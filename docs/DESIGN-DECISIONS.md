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

---

## DD-011: Two-tier LLM assessment — cheap pre-filter before full assessor

**Decision:** An optional tier-1 pre-filter (`src/assessors/pre_filter.js`) runs before the
main assessor. It classifies events as `NOISE` or `REAL` using a short binary-classification
prompt. Noise events are rejected immediately without calling the main assessor. The pre-filter
is opt-in (`pre_filter.enabled: false` by default) and uses a separate `runner`/`model` config
so it can be routed to a cheap model independently of the main assessment model.

**Rationale:**
- Full assessment prompts are large (intent context, contributor profile, structured schema,
  chain-of-thought instruction). Running them on spam, gibberish, or auto-generated dependency
  bumps wastes tokens and adds latency with no triage value.
- A cheap model (Haiku, GPT-4o-mini, Gemini Flash) can reliably classify obvious noise at a
  fraction of the cost. The main assessor only runs on events that passed the filter.
- Pre-filter is opt-in because false positives (dropping a real event as noise) are worse than
  false negatives (letting noise reach the main assessor). Operators enable it once they have
  confidence in the threshold for their event stream.

**Failure behavior:**
- Any pre-filter failure (LLM error, parse error, timeout, model unavailable) degrades silently
  to pass-through: `noise: false`. The main assessor runs as if the pre-filter did not exist.
  Pre-filter failures are logged as warnings but are never fatal to the pipeline.
- Confidence below `pre_filter.confidence_threshold` (default 0.8) also passes through. The
  threshold is intentionally high: uncertain classifications pass, certain classifications gate.

**Security:**
- The pre-filter applies the full `redact()` suite (DD-004 credential patterns + RT-001
  injection markers) before prompt construction, identical to the main assessor. It is a new
  LLM egress path and must be treated as such.
- Pre-filter body input is capped at 1500 characters; title at 500. The full body is available
  to the main assessor if the event passes through.

**Implementation:**
- `preFilter(config, enrichedEvent)` in `src/assessors/pre_filter.js`. Returns
  `{ noise, reason, confidence, model_used }`.
- `noiseAssessment(enrichedEvent, preFilterResult)` builds a uniform Assessment (verdict:
  `reject`, action: `close`, `pre_filter: true`) for events flagged as noise.
- Pipeline wiring in `src/pipeline.js`: after `enrich()`, before `assess()`. Controlled by
  `config.pre_filter.enabled`.
- Config block: `pre_filter.{ enabled, runner, model, timeout_ms, confidence_threshold }`.
  `runner` and `model` fall back to the main runner/model if unset.
- `clagentic-router` is not compatible as a `pre_filter.runner` — the router endpoint expects
  the full assessment schema, not the binary `NOISE|REAL` response. Use a direct model runner
  for tier-1 filtering.

---

## DD-012: Namespaced label vocabulary — status/* is the single state axis

**Decision:** Labels are namespaced (`<axis>/<value>`). `status/*` is the SINGLE lifecycle-state
axis (`needs-triage`, `accepted`, `needs-info`, `blocked`, `in-progress`, `in-review`,
`awaiting-release`, `released`). Terminal "not planned" closures use a separate, unnamespaced set
(`wontfix`, `duplicate`, `invalid`) rather than status values, since they close the item instead
of describing an in-flight state. `kind/*`, `priority/*`, and `area/*` are orthogonal axes — they
describe the item, not its lifecycle state — and must never be folded into `status/*`. The entire
vocabulary is config-driven (`config.labels`), never hardcoded in business logic.

**Rationale:**
- Prior art (Kubernetes/Prow `kind/`, `priority/`, `sig/`; Rust's `T-*`/`S-*`; VS Code's
  `bug`/`feature-request` + separate triage states) converges on the same shape: exactly one
  axis tracks "where is this in its lifecycle," and every other axis is free to combine with it.
  Folding kind/priority/area into a single flat label list makes "what state is this in" an
  ambiguous query — the same problem this vocabulary avoids by keeping `status/*` singular.
- A single state axis is a precondition for a real state machine (T3/T7): "exactly one status/*
  label" only has to be enforced against one namespace, not reasoned about across every label
  an item might carry.
- The tool is a released, generic library (CLAUDE.md: no hardcoded org/repo/model names). The
  vocabulary itself — namespace names, status values, orthogonal axes — is exactly the kind of
  per-deployment choice that must be config-driven, not baked into `src/`. Two different
  operators triaging two different projects may legitimately want different `kind/*` values;
  the code must not assume any specific set.

**Implementation:**
- `src/labels.js` is the ticketing-agnostic vocabulary module. It knows nothing about GitHub,
  Jira, or any other backend — it only reasons about label strings and a vocabulary object.
  - `resolveVocabulary(config)` — merges `config.labels` over built-in defaults, never mutating
    either. An absent `config.labels` block is not an error; it means "use the defaults."
  - `normalizeLabels(config, labels)` — splits candidate labels into `{ accepted, rejected }`.
    Labels outside the vocabulary are rejected explicitly (not silently dropped) so callers can
    decide how to surface a rejection.
  - `enforceSingleStatus(config, currentLabels, incomingLabels)` — pure function; given an
    item's current labels and the labels about to be applied, returns which existing `status/*`
    label(s) must be removed to keep exactly one `status/*` label on the item. Throws
    `RangeError` if more than one `status/*` label is supplied as incoming (a caller bug, not a
    runtime data problem). This helper does not call any adapter; T7 wires the actual removal.
- `config.labels` (see `src/config/loader.js` `defaults()`): `status_namespace`, `status_values`,
  `not_planned_values`, `axes: { kind, priority, area, ...operator-defined }`. Validated at load
  time: `status_namespace` must not collide with any axis name, `status_values` and
  `not_planned_values` must be disjoint, and every value must be a non-empty string.
