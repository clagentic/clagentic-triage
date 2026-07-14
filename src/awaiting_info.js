/**
 * awaiting_info — clarifying-question parking + reply-triggered re-assessment
 * (lr-910ca2).
 *
 * Problem this solves: src/pipeline.js's runPipeline permanently skips
 * re-assessing any event that already has a pending/approved queue entry
 * (lr-bfb0ac dedup). That is correct for the general case, but an item
 * parked specifically because triage asked the reporter a clarifying
 * question never wakes back up once they reply — see
 * clagentic/clagentic-console#328.
 *
 * This module owns two concerns, kept out of src/pipeline.js to avoid
 * growing it into a god file (mirrors src/stale.js and src/release_notify.js,
 * which already extract single-purpose lifecycle concerns the same way):
 *
 *   1. Classifying a queued verdict as `awaiting_info` (a `needs_changes`
 *      verdict — src/llm.js's VALID_VERDICTS enum value for "incomplete,
 *      asked for more info" — carrying a 'respond' class with a
 *      clarifying-question body) rather than the generic `awaiting_approval`.
 *   2. Scanning ONLY `awaiting_info` queue items (never the full open-issue
 *      set — see lr-b3a052, the GraphQL rate-limit blocker this task was
 *      gated on) for a qualifying non-bot reply, and re-running
 *      enrich()/assess() when one is found.
 *
 * Reply-detection signal (lr-2ed0f0): "is there a reply to act on" is
 * determined by LAST-COMMENT AUTHORSHIP, not by comparing a comment's
 * timestamp against the item's own queued_at/awaiting_info_since marker.
 * Marker-timestamp comparison assumes a reply always arrives chronologically
 * after the queue entry exists — false whenever the entry is created or
 * re-created AFTER a reply already sitting in the thread (confirmed live on
 * clagentic/clagentic-console#328: reporter replied 11:41-11:43 UTC, a
 * re-triaged queue entry got queued_at 18:49 UTC during unrelated operator
 * remediation, and the already-posted reply looked "too early" and was
 * skipped — the bot re-asked a question it already had the answer to). Who
 * spoke last in the thread is the correct signal and needs no stored
 * timestamp at all: if the last comment is from a non-bot author, that is
 * the qualifying reply, full stop, regardless of when the queue entry itself
 * was created.
 *
 * Explicit non-goals (per task lr-910ca2 design, locked by andy 2026-07-14):
 *   - No special extra-cautious approval gate for the re-assessed verdict —
 *     it goes back through router.js's normal rules, same as any other event.
 *   - Does not rebuild src/stale.js's idle-close sweep; this is only the
 *     "woke up early because of a reply" path. Whichever fires first (a
 *     reply here, or stale.js's timeout) wins — see processAwaitingInfoItems'
 *     docblock for how the two are kept from double-processing the same item.
 */

import { resolveVocabulary } from './labels.js';
import { enqueue, resolveItem } from './queue.js';
import { route } from './router.js';

/** status/* label value applied when an item enters awaiting_info, matching
 * the vocabulary src/stale.js already reads/writes for the same state. */
const NEEDS_INFO_VALUE = 'needs-info';

// ---------------------------------------------------------------------------
// Classification (used by src/pipeline.js when queuing a new verdict)
// ---------------------------------------------------------------------------

/**
 * Decide whether a queued (non-auto-dispatched) Assessment should be tagged
 * `awaiting_info` rather than the generic `awaiting_approval`.
 *
 * An item qualifies when the verdict is `needs_changes` — src/llm.js's
 * VALID_VERDICTS enum value the assessor already emits for exactly this
 * case: "incomplete, asked for more info, left open" (see every intent
 * file's verdict vocabulary, e.g. "respond asking for the missing
 * information and leave the issue open... Verdict: needs_changes") — AND
 * the suggested_action names 'respond' with a non-empty clarifying-question
 * body (that's what actually posts the question). A `needs_changes` verdict
 * with a respond body IS the clarifying-question case, whether or not a
 * second action class (e.g. 'dispatch') also happens to be present. Any
 * other verdict (e.g. 'accept') with a bare 'respond' is NOT awaiting_info —
 * it is a plain comment with nothing further pending, the generic
 * awaiting_approval case (or would have auto-dispatched if 'respond' alone
 * were trusted).
 *
 * @param {object} assessment - Assessment from src/assessor.js
 * @returns {boolean}
 */
