/**
 * Tests for src/dispatchers/webhook.js
 *
 * Uses Node's built-in test runner. No external dependencies. fetch is mocked
 * globally — no real network calls are made.
 *
 * Coverage:
 *   - POST sent to correct URL with correct payload shape
 *   - HMAC signature header present when secret set, absent when not
 *   - AbortController timeout fires after timeout_ms
 *   - Non-2xx response throws with status code
 *   - update_task is a no-op (returns undefined, makes no calls)
 *   - Payload does NOT contain event.body or context fields
 *   - Config-driven field mapping ("payload"): literals, single-placeholder
 *     native-type passthrough, multi-placeholder string interpolation,
 *     opt-in event.body forwarding, unresolved-path handling
 *   - Bearer-token auth mode ("auth: { type: 'bearer', token_env }")
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import * as webhook from '../src/dispatchers/webhook.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return {
    id: 'owner/repo#42',
    repo: 'owner/repo',
    type: 'issue',
    author: 'testuser',
    url: 'https://github.com/owner/repo/issues/42',
    // Fields that must NOT appear in the outbound payload:
    body: 'raw issue body — must not be forwarded',
    context: [{ role: 'system', content: 'private context — must not be forwarded' }],
    ...overrides,
  };
}

function makeAssessment(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.95,
    reasoning: 'Looks like a valid bug report.',
    suggested_action: { classes: ['dispatch'], body: 'opening a ticket' },
    ...overrides,
  };
}

function makeConfig(dispatcherOverrides = {}) {
  return {
    dispatchers: [
      {
        name: 'webhook',
        url: 'https://hooks.example.com/triage',
        ...dispatcherOverrides,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

/**
 * Install a global fetch mock that records calls and returns the given response.
 *
 * @param {object} opts
 * @param {number}  [opts.status=200]  - HTTP status code to return
 * @param {boolean} [opts.ok]          - defaults to status < 300
 * @param {number}  [opts.delayMs=0]   - artificial delay before resolving
 * @returns {{ calls: Array, restore: Function }}
 */
