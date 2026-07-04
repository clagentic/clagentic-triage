/**
 * Tests for src/assessors/pre_filter.js.
 *
 * Uses Node's built-in test runner. The LLM call is mocked by injecting a
 * fake spawn function via llm._setSpawnFn(). No real LLM calls are made.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { preFilter, noiseAssessment } from '../src/assessors/pre_filter.js';
import { _setSpawnFn } from '../src/llm.js';

// ---------------------------------------------------------------------------
// Fake process helpers (mirrors assessor.test.js pattern)
// ---------------------------------------------------------------------------

class FakeStdin {
  constructor() {
    this.written = [];
    this.ended = false;
  }
  write(chunk) {
    this.written.push(chunk);
  }
  end() {
    this.ended = true;
  }
}

/**
 * Build a fake child process that emits the given stdout content and exits.
 *
 * @param {object} opts
 * @param {string}  opts.stdout  - Content emitted on stdout
 * @param {string}  [opts.stderr]
 * @param {number}  [opts.code]  - Exit code (default 0)
 * @returns {object}
 */
function makeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const child = new EventEmitter();

  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = new FakeStdin();
  child.killed = false;
  child.kill = function () {
    if (!this.killed) {
      this.killed = true;
      setImmediate(() => child.emit('close', null));
    }
  };

  setImmediate(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });

  return child;
}

function makeSpawn(childOpts) {
  return function fakeSpawn(_bin, _args, _opts) {
    return makeChild(childOpts);
  };
}

/**
 * Wrap a pre-filter JSON payload in the claude CLI envelope format.
 * The CLI returns {"result": "<JSON string>"} on stdout.
 */
function cliEnvelope(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return {
    runner: 'claude-cli',
    model: 'test-model',
    pre_filter: {
      enabled: true,
      runner: null,
      model: null,
      timeout_ms: 500,
      confidence_threshold: 0.8,
    },
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#1',
    type: 'issue',
    title: 'Test issue',
    body: 'Test body',
    author: 'testuser',
    number: 1,
    created_at: '2024-01-01T00:00:00Z',
    url: 'https://github.com/owner/repo/issues/1',
    source: 'github',
    repo: 'owner/repo',
    metadata: {},
    context: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preFilter', () => {
  afterEach(() => {
    // Reset spawn to real Node spawn after each test.
    _setSpawnFn(null);
  });

  it('returns { noise: false } when LLM call fails (pass-through on error)', async () => {
    // Simulate the CLI exiting with a non-zero code.
    _setSpawnFn(makeSpawn({ stdout: '', stderr: 'internal error', code: 1 }));

    const config = makeConfig();
    const event = makeEvent();
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, false);
    assert.strictEqual(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'reason should be non-empty on error');
    assert.strictEqual(result.confidence, 0);
  });

  it('returns { noise: true } when LLM returns NOISE with confidence above threshold', async () => {
    const payload = {
      verdict: 'NOISE',
      confidence: 0.95,
      reason: 'Pure spam with no content.',
      model_used: 'test-model',
    };
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload) }));

    const config = makeConfig();
    const event = makeEvent({ title: 'BUY NOW!!!', body: 'Click here for cheap stuff' });
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, true);
    assert.strictEqual(result.confidence, 0.95);
    assert.strictEqual(result.reason, 'Pure spam with no content.');
  });

  it('returns { noise: false } when LLM returns NOISE but confidence is below threshold', async () => {
    // Confidence 0.6 is below the default threshold of 0.8 — should pass through.
    const payload = {
      verdict: 'NOISE',
      confidence: 0.6,
      reason: 'Possibly spam but uncertain.',
      model_used: 'test-model',
    };
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload) }));

    const config = makeConfig();
    const event = makeEvent();
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, false);
    assert.strictEqual(result.confidence, 0.6);
  });

  it('returns { noise: false } when LLM returns REAL regardless of confidence', async () => {
    const payload = {
      verdict: 'REAL',
      confidence: 0.99,
      reason: 'Genuine bug report.',
      model_used: 'test-model',
    };
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload) }));

    const config = makeConfig();
    const event = makeEvent();
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, false);
  });

  it('returns { noise: false } when LLM response cannot be parsed', async () => {
    // Simulate the CLI returning JSON that parses OK at the envelope level but
    // contains a result field with an unexpected schema (no verdict/confidence).
    // _runClaudeCli successfully parses the inner JSON to an object; the
    // pre-filter's _parsePreFilterResponse then fails on the missing fields.
    const payload = { unexpected_field: 'something' };
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload) }));

    const config = makeConfig();
    const event = makeEvent();
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, false);
    assert.strictEqual(result.reason, 'parse failure');
  });

  it('uses pre_filter.confidence_threshold from config', async () => {
    // Threshold set to 0.5; confidence 0.6 should be treated as noise.
    const payload = {
      verdict: 'NOISE',
      confidence: 0.6,
      reason: 'Low-quality post.',
      model_used: 'test-model',
    };
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload) }));

    const config = makeConfig({
      pre_filter: {
        enabled: true,
        runner: null,
        model: null,
        timeout_ms: 500,
        confidence_threshold: 0.5,
      },
    });
    const event = makeEvent();
    const result = await preFilter(config, event);

    assert.strictEqual(result.noise, true);
  });
});

describe('noiseAssessment', () => {
  it('returns an Assessment with verdict "reject" and pre_filter: true', () => {
    const event = makeEvent();
    const pfResult = {
      noise: true,
      reason: 'Detected as spam.',
      confidence: 0.92,
      model_used: 'haiku-model',
    };

    const assessment = noiseAssessment(event, pfResult);

    assert.strictEqual(assessment.verdict, 'reject');
    assert.strictEqual(assessment.pre_filter, true);
    assert.strictEqual(assessment.confidence, 0.92);
    assert.strictEqual(assessment.model_used, 'haiku-model');
    assert.ok(assessment.reasoning.includes('Detected as spam.'));
    assert.deepStrictEqual(assessment.suggested_action.classes, ['close']);
    assert.strictEqual(assessment.event_id, event.id);
    assert.ok(typeof assessment.assessed_at === 'string', 'assessed_at should be a string');
  });

  it('includes event_id from enrichedEvent.id', () => {
    const event = makeEvent({ id: 'owner/repo#42' });
    const pfResult = { noise: true, reason: 'spam', confidence: 0.9, model_used: 'model' };

    const assessment = noiseAssessment(event, pfResult);

    assert.strictEqual(assessment.event_id, 'owner/repo#42');
  });

  it('handles missing event id gracefully', () => {
    const event = makeEvent({ id: undefined });
    const pfResult = { noise: true, reason: 'spam', confidence: 0.9, model_used: 'model' };

    const assessment = noiseAssessment(event, pfResult);

    assert.strictEqual(assessment.event_id, '');
  });
});
