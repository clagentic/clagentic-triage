# clagentic:triage — Configuration Reference

Configuration is loaded from (in priority order):
1. Environment variables (prefix: `CLAGENTIC_TRIAGE_`)
2. `triage.config.json` in the working directory
3. `~/.config/clagentic/triage/config.json`

## Full config schema

```json
{
  "source": {
    "adapter": "github",
    "org": "your-org",
    "repos": ["*"],
    "poll_interval_seconds": 60,
    "allow_bot_logins": [],
    "watch_associations": ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"],
    "ignore_logins": [],
    "watch_logins": []
  },
  "intent_file": ".github/triage-intent.yml",
  "intent_file_fallback": ".github/TRIAGE_INTENT.md",
  "model": "claude-sonnet-4-5",
  "model_fallback": "claude-sonnet-4-5",
  "runner": "claude-cli",
  "runner_url": null,
  "runner_api_key_env": null,
  "confidence_threshold": 0.7,
  "auto_approve": [],
  "allow_auto_pr_approval": false,
  "auto_label": false,
  "pending_queue": ".triage/pending.jsonl",
  "dispatchers": [
    {
      "name": "webhook",
      "url": "https://example.com/triage-hook"
    }
  ],
  "hooks": [
    {
      "name": "clagentic-console",
      "module": "@clagentic/triage-hook-console",
      "config": {}
    }
  ],
  "webhooks": {
    "enabled": false,
    "port": 8742,
    "secret": "",
    "rate_limit_window_seconds": 60,
    "max_events_per_minute": 300
  },
  "notifications": {
    "webhooks": []
  }
}
```

## Key fields

### `source`

| Field | Default | Description |
|---|---|---|
| `adapter` | `"github"` | Source adapter (`github`, `gitlab`, `forgejo`) |
| `org` | `null` | GitHub org to watch. If set, all repos in the org are fetched unless `repos` is specified. |
| `repos` | `["*"]` | Repos to watch in `owner/repo` format. `*` = all repos in `org`. |
| `poll_interval_seconds` | `60` | How often to poll for new events (seconds). |
| `allow_bot_logins` | `[]` | Bot logins exempted from the bot-event filter (DD-005). Use sparingly. |
| `watch_associations` | `["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"]` | Actor-association filter (DD-008). Only events whose GitHub `author_association` is in this list are triaged. Default = external contributors only. Valid values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`. Unknown values are rejected at load. |
| `ignore_logins` | `[]` | Logins always skipped, regardless of association (deny). E.g. the operator's own username, or an automation account like `naomi`. Wins over everything. |
| `watch_logins` | `[]` | Logins always processed, even if their association is not in `watch_associations` (allow). Lets you watch a specific internal person. |
| `max_events_per_author_per_poll` | `20` | Maximum events passed downstream per author per poll window. Applied after the bot and actor-association filters; filtered events do not count. `0` or `null` disables the cap. Stateless — counts reset each poll call. Protects against a single noisy actor flooding the assessment queue. |
| `max_events_per_repo_per_poll` | `200` | Maximum post-filter events accumulated per repo per poll. Pagination stops once this many events have passed all filters for a repo. This cap operates on the post-filter event count, so a high-volume author whose events are dropped by the per-author cap cannot consume the budget and starve legitimate contributors. `0` or `null` disables the cap. |
| `github_app_id` | `null` | GitHub App numeric ID. When set, the adapter mints installation tokens instead of using `CLAGENTIC_TRIAGE_GITHUB_TOKEN`. Use App auth or PAT — not both. |
| `github_app_private_key_env` | `"CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY"` | Name of the env var that holds the RS256 private key PEM. The PEM is never stored on the config object — only the env var name is. Override if you store the key under a different env var name. |
| `github_app_installation_id` | `null` | Installation numeric ID. Found in the installation URL on GitHub. Required when `github_app_id` is set. |

The actor-association filter is orthogonal to the bot filter — both apply, and an
event must pass both to be triaged. Precedence: `ignore_logins` (deny) → `watch_logins`
(allow) → `watch_associations` bucket. An event with a missing/unknown association
is treated as external and processed (fail-open). See DD-008 for the full rationale.

### `runner` / `model` / `runner_url` / `runner_api_key_env`

`runner` selects the LLM backend. `model` is the model hint passed to that backend.

| `runner` | Description |
|---|---|
| `"claude-cli"` | Default. Spawns the `claude` CLI as a subprocess. `model` is passed as `--model`. Requires `claude` on PATH or `CLAUDE_PATH`. |
| `"anthropic-api"` | HTTP POST to `https://api.anthropic.com/v1/messages`. API key read from the env var named in `runner_api_key_env` (default: `ANTHROPIC_API_KEY`). |
| `"openai-compatible"` | HTTP POST to `${runner_url}/chat/completions`. Covers OpenAI, Azure OpenAI, Ollama, and any OpenAI-compatible server. If the key env var is empty (e.g. Ollama local), the Authorization header is omitted. |
| `"clagentic-router"` | HTTP POST to `${runner_url}/v1/assess` (default URL: `http://localhost:4200`). The router handles multi-provider routing — Claude, GPT-4o, Gemini, or any configured backend. |

