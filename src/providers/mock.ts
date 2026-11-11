/**
 * Deterministic in-process provider for tests and dry runs. It speaks real MCP to the bridge,
 * so the whole tool round-trip path is exercised without spending subscription usage.
 *
 * Behaviour, based on the latest user text:
 *   "fail"          -> fails before any output (exercises failover)
 *   "ratelimit"     -> fails with a rate limit
 *   "call <tool> <json>" -> calls that tool via the bridge, then replies with its result
 *   "parallel"      -> calls the first tool twice concurrently
 *   anything else   -> "echo: <text>"
 */
import type { ProviderConfig } from "../config.ts";
import { isText, type ContentBlock } from "../types.ts";
import { ProviderFailure, type Provider, type ProviderRun, type RunEvent, type StartOptions } from "./types.ts";

export class MockProvider implements Provider {
  readonly type = "mock";
  readonly capabilities = { multiTurn: true, images: false };
  constructor(readonly name: string, private cfg: ProviderConfig, _dataDir?: string) {}

  start(o: StartOptions, emit: (e: RunEvent) => void): ProviderRun {
    let killed = false;
    const ctl = new AbortController();
    let rpcId = 0;
    const rpc = async (method: string, params?: object) => {
      const r = await fetch(o.bridgeUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: ctl.signal,
      });
      return ((await r.json()) as any).result;
    };

    const turn = async (content: ContentBlock[]) => {
      const text = content.filter(isText).map((b) => b.text).join("\n");
      const latest = text.split("\n").filter(Boolean).pop() ?? "";
      const instr = (this.cfg.env?.MOCK_FORCE ?? latest).trim();
      await Bun.sleep(5);
      if (killed) return;
      if (instr === "fail") return emit({ type: "error", failure: new ProviderFailure("unavailable", "mock failure") });
      if (instr === "ratelimit")
        return emit({ type: "error", failure: new ProviderFailure("rate_limit", "mock limit", Date.now() + 60_000) });

      emit({ type: "usage", usage: { input_tokens: Math.ceil(text.length / 4) } });
      const call = /^call (\S+)\s*(.*)$/.exec(instr);
      if ((call || instr === "parallel") && o.bridgeUrl) {
        await rpc("initialize", { protocolVersion: "2025-06-18" });
        const tools = (await rpc("tools/list")).tools as Array<{ name: string }>;
        emit({ type: "text", text: "Calling tool." });
        let results: any[];
        if (instr === "parallel") {
          emit({ type: "tool_hint", count: 2 });
          const name = tools[0].name;
          results = await Promise.all([
            rpc("tools/call", { name, arguments: { n: 1 } }),
            rpc("tools/call", { name, arguments: { n: 2 } }),
          ]);
        } else {
          emit({ type: "tool_hint", count: 1 });
          results = [await rpc("tools/call", { name: call![1], arguments: call![2] ? JSON.parse(call![2]) : {} })];
        }
        if (killed) return;
        emit({ type: "text_break" });
        const rendered = results.map((r) => (r.isError ? "ERROR " : "") + r.content.map((c: any) => c.text ?? "[img]").join(""));
        emit({ type: "text", text: `Tool said: ${rendered.join(" | ")}` });
      } else {
        emit({ type: "text", text: `echo: ${latest}` });
      }
      emit({ type: "usage", usage: { output_tokens: 7 } });
      emit({ type: "turn_end", stopReason: "end_turn" });
    };

    const run = (c: ContentBlock[]) =>
      turn(c).catch((e) => !killed && emit({ type: "error", failure: new ProviderFailure("unknown", String(e)) }));
    run(o.prompt);
    return {
      send: (c) => void run(c),
      kill: () => {
        killed = true;
        ctl.abort();
        emit({ type: "exit", code: 0, stderr: "" });
      },
    };
  }
}
