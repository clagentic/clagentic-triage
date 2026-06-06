/**
 * Tests for dispatcher wiring: the integration between the approval/queue path
 * (cli.js + queue.js) and the pipeline auto-approve path (pipeline.js) and
 * the dispatch() runner in dispatchers/index.js.
 *
 * Tests cover:
 *   - Auto-approve path: dispatch-class item triggers dispatch() (mocked dispatchers)
 *   - CLI approve path: dispatch-class item triggers dispatch(); non-dispatch items do not
 *   - dispatch_results persisted on queue entry
 *   - Config validation: valid dispatcher entries pass; invalid entries throw
 *
 * Uses Node's built-in test runner (node:test). No external dependencies.
 * Writes to os.tmpdir() — never to the project tree.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { enqueue, readAll, resolveItem } from '../src/queue.js';
import { dispatch } from '../src/dispatchers/index.js';
import { loadConfig, ConfigError } from '../src/config/loader.js';

// ---------------------------------------------------------------------------
// Path to the fake dispatcher fixture
// ---------------------------------------------------------------------------

const FAKE_DISPATCHER_PATH = fileURLToPath(
  new URL('./fixtures/fake-dispatcher.js', import.meta.url),
);

// ---------------------------------------------------------------------------
// Console capture (suppress warnings from dispatch internals during tests)
// ---------------------------------------------------------------------------

let origWarn;
let warnLines;

beforeEach(() => {
  warnLines = [];
  origWarn = console.warn;
  console.warn = (...args) => { warnLines.push(args.join(' ')); };
});

afterEach(() => {
  console.warn = origWarn;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpQueuePath() {
  const unique = randomBytes(6).toString('hex');
  return join(tmpdir(), `triage-wiring-test-${unique}`, 'pending.jsonl');
}

function makeQueueConfig(queuePath, dispatchers = []) {
  return { pending_queue: queuePath, dispatchers };
}

function makeEvent(id = 'owner/repo#1') {
  return { id, type: 'issue', title: 'Test issue' };
}

function makeAssessment(actionClass = 'dispatch') {
  return {
    verdict: 'accept',
    confidence: 0.9,
    suggested_action: { class: actionClass, body: null, labels: [] },
    assessed_at: new Date().toISOString(),
  };
}

/**
 * Inline reimplementation of the dispatch-class auto-approve path in pipeline.js.
 * Mirrors _executeAction (dispatch case) + enqueue so tests can exercise the
 * wiring without spawning the full pipeline (which requires real enrich/assess).
 *
 * This shim must stay in sync with pipeline.js's _executeAction dispatch case.
 */
async function simulatePipelineDispatch(config, event, assessment) {
  // This mirrors what pipeline.js does for an auto-approved dispatch-class item.
  const dispatchResults = await dispatch(config, event, assessment);
  await enqueue(config, {
    event,
    assessment,
    queue_reason: 'dispatch',
    dispatch_results: dispatchResults,
  });
  return dispatchResults;
}

// ---------------------------------------------------------------------------
// Auto-approve pipeline path: dispatch-class triggers dispatch()
// ---------------------------------------------------------------------------

describe('pipeline auto-approve: dispatch-class item', () => {
  it('calls dispatch() and stores results on the enqueued item when dispatchers are configured', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath, [
      { name: 'fake-tracker', module: FAKE_DISPATCHER_PATH },
    ]);
    const event = makeEvent('owner/repo#42');
    const assessment = makeAssessment('dispatch');

    const results = await simulatePipelineDispatch(config, event, assessment);

    // dispatch() returned results for the fake-tracker dispatcher.
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'fake-tracker');
    assert.deepEqual(results[0].result, {
      id: 'fake-owner/repo#42',
      url: 'https://tracker.example/fake/1',
    });
    assert.equal(results[0].error, undefined);

    // The queue entry was written with dispatch_results.
    const all = await readAll(config);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].dispatch_results, results);
  });

  it('enqueues with dispatch_results: [] when no dispatchers are configured', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath, []);
    const event = makeEvent();
    const assessment = makeAssessment('dispatch');

    const results = await simulatePipelineDispatch(config, event, assessment);
    assert.deepEqual(results, []);

    const all = await readAll(config);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].dispatch_results, []);
  });

  it('does NOT call dispatch() for non-dispatch-class items (e.g. respond)', async () => {
    // Simulate what the pipeline does for a respond-class item: it calls
    // adapter.post_comment and does NOT call dispatch(). The queue entry
    // should have dispatch_results: null.
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath, [
      { name: 'fake-tracker', module: FAKE_DISPATCHER_PATH },
    ]);
    const event = makeEvent();
    const assessment = makeAssessment('respond');

    // For non-dispatch items, the pipeline enqueues without calling dispatch().
    await enqueue(config, {
      event,
      assessment,
      queue_reason: 'low_confidence',
      // dispatch_results intentionally omitted (default null)
    });

    const all = await readAll(config);
    assert.equal(all.length, 1);
    assert.equal(all[0].dispatch_results, null);
  });
});

