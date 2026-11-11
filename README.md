# subgate

An Anthropic Messages-API–compatible gateway that serves requests from your **subscription
harnesses** (Claude Code, Codex CLI) and gives every local service its own **scoped API key**.
Tools are **always executed by the client**: the harness never touches your files or shell.

```
 your service / Claude Code / any Anthropic SDK
        │  POST /v1/messages  (x-api-key: sg-…)
        ▼
 ┌──────────────── subgate ────────────────┐
 │ key auth → policy (models, tools, limits)│
 │ router → provider chain + health/failover│
 │ session ──spawns──▶ claude -p / codex exec   (no built-in tools,
 │    ▲                      │                    empty per-session dir,
 │    └── MCP bridge ◀───────┘ tools/call         user config ignored)
 └──────────────────────────────────────────┘
        │  tool_use  ▲ tool_result
        ▼            │
   the client runs the tool itself
```

## How the tool loop works

1. The request's `tools` are filtered by the key's policy. The allowed ones are exposed to the
   harness through a per-session MCP endpoint (`/bridge/<random token>`).
2. When the model calls a tool, the MCP `tools/call` is **held open**. The gateway ends the
   HTTP response with `tool_use` blocks and `stop_reason: "tool_use"`, as the real API does.
   Parallel calls come back together.
3. The client runs the tool and sends the next request with `tool_result`s. The gateway
   recognizes the conversation by fingerprint and checks that the key matches. It then answers
   the held MCP calls, and the paused harness carries on. There's no replay and the prompt cache
   stays warm.
4. After `end_turn` the Claude harness stays alive, so the next user turn continues the same process.
5. If a conversation can't be continued (gateway restart, session expired, provider switch),
   the full history is **replayed** into a fresh harness as a transcript.

## Quick start

```bash
bun install
bun src/cli.ts init                       # writes subgate.json (edit providers/routes)
bun src/cli.ts keys create home-assistant \
  --models 'claude-haiku-*,claude-sonnet-*' \
  --tools-allow 'search_*,get_*' --tools-deny 'delete_*' \
  --rpm 20 --concurrency 2 --tokens-per-day 2000000 --expires 90d
bun src/cli.ts serve
```

```bash
curl localhost:8742/v1/messages -H "x-api-key: sg-…" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

### Claude Code as a client

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8742 ANTHROPIC_AUTH_TOKEN=sg-… claude
```

Claude Code's own tools (Read, Bash, Edit…) run on the client machine. Use `--tools-allow` /
`--tools-deny` / `--arg-deny` on its key to decide which of them the model may use at all.
The gateway strips `ANTHROPIC_*` variables from the harness environment, so pointing your
shell at the gateway can't make the harness call itself.

## Key policy

Manage keys with `subgate keys create|update|list|show|revoke|delete`. Policy changes apply
on the next request; no restart needed.

| field | effect |
|---|---|
| `models` | globs of model names the key may request |
| `modelOverride` | route every request as this model |
| `providers` | provider instances the key may be served by |
| `tools.allow` / `tools.deny` | which client tools the model sees (deny wins) |
| `tools.argDeny` | `[{tool, pattern, reason}]`: matching calls are rejected inside the gateway and never reach the client, e.g. `--arg-deny 'Bash=rm\s+-rf'` |
| `tools.max` | cap on exposed tools |
| `limits.rpm`, `limits.concurrency` | in-memory rate and parallelism limits |
| `limits.requestsPerDay`, `tokensPerDay`, `outputTokensPerDay` | daily quotas (UTC), counted from the usage log |
| `systemPrompt` | prepended to every request; the client can't remove it |
| `allowImages` | `false` strips image input |
| `expiresAt` | key stops working after this time |

`subgate usage --days 7 [--key name]` shows requests and tokens per key, provider and model.

## Providers, routing and failover

`subgate.json`:

```jsonc
{
  "providers": {
    "claude":     { "type": "claude" },
    "claude-alt": { "type": "claude", "env": { "CLAUDE_CONFIG_DIR": "/home/me/.claude-alt" } }, // second account
    "codex":      { "type": "codex" }                                                         // needs `codex login`
  },
  "routes": [
    { "match": "*haiku*", "targets": [{ "provider": "claude", "model": "haiku" }, { "provider": "codex" }] },
    { "match": "*",       "targets": [{ "provider": "claude", "model": "opus" }, { "provider": "claude-alt", "model": "opus" }, { "provider": "codex" }] }
  ],
  "failover": { "switchAtUtilization": 0.98, "defaultCooldownSeconds": 60, "rateLimitCooldownSeconds": 900 }
}
```

- Targets are tried in order. If a provider fails **before any content was sent**
  (rate limit, logged out, crash), the request moves to the next target without the client
  noticing.
