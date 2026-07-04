/**
 * Pending queue module for clagentic:triage.
 *
 * Stores items awaiting human review as an append-only JSONL file. The file
 * path comes from config.pending_queue (default: .triage/pending.jsonl).
 *
 * Resolutions rewrite the full file — this is a local CLI tool where queue
 * sizes are small; the simplicity of full-rewrite beats the complexity of
 * random-access updates.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { resolveVocabulary, isStatusLabel } from './labels.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class QueueError extends Error {
  /**
   * @param {string} message  - Human-readable description
   * @param {string} code     - Machine-readable error code
   */
  constructor(message, code) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a simple time-prefixed ID that requires no external dependency.
 * Format: <base36 timestamp>-<random hex suffix>
 *
 * @returns {string}
 */
function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Return the queue file path from config, falling back to the default.
 *
 * @param {object} config
 * @returns {string}
 */
function queuePath(config) {
  return config.pending_queue ?? '.triage/pending.jsonl';
}

/**
 * Validate a deserialized queue record. Returns true if the record is
 * structurally sound; false (with a console.warn) if it is corrupt or missing
 * required fields. A single corrupt record must not prevent the rest of the
 * queue from loading.
 *
 * Required fields:
 *   - id:              non-empty string
 *   - event:           object with a non-empty string `repo` field
 *   - assessment:      object with string `verdict` and number `confidence` (0–1)
 *   - created_at:      string (ISO 8601; format is not re-parsed, only type-checked)
 *
 * Note: queue records written by `enqueue` use `queued_at`, not `created_at`.
 * The validator accepts either field name so that records from both the current
 * writer and any future schema variation pass without false positives.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
function _validate_record(record) {
  if (record === null || typeof record !== 'object') {
    console.warn('[queue] skipping corrupt record: not an object', record);
    return false;
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    console.warn('[queue] skipping corrupt record: id is missing or not a non-empty string', record);
    return false;
  }

  if (record.event === null || typeof record.event !== 'object') {
    console.warn(`[queue] skipping corrupt record ${record.id}: event is missing or not an object`);
    return false;
  }

  if (typeof record.event.repo !== 'string' || record.event.repo.length === 0) {
    console.warn(`[queue] skipping record ${record.id}: event.repo is missing or empty`);
    return false;
  }

  if (
    record.assessment === null ||
    typeof record.assessment !== 'object' ||
    typeof record.assessment.verdict !== 'string' ||
    typeof record.assessment.confidence !== 'number' ||
    record.assessment.confidence < 0 ||
    record.assessment.confidence > 1
  ) {
    console.warn(
      `[queue] skipping corrupt record ${record.id}: assessment.verdict or assessment.confidence is missing or invalid`,
    );
    return false;
  }

  // Accept either created_at (external schema) or queued_at (written by enqueue).
  const timestamp = record.created_at ?? record.queued_at;
  if (typeof timestamp !== 'string') {
    console.warn(
      `[queue] skipping corrupt record ${record.id}: created_at/queued_at is missing or not a string`,
    );
    return false;
  }

  return true;
}

/**
 * Read and parse all lines from the JSONL file. Returns an empty array if the
 * file does not exist or is empty. Never throws on missing file. Corrupt lines
 * are skipped with a warning rather than causing the whole load to fail.
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
      console.warn('[queue] skipping unparseable JSONL line:', line.slice(0, 120));
      continue;
    }
    if (_validate_record(parsed)) {
      records.push(parsed);
    }
  }
  return records;
}

/**
 * Write an array of items back to the JSONL file as one item per line.
 * Creates parent directories if they do not exist.
 *
 * @param {string} filePath
 * @param {object[]} items
 * @returns {Promise<void>}
 */
