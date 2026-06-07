/**
 * Tests for src/enricher.js
 *
 * Uses Node's built-in test runner. All GitHub API calls are intercepted by
 * overriding globalThis.fetch — no real network calls are made.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { enrich } from '../src/enricher.js';
import { parseYaml } from '../src/yaml.js';

// Generate a throwaway RSA key pair once for GitHub App token tests.
const { privateKey: _APP_PRIVATE_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_PRIVATE_KEY_PEM = _APP_PRIVATE_KEY.export({ type: 'pkcs8', format: 'pem' });

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal normalized Event.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#1',
    type: 'issue',
    title: 'Test issue',
    body: 'Issue body',
    author: 'testuser',
    created_at: '2024-01-01T00:00:00Z',
    url: 'https://github.com/owner/repo/issues/1',
    source: 'github',
    repo: 'owner/repo',
    number: 1,
    metadata: {},
    ...overrides,
  };
}

/**
 * Build a minimal config object.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  const token = overrides._token ?? 'test-token';
  const base = {
    intent_file: '.github/triage-intent.yml',
    intent_file_fallback: '.github/TRIAGE_INTENT.md',
    github_token: () => token,
  };
  const { _token: _removed, ...rest } = overrides;
  return { ...base, ...rest };
}

/**
 * Encode a string as base64 with the line-wrapping GitHub uses in the
 * contents API response.
 *
 * @param {string} s
 * @returns {string}
 */
function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Build a mock GitHub contents API response body for a given file content.
 *
 * @param {string} content
 * @returns {object}
 */
function contentsResponse(content) {
  return {
    type: 'file',
    content: b64(content),
    encoding: 'base64',
  };
}

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

let _originalFetch;
let _fetchHandlers; // Array of { match(url): bool, respond(): Response }

/**
 * Mock fetch that routes requests through registered handlers.
 * Falls through to a 404 if no handler matches.
 */
function _mockFetch(url, _opts) {
  for (const handler of _fetchHandlers) {
    if (handler.match(url)) {
      return Promise.resolve(handler.respond(url));
    }
  }
  // Default: 404
  return Promise.resolve(
    new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
  );
}

/**
 * Register a handler that matches URLs containing `urlSubstring`.
 *
 * @param {string} urlSubstring
 * @param {object | null} body   - Response body (null → 404)
 * @param {number} [status=200]
 */
