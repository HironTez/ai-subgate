import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ProviderConfig {
  /** Which harness adapter to use. */
  type: "claude" | "codex" | "mock";
  enabled?: boolean;
  /** Path to the harness binary (default: "claude" / "codex" on PATH). */
  bin?: string;
  /** Extra environment for the harness (e.g. CLAUDE_CONFIG_DIR or CODEX_HOME to pick a second account). */
  env?: Record<string, string>;
  /** Names of host environment variables to pass through in addition to the safe defaults. */
  inheritEnv?: string[];
  /**
   * Optional command prefix for OS-level sandboxing, e.g. ["bwrap", "--ro-bind", "/", "/", "--bind", "{runDir}", "{runDir}", "--"].
   * `{runDir}` is replaced with the per-session working directory.
   */
  wrapper?: string[];
  /** Extra CLI args appended to the harness invocation. */
  extraArgs?: string[];
}

export interface RouteTarget {
  provider: string;
  /** Model passed to the harness (omit to use the harness default). */
  model?: string;
}

export interface Route {
  /** Glob matched against the client's requested model, e.g. "claude-opus-*" or "*". */
  match: string;
  targets: RouteTarget[];
}

export interface Config {
  listen: { host: string; port: number };
  /** URL harnesses use to reach the MCP bridge. Default: http://<host>:<port> */
  bridgeUrl?: string;
  dataDir: string;
  /** How long a paused session (waiting for tool results / next user turn) is kept alive. */
  sessionTtlSeconds: number;
  maxSessions: number;
  /** Optional token for GET /admin/status. */
  adminToken?: string;
  providers: Record<string, ProviderConfig>;
  routes: Route[];
  failover: {
    /** Treat a provider as exhausted when its reported utilization reaches this fraction (0..1). */
    switchAtUtilization: number;
    defaultCooldownSeconds: number;
    rateLimitCooldownSeconds: number;
  };
  /** Model ids advertised by GET /v1/models. */
  advertisedModels: string[];
}

export const defaultConfig = (): Config => ({
  listen: { host: "127.0.0.1", port: 8742 },
  dataDir: "./data",
  sessionTtlSeconds: 900,
  maxSessions: 32,
  providers: {
    claude: { type: "claude" },
    codex: { type: "codex", enabled: false },
  },
  routes: [
    { match: "*haiku*", targets: [{ provider: "claude", model: "haiku" }, { provider: "codex" }] },
    { match: "*sonnet*", targets: [{ provider: "claude", model: "sonnet" }, { provider: "codex" }] },
    { match: "*", targets: [{ provider: "claude", model: "opus" }, { provider: "codex" }] },
  ],
  failover: { switchAtUtilization: 0.98, defaultCooldownSeconds: 60, rateLimitCooldownSeconds: 900 },
  advertisedModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
});

export function configPath(explicit?: string): string {
  return resolve(explicit ?? process.env.SUBGATE_CONFIG ?? "subgate.json");
}

export function loadConfig(explicit?: string): Config {
  const path = configPath(explicit);
  const base = defaultConfig();
  if (!existsSync(path)) {
    base.dataDir = resolve(base.dataDir);
    return base;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  const cfg: Config = {
    ...base,
    ...raw,
    listen: { ...base.listen, ...raw.listen },
    failover: { ...base.failover, ...raw.failover },
    providers: raw.providers ?? base.providers,
    routes: raw.routes ?? base.routes,
  };
  cfg.dataDir = resolve(dirname(path), cfg.dataDir);
  for (const r of cfg.routes)
    for (const t of r.targets)
      if (!cfg.providers[t.provider]) throw new Error(`route "${r.match}" references unknown provider "${t.provider}"`);
  return cfg;
}
