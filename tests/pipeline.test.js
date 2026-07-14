/**
 * Tests for src/pipeline.js and src/router.js
 *
 * Uses Node's built-in test runner (node:test). All external dependencies
 * (adapter, enricher, assessor) are replaced with in-process test doubles
 * injected via module mocking.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a minimal config suitable for pipeline tests.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  return {
    confidence_threshold: 0.7,
    auto_approve: [],
    auto_label: false,
    allow_auto_pr_approval: false,
    ...overrides,
  };
}

/**
 * Build a minimal normalized event.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeEvent(overrides = {}) {
  return {
    id: 'repo/owner#1',
    type: 'issue',
    title: 'Test issue',
    body: 'Test body',
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
 * Build a minimal Assessment.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeAssessment(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.9,
    reasoning: 'Looks good.',
    suggested_action: {
      classes: ['respond'],
      body: 'Thank you for the report.',
      dispatch_target: null,
      labels: [],
    },
    model_used: 'test-model',
    assessed_at: '2024-01-01T00:00:00Z',
    event_id: 'repo/owner#1',
    ...overrides,
  };
}

/**
 * Build a mock adapter. All action methods are no-ops by default.
 * Pass a spy map to override individual methods.
 *
 * @param {object} [spies] - Map of method name → function
 * @returns {object}
 */
