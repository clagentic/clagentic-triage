/**
 * Tests for src/lifecycle.js (T6, lr-d557)
 *
 * Uses a fake adapter double — no real GitHub calls. Covers:
 *   - isMergedToDefaultBranch detection
 *   - applyMergeTransition -> status/awaiting-release (never released)
 *   - applyReleaseTransition -> released + close (never awaiting-release)
 *   - the single-status invariant on both transitions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMergedToDefaultBranch,
  applyMergeTransition,
  applyReleaseTransition,
} from '../src/lifecycle.js';

function makeConfig(overrides = {}) {
  return {
    // Watch scope defaults to exactly the fixtures' own repo ("owner/repo") so
    // same-repo release-transition tests pass the scope check by default.
    // Cross-repo scope tests below override `source` explicitly.
    source: {
      repos: ['owner/repo'],
      org: null,
    },
    labels: {
      status_namespace: 'status',
      status_values: ['needs-triage', 'in-review', 'awaiting-release', 'released'],
      not_planned_values: ['wontfix', 'duplicate', 'invalid'],
      axes: { kind: [], priority: [], area: [] },
    },
    ...overrides,
  };
}

/**
 * Fake adapter with in-memory per-(repo,number) label/state store, plus a
 * configurable get_pr_closing_issues stub for the merge-path tests.
 */
function makeFakeAdapter({ initialLabels = {}, closingIssues = [], crossRepoRefs = [] } = {}) {
  const state = {
    labels: { ...initialLabels }, // key: "repo#number" -> string[]
    closed: new Set(),            // key: "repo#number"
    labelCalls: [],
    unlabelCalls: [],
    closeCalls: [],
  };

  const key = (repo, number) => `${repo}#${number}`;

  const adapter = {
    async get_pr_closing_issues() {
      return { closingIssues, crossRepoRefs };
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
    async close_item_completed(_config, event) {
      state.closeCalls.push({ repo: event.repo, number: event.number });
      state.closed.add(key(event.repo, event.number));
    },
  };

  return { adapter, state };
}

function makeMergedPrEvent(overrides = {}) {
  return {
    id: 'owner/repo#7',
    type: 'pr',
    repo: 'owner/repo',
    number: 7,
    metadata: {
      merged: true,
      base_ref: 'main',
      default_branch: 'main',
    },
    ...overrides,
  };
}

function makeReleaseEvent(overrides = {}) {
  return {
    id: 'owner/repo#release-1',
    type: 'release',
    repo: 'owner/repo',
    body: 'Closes #42',
    ...overrides,
  };
}

describe('isMergedToDefaultBranch', () => {
  it('returns true for a merged PR whose base_ref matches default_branch', () => {
    assert.equal(isMergedToDefaultBranch(makeMergedPrEvent()), true);
  });

  it('returns false for a merged PR into a non-default branch', () => {
    const event = makeMergedPrEvent({ metadata: { merged: true, base_ref: 'release/1.x', default_branch: 'main' } });
    assert.equal(isMergedToDefaultBranch(event), false);
  });

  it('returns false for an unmerged PR', () => {
    const event = makeMergedPrEvent({ metadata: { merged: false, base_ref: 'main', default_branch: 'main' } });
    assert.equal(isMergedToDefaultBranch(event), false);
  });

  it('returns false when default_branch is unresolved (null)', () => {
    const event = makeMergedPrEvent({ metadata: { merged: true, base_ref: 'main', default_branch: null } });
    assert.equal(isMergedToDefaultBranch(event), false);
  });

  it('returns false for a non-PR event', () => {
    assert.equal(isMergedToDefaultBranch({ type: 'issue', metadata: {} }), false);
  });
});

describe('applyMergeTransition', () => {
  it('applies status/awaiting-release to each same-repo closing issue', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      closingIssues: [
        { owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' },
      ],
    });

    const result = await applyMergeTransition(config, adapter, makeMergedPrEvent());

    assert.equal(result.applied, true);
    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: true }]);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/awaiting-release']);
    // Merge must NEVER apply released — the #1 invariant for this task.
    assert.ok(!state.labels['owner/repo#42'].includes('status/released'));
  });

  it('is idempotent — a second run for an item already awaiting-release is a no-op', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/awaiting-release'] },
      closingIssues: [
        { owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' },
      ],
    });

    const result = await applyMergeTransition(config, adapter, makeMergedPrEvent());

    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: false }]);
    assert.equal(state.labelCalls.length, 0);
    assert.equal(state.unlabelCalls.length, 0);
  });

  it('removes a prior status/* label (single-status invariant)', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/in-review'] },
      closingIssues: [
        { owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' },
      ],
    });

    await applyMergeTransition(config, adapter, makeMergedPrEvent());

    assert.deepEqual(state.labels['owner/repo#42'], ['status/awaiting-release']);
    assert.deepEqual(state.unlabelCalls, [{ repo: 'owner/repo', number: 42, label: 'status/in-review' }]);
  });

  it('is a no-op when the PR was not merged to the default branch', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      closingIssues: [{ owner: 'owner', repo: 'repo', number: 42, title: 'Bug', url: 'https://x/42', state: 'OPEN' }],
    });

    const event = makeMergedPrEvent({ metadata: { merged: true, base_ref: 'feature/x', default_branch: 'main' } });
    const result = await applyMergeTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
  });

  it('handles multiple closing issues in one PR', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      closingIssues: [
        { owner: 'owner', repo: 'repo', number: 42, title: 'A', url: 'https://x/42', state: 'OPEN' },
        { owner: 'owner', repo: 'repo', number: 43, title: 'B', url: 'https://x/43', state: 'OPEN' },
      ],
    });

    const result = await applyMergeTransition(config, adapter, makeMergedPrEvent());

    assert.equal(result.issues.length, 2);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/awaiting-release']);
    assert.deepEqual(state.labels['owner/repo#43'], ['status/awaiting-release']);
  });
});

