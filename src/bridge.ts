/**
 * Minimal MCP server (Streamable HTTP transport, JSON responses only) that exposes a client's
 * tools to a harness. Every session gets its own unguessable endpoint: POST /bridge/<token>.
 *
 * A `tools/call` request is held open until the API client returns the matching tool_result,
 * so the harness simply sees a slow tool. Nothing is executed on the gateway side.
 */
import { log, randId } from "./util.ts";

export interface BridgeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface BridgeHandler {
  tools: BridgeTool[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

export class Bridge {
  private handlers = new Map<string, BridgeHandler>();

  register(h: BridgeHandler): string {
    const token = randId("", 24);
    this.handlers.set(token, h);
    return token;
  }

  unregister(token: string) {
    this.handlers.delete(token);
  }

  async handle(req: Request, token: string): Promise<Response> {
    const h = this.handlers.get(token);
    if (!h) return new Response("unknown session", { status: 404 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });

    let body: JsonRpc | JsonRpc[];
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
    }
    const batch = Array.isArray(body);
    const msgs = batch ? (body as JsonRpc[]) : [body as JsonRpc];
    const replies = (await Promise.all(msgs.map((m) => this.dispatch(h, m, req.signal)))).filter((r) => r !== null);
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0], { headers: { "mcp-session-id": token } });
  }

  private async dispatch(h: BridgeHandler, m: JsonRpc, signal: AbortSignal): Promise<object | null> {
    const isNotification = m.id === undefined || m.id === null;
    if (!m.method) return null; // a response from the client; we never send requests
    const ok = (result: object) => ({ jsonrpc: "2.0", id: m.id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id, error: { code, message } });

    switch (m.method) {
      case "initialize":
        return ok({
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "subgate-bridge", version: "0.1.0" },
          instructions: "Tools provided by the API client. Results come from the client's environment.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: h.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
            // readOnlyHint lets harnesses issue parallel calls, mirroring how the Messages API
            // returns several tool_use blocks in one turn. Execution safety is the client's job.
            annotations: { readOnlyHint: true },
          })),
        });
      case "tools/call": {
        const name = m.params?.name;
        if (!h.tools.some((t) => t.name === name)) return ok({ content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
        try {
          return ok(await h.call(name, m.params?.arguments ?? {}, signal));
        } catch (e) {
          log.debug("bridge call failed", e);
          return ok({ content: [{ type: "text", text: `Tool call failed: ${(e as Error).message}` }], isError: true });
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return isNotification ? null : err(-32601, `method not found: ${m.method}`);
    }
  }
}
