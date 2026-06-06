# clagentic:triage

LLM-powered triage agent for GitHub issues and PRs. Watches an org or repo, assesses inbound signals against intent, and routes actions — respond, approve, escalate, reject, or dispatch to external systems.

## Rules

- All LLM calls via `claude` CLI or clagentic:router. No `anthropic` SDK without explicit sign-off.
- Model selection is user-configurable. Never hardcode a model name in business logic.
- No hardcoded org names, repo names, or usernames anywhere in src/. All config via environment or config file.
- Adapters (GitHub, GitLab, etc.) are pluggable. Core logic must not import adapter internals directly — only through the adapter interface.
- Backends (Lore, Jira, Linear, etc.) are pluggable. Core triage logic must not know about specific backend implementations.
- Dispatch hooks (console, webhooks, etc.) are optional and config-driven. The core pipeline runs cleanly with no hooks registered.
- FSL-1.1-MIT license. See LICENSE.

## Project Structure

```
src/
  adapters/       # Source adapters: github.js, gitlab.js (interface: list_events, post_comment, etc.)
  assessors/      # LLM assessment logic: intent-check, quality-check, routing
  dispatchers/    # Dispatch targets: lore.js, jira.js, linear.js, webhook.js
  hooks/          # Optional integration hooks: console-push.js, etc.
  webhooks/       # Inbound webhook server for real-time events
  config/         # Config schema, loader, validator
tests/
docs/
  ARCHITECTURE.md
  CONFIG.md
  ADAPTERS.md
  DISPATCHERS.md
```

## Key design decisions

- Adapter interface (not finalized yet — see ARCHITECTURE.md)
- Assessment pipeline: event → enrich → assess → route → dispatch
- Human-in-the-loop by default: assessment produces a verdict + suggested action. Execution requires approval unless auto-mode is explicitly enabled per action type.
- Dispatch hooks are declared in config as a list; each hook is a module that exports a standard interface.

## CLI Naming

Follows the clagentic CLI Naming Standard (see the `clagentic-brand` repo at github.com/clagentic/brand).

- **Binary:** `clagentic-triage`
- **Env vars:** `CLAGENTIC_TRIAGE_*` prefix
- **Config:** `~/.config/clagentic/triage/config.json`