describe('applyReleaseTransition', () => {
  it('applies released + closes the referenced same-repo issue', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/awaiting-release'] },
    });

    const result = await applyReleaseTransition(config, adapter, makeReleaseEvent());

    assert.equal(result.applied, true);
    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: true, closed: true }]);
    assert.deepEqual(state.labels['owner/repo#42'], ['status/released']);
    assert.ok(state.closed.has('owner/repo#42'));
  });

  it('removes the prior awaiting-release label — awaiting-release != released', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/awaiting-release'] },
    });

    await applyReleaseTransition(config, adapter, makeReleaseEvent());

    assert.deepEqual(state.unlabelCalls, [{ repo: 'owner/repo', number: 42, label: 'status/awaiting-release' }]);
    assert.ok(!state.labels['owner/repo#42'].includes('status/awaiting-release'));
  });

  it('is idempotent — a second run for an already-released issue does not relabel', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter({
      initialLabels: { 'owner/repo#42': ['status/released'] },
    });

    const result = await applyReleaseTransition(config, adapter, makeReleaseEvent());

    assert.deepEqual(result.issues, [{ repo: 'owner/repo', number: 42, labeled: false, closed: true }]);
    assert.equal(state.labelCalls.length, 0);
    // close_item_completed is still called — idempotent on GitHub's side.
    assert.equal(state.closeCalls.length, 1);
  });

  it('honors an in-scope cross-repo owner/repo#N reference in the release body', async () => {
    const config = makeConfig({ source: { repos: ['owner/repo', 'other-org/other-repo'], org: null } });
    const { adapter, state } = makeFakeAdapter();

    const event = makeReleaseEvent({ body: 'Fixes other-org/other-repo#99' });
    const result = await applyReleaseTransition(config, adapter, event);

    assert.deepEqual(result.issues, [{ repo: 'other-org/other-repo', number: 99, labeled: true, closed: true }]);
    assert.deepEqual(state.labels['other-org/other-repo#99'], ['status/released']);
  });

  it('drops an out-of-scope cross-repo reference — confused-deputy guard (BOBBIE review 4629660561)', async () => {
    // Default makeConfig() watch scope is exactly "owner/repo"; a release body
    // for that repo referencing a DIFFERENT, unconfigured repo must not drive
    // any label/close call against it — the release body is publisher-
    // controlled, not operator-controlled trust input.
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter();

    const event = makeReleaseEvent({ body: 'Fixes some-other-org/some-other-repo#1' });
    const result = await applyReleaseTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
    assert.equal(state.closeCalls.length, 0);
    assert.equal(state.labels['some-other-org/some-other-repo#1'], undefined);
  });

  it('drops an out-of-scope SAME-repo-shaped ref when the watch scope is narrower still', async () => {
    // Even a same-repo bare #N ref must respect the watch scope: if the
    // operator's config does not include the release's own repo, nothing
    // should be actioned (defense in depth against a misconfigured scope).
    const config = makeConfig({ source: { repos: ['some-other/repo'], org: null } });
    const { adapter, state } = makeFakeAdapter();

    const result = await applyReleaseTransition(config, adapter, makeReleaseEvent());

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
    assert.equal(state.closeCalls.length, 0);
  });

  it('honors cross-repo refs under an org wildcard scope when the ref owner matches the org', async () => {
    const config = makeConfig({ source: { repos: ['*'], org: 'owner' } });
    const { adapter, state } = makeFakeAdapter();

    const event = makeReleaseEvent({ body: 'Fixes owner/another-repo#5' });
    const result = await applyReleaseTransition(config, adapter, event);

    assert.deepEqual(result.issues, [{ repo: 'owner/another-repo', number: 5, labeled: true, closed: true }]);
    assert.deepEqual(state.labels['owner/another-repo#5'], ['status/released']);
  });

  it('drops cross-repo refs under an org wildcard scope when the ref owner does not match the org', async () => {
    const config = makeConfig({ source: { repos: ['*'], org: 'owner' } });
    const { adapter, state } = makeFakeAdapter();

    const event = makeReleaseEvent({ body: 'Fixes attacker-org/evil-repo#1' });
    const result = await applyReleaseTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is a no-op for an event that is not type=release', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter();

    const result = await applyReleaseTransition(config, adapter, makeMergedPrEvent());

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.labelCalls.length, 0);
  });

  it('is a no-op when the release body has no closing-keyword references', async () => {
    const config = makeConfig();
    const { adapter, state } = makeFakeAdapter();

    const event = makeReleaseEvent({ body: 'Just a changelog, no issue refs.' });
    const result = await applyReleaseTransition(config, adapter, event);

    assert.equal(result.applied, false);
    assert.deepEqual(result.issues, []);
    assert.equal(state.closeCalls.length, 0);
  });
});
