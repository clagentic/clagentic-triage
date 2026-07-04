/**
 * webhook — outbound HTTP dispatcher for clagentic:triage.
 *
 * POSTs a sanitized triage event payload to a configured URL on create_task.
 * Supports optional HMAC-SHA256 request signing and a configurable timeout.
 * update_task is a no-op: webhooks are fire-and-forget with no mutable state.
 *
 * Interface contract (see docs/DISPATCHERS.md):
 *   export const name
 *   export async function create_task(config, event, assessment) -> { id, url }
 *   export async function update_task(config, task_id, patch)    -> void
 *
 * Config entry shape (inside config.dispatchers[]):
 *   {
 *     "name": "webhook",
 *     "url": "https://...",        // required — POST target
 *     "secret": "optional",        // if set, adds X-Clagentic-Signature header
 *     "timeout_ms": 5000           // default 5000
 *   }
 */

import { createHmac } from 'node:crypto';

export const name = 'webhook';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Find this dispatcher's own config entry within config.dispatchers.
 *
 * @param {object} config - loaded triage config
 * @returns {object} dispatcher config entry
 * @throws {Error} if no webhook entry is found or url is missing
 */
function resolveDispatcherConfig(config) {
  const entries = Array.isArray(config?.dispatchers) ? config.dispatchers : [];
  const entry = entries.find((d) => d.name === 'webhook');
  if (!entry) {
    throw new Error('[webhook] no dispatcher config entry with name "webhook" found');
  }
  if (!entry.url || typeof entry.url !== 'string') {
    throw new Error('[webhook] dispatcher config entry is missing a valid "url"');
  }
  return entry;
}

/**
 * Build the outbound payload from the normalized event and assessment.
 *
 * Only known safe fields are included. Raw event body, context blocks, and any
 * other untrusted content are intentionally omitted.
 *
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {object} plain JSON-serializable payload
 */
function buildPayload(event, assessment) {
  return {
    event_id: event?.id ?? null,
    repo: event?.repo ?? null,
    type: event?.type ?? null,
    author: event?.author ?? null,
    url: event?.url ?? null,
    verdict: assessment?.verdict ?? null,
    confidence: assessment?.confidence ?? null,
    reasoning: assessment?.reasoning ?? null,
    suggested_action: {
      classes: Array.isArray(assessment?.suggested_action?.classes)
        ? assessment.suggested_action.classes
        : [],
      body: assessment?.suggested_action?.body ?? null,
    },
    dispatched_at: new Date().toISOString(),
  };
}

/**
 * Compute the HMAC-SHA256 signature for the given body string.
 *
 * @param {string} secret   - signing secret
 * @param {string} bodyStr  - JSON-serialized payload string
 * @returns {string}        - "sha256=<hex digest>"
 */
function computeSignature(secret, bodyStr) {
  const hmac = createHmac('sha256', secret);
  hmac.update(bodyStr);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * POST the triage payload to the configured webhook URL.
 *
 * Signs the request with HMAC-SHA256 when a secret is configured.
 * Aborts after timeout_ms (default 5000). Non-2xx response → throws.
 *
 * @param {object} config      - loaded triage config
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function create_task(config, event, assessment) {
  const dispatcherConfig = resolveDispatcherConfig(config);
  const { url, secret, timeout_ms: timeoutMs = DEFAULT_TIMEOUT_MS } = dispatcherConfig;

  const payload = buildPayload(event, assessment);
  const bodyStr = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    headers['X-Clagentic-Signature'] = computeSignature(secret, bodyStr);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`[webhook] POST to ${url} failed with status ${response.status}`);
  }

  return { id: event?.id ?? null, url };
}

/**
 * No-op. Webhooks are fire-and-forget; there is no remote task state to update.
 *
 * @returns {Promise<void>}
 */
export async function update_task(_config, _task_id, _patch) {
  // Intentional no-op: webhook dispatcher has no mutable task state.
}