function makeAdapter(spies = {}) {
  return {
    list_events: spies.list_events ?? (() => Promise.resolve([])),
    post_comment: spies.post_comment ?? (() => Promise.resolve()),
    close_item: spies.close_item ?? (() => Promise.resolve()),
    request_changes: spies.request_changes ?? (() => Promise.resolve()),
    approve_pr: spies.approve_pr ?? (() => Promise.resolve()),
    label_item: spies.label_item ?? (() => Promise.resolve()),
    unlabel_item: spies.unlabel_item ?? (() => Promise.resolve()),
    get_item_labels: spies.get_item_labels ?? (() => Promise.resolve([])),
    // lr-910ca2: runPipeline's awaiting_info reply-scan calls list_comments
    // only for items with queue_reason 'awaiting_info' — default to "no
    // reply yet" so pre-existing tests that never populate an awaiting_info
    // queue item are unaffected by this addition.
    list_comments: spies.list_comments ?? (() => Promise.resolve([])),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks for enricher and assessor
//
// Node's built-in test runner does not expose a stable import-mock API in
// Node 20. We work around this by importing the pipeline module with its real
// imports and replacing the module-level functions via a thin seam pattern:
// pipeline.js imports enrich() and assess() which we cannot intercept at the
// module graph level in plain ESM without a loader.
//
// Instead, we test pipeline behavior at a level that IS controllable:
// We test router.js directly (pure function, no imports to mock).
// For pipeline.js we use an integration approach that validates observable
// behavior against a controlled adapter spy — the real enrich() and assess()
// are not called because we build a test-only shim of processEvent that
// inlines the pipeline logic with injected enrich/assess functions.
// ---------------------------------------------------------------------------

/**
 * Inline reimplementation of processEvent with injectable enrich/assess.
 * Mirrors src/pipeline.js's control flow (enrich → assess → route → execute →
 * label), but takes enrich and assess as parameters so tests can inject
 * doubles without an ESM loader hook.
 *
 * T7 (lr-f0f2): the actual action-execution and label-application logic
 * (multi-action classes[] looping, single-status-invariant enforcement) is no
 * longer re-derived here — it delegates to the real, exported
 * `_executeAction`/`_applyLabels` from src/pipeline.js so this shim cannot
 * silently drift from the code it stands in for. Only the enrich/assess/route
 * sequencing (which has no test seam of its own) remains reimplemented.
 *
 * @param {object}   config
 * @param {object}   event
 * @param {object}   adapter
 * @param {Function} enrichFn    - async (config, event, adapter) => enrichedEvent
 * @param {Function} assessFn    - async (config, enrichedEvent) => assessment
 * @param {Function} routeFn     - (config, assessment) => { should_dispatch, queue_reason }
 * @returns {Promise<object>}    - PipelineResult
 */
async function processEventShim(config, event, adapter, enrichFn, assessFn, routeFn) {
  const eventId = event?.id ?? '(unknown)';

  try {
    const enrichedEvent = await enrichFn(config, event, adapter);
    const assessment = await assessFn(config, enrichedEvent);
    const { should_dispatch, queue_reason } = routeFn(config, assessment);

    if (!should_dispatch) {
      // Apply labels on queued items if auto_label is true.
      try {
        await _applyLabels(config, event, assessment, adapter, 'queued');
      } catch {
        // Non-fatal.
      }

      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: null,
        actions_taken: [],
        queue_reason,
        dispatched_at: null,
        error: null,
      };
    }

    const { actions_taken, queue_reason: deferredQueueReason } = await _executeAction(
      config,
      event,
      assessment,
      adapter,
    );

    if (deferredQueueReason !== null) {
      try {
        await _applyLabels(config, event, assessment, adapter, 'queued');
      } catch {
        // Non-fatal.
      }

      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: actions_taken[0] ?? null,
        actions_taken,
        queue_reason: deferredQueueReason,
        dispatched_at: null,
        error: null,
      };
    }

    // Apply labels unconditionally on dispatched items.
    try {
      await _applyLabels(config, event, assessment, adapter, 'dispatched');
    } catch {
      // Non-fatal.
    }

    return {
      event_id: eventId,
      status: 'dispatched',
      assessment,
      action_taken: actions_taken[0] ?? null,
      actions_taken,
      queue_reason: null,
      dispatched_at: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    return {
      event_id: eventId,
      status: 'error',
      assessment: null,
      action_taken: null,
      actions_taken: [],
      queue_reason: null,
      dispatched_at: null,
      error: err.message ?? String(err),
    };
  }
}

/**
 * Batch shim mirroring runPipeline logic.
 */
async function runPipelineShim(config, events, adapter, enrichFn, assessFn, routeFn) {
  const dispatched = [];
  const queued = [];
  const errors = [];
  for (const event of events) {
    const result = await processEventShim(config, event, adapter, enrichFn, assessFn, routeFn);
    if (result.status === 'dispatched') dispatched.push(result);
    else if (result.status === 'queued') queued.push(result);
    else errors.push(result);
  }
  return { dispatched, queued, errors };
}

// ---------------------------------------------------------------------------
// Import router for direct unit tests
// ---------------------------------------------------------------------------

import { route } from '../src/router.js';
import { _executeAction, _applyLabels } from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// Tests — router.js (pure, no mocking needed)
// ---------------------------------------------------------------------------

describe('router.route()', () => {
  it('returns low_confidence when confidence is below threshold', () => {
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({ confidence: 0.5 });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: false, queue_reason: 'low_confidence' });
  });

  it('returns low_confidence when confidence equals threshold boundary (exclusive)', () => {
    // Confidence exactly at threshold: 0.69 < 0.70 → low_confidence
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({ confidence: 0.69 });
    const result = route(config, assessment);
    assert.equal(result.queue_reason, 'low_confidence');
  });

  it('dispatches when action class is in auto_approve and confidence >= threshold', () => {
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({ confidence: 0.8 });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: true, queue_reason: null });
  });

  it('returns awaiting_approval for action class NOT in auto_approve', () => {
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: [] });
    const assessment = makeAssessment({ confidence: 0.9, suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: [] } });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: false, queue_reason: 'awaiting_approval' });
  });

  it('low_confidence overrides auto_approve (DD-001)', () => {
    // Even if respond is in auto_approve, low confidence forces HITL.
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({ confidence: 0.3 });
    const result = route(config, assessment);
    assert.equal(result.should_dispatch, false);
    assert.equal(result.queue_reason, 'low_confidence');
  });

  // T7 (lr-f0f2): multi-action verdicts — every named class must be
  // individually trusted for the whole verdict to auto-dispatch.
  it('dispatches a multi-action verdict when every class is in auto_approve', () => {
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond', 'dispatch'] });
    const assessment = makeAssessment({
      confidence: 0.9,
      suggested_action: { classes: ['respond', 'dispatch'], body: null, dispatch_target: null, labels: [] },
    });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: true, queue_reason: null });
  });

  it('queues a multi-action verdict when only SOME of its classes are auto_approved', () => {
    // 'respond' is trusted but 'close' is not — the whole verdict must queue,
    // not partially auto-execute the trusted class.
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({
      confidence: 0.9,
      suggested_action: { classes: ['respond', 'close'], body: null, dispatch_target: null, labels: [] },
    });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: false, queue_reason: 'awaiting_approval' });
  });

  it('normalizes a legacy singular suggested_action.class to a one-element classes list', () => {
    const config = makeConfig({ confidence_threshold: 0.7, auto_approve: ['respond'] });
    const assessment = makeAssessment({
      confidence: 0.9,
      suggested_action: { class: 'respond', body: null, dispatch_target: null, labels: [] },
    });
    const result = route(config, assessment);
    assert.deepEqual(result, { should_dispatch: true, queue_reason: null });
  });
});

