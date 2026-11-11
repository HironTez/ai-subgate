/**
 * Runs Claude harnesses under an isolated, profile-less config dir.
 *
 * With the owner's normal ~/.claude profile, Claude Code injects account context (the account
 * email, among others) into every conversation, so any API client could ask the model for it.
 * Instead the harness gets its own empty CLAUDE_CONFIG_DIR and only an OAuth token:
 *
 *   1. provider.oauthTokenFile: a long-lived token from `claude setup-token` (recommended)
 *   2. otherwise the current access token from the owner's credentials file, while it has at
 *      least an hour of validity left (the owner's own Claude Code keeps it refreshed)
 *   3. otherwise the shared profile, with a warning (the leak this module exists to prevent)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.ts";
import { log } from "../util.ts";

const MIN_VALIDITY_MS = 60 * 60 * 1000;
const warned = new Set<string>();

function warnOnce(name: string, msg: string) {
  if (warned.has(name + msg)) return;
  warned.add(name + msg);
  log.warn(`provider ${name}: ${msg}`);
}

function readToken(name: string, pc: ProviderConfig): string | null {
  if (pc.oauthTokenFile) {
    try {
      const t = readFileSync(pc.oauthTokenFile, "utf8").trim();
      if (t) return t;
      warnOnce(name, `oauthTokenFile ${pc.oauthTokenFile} is empty`);
    } catch (e) {
      warnOnce(name, `cannot read oauthTokenFile ${pc.oauthTokenFile}: ${(e as Error).message}`);
    }
  }
  const credDir = pc.env?.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? homedir(), ".claude");
  try {
    const c = JSON.parse(readFileSync(join(credDir, ".credentials.json"), "utf8")).claudeAiOauth;
    if (c?.accessToken && Number(c.expiresAt) - Date.now() > MIN_VALIDITY_MS) return c.accessToken;
  } catch {}
  return null;
}

/** Environment overrides for a Claude harness; empty when isolation is off or impossible. */
export function claudeAuthEnv(name: string, pc: ProviderConfig, dataDir: string): Record<string, string> {
  if (pc.isolateProfile === false) return {};
  const token = readToken(name, pc);
  if (!token) {
    warnOnce(
      name,
      "no OAuth token for an isolated harness profile; using the shared profile, which exposes the account email " +
        "to API clients. Run `claude setup-token` and set providers." + name + ".oauthTokenFile.",
    );
    return {};
  }
  const dir = join(dataDir, "claude-home", name);
  mkdirSync(dir, { recursive: true });
  scrubProfile(join(dir, ".claude.json"));
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token };
}

/** Make sure no account profile gets persisted into the isolated config. */
function scrubProfile(path: string) {
  if (!existsSync(path)) return;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j.oauthAccount) {
      delete j.oauthAccount;
      writeFileSync(path, JSON.stringify(j, null, 2));
    }
  } catch {}
}