**`runner_url`** — base URL for `openai-compatible` and `clagentic-router`. Required for `openai-compatible`; optional for `clagentic-router` (defaults to `http://localhost:4200`).

**`runner_api_key_env`** — the **name** of the environment variable that holds the API key (never the key itself). Leave unset to use the runner's default (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CLAGENTIC_ROUTER_TOKEN`).

**Minimal standalone setup (claude CLI):**
```json
{ "runner": "claude-cli", "model": "claude-sonnet-4-5" }
```

**Anthropic API directly:**
```json
{ "runner": "anthropic-api", "model": "claude-opus-4", "runner_api_key_env": "ANTHROPIC_API_KEY" }
```

**Ollama local (no auth):**
```json
{ "runner": "openai-compatible", "model": "llama3", "runner_url": "http://localhost:11434" }
```

**clagentic:router:**
```json
{ "runner": "clagentic-router", "model": "auto", "runner_url": "http://localhost:4200" }
```

**Deprecation note:** `model: "clagentic:router"` is deprecated. On load, it is automatically
migrated to `runner: "clagentic-router"` and `model: "auto"` with a warning. Update your config
to use the explicit `runner` field.

### `confidence_threshold`

Default: `0.7`. Verdicts with confidence below this value are always routed to
the HITL pending queue, regardless of `auto_approve` configuration. This gate
cannot be bypassed by `auto_approve`.

### `auto_approve`

List of action classes that execute immediately without human review:

| Class | Effect |
|---|---|
| `respond` | Post a comment on the issue/PR |
| `request_changes` | Submit a request-changes review on a PR |
| `close` | Close the issue or PR |
| `dispatch` | Create a task in configured dispatchers |
| `escalate` | Route to human review (effectively a no-op for auto-approve) |
| `approve` | Approve a PR — **requires `allow_auto_pr_approval: true`** |

Default: `[]` (fully human-in-the-loop).

### `allow_auto_pr_approval`

Default: `false`. Must be explicitly set to `true` before `"approve"` can be
added to `auto_approve`. This is a deliberate friction point — autonomous PR
approval carries real consequences on live repos. See DD-001 and DD-002 in
`docs/DESIGN-DECISIONS.md`.

### `allow_overprivileged_token`

Default: `false`. When a classic PAT with broad OAuth scopes (e.g. `repo`,
`admin:org`) is used alongside write action classes in `auto_approve`
(`respond`, `close`, `request_changes`, `approve`, `dispatch`), clagentic-triage
emits a startup warning because a compromised token can take write actions across
every repo in scope.

Set `allow_overprivileged_token: true` to silence the warning when you have
intentionally accepted this risk — for example, in a development environment or
when the token is scoped to a dedicated test org.

The preferred alternative is to use a fine-grained PAT scoped to the specific
repos you want to triage, or to configure a GitHub App (see
`docs/GITHUB_APP.md`). GitHub App installation tokens are already narrowly
scoped and are not subject to this check.

### `auto_label`

