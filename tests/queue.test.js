/**
 * Tests for src/queue.js
 *
 * Uses os.tmpdir() for all file paths — never writes to the project directory.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { enqueue, readAll, listItems, resolveItem, QueueError } from '../src/queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temp directory path for each test without creating it.
 * Tests create their own subdirs via enqueue/writeLines.
 */
function tmpQueuePath() {
  const unique = randomBytes(6).toString('hex');
  return join(tmpdir(), `triage-queue-test-${unique}`, 'pending.jsonl');
}

function makeConfig(queuePath) {
  return { pending_queue: queuePath };
}

function makeEvent(id = 'evt-1') {
  return { id, title: `Test event ${id}`, type: 'issue', repo: 'example/repo' };
}

function makeAssessment(verdict = 'off_topic', confidence = 0.9) {
  return {
    verdict,
    confidence,
    suggested_action: { class: 'close', body: 'Closing as off-topic.' },
    assessed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  test('creates file and returns item with id and queued_at', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'awaiting_approval',
    });

    assert.ok(typeof item.id === 'string' && item.id.length > 0, 'item.id should be a non-empty string');
    assert.ok(typeof item.queued_at === 'string', 'item.queued_at should be a string');
    assert.doesNotThrow(() => new Date(item.queued_at), 'item.queued_at should be a valid ISO timestamp');
    assert.equal(item.status, 'pending');
    assert.equal(item.queue_reason, 'awaiting_approval');
    assert.equal(item.resolved_at, null);
    assert.equal(item.resolved_action, null);
    assert.ok(existsSync(config.pending_queue), 'queue file should exist after enqueue');
  });

  test('creates parent directories if they do not exist', async () => {
    // Use a deeply nested path that does not exist
    const base = join(tmpdir(), `triage-deep-${randomBytes(6).toString('hex')}`);
    const config = makeConfig(join(base, 'nested', 'dir', 'pending.jsonl'));

    await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment(),
      queue_reason: 'escalate',
    });

    assert.ok(existsSync(config.pending_queue), 'queue file should exist after deep enqueue');
  });

  test('appends multiple items as separate JSONL lines', async () => {
    const config = makeConfig(tmpQueuePath());

    await enqueue(config, { event: makeEvent('e1'), assessment: makeAssessment(), queue_reason: 'dispatch' });
    await enqueue(config, { event: makeEvent('e2'), assessment: makeAssessment(), queue_reason: 'escalate' });
    await enqueue(config, { event: makeEvent('e3'), assessment: makeAssessment(), queue_reason: 'low_confidence' });

    const raw = await readFile(config.pending_queue, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 3, 'should have 3 JSONL lines');

    const parsed = lines.map((l) => JSON.parse(l));
    const ids = parsed.map((item) => item.event.id);
    assert.deepEqual(ids, ['e1', 'e2', 'e3']);
  });
});

describe('readAll', () => {
  test('returns empty array when file does not exist', async () => {
    const config = makeConfig(tmpQueuePath());
    const items = await readAll(config);
    assert.deepEqual(items, []);
  });

  test('returns all items in order (oldest first)', async () => {
    const config = makeConfig(tmpQueuePath());

    await enqueue(config, { event: makeEvent('a'), assessment: makeAssessment(), queue_reason: 'awaiting_approval' });
    await enqueue(config, { event: makeEvent('b'), assessment: makeAssessment(), queue_reason: 'low_confidence' });

    const items = await readAll(config);
    assert.equal(items.length, 2);
    assert.equal(items[0].event.id, 'a');
    assert.equal(items[1].event.id, 'b');
  });
});

describe('listItems', () => {
  test('returns only pending items by default', async () => {
    const config = makeConfig(tmpQueuePath());

    const item1 = await enqueue(config, { event: makeEvent('x'), assessment: makeAssessment(), queue_reason: 'dispatch' });
    const item2 = await enqueue(config, { event: makeEvent('y'), assessment: makeAssessment(), queue_reason: 'escalate' });

    // Manually resolve item2 by calling resolveItem
    await resolveItem(config, item2.id, { action: 'approved' });

    const pending = await listItems(config);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, item1.id);
  });

  test('filters by provided status array', async () => {
    const config = makeConfig(tmpQueuePath());

    const item1 = await enqueue(config, { event: makeEvent('p'), assessment: makeAssessment(), queue_reason: 'low_confidence' });
    const item2 = await enqueue(config, { event: makeEvent('q'), assessment: makeAssessment(), queue_reason: 'awaiting_approval' });

    await resolveItem(config, item1.id, { action: 'rejected' });
    await resolveItem(config, item2.id, { action: 'approved' });

    const rejected = await listItems(config, { status: ['rejected'] });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].id, item1.id);

    const both = await listItems(config, { status: ['rejected', 'approved'] });
    assert.equal(both.length, 2);
  });

  test('returns empty array when no items match the filter', async () => {
    const config = makeConfig(tmpQueuePath());
    const items = await listItems(config, { status: ['approved'] });
    assert.deepEqual(items, []);
  });
});

