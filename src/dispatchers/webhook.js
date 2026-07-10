/**
 * webhook — outbound HTTP dispatcher for clagentic:triage.
 *
 * POSTs a sanitized triage event payload to a configured URL on create_task.
 * Supports optional HMAC-SHA256 request signing, bearer-token auth, and a
 * configurable timeout. update_task is a no-op: webhooks are fire-and-forget
 * with no mutable state.
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
 *     "secret": "optional",        // if set, adds X-Clagentic-Signature header (HMAC-SHA256)
 *     "auth": {                    // optional — alternative to "secret"
 *       "type": "bearer",
 *       "token_env": "INGEST_TOKEN"  // env var holding the bearer token
 *     },
 *     "payload": {                 // optional — field mapping; omit for the
 *       "title": "{{event.title}}",       // fixed default payload (back-compat)
 *       "project": "my-project",          // literal value — no {{...}} present
 *       "description": "{{assessment.reasoning}}\n\n{{event.body}}",
 *       "source_url": "{{event.url}}"
 *     },
 *     "timeout_ms": 5000           // default 5000
 *   }
 *
 * Field mapping (docs/DISPATCHERS.md has the full worked example): each value
 * in "payload" is a template string. "{{path}}" placeholders are resolved
 * against `event` and `assessment` (dot paths, e.g. "event.title",
 * "assessment.suggested_action.body"); a value with no "{{...}}" placeholder
 * is sent as a literal. Multiple placeholders and surrounding text in one
 * string are supported (e.g. "{{assessment.reasoning}}\n\n{{event.body}}").
 * An unresolvable path renders as null for a whole-string placeholder, or as
 * "" inside interpolated text (see renderTemplate below). Unlike the default
 * fixed payload, "payload" mappings may reference event.body — this is an
 * explicit, operator-configured opt-in per target field, not the default
 * behavior.
 */

import { createHmac } from 'node:crypto';

export const name = 'webhook';

const DEFAULT_TIMEOUT_MS = 5000;
const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

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
  if (entry.secret && entry.auth) {
    throw new Error(
      '[webhook] dispatcher config sets both "secret" (HMAC) and "auth" (bearer) — '
      + 'these are mutually exclusive; configure one auth mode, not both',
    );
  }
  return entry;
}

/**
 * Resolve a dot-separated path (e.g. "event.title") against a { event,
 * assessment } context object.
 *
 * @param {object} context - { event, assessment }
 * @param {string} path    - dot-separated path, root must be "event" or "assessment"
 * @returns {*} the resolved value, or undefined if any segment is missing
 */
function resolvePath(context, path) {
  return path.split('.').reduce((acc, segment) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[segment];
  }, context);
}

/**
 * Render one template string against the event/assessment context.
 *
 * A value with no "{{...}}" placeholder is returned unchanged (literal).
 * A value that is exactly one placeholder ("{{event.title}}") returns the
 * resolved value's native type (string, number, array, etc.) rather than a
 * stringified version, so non-string fields (e.g. an array of labels) survive
 * intact. A value with a placeholder plus surrounding text, or more than one
 * placeholder, is resolved as string interpolation. Unresolvable paths render
 * as the empty string.
 *
 * @param {string} template - config-supplied template string
 * @param {object} context  - { event, assessment }
 * @returns {*} resolved value
 */
function renderTemplate(template, context) {
  if (typeof template !== 'string') return template;

  const matches = [...template.matchAll(TEMPLATE_RE)];
  if (matches.length === 0) {
    // No placeholder — literal value, passed through as-is.
    return template;
  }

  if (matches.length === 1 && matches[0][0] === template) {
    // The whole string is a single placeholder — preserve native type.
    const value = resolvePath(context, matches[0][1]);
    return value === undefined ? null : value;
  }

  // Mixed literal/placeholder text or multiple placeholders — string interpolation.
  return template.replace(TEMPLATE_RE, (_match, path) => {
    const value = resolvePath(context, path);
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Build the outbound payload from a config-supplied field mapping.
 *
 * @param {object} payloadMap  - config.dispatchers[].payload mapping
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {object} plain JSON-serializable payload
 */
function buildMappedPayload(payloadMap, event, assessment) {
  const context = { event, assessment };
  const result = {};
  for (const [targetKey, template] of Object.entries(payloadMap)) {
    result[targetKey] = renderTemplate(template, context);
  }
  return result;
}

/**
 * Build the default fixed-shape payload (back-compat when no "payload"
 * mapping is configured).
 *
 * Only known safe fields are included. Raw event body, context blocks, and any
 * other untrusted content are intentionally omitted.
 *
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {object} plain JSON-serializable payload
 */
function buildDefaultPayload(event, assessment) {
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
 * Build the auth header(s) for the configured auth mode.
 *
 * Supports two modes, checked in this order:
 *   - `auth: { type: 'bearer', token_env: '<ENV_VAR>' }` — reads the token
 *     from the named environment variable and sends `Authorization: Bearer <token>`.
 *   - `secret` (legacy top-level field) — HMAC-SHA256 signs the body and sends
 *     `X-Clagentic-Signature: sha256=<hex>`.
 * A dispatcher entry with neither is sent unauthenticated.
 *
 * @param {object} dispatcherConfig - this dispatcher's config entry
 * @param {string} bodyStr          - JSON-serialized payload string (for HMAC)
 * @returns {object} headers to merge into the request
 * @throws {Error} if auth.type is 'bearer' and the named env var is unset/empty
 */
function buildAuthHeaders(dispatcherConfig, bodyStr) {
  const { auth, secret } = dispatcherConfig;

  if (auth && auth.type === 'bearer') {
    const envVar = auth.token_env ?? 'INGEST_TOKEN';
    const token = process.env[envVar];
    if (!token) {
      throw new Error(`[webhook] bearer auth configured but env var "${envVar}" is unset or empty`);
    }
    return { Authorization: `Bearer ${token}` };
  }

  if (secret) {
    return { 'X-Clagentic-Signature': computeSignature(secret, bodyStr) };
  }

  return {};
}

/**
 * POST the triage payload to the configured webhook URL.
 *
 * Builds the payload from the config-supplied "payload" field mapping when
 * present, falling back to the fixed default shape otherwise (back-compat).
 * Authenticates via bearer token ("auth: { type: 'bearer', ... }") or
 * HMAC-SHA256 signing ("secret"), whichever is configured.
 * Aborts after timeout_ms (default 5000). Non-2xx response → throws.
 *
 * @param {object} config      - loaded triage config
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function create_task(config, event, assessment) {
  const dispatcherConfig = resolveDispatcherConfig(config);
  const { url, timeout_ms: timeoutMs = DEFAULT_TIMEOUT_MS, payload: payloadMap } = dispatcherConfig;

  const payload = payloadMap && typeof payloadMap === 'object'
    ? buildMappedPayload(payloadMap, event, assessment)
    : buildDefaultPayload(event, assessment);
  const bodyStr = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(dispatcherConfig, bodyStr),
  };

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
