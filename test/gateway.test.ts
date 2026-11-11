import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Gateway } from "../src/server.ts";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let dir: string;
let gw: Gateway;
let server: ReturnType<Gateway["listen"]>;
let store: Store;
const keys: Record<string, string> = {};

const weatherTool = {
  name: "get_weather",
  description: "Weather for a city",
  input_schema: { type: "object", properties: { city: { type: "string" } } },
};
const bashTool = { name: "Bash", description: "run shell", input_schema: { type: "object", properties: { command: { type: "string" } } } };

beforeAll(() => {
  dir = mkdtempSync(join(process.env.SUBGATE_TEST_TMP ?? tmpdir(), "subgate-test-"));
  const cfg: Config = {
    ...defaultConfig(),
    listen: { host: "127.0.0.1", port },
    dataDir: dir,
    providers: {
      broken: { type: "mock", env: { MOCK_FORCE: "fail" } },
      good: { type: "mock" },
      solo: { type: "mock" },
    },
    routes: [
      { match: "failover-*", targets: [{ provider: "broken" }, { provider: "good" }] },
      { match: "*", targets: [{ provider: "solo" }] },
    ],
    moderation: {
      ...defaultConfig().moderation,
      classifier: "command",
      command: [process.execPath, join(import.meta.dir, "fixtures/classifier.ts")],
      blockPatterns: ["evil-pattern-\\d+"],
      suspendAfterBlocks: 3,
    },
  };
  process.env.MOD_COUNTER = join(dir, "classifier-calls");
  store = new Store(dir);
  gw = new Gateway(cfg, store);
  server = gw.listen();
  keys.open = store.createKey("open", {}).secret;
  keys.scoped = store.createKey("scoped", {
    models: ["claude-*"],
    tools: { deny: ["Bash"], argDeny: [{ tool: "get_weather", pattern: "Mordor", reason: "no." }] },
    limits: { rpm: 100 },
  }).secret;
  keys.limited = store.createKey("limited", { limits: { rpm: 1 } }).secret;
  keys.mod = store.createKey("mod", {}).secret;
  keys.modAll = store.createKey("mod-all", { moderation: { scope: "all" } }).secret;
  keys.modOff = store.createKey("mod-off", { moderation: { enabled: false } }).secret;
  keys.offender = store.createKey("offender", {}).secret;
});

afterAll(() => {
  gw.sessions.shutdown();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function post(key: string, body: object, path = "/v1/messages") {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ max_tokens: 1000, ...body }),
  });
  return { status: r.status, json: (await r.json()) as any };
}

async function stream(key: string, body: object) {
  const r = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ max_tokens: 1000, stream: true, ...body }),
  });
  const text = await r.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

