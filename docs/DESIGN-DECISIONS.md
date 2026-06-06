# clagentic:triage — Design Decisions

## DD-001: Human-in-the-loop by default; auto-approve is opt-in per action class

**Decision:** The approval gate defaults to human-in-the-loop for all action classes.
Auto-approve must be explicitly opted into, per action class, in config.

**Rationale:**
- Modifying live GitHub repos (closing issues, posting comments, labeling) carries reputational
  risk on wrong verdicts. The cost of a missed automation is low; the cost of a false close is high.
- The right v0.1 default is conservative. Users who trust the model's verdicts can unlock
  auto-approve incrementally per action class as they gain confidence.
- Research into existing LLM triage bots confirms over-automation is the single most common
  reason they get disabled. All production systems treat LLM output as proposals, not commands.

**Implementation:**
- `config.auto_approve` is a list of action classes (`approve`, `respond`, `request_changes`,
  `close`, `dispatch`, `escalate`). Default: empty list (fully HITL).
- The approval gate checks `config.auto_approve` at runtime. If the assessed action class is
  in the list, it executes immediately. Otherwise the verdict is written to the pending queue.
- A second gate applies regardless of `auto_approve`: if `assessment.confidence < config.confidence_threshold`
  (default: 0.7), the item is always routed to HITL with `low_confidence` as the reason.
  This cannot be overridden by `auto_approve`.

**Config keys:**
```json
{
  "auto_approve": [],
  "confidence_threshold": 0.7
}
```

**Env var:** `CLAGENTIC_TRIAGE_AUTO_APPROVE` (comma-separated action classes), `CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD`.

---

## DD-002: Intent file is YAML with referenced context files

**Decision:** The primary intent file format is `.github/triage-intent.yml` (YAML).
A Markdown fallback (`.github/TRIAGE_INTENT.md`) is supported for simple cases.

**Rationale:**
- YAML allows structured rule definitions, per-rule output schemas, and a `repo_context_files`
  list that references existing repo documents (CONTRIBUTING.md, CODEOWNERS, etc.) rather than
  duplicating them. The LLM gets richer context without requiring maintainers to write a
  triage-specific document from scratch.
- Markdown fallback keeps the tool usable for repos that don't want a structured intent file.

**YAML schema (minimum viable):**
```yaml
repo_context_files:
  - path: "CONTRIBUTING.md"
  - path: ".github/CODEOWNERS"

triage_rules:
  - id: default
    description: "General triage rules for this repository."
    llm_context: |
      Accept bug reports with reproduction steps.
      Request info if steps are missing.
      Redirect support questions to Discussions.
```

**Enricher behavior:**
1. Look for `.github/triage-intent.yml`. If found, load it, read each `repo_context_files` entry
   via the adapter, inject their content into the prompt context block.
2. If not found, look for `.github/TRIAGE_INTENT.md`. Inject as a single context block.
3. If neither found, use a built-in generic fallback intent string.

---

## DD-003: LLM calls via runner dispatch in `src/llm.js`; four backends supported

**Decision:** All LLM calls go through `callLlm()` in `src/llm.js`. The runner
backend is selected by `config.runner` (or `opts.runner` per-call). The `anthropic`
SDK is not a dependency — the `anthropic-api` runner uses raw `fetch`.

**Rationale:** CLI is the default path. Marginal speed/cost wins do not justify an SDK
dependency. Multiple runner backends are needed for operators who cannot install the CLI
or who need to route to OpenAI-compatible endpoints or the clagentic:router service.

**Implementation:** `src/llm.js` selects a runner based on `config.runner`, delegates
to the appropriate backend function, and applies unified schema validation before
returning. If output fails to validate, `llm.js` throws `LlmError` — it does not retry
silently. The caller (assessor) routes LlmErrors to HITL.

**Runner selection:**

`config.runner` selects the backend. `config.model` is passed as a hint.

| Runner | Behavior |
|---|---|
| `"claude-cli"` | Default. Spawns the `claude` CLI subprocess. Model passed as `--model`. |
| `"anthropic-api"` | HTTP POST to `https://api.anthropic.com/v1/messages`. API key from env. |
| `"openai-compatible"` | HTTP POST to `${runner_url}/chat/completions`. Covers OpenAI, Azure, Ollama, etc. |
| `"clagentic-router"` | HTTP POST to `${runner_url}/v1/assess`. Router handles multi-provider routing. |

**Deprecation:** `model: "clagentic:router"` is deprecated. On config load it is
automatically migrated to `runner: "clagentic-router"` + `model: "auto"` with a warning.
`router_url` is deprecated in favor of `runner_url` with the same migration shim.

---

## DD-004: Input sanitization before LLM prompt construction

**Decision:** Issue/PR body content is redacted of likely secrets before being injected
into any LLM prompt.

**Rationale:** Issue bodies can contain credentials accidentally pasted by reporters.
All of that content is sent to the Claude API. Pre-processing is simple and eliminates
a whole class of data leakage risk.

**Implementation:** The assessor runs body content through a redact step before prompt
construction. Patterns redacted: `ghp_*`, `sk-*`, `-----BEGIN *`, `AKIA*`, and similar
common secret shapes. The redacted form is `[REDACTED]`. This happens in the assessor,
not the adapter — the adapter stores the raw body; redaction is a prompt-construction concern.

---

## DD-005: Bot event filtering at adapter ingress

**Decision:** Events where `sender.type === 'Bot'` or `sender.login` ends in `[bot]` are
filtered out at the adapter layer before entering the pipeline.

**Rationale:** Without this filter, the triage bot can create feedback loops: bot posts a
comment → webhook fires → bot processes its own comment → loop. Filtering at ingress is the
cleanest place; it keeps the pipeline free of bot-awareness.

**Exception:** The filter list is configurable (`config.source.allow_bot_logins`) for orgs
that need cross-bot interactions (e.g. a known safe bot that posts structured reports).