export function isAwaitingInfoVerdict(assessment) {
  const suggestedAction = assessment?.suggested_action ?? {};
  const classes = Array.isArray(suggestedAction.classes)
    ? suggestedAction.classes
    : typeof suggestedAction.class === 'string'
      ? [suggestedAction.class]
      : [];

  const hasRespondWithBody =
    classes.includes('respond') && typeof suggestedAction.body === 'string' && suggestedAction.body.trim().length > 0;

  return assessment?.verdict === 'needs_changes' && hasRespondWithBody;
}

/**
 * Resolve the queue_reason to record for a queued item: `awaiting_info` when
 * the verdict qualifies (see isAwaitingInfoVerdict), else the caller's
 * already-computed default (typically router.js's own queue_reason, e.g.
 * 'awaiting_approval' or 'low_confidence').
 *
 * Low-confidence items are never reclassified — DD-001's confidence gate is
 * a distinct trust boundary from "this item is parked pending a reply", and
 * conflating them would let a low-confidence verdict skip the low_confidence
 * signal a human reviewer relies on.
 *
 * @param {object} assessment
 * @param {string} defaultReason
 * @returns {string}
 */
export function resolveQueueReason(assessment, defaultReason) {
  if (defaultReason === 'low_confidence') {
    return defaultReason;
  }
  return isAwaitingInfoVerdict(assessment) ? 'awaiting_info' : defaultReason;
}

/**
 * Build the needs-info status/* label for the operator's configured
 * vocabulary (same helper shape src/stale.js uses internally, exposed here
 * so src/pipeline.js does not have to re-derive it).
 *
 * @param {object} config
 * @returns {string}
 */
export function needsInfoLabel(config) {
  const vocabulary = resolveVocabulary(config);
  return `${vocabulary.status_namespace}/${NEEDS_INFO_VALUE}`;
}

// ---------------------------------------------------------------------------
// Reply detection + re-assessment (used by src/pipeline.js's runPipeline)
// ---------------------------------------------------------------------------

/**
 * Return true if `comment` was authored by someone other than the triage
 * bot itself. Comments come from adapter.list_comments() as raw provider
 * objects (e.g. GitHub's `{ user: { login, type }, body, created_at }`) —
 * this checks the same bot-detection signal src/adapters/github.js's
 * is_bot_event uses (Bot account type, or a `[bot]`-suffixed login),
 * generalized here since list_comments' raw shape is not a normalized Event.
 *
 * @param {object} comment
 * @returns {boolean}
 */
function _isNonBotComment(comment) {
  const login = comment.user?.login ?? '';
  const type = comment.user?.type ?? '';
  return type !== 'Bot' && !login.endsWith('[bot]');
}

/**
 * Return the last (most recent) comment in a list_comments() result, or null
 * for an empty list. list_comments() returns comments in the provider's
 * natural (chronological, oldest-first) order, matching GitHub's API and the
 * shape every other reader of this call already assumes.
 *
 * @param {object[]} comments
 * @returns {object|null}
 */
function _lastComment(comments) {
  return comments.length > 0 ? comments[comments.length - 1] : null;
}

/**
 * Scan one awaiting_info item's comments for a qualifying reply, using
 * last-comment authorship as the signal (lr-2ed0f0) rather than a
 * timestamp comparison against the item's own queued_at/awaiting_info_since
 * marker — see this module's docblock for why marker comparison is wrong.
 *
 * If the most recent comment in the thread is from a non-bot author (per
 * `_isNonBotComment`), that comment IS the qualifying reply — act on it,
 * regardless of its timestamp relative to when this queue entry was
 * created. If the last comment is the bot's own, or there are no comments
 * at all, there is nothing new to act on and the item falls through
 * unchanged to src/stale.js's idle timeline (same as today's "no reply
 * found" case).
 *
 * Scoped to a single item's list_comments() call — callers are responsible
 * for only invoking this for items already filtered to queue_reason ===
 * 'awaiting_info' (see processAwaitingInfoItems), which is what keeps API
 * volume bounded to the parked subset rather than every open issue (the
 * rate-limit sensitivity this task was gated on lr-b3a052 for).
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement list_comments)
 * @param {object} item    - queue item with queue_reason === 'awaiting_info'
 * @returns {Promise<object|null>} the qualifying comment, or null if none found
 */
export async function findQualifyingReply(config, adapter, item) {
  const comments = await adapter.list_comments(config, item.event);
  const last = _lastComment(comments);

  if (last === null || !_isNonBotComment(last)) {
    return null;
  }
  return last;
}

