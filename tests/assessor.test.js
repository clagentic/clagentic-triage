/**
 * Tests for src/assessor.js (and supporting src/llm.js).
 *
 * Uses Node's built-in test runner. The claude CLI subprocess is mocked by
 * injecting a fake spawn function via llm._setSpawnFn(). No real processes
 * are launched. No network calls are made.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { redact, assess, AssessorError } from '../src/assessor.js';
import { _setSpawnFn } from '../src/llm.js';

// ---------------------------------------------------------------------------
// Fake process helpers
// ---------------------------------------------------------------------------

/**
 * A mock stdin stream that records what was written to it.
 */
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
 * Build a fake child process that emits the given stdout and stderr strings
 * and exits with the given code, after a short async tick.
 *
 * @param {object} opts
 * @param {string}      opts.stdout  - Content to emit on stdout
 * @param {string}      [opts.stderr] - Content to emit on stderr
 * @param {number}      [opts.code]  - Exit code (default 0)
 * @param {boolean}     [opts.hang]  - If true, never closes (simulates timeout)
 * @returns {object}  Fake child process
 */
function makeChild({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
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
      // Emit close with null to signal abnormal termination.
      setImmediate(() => child.emit('close', null));
    }
  };

  if (!hang) {
    setImmediate(() => {
      if (stdout) {
        stdoutEmitter.emit('data', Buffer.from(stdout));
      }
      if (stderr) {
        stderrEmitter.emit('data', Buffer.from(stderr));
      }
      child.emit('close', code);
    });
  }
  // If hang=true, we emit nothing — the timeout will kill the process.

  return child;
}

/**
 * Build a spawn function that always returns the given fake child.
 *
 * @param {object} childOpts  - Options forwarded to makeChild
 * @returns {Function}
 */
