/**
 * Claude Code harness adapter: runs `claude -p` in stream-json mode with every built-in tool
 * disabled, user settings/plugins/hooks ignored, and only the bridge MCP server attached.
 * The process stays alive between turns so follow-up turns don't need a replay.
 */
import type { ProviderConfig } from "../config.ts";
import type { ContentBlock, StopReason } from "../types.ts";
import { classifyError, harnessEnv, spawnLines, wrapCommand } from "./spawn.ts";
import { ProviderFailure, type Provider, type ProviderRun, type RunEvent, type StartOptions } from "./types.ts";

const BRIDGE = "api";
const STOP_REASONS = new Set<StopReason>(["end_turn", "max_tokens", "stop_sequence", "refusal"]);

export class ClaudeProvider implements Provider {
  readonly type = "claude";
  readonly capabilities = { multiTurn: true, images: true };
  constructor(readonly name: string, private cfg: ProviderConfig) {}

  start(o: StartOptions, emit: (e: RunEvent) => void): ProviderRun {
    const args = [
      this.cfg.bin ?? "claude",
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--system-prompt", o.system,
    ];
    if (o.model) args.push("--model", o.model);
    if (o.bridgeUrl) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: { [BRIDGE]: { type: "http", url: o.bridgeUrl } } }));
      args.push("--allowedTools", `mcp__${BRIDGE}`);
    }
    args.push(...(this.cfg.extraArgs ?? []));

    const env = harnessEnv(this.cfg, o.runDir, {
      MCP_TOOL_TIMEOUT: String(o.toolTimeoutMs),
      MCP_TIMEOUT: "30000",
      MAX_MCP_OUTPUT_TOKENS: "500000",
      DISABLE_AUTOUPDATER: "1",
    });

    let failed = false;
    const fail = (f: ProviderFailure) => {
      if (failed) return;
      failed = true;
      emit({ type: "error", failure: f });
    };

    const sp = spawnLines(
      wrapCommand(this.cfg, o.runDir, args),
      { cwd: o.runDir, env },
      (line) => {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        this.onMessage(m, emit, fail);
      },
      (code, stderr) => emit({ type: "exit", code, stderr }),
    );

    const send = (content: ContentBlock[]) => {
      failed = false;
      sp.write(JSON.stringify({ type: "user", message: { role: "user", content: toClaudeContent(content) } }));
    };
    send(o.prompt);

    return {
      send,
      kill: () => {
        sp.closeStdin();
        sp.proc.kill();
      },
    };
  }

  private onMessage(m: any, emit: (e: RunEvent) => void, fail: (f: ProviderFailure) => void) {
    if (m.type === "stream_event" && !m.parent_tool_use_id) {
      const ev = m.event;
      switch (ev?.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {};
          emit({
            type: "usage",
            usage: {
              input_tokens: u.input_tokens ?? 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
            },
          });
          break;
        }
        case "content_block_start":
          if (ev.content_block?.type === "text") emit({ type: "text_break" });
          else if (ev.content_block?.type === "tool_use" && String(ev.content_block.name).startsWith(`mcp__${BRIDGE}__`))
            emit({ type: "tool_hint", count: 1 });
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") emit({ type: "text", text: ev.delta.text });
          break;
        case "message_delta":
          if (ev.usage?.output_tokens) emit({ type: "usage", usage: { output_tokens: ev.usage.output_tokens } });
          break;
      }
      return;
    }
    if (m.type === "rate_limit_event") {
      const info = m.rate_limit_info ?? {};
      const windows = Object.values(info.unifiedWindows ?? {}) as Array<{ utilization?: number }>;
      const utilization = windows.length ? Math.max(...windows.map((w) => w.utilization ?? 0)) : undefined;
      emit({ type: "rate_limit", status: info.status, utilization, resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined });
      return;
    }
    if (m.type === "result") {
      if (m.is_error || (m.subtype && m.subtype !== "success")) {
        const text = String(m.result ?? m.error ?? m.subtype ?? "unknown error");
        const kind = classifyError(text);
        const reset = /\|(\d{9,})/.exec(text);
        fail(new ProviderFailure(kind, `claude: ${text}`, reset ? Number(reset[1]) * 1000 : undefined));
        return;
      }
      const stop = STOP_REASONS.has(m.stop_reason) ? (m.stop_reason as StopReason) : "end_turn";
      emit({ type: "turn_end", stopReason: stop });
    }
  }
}

/** Claude stream-json accepts text and image blocks in a user turn. */
function toClaudeContent(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => b.type === "text" || b.type === "image");
}
