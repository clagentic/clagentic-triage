/**
 * Issue-lifecycle transitions driven by PR-merge, release/tag, and PR-open/
 * ready-for-review events (T6 lr-d557, T10 lr-9e35).
 *
 * These transitions are deterministic label/close operations, not LLM assessments —
 * a merged PR, a published release, an opened PR, or a PR leaving draft state are
 * all facts, not something to triage. This module therefore never imports
 * enrich/assess (src/enricher.js, src/assessor.js); callers (src/cli.js) branch on
 * `event.type` before the pipeline so these events never reach the LLM-assessment
 * path (docs/ADAPTERS.md, DD-013 for the analogous release_notify.js precedent).
 *
 * Four transitions, kept in one module because they share the same closing-issue
 * resolution and single-status-invariant machinery, and because the #1 rule for
 * released tools is that the release pair must never be conflated:
 *
 *   applyMergeTransition       — PR merged to the repo's default branch
 *                                 -> status/awaiting-release on each linked issue.
 *   applyReleaseTransition     — release/tag published
 *                                 -> released on each linked issue (+ close if open).
 *   applyPrOpenedTransition    — PR opened, linking one or more issues
 *                                 -> status/in-progress on each linked issue.
 *   applyPrReadyForReviewTransition — draft PR marked ready for review
 *                                 -> status/in-review on each linked issue.
 *
 * awaiting-release != released: a merge-close must NOT masquerade as shipped. Only a
 * published release/tag may apply the terminal `released` label; merge only ever
 * applies `awaiting-release`. See docs/DESIGN-DECISIONS.md (this task's DD entry).
 */

import { enforceSingleStatus } from './labels.js';
import { parse_closing_keyword_refs, is_repo_in_watch_scope } from './adapters/github.js';

/**
 * Fallback backoff duration (ms) applied when a rate-limited error carries no
 * parseable reset/retry hint. Matches GitHub's documented ~1hr GraphQL point
 * budget window (lr-b3a052) — safer to wait a full window than to guess low
 * and re-trigger the storm this backoff exists to prevent.
 */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

/** The status/* value applied when a PR merges to the default branch. */
const AWAITING_RELEASE_STATUS_VALUE = 'awaiting-release';

/** The status/* value applied when a PR opens, linking an issue (T10, lr-9e35). */
const IN_PROGRESS_STATUS_VALUE = 'in-progress';

/** The status/* value applied when a linked PR leaves draft state (T10, lr-9e35). */
const IN_REVIEW_STATUS_VALUE = 'in-review';

/** The status/* value applied when a release/tag is published. */
const RELEASED_STATUS_VALUE = 'released';

/**
 * Resolve the namespaced `status/<value>` label string for a given vocabulary value.
 *
 * @param {object} config
 * @param {string} value
 * @returns {string}
 */
function _statusLabel(config, value) {
  const namespace = config?.labels?.status_namespace ?? 'status';
  return `${namespace}/${value}`;
}

/**
 * Apply a single status/* label to one item via the single-status invariant
 * (enforceSingleStatus): removes any other status/* label currently on the item,
 * then applies the new one. A no-op if the item already carries exactly this label.
 *
 * @param {object} config
 * @param {object} adapter
 * @param {object} event - { repo, number, url } shape (Normalized Event or subset)
 * @param {string} statusLabel - fully-namespaced label, e.g. "status/awaiting-release"
 * @returns {Promise<boolean>} true if a label mutation occurred, false if already applied
 */
async function _applyStatusLabel(config, adapter, event, statusLabel) {
  const currentLabels = await adapter.get_item_labels(config, event);
  if (currentLabels.includes(statusLabel)) {
    return false;
  }

  const { toRemove, toApply } = enforceSingleStatus(config, currentLabels, [statusLabel]);
  for (const label of toRemove) {
    await adapter.unlabel_item(config, event, label);
  }
  await adapter.label_item(config, event, toApply);
  return true;
}

