import type { Subprocess } from "bun";
import type { ProviderConfig } from "../config.ts";
import { log } from "../util.ts";

/** Host env vars a harness needs to find its own login/config. Everything else is dropped. */
const SAFE_ENV = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];

export function harnessEnv(cfg: ProviderConfig, runDir: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...SAFE_ENV, ...(cfg.inheritEnv ?? [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.TMPDIR = `${runDir}/tmp`;
  return { ...env, ...extra, ...(cfg.env ?? {}) };
}

export function wrapCommand(cfg: ProviderConfig, runDir: string, cmd: string[]): string[] {
  const wrapper = (cfg.wrapper ?? []).map((a) => a.replaceAll("{runDir}", runDir));
  return [...wrapper, ...cmd];
}

export interface Spawned {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  stderr: () => string;
  write: (line: string) => void;
  closeStdin: () => void;
}

/** Spawn a harness and feed stdout to `onLine` line by line. */
export function spawnLines(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
  onLine: (line: string) => void,
  onExit: (code: number | null, stderr: string) => void,
): Spawned {
  log.debug("spawn", cmd.map((a) => (a.length > 120 ? a.slice(0, 120) + "…" : a)).join(" "));
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let errBuf = "";
  let stdinOpen = true;

  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) {
      errBuf = (errBuf + dec.decode(chunk)).slice(-8192);
    }
  })().catch(() => {});

  const stdoutDone = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf.trim());
  })().catch((e) => log.debug("stdout reader", e));

  proc.exited.then(async (code) => {
    await stdoutDone;
    onExit(code, errBuf);
  });

  return {
    proc,
    stderr: () => errBuf,
    write: (line) => {
      if (!stdinOpen) return;
      proc.stdin.write(line + "\n");
      proc.stdin.flush();
    },
    closeStdin: () => {
      if (!stdinOpen) return;
      stdinOpen = false;
      proc.stdin.end();
    },
  };
}

/** Heuristic classification of harness error text. */
export function classifyError(text: string): "rate_limit" | "auth" | "unknown" {
  const t = text.toLowerCase();
  if (/usage limit|rate.?limit|limit reached|quota|too many requests|429|exhausted/.test(t)) return "rate_limit";
  if (/log ?in|logged out|unauthori|authenticat|oauth|credential|401|invalid api key|token (has )?expired/.test(t)) return "auth";
  return "unknown";
}
