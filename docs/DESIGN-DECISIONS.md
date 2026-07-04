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
