/**
 * Tests for src/cli.js's routeEvent — the single lifecycle-vs-triage dispatch
 * point (T6 lr-d557, T10 lr-9e35).
 *
 * Only the new T10 PR-opened/ready-for-review branch is covered here; the
 * pre-existing merge/release branching is covered by tests/lifecycle.test.js
 * exercising the underlying transition functions directly. This file verifies
 * the wiring: routeEvent picks exactly one transition based on the PR's draft
 * flag for a PR event with linked issues.
 *
 * The "LLM-pipeline fallthrough is bot/actor-filtered" block (lr-af2104)
 * covers the actual incident this task fixes: a PR event with no linked
 * issue (so no lifecycle transition applies) must not reach
 * processEvent/the pending queue when it fails the adapter's combined
 * event_allowed gate.
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

// ---------------------------------------------------------------------------
// LLM-pipeline fallthrough is bot/actor-filtered (lr-af2104)
// ---------------------------------------------------------------------------

/**
 * A PR with no linked issue never reaches a lifecycle transition — it falls
 * through routeEvent to processEvent instead. These fixtures exercise that
 * exact fallthrough, the path list_open_prs/list_lifecycle_events (T10,
 * lr-9e35) feeds unfiltered by design, which is exactly how the incident's
 * 28 clagentic-builder[bot] and 14 akuehner pending-queue entries reached the
 * queue: neither PR type had (or needed) a linked issue.
 */
function makeUnlinkedPrEvent({ author, authorType = '', authorAssociation = null } = {}) {
  return {
    id: 'owner/repo#99',
    type: 'pr',
    repo: 'owner/repo',
    number: 99,
    author,
    body: 'no closing keyword here',
    metadata: {
      merged: false,
      draft: false,
      base_ref: 'main',
      default_branch: 'main',
      author_type: authorType,
      author_association: authorAssociation,
    },
  };
}

/**
 * Adapter double that also implements event_allowed/is_bot_event, mirroring
 * the real github adapter's exports, plus a processEvent-call spy via a
 * module-level flag on the adapter object (routeEvent's fallthrough calls
 * the real processEvent, which needs enrich/assess/etc. — rather than stub
 * those out here, event_allowed's own return value is asserted directly and
 * a spy wraps it to prove routeEvent actually consulted it before falling
 * through).
 */
function makeGatedAdapter({ closingIssues = [], allowBotLogins = [] } = {}) {
  const calls = { eventAllowedCalls: [] };
  return {
    calls,
    async get_pr_closing_issues() {
      return { closingIssues, crossRepoRefs: [] };
    },
    async get_item_labels() {
      return [];
    },
    async label_item() {},
    async unlabel_item() {},
    event_allowed(config, event) {
      calls.eventAllowedCalls.push(event.id);
      const login = event.author ?? '';
      const isBot = login.endsWith('[bot]') || event.metadata?.author_type === 'Bot';
      if (isBot && !allowBotLogins.includes(login)) {
        return false;
      }
      const ignoreLogins = config.source?.ignore_logins ?? [];
      if (ignoreLogins.includes(login)) {
        return false;
      }
      return true;
    },
  };
}

describe('routeEvent — LLM-pipeline fallthrough is bot/actor-filtered (lr-af2104)', () => {
  it('a [bot]-suffixed author on an unlinked PR is filtered before processEvent (never queued)', async () => {
    const config = makeConfig();
    const adapter = makeGatedAdapter({ closingIssues: [] });
    const event = makeUnlinkedPrEvent({ author: 'clagentic-builder[bot]', authorType: 'Bot' });

    const result = await routeEvent(config, event, adapter);

    assert.equal(result.kind, 'triage');
    assert.equal(result.status, 'ignored');
    assert.equal(result.reason, 'actor_or_bot');
    assert.deepEqual(adapter.calls.eventAllowedCalls, [event.id]);
  });

  it('an operator login present in ignore_logins on an unlinked PR is filtered before processEvent', async () => {
    const config = makeConfig();
    config.source.ignore_logins = ['akuehner'];
    const adapter = makeGatedAdapter({ closingIssues: [] });
    const event = makeUnlinkedPrEvent({ author: 'akuehner', authorAssociation: 'MEMBER' });

    const result = await routeEvent(config, event, adapter);

    assert.equal(result.status, 'ignored');
    assert.equal(result.reason, 'actor_or_bot');
  });

  it('does not call event_allowed for a PR event that resolves to a lifecycle transition', async () => {
    const config = makeConfig();
    const adapter = makeGatedAdapter({ closingIssues: CLOSING });

    await routeEvent(config, makePrEvent({ draft: true }), adapter);

    assert.deepEqual(adapter.calls.eventAllowedCalls, [], 'a linked PR resolves via the transition branch, never reaching the fallthrough gate');
  });

  it('an adapter without event_allowed does not throw — fallthrough proceeds unfiltered (backward compatible)', async () => {
    const config = makeConfig();
    // Deliberately omit event_allowed to match adapters written before lr-af2104.
    const adapter = makeAdapter({ closingIssues: [] });
    const event = makeUnlinkedPrEvent({ author: 'clagentic-builder[bot]', authorType: 'Bot' });

    // processEvent will run (no event_allowed gate present) and requires a full
    // config; assert only that routeEvent does not throw resolving the branch —
    // the absence-of-throw here is the backward-compatibility contract.
    await assert.doesNotReject(() => routeEvent(config, event, adapter));
  });
});
