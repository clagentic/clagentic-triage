/**
 * Tests for src/hooks/index.js (loader + runner) and
 * src/hooks/console.js (bundled console hook).
 *
 * Uses Node's built-in test runner. No external deps.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadHooks, runHooks } from '../src/hooks/index.js';
import { run as consoleRun, buildPrompt } from '../src/hooks/console.js';

// ---------------------------------------------------------------------------
// Console capture helper
// ---------------------------------------------------------------------------

let warnLines;
let origWarn;

beforeEach(() => {
  warnLines = [];
  origWarn = console.warn;
  console.warn = (...args) => { warnLines.push(args.join(' ')); };
});

afterEach(() => {
  console.warn = origWarn;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#42',
    repo: 'owner/repo',
    number: 42,
    title: 'Fix broken login flow',
    type: 'issue',
    ...overrides,
  };
}

function makeAssessment(overrides = {}) {
  return {
    verdict: 'escalate',
    confidence: 0.85,
    suggested_action: { class: 'escalate', body: null, labels: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// console hook — unit tests
// ---------------------------------------------------------------------------

describe('console hook run()', () => {
  it('skips non-escalate verdict', async () => {
    const result = await consoleRun(makeEvent(), makeAssessment({ verdict: 'accept' }));
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'verdict is not escalate');
  });

  it('skips respond verdict', async () => {
    const result = await consoleRun(makeEvent(), makeAssessment({ verdict: 'respond' }));
    assert.equal(result.skipped, true);
  });

  it('skips reject verdict', async () => {
    const result = await consoleRun(makeEvent(), makeAssessment({ verdict: 'reject' }));
    assert.equal(result.skipped, true);
  });

  it('prompt contains repo and title', () => {
    const event = makeEvent({ repo: 'clagentic/clagentic-triage', number: 7, title: 'Spam wave detected' });
    const assessment = makeAssessment({ verdict: 'escalate', confidence: 0.91 });
    const prompt = buildPrompt(event, assessment);
    assert.ok(prompt.includes('clagentic/clagentic-triage'), 'prompt should include repo');
    assert.ok(prompt.includes('#7'), 'prompt should include issue number');
    assert.ok(prompt.includes('Spam wave detected'), 'prompt should include title');
    assert.ok(prompt.includes('escalate'), 'prompt should include verdict');
    assert.ok(prompt.includes('0.91'), 'prompt should include confidence');
  });

  it('launches with stdin prompt_via', async () => {
    const result = await consoleRun(
      makeEvent(),
      makeAssessment({ verdict: 'escalate' }),
      { command: 'true', prompt_via: 'stdin' },
    );
    assert.equal(result.launched, true);
  });
});

// ---------------------------------------------------------------------------
// loadHooks — loader tests
// ---------------------------------------------------------------------------

describe('loadHooks', () => {
  it('returns [] for empty hooks array', async () => {
    const loaded = await loadHooks({ hooks: [] });
    assert.deepEqual(loaded, []);
  });

  it('returns [] when hooks key is absent', async () => {
    const loaded = await loadHooks({});
    assert.deepEqual(loaded, []);
  });

  it('resolves the bundled console hook by name', async () => {
    const loaded = await loadHooks({ hooks: [{ name: 'console' }] });
    assert.equal(loaded.length, 1);
    assert.equal(typeof loaded[0].mod.run, 'function');
  });

  it('skips an entry with an invalid bundled name and emits a warning', async () => {
    const loaded = await loadHooks({ hooks: [{ name: '../escape' }] });
    assert.equal(loaded.length, 0);
    assert.ok(
      warnLines.some((l) => /invalid bundled name/.test(l)),
      `expected invalid-name warning, got: ${JSON.stringify(warnLines)}`,
    );
  });

  it('skips a module that fails to import without crashing', async () => {
    const loaded = await loadHooks({
      hooks: [
        { name: 'console' },
        { name: 'gone', module: './does-not-exist-hook.js' },
      ],
    });
    // console loads; the bad module is dropped
    assert.equal(loaded.length, 1);
    assert.ok(warnLines.some((l) => /failed to load/.test(l)));
  });

  it('skips a module missing run() and emits a warning', async () => {
    const noRun = 'data:text/javascript,export const name = "norune";';
    const loaded = await loadHooks({ hooks: [{ name: 'norune', module: noRun }] });
    assert.equal(loaded.length, 0);
    assert.ok(warnLines.some((l) => /missing run/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// runHooks — runner tests
// ---------------------------------------------------------------------------

describe('runHooks', () => {
  it('is a clean no-op for empty hooks list', async () => {
    const results = await runHooks({ hooks: [] }, makeEvent(), makeAssessment());
    assert.deepEqual(results, []);
  });

  it('returns { skipped: true } for the console hook on non-escalate assessment', async () => {
    const results = await runHooks(
      { hooks: [{ name: 'console', config: { command: 'true' } }] },
      makeEvent(),
      makeAssessment({ verdict: 'accept' }),
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].result.skipped, true);
    assert.equal(results[0].error, undefined);
  });

  it('catches a hook that throws and returns { name, error } without throwing', async () => {
    // Build a data: URL hook module that always throws.
    const throwingHook =
      'data:text/javascript,' +
      'export async function run(){ throw new Error("boom"); }';

    const results = await runHooks(
      { hooks: [{ name: 'bomb', module: throwingHook }] },
      makeEvent(),
      makeAssessment(),
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].result, undefined);
    assert.match(results[0].error, /boom/);
    // Warning should have been emitted
    assert.ok(warnLines.some((l) => /hook.*failed/.test(l)));
  });

  it('runs all hooks and isolates a failing one', async () => {
    const throwingHook =
      'data:text/javascript,' +
      'export async function run(){ throw new Error("crash"); }';

    const results = await runHooks(
      {
        hooks: [
          { name: 'console', config: { command: 'true' } },
          { name: 'crash', module: throwingHook },
        ],
      },
      makeEvent(),
      makeAssessment({ verdict: 'accept' }),
    );
    assert.equal(results.length, 2);
    // console hook skips non-escalate
    assert.equal(results[0].result?.skipped, true);
    // crash hook records the error
    assert.match(results[1].error, /crash/);
  });
});

// ---------------------------------------------------------------------------
// Prompt content test
// ---------------------------------------------------------------------------

describe('console hook prompt content', () => {
  it('includes repo, number, title, verdict, confidence, and suggested action', () => {
    const event = makeEvent({ repo: 'clagentic/clagentic-triage', number: 99, title: 'Login spam wave' });
    const assessment = makeAssessment({ verdict: 'escalate', confidence: 0.77, suggested_action: { class: 'escalate' } });
    const prompt = buildPrompt(event, assessment);
    assert.ok(prompt.includes('clagentic/clagentic-triage'), 'repo');
    assert.ok(prompt.includes('#99'), 'number');
    assert.ok(prompt.includes('Login spam wave'), 'title');
    assert.ok(prompt.includes('escalate'), 'verdict');
    assert.ok(prompt.includes('0.77'), 'confidence');
  });

  it('falls back gracefully for missing event fields', () => {
    const prompt = buildPrompt({}, { verdict: 'escalate', confidence: 0.5 });
    assert.ok(prompt.includes('(unknown repo)'), 'fallback repo');
    assert.ok(prompt.includes('(unknown)'), 'fallback number');
    assert.ok(prompt.includes('(no title)'), 'fallback title');
  });
});
