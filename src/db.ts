import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { validatePolicy, type KeyPolicy } from "./policy.ts";
import { randId, sha256 } from "./util.ts";

export interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
  policy: KeyPolicy;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface UsageRow {
  key_id: string;
  model: string;
  provider: string;
  target_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  stop_reason: string;
  status: "ok" | "error";
  duration_ms: number;
}

export class Store {
  readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "subgate.sqlite"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        target_model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        stop_reason TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_key_ts ON usage(key_id, ts);
    `);
  }

  private row(r: any): KeyRecord {
    return { ...r, policy: JSON.parse(r.policy) };
  }

  createKey(name: string, policy: KeyPolicy): { record: KeyRecord; secret: string } {
    validatePolicy(policy);
    const secret = randId("sg-", 32);
    const id = randId("key_", 8);
    const now = Date.now();
    this.db
      .query("INSERT INTO keys (id, name, prefix, hash, policy, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, secret.slice(0, 10), sha256(secret), JSON.stringify(policy), now);
    return { record: this.getKey(id)!, secret };
  }

  getKey(idOrName: string): KeyRecord | null {
    const r = this.db.query("SELECT * FROM keys WHERE id = ? OR name = ?").get(idOrName, idOrName);
    return r ? this.row(r) : null;
  }

  authenticate(secret: string): KeyRecord | null {
    const r = this.db.query("SELECT * FROM keys WHERE hash = ?").get(sha256(secret));
    if (!r) return null;
    const rec = this.row(r);
    if (rec.revoked_at) return null;
    this.db.query("UPDATE keys SET last_used_at = ? WHERE id = ?").run(Date.now(), rec.id);
    return rec;
  }

  listKeys(): KeyRecord[] {
    return this.db.query("SELECT * FROM keys ORDER BY created_at").all().map((r) => this.row(r));
  }

  setPolicy(id: string, policy: KeyPolicy): void {
    validatePolicy(policy);
    this.db.query("UPDATE keys SET policy = ? WHERE id = ?").run(JSON.stringify(policy), id);
  }

  revoke(id: string): void {
    this.db.query("UPDATE keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  }

  remove(id: string): void {
    this.db.query("DELETE FROM keys WHERE id = ?").run(id);
  }

  recordUsage(u: UsageRow): void {
    this.db
      .query(
        `INSERT INTO usage (key_id, ts, model, provider, target_model, input_tokens, output_tokens, cache_read, cache_write, stop_reason, status, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.key_id, Date.now(), u.model, u.provider, u.target_model, u.input_tokens, u.output_tokens, u.cache_read, u.cache_write, u.stop_reason, u.status, u.duration_ms);
  }

  usageSince(keyId: string, since: number): { requests: number; input: number; output: number } {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens + cache_read + cache_write), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output
         FROM usage WHERE key_id = ? AND ts >= ?`,
      )
      .get(keyId, since) as { requests: number; input: number; output: number };
    return r;
  }

  usageReport(since: number, keyId?: string) {
    return this.db
      .query(
        `SELECT k.name AS key, u.provider, u.target_model AS model, COUNT(*) AS requests,
                SUM(u.input_tokens + u.cache_read + u.cache_write) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
                SUM(CASE WHEN u.status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM usage u LEFT JOIN keys k ON k.id = u.key_id
         WHERE u.ts >= ? AND (? IS NULL OR u.key_id = ?)
         GROUP BY k.name, u.provider, u.target_model ORDER BY k.name`,
      )
      .all(since, keyId ?? null, keyId ?? null);
  }
}
