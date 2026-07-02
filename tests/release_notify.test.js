/**
 * Tests for src/release_notify.js
 *
 * Uses a fake adapter double — no real GitHub calls. Covers idempotency
 * (re-run is a no-op) and the single-status label transition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyReleaseNotice } from '../src/release_notify.js';

function makeConfig(overrides = {}) {
  return {
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'in-review', 'awaiting-release', 'released'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
    release_notify: { comment_template: 'Shipped in {version}: {task_url}' },
    ...overrides,
  };
}

/**
 * Build a fake adapter with an in-memory comments/labels store so tests can
 * assert idempotent behavior across repeated calls.
 */
function makeFakeAdapter({ initialComments = [], initialLabels = [] } = {}) {
  const state = {
    comments: [...initialComments],
    labels: [...initialLabels],
    postCommentCalls: 0,
    labelCalls: [],
    unlabelCalls: [],
  };

  const adapter = {
    async list_comments() {
      return state.comments;
    },
    async post_comment(_config, _event, body) {
      state.postCommentCalls += 1;
      const url = `https://github.com/owner/repo/issues/1#comment-${state.postCommentCalls}`;
      state.comments.push({ id: state.postCommentCalls, body, html_url: url, user: { login: 'clagentic-triage[bot]', type: 'Bot' } });
      return url;
    },
    async get_item_labels() {
      return state.labels;
    },
    async label_item(_config, _event, labels) {
      state.labelCalls.push(labels);
      for (const l of labels) {
        if (!state.labels.includes(l)) state.labels.push(l);
      }
    },
    async unlabel_item(_config, _event, label) {
      state.unlabelCalls.push(label);
      state.labels = state.labels.filter((l) => l !== label);
    },
  };

  return { adapter, state };
}

function makeTarget(overrides = {}) {
  return {
    repo: 'clagentic/clagentic-console',
    number: 263,
    url: 'https://github.com/clagentic/clagentic-console/issues/263',
    task_id: 'lr-a68f',
    task_url: 'https://lore.example/lr-a68f',
    version: '0.9.0-beta.3',
    ...overrides,
  };
}

describe('applyReleaseNotice', () => {
  it('posts a templated comment and applies the released label on first run', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ initialLabels: ['status/awaiting-release'] });

    const result = await applyReleaseNotice(config, adapter, makeTarget());

    assert.equal(result.posted, true);
    assert.equal(result.labeled, true);
    assert.ok(result.comment_url);
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /Shipped in 0\.9\.0-beta\.3: https:\/\/lore\.example\/lr-a68f/);
    assert.deepEqual(state.labels, ['status/released']);
    assert.deepEqual(state.unlabelCalls, ['status/awaiting-release']);
  });

  it('re-running for the same (task_id, version) is a no-op — idempotent', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ initialLabels: ['status/awaiting-release'] });
    const target = makeTarget();

    const first = await applyReleaseNotice(config, adapter, target);
    assert.equal(first.posted, true);
    assert.equal(first.labeled, true);

    const second = await applyReleaseNotice(config, adapter, target);
    assert.equal(second.posted, false, 're-run must not post a duplicate comment');
    assert.equal(second.labeled, false, 're-run must not re-apply the label');
    assert.equal(state.comments.length, 1, 'exactly one comment must exist after two runs');
    assert.equal(state.postCommentCalls, 1);
  });

  it('re-posts for a different version of the same task_id (not idempotent across versions)', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter();

    await applyReleaseNotice(config, adapter, makeTarget({ version: '0.9.0' }));
    await applyReleaseNotice(config, adapter, makeTarget({ version: '0.9.1' }));

    assert.equal(state.comments.length, 2);
  });

  it('does not duplicate the label if released is already applied but no comment exists yet', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ initialLabels: ['status/released'] });

    const result = await applyReleaseNotice(config, adapter, makeTarget());

    assert.equal(result.posted, true);
    assert.equal(result.labeled, false);
    assert.equal(state.labelCalls.length, 0);
    assert.equal(state.unlabelCalls.length, 0);
  });

  it('renders {repo} and {number} placeholders from the target', async () => {
    const config = makeConfig({ release_notify: { comment_template: '{repo}#{number} shipped in {version}' } });
    const { adapter, state } = makeFakeAdapter();

    await applyReleaseNotice(config, adapter, makeTarget());

    assert.match(state.comments[0].body, /clagentic\/clagentic-console#263 shipped in 0\.9\.0-beta\.3/);
  });

  it('uses the default template when release_notify config is absent', async () => {
    const config = { labels: makeConfig().labels };
    const { adapter, state } = makeFakeAdapter();

    await applyReleaseNotice(config, adapter, makeTarget());

    assert.match(state.comments[0].body, /^Shipped in 0\.9\.0-beta\.3: https:\/\/lore\.example\/lr-a68f/);
  });
});
