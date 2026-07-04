/**
 * Router for clagentic:triage.
 *
 * Maps an Assessment verdict + action class to a dispatch decision.
 * Implements the HITL gate defined in DD-001:
 *   - confidence below threshold always queues (overrides auto_approve)
 *   - action class in auto_approve dispatches immediately
 *   - everything else queues for human review
 */

/**
 * Determine whether an assessed event should be dispatched immediately or
 * queued for human review.
 *
 * Rules applied in order (DD-001):
 *   1. confidence < config.confidence_threshold → queue with 'low_confidence'
 *   2. every class in suggested_action.classes is in config.auto_approve → dispatch
 *   3. default → queue with 'awaiting_approval'
 *
 * T7 (lr-f0f2) — multi-action verdicts: suggested_action.classes is an array.
 * Named trade-off: auto-approve requires ALL named classes to be individually
 * opted into config.auto_approve, not just one of them. A verdict naming
 * ['respond', 'close'] must not dispatch automatically just because 'respond'
 * is auto-approved while 'close' is not — that would silently auto-execute an
 * action class the operator never opted into. This preserves DD-001's
 * per-action-class HITL contract under multi-action verdicts: a mixed verdict
 * queues for human review unless every one of its classes is trusted.
 * Backward-compat: suggested_action.class (singular string) from an
 * unmigrated caller is treated as a one-element classes array.
 *
 * @param {object} config     - Loaded config (must have confidence_threshold, auto_approve)
 * @param {object} assessment - Assessment object from src/assessor.js
 * @returns {{ should_dispatch: boolean, queue_reason: string | null }}
 */
export function route(config, assessment) {
  const threshold =
    typeof config.confidence_threshold === 'number' ? config.confidence_threshold : 0.7;
  const autoApprove = Array.isArray(config.auto_approve) ? config.auto_approve : [];
  const suggestedAction = assessment?.suggested_action ?? {};
  const actionClasses = Array.isArray(suggestedAction.classes)
    ? suggestedAction.classes
    : typeof suggestedAction.class === 'string'
      ? [suggestedAction.class]
      : [];
  const confidence = typeof assessment?.confidence === 'number' ? assessment.confidence : 0;

  // Rule 1: low confidence always queues — cannot be overridden by auto_approve.
  if (confidence < threshold) {
    return { should_dispatch: false, queue_reason: 'low_confidence' };
  }

  // Rule 2: every named action class must be individually opted into
  // auto-approve for the whole verdict to dispatch automatically.
  if (actionClasses.length > 0 && actionClasses.every((c) => autoApprove.includes(c))) {
    return { should_dispatch: true, queue_reason: null };
  }

  // Rule 3: default HITL.
  return { should_dispatch: false, queue_reason: 'awaiting_approval' };
}
