/**
 * Pipeline orchestrator for clagentic:triage.
 *
 * Runs the full event → enrich → assess → route → approval gate → dispatch
 * pipeline (ARCHITECTURE.md). Two entry points:
 *
 *   processEvent(config, event, adapter)  — single event; never throws
 *   runPipeline(config, events, adapter)  — batch; collects results + errors
 *
 * Design decisions respected:
 *   DD-001: HITL gate; confidence threshold; auto_approve opt-in per action class
 */

import { enrich } from './enricher.js';
import { assess } from './assessor.js';
import { preFilter, noiseAssessment } from './assessors/pre_filter.js';
import { route } from './router.js';
import { enqueue, readAll } from './queue.js';
import { dispatch } from './dispatchers/index.js';
import { runHooks } from './hooks/index.js';
import { recordTask } from './task_index.js';
import { enforceSingleStatus, resolveVocabulary, isStatusLabel } from './labels.js';

// ---------------------------------------------------------------------------
// Single-action execution (T7, lr-f0f2: extracted so classes[] can loop it)
// ---------------------------------------------------------------------------

/**
 * Execute exactly one action class described by an auto-approved Assessment
 * via the adapter.
 *
 * Dispatch map (per task spec):
 *   'respond'          → adapter.post_comment(config, event, body)
 *   'request_changes'  → adapter.request_changes(config, event, body)
 *   'approve'          → adapter.approve_pr(config, event)
 *   'close'            → adapter.close_item(config, event)
 *   'dispatch'         → no adapter call; treated as pending-queue item
 *   'escalate'         → no adapter call; treated as pending-queue item
 *
 * @param {object} config
 * @param {object} event       - Normalized Event
 * @param {object} assessment  - Assessment from assessor
 * @param {object} adapter     - Source adapter
 * @param {string} actionClass - Single action class to execute
 * @returns {Promise<{ action_taken: string | null, queue_reason: string | null, dispatch_results: Array|null }>}
 *   action_taken is the action class that was executed, or null if deferred to queue.
 *   queue_reason is set for 'dispatch' and 'escalate' classes.
 *   dispatch_results is set when the action class is 'dispatch' — per-dispatcher outcomes.
 */
async function _executeSingleAction(config, event, assessment, adapter, actionClass) {
  const body = assessment.suggested_action.body ?? '';

  switch (actionClass) {
    case 'respond':
      await adapter.post_comment(config, event, body);
      return { action_taken: 'respond', queue_reason: null, dispatch_results: null };

    case 'request_changes':
      await adapter.request_changes(config, event, body);
      return { action_taken: 'request_changes', queue_reason: null, dispatch_results: null };

    case 'approve':
      await adapter.approve_pr(config, event);
      return { action_taken: 'approve', queue_reason: null, dispatch_results: null };

    case 'close':
      await adapter.close_item(config, event);
      return { action_taken: 'close', queue_reason: null, dispatch_results: null };

    case 'dispatch': {
      // Fire all configured dispatchers. dispatch() handles per-dispatcher errors
      // internally and never throws — failures are captured in the returned array.
      const dispatchResults = await dispatch(config, event, assessment);

      // Record each successful dispatcher's task_id -> origin mapping in the
      // durable side-index (src/task_index.js) so an inbound status-callback
      // (T3, lr-f848) can resolve "which issue does task X belong to" after
      // dispatch_results has scrolled out of the one-time queue entry. Recording
      // failures are non-fatal — the dispatch itself already succeeded.
      for (const entry of dispatchResults) {
        const taskId = entry.result?.id;
        if (!taskId) {
          continue; // dispatcher errored, or returned no id — nothing to index
        }
        try {
          await recordTask(config, {
            dispatcher: entry.name,
            task_id: taskId,
            task_url: entry.result?.url ?? null,
            event_id: event.id,
            repo: event.repo,
            number: event.number,
            event_url: event.url,
          });
        } catch (indexErr) {
          console.warn(`[pipeline] recordTask failed for dispatcher "${entry.name}": ${indexErr.message}`);
        }
      }

      return { action_taken: null, queue_reason: 'dispatch', dispatch_results: dispatchResults };
    }

    case 'escalate':
      return { action_taken: null, queue_reason: 'escalate', dispatch_results: null };

    default:
      // Unknown action class — treat as escalate.
      return { action_taken: null, queue_reason: 'escalate', dispatch_results: null };
  }
}

