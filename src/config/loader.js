/**
 * Config loader for clagentic:triage.
 *
 * Load order (highest priority first):
 *   1. Environment variables (CLAGENTIC_TRIAGE_* prefix)
 *   2. triage.config.json in cwd
 *   3. ~/.config/clagentic/triage/config.json
 *
 * CLAGENTIC_TRIAGE_GITHUB_TOKEN is never stored in the returned config object.
 * Access it via config.github_token() which reads the env var at call time.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VALID_ADAPTERS = ['github', 'gitlab', 'forgejo'];
const VALID_RUNNERS = ['claude-cli', 'anthropic-api', 'openai-compatible', 'clagentic-router'];
const VALID_AUTO_APPROVE_CLASSES = [
  'approve',
  'respond',
  'request_changes',
  'close',
  'dispatch',
  'escalate',
];

// DD-008: known GitHub author_association values. watch_associations entries
// are validated against this enum.
const VALID_ASSOCIATIONS = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  'MANNEQUIN',
];

// DD-008: the default "external contributor" association set. Events whose
// author_association is in this set pass the association check by default;
// internal associations (OWNER/MEMBER/COLLABORATOR) are filtered out.
const DEFAULT_WATCH_ASSOCIATIONS = [
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  'MANNEQUIN',
];

/**
 * The default config. All fields must be present here so callers
 * can rely on structural completeness without null-checking every path.
 */
function defaults() {
  return {
    source: {
      adapter: 'github',
      org: null,
      repos: ['*'],
      poll_interval_seconds: 60,
      allow_bot_logins: [],
      // DD-008: actor-association filter. Default = external contributors only.
      watch_associations: DEFAULT_WATCH_ASSOCIATIONS.slice(),
      ignore_logins: [],   // always skipped, regardless of association (deny)
      watch_logins: [],    // always processed, regardless of association (allow)
    },
    intent_file: '.github/triage-intent.yml',
    intent_file_fallback: '.github/TRIAGE_INTENT.md',
    model: 'clagentic:router',
    model_fallback: 'claude-sonnet-4-5',
    runner: 'claude-cli',          // CLAGENTIC_TRIAGE_RUNNER — which backend to use for LLM calls
    runner_url: null,              // CLAGENTIC_TRIAGE_RUNNER_URL — base URL for openai-compatible / clagentic-router
    runner_api_key_env: null,      // name of the env var holding the API key (never the key itself)
    confidence_threshold: 0.7,
    auto_approve: [],
    allow_auto_pr_approval: false,  // RT-002: explicit opt-in required before approve class works
    pending_queue: '.triage/pending.jsonl',
    dispatchers: [],
    hooks: [],
    webhooks: {
      enabled: false,
      port: 8742,
      secret: '',
      bind: '127.0.0.1',
      path: '/webhook',
    },
    notifications: {
      webhooks: [],
    },
  };
}

/**
 * Deep-merge src into dst. Arrays are replaced, not concatenated.
 * Returns a new object; does not mutate either argument.
 */
