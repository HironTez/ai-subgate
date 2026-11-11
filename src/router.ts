/**
 * Maps a client model name to an ordered list of harness targets and tracks provider health,
 * so exhausted or broken subscriptions are skipped until they recover.
 */
import type { Config, RouteTarget } from "./config.ts";
import { providerAllowed, type KeyPolicy } from "./policy.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { CodexProvider } from "./providers/codex.ts";
import { MockProvider } from "./providers/mock.ts";
import type { Provider, ProviderFailure } from "./providers/types.ts";
import { globToRegExp, log } from "./util.ts";

export interface Target {
  provider: Provider;
  model?: string;
}

interface Health {
  cooldownUntil: number;
  reason?: string;
  utilization?: number;
  lastOk?: number;
  failures: number;
}

export class Router {
  readonly providers = new Map<string, Provider>();
  private health = new Map<string, Health>();

  constructor(private cfg: Config) {
    for (const [name, pc] of Object.entries(cfg.providers)) {
      if (pc.enabled === false) continue;
      const P = { claude: ClaudeProvider, codex: CodexProvider, mock: MockProvider }[pc.type];
      if (!P) throw new Error(`unknown provider type ${pc.type}`);
      this.providers.set(name, new P(name, pc));
      this.health.set(name, { cooldownUntil: 0, failures: 0 });
    }
  }

  /** Healthy targets first (in route order), then cooling-down ones by earliest recovery. */
  candidates(model: string, policy: KeyPolicy): Target[] {
    const route = this.cfg.routes.find((r) => globToRegExp(r.match).test(model));
    if (!route) return [];
    const now = Date.now();
    const usable = route.targets.filter((t: RouteTarget) => this.providers.has(t.provider) && providerAllowed(policy, t.provider));
    const healthy = usable.filter((t) => this.health.get(t.provider)!.cooldownUntil <= now);
    const cooling = usable
      .filter((t) => this.health.get(t.provider)!.cooldownUntil > now)
      .sort((a, b) => this.health.get(a.provider)!.cooldownUntil - this.health.get(b.provider)!.cooldownUntil);
    return [...healthy, ...cooling].map((t) => ({ provider: this.providers.get(t.provider)!, model: t.model }));
  }

  markFailure(provider: string, f: ProviderFailure) {
    const h = this.health.get(provider);
    if (!h) return;
    h.failures++;
    const fo = this.cfg.failover;
    const secs =
      f.kind === "rate_limit" ? fo.rateLimitCooldownSeconds : f.kind === "auth" ? 600 : f.kind === "bad_request" ? 0 : fo.defaultCooldownSeconds;
    const until = f.cooldownUntil ?? Date.now() + secs * 1000;
    if (until > Date.now()) {
      h.cooldownUntil = Math.max(h.cooldownUntil, until);
      h.reason = `${f.kind}: ${f.message}`.slice(0, 300);
      log.warn(`provider ${provider} cooling down until ${new Date(h.cooldownUntil).toISOString()} (${f.kind})`);
    }
  }

  markSuccess(provider: string) {
    const h = this.health.get(provider);
    if (!h) return;
    h.failures = 0;
    h.lastOk = Date.now();
  }

  /** Proactive switching: harnesses report how much of the subscription window is used. */
  onRateLimit(provider: string, status: string, utilization?: number, resetsAt?: number) {
    const h = this.health.get(provider);
    if (!h) return;
    h.utilization = utilization;
    const exhausted = status === "rejected" || (utilization !== undefined && utilization >= this.cfg.failover.switchAtUtilization);
    if (exhausted) {
      h.cooldownUntil = Math.max(h.cooldownUntil, resetsAt ?? Date.now() + this.cfg.failover.rateLimitCooldownSeconds * 1000);
      h.reason = `subscription window ${status} (utilization ${utilization ?? "?"})`;
      log.warn(`provider ${provider} near/at limit; preferring other providers until ${new Date(h.cooldownUntil).toISOString()}`);
    }
  }

  status() {
    const now = Date.now();
    return [...this.providers.keys()].map((name) => {
      const h = this.health.get(name)!;
      return {
        name,
        type: this.providers.get(name)!.type,
        available: h.cooldownUntil <= now,
        cooldownUntil: h.cooldownUntil > now ? new Date(h.cooldownUntil).toISOString() : null,
        reason: h.cooldownUntil > now ? h.reason : undefined,
        utilization: h.utilization,
        lastOk: h.lastOk ? new Date(h.lastOk).toISOString() : null,
      };
    });
  }
}
