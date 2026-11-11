// Fake local classifier for tests: blocks "FORBIDDEN", flags "BORDERLINE", crashes on "CRASH".
import { appendFileSync } from "node:fs";
const { items } = JSON.parse(await Bun.stdin.text()) as { items: Array<{ id: number; text: string }> };
if (process.env.MOD_COUNTER) appendFileSync(process.env.MOD_COUNTER, "x");
if (items.some((i) => i.text.includes("CRASH"))) process.exit(3);
const hit = (w: string) => items.filter((i) => i.text.includes(w)).map((i) => i.id);
const blocked = hit("FORBIDDEN");
const flagged = hit("BORDERLINE");
console.log(
  JSON.stringify(
    blocked.length
      ? { verdict: "block", category: "other_illegal", reason: "test block", flagged_items: blocked }
      : flagged.length
        ? { verdict: "flag", category: "borderline", reason: "test flag", flagged_items: flagged }
        : { verdict: "allow", category: "none", reason: "fine", flagged_items: [] },
  ),
);