function mockFetch({ status = 200, ok, delayMs = 0 } = {}) {
  const calls = [];
  const resolvedOk = ok !== undefined ? ok : status >= 200 && status < 300;

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    // Respect AbortSignal — if aborted before resolution, throw DOMException.
    if (init?.signal?.aborted) {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    }
    return { status, ok: resolvedOk };
  };

  return {
    calls,
    restore() {
      delete globalThis.fetch;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('webhook dispatcher', () => {
  let fetchMock;

  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  // -------------------------------------------------------------------------
  // Payload shape and POST target
  // -------------------------------------------------------------------------

  describe('POST target and payload shape', () => {
    it('POSTs to the configured URL', async () => {
      fetchMock = mockFetch();
      await webhook.create_task(makeConfig(), makeEvent(), makeAssessment());

      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, 'https://hooks.example.com/triage');
      assert.equal(fetchMock.calls[0].init.method, 'POST');
    });

    it('sends Content-Type: application/json', async () => {
      fetchMock = mockFetch();
      await webhook.create_task(makeConfig(), makeEvent(), makeAssessment());

      const headers = fetchMock.calls[0].init.headers;
      assert.equal(headers['Content-Type'], 'application/json');
    });

    it('payload contains all required fields with correct values', async () => {
      fetchMock = mockFetch();
      const event = makeEvent();
      const assessment = makeAssessment();

      await webhook.create_task(makeConfig(), event, assessment);

      const body = JSON.parse(fetchMock.calls[0].init.body);

      assert.equal(body.event_id, event.id);
      assert.equal(body.repo, event.repo);
      assert.equal(body.type, event.type);
      assert.equal(body.author, event.author);
      assert.equal(body.url, event.url);
      assert.equal(body.verdict, assessment.verdict);
      assert.equal(body.confidence, assessment.confidence);
      assert.equal(body.reasoning, assessment.reasoning);
      assert.deepEqual(body.suggested_action, {
        classes: assessment.suggested_action.classes,
        body: assessment.suggested_action.body,
      });
      assert.ok(body.dispatched_at, 'dispatched_at should be present');
      // dispatched_at must parse as a valid ISO timestamp
      assert.ok(!isNaN(Date.parse(body.dispatched_at)), 'dispatched_at must be a valid ISO timestamp');
    });

    it('payload does NOT contain event.body or context fields', async () => {
      fetchMock = mockFetch();
      const event = makeEvent({
        body: 'raw body — forbidden',
        context: [{ role: 'system', content: 'forbidden' }],
      });

      await webhook.create_task(makeConfig(), event, makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);

      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'body'),
        'payload must not include event.body');
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'context'),
        'payload must not include context blocks');
      // No deeply-nested untrusted content either
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'raw_body'),
        'payload must not include raw_body');
    });
  });

  // -------------------------------------------------------------------------
  // Return value
  // -------------------------------------------------------------------------

  describe('return value', () => {
    it('returns { id: event.id, url: dispatcherConfig.url }', async () => {
      fetchMock = mockFetch();
      const event = makeEvent();
      const config = makeConfig();

      const result = await webhook.create_task(config, event, makeAssessment());

      assert.deepEqual(result, {
        id: event.id,
        url: 'https://hooks.example.com/triage',
      });
    });
  });

  // -------------------------------------------------------------------------
  // HMAC signature
  // -------------------------------------------------------------------------

  describe('HMAC signature', () => {
    it('adds X-Clagentic-Signature header when secret is set', async () => {
      fetchMock = mockFetch();
      const secret = 'my-webhook-secret';
      const config = makeConfig({ secret });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const headers = fetchMock.calls[0].init.headers;
      assert.ok(
        Object.prototype.hasOwnProperty.call(headers, 'X-Clagentic-Signature'),
        'X-Clagentic-Signature header should be present',
      );
      assert.match(headers['X-Clagentic-Signature'], /^sha256=[a-f0-9]{64}$/);
    });

    it('signature is the correct HMAC-SHA256 of the request body', async () => {
      fetchMock = mockFetch();
      const secret = 'my-webhook-secret';
      const config = makeConfig({ secret });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const { init } = fetchMock.calls[0];
      const bodyStr = init.body;
      const expectedHmac = createHmac('sha256', secret).update(bodyStr).digest('hex');
      const expectedSig = `sha256=${expectedHmac}`;

      assert.equal(init.headers['X-Clagentic-Signature'], expectedSig);
    });

    it('does NOT add X-Clagentic-Signature header when secret is not set', async () => {
      fetchMock = mockFetch();
      // makeConfig with no secret field
      const config = makeConfig();

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const headers = fetchMock.calls[0].init.headers;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(headers, 'X-Clagentic-Signature'),
        'X-Clagentic-Signature header must not be present when secret is unset',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('AbortController fires after timeout_ms and rejects', async () => {
      // fetch resolves only after delayMs; timeout_ms is shorter, so AbortController
      // fires first and fetch throws an AbortError.
      //
      // We simulate this by setting a very short timeout_ms and making fetch check
      // the signal's aborted state after an artificial delay. The real AbortController
      // fires the abort event asynchronously; our mock checks signal.aborted synchronously
      // after the delay, so we need a delay longer than timeout_ms.
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        // Assert the signal is a real AbortSignal (not just any truthy value).
        assert.ok(init?.signal instanceof AbortSignal, 'fetch must receive an AbortSignal');
        // Wait long enough for the AbortController to fire.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return { status: 200, ok: true };
      };
      fetchMock = { calls, restore() { delete globalThis.fetch; } };

      const config = makeConfig({ timeout_ms: 10 });

      await assert.rejects(
        () => webhook.create_task(config, makeEvent(), makeAssessment()),
        (err) => {
          // Node's AbortController throws a DOMException with name 'AbortError',
          // or a generic Error wrapping the abort. Accept either.
          assert.ok(
            err.name === 'AbortError' || /abort/i.test(err.message),
            `expected AbortError, got: ${err.name}: ${err.message}`,
          );
          return true;
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Non-2xx response
  // -------------------------------------------------------------------------

  describe('non-2xx response', () => {
    for (const status of [400, 403, 404, 500, 503]) {
      it(`throws on HTTP ${status}`, async () => {
        fetchMock = mockFetch({ status });

        await assert.rejects(
          () => webhook.create_task(makeConfig(), makeEvent(), makeAssessment()),
          (err) => {
            assert.match(err.message, new RegExp(String(status)));
            return true;
          },
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // update_task
  // -------------------------------------------------------------------------

  describe('update_task', () => {
    it('is a no-op: returns undefined without calling fetch', async () => {
      fetchMock = mockFetch();
      const result = await webhook.update_task(makeConfig(), 'some-id', { status: 'done' });

      assert.equal(result, undefined);
      assert.equal(fetchMock.calls.length, 0, 'update_task must not call fetch');
    });
  });

  // -------------------------------------------------------------------------
  // Config errors
  // -------------------------------------------------------------------------

  describe('config validation', () => {
    it('throws when no webhook entry exists in config.dispatchers', async () => {
      await assert.rejects(
        () => webhook.create_task({ dispatchers: [] }, makeEvent(), makeAssessment()),
        /no dispatcher config entry with name "webhook"/,
      );
    });

    it('throws when webhook entry is missing a url', async () => {
      const config = { dispatchers: [{ name: 'webhook' }] };
      await assert.rejects(
        () => webhook.create_task(config, makeEvent(), makeAssessment()),
        /missing a valid "url"/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Config-driven field mapping ("payload")
  // -------------------------------------------------------------------------

  describe('field mapping (config.payload)', () => {
    it('uses the default fixed payload when no "payload" mapping is configured (back-compat)', async () => {
      fetchMock = mockFetch();
      const event = makeEvent();
      const assessment = makeAssessment();

      await webhook.create_task(makeConfig(), event, assessment);

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.event_id, event.id);
      assert.equal(body.verdict, assessment.verdict);
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'title'),
        'default payload has no "title" key — mapped-payload-only field');
    });

    it('maps a single "{{event.field}}" placeholder to the target key, preserving native type', async () => {
      fetchMock = mockFetch();
      const event = makeEvent({ title: 'Something broke' });
      const config = makeConfig({
        payload: { title: '{{event.title}}' },
      });

      await webhook.create_task(config, event, makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.title, 'Something broke');
    });

    it('maps a literal value (no placeholder) through unchanged', async () => {
      fetchMock = mockFetch();
      const config = makeConfig({
        payload: { project: 'lore-archivist' },
      });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.project, 'lore-archivist');
    });

    it('interpolates multiple placeholders and literal text in one template', async () => {
      fetchMock = mockFetch();
      const event = makeEvent({ body: 'Steps to reproduce: click the button.' });
      const assessment = makeAssessment({ reasoning: 'Valid bug report.' });
      const config = makeConfig({
        payload: { description: '{{assessment.reasoning}}\n\n{{event.body}}' },
      });

      await webhook.create_task(config, event, assessment);

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.description, 'Valid bug report.\n\nSteps to reproduce: click the button.');
    });

    it('supports opt-in forwarding of event.url as a back-link field', async () => {
      fetchMock = mockFetch();
      const event = makeEvent({ url: 'https://github.com/owner/repo/issues/42' });
      const config = makeConfig({
        payload: { source_url: '{{event.url}}' },
      });

      await webhook.create_task(config, event, makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.source_url, 'https://github.com/owner/repo/issues/42');
    });

    it('renders an unresolvable path as null for a whole-string placeholder', async () => {
      fetchMock = mockFetch();
      const config = makeConfig({
        payload: { assignee: '{{event.does_not_exist}}' },
      });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.assignee, null);
    });

    it('renders an unresolvable path as empty string within interpolated text', async () => {
      fetchMock = mockFetch();
      const config = makeConfig({
        payload: { description: 'prefix-{{event.does_not_exist}}-suffix' },
      });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.description, 'prefix--suffix');
    });

    it('maps a nested assessment path (assessment.suggested_action.body)', async () => {
      fetchMock = mockFetch();
      const assessment = makeAssessment({
        suggested_action: { classes: ['dispatch'], body: 'opening a ticket for this' },
      });
      const config = makeConfig({
        payload: { notes: '{{assessment.suggested_action.body}}' },
      });

      await webhook.create_task(config, makeEvent(), assessment);

      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.notes, 'opening a ticket for this');
    });
  });

  // -------------------------------------------------------------------------
  // Bearer-token auth
  // -------------------------------------------------------------------------

  describe('bearer auth (config.auth)', () => {
    const ENV_VAR = 'CLAGENTIC_TRIAGE_TEST_INGEST_TOKEN';

    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it('adds an Authorization: Bearer header using the configured token_env', async () => {
      process.env[ENV_VAR] = 'super-secret-token';
      fetchMock = mockFetch();
      const config = makeConfig({ auth: { type: 'bearer', token_env: ENV_VAR } });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const headers = fetchMock.calls[0].init.headers;
      assert.equal(headers.Authorization, 'Bearer super-secret-token');
    });

    it('does not add X-Clagentic-Signature when bearer auth is configured', async () => {
      process.env[ENV_VAR] = 'super-secret-token';
      fetchMock = mockFetch();
      const config = makeConfig({ auth: { type: 'bearer', token_env: ENV_VAR } });

      await webhook.create_task(config, makeEvent(), makeAssessment());

      const headers = fetchMock.calls[0].init.headers;
      assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'X-Clagentic-Signature'));
    });

    it('throws when auth.type is "bearer" and the named env var is unset', async () => {
      fetchMock = mockFetch();
      const config = makeConfig({ auth: { type: 'bearer', token_env: ENV_VAR } });

      await assert.rejects(
        () => webhook.create_task(config, makeEvent(), makeAssessment()),
        /token_env.*unset|unset or empty/i,
      );
      assert.equal(fetchMock.calls.length, 0, 'must not POST when auth token is missing');
    });

    it('throws when auth.type is "bearer" and the named env var is empty', async () => {
      process.env[ENV_VAR] = '';
      fetchMock = mockFetch();
      const config = makeConfig({ auth: { type: 'bearer', token_env: ENV_VAR } });

      await assert.rejects(
        () => webhook.create_task(config, makeEvent(), makeAssessment()),
        /unset or empty/i,
      );
    });

    it('defaults token_env to INGEST_TOKEN when not specified', async () => {
      process.env.INGEST_TOKEN = 'default-env-token';
      fetchMock = mockFetch();
      const config = makeConfig({ auth: { type: 'bearer' } });

      try {
        await webhook.create_task(config, makeEvent(), makeAssessment());
        const headers = fetchMock.calls[0].init.headers;
        assert.equal(headers.Authorization, 'Bearer default-env-token');
      } finally {
        delete process.env.INGEST_TOKEN;
      }
    });
  });
});