/**
 * Execute every action class named by an auto-approved Assessment, in order,
 * via the adapter (T7, lr-f0f2 — multi-action verdicts).
 *
 * A single verdict may name more than one class (e.g. ['respond', 'dispatch'])
 * so a comment, a status transition, and a link can be applied atomically for
 * one triage decision. Classes execute serially in the order the LLM listed
 * them — 'respond' before 'close' is the natural order for "comment then
 * close," and the LLM is instructed (assessor.js) not to pad the list, so
 * ordering is meaningful.
 *
 * 'dispatch' and 'escalate' both defer to the pending queue (no adapter call
 * beyond dispatch()'s own dispatcher fan-out) — if either appears alongside
 * an executable class (e.g. ['respond', 'dispatch']), the executable classes
 * still run immediately and the item is additionally queued for the
 * dispatch/escalate portion. The first queue_reason encountered wins if both
 * 'dispatch' and 'escalate' are somehow both present (LLM should never emit
 * both, but this is defensive rather than a hard failure).
 *
 * @param {object} config
 * @param {object} event       - Normalized Event
 * @param {object} assessment  - Assessment from assessor (suggested_action.classes[])
 * @param {object} adapter     - Source adapter
 * @returns {Promise<{ actions_taken: string[], queue_reason: string | null, dispatch_results: Array|null }>}
 *   actions_taken lists every class that executed an adapter action immediately.
 *   queue_reason is set if any class ('dispatch' or 'escalate') deferred to the queue.
 *   dispatch_results is set when 'dispatch' was among the classes.
 */
// Exported for direct unit testing only (tests/pipeline.test.js) — the module's
// public API surface for actual callers remains processEvent/runPipeline.
// Node's built-in test runner has no stable import-mock hook (see the
// hand-rolled shim this replaces for multi-action/label coverage), so testing
// these two functions directly against a spy adapter is more reliable than
// re-deriving their logic a second time in test-only code that can drift.
export async function _executeAction(config, event, assessment, adapter) {
  const suggestedAction = assessment.suggested_action ?? {};
  const classes = Array.isArray(suggestedAction.classes)
    ? suggestedAction.classes
    : typeof suggestedAction.class === 'string'
      ? [suggestedAction.class]
      : [];

  const actionsTaken = [];
  let queueReason = null;
  let dispatchResults = null;

  for (const actionClass of classes) {
    const result = await _executeSingleAction(config, event, assessment, adapter, actionClass);
    if (result.action_taken !== null) {
      actionsTaken.push(result.action_taken);
    }
    if (result.queue_reason !== null && queueReason === null) {
      queueReason = result.queue_reason;
    }
    if (result.dispatch_results !== null) {
      dispatchResults = result.dispatch_results;
    }
  }

  return { actions_taken: actionsTaken, queue_reason: queueReason, dispatch_results: dispatchResults };
}

// ---------------------------------------------------------------------------
// Label application (single-status invariant, T7 lr-f0f2 / T2 lr-a192)
// ---------------------------------------------------------------------------

/**
 * Split a namespaced label into its axis name (the part before "/"), or null
 * for an unnamespaced label (e.g. a not_planned closure label).
 *
 * @param {string} label
 * @returns {string|null}
 */
function _axisOf(label) {
  const idx = label.indexOf('/');
  return idx === -1 ? null : label.slice(0, idx);
}

/**
 * Filter intake-suggestion labels (kind/*, priority/*, area/*, and any other
 * orthogonal axis — never status/*) down to only those axes the operator has
 * explicitly trusted via `config.label_auto_approve` (T10, lr-9e35).
 *
 * This is a per-axis trust gate, separate from and in addition to the
 * existing `resultStatus`/`config.auto_label` gate below: an operator may
 * trust `kind` suggestions (low blast radius — a wrong kind label is
 * cosmetic) while still holding `area` or `priority` suggestions for human
 * review. Per DD-001's posture, an axis absent from `label_auto_approve`
 * (the default: empty) is never auto-applied — the intake suggestion still
 * reaches the assessment/queue record for a human to apply manually via
 * `clagentic-triage review`/`approve`.
 *
 * status/* labels are exempt from this gate — they are not intake
 * suggestions, and their own trust boundary is the existing dispatched/
 * queued+auto_label gate in `_applyLabels`, unchanged by this filter.
 *
 * @param {object} config
 * @param {string[]} labels
 * @returns {string[]} labels whose axis is trusted, plus every status/* label
 *   (status labels are never filtered here)
 */
function _filterTrustedAxisLabels(config, labels) {
  const vocabulary = resolveVocabulary(config);
  const trustedAxes = Array.isArray(config.label_auto_approve) ? config.label_auto_approve : [];

  return labels.filter((label) => {
    if (isStatusLabel(label, vocabulary)) {
      return true; // status/* is gated elsewhere, not here.
    }
    const axis = _axisOf(label);
    if (axis === null) {
      // Unnamespaced label (e.g. a not_planned closure label like "wontfix") —
      // treated as always-trusted, matching pre-T10 behavior for these labels.
      return true;
    }
    return trustedAxes.includes(axis);
  });
}

