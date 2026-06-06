/**
 * Tests for src/dispatchers/index.js (loader + dispatch) and
 * src/dispatchers/noop.js (reference dispatcher).
 *
 * Uses Node's built-in test runner. No external deps. Console output is
 * captured per-test by swapping console.log / console.warn.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { loadDispatchers, dispatch } from '../src/dispatchers/index.js';
import * as noop from '../src/dispatchers/noop.js';

// ---------------------------------------------------------------------------
// Console capture helper
// ---------------------------------------------------------------------------

let logLines;
let warnLines;
let origLog;
let origWarn;

beforeEach(() => {
  logLines = [];
  warnLines = [];
  origLog = console.log;
  origWarn = console.warn;
  console.log = (...args) => { logLines.push(args.join(' ')); };
  console.warn = (...args) => { warnLines.push(args.join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return { id: 'owner/repo#1', type: 'issue', title: 'T', ...overrides };
}

function makeAssessment(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.9,
    suggested_action: { class: 'dispatch', body: null, labels: [] },
    ...overrides,
  };
}

const FAKE_MODULE_PATH = fileURLToPath(new URL('./fixtures/fake-dispatcher.js', import.meta.url));

// ---------------------------------------------------------------------------
// noop reference dispatcher
// ---------------------------------------------------------------------------

describe('noop dispatcher', () => {
  it('create_task returns { id, url } and logs a one-line summary', async () => {
    const result = await noop.create_task({}, makeEvent(), makeAssessment());
    assert.deepEqual(result, { id: 'noop-owner/repo#1', url: null });
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /create_task/);
    assert.match(logLines[0], /owner\/repo#1/);
    assert.match(logLines[0], /verdict=accept/);
    assert.match(logLines[0], /action=dispatch/);
  });

  it('update_task logs and returns undefined', async () => {
    const ret = await noop.update_task({}, 'noop-x', { status: 'done' });
    assert.equal(ret, undefined);
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /update_task/);
    assert.match(logLines[0], /noop-x/);
  });
});

// ---------------------------------------------------------------------------
// loadDispatchers
// ---------------------------------------------------------------------------

describe('loadDispatchers', () => {
  it('resolves a bundled dispatcher by name (noop)', async () => {
    const loaded = await loadDispatchers({ dispatchers: [{ name: 'noop' }] });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'noop');
    assert.equal(typeof loaded[0].create_task, 'function');
  });

  it('resolves a module-path dispatcher', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [{ name: 'fake-tracker', module: FAKE_MODULE_PATH }],
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'fake-tracker');
    assert.equal(typeof loaded[0].create_task, 'function');
  });

  it('returns [] for empty dispatchers list', async () => {
    assert.deepEqual(await loadDispatchers({ dispatchers: [] }), []);
  });

  it('returns [] when dispatchers is absent', async () => {
    assert.deepEqual(await loadDispatchers({}), []);
  });

  for (const bad of ['../evil', 'foo/bar', '.hidden', 'a/../b', 'UPPER']) {
    it(`rejects bundled name traversal/invalid: ${JSON.stringify(bad)}`, async () => {
      const loaded = await loadDispatchers({ dispatchers: [{ name: bad }] });
      assert.equal(loaded.length, 0);
      assert.ok(
        warnLines.some((l) => l.includes('invalid bundled name')),
        `expected an invalid-name warning, got: ${JSON.stringify(warnLines)}`,
      );
    });
  }

  it('skips a dispatcher missing create_task with a warning; others still load', async () => {
    // Build a data: URL module that exports a name but no create_task.
    const badModule =
      'data:text/javascript,export const name = "broken";';
    const loaded = await loadDispatchers({
      dispatchers: [
        { name: 'broken', module: badModule },
        { name: 'noop' },
      ],
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'noop');
    assert.ok(warnLines.some((l) => /missing create_task/.test(l)));
  });

  it('skips a module that fails to import without crashing', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [
        { name: 'nope', module: './does-not-exist-anywhere.js' },
        { name: 'noop' },
      ],
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'noop');
    assert.ok(warnLines.some((l) => /failed to load/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('is a clean no-op returning [] for empty dispatchers', async () => {
    const out = await dispatch({ dispatchers: [] }, makeEvent(), makeAssessment());
    assert.deepEqual(out, []);
  });

  it('runs create_task on a bundled dispatcher and returns { name, result }', async () => {
    const out = await dispatch({ dispatchers: [{ name: 'noop' }] }, makeEvent(), makeAssessment());
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'noop');
    assert.deepEqual(out[0].result, { id: 'noop-owner/repo#1', url: null });
    assert.equal(out[0].error, undefined);
  });

  it('runs all dispatchers and isolates a failing one', async () => {
    const throwingModule =
      'data:text/javascript,' +
      'export const name = "boom";' +
      'export async function create_task(){ throw new Error("kaboom"); }';

    const out = await dispatch(
      {
        dispatchers: [
          { name: 'noop' },
          { name: 'boom', module: throwingModule },
          { name: 'fake-tracker', module: FAKE_MODULE_PATH },
        ],
      },
      makeEvent(),
      makeAssessment(),
    );

    assert.equal(out.length, 3);

    const byName = Object.fromEntries(out.map((r) => [r.name, r]));
    assert.deepEqual(byName.noop.result, { id: 'noop-owner/repo#1', url: null });
    assert.equal(byName.boom.result, undefined);
    assert.match(byName.boom.error, /kaboom/);
    assert.deepEqual(byName['fake-tracker'].result, {
      id: 'fake-owner/repo#1',
      url: 'https://tracker.example/fake/1',
    });
  });
});