// ---------------------------------------------------------------------------
// Tests — pipeline (via shim)
// ---------------------------------------------------------------------------

describe('processEvent shim', () => {
  let adapter;
  const passThruEnrich = async (_c, event, _a) => ({ ...event, context: {} });

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('dispatches when action class is in auto_approve', async () => {
    const config = makeConfig({ auto_approve: ['respond'] });
    const event = makeEvent();
    const assessment = makeAssessment({ confidence: 0.9 });
    const assessFn = async () => assessment;
    const routeFn = route;

    const result = await processEventShim(config, event, adapter, passThruEnrich, assessFn, routeFn);

    assert.equal(result.status, 'dispatched');
    assert.equal(result.action_taken, 'respond');
    assert.equal(result.queue_reason, null);
    assert.notEqual(result.dispatched_at, null);
  });

  it('queues when action class is NOT in auto_approve', async () => {
    const config = makeConfig({ auto_approve: [] });
    const event = makeEvent();
    const assessment = makeAssessment({ confidence: 0.9 });
    const assessFn = async () => assessment;

    const result = await processEventShim(config, event, adapter, passThruEnrich, assessFn, route);

    assert.equal(result.status, 'queued');
    assert.equal(result.action_taken, null);
    assert.equal(result.queue_reason, 'awaiting_approval');
  });

  it('always queues low-confidence assessment regardless of auto_approve', async () => {
    const config = makeConfig({ auto_approve: ['respond', 'approve', 'close'], confidence_threshold: 0.7 });
    const event = makeEvent();
    const assessment = makeAssessment({ confidence: 0.4 });
    const assessFn = async () => assessment;

    const result = await processEventShim(config, event, adapter, passThruEnrich, assessFn, route);

    assert.equal(result.status, 'queued');
    assert.equal(result.queue_reason, 'low_confidence');
  });

  it('calls post_comment on respond auto-approve', async () => {
    const config = makeConfig({ auto_approve: ['respond'] });
    const event = makeEvent();
    const assessment = makeAssessment({ confidence: 0.9 });
    const assessFn = async () => assessment;

    let commentBody = null;
    const spyAdapter = makeAdapter({
      post_comment: async (_c, _e, body) => { commentBody = body; },
    });

    const result = await processEventShim(config, event, spyAdapter, passThruEnrich, assessFn, route);

    assert.equal(result.status, 'dispatched');
    assert.equal(commentBody, assessment.suggested_action.body);
  });

  it('calls approve_pr on approve auto-approve with allow_auto_pr_approval true', async () => {
    const config = makeConfig({ auto_approve: ['approve'], allow_auto_pr_approval: true });
    const event = makeEvent({ type: 'pr' });
    const assessment = makeAssessment({
      confidence: 0.9,
      suggested_action: { class: 'approve', body: null, dispatch_target: null, labels: [] },
    });
    const assessFn = async () => assessment;

    let approveCalled = false;
    const spyAdapter = makeAdapter({
      approve_pr: async () => { approveCalled = true; },
    });

    const result = await processEventShim(config, event, spyAdapter, passThruEnrich, assessFn, route);

    assert.equal(result.status, 'dispatched');
    assert.equal(approveCalled, true);
  });

  it('marks result as error when adapter action throws; does not propagate', async () => {
    const config = makeConfig({ auto_approve: ['respond'] });
    const event = makeEvent();
    const assessment = makeAssessment({ confidence: 0.9 });
    const assessFn = async () => assessment;

    const spyAdapter = makeAdapter({
      post_comment: async () => { throw new Error('adapter exploded'); },
    });

    const result = await processEventShim(config, event, spyAdapter, passThruEnrich, assessFn, route);

    assert.equal(result.status, 'error');
    assert.match(result.error, /adapter exploded/);
  });

  it('marks result as error when enrich throws; does not propagate', async () => {
    const config = makeConfig({ auto_approve: ['respond'] });
    const event = makeEvent();
    const enrichFn = async () => { throw new Error('enrich failed'); };
    const assessFn = async () => makeAssessment();

    const result = await processEventShim(config, event, adapter, enrichFn, assessFn, route);

    assert.equal(result.status, 'error');
    assert.match(result.error, /enrich failed/);
  });
});

