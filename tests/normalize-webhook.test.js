/**
 * Tests for src/adapters/github.js normalize_webhook — release event support
 * and default_branch carry-through for pull_request events (T6, lr-d557).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalize_webhook } from '../src/adapters/github.js';

describe('normalize_webhook — pull_request (default_branch carry-through)', () => {
  it('carries payload.repository.default_branch into metadata.default_branch', () => {
    const headers = { 'x-github-event': 'pull_request' };
    const payload = {
      action: 'closed',
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      pull_request: {
        number: 7,
        title: 'Fix thing',
        body: 'Closes #42',
        merged_at: '2026-07-04T00:00:00Z',
        head: { ref: 'feat/thing' },
        base: { ref: 'main' },
        user: { login: 'alice' },
      },
    };

    const event = normalize_webhook(headers, payload);

    assert.equal(event.type, 'pr');
    assert.equal(event.metadata.merged, true);
    assert.equal(event.metadata.base_ref, 'main');
    assert.equal(event.metadata.default_branch, 'main');
  });

  it('sets default_branch to null when the repository payload omits it', () => {
    const headers = { 'x-github-event': 'pull_request' };
    const payload = {
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 7, base: { ref: 'main' } },
    };

    const event = normalize_webhook(headers, payload);
    assert.equal(event.metadata.default_branch, null);
  });
});

describe('normalize_webhook — release', () => {
  it('normalizes a published release to a type=release Event', () => {
    const headers = { 'x-github-event': 'release' };
    const payload = {
      action: 'published',
      repository: { full_name: 'owner/repo' },
      release: {
        id: 123,
        tag_name: 'v1.2.0',
        target_commitish: 'main',
        name: 'v1.2.0',
        body: 'Closes #42',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/owner/repo/releases/tag/v1.2.0',
        published_at: '2026-07-04T00:00:00Z',
        author: { login: 'releaser' },
        created_at: '2026-07-04T00:00:00Z',
      },
    };

    const event = normalize_webhook(headers, payload);

    assert.ok(event);
    assert.equal(event.type, 'release');
    assert.equal(event.repo, 'owner/repo');
    assert.equal(event.number, null);
    assert.equal(event.title, 'v1.2.0');
    assert.equal(event.body, 'Closes #42');
    assert.equal(event.author, 'releaser');
    assert.equal(event.metadata.tag_name, 'v1.2.0');
    assert.equal(event.metadata.target_commitish, 'main');
    assert.equal(event.metadata.draft, false);
    assert.equal(event.metadata.prerelease, false);
  });

  it('returns null for non-published release actions (created draft, edited, deleted, unpublished)', () => {
    const headers = { 'x-github-event': 'release' };
    for (const action of ['created', 'edited', 'deleted', 'unpublished']) {
      const payload = {
        action,
        repository: { full_name: 'owner/repo' },
        release: { id: 1, tag_name: 'v1.0.0', draft: action === 'created' },
      };
      assert.equal(normalize_webhook(headers, payload), null, `action=${action} should not normalize`);
    }
  });

  it('normalizes a prerelease publish (published action still fires for prereleases)', () => {
    const headers = { 'x-github-event': 'release' };
    const payload = {
      action: 'published',
      repository: { full_name: 'owner/repo' },
      release: { id: 2, tag_name: 'v1.2.0-beta.1', prerelease: true, draft: false, body: '' },
    };

    const event = normalize_webhook(headers, payload);
    assert.ok(event);
    assert.equal(event.metadata.prerelease, true);
  });
});

describe('normalize_webhook — unsupported event types unaffected', () => {
  it('still returns null for an event type outside the supported set', () => {
    const headers = { 'x-github-event': 'star' };
    const event = normalize_webhook(headers, { repository: { full_name: 'owner/repo' } });
    assert.equal(event, null);
  });
});
