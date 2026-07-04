/**
 * Tests for src/lifecycle.js PR-opened / ready-for-review transitions (T10, lr-9e35).
 *
 * Uses the same fake adapter double pattern as tests/lifecycle.test.js — no real
 * GitHub calls. Covers:
 *   - applyPrOpenedTransition -> status/in-progress (draft PRs only)
 *   - applyPrReadyForReviewTransition -> status/in-review (non-draft PRs only)
 *   - mutual exclusivity by draft flag
 *   - regression guard (never reverts a later status)
 *   - single-status invariant and idempotency
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyPrOpenedTransition, applyPrReadyForReviewTransition } from '../src/lifecycle.js';

function makeConfig(overrides = {}) {
  return {
    source: { repos: ['owner/repo'], org: null },
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'in-progress', 'in-review', 'awaiting-release', 'released'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
    ...overrides,
  };
}

function makeFakeAdapter({ initialLabels = {}, closingIssues = [] } = {}) {
  const state = {
    labels: { ...initialLabels },
    labelCalls: [],
    unlabelCalls: [],
  };
  const key = (repo, number) => `${repo}#${number}`;

  const adapter = {
    async get_pr_closing_issues() {
      return { closingIssues, crossRepoRefs: [] };
    },
    async get_item_labels(_config, event) {
      return state.labels[key(event.repo, event.number)] ?? [];
    },
    async label_item(_config, event, labels) {
      const k = key(event.repo, event.number);
      state.labelCalls.push({ repo: event.repo, number: event.number, labels });
      const current = state.labels[k] ?? [];
      state.labels[k] = [...new Set([...current, ...labels])];
    },
    async unlabel_item(_config, event, label) {
      const k = key(event.repo, event.number);
      state.unlabelCalls.push({ repo: event.repo, number: event.number, label });
      state.labels[k] = (state.labels[k] ?? []).filter((l) => l !== label);
    },
  };

  return { adapter, state };
}

function makeDraftPrEvent(overrides = {}) {
  return {
    id: 'owner/repo#7',
    type: 'pr',
    repo: 'owner/repo',
    number: 7,
    body: 'Closes #42',
    metadata: { merged: false, draft: true },
    ...overrides,
  };
}

function makeReadyPrEvent(overrides = {}) {
  return {
    id: 'owner/repo#7',
    type: 'pr',
    repo: 'owner/repo',
    number: 7,
    body: 'Closes #42',
    metadata: { merged: false, draft: false },
    ...overrides,
  };
}

const CLOSING = [{ owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' }];

describe('applyPrOpenedTransition', () => {
  it('applies status/in-progress to each linked issue for a draft PR', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const result = await applyPrOpenedTransition(config, adapter, makeDraftPrEvent());

    assert.equal(result.applied, true);
    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: true }]);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/in-progress']);
  });

  it('is a no-op for a non-draft PR — that is applyPrReadyForReviewTransition’s job', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const result = await applyPrOpenedTransition(config, adapter, makeReadyPrEvent());

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is a no-op for a merged PR', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const event = makeDraftPrEvent({ metadata: { merged: true, draft: true } });
    const result = await applyPrOpenedTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is a no-op when the PR has no linked issues', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: [] });

    const result = await applyPrOpenedTransition(config, adapter, makeDraftPrEvent());

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is idempotent — a second run on an already in-progress issue is a no-op', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/in-progress'] },
      closingIssues: CLOSING,
    });

    const result = await applyPrOpenedTransition(config, adapter, makeDraftPrEvent());

    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: false }]);
    assert.equal(state.labelCalls.length, 0);
  });

  it('never regresses an issue already in-review, awaiting-release, or released', async () => {
    for (const laterStatus of ['status/in-review', 'status/awaiting-release', 'status/released']) {
      const config = makeConfig();
      const { adapter, state } = makeFakeAdapter({
        initialLabels: { 'owner/repo#42': [laterStatus] },
        closingIssues: CLOSING,
      });

      const result = await applyPrOpenedTransition(config, adapter, makeDraftPrEvent());

      assert.deepEqual(
        result.issues,
        [{ repo: 'owner/repo', number: 42, labeled: false }],
        `must not regress from ${laterStatus}`,
      );
      assert.deepEqual(state.labels['owner/repo#42'], [laterStatus]);
      assert.equal(state.labelCalls.length, 0);
    }
  });

  it('removes a prior needs-triage status label (single-status invariant)', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/needs-triage'] },
      closingIssues: CLOSING,
    });

    await applyPrOpenedTransition(config, adapter, makeDraftPrEvent());

    assert.deepEqual(state.labels['owner/repo#42'], ['status/in-progress']);
    assert.deepEqual(state.unlabelCalls, [{ repo: 'owner/repo', number: 42, label: 'status/needs-triage' }]);
  });
});

describe('applyPrReadyForReviewTransition', () => {
  it('applies status/in-review to each linked issue for a non-draft, unmerged PR', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const result = await applyPrReadyForReviewTransition(config, adapter, makeReadyPrEvent());

    assert.equal(result.applied, true);
    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: true }]);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/in-review']);
  });

  it('is a no-op for a draft PR — that is applyPrOpenedTransition’s job', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const result = await applyPrReadyForReviewTransition(config, adapter, makeDraftPrEvent());

    assert.equal(result.applied, false);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is a no-op for a merged PR', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({ closingIssues: CLOSING });

    const event = makeReadyPrEvent({ metadata: { merged: true, draft: false } });
    const result = await applyPrReadyForReviewTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.equal(state.labelCalls.length, 0);
  });

  it('never regresses an issue already awaiting-release or released', async () => {
    for (const laterStatus of ['status/awaiting-release', 'status/released']) {
      const config = makeConfig();
      const { adapter, state } = makeFakeAdapter({
        initialLabels: { 'owner/repo#42': [laterStatus] },
        closingIssues: CLOSING,
      });

      const result = await applyPrReadyForReviewTransition(config, adapter, makeReadyPrEvent());

      assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: false }]);
      assert.deepEqual(state.labels['owner/repo#42'], [laterStatus]);
    }
  });

  it('DOES regress from in-progress to in-review — that is forward progress, not a regression', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/in-progress'] },
      closingIssues: CLOSING,
    });

    const result = await applyPrReadyForReviewTransition(config, adapter, makeReadyPrEvent());

    assert.equal(result.applied, true);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/in-review']);
  });

  it('is idempotent — a second run on an already in-review issue is a no-op', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/in-review'] },
      closingIssues: CLOSING,
    });

    const result = await applyPrReadyForReviewTransition(config, adapter, makeReadyPrEvent());

    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: false }]);
    assert.equal(state.labelCalls.length, 0);
  });
});
