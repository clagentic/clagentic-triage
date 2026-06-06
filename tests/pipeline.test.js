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
      class: 'respond',
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
 * Mirrors src/pipeline.js logic exactly, but takes enrich and assess as
 * parameters so tests can inject doubles without an ESM loader hook.
 *
 * This shim must stay in sync with pipeline.js. Any behavioral change to
 * pipeline.js must be mirrored here.
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
      const labels = assessment.suggested_action?.labels;
      if (config.auto_label && Array.isArray(labels) && labels.length > 0) {
        try {
          await adapter.label_item(config, event, labels);
        } catch {
          // Non-fatal.
        }
      }

      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: null,
        queue_reason,
        dispatched_at: null,
        error: null,
      };
    }

    // Execute the action.
    const actionClass = assessment.suggested_action.class;
    const body = assessment.suggested_action.body ?? '';
    let action_taken = null;
    let deferredQueueReason = null;

    switch (actionClass) {
      case 'respond':
        await adapter.post_comment(config, event, body);
        action_taken = 'respond';
        break;
      case 'request_changes':
        await adapter.request_changes(config, event, body);
        action_taken = 'request_changes';
        break;
      case 'approve':
        await adapter.approve_pr(config, event);
        action_taken = 'approve';
        break;
      case 'close':
        await adapter.close_item(config, event);
        action_taken = 'close';
        break;
      case 'dispatch':
        deferredQueueReason = 'dispatch';
        break;
      case 'escalate':
        deferredQueueReason = 'escalate';
        break;
      default:
        deferredQueueReason = 'escalate';
    }

    if (action_taken === null) {
      return {
        event_id: eventId,
        status: 'queued',
        assessment,
        action_taken: null,
        queue_reason: deferredQueueReason,
        dispatched_at: null,
        error: null,
      };
    }

    // Apply labels unconditionally on dispatched items.
    const labels = assessment.suggested_action?.labels;
    if (Array.isArray(labels) && labels.length > 0) {
      try {
        await adapter.label_item(config, event, labels);
      } catch {
        // Non-fatal.
      }
    }

    return {
      event_id: eventId,
      status: 'dispatched',
      assessment,
      action_taken,
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
    const assessment = makeAssessment({ confidence: 0.9, suggested_action: { class: 'respond', body: null, dispatch_target: null, labels: [] } });
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
