/**
 * A Session is one live harness process serving one conversation for one API key.
 *
 * Lifecycle of a tool round-trip:
 *   1. harness calls a bridged tool  -> MCP tools/call is held open
 *   2. session emits tool_use blocks -> response ends with stop_reason "tool_use"
 *   3. client executes the tool and sends a new request whose last message holds tool_result
 *   4. server finds this session by conversation fingerprint, resolves the held MCP calls
 *   5. harness continues; its output streams into the new response
 *
 * After an end_turn the session goes "idle"; a multi-turn harness can take the next user turn
 * directly. Anything that can't be continued (restart, failover, expired) is replayed instead.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bridge, BridgeTool, McpCallResult, McpContent } from "./bridge.ts";
import type { KeyRecord } from "./db.ts";
import { checkToolArgs } from "./policy.ts";
import { ProviderFailure, type ProviderRun, type RunEvent } from "./providers/types.ts";
import type { Router, Target } from "./router.ts";
import type { Sink } from "./sink.ts";
import {
  isText,
  isToolResult,
  zeroUsage,
  type ContentBlock,
  type Message,
  type StopReason,
  type ToolDef,
  type ToolResultBlock,
  type Usage,
} from "./types.ts";
import { log, randId, truncate } from "./util.ts";

type State = "new" | "running" | "awaiting_tools" | "idle" | "closed";

interface PendingCall {
  id: string;
  name: string;
  input: unknown;
  resolve: (r: McpCallResult) => void;
}

export interface SessionDeps {
  bridge: Bridge;
  router: Router;
  bridgeBaseUrl: string;
  runsDir: string;
  ttlMs: number;
  onClose: (s: Session) => void;
}

export interface TurnResult {
  stopReason: StopReason;
  usage: Usage;
}

/** Multiple parallel tool calls arrive within a few ms; wait this long for siblings. */
const BATCH_WINDOW_MS = 250;
/** When the harness announced more calls than arrived (serial execution), give up waiting after this. */
const ANNOUNCED_WAIT_MS = 1000;

export class Session {
  readonly id = randId("ses_", 9);
  state: State = "new";
  fingerprint: string | null = null;
  lastActivity = Date.now();
  readonly runDir: string;

  private run: ProviderRun | null = null;
  private token: string | null = null;
  private sink: Sink | null = null;
  private waiter: { resolve: (r: TurnResult) => void; reject: (e: ProviderFailure) => void } | null = null;
  private batch: PendingCall[] = [];
  private pending = new Map<string, PendingCall>();
  private expected = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private usage: Usage = zeroUsage();

  constructor(
    readonly key: KeyRecord,
    readonly target: Target,
    readonly tools: ToolDef[],
    private deps: SessionDeps,
  ) {
    this.runDir = join(deps.runsDir, this.id);
  }

  get providerName() {
    return this.target.provider.name;
  }
  get multiTurn() {
    return this.target.provider.capabilities.multiTurn;
  }
  /** Can a request whose history matches our fingerprint be served by this session? */
  get continuable() {
    return this.state === "awaiting_tools" || (this.state === "idle" && this.multiTurn);
  }

  start(system: string, prompt: ContentBlock[]) {
    mkdirSync(join(this.runDir, "tmp"), { recursive: true });
    let bridgeUrl: string | undefined;
    if (this.tools.length) {
      const bt: BridgeTool[] = this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
      this.token = this.deps.bridge.register({ tools: bt, call: (n, a, s) => this.onToolCall(n, a, s) });
      bridgeUrl = `${this.deps.bridgeBaseUrl}/bridge/${this.token}`;
    }
    this.state = "running";
    log.info(`session ${this.id} start provider=${this.providerName} model=${this.target.model ?? "(default)"} key=${this.key.name} tools=${this.tools.length}`);
    this.run = this.target.provider.start(
      { runDir: this.runDir, system, prompt, model: this.target.model, bridgeUrl, toolTimeoutMs: this.deps.ttlMs + 60_000 },
      (e) => this.onEvent(e),
    );
  }

