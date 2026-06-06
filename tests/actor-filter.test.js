/**
 * Tests for the actor-association filter (DD-008).
 *
 * Covers:
 *   - should_process_actor pure decision function (association buckets + login lists)
 *   - config defaults and validation for watch_associations / ignore_logins / watch_logins
 *   - adapter _normalize now captures metadata.author_association
 *   - webhook ingress: MEMBER-authored delivery is acked + ignored, onEvent NOT called
 *   - poll ingress: MEMBER-authored items excluded from list_events output
 *
 * Run with: node --test tests/actor-filter.test.js
 */

import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  should_process_actor,
  actor_allowed,
  normalize_webhook,
  list_events,
} from '../src/adapters/github.js';
import * as githubAdapter from '../src/adapters/github.js';
import { createServer } from '../src/webhooks/server.js';
import { loadConfig, ConfigError } from '../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a config.source matching loader defaults for the actor filter. */
function defaultSource(overrides = {}) {
  return {
    adapter: 'github',
    org: null,
    repos: ['example/repo'],
    poll_interval_seconds: 60,
    allow_bot_logins: [],
    watch_associations: ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN'],
    ignore_logins: [],
    watch_logins: [],
    ...overrides,
  };
}

function makeConfig(sourceOverrides = {}) {
  return { source: defaultSource(sourceOverrides) };
}

