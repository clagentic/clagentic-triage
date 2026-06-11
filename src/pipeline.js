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

// ---------------------------------------------------------------------------
// Dispatch execution
// ---------------------------------------------------------------------------

/**
 * Execute the action described by an auto-approved Assessment via the adapter.
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
 * @returns {Promise<{ action_taken: string | null, queue_reason: string | null, dispatch_results: Array|null }>}
 *   action_taken is the action class that was executed, or null if deferred to queue.
 *   queue_reason is set for 'dispatch' and 'escalate' classes.
 *   dispatch_results is set when the action class is 'dispatch' — per-dispatcher outcomes.
 */
async function _executeAction(config, event, assessment, adapter) {
  const actionClass = assessment.suggested_action.class;
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
      return { action_taken: null, queue_reason: 'dispatch', dispatch_results: dispatchResults };
    }

    case 'escalate':
      return { action_taken: null, queue_reason: 'escalate', dispatch_results: null };

    default:
      // Unknown action class — treat as escalate.
      return { action_taken: null, queue_reason: 'escalate', dispatch_results: null };
  }
}

// ---------------------------------------------------------------------------
// Label application
// ---------------------------------------------------------------------------

/**
 * Apply labels to an event if the assessment includes labels and the relevant
 * label config is satisfied.
 *
 * Labels are applied on auto-approved items unconditionally.
 * Labels are applied on queued items only when config.auto_label is true.
 *
 * @param {object} config
 * @param {object} event
 * @param {object} assessment
 * @param {object} adapter
 * @param {'dispatched'|'queued'} resultStatus
 * @returns {Promise<void>}
 */
async function _applyLabels(config, event, assessment, adapter, resultStatus) {
  const labels = assessment.suggested_action?.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    return;
  }

  // For queued items, only label if auto_label is explicitly enabled.
  if (resultStatus === 'queued' && !config.auto_label) {
    return;
  }

  await adapter.label_item(config, event, labels);
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
        queue_reason,
        dispatch_results: null,
        dispatched_at: null,
        error: null,
      };
    }

    // Stage 4: Dispatch — execute the adapter action.
    // Pass enrichedEvent so dispatchers receive the full context block.
    const { action_taken, queue_reason: deferredQueueReason, dispatch_results } = await _executeAction(
      config,
      enrichedEvent,
      assessment,
      adapter,
    );

    // 'dispatch' and 'escalate' classes always land in the pending queue even
    // when they are in auto_approve — _executeAction returns no action_taken.
    // For 'dispatch', _executeAction already fired the dispatchers; the queue
    // entry records the per-dispatcher outcomes via dispatch_results.
    if (action_taken === null) {
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
        action_taken: null,
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
      action_taken,
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

  // Build a set of event IDs that already have a pending queue entry so we
  // don't re-assess the same issue/PR on every poll cycle while it awaits
  // human review. Resolved items (approved/rejected) are not excluded — a
  // re-opened issue could legitimately be re-assessed.
  const pendingEventIds = new Set();
  try {
    const existing = await readAll(config);
    for (const item of existing) {
      if (item.status === 'pending' && item.event?.id) {
        pendingEventIds.add(item.event.id);
      }
    }
  } catch {
    // readAll never throws, but guard defensively — dedup is best-effort.
  }

  for (const event of events) {
    if (pendingEventIds.has(event.id)) {
      continue; // already awaiting human review; skip re-assessment
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
