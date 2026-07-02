/**
 * Task index — durable task_id -> origin mapping for clagentic:triage.
 *
 * `dispatch()` (src/dispatchers/index.js) returns { name, result } per dispatcher,
 * where `result` is the dispatcher's create_task() return value ({ id, url }).
 * That result is stored in the pending-queue entry, but only as part of the
 * one-time `dispatch_results` blob — there is no queryable index that lets a
 * backend later say "task X shipped" and have triage resolve which issue/PR
 * that maps back to.
 *
 * This module is the queryable side-index: an append-only JSONL file keyed by
 * (dispatcher name, task id), recording enough of the originating Event to let
 * a status-callback handler act on it (repo, issue number, url) without needing
 * to re-fetch or re-derive anything ticketing-specific. It is backend-agnostic —
 * it knows nothing about lore, Jira, or any other dispatcher; it only stores
 * whatever create_task returned plus the Event fields needed to act on GitHub
 * (or whichever adapter originated the event).
 *
 * Same file-per-line format and read/write style as src/queue.js, so operators
 * managing `.triage/` see one consistent storage convention.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

export class TaskIndexError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   */
  constructor(message, code) {
    super(message);
    this.name = 'TaskIndexError';
    this.code = code;
  }
}

/**
 * Return the task index file path from config, falling back to the default.
 * Kept alongside the pending queue by convention (same .triage/ directory).
 *
 * @param {object} config
 * @returns {string}
 */
function indexPath(config) {
  return config.task_index ?? '.triage/task-index.jsonl';
}

/**
 * Build the composite key used to look up a record: dispatcher name is part of
 * the key because task ids are only unique within a single dispatcher's id space
 * (two different backends could coincidentally mint the same id string).
 *
 * @param {string} dispatcherName
 * @param {string} taskId
 * @returns {string}
 */
function compositeKey(dispatcherName, taskId) {
  return `${dispatcherName}::${taskId}`;
}

/**
 * Read and parse all lines from the JSONL file. Returns [] if the file does not
 * exist. Corrupt lines are skipped with a warning, never fail the whole read.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readLines(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[task_index] skipping unparseable JSONL line:', line.slice(0, 120));
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.dispatcher === 'string' &&
      typeof parsed.task_id === 'string'
    ) {
      records.push(parsed);
    } else {
      console.warn('[task_index] skipping corrupt record (missing dispatcher/task_id):', parsed);
    }
  }
  return records;
}

/**
 * Record a task_id -> origin mapping. Called once per successful dispatcher
 * create_task() result, immediately after dispatch() returns (src/pipeline.js).
 *
 * Idempotent by (dispatcher, task_id): re-recording the same key overwrites the
 * prior record rather than appending a duplicate, so a re-dispatched event never
 * grows the index unboundedly.
 *
 * @param {object} config
 * @param {object} opts
 * @param {string} opts.dispatcher   - dispatcher name (e.g. 'lore', 'webhook')
 * @param {string} opts.task_id      - id returned by the dispatcher's create_task
 * @param {string|null} opts.task_url - url returned by create_task, if any
 * @param {string} opts.event_id     - originating Event.id
 * @param {string} opts.repo         - originating Event.repo ("owner/repo")
 * @param {number} opts.number       - originating Event.number (issue/PR number)
 * @param {string} opts.event_url    - originating Event.url
 * @returns {Promise<object>} the stored record
 */
export async function recordTask(config, { dispatcher, task_id, task_url = null, event_id, repo, number, event_url }) {
  if (!dispatcher || !task_id) {
    throw new TaskIndexError('recordTask requires both dispatcher and task_id', 'invalid_args');
  }

  const filePath = indexPath(config);
  const existing = await readLines(filePath);

  const record = {
    dispatcher,
    task_id,
    task_url,
    event_id: event_id ?? null,
    repo: repo ?? null,
    number: number ?? null,
    event_url: event_url ?? null,
    recorded_at: new Date().toISOString(),
  };

  const key = compositeKey(dispatcher, task_id);
  const filtered = existing.filter((r) => compositeKey(r.dispatcher, r.task_id) !== key);
  filtered.push(record);

  await mkdir(dirname(filePath), { recursive: true });
  const content = filtered.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(filePath, content, 'utf8');

  return record;
}

/**
 * Look up the origin record for a given task_id.
 *
 * @param {object} config
 * @param {string} task_id
 * @param {object} [opts]
 * @param {string} [opts.dispatcher] - narrow the lookup to a specific dispatcher's
 *   id space. Omit to search across all dispatchers (returns the first match).
 * @returns {Promise<object|null>} the stored record, or null if not found
 */
export async function lookupTask(config, task_id, { dispatcher } = {}) {
  const records = await readLines(indexPath(config));
  const match = records.find(
    (r) => r.task_id === task_id && (dispatcher === undefined || r.dispatcher === dispatcher),
  );
  return match ?? null;
}
