/**
 * Inbound webhook server for clagentic:triage.
 *
 * This module is provider-agnostic. All provider-specific logic — signature
 * verification, delivery ID extraction, and payload normalization — is delegated
 * to the source adapter via the webhook interface methods:
 *
 *   adapter.verify_webhook(rawBody, headers, secret)  -> boolean
 *   adapter.get_delivery_id(headers)                  -> string|null
 *   adapter.normalize_webhook(headers, payload)       -> Event|null
 *   adapter.is_bot_sender(payload, allowList)         -> boolean
 *
 * The server owns only HTTP plumbing, replay protection bookkeeping, routing,
 * and the RT-004 empty-secret guard.
 *
 * Security model:
 *   - Signature verification is fully delegated to the adapter (RT-004).
 *     The server never references provider-specific header names or HMAC schemes.
 *   - Replay protection via in-memory delivery ID set (per-process; see note below)
 *   - Binds to 127.0.0.1 by default — expose externally via reverse proxy only
 *   - createServer throws immediately if webhooks.enabled and secret is empty
 *
 * NOTE on replay protection: The delivery ID set is in-memory and resets on
 * process restart. A multi-instance deployment (multiple triage processes
 * behind a load balancer) would need shared state (Redis, etc.) to guarantee
 * cross-instance replay protection. That is out of scope for this implementation.
 * Single-process deployments (the expected default) are fully protected.
 */

import { createServer as _httpCreateServer } from 'node:http';

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

/**
 * Maximum number of delivery IDs to retain in the in-process LRU set.
 * 10 000 entries covers well over any realistic burst before the oldest entries
 * are safe to evict.
 */
const REPLAY_SET_MAX = 10_000;

/**
 * A capped set of recently-seen delivery IDs.
 * Order of insertion is preserved; the oldest entry is evicted when the cap
 * is hit. This is a simple insertion-order LRU using a Map (JS Maps are
 * ordered by insertion).
 */
class DeliveryIdSet {
  constructor(maxSize = REPLAY_SET_MAX) {
    this._map = new Map();
    this._max = maxSize;
  }