- Claude Code reports subscription-window utilization. Once a provider reaches
  `switchAtUtilization` it is skipped until the window resets, so you switch *before* hitting
  the wall.
- A conversation that moves to another provider is replayed there from the full history.
- `GET /health` shows availability. `GET /admin/status` (with `adminToken` set in the config)
  shows cooldown reasons, utilization and live sessions.

## Isolation

Each conversation gets its own harness process:

- **Claude:** `claude -p` with `--tools ""` (no built-in tools), `--strict-mcp-config` (only the
  bridge), `--setting-sources ""` (no user settings, hooks, plugins or CLAUDE.md),
  `--disable-slash-commands`, `--no-session-persistence`, and permission mode `dontAsk`.
- **Codex:** `codex exec` with `--ignore-user-config --ignore-rules --ephemeral -s read-only`,
  shell, exec, browser, apps and image tools disabled, and web search off.
- It runs in an empty per-session directory under `data/runs/` (removed afterwards), with
  `TMPDIR` pointed inside it.
- Its environment is reduced to an allowlist (HOME, PATH, locale, XDG, proxy). Add more with
  `inheritEnv`.
- The MCP bridge token is random per session, and a session can only be continued by the
  key that created it.
- For OS-level sandboxing, set `wrapper`, e.g.
  `["bwrap","--ro-bind","/","/","--bind","{runDir}","{runDir}","--dev","/dev","--"]`
  (the harness needs write access to its own config dir for auth refresh).

## API surface and limitations

Implemented: `POST /v1/messages` (streaming SSE and JSON), `POST /v1/messages/count_tokens`
(an estimate), `GET /v1/models`. Auth is `x-api-key` or `Authorization: Bearer`.

- The harness decides sampling. `max_tokens`, `temperature`, `top_p`, `stop_sequences` and
  `thinking` are accepted but ignored. Thinking blocks are not returned.
- Server tools (`web_search_*` etc.) are dropped. Only custom (client) tools are bridged.
- Assistant prefill is approximated: the model is told to continue from the given text.
- Replays send history as a transcript, which costs more than a live continuation.
- Codex streams whole messages, not tokens, and is single-turn per process. Tool round-trips
  within a turn stay live, but follow-up user turns are replayed. **The Codex adapter has only
  been smoke-tested (flags accepted, auth error detected), not run against a logged-in account.**

## Terms of service

Subscription plans are licensed for your own use through the vendor's apps. Driving them
headlessly for personal local services is your responsibility to check against
Anthropic's and OpenAI's current terms. Don't share keys with other people or expose the
gateway publicly. It binds to `127.0.0.1` by default.

## Always-on in the `dev` distrobox

The gateway runs permanently inside the `dev` box. It uses the shared pattern for always-running box
services: a supervisor plus a box login hook, and **no host systemd unit**. The pattern, lessons,
port registry and steps for adding services are in
`/home/v/agents/docs/always-running-box-services.md`. Host notes specific to this service are in
`/home/v/agents/docs/subgate-dev-box-autostart.md`.

```bash
scripts/run-local.sh install     # once: writes /etc/profile.d/subgate.sh in the box (sudo)
scripts/run-local.sh up          # start now (idempotent; the hook runs this on every box login/shell)
scripts/run-local.sh status      # pids, /health, log path
scripts/run-local.sh restart     # after changing code or subgate.json
scripts/run-local.sh down        # stop
scripts/run-local.sh uninstall   # stop and remove the hook
```

- The supervisor (`run-local.sh supervise`) holds `var/supervisor.lock`, runs `bun src/cli.ts serve`
  and restarts it 10s after it exits. Logs go to `var/serve.log`, rotated at 20 MB.
- It unsets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, so the
  harness always uses the box's subscription login (`~/dbx-homes/dev/.claude`).
- Everything lives in the container's cgroup: `distrobox stop dev` stops it, and the next entry
  into the box starts it again. After a reboot it comes back when `dev` is entered.
- Port 8742 is used because the knowledge base already takes 8787 (boxes share the host network).

Key management works while the gateway runs: the CLI and the server share the SQLite DB in `data/`.

## Development

```bash
bun test          # end-to-end tests against an in-process mock harness (no subscription usage)
bun run typecheck
SUBGATE_DEBUG=1 bun src/cli.ts serve   # or --debug
```

Layout: `src/server.ts` (HTTP, routing of requests to sessions), `src/session.ts` (harness
lifecycle and the tool pause/resume state machine), `src/bridge.ts` (MCP endpoint),
`src/conversation.ts` (fingerprints, replay rendering), `src/providers/*` (harness adapters),
`src/policy.ts`, `src/db.ts`, `src/router.ts`, `src/cli.ts`.
