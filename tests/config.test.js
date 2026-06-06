/**
 * Tests for src/config/loader.js
 * Run with: node --test tests/config.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig, ConfigError } from '../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory with an optional triage.config.json file. */
async function makeTempDir(configObj) {
  const dir = join(tmpdir(), `triage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  if (configObj !== undefined) {
    await writeFile(join(dir, 'triage.config.json'), JSON.stringify(configObj), 'utf8');
  }
  return dir;
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Load config with a temp cwd and an isolated env that has no CLAGENTIC_TRIAGE_* vars
 * unless the caller provides them.
 */
async function load(opts = {}) {
  const { cwd, env = {}, configObj, configPath } = opts;
  let dir = cwd;
  let created = false;
  if (!dir) {
    dir = await makeTempDir(configObj);
    created = true;
  } else if (configObj !== undefined) {
    await writeFile(join(dir, 'triage.config.json'), JSON.stringify(configObj), 'utf8');
  }

  // Provide a clean env — only what the test explicitly passes in.
  const cleanEnv = Object.assign({}, env);

  try {
    return await loadConfig({ cwd: dir, configPath, _env: cleanEnv });
  } finally {
    if (created) {
      await cleanup(dir);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. default config loads with no files and no env vars', async () => {
  const cfg = await load();

  assert.equal(cfg.source.adapter, 'github');
  assert.deepEqual(cfg.source.repos, ['*']);
  assert.equal(cfg.source.org, null);
  assert.equal(cfg.source.poll_interval_seconds, 60);
  assert.deepEqual(cfg.source.allow_bot_logins, []);
  assert.equal(cfg.intent_file, '.github/triage-intent.yml');
  assert.equal(cfg.intent_file_fallback, '.github/TRIAGE_INTENT.md');
  // Default model:'clagentic:router' triggers the deprecation migration on load:
  // model becomes 'auto' and runner becomes 'clagentic-router'.
  assert.equal(cfg.runner, 'clagentic-router');
  assert.equal(cfg.model, 'auto');
  assert.equal(cfg.model_fallback, 'claude-sonnet-4-5');
  assert.equal(cfg.confidence_threshold, 0.7);
  assert.deepEqual(cfg.auto_approve, []);
  assert.equal(cfg.pending_queue, '.triage/pending.jsonl');
  assert.deepEqual(cfg.dispatchers, []);
  assert.deepEqual(cfg.hooks, []);
  assert.equal(cfg.webhooks.enabled, false);
  assert.equal(cfg.webhooks.port, 8742);
  assert.equal(cfg.webhooks.secret, '');
  assert.deepEqual(cfg.notifications.webhooks, []);
});

test('2. env vars override defaults', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_ADAPTER: 'gitlab',
      CLAGENTIC_TRIAGE_ORG: 'my-org',
      CLAGENTIC_TRIAGE_MODEL: 'claude-opus-4',
      CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD: '0.9',
      CLAGENTIC_TRIAGE_WEBHOOK_SECRET: 'hunter2',
    },
  });

  assert.equal(cfg.source.adapter, 'gitlab');
  assert.equal(cfg.source.org, 'my-org');
  assert.equal(cfg.model, 'claude-opus-4');
  assert.equal(cfg.confidence_threshold, 0.9);
  assert.equal(cfg.webhooks.secret, 'hunter2');
});

test('3. CLAGENTIC_TRIAGE_REPOS comma-separated string → array', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_REPOS: 'repo-a, repo-b,  repo-c  ',
    },
  });

  assert.deepEqual(cfg.source.repos, ['repo-a', 'repo-b', 'repo-c']);
});

test('4. CLAGENTIC_TRIAGE_AUTO_APPROVE comma-separated string → array', async () => {
  const cfg = await load({
    env: {
      // RT-002: 'approve' requires allow_auto_pr_approval:true — use safer classes here
      CLAGENTIC_TRIAGE_AUTO_APPROVE: 'respond, close',
    },
  });

  assert.deepEqual(cfg.auto_approve, ['respond', 'close']);
});

test('4b. auto_approve with approve class requires allow_auto_pr_approval (RT-002)', async () => {
  // Without allow_auto_pr_approval, including 'approve' must throw ConfigError
  await assert.rejects(
    () => load({ env: { CLAGENTIC_TRIAGE_AUTO_APPROVE: 'approve' } }),
    (err) => {
      assert.ok(err instanceof ConfigError, 'should be ConfigError');
      assert.ok(err.message.includes('allow_auto_pr_approval'), 'should mention the guard key');
      return true;
    },
  );
});

test('5. invalid adapter value throws ConfigError', async () => {
  await assert.rejects(
    () =>
      load({
        env: { CLAGENTIC_TRIAGE_ADAPTER: 'bitbucket' },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}`);
      assert.ok(err.message.includes('source.adapter'), `message: ${err.message}`);
      return true;
    },
  );
});

