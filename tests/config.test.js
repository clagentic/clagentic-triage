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
 * Load config with a temp cwd and an isolated env that has no TRIAGE_* vars
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
  assert.equal(cfg.model, 'clagentic:router');
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
      TRIAGE_ADAPTER: 'gitlab',
      TRIAGE_ORG: 'my-org',
      TRIAGE_MODEL: 'claude-opus-4',
      TRIAGE_CONFIDENCE_THRESHOLD: '0.9',
      TRIAGE_WEBHOOK_SECRET: 'hunter2',
    },
  });

  assert.equal(cfg.source.adapter, 'gitlab');
  assert.equal(cfg.source.org, 'my-org');
  assert.equal(cfg.model, 'claude-opus-4');
  assert.equal(cfg.confidence_threshold, 0.9);
  assert.equal(cfg.webhooks.secret, 'hunter2');
});

test('3. TRIAGE_REPOS comma-separated string → array', async () => {
  const cfg = await load({
    env: {
      TRIAGE_REPOS: 'repo-a, repo-b,  repo-c  ',
    },
  });

  assert.deepEqual(cfg.source.repos, ['repo-a', 'repo-b', 'repo-c']);
});

test('4. TRIAGE_AUTO_APPROVE comma-separated string → array', async () => {
  const cfg = await load({
    env: {
      TRIAGE_AUTO_APPROVE: 'approve,respond, close',
    },
  });

  assert.deepEqual(cfg.auto_approve, ['approve', 'respond', 'close']);
});

test('5. invalid adapter value throws ConfigError', async () => {
  await assert.rejects(
    () =>
      load({
        env: { TRIAGE_ADAPTER: 'bitbucket' },
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
        env: { TRIAGE_CONFIDENCE_THRESHOLD: '1.5' },
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
        env: { TRIAGE_CONFIDENCE_THRESHOLD: '-0.1' },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      return true;
    },
  );
});

test('7. github_token() reads from env at call time — not stored in config object', async () => {
  const env = { TRIAGE_GITHUB_TOKEN: 'ghp_test_token_abc' };
  const cfg = await load({ env });

  // Must not appear as an enumerable property on the config object
  assert.ok(!Object.keys(cfg).includes('TRIAGE_GITHUB_TOKEN'), 'token must not be a direct key');
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
        TRIAGE_ADAPTER: 'github', // overrides file's forgejo
        TRIAGE_ORG: 'env-org',   // overrides file's file-org
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
      webhooks: { enabled: true, port: 9000 },
    },
  });

  assert.equal(cfg.webhooks.enabled, true);
  assert.equal(cfg.webhooks.port, 9000);
  // secret was not in the file — must retain default
  assert.equal(cfg.webhooks.secret, '');
});
