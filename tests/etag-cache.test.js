/**
 * Tests for ETag cache hardening (lr-1dc5):
 *   - TTL eviction: expired entries trigger a full re-fetch (no If-None-Match)
 *   - TTL within window: fresh entry uses the 304 path
 *   - Post-write invalidation: write methods clear the cache for the affected repo
 *   - Bot/actor filter re-application on 304 replay
 *
 * Uses Node's built-in test runner (node:test). globalThis.fetch is stubbed to
 * avoid real network calls.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  list_events,
  post_comment,
  close_item,
  request_changes,
  approve_pr,
  label_item,
} from '../src/adapters/github.js';

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors adapter-github.test.js conventions)
// ---------------------------------------------------------------------------

function makeRawIssue(overrides = {}) {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Body',
    html_url: 'https://github.com/testorg/testrepo/issues/1',
    state: 'open',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    node_id: 'I_1',
    draft: false,
    labels: [],
    user: { login: 'alice', type: 'User' },
    pull_request: undefined,
    author_association: 'CONTRIBUTOR',
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  const token = overrides._token ?? 'ghp_test';
  delete overrides._token;
  return {
    source: {
      adapter: 'github',
      org: null,
      repos: ['testorg/testrepo'],
      poll_interval_seconds: 60,
      allow_bot_logins: [],
      ignore_logins: [],
      watch_logins: [],
      watch_associations: ['CONTRIBUTOR', 'MEMBER', 'OWNER', 'NONE'],
      ...((overrides.source) ?? {}),
    },
    github_token: () => token,
    ...overrides,
  };
}

function mockResponse(status, body, headers = {}) {
  const defaultHeaders = {
    'X-RateLimit-Remaining': '999',
    'X-RateLimit-Reset': '0',
    ...headers,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: { get: (key) => defaultHeaders[key] ?? null },
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// Capture and restore globalThis.fetch between tests
// ---------------------------------------------------------------------------

let _originalFetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
});

// ---------------------------------------------------------------------------
// Test: TTL expiry evicts the entry and re-fetches (no If-None-Match)
// ---------------------------------------------------------------------------

describe('ETag cache TTL', () => {
  it('evicts an expired entry and re-fetches without If-None-Match', async () => {
    const since = '2025-01-01T00:00:00Z';
    const raw = makeRawIssue();
    let callCount = 0;
    const ifNoneMatchSentOn = [];

    globalThis.fetch = async (_url, opts) => {
      callCount++;
      ifNoneMatchSentOn.push(opts?.headers?.['If-None-Match'] ?? null);
      return mockResponse(200, [raw], { ETag: `"etag-${callCount}"` });
    };

    const config = makeConfig();

    // First call — populates cache
    const first = await list_events(config, since);
    assert.equal(first.length, 1, 'first fetch should return 1 event');

    // Backdate the cache entry's cached_at to simulate TTL expiry
    // (module-level Map is shared across calls within the same import graph)
    // We can't access _etagCache directly since it is not exported, so we
    // use Date.now monkey-patching to simulate time advancing past TTL.
    const realDateNow = Date.now;
    try {
      // Advance clock by 300_001 ms (just past 5-minute TTL)
      Date.now = () => realDateNow() + 300_001;

      const second = await list_events(config, since);
      assert.equal(second.length, 1, 'second fetch after TTL should return fresh data');

      // The second fetch must NOT have sent If-None-Match (cache was evicted)
      assert.equal(
        ifNoneMatchSentOn[1],
        null,
        'second call after TTL expiry must not send If-None-Match',
      );
      assert.equal(callCount, 2, 'should have made two real HTTP calls');
    } finally {
      Date.now = realDateNow;
    }
  });

  // -------------------------------------------------------------------------
  // Test: fresh entry within TTL uses the 304 path
  // -------------------------------------------------------------------------

  it('sends If-None-Match and accepts 304 when entry is within TTL', async () => {
    const since = '2025-02-01T00:00:00Z';
    const raw = makeRawIssue({ number: 2 });
    let callCount = 0;

    globalThis.fetch = async (_url, opts) => {
      callCount++;
      if (callCount === 1) {
        // First call: return data with ETag
        return mockResponse(200, [raw], { ETag: '"fresh-etag"' });
      }
      // Second call: expect If-None-Match, return 304
      assert.equal(
        opts?.headers?.['If-None-Match'],
        '"fresh-etag"',
        'second call should send the cached ETag',
      );
      return { ok: false, status: 304, headers: { get: () => null } };
    };

    const config = makeConfig();

    const first = await list_events(config, since);
    assert.equal(first.length, 1, 'first fetch should return 1 event');

    // Second call within TTL — should hit 304 and return cached data
    const second = await list_events(config, since);
    assert.equal(second.length, 1, '304 replay should return cached event');
    assert.equal(second[0].number, 2, 'cached event should be issue #2');
    assert.equal(callCount, 2, 'should have made exactly 2 HTTP calls');
  });
});

// ---------------------------------------------------------------------------
// Test: post-write invalidation removes correct cache keys
// ---------------------------------------------------------------------------

describe('post-write cache invalidation', () => {
  it('invalidates cache after post_comment so next poll re-fetches', async () => {
    const since = '2025-03-01T00:00:00Z';
    const raw = makeRawIssue({ number: 10 });
    let fetchCallCount = 0;
    const ifNoneMatchSentOn = [];

    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        // post_comment write call
        return mockResponse(201, { html_url: 'https://github.com/testorg/testrepo/issues/10#comment-1' });
      }
      fetchCallCount++;
      ifNoneMatchSentOn.push(opts?.headers?.['If-None-Match'] ?? null);
      return mockResponse(200, [raw], { ETag: `"etag-v${fetchCallCount}"` });
    };

    const config = makeConfig();

    // Populate cache
    await list_events(config, since);
    assert.equal(fetchCallCount, 1, 'cache should be populated after first poll');

    // Perform write — should invalidate cache
    const event = { type: 'issue', repo: 'testorg/testrepo', number: 10 };
    await post_comment(config, event, 'Looks good');

    // Next poll should NOT send If-None-Match (cache was invalidated)
    await list_events(config, since);
    assert.equal(fetchCallCount, 2, 'should have made a second real HTTP call after invalidation');
    assert.equal(
      ifNoneMatchSentOn[1],
      null,
      'poll after write should not send If-None-Match',
    );
  });

  it('invalidates cache for the correct repo only (close_item)', async () => {
    // Two repos; write to one; the other should retain its cache
    const since = '2025-03-02T00:00:00Z';
    const raw = makeRawIssue({ number: 20 });
    const fetchCounts = { 'testorg/testrepo': 0, 'testorg/otherrepo': 0 };

    globalThis.fetch = async (url, opts) => {
      if (opts?.method === 'PATCH') {
        return mockResponse(200, {});
      }
      if (url.includes('/testrepo/')) {
        fetchCounts['testorg/testrepo']++;
        return mockResponse(200, [raw], { ETag: '"etag-a"' });
      }
      fetchCounts['testorg/otherrepo']++;
      return mockResponse(200, [raw], { ETag: '"etag-b"' });
    };

    const config = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['testorg/testrepo', 'testorg/otherrepo'],
        poll_interval_seconds: 60,
        allow_bot_logins: [],
        ignore_logins: [],
        watch_logins: [],
        watch_associations: ['CONTRIBUTOR', 'MEMBER', 'OWNER', 'NONE'],
      },
    });

    // Populate cache for both repos
    await list_events(config, since);
    assert.equal(fetchCounts['testorg/testrepo'], 1);
    assert.equal(fetchCounts['testorg/otherrepo'], 1);

    // Write to testrepo only
    const event = { type: 'issue', repo: 'testorg/testrepo', number: 20 };
    await close_item(config, event);

    // Override fetch so that we can detect 304 vs full-fetch per repo
    let testrepoSentEtag = false;
    let otherrepoSentEtag = false;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/testrepo/')) {
        testrepoSentEtag = Boolean(opts?.headers?.['If-None-Match']);
        fetchCounts['testorg/testrepo']++;
        return mockResponse(200, [raw], { ETag: '"etag-a2"' });
      }
      otherrepoSentEtag = Boolean(opts?.headers?.['If-None-Match']);
      // Return 304 to confirm cache is intact for otherrepo
      return { ok: false, status: 304, headers: { get: () => null } };
    };

    await list_events(config, since);

    assert.equal(
      testrepoSentEtag,
      false,
      'testrepo cache was invalidated; must not send If-None-Match',
    );
    assert.equal(
      otherrepoSentEtag,
      true,
      'otherrepo cache is intact; must send If-None-Match',
    );
  });
});

// ---------------------------------------------------------------------------
// Test: bot filter and actor filter re-applied on 304 replay
// ---------------------------------------------------------------------------

describe('filter re-application on 304 replay', () => {
  it('excludes a [bot] login that was added to ignore_logins after initial cache', async () => {
    const since = '2025-04-01T00:00:00Z';
    const humanIssue = makeRawIssue({ number: 30, user: { login: 'alice', type: 'User' } });
    const botIssue = makeRawIssue({
      number: 31,
      user: { login: 'mybot[bot]', type: 'User' },
    });
    let callCount = 0;

    globalThis.fetch = async (_url, opts) => {
      callCount++;
      if (callCount === 1) {
        // First fetch: allow_bot_logins=['mybot[bot]'] so both pass through
        return mockResponse(200, [humanIssue, botIssue], { ETag: '"etag-bot-test"' });
      }
      // Second fetch: 304
      return { ok: false, status: 304, headers: { get: () => null } };
    };

    // First call: allow the bot login through
    const configWithBotAllowed = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['testorg/testrepo'],
        poll_interval_seconds: 60,
        allow_bot_logins: ['mybot[bot]'],
        ignore_logins: [],
        watch_logins: [],
        watch_associations: ['CONTRIBUTOR', 'MEMBER', 'OWNER', 'NONE'],
      },
    });

    const first = await list_events(configWithBotAllowed, since);
    assert.equal(first.length, 2, 'both events should be returned on first fetch');

    // Second call: config no longer allows the bot login — re-filter should drop it
    const configBotRemoved = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['testorg/testrepo'],
        poll_interval_seconds: 60,
        allow_bot_logins: [],
        ignore_logins: [],
        watch_logins: [],
        watch_associations: ['CONTRIBUTOR', 'MEMBER', 'OWNER', 'NONE'],
      },
    });

    const second = await list_events(configBotRemoved, since);
    assert.equal(callCount, 2, 'second call should have been a 304');
    assert.equal(
      second.length,
      1,
      '304 replay should re-apply bot filter and drop mybot[bot]',
    );
    assert.equal(second[0].author, 'alice');
  });

  it('excludes an actor newly added to ignore_logins on 304 replay', async () => {
    const since = '2025-04-02T00:00:00Z';
    const aliceIssue = makeRawIssue({
      number: 40,
      user: { login: 'alice', type: 'User' },
      author_association: 'CONTRIBUTOR',
    });
    const bobIssue = makeRawIssue({
      number: 41,
      user: { login: 'bob', type: 'User' },
      author_association: 'CONTRIBUTOR',
    });
    let callCount = 0;

    globalThis.fetch = async (_url, opts) => {
      callCount++;
      if (callCount === 1) {
        return mockResponse(200, [aliceIssue, bobIssue], { ETag: '"etag-actor-test"' });
      }
      return { ok: false, status: 304, headers: { get: () => null } };
    };

    const baseSource = {
      adapter: 'github',
      org: null,
      repos: ['testorg/testrepo'],
      poll_interval_seconds: 60,
      allow_bot_logins: [],
      watch_logins: [],
      watch_associations: ['CONTRIBUTOR', 'MEMBER', 'OWNER', 'NONE'],
    };

    // First call: neither alice nor bob is ignored
    const configFirst = makeConfig({ source: { ...baseSource, ignore_logins: [] } });
    const first = await list_events(configFirst, since);
    assert.equal(first.length, 2, 'first fetch should return both events');

    // Second call: bob is now on the ignore list
    const configSecond = makeConfig({ source: { ...baseSource, ignore_logins: ['bob'] } });
    const second = await list_events(configSecond, since);
    assert.equal(callCount, 2, 'second call should have been a 304');
    assert.equal(
      second.length,
      1,
      '304 replay should re-apply actor filter and drop bob',
    );
    assert.equal(second[0].author, 'alice');
  });
});
