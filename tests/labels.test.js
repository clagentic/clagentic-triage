/**
 * Tests for src/labels.js — namespaced label vocabulary + single-status helper.
 * Run with: node --test tests/labels.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultVocabulary,
  resolveVocabulary,
  isStatusLabel,
  normalizeLabels,
  enforceSingleStatus,
  STATUS_NAMESPACE,
} from '../src/labels.js';

describe('defaultVocabulary', () => {
  it('exposes the status/* axis as the single state axis', () => {
    const vocab = defaultVocabulary();
    assert.equal(vocab.status_namespace, STATUS_NAMESPACE);
    assert.ok(vocab.status_values.includes('needs-triage'));
    assert.ok(vocab.status_values.includes('released'));
  });

  it('keeps not_planned_values and axes disjoint from status_values', () => {
    const vocab = defaultVocabulary();
    for (const v of vocab.not_planned_values) {
      assert.ok(!vocab.status_values.includes(v), `${v} must not also be a status value`);
    }
  });
});

describe('resolveVocabulary', () => {
  it('falls back to defaults when config has no labels block', () => {
    const vocab = resolveVocabulary({});
    assert.deepEqual(vocab, defaultVocabulary());
  });

  it('honors an operator-supplied vocabulary without hardcoding it', () => {
    const config = {
      labels: {
        status_namespace: 'lifecycle',
        status_values: ['new', 'done'],
        not_planned_values: ['wontfix'],
        axes: { kind: ['bug'], priority: [], area: ['backend'] },
      },
    };
    const vocab = resolveVocabulary(config);
    assert.equal(vocab.status_namespace, 'lifecycle');
    assert.deepEqual(vocab.status_values, ['new', 'done']);
    assert.deepEqual(vocab.axes.area, ['backend']);
  });

  it('passes through operator-defined additional axes beyond kind/priority/area', () => {
    const config = { labels: { axes: { team: ['platform', 'growth'] } } };
    const vocab = resolveVocabulary(config);
    assert.deepEqual(vocab.axes.team, ['platform', 'growth']);
    // Built-in axes still fall back to defaults when not supplied.
    assert.ok(vocab.axes.kind.length > 0);
  });
});

describe('isStatusLabel', () => {
  it('identifies status/* labels under the configured namespace', () => {
    const vocab = defaultVocabulary();
    assert.equal(isStatusLabel('status/accepted', vocab), true);
    assert.equal(isStatusLabel('kind/bug', vocab), false);
    assert.equal(isStatusLabel('wontfix', vocab), false);
  });

  it('respects a renamed status namespace', () => {
    const vocab = resolveVocabulary({ labels: { status_namespace: 'lifecycle' } });
    assert.equal(isStatusLabel('lifecycle/accepted', vocab), true);
    assert.equal(isStatusLabel('status/accepted', vocab), false);
  });
});

describe('normalizeLabels', () => {
  it('accepts labels present in the vocabulary', () => {
    const { accepted, rejected } = normalizeLabels({}, ['status/accepted', 'kind/bug', 'priority/p1']);
    assert.deepEqual(accepted, ['status/accepted', 'kind/bug', 'priority/p1']);
    assert.deepEqual(rejected, []);
  });

  it('rejects labels outside the vocabulary rather than silently dropping them', () => {
    const { accepted, rejected } = normalizeLabels({}, ['status/accepted', 'made-up-label']);
    assert.deepEqual(accepted, ['status/accepted']);
    assert.deepEqual(rejected, ['made-up-label']);
  });

  it('accepts not_planned closure labels', () => {
    const { accepted } = normalizeLabels({}, ['wontfix', 'duplicate']);
    assert.deepEqual(accepted, ['wontfix', 'duplicate']);
  });

  it('honors a config-driven vocabulary override, not a hardcoded one', () => {
    const config = { labels: { axes: { area: ['payments'] } } };
    const { accepted, rejected } = normalizeLabels(config, ['area/payments', 'area/not-configured']);
    assert.deepEqual(accepted, ['area/payments']);
    assert.deepEqual(rejected, ['area/not-configured']);
  });

  it('rejects empty/whitespace-only and non-string entries', () => {
    const { accepted, rejected } = normalizeLabels({}, ['', '   ', 42, 'status/accepted']);
    assert.deepEqual(accepted, ['status/accepted']);
    assert.equal(rejected.length, 3);
  });
});

describe('enforceSingleStatus', () => {
  it('returns no removals when no incoming status label is present', () => {
    const result = enforceSingleStatus({}, ['status/accepted', 'kind/bug'], ['priority/p1']);
    assert.deepEqual(result.toRemove, []);
    assert.deepEqual(result.toApply, ['priority/p1']);
  });

  it('marks the existing status label for removal when a new one is applied', () => {
    const result = enforceSingleStatus({}, ['status/needs-triage', 'kind/bug'], ['status/accepted']);
    assert.deepEqual(result.toRemove, ['status/needs-triage']);
    assert.deepEqual(result.toApply, ['status/accepted']);
  });

  it('does not re-remove a status label that is also the incoming one (idempotent)', () => {
    const result = enforceSingleStatus({}, ['status/accepted'], ['status/accepted']);
    assert.deepEqual(result.toRemove, []);
  });

  it('handles multiple stale status labels (defensive against prior drift)', () => {
    const result = enforceSingleStatus(
      {},
      ['status/needs-triage', 'status/blocked', 'kind/bug'],
      ['status/in-progress'],
    );
    assert.deepEqual(result.toRemove.sort(), ['status/blocked', 'status/needs-triage'].sort());
  });

  it('throws if more than one status/* label is supplied as incoming', () => {
    assert.throws(
      () => enforceSingleStatus({}, [], ['status/accepted', 'status/blocked']),
      RangeError,
    );
  });

  it('leaves non-status current labels untouched', () => {
    const result = enforceSingleStatus({}, ['kind/bug', 'priority/p1'], ['status/accepted']);
    assert.deepEqual(result.toRemove, []);
  });
});