Default: `false`. When `true`, labels suggested by the LLM are applied to
queued items immediately (without waiting for human approval of the full action).

### `pre_filter`

Optional tier-1 cheap LLM pass that classifies events as noise or real before
running the full assessor. Off by default. See DD-011 in `docs/DESIGN-DECISIONS.md`
and `docs/SPAM_PROTECTION.md` for when and how to enable it.

```json
{
  "pre_filter": {
    "enabled": false,
    "runner": "claude-cli",
    "model": "claude-haiku-4-5",
    "timeout_ms": 15000,
    "confidence_threshold": 0.8
  }
}
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable the pre-filter. Off by default — enable once you have confidence in the threshold for your event stream. |
| `runner` | main `runner` | Runner to use for tier-1 calls. Route to a cheap model here. `clagentic-router` is not compatible — use a direct runner. |
| `model` | main `model` | Model for tier-1 calls. |
| `timeout_ms` | main `llm_timeout_ms` | Timeout for pre-filter calls. |
| `confidence_threshold` | `0.8` | Minimum confidence to drop an event as noise. Below this threshold the event passes through to the main assessor. Intentionally high — uncertain classifications pass. |

Pre-filter failures (LLM error, parse error, timeout) always degrade to pass-through.
A failing pre-filter never blocks the pipeline.

## Dispatchers

Dispatchers receive events after assessment and create tasks in external systems
(Jira, Linear, webhooks, etc.). They fire on the `dispatch` action class.

```json
{
  "dispatchers": [
    { "name": "webhook", "url": "https://example.com/triage-hook" },
    { "name": "my-backend", "module": "./backends/my-backend.js", "config": {} }
  ]
}
```

Each entry must have either `name` (bundled dispatcher) or `module` (operator-supplied
module path or npm specifier). `config` is optional and passed to the dispatcher.

Bundled dispatchers: `noop` (logs only), `webhook` (HTTP POST). See `docs/DISPATCHERS.md`
for the dispatcher interface contract.

## Hooks

Hooks are lightweight callbacks that fire after every assessment, regardless of the
verdict. They run before the pending queue is written. Hook failures are logged as
warnings — they never affect the pipeline outcome.

```json
{
  "hooks": [
    {
      "name": "console",
      "config": {
        "command": "clagentic-console",
        "args": [],
        "prompt_via": "flag"
      }
    }
  ]
}
```

Each entry must have either `name` (bundled hook) or `module` (operator-supplied
module path or npm specifier). `config` is optional and passed to the hook's `run`
function.

| Field | Required | Description |
|---|---|---|
| `name` | one of `name`/`module` | Bundled hook name. Must match `/^[a-z][a-z0-9-]*$/`. |
| `module` | one of `name`/`module` | Operator-supplied module path (relative/absolute within cwd, or npm specifier). |
| `config` | no | Hook-specific config object passed to `run()`. |

### Bundled hook: `console`

Launches `clagentic-console` when the triage verdict is `escalate`. The hook is
fire-and-forget — the CLI session starts in a detached process; the pipeline does not
wait for it to finish. Non-escalate verdicts are silently skipped.

```json
{
  "name": "console",
  "config": {
    "command": "clagentic-console",
    "args": [],
    "prompt_via": "flag"
  }
}
```

| Key | Default | Description |
|---|---|---|
| `command` | `"clagentic-console"` | CLI binary to invoke. Must be on PATH or an absolute path. |
| `args` | `[]` | Extra arguments prepended before the prompt. Use for flags like `--profile myprofile`. |
| `prompt_via` | `"flag"` | How to pass the prompt: `"flag"` passes `--message <prompt>` as a CLI argument; `"stdin"` writes the prompt to the process stdin. |

The prompt contains: repo, issue/PR number, title, verdict, confidence score, and
suggested action. It is a single concise paragraph — enough context for a console
session to start immediately.

## Intent file

The primary intent file is a YAML file committed to each watched repo at
`.github/triage-intent.yml`. It tells the LLM what belongs in the repo.

```yaml
# .github/triage-intent.yml
repo_context_files:
  - path: CONTRIBUTING.md
  - path: docs/ROADMAP.md

