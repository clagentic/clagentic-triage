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
    "allow_bot_logins": []
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
      "name": "lore",
      "project": "my-project"
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
    "secret": ""
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

### `auto_label`

Default: `false`. When `true`, labels suggested by the LLM are applied to
queued items immediately (without waiting for human approval of the full action).

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

## Environment variable overrides

| Variable | Config key | Notes |
|---|---|---|
| `CLAGENTIC_TRIAGE_ADAPTER` | `source.adapter` | |
| `CLAGENTIC_TRIAGE_ORG` | `source.org` | |
| `CLAGENTIC_TRIAGE_REPOS` | `source.repos` | comma-separated |
| `CLAGENTIC_TRIAGE_MODEL` | `model` | |
| `CLAGENTIC_TRIAGE_RUNNER` | `runner` | `claude-cli`, `anthropic-api`, `openai-compatible`, `clagentic-router` |
| `CLAGENTIC_TRIAGE_RUNNER_URL` | `runner_url` | Base URL for openai-compatible / clagentic-router |
| `CLAGENTIC_TRIAGE_GITHUB_TOKEN` | *(token getter)* | Never stored in config object |
| `CLAGENTIC_TRIAGE_AUTO_APPROVE` | `auto_approve` | comma-separated |
| `CLAGENTIC_TRIAGE_WEBHOOK_SECRET` | `webhooks.secret` | |
| `CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD` | `confidence_threshold` | float 0–1 |
