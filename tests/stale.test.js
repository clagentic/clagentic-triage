/**
 * Tests for src/stale.js — needs-info idle auto-close (T10, lr-9e35).
 *
 * Uses a fake adapter double — no real GitHub calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkStaleNeedsInfo } from '../src/stale.js';

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeConfig(overrides = {}) {
  return {
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'needs-info', 'accepted'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
    stale: {
      enabled: true,
      needs_info_days: 60,
      close_after_days: 7,
      exempt_labels: [],
      stale_comment_template: 'idle for {days} days, closing in {close_after_days} days',
      close_comment_template: 'closing now',
    },
    ...overrides,
  };
}

function makeIssue({ number = 1, labels = ['status/needs-info'], updatedAt, comments = [] } = {}) {
  return {
    id: `owner/repo#${number}`,
    type: 'issue',
    repo: 'owner/repo',
    number,
    created_at: updatedAt ?? new Date().toISOString(),
    metadata: { labels, updated_at: updatedAt ?? new Date().toISOString() },
    _comments: comments,
  };
}

function makeFakeAdapter(issues) {
  const calls = { posted: [], closed: [] };
  const adapter = {
    async list_issues_by_label() {
      return issues;
    },
    async list_comments(_config, event) {
      const issue = issues.find((i) => i.number === event.number);
      return (issue?._comments ?? []).map((body) => ({ body }));
    },
    async post_comment(_config, event, body) {
      calls.posted.push({ number: event.number, body });
    },
    async close_item(_config, event) {
      calls.closed.push({ number: event.number });
    },
  };
  return { adapter, calls };
}

describe('checkStaleNeedsInfo', () => {
  it('is a no-op when stale.enabled is false', async () => {
    const config = makeConfig({ stale: { enabled: false } });
    const { adapter, calls } = makeFakeAdapter([makeIssue({ updatedAt: daysAgo(100) })]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 0, warned: 0, closed: 0 });
    assert.equal(calls.posted.length, 0);
    assert.equal(calls.closed.length, 0);
  });

  it('does nothing for an issue idle less than needs_info_days', async () => {
    const config = makeConfig();
    const { adapter, calls } = makeFakeAdapter([makeIssue({ updatedAt: daysAgo(10) })]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 1, warned: 0, closed: 0 });
    assert.equal(calls.posted.length, 0);
  });

  it('posts a warning comment once idle >= needs_info_days and < needs_info_days + close_after_days', async () => {
    const config = makeConfig();
    const { adapter, calls } = makeFakeAdapter([makeIssue({ updatedAt: daysAgo(63) })]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 1, warned: 1, closed: 0 });
    assert.equal(calls.posted.length, 1);
    assert.match(calls.posted[0].body, /idle for 63 days, closing in 7 days/);
    assert.match(calls.posted[0].body, /clagentic-triage:stale-warning/);
  });

  it('does not re-warn an issue that already carries the warning marker', async () => {
    const config = makeConfig();
    const { adapter, calls } = makeFakeAdapter([
      makeIssue({ updatedAt: daysAgo(63), comments: ['<!-- clagentic-triage:stale-warning -->'] }),
    ]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 1, warned: 0, closed: 0 });
    assert.equal(calls.posted.length, 0);
  });

  it('closes an issue once idle >= needs_info_days + close_after_days, posting the close comment first', async () => {
    const config = makeConfig();
    const { adapter, calls } = makeFakeAdapter([makeIssue({ updatedAt: daysAgo(70) })]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 1, warned: 0, closed: 1 });
    assert.equal(calls.closed.length, 1);
    assert.equal(calls.posted.length, 1);
    assert.equal(calls.posted[0].body, 'closing now');
  });

  it('skips an issue carrying an exempt label entirely', async () => {
    const config = makeConfig({
      stale: {
        enabled: true,
        needs_info_days: 60,
        close_after_days: 7,
        exempt_labels: ['pinned'],
        stale_comment_template: 'x',
        close_comment_template: 'y',
      },
    });
    const { adapter, calls } = makeFakeAdapter([
      makeIssue({ updatedAt: daysAgo(100), labels: ['status/needs-info', 'pinned'] }),
    ]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 1, warned: 0, closed: 0 });
    assert.equal(calls.posted.length, 0);
    assert.equal(calls.closed.length, 0);
  });

  it('checks every issue independently across a batch', async () => {
    const config = makeConfig();
    const { adapter, calls } = makeFakeAdapter([
      makeIssue({ number: 1, updatedAt: daysAgo(10) }), // fresh — no action
      makeIssue({ number: 2, updatedAt: daysAgo(63) }), // warn
      makeIssue({ number: 3, updatedAt: daysAgo(80) }), // close
    ]);

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.deepEqual(result, { checked: 3, warned: 1, closed: 1 });
    assert.deepEqual(calls.closed, [{ number: 3 }]);
  });

  it('still closes the issue even if the close-comment post fails', async () => {
    const config = makeConfig();
    const issues = [makeIssue({ updatedAt: daysAgo(70) })];
    const calls = { closed: [] };
    const adapter = {
      async list_issues_by_label() { return issues; },
      async list_comments() { return []; },
      async post_comment() { throw new Error('comment API down'); },
      async close_item(_config, event) { calls.closed.push({ number: event.number }); },
    };

    const result = await checkStaleNeedsInfo(config, adapter);

    assert.equal(result.closed, 1);
    assert.deepEqual(calls.closed, [{ number: 1 }]);
  });
});
