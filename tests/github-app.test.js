/**
 * Tests for src/adapters/github_app.js
 *
 * Covers:
 *   - JWT construction: 3-part dot-separated token, correct header
 *   - Error handling: non-200 response throws with status in message
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

// Generate a throwaway RSA key pair once for all tests. PKCS#8 PEM is what
// Node's crypto module produces by default and what GitHub accepts.
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const TEST_PRIVATE_KEY_PEM = TEST_PRIVATE_KEY.export({ type: 'pkcs8', format: 'pem' });

const TEST_APP_ID = '999';
const TEST_INSTALLATION_ID = '12345';
const TEST_TOKEN = 'ghs_test_installation_token';

// ---------------------------------------------------------------------------
// fetch stub helpers
// ---------------------------------------------------------------------------

let _stubFetch;

function stub_fetch(handler) {
  _stubFetch = globalThis.fetch;
  globalThis.fetch = handler;
}

function restore_fetch() {
  if (_stubFetch !== undefined) {
    globalThis.fetch = _stubFetch;
    _stubFetch = undefined;
  }
}

// ---------------------------------------------------------------------------
// Import under test (after key is ready)
// ---------------------------------------------------------------------------

const { mint_installation_token } = await import('../src/adapters/github_app.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mint_installation_token', () => {
  after(restore_fetch);

  it('sends a 3-part JWT with RS256 header and returns the token', async () => {
    let capturedAuthHeader = null;

    stub_fetch(async (url, init) => {
      capturedAuthHeader = init?.headers?.Authorization ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: TEST_TOKEN }),
        text: async () => JSON.stringify({ token: TEST_TOKEN }),
      };
    });

    const result = await mint_installation_token({
      app_id: TEST_APP_ID,
      private_key_pem: TEST_PRIVATE_KEY_PEM,
      installation_id: TEST_INSTALLATION_ID,
    });

    assert.equal(result, TEST_TOKEN, 'should return the token from the response');

    // Authorization header must be "Bearer <jwt>"
    assert.ok(capturedAuthHeader.startsWith('Bearer '), 'Authorization must start with Bearer');

    const jwt = capturedAuthHeader.slice('Bearer '.length);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT must have exactly 3 dot-separated parts');

    // Decode header (first part is base64url-encoded JSON)
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson);
    assert.equal(header.alg, 'RS256', 'JWT header alg must be RS256');
    assert.equal(header.typ, 'JWT', 'JWT header typ must be JWT');

    restore_fetch();
  });

  it('POSTs to the correct installations endpoint', async () => {
    let capturedUrl = null;

    stub_fetch(async (url, _init) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: TEST_TOKEN }),
        text: async () => JSON.stringify({ token: TEST_TOKEN }),
      };
    });

    await mint_installation_token({
      app_id: TEST_APP_ID,
      private_key_pem: TEST_PRIVATE_KEY_PEM,
      installation_id: TEST_INSTALLATION_ID,
    });

    assert.ok(
      capturedUrl.includes(`/app/installations/${TEST_INSTALLATION_ID}/access_tokens`),
      `URL must include the installation ID; got: ${capturedUrl}`,
    );

    restore_fetch();
  });

  it('throws on non-200 response with status in message', async () => {
    stub_fetch(async (_url, _init) => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));

    await assert.rejects(
      () =>
        mint_installation_token({
          app_id: TEST_APP_ID,
          private_key_pem: TEST_PRIVATE_KEY_PEM,
          installation_id: TEST_INSTALLATION_ID,
        }),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(
          err.message.includes('401'),
          `error message must include HTTP status; got: ${err.message}`,
        );
        return true;
      },
    );

    restore_fetch();
  });
});