/**
 * Apply labels to an event if the assessment includes labels and the relevant
 * label config is satisfied — enforcing the single-status invariant (exactly
 * one status/* label present after any transition, DD-012/T2) along the way.
 *
 * Labels are applied on auto-approved items unconditionally.
 * Labels are applied on queued items only when config.auto_label is true.
 *
 * Independent of the above (T10, lr-9e35): non-status intake-suggestion
 * labels (kind/*, priority/*, area/*) are further filtered down to only the
 * axes the operator has trusted via `config.label_auto_approve` — see
 * `_filterTrustedAxisLabels`. This applies to BOTH the dispatched and
 * auto_label-gated-queued paths; an untrusted axis is never auto-applied
 * regardless of the item's dispatch status, matching the task's explicit
 * "HITL until trusted per class" requirement. The full, untrusted label set
 * remains visible in `assessment.suggested_action.labels` on the queue
 * record for a human to apply manually.
 *
 * When the incoming labels include a status/* value, the item's live label
 * set is fetched (adapter.get_item_labels) and any other status/* label
 * currently present is removed (adapter.unlabel_item) BEFORE the new label is
 * applied — never the reverse order, so the item is never observed carrying
 * two status/* labels at once. Non-status labels (kind/*, priority/*, area/*)
 * pass through unaffected; enforceSingleStatus (src/labels.js) never touches
 * them.
 *
 * @param {object} config
 * @param {object} event
 * @param {object} assessment
 * @param {object} adapter
 * @param {'dispatched'|'queued'} resultStatus
 * @returns {Promise<void>}
 */
export async function _applyLabels(config, event, assessment, adapter, resultStatus) {
  const suggestedLabels = assessment.suggested_action?.labels;
  if (!Array.isArray(suggestedLabels) || suggestedLabels.length === 0) {
    return;
  }

  // For queued items, only label if auto_label is explicitly enabled.
  if (resultStatus === 'queued' && !config.auto_label) {
    return;
  }

  const labels = _filterTrustedAxisLabels(config, suggestedLabels);
  if (labels.length === 0) {
    return;
  }

  const currentLabels = await adapter.get_item_labels(config, event);
  const { toRemove, toApply } = enforceSingleStatus(config, currentLabels, labels);

  for (const label of toRemove) {
    await adapter.unlabel_item(config, event, label);
  }
  if (toApply.length > 0) {
    await adapter.label_item(config, event, toApply);
  }
}

// ---------------------------------------------------------------------------
// Single-event processing
// ---------------------------------------------------------------------------

/**
 * Process a single event through the full pipeline.
 *
 * Never throws — all errors are captured as PipelineResult with status='error'.
 *
 * @param {object} config
 * @param {object} event    - Normalized Event from adapter
 * @param {object} adapter  - Source adapter
 * @returns {Promise<object>} PipelineResult
 */
