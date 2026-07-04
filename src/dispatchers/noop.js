/**
 * noop — reference dispatcher for clagentic:triage.
 *
 * The dry-run dispatcher. It performs no external calls: create_task logs a
 * one-line summary and returns a synthetic identifier, and update_task logs and
 * returns. Use it as the safe default for exercising the pipeline end to end,
 * and as the template operators copy when writing their own backend dispatcher.
 *
 * Interface contract (see docs/DISPATCHERS.md):
 *   export const name
 *   export async function create_task(config, event, assessment) -> { id, url }
 *   export async function update_task(config, task_id, patch)    -> void  (optional)
 */

export const name = 'noop';

/**
 * Log a one-line summary of the triage verdict and return a synthetic task ref.
 *
 * No external system is contacted. The returned id is derived from the event id
 * so a later update_task call has something stable to reference; url is null
 * because no real task was created.
 *
 * @param {object} config      - loaded triage config (unused by noop)
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {Promise<{ id: string, url: null }>}
 */
export async function create_task(config, event, assessment) {
  const eventId = event?.id ?? '(unknown)';
  const verdict = assessment?.verdict ?? '(no verdict)';
  const classes = assessment?.suggested_action?.classes;
  const action = Array.isArray(classes) && classes.length > 0 ? classes.join('+') : '(no action)';

  console.log(`[noop] create_task event=${eventId} verdict=${verdict} action=${action}`);

  return { id: `noop-${eventId}`, url: null };
}

/**
 * Log the update and return. No external system is contacted.
 *
 * @param {object} config   - loaded triage config (unused by noop)
 * @param {string} task_id  - id previously returned by create_task
 * @param {object} patch    - fields the caller wants to update
 * @returns {Promise<void>}
 */
export async function update_task(config, task_id, patch) {
  const keys = patch && typeof patch === 'object' ? Object.keys(patch).join(',') : '';
  console.log(`[noop] update_task task=${task_id} patch_keys=${keys}`);
}
