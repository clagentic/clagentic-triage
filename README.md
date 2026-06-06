# clagentic:triage

LLM-powered triage agent for GitHub issues and PRs.

## What it does

clagentic:triage watches a GitHub org or repo for new issues and pull requests.
Each inbound event is enriched with repo context (a per-repo intent file plus
referenced documentation), then assessed by an LLM against the stated intent —
does this issue belong here, does this PR meet the bar, what action should follow?

The LLM returns a verdict and a suggested action. By default that suggestion waits
in a human-review queue. A human approves, overrides, or rejects it via the CLI.
Auto-approve can be enabled per action class once you trust the model's verdicts on
that class.

Approved actions execute through the source adapter (post comment, request changes,
close, approve PR) and optionally dispatch into a backend task system (Jira, Linear,
GitHub Issues, a webhook endpoint, or any custom dispatcher).

## Key properties

- **Human-in-the-loop by default.** Every verdict waits for approval unless you
  explicitly opt an action class into auto-approve. Confidence below the configured
  threshold always routes to HITL regardless of auto-approve settings.
- **Multi-runner LLM.** Four backends: `claude-cli` (default — spawns the `claude`
  CLI, no API key required in the environment), `anthropic-api` (direct HTTP, no SDK),
  `openai-compatible` (covers OpenAI, Azure OpenAI, Ollama, and any compatible server),
  `clagentic-router` (delegates to the clagentic:router service for multi-provider
  routing). Model selection is config-driven, never hardcoded.
- **Pluggable source adapters.** Adapters normalize events from a platform (GitHub,
  GitLab, Forgejo, ...) into a common Event schema. The pipeline is adapter-agnostic.
- **Pluggable dispatch backends.** Dispatchers push verdicts into backend systems.
  Any backend — including private or internal tools — plugs in by module path. The
  core ships generic reference dispatchers (`webhook`, `noop`); concrete backends are
  external packages.
- **Zero runtime npm dependencies.** ESM, Node 20+, no bundler required.

## Install

Requires Node 20 or later.

```
npm install -g @clagentic/triage
```

Or run from a clone:

```
git clone https://github.com/clagentic/triage
cd triage
node src/cli.js run
```

The binary is `clagentic-triage`.

## Quickstart

Create a minimal config file at `~/.config/clagentic/triage/config.json`:

```json
{
  "source": {
    "adapter": "github",
    "org": "your-org"
  },
  "runner": "claude-cli",
  "model": "claude-sonnet-4-5"
}
```

Set the required token:

```
export CLAGENTIC_TRIAGE_GITHUB_TOKEN=ghp_...
```

Run a single triage pass:

```
clagentic-triage run
```

Run a continuous poll loop:

```
clagentic-triage watch
```

Review the pending queue:

```
clagentic-triage review
```

Approve or reject a queued verdict:

```
clagentic-triage approve <id>
clagentic-triage reject <id>
```

## Configuration

Configuration is loaded from environment variables (`CLAGENTIC_TRIAGE_*` prefix),
then `triage.config.json` in the working directory, then
`~/.config/clagentic/triage/config.json`.

See [docs/CONFIG.md](docs/CONFIG.md) for the full schema and all environment
variable overrides.

## Security model

- **Webhook verification.** Inbound webhook deliveries are verified by the source
  adapter (HMAC-SHA256 for GitHub, token comparison for GitLab/Forgejo) before any
  payload parsing. The webhook secret is required at startup when the webhook server
  is enabled — an empty secret is rejected at config load time.
- **Prompt-injection boundary.** Issue and PR bodies are wrapped in
  `<UNTRUSTED_USER_CONTENT>` tags and pass through a redaction step before LLM
  prompt construction. Common secret patterns (`ghp_*`, `sk-*`, `AKIA*`,
  `-----BEGIN *`) are redacted to `[REDACTED]`.
- **Intent file trust boundary.** The per-repo intent file
  (`.github/triage-intent.yml`) is authored by repo maintainers with write access.
  Its content is injected into the prompt as operator-controlled configuration, not
  user input. Referenced context files are path-validated against an extension
  allowlist before fetching. Intent files are capped at 64 KB; referenced context
  files are capped per-file and in aggregate.
- **Secrets via env, never stored.** Tokens and API keys are read from environment
  variables named by `runner_api_key_env` (or the runner's default env var). They
  are never written to the config file or the pending queue.

See [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) for the full rationale
behind each security decision (DD-001 through DD-007).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Pipeline stages, module layout, interfaces |
| [docs/CONFIG.md](docs/CONFIG.md) | Full config schema and environment variable reference |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Source adapter interface (poll + webhook), how to write one |
| [docs/DISPATCHERS.md](docs/DISPATCHERS.md) | Dispatch backend interface, reference dispatchers, third-party plugins |
| [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) | DD-001..DD-007 rationale and security decisions |

## License

[FSL-1.1-MIT](LICENSE) — Functional Source License, version 1.1, with MIT as the
Change License.
