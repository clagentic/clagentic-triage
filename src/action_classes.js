/**
 * Action-class / event-type compatibility — single source of truth.
 *
 * lr-757a69: 'approve'/'request_changes' are PR-only action classes but the
 * assessor prompt's constraint (lr-4717) was the only place this rule lived.
 * Operators and agents repeatedly assumed 'approve' also applies to issues
 * (the correct class there is 'dispatch' or 'respond'), and a model that
 * violated the prompt constraint surfaced only as a raw AdapterError deep in
 * the GitHub adapter (src/adapters/github.js's approve_pr/request_changes
 * guards). This module is the one place the matrix is defined so the CLI
 * pre-flight check (src/cli.js), the assessor re-route guard (src/assessor.js),
 * and docs/ACTION_CLASSES.md can all cite the same values instead of drifting.
 *
 * Ticketing-agnostic, like src/labels.js: this module only reasons about
 * action-class strings and event-type strings, never about a specific
 * adapter/backend.
 */

/** Every action class the assessor may emit (mirrors src/llm.js's VALID_ACTION_CLASSES). */
export const ALL_ACTION_CLASSES = [
  'approve', 'respond', 'request_changes', 'close', 'dispatch', 'escalate',
];

/**
 * Event types an action class is valid for. A class absent from this map
 * (should not happen given ALL_ACTION_CLASSES) is treated as valid for no type.
 *
 * 'approve' and 'request_changes' are PR review actions — GitHub (and every
 * other adapter's) review API has no issue equivalent. 'respond', 'close',
 * 'dispatch', and 'escalate' apply to both issues and PRs.
 */
const VALID_TYPES_BY_CLASS = {
  approve: ['pr'],
  request_changes: ['pr'],
  respond: ['issue', 'pr'],
  close: ['issue', 'pr'],
  dispatch: ['issue', 'pr'],
  escalate: ['issue', 'pr'],
};

/**
 * Return the event types a given action class is valid for.
 *
 * @param {string} actionClass
 * @returns {string[]} e.g. ['pr'] or ['issue', 'pr']; [] for an unknown class
 */
export function validTypesForClass(actionClass) {
  return VALID_TYPES_BY_CLASS[actionClass] ?? [];
}

/**
 * Return every action class valid for a given event type, in the same order
 * as ALL_ACTION_CLASSES — used to build "valid classes for this type" hints
 * in CLI usage/error messages.
 *
 * @param {string} eventType - 'issue' | 'pr'
 * @returns {string[]}
 */
export function validClassesForType(eventType) {
  return ALL_ACTION_CLASSES.filter((cls) => VALID_TYPES_BY_CLASS[cls].includes(eventType));
}

/**
 * Whether an action class is valid for a given event type.
 *
 * @param {string} actionClass
 * @param {string} eventType
 * @returns {boolean}
 */
export function isActionClassValidForType(actionClass, eventType) {
  return VALID_TYPES_BY_CLASS[actionClass]?.includes(eventType) ?? false;
}

/**
 * Build a human-readable, actionable error message for an action-class/
 * event-type mismatch. Shared by every execution-boundary caller (CLI
 * pre-flight, future adapters) so the message text does not drift.
 *
 * @param {string} actionClass
 * @param {string} eventType
 * @returns {string}
 */
export function mismatchMessage(actionClass, eventType) {
  const validClasses = validClassesForType(eventType);
  return (
    `Action class "${actionClass}" is not valid for event type "${eventType}". ` +
    `Valid classes for "${eventType}": ${validClasses.join(', ') || '(none)'}.`
  );
}