// ---------------------------------------------------------------------------
// CLI approve path: dispatch-class triggers dispatch()
// ---------------------------------------------------------------------------

describe('CLI approve path: dispatch-class item', () => {
  it('calls dispatch() and persists results on the resolved entry', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath, [
      { name: 'fake-tracker', module: FAKE_DISPATCHER_PATH },
    ]);
    const event = makeEvent('owner/repo#7');
    const assessment = makeAssessment('dispatch');

    // Enqueue a dispatch-class item.
    const queued = await enqueue(config, { event, assessment, queue_reason: 'dispatch' });

    // Simulate what cmdApprove does:
    //   1. Read all items.
    //   2. If action class is 'dispatch', call dispatch().
    //   3. resolveItem with dispatch_results.
    const all = await readAll(config);
    const item = all.find((i) => i.id === queued.id);
    assert.ok(item, 'item should be in the queue');

    let dispatchResults = null;
    if (item.assessment?.suggested_action?.class === 'dispatch') {
      dispatchResults = await dispatch(config, item.event, item.assessment);
    }

    const resolved = await resolveItem(config, queued.id, {
      action: 'approved',
      dispatch_results: dispatchResults,
    });

    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.dispatch_results.length, 1);
    assert.equal(resolved.dispatch_results[0].name, 'fake-tracker');
    assert.deepEqual(resolved.dispatch_results[0].result, {
      id: 'fake-owner/repo#7',
      url: 'https://tracker.example/fake/1',
    });
  });

  it('does NOT call dispatch() for non-dispatch-class items', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath, [
      { name: 'fake-tracker', module: FAKE_DISPATCHER_PATH },
    ]);
    const event = makeEvent();
    const assessment = makeAssessment('respond');

    const queued = await enqueue(config, { event, assessment, queue_reason: 'low_confidence' });

    // Simulate cmdApprove logic for a respond-class item — dispatch is not called.
    const all = await readAll(config);
    const item = all.find((i) => i.id === queued.id);

    let dispatchResults = null;
    if (item.assessment?.suggested_action?.class === 'dispatch') {
      dispatchResults = await dispatch(config, item.event, item.assessment);
    }

    // dispatch_results must remain null for non-dispatch items.
    assert.equal(dispatchResults, null);

    const resolved = await resolveItem(config, queued.id, {
      action: 'approved',
      dispatch_results: dispatchResults,
    });

    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.dispatch_results, null);
  });
});

// ---------------------------------------------------------------------------
// dispatch_results persistence on queue entries
// ---------------------------------------------------------------------------

describe('dispatch_results persistence', () => {
  it('persists dispatch_results on enqueue and survives a full read-write cycle', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath);
    const fakeResults = [{ name: 'noop', result: { id: 'noop-x', url: null } }];

    await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment('dispatch'),
      queue_reason: 'dispatch',
      dispatch_results: fakeResults,
    });

    const all = await readAll(config);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].dispatch_results, fakeResults);
  });

  it('persists dispatch_results on resolveItem', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath);

    const queued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment('dispatch'),
      queue_reason: 'dispatch',
    });

    const fakeResults = [{ name: 'jira', result: { id: 'PROJ-1', url: 'https://jira.example/PROJ-1' } }];
    const resolved = await resolveItem(config, queued.id, {
      action: 'approved',
      dispatch_results: fakeResults,
    });

    assert.deepEqual(resolved.dispatch_results, fakeResults);

    // Verify it round-trips through the JSONL file.
    const all = await readAll(config);
    assert.deepEqual(all[0].dispatch_results, fakeResults);
  });

  it('dispatch_results defaults to null when not provided to enqueue', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath);

    await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment('respond'),
      queue_reason: 'low_confidence',
    });

    const all = await readAll(config);
    assert.equal(all[0].dispatch_results, null);
  });

  it('dispatch_results defaults to null when not provided to resolveItem', async () => {
    const queuePath = tmpQueuePath();
    const config = makeQueueConfig(queuePath);

    const queued = await enqueue(config, {
      event: makeEvent(),
      assessment: makeAssessment('respond'),
      queue_reason: 'low_confidence',
    });

    const resolved = await resolveItem(config, queued.id, { action: 'rejected' });
    assert.equal(resolved.dispatch_results, null);
  });
});