describe("auth & policy", () => {
  test("rejects missing and bad keys", async () => {
    expect((await post("", { model: "x", messages: [{ role: "user", content: "hi" }] })).status).toBe(401);
    expect((await post("sg-nope", { model: "x", messages: [{ role: "user", content: "hi" }] })).status).toBe(401);
  });

  test("model scope", async () => {
    const r = await post(keys.scoped, { model: "gpt-anything", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(403);
    expect(r.json.error.type).toBe("permission_error");
  });

  test("rpm limit", async () => {
    expect((await post(keys.limited, { model: "m", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    const r = await post(keys.limited, { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(429);
  });

  test("revoked key", async () => {
    const { record, secret } = store.createKey("temp", {});
    store.revoke(record.id);
    expect((await post(secret, { model: "m", messages: [{ role: "user", content: "hi" }] })).status).toBe(401);
  });
});

describe("messages", () => {
  test("plain completion (json)", async () => {
    const r = await post(keys.open, { model: "claude-x", messages: [{ role: "user", content: "hello there" }] });
    expect(r.status).toBe(200);
    expect(r.json.type).toBe("message");
    expect(r.json.content[0].text).toBe("echo: hello there");
    expect(r.json.stop_reason).toBe("end_turn");
  });

  test("streaming emits a well-formed SSE sequence", async () => {
    const ev = await stream(keys.open, { model: "claude-x", messages: [{ role: "user", content: "streamed" }] });
    const types = ev.map((e) => e.type).filter((t) => t !== "ping");
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(ev.find((e) => e.type === "content_block_delta").delta.text).toBe("echo: streamed");
  });

  test("failover to next provider when first fails before output", async () => {
    const r = await post(keys.open, { model: "failover-model", messages: [{ role: "user", content: "anyone?" }] });
    expect(r.status).toBe(200);
    expect(r.json.content[0].text).toBe("echo: anyone?");
    expect(gw.router.status().find((p) => p.name === "broken")!.available).toBe(false);
  });

  test("multi-turn continues the same harness session", async () => {
    const m1 = [{ role: "user", content: "first" }];
    const r1 = await post(keys.open, { model: "claude-x", messages: m1 });
    const before = gw.sessions.list().length;
    const r2 = await post(keys.open, {
      model: "claude-x",
      messages: [...m1, { role: "assistant", content: r1.json.content }, { role: "user", content: "second" }],
    });
    expect(r2.json.content[0].text).toBe("echo: second");
    expect(gw.sessions.list().length).toBe(before); // no new session spawned
  });
});

describe("client-side tools", () => {
  test("tool round-trip resumes the paused harness", async () => {
    const messages: any[] = [{ role: "user", content: 'call get_weather {"city":"Berlin"}' }];
    const r1 = await post(keys.scoped, { model: "claude-x", tools: [weatherTool, bashTool], messages });
    expect(r1.json.stop_reason).toBe("tool_use");
    const tu = r1.json.content.find((b: any) => b.type === "tool_use");
    expect(tu.name).toBe("get_weather");
    expect(tu.input).toEqual({ city: "Berlin" });
    expect(r1.json.content[0]).toEqual({ type: "text", text: "Calling tool." });

    const sessionsBefore = gw.sessions.list().length;
    messages.push({ role: "assistant", content: r1.json.content });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "sunny, 21C" }] });
    const r2 = await post(keys.scoped, { model: "claude-x", tools: [weatherTool, bashTool], messages });
    expect(r2.json.stop_reason).toBe("end_turn");
    expect(r2.json.content[0].text).toBe("Tool said: sunny, 21C");
    expect(gw.sessions.list().length).toBe(sessionsBefore);
  });

  test("parallel tool calls are returned in one response", async () => {
    const r = await post(keys.open, { model: "claude-x", tools: [weatherTool], messages: [{ role: "user", content: "parallel" }] });
    const uses = r.json.content.filter((b: any) => b.type === "tool_use");
    expect(uses.length).toBe(2);
    expect(r.json.stop_reason).toBe("tool_use");
  });

  test("denied tools are never exposed to the model", async () => {
    const messages: any[] = [{ role: "user", content: 'call Bash {"command":"id"}' }];
    const r = await post(keys.scoped, { model: "claude-x", tools: [weatherTool, bashTool], messages });
    expect(r.json.stop_reason).toBe("end_turn");
    expect(r.json.content.some((b: any) => b.type === "tool_use")).toBe(false);
    expect(r.json.content.at(-1).text).toContain("ERROR Unknown tool: Bash");
  });

  test("argDeny rejects a call inside the gateway", async () => {
    const r = await post(keys.scoped, {
      model: "claude-x",
      tools: [weatherTool],
      messages: [{ role: "user", content: 'call get_weather {"city":"Mordor"}' }],
    });
    expect(r.json.stop_reason).toBe("end_turn");
    expect(r.json.content.at(-1).text).toContain("rejected by gateway policy: no.");
  });

  test("orphaned tool_result (no live session) is replayed as a transcript", async () => {
    const r = await post(keys.open, {
      model: "claude-x",
      tools: [weatherTool],
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_gone", name: "get_weather", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_gone", content: "rain" }] },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.content[0].text).toBe("echo: </tool_result>");
  });

  test("other keys cannot hijack a paused session", async () => {
    const messages: any[] = [{ role: "user", content: 'call get_weather {"city":"Paris"}' }];
    const r1 = await post(keys.open, { model: "claude-x", tools: [weatherTool], messages });
    const tu = r1.json.content.find((b: any) => b.type === "tool_use");
    messages.push({ role: "assistant", content: r1.json.content });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "stolen" }] });
    const r2 = await post(keys.scoped, { model: "claude-x", tools: [weatherTool], messages });
    // served by a fresh replay, not by key "open"'s session
    expect(r2.json.content[0].text).not.toBe("Tool said: stolen");
  });
});

