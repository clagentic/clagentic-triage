# clagentic:triage

LLM-powered triage agent for GitHub issues and PRs. Watches an org or repo, assesses inbound signals against intent, and routes actions — respond, approve, escalate, reject, or dispatch to external systems.

## Rules

- All LLM calls via `claude` CLI or clagentic:router. No `anthropic` SDK without explicit sign-off.
- Model selection is user-configurable. Never hardcode a model name in business logic.
- No hardcoded org names, repo names, or usernames anywhere in src/. All config via environment or config file.
- Adapters (GitHub, GitLab, etc.) are pluggable. Core logic must not import adapter internals directly — only through the adapter interface.
- Backends (Jira, Linear, GitHub Issues, webhook, etc.) are pluggable. Core triage logic must not know about specific backend implementations. Any backend — including private/internal systems — plugs in via the dispatcher interface and is loaded by config-supplied module path; never bundle a backend-specific adapter in core.
- Dispatch hooks (console, webhooks, etc.) are optional and config-driven. The core pipeline runs cleanly with no hooks registered.
- FSL-1.1-MIT license. See LICENSE.

## CLI Naming

Follows the clagentic CLI Naming Standard (see the `clagentic-brand` repo at github.com/clagentic/brand).

- **Binary:** `clagentic-triage`
- **Env vars:** `CLAGENTIC_TRIAGE_*` prefix
- **Config:** `~/.config/clagentic/triage/config.json`

## Documentation

Human-facing documentation lives in README.md (repo front door) and docs/ (detailed reference).

CLAUDE.md is agent operating instructions only. It must not be used as repo documentation, duplicate content from README.md or docs/, or describe the project structure or design decisions.