- Env vars: `CLAGENTIC_TRIAGE_LABELS_STATUS_NAMESPACE`, `CLAGENTIC_TRIAGE_LABELS_STATUS_VALUES`
  (comma-separated), `CLAGENTIC_TRIAGE_LABELS_NOT_PLANNED_VALUES` (comma-separated). Per-axis env
  overrides for `axes.*` are not provided — operators needing to customize orthogonal axes use a
  config file, consistent with how `dispatchers` and other structured blocks are configured.
- `src/adapters/github.js` gained `unlabel_item(config, event, label)` — `DELETE
  /repos/{owner}/{repo}/issues/{number}/labels/{name}` — additive alongside the existing
  `label_item` (add) method. A 404 (label not currently applied) is treated as an idempotent
  no-op, since `enforceSingleStatus` callers may attempt to remove a label that is already gone.
  Registered in `docs/ADAPTERS.md` and `src/adapters/index.js`.

**Scope note:** This DD covers the vocabulary, the adapter removal method, and the
single-status helper. Wiring the pipeline to actually call `enforceSingleStatus` +
`unlabel_item` on every label-applying action is deferred to T7 (the full lifecycle state
machine) — `_applyLabels` in `src/pipeline.js` is unchanged by this decision.

---

## DD-013: Closed-loop status back-post — inbound status hook, not outbound polling

