/**
 * Tests for src/task_index.js
 *
 * Uses os.tmpdir() for all file paths — never writes to the project directory.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { recordTask, lookupTask, TaskIndexError } from '../src/task_index.js';

function tmpIndexPath() {
  const unique = randomBytes(6).toString('hex');
  return join(tmpdir(), `triage-task-index-test-${unique}`, 'task-index.jsonl');
}

function makeConfig(path) {
  return { task_index: path };
}

describe('recordTask', () => {
  test('creates the file and records a task -> origin mapping', async () => {
    const config = makeConfig(tmpIndexPath());
    const record = await recordTask(config, {
      dispatcher: 'lore',
      task_id: 'lr-a68f',
      task_url: 'https://lore.example/tasks/lr-a68f',
      event_id: 'owner/repo#263',
      repo: 'owner/repo',
      number: 263,
      event_url: 'https://github.com/owner/repo/issues/263',
    });

    assert.equal(record.dispatcher, 'lore');
    assert.equal(record.task_id, 'lr-a68f');
    assert.ok(typeof record.recorded_at === 'string' && record.recorded_at.length > 0);
  });

  test('throws TaskIndexError when dispatcher or task_id is missing', async () => {
    const config = makeConfig(tmpIndexPath());
    await assert.rejects(
      () => recordTask(config, { dispatcher: 'lore', task_id: '' }),
      (err) => {
        assert.ok(err instanceof TaskIndexError);
        assert.equal(err.code, 'invalid_args');
        return true;
      },
    );
  });

  test('re-recording the same (dispatcher, task_id) overwrites rather than duplicates', async () => {
    const path = tmpIndexPath();
    const config = makeConfig(path);

    await recordTask(config, {
      dispatcher: 'lore', task_id: 'lr-a68f', event_id: 'owner/repo#263',
      repo: 'owner/repo', number: 263, event_url: 'https://github.com/owner/repo/issues/263',
    });
    await recordTask(config, {
      dispatcher: 'lore', task_id: 'lr-a68f', task_url: 'https://lore.example/lr-a68f',
      event_id: 'owner/repo#263', repo: 'owner/repo', number: 263,
      event_url: 'https://github.com/owner/repo/issues/263',
    });

    const record = await lookupTask(config, 'lr-a68f');
    assert.equal(record.task_url, 'https://lore.example/lr-a68f');

    // Only one line should exist for this key.
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1);
  });

  test('keeps distinct records for the same task_id across different dispatchers', async () => {
    const config = makeConfig(tmpIndexPath());
    await recordTask(config, {
      dispatcher: 'lore', task_id: 'X-1', event_id: 'a/b#1', repo: 'a/b', number: 1, event_url: 'https://x/1',
    });
    await recordTask(config, {
      dispatcher: 'jira', task_id: 'X-1', event_id: 'c/d#2', repo: 'c/d', number: 2, event_url: 'https://x/2',
    });

    const loreRecord = await lookupTask(config, 'X-1', { dispatcher: 'lore' });
    const jiraRecord = await lookupTask(config, 'X-1', { dispatcher: 'jira' });
    assert.equal(loreRecord.repo, 'a/b');
    assert.equal(jiraRecord.repo, 'c/d');
  });
});

describe('lookupTask', () => {
  test('returns null for an unknown task_id', async () => {
    const config = makeConfig(tmpIndexPath());
    const record = await lookupTask(config, 'does-not-exist');
    assert.equal(record, null);
  });

  test('returns null when the index file does not exist yet', async () => {
    const config = makeConfig(tmpIndexPath());
    const record = await lookupTask(config, 'anything');
    assert.equal(record, null);
  });

  test('is queryable after create_task/recordTask returns — the durability requirement', async () => {
    // This mirrors the design gap the task description calls out: dispatch_results
    // only lived in the one-time queue blob. recordTask + lookupTask must let a
    // caller resolve task_id -> origin at any later point, independent of the
    // pending-queue entry that originally carried it.
    const config = makeConfig(tmpIndexPath());
    await recordTask(config, {
      dispatcher: 'lore', task_id: 'lr-a68f', task_url: 'https://lore.example/lr-a68f',
      event_id: 'clagentic/clagentic-console#263', repo: 'clagentic/clagentic-console',
      number: 263, event_url: 'https://github.com/clagentic/clagentic-console/issues/263',
    });

    // Simulate a later, independent process (the status-hook handler) looking
    // up the mapping with no other context than the task_id.
    const later = await lookupTask(config, 'lr-a68f', { dispatcher: 'lore' });
    assert.equal(later.repo, 'clagentic/clagentic-console');
    assert.equal(later.number, 263);
  });

  test('skips corrupt lines without throwing', async () => {
    const path = tmpIndexPath();
    const config = makeConfig(path);
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not json\n{"dispatcher":"lore","task_id":"ok","repo":"a/b","number":1}\n', 'utf8');

    const record = await lookupTask(config, 'ok');
    assert.equal(record.repo, 'a/b');
  });
});
