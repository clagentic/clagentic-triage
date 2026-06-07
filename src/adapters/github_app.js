/**
 * GitHub App installation token minter.
 *
 * Produces short-lived installation tokens from a GitHub App ID + RS256 private
 * key without any third-party JWT library. Requires Node 20+ (built-in fetch and
 * crypto.subtle).
 *
 * The token is intentionally not cached here — the adapter layer decides when to
 * mint a fresh token relative to its poll cycle.
 */

import { createSign } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';

/**
 * Encode a Buffer or Uint8Array as a URL-safe base64 string (no padding).
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build and sign a GitHub App JWT using RS256.
 *
 * Claims:
 *   iss — App ID (string)
 *   iat — now minus 60 s (clock-skew tolerance)
 *   exp — iat + 10 minutes
 *
 * @param {string|number} app_id
 * @param {string} private_key_pem - PKCS#8 or PKCS#1 RSA private key PEM
 * @returns {string} Signed JWT
 */
function _build_jwt(app_id, private_key_pem) {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));

  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60; // 60 s clock-skew tolerance
  const exp = iat + 600; // 10 minutes

  const payload = base64url(
    Buffer.from(JSON.stringify({ iss: String(app_id), iat, exp })),
  );

  const signing_input = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing_input);
  const sig = base64url(signer.sign(private_key_pem));

  return `${signing_input}.${sig}`;
}

/**
 * Mint a GitHub App installation token.
 *
 * @param {object} opts
 * @param {string|number} opts.app_id           - GitHub App numeric ID (as string or number)
 * @param {string}        opts.private_key_pem  - RS256 private key PEM string (PKCS#8 or PKCS#1)
 * @param {string|number} opts.installation_id  - Installation numeric ID (as string or number)
 * @returns {Promise<string>}                    - The installation token (valid ~1 hour)
 */
export async function mint_installation_token({ app_id, private_key_pem, installation_id }) {
  let jwt;
  try {
    jwt = _build_jwt(app_id, private_key_pem);
  } catch (err) {
    throw new Error(`Failed to sign GitHub App JWT (check app_id and private key PEM): ${err.message}`);
  }

  const url = `${GITHUB_API}/app/installations/${installation_id}/access_tokens`;
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'clagentic-triage',
    },
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // Ignore read errors — the status is the authoritative signal.
    }
    throw new Error(
      `GitHub App token exchange failed: HTTP ${res.status} — ${body}`,
    );
  }

  const data = await res.json();
  return data.token;
}
