import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import type { Config } from "./config.ts";
import { estimateTokens, fingerprint, normalizeMessages, renderPrompt, systemBlocks, systemText } from "./conversation.ts";
import type { KeyRecord, Store } from "./db.ts";
import { Moderator } from "./moderation.ts";
import { filterTools, Limiter, modelAllowed } from "./policy.ts";
import { ProviderFailure } from "./providers/types.ts";
import { Router } from "./router.ts";
import { SessionManager, type Session, type TurnResult } from "./session.ts";
import { errorResponse, JsonSink, StreamSink, type Sink } from "./sink.ts";
import type { Message, MessagesRequest, ToolDef } from "./types.ts";
import { log, sha256, startOfUtcDay } from "./util.ts";

const BRIDGE_PREAMBLE = (toolCount: number, tc: MessagesRequest["tool_choice"]) =>
  [
    "You are being served through an API. You have no built-in tools: no shell, no file access, no web access.",
    "IMPORTANT: the \"# Environment\" section in your context (working directory under gateway-sandbox-not-the-callers-filesystem, " +
      "platform, git status) describes an empty gateway sandbox you cannot access. It is NOT the caller's machine. Never use or " +
      "mention its paths. The caller's real working directory and files are whatever the conversation and the caller's tools say; " +
      "when the conversation states a working directory, that one is authoritative.",
    toolCount
      ? `The only tools you have are the ${toolCount} tools of the MCP server "api" (they may appear as mcp__api__<name>). ` +
        "They run in the caller's environment; use them exactly as you would use tools in the Messages API."
      : "You have no tools in this conversation; answer directly.",
    tc?.type === "any" ? "You must call at least one tool in your response." : "",
    tc?.type === "tool" && tc.name ? `You must call the tool "${tc.name}" in your response.` : "",
  ]
    .filter(Boolean)
    .join("\n");

export class Gateway {
  readonly bridge = new Bridge();
  readonly router: Router;
  readonly sessions: SessionManager;
  private limiter = new Limiter();
  readonly moderator: Moderator;

  constructor(
    private cfg: Config,
    private store: Store,
  ) {
    this.router = new Router(cfg);
    this.moderator = new Moderator(cfg, store);
    const bridgeBaseUrl = cfg.bridgeUrl ?? `http://${cfg.listen.host === "0.0.0.0" ? "127.0.0.1" : cfg.listen.host}:${cfg.listen.port}`;
    this.sessions = new SessionManager(
      { bridge: this.bridge, router: this.router, bridgeBaseUrl, runsDir: cfg.runsDir ?? join(tmpdir(), "gateway-sandbox-not-the-callers-filesystem"), ttlMs: cfg.sessionTtlSeconds * 1000 },
      cfg.maxSessions,
    );
  }

