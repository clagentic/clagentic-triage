# Security

This document covers security properties, data handling, and operator responsibilities for clagentic:triage.

---

## Token security

The GitHub token is read exclusively from the `CLAGENTIC_TRIAGE_GITHUB_TOKEN` environment variable (or `config.github_token()` if a custom loader is used). It is never logged, stored, or transmitted outside of GitHub API requests.

Use a fine-grained personal access token scoped to only the repositories triage needs to read. Classic PATs with broad scopes (`repo`, `admin:org`, etc.) will trigger a startup warning — see `docs/GITHUB_APP.md`.

Webhook secrets are stored only in environment variables (`CLAGENTIC_TRIAGE_WEBHOOK_SECRET`). They are used for HMAC-SHA256 signature verification of inbound GitHub deliveries (timing-safe comparison). A delivery with a missing or invalid signature is rejected before any payload is processed.

---

## Input validation

Event content from GitHub (issue titles, PR bodies, comments) is untrusted input. `assessor.js` redacts credential-shaped strings and prompt-injection markers from event content before it is forwarded to the LLM runner. This is a best-effort measure, not a guarantee of complete sanitization.

The `since` parameter accepted by the poll adapter is validated against a basic ISO 8601 pattern before use. Non-conforming values are rejected with an `AdapterError` rather than forwarded to the API.

Queue records are re-validated when loaded from disk. Records missing required fields (including `event.repo`) are rejected and skipped rather than silently loaded. A single corrupt record never causes the entire queue load to fail.

---

## Plugin module path confinement

Operators can supply custom dispatchers and hooks by module path. All operator-supplied module paths go through `_validate_module_path()` before import:

- Filesystem paths (`./`, `../`, `/`) are resolved to an absolute path and must remain within the project root. Paths that escape via `../` traversal are rejected.
- Bare npm package specifiers (e.g. `@clagentic/my-dispatcher`) are allowed.
- URL schemes that enable arbitrary code execution are blocked: `data:`, `file:`, `javascript:`, `blob:`, and `vbscript:`. These are rejected regardless of content.

This prevents config-controlled code injection via crafted module paths.

---

## Webhook rate limiting

The webhook server enforces two independent caps to protect against event floods:

- **Per-author cap:** an author who sends more than `source.max_events_per_author_per_poll` events (default 20) within `webhooks.rate_limit_window_seconds` (default 60) receives `429 Too Many Requests`. The counter resets per-author when the window expires.
- **Global cap:** if more than `webhooks.max_events_per_minute` events (default 300) are processed across all authors in any 60-second bucket, the server returns `429`. This guards against distributed floods from many unique actors.

Both caps are in-memory and reset on process restart. See `docs/CONFIG.md` — Webhook rate limiting for configuration.

---

## Token scope enforcement

At startup (`run` and `watch` commands), clagentic-triage checks the OAuth scopes of the configured PAT via `check_token_scopes()`. If the token carries broad scopes (`repo`, `admin:org`, etc.) and write action classes are present in `auto_approve`, a prominent warning is emitted. This is not a hard failure — the operator may set `allow_overprivileged_token: true` to acknowledge the risk — but it surfaces the blast radius of a token compromise.

GitHub App installation tokens are already narrowly scoped and are not subject to this check.

---

## PII and data residency

### What data leaves the operator's environment

The event payload — issue or PR title, body, and author login — is sent to the configured LLM runner for assessment. Where that data goes depends on the runner choice:

- `claude-cli` / `anthropic-api`: data is sent to Anthropic's API. Anthropic's data handling and retention policies apply.
- `openai-compatible`: data is sent to whatever URL the operator configures in `llm.base_url`. The operator is responsible for knowing who operates that endpoint.
- `clagentic-router`: data is sent to the router URL (`llm.router_url`). The operator controls where the router forwards requests.

No event content is sent to any endpoint other than the configured LLM runner and the originating GitHub API.

### What is stored locally

The pending queue (`pending.jsonl`, default path `.triage/pending.jsonl`) stores normalized event data including author login, repository name, and the LLM assessment result. This file is written to the operator's local filesystem. Protect it with appropriate filesystem permissions — it contains the same information as the issues and PRs it reflects.

### What is NOT stored

Raw issue and PR bodies are not persisted. Only the normalized event struct (title, body, author, repo, type) and the assessment result (verdict, confidence, suggested action) are written to the queue. Webhook delivery payloads are not logged or stored.

### Redaction

`assessor.js` redacts credential-shaped strings (tokens, API keys) and prompt-injection markers from event content before LLM submission. The intent is to reduce the risk of leaking secrets that appear in issue or PR bodies. This is a best-effort heuristic — it does not guarantee that all sensitive content is removed.

### Operator responsibility

Operators are responsible for ensuring their LLM runner choice complies with their data handling obligations. This includes any privacy regulations, data residency requirements, or contractual commitments that apply to the issue and PR content being triaged. Clagentic:triage makes no data residency guarantees on behalf of third-party runners.