// ---------------------------------------------------------------------------
// Merge transition
// ---------------------------------------------------------------------------

/**
 * Return true if a normalized PR Event represents a merge to the repo's default
 * branch. Both ingress paths populate the fields this checks:
 *   - webhook: `normalize_webhook` carries `payload.repository.default_branch`
 *     into `metadata.default_branch`.
 *   - poll: `list_merged_prs` resolves it via `get_default_branch` per repo.
 *
 * @param {object} event - Normalized Event (type='pr')
 * @returns {boolean}
 */
export function isMergedToDefaultBranch(event) {
  if (event?.type !== 'pr') {
    return false;
  }
  const meta = event.metadata ?? {};
  if (!meta.merged) {
    return false;
  }
  if (!meta.default_branch) {
    // Default branch unresolved — cannot confirm the invariant; caller should
    // treat this as "not actionable" rather than guessing.
    return false;
  }
  return meta.base_ref === meta.default_branch;
}

/**
 * Apply the `awaiting-release` transition to every issue a merged PR closes.
 *
 * Resolves the closing-issue set via `adapter.get_pr_closing_issues` (T5,
 * lr-6857 — GraphQL `closingIssuesReferences`, the authoritative same-repo
 * source). Cross-repo `owner/repo#N` keyword refs are surfaced by that same
 * call but are NOT auto-close candidates (GitHub's keyword auto-close is
 * same-repo only) — they are skipped here, same as release_notify.js never
 * substitutes commit-message parsing for the GraphQL read.
 *
 * No-op (returns an empty result) if the PR was not merged to the default
 * branch — callers should check `isMergedToDefaultBranch` first, but this
 * function re-checks defensively so it is safe to call directly.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement get_pr_closing_issues,
 *   get_item_labels, label_item, unlabel_item)
 * @param {object} prEvent - Normalized Event (type='pr')
 * @returns {Promise<{ applied: boolean, issues: {repo:string, number:number, labeled:boolean}[] }>}
 */
export async function applyMergeTransition(config, adapter, prEvent) {
  if (!isMergedToDefaultBranch(prEvent)) {
    return { applied: false, issues: [] };
  }

  const { closingIssues } = await adapter.get_pr_closing_issues(config, prEvent);
  const statusLabel = _statusLabel(config, AWAITING_RELEASE_STATUS_VALUE);

  const issues = [];
  for (const closing of closingIssues) {
    const targetRepo = `${closing.owner}/${closing.repo}`;
    const targetEvent = { repo: targetRepo, number: closing.number, url: closing.url };
    const labeled = await _applyStatusLabel(config, adapter, targetEvent, statusLabel);
    issues.push({ repo: targetRepo, number: closing.number, labeled });
  }

  return { applied: true, issues };
}

// ---------------------------------------------------------------------------
// PR-opened / ready-for-review transitions (T10, lr-9e35)
// ---------------------------------------------------------------------------

/**
 * Shared implementation for the two "PR is open and linked to an issue"
 * transitions (`applyPrOpenedTransition` -> in-progress, draft PRs;
 * `applyPrReadyForReviewTransition` -> in-review, non-draft PRs). Mutually
 * exclusive by construction: GitHub's own draft flag is the boundary between
 * them, mirroring the real `opened`/`ready_for_review` webhook pair (a PR
 * opened directly as non-draft goes straight to in-review; a draft PR that
 * later leaves draft state fires `ready_for_review`). This is also what makes
 * the poll path (which never sees a webhook `action`) safe to call
 * unconditionally on every open, unmerged PR each cycle: exactly one of the
 * two transitions is eligible for a given PR's current draft state, so there
 * is no double-apply race between them regardless of ingress path.
 *
 * Idempotent per issue via `_applyStatusLabel` (no-op if the target status is
 * already applied), and guarded against regressing an issue that has already
 * advanced past the target status (e.g. a stale poll re-observing an old,
 * already-in-review PR must never revert an issue's status back to
 * in-progress, and neither transition may revert `awaiting-release`/`released`).
 *
 * @param {object} config
 * @param {object} adapter
 * @param {object} prEvent      - Normalized Event (type='pr')
 * @param {string} statusValue  - bare status value to apply (e.g. 'in-progress')
 * @param {string[]} laterValues - bare status values that must never be regressed
 * @returns {Promise<{ applied: boolean, issues: {repo:string, number:number, labeled:boolean}[] }>}
 */