export async function processEvent(config, event, adapter) {
  const eventId = event?.id ?? '(unknown)';

  try {
    // Stage 1: Enrich
    const enrichedEvent = await enrich(config, event, adapter);

    // Stage 1.5: Pre-filter (tier-1 cheap noise check, optional)
    // Failures inside preFilter() degrade to pass-through — no extra handling needed here.
    let assessment;
    if (config.pre_filter?.enabled) {
      const pfResult = await preFilter(config, enrichedEvent);
      if (pfResult.noise === true) {
        console.log(`[pipeline] pre-filter: noise detected — skipping main assessor (event=${eventId})`);
        assessment = noiseAssessment(enrichedEvent, pfResult);
      }
    }

    // Stage 2: Assess (skipped when pre-filter already produced an assessment)
    if (!assessment) {
      assessment = await assess(config, enrichedEvent);
    }

    // Stage 2.5: Run hooks (fire-and-forget; failures are warnings, never fatal)
    try {
      const hookResults = await runHooks(config, enrichedEvent, assessment);
      for (const r of hookResults) {
        if (r.error) {
          console.warn(`[pipeline] hook "${r.name}" failed: ${r.error}`);
        }
      }
    } catch (hookErr) {
      // runHooks itself should never throw, but guard defensively.
      console.warn(`[pipeline] runHooks threw unexpectedly: ${hookErr.message}`);
    }

    // Stage 3: Route — apply HITL gate (DD-001)
    const { should_dispatch, queue_reason } = route(config, assessment);

    if (!should_dispatch) {
      // Queued for human review (or escalate/dispatch that always queue).
      // Still apply labels if auto_label is enabled.
      try {
        await _applyLabels(config, event, assessment, adapter, 'queued');
      } catch (labelErr) {
        // Label failure on a queued item is non-fatal; log and continue.
        console.warn(`[pipeline] label_item failed for event ${eventId}: ${labelErr.message}`);
      }

      try {
        await enqueue(config, { event: enrichedEvent, assessment, queue_reason });
      } catch (queueErr) {
        // Queue write failure is non-fatal; log and continue so the event is
        // still reflected in the returned result.
        console.warn(`[pipeline] enqueue failed for event ${eventId}: ${queueErr.message}`);
      }

      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: null,
        actions_taken: [],
        queue_reason,
        dispatch_results: null,
        dispatched_at: null,
        error: null,
      };
    }

    // Stage 4: Dispatch — execute the adapter action(s).
    // Pass enrichedEvent so dispatchers receive the full context block.
    const { actions_taken, queue_reason: deferredQueueReason, dispatch_results } = await _executeAction(
      config,
      enrichedEvent,
      assessment,
      adapter,
    );

    // 'dispatch' and 'escalate' classes always land in the pending queue even
    // when they are in auto_approve. A multi-action verdict (T7, lr-f0f2) may
    // execute one or more classes immediately (actions_taken non-empty) AND
    // still carry a queue_reason from a 'dispatch'/'escalate' class in the
    // same verdict — the item is queued in that case so the deferred portion
    // is tracked, but the already-executed actions are not undone or re-run.
    if (deferredQueueReason !== null) {
      try {
        await _applyLabels(config, event, assessment, adapter, 'queued');
      } catch (labelErr) {
        console.warn(`[pipeline] label_item failed for event ${eventId}: ${labelErr.message}`);
      }

      try {
        await enqueue(config, { event: enrichedEvent, assessment, queue_reason: deferredQueueReason, dispatch_results });
      } catch (queueErr) {
        console.warn(`[pipeline] enqueue failed for event ${eventId}: ${queueErr.message}`);
      }

      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: actions_taken[0] ?? null,
        actions_taken,
        queue_reason: deferredQueueReason,
        dispatch_results: dispatch_results ?? null,
        dispatched_at: null,
        error: null,
      };
    }

    // Successfully dispatched — apply labels unconditionally.
    try {
      await _applyLabels(config, event, assessment, adapter, 'dispatched');
    } catch (labelErr) {
      console.warn(`[pipeline] label_item failed for event ${eventId}: ${labelErr.message}`);
    }

    return {
      event_id: eventId,
      status: 'dispatched',
      assessment,
      // action_taken is retained for backward compat (first action executed);
      // actions_taken is the full ordered list (T7, lr-f0f2).
      action_taken: actions_taken[0] ?? null,
      actions_taken,
      queue_reason: null,
      dispatch_results: null,
      dispatched_at: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    // Any unrecoverable error from enrich/assess/dispatch becomes a PipelineError result.
    return {
      event_id: eventId,
      status: 'error',
      assessment: null,
      action_taken: null,
      actions_taken: [],
      queue_reason: null,
      dispatch_results: null,
      dispatched_at: null,
      error: err.message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Batch pipeline
// ---------------------------------------------------------------------------

/**
 * Run all events through the full pipeline.
 *
 * Processes each event independently — one bad event never halts the run.
 * Errors are collected in the returned errors array and also appear as
 * PipelineResult entries with status='error' in the appropriate bucket.
 *
 * @param {object}   config
 * @param {object[]} events   - Array of normalized Events from the adapter
 * @param {object}   adapter  - Source adapter
 * @returns {Promise<{ dispatched: object[], queued: object[], errors: object[] }>}
 */
export async function runPipeline(config, events, adapter) {
  const dispatched = [];
  const queued = [];
  const errors = [];

  // Build a set of event IDs to skip on this poll cycle:
  //   - 'pending': awaiting human review; don't re-assess.
  //   - 'approved': action already executed (or queued for execution); don't re-queue.
  // Rejected and overridden items ARE re-assessed — the human explicitly declined,
  // so a re-opened or updated issue should be triaged fresh.
  const skipEventIds = new Set();
  try {
    const existing = await readAll(config);
    for (const item of existing) {
      if ((item.status === 'pending' || item.status === 'approved') && item.event?.id) {
        skipEventIds.add(item.event.id);
      }
    }
  } catch {
    // readAll never throws, but guard defensively — dedup is best-effort.
  }

  for (const event of events) {
    if (skipEventIds.has(event.id)) {
      continue; // already pending or approved; skip re-assessment
    }

    // processEvent never throws — safe to await in a loop.
    const result = await processEvent(config, event, adapter);

    if (result.status === 'dispatched') {
      dispatched.push(result);
    } else if (result.status === 'queued') {
      queued.push(result);
    } else {
      // status === 'error'
      errors.push(result);
    }
  }

  return { dispatched, queued, errors };
}