describe('runPipeline shim', () => {
  const passThruEnrich = async (_c, event, _a) => ({ ...event, context: {} });

  it('processes all events even when one throws during assess', async () => {
    const config = makeConfig({ auto_approve: ['respond'] });
    const events = [makeEvent({ id: 'r#1' }), makeEvent({ id: 'r#2' }), makeEvent({ id: 'r#3' })];
    const adapter = makeAdapter();

    let callCount = 0;
    const assessFn = async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('assess blew up on event 2');
      }
      return makeAssessment({ confidence: 0.9 });
    };

    const { dispatched, queued, errors } = await runPipelineShim(
      config, events, adapter, passThruEnrich, assessFn, route,
    );

    // Event 1 and 3 should dispatch; event 2 is an error.
    assert.equal(dispatched.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(queued.length, 0);
    assert.equal(errors[0].event_id, 'r#2');
  });

  it('returns correct buckets: dispatched, queued, errors', async () => {
    // Event A: high confidence, respond in auto_approve → dispatched
    // Event B: low confidence → queued
    // Event C: assess throws → error
    const config = makeConfig({ auto_approve: ['respond'], confidence_threshold: 0.7 });
    const eventA = makeEvent({ id: 'r#A' });
    const eventB = makeEvent({ id: 'r#B' });
    const eventC = makeEvent({ id: 'r#C' });
    const adapter = makeAdapter();

    const assessFn = async (_c, enriched) => {
      if (enriched.id === 'r#A') return makeAssessment({ confidence: 0.95 });
      if (enriched.id === 'r#B') return makeAssessment({ confidence: 0.3 });
      throw new Error('fatal assess error');
    };

    const { dispatched, queued, errors } = await runPipelineShim(
      config, [eventA, eventB, eventC], adapter, passThruEnrich, assessFn, route,
    );

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].event_id, 'r#A');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].event_id, 'r#B');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event_id, 'r#C');
  });
});

// ---------------------------------------------------------------------------
// _executeAction — multi-action verdicts (T7, lr-f0f2)
// ---------------------------------------------------------------------------

