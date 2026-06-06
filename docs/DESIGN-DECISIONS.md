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

---

## DD-006: Intent file trust boundary — repo maintainers are trusted, issue authors are not

**Decision:** The intent file (`.github/triage-intent.yml`) is treated as operator-controlled
configuration committed by repo maintainers, not as user input. Its content is injected into
the LLM prompt without the `<UNTRUSTED_USER_CONTENT>` boundary applied to issue/PR bodies.

**Rationale:**
- The intent file is committed to the repo by maintainers with write access. Write access is
  the relevant trust boundary: anyone who can modify `.github/triage-intent.yml` already has
  the ability to run arbitrary CI pipelines and deploy code. A prompt-injection attack via the
  intent file requires that level of access — it is not an unauthenticated attack surface.
- Issue and PR bodies, by contrast, are submitted by anonymous contributors. These are wrapped
  in `<UNTRUSTED_USER_CONTENT>` tags and pass through the `redact()` step in the assessor.

**Residual risk and mitigations:**
- A compromised maintainer account or a supply-chain compromise of the repo could weaponize
  the intent file. Mitigations applied:
  1. **Size cap (RT-003):** Intent files are capped at 64 KB (`MAX_INTENT_FILE_BYTES`) and
     truncated with a visible marker. A legitimate triage-intent.yml is typically < 2 KB; an
     abnormally large file is a signal. The cap limits the blast radius of prompt-stuffing.
  2. **`repo_context_files` path safety (RT-005):** Referenced context files are validated
     by extension allowlist and blocked-path patterns before fetching. The intent file cannot
     be used to read arbitrary repo content.
  3. **Composite byte bound:** The 64 KB intent cap is a *per-source* cap, not the total
     bytes reaching the LLM. A truncated intent file that retains a `repo_context_files`
     block still triggers up to `MAX_CONTEXT_FILES` (5) fetches of up to
     `MAX_CONTEXT_FILE_BYTES` (32 KB) each. The composite worst-case repo-controlled
     context is therefore ~64 KB + 5×32 KB ≈ 224 KB. All three caps compose; none defeats
     another. Operators tuning these limits should reason about the aggregate, not just the
     intent cap.
  4. **Operator awareness:** Operators deploying this tool should treat the intent file as
     configuration with the same review discipline as CI workflow files.

**What this does NOT protect against:**
- A maintainer who deliberately authors a malicious intent file to manipulate triage output.
  That is an insider threat, not a triage tool security issue.
- Repos where the default branch protection allows external contributors to push to the branch
  where `.github/triage-intent.yml` lives. Operators in this configuration should disable
  intent file loading or use a stricter branch protection policy.

---

## DD-007: Webhook server is provider-agnostic; verification and normalization are adapter responsibilities

**Decision:** `src/webhooks/server.js` is a generic HTTP receiver shell. It never references
provider-specific header names, HMAC schemes, or payload shapes. All provider-specific
webhook logic is owned by the source adapter, exported as four methods that form the adapter
webhook interface:

- `verify_webhook(rawBody, headers, secret) -> boolean` — provider's signature/token scheme
- `get_delivery_id(headers) -> string|null` — provider's replay-protection ID header
- `normalize_webhook(headers, payload) -> Event|null` — map raw payload to Event schema
- `is_bot_sender(payload, allowList) -> boolean` — bot-filtering at webhook ingress (DD-005)

The server calls these methods; it does not implement any of them.

