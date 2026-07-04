/**
 * Issue-lifecycle transitions driven by PR-merge and release/tag events (T6, lr-d557).
 *
 * These transitions are deterministic label/close operations, not LLM assessments —
 * a merged PR or a published release is a fact, not something to triage. This module
 * therefore never imports enrich/assess (src/enricher.js, src/assessor.js); callers
 * (src/cli.js) branch on `event.type` before the pipeline so `pull_request`-merge and
 * `release` events never reach the LLM-assessment path (docs/ADAPTERS.md, DD-013 for
 * the analogous release_notify.js precedent).
 *
 * Two transitions, kept in one module because they share the same closing-issue
 * resolution and single-status-invariant machinery, and because the #1 rule for
 * released tools is that they must never be conflated:
 *
 *   applyMergeTransition   — PR merged to the repo's default branch
 *                             -> status/awaiting-release on each linked issue.
 *   applyReleaseTransition — release/tag published
 *                             -> released on each linked issue (+ close if open).
 *
 * awaiting-release != released: a merge-close must NOT masquerade as shipped. Only a
 * published release/tag may apply the terminal `released` label; merge only ever
 * applies `awaiting-release`. See docs/DESIGN-DECISIONS.md (this task's DD entry).
 */

import { enforceSingleStatus } from './labels.js';
import { parse_closing_keyword_refs } from './adapters/github.js';

/** The status/* value applied when a PR merges to the default branch. */
const AWAITING_RELEASE_STATUS_VALUE = 'awaiting-release';

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
  const refs = [...sameRepoRefs, ...crossRepoRefs];

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