**Decision:** clagentic:triage gains a **generic inbound** "task shipped" channel
(`src/status_hook.js`) rather than an outbound poller that queries each configured
backend for status changes. A durable side-index (`src/task_index.js`) records every
dispatched task's `task_id -> { repo, number, url }` mapping so the inbound hook can
resolve "which issue does task X belong to" independently of the one-time
`dispatch_results` blob. When the hook fires, `src/release_notify.js` posts a
config-driven comment and applies the `released` status/* label (DD-012) to the
originating item — as the triage bot's own `clagentic-triage[bot]` identity, with no
new App, gatekeeper, or "releaser" role. Issue bookkeeping remains triage's own job.

**Rationale:**
- **Inbound over outbound.** `src/webhooks/server.js` already establishes the inbound-hook
  pattern for GitHub-side events (DD-007). Extending that shape to backend-side state
  changes is more consistent than adding a second, backend-aware polling loop — triage
  would otherwise need to know how to query N different backends' status APIs, which
  directly violates the backend-agnostic rule (CLAUDE.md). A dispatcher-side push is
  symmetric with `create_task` (triage -> backend) and closes the loop without adding any
  backend-specific code to core.
- **Distinct trust boundary from the GitHub webhook.** The GitHub webhook server
  (`src/webhooks/server.js`) authenticates deliveries *from GitHub* using the adapter's
  `verify_webhook`. The status-callback channel authenticates deliveries *from whichever
  dispatcher backend the operator configured* — a different caller, a different secret
  (`status_hooks.secret` / `CLAGENTIC_TRIAGE_STATUS_HOOK_SECRET`), and a different route
  (`status_hooks.path`, default `/status-hook`) and port (default 8743). Reusing the
  GitHub webhook secret would conflate two independent trust boundaries: anyone who can
  forge a valid GitHub HMAC should not thereby gain the ability to post arbitrary "shipped"
  comments, and vice versa.
- **Same authentication discipline as RT-004.** `verify_status_hook` in `src/status_hook.js`
  mirrors the GitHub adapter's `verify_webhook`: HMAC-SHA256 over the raw body, signature
  carried in `x-clagentic-signature: sha256=<hex>`, `timingSafeEqual` comparison with a
  length guard before it, and a hard refusal (`createStatusHookServer` throws) if the
  channel is enabled with an empty secret. An unauthenticated call is rejected with 401
  before the body is even parsed.
- **The persistence gap was real.** Before this DD, `dispatch_results` (the `{ id, url }`
  a dispatcher's `create_task` returns) was stored only on the one-time pending-queue entry
  written at dispatch time (`src/queue.js`). There was no way to look up "which GitHub issue
  does task `lr-a68f` correspond to" after that queue entry had been resolved, or from a
  cold-started process. `src/task_index.js` is a small, ticketing-agnostic JSONL side-index
  keyed by `(dispatcher name, task_id)` — recorded once per successful `create_task` result
  (`src/pipeline.js`'s `_executeAction` dispatch case), queryable at any later point via
  `lookupTask`.
- **Idempotency by design, not by luck.** `applyReleaseNotice` (`src/release_notify.js`)
  scans existing comments for a hidden marker (`<!-- clagentic-triage:release
  task_id=... version=... -->`) before posting, and checks the item's live label state
  (`adapter.get_item_labels`) before applying `released`. A repeated call for the same
  `(task_id, version)` is a no-op on both axes — safe to retry, safe to replay.
- **Loop prevention already exists; this DD verifies it covers the release path.** The
  triage bot posts its own release comment as `clagentic-triage[bot]`. On the webhook
  ingress path, GitHub's `issue_comment` event always carries `payload.sender` set to the
  comment's actual author — so the existing DD-005 bot filter (`_isBot`, checked before
  `normalize_webhook` in `src/webhooks/server.js`) already drops the bot's own release
  comment at ingress, exactly as it would drop any other bot-authored comment. No new
  loop-prevention logic was needed; a regression test
  (`tests/webhook-server.test.js` — "drops the bot's own issue_comment delivery") pins this
  behavior specifically for the release-comment shape so a future change to either the bot
  filter or the webhook normalization path cannot silently reopen the loop. On the poll
  path, comments are never separately event-sourced (`list_events` only lists issues/PRs,
  not comments), so the loop risk is webhook-only by construction.

**Implementation:**
- `src/task_index.js` — durable `task_id -> { repo, number, event_url, task_url, event_id }`
  side-index. `recordTask(config, opts)` upserts by `(dispatcher, task_id)` (re-recording
  overwrites rather than duplicating); `lookupTask(config, task_id, { dispatcher })` reads
  it back. Same JSONL-per-line convention as `src/queue.js`. Config key: `task_index`
  (default `.triage/task-index.jsonl`).
- `src/pipeline.js` — after a successful `dispatch()` call in the `'dispatch'` action-class
  case, iterates the per-dispatcher results and calls `recordTask` for each one that
  returned a task id. Recording failures are logged and non-fatal — the dispatch itself
  already succeeded.
- `src/release_notify.js` — `applyReleaseNotice(config, adapter, target)` is the
  ticketing-agnostic core: renders `config.release_notify.comment_template` (default
  `"Shipped in {version}: {task_url}"`, placeholders `{version} {task_url} {task_id} {repo}
  {number}`), posts it via `adapter.post_comment` if not already posted, and applies the
  `released` status/* label via `enforceSingleStatus` (DD-012) + `adapter.label_item` /
  `adapter.unlabel_item` if not already applied. Never imports a dispatcher or any
  backend-specific module.
- `src/status_hook.js` — `createStatusHookServer(config, adapter)` /
  `startStatusHookServer(config, adapter)`, mirroring the shape of
  `src/webhooks/server.js`'s `createServer` / `startWebhookServer`. Accepts
  `{ task_id, dispatcher?, status: "shipped", version? }` JSON payloads on
  `status_hooks.path` (default `/status-hook`); only `status: "shipped"` is currently
  handled (other values are acknowledged and ignored). Looks up `task_id` via
  `lookupTask`; an unknown `task_id` is acknowledged (200) rather than treated as an error,
  since a backend may legitimately call this for a task triage never dispatched.
- `src/adapters/github.js` gained two new methods needed by the release-notify path:
  `list_comments(config, event)` (paginated `GET .../issues/{number}/comments`, used for the
  idempotency scan) and `get_item_labels(config, event)` (`GET .../issues/{number}`, used to
  read the item's live label set before the single-status transition). Both are additive to
  the adapter interface — existing callers of the adapter are unaffected.
- `src/cli.js` `cmdWatch` starts the status-hook server alongside the existing webhook
  server when `config.status_hooks.enabled` is true, and tears it down on `SIGINT`
  alongside the webhook server.
- Config (`src/config/loader.js`): `status_hooks: { enabled, port (default 8743), secret,
  bind, path (default "/status-hook") }` and `release_notify: { comment_template }`. Env
  vars: `CLAGENTIC_TRIAGE_STATUS_HOOK_SECRET`, `CLAGENTIC_TRIAGE_STATUS_HOOK_PORT`,
  `CLAGENTIC_TRIAGE_RELEASE_COMMENT_TEMPLATE`. Validation mirrors the webhook block:
  `status_hooks.enabled` requires a non-empty `status_hooks.secret` (RT-004 parity), and
  `status_hooks.port` must be a valid port integer.

**What is explicitly out of scope for this DD (see task lr-f848):**
- The private lore-side dispatcher module that would actually call this hook when a lore
  task ships — that is T4 (crew-manifest), a separate operator-config artifact, not core.
- Any lore-specific field names, URLs, or identifiers in `src/` — the hook payload shape
  (`task_id`, `dispatcher`, `status`, `version`) and the task-index record shape are generic
  across any ticketing backend.
- Wiring `enforceSingleStatus` into every other label-applying pipeline path (still T7,
  per DD-012's scope note) — this DD only wires it into the new release-notify path.

---

## DD-014: PR-merge and release/tag events are deterministic lifecycle transitions, routed outside the LLM-assessment pipeline

**Decision:** Triage ingests two new GitHub event classes — `pull_request` merged to the
default branch, and `release` publish — but neither ever reaches `enrich`/`assess`
(`src/pipeline.js`'s `processEvent`). A new module, `src/lifecycle.js`, applies the two
transitions directly against the adapter: a merge-to-default applies `status/awaiting-release`
to every issue the PR's `closingIssuesReferences` resolves (T5, lr-6857); a published release
applies the terminal `released` label (+ closes the issue with `state_reason: 'completed'`,
distinct from the LLM `close` action class's `not_planned`) to every issue its release notes
reference via a closing keyword. `awaiting-release != released` is enforced structurally: the
merge path can only ever call `applyMergeTransition` (which only ever applies
`awaiting-release`), and the release path can only ever call `applyReleaseTransition` (which
only ever applies `released`) — there is no code path that lets a merge apply `released`.

**Rationale:**
- A merged PR or a published release is a fact, not a judgment call. Routing it through the
  LLM assessor (which exists to interpret ambiguous human-authored issue/PR content) would be
  both wasteful and a category error — there is nothing to triage. `src/lifecycle.js`'s module
  docblock states this explicitly and the routing decision lives in exactly one place
  (`routeEvent` in `src/cli.js`) so both the webhook and poll ingress paths share it.
- **Merge-issue resolution reuses T5, never commit-message parsing.** `applyMergeTransition`
  calls `adapter.get_pr_closing_issues` (the GraphQL `closingIssuesReferences` read) — the
  same reliability guarantee T5 established: squash/merge strategies make commit messages an
  unreliable carrier of the original PR body's closing keywords, so this task does not
  reintroduce that class of bug.
- **Release-issue resolution is release-body closing-keyword parsing — a named trade-off, not
  an invented mechanism.** GitHub's `release` webhook payload carries no PR or commit list,
  only `tag_name`/`target_commitish`/`body`. Resolving the *true* PR range for a release
  requires a generic v*-tag detector with commit-range-to-PR association, which the plan
  (tome #670) explicitly defers to **T8** (crew-manifest, private module) as a v2-cut-line
  follow-on. `applyReleaseTransition` instead reuses T5's already-reviewed
  `parse_closing_keyword_refs` against the release body — this covers the common case
  (GitHub-generated and most changelog-tool release notes already carry `Closes #NN`-shaped
  entries per PR) without inventing new GraphQL surface area out of this task's scope.
  **Residual gap:** a release whose notes do not repeat each PR's closing keyword will not
  transition its issues to `released` via this path; T8's generic detector is the intended
  long-term fix. Tracked as a known limitation, not a silent gap — see `src/lifecycle.js`'s
  `applyReleaseTransition` docblock.
- **Every parsed ref — same-repo AND cross-repo — is validated against the configured watch
  scope before it drives any adapter call (BOBBIE pre-merge review 4629660561).** The release
  body is publisher/attacker-controlled text, not operator-controlled configuration: honoring
  cross-repo refs (rationale above) without a scope check let a malicious or careless release
  note (e.g. `Fixes some-other-org/some-other-repo#1`) drive triage's own token/App installation
  to label/close an issue in a repo the operator never configured triage to watch — a
  confused-deputy write. This is a structural regression class relative to
  `applyMergeTransition`, which only ever acts on the GraphQL-resolved same-repo
  `closingIssuesReferences` set and already discards cross-repo refs; the release path's wider
  trust surface (cross-repo refs are meaningful here, unlike the merge path) requires an
  explicit, matching guard rather than an implicit "same repo" boundary. `applyReleaseTransition`
  filters `[...sameRepoRefs, ...crossRepoRefs]` through `is_repo_in_watch_scope(config,
  "owner/repo")` (`src/adapters/github.js`) before building any target event; out-of-scope refs
  are dropped silently (not acted on, not an error — a release author does not get an error
  channel into triage's watch-scope decisions). `is_repo_in_watch_scope` is the same
  `config.source.repos`/`config.source.org` contract `_resolveRepos` already enforces for
  polling, expressed as a pure per-repo membership check (no network call) so a single
  candidate repo can be validated without listing every repo the config resolves to. It fails
  closed: `repos: ['*']` with no `source.org` configured is out of scope for every repo, exactly
  matching `_resolveRepos`'s existing refusal to expand a wildcard without an org.
- **`close_item_completed` is a new adapter method, not a `close_item` reuse.** `close_item`
  hardcodes `state_reason: 'not_planned'`, correct for the LLM-assessed `close` action class
  (reject/decline), but semantically wrong for "this shipped." Overloading `close_item` with a
  flag would mean every existing caller silently changes behavior unless updated; a distinct,
  additive method (mirroring the `label_item`/`unlabel_item` precedent, DD-012) keeps the two
  close semantics — and their very different meaning to a repo's contributors — clearly
  separated at the interface level. Idempotent on an already-closed issue, same guarantee as
  `close_item`.
- **Default-branch detection needs the repo's actual default branch, not a guess.** The webhook
  path gets `default_branch` for free from `payload.repository.default_branch` — carried into
  `event.metadata.default_branch` by `normalize_webhook`. The poll path's PR-list endpoint does
  not include repo-level fields, so `list_merged_prs` resolves it once per repo via the new
  `get_default_branch` method. `isMergedToDefaultBranch` compares `metadata.base_ref` against
  `metadata.default_branch` and fails closed (returns `false`, not "assume main") when the
  default branch could not be resolved — an unresolved default branch is "not actionable," not
  "probably main."

**Implementation:**
- `src/lifecycle.js` — `isMergedToDefaultBranch(event)` (pure predicate), `applyMergeTransition`,
  `applyReleaseTransition`. Both transition functions share `_applyStatusLabel`, a small
  private helper wrapping `enforceSingleStatus` (DD-012) + `get_item_labels`/`label_item`/
  `unlabel_item`, so both paths get the single-status invariant and idempotent no-op behavior
  (skip relabeling if the target label is already applied) for free.
- `src/adapters/github.js`:
  - `_normalize` gained an optional `defaultBranch` parameter, stored as
    `metadata.default_branch`. `normalize_webhook`'s `pull_request` branch passes
    `payload.repository.default_branch` through.
  - `metadata.merged` detection now also checks `raw.merged_at` directly (the shape the real
    `pulls` REST list endpoint uses), in addition to the existing
    `raw.pull_request?.merged_at` (issues-list endpoint shape) and `raw.merged` (boolean) checks.
  - `normalize_webhook` gained a `release` branch: only `payload.action === 'published'`
    normalizes (drafts, edits, deletions, and un-publishes return `null` — `published` is the
    one unambiguous "this is now live" signal, and also fires for prereleases). Releases
    normalize to a distinct `type: 'release'` Event shape (`_normalizeRelease`) — not an
    issue/PR — carrying `tag_name`, `target_commitish`, `draft`, `prerelease`, `published_at`.
  - New poll-path methods: `get_default_branch(config, repo)`, `list_merged_prs(config, repo,
    since)` (closed PRs with a non-null `merged_at`), `list_releases(config, repo)` (non-draft
    releases), and `list_lifecycle_events(config, since)` (aggregates both across every repo
    `config.source` resolves to — the repo-resolution logic itself was extracted from
    `list_events` into a shared `_resolveRepos` helper so both call sites share one
    implementation of the org-wildcard-vs-explicit-list contract).
  - New `close_item_completed(config, event)` — additive alongside `close_item`.
  - New `is_repo_in_watch_scope(config, repo)` — pure, network-free membership check against
    `config.source.repos`/`config.source.org`, factored out of (and matching) `_resolveRepos`'s
    existing scoping contract. Used by `applyReleaseTransition` to drop out-of-scope refs before
    they can drive any label/close call (see rationale above).
- `src/cli.js` — `routeEvent(config, event, adapter)`: the single dispatch point. `type ===
  'release'` -> `applyReleaseTransition`; `type === 'pr'` and `isMergedToDefaultBranch(event)`
  -> `applyMergeTransition`; everything else -> the existing `processEvent` LLM pipeline. Both
  `cmdWatch`'s webhook `onEvent` and poll `tick`, and `cmdRun`'s single pass, call `routeEvent`
  for webhook deliveries and use `adapter.list_lifecycle_events` (guarded by a
  `typeof === 'function'` check, since the interface addition is optional for adapters that
  have not implemented it yet) to source lifecycle events on the poll path.
- `docs/ADAPTERS.md` — documents the four new/changed adapter methods and the `release` webhook
  event type.

**What is explicitly out of scope for this task (see tome #670):**
- **T7** (multi-action verdicts, per-issue lifecycle state derived live from labels) — this
  task's transitions are single-purpose (one label + optional close), not a general
  multi-action verdict engine.
- **T8** (generic v*-tag release detector with true commit-range-to-PR association) — the
  release-body closing-keyword parse here is the interim, named-trade-off mechanism; T8 is the
  long-term fix for releases whose notes do not repeat each PR's closing keyword.

---

## DD-015: Multi-action verdicts (`suggested_action.classes[]`), single-status invariant enforced on every label-applying path, and lifecycle state derived live from labels

**Decision:** `suggested_action.class` (a single string) becomes `suggested_action.classes`
(an array of one or more action classes) so a single LLM verdict can, in one atomic step,
comment on an item, transition its `status/*` label, and dispatch it to a backend — three
actions that previously required three separate auto-approved verdicts (or three manual
approvals) to land together. `src/pipeline.js`'s label-application path (`_applyLabels`,
consumed by both the auto-approve and human-approval flows) now enforces the single-status
invariant that T2 (lr-a192, `enforceSingleStatus`) built but explicitly deferred wiring into
the pipeline: on any transition, the prior `status/*` label is removed (`adapter.unlabel_item`)
before the new one is applied (`adapter.label_item`), so an item is never observed carrying two
`status/*` labels. A new `getLifecycleState(config, adapter, event)` (`src/queue.js`) lets any
caller (CLI `state` command, future callers) ask "what lifecycle state is this issue in right
now?" — answered by reading the item's live labels, not a parallel store.

**Rationale:**
- **Why `classes[]` instead of a second `dispatch_action`/`label_action` field, or three
  separate suggested-action objects.** A flat array of the existing action-class vocabulary is
  the smallest change that removes the "one verdict, one action" ceiling: every existing
  execution path (`pipeline.js`'s per-class switch, `cli.js`'s `approve` command) already
  understands individual action classes: they just needed to loop instead of switch once. A
  richer structure (e.g. per-class metadata objects) was considered and rejected as scope
  creep — nothing in this task's acceptance criteria needs anything beyond "run these classes,
  in this order."
- **Backward compatibility is a named, deliberate trade-off, not an oversight.** `src/llm.js`'s
  `_validatePayload` accepts either `suggested_action.classes` (array) or the legacy singular
  `suggested_action.class` (string), normalizing the latter to a one-element array before
  returning. `src/assessor.js`, `src/router.js`, `src/pipeline.js`, and `src/cli.js`'s
  `cmdApprove` all apply the same normalization defensively. This exists because: (1) an
  operator's `clagentic-router` deployment (a config-driven external runner, DD is silent on its
  upgrade cadence) may not be redeployed in lockstep with triage's own release, and (2) items
  already sitting in the pending queue (`.triage/pending.jsonl`) at upgrade time were serialized
  under the old schema and must still be approvable after the upgrade. The LLM prompt schema
  block (`assessor.js`) only asks for `classes[]` going forward — the singular shape is an
  input-compatibility path, not a supported output target.
- **`route()`'s auto-approve rule requires every named class to be individually trusted, not
  just one of them (structural decision, not a trade-off).** A verdict naming
  `['respond', 'close']` must not auto-dispatch just because `respond` is in
  `config.auto_approve` while `close` is not — that would silently auto-execute a write action
  the operator never opted into, breaking DD-001's per-action-class HITL contract. `route()`
  therefore checks `actionClasses.every((c) => autoApprove.includes(c))`; if any single class in
  the verdict is not trusted, the whole verdict queues for human review. This is conservative by
  construction: a multi-action verdict is *harder* to auto-approve than a single-action one, in
  keeping with DD-001's "the cost of a missed automation is low; the cost of a false action is
  high."
- **Classes execute serially, in the LLM's listed order — not merged, not parallelized, not
  reordered.** `_executeAction` (`src/pipeline.js`) loops `suggested_action.classes` in order and
  calls the existing per-class adapter action for each (`_executeSingleAction`, the same switch
  the pre-T7 code had, factored out unchanged). "Respond, then close" is the natural order for
  "leave an explanatory comment before closing"; the assessor prompt instructs the LLM not to pad
  the list with classes that do not truly apply, so the emitted order carries real intent.
  `'dispatch'` and `'escalate'` both defer their queue_reason exactly as before; if either
  appears alongside an executable class, the executable classes still run immediately and the
  item is additionally queued for the deferred portion — already-executed actions are never
  undone or re-run.
- **Single-status invariant: enforced in exactly one place (`_applyLabels`), not duplicated at
  every call site.** `_applyLabels` already existed as the single label-application chokepoint
  for both the auto-approve and queued/`auto_label` paths (pre-T7 code); T7 adds
  `adapter.get_item_labels` (T2's live-label fetch) + `enforceSingleStatus` (T2's pure decision
  function) + `adapter.unlabel_item` (T2's removal call) to that one function, exactly mirroring
  the pattern `src/lifecycle.js`'s private `_applyStatusLabel` already established for the T6
  merge/release transitions (`enforceSingleStatus` → remove stale `status/*` → apply new). T7
  does not duplicate that pattern into a second helper; the pipeline's only label-application
  path now uses the same invariant-enforcement shape as the lifecycle-transition path.
  Non-status labels (`kind/*`, `priority/*`, `area/*`, unnamespaced `wontfix`/`duplicate`/
  `invalid`) pass through `enforceSingleStatus` unaffected — only a `status/*` value in the
  incoming label list triggers a removal.
- **Lifecycle state is derived from live labels, never from a parallel local store — this is a
  requirement from the task spec, not a preference.** A side-index (e.g. a JSON file keyed by
  `repo#number` tracking "last known state") would drift the moment a human relabels an issue
  directly on GitHub, via a GitHub Action, or through any path other than triage itself — the
  exact failure mode a single-source-of-truth state machine exists to prevent. `getLifecycleState`
  (`src/queue.js`) calls `adapter.get_item_labels` (the same T2 method `_applyLabels` already
  calls) and resolves the vocabulary via `resolveVocabulary`/`isStatusLabel` (`src/labels.js`) —
  no new adapter method, no new storage, no new reading path. A `status: null` result (no
  `status/*` label present) is a valid, expected answer — an untouched or newly-opened issue has
  no lifecycle state yet — not an error.

**Config keys:** none new — `getLifecycleState` and the single-status enforcement in
`_applyLabels` both resolve the vocabulary from the existing `config.labels` block (DD-012).

**Implementation:**
- `src/llm.js` — `_validatePayload` accepts `suggested_action.classes[]` or legacy
  `suggested_action.class` (string), validates every entry against `VALID_ACTION_CLASSES`, and
  normalizes onto `payload.suggested_action.classes` so every downstream caller sees the array
  shape regardless of which shape the runner returned.
- `src/assessor.js` — prompt schema block now asks for `suggested_action.classes[]`; the
  `<rules>` block explains the array semantics and warns against padding it. `_degradedAssessment`
  and the success-path Assessment builder both emit `classes` (defensively normalizing a legacy
  `class` string if `assess()` is ever called on a payload that bypassed `callLlm`'s validation).
- `src/router.js` — `route()` reads `suggested_action.classes` (or normalizes a legacy `class`),
  requires every class to be in `config.auto_approve` to dispatch; any single untrusted class
  forces the whole verdict to HITL.
- `src/pipeline.js` — `_executeSingleAction` (the pre-T7 per-class switch, unchanged) is now
  looped by `_executeAction` over `suggested_action.classes`, accumulating `actions_taken[]`,
  a single `queue_reason` (first one seen), and `dispatch_results`. `_applyLabels` fetches live
  labels and runs them through `enforceSingleStatus` before calling `unlabel_item`/`label_item`.
  `processEvent`'s PipelineResult keeps `action_taken` (first action, backward-compatible) and
  adds `actions_taken` (the full ordered list).
- `src/cli.js` — `cmdApprove` loops `suggested_action.classes` the same way for manually-approved
  queue items. New `cmdState`/`state` command reports an issue's lifecycle state via
  `getLifecycleState`.
- `src/queue.js` — new `getLifecycleState(config, adapter, event)`, returning
  `{ status: string|null, labels: string[] }`.
- `src/assessors/pre_filter.js`, `src/dispatchers/{webhook,noop,scaffold}.js`,
  `src/hooks/console.js` — updated to read/construct `classes[]` instead of `class` (display/
  logging/payload sites only; no behavioral branching on the value beyond formatting).
- `docs/ARCHITECTURE.md` — Assessment schema updated to `suggested_action.classes[]`.

---

## DD-016: Triage v3 — PR-open/ready-for-review auto-transitions, needs-info idle auto-close, and per-axis trust for intake labels (T10, lr-9e35)

**Decision:** Three additive, independently-gated components complete the "full triage-driven
flow" layer of the lifecycle-engine plan (tome #670):

1. **Auto-transitions off PR events**: an opened, still-draft PR that closes an issue
   transitions the issue to `status/in-progress`; a non-draft PR (opened directly as
   non-draft, or a draft PR marked ready for review) transitions it to `status/in-review`.
   Deterministic, never LLM-assessed — same family as T6's merge/release transitions.
2. **needs-info idle auto-close**: modeled on `actions/stale`'s own defaults (60 days idle
   before a warning comment, 7 further idle days before close), honoring exempt labels.
   Off by default (`config.stale.enabled`).
3. **Intake `kind/priority/area` suggestions**: the assessor prompt now surfaces the
   configured axis vocabulary and asks for label suggestions on intake; a new **per-axis**
   trust gate (`config.label_auto_approve`) — distinct from `auto_approve`/`auto_label` —
   decides which axes may be auto-applied. Empty by default (HITL until trusted per class,
   exactly as this task's spec requires).

**Rationale:**
- **Opened-vs-ready-for-review is resolved by the PR's draft flag, not by trying both
  transitions and picking whichever "wins."** An earlier draft of this design checked
  `applyPrOpenedTransition` first and fell through to `applyPrReadyForReviewTransition` only
  if the first reported nothing applied — but `applied` on a guarded-off issue (already past
  the target status) is ambiguous with `applied` on "nothing to do," so the fallthrough could
  silently skip the ready-for-review transition for a non-draft PR whose linked issue happened
  to already carry `status/in-progress` from an earlier poll. The two transitions are
  restructured to be **mutually exclusive by construction**: `applyPrOpenedTransition` only
  ever fires for a **draft** PR, `applyPrReadyForReviewTransition` only for a **non-draft,
  unmerged** PR. This mirrors GitHub's own webhook pair — `ready_for_review` only fires when a
  PR *transitions* out of draft, so a PR opened directly as non-draft must reach `in-review` via
  its `opened` delivery instead, which the draft-flag split naturally provides. `src/cli.js`'s
  `routeEvent` picks the single applicable transition via `event.metadata.draft`, no
  try-both-and-check-applied logic.
- **The poll path has no equivalent "opened"/"ready_for_review" edge signal — both transitions
  are therefore idempotent and called unconditionally on every open, unmerged PR each poll
  cycle**, exactly the same idempotent-poll design T6's merge/release transitions established
  (`_applyStatusLabel`'s no-op-if-already-applied check). A new poll-path listing,
  `list_open_prs` (mirroring `list_merged_prs`'s shape: `state=open` vs `state=closed` +
  `merged_at` filter), feeds `list_lifecycle_events`'s new `openPrs` bucket so the CLI's
  lifecycle poll cycle (already the single dispatch point for merge/release, T6) picks these up
  without a second poll loop or a second `routeEvent`-adjacent call site.
- **Both transitions refuse to regress an issue past a later status.** `_applyLinkedIssueStatus`
  (the shared implementation both `applyPrOpenedTransition`/`applyPrReadyForReviewTransition`
  delegate to) fetches the target issue's live labels and skips the label-apply if a "later"
  status (`in-review`/`awaiting-release`/`released` for the in-progress transition;
  `awaiting-release`/`released` for the in-review transition) is already present. Without this
  guard, a poll cycle re-observing a PR that has already advanced past review (e.g. re-opened
  after being merged and reverted) could regress the issue's status backward — a correctness
  bug the merge/release transitions do not have to worry about because they only ever move
  forward along the lifecycle's terminal end.
- **needs-info idle time is derived from GitHub's own `updated_at`, not a comment-count
  heuristic or a parallel timestamp store.** `actions/stale` itself treats any update
  (comment, label change, edit) as activity that resets the idle clock; `updated_at` is the
  field GitHub already maintains for exactly that purpose. A parallel "last seen" store would
  drift the same way a parallel lifecycle-state store would (T7's rationale, DD-015) — this task
  reuses that same principle rather than reintroducing the anti-pattern DD-015 explicitly
  rejected.
- **The stale-close sweep is issue-only, needs its own adapter listing method
  (`list_issues_by_label`), and deliberately bypasses `list_events`'s bot/actor/cap
  filtering.** A deterministic idle-close decision must see every open `status/needs-info`
  issue regardless of who commented on it last — the bot filter (DD-005) and actor-association
  filter (DD-008) exist to keep noisy/low-trust actors out of *LLM assessment*, not to hide an
  issue from a fact-based idle-time sweep the operator explicitly opted into.
- **The warning comment's idempotency uses the same "scan live state for a marker" pattern
  DD-013's release-notify path established**, rather than a parallel "have I warned this issue"
  store: a hidden HTML comment marker (`<!-- clagentic-triage:stale-warning -->`) is appended to
  the warning body; a repeat sweep checks `list_comments` for the marker before posting again.
  This means an issue that receives new activity after the warning (moving its `updated_at`
  forward, dropping it back below `needs_info_days`) naturally "resets" — the next sweep simply
  will not re-warn or close it, with no explicit reset logic needed.
- **A dedicated `label_auto_approve` config key, not overloading `auto_label`.** `auto_label`
  (pre-existing) is a blanket boolean gating *whether any* suggested label applies to a queued
  item — it does not distinguish `status/*` (already tightly governed by
  `auto_approve`/the lifecycle transitions) from the orthogonal `kind/priority/area` axes this
  task's spec calls out by name ("HITL until trusted per class"). Reusing `auto_label` for
  per-axis trust would conflate two different trust decisions behind one flag: an operator who
  trusts the LLM's `kind` classification (low blast radius — cosmetic if wrong) but not its
  `priority` classification (can affect on-call routing) has no way to express that with a
  single boolean. `label_auto_approve` is an explicit array of axis names, validated at config
  load against `labels.axes` (rejects unknown axes and rejects the status namespace itself,
  which is not a "class" this key governs). Empty by default — no axis is auto-applied until the
  operator opts in, matching DD-001's posture and the task's explicit instruction not to
  auto-apply until trust is configured.
- **`_filterTrustedAxisLabels` runs in `_applyLabels` for BOTH the dispatched and
  `auto_label`-gated-queued paths, not just one.** An untrusted axis must never auto-apply
  regardless of whether the item's *action class* happened to be trusted — a verdict naming
  `['dispatch']` with `auto_approve: ['dispatch']` should still hold back an untrusted `area/*`
  suggestion even though the dispatch itself proceeds immediately. The full, unfiltered
  suggestion list remains on the assessment record in the queue for a human to apply manually.
- **The assessor prompt surfaces the operator's actual configured axis values
  (`config.labels.axes`), not a generic "suggest a label" instruction.** `src/labels.js`'s
  `normalizeLabels` already rejects any label outside the configured vocabulary — asking the LLM
  to freehand label values it cannot know are valid would produce suggestions that are silently
  rejected downstream. Listing the exact `kind/*`/`priority/*`/`area/*` values in the prompt
  (skipping any axis with no configured values, e.g. a default-empty `area`) lets the LLM choose
  from the real vocabulary and gives it an explicit instruction to omit an axis rather than guess
  when uncertain.

**What is explicitly out of scope for this task (see tome #670):** none of the three
components is deferred — all three ship in this PR. The one named residual limitation is that
`stale.close_after_days`'s warning-then-close cadence checks on each `run`/`watch` poll cycle,
not on a wall-clock schedule independent of polling frequency — an operator running `watch` with
a very long `poll_interval_seconds` will see coarser-grained stale-close timing. This is the same
poll-cadence coupling every other poll-path check in this codebase already has (T6's merge/
release poll, T10's own open-PR poll) and is not a new trade-off introduced by this task.

**Config keys:**
```json
{
  "label_auto_approve": [],
  "stale": {
    "enabled": false,
    "needs_info_days": 60,
    "close_after_days": 7,
    "exempt_labels": [],
    "stale_comment_template": "This issue has had no activity for {days} days while marked needs-info. It will be closed in {close_after_days} days if no update is provided.",
    "close_comment_template": "Closing due to inactivity — no update was provided after the needs-info notice."
  }
}
```

**Env vars:** `CLAGENTIC_TRIAGE_LABEL_AUTO_APPROVE` (comma-separated axis names),
`CLAGENTIC_TRIAGE_STALE_ENABLED`, `CLAGENTIC_TRIAGE_STALE_NEEDS_INFO_DAYS`,
`CLAGENTIC_TRIAGE_STALE_CLOSE_AFTER_DAYS`, `CLAGENTIC_TRIAGE_STALE_EXEMPT_LABELS`.

**Implementation:**
- `src/lifecycle.js` — `applyPrOpenedTransition`/`applyPrReadyForReviewTransition`, sharing
  `_applyLinkedIssueStatus` (the "resolve closing issues, guard against regression, apply via
  the existing `_applyStatusLabel` single-status-invariant helper" logic factored out once for
  both transitions).
- `src/adapters/github.js` — `_normalize` gained a `webhookAction` parameter (carried as
  `metadata.webhook_action`, populated by `normalize_webhook`'s `pull_request` branch from
  `payload.action`) and an `updated_at` metadata field (from `raw.updated_at`, used by the stale
  sweep). New poll methods: `list_open_prs(config, repo)` (mirrors `list_merged_prs`'s shape) and
  `list_issues_by_label(config, label)` (issue-only, filters out PRs sharing the label).
  `list_lifecycle_events` aggregates a new `openPrs` bucket alongside the existing `mergedPrs`/
  `releases`.
- `src/cli.js` — `routeEvent` branches on `event.metadata.draft` to pick exactly one of
  `applyPrOpenedTransition`/`applyPrReadyForReviewTransition` for a PR event that is not a
  default-branch merge. `cmdWatch`'s tick and `cmdRun` both fold `openPrs` into the existing
  lifecycle-poll loop and call the new `checkStaleNeedsInfo` (`src/stale.js`) once per cycle.
- `src/stale.js` — new module: `checkStaleNeedsInfo(config, adapter)`, the idle-sweep described
  above. No-op when `config.stale.enabled` is false.
- `src/pipeline.js` — `_applyLabels` gained `_filterTrustedAxisLabels`/`_axisOf`: non-status
  labels are filtered to axes present in `config.label_auto_approve` before being passed through
  `enforceSingleStatus`/applied, on both the dispatched and `auto_label`-gated-queued paths.
- `src/assessor.js` — `_buildPrompt` surfaces `config.labels.axes` as an explicit intake-labeling
  instruction in the `<rules>` block, listing the real configured values per axis.
- `src/config/loader.js` — new `label_auto_approve` (default `[]`) and `stale` (defaults above)
  top-level config keys, with load-time validation (`label_auto_approve` entries must be known,
  non-status axes; `stale.needs_info_days`/`close_after_days` must be positive integers).
- `docs/CONFIG.md`, `docs/ADAPTERS.md` — document the new config keys, env vars, and adapter
  methods.

---

## DD-017: Action-class/event-type matrix is one shared module, enforced at every boundary (lr-757a69)

**Decision:** `src/action_classes.js` is the single source of truth for which action classes
(`approve`, `respond`, `request_changes`, `close`, `dispatch`, `escalate`) are valid for which
event types (`issue`, `pr`). Every layer that reasons about this — the assessor prompt, the
assessor's own re-route guard, and the CLI's execution-boundary check — reads from this one
module instead of restating the rule.

**Rationale:**
- The rule already existed exactly once, informally: the assessor prompt (lr-4717) instructs
  the model that `approve`/`request_changes` are PR-only. But that was the *only* place the
  constraint lived. A human operator running `clagentic-triage override <id> --action approve`
  against an issue, or a model that violated the prompt constraint (observed on console#314/
  #315), both reached `adapter.approve_pr`/`adapter.request_changes` and got a raw `AdapterError`
  thrown deep in `src/adapters/github.js` — accurate, but not discoverable ahead of time and not
  actionable at the point of failure.
- Docs (`docs/ACTION_CLASSES.md`), CLI help text, and the two enforcement points below all need
  the same matrix. Hardcoding it four times invites exactly the kind of silent drift this task
  exists to fix — the fix has to be the single place that answers "is class X valid for type Y,"
  not another parallel restatement of the same six-by-two table.

**Two enforcement points, one root cause each:**
1. **Execution boundary (`src/cli.js`)** — `cmdApprove` and `cmdOverride` call
   `isActionClassValidForType` before invoking any adapter method, for every class the queue item
   carries (not just the first). A mismatch exits with a message naming the valid classes for
   that event's type (`mismatchMessage`) instead of reaching `AdapterError`. This covers the
   *human* path: an operator who overrides to the wrong class for the item's type, or approves a
   held item whose LLM-suggested class only reaches the execution boundary now that a mismatch is
   possible upstream (see below).
2. **Assessor re-route guard (`src/assessor.js`'s `assess()`)** — after `callLlm` returns a
   validated payload, every class in `suggested_action.classes` is checked against
   `enrichedEvent.type`. If any class is invalid for the type (model non-compliance with the
   prompt's PR-only instruction), the Assessment is downgraded to `verdict: 'escalate'`,
   `confidence: 0`, with the invalid class(es) dropped from `suggested_action.classes` (any
   still-valid class in the same multi-action verdict survives). This covers the *model* path:
   the item is never queued with an action class its own event type makes un-approvable — it
   escalates to a human with a reasoning string naming exactly which class(es) were rejected and
   why, rather than surfacing only as an eventual `AdapterError` if auto-approved, or as a silent
   dead end if a human later tries to approve an item that can never succeed.

**What this does NOT change:** `src/llm.js`'s `_validatePayload` still validates that each class
is one of the six known values (`VALID_ACTION_CLASSES`) — that check is orthogonal (is this a
real class at all?) to this task's check (is this class valid for *this event's type*?). Both
run; `_validatePayload`'s check happens first, inside `callLlm`, before `assess()` ever sees the
payload.

**Config keys:** none — this is validation logic, not operator-configurable policy.

**Implementation:**
- `src/action_classes.js` — new module: `ALL_ACTION_CLASSES`, `validTypesForClass`,
  `validClassesForType`, `isActionClassValidForType`, `mismatchMessage`.
- `src/cli.js` — `cmdApprove` validates every class in the held item's `suggested_action.classes`
  against `item.event.type` before the execution loop; `cmdOverride` now unconditionally looks up
  the item (previously only on `--action dispatch`) so the override's class can be validated
  against the item's type; `cmdHelp`'s override usage text lists valid classes per type via
  `validClassesForType` rather than a hand-maintained string.
- `src/assessor.js` — `assess()` filters `suggested_action.classes` against
  `enrichedEvent.type` after `callLlm` returns; a mismatch re-routes the Assessment to
  `verdict: 'escalate'`.
- `docs/ACTION_CLASSES.md` — new doc: the authoritative matrix, referenced from `README.md`'s
  documentation table and its `override` usage blurb.