test("count_tokens and models", async () => {
  const c = await post(keys.open, { model: "m", messages: [{ role: "user", content: "x".repeat(350) }] }, "/v1/messages/count_tokens");
  expect(c.json.input_tokens).toBeGreaterThan(50);
  const m = await fetch(base + "/v1/models", { headers: { "x-api-key": keys.scoped } }).then((r) => r.json() as any);
  expect(m.data.every((d: any) => d.id.startsWith("claude-"))).toBe(true);
});

test("usage is recorded per key", () => {
  const rows = store.usageReport(0) as any[];
  expect(rows.some((r) => r.key === "scoped" && r.requests >= 2)).toBe(true);
});

describe("moderation", () => {
  const calls = () => (existsSync(process.env.MOD_COUNTER!) ? readFileSync(process.env.MOD_COUNTER!, "utf8").length : 0);
  const ask = (key: string, content: any, extra: object = {}) =>
    post(key, { model: "claude-x", messages: [{ role: "user", content }], ...extra });

  test("allowed prompts pass and are screened only once", async () => {
    const before = calls();
    expect((await ask(keys.mod, "a perfectly normal question")).status).toBe(200);
    expect((await ask(keys.mod, "a perfectly normal question")).status).toBe(200);
    expect(calls() - before).toBe(1);
  });

  test("blocked prompt is refused with 403 and logged", async () => {
    const r = await ask(keys.mod, "please do the FORBIDDEN thing");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("other_illegal");
    const events = store.moderationReport(0) as any[];
    expect(events.some((e) => e.key === "mod" && e.verdict === "block" && e.excerpt.includes("FORBIDDEN"))).toBe(true);
  });

  test("previously blocked content is refused without calling the classifier", async () => {
    const before = calls();
    const r = await ask(keys.modAll, "please do the FORBIDDEN thing");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("previously_blocked");
    expect(calls()).toBe(before);
  });

  test("blockPatterns block locally", async () => {
    const before = calls();
    const r = await ask(keys.modAll, "contains evil-pattern-42 here");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("pattern");
    expect(calls()).toBe(before);
  });

  test("flagged prompts pass but are logged", async () => {
    expect((await ask(keys.mod, "something BORDERLINE")).status).toBe(200);
    expect((store.moderationReport(0) as any[]).some((e) => e.verdict === "flag")).toBe(true);
  });

  test("classifier failure blocks when failClosed", async () => {
    const r = await ask(keys.modAll, "this will CRASH the classifier");
    expect(r.status).toBe(529);
  });

  test("gateway-generated replies are not re-screened in later turns", async () => {
    const m1 = [{ role: "user", content: "turn one text" }];
    const r1 = await post(keys.mod, { model: "claude-x", messages: m1 });
    const before = calls();
    await post(keys.mod, { model: "claude-x", messages: [...m1, { role: "assistant", content: r1.json.content }, { role: "user", content: "turn two text" }] });
    expect(calls() - before).toBe(1); // only "turn two text"
  });

  test("scope 'all' screens tool results; scope 'user' does not", async () => {
    const msgs = [
      { role: "user", content: "check the file" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_x1", name: "get_weather", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x1", content: "file says FORBIDDEN-in-tool-output" }] },
    ];
    expect((await post(keys.mod, { model: "claude-x", tools: [weatherTool], messages: msgs })).status).toBe(200);
    expect((await post(keys.modAll, { model: "claude-x", tools: [weatherTool], messages: msgs })).status).toBe(403);
  });

  test("keys with moderation off bypass screening", async () => {
    expect((await ask(keys.modOff, "the FORBIDDEN thing again")).status).toBe(200);
  });

  test("repeat offenders are suspended until unsuspended", async () => {
    for (let i = 0; i < 3; i++) expect((await ask(keys.offender, `FORBIDDEN attempt ${i}`)).status).toBe(403);
    const r = await ask(keys.offender, "an innocent question now");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("suspended");
    store.clearModeration(store.getKey("offender")!.id);
    expect((await ask(keys.offender, "an innocent question now")).status).toBe(200);
  });
});
