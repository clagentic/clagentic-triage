/**
 * Tests for src/adapters/github.js
 *
 * Uses Node's built-in test runner (node:test) and overrides globalThis.fetch
 * to avoid real network calls.
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
  unlabel_item,
  AdapterError,
} from '../src/adapters/github.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal raw GitHub issue payload.
 */
function makeRawIssue(overrides = {}) {
  return {
    number: 42,
    title: 'Test issue',
    body: 'Issue body',
    html_url: 'https://github.com/example/repo/issues/42',
    state: 'open',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    node_id: 'I_123',
    draft: false,
    labels: [{ name: 'bug' }],
    user: { login: 'alice', type: 'User' },
    pull_request: undefined,
    ...overrides,
  };
}

/**
 * Build a minimal raw GitHub PR payload (has a pull_request key).
 */
function makeRawPr(overrides = {}) {
  return makeRawIssue({
    number: 7,
    title: 'Test PR',
    html_url: 'https://github.com/example/repo/pull/7',
    pull_request: { merged_at: null },
    head: { ref: 'feat/thing' },
    base: { ref: 'main' },
    ...overrides,
  });
}

/**
 * Build a minimal config object that mirrors what loader.js produces.
 */
function makeConfig(overrides = {}) {
  const token = overrides._token ?? 'ghp_testtoken';
  delete overrides._token;

  return {
    source: {
      adapter: 'github',
      org: null,
      repos: ['example/repo'],
      poll_interval_seconds: 60,
      allow_bot_logins: [],
      ...((overrides.source) ?? {}),
    },
    github_token: () => token,
    ...overrides,
  };
}

/**
 * Build a mock Response-like object for use as a globalThis.fetch override.
 *
 * @param {number} status
 * @param {object|Array} body
 * @param {Record<string,string>} [headers]
 */
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
    headers: {
      get: (key) => defaultHeaders[key] ?? null,
    },
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
// Test 1: list_events returns normalized events for a single repo
// ---------------------------------------------------------------------------