function mockUrl(urlSubstring, body, status = 200) {
  _fetchHandlers.push({
    match: (url) => url.includes(urlSubstring),
    respond: () =>
      new Response(JSON.stringify(body), {
        status: body === null ? 404 : status,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
}

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _fetchHandlers = [];
  globalThis.fetch = _mockFetch;
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
});

// ---------------------------------------------------------------------------
// parseYaml unit tests
// ---------------------------------------------------------------------------

describe('parseYaml', () => {
  it('parses flat key: value pairs', () => {
    const yaml = `name: clagentic\nversion: 1`;
    const result = parseYaml(yaml);
    assert.equal(result.name, 'clagentic');
    assert.equal(result.version, '1');
  });

  it('parses block scalar (|)', () => {
    const yaml = [
      'id: default',
      'llm_context: |',
      '  Accept bug reports.',
      '  Request info if missing.',
    ].join('\n');
    const result = parseYaml(yaml);
    assert.equal(result.id, 'default');
    assert.equal(result.llm_context, 'Accept bug reports.\nRequest info if missing.');
  });

  it('parses simple arrays', () => {
    const yaml = `items:\n  - alpha\n  - beta\n  - gamma`;
    const result = parseYaml(yaml);
    assert.deepEqual(result.items, ['alpha', 'beta', 'gamma']);
  });

  it('parses array of objects', () => {
    const yaml = [
      'repo_context_files:',
      '  - path: CONTRIBUTING.md',
      '  - path: .github/CODEOWNERS',
    ].join('\n');
    const result = parseYaml(yaml);
    assert.deepEqual(result.repo_context_files, [
      { path: 'CONTRIBUTING.md' },
      { path: '.github/CODEOWNERS' },
    ]);
  });

  it('parses nested objects', () => {
    const yaml = `outer:\n  inner: value\n  another: thing`;
    const result = parseYaml(yaml);
    assert.deepEqual(result.outer, { inner: 'value', another: 'thing' });
  });

  it('wraps pure prose as { description: string }', () => {
    const prose = 'This is just a plain paragraph with no structure.';
    const result = parseYaml(prose);
    assert.equal(result.description, prose);
  });

  it('strips single and double quotes from scalar values', () => {
    const yaml = `a: "hello world"\nb: 'single quoted'`;
    const result = parseYaml(yaml);
    assert.equal(result.a, 'hello world');
    assert.equal(result.b, 'single quoted');
  });
});

// ---------------------------------------------------------------------------
// enrich() integration tests
// ---------------------------------------------------------------------------

describe('enrich', () => {
  // -------------------------------------------------------------------------
  // Test 1: YAML intent file loaded and parsed correctly
  // -------------------------------------------------------------------------

  it('loads and parses the YAML intent file', async () => {
    const yamlContent = [
      'triage_rules:',
      '  - id: default',
      '    description: Standard rules.',
      '    llm_context: |',
      '      Accept bug reports with steps.',
    ].join('\n');

    mockUrl('/repos/owner/repo/contents/.github/triage-intent.yml', contentsResponse(yamlContent));
    mockUrl('/users/testuser', {
      login: 'testuser',
      name: 'Test User',
      public_repos: 10,
      followers: 5,
      created_at: '2020-01-01T00:00:00Z',
      company: null,
      bio: null,
    });

    const event = makeEvent();
    const config = makeConfig();
    const enriched = await enrich(config, event, null);

    assert.equal(enriched.context.intent._source, 'yaml');
    assert.ok(Array.isArray(enriched.context.intent.triage_rules));
    assert.equal(enriched.context.intent.triage_rules[0].id, 'default');
  });

  // -------------------------------------------------------------------------
  // RT-003: intent file size cap — oversized YAML is truncated, not rejected
  // -------------------------------------------------------------------------

  it('truncates an oversized YAML intent file (RT-003 size cap)', async () => {
    // Build a YAML file well over the 64 KB cap. A valid top-level key keeps
    // it on the YAML path; the bulk is a large block scalar.
    const filler = 'x'.repeat(70 * 1024);
    const yamlContent = `description: |\n  ${filler}`;

    mockUrl('/repos/owner/repo/contents/.github/triage-intent.yml', contentsResponse(yamlContent));
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const enriched = await enrich(makeConfig(), makeEvent(), null);

    assert.equal(enriched.context.intent._source, 'yaml');
    // The parsed description must be shorter than the raw 70 KB input —
    // the cap truncated the source before parsing.
    assert.ok(
      enriched.context.intent.description.length < 70 * 1024,
      'oversized intent file should be truncated below the original size',
    );
  });

  it('truncates an oversized Markdown fallback intent file (RT-003 size cap)', async () => {
    const mdContent = '# Intent\n' + 'y'.repeat(70 * 1024);

    // YAML 404s (default handler), Markdown returns oversized content
    mockUrl('/repos/owner/repo/contents/.github/TRIAGE_INTENT.md', contentsResponse(mdContent));
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const enriched = await enrich(makeConfig(), makeEvent(), null);

    assert.equal(enriched.context.intent._source, 'markdown');
    assert.ok(enriched.context.intent.description.length <= 64 * 1024 + 100);
    assert.ok(enriched.context.intent.description.includes('[truncated by clagentic-triage'));
  });

  // -------------------------------------------------------------------------
  // Test 2: repo_context_files entries fetched and injected into _resolved_files
  // -------------------------------------------------------------------------

  it('fetches repo_context_files and injects them into _resolved_files', async () => {
    // RT-005: only .md/.yml/.json etc. are allowed — CODEOWNERS (no ext) is now
    // blocked by the extension allowlist. Use two .md files instead.
    const yamlContent = [
      'repo_context_files:',
      '  - path: CONTRIBUTING.md',
      '  - path: docs/GUIDELINES.md',
      'triage_rules:',
      '  - id: default',
      '    description: Rules.',
    ].join('\n');

    const contributingContent = '# Contributing\nPlease read this.';
    const guidelinesContent = '# Guidelines\nBe respectful.';

    mockUrl(
      '/repos/owner/repo/contents/.github/triage-intent.yml',
      contentsResponse(yamlContent),
    );
    mockUrl(
      '/repos/owner/repo/contents/CONTRIBUTING.md',
      contentsResponse(contributingContent),
    );
    mockUrl(
      '/repos/owner/repo/contents/docs/GUIDELINES.md',
      contentsResponse(guidelinesContent),
    );
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const event = makeEvent();
    const config = makeConfig();
    const enriched = await enrich(config, event, null);

    assert.equal(enriched.context.intent._source, 'yaml');
    assert.ok(enriched.context.intent._resolved_files);
    assert.equal(enriched.context.intent._resolved_files['CONTRIBUTING.md'], contributingContent);
    assert.equal(enriched.context.intent._resolved_files['docs/GUIDELINES.md'], guidelinesContent);
  });

  // -------------------------------------------------------------------------
  // Test 3: Falls back to Markdown intent file when YAML not found (404)
  // -------------------------------------------------------------------------

  it('falls back to Markdown intent when YAML returns 404', async () => {
    const mdContent = '# Triage Intent\n\nAccept bugs with steps.';

    // YAML path returns 404 (default handler), Markdown returns content
    mockUrl(
      '/repos/owner/repo/contents/.github/TRIAGE_INTENT.md',
      contentsResponse(mdContent),
    );
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const event = makeEvent();
    const config = makeConfig();
    const enriched = await enrich(config, event, null);

    assert.equal(enriched.context.intent._source, 'markdown');
    assert.equal(enriched.context.intent.description, mdContent);
  });

  // -------------------------------------------------------------------------
  // Test 4: Falls back to generic intent when neither file found
  // -------------------------------------------------------------------------

  it('uses generic fallback intent when neither file is found', async () => {
    // Both paths return 404 (default handler)
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const event = makeEvent();
    const config = makeConfig();
    const enriched = await enrich(config, event, null);

    assert.equal(enriched.context.intent._source, 'generic');
    assert.ok(typeof enriched.context.intent.description === 'string');
    assert.ok(enriched.context.intent.description.length > 0);
  });

  // -------------------------------------------------------------------------
  // Test 5: Contributor profile fetched and normalized
  // -------------------------------------------------------------------------

  it('fetches and normalizes the contributor profile', async () => {
    const yamlContent = 'description: simple intent';

    mockUrl('/repos/owner/repo/contents/.github/triage-intent.yml', contentsResponse(yamlContent));
    mockUrl('/users/testuser', {
      login: 'testuser',
      name: 'Test User',
      public_repos: 42,
      followers: 100,
      created_at: '2019-06-15T00:00:00Z',
      company: 'Acme Corp',
      bio: 'Software engineer.',
    });

    const event = makeEvent();
    const config = makeConfig();
    const enriched = await enrich(config, event, null);

    const c = enriched.context.contributor;
    assert.equal(c.login, 'testuser');
    assert.equal(c.name, 'Test User');
    assert.equal(c.public_repos, 42);
    assert.equal(c.followers, 100);
    assert.equal(c.created_at, '2019-06-15T00:00:00Z');
    assert.equal(c.company, 'Acme Corp');
    assert.equal(c.bio, 'Software engineer.');
  });

  // -------------------------------------------------------------------------
  // Test 6: On contributor fetch failure, returns minimal { login } object
  // -------------------------------------------------------------------------

  it('returns minimal contributor object on fetch failure without throwing', async () => {
    // YAML path returns 404, MD path returns 404, contributor API returns 500
    mockUrl('/users/testuser', null, 500);

    const event = makeEvent();
    const config = makeConfig();

    // Must not throw
    let enriched;
    await assert.doesNotReject(async () => {
      enriched = await enrich(config, event, null);
    });

    assert.deepEqual(enriched.context.contributor, { login: 'testuser' });
  });

  // -------------------------------------------------------------------------
  // Test 7: _source field reflects which fallback was used
  // -------------------------------------------------------------------------

  it('sets _source=yaml when YAML file is found', async () => {
    mockUrl(
      '/repos/owner/repo/contents/.github/triage-intent.yml',
      contentsResponse('name: repo'),
    );
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const enriched = await enrich(makeConfig(), makeEvent(), null);
    assert.equal(enriched.context.intent._source, 'yaml');
  });

  it('sets _source=markdown when only Markdown file is found', async () => {
    mockUrl(
      '/repos/owner/repo/contents/.github/TRIAGE_INTENT.md',
      contentsResponse('# Intent'),
    );
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const enriched = await enrich(makeConfig(), makeEvent(), null);
    assert.equal(enriched.context.intent._source, 'markdown');
  });

  it('sets _source=generic when no intent file is found', async () => {
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const enriched = await enrich(makeConfig(), makeEvent(), null);
    assert.equal(enriched.context.intent._source, 'generic');
  });

  // -------------------------------------------------------------------------
  // Additional: original event fields are preserved on the enriched event
  // -------------------------------------------------------------------------

  it('preserves all original event fields in the returned EnrichedEvent', async () => {
    mockUrl(
      '/repos/owner/repo/contents/.github/triage-intent.yml',
      contentsResponse('name: repo'),
    );
    mockUrl('/users/testuser', { login: 'testuser', name: null, public_repos: 0, followers: 0, created_at: null, company: null, bio: null });

    const event = makeEvent({ title: 'Custom title', body: 'Custom body' });
    const enriched = await enrich(makeConfig(), event, null);

    assert.equal(enriched.title, 'Custom title');
    assert.equal(enriched.body, 'Custom body');
    assert.equal(enriched.id, event.id);
    assert.equal(enriched.repo, event.repo);
    assert.ok(enriched.context); // context is added, original fields unchanged
  });

  // -------------------------------------------------------------------------
  // Additional: no token → degraded context without throwing
  // -------------------------------------------------------------------------

  it('returns degraded context when no token is available without throwing', async () => {
    const config = makeConfig({ _token: null });
    // Override the github_token getter to return null
    config.github_token = () => null;

    const event = makeEvent();
    let enriched;
    await assert.doesNotReject(async () => {
      enriched = await enrich(config, event, null);
    });

    assert.equal(enriched.context.intent._source, 'generic');
    assert.deepEqual(enriched.context.contributor, { login: 'testuser' });
  });

  // -------------------------------------------------------------------------
  // GitHub App auth: enrich() uses _resolve_token (installation token) rather
  // than config.github_token() when App credentials are configured.
  //
  // Validates that the enricher does not bypass App auth by falling through to
  // config.github_token(). We configure github_token() to return null so that
  // any code path that calls it directly would produce degraded context — then
  // verify that the enricher still returns real (non-generic) context because
  // _resolve_token minted an installation token instead.
  // -------------------------------------------------------------------------

  it('uses GitHub App installation token when App credentials are configured', async () => {
    const INSTALL_TOKEN = 'ghs_test_enricher_install_token';
    const APP_ENV_VAR = 'CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY';

    // Inject the throwaway PEM into the process environment so _resolve_token
    // can read it at the key_env name.
    process.env[APP_ENV_VAR] = APP_PRIVATE_KEY_PEM;

    try {
      // Config has App credentials; github_token() deliberately returns null.
      // If enrich() called github_token() directly it would get degraded context.
      const config = {
        intent_file: '.github/triage-intent.yml',
        intent_file_fallback: '.github/TRIAGE_INTENT.md',
        github_token: () => null,
        source: {
          github_app_id: '123',
          github_app_private_key_env: APP_ENV_VAR,
          github_app_installation_id: '456',
        },
      };

      const yamlContent = 'description: App auth intent';

      // Register fetch handlers: installation token mint, intent file, user profile.
      // Use a handler array to avoid replacing the module-level mock infrastructure.
      _fetchHandlers.push({
        match: (url) => url.includes('/app/installations/'),
        respond: () =>
          new Response(JSON.stringify({ token: INSTALL_TOKEN }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      mockUrl('/repos/owner/repo/contents/.github/triage-intent.yml', contentsResponse(yamlContent));
      mockUrl('/users/testuser', {
        login: 'testuser',
        name: 'App User',
        public_repos: 1,
        followers: 0,
        created_at: '2023-01-01T00:00:00Z',
        company: null,
        bio: null,
      });

      const enriched = await enrich(config, makeEvent(), null);

      // Enrichment must have succeeded using the installation token — not degraded.
      assert.notEqual(
        enriched.context.intent._source,
        'generic',
        'intent source must not be generic; enricher must have used the App installation token',
      );
      assert.equal(enriched.context.intent._source, 'yaml');
      assert.equal(enriched.context.contributor.login, 'testuser');
    } finally {
      delete process.env[APP_ENV_VAR];
    }
  });
});