describe('resolveItem', () => {
  test('marks a pending item as approved', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, { event: makeEvent(), assessment: makeAssessment(), queue_reason: 'awaiting_approval' });

    const updated = await resolveItem(config, item.id, { action: 'approved' });

    assert.equal(updated.id, item.id);
    assert.equal(updated.status, 'approved');
    assert.ok(typeof updated.resolved_at === 'string', 'resolved_at should be set');
    assert.doesNotThrow(() => new Date(updated.resolved_at));
    assert.equal(updated.resolved_action, null);
  });

  test('marks a pending item as rejected', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, { event: makeEvent(), assessment: makeAssessment(), queue_reason: 'low_confidence' });

    const updated = await resolveItem(config, item.id, { action: 'rejected' });
    assert.equal(updated.status, 'rejected');
  });

  test('stores resolved_action_class when action is overridden', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, { event: makeEvent(), assessment: makeAssessment(), queue_reason: 'awaiting_approval' });

    const updated = await resolveItem(config, item.id, { action: 'overridden', resolved_action_class: 'respond' });
    assert.equal(updated.status, 'overridden');
    assert.equal(updated.resolved_action, 'respond');
  });

  test('persists the update so subsequent reads reflect the new status', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, { event: makeEvent(), assessment: makeAssessment(), queue_reason: 'dispatch' });

    await resolveItem(config, item.id, { action: 'approved' });

    const all = await readAll(config);
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'approved');
  });

  test('throws QueueError with code not_found when id does not exist', async () => {
    const config = makeConfig(tmpQueuePath());

    await assert.rejects(
      () => resolveItem(config, 'nonexistent-id', { action: 'approved' }),
      (err) => {
        assert.ok(err instanceof QueueError, 'should be QueueError');
        assert.equal(err.code, 'not_found');
        return true;
      },
    );
  });

  test('throws QueueError with code already_resolved when item is not pending', async () => {
    const config = makeConfig(tmpQueuePath());
    const item = await enqueue(config, { event: makeEvent(), assessment: makeAssessment(), queue_reason: 'escalate' });

    // First resolve succeeds
    await resolveItem(config, item.id, { action: 'approved' });

    // Second resolve should throw
    await assert.rejects(
      () => resolveItem(config, item.id, { action: 'rejected' }),
      (err) => {
        assert.ok(err instanceof QueueError, 'should be QueueError');
        assert.equal(err.code, 'already_resolved');
        return true;
      },
    );
  });
});

describe('QueueError', () => {
  test('has name QueueError and exposes code', () => {
    const e = new QueueError('test message', 'test_code');
    assert.equal(e.name, 'QueueError');
    assert.equal(e.code, 'test_code');
    assert.equal(e.message, 'test message');
    assert.ok(e instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Record re-validation on load
// ---------------------------------------------------------------------------

describe('readAll record validation', () => {
  test('silently skips a malformed record (missing id)', async () => {
    const config = makeConfig(tmpQueuePath());

    // Write one malformed record directly (missing id) and confirm it is skipped.
    const bad = {
      // id intentionally omitted
      queued_at: new Date().toISOString(),
      queue_reason: 'awaiting_approval',
      event: { id: 'e-bad', title: 'Bad', type: 'issue', repo: 'example/repo' },
      assessment: { verdict: 'off_topic', confidence: 0.9 },
      status: 'pending',
      resolved_at: null,
      resolved_action: null,
      dispatch_results: null,
    };

    await mkdir(dirname(config.pending_queue), { recursive: true });
    await writeFile(config.pending_queue, JSON.stringify(bad) + '\n', 'utf8');

    const items = await readAll(config);
    assert.deepEqual(items, [], 'malformed record should be skipped, returning empty array');
  });

  test('returns only valid records when the queue contains a mix of good and bad', async () => {
    const config = makeConfig(tmpQueuePath());

    // Write two records: one valid (via enqueue), one malformed (via direct write).
    const good = await enqueue(config, {
      event: { ...makeEvent('good-1'), repo: 'example/repo' },
      assessment: makeAssessment(),
      queue_reason: 'awaiting_approval',
    });

    // Append a bad record: assessment.confidence is out of range.
    const bad = {
      id: 'bad-record-1',
      queued_at: new Date().toISOString(),
      queue_reason: 'low_confidence',
      event: { id: 'e-bad', title: 'Bad', type: 'issue', repo: 'example/repo' },
      assessment: { verdict: 'spam', confidence: 2.5 },
      status: 'pending',
      resolved_at: null,
      resolved_action: null,
      dispatch_results: null,
    };
    await writeFile(config.pending_queue, JSON.stringify(bad) + '\n', { flag: 'a', encoding: 'utf8' });

    const items = await readAll(config);
    assert.equal(items.length, 1, 'only the valid record should be returned');
    assert.equal(items[0].id, good.id);
  });
});