async function _applyLinkedIssueStatus(config, adapter, prEvent, statusValue, laterValues) {
  const { closingIssues } = await adapter.get_pr_closing_issues(config, prEvent);
  if (closingIssues.length === 0) {
    return { applied: false, issues: [] };
  }

  const statusLabel = _statusLabel(config, statusValue);
  const laterStatuses = new Set(laterValues.map((v) => _statusLabel(config, v)));

  const issues = [];
  let anyLabeled = false;

  for (const closing of closingIssues) {
    const targetRepo = `${closing.owner}/${closing.repo}`;
    const targetEvent = { repo: targetRepo, number: closing.number, url: closing.url };

    const currentLabels = await adapter.get_item_labels(config, targetEvent);
    if (currentLabels.some((l) => laterStatuses.has(l))) {
      issues.push({ repo: targetRepo, number: closing.number, labeled: false });
      continue;
    }

    const labeled = await _applyStatusLabel(config, adapter, targetEvent, statusLabel);
    anyLabeled = anyLabeled || labeled;
    issues.push({ repo: targetRepo, number: closing.number, labeled });
  }

  return { applied: anyLabeled, issues };
}

/**
 * Apply the `in-progress` transition to every issue an open, draft, unmerged
 * PR closes.
 *
 * Resolves the closing-issue set via `adapter.get_pr_closing_issues` (T5,
 * lr-6857 — GraphQL `closingIssuesReferences`), the same authoritative source
 * `applyMergeTransition` uses. A PR with no linked issue is a no-op — omit the
 * trailer, no signal, no state change (same "don't fail closed on absence"
 * rule the plan applies to the merge/release paths).
 *
 * Only fires for a **draft** PR — a non-draft PR (opened ready for review, or
 * a draft that has since left draft state) is `applyPrReadyForReviewTransition`'s
 * responsibility instead, keeping the two transitions mutually exclusive by
 * construction (see `_applyLinkedIssueStatus`'s docblock).
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement get_pr_closing_issues,
 *   get_item_labels, label_item, unlabel_item)
 * @param {object} prEvent - Normalized Event (type='pr')
 * @returns {Promise<{ applied: boolean, issues: {repo:string, number:number, labeled:boolean}[] }>}
 */
export async function applyPrOpenedTransition(config, adapter, prEvent) {
  if (prEvent?.type !== 'pr') {
    return { applied: false, issues: [] };
  }
  const meta = prEvent.metadata ?? {};
  if (meta.merged || !meta.draft) {
    return { applied: false, issues: [] };
  }

  return _applyLinkedIssueStatus(config, adapter, prEvent, IN_PROGRESS_STATUS_VALUE, [
    IN_REVIEW_STATUS_VALUE,
    AWAITING_RELEASE_STATUS_VALUE,
    'released',
  ]);
}

/**
 * Apply the `in-review` transition to every issue a non-draft, unmerged,
 * linked PR closes.
 *
 * Webhook delivery fires this on the exact `ready_for_review` action, or on
 * `opened` when a PR is created directly as non-draft (no separate
 * `ready_for_review` event fires in that case — GitHub only sends it when a
 * PR *transitions* out of draft, so a PR that was never a draft must reach
 * `in-review` via its `opened` delivery instead). Poll-path callers have no
 * such edge signal at all — this function is safe to call unconditionally on
 * any open, non-draft, unmerged PR because `_applyLinkedIssueStatus` is
 * idempotent and mutually exclusive with `applyPrOpenedTransition` by draft
 * state.
 *
 * A draft PR is excluded — draft status means work has not yet reached
 * review; `applyPrOpenedTransition` owns that case. A merged PR is handled
 * entirely by `applyMergeTransition`.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement get_pr_closing_issues,
 *   get_item_labels, label_item, unlabel_item)
 * @param {object} prEvent - Normalized Event (type='pr')
 * @returns {Promise<{ applied: boolean, issues: {repo:string, number:number, labeled:boolean}[] }>}
 */
