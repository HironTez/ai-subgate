import type { ContentBlock, StopReason, Usage } from "./types.ts";
import { zeroUsage } from "./types.ts";
import { randId } from "./util.ts";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

const statusFor: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

export function errorResponse(type: ErrorType, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ type: "error", error: { type, message } }, { status: statusFor[type], headers });
}

/**
 * Accumulates one assistant message and renders it either as an SSE stream or a JSON body.
 * "contentEmitted" marks the point after which provider failover is no longer possible.
 */
export abstract class Sink {
  readonly id = randId("msg_");
  contentEmitted = false;
  closed = false;
  readonly blocks: ContentBlock[] = [];
  protected openText: number | null = null;
  private abortHandlers: Array<() => void> = [];

  constructor(readonly model: string) {}

  abstract response(): Promise<Response>;
  protected abstract begin(): void;
  protected abstract event(name: string, data: Record<string, unknown>): void;
  protected abstract end(): void;
  protected abstract endWithError(type: ErrorType, message: string): void;

  onAbort(fn: () => void) {
    this.abortHandlers.push(fn);
  }
  protected aborted() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.abortHandlers) fn();
  }

  private ensureBegun() {
    if (!this.contentEmitted) {
      this.contentEmitted = true;
      this.begin();
    }
  }

  text(t: string) {
    if (!t || this.closed) return;
    this.ensureBegun();
    if (this.openText === null) {
      this.openText = this.blocks.length;
      this.blocks.push({ type: "text", text: "" });
      this.event("content_block_start", { index: this.openText, content_block: { type: "text", text: "" } });
    }
    (this.blocks[this.openText] as { text: string }).text += t;
    this.event("content_block_delta", { index: this.openText, delta: { type: "text_delta", text: t } });
  }

  textBreak() {
    if (this.openText === null) return;
    this.event("content_block_stop", { index: this.openText });
    this.openText = null;
  }

  toolUse(id: string, name: string, input: unknown) {
    if (this.closed) return;
    this.ensureBegun();
    this.textBreak();
    const index = this.blocks.length;
    this.blocks.push({ type: "tool_use", id, name, input });
    this.event("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } });
    this.event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input ?? {}) } });
    this.event("content_block_stop", { index });
  }

  stopReason: StopReason | null = null;
  usage: Usage = zeroUsage();

  finish(stop: StopReason, usage: Usage) {
    if (this.closed) return;
    this.ensureBegun();
    this.textBreak();
    this.stopReason = stop;
    this.usage = usage;
    this.event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage });
    this.event("message_stop", {});
    this.closed = true;
    this.end();
  }

  fail(type: ErrorType, message: string) {
    if (this.closed) return;
    this.closed = true;
    this.endWithError(type, message);
  }

  protected messageSkeleton(): Record<string, unknown> {
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: zeroUsage(),
    };
  }
}

export class StreamSink extends Sink {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private stream: ReadableStream<Uint8Array>;
  private resolveResponse!: (r: Response) => void;
  private responsePromise: Promise<Response>;
  private headersSent = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private earlyTimer: ReturnType<typeof setTimeout>;
  private enc = new TextEncoder();
  private startedEnvelope = false;

  constructor(model: string, signal: AbortSignal, keepaliveAfterMs = 5000) {
    super(model);
    this.stream = new ReadableStream({
      start: (c) => void (this.controller = c),
      cancel: () => this.aborted(),
    });
    this.responsePromise = new Promise((r) => (this.resolveResponse = r));
    signal.addEventListener("abort", () => this.aborted());
    // Send headers + message_start early so clients don't time out while the harness boots.
    // That does not "emit content", so failover stays possible.
    this.earlyTimer = setTimeout(() => this.sendHeaders(), keepaliveAfterMs);
  }

  response() {
    return this.responsePromise;
  }

  private write(name: string, data: Record<string, unknown>) {
    try {
      this.controller.enqueue(this.enc.encode(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`));
    } catch {
      this.aborted();
    }
  }

  private sendHeaders() {
    if (this.headersSent || this.closed) return;
    this.headersSent = true;
    clearTimeout(this.earlyTimer);
    this.resolveResponse(
      new Response(this.stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      }),
    );
    this.write("message_start", { message: this.messageSkeleton() });
    this.startedEnvelope = true;
    this.pingTimer = setInterval(() => this.write("ping", {}), 15000);
  }

  protected begin() {
    this.sendHeaders();
  }
  protected event(name: string, data: Record<string, unknown>) {
    this.write(name, data);
  }
  private cleanup() {
    clearTimeout(this.earlyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.controller.close();
    } catch {}
  }
  protected end() {
    this.cleanup();
  }
  protected endWithError(type: ErrorType, message: string) {
    if (!this.headersSent) {
      clearTimeout(this.earlyTimer);
      this.headersSent = true;
      this.resolveResponse(errorResponse(type, message));
      return;
    }
    if (this.startedEnvelope) this.write("error", { error: { type, message } });
    this.cleanup();
  }
}

export class JsonSink extends Sink {
  private resolveResponse!: (r: Response) => void;
  private responsePromise = new Promise<Response>((r) => (this.resolveResponse = r));

  constructor(model: string, signal: AbortSignal) {
    super(model);
    signal.addEventListener("abort", () => this.aborted());
  }
  response() {
    return this.responsePromise;
  }
  protected begin() {}
  protected event() {}
  protected end() {
    this.resolveResponse(
      Response.json({ ...this.messageSkeleton(), content: this.blocks, stop_reason: this.stopReason, usage: this.usage }),
    );
  }
  protected endWithError(type: ErrorType, message: string) {
    this.resolveResponse(errorResponse(type, message));
  }
}