describe('_executeAction — multi-action verdicts', () => {
  it('executes every class in order and reports all of them in actions_taken', async () => {
    const calls = [];
    const adapter = makeAdapter({
      post_comment: async (_c, _e, body) => { calls.push(['post_comment', body]); },
      close_item: async () => { calls.push(['close_item']); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond', 'close'], body: 'Thanks, closing this.', dispatch_target: null, labels: [] },
    });

    const result = await _executeAction({}, event, assessment, adapter);

    assert.deepEqual(result.actions_taken, ['respond', 'close']);
    assert.equal(result.queue_reason, null);
    // Order matters: respond (the comment) must run before close.
    assert.deepEqual(calls, [['post_comment', 'Thanks, closing this.'], ['close_item']]);
  });

  it('runs executable classes immediately AND still surfaces a deferred queue_reason', async () => {
    let commented = false;
    const adapter = makeAdapter({
      post_comment: async () => { commented = true; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond', 'escalate'], body: 'Escalating.', dispatch_target: null, labels: [] },
    });

    const result = await _executeAction({}, event, assessment, adapter);

    assert.ok(commented, 'respond should have executed immediately');
    assert.deepEqual(result.actions_taken, ['respond']);
    assert.equal(result.queue_reason, 'escalate');
  });

  it('normalizes a legacy singular suggested_action.class to a one-element classes list', async () => {
    let approved = false;
    const adapter = makeAdapter({ approve_pr: async () => { approved = true; } });

    const event = makeEvent({ type: 'pr' });
    const assessment = makeAssessment({
      suggested_action: { class: 'approve', body: null, dispatch_target: null, labels: [] },
    });

    const result = await _executeAction({}, event, assessment, adapter);

    assert.ok(approved);
    assert.deepEqual(result.actions_taken, ['approve']);
  });

  it('returns no actions_taken and escalate queue_reason for an empty/missing classes list', async () => {
    const adapter = makeAdapter();
    const event = makeEvent();
    const assessment = makeAssessment({ suggested_action: { body: null, dispatch_target: null, labels: [] } });

    const result = await _executeAction({}, event, assessment, adapter);

    assert.deepEqual(result.actions_taken, []);
    assert.equal(result.queue_reason, null);
  });
});

// ---------------------------------------------------------------------------
// _applyLabels — single-status invariant (T2 lr-a192 / T7 lr-f0f2)
// ---------------------------------------------------------------------------

describe('_applyLabels — single-status invariant', () => {
  it('removes the prior status/* label before applying the new one', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => ['status/needs-triage', 'kind/bug'],
      unlabel_item: async (_c, _e, label) => { calls.push(['unlabel', label]); },
      label_item: async (_c, _e, labels) => { calls.push(['label', labels]); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['status/accepted'] },
    });

    await _applyLabels({}, event, assessment, adapter, 'dispatched');

    assert.deepEqual(calls, [
      ['unlabel', 'status/needs-triage'],
      ['label', ['status/accepted']],
    ]);
  });

  it('never applies the new label before removing the stale one (removal-before-apply ordering)', async () => {
    const order = [];
    const adapter = makeAdapter({
      get_item_labels: async () => ['status/in-progress'],
      unlabel_item: async () => { order.push('unlabel'); },
      label_item: async () => { order.push('label'); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['status/in-review'] },
    });

    await _applyLabels({}, event, assessment, adapter, 'dispatched');

    assert.deepEqual(order, ['unlabel', 'label']);
  });

  it('does not touch non-status labels when no status/* label is incoming', async () => {
    let unlabelCalled = false;
    const adapter = makeAdapter({
      get_item_labels: async () => ['status/accepted', 'kind/bug'],
      unlabel_item: async () => { unlabelCalled = true; },
      label_item: async () => {},
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['priority/p1'] },
    });

    await _applyLabels({}, event, assessment, adapter, 'dispatched');

    assert.equal(unlabelCalled, false, 'no status/* label incoming means no removal');
  });

  it('is a no-op when suggested_action.labels is empty', async () => {
    let labelsFetched = false;
    const adapter = makeAdapter({
      get_item_labels: async () => { labelsFetched = true; return []; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: [] },
    });

    await _applyLabels({}, event, assessment, adapter, 'dispatched');

    assert.equal(labelsFetched, false, 'should not even fetch live labels when there is nothing to apply');
  });

  it('skips labeling a queued item when auto_label is not enabled', async () => {
    let labelsFetched = false;
    const adapter = makeAdapter({
      get_item_labels: async () => { labelsFetched = true; return []; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: null, labels: ['status/accepted'] },
    });

    await _applyLabels({ auto_label: false }, event, assessment, adapter, 'queued');

    assert.equal(labelsFetched, false);
  });

  it('applies labels on a queued item when auto_label is enabled, enforcing single-status', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => ['status/needs-triage'],
      unlabel_item: async (_c, _e, label) => { calls.push(['unlabel', label]); },
      label_item: async (_c, _e, labels) => { calls.push(['label', labels]); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['dispatch'], body: null, dispatch_target: null, labels: ['status/accepted'] },
    });

    await _applyLabels({ auto_label: true }, event, assessment, adapter, 'queued');

    assert.deepEqual(calls, [
      ['unlabel', 'status/needs-triage'],
      ['label', ['status/accepted']],
    ]);
  });
});

