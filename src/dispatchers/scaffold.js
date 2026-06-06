/**
 * scaffold — starter template for a clagentic:triage dispatcher.
 *
 * Copy this file to your own package and fill in the marked sections.
 * Remove the scaffold comments once you understand the contract.
 *
 * USAGE
 * -----
 * 1. Copy this file to your package: cp scaffold.js my-backend.js
 * 2. Replace every TODO with your implementation.
 * 3. Point your triage config at it:
 *
 *    {
 *      "dispatchers": [
 *        { "name": "my-backend", "module": "@myorg/triage-dispatcher-my-backend" }
 *      ]
 *    }
 *
 * The dispatcher loader (src/dispatchers/index.js) will import it, verify that
 * create_task is exported, and call it for every approved dispatch-class verdict.
 *
 * INTERFACE CONTRACT (docs/DISPATCHERS.md)
 * -----------------------------------------
 * export const name                               — required, string
 * export async function create_task(...)          — required
 * export async function update_task(...)          — optional
 *
 * SECURITY NOTES
 * --------------
 * - Never log or store raw event.body — it contains untrusted user content.
 * - Read credentials from environment variables; never hardcode them.
 * - Use the backend-specific config in config.dispatchers.find(d => d.name === name)
 *   for dispatcher-level settings (url, token_env, etc.).
 */

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

/**
 * The dispatcher name as it will appear in config and log output.
 * Must match the "name" key in the config dispatchers entry.
 */
export const name = 'scaffold'; // TODO: rename to your backend name

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

/**
 * Find this dispatcher's own config entry from config.dispatchers.
 *
 * Each dispatcher carries its own backend-specific config keys inside the
 * dispatchers array entry that loaded it. This helper extracts that entry so
 * create_task / update_task can read url, token env var names, etc.
 *
 * @param {object} config - the full loaded triage config
 * @returns {object} the dispatcher's own config entry (or {} if not found)
 */
function resolveConfig(config) {
  return config?.dispatchers?.find((d) => d.name === name) ?? {};
}

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

/**
 * Called when a triage verdict is approved for dispatch.
 *
 * Receives the normalized Event and the full Assessment. Creates a task/ticket
 * in the backend and returns a stable { id, url } that the pipeline stores on
 * the pending queue entry so update_task can reference it later.
 *
 * Never throws on expected failure paths — throw only on truly unrecoverable
 * errors. The dispatcher runner catches any thrown error, records it as
 * { name, error } in the results array, and continues with the next dispatcher.
 *
 * @param {object} config     - loaded triage config; use resolveConfig(config)
 *                              to get the backend-specific section
 * @param {object} event      - normalized Event (schema below)
 * @param {object} assessment - full assessor output (schema below)
 * @returns {Promise<{ id: string, url: string|null }>}
 *
 * Event shape (all fields always present, some may be null):
 *   event.id          — string, unique event identifier
 *   event.type        — 'issue' | 'pr' | 'issue_comment' | 'pr_comment'
 *   event.title       — string, issue/PR title
 *   event.author      — string, GitHub login of the event author
 *   event.url         — string, URL to the issue/PR on GitHub
 *   event.repo        — string, 'owner/repo'
 *   event.created_at  — ISO timestamp string
 *   event.source      — adapter name, e.g. 'github'
 *   event.metadata    — object, adapter-specific extras (author_association, etc.)
 *   event.context     — object|null, enriched repo context (intent, docs, etc.)
 *   ⚠️  Do NOT use event.body in your backend payload — it is untrusted user
 *       content and should never leave the triage system without explicit review.
 *
 * Assessment shape:
 *   assessment.verdict          — 'accept' | 'needs_changes' | 'reject' | 'escalate' | 'defer'
 *   assessment.confidence       — float 0.0–1.0
 *   assessment.reasoning        — string, LLM's explanation
 *   assessment.suggested_action.class  — 'approve' | 'respond' | 'request_changes'
 *                                         | 'close' | 'dispatch' | 'escalate'
 *   assessment.suggested_action.body   — string|null, comment text if applicable
 *   assessment.suggested_action.labels — string[], labels to apply
 *   assessment.model_used       — string, which model produced this assessment
 */
export async function create_task(config, event, assessment) {
  const dispatcherConfig = resolveConfig(config);

  // TODO: read your backend URL / credentials from dispatcherConfig or env
  // Example:
  //   const url = dispatcherConfig.url;
  //   const token = process.env[dispatcherConfig.token_env ?? 'MY_BACKEND_TOKEN'];

  // TODO: build your backend-specific payload from the structured fields above.
  // Include event.id, event.url, event.title, assessment.verdict, etc.
  // Do NOT include event.body.
  const payload = {
    title: `[triage] ${event.title ?? event.id}`,
    source_url: event.url,
    verdict: assessment.verdict,
    confidence: assessment.confidence,
    reasoning: assessment.reasoning,
    action: assessment.suggested_action?.class,
    repo: event.repo,
  };

  // TODO: make the API call to your backend
  // Example (generic fetch):
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  //     body: JSON.stringify(payload),
  //   });
  //   if (!res.ok) throw new Error(`backend returned ${res.status}`);
  //   const data = await res.json();
  //   return { id: String(data.id), url: data.url ?? null };

  // Placeholder return — remove once implemented:
  console.log(`[${name}] would create task for event=${event.id}`, payload);
  return { id: `${name}-${event.id}`, url: null };
}

// ---------------------------------------------------------------------------
// update_task  (optional)
// ---------------------------------------------------------------------------

/**
 * Update an existing task in the backend.
 *
 * This method is optional and is NOT called by the current pipeline. It is part
 * of the dispatcher interface contract for future use — export it if your backend
 * supports updates, or omit it if not. The current pipeline only calls
 * create_task.
 *
 * @param {object} config   - loaded triage config
 * @param {string} task_id  - the id returned by create_task
 * @param {object} patch    - fields to update (shape is caller-defined)
 * @returns {Promise<void>}
 */
export async function update_task(config, task_id, patch) {
  // TODO: implement if your backend supports task updates, or remove this
  // export entirely if it does not.
  console.log(`[${name}] update_task task=${task_id} (not implemented)`);
}
