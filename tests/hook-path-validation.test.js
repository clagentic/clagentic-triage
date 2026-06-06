/**
 * Tests for _validate_module_path (RT-009) and the loadDispatchers skip
 * behaviour on invalid module paths.
 *
 * Uses Node's built-in test runner. No external deps.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { _validate_module_path, loadDispatchers } from '../src/dispatchers/index.js';

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
// Helpers
// ---------------------------------------------------------------------------

// Derive a stable cwd for tests that is unambiguously inside the project.
const TEST_CWD = fileURLToPath(new URL('..', import.meta.url));

// A path that is guaranteed to be outside TEST_CWD regardless of where the
// project lives. /etc is the canonical sentinel for "system file" in the task.
const OUTSIDE_PATH = '/etc/passwd';

// A path inside the project that exists (the fixtures directory).
const INSIDE_ABS_PATH = join(TEST_CWD, 'tests', 'fixtures', 'fake-dispatcher.js');

// ---------------------------------------------------------------------------
// _validate_module_path — unit tests
// ---------------------------------------------------------------------------

describe('_validate_module_path', () => {
  it('bare npm package name is valid', () => {
    const result = _validate_module_path('my-package', TEST_CWD);
    assert.deepEqual(result, { valid: true });
  });

  it('scoped npm package name is valid', () => {
    const result = _validate_module_path('@scope/package', TEST_CWD);
    assert.deepEqual(result, { valid: true });
  });

  it('relative path within cwd is valid', () => {
    // ./tests/fixtures/fake-dispatcher.js resolves inside the project root.
    const result = _validate_module_path('./tests/fixtures/fake-dispatcher.js', TEST_CWD);
    assert.deepEqual(result, { valid: true });
  });

  it('relative path escaping cwd via ../ traversal is invalid', () => {
    const result = _validate_module_path('../../etc/shadow', TEST_CWD);
    assert.equal(result.valid, false);
    assert.match(result.reason, /outside the project root/);
  });

  it('absolute path within cwd is valid', () => {
    const result = _validate_module_path(INSIDE_ABS_PATH, TEST_CWD);
    assert.deepEqual(result, { valid: true });
  });

  it('absolute path outside cwd is invalid', () => {
    const result = _validate_module_path(OUTSIDE_PATH, TEST_CWD);
    assert.equal(result.valid, false);
    assert.match(result.reason, /outside the project root/);
  });

  it('path with null byte is invalid', () => {
    const result = _validate_module_path('./valid\0/path', TEST_CWD);
    assert.equal(result.valid, false);
    assert.match(result.reason, /null byte/);
  });

  it('returns { valid: false } without throwing when path is invalid', () => {
    // Ensure the function never throws — callers rely on the return value.
    assert.doesNotThrow(() => _validate_module_path('/etc/passwd', TEST_CWD));
    assert.doesNotThrow(() => _validate_module_path('../../escape', TEST_CWD));
    assert.doesNotThrow(() => _validate_module_path('foo\0bar', TEST_CWD));
  });
});

// ---------------------------------------------------------------------------
// loadDispatchers — skip-on-invalid-module-path integration
// ---------------------------------------------------------------------------

describe('loadDispatchers with invalid module paths', () => {
  it('skips an absolute-path-outside-cwd entry and emits a warning', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [{ name: 'evil', module: OUTSIDE_PATH }],
    });
    assert.equal(loaded.length, 0);
    assert.ok(
      warnLines.some((l) => /module path rejected/.test(l)),
      `expected a "module path rejected" warning, got: ${JSON.stringify(warnLines)}`,
    );
  });

  it('skips an escaping-relative-path entry and emits a warning', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [{ name: 'escape', module: '../../../etc/shadow' }],
    });
    assert.equal(loaded.length, 0);
    assert.ok(
      warnLines.some((l) => /module path rejected/.test(l)),
      `expected a "module path rejected" warning, got: ${JSON.stringify(warnLines)}`,
    );
  });

  it('skips a null-byte-path entry and emits a warning', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [{ name: 'nullbyte', module: './valid\0path.js' }],
    });
    assert.equal(loaded.length, 0);
    assert.ok(
      warnLines.some((l) => /module path rejected/.test(l)),
      `expected a "module path rejected" warning, got: ${JSON.stringify(warnLines)}`,
    );
  });

  it('does not throw when a module path is invalid; valid entries still load', async () => {
    const loaded = await loadDispatchers({
      dispatchers: [
        { name: 'evil', module: OUTSIDE_PATH },
        { name: 'noop' },
      ],
    });
    // Only noop loads; the evil entry is silently dropped (warning only).
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'noop');
  });
});