/** Load config from an isolated temp cwd with a clean env. */
async function loadIsolated(opts = {}) {
  const { env = {}, configObj } = opts;
  const dir = join(tmpdir(), `triage-actor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  if (configObj !== undefined) {
    await writeFile(join(dir, 'triage.config.json'), JSON.stringify(configObj), 'utf8');
  }
  try {
    return await loadConfig({ cwd: dir, _env: { ...env } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// should_process_actor — association buckets
// ---------------------------------------------------------------------------

describe('should_process_actor — association buckets (default config)', () => {
  const config = makeConfig();

  it('processes an external CONTRIBUTOR', () => {
    assert.equal(should_process_actor(config, { author: 'ext', author_association: 'CONTRIBUTOR' }), true);
  });

  it('processes NONE (anonymous external)', () => {
    assert.equal(should_process_actor(config, { author: 'ext', author_association: 'NONE' }), true);
  });

  it('filters out MEMBER', () => {
    assert.equal(should_process_actor(config, { author: 'teammate', author_association: 'MEMBER' }), false);
  });

  it('filters out OWNER', () => {
    assert.equal(should_process_actor(config, { author: 'boss', author_association: 'OWNER' }), false);
  });

  it('filters out COLLABORATOR', () => {
    assert.equal(should_process_actor(config, { author: 'collab', author_association: 'COLLABORATOR' }), false);
  });
});

// ---------------------------------------------------------------------------
// should_process_actor — login overrides
// ---------------------------------------------------------------------------

describe('should_process_actor — login overrides', () => {
  it('ignore_logins denies even an external (CONTRIBUTOR) login', () => {
    const config = makeConfig({ ignore_logins: ['noisy-ext'] });
    assert.equal(should_process_actor(config, { author: 'noisy-ext', author_association: 'CONTRIBUTOR' }), false);
  });

  it('watch_logins allows even a MEMBER login', () => {
    const config = makeConfig({ watch_logins: ['watched-member'] });
    assert.equal(should_process_actor(config, { author: 'watched-member', author_association: 'MEMBER' }), true);
  });

  it('ignore_logins wins over watch_logins (same login in both → denied)', () => {
    const config = makeConfig({ ignore_logins: ['dual'], watch_logins: ['dual'] });
    assert.equal(should_process_actor(config, { author: 'dual', author_association: 'CONTRIBUTOR' }), false);
  });
});

// ---------------------------------------------------------------------------
// should_process_actor — fail-open on unknown association
// ---------------------------------------------------------------------------

describe('should_process_actor — null/unknown association (fail-open)', () => {
  const config = makeConfig();

  it('processes a null association (fail-open toward triage)', () => {
    assert.equal(should_process_actor(config, { author: 'mystery', author_association: null }), true);
  });

  it('processes a missing association field', () => {
    assert.equal(should_process_actor(config, { author: 'mystery' }), true);
  });

  it('but ignore_logins still denies a null-association login', () => {
    const c = makeConfig({ ignore_logins: ['mystery'] });
    assert.equal(should_process_actor(c, { author: 'mystery', author_association: null }), false);
  });
});

// ---------------------------------------------------------------------------
// Config defaults + validation
// ---------------------------------------------------------------------------

describe('config — actor-filter defaults and validation', () => {
  test('defaults: watch_associations is the external set; login lists empty', async () => {
    const cfg = await loadIsolated();
    assert.deepEqual(cfg.source.watch_associations, [
      'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN',
    ]);
    assert.deepEqual(cfg.source.ignore_logins, []);
    assert.deepEqual(cfg.source.watch_logins, []);
  });

  test('env overrides populate the three fields (comma-separated)', async () => {
    const cfg = await loadIsolated({
      env: {
        CLAGENTIC_TRIAGE_WATCH_ASSOCIATIONS: 'MEMBER, OWNER',
        CLAGENTIC_TRIAGE_IGNORE_LOGINS: 'naomi, self',
        CLAGENTIC_TRIAGE_WATCH_LOGINS: 'special-member',
      },
    });
    assert.deepEqual(cfg.source.watch_associations, ['MEMBER', 'OWNER']);
    assert.deepEqual(cfg.source.ignore_logins, ['naomi', 'self']);
    assert.deepEqual(cfg.source.watch_logins, ['special-member']);
  });

  test('unknown association in watch_associations → ConfigError', async () => {
    await assert.rejects(
      () => loadIsolated({ configObj: { source: { watch_associations: ['MEMBER', 'BOGUS'] } } }),
      (err) => {
        assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}`);
        assert.ok(err.message.includes('watch_associations'), `message: ${err.message}`);
        assert.ok(err.message.includes('BOGUS'), `message: ${err.message}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter _normalize captures author_association (via normalize_webhook)
// ---------------------------------------------------------------------------

describe('adapter — author_association captured in metadata', () => {
  it('normalize_webhook records issue author_association on metadata', () => {
    const event = normalize_webhook(
      { 'x-github-event': 'issues' },
      {
        repository: { full_name: 'org/repo' },
        sender: { login: 'ext', type: 'User' },
        issue: {
          number: 1,
          title: 't',
          body: 'b',
          html_url: 'https://github.com/org/repo/issues/1',
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          node_id: 'I_1',
          labels: [],
          user: { login: 'ext', type: 'User' },
          author_association: 'FIRST_TIME_CONTRIBUTOR',
        },
      },
    );
    assert.equal(event.metadata.author_association, 'FIRST_TIME_CONTRIBUTOR');
  });

  it('defaults author_association to null when absent', () => {
    const event = normalize_webhook(
      { 'x-github-event': 'issues' },
      {
        repository: { full_name: 'org/repo' },
        issue: { number: 2, user: { login: 'x' }, state: 'open', labels: [] },
      },
    );
    assert.equal(event.metadata.author_association, null);
  });

  it('issue_comment carries through the parent issue association when comment lacks one', () => {
    const event = normalize_webhook(
      { 'x-github-event': 'issue_comment' },
      {
        repository: { full_name: 'org/repo' },
        issue: {
          number: 5,
          state: 'open',
          labels: [],
          user: { login: 'alice' },
          author_association: 'MEMBER',
        },
        comment: { body: 'hi', user: { login: 'alice' } },
      },
    );
    assert.equal(event.metadata.author_association, 'MEMBER');
  });
});

// ---------------------------------------------------------------------------
// actor_allowed (adapter webhook-interface method, operates on Event)
// ---------------------------------------------------------------------------

describe('actor_allowed — operates on a normalized Event', () => {
  const config = makeConfig();

  it('returns false for a MEMBER-authored event', () => {
    const event = { author: 'm', metadata: { author_association: 'MEMBER' } };
    assert.equal(actor_allowed(config, event), false);
  });

  it('returns true for a CONTRIBUTOR-authored event', () => {
    const event = { author: 'c', metadata: { author_association: 'CONTRIBUTOR' } };
    assert.equal(actor_allowed(config, event), true);
  });
});

// ---------------------------------------------------------------------------
// Webhook ingress — MEMBER delivery filtered (parallel to bot-filter test)
// ---------------------------------------------------------------------------

describe('webhook ingress — actor filter (DD-008)', () => {
  const SECRET = 'test-secret';

  function webhookConfig() {
    return {
      webhooks: { secret: SECRET, path: '/webhook' },
      source: defaultSource(),
    };
  }

  function githubSig(secret, body) {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  }

  function startServer(config, adapter, opts = {}) {
    return new Promise((resolve, reject) => {
      const server = createServer(config, adapter, opts);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
      server.once('error', reject);
    });
  }

  function closeServer(server) {
    return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }

  async function sendWebhook(port, body, headers) {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength), ...headers },
      body,
    });
    return { status: res.status, body: await res.json() };
  }

  it('a MEMBER-authored delivery → 200 ignored, onEvent NOT called', async () => {
    let callCount = 0;
    const config = webhookConfig();
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: () => { callCount++; },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'example/repo' },
      sender: { login: 'teammate', type: 'User' },
      action: 'opened',
      issue: {
        number: 11,
        title: 'Internal issue',
        body: '',
        html_url: 'https://github.com/example/repo/issues/11',
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        node_id: 'I_11',
        labels: [],
        user: { login: 'teammate', type: 'User' },
        author_association: 'MEMBER',
      },
    });
    const buf = Buffer.from(payload, 'utf8');

    try {
      const { status, body } = await sendWebhook(port, buf, {
        'x-hub-signature-256': githubSig(SECRET, buf),
        'x-github-event': 'issues',
        'x-github-delivery': 'actor-member-1',
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'ignored');
      assert.equal(body.reason, 'actor');
      assert.equal(callCount, 0, 'onEvent must not be called for an internal MEMBER');
    } finally {
      await closeServer(server);
    }
  });

  it('an external CONTRIBUTOR delivery → 200 ok, onEvent called', async () => {
    let received = null;
    const config = webhookConfig();
    const { server, port } = await startServer(config, githubAdapter, {
      onEvent: (ev) => { received = ev; },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'example/repo' },
      sender: { login: 'outsider', type: 'User' },
      action: 'opened',
      issue: {
        number: 12,
        title: 'External issue',
        body: 'help',
        html_url: 'https://github.com/example/repo/issues/12',
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        node_id: 'I_12',
        labels: [],
        user: { login: 'outsider', type: 'User' },
        author_association: 'CONTRIBUTOR',
      },
    });
    const buf = Buffer.from(payload, 'utf8');

    try {
      const { status, body } = await sendWebhook(port, buf, {
        'x-hub-signature-256': githubSig(SECRET, buf),
        'x-github-event': 'issues',
        'x-github-delivery': 'actor-ext-1',
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.ok(received, 'onEvent should fire for an external contributor');
      assert.equal(received.author, 'outsider');
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Poll ingress — MEMBER items excluded from list_events
// ---------------------------------------------------------------------------

describe('poll ingress — actor filter excludes internal items', () => {
  let _originalFetch;
  beforeEach(() => { _originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = _originalFetch; });

  function pollConfig(sourceOverrides = {}) {
    return {
      source: defaultSource(sourceOverrides),
      github_token: () => 'ghp_test',
    };
  }

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: { get: (k) => ({ 'X-RateLimit-Remaining': '999', 'X-RateLimit-Reset': '0' }[k] ?? null) },
      json: async () => body,
    };
  }

  function rawIssue(num, login, assoc) {
    return {
      number: num,
      title: `issue ${num}`,
      body: '',
      html_url: `https://github.com/example/repo/issues/${num}`,
      state: 'open',
      created_at: '2024-01-01T00:00:00Z',
      node_id: `I_${num}`,
      labels: [],
      user: { login, type: 'User' },
      author_association: assoc,
    };
  }

  it('excludes MEMBER/OWNER items, keeps external ones', async () => {
    const items = [
      rawIssue(1, 'alice', 'CONTRIBUTOR'),     // keep
      rawIssue(2, 'boss', 'OWNER'),            // drop
      rawIssue(3, 'teammate', 'MEMBER'),       // drop
      rawIssue(4, 'newbie', 'FIRST_TIMER'),    // keep
    ];
    globalThis.fetch = async () => mockResponse(200, items);

    const events = await list_events(pollConfig(), '2024-01-01T00:00:00Z');
    const numbers = events.map((e) => e.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 4]);
  });

  it('ignore_logins drops an external login on the poll path', async () => {
    const items = [
      rawIssue(1, 'alice', 'CONTRIBUTOR'),
      rawIssue(2, 'noisy', 'CONTRIBUTOR'),
    ];
    globalThis.fetch = async () => mockResponse(200, items);

    const events = await list_events(pollConfig({ ignore_logins: ['noisy'] }), '2024-01-01T00:00:00Z');
    assert.deepEqual(events.map((e) => e.number), [1]);
  });

  it('watch_logins keeps a MEMBER on the poll path', async () => {
    const items = [
      rawIssue(1, 'teammate', 'MEMBER'),       // drop by default
      rawIssue(2, 'watched', 'MEMBER'),        // kept via watch_logins
    ];
    globalThis.fetch = async () => mockResponse(200, items);

    const events = await list_events(pollConfig({ watch_logins: ['watched'] }), '2024-01-01T00:00:00Z');
    assert.deepEqual(events.map((e) => e.number), [2]);
  });
});
