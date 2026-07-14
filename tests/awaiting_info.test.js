/**
 * Tests for src/awaiting_info.js (lr-910ca2) — awaiting_info classification,
 * reply detection, and reply-triggered re-assessment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAwaitingInfoVerdict,
  resolveQueueReason,
  needsInfoLabel,
  findQualifyingReply,
  reassessAwaitingInfoItem,
  processAwaitingInfoItems,
} from '../src/awaiting_info.js';
import { QueueError } from '../src/queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return {
    confidence_threshold: 0.7,
    auto_approve: [],
    pending_queue: '.triage/pending-test.jsonl',
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#328',
    type: 'issue',
    title: 'Something broke',
    body: 'It does not work.',
    author: 'bradorchard',
    repo: 'owner/repo',
    number: 328,
    metadata: {},
    ...overrides,
  };
}

function makeAssessment(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.9,
    reasoning: 'Need the console version to reproduce.',
    suggested_action: {
      classes: ['respond', 'dispatch'],
      body: 'Which version of @clagentic/console are you running?',
      dispatch_target: null,
      labels: [],
    },
    model_used: 'test-model',
    assessed_at: '2026-07-10T00:00:00Z',
    event_id: 'owner/repo#328',
    ...overrides,
  };
}

function makeQueueItem(overrides = {}) {
  return {
    id: 'item-1',
    queued_at: '2026-07-10T00:00:00.000Z',
    queue_reason: 'awaiting_info',
    event: makeEvent(),
    assessment: makeAssessment(),
    status: 'pending',
    resolved_at: null,
    resolved_action: null,
    dispatch_results: null,
    ...overrides,
  };
}

function makeComment({ login = 'bradorchard', type = 'User', body = 'v1.2.3', created_at } = {}) {
  return { user: { login, type }, body, created_at };
}

// ---------------------------------------------------------------------------
// isAwaitingInfoVerdict / resolveQueueReason
// ---------------------------------------------------------------------------

describe('isAwaitingInfoVerdict', () => {
  it('is true for a respond-with-body verdict mixed with another class', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond', 'dispatch'], body: 'Please clarify X.', dispatch_target: null, labels: [] },
    });
    assert.equal(isAwaitingInfoVerdict(assessment), true);
  });

  it('is false for a respond-only verdict (nothing else pending)', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: 'Thanks!', dispatch_target: null, labels: [] },
    });
    assert.equal(isAwaitingInfoVerdict(assessment), false);
  });

  it('is false when respond has no body', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond', 'dispatch'], body: null, dispatch_target: null, labels: [] },
    });
    assert.equal(isAwaitingInfoVerdict(assessment), false);
  });

  it('is false when respond has a blank/whitespace-only body', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond', 'dispatch'], body: '   ', dispatch_target: null, labels: [] },
    });
    assert.equal(isAwaitingInfoVerdict(assessment), false);
  });

  it('is false when the verdict has no respond class at all', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: null, labels: [] },
    });
    assert.equal(isAwaitingInfoVerdict(assessment), false);
  });

  it('normalizes a legacy singular suggested_action.class', () => {
    const assessment = makeAssessment({
      suggested_action: { class: 'respond', body: 'hi', dispatch_target: null, labels: [] },
    });
    // Singular 'class' normalizes to a one-element list — no "other class"
    // present, so this is not awaiting_info.
    assert.equal(isAwaitingInfoVerdict(assessment), false);
  });
});

describe('resolveQueueReason', () => {
  it('returns awaiting_info when the verdict qualifies', () => {
    const assessment = makeAssessment();
    assert.equal(resolveQueueReason(assessment, 'awaiting_approval'), 'awaiting_info');
  });

  it('returns the default reason when the verdict does not qualify', () => {
    const assessment = makeAssessment({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: null, labels: [] },
    });
    assert.equal(resolveQueueReason(assessment, 'awaiting_approval'), 'awaiting_approval');
  });

  it('never reclassifies low_confidence, even for a qualifying verdict', () => {
    const assessment = makeAssessment();
    assert.equal(resolveQueueReason(assessment, 'low_confidence'), 'low_confidence');
  });
});

describe('needsInfoLabel', () => {
  it('uses the default status namespace', () => {
    assert.equal(needsInfoLabel({}), 'status/needs-info');
  });

  it('respects a custom status_namespace', () => {
    const config = { labels: { status_namespace: 'lifecycle' } };
    assert.equal(needsInfoLabel(config), 'lifecycle/needs-info');
  });
});

// ---------------------------------------------------------------------------
// findQualifyingReply
// ---------------------------------------------------------------------------

describe('findQualifyingReply', () => {
  it('returns null when there is no reply at all', async () => {
    const item = makeQueueItem();
    const adapter = { list_comments: async () => [] };
    const reply = await findQualifyingReply(makeConfig(), adapter, item);
    assert.equal(reply, null);
  });

  it('returns null when the only new comment is from the triage bot itself', async () => {
    const item = makeQueueItem();
    const adapter = {
      list_comments: async () => [
        makeComment({ login: 'clagentic-triage[bot]', type: 'Bot', created_at: '2026-07-13T00:00:00Z' }),
      ],
    };
    const reply = await findQualifyingReply(makeConfig(), adapter, item);
    assert.equal(reply, null);
  });

  it('returns null when the only new comment predates the waiting-since marker', async () => {
    const item = makeQueueItem({ queued_at: '2026-07-10T00:00:00.000Z' });
    const adapter = {
      list_comments: async () => [makeComment({ created_at: '2026-07-09T00:00:00Z' })],
    };
    const reply = await findQualifyingReply(makeConfig(), adapter, item);
    assert.equal(reply, null);
  });

  it('finds a qualifying non-bot reply posted after the waiting-since marker', async () => {
    const item = makeQueueItem({ queued_at: '2026-07-10T00:00:00.000Z' });
    const reply = makeComment({ created_at: '2026-07-14T00:00:00Z', body: 'running v1.2.3' });
    const adapter = { list_comments: async () => [reply] };

    const found = await findQualifyingReply(makeConfig(), adapter, item);
    assert.equal(found, reply);
  });

  it('prefers awaiting_info_since over queued_at when both are present', async () => {
    const item = makeQueueItem({
      queued_at: '2026-07-01T00:00:00.000Z',
      awaiting_info_since: '2026-07-13T00:00:00.000Z',
    });
    // Posted after queued_at but BEFORE awaiting_info_since — should not qualify.
    const adapter = {
      list_comments: async () => [makeComment({ created_at: '2026-07-05T00:00:00Z' })],
    };
    const reply = await findQualifyingReply(makeConfig(), adapter, item);
    assert.equal(reply, null);
  });
});

// ---------------------------------------------------------------------------
// reassessAwaitingInfoItem — uses a real temp-file queue (fs-backed)
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, readAll } from '../src/queue.js';

function tmpQueuePath() {
  return join(tmpdir(), `triage-awaiting-info-test-${randomBytes(6).toString('hex')}`, 'pending.jsonl');
}

describe('reassessAwaitingInfoItem', () => {
  it('resolves the stale entry as superseded and enqueues a fresh verdict via normal router rules', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath(), auto_approve: [] });
    const enqueued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    const reply = makeComment({ created_at: '2026-07-14T00:00:00Z', body: 'v1.2.3' });
    const adapter = { list_comments: async () => [reply] };

    const freshAssessment = makeAssessment({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: 'lore', labels: [] },
    });
    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => freshAssessment,
    };

    const result = await reassessAwaitingInfoItem(config, adapter, enqueued, reply, deps);

    // 'dispatch' is not in auto_approve, so route()'s default HITL rule
    // queues it as 'awaiting_approval' — normal router.js rules, no special
    // extra-caution gate (explicit design decision for this task).
    assert.equal(result.should_dispatch, false);
    assert.ok(result.new_item, 'a fresh queue item should have been enqueued');
    assert.equal(result.new_item.queue_reason, 'awaiting_approval');
    assert.equal(result.new_item.status, 'pending');

    const all = await readAll(config);
    const old = all.find((i) => i.id === enqueued.id);
    assert.equal(old.status, 'superseded');
    assert.notEqual(old.resolved_at, null);

    const fresh = all.find((i) => i.id === result.new_item.id);
    assert.ok(fresh, 'fresh item should be present in the queue file');
    assert.equal(fresh.assessment.suggested_action.classes[0], 'dispatch');
  });

  it('folds the reply into the event body passed to enrich/assess', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath() });
    const enqueued = await enqueue(config, {
      event: makeEvent({ body: 'Original report.' }),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    const reply = makeComment({ login: 'bradorchard', created_at: '2026-07-14T00:00:00Z', body: 'v1.2.3' });
    const adapter = { list_comments: async () => [reply] };

    let seenBody = null;
    const deps = {
      enrich: async (_c, event) => {
        seenBody = event.body;
        return { ...event, context: {} };
      },
      assess: async () => makeAssessment({ suggested_action: { classes: ['close'], body: null, dispatch_target: null, labels: [] } }),
    };

    await reassessAwaitingInfoItem(config, adapter, enqueued, reply, deps);

    assert.match(seenBody, /Original report\./);
    assert.match(seenBody, /bradorchard/);
    assert.match(seenBody, /v1\.2\.3/);
  });

  it('dispatches immediately (no new queue item) when the fresh verdict clears auto_approve', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath(), auto_approve: ['close'] });
    const enqueued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    const reply = makeComment({ created_at: '2026-07-14T00:00:00Z' });
    const adapter = { list_comments: async () => [reply] };
    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => makeAssessment({
        confidence: 0.95,
        suggested_action: { classes: ['close'], body: null, dispatch_target: null, labels: [] },
      }),
    };

    const result = await reassessAwaitingInfoItem(config, adapter, enqueued, reply, deps);

    assert.equal(result.should_dispatch, true);
    assert.equal(result.new_item, null);

    const all = await readAll(config);
    assert.equal(all.length, 1); // only the resolved 'superseded' entry — nothing new enqueued
    assert.equal(all[0].status, 'superseded');
  });

  it('backs off without enqueueing a duplicate when the item was already resolved (double-processing guard)', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath() });
    const enqueued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    // Simulate a concurrent resolution (e.g. stale.js's idle-close sweep, or
    // a human override) that already resolved the item before this
    // re-assessment call's resolveItem runs.
    const { resolveItem } = await import('../src/queue.js');
    await resolveItem(config, enqueued.id, { action: 'overridden', resolved_action_class: 'close' });

    const reply = makeComment({ created_at: '2026-07-14T00:00:00Z' });
    const adapter = { list_comments: async () => [reply] };
    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => makeAssessment(),
    };

    const result = await reassessAwaitingInfoItem(config, adapter, enqueued, reply, deps);

    assert.equal(result.new_item, null);
    assert.equal(result.should_dispatch, false);

    const all = await readAll(config);
    // Still exactly one entry — the already-overridden one. No duplicate.
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'overridden');
  });

  it('propagates non-already_resolved QueueErrors', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath() });
    const enqueued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });
    // Corrupt the id so resolveItem throws 'not_found' instead of 'already_resolved'.
    const badItem = { ...enqueued, id: 'does-not-exist' };
    const reply = makeComment({ created_at: '2026-07-14T00:00:00Z' });
    const adapter = { list_comments: async () => [reply] };
    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => makeAssessment(),
    };

    await assert.rejects(
      () => reassessAwaitingInfoItem(config, adapter, badItem, reply, deps),
      (err) => err instanceof QueueError && err.code === 'not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// processAwaitingInfoItems — batch driver
// ---------------------------------------------------------------------------

describe('processAwaitingInfoItems', () => {
  it('re-assesses only items with a qualifying reply; leaves the rest untouched', async () => {
    // Both items share one queue file, matching how a single poll cycle
    // reads/writes exactly one queue for the whole batch.
    const config = makeConfig({ pending_queue: tmpQueuePath() });
    const itemWithReply = await enqueue(config, {
      event: makeEvent({ id: 'owner/repo#328', number: 328 }),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });
    const itemNoReply = await enqueue(config, {
      event: makeEvent({ id: 'owner/repo#329', number: 329 }),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    const adapter = {
      list_comments: async (_c, event) => {
        // Comment timestamp deliberately far in the future — the item's real
        // `queued_at` (set by enqueue() to the actual current time) is the
        // "waiting since" marker, so the reply must postdate it regardless of
        // when this test happens to run.
        if (event.number === 328) {
          return [makeComment({ created_at: '2099-01-01T00:00:00Z', body: 'v1.2.3' })];
        }
        return []; // no reply for #329
      },
    };

    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => makeAssessment({
        suggested_action: { classes: ['dispatch'], body: null, dispatch_target: null, labels: [] },
      }),
    };

    const { reassessed, errors } = await processAwaitingInfoItems(
      config,
      adapter,
      [itemWithReply, itemNoReply],
      deps,
    );

    assert.equal(errors.length, 0);
    assert.equal(reassessed.length, 1);
    assert.equal(reassessed[0].resolved_id, itemWithReply.id);
  });

  it('captures a per-item error without halting the batch', async () => {
    const config = makeConfig({ pending_queue: tmpQueuePath() });
    const item = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_info',
    });

    const adapter = {
      list_comments: async () => { throw new Error('GitHub API exploded'); },
    };
    const deps = {
      enrich: async (_c, event) => ({ ...event, context: {} }),
      assess: async () => makeAssessment(),
    };

    const { reassessed, errors } = await processAwaitingInfoItems(config, adapter, [item], deps);

    assert.equal(reassessed.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].item_id, item.id);
    assert.match(errors[0].error, /GitHub API exploded/);
  });

  it('is a no-op for an empty items list', async () => {
    const config = makeConfig();
    const adapter = { list_comments: async () => { throw new Error('should not be called'); } };
    const deps = { enrich: async () => ({}), assess: async () => makeAssessment() };

    const { reassessed, errors } = await processAwaitingInfoItems(config, adapter, [], deps);

    assert.deepEqual(reassessed, []);
    assert.deepEqual(errors, []);
  });
});
