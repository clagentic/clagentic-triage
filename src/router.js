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
 *   2. suggested_action.class in config.auto_approve → dispatch
 *   3. default → queue with 'awaiting_approval'
 *
 * @param {object} config     - Loaded config (must have confidence_threshold, auto_approve)
 * @param {object} assessment - Assessment object from src/assessor.js
 * @returns {{ should_dispatch: boolean, queue_reason: string | null }}
 */
export function route(config, assessment) {
  const threshold =
    typeof config.confidence_threshold === 'number' ? config.confidence_threshold : 0.7;
  const autoApprove = Array.isArray(config.auto_approve) ? config.auto_approve : [];
  const actionClass = assessment?.suggested_action?.class ?? null;
  const confidence = typeof assessment?.confidence === 'number' ? assessment.confidence : 0;

  // Rule 1: low confidence always queues — cannot be overridden by auto_approve.
  if (confidence < threshold) {
    return { should_dispatch: false, queue_reason: 'low_confidence' };
  }

  // Rule 2: action class explicitly opted into auto-approve → dispatch.
  if (actionClass !== null && autoApprove.includes(actionClass)) {
    return { should_dispatch: true, queue_reason: null };
  }

  // Rule 3: default HITL.
  return { should_dispatch: false, queue_reason: 'awaiting_approval' };
}
