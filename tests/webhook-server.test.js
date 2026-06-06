/**
 * Tests for src/webhooks/server.js
 *
 * Tests exercise the server with the real github adapter wired in (end-to-end
 * through verify_webhook / normalize_webhook) and with a minimal fake adapter
 * that uses a different provider's verification scheme (proving provider-agnosticism).
 *
 * All tests bind to port 0 (ephemeral) and close the server after each test.
 *
 * Security cases tested:
 *   - Valid HMAC signature (github adapter) — 200 ok
 *   - Invalid HMAC signature — 401
 *   - Missing signature header — 401
 *   - Replay detection (duplicate delivery ID) — 200 duplicate
 *   - Bot sender filtering (DD-005)
 *   - Unsupported event type — 200 ignored
 *   - Empty secret throws on createServer
 *   - GET /health — 200 ok
 *   - Unknown path — 404
 *   - Fake adapter with different verify scheme — proves server is not GitHub-specific
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createServer } from '../src/webhooks/server.js';
import * as githubAdapter from '../src/adapters/github.js';
import { loadAdapter } from '../src/cli.js';
import { request as httpRequest } from 'node:http';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal triage config with a webhook secret.
 */
function makeConfig(overrides = {}) {
  return {
    webhooks: {
      secret: 'test-secret',
      path: '/webhook',
      ...((overrides.webhooks) ?? {}),
    },
    source: {
      allow_bot_logins: [],
      ...((overrides.source) ?? {}),
    },
    ...overrides,
  };
}

/**
 * Compute a GitHub HMAC-SHA256 signature for a body buffer.
 * Mirrors the github adapter's verify_webhook internals.
 */
function githubSig(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Start a server on an ephemeral port and return { server, port }.
 * The server uses createServer (no auto-listen) so we call .listen(0) here.
 */
function startServer(config, adapter, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(config, adapter, opts);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.once('error', reject);
  });
}

/**
 * Close a server and wait for it to fully close.
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Send a webhook POST to the server and return { status, body }.
 *
 * @param {number} port
 * @param {Buffer|string} body
 * @param {Record<string,string>} headers
 * @param {string} [path='/webhook']
 */
async function sendWebhook(port, body, headers, path = '/webhook') {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(buf.byteLength),
      ...headers,
    },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Send a GET request and return { status, body }.
 */
async function sendGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Minimal fake adapter for provider-agnosticism proof
//
// This adapter uses a simple shared-token scheme: it checks the
// `x-fake-token` header against the secret directly (like GitLab's
// X-Gitlab-Token). No HMAC involved.
// ---------------------------------------------------------------------------

const fakeAdapter = {
  name: 'fake',

  verify_webhook(rawBody, headers, secret) {
    return headers['x-fake-token'] === secret;
  },

  get_delivery_id(headers) {
    return headers['x-fake-delivery'] ?? null;
  },

  normalize_webhook(headers, payload) {
    const eventType = headers['x-fake-event'] ?? '';
    if (eventType !== 'item') {
      return null;
    }
    return {
      id: `fake#${payload.id}`,
      type: 'issue',
      title: payload.title ?? '',
      body: payload.body ?? '',
      author: payload.author ?? '',
      created_at: payload.created_at ?? '',
      url: payload.url ?? '',
      source: 'fake',
      repo: payload.repo ?? '',
      number: payload.id,
      metadata: { labels: [], state: 'open', draft: false, merged: false, head_ref: '', base_ref: '' },
    };
  },

  is_bot_sender(_payload, _allowList) {
    return false;
  },
};

// ---------------------------------------------------------------------------
// GitHub adapter tests
// ---------------------------------------------------------------------------