// ---------------------------------------------------------------------------
// Config validation: dispatchers array
// ---------------------------------------------------------------------------

/**
 * Minimal valid env to pass loadConfig's built-in validations without a
 * config file on disk. Uses a temp dir so no triage.config.json is found.
 */
async function loadWithDispatchers(dispatchersValue) {
  const dir = join(tmpdir(), `triage-cfg-test-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });

  // Write a minimal config file to avoid the clagentic-router deprecation shim
  // and pass all other validations with known-good values.
  const configObj = {
    source: { adapter: 'github', org: 'test-org' },
    runner: 'claude-cli',
    model: 'claude-sonnet-4-5',
    dispatchers: dispatchersValue,
  };
  await writeFile(join(dir, 'triage.config.json'), JSON.stringify(configObj), 'utf8');

  try {
    return await loadConfig({
      cwd: dir,
      _env: {},
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('config validation: dispatchers entries', () => {
  it('accepts an empty dispatchers array', async () => {
    const cfg = await loadWithDispatchers([]);
    assert.deepEqual(cfg.dispatchers, []);
  });

  it('accepts a valid entry with only a name (built-in)', async () => {
    const cfg = await loadWithDispatchers([{ name: 'noop' }]);
    assert.equal(cfg.dispatchers[0].name, 'noop');
  });

  it('accepts a valid entry with only a module path', async () => {
    const cfg = await loadWithDispatchers([{ module: '/some/path/my-dispatcher.js' }]);
    assert.equal(cfg.dispatchers[0].module, '/some/path/my-dispatcher.js');
  });

  it('accepts a valid entry with both name and module', async () => {
    const cfg = await loadWithDispatchers([{ name: 'my-tracker', module: '/opt/my-tracker/index.js' }]);
    assert.equal(cfg.dispatchers[0].name, 'my-tracker');
    assert.equal(cfg.dispatchers[0].module, '/opt/my-tracker/index.js');
  });

  it('accepts a valid entry with extra unknown fields (pass-through)', async () => {
    const cfg = await loadWithDispatchers([{ name: 'noop', base_url: 'https://example.com', project: 'proj' }]);
    assert.equal(cfg.dispatchers[0].name, 'noop');
    assert.equal(cfg.dispatchers[0].base_url, 'https://example.com');
  });

  it('accepts a name with hyphens and digits', async () => {
    const cfg = await loadWithDispatchers([{ name: 'my-tracker-2', module: './my-tracker-2.js' }]);
    assert.equal(cfg.dispatchers[0].name, 'my-tracker-2');
  });

  it('rejects an entry with no name and no module', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ url: 'https://example.com' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /must have either a "name" or a "module"/);
        return true;
      },
    );
  });

  it('rejects an entry where name contains invalid chars (uppercase)', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ name: 'MyTracker' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /name must be a string matching/);
        return true;
      },
    );
  });

  it('rejects an entry where name contains a slash (path traversal)', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ name: 'foo/bar' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /name must be a string matching/);
        return true;
      },
    );
  });

  it('rejects an entry where name starts with a hyphen', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ name: '-bad' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /name must be a string matching/);
        return true;
      },
    );
  });

  it('rejects an entry where module is an empty string', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ module: '' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /module must be a non-empty string/);
        return true;
      },
    );
  });

  it('rejects an entry where module is whitespace only', async () => {
    await assert.rejects(
      () => loadWithDispatchers([{ module: '   ' }]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /module must be a non-empty string/);
        return true;
      },
    );
  });

  it('rejects a non-object entry (e.g. a string)', async () => {
    await assert.rejects(
      () => loadWithDispatchers(['noop']),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /must be an object/);
        return true;
      },
    );
  });

  it('rejects a null entry', async () => {
    await assert.rejects(
      () => loadWithDispatchers([null]),
      (err) => {
        assert.ok(err instanceof ConfigError, 'should be ConfigError');
        assert.match(err.message, /must be an object/);
        return true;
      },
    );
  });
});
