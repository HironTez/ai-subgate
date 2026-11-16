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

## Prompt screening (moderation)

Every request is screened **before** it reaches a harness, to keep content that violates the
provider's usage policy (and could get the subscription account flagged) off the account. It's on by
default.

1. **`blockPatterns`**: local, case-insensitive regexes. A match is blocked immediately and the
   text is never sent anywhere.
2. **Classifier**: `"claude"` (default) asks a small model through the subscription for a
   structured `allow` / `flag` / `block` verdict. The classifier prompt is `CLASSIFIER_PROMPT` in
   `src/moderation.ts`: it blocks clear requests for CSAM, CBRN weapons, malware or unauthorized
   intrusion, extremism, weapons and drug synthesis, fraud and phishing, doxxing, harassment,
   self-harm instructions, election interference and jailbreaks. It explicitly allows
   defensive or authorized security work, fiction, and medical or legal questions.
   `"command"` runs a local program instead (e.g. a Llama Guard wrapper). It reads
   `{"items":[{"id","kind","text"}]}` on stdin and prints
   `{"verdict","category","reason","flagged_items"}`, so screened text stays on the machine.
   **Escalation:** the first model also reports whether the content is `complex` and how high its
   `injection_risk` is. A second, stronger model (`escalationModel`, default `sonnet`) re-checks it and
   decides when any of these hold:
   - injection risk is high
   - the content is complex
   - the verdict is a borderline `flag`
   - the text matches local injection heuristics ("ignore previous instructions", notes aimed at the
     filter, fake `<item>` tags, jailbreak personas). This covers the case where an injection fooled
     the first model into reporting low risk.

   Content can't close its own `<item>` tag. `subgate moderation` shows which model decided.
3. **Cache**: verdicts are stored per content hash in SQLite. Unchanged content (system prompts,
   earlier turns) is screened once, and the gateway's own replies are trusted when they come back.
   **Blocked content is never sent again**: a retry is refused immediately.

Outcomes:
- **block**: HTTP 403 `permission_error` naming the category and reason. The event is logged.
- **flag**: the request passes, and the event is logged for review.
- **Classifier failure**: with `failClosed` (the default), the request is refused with a 529, which
  clients retry.
- **Repeat offenders**: a key with `suspendAfterBlocks` (default 5) blocks within 24h is
  suspended until an admin reviews it.

```bash
bun src/cli.ts moderation --days 7 [--key name]      # blocked/flagged requests with excerpts
bun src/cli.ts keys unsuspend <key>                  # after review
bun src/cli.ts keys update <key> --moderation-scope all   # also screen tool results + tool descriptions
bun src/cli.ts keys update <key> --moderation off         # exempt a trusted key
```

Config (`subgate.json`, all optional):

```jsonc
"moderation": {
  "enabled": true, "classifier": "claude", "provider": "claude", "model": "haiku",
  "scope": "user",            // "all" also screens tool results and tool descriptions
  "failClosed": true, "maxChunkChars": 24000, "suspendAfterBlocks": 5,
  "escalationModel": "sonnet",  // null disables escalation
  "blockPatterns": []          // e.g. ["\\bmy-forbidden-term\\b"]
}
```

Cost and limits:
- **Latency:** each new user turn adds one haiku call, about 2–4 s. The first request of a
  Claude Code session also screens its large system prompt once (about 10 s). Tool-loop steps add
  nothing in `user` scope.
- **Usage:** classifier calls are counted against the key and show as `kind = moderation` in
  `subgate usage`.
- **Images are not screened.** Use `--no-images` on keys where that matters.
- **Coverage:** tool results are only screened with scope `all`. In the default `user` scope they
  pass unchecked.
- **No guarantee:** this reduces risk but guarantees nothing. The provider's own enforcement is
  what counts.
- **The `claude` classifier still sends the text to Anthropic**, in a classification request.
  Use `blockPatterns` or a `command` classifier for content that must never leave the machine.

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
- It runs in an empty per-session directory under `<tmp>/gateway-sandbox-not-the-callers-filesystem/`
  (outside any repo, removed afterwards), with `TMPDIR` pointed inside it. Claude Code always tells
  its model its working directory, so the directory name itself says it isn't the caller's, and the
  preamble tells the model to ignore it.
- **No account context reaches API clients.** With the owner's normal profile, Claude Code injects
  the account email into every conversation. Claude harnesses therefore run with their own empty
  `CLAUDE_CONFIG_DIR` (`data/claude-home/<provider>`) and only `CLAUDE_CODE_OAUTH_TOKEN`. The token
  comes from `providers.<name>.oauthTokenFile` (a long-lived token from `claude setup-token`;
  recommended). Failing that, the gateway borrows the owner's current access token while it has more
  than an hour of validity left. If neither works it falls back to the shared profile and logs a
  warning. `"isolateProfile": false` turns this off.
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

## Running as a domain host service

On this machine subgate runs as the `work` domain's host service `subgate` (`decl/services/subgate.toml`,
see the domains manual, "Host services"): `bun src/cli.ts serve` in this project's container, under a
generated systemd user unit that restarts it on exit.

- `subgate.json` and `data/` stay local to the deployment (git-ignored).
- The `claude` provider sets `env.CLAUDE_CONFIG_DIR` to the domain's Claude login (`/d/identity/claude`),
  so the gateway borrows that session (see Isolation) instead of needing an `oauthTokenFile`.
- It listens on the port in `subgate.json`, which the service publishes on 127.0.0.1. Publishing on the
  network (for clients on other machines) is a host-side admin setting:
  `domain service expose work/subgate 28742:8742`.
- The domain's phone services reach it on their own localhost (`phone = true` in the declaration).

```bash
domain service status work/subgate        # on the host
domain service logs work/subgate
domain service restart work/subgate       # after changing code or subgate.json
bun src/cli.ts keys list                  # in `project enter work/ai-subgate` (same SQLite DB)
```

## Development

```bash
bun test          # end-to-end tests against an in-process mock harness (no subscription usage)
bun run typecheck
SUBGATE_DEBUG=1 bun src/cli.ts serve   # or --debug
```

Layout: `src/server.ts` (HTTP, routing of requests to sessions), `src/session.ts` (harness
lifecycle and the tool pause/resume state machine), `src/bridge.ts` (MCP endpoint),
`src/conversation.ts` (fingerprints, replay rendering), `src/moderation.ts` (prompt screening), `src/providers/*` (harness adapters),
`src/policy.ts`, `src/db.ts`, `src/router.ts`, `src/cli.ts`.