describe('webhook server — github adapter', () => {
  const SECRET = 'test-secret';
  const config = makeConfig({ webhooks: { secret: SECRET, path: '/webhook' } });

  // Minimal GitHub issues webhook payload
  const issuePayload = JSON.stringify({
    repository: { full_name: 'example/repo' },
    sender: { login: 'alice', type: 'User' },
    action: 'opened',
    issue: {
      number: 1,
      title: 'Test issue',
      body: 'Body text',
      html_url: 'https://github.com/example/repo/issues/1',
      state: 'open',
      created_at: '2024-01-01T00:00:00Z',
      node_id: 'I_1',
      labels: [],
      user: { login: 'alice', type: 'User' },
    },
  });

  const issueBody = Buffer.from(issuePayload, 'utf8');

  it('accepts a valid delivery and calls onEvent with a normalized Event', async () => {
    let receivedEvent = null;
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: (ev) => { receivedEvent = ev; },
    });

    try {
      const { status, body } = await sendWebhook(port, issueBody, {
        'x-hub-signature-256': githubSig(SECRET, issueBody),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.ok(receivedEvent !== null, 'onEvent should have been called');
      assert.equal(receivedEvent.type, 'issue');
      assert.equal(receivedEvent.source, 'github');
      assert.equal(receivedEvent.repo, 'example/repo');
      assert.equal(receivedEvent.number, 1);
      assert.equal(receivedEvent.author, 'alice');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a delivery with an invalid HMAC signature — 401', async () => {
    const { server, port } = await startServer(config, githubAdapter);

    try {
      const { status, body } = await sendWebhook(port, issueBody, {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-2',
      });

      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a delivery with no signature header — 401', async () => {
    const { server, port } = await startServer(config, githubAdapter);

    try {
      const { status, body } = await sendWebhook(port, issueBody, {
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-3',
      });

      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    } finally {
      await closeServer(server);
    }
  });

  it('returns 200 duplicate on replay (same x-github-delivery)', async () => {
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: () => {},
    });

    try {
      const headers = {
        'x-hub-signature-256': githubSig(SECRET, issueBody),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-replay-1',
      };

      // First delivery — should succeed
      const first = await sendWebhook(port, issueBody, headers);
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'ok');

      // Second delivery with same ID — should be acknowledged as duplicate
      const second = await sendWebhook(port, issueBody, headers);
      assert.equal(second.status, 200);
      assert.equal(second.body.status, 'duplicate');
    } finally {
      await closeServer(server);
    }
  });

  it('drops bot sender events — 200 ignored', async () => {
    let callCount = 0;
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: () => { callCount++; },
    });

    const botPayload = JSON.stringify({
      repository: { full_name: 'example/repo' },
      sender: { login: 'renovate[bot]', type: 'Bot' },
      action: 'opened',
      issue: {
        number: 99,
        title: 'Bot issue',
        body: '',
        html_url: 'https://github.com/example/repo/issues/99',
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        node_id: 'I_99',
        labels: [],
        user: { login: 'renovate[bot]', type: 'Bot' },
      },
    });
    const botBody = Buffer.from(botPayload, 'utf8');

    try {
      const { status, body } = await sendWebhook(port, botBody, {
        'x-hub-signature-256': githubSig(SECRET, botBody),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-bot-1',
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'ignored');
      assert.equal(body.reason, 'bot');
      assert.equal(callCount, 0, 'onEvent must not be called for bot senders');
    } finally {
      await closeServer(server);
    }
  });

  it('returns 200 ignored for unsupported event types', async () => {
    let callCount = 0;
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: () => { callCount++; },
    });

    try {
      const { status, body } = await sendWebhook(port, issueBody, {
        'x-hub-signature-256': githubSig(SECRET, issueBody),
        'x-github-event': 'deployment',   // not in the supported set
        'x-github-delivery': 'delivery-unsupported-1',
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'ignored');
      assert.equal(body.reason, 'unsupported_event_type');
      assert.equal(callCount, 0);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 400 for malformed JSON body (after valid signature)', async () => {
    // Compute a valid signature for the malformed body so verification passes
    const badBody = Buffer.from('not-json', 'utf8');
    const { server, port } = await startServer(config, githubAdapter);

    try {
      const { status, body } = await sendWebhook(port, badBody, {
        'x-hub-signature-256': githubSig(SECRET, badBody),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-malformed-1',
      });

      assert.equal(status, 400);
      assert.equal(body.error, 'invalid json');
    } finally {
      await closeServer(server);
    }
  });

  it('normalizes a pull_request webhook event to type=pr', async () => {
    let receivedEvent = null;
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: (ev) => { receivedEvent = ev; },
    });

    const prPayload = JSON.stringify({
      repository: { full_name: 'example/repo' },
      sender: { login: 'alice', type: 'User' },
      action: 'opened',
      pull_request: {
        number: 7,
        title: 'My PR',
        body: 'PR body',
        html_url: 'https://github.com/example/repo/pull/7',
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        node_id: 'PR_7',
        labels: [],
        draft: false,
        merged: false,
        head: { ref: 'feat/thing' },
        base: { ref: 'main' },
        user: { login: 'alice', type: 'User' },
      },
    });
    const prBody = Buffer.from(prPayload, 'utf8');

    try {
      const { status, body } = await sendWebhook(port, prBody, {
        'x-hub-signature-256': githubSig(SECRET, prBody),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-pr-1',
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.ok(receivedEvent, 'onEvent should be called');
      assert.equal(receivedEvent.type, 'pr');
      assert.equal(receivedEvent.metadata.head_ref, 'feat/thing');
      assert.equal(receivedEvent.metadata.base_ref, 'main');
    } finally {
      await closeServer(server);
    }
  });

  it('normalizes an issue_comment event, body from comment', async () => {
    let receivedEvent = null;
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: (ev) => { receivedEvent = ev; },
    });

    const commentPayload = JSON.stringify({
      repository: { full_name: 'example/repo' },
      sender: { login: 'bob', type: 'User' },
      action: 'created',
      issue: {
        number: 5,
        title: 'Parent issue',
        body: 'Issue body',
        html_url: 'https://github.com/example/repo/issues/5',
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        node_id: 'I_5',
        labels: [],
        user: { login: 'alice', type: 'User' },
      },
      comment: {
        node_id: 'C_10',
        body: 'This is the comment text',
        html_url: 'https://github.com/example/repo/issues/5#issuecomment-10',
        created_at: '2024-01-02T00:00:00Z',
        user: { login: 'bob', type: 'User' },
      },
    });
    const commentBody = Buffer.from(commentPayload, 'utf8');

    try {
      await sendWebhook(port, commentBody, {
        'x-hub-signature-256': githubSig(SECRET, commentBody),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-comment-1',
      });

      assert.ok(receivedEvent, 'onEvent should be called');
      assert.equal(receivedEvent.type, 'issue');
      assert.equal(receivedEvent.body, 'This is the comment text');
      assert.equal(receivedEvent.author, 'bob');
    } finally {
      await closeServer(server);
    }
  });

  it('GET /health returns 200 ok', async () => {
    const { server, port } = await startServer(config, githubAdapter);

    try {
      const { status, body } = await sendGet(port, '/health');
      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
    } finally {
      await closeServer(server);
    }
  });

  it('returns 404 for an unknown path', async () => {
    const { server, port } = await startServer(config, githubAdapter);

    try {
      const { status, body } = await sendGet(port, '/unknown');
      assert.equal(status, 404);
      assert.equal(body.error, 'not found');
    } finally {
      await closeServer(server);
    }
  });

  it('throws synchronously when secret is empty (RT-004)', () => {
    const badConfig = makeConfig({ webhooks: { secret: '', path: '/webhook' } });
    assert.throws(
      () => createServer(badConfig, githubAdapter),
      (err) => {
        assert.ok(err.message.includes('webhooks.secret is empty'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Fake adapter tests — proves server is not GitHub-specific
// ---------------------------------------------------------------------------

describe('webhook server — fake adapter (provider-agnosticism)', () => {
  const SECRET = 'shared-token-value';
  const config = makeConfig({ webhooks: { secret: SECRET, path: '/webhook' } });

  const itemPayload = JSON.stringify({
    id: 42,
    title: 'Fake item',
    body: 'Item body',
    author: 'charlie',
    created_at: '2024-03-01T00:00:00Z',
    url: 'https://fake.example/items/42',
    repo: 'org/project',
  });
  const itemBody = Buffer.from(itemPayload, 'utf8');

  it('accepts a delivery verified by the fake adapter token scheme', async () => {
    let receivedEvent = null;
    const { server, port } = await startServer(config, fakeAdapter, {
      onEvent: (ev) => { receivedEvent = ev; },
    });

    try {
      const { status, body } = await sendWebhook(port, itemBody, {
        'x-fake-token': SECRET,
        'x-fake-event': 'item',
        'x-fake-delivery': 'fake-delivery-1',
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.ok(receivedEvent, 'onEvent should be called');
      assert.equal(receivedEvent.source, 'fake');
      assert.equal(receivedEvent.number, 42);
      assert.equal(receivedEvent.author, 'charlie');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a fake adapter delivery with wrong token — 401', async () => {
    const { server, port } = await startServer(config, fakeAdapter);

    try {
      const { status, body } = await sendWebhook(port, itemBody, {
        'x-fake-token': 'wrong-token',
        'x-fake-event': 'item',
        'x-fake-delivery': 'fake-delivery-2',
      });

      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    } finally {
      await closeServer(server);
    }
  });

  it('replay protection works for the fake adapter', async () => {
    const { server, port } = await startServer(config, fakeAdapter, {
      onEvent: () => {},
    });

    try {
      const headers = {
        'x-fake-token': SECRET,
        'x-fake-event': 'item',
        'x-fake-delivery': 'fake-replay-1',
      };

      const first = await sendWebhook(port, itemBody, headers);
      assert.equal(first.body.status, 'ok');

      const second = await sendWebhook(port, itemBody, headers);
      assert.equal(second.body.status, 'duplicate');
    } finally {
      await closeServer(server);
    }
  });

  it('server does not reference x-hub-signature-256 or x-github-* headers directly', async () => {
    // Read the server source to confirm no GitHub-specific header names are present.
    // This is a static assertion about the codebase modularity guarantee.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/webhooks/server.js', import.meta.url),
      'utf8',
    );
    assert.ok(!src.includes('x-hub-signature-256'), 'server.js must not reference x-hub-signature-256');
    assert.ok(!src.includes('x-github-delivery'), 'server.js must not reference x-github-delivery');
    assert.ok(!src.includes('x-github-event'), 'server.js must not reference x-github-event');
    assert.ok(!src.includes('sha256='), 'server.js must not reference the sha256= HMAC prefix');
  });
});

// ---------------------------------------------------------------------------
// github adapter webhook interface unit tests
// ---------------------------------------------------------------------------

describe('github adapter webhook interface', () => {
  const SECRET = 'my-secret';

  describe('verify_webhook', () => {
    it('returns true for a valid HMAC-SHA256 signature', () => {
      const body = Buffer.from('{"test":1}', 'utf8');
      const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
      const result = githubAdapter.verify_webhook(body, { 'x-hub-signature-256': sig }, SECRET);
      assert.equal(result, true);
    });

    it('returns false for an incorrect signature', () => {
      const body = Buffer.from('{"test":1}', 'utf8');
      const result = githubAdapter.verify_webhook(body, { 'x-hub-signature-256': 'sha256=deadbeef' }, SECRET);
      assert.equal(result, false);
    });

    it('returns false when the signature header is absent', () => {
      const body = Buffer.from('{"test":1}', 'utf8');
      const result = githubAdapter.verify_webhook(body, {}, SECRET);
      assert.equal(result, false);
    });
  });

  describe('get_delivery_id', () => {
    it('returns the x-github-delivery value', () => {
      const id = githubAdapter.get_delivery_id({ 'x-github-delivery': 'abc-123' });
      assert.equal(id, 'abc-123');
    });

    it('returns null when the header is absent', () => {
      const id = githubAdapter.get_delivery_id({});
      assert.equal(id, null);
    });
  });

  describe('normalize_webhook', () => {
    it('normalizes an issues event to type=issue', () => {
      const headers = { 'x-github-event': 'issues' };
      const payload = {
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice', type: 'User' },
        issue: {
          number: 10,
          title: 'A bug',
          body: 'Steps to reproduce',
          html_url: 'https://github.com/org/repo/issues/10',
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          node_id: 'I_10',
          labels: [{ name: 'bug' }],
          user: { login: 'alice', type: 'User' },
        },
      };

      const event = githubAdapter.normalize_webhook(headers, payload);
      assert.ok(event, 'should return a non-null Event');
      assert.equal(event.type, 'issue');
      assert.equal(event.id, 'org/repo#10');
      assert.equal(event.title, 'A bug');
      assert.equal(event.source, 'github');
      assert.deepEqual(event.metadata.labels, ['bug']);
      assert.equal(event.metadata.draft, false);
    });

    it('normalizes a pull_request event to type=pr', () => {
      const headers = { 'x-github-event': 'pull_request' };
      const payload = {
        repository: { full_name: 'org/repo' },
        sender: { login: 'bob', type: 'User' },
        pull_request: {
          number: 3,
          title: 'My PR',
          body: 'PR description',
          html_url: 'https://github.com/org/repo/pull/3',
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          node_id: 'PR_3',
          labels: [],
          draft: true,
          merged: false,
          head: { ref: 'feat/x' },
          base: { ref: 'main' },
          user: { login: 'bob', type: 'User' },
        },
      };

      const event = githubAdapter.normalize_webhook(headers, payload);
      assert.ok(event);
      assert.equal(event.type, 'pr');
      assert.equal(event.metadata.draft, true);
      assert.equal(event.metadata.head_ref, 'feat/x');
      assert.equal(event.metadata.base_ref, 'main');
    });

    it('normalizes an issue_comment event — body from comment', () => {
      const headers = { 'x-github-event': 'issue_comment' };
      const payload = {
        repository: { full_name: 'org/repo' },
        sender: { login: 'carol', type: 'User' },
        issue: {
          number: 5,
          title: 'Issue title',
          body: 'Issue body',
          html_url: 'https://github.com/org/repo/issues/5',
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          node_id: 'I_5',
          labels: [],
          user: { login: 'alice', type: 'User' },
        },
        comment: {
          node_id: 'C_20',
          body: 'Comment text here',
          html_url: 'https://github.com/org/repo/issues/5#issuecomment-20',
          created_at: '2024-02-01T00:00:00Z',
          user: { login: 'carol', type: 'User' },
        },
      };

      const event = githubAdapter.normalize_webhook(headers, payload);
      assert.ok(event);
      assert.equal(event.type, 'issue');
      assert.equal(event.body, 'Comment text here');
      assert.equal(event.author, 'carol');
    });

    it('normalizes a pull_request_review event — body from review', () => {
      const headers = { 'x-github-event': 'pull_request_review' };
      const payload = {
        repository: { full_name: 'org/repo' },
        sender: { login: 'dave', type: 'User' },
        pull_request: {
          number: 8,
          title: 'PR title',
          body: 'PR body',
          html_url: 'https://github.com/org/repo/pull/8',
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          node_id: 'PR_8',
          labels: [],
          draft: false,
          merged: false,
          head: { ref: 'feat/y' },
          base: { ref: 'main' },
          user: { login: 'bob', type: 'User' },
        },
        review: {
          node_id: 'R_5',
          body: 'LGTM with nits',
          html_url: 'https://github.com/org/repo/pull/8#pullrequestreview-5',
          submitted_at: '2024-03-01T00:00:00Z',
          user: { login: 'dave', type: 'User' },
        },
      };

      const event = githubAdapter.normalize_webhook(headers, payload);
      assert.ok(event);
      assert.equal(event.type, 'pr');
      assert.equal(event.body, 'LGTM with nits');
      assert.equal(event.author, 'dave');
    });

    it('returns null for an unsupported event type', () => {
      const headers = { 'x-github-event': 'deployment' };
      const payload = { repository: { full_name: 'org/repo' } };
      const event = githubAdapter.normalize_webhook(headers, payload);
      assert.equal(event, null);
    });
  });

  describe('is_bot_sender', () => {
    it('returns true for sender.type=Bot', () => {
      const payload = { sender: { login: 'dependabot', type: 'Bot' } };
      assert.equal(githubAdapter.is_bot_sender(payload, []), true);
    });

    it('returns true for login ending in [bot]', () => {
      const payload = { sender: { login: 'renovate[bot]', type: 'User' } };
      assert.equal(githubAdapter.is_bot_sender(payload, []), true);
    });

    it('returns false for a human sender', () => {
      const payload = { sender: { login: 'alice', type: 'User' } };
      assert.equal(githubAdapter.is_bot_sender(payload, []), false);
    });

    it('returns false for an allowlisted bot login', () => {
      const payload = { sender: { login: 'trusted-bot[bot]', type: 'Bot' } };
      assert.equal(githubAdapter.is_bot_sender(payload, ['trusted-bot[bot]']), false);
    });
  });
});

// ---------------------------------------------------------------------------
// Adapter wiring contract (regression guard)
//
// cli.js builds the adapter for the webhook server by spreading the whole
// adapter module: `const adapter = { ...adapterModule }`. If the adapter is
// ever built as a hand-picked subset that omits the webhook methods, the
// webhook server calls adapter.verify_webhook (undefined) and every delivery
// 500s. These tests pin the contract the cli relies on.
// ---------------------------------------------------------------------------

describe('adapter wiring contract', () => {
  const SECRET = 'test-secret';
  const WEBHOOK_METHODS = ['verify_webhook', 'get_delivery_id', 'normalize_webhook', 'is_bot_sender'];

  it('cli.loadAdapter produces an adapter with every webhook interface method', async () => {
    // This drives the ACTUAL cli construction path. If cli.js reverts to a
    // hand-picked subset that omits webhook methods, this fails — which is the
    // regression this guards.
    const adapter = await loadAdapter({ source: { adapter: 'github' } });
    for (const m of WEBHOOK_METHODS) {
      assert.equal(
        typeof adapter[m],
        'function',
        `cli.loadAdapter('github') must expose ${m}() for the webhook server`,
      );
    }
  });

  it('an adapter from cli.loadAdapter serves a signed delivery end to end', async () => {
    // Use the real cli construction, not an inline spread, so the server is
    // exercised against exactly what the running CLI would pass it.
    const adapter = await loadAdapter({ source: { adapter: 'github' } });
    const config = makeConfig({ webhooks: { secret: SECRET, path: '/webhook' } });

    let received = null;
    const { server, port } = await startServer(config, adapter, {
      onEvent: (event) => { received = event; },
    });
    try {
      const body = JSON.stringify({
        repository: { full_name: 'org/repo' },
        issue: { number: 7, title: 'Wired', body: 'b', user: { login: 'alice' }, state: 'open', labels: [] },
      });
      const buf = Buffer.from(body, 'utf8');
      const res = await sendWebhook(port, buf, {
        'x-github-event': 'issues',
        'x-github-delivery': 'wire-1',
        'x-hub-signature-256': githubSig(SECRET, buf),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(received, 'onEvent must fire — proves verify_webhook/normalize_webhook resolved');
      assert.equal(received.number, 7);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects an over-size body (declared Content-Length) with a readable 413', async () => {
    // fetch sets Content-Length, so this exercises the fast path: the cap is
    // enforced before any body bytes are read and the client gets a clean 413.
    const adapter = { ...githubAdapter };
    const config = makeConfig({ webhooks: { secret: SECRET, path: '/webhook' } });
    const { server, port } = await startServer(config, adapter);
    try {
      const buf = Buffer.alloc(6 * 1024 * 1024, 0x61);
      const res = await sendWebhook(port, buf, { 'x-github-event': 'issues' });
      assert.equal(res.status, 413);
    } finally {
      await closeServer(server);
    }
  });

  it('bounds memory on a chunked over-size body with no Content-Length (streaming guard)', async () => {
    // A chunked client without Content-Length bypasses the fast path. The
    // streaming guard in readBody must stop accumulating and tear down the
    // socket so memory stays bounded. The client sees a 413 OR a connection
    // reset — either proves the body was not buffered unbounded. What must NOT
    // happen is a 200/normal completion of a 6 MB upload.
    const adapter = { ...githubAdapter };
    const config = makeConfig({ webhooks: { secret: SECRET, path: '/webhook' } });
    const { server, port } = await startServer(config, adapter);
    try {
      const outcome = await new Promise((resolve) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'x-github-event': 'issues' } },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ kind: 'status', status: res.statusCode }));
          },
        );
        req.on('error', () => resolve({ kind: 'reset' }));
        // Stream chunks past the cap without ever setting Content-Length
        // (Node uses Transfer-Encoding: chunked when we write without a length).
        const chunk = Buffer.alloc(512 * 1024, 0x61);
        let written = 0;
        const pump = () => {
          while (written < 7 * 1024 * 1024) {
            written += chunk.length;
            if (!req.write(chunk)) {
              req.once('drain', pump);
              return;
            }
          }
          req.end();
        };
        pump();
      });

      if (outcome.kind === 'status') {
        assert.equal(outcome.status, 413, 'streaming over-size body should be rejected with 413');
      } else {
        assert.equal(outcome.kind, 'reset', 'socket reset is an acceptable bounded-memory outcome');
      }
    } finally {
      await closeServer(server);
    }
  });
});