  /** Attach the response for the next chunk of harness output. */
  respond(sink: Sink): Promise<TurnResult> {
    this.sink = sink;
    this.usage = zeroUsage();
    sink.onAbort(() => {
      if (this.sink === sink) this.close("client disconnected");
    });
    const p = new Promise<TurnResult>((resolve, reject) => (this.waiter = { resolve, reject }));
    if (this.batch.length) this.scheduleFlush();
    return p;
  }

  /** Feed the client's latest user message into the live harness. */
  continueWith(msg: Message) {
    this.lastActivity = Date.now();
    if (this.state === "awaiting_tools") {
      const results = msg.content.filter(isToolResult);
      const notes = msg.content.filter(isText).map((b) => b.text).filter((t) => t.trim());
      const answered: Array<[PendingCall, McpCallResult]> = [];
      for (const r of results) {
        const p = this.pending.get(r.tool_use_id);
        if (!p) continue;
        this.pending.delete(r.tool_use_id);
        answered.push([p, toMcpResult(r)]);
      }
      if (notes.length && answered.length)
        answered[answered.length - 1][1].content.push({
          type: "text",
          text: `\n<client_context note="sent by the API client alongside the tool results; not part of the tool output">\n${notes.join("\n")}\n</client_context>`,
        });
      for (const p of this.pending.values())
        answered.push([p, { content: [{ type: "text", text: "The client returned no result for this tool call." }], isError: true }]);
      this.pending.clear();
      this.state = "running";
      for (const [p, r] of answered) p.resolve(r);
    } else if (this.state === "idle") {
      this.state = "running";
      this.expected = 0;
      this.run!.send(msg.content);
    } else {
      throw new Error(`session ${this.id} not continuable in state ${this.state}`);
    }
  }

  /** Message ids of tool calls this session is waiting on (used to validate continuations). */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  private onToolCall(name: string, input: unknown, signal: AbortSignal): Promise<McpCallResult> {
    this.lastActivity = Date.now();
    const denied = checkToolArgs(this.key.policy, name, input);
    if (denied) {
      log.info(`session ${this.id} blocked ${name}: ${denied}`);
      this.expected = Math.max(0, this.expected - 1);
      return Promise.resolve({ content: [{ type: "text", text: `Tool call rejected by gateway policy: ${denied}` }], isError: true });
    }
    return new Promise((resolve) => {
      const call: PendingCall = { id: randId("toolu_", 18), name, input, resolve };
      signal.addEventListener("abort", () => {
        this.batch = this.batch.filter((c) => c !== call);
        this.pending.delete(call.id);
      });
      this.batch.push(call);
      this.scheduleFlush();
    });
  }