export async function applyPrReadyForReviewTransition(config, adapter, prEvent) {
  if (prEvent?.type !== 'pr') {
    return { applied: false, issues: [] };
  }
  const meta = prEvent.metadata ?? {};
  if (meta.merged || meta.draft) {
    return { applied: false, issues: [] };
  }

  return _applyLinkedIssueStatus(config, adapter, prEvent, IN_REVIEW_STATUS_VALUE, [
    AWAITING_RELEASE_STATUS_VALUE,
    'released',
  ]);
}

// ---------------------------------------------------------------------------
// Release transition
// ---------------------------------------------------------------------------

/**
 * Apply the terminal `released` transition (+ close if still open) to every
 * issue a published release's notes reference via a closing keyword.
 *
 * Issue resolution source: the release body is parsed for closing-keyword
 * references (`Closes #NN`, `Fixes owner/repo#NN`, etc.) using the same parser
 * T5 built for the cross-repo supplement (`parse_closing_keyword_refs`,
 * src/adapters/github.js). This is a deliberate, named trade-off — see this
 * task's DD entry — rather than an invented commit-range/PR-association query:
 * GitHub's `release` webhook payload carries no PR or commit list, only
 * `tag_name`/`target_commitish`/`body`; resolving the true PR range requires a
 * generic v*-tag detector, which the plan explicitly defers to T8
 * (crew-manifest, private module). Release notes generated by GitHub itself
 * (and by most changelog tooling) already carry `Closes #NN`-shaped references
 * per entry, so this is the same-repo-reliable subset of what T8 will later
 * generalize.
 *
 * Same-repo bare `#N` refs found in the body are treated as authoritative
 * (this repo's own release notes referencing its own issues). Cross-repo
 * `owner/repo#N` refs are also honored here — unlike the merge transition,
 * the release step does not need GitHub's own auto-close semantics (which are
 * same-repo only); it only needs "this release's notes say issue N shipped,"
 * which is a statement the release author can make about any repo.
 *
 * Release-body text is publisher-controlled, not operator-controlled — a
 * malicious or careless release note (e.g. `Fixes some-other-org/some-repo#1`)
 * must not let triage act against a repo the operator never configured it to
 * watch. Every ref (same-repo AND cross-repo) is therefore validated against
 * the configured watch scope (`is_repo_in_watch_scope`, the same
 * `config.source.repos`/`config.source.org` contract `_resolveRepos` enforces
 * elsewhere in the adapter) before any label/close call is made; out-of-scope
 * refs are dropped, never acted on. See docs/DESIGN-DECISIONS.md DD-014.
 *
 * Idempotent per issue: skips relabeling if `released` is already applied,
 * and skips closing if the issue is already closed.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement get_item_labels,
 *   label_item, unlabel_item, close_item_completed). `close_item_completed` is
 *   used rather than `close_item` because a shipped issue must close with
 *   `state_reason: 'completed'`, not `close_item`'s hardcoded `not_planned`
 *   (that reason is correct for the LLM-assessed reject/decline path, not for
 *   "this shipped" — see src/adapters/github.js). It is idempotent on an
 *   already-closed issue (PATCH state=closed is a GitHub no-op), so it is
 *   safe to call unconditionally without a separate "is it open" lookup.
 * @param {object} releaseEvent - Normalized Event (type='release')
 * @returns {Promise<{ applied: boolean, issues: {repo:string, number:number, labeled:boolean, closed:boolean}[] }>}
 */
