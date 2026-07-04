/**
 * Tests for src/cli.js's routeEvent — the single lifecycle-vs-triage dispatch
 * point (T6 lr-d557, T10 lr-9e35).
 *
 * Only the new T10 PR-opened/ready-for-review branch is covered here; the
 * pre-existing merge/release branching is covered by tests/lifecycle.test.js
 * exercising the underlying transition functions directly. This file verifies
 * the wiring: routeEvent picks exactly one transition based on the PR's draft
 * flag for a PR event with linked issues.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeEvent } from '../src/cli.js';

function makeConfig() {
  return {
    source: { repos: ['owner/repo'], org: null },
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'in-progress', 'in-review', 'awaiting-release', 'released'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
  };
}

function makeAdapter({ closingIssues = [], labels = {} } = {}) {
  const calls = { labeled: [], processEventCalled: false };
  return {
    calls,
    async get_pr_closing_issues() {
      return { closingIssues, crossRepoRefs: [] };
    },
    async get_item_labels(_config, event) {
      return labels[`${event.repo}#${event.number}`] ?? [];
    },
    async label_item(_config, event, appliedLabels) {
      calls.labeled.push({ repo: event.repo, number: event.number, labels: appliedLabels });
    },
    async unlabel_item() {},
  };
}

function makePrEvent({ draft, merged = false }) {
  return {
    id: 'owner/repo#7',
    type: 'pr',
    repo: 'owner/repo',
    number: 7,
    body: 'Closes #42',
    metadata: { merged, draft, base_ref: 'main', default_branch: 'main' },
  };
}

const CLOSING = [{ owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' }];

describe('routeEvent — PR-opened/ready-for-review (T10, lr-9e35)', () => {
  it('routes a draft PR to the in-progress transition (kind: pr_opened)', async () => {
    const config = makeConfig();
    const adapter = makeAdapter({ closingIssues: CLOSING });

    const result = await routeEvent(config, makePrEvent({ draft: true }), adapter);

    assert.equal(result.kind, 'pr_opened');
    assert.equal(result.applied, true);
    assert.deepEqual(adapter.calls.labeled, [{ repo: 'owner/repo', number: 42, labels: ['status/in-progress'] }]);
  });

  it('routes a non-draft PR to the in-review transition (kind: pr_ready_for_review)', async () => {
    const config = makeConfig();
    const adapter = makeAdapter({ closingIssues: CLOSING });

    const result = await routeEvent(config, makePrEvent({ draft: false }), adapter);

    assert.equal(result.kind, 'pr_ready_for_review');
    assert.equal(result.applied, true);
    assert.deepEqual(adapter.calls.labeled, [{ repo: 'owner/repo', number: 42, labels: ['status/in-review'] }]);
  });
});