function deepMerge(dst, src) {
  const out = Object.assign({}, dst);
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const dv = dst[key];
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      dv !== null &&
      typeof dv === 'object' &&
      !Array.isArray(dv)
    ) {
      out[key] = deepMerge(dv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * Attempt to read and parse a JSON file. Returns parsed object or null if
 * the file does not exist. Throws on parse errors.
 */
async function tryReadJson(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse config file ${filePath}: ${err.message}`);
  }
}

/**
 * Split a comma-separated env var value into a trimmed, non-empty array.
 */
function splitCsv(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a partial config object from CLAGENTIC_TRIAGE_* environment variables.
 * Only fields that are present in the env are included — absent vars do not
 * override file config with undefined values.
 */
function configFromEnv(env) {
  const out = {};

  if (env.CLAGENTIC_TRIAGE_ADAPTER !== undefined) {
    out.source = out.source || {};
    out.source.adapter = env.CLAGENTIC_TRIAGE_ADAPTER;
  }

  if (env.CLAGENTIC_TRIAGE_ORG !== undefined) {
    out.source = out.source || {};
    out.source.org = env.CLAGENTIC_TRIAGE_ORG;
  }

  if (env.CLAGENTIC_TRIAGE_REPOS !== undefined) {
    out.source = out.source || {};
    out.source.repos = splitCsv(env.CLAGENTIC_TRIAGE_REPOS);
  }

  // An empty value is treated as "unset" rather than "watch no associations".
  // Clearing the external-only default via an empty env var would silently
  // filter out every actor except those in watch_logins — a footgun. Operators
  // who genuinely want association-based triage disabled set watch_logins.
  if (env.CLAGENTIC_TRIAGE_WATCH_ASSOCIATIONS) {
    const parsed = splitCsv(env.CLAGENTIC_TRIAGE_WATCH_ASSOCIATIONS);
    if (parsed.length > 0) {
      out.source = out.source || {};
      out.source.watch_associations = parsed;
    }
  }

  if (env.CLAGENTIC_TRIAGE_IGNORE_LOGINS !== undefined) {
    out.source = out.source || {};
    out.source.ignore_logins = splitCsv(env.CLAGENTIC_TRIAGE_IGNORE_LOGINS);
  }

  if (env.CLAGENTIC_TRIAGE_WATCH_LOGINS !== undefined) {
    out.source = out.source || {};
    out.source.watch_logins = splitCsv(env.CLAGENTIC_TRIAGE_WATCH_LOGINS);
  }

  if (env.CLAGENTIC_TRIAGE_MODEL !== undefined) {
    out.model = env.CLAGENTIC_TRIAGE_MODEL;
  }

  if (env.CLAGENTIC_TRIAGE_RUNNER !== undefined) {
    out.runner = env.CLAGENTIC_TRIAGE_RUNNER;
  }

  if (env.CLAGENTIC_TRIAGE_RUNNER_URL !== undefined) {
    out.runner_url = env.CLAGENTIC_TRIAGE_RUNNER_URL;
  }

  if (env.CLAGENTIC_TRIAGE_RUNNER_API_KEY_ENV !== undefined) {
    out.runner_api_key_env = env.CLAGENTIC_TRIAGE_RUNNER_API_KEY_ENV;
  }

  if (env.CLAGENTIC_TRIAGE_AUTO_APPROVE !== undefined) {
    out.auto_approve = splitCsv(env.CLAGENTIC_TRIAGE_AUTO_APPROVE);
  }

  if (env.CLAGENTIC_TRIAGE_WEBHOOK_SECRET !== undefined) {
    out.webhooks = out.webhooks || {};
    out.webhooks.secret = env.CLAGENTIC_TRIAGE_WEBHOOK_SECRET;
  }

  if (env.CLAGENTIC_TRIAGE_WEBHOOK_PORT !== undefined) {
    const parsed = parseInt(env.CLAGENTIC_TRIAGE_WEBHOOK_PORT, 10);
    if (isNaN(parsed)) {
      throw new ConfigError(
        `CLAGENTIC_TRIAGE_WEBHOOK_PORT must be an integer, got: ${env.CLAGENTIC_TRIAGE_WEBHOOK_PORT}`,
      );
    }
    out.webhooks = out.webhooks || {};
    out.webhooks.port = parsed;
  }

  if (env.CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD !== undefined) {
    const parsed = parseFloat(env.CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD);
    if (isNaN(parsed)) {
      throw new ConfigError(
        `CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD must be a number, got: ${env.CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD}`,
      );
    }
    out.confidence_threshold = parsed;
  }

  return out;
}

/**
 * Validate a fully merged config object. Throws ConfigError on any violation.
 */
function validate(cfg) {
  if (!VALID_ADAPTERS.includes(cfg.source.adapter)) {
    throw new ConfigError(
      `source.adapter must be one of: ${VALID_ADAPTERS.join(', ')}. Got: ${cfg.source.adapter}`,
    );
  }

  if (!VALID_RUNNERS.includes(cfg.runner)) {
    throw new ConfigError(
      `runner must be one of: ${VALID_RUNNERS.join(', ')}. Got: ${cfg.runner}`,
    );
  }

  if (
    typeof cfg.confidence_threshold !== 'number' ||
    cfg.confidence_threshold < 0 ||
    cfg.confidence_threshold > 1
  ) {
    throw new ConfigError(
      `confidence_threshold must be a number between 0 and 1. Got: ${cfg.confidence_threshold}`,
    );
  }

  for (const action of cfg.auto_approve) {
    if (!VALID_AUTO_APPROVE_CLASSES.includes(action)) {
      throw new ConfigError(
        `auto_approve contains invalid action class "${action}". Valid classes: ${VALID_AUTO_APPROVE_CLASSES.join(', ')}`,
      );
    }
  }

  // RT-002: auto-approving the 'approve' action class means the LLM can
  // autonomously approve PRs on live repos. This requires an explicit opt-in
  // acknowledgment key to prevent accidental enablement.
  if (cfg.auto_approve.includes('approve') && !cfg.allow_auto_pr_approval) {
    throw new ConfigError(
      'auto_approve includes "approve" (autonomous PR approval) but allow_auto_pr_approval is not set to true. ' +
      'Set allow_auto_pr_approval: true in your config to confirm this is intentional. ' +
      'See docs/DESIGN-DECISIONS.md DD-002 for the security implications.',
    );
  }

  // DD-008: validate actor-association config. watch_associations entries must
  // be known GitHub author_association values; ignore_logins / watch_logins are
  // free-form login arrays and are not enumerated.
  for (const assoc of cfg.source.watch_associations ?? []) {
    if (!VALID_ASSOCIATIONS.includes(assoc)) {
      throw new ConfigError(
        `source.watch_associations contains invalid association "${assoc}". ` +
        `Valid values: ${VALID_ASSOCIATIONS.join(', ')}`,
      );
    }
  }

  const port = cfg.webhooks.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `webhooks.port must be an integer between 1 and 65535. Got: ${port}`,
    );
  }

  // RT-004: webhook server must not start without a secret when enabled.
  if (cfg.webhooks.enabled && !cfg.webhooks.secret) {
    throw new ConfigError(
      'webhooks.enabled is true but webhooks.secret is empty. ' +
      'Set CLAGENTIC_TRIAGE_WEBHOOK_SECRET or webhooks.secret in your config. ' +
      'An unauthenticated webhook server is refused.',
    );
  }
}

/**
 * Load, merge, and validate configuration.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]        - Working directory to look for triage.config.json (default: process.cwd())
 * @param {string} [opts.configPath] - Explicit path to a config file (overrides the cwd search)
 * @param {object} [opts._env]       - Environment variable source (default: process.env). Exposed for testing.
 * @returns {Promise<object>} The merged, validated config with a github_token() getter.
 */
export async function loadConfig(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts._env || process.env;

  // Layer 3 (lowest priority): user-level config file
  const userConfigPath = join(homedir(), '.config', 'clagentic', 'triage', 'config.json');
  const userConfig = await tryReadJson(userConfigPath);

  // Layer 2: project-level config file
  let projectConfig = null;
  if (opts.configPath) {
    projectConfig = await tryReadJson(opts.configPath);
    if (projectConfig === null) {
      throw new ConfigError(`Config file not found: ${opts.configPath}`);
    }
  } else {
    const projectConfigPath = join(cwd, 'triage.config.json');
    projectConfig = await tryReadJson(projectConfigPath);
  }

  // Layer 1 (highest priority): environment variables
  const envConfig = configFromEnv(env);

  // Merge: defaults ← user config ← project config ← env vars
  let merged = defaults();
  if (userConfig !== null) {
    merged = deepMerge(merged, userConfig);
  }
  if (projectConfig !== null) {
    merged = deepMerge(merged, projectConfig);
  }
  if (Object.keys(envConfig).length > 0) {
    merged = deepMerge(merged, envConfig);
  }

  // Deprecation shim: router_url → runner_url.
  // If a config file supplied the old router_url key and runner_url was not set,
  // migrate the value and warn. runner_url is the canonical key going forward.
  if (merged.router_url && !merged.runner_url) {
    process.stderr.write(
      '[clagentic:triage] DEPRECATED: config key "router_url" has been renamed to "runner_url". ' +
      'Please update your config file.\n',
    );
    merged.runner_url = merged.router_url;
  }
  // Remove the legacy key so it does not appear in the validated object.
  delete merged.router_url;

  // Deprecation shim: model: "clagentic:router" without an explicit runner set.
  // If the user has not migrated to the runner field, emit a warning and apply
  // the equivalent runner selection automatically.
  if (
    merged.model === 'clagentic:router' &&
    merged.runner === 'claude-cli'
  ) {
    process.stderr.write(
      '[clagentic:triage] DEPRECATED: model: "clagentic:router" is deprecated. ' +
      'Set runner: "clagentic-router" and model: "auto" in your config instead.\n',
    );
    merged.runner = 'clagentic-router';
    merged.model = 'auto';
  }

  validate(merged);

  // Attach the token getter. Reads at call time so rotation works without reload.
  // The token is never stored on the config object.
  Object.defineProperty(merged, 'github_token', {
    enumerable: false,
    configurable: false,
    value: () => env.CLAGENTIC_TRIAGE_GITHUB_TOKEN || null,
  });

  return merged;
}