**Rationale:**
- The adapter-pluggable rule from `CLAUDE.md` ("Core logic must not import adapter internals
  directly — only through the adapter interface") applies to webhook ingress too. Baking
  GitHub's HMAC scheme or `x-github-event` parsing into a generic server file violates this
  invariant and makes it impossible to plug in a GitLab or Forgejo adapter without modifying
  the server.
- GitLab uses a plain `x-gitlab-token` header (shared secret, no HMAC). Gitea uses
  `x-gitea-signature` with HMAC-SHA256 but a different header name. Each provider's
  verification logic is meaningfully different; the server cannot abstract over all of them
  without becoming a provider-aware switch statement — which is worse than delegation.
- The `normalize_webhook` method on the adapter shares internal normalization logic with the
  poll path (`list_events`). This ensures the Event schema is identical regardless of whether
  the event arrived via polling or webhook, preventing silent drift between the two paths.

**The `adapter` parameter is required and must implement the webhook interface.**
The server throws at call time if the adapter does not export the required methods.

**Replay protection** remains in the server (not the adapter) because it is provider-agnostic:
the `DeliveryIdSet` LRU tracks whatever opaque string `get_delivery_id` returns. The adapter
tells the server how to extract the ID; the server decides what to do with it.

**Scope:** `src/webhooks/server.js` must not contain any of the following:
- Literal strings `x-hub-signature-256`, `x-github-delivery`, `x-github-event`, `sha256=`
- Any HMAC computation
- Any provider-specific payload field access

---

## DD-008: Actor-association trust boundary — external contributors only by default

**Decision:** Events are filtered at adapter ingress by the actor's GitHub
`author_association`. The default policy triages **external contributors only** —
PRs and issues from the operator's own org members, owners, and collaborators are
filtered out unless explicitly opted in. The policy is config-driven via three
`source` fields and is **orthogonal to** the bot filter (DD-005): both filters
apply, and an event must pass both to be processed.

**Rationale:**
- The tool's purpose is to triage inbound signals from people outside the trusted
  circle — drive-by issues, first-time PRs, community contributions. PRs the
  operator opens themselves, or PRs from trusted internal automation, are noise
  for a triage agent: they are already going through the team's normal review.
- GitHub's `author_association` is the native signal for this distinction. It is
  present on both the REST issues/PRs API and webhook payloads, so the same filter
  works identically on the poll path and the webhook path.
- Defaulting to external-only is the conservative choice: it minimizes the surface
  the agent acts on and avoids the agent commenting on or assessing its own
  operators' work.

**Config (`source`):**

| Field | Default | Meaning |
|---|---|---|
| `watch_associations` | `['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN']` | The external set. An event whose `author_association` is in this list passes the association check. |
| `ignore_logins` | `[]` | Logins ALWAYS skipped, regardless of association (e.g. the operator's own username, or a non-`[bot]`-suffixed automation account such as `naomi`). |
| `watch_logins` | `[]` | Logins ALWAYS processed, even if their association is not in `watch_associations` (lets the operator watch a specific internal person). |

**Precedence (highest first):**
1. `ignore_logins` (deny) — wins over everything.
2. `watch_logins` (allow) — overrides the association bucket.
3. `watch_associations` bucket check.

**Known `author_association` values** (validated; unknown values in
`watch_associations` are rejected with `ConfigError`):
`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
`FIRST_TIMER`, `NONE`, `MANNEQUIN`.

**Null-association fail-open choice:** if `author_association` is `null` or missing
(not present on the payload, or an unrecognized value), the event is **processed**
(treated as external). A missing association on a real inbound event is far more
likely to be an external contributor than a trusted member, and the conservative
failure mode for a triage tool is to triage rather than to silently drop a
legitimate inbound signal. The deny list still applies first, so an operator can
always force-skip a specific login regardless of its association.

**Composition with DD-005:** the bot filter and the actor filter are independent.
The bot filter removes automated senders (`sender.type === 'Bot'` or `[bot]`
suffix); the actor filter removes internal humans. An event must pass both. The
actor filter does NOT replace the bot filter — a `[bot]` account with a
`COLLABORATOR` association is still dropped by the bot filter even though it would
also fail the actor filter.

**Placement:** the filter runs at adapter ingress on both paths, mirroring DD-005.
On the poll path, `list_events` excludes filtered items from the returned array.
On the webhook path, the filter runs after `normalize_webhook` (so
`author_association` is available on `event.metadata`); a filtered delivery is
acknowledged with `200 { status: 'ignored', reason: 'actor' }`, logged, and
`onEvent` is NOT called. The provider-agnostic server delegates the check to the
adapter via `actor_allowed(config, event)`, keeping the actor policy co-located
with the adapter that produced the association signal. The pure decision function
`should_process_actor(config, { author, author_association })` is exported for
reuse and testing.

---

## DD-009: ETag cache has a TTL, is invalidated after writes, and re-applies filters on 304 replay

**Decision:** The GitHub adapter's ETag cache (module-level Map keyed by repo + since) enforces
a 5-minute TTL, is invalidated after any write operation, and re-applies bot and actor filters
to cached items before returning them on a 304 replay.

**Rationale:**
- Without a TTL, a long-running watch process accumulates cache entries that are never evicted.
  Stale entries can mask real changes if GitHub's ETag happens to be reused for a different
  response body.
- After a write (comment, close, label, approve), the repo's state has changed. The ETag for
  that repo's issue list is now stale. Invalidating on write ensures the next poll fetches fresh
  data rather than replaying a pre-write snapshot.
- `config.source.allow_bot_logins` and `config.source.ignore_logins` can change between poll
  cycles (config reload). If a 304 replay returns pre-filter items and config has changed, the
  pipeline processes events it should have dropped (or vice versa). Re-applying filters on replay
  is a defense-in-depth measure that keeps behavior consistent across hot config changes.

**Implementation:**
- `ETAG_CACHE_TTL_MS = 300_000` (5 minutes). On cache lookup, if `Date.now() - entry.cached_at > TTL`,
  the entry is evicted and the fetch proceeds without `If-None-Match`.
- `_invalidate_cache(repo)` removes all entries whose key contains `:${repo}:`. Called in each write method.
- Cache entry is written **after** normalization succeeds (not before), so a partially-processed
  fetch never leaves a stale empty entry in the cache.
- On 304, the cached normalized events are re-run through `_isBot` and `should_process_actor` before
  being appended to the results.

---

## DD-010: Operator-supplied dispatcher module paths are validated before dynamic import

**Decision:** When a `dispatchers` config entry has a `module` field (operator-supplied path),
the path is validated against a confinement policy before `import()` is called. Invalid paths
are skipped with a warning; they never cause a crash.

**Rationale (RT-009):** Dynamic `import()` of an arbitrary operator-supplied path is a path
traversal risk. Without validation, a misconfigured or malicious config entry could load
system files (e.g. `/etc/passwd` as a module), execute code outside the project, or read
sensitive content. The confinement policy limits filesystem-path specifiers to within the
operator's `process.cwd()` — effectively the project directory.

**Implementation:**
- `_validate_module_path(modulePath, cwd)` (exported for testing) validates the specifier:
  - Rejects paths containing null bytes (C-level path truncation).
  - Bare npm specifiers (`package-name`, `@scope/pkg`) are not filesystem paths — they pass
    without confinement checks and are loaded via node_modules as normal.
  - Relative (`./`, `../`) and absolute paths are resolved to an absolute path via
    `resolve(cwd, modulePath)`. The resolved path must start with `cwd + sep` (sep-appended to
    prevent prefix-collision attacks like `/tmp` matching `/tmp-evil`).
  - Returns `{ valid: true, resolvedPath }` on pass or `{ valid: false, reason }` on reject.
- `resolveDispatcher` converts `resolvedPath` to a `file://` URL and passes that to `import()`.
  This is the key safety property: the path that is **validated** and the path that is **loaded**
  are identical. Using the raw `entry.module` string would let ESM resolve it relative to
  `src/dispatchers/`, not `cwd`, defeating the confinement check for relative specifiers.
- Validation failures log a warning and return `null`; the loader skips the entry and continues.
  The pipeline is never blocked by a bad dispatcher config entry.

**Scope note:** The hook module loader (`config.hooks`) is not yet implemented. When it is,
the same guard (`_validate_module_path` + import-from-resolvedPath) must be applied there.
This is noted in `src/cli.js` where hook loading will be wired.