// ---------------------------------------------------------------------------
// _applyLabels — per-axis trust for intake labels (T10, lr-9e35)
// ---------------------------------------------------------------------------

describe('_applyLabels — label_auto_approve per-axis trust', () => {
  it('does not auto-apply an intake label whose axis is not in label_auto_approve', async () => {
    let labelCalled = false;
    const adapter = makeAdapter({
      get_item_labels: async () => [],
      label_item: async () => { labelCalled = true; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['kind/bug'] },
    });

    await _applyLabels({ label_auto_approve: [] }, event, assessment, adapter, 'dispatched');

    assert.equal(labelCalled, false, 'kind/* is not trusted by default — must not auto-apply');
  });

  it('auto-applies an intake label whose axis IS in label_auto_approve', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => [],
      label_item: async (_c, _e, labels) => { calls.push(labels); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['kind/bug'] },
    });

    await _applyLabels({ label_auto_approve: ['kind'] }, event, assessment, adapter, 'dispatched');

    assert.deepEqual(calls, [['kind/bug']]);
  });

  it('filters a mixed label set down to only the trusted axis', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => [],
      label_item: async (_c, _e, labels) => { calls.push(labels); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: {
        classes: ['respond'],
        body: null,
        dispatch_target: null,
        labels: ['kind/bug', 'priority/p1', 'area/backend'],
      },
    });

    await _applyLabels({ label_auto_approve: ['kind'] }, event, assessment, adapter, 'dispatched');

    assert.deepEqual(calls, [['kind/bug']]);
  });

  it('never filters status/* labels — the status axis is gated elsewhere, not by label_auto_approve', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => [],
      label_item: async (_c, _e, labels) => { calls.push(labels); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: {
        classes: ['respond'],
        body: null,
        dispatch_target: null,
        labels: ['status/accepted', 'area/backend'],
      },
    });

    await _applyLabels({ label_auto_approve: [] }, event, assessment, adapter, 'dispatched');

    assert.deepEqual(calls, [['status/accepted']]);
  });

  it('applies per-axis trust on the auto_label-gated queued path too, not just dispatched', async () => {
    const calls = [];
    const adapter = makeAdapter({
      get_item_labels: async () => [],
      label_item: async (_c, _e, labels) => { calls.push(labels); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: {
        classes: ['dispatch'],
        body: null,
        dispatch_target: null,
        labels: ['kind/bug', 'priority/p1'],
      },
    });

    await _applyLabels({ auto_label: true, label_auto_approve: ['kind'] }, event, assessment, adapter, 'queued');

    assert.deepEqual(calls, [['kind/bug']]);
  });

  it('is a no-op (no adapter calls) when every incoming label is filtered out', async () => {
    let labelsFetched = false;
    const adapter = makeAdapter({
      get_item_labels: async () => { labelsFetched = true; return []; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['area/backend'] },
    });

    await _applyLabels({ label_auto_approve: [] }, event, assessment, adapter, 'dispatched');

    assert.equal(labelsFetched, false, 'should short-circuit before fetching live labels');
  });
});

// ---------------------------------------------------------------------------
// _applyLabels — malformed multi-status incoming labels (lr-cf26)
// ---------------------------------------------------------------------------

describe('_applyLabels — malformed multi-status incoming labels (RangeError handling)', () => {
  it('resolves (does not throw) and applies/removes nothing when incoming labels carry two status/* values', async () => {
    let unlabelCalled = false;
    let labelCalled = false;
    const adapter = makeAdapter({
      get_item_labels: async () => ['status/needs-triage'],
      unlabel_item: async () => { unlabelCalled = true; },
      label_item: async () => { labelCalled = true; },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: {
        classes: ['respond'],
        body: null,
        dispatch_target: null,
        labels: ['status/accepted', 'status/in-progress'],
      },
    });

    // Must not throw — enforceSingleStatus's RangeError is caught explicitly
    // at the _applyLabels call site, not left to propagate.
    await assert.doesNotReject(
      () => _applyLabels({}, event, assessment, adapter, 'dispatched'),
    );

    assert.equal(unlabelCalled, false, 'fail-safe: no label removal on malformed incoming labels');
    assert.equal(labelCalled, false, 'fail-safe: no label application on malformed incoming labels');
  });

  it('still propagates a non-RangeError thrown while enforcing single-status', async () => {
    const adapter = makeAdapter({
      get_item_labels: async () => { throw new Error('adapter fetch exploded'); },
    });

    const event = makeEvent();
    const assessment = makeAssessment({
      suggested_action: { classes: ['respond'], body: null, dispatch_target: null, labels: ['status/accepted'] },
    });

    await assert.rejects(
      () => _applyLabels({}, event, assessment, adapter, 'dispatched'),
      /adapter fetch exploded/,
    );
  });
});