triage_rules:
  - id: default
    description: "General triage rules"
    llm_context: |
      Accept bug reports with reproduction steps and expected/actual behavior.
      Request info if steps are missing.
      Redirect support questions to Discussions.
```

`repo_context_files` lists additional files in the repo whose contents are
injected into the LLM context. Only documentation-style extensions are allowed
(`.md`, `.txt`, `.yml`, `.yaml`, `.json`, `.rst`). Credential files, private
keys, and `.env` files are blocked regardless of the intent file's contents.

If no YAML file is found, the assessor falls back to `.github/TRIAGE_INTENT.md`
(Markdown), then to a built-in generic intent.

## Webhook server

Real-time event delivery via GitHub webhooks. Disabled by default.

```json
{
  "webhooks": {
    "enabled": true,
    "port": 8742,
    "secret": "your-webhook-secret-here"
  }
}
```

**`webhooks.secret` must be a non-empty string when `enabled` is `true`.** An
empty secret is rejected at config load time. Expose the webhook endpoint behind
a reverse proxy — the default bind address is `127.0.0.1`, not `0.0.0.0`.

### Webhook rate limiting

Two independent caps protect the inbound event stream from noisy or abusive senders:

| Key | Default | Description |
|---|---|---|
| `webhooks.rate_limit_window_seconds` | `60` | Sliding window length (seconds) for the per-author event cap. Each author's counter resets independently when this many seconds have elapsed since their window started. |
| `webhooks.max_events_per_minute` | `300` | Global cap: maximum events processed across all authors in any 60-second bucket. When exceeded, the server returns `429 Too Many Requests` and logs a warning. Use this to guard against distributed floods from many unique actors. |

The per-author cap reuses the `source.max_events_per_author_per_poll` threshold
(default `20`) — no additional config key is needed. An author who sends more
than that many events within `rate_limit_window_seconds` receives `429` until
the window expires. Both caps are in-memory and reset on process restart.

## Environment variable overrides

| Variable | Config key | Notes |
|---|---|---|
| `CLAGENTIC_TRIAGE_ADAPTER` | `source.adapter` | |
| `CLAGENTIC_TRIAGE_ORG` | `source.org` | |
| `CLAGENTIC_TRIAGE_REPOS` | `source.repos` | comma-separated |
| `CLAGENTIC_TRIAGE_WATCH_ASSOCIATIONS` | `source.watch_associations` | comma-separated GitHub author_association values |
| `CLAGENTIC_TRIAGE_IGNORE_LOGINS` | `source.ignore_logins` | comma-separated logins (deny) |
| `CLAGENTIC_TRIAGE_WATCH_LOGINS` | `source.watch_logins` | comma-separated logins (allow) |
| `CLAGENTIC_TRIAGE_MODEL` | `model` | |
| `CLAGENTIC_TRIAGE_RUNNER` | `runner` | `claude-cli`, `anthropic-api`, `openai-compatible`, `clagentic-router` |
| `CLAGENTIC_TRIAGE_RUNNER_URL` | `runner_url` | Base URL for openai-compatible / clagentic-router |
| `CLAGENTIC_TRIAGE_RUNNER_API_KEY_ENV` | `runner_api_key_env` | Name of the env var holding the API key (never the key itself) |
| `CLAGENTIC_TRIAGE_GITHUB_TOKEN` | *(token getter)* | Never stored in config object |
| `CLAGENTIC_TRIAGE_GITHUB_APP_ID` | `source.github_app_id` | |
| `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY` | *(PEM read at mint time)* | Never stored in config object; env var name stored via `github_app_private_key_env` |
| `CLAGENTIC_TRIAGE_GITHUB_APP_INSTALLATION_ID` | `source.github_app_installation_id` | |
| `CLAGENTIC_TRIAGE_AUTO_APPROVE` | `auto_approve` | comma-separated |
| `CLAGENTIC_TRIAGE_WEBHOOK_SECRET` | `webhooks.secret` | |
| `CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD` | `confidence_threshold` | float 0–1 |
