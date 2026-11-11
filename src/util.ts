import { createHash, randomBytes } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function randId(prefix: string, bytes = 18): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

/** Simple glob: `*` = any run of chars, `?` = one char. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

export function matchAny(value: string, patterns: string[] | undefined): boolean {
  if (!patterns) return false;
  return patterns.some((p) => globToRegExp(p).test(value));
}

/** "30d", "12h", "15m", "45s" -> milliseconds */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s} (use e.g. 30d, 12h, 15m)`);
  const mult = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2] as "s"];
  return Number(m[1]) * mult;
}

export function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

let logLevel: "debug" | "info" = process.env.SUBGATE_DEBUG ? "debug" : "info";
export const setDebug = (on: boolean) => (logLevel = on ? "debug" : "info");
export const log = {
  info: (...a: unknown[]) => console.error(new Date().toISOString(), ...a),
  warn: (...a: unknown[]) => console.error(new Date().toISOString(), "WARN", ...a),
  debug: (...a: unknown[]) => {
    if (logLevel === "debug") console.error(new Date().toISOString(), "DEBUG", ...a);
  },
};

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}