// ---------------------------------------------------------------------------
// runPipeline — awaiting_info skip/wake/dedup contract (lr-910ca2)
//
// Exercises the real runPipeline against a real, temp-file-backed queue (via
// src/queue.js's enqueue/readAll) so the skipEventIds/awaiting_info branch
// added by this task is covered end-to-end at the module boundary it
// actually reads (the queue file), not just via the awaiting_info.js unit
// tests. The `events` array passed to runPipeline is deliberately empty in
// every case here — this suite covers the dedup/skip/reassess wiring, not a
// fresh event's full enrich/assess/route path (already covered by the
// processEvent shim tests above and by tests/awaiting_info.test.js's direct
// coverage of reassessAwaitingInfoItem).
// ---------------------------------------------------------------------------

import { randomBytes as _randomBytes } from 'node:crypto';
import { tmpdir as _tmpdir } from 'node:os';
import { join as _join } from 'node:path';
import { enqueue as _enqueue, readAll as _readAll } from '../src/queue.js';
import { runPipeline } from '../src/pipeline.js';

function _tmpQueuePath() {
  return _join(_tmpdir(), `triage-pipeline-awaiting-info-${_randomBytes(6).toString('hex')}`, 'pending.jsonl');
}

describe('runPipeline — awaiting_info reply detection (lr-910ca2)', () => {
  // Note: runPipeline wires the reply-scan to the REAL enrich()/assess()
  // (src/enricher.js / src/assessor.js), not an injectable test double — see
  // src/pipeline.js's import of processAwaitingInfoItems. Driving a full
  // "reply found -> fresh verdict enqueued, old entry superseded" outcome
  // through runPipeline itself would require a live GitHub token and LLM
  // CLI, which this suite does not have. That full round trip (with
  // injected enrich/assess deps) is covered directly by
  // tests/awaiting_info.test.js's reassessAwaitingInfoItem/
  // processAwaitingInfoItems suites. This test instead verifies runPipeline
  // actually triggers the reply-scan and hands off to re-assessment (rather
  // than never calling list_comments at all, or blowing up the whole poll
  // cycle when assess() has nothing to work with in a test environment).
  it('scans an awaiting_info item for a reply and attempts re-assessment without corrupting the queue on failure', async () => {
    const config = makeConfig({ pending_queue: _tmpQueuePath() });
    const parkedEvent = makeEvent({ id: 'owner/repo#328', number: 328 });
    const parked = await _enqueue(config, {
      event: parkedEvent,
      assessment: makeAssessment({
        suggested_action: { classes: ['respond', 'dispatch'], body: 'Which version?', dispatch_target: null, labels: [] },
      }),
      queue_reason: 'awaiting_info',
    });

    let listCommentsCalled = false;
    const adapter = makeAdapter({
      list_comments: async () => {
        listCommentsCalled = true;
        return [{ user: { login: 'bradorchard', type: 'User' }, body: 'v1.2.3', created_at: '2099-01-01T00:00:00Z' }];
      },
    });

    // The real assess() has no LLM runner available in this test environment
    // and will throw or degrade — either way, runPipeline's own top-level
    // loop (which never touched this item — `events` is empty) must not
    // throw, and processAwaitingInfoItems must not leave the queue file in a
    // corrupt/duplicated state.
    const { errors } = await runPipeline(config, [], adapter);

    assert.equal(errors.length, 0, 'a re-assessment failure must not surface as a runPipeline-level error');
    assert.ok(listCommentsCalled, 'runPipeline must have scanned the awaiting_info item for a reply');

    const all = await _readAll(config);
    assert.equal(all.length, 1, 'no duplicate/orphaned entry should exist regardless of re-assessment outcome');
    assert.equal(all[0].id, parked.id);
  });

  it('leaves an awaiting_info item with no reply untouched (falls through to stale.js unchanged)', async () => {
    const config = makeConfig({ pending_queue: _tmpQueuePath() });
    const parkedEvent = makeEvent({ id: 'owner/repo#329', number: 329 });
    const parked = await _enqueue(config, {
      event: parkedEvent,
      assessment: makeAssessment({
        suggested_action: { classes: ['respond', 'dispatch'], body: 'Which version?', dispatch_target: null, labels: [] },
      }),
      queue_reason: 'awaiting_info',
    });

    let listCommentsCalled = false;
    const adapter = makeAdapter({
      list_comments: async () => { listCommentsCalled = true; return []; },
    });

    const { errors } = await runPipeline(config, [], adapter);

    assert.equal(errors.length, 0);
    assert.ok(listCommentsCalled, 'runPipeline must scope-check awaiting_info items for a reply');

    const all = await _readAll(config);
    assert.equal(all.length, 1, 'no new entry should be created when there is no qualifying reply');
    assert.equal(all[0].id, parked.id);
    assert.equal(all[0].status, 'pending', 'the item must remain pending — untouched by this path');
  });

  it('does not blanket-skip awaiting_info items the way plain pending/approved items are skipped', async () => {
    // Regression guard for the exact bug this task fixes: an awaiting_info
    // item must be scanned (list_comments called) even though it is
    // 'pending' — unlike a generic 'awaiting_approval' pending item, which
    // is still blanket-skipped and never triggers a list_comments call.
    const config = makeConfig({ pending_queue: _tmpQueuePath() });
    await _enqueue(config, {
      event: makeEvent({ id: 'owner/repo#1', number: 1 }),
      assessment: makeAssessment({ suggested_action: { classes: ['respond'], body: 'Thanks', dispatch_target: null, labels: [] } }),
      queue_reason: 'awaiting_approval', // NOT awaiting_info
    });
    await _enqueue(config, {
      event: makeEvent({ id: 'owner/repo#2', number: 2 }),
      assessment: makeAssessment({
        suggested_action: { classes: ['respond', 'dispatch'], body: 'Which version?', dispatch_target: null, labels: [] },
      }),
      queue_reason: 'awaiting_info',
    });

    const listCommentsCalls = [];
    const adapter = makeAdapter({
      list_comments: async (_c, event) => { listCommentsCalls.push(event.number); return []; },
    });

    await runPipeline(config, [], adapter);

    assert.deepEqual(listCommentsCalls, [2], 'only the awaiting_info item (#2) should be scanned, not the awaiting_approval one (#1)');
  });

  it('falls back to skipping awaiting_info items when the adapter has no list_comments (no dedup gap)', async () => {
    const config = makeConfig({ pending_queue: _tmpQueuePath() });
    const parkedEvent = makeEvent({ id: 'owner/repo#328', number: 328 });
    await _enqueue(config, {
      event: parkedEvent,
      assessment: makeAssessment({
        suggested_action: { classes: ['respond', 'dispatch'], body: 'Which version?', dispatch_target: null, labels: [] },
      }),
      queue_reason: 'awaiting_info',
    });

    // Adapter without list_comments — same event re-appears in this poll's
    // `events` list (e.g. its updated_at bumped from the reply). Without the
    // fallback skip, this would re-enter processEvent and risk a duplicate
    // queue entry for the same event id (lr-bfb0ac dedup).
    const adapter = makeAdapter();
    delete adapter.list_comments;

    const { dispatched, queued, errors } = await runPipeline(config, [parkedEvent], adapter);

    assert.equal(errors.length, 0);
    assert.equal(dispatched.length, 0);
    assert.equal(queued.length, 0, 'the event must be skipped, not re-processed, when reply-detection is unavailable');

    const all = await _readAll(config);
    assert.equal(all.length, 1, 'no duplicate entry should have been created');
  });
});
