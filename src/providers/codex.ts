/**
 * Codex CLI harness adapter: `codex exec --json` in an empty read-only sandbox directory, with
 * user config ignored, built-in tools disabled where Codex allows it, and the bridge attached
 * as a streamable-HTTP MCP server. One process per user turn (Codex exec is single-turn), so
 * follow-up user turns are replayed; tool round-trips within a turn are still live.
 */
import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderConfig } from "../config.ts";
import { isImage, isText, type ContentBlock, type ImageBlock } from "../types.ts";
import { classifyError, harnessEnv, spawnLines, wrapCommand } from "./spawn.ts";
import { ProviderFailure, type Provider, type ProviderRun, type RunEvent, type StartOptions } from "./types.ts";

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "view_image",
  "skill_search",
];

function defaultBin(): string {
  const local = resolve(import.meta.dir, "../../node_modules/.bin/codex");
  return existsSync(local) ? local : "codex";
}

export class CodexProvider implements Provider {
  readonly type = "codex";
  readonly capabilities = { multiTurn: false, images: true };
  constructor(readonly name: string, private cfg: ProviderConfig) {}

  start(o: StartOptions, emit: (e: RunEvent) => void): ProviderRun {
    const args = [
      this.cfg.bin ?? defaultBin(),
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color", "never",
      "-s", "read-only",
      "-C", o.runDir,
      "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"',
    ];
    for (const f of DISABLED_FEATURES) args.push("--disable", f);
    if (o.model) args.push("-m", o.model);
    if (o.bridgeUrl) {
      args.push(
        "-c", `mcp_servers.api.url=${JSON.stringify(o.bridgeUrl)}`,
        "-c", `mcp_servers.api.tool_timeout_sec=${Math.ceil(o.toolTimeoutMs / 1000)}`,
        "-c", "mcp_servers.api.startup_timeout_sec=30",
      );
    }
    o.prompt.filter(isImage).forEach((img, i) => {
      const path = saveImage(o.runDir, img, i);
      if (path) args.push("-i", path);
    });
    args.push(...(this.cfg.extraArgs ?? []), "-");

    const promptText =
      `<system_instructions>\n${o.system}\n</system_instructions>\n\n` +
      o.prompt.filter(isText).map((b) => b.text).join("\n\n");

    let failed = false;
    const fail = (f: ProviderFailure) => {
      if (!failed) (failed = true), emit({ type: "error", failure: f });
    };

    const sp = spawnLines(
      wrapCommand(this.cfg, o.runDir, args),
      { cwd: o.runDir, env: harnessEnv(this.cfg, o.runDir, {}) },
      (line) => {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        switch (m.type) {
          case "item.completed":
            if (m.item?.type === "agent_message" && m.item.text) {
              emit({ type: "text_break" });
              emit({ type: "text", text: m.item.text });
            }
            break;
          case "turn.completed": {
            const u = m.usage ?? {};
            emit({
              type: "usage",
              usage: {
                input_tokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
                cache_read_input_tokens: u.cached_input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
              },
            });
            emit({ type: "turn_end", stopReason: "end_turn" });
            break;
          }
          case "turn.failed":
          case "error": {
            const text = String(m.error?.message ?? m.message ?? JSON.stringify(m));
            fail(new ProviderFailure(classifyError(text), `codex: ${text}`));
            break;
          }
        }
      },
      (code, stderr) => emit({ type: "exit", code, stderr }),
    );
    sp.write(promptText);
    sp.closeStdin();

    return {
      send: () => {
        throw new Error("codex provider is single-turn");
      },
      kill: () => sp.proc.kill(),
    };
  }
}

function saveImage(dir: string, img: ImageBlock, i: number): string | null {
  if (img.source.type !== "base64") return null;
  const ext = img.source.media_type.split("/")[1] ?? "png";
  const path = join(dir, `input-${i}.${ext}`);
  writeFileSync(path, Buffer.from(img.source.data, "base64"));
  return path;
}
