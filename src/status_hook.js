/**
 * Inbound status-callback server for clagentic:triage (T3, lr-f848).
 *
 * A generic HTTP receiver that lets ANY backend (lore, Jira, Linear, an
 * internal tool) tell triage "task X changed state" — the reverse direction
 * of create_task. This complements src/webhooks/server.js (which is GitHub's
 * inbound event channel): that server is GitHub-shaped and delegates all
 * verification/normalization to the source adapter; this one is backend-
 * shaped and delegates nothing to a source adapter, because the caller here
 * is not a source at all — it is whichever dispatcher-side system the
 * operator wired up.
 *
 * Payload shape (JSON body):
 *   {
 *     "task_id": "...",       // required — the id returned by a dispatcher's create_task
 *     "dispatcher": "...",    // optional — narrows the task_index lookup (recommended)
 *     "status": "shipped",    // required — only "shipped" is currently handled
 *     "version": "...",       // optional — included in the comment template
 *   }
 *
 * Auth model (RT-004 parity): HMAC-SHA256 over the raw request body, using a
 * dedicated secret (config.status_hooks.secret / CLAGENTIC_TRIAGE_STATUS_HOOK_SECRET) —
 * NOT the GitHub webhook secret, since this is a different trust boundary (any
 * configured backend, not GitHub). Same timing-safe comparison discipline as
 * the GitHub adapter's verify_webhook. An unauthenticated or badly-signed call
 * is rejected with 401 before the body is parsed or acted on.
 *
 * The route never imports task_index/release_notify's ticketing-specific
 * assumptions beyond the generic { repo, number, url } shape looked up from
 * src/task_index.js — it stays backend-agnostic on both the inbound (any
 * dispatcher can call it) and outbound (any source adapter can be the
 * target) sides.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer as _httpCreateServer } from 'node:http';
import { lookupTask } from './task_index.js';
import { applyReleaseNotice } from './release_notify.js';

/** Body size cap — status payloads are tiny; this bounds pre-auth memory use. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

/**
 * Verify an inbound status-callback delivery using HMAC-SHA256 over the raw
 * body, signature carried in the `x-clagentic-signature` header as
 * `sha256=<hex>`. Mirrors the GitHub adapter's verify_webhook discipline
 * (RT-004): timing-safe comparison, length-guarded before comparison, missing
 * header rejected up front.
 *
 * Exported for unit testing independent of the HTTP layer.
 *
 * @param {Buffer} rawBody
 * @param {object} headers - lowercase HTTP request headers object
 * @param {string} secret
 * @returns {boolean}
 */
export function verify_status_hook(rawBody, headers, secret) {
  const sigHeader = headers['x-clagentic-signature'] ?? '';
  if (!sigHeader) {
    return false;
  }
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sigHeader, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Read the full request body into a Buffer, capped at MAX_BODY_BYTES.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
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

/**
 * Handle a "shipped" status payload: look up the task_id in the durable
 * task index, and if found, apply the release notice to the originating
 * item via the configured source adapter.
 *
 * @param {object} config
 * @param {object} adapter
 * @param {object} payload
 * @returns {Promise<{ status: number, body: object }>}
 */
async function _handleShipped(config, adapter, payload) {
  const { task_id, dispatcher, version = null } = payload;

  if (typeof task_id !== 'string' || task_id.length === 0) {
    return { status: 400, body: { error: 'task_id is required' } };
  }

  const record = await lookupTask(config, task_id, { dispatcher });
  if (!record) {
    // Unknown task_id — acknowledge rather than error, since a backend may
    // legitimately call this for a task triage never dispatched (e.g. a task
    // created out-of-band). Not found is not the caller's fault.
    return { status: 200, body: { status: 'unknown_task_id' } };
  }

  if (!record.repo || record.number === null || record.number === undefined) {
    return { status: 200, body: { status: 'incomplete_origin_record' } };
  }

  const result = await applyReleaseNotice(config, adapter, {
    repo: record.repo,
    number: record.number,
    url: record.event_url,
    task_id,
    task_url: record.task_url,
    version,
  });

  return { status: 200, body: { status: 'ok', ...result } };
}

/**
 * Handle a single status-callback POST request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} config
 * @param {string} secret
 * @param {object} adapter
 */
async function handleRequest(req, res, config, secret, adapter) {
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: 'payload too large' });
    req.destroy();
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    throw e;
  }

  // Auth first, before any parsing — an unauthenticated call must be rejected
  // without acting on (or even inspecting) its content.
  if (!verify_status_hook(rawBody, req.headers, secret)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid json' });
    return;
  }

  if (payload.status !== 'shipped') {
    sendJson(res, 200, { status: 'ignored', reason: 'unsupported_status' });
    return;
  }

  const { status, body } = await _handleShipped(config, adapter, payload);
  sendJson(res, status, body);
}

/**
 * Create an HTTP server that receives inbound status-callback deliveries.
 *
 * Does NOT call .listen() — the caller controls lifecycle (mirrors
 * src/webhooks/server.js so tests can bind to port 0).
 *
 * @param {object} config  - loaded triage config
 * @param {object} adapter - source adapter (must implement post_comment,
 *   label_item, unlabel_item, list_comments, get_item_labels)
 * @returns {import('node:http').Server}
 */
export function createStatusHookServer(config, adapter) {
  const secret = config.status_hooks?.secret ?? '';
  const path = config.status_hooks?.path ?? '/status-hook';

  // RT-004 parity: refuse to create an unauthenticated status-hook server.
  if (!secret) {
    throw new Error(
      'Cannot create status-hook server: status_hooks.secret is empty. ' +
      'Set CLAGENTIC_TRIAGE_STATUS_HOOK_SECRET or status_hooks.secret in your config.',
    );
  }

  const server = _httpCreateServer((req, res) => {
    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method !== 'POST' || url !== path) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    handleRequest(req, res, config, secret, adapter).catch((e) => {
      console.error('[status-hook] unhandled error:', e.message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });

  return server;
}

/**
 * Convenience wrapper: create server + listen on the configured port and bind
 * address. Defaults to loopback — external exposure goes through a reverse
 * proxy, same posture as the GitHub webhook server.
 *
 * @param {object} config
 * @param {object} adapter
 * @returns {Promise<import('node:http').Server>}
 */
export function startStatusHookServer(config, adapter) {
  const port = config.status_hooks?.port ?? 8743;
  const bind = config.status_hooks?.bind ?? '127.0.0.1';

  const server = createStatusHookServer(config, adapter);

  return new Promise((resolve, reject) => {
    server.listen(port, bind, () => {
      const addr = server.address();
      console.log(`[status-hook] listening on ${addr.address}:${addr.port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}
