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
import { _setSpawnFn, callLlm, LlmError } from '../src/llm.js';

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
 *
 * Default class is 'respond', not 'approve' (lr-757a69): 'approve' is
 * PR-only (see src/action_classes.js), but makeEvent()'s default type is
 * 'issue' — 'respond' is valid for both event types, so this default payload
 * pairs with makeEvent()'s default without tripping the assessor's
 * class/type mismatch re-route guard. Tests that specifically exercise
 * 'approve' override both suggested_action and the event's type to 'pr'.
 */
function validLlmPayload(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.9,
    reasoning: 'Clear bug report with reproduction steps.',
    suggested_action: {
      classes: ['respond'],
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
    // Slack bot token pattern: xoxb- prefix. Value is split across concat to
    // avoid triggering GitHub push protection on the test file itself.
    const prefix = 'xoxb';
    const input = `slack token: ${prefix}-123456789-ABCDEFGHIJKLMN`;
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
    assert.deepEqual(result.suggested_action.classes, ['respond']);
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
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
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
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
  });

  it('returns degraded Assessment on non-zero exit code', async () => {
    _setSpawnFn(makeSpawn({ stdout: '', stderr: 'authentication error', code: 1 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.length > 0, 'should have reasoning text');
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
  });

  it('returns degraded Assessment when LLM response is missing required fields', async () => {
    // Valid JSON but missing 'verdict'
    const incomplete = { confidence: 0.8, reasoning: 'ok' };
    _setSpawnFn(makeSpawn({ stdout: JSON.stringify(incomplete), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate');
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
  });

  // RT-007: strict schema validation — bad_response code paths
  it('returns degraded Assessment when verdict is not a valid enum value (RT-007)', async () => {
    const bad = validLlmPayload({ verdict: 'approve_everything' });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'invalid verdict → degraded escalate');
    assert.equal(result.confidence, 0);
  });

  it('returns degraded Assessment when confidence is a string, not a number (RT-007)', async () => {
    // String "1.0" bypasses numeric comparison — must be caught as bad_response
    const bad = validLlmPayload({ confidence: '1.0' });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'string confidence → degraded escalate');
    assert.equal(result.confidence, 0);
  });

  it('returns degraded Assessment when confidence is out of range (RT-007)', async () => {
    const bad = validLlmPayload({ confidence: 1.5 });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'out-of-range confidence → degraded escalate');
    assert.equal(result.confidence, 0);
  });

  it('returns degraded Assessment when suggested_action.class is not a valid enum (RT-007)', async () => {
    const bad = validLlmPayload({
      suggested_action: { class: 'do_everything', body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'invalid action class → degraded escalate');
    assert.equal(result.confidence, 0);
  });

  // T7 (lr-f0f2): multi-action verdicts — suggested_action.classes[]
  it('returns degraded Assessment when any entry in suggested_action.classes is invalid (RT-007)', async () => {
    const bad = validLlmPayload({
      suggested_action: { classes: ['respond', 'do_everything'], body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'one invalid class in the array → degraded escalate');
    assert.equal(result.confidence, 0);
  });

  it('returns degraded Assessment when suggested_action.classes is an empty array', async () => {
    const bad = validLlmPayload({
      suggested_action: { classes: [], body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(bad), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.equal(result.verdict, 'escalate', 'empty classes array → degraded escalate');
    assert.equal(result.confidence, 0);
  });
});

// ---------------------------------------------------------------------------
// assess() — action-class/event-type re-route guard (lr-757a69)
// ---------------------------------------------------------------------------

describe('assess() — action-class/event-type re-route guard', () => {
  it('re-routes to escalate when the model emits "approve" for an issue event', async () => {
    const payload = validLlmPayload({
      suggested_action: { classes: ['approve'], body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent({ type: 'issue' }));

    assert.equal(result.verdict, 'escalate', 'invalid class for type → escalate, not the model verdict');
    assert.equal(result.confidence, 0);
    assert.ok(
      result.reasoning.includes('approve') && result.reasoning.includes('issue'),
      `reasoning should name the invalid class and the event type; got: ${result.reasoning}`,
    );
    // No valid class survives (the only class named was invalid) — falls back to escalate.
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
  });

  it('re-routes to escalate when the model emits "request_changes" for an issue event', async () => {
    const payload = validLlmPayload({
      suggested_action: { classes: ['request_changes'], body: 'please fix', dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent({ type: 'issue' }));

    assert.equal(result.verdict, 'escalate');
    assert.deepEqual(result.suggested_action.classes, ['escalate']);
  });

  it('drops only the invalid class from a multi-action verdict, keeping the valid ones', async () => {
    const payload = validLlmPayload({
      suggested_action: {
        classes: ['respond', 'approve'],
        body: 'Thanks!',
        dispatch_target: null,
        labels: [],
      },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent({ type: 'issue' }));

    assert.equal(result.verdict, 'escalate', 'any invalid class in the array re-routes the whole verdict');
    assert.deepEqual(
      result.suggested_action.classes,
      ['respond'],
      'the still-valid class (respond) survives; only approve is dropped',
    );
  });

  it('does not re-route a valid class for a pr event', async () => {
    const payload = validLlmPayload({
      suggested_action: { classes: ['approve'], body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent({ type: 'pr' }));

    assert.equal(result.verdict, 'accept', 'approve is valid for a pr event — no re-route');
    assert.deepEqual(result.suggested_action.classes, ['approve']);
  });

  it('does not re-route dispatch for an issue event (the correct class for an accepted issue)', async () => {
    const payload = validLlmPayload({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: 'backend', labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent({ type: 'issue' }));

    assert.equal(result.verdict, 'accept');
    assert.deepEqual(result.suggested_action.classes, ['dispatch']);
  });
});

// ---------------------------------------------------------------------------
// assess() — multi-action verdicts (T7, lr-f0f2)
// ---------------------------------------------------------------------------

describe('assess() — multi-action verdicts (classes[])', () => {
  it('returns every class from a multi-action suggested_action.classes payload', async () => {
    const payload = validLlmPayload({
      suggested_action: {
        classes: ['respond', 'dispatch'],
        body: 'Thanks, filing this now.',
        dispatch_target: 'backend',
        labels: ['status/accepted'],
      },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const result = await assess(makeConfig(), makeEvent());

    assert.deepEqual(result.suggested_action.classes, ['respond', 'dispatch']);
    assert.equal(result.suggested_action.body, 'Thanks, filing this now.');
  });

  it('normalizes a legacy singular suggested_action.class into a one-element classes array', async () => {
    const payload = validLlmPayload({
      suggested_action: { class: 'approve', body: null, dispatch_target: null, labels: [] },
    });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    // 'approve' is PR-only (lr-757a69) — use a PR event so this normalization
    // test exercises the singular-to-array migration in isolation, without
    // also tripping the assessor's class/type mismatch re-route guard.
    const result = await assess(makeConfig(), makeEvent({ type: 'pr' }));

    assert.deepEqual(result.suggested_action.classes, ['approve']);
  });
});

// ---------------------------------------------------------------------------
// Model / runner selection
// ---------------------------------------------------------------------------

describe('assess() — model selection', () => {
  it('passes config.model to the claude-cli runner and returns a valid assessment', async () => {
    const payload = validLlmPayload({ model_used: 'claude-opus-4' });
    _setSpawnFn(makeSpawn({ stdout: cliEnvelope(payload), code: 0 }));

    const config = makeConfig({ model: 'claude-opus-4', runner: 'claude-cli' });
    const result = await assess(config, makeEvent());

    assert.equal(result.verdict, 'accept');
    assert.equal(result.model_used, 'claude-opus-4');
  });

  it('produces degraded assessment when anthropic-api runner has no API key configured', async () => {
    // anthropic-api runner requires an API key env var — omitting it should
    // throw LlmError and the assessor should degrade to escalate/confidence=0.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const config = makeConfig({ runner: 'anthropic-api', model: 'claude-opus-4' });
    const result = await assess(config, makeEvent());

    if (prevKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = prevKey;
    }

    assert.equal(result.verdict, 'escalate', 'missing API key → degraded escalate');
    assert.equal(result.confidence, 0);
  });
});

// ---------------------------------------------------------------------------
// callLlm() — runner dispatch
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch that returns the given response object.
 *
 * @param {object} opts
 * @param {number}  [opts.status]   - HTTP status code (default 200)
 * @param {object}  [opts.body]     - JSON body to return
 * @param {boolean} [opts.throws]   - If true, throw a network error
 * @param {string}  [opts.rawText]  - Raw text body (takes precedence over body)
 * @returns {Function}
 */
function makeFetch({ status = 200, body = null, throws = false, rawText = null } = {}) {
  return async (_url, _opts) => {
    if (throws) {
      const err = new Error('network error');
      throw err;
    }
    const responseBody = rawText ?? JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(responseBody),
      text: async () => responseBody,
    };
  };
}

/**
 * Save/restore fetch around a test.
 */
function withFetch(fn) {
  return async () => {
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      // The test body runs inside the outer it() — nothing to call here.
      // This wrapper is used inline.
    } finally {
      // Cleanup is handled by afterEach.
    }
  };
}

describe('callLlm() — anthropic-api runner', () => {
  it('POSTs to Anthropic endpoint and parses content[0].text as JSON', async () => {
    const payload = validLlmPayload();
    let capturedUrl = null;
    let capturedBody = null;
    let capturedHeaders = null;

    process.env.TEST_ANTHROPIC_KEY = 'test-key-for-unit-test';

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ text: JSON.stringify(payload) }] }),
        text: async () => '',
      };
    };

    const result = await callLlm('test prompt', {
      runner: 'anthropic-api',
      model: 'claude-opus-4',
      config: { runner_api_key_env: 'TEST_ANTHROPIC_KEY' },
    });

    assert.ok(capturedUrl.includes('anthropic.com'), 'should POST to Anthropic API');
    assert.equal(capturedBody.model, 'claude-opus-4', 'model should be forwarded');
    assert.equal(capturedBody.messages[0].content, 'test prompt', 'prompt should be in messages');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01', 'API version header should be set');
    assert.equal(result.verdict, 'accept');
    assert.equal(result.confidence, 0.9);
  });

  it('throws LlmError with code exit_nonzero on non-200 response', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'test-key-for-unit-test';

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Unauthorized',
    });

    await assert.rejects(
      () => callLlm('test prompt', { runner: 'anthropic-api', config: { runner_api_key_env: 'TEST_ANTHROPIC_KEY' } }),
      (err) => {
        assert.ok(err instanceof LlmError, 'should be LlmError');
        assert.equal(err.code, 'exit_nonzero');
        assert.ok(err.message.includes('401'), 'message should include status code');
        return true;
      },
    );
  });

  it('reads API key from the env var named in runner_api_key_env', async () => {
    const payload = validLlmPayload();
    let capturedHeaders = null;

    process.env.MY_TEST_ANTHROPIC_KEY = 'test-key-value-xyz';
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ text: JSON.stringify(payload) }] }),
        text: async () => '',
      };
    };

    await callLlm('test', {
      runner: 'anthropic-api',
      config: { runner_api_key_env: 'MY_TEST_ANTHROPIC_KEY' },
    });
    delete process.env.MY_TEST_ANTHROPIC_KEY;

    assert.equal(capturedHeaders['x-api-key'], 'test-key-value-xyz', 'API key should be sent');
  });
});

