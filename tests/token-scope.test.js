/**
 * Tests for check_token_scopes in src/adapters/github.js (RT-006).
 *
 * All tests mock globalThis.fetch — no real network calls are made.
 * stderr capture uses process.stderr.write monkey-patching so that
 * warning assertions do not pollute test output.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { check_token_scopes } from '../src/adapters/github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal config whose github_token() returns the given token string.
 *
 * @param {string} [token]
 * @returns {object}
 */
function makeConfig(token = 'ghp_testtoken') {
  return {
    source: { adapter: 'github' },
    github_token: () => token,
  };
}

/**
 * Build a mock fetch response that returns the given header map.
 *
 * @param {Record<string,string>} headers
 * @param {number} [status]
 * @returns {object}
 */
function mockFetchWith(headers, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => headers[key.toLowerCase()] ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Save / restore fetch and stderr between tests
// ---------------------------------------------------------------------------

let _originalFetch;
let _originalStderrWrite;
let _stderrLines;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _originalStderrWrite = process.stderr.write.bind(process.stderr);
  _stderrLines = [];

  // Capture stderr output during tests.
  process.stderr.write = (chunk, ...rest) => {
    _stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    // Let output through so node:test can still print failures.
    return _originalStderrWrite(chunk, ...rest);
  };
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  process.stderr.write = _originalStderrWrite;
});

// ---------------------------------------------------------------------------
// Test 1: fine-grained PAT (no x-oauth-scopes header)
// ---------------------------------------------------------------------------

describe('check_token_scopes', () => {
  it('fine-grained token: no x-oauth-scopes header → ok, type fine-grained, no warning', async () => {
    // Fine-grained PATs don't return x-oauth-scopes; the header is absent.
    globalThis.fetch = mockFetchWith({});

    const result = await check_token_scopes(makeConfig());

    assert.equal(result.ok, true);
    assert.equal(result.type, 'fine-grained');
    assert.equal(result.scopes, null);

    // No warning should have been emitted.
    const warns = _stderrLines.filter((l) => l.includes('WARNING'));
    assert.equal(warns.length, 0, `unexpected warning on stderr: ${warns.join('')}`);
  });

  // ---------------------------------------------------------------------------
  // Test 2: classic token with narrow (safe) scopes
  // ---------------------------------------------------------------------------

  it('classic token with narrow scopes → ok, warned: false, no stderr output', async () => {
    // Narrow scopes: issues read + pull_requests read — neither is broad.
    globalThis.fetch = mockFetchWith({
      'x-oauth-scopes': 'read:org, public_repo',
    });

    const result = await check_token_scopes(makeConfig());

    assert.equal(result.ok, true);
    assert.equal(result.type, 'classic');
    assert.ok(Array.isArray(result.scopes));
    assert.equal(result.warned, false);

    const warns = _stderrLines.filter((l) => l.includes('WARNING'));
    assert.equal(warns.length, 0, `unexpected warning on stderr: ${warns.join('')}`);
  });

  // ---------------------------------------------------------------------------
  // Test 3: classic token with broad scopes
  // ---------------------------------------------------------------------------

  it('classic token with broad scopes (repo, admin:org) → warned: true, warning on stderr', async () => {
    globalThis.fetch = mockFetchWith({
      'x-oauth-scopes': 'repo, admin:org, read:user',
    });

    const result = await check_token_scopes(makeConfig());

    assert.equal(result.ok, true);
    assert.equal(result.type, 'classic');
    assert.ok(result.scopes.includes('repo'));
    assert.ok(result.scopes.includes('admin:org'));
    assert.equal(result.warned, true);

    // Exactly one warning line should have been emitted.
    const warns = _stderrLines.filter((l) => l.includes('WARNING'));
    assert.equal(warns.length, 1, `expected 1 warning line, got ${warns.length}`);

    const warnLine = warns[0];
    assert.ok(
      warnLine.includes('repo'),
      `warning should name the broad scope 'repo': ${warnLine}`,
    );
    assert.ok(
      warnLine.includes('admin:org'),
      `warning should name the broad scope 'admin:org': ${warnLine}`,
    );
    assert.ok(
      warnLine.includes('docs/GITHUB_APP.md'),
      `warning should reference docs/GITHUB_APP.md: ${warnLine}`,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: API call fails (network error)
  // ---------------------------------------------------------------------------

  it('network error during fetch → ok: false, does not throw', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED: connection refused');
    };

    // Must not throw — all errors are captured in the return value.
    let result;
    await assert.doesNotReject(async () => {
      result = await check_token_scopes(makeConfig());
    });

    assert.equal(result.ok, false);
    assert.ok(
      typeof result.error === 'string' && result.error.length > 0,
      `result.error should be a non-empty string, got: ${JSON.stringify(result.error)}`,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 5: missing token → ok: false, does not throw
  // ---------------------------------------------------------------------------

  it('missing token → ok: false, does not throw', async () => {
    // fetch should never be called, but guard it to catch regressions.
    globalThis.fetch = async () => {
      throw new Error('fetch called unexpectedly with missing token');
    };

    const result = await check_token_scopes(makeConfig(''));

    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string');
  });
});