async function writeLines(filePath, items) {
  await mkdir(dirname(filePath), { recursive: true });
  const content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
  await writeFile(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append one item to the queue. Creates the file and parent directories if
 * they do not already exist.
 *
 * @param {object} config
 * @param {object} opts
 * @param {object} opts.event              - EnrichedEvent
 * @param {object} opts.assessment         - Assessment
 * @param {string} opts.queue_reason       - 'awaiting_approval' | 'low_confidence' | 'dispatch' | 'escalate'
 * @param {Array|null} [opts.dispatch_results] - Per-dispatcher outcomes for 'dispatch'-class items
 * @returns {Promise<object>} The new queue item with id and queued_at filled in.
 */
export async function enqueue(config, { event, assessment, queue_reason, dispatch_results = null }) {
  const filePath = queuePath(config);

  const item = {
    id: generateId(),
    queued_at: new Date().toISOString(),
    queue_reason,
    event,
    assessment,
    status: 'pending',
    resolved_at: null,
    resolved_action: null,
    dispatch_results,
  };

  await mkdir(dirname(filePath), { recursive: true });

  // Append a single JSON line to the file.
  const line = JSON.stringify(item) + '\n';
  await writeFile(filePath, line, { flag: 'a', encoding: 'utf8' });

  return item;
}

/**
 * Read all queue items. Returns an array ordered oldest-first (most recent last).
 * Never throws — returns [] if the file is missing or empty.
 *
 * @param {object} config
 * @returns {Promise<object[]>}
 */
export async function readAll(config) {
  return readLines(queuePath(config));
}

/**
 * List queue items filtered by one or more status values.
 *
 * @param {object}   config
 * @param {object}   [opts]
 * @param {string[]} [opts.status=['pending']]  - Array of status strings to include
 * @returns {Promise<object[]>}
 */
export async function listItems(config, { status = ['pending'] } = {}) {
  const all = await readLines(queuePath(config));
  return all.filter((item) => status.includes(item.status));
}

/**
 * Resolve a pending queue item by marking it approved, rejected, or overridden.
 *
 * @param {object} config
 * @param {string} id     - ID of the item to resolve
 * @param {object} opts
 * @param {string} opts.action                   - 'approved' | 'rejected' | 'overridden'
 * @param {string|null} [opts.resolved_action_class] - Used when action='overridden'; names the action class to execute
 * @param {Array|null} [opts.dispatch_results]   - Per-dispatcher outcomes when action class is 'dispatch'
 * @returns {Promise<object>} The updated item.
 * @throws {QueueError} with code 'not_found' when the id is not in the queue.
 * @throws {QueueError} with code 'already_resolved' when the item is not in 'pending' status.
 */
export async function resolveItem(config, id, { action, resolved_action_class = null, dispatch_results = null }) {
  const filePath = queuePath(config);
  const items = await readLines(filePath);

  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new QueueError(`Queue item not found: ${id}`, 'not_found');
  }

  const item = items[index];
  if (item.status !== 'pending') {
    throw new QueueError(
      `Queue item ${id} is already resolved (status: ${item.status})`,
      'already_resolved',
    );
  }

  const updated = {
    ...item,
    status: action,
    resolved_at: new Date().toISOString(),
    resolved_action: resolved_action_class,
    dispatch_results,
  };

  items[index] = updated;
  await writeLines(filePath, items);

  return updated;
}

// ---------------------------------------------------------------------------
// Per-issue lifecycle state (T7, lr-f0f2)
// ---------------------------------------------------------------------------

/**
 * Derive an item's current lifecycle state from its live label set.
 *
 * Per this task's spec: prefer deriving state from live GitHub labels over a
 * parallel local store. A parallel store (e.g. a JSON side-index keyed by
 * repo#number) would drift the moment a human relabels an issue directly on
 * GitHub, in a GitHub Action, or via any path other than triage itself —
 * exactly the failure mode a "single source of truth" state machine exists to
 * avoid. The adapter's get_item_labels (T2, lr-a192) already fetches fresh
 * labels for the single-status invariant helper in src/labels.js; this
 * function reuses that same call and the same vocabulary resolution rather
 * than introducing a second labels-reading path.
 *
 * Returns `status: null` (not an error) when the item carries no status/*
 * label — an untouched or newly-opened issue has no lifecycle state yet,
 * which is a valid, expected condition, not a fault.
 *
 * @param {object} config
 * @param {object} adapter - source adapter (must implement get_item_labels)
 * @param {object} event   - Normalized Event (or the { repo, number } subset)
 * @returns {Promise<{ status: string|null, labels: string[] }>}
 *   status is the bare status/* value (e.g. "in-progress"), without the
 *   namespace prefix; labels is the item's full current label set.
 */
export async function getLifecycleState(config, adapter, event) {
  const labels = await adapter.get_item_labels(config, event);
  const vocabulary = resolveVocabulary(config);

  const statusLabel = labels.find((label) => isStatusLabel(label, vocabulary));
  const status = statusLabel ? statusLabel.slice(vocabulary.status_namespace.length + 1) : null;

  return { status, labels };
}
