import type { ContentBlock, StopReason, Usage } from "../types.ts";

export type FailureKind = "rate_limit" | "auth" | "unavailable" | "bad_request" | "unknown";

export class ProviderFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    /** epoch ms until which the provider should not be used */
    readonly cooldownUntil?: number,
  ) {
    super(message);
  }
}

export type RunEvent =
  | { type: "text"; text: string }
  /** a new text block started in the harness (keeps paragraphs/blocks separate) */
  | { type: "text_break" }
  /** harness announced N upcoming bridge tool calls (lets the session batch parallel calls) */
  | { type: "tool_hint"; count: number }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "rate_limit"; status: string; utilization?: number; resetsAt?: number }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "error"; failure: ProviderFailure }
  | { type: "exit"; code: number | null; stderr: string };

export interface StartOptions {
  runDir: string;
  system: string;
  prompt: ContentBlock[];
  model?: string;
  /** MCP endpoint that exposes the client's tools; undefined when there are none. */
  bridgeUrl?: string;
  /** How long a single bridged tool call may stay open. */
  toolTimeoutMs: number;
}

export interface ProviderRun {
  /** Send a follow-up user turn (only when capabilities.multiTurn). */
  send(content: ContentBlock[]): void;
  kill(): void;
}

export interface Provider {
  readonly name: string;
  readonly type: string;
  readonly capabilities: { multiTurn: boolean; images: boolean };
  start(opts: StartOptions, emit: (e: RunEvent) => void): ProviderRun;
}
