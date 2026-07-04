/**
 * needs-info idle auto-close (T10, lr-9e35).
 *
 * Modeled on GitHub's own `actions/stale` defaults: after N days of no
 * activity on an issue marked `status/needs-info`, post a warning comment;
 * after M further idle days with no update, close the issue. Config-driven
 * thresholds (`config.stale.needs_info_days` / `close_after_days`, default
 * 60/7 to match `actions/stale`'s own defaults) — no hardcoded org, repo, or
 * username per project convention (CLAUDE.md).
 *
 * This is a deterministic idle-time sweep, not an LLM assessment — it never
 * imports src/enricher.js or src/assessor.js, matching src/lifecycle.js's
 * precedent for the other deterministic transitions in this codebase.
 *
 * Exempt labels (`config.stale.exempt_labels`) let an operator mark specific
 * issues as immune to the sweep (e.g. a `pinned` or `help-wanted` label),
 * mirroring `actions/stale`'s own `exempt-issue-labels` option.
 */

import { resolveVocabulary } from './labels.js';

const NEEDS_INFO_VALUE = 'needs-info';

/** Sentinel marker embedded in the warning comment so a repeat sweep can tell
 * whether the warning has already been posted for the *current* needs-info
 * idle window, without a separate persisted-state store (mirrors the
 * idempotency pattern src/lifecycle.js's transitions already use — derive
 * state from live GitHub data, not a parallel side-index). */
const STALE_WARNING_MARKER = '<!-- clagentic-triage:stale-warning -->';

/**
 * Render a comment template, substituting `{days}` / `{close_after_days}`
 * placeholders. Unknown placeholders are left as-is (defensive — a typo'd
 * template should not crash the sweep).
 *
 * @param {string} template
 * @param {{ days: number, close_after_days: number }} vars
 * @returns {string}
 */
function _renderTemplate(template, vars) {
  return template
    .replace(/\{days\}/g, String(vars.days))
    .replace(/\{close_after_days\}/g, String(vars.close_after_days));
}

/**
 * Return true if `labels` contains any of the operator's configured exempt
 * labels — an exempt issue is skipped entirely by the sweep.
 *
 * @param {string[]} labels
 * @param {string[]} exemptLabels
 * @returns {boolean}
 */
function _isExempt(labels, exemptLabels) {
  return labels.some((l) => exemptLabels.includes(l));
}

/**
 * Return the number of whole days between `isoTimestamp` and now.
 *
 * @param {string} isoTimestamp
 * @returns {number}
 */
function _daysSince(isoTimestamp) {
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) {
    return 0;
  }
  const now = Date.now();
  return Math.floor((now - then) / (24 * 60 * 60 * 1000));
}

/**
 * Sweep every open issue carrying `status/needs-info` and apply the idle
 * warning/close transitions.
 *
 * Two-stage, matching `actions/stale`:
 *   1. Idle >= `needs_info_days` and not yet warned this window -> post the
 *      warning comment (idempotent: checks existing comments for the marker
 *      before posting again).
 *   2. Idle >= `needs_info_days + close_after_days` -> close the issue
 *      (`close_item`, `not_planned` reason — this is a decline-by-inactivity,
 *      the same semantic as the LLM-assessed `close` action class).
 *
 * A no-op entirely when `config.stale.enabled` is false (default) — this is
 * an opt-in feature, matching every other auto-action in this codebase
 * (DD-001's HITL-by-default posture).
 *
 * Idle time is measured from the issue's `updated_at` (last GitHub-recorded
 * activity — comments, label changes, edits). This is a deliberate,
 * conservative choice: `actions/stale` also treats any comment as activity
 * that resets its own idle clock, and `updated_at` is the field GitHub itself
 * maintains for exactly that purpose — no need to enumerate comments to
 * derive it.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement list_issues_by_label,
 *   get_item_labels, list_comments, post_comment, close_item)
 * @returns {Promise<{ checked: number, warned: number, closed: number }>}
 */
export async function checkStaleNeedsInfo(config, adapter) {
  const staleConfig = config.stale ?? {};
  if (!staleConfig.enabled) {
    return { checked: 0, warned: 0, closed: 0 };
  }

  const needsInfoDays = staleConfig.needs_info_days ?? 60;
  const closeAfterDays = staleConfig.close_after_days ?? 7;
  const exemptLabels = staleConfig.exempt_labels ?? [];

  const vocabulary = resolveVocabulary(config);
  const needsInfoLabel = `${vocabulary.status_namespace}/${NEEDS_INFO_VALUE}`;

  const issues = await adapter.list_issues_by_label(config, needsInfoLabel);

  let checked = 0;
  let warned = 0;
  let closed = 0;

  for (const issue of issues) {
    checked += 1;

    const labels = issue.metadata?.labels ?? [];
    if (_isExempt(labels, exemptLabels)) {
      continue;
    }

    const idleDays = _daysSince(issue.metadata?.updated_at ?? issue.created_at);

    if (idleDays < needsInfoDays) {
      continue; // not idle long enough yet
    }

    if (idleDays >= needsInfoDays + closeAfterDays) {
      // Post the close-reason comment before closing (matches actions/stale's
      // own behavior of explaining why the issue closed) — best-effort: a
      // comment failure must not block the close itself, so it is not
      // awaited-and-thrown; log and proceed.
      try {
        await adapter.post_comment(config, issue, staleConfig.close_comment_template);
      } catch (commentErr) {
        console.warn(`[stale] close comment failed for ${issue.repo}#${issue.number}: ${commentErr.message}`);
      }
      await adapter.close_item(config, issue);
      closed += 1;
      continue;
    }

    // In the warning window: post the warning comment once per idle window.
    // Idempotency check: scan existing comments for the marker rather than a
    // separate persisted-state store (same "derive from live GitHub state"
    // principle src/queue.js's getLifecycleState already established).
    const comments = await adapter.list_comments(config, issue);
    const alreadyWarned = comments.some((c) => (c.body ?? '').includes(STALE_WARNING_MARKER));
    if (alreadyWarned) {
      continue;
    }

    const body =
      _renderTemplate(staleConfig.stale_comment_template, { days: idleDays, close_after_days: closeAfterDays }) +
      `\n\n${STALE_WARNING_MARKER}`;
    await adapter.post_comment(config, issue, body);
    warned += 1;
  }

  return { checked, warned, closed };
}