test('6. confidence_threshold out of range throws ConfigError', async () => {
  await assert.rejects(
    () =>
      load({
        env: { CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD: '1.5' },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}`);
      assert.ok(err.message.includes('confidence_threshold'), `message: ${err.message}`);
      return true;
    },
  );
});

test('6b. confidence_threshold below 0 throws ConfigError', async () => {
  await assert.rejects(
    () =>
      load({
        env: { CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD: '-0.1' },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      return true;
    },
  );
});

test('7. github_token() reads from env at call time — not stored in config object', async () => {
  const env = { CLAGENTIC_TRIAGE_GITHUB_TOKEN: 'ghp_test_token_abc' };
  const cfg = await load({ env });

  // Must not appear as an enumerable property on the config object
  assert.ok(!Object.keys(cfg).includes('CLAGENTIC_TRIAGE_GITHUB_TOKEN'), 'token must not be a direct key');
  assert.ok(!Object.keys(cfg).includes('github_token_value'), 'token value must not be stored');

  // JSON serialization must not leak the token
  const serialized = JSON.stringify(cfg);
  assert.ok(!serialized.includes('ghp_test_token_abc'), 'token must not appear in JSON output');

  // Getter returns the value from env
  assert.equal(cfg.github_token(), 'ghp_test_token_abc');

  // Getter returns null when token is absent
  const cfgNoToken = await load({ env: {} });
  assert.equal(cfgNoToken.github_token(), null);
});

test('8. config file is merged — env vars win over file values', async () => {
  const dir = await makeTempDir({
    source: { adapter: 'forgejo', org: 'file-org' },
    model: 'claude-haiku-3',
  });

  try {
    const cfg = await load({
      cwd: dir,
      env: {
        CLAGENTIC_TRIAGE_ADAPTER: 'github', // overrides file's forgejo
        CLAGENTIC_TRIAGE_ORG: 'env-org',   // overrides file's file-org
        // model intentionally not set — file value should win over default
      },
    });

    // Env wins over file
    assert.equal(cfg.source.adapter, 'github');
    assert.equal(cfg.source.org, 'env-org');
    // File wins over default
    assert.equal(cfg.model, 'claude-haiku-3');
  } finally {
    await cleanup(dir);
  }
});

test('8b. config file sets nested field — unset fields retain defaults', async () => {
  const cfg = await load({
    configObj: {
      // A secret is required whenever webhooks.enabled is true (RT-004), so a
      // valid enabled-webhook config must include one. This test proves that
      // OTHER unset nested fields (bind, path) still fall back to defaults.
      webhooks: { enabled: true, port: 9000, secret: 'test-secret' },
    },
  });

  assert.equal(cfg.webhooks.enabled, true);
  assert.equal(cfg.webhooks.port, 9000);
  assert.equal(cfg.webhooks.secret, 'test-secret');
  // bind and path were not in the file — must retain defaults
  assert.equal(cfg.webhooks.bind, '127.0.0.1');
  assert.equal(cfg.webhooks.path, '/webhook');
});

test('8c. webhooks.enabled with empty secret is rejected (RT-004)', async () => {
  await assert.rejects(
    () => load({ configObj: { webhooks: { enabled: true, port: 9000 } } }),
    (e) => e instanceof ConfigError && /secret is empty/.test(e.message),
    'enabling webhooks without a secret must throw ConfigError',
  );
});

// ---------------------------------------------------------------------------
// Runner config tests
// ---------------------------------------------------------------------------

test('9. runner defaults to claude-cli when model is set to a non-router value', async () => {
  const cfg = await load({
    env: { CLAGENTIC_TRIAGE_MODEL: 'claude-sonnet-4-5' },
  });

  assert.equal(cfg.runner, 'claude-cli', 'runner should default to claude-cli');
  assert.equal(cfg.model, 'claude-sonnet-4-5');
});

test('10. CLAGENTIC_TRIAGE_RUNNER env var sets runner field', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_MODEL: 'gpt-4o',
      CLAGENTIC_TRIAGE_RUNNER: 'openai-compatible',
      CLAGENTIC_TRIAGE_RUNNER_URL: 'http://localhost:11434',
    },
  });

  assert.equal(cfg.runner, 'openai-compatible');
  assert.equal(cfg.runner_url, 'http://localhost:11434');
});

test('11. invalid runner value throws ConfigError', async () => {
  await assert.rejects(
    () => load({
      env: {
        CLAGENTIC_TRIAGE_MODEL: 'claude-sonnet-4-5',
        CLAGENTIC_TRIAGE_RUNNER: 'banana',
      },
    }),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}`);
      assert.ok(err.message.includes('runner'), `message: ${err.message}`);
      return true;
    },
  );
});