/**
 * Re-assess one awaiting_info item that received a qualifying reply:
 * re-run enrich()/assess() with the reply folded into context, resolve the
 * stale queue entry as a terminal 'superseded' status, and enqueue the fresh
 * verdict through the exact same route()/enqueue() path any other event
 * uses — no special extra-caution gate (explicit non-goal, task design).
 *
 * The reply is folded in by appending it to the event body before enrich —
 * enrich()/assess() have no separate "conversation" input, and appending
 * keeps this re-assessment indistinguishable, from the assessor's point of
 * view, from an issue whose body always included the requested information.
 *
 * @param {object} config
 * @param {object} adapter - source adapter
 * @param {object} item    - queue item with queue_reason === 'awaiting_info'
 * @param {object} reply   - qualifying comment from findQualifyingReply
 * @param {object} deps
 * @param {(config: object, event: object, adapter: object) => Promise<object>} deps.enrich
 * @param {(config: object, enrichedEvent: object) => Promise<object>} deps.assess
 * @returns {Promise<{ resolved_id: string, new_item: object|null, should_dispatch: boolean }>}
 */
export async function reassessAwaitingInfoItem(config, adapter, item, reply, { enrich, assess }) {
  const replyAuthor = reply.user?.login ?? 'someone';
  const replyBody = reply.body ?? '';
  const eventWithReply = {
    ...item.event,
    body: `${item.event.body ?? ''}\n\n---\nReply from @${replyAuthor}:\n${replyBody}`,
  };

  const enrichedEvent = await enrich(config, eventWithReply, adapter);
  const freshAssessment = await assess(config, enrichedEvent);

  // Resolve the stale entry first — 'superseded' is a terminal, non-pending
  // status (acceptance: "old entry is resolved to a terminal, non-pending
  // status, not left dangling as 'pending'"). If this item was already
  // resolved by a concurrent path (e.g. stale.js's idle-close sweep ran in
  // the same cycle, or a human resolved it manually), resolveItem throws
  // QueueError('already_resolved') — that is the double-processing guard:
  // whichever path resolves the item first wins, and this one backs off
  // without enqueueing a duplicate fresh verdict.
  try {
    await resolveItem(config, item.id, { action: 'superseded' });
  } catch (err) {
    if (err?.code === 'already_resolved') {
      return { resolved_id: item.id, new_item: null, should_dispatch: false };
    }
    throw err;
  }

  const { should_dispatch, queue_reason: defaultReason } = route(config, freshAssessment);
  const queueReason = should_dispatch ? null : resolveQueueReason(freshAssessment, defaultReason);

  let newItem = null;
  if (!should_dispatch) {
    newItem = await enqueue(config, { event: enrichedEvent, assessment: freshAssessment, queue_reason: queueReason });
  }

  return { resolved_id: item.id, new_item: newItem, should_dispatch };
}

/**
 * Scan every currently-pending `awaiting_info` queue item for a qualifying
 * reply and re-assess the ones that have one. Returns the set of event ids
 * that were re-assessed this cycle, so runPipeline can still skip them for
 * the remainder of the SAME poll (the freshly-enqueued item is itself a new
 * pending entry and must not be immediately re-processed by the rest of this
 * cycle's normal skipEventIds logic).
 *
 * Deliberately does not touch any item without a qualifying reply — those
 * fall through untouched to src/stale.js's existing needs_info_days idle
 * sweep, unchanged (explicit non-goal: this only adds the "woke up early"
 * path, never duplicates or races the idle-close timeline).
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement list_comments)
 * @param {object[]} awaitingInfoItems - pending items with queue_reason === 'awaiting_info'
 * @param {object} deps
 * @param {Function} deps.enrich
 * @param {Function} deps.assess
 * @returns {Promise<{ reassessed: object[], errors: object[] }>}
 *   reassessed: results of reassessAwaitingInfoItem for every item with a
 *     qualifying reply; errors: { item_id, error } for any item whose
 *     reply-check or re-assessment threw (never propagates — one bad item
 *     must not halt the poll cycle).
 */
export async function processAwaitingInfoItems(config, adapter, awaitingInfoItems, { enrich, assess }) {
  const reassessed = [];
  const errors = [];

  for (const item of awaitingInfoItems) {
    try {
      const reply = await findQualifyingReply(config, adapter, item);
      if (reply === null) {
        continue; // no reply yet — leave untouched for stale.js's idle timeline
      }
      const result = await reassessAwaitingInfoItem(config, adapter, item, reply, { enrich, assess });
      reassessed.push(result);
    } catch (err) {
      console.warn(`[awaiting_info] re-assessment failed for item ${item.id}: ${err.message}`);
      errors.push({ item_id: item.id, error: err.message ?? String(err) });
    }
  }

  return { reassessed, errors };
}