  /** Returns true if the id was already seen (duplicate). */
  checkAndAdd(id) {
    if (this._map.has(id)) {
      return true;
    }
    if (this._map.size >= this._max) {
      // Evict the oldest entry (first key in insertion order).
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(id, true);
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Read the full request body into a Buffer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send a simple JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Core exports
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server that receives inbound webhook deliveries.
 *
 * All provider-specific logic is delegated to the adapter. The adapter must
 * implement the following webhook interface methods:
 *
 *   verify_webhook(rawBody, headers, secret)  -> boolean
 *   get_delivery_id(headers)                  -> string|null
 *   normalize_webhook(headers, payload)       -> Event|null
 *   is_bot_sender(payload, allowList)         -> boolean
 *
 * Does NOT call .listen() — the caller controls lifecycle. This separation
 * allows tests to bind to port 0 for ephemeral port assignment.
 *
 * @param {object} config   - Loaded triage config
 * @param {object} adapter  - Source adapter implementing the webhook interface
 * @param {object} [opts]
 * @param {function} [opts.onEvent]  - Called with each normalized, verified Event
 * @returns {import('node:http').Server}
 */
export function createServer(config, adapter, { onEvent } = {}) {
  const secret = config.webhooks?.secret ?? '';
  const webhookPath = config.webhooks?.path ?? '/webhook';
  const allowBotLogins = config.source?.allow_bot_logins ?? [];

  // RT-004: refuse to create an unauthenticated webhook server.
  // The config validator also enforces this; this is defense in depth.
  if (!secret) {
    throw new Error(
      'Cannot create webhook server: webhooks.secret is empty. ' +
      'Set CLAGENTIC_TRIAGE_WEBHOOK_SECRET or webhooks.secret in your config.',
    );
  }

  const seenDeliveries = new DeliveryIdSet();

  const server = _httpCreateServer((req, res) => {
    const { method, url } = req;

    // Health check — simple liveness probe.
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Only POST to the configured webhook path is accepted.
    if (method !== 'POST' || url !== webhookPath) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Async handler — errors are caught and returned as 500 to avoid
    // uncaught promise rejections hanging the server.
    handleWebhookRequest(req, res, secret, adapter, seenDeliveries, allowBotLogins, onEvent)
      .catch((err) => {
        console.error('[webhook] unhandled error:', err.message);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal error' });
        }
      });
  });

  return server;
}

/**
 * Convenience wrapper: create server + listen on the configured port and bind address.
 *
 * @param {object} config
 * @param {object} adapter
 * @param {object} [opts]
 * @param {function} [opts.onEvent]
 * @returns {Promise<import('node:http').Server>}  The listening server.
 */
export function startWebhookServer(config, adapter, { onEvent } = {}) {
  const port = config.webhooks?.port ?? 8742;
  // Default to loopback — operators who need external exposure place a reverse
  // proxy in front rather than binding 0.0.0.0 directly (RT-004).
  const bind = config.webhooks?.bind ?? '127.0.0.1';

  const server = createServer(config, adapter, { onEvent });

  return new Promise((resolve, reject) => {
    server.listen(port, bind, () => {
      const addr = server.address();
      console.log(`[webhook] listening on ${addr.address}:${addr.port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Request handler (extracted for clarity)
// ---------------------------------------------------------------------------

/**
 * Handle an incoming webhook POST request.
 *
 * All provider-specific concerns are handled via adapter method calls.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} secret
 * @param {object} adapter
 * @param {DeliveryIdSet} seenDeliveries
 * @param {string[]} allowBotLogins
 * @param {function|undefined} onEvent
 */
async function handleWebhookRequest(req, res, secret, adapter, seenDeliveries, allowBotLogins, onEvent) {
  const rawBody = await readBody(req);

  // RT-004: verify signature before touching any payload content.
  // The adapter owns the provider-specific HMAC/token scheme entirely.
  if (!adapter.verify_webhook(rawBody, req.headers, secret)) {
    // No signature or invalid signature — reject without logging payload detail.
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  // Replay protection: adapter extracts the delivery ID (provider-specific header).
  // If the adapter returns null, this provider does not support delivery IDs and
  // replay protection is skipped for this delivery.
  const deliveryId = adapter.get_delivery_id(req.headers);
  if (deliveryId !== null && seenDeliveries.checkAndAdd(deliveryId)) {
    // Duplicate delivery (provider retry) — acknowledge idempotently but skip processing.
    console.log(`[webhook] duplicate delivery ignored: ${deliveryId}`);
    sendJson(res, 200, { status: 'duplicate' });
    return;
  }

  // Parse body — signature is verified, safe to parse now.
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid json' });
    return;
  }

  // DD-005: drop bot senders at webhook ingress, same as poll ingress.
  // The adapter owns the bot-detection logic so it stays consistent with
  // its poll-path filtering.
  if (adapter.is_bot_sender(payload, allowBotLogins)) {
    console.log(`[webhook] bot sender ignored: ${payload.sender?.login}`);
    sendJson(res, 200, { status: 'ignored', reason: 'bot' });
    return;
  }

  // Adapter normalizes the provider-specific payload into the standard Event schema.
  // The adapter reads provider-specific event-type headers from the headers object internally.
  const event = adapter.normalize_webhook(req.headers, payload);

  if (event === null) {
    // Unsupported event type — ack without processing.
    console.log(`[webhook] unsupported event type ignored`);
    sendJson(res, 200, { status: 'ignored', reason: 'unsupported_event_type' });
    return;
  }

  // Deliver to the pipeline.
  if (typeof onEvent === 'function') {
    await onEvent(event);
  }

  sendJson(res, 200, { status: 'ok' });
}