describe('callLlm() — openai-compatible runner', () => {
  it('POSTs to runner_url/chat/completions and parses choices[0].message.content', async () => {
    const payload = validLlmPayload();
    let capturedUrl = null;
    let capturedBody = null;

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        text: async () => '',
      };
    };

    const result = await callLlm('test prompt', {
      runner: 'openai-compatible',
      model: 'gpt-4o',
      config: { runner_url: 'http://localhost:11434', runner_api_key_env: null },
    });

    assert.ok(capturedUrl.includes('localhost:11434'), 'should use runner_url');
    assert.ok(capturedUrl.endsWith('/chat/completions'), 'should POST to /chat/completions');
    assert.equal(capturedBody.model, 'gpt-4o', 'model should be forwarded');
    assert.equal(result.verdict, 'accept');
  });

  it('omits Authorization header when api key env var is empty (Ollama local)', async () => {
    const payload = validLlmPayload();
    let capturedHeaders = null;

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        text: async () => '',
      };
    };

    // runner_api_key_env points to an env var that is not set — key should be absent.
    delete process.env.OPENAI_API_KEY;
    await callLlm('test', {
      runner: 'openai-compatible',
      config: { runner_url: 'http://localhost:11434' },
    });

    assert.ok(!('Authorization' in capturedHeaders), 'Authorization should be omitted when key is missing');
  });

  it('throws LlmError when runner_url is not set', async () => {
    await assert.rejects(
      () => callLlm('test', { runner: 'openai-compatible', config: {} }),
      (err) => {
        assert.ok(err instanceof LlmError, 'should be LlmError');
        assert.ok(err.message.includes('runner_url'), 'message should mention runner_url');
        return true;
      },
    );
  });

  it('throws LlmError with status on non-200 response', async () => {
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'Service Unavailable',
    });

    await assert.rejects(
      () => callLlm('test', { runner: 'openai-compatible', config: { runner_url: 'http://localhost:11434' } }),
      (err) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'exit_nonzero');
        assert.ok(err.message.includes('503'));
        return true;
      },
    );
  });
});

