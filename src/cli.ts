#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configPath, defaultConfig, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { validatePolicy, type KeyPolicy } from "./policy.ts";
import { Gateway } from "./server.ts";
import { parseDuration, setDebug } from "./util.ts";

const HELP = `subgate — Anthropic-compatible API over your subscription harnesses

Usage:
  subgate init                         write a default subgate.json
  subgate serve [--debug]              start the gateway
  subgate keys create <name> [policy flags]
  subgate keys update <id|name> [policy flags]   (merges into the existing policy)
  subgate keys list
  subgate keys show <id|name>
  subgate keys revoke <id|name>
  subgate keys delete <id|name>
  subgate keys unsuspend <id|name>               (after reviewing its moderation events)
  subgate usage [--key <id|name>] [--days N]
  subgate moderation [--key <id|name>] [--days N] blocked/flagged requests

Policy flags:
  --models <globs>          comma-separated model globs the key may request (default *)
  --model-override <name>   route every request as this model
  --providers <names>       provider instances the key may use (default all)
  --tools-allow <globs>     client tools exposed to the model (default *)
  --tools-deny <globs>      client tools never exposed
  --arg-deny <tool=regex>   reject tool calls whose JSON input matches (repeatable)
  --max-tools <n>
  --rpm <n>  --concurrency <n>  --requests-per-day <n>  --tokens-per-day <n>  --output-tokens-per-day <n>
  --system <text>           system prompt prepended to every request
  --no-images               strip image inputs
  --expires <30d|ISO>       expiry
  --moderation <on|off>     prompt screening for this key (default on when enabled in config)
  --moderation-scope <user|all>  also screen tool results and tool descriptions ("all")
  --policy <json>           full policy JSON (merged first, flags override)

Global: --config <path> (default ./subgate.json or $SUBGATE_CONFIG)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    debug: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    models: { type: "string" },
    "model-override": { type: "string" },
    providers: { type: "string" },
    "tools-allow": { type: "string" },
    "tools-deny": { type: "string" },
    "arg-deny": { type: "string", multiple: true },
    "max-tools": { type: "string" },
    rpm: { type: "string" },
    concurrency: { type: "string" },
    "requests-per-day": { type: "string" },
    "tokens-per-day": { type: "string" },
    "output-tokens-per-day": { type: "string" },
    system: { type: "string" },
    "no-images": { type: "boolean" },
    expires: { type: "string" },
    moderation: { type: "string" },
    "moderation-scope": { type: "string" },
    policy: { type: "string" },
    key: { type: "string" },
    days: { type: "string" },
  },
});

const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const num = (s?: string) => (s === undefined ? undefined : Number(s));

function policyFromFlags(base: KeyPolicy): KeyPolicy {
  const p: KeyPolicy = structuredClone({ ...base, ...(flags.policy ? JSON.parse(flags.policy) : {}) });
  if (flags.models) p.models = list(flags.models);
  if (flags["model-override"]) p.modelOverride = flags["model-override"];
  if (flags.providers) p.providers = list(flags.providers);
  if (flags["tools-allow"] || flags["tools-deny"] || flags["arg-deny"] || flags["max-tools"]) {
    p.tools = { ...p.tools };
    if (flags["tools-allow"]) p.tools.allow = list(flags["tools-allow"]);
    if (flags["tools-deny"]) p.tools.deny = list(flags["tools-deny"]);
    if (flags["max-tools"]) p.tools.max = num(flags["max-tools"]);
    if (flags["arg-deny"])
      p.tools.argDeny = [
        ...(p.tools.argDeny ?? []),
        ...flags["arg-deny"].map((r) => {
          const i = r.indexOf("=");
          if (i < 1) throw new Error(`--arg-deny expects tool=regex, got ${r}`);
          return { tool: r.slice(0, i), pattern: r.slice(i + 1) };
        }),
      ];
  }
  const limits = {
    rpm: num(flags.rpm),
    concurrency: num(flags.concurrency),
    requestsPerDay: num(flags["requests-per-day"]),
    tokensPerDay: num(flags["tokens-per-day"]),
    outputTokensPerDay: num(flags["output-tokens-per-day"]),
  };
  for (const [k, v] of Object.entries(limits)) if (v !== undefined) (p.limits ??= {})[k as keyof typeof limits] = v;
  if (flags.system !== undefined) p.systemPrompt = flags.system;
  if (flags["no-images"]) p.allowImages = false;
  if (flags.expires)
    p.expiresAt = /^\d+[smhdw]$/.test(flags.expires) ? new Date(Date.now() + parseDuration(flags.expires)).toISOString() : new Date(flags.expires).toISOString();
  if (flags.moderation || flags["moderation-scope"]) {
    p.moderation = { ...p.moderation };
    if (flags.moderation) {
      if (!["on", "off"].includes(flags.moderation)) throw new Error("--moderation expects on|off");
      p.moderation.enabled = flags.moderation === "on";
    }
    if (flags["moderation-scope"]) {
      if (!["user", "all"].includes(flags["moderation-scope"])) throw new Error("--moderation-scope expects user|all");
      p.moderation.scope = flags["moderation-scope"] as "user" | "all";
    }
  }
  return validatePolicy(p);
}

function fmtDate(ms: number | null) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "-";
}

async function main() {
  const [cmd, sub, arg] = positionals;
  if (flags.help || !cmd) return console.log(HELP);
  if (flags.debug) setDebug(true);

  if (cmd === "init") {
    const path = configPath(flags.config);
    if (existsSync(path)) throw new Error(`${path} already exists`);
    writeFileSync(path, JSON.stringify(defaultConfig(), null, 2) + "\n");
    return console.log(`wrote ${path}`);
  }

  const cfg = loadConfig(flags.config);
  const store = new Store(cfg.dataDir);

  if (cmd === "serve") {
    const gw = new Gateway(cfg, store);
    gw.listen();
    const stop = () => {
      gw.sessions.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (cmd === "keys") {
    const need = () => {
      if (!arg) throw new Error("missing key id or name");
      const k = store.getKey(arg);
      if (!k) throw new Error(`no key ${arg}`);
      return k;
    };
    switch (sub) {
      case "create": {
        if (!arg) throw new Error("usage: subgate keys create <name> [flags]");
        const { record, secret } = store.createKey(arg, policyFromFlags({}));
        console.log(`created ${record.id} (${record.name})\n\n  ${secret}\n\nStore it now; it is not shown again.`);
        console.log(`policy: ${JSON.stringify(record.policy)}`);
        return;
      }
      case "update": {
        const k = need();
        const p = policyFromFlags(k.policy);
        store.setPolicy(k.id, p);
        return console.log(`updated ${k.name}: ${JSON.stringify(p)}`);
      }
      case "list":
        for (const k of store.listKeys())
          console.log(
            `${k.id}  ${k.name.padEnd(20)} ${k.prefix}…  ${k.revoked_at ? "REVOKED" : "active "}  created ${fmtDate(k.created_at)}  last used ${fmtDate(k.last_used_at)}`,
          );
        return;
      case "show":
        return console.log(JSON.stringify({ ...need(), hash: undefined }, null, 2));
      case "revoke": {
        const k = need();
        store.revoke(k.id);
        return console.log(`revoked ${k.name}`);
      }
      case "unsuspend": {
        const k = need();
        store.clearModeration(k.id);
        return console.log(`cleared moderation suspension for ${k.name} (earlier blocks no longer count)`);
      }
      case "delete": {
        const k = need();
        store.remove(k.id);
        return console.log(`deleted ${k.name}`);
      }
    }
    throw new Error(`unknown keys subcommand: ${sub}`);
  }

  if (cmd === "usage") {
    const days = Number(flags.days ?? 1);
    const keyId = flags.key ? store.getKey(flags.key)?.id : undefined;
    if (flags.key && !keyId) throw new Error(`no key ${flags.key}`);
    console.table(store.usageReport(Date.now() - days * 86_400_000, keyId));
    return;
  }

  if (cmd === "moderation") {
    const days = Number(flags.days ?? 7);
    const keyId = flags.key ? store.getKey(flags.key)?.id : undefined;
    if (flags.key && !keyId) throw new Error(`no key ${flags.key}`);
    const rows = store.moderationReport(Date.now() - days * 86_400_000, keyId);
    if (!rows.length) return console.log(`no blocked or flagged requests in the last ${days} day(s)`);
    for (const r of rows as any[]) console.log(`${r.time}  ${r.key}  ${r.verdict.toUpperCase()}  ${r.category} (${r.kind})\n    ${r.reason}\n    > ${r.excerpt}`);
    return;
  }

  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
