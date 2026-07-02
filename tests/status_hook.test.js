/**
 * Tests for src/status_hook.js
 *
 * Exercises the generic inbound "task shipped" callback server end-to-end
 * over real HTTP (ephemeral port), with a fake adapter double standing in
 * for the source adapter.
 *
 * Security cases covered (T3, lr-f848 acceptance):
 *   - Valid HMAC signature — 200, release notice applied
 *   - Missing signature header — 401 (unauthenticated call rejected)
 *   - Invalid HMAC signature — 401
 *   - Unknown task_id — 200 { status: 'unknown_task_id' }, no adapter action taken
 *   - Idempotent re-run — second call for the same version is a no-op
 *   - createStatusHookServer throws when secret is empty (RT-004 parity)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { createStatusHookServer, verify_status_hook } from '../src/status_hook.js';
import { recordTask } from '../src/task_index.js';

function tmpIndexPath() {
  const unique = randomBytes(6).toString('hex');
  return join(tmpdir(), `triage-status-hook-test-${unique}`, 'task-index.jsonl');
}

function makeConfig(overrides = {}) {
  return {
    status_hooks: { secret: 'hook-secret', path: '/status-hook', ...(overrides.status_hooks ?? {}) },
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'awaiting-release', 'released'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
    release_notify: { comment_template: 'Shipped in {version}: {task_url}' },
    task_index: tmpIndexPath(),
    ...overrides,
  };
}

function makeFakeAdapter() {
  const state = { comments: [], labels: ['status/awaiting-release'], postCommentCalls: 0 };
  return {
    state,
    adapter: {
      async list_comments() { return state.comments; },
      async post_comment(_c, _e, body) {
        state.postCommentCalls += 1;
        state.comments.push({ body });
        return `https://github.com/example/repo/issues/1#comment-${state.postCommentCalls}`;
      },
      async get_item_labels() { return state.labels; },
      async label_item(_c, _e, labels) {
        for (const l of labels) if (!state.labels.includes(l)) state.labels.push(l);
      },
      async unlabel_item(_c, _e, label) {
        state.labels = state.labels.filter((l) => l !== label);
      },
    },
  };
}

function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function startServer(config, adapter) {
  return new Promise((resolve, reject) => {
    const server = createStatusHookServer(config, adapter);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function post(port, path, bodyStr, headers = {}) {
  const buf = Buffer.from(bodyStr, 'utf8');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(buf.byteLength), ...headers },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

describe('verify_status_hook', () => {
  it('accepts a valid signature', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const sig = sign('s3cr3t', body);
    assert.equal(verify_status_hook(body, { 'x-clagentic-signature': sig }, 's3cr3t'), true);
  });

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    assert.equal(verify_status_hook(body, {}, 's3cr3t'), false);
  });

  it('rejects an invalid signature', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    assert.equal(verify_status_hook(body, { 'x-clagentic-signature': 'sha256=deadbeef' }, 's3cr3t'), false);
  });
});

describe('createStatusHookServer — RT-004 parity', () => {
  it('throws if status_hooks.secret is empty', () => {
    const config = makeConfig({ status_hooks: { secret: '', path: '/status-hook' } });
    const { adapter } = makeFakeAdapter();
    assert.throws(() => createStatusHookServer(config, adapter), /status_hooks\.secret is empty/);
  });
});

describe('status-hook server — HTTP', () => {
  it('rejects an unauthenticated call with 401 (no signature header)', async () => {
    const config = makeConfig();
    const { adapter } = makeFakeAdapter();
    const { server, port } = await startServer(config, adapter);
    try {
      const payload = JSON.stringify({ task_id: 'lr-a68f', status: 'shipped', version: '1.0.0' });
      const { status, body } = await post(port, '/status-hook', payload);
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a call with an invalid signature — 401', async () => {
    const config = makeConfig();
    const { adapter } = makeFakeAdapter();
    const { server, port } = await startServer(config, adapter);
    try {
      const payload = JSON.stringify({ task_id: 'lr-a68f', status: 'shipped', version: '1.0.0' });
      const { status, body } = await post(port, '/status-hook', payload, {
        'x-clagentic-signature': 'sha256=deadbeef',
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    } finally {
      await closeServer(server);
    }
  });

  it('returns unknown_task_id for a task_id not in the index (does not throw)', async () => {
    const config = makeConfig();
    const { adapter } = makeFakeAdapter();
    const { server, port } = await startServer(config, adapter);
    try {
      const payload = JSON.stringify({ task_id: 'does-not-exist', status: 'shipped', version: '1.0.0' });
      const { status, body } = await post(port, '/status-hook', payload, {
        'x-clagentic-signature': sign(config.status_hooks.secret, payload),
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'unknown_task_id');
    } finally {
      await closeServer(server);
    }
  });

  it('acknowledges but ignores an unsupported status value', async () => {
    const config = makeConfig();
    const { adapter } = makeFakeAdapter();
    const { server, port } = await startServer(config, adapter);
    try {
      const payload = JSON.stringify({ task_id: 'lr-a68f', status: 'in_progress' });
      const { status, body } = await post(port, '/status-hook', payload, {
        'x-clagentic-signature': sign(config.status_hooks.secret, payload),
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'ignored');
      assert.equal(body.reason, 'unsupported_status');
    } finally {
      await closeServer(server);
    }
  });

  describe('acceptance case: lr-a68f / console#263', () => {
    it('fires the shipped hook -> post_comment + released label land; re-run is a no-op', async () => {
      const config = makeConfig();
      const { adapter, state } = makeFakeAdapter();

      await recordTask(config, {
        dispatcher: 'lore',
        task_id: 'lr-a68f',
        task_url: 'https://lore.example/lr-a68f',
        event_id: 'clagentic/clagentic-console#263',
        repo: 'clagentic/clagentic-console',
        number: 263,
        event_url: 'https://github.com/clagentic/clagentic-console/issues/263',
      });

      const { server, port } = await startServer(config, adapter);
      try {
        const payload = JSON.stringify({
          task_id: 'lr-a68f', dispatcher: 'lore', status: 'shipped', version: '0.9.0-beta.3',
        });
        const sig = sign(config.status_hooks.secret, payload);

        const first = await post(port, '/status-hook', payload, { 'x-clagentic-signature': sig });
        assert.equal(first.status, 200);
        assert.equal(first.body.status, 'ok');
        assert.equal(first.body.posted, true);
        assert.equal(first.body.labeled, true);
        assert.equal(state.comments.length, 1);
        assert.ok(state.labels.includes('status/released'));

        // Re-run with an identical payload — idempotent no-op.
        const second = await post(port, '/status-hook', payload, { 'x-clagentic-signature': sig });
        assert.equal(second.status, 200);
        assert.equal(second.body.posted, false);
        assert.equal(second.body.labeled, false);
        assert.equal(state.comments.length, 1, 'no duplicate comment on re-run');
        assert.equal(state.postCommentCalls, 1);
      } finally {
        await closeServer(server);
      }
    });
  });
});