test('12. model: "clagentic:router" triggers deprecation migration — runner becomes clagentic-router, model becomes auto', async () => {
  const cfg = await load({
    configObj: { model: 'clagentic:router', runner: 'claude-cli' },
  });

  assert.equal(cfg.runner, 'clagentic-router', 'runner should be migrated to clagentic-router');
  assert.equal(cfg.model, 'auto', 'model should be migrated to auto');
});

test('12b. model: "clagentic:router" migration does not fire when runner is already set explicitly', async () => {
  // If the user has already set runner: clagentic-router themselves, no migration needed.
  const cfg = await load({
    configObj: { model: 'clagentic:router', runner: 'clagentic-router' },
  });

  // model: 'clagentic:router' with runner already 'clagentic-router' — runner stays, model may be kept
  assert.equal(cfg.runner, 'clagentic-router');
});

test('13. router_url in config file is migrated to runner_url with deprecation shim', async () => {
  const cfg = await load({
    configObj: {
      model: 'claude-sonnet-4-5',
      runner: 'openai-compatible',
      router_url: 'http://old-router:4200',
    },
  });

  assert.equal(cfg.runner_url, 'http://old-router:4200', 'runner_url should be set from router_url');
  assert.ok(!('router_url' in cfg), 'router_url should be removed from config');
});

test('13b. runner_url wins over router_url when both are set', async () => {
  const cfg = await load({
    configObj: {
      model: 'claude-sonnet-4-5',
      runner: 'openai-compatible',
      runner_url: 'http://new-runner:5000',
      router_url: 'http://old-router:4200',
    },
  });

  assert.equal(cfg.runner_url, 'http://new-runner:5000', 'runner_url should win over router_url');
});

test('14. CLAGENTIC_TRIAGE_RUNNER_URL sets runner_url', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_MODEL: 'claude-sonnet-4-5',
      CLAGENTIC_TRIAGE_RUNNER: 'clagentic-router',
      CLAGENTIC_TRIAGE_RUNNER_URL: 'http://router.internal:4200',
    },
  });

  assert.equal(cfg.runner_url, 'http://router.internal:4200');
});

test('15. runner_url defaults to null when not set', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_MODEL: 'claude-sonnet-4-5',
      CLAGENTIC_TRIAGE_RUNNER: 'claude-cli',
    },
  });

  assert.equal(cfg.runner_url, null, 'runner_url should default to null');
});

test('16. runner: anthropic-api is a valid runner value', async () => {
  const cfg = await load({
    env: {
      CLAGENTIC_TRIAGE_MODEL: 'claude-opus-4',
      CLAGENTIC_TRIAGE_RUNNER: 'anthropic-api',
    },
  });

  assert.equal(cfg.runner, 'anthropic-api');
});