  private scheduleFlush() {
    if (!this.sink) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.expected > 0 && this.batch.length >= this.expected) return this.flush();
    this.flushTimer = setTimeout(() => this.flush(), this.expected > this.batch.length ? ANNOUNCED_WAIT_MS : BATCH_WINDOW_MS);
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.sink || !this.batch.length) return;
    for (const c of this.batch) {
      this.sink.toolUse(c.id, c.name, c.input);
      this.pending.set(c.id, c);
    }
    this.expected = Math.max(0, this.expected - this.batch.length);
    this.batch = [];
    this.state = "awaiting_tools";
    this.endResponse("tool_use");
  }

  private endResponse(stop: StopReason) {
    const sink = this.sink;
    const waiter = this.waiter;
    this.sink = null;
    this.waiter = null;
    this.lastActivity = Date.now();
    sink?.finish(stop, this.usage);
    waiter?.resolve({ stopReason: stop, usage: this.usage });
  }

  private onEvent(e: RunEvent) {
    this.lastActivity = Date.now();
    switch (e.type) {
      case "text":
        this.sink?.text(e.text);
        break;
      case "text_break":
        this.sink?.textBreak();
        break;
      case "tool_hint":
        this.expected += e.count;
        break;
      case "usage":
        for (const [k, v] of Object.entries(e.usage)) this.usage[k as keyof Usage] += v ?? 0;
        break;
      case "rate_limit":
        this.deps.router.onRateLimit(this.providerName, e.status, e.utilization, e.resetsAt);
        break;
      case "turn_end":
        if (this.batch.length) this.flush();
        if (this.state !== "running") break;
        this.deps.router.markSuccess(this.providerName);
        this.state = this.multiTurn ? "idle" : "closed";
        this.endResponse(e.stopReason);
        if (!this.multiTurn) this.close("turn complete");
        break;
      case "error":
        this.failWith(e.failure);
        break;
      case "exit":
        if (this.state === "running" || this.state === "awaiting_tools")
          this.failWith(new ProviderFailure("unavailable", `harness exited (code ${e.code}): ${truncate(e.stderr.trim(), 500)}`));
        this.close("harness exited");
        break;
    }
  }

  private failWith(f: ProviderFailure) {
    log.warn(`session ${this.id} (${this.providerName}) failed: ${f.kind}: ${truncate(f.message, 300)}`);
    const waiter = this.waiter;
    this.waiter = null;
    this.sink = null;
    this.close("provider failure");
    // The server decides whether to fail over (no content sent yet) or surface the error.
    waiter?.reject(f);
  }

  close(reason: string) {
    if (this.state === "closed" && !this.run) return;
    const wasOpen = this.state !== "closed" || this.run !== null;
    this.state = "closed";
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const p of [...this.pending.values(), ...this.batch])
      p.resolve({ content: [{ type: "text", text: "Session closed." }], isError: true });
    this.pending.clear();
    this.batch = [];
    if (this.token) this.deps.bridge.unregister(this.token);
    const run = this.run;
    this.run = null;
    run?.kill();
    try {
      rmSync(this.runDir, { recursive: true, force: true });
    } catch {}
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(new ProviderFailure("unavailable", `session closed: ${reason}`));
    }
    if (wasOpen) log.debug(`session ${this.id} closed: ${reason}`);
    this.deps.onClose(this);
  }
}

function toMcpResult(r: ToolResultBlock): McpCallResult {
  const content: McpContent[] = [];
  if (typeof r.content === "string") content.push({ type: "text", text: r.content });
  else
    for (const b of r.content ?? []) {
      if (b.type === "text") content.push({ type: "text", text: (b as { text: string }).text });
      else if (b.type === "image" && (b as any).source?.type === "base64")
        content.push({ type: "image", data: (b as any).source.data, mimeType: (b as any).source.media_type });
      else content.push({ type: "text", text: `[${b.type} omitted]` });
    }
  if (!content.length) content.push({ type: "text", text: "(no output)" });
  return { content, isError: r.is_error === true };
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor(private deps: Omit<SessionDeps, "onClose">, private maxSessions: number) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
  }

  create(key: KeyRecord, target: Target, tools: ToolDef[]): Session {
    if (this.sessions.size >= this.maxSessions) this.evictOne();
    const s = new Session(key, target, tools, { ...this.deps, onClose: (x) => this.sessions.delete(x.id) });
    this.sessions.set(s.id, s);
    return s;
  }

  /** Find a live session owned by this key whose conversation matches the request's history. */
  findContinuable(keyId: string, fp: string, last: Message): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.key.id !== keyId || s.fingerprint !== fp || !s.continuable) continue;
      if (s.state === "awaiting_tools") {
        const ids = new Set(last.content.filter(isToolResult).map((r) => r.tool_use_id));
        if (!s.pendingIds().some((id) => ids.has(id))) continue;
      } else if (last.content.some(isToolResult)) continue;
      if (!best || s.lastActivity > best.lastActivity) best = s;
    }
    return best;
  }

  private evictOne() {
    const idle = [...this.sessions.values()].filter((s) => s.state !== "running").sort((a, b) => a.lastActivity - b.lastActivity);
    idle[0]?.close("evicted (maxSessions)");
  }

  private sweep() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const idleFor = now - s.lastActivity;
      if (s.state !== "running" && idleFor > this.deps.ttlMs) s.close("expired");
      else if (s.state === "running" && idleFor > this.deps.ttlMs * 2) s.close("stalled");
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      key: s.key.name,
      provider: s.providerName,
      model: s.target.model,
      state: s.state,
      idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000),
    }));
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const s of [...this.sessions.values()]) s.close("shutdown");
  }
}
