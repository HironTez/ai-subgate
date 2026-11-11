import type { ToolDef } from "./types.ts";
import { globToRegExp, matchAny } from "./util.ts";

/**
 * Per-API-key policy. Everything is optional; an empty policy means
 * "any model, any provider, any client tool, no limits".
 */
export interface KeyPolicy {
  /** Globs of client-facing model names this key may request. Default ["*"]. */
  models?: string[];
  /** Force every request from this key to be routed as this model name. */
  modelOverride?: string;
  /** Provider instances (config.providers keys) this key may be served by. Default: all. */
  providers?: string[];
  tools?: {
    /** Globs of client tool names that are exposed to the model. Default ["*"]. */
    allow?: string[];
    /** Globs of client tool names that are never exposed. Wins over allow. */
    deny?: string[];
    /**
     * Argument rules: when the model calls a matching tool with input whose JSON matches
     * `pattern` (regex), the call is rejected by the gateway and never reaches the client.
     */
    argDeny?: Array<{ tool: string; pattern: string; reason?: string }>;
    /** Max number of tools exposed per request (extra ones are dropped). */
    max?: number;
  };
  limits?: {
    /** Requests per minute. */
    rpm?: number;
    /** Simultaneous in-flight requests. */
    concurrency?: number;
    requestsPerDay?: number;
    /** input + output tokens per UTC day. */
    tokensPerDay?: number;
    outputTokensPerDay?: number;
  };
  /** Prepended to the client's system prompt; the client cannot remove it. */
  systemPrompt?: string;
  /** Whether image inputs are forwarded. Default true. */
  allowImages?: boolean;
  /** ISO timestamp after which the key stops working. */
  expiresAt?: string;
}

export function modelAllowed(policy: KeyPolicy, model: string): boolean {
  return matchAny(model, policy.models ?? ["*"]);
}

export function providerAllowed(policy: KeyPolicy, provider: string): boolean {
  return !policy.providers || policy.providers.includes(provider);
}

export interface ToolFilterResult {
  allowed: ToolDef[];
  dropped: string[];
}

/** Only client-defined ("custom") tools are bridged; server tools (web_search etc.) are dropped. */
export function filterTools(tools: ToolDef[] | undefined, policy: KeyPolicy): ToolFilterResult {
  const allowed: ToolDef[] = [];
  const dropped: string[] = [];
  const allow = policy.tools?.allow ?? ["*"];
  const deny = policy.tools?.deny ?? [];
  for (const t of tools ?? []) {
    const custom = !t.type || t.type === "custom";
    if (!custom || !t.name || !matchAny(t.name, allow) || matchAny(t.name, deny)) {
      dropped.push(t.name ?? t.type ?? "?");
      continue;
    }
    if (policy.tools?.max !== undefined && allowed.length >= policy.tools.max) {
      dropped.push(t.name);
      continue;
    }
    allowed.push(t);
  }
  return { allowed, dropped };
}

/** Returns a rejection reason if the tool call violates an argDeny rule. */
export function checkToolArgs(policy: KeyPolicy, tool: string, input: unknown): string | null {
  const json = JSON.stringify(input ?? {});
  for (const rule of policy.tools?.argDeny ?? []) {
    if (!globToRegExp(rule.tool).test(tool)) continue;
    if (new RegExp(rule.pattern).test(json)) return rule.reason ?? `blocked by gateway policy (${rule.pattern})`;
  }
  return null;
}

export function validatePolicy(p: unknown): KeyPolicy {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("policy must be an object");
  const policy = p as KeyPolicy;
  for (const r of policy.tools?.argDeny ?? []) new RegExp(r.pattern); // throws on bad regex
  if (policy.expiresAt && Number.isNaN(Date.parse(policy.expiresAt))) throw new Error("expiresAt must be ISO date");
  return policy;
}

/** In-memory RPM + concurrency limiter. Daily quotas are checked against the DB. */
export class Limiter {
  private windows = new Map<string, number[]>();
  private inflight = new Map<string, number>();

  check(keyId: string, policy: KeyPolicy): { ok: true } | { ok: false; reason: string; retryAfter: number } {
    const lim = policy.limits ?? {};
    const now = Date.now();
    if (lim.rpm !== undefined) {
      const w = (this.windows.get(keyId) ?? []).filter((t) => now - t < 60_000);
      this.windows.set(keyId, w);
      if (w.length >= lim.rpm)
        return { ok: false, reason: `rate limit: ${lim.rpm} requests/minute`, retryAfter: Math.ceil((60_000 - (now - w[0])) / 1000) };
    }
    if (lim.concurrency !== undefined && (this.inflight.get(keyId) ?? 0) >= lim.concurrency)
      return { ok: false, reason: `concurrency limit: ${lim.concurrency}`, retryAfter: 1 };
    return { ok: true };
  }

  acquire(keyId: string): () => void {
    const w = this.windows.get(keyId) ?? [];
    w.push(Date.now());
    this.windows.set(keyId, w);
    this.inflight.set(keyId, (this.inflight.get(keyId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight.set(keyId, Math.max(0, (this.inflight.get(keyId) ?? 1) - 1));
    };
  }
}