export async function applyReleaseTransition(config, adapter, releaseEvent) {
  if (releaseEvent?.type !== 'release') {
    return { applied: false, issues: [] };
  }

  const { sameRepoRefs, crossRepoRefs } = parse_closing_keyword_refs(
    releaseEvent.body,
    releaseEvent.repo,
  );
  const refs = [...sameRepoRefs, ...crossRepoRefs].filter((ref) =>
    is_repo_in_watch_scope(config, `${ref.owner}/${ref.repo}`),
  );

  const statusLabel = _statusLabel(config, RELEASED_STATUS_VALUE);
  const issues = [];

  for (const ref of refs) {
    const targetRepo = `${ref.owner}/${ref.repo}`;
    const targetEvent = { repo: targetRepo, number: ref.number, type: 'issue' };

    const labeled = await _applyStatusLabel(config, adapter, targetEvent, statusLabel);
    await adapter.close_item_completed(config, targetEvent);

    issues.push({ repo: targetRepo, number: ref.number, labeled, closed: true });
  }

  return { applied: refs.length > 0, issues };
}

// ---------------------------------------------------------------------------
// Lifecycle cycle runner with rate-limit backoff (lr-b3a052)
// ---------------------------------------------------------------------------

/**
 * Parse a `(Retry-After: Ns)` / `(resets in Ns)` hint appended by the
 * adapter's rate-limit error messages (src/adapters/github.js's
 * `_rateLimitHint`) into a millisecond duration.
 *
 * Adapter-agnostic by design: any adapter's rate-limited AdapterError can opt
 * into a precise backoff by appending one of these two hint shapes to its
 * message; an adapter that does not is still covered by
 * DEFAULT_RATE_LIMIT_BACKOFF_MS.
 *
 * @param {string} message
 * @returns {number|null} milliseconds, or null if no hint was found
 */
function _parseBackoffHintMs(message) {
  const retryAfterMatch = /Retry-After:\s*(\d+)s/.exec(message ?? '');
  if (retryAfterMatch) {
    return parseInt(retryAfterMatch[1], 10) * 1000;
  }
  const resetsInMatch = /resets in (\d+)s/.exec(message ?? '');
  if (resetsInMatch) {
    return parseInt(resetsInMatch[1], 10) * 1000;
  }
  return null;
}

/**
 * Create a fresh rate-limit backoff state object for a lifecycle poll loop.
 * Callers (cli.js's cmdWatch/cmdRun) own one instance for the process
 * lifetime and pass it into every `runLifecycleCycle` call so a rate-limit
 * hit in one cycle suppresses further GraphQL calls across *subsequent*
 * cycles too — not just the remainder of the cycle that hit it.
 *
 * Also carries `seenOpenPrs` (repo#number -> last-processed updated_at), the
 * call-volume-reduction half of lr-b3a052: an open PR whose `updated_at` has
 * not changed since the last cycle that already routed it gets no fresh
 * `get_pr_closing_issues` GraphQL call — nothing on GitHub could have changed
 * its closing-issue set or draft state since then, so re-querying is pure
 * budget waste. Bounded by GitHub's own open-PR count per repo; entries are
 * never actively evicted for a still-open PR (re-querying resumes the moment
 * `updated_at` changes, e.g. a new commit, comment, or review), and a
 * PR that merges/closes leaves list_open_prs's result set entirely, so its
 * entry simply stops being read (harmless if a caller cared enough to
 * evict it, but not required for correctness).
 *
 * @returns {{ backoffUntilMs: number, seenOpenPrs: Map<string, string> }}
 */
export function createLifecycleBackoffState() {
  return { backoffUntilMs: 0, seenOpenPrs: new Map() };
}