describe('list_events', () => {
  it('returns normalized events for a single repo', async () => {
    const rawIssue = makeRawIssue();
    const rawPr = makeRawPr();

    globalThis.fetch = async () => mockResponse(200, [rawIssue, rawPr]);

    const config = makeConfig();
    const events = await list_events(config, '2024-01-01T00:00:00Z');

    assert.equal(events.length, 2);

    const issue = events.find((e) => e.type === 'issue');
    assert.ok(issue, 'expected an issue event');
    assert.equal(issue.id, 'example/repo#42');
    assert.equal(issue.type, 'issue');
    assert.equal(issue.title, 'Test issue');
    assert.equal(issue.body, 'Issue body');
    assert.equal(issue.author, 'alice');
    assert.equal(issue.source, 'github');
    assert.equal(issue.repo, 'example/repo');
    assert.equal(issue.number, 42);
    assert.equal(issue.metadata.draft, false);
    assert.equal(issue.metadata.merged, false);
    assert.deepEqual(issue.metadata.labels, ['bug']);

    const pr = events.find((e) => e.type === 'pr');
    assert.ok(pr, 'expected a pr event');
    assert.equal(pr.id, 'example/repo#7');
    assert.equal(pr.type, 'pr');
    assert.equal(pr.metadata.head_ref, 'feat/thing');
    assert.equal(pr.metadata.base_ref, 'main');
  });

  // -------------------------------------------------------------------------
  // Test 2: bot events are filtered out
  // -------------------------------------------------------------------------

  it('filters out bot events (sender.type===Bot and login ending [bot])', async () => {
    const human = makeRawIssue({ number: 1, user: { login: 'alice', type: 'User' } });
    const botByType = makeRawIssue({
      number: 2,
      user: { login: 'dependabot', type: 'Bot' },
    });
    const botByLogin = makeRawIssue({
      number: 3,
      user: { login: 'renovate[bot]', type: 'User' },
    });

    globalThis.fetch = async () => mockResponse(200, [human, botByType, botByLogin]);

    const config = makeConfig();
    const events = await list_events(config, '2024-01-01T00:00:00Z');

    assert.equal(events.length, 1, 'only the human event should pass through');
    assert.equal(events[0].author, 'alice');
  });

  // -------------------------------------------------------------------------
  // Test 3: 304 response returns cached events (ETag hit)
  // -------------------------------------------------------------------------

  it('returns cached events on 304 (ETag hit)', async () => {
    const rawIssue = makeRawIssue();
    let callCount = 0;

    globalThis.fetch = async (url, opts) => {
      callCount++;
      if (callCount === 1) {
        // First call: return data with ETag
        return mockResponse(200, [rawIssue], { ETag: '"abc123"', 'X-RateLimit-Remaining': '999' });
      }
      // Second call: 304 Not Modified
      assert.ok(
        opts?.headers?.['If-None-Match'],
        'second call should send If-None-Match header',
      );
      return { ok: false, status: 304, headers: { get: () => null } };
    };

    const config = makeConfig();
    const since = '2024-01-01T00:00:00Z';

    // First call — populate cache
    const first = await list_events(config, since);
    assert.equal(first.length, 1);

    // Second call — should hit 304 and return cached data
    const second = await list_events(config, since);
    assert.equal(second.length, 1);
    assert.equal(second[0].id, 'example/repo#42');
    assert.equal(callCount, 2);
  });

  // -------------------------------------------------------------------------
  // Test 4: 401 returns empty array and logs warning (does not throw)
  // -------------------------------------------------------------------------

  it('returns empty array on 401 (does not throw)', async () => {
    globalThis.fetch = async () => mockResponse(401, { message: 'Bad credentials' });

    const config = makeConfig();
    const events = await list_events(config, '2024-01-01T00:00:00Z');

    assert.deepEqual(events, []);
  });

  // -------------------------------------------------------------------------
  // Test 5: Non-2xx on a single repo returns empty array (does not throw)
  // -------------------------------------------------------------------------

  it('returns empty array for a repo that returns non-2xx (not 401)', async () => {
    globalThis.fetch = async () => mockResponse(500, { message: 'Internal Server Error' });

    const config = makeConfig();
    const events = await list_events(config, '2024-01-01T00:00:00Z');

    assert.deepEqual(events, []);
  });

  // -------------------------------------------------------------------------
  // Per-author cap: author is dropped after hitting the configured limit
  // -------------------------------------------------------------------------

  it('caps events per author at max_events_per_author_per_poll', async () => {
    // Build 5 issues from 'spammer' and 1 from 'normal'
    const spamIssues = Array.from({ length: 5 }, (_, i) =>
      makeRawIssue({
        number: 100 + i,
        user: { login: 'spammer', type: 'User' },
        author_association: 'NONE',
      }),
    );
    const normalIssue = makeRawIssue({
      number: 200,
      user: { login: 'normal', type: 'User' },
      author_association: 'NONE',
    });

    globalThis.fetch = async () => mockResponse(200, [...spamIssues, normalIssue]);

    // Cap at 3 for 'spammer'; 'normal' is well under the cap.
    const config = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['example/repo'],
        allow_bot_logins: [],
        watch_associations: ['NONE'],
        ignore_logins: [],
        watch_logins: [],
        max_events_per_author_per_poll: 3,
      },
    });

    const events = await list_events(config, '2024-01-01T00:00:00Z');
    const spammerEvents = events.filter((e) => e.author === 'spammer');
    const normalEvents = events.filter((e) => e.author === 'normal');

    assert.equal(spammerEvents.length, 3, 'only 3 spammer events should pass through');
    assert.equal(normalEvents.length, 1, 'normal event should always pass through');
    assert.equal(events.length, 4);
  });

  // -------------------------------------------------------------------------
  // Per-author cap: disabled when set to 0
  // -------------------------------------------------------------------------

  it('does not cap events when max_events_per_author_per_poll is 0', async () => {
    // Build 10 issues all from the same author
    const manyIssues = Array.from({ length: 10 }, (_, i) =>
      makeRawIssue({
        number: 300 + i,
        user: { login: 'prolific', type: 'User' },
        author_association: 'NONE',
      }),
    );

    globalThis.fetch = async () => mockResponse(200, manyIssues);

    const config = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['example/repo'],
        allow_bot_logins: [],
        watch_associations: ['NONE'],
        ignore_logins: [],
        watch_logins: [],
        max_events_per_author_per_poll: 0,
      },
    });

    const events = await list_events(config, '2024-01-01T00:00:00Z');
    assert.equal(events.length, 10, 'all events pass through when cap is 0');
  });

  // -------------------------------------------------------------------------
  // Post-filter repo cap: single author with many issues hits repo cap, not author cap
  // -------------------------------------------------------------------------

  it('single-author flood hits max_events_per_repo_per_poll before author cap', async () => {
    // 150 issues from one author, repo cap=50, author cap=200 (higher than repo cap).
    // Expect exactly 50 events — capped by the repo limit, not the author limit.
    // Issues are spread across two pages to verify pagination is working.
    const page1Issues = Array.from({ length: 100 }, (_, i) =>
      makeRawIssue({
        number: 1000 + i,
        user: { login: 'attacker', type: 'User' },
        author_association: 'NONE',
      }),
    );
    const page2Issues = Array.from({ length: 50 }, (_, i) =>
      makeRawIssue({
        number: 1100 + i,
        user: { login: 'attacker', type: 'User' },
        author_association: 'NONE',
      }),
    );

    const page2Url = 'https://api.github.com/repos/example/repo/issues?state=open&page=2';

    globalThis.fetch = async (url) => {
      if (url.includes('page=2') || url === page2Url) {
        return mockResponse(200, page2Issues);
      }
      // Page 1: return 100 items and a Link: rel="next" header
      return mockResponse(200, page1Issues, {
        Link: `<${page2Url}>; rel="next"`,
      });
    };

    const config = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['example/repo'],
        allow_bot_logins: [],
        watch_associations: ['NONE'],
        ignore_logins: [],
        watch_logins: [],
        max_events_per_author_per_poll: 200,
        max_events_per_repo_per_poll: 50,
      },
    });

    const events = await list_events(config, '2024-01-01T00:00:00Z');
    assert.equal(
      events.length,
      50,
      'repo cap (50) should stop pagination before author cap (200) is reached',
    );
    assert.ok(
      events.every((e) => e.author === 'attacker'),
      'all events should be from the flood author',
    );
  });

  // -------------------------------------------------------------------------
  // Post-filter repo cap: two authors, both hit author cap, repo cap not reached
  // -------------------------------------------------------------------------

  it('two authors each hit author cap independently; repo cap is not the limiting factor', async () => {
    // Two authors each with 30 issues, author cap=20, repo cap=200.
    // Expected: 20 from alice + 20 from bob = 40 total.
    // The repo cap (200) is not hit; the author cap (20) is the binding constraint.
    const aliceIssues = Array.from({ length: 30 }, (_, i) =>
      makeRawIssue({
        number: 2000 + i,
        user: { login: 'alice', type: 'User' },
        author_association: 'NONE',
      }),
    );
    const bobIssues = Array.from({ length: 30 }, (_, i) =>
      makeRawIssue({
        number: 2100 + i,
        user: { login: 'bob', type: 'User' },
        author_association: 'NONE',
      }),
    );

    // All 60 items fit on one page (< 100), so no pagination is needed.
    globalThis.fetch = async () => mockResponse(200, [...aliceIssues, ...bobIssues]);

    const config = makeConfig({
      source: {
        adapter: 'github',
        org: null,
        repos: ['example/repo'],
        allow_bot_logins: [],
        watch_associations: ['NONE'],
        ignore_logins: [],
        watch_logins: [],
        max_events_per_author_per_poll: 20,
        max_events_per_repo_per_poll: 200,
      },
    });

    const events = await list_events(config, '2024-01-01T00:00:00Z');
    const aliceEvents = events.filter((e) => e.author === 'alice');
    const bobEvents = events.filter((e) => e.author === 'bob');

    assert.equal(aliceEvents.length, 20, 'alice capped at 20 by author cap');
    assert.equal(bobEvents.length, 20, 'bob capped at 20 by author cap');
    assert.equal(events.length, 40, 'total should be 40 (20+20), not 50 or 60');
  });

  // -------------------------------------------------------------------------
  // Test 5b: repos=['*'] without org throws AdapterError
  // -------------------------------------------------------------------------

  it("throws AdapterError when repos=['*'] and no org is set", async () => {
    const config = makeConfig({ source: { repos: ['*'], org: null, allow_bot_logins: [] } });

    await assert.rejects(
      () => list_events(config, '2024-01-01T00:00:00Z'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.ok(err.message.includes('org'));
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  // since validation: malformed string is rejected
  // -------------------------------------------------------------------------

  it('throws AdapterError with code invalid_since for a malformed since value', async () => {
    const config = makeConfig();

    await assert.rejects(
      () => list_events(config, 'yesterday'),
      (err) => {
        assert.ok(err instanceof AdapterError, 'should be AdapterError');
        assert.equal(err.code, 'invalid_since');
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  // since validation: a valid ISO 8601 timestamp passes without throwing
  // -------------------------------------------------------------------------

  it('does not throw for a well-formed ISO 8601 since value', async () => {
    globalThis.fetch = async () => mockResponse(200, []);

    const config = makeConfig();
    // Should resolve without error; the adapter returns an empty array.
    const events = await list_events(config, '2024-06-01T12:00:00Z');
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// Test 6: post_comment calls correct endpoint with body
// ---------------------------------------------------------------------------

describe('post_comment', () => {
  it('calls the correct endpoint with the supplied body', async () => {
    let capturedUrl;
    let capturedBody;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(201, { html_url: 'https://github.com/example/repo/issues/42#issuecomment-1' });
    };

    const config = makeConfig();
    const event = {
      type: 'issue',
      repo: 'example/repo',
      number: 42,
    };

    const commentUrl = await post_comment(config, event, 'Thanks for the report!');

    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/issues/42/comments',
    );
    assert.equal(capturedBody.body, 'Thanks for the report!');
    assert.equal(
      commentUrl,
      'https://github.com/example/repo/issues/42#issuecomment-1',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests 7 & 8: close_item
// ---------------------------------------------------------------------------

describe('close_item', () => {
  it('closes an issue with state=closed and state_reason=not_planned', async () => {
    let capturedUrl;
    let capturedBody;
    let capturedMethod;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      capturedMethod = opts.method;
      return mockResponse(200, {});
    };

    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await close_item(config, event);

    assert.equal(capturedMethod, 'PATCH');
    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/issues/42',
    );
    assert.equal(capturedBody.state, 'closed');
    assert.equal(capturedBody.state_reason, 'not_planned');
  });

  it('closes a PR via the pulls endpoint', async () => {
    let capturedUrl;
    let capturedBody;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(200, {});
    };

    const config = makeConfig();
    const event = { type: 'pr', repo: 'example/repo', number: 7 };

    await close_item(config, event);

    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/pulls/7',
    );
    assert.equal(capturedBody.state, 'closed');
    assert.equal(capturedBody.state_reason, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test 9: request_changes on issue throws AdapterError
// ---------------------------------------------------------------------------

describe('request_changes', () => {
  it('throws AdapterError when called on an issue', async () => {
    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await assert.rejects(
      () => request_changes(config, event, 'Please fix X'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.ok(err.message.includes("type='issue'"));
        return true;
      },
    );
  });

  it('calls the reviews endpoint for a PR', async () => {
    let capturedUrl;
    let capturedBody;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(200, {});
    };

    const config = makeConfig();
    const event = { type: 'pr', repo: 'example/repo', number: 7 };

    await request_changes(config, event, 'Needs work');

    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/pulls/7/reviews',
    );
    assert.equal(capturedBody.event, 'REQUEST_CHANGES');
    assert.equal(capturedBody.body, 'Needs work');
  });
});

// ---------------------------------------------------------------------------
// Test 10: approve_pr calls correct review endpoint
// ---------------------------------------------------------------------------

describe('approve_pr', () => {
  it('calls the reviews endpoint with APPROVE for a PR', async () => {
    let capturedUrl;
    let capturedBody;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(200, {});
    };

    const config = makeConfig();
    const event = { type: 'pr', repo: 'example/repo', number: 7 };

    await approve_pr(config, event);

    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/pulls/7/reviews',
    );
    assert.equal(capturedBody.event, 'APPROVE');
  });

  it('throws AdapterError when called on an issue', async () => {
    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await assert.rejects(
      () => approve_pr(config, event),
      (err) => {
        assert.ok(err instanceof AdapterError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// label_item
// ---------------------------------------------------------------------------

describe('label_item', () => {
  it('calls the labels endpoint with the supplied labels', async () => {
    let capturedUrl;
    let capturedBody;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(200, []);
    };

    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await label_item(config, event, ['triage', 'needs-info']);

    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/issues/42/labels',
    );
    assert.deepEqual(capturedBody.labels, ['triage', 'needs-info']);
  });
});

// ---------------------------------------------------------------------------
// unlabel_item
// ---------------------------------------------------------------------------

describe('unlabel_item', () => {
  it('calls DELETE on the per-label endpoint', async () => {
    let capturedUrl;
    let capturedMethod;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      return mockResponse(200, {});
    };

    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await unlabel_item(config, event, 'status/needs-triage');

    assert.equal(capturedMethod, 'DELETE');
    assert.equal(
      capturedUrl,
      'https://api.github.com/repos/example/repo/issues/42/labels/status%2Fneeds-triage',
    );
  });

  it('treats a 404 (label not applied) as a no-op success', async () => {
    globalThis.fetch = async () => mockResponse(404, { message: 'Label does not exist' });

    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    // Should resolve without throwing.
    await unlabel_item(config, event, 'status/accepted');
  });

  it('throws AdapterError on a non-404 failure', async () => {
    globalThis.fetch = async () => mockResponse(500, { message: 'Internal Server Error' });

    const config = makeConfig();
    const event = { type: 'issue', repo: 'example/repo', number: 42 };

    await assert.rejects(
      () => unlabel_item(config, event, 'status/accepted'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        return true;
      },
    );
  });
});