describe('callLlm() — clagentic-router runner', () => {
  it('POSTs to runner_url/v1/assess with model and prompt', async () => {
    const payload = validLlmPayload();
    let capturedUrl = null;
    let capturedBody = null;
    let capturedHeaders = null;

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => '',
      };
    };

    const result = await callLlm('test prompt', {
      runner: 'clagentic-router',
      model: 'fast',
      config: { runner_url: 'http://router:4200', runner_api_key_env: null },
    });

    assert.ok(capturedUrl.includes('router:4200'), 'should use runner_url');
    assert.ok(capturedUrl.endsWith('/v1/assess'), 'should POST to /v1/assess');
    assert.equal(capturedBody.model, 'fast', 'model should be forwarded');
    assert.equal(capturedBody.prompt, 'test prompt', 'prompt should be in body');
    assert.ok(!('Authorization' in capturedHeaders), 'should omit auth when key is not set');
    assert.equal(result.verdict, 'accept');
  });

  it('uses default router URL when runner_url is not configured', async () => {
    const payload = validLlmPayload();
    let capturedUrl = null;

    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => '',
      };
    };

    await callLlm('test', {
      runner: 'clagentic-router',
      config: {},
    });

    assert.ok(capturedUrl.includes('localhost:4200'), 'should fall back to default URL');
  });

  it('sends Authorization header when runner_api_key_env is set and env var is present', async () => {
    const payload = validLlmPayload();
    let capturedHeaders = null;

    process.env.MY_ROUTER_TOKEN = 'router-token-abc';
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => '',
      };
    };

    await callLlm('test', {
      runner: 'clagentic-router',
      config: { runner_url: 'http://localhost:4200', runner_api_key_env: 'MY_ROUTER_TOKEN' },
    });
    delete process.env.MY_ROUTER_TOKEN;

    assert.ok('Authorization' in capturedHeaders, 'Authorization header should be present');
    assert.ok(capturedHeaders['Authorization'].includes('Bearer'), 'should be Bearer token');
  });

  it('throws LlmError on non-200 response', async () => {
    globalThis._fetchBackup = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => 'Bad Gateway',
    });

    await assert.rejects(
      () => callLlm('test', { runner: 'clagentic-router', config: {} }),
      (err) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'exit_nonzero');
        assert.ok(err.message.includes('502'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// _buildPrompt — approve-class constraint rule (lr-4717)
// ---------------------------------------------------------------------------

/**
 * Build a spawn function that captures the full prompt passed to the claude
 * CLI — whether delivered via --print argv or via stdin. The prompt is stored
 * in capturedPrompt[0] after assess() resolves.
 *
 * The claude-cli runner uses stdin when prompt.length > STDIN_THRESHOLD (4000);
 * otherwise it passes the prompt as a --print argument. Both paths are covered.
 *
 * @param {string[]} capturedPrompt  - Single-element array populated with the prompt
 * @param {object}   childOpts       - Forwarded to makeChild
 * @returns {Function}
 */
function makePromptCapturingSpawn(capturedPrompt, childOpts) {
  return function fakeSpawn(_bin, args, _opts) {
    // Short prompts arrive via --print <value> in args.
    const printIdx = args.indexOf('--print');
    if (printIdx !== -1 && args[printIdx + 1] !== undefined) {
      capturedPrompt[0] = args[printIdx + 1];
    }

    const child = makeChild(childOpts);

    // Long prompts arrive via stdin.write(); capture those too.
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      capturedPrompt[0] = typeof chunk === 'string' ? chunk : chunk.toString();
      return origWrite(chunk, ...rest);
    };

    return child;
  };
}

describe('_buildPrompt() — approve-class PR-only rule (lr-4717)', () => {
  it('prompt for an issue event contains the approve-is-PR-only rule', async () => {
    const capturedPrompt = [];
    const payload = validLlmPayload({ suggested_action: { class: 'dispatch', body: null, dispatch_target: 'backend', labels: [] } });
    _setSpawnFn(makePromptCapturingSpawn(capturedPrompt, { stdout: cliEnvelope(payload), code: 0 }));

    const event = makeEvent({ type: 'issue' });
    await assess(makeConfig(), event);

    const prompt = capturedPrompt[0] ?? '';
    assert.ok(
      prompt.includes("'approve' is valid ONLY for PRs"),
      `prompt must contain approve-is-PR-only constraint; got: ${prompt.slice(0, 500)}`,
    );
    assert.ok(
      prompt.includes("use 'dispatch'"),
      "prompt must mention 'dispatch' as the alternative for accepted issues",
    );
  });

  it('prompt for a PR event also contains the approve-is-PR-only rule', async () => {
    const capturedPrompt = [];
    const payload = validLlmPayload();
    _setSpawnFn(makePromptCapturingSpawn(capturedPrompt, { stdout: cliEnvelope(payload), code: 0 }));

    const event = makeEvent({ type: 'pr' });
    await assess(makeConfig(), event);

    const prompt = capturedPrompt[0] ?? '';
    assert.ok(
      prompt.includes("'approve' is valid ONLY for PRs"),
      `PR prompt must also carry the constraint rule; got: ${prompt.slice(0, 500)}`,
    );
  });
});