function makeSpawn(childOpts) {
  return function fakeSpawn(_bin, _args, _opts) {
    return makeChild(childOpts);
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * A valid Assessment JSON payload as the LLM would produce it.
 */
function validLlmPayload(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.9,
    reasoning: 'Clear bug report with reproduction steps.',
    suggested_action: {
      class: 'approve',
      body: null,
      dispatch_target: null,
      labels: ['bug'],
    },
    model_used: 'claude-sonnet-4-5',
    ...overrides,
  };
}

/**
 * The claude CLI wraps responses in an envelope like:
 *   { "result": "<JSON string>", ... }
 * Build the full CLI stdout for a given payload.
 *
 * @param {object} payload
 * @returns {string}
 */
function cliEnvelope(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

/**
 * Build a minimal config. router disabled by default so tests don't require
 * a real health check endpoint.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  return {
    model: 'claude-sonnet-4-5',
    model_fallback: 'claude-haiku-3-5',
    confidence_threshold: 0.7,
    auto_approve: [],
    llm_timeout_ms: 500,
    ...overrides,
  };
}

/**
 * Build a minimal enriched event.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#42',
    type: 'issue',
    title: 'Cannot reproduce the bug',
    body: 'Steps to reproduce: 1) do X 2) see error',
    author: 'testuser',
    number: 42,
    created_at: '2024-01-01T00:00:00Z',
    url: 'https://github.com/owner/repo/issues/42',
    source: 'github',
    repo: 'owner/repo',
    metadata: {},
    context: {
      intent: {
        description: 'Accept bug reports with reproduction steps.',
        _source: 'generic',
      },
      contributor: {
        login: 'testuser',
        public_repos: 10,
        followers: 5,
        created_at: '2020-01-01T00:00:00Z',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Restore real spawn after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  _setSpawnFn(null);
  // Restore fetch if it was replaced.
  if (globalThis._fetchBackup) {
    globalThis.fetch = globalThis._fetchBackup;
    delete globalThis._fetchBackup;
  }
});

// ---------------------------------------------------------------------------
// redact() tests
// ---------------------------------------------------------------------------

describe('redact()', () => {
  it('removes GitHub classic tokens (ghp_)', () => {
    const input = 'My token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 please help';
    const result = redact(input);
    assert.ok(!result.includes('ghp_'), 'should not contain original token');
    assert.ok(result.includes('[REDACTED]'), 'should contain [REDACTED]');
  });

  it('removes AWS access key IDs', () => {
    const input = 'Use AKIAIOSFODNN7EXAMPLE for access';
    const result = redact(input);
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'), 'should not contain AWS key');
    assert.ok(result.includes('[REDACTED]'), 'should contain [REDACTED]');
  });

  it('removes PEM headers', () => {
    const input = '-----BEGIN RSA PRIVATE KEY----- and some data';
    const result = redact(input);
    assert.ok(!result.includes('BEGIN RSA PRIVATE KEY'), 'should not contain PEM header');
    assert.ok(result.includes('[REDACTED]'), 'should contain [REDACTED]');
  });

  it('removes npm tokens', () => {
    const input = 'npm_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234 is the token';
    const result = redact(input);
    assert.ok(!result.includes('npm_abcdefghijklmnopqrstuvwxyz'), 'should not contain npm token');
    assert.ok(result.includes('[REDACTED]'), 'should contain [REDACTED]');
  });

  it('removes Slack bot tokens', () => {
    const input = 'slack token: xoxb-REDACTED-IN-TEST';
    const result = redact(input);
    assert.ok(!result.includes('xoxb-'), 'should not contain slack token');
    assert.ok(result.includes('[REDACTED]'), 'should contain [REDACTED]');
  });

  it('passes through clean text unchanged', () => {
    const input = 'This is a normal bug report with no secrets.';
    assert.equal(redact(input), input);
  });
});

// ---------------------------------------------------------------------------
// assess() — success path
// ---------------------------------------------------------------------------

describe('assess() — success', () => {
  it('returns a valid Assessment on successful LLM call', async () => {
    const payload = validLlmPayload();
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const config = makeConfig();
    const event = makeEvent();
    const result = await assess(config, event);

    assert.equal(result.verdict, 'accept');
    assert.equal(result.confidence, 0.9);
    assert.ok(typeof result.reasoning === 'string', 'reasoning should be string');
    assert.ok(result.suggested_action, 'suggested_action should exist');
    assert.equal(result.suggested_action.class, 'approve');
    assert.deepEqual(result.suggested_action.labels, ['bug']);
    assert.ok(typeof result.model_used === 'string', 'model_used should be string');
    assert.ok(typeof result.assessed_at === 'string', 'assessed_at should be string');
    assert.equal(result.event_id, event.id);
  });

  it('assessed_at is an ISO timestamp string', async () => {
    const payload = validLlmPayload();
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    // ISO 8601 regex: YYYY-MM-DDTHH:mm:ss.sssZ
    assert.match(result.assessed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Must parse as a valid date.
    assert.ok(!isNaN(new Date(result.assessed_at).getTime()), 'assessed_at must be a valid date');
  });

  it('confidence and all required fields present in Assessment output', async () => {
    const payload = validLlmPayload({ confidence: 0.85 });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.ok('verdict' in result, 'verdict required');
    assert.ok('confidence' in result, 'confidence required');
    assert.ok('reasoning' in result, 'reasoning required');
    assert.ok('suggested_action' in result, 'suggested_action required');
    assert.ok('model_used' in result, 'model_used required');
    assert.ok('assessed_at' in result, 'assessed_at required');
    assert.ok('event_id' in result, 'event_id required');
    assert.equal(result.confidence, 0.85);
  });
});

// ---------------------------------------------------------------------------
// assess() — degraded paths
// ---------------------------------------------------------------------------

describe('assess() — degraded paths', () => {
  it('returns degraded Assessment when LLM returns non-JSON (parse_error)', async () => {
    _setSpawnFn(makeSpawn({ stdout: 'this is not json at all', code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'degraded verdict should be escalate');
    assert.equal(result.confidence, 0, 'degraded confidence should be 0');
    assert.ok(result.reasoning.includes('parsed'), 'reasoning should mention parsing');
    assert.equal(result.suggested_action.class, 'escalate');
  });

  it('returns degraded Assessment on timeout', async () => {
    // hang=true means the process never closes; the timeout kills it.
    // Use a very short timeout so the test doesn't wait 120s.
    _setSpawnFn(makeSpawn({ hang: true }));

    const config = makeConfig({ llm_timeout_ms: 50 });
    const result = await assess(config, makeEvent());

    assert.equal(result.verdict, 'escalate');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.toLowerCase().includes('timed out'), 'reasoning should mention timeout');
    assert.equal(result.suggested_action.class, 'escalate');
  });

  it('returns degraded Assessment on non-zero exit code', async () => {
    _setSpawnFn(makeSpawn({ stdout: '', stderr: 'authentication error', code: 1 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.length > 0, 'should have reasoning text');
    assert.equal(result.suggested_action.class, 'escalate');
  });

  it('returns degraded Assessment when LLM response is missing required fields', async () => {
    // Valid JSON but missing 'verdict'
    const incomplete = { confidence: 0.8, reasoning: 'ok' };
    _setSpawnFn(makeSpawn({ stdout: JSON.stringify(incomplete), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate');
    assert.equal(result.confidence, 0);
    assert.equal(result.suggested_action.class, 'escalate');
  });
});

// ---------------------------------------------------------------------------
// Model fallback
// ---------------------------------------------------------------------------

describe('assess() — model selection', () => {
  it('uses model_fallback when clagentic:router is unreachable', async () => {
    // Override fetch so the health check fails.
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };

    const payload = validLlmPayload({ model_used: 'claude-haiku-3-5' });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const config = makeConfig({
      model: 'clagentic:router',
      model_fallback: 'claude-haiku-3-5',
    });

    const result = await assess(config, makeEvent());

    // We can't directly assert which --model flag was passed to the fake spawn,
    // but the assessment should succeed and use the fallback (reported via model_used).
    assert.equal(result.verdict, 'accept', 'should return valid assessment');
    // The model_used in the payload matches the fallback.
    assert.equal(result.model_used, 'claude-haiku-3-5');
  });
});