  listen() {
    const server = Bun.serve({
      hostname: this.cfg.listen.host,
      port: this.cfg.listen.port,
      idleTimeout: 0, // tool calls / SSE streams may stay open for minutes
      fetch: (req) => this.fetch(req),
    });
    log.info(`subgate listening on http://${server.hostname}:${server.port} providers=[${[...this.router.providers.keys()].join(", ")}]`);
    return server;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/bridge/")) return await this.bridge.handle(req, p.slice("/bridge/".length));
      if (p === "/health") return Response.json({ ok: true, providers: this.router.status().map(({ name, available }) => ({ name, available })) });
      if (p === "/admin/status") return this.adminStatus(req);

      const key = this.authenticate(req);
      if (key instanceof Response) return key;

      if (p === "/v1/models" && req.method === "GET") return this.models(key);
      if (p === "/v1/messages/count_tokens" && req.method === "POST")
        return Response.json({ input_tokens: estimateTokens((await req.json()) as MessagesRequest) });
      if (p === "/v1/messages" && req.method === "POST") return await this.messages(req, key);
      return errorResponse("not_found_error", `no route for ${req.method} ${p}`);
    } catch (e) {
      log.warn("request failed", e);
      return errorResponse("api_error", (e as Error).message);
    }
  }

  private authenticate(req: Request): KeyRecord | Response {
    const auth = req.headers.get("authorization");
    const secret = req.headers.get("x-api-key") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null);
    if (!secret) return errorResponse("authentication_error", "missing API key (x-api-key or Authorization: Bearer)");
    const key = this.store.authenticate(secret);
    if (!key) return errorResponse("authentication_error", "invalid or revoked API key");
    if (key.policy.expiresAt && Date.parse(key.policy.expiresAt) < Date.now()) return errorResponse("authentication_error", "API key expired");
    return key;
  }

  private adminStatus(req: Request): Response {
    if (!this.cfg.adminToken || req.headers.get("authorization") !== `Bearer ${this.cfg.adminToken}`)
      return errorResponse("authentication_error", "admin token required");
    return Response.json({ providers: this.router.status(), sessions: this.sessions.list() });
  }

  private models(key: KeyRecord): Response {
    const data = this.cfg.advertisedModels
      .filter((m) => modelAllowed(key.policy, m))
      .map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" }));
    return Response.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  }

  private checkQuotas(key: KeyRecord): Response | null {
    const lim = key.policy.limits ?? {};
    if (lim.requestsPerDay === undefined && lim.tokensPerDay === undefined && lim.outputTokensPerDay === undefined) return null;
    const used = this.store.usageSince(key.id, startOfUtcDay());
    const retry = String(Math.ceil((startOfUtcDay() + 86_400_000 - Date.now()) / 1000));
    if (lim.requestsPerDay !== undefined && used.requests >= lim.requestsPerDay)
      return errorResponse("rate_limit_error", `daily request quota (${lim.requestsPerDay}) exhausted`, { "retry-after": retry });
    if (lim.tokensPerDay !== undefined && used.input + used.output >= lim.tokensPerDay)
      return errorResponse("rate_limit_error", `daily token quota (${lim.tokensPerDay}) exhausted`, { "retry-after": retry });
    if (lim.outputTokensPerDay !== undefined && used.output >= lim.outputTokensPerDay)
      return errorResponse("rate_limit_error", `daily output token quota (${lim.outputTokensPerDay}) exhausted`, { "retry-after": retry });
    return null;
  }

  private async messages(req: Request, key: KeyRecord): Promise<Response> {
    let body: MessagesRequest;
    try {
      body = (await req.json()) as MessagesRequest;
    } catch {
      return errorResponse("invalid_request_error", "body must be JSON");
    }
    if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0)
      return errorResponse("invalid_request_error", "model and a non-empty messages array are required");

    const policy = key.policy;
    if (!modelAllowed(policy, body.model)) return errorResponse("permission_error", `this key may not use model ${body.model}`);
    const routeModel = policy.modelOverride ?? body.model;

    const lim = this.limiter.check(key.id, policy);
    if (!lim.ok) return errorResponse("rate_limit_error", lim.reason, { "retry-after": String(lim.retryAfter) });
    const quota = this.checkQuotas(key);
    if (quota) return quota;
    if (this.moderator.suspended(key))
      return errorResponse("permission_error", "this key is suspended after repeated content-policy blocks; an admin must review it (subgate moderation, subgate keys unsuspend)");

    const messages = normalizeMessages(body.messages);
    if (messages.length === 0) return errorResponse("invalid_request_error", "messages contain no user or assistant turns");
    if (messages[messages.length - 1].role === "assistant") {
      // Assistant prefill: harnesses can't be prefilled, so ask for the continuation instead.
      const prefill = messages.pop()!.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Your reply must continue directly from this already-written beginning; output only the continuation, without repeating it:\n${prefill}` }],
      });
      if (messages.length > 1 && messages[messages.length - 2].role === "user") {
        const note = messages.pop()!;
        messages[messages.length - 1].content.push(...note.content);
      }
    }
    const last = messages[messages.length - 1];
    if (policy.allowImages === false) for (const m of messages) m.content = m.content.filter((b) => b.type !== "image");

    const { allowed: tools, dropped } = body.tool_choice?.type === "none" ? { allowed: [] as ToolDef[], dropped: [] } : filterTools(body.tools, policy);
    if (dropped.length) log.debug(`key ${key.name}: tools not exposed: ${dropped.join(", ")}`);

    const system = [policy.systemPrompt, systemText(body.system), BRIDGE_PREAMBLE(tools.length, body.tool_choice)].filter(Boolean).join("\n\n");
    const clientSystem = systemBlocks(body.system);
    const mod = await this.moderator.check(key, { system: clientSystem, messages, tools });
    if (mod.verdict === "block") {
      if (mod.category === "moderation_unavailable") return errorResponse("overloaded_error", `content screening unavailable: ${mod.reason}`);
      return errorResponse("permission_error", `request blocked by gateway content policy (${mod.category}): ${mod.reason}`);
    }

    const context = sha256(JSON.stringify([key.id, routeModel, system, tools.map((t) => [t.name, t.input_schema])]));

    const sink: Sink = body.stream ? new StreamSink(body.model, req.signal) : new JsonSink(body.model, req.signal);
    const release = this.limiter.acquire(key.id);
    const started = Date.now();

    const run = async () => {
      let session: Session | null = this.sessions.findContinuable(key.id, fingerprint(context, messages.slice(0, -1)), last);
      let result: TurnResult | null = null;
      const failures: string[] = [];

      if (session) {
        log.debug(`session ${session.id} continues (${session.state})`);
        try {
          const p = session.respond(sink);
          session.continueWith(last);
          result = await p;
        } catch (e) {
          if (!(e instanceof ProviderFailure) || sink.contentEmitted || sink.closed) throw e;
          this.router.markFailure(session.providerName, e);
          failures.push(`${session.providerName}: ${e.message}`);
          session = null; // fall through to a fresh replay with the full history
        }
      }

      if (!result) {
        for (const target of this.router.candidates(routeModel, policy)) {
          if (sink.closed) return;
          const s = this.sessions.create(key, target, tools);
          try {
            const p = s.respond(sink);
            s.start(system, renderPrompt(messages, { images: target.provider.capabilities.images }));
            result = await p;
            session = s;
            break;
          } catch (e) {
            if (!(e instanceof ProviderFailure) || sink.contentEmitted || sink.closed) throw e;
            this.router.markFailure(target.provider.name, e);
            failures.push(`${target.provider.name}: ${e.message}`);
            log.info(`failover: ${target.provider.name} failed before output, trying next provider`);
          }
        }
      }

      if (!result || !session) {
        const msg = failures.length ? `all providers failed: ${failures.join("; ")}` : `no provider route for model ${routeModel}`;
        sink.fail(failures.length ? "overloaded_error" : "invalid_request_error", msg);
        return;
      }

      const assistant: Message = { role: "assistant", content: sink.blocks };
      this.moderator.trust(sink.blocks);
      session.fingerprint = fingerprint(context, [...messages, assistant]);
      this.store.recordUsage({
        key_id: key.id,
        model: body.model,
        provider: session.providerName,
        target_model: session.target.model ?? null,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read: result.usage.cache_read_input_tokens,
        cache_write: result.usage.cache_creation_input_tokens,
        stop_reason: result.stopReason,
        status: "ok",
        duration_ms: Date.now() - started,
      });
    };

    run()
      .catch((e) => {
        log.warn(`request for key ${key.name} failed`, e);
        sink.fail("api_error", (e as Error).message);
        this.store.recordUsage({
          key_id: key.id, model: body.model, provider: "-", target_model: null, input_tokens: 0, output_tokens: 0,
          cache_read: 0, cache_write: 0, stop_reason: "error", status: "error", duration_ms: Date.now() - started,
        });
      })
      .finally(release);

    return sink.response();
  }
}
