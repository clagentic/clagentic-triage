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

## DD-003: LLM calls via `claude` CLI subprocess only

**Decision:** All LLM calls go through the `claude` CLI as a child process.
The `anthropic` SDK is not a dependency.

**Rationale:** Workspace-wide rule. CLI is the default path. Marginal speed/cost wins do not
justify an SDK dependency. Deviation requires explicit sign-off.

**Implementation:** `src/llm.js` is a standalone utility that wraps the subprocess call,
constructs the prompt, invokes `claude`, parses JSON from stdout, and validates the output
schema. If output fails to parse or is missing required fields, `llm.js` returns an error
result — it does not retry silently. The caller (assessor) routes parse errors to HITL.

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
