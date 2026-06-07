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

Queue records are re-validated when loaded from disk. A single corrupt record is skipped with a warning rather than causing the entire queue load to fail.

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
