/**
 * Release notification — closed-loop status back-post (T3, lr-f848).
 *
 * When a dispatched task ships (in any backend — lore, Jira, Linear, an
 * internal tool), this module posts that status back to the originating
 * GitHub issue/PR: a config-driven comment + the `released` status/* label
 * (DD-012). It is ticketing-agnostic — it never imports a dispatcher or knows
 * which backend originated the task; it only operates on the adapter-level
 * primitives (post_comment, label_item, unlabel_item, list_comments) and the
 * resolved { repo, number, url } that the caller (the inbound status hook,
 * src/status_hook.js) already looked up via src/task_index.js.
 *
 * Idempotent per (issue, version): scans existing comments for a marker before
 * posting, and skips re-applying a label the item already carries. A repeated
 * call for the same task_id + version is a no-op — safe to retry or replay.
 */

import { enforceSingleStatus } from './labels.js';

/** Namespace used to build the terminal "shipped" status label (DD-012). */
const RELEASED_STATUS_VALUE = 'released';

/**
 * Hidden HTML-comment marker embedded in every release comment. Used to detect
 * "have we already posted this exact (task_id, version) release notice" without
 * depending on exact prose match, so template wording can change without
 * breaking idempotency.
 *
 * @param {string} task_id
 * @param {string|null} version
 * @returns {string}
 */
function _marker(task_id, version) {
  return `<!-- clagentic-triage:release task_id=${task_id} version=${version ?? ''} -->`;
}

/**
 * Render the comment body from the operator's configured template.
 *
 * Template placeholders: {version}, {task_url}, {task_id}, {repo}, {number}.
 * Unset placeholders in the payload render as an empty string rather than
 * throwing, so a partial payload never crashes the notifier.
 *
 * @param {string} template
 * @param {object} vars
 * @returns {string}
 */
function _renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = vars[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

/**
 * Default comment template used when the operator has not configured one.
 */
const DEFAULT_TEMPLATE = 'Shipped in {version}: {task_url}';

/**
 * Resolve the release-notify config block, falling back to defaults for any
 * field the operator did not supply.
 *
 * @param {object} config
 * @returns {{ comment_template: string, status_label: string }}
 */
function resolveReleaseConfig(config) {
  const rn = config?.release_notify ?? {};
  return {
    comment_template: typeof rn.comment_template === 'string' && rn.comment_template.length > 0
      ? rn.comment_template
      : DEFAULT_TEMPLATE,
  };
}

/**
 * Return true if a release comment for this exact (task_id, version) has
 * already been posted to the item.
 *
 * @param {object[]} comments - raw comment objects from adapter.list_comments
 * @param {string} task_id
 * @param {string|null} version
 * @returns {boolean}
 */
function _alreadyPosted(comments, task_id, version) {
  const marker = _marker(task_id, version);
  return comments.some((c) => typeof c.body === 'string' && c.body.includes(marker));
}

/**
 * Apply the closed-loop "task shipped" release notice to the originating item.
 *
 * IDEMPOTENT per (task_id, version): if a prior call already posted the
 * marked comment, this is a no-op (comment is not re-posted). The `released`
 * label is applied via the normal single-status invariant (enforceSingleStatus,
 * src/labels.js) so any other in-flight status/* label is removed — re-running
 * with the label already applied is also a no-op (label_item on an
 * already-applied label is idempotent on GitHub's side).
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement post_comment,
 *   label_item, unlabel_item, list_comments, get_item_labels)
 * @param {object} target
 * @param {string} target.repo    - "owner/repo"
 * @param {number} target.number  - issue/PR number
 * @param {string} target.url     - item URL (for template rendering)
 * @param {string} target.task_id
 * @param {string|null} [target.task_url]
 * @param {string|null} [target.version]
 * @returns {Promise<{ posted: boolean, labeled: boolean, comment_url: string|null }>}
 */
export async function applyReleaseNotice(config, adapter, target) {
  const { repo, number, url, task_id, task_url = null, version = null } = target;
  const event = { repo, number, url };

  const releaseConfig = resolveReleaseConfig(config);

  const comments = await adapter.list_comments(config, event);
  const alreadyPosted = _alreadyPosted(comments, task_id, version);

  let commentUrl = null;
  let posted = false;
  if (!alreadyPosted) {
    const body = _renderTemplate(releaseConfig.comment_template, {
      version,
      task_url,
      task_id,
      repo,
      number,
    }) + `\n\n${_marker(task_id, version)}`;
    commentUrl = await adapter.post_comment(config, event, body);
    posted = true;
  }

  const releasedLabel = `${config?.labels?.status_namespace ?? 'status'}/${RELEASED_STATUS_VALUE}`;
  const currentLabels = await adapter.get_item_labels(config, event);
  const alreadyLabeled = currentLabels.includes(releasedLabel);

  let labeled = false;
  if (!alreadyLabeled) {
    const { toRemove, toApply } = enforceSingleStatus(config, currentLabels, [releasedLabel]);
    for (const label of toRemove) {
      await adapter.unlabel_item(config, event, label);
    }
    await adapter.label_item(config, event, toApply);
    labeled = true;
  }

  return { posted, labeled, comment_url: commentUrl };
}