/**
 * Run one lifecycle poll cycle: route every merged PR / release / open PR
 * event through `routeEvent`-equivalent dispatch, with cross-cycle rate-limit
 * backoff (lr-b3a052).
 *
 * Root cause this addresses: `get_pr_closing_issues` (GraphQL) was called
 * once per open PR, every poll cycle, unconditionally and forever for as
 * long as a PR stayed open (list_open_prs has no `since` filter by design —
 * every still-open PR is safe-but-costly to re-observe every cycle). Once
 * the installation's GraphQL budget was exhausted, each subsequent cycle
 * immediately retried the same calls with no memory of the failure,
 * re-asserting exhaustion every reset window — a self-sustaining retry storm
 * layered on top of whatever real-traffic load contributed to the first
 * exhaustion.
 *
 * `state.backoffUntilMs` persists across calls (caller passes the same state
 * object every cycle): once any event in a cycle throws a `rate_limited`
 * AdapterError, this function stops routing further events for the *rest of
 * that cycle* (avoids burning remaining budget on calls that will also fail)
 * and skips routing entirely on every subsequent call until the backoff
 * window elapses, honoring the reset/Retry-After hint parsed from the error
 * message when present, else a conservative 1-hour default.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement list_lifecycle_events
 *   and everything routeFn's transitions require)
 * @param {(config: object, event: object, adapter: object) => Promise<object>} routeFn
 *   - event router (cli.js's `routeEvent`); injected rather than imported to
 *     avoid a lifecycle.js -> cli.js import (cli.js already imports
 *     lifecycle.js — a reverse import would cycle).
 * @param {{ backoffUntilMs: number, seenOpenPrs: Map<string,string> }} state
 *   - mutable backoff + dedup state, one instance per process, shared across
 *     calls (see createLifecycleBackoffState)
 * @returns {Promise<{
 *   merged_prs: number, releases: number, open_prs: number,
 *   open_prs_skipped_unchanged: number, applied: number,
 *   skipped_backoff: boolean, rate_limited: boolean,
 * }>}
 */
export async function runLifecycleCycle(config, adapter, routeFn, state) {
  const now = Date.now();
  if (now < state.backoffUntilMs) {
    return {
      merged_prs: 0,
      releases: 0,
      open_prs: 0,
      open_prs_skipped_unchanged: 0,
      applied: 0,
      skipped_backoff: true,
      rate_limited: false,
    };
  }

  const { mergedPrs, releases, openPrs = [] } = await adapter.list_lifecycle_events(config);

  // Call-volume reduction (lr-b3a052): drop open PRs already routed at their
  // current updated_at — see createLifecycleBackoffState's docblock. Merged
  // PRs and releases are not deduped here: list_merged_prs/list_releases
  // already bound their own result sets (since-filter / small per-repo
  // count), and applyMergeTransition/applyReleaseTransition are one-shot by
  // nature (a PR merges once), so they carry none of open PRs' "same item,
  // every cycle, forever" cost.
  const dedupedOpenPrs = openPrs.filter((event) => {
    const key = `${event.repo}#${event.number}`;
    const lastSeenUpdatedAt = state.seenOpenPrs.get(key);
    return lastSeenUpdatedAt !== event.metadata?.updated_at;
  });
  const skippedUnchangedCount = openPrs.length - dedupedOpenPrs.length;

  let appliedCount = 0;
  let rateLimited = false;

  for (const event of [...mergedPrs, ...releases, ...dedupedOpenPrs]) {
    try {
      const result = await routeFn(config, event, adapter);
      if (result.applied) {
        appliedCount += 1;
      }
      if (event.type === 'pr' && openPrs.includes(event)) {
        state.seenOpenPrs.set(`${event.repo}#${event.number}`, event.metadata?.updated_at);
      }
    } catch (e) {
      if (e?.code === 'rate_limited') {
        const hintMs = _parseBackoffHintMs(e.message);
        state.backoffUntilMs = Date.now() + (hintMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);
        rateLimited = true;
        break; // stop burning remaining budget on calls that will also fail
      }
      throw e;
    }
  }

  return {
    merged_prs: mergedPrs.length,
    releases: releases.length,
    open_prs: openPrs.length,
    open_prs_skipped_unchanged: skippedUnchangedCount,
    applied: appliedCount,
    skipped_backoff: false,
    rate_limited: rateLimited,
  };
}
