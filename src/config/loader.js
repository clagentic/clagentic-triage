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
const VALID_AUTO_APPROVE_CLASSES = [
  'approve',
  'respond',
  'request_changes',
  'close',
  'dispatch',
  'escalate',
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
    },
    intent_file: '.github/triage-intent.yml',
    intent_file_fallback: '.github/TRIAGE_INTENT.md',
    model: 'clagentic:router',
    model_fallback: 'claude-sonnet-4-5',
    confidence_threshold: 0.7,
    auto_approve: [],
    pending_queue: '.triage/pending.jsonl',
    dispatchers: [],
    hooks: [],
    webhooks: {
      enabled: false,
      port: 8742,
      secret: '',
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

  if (env.CLAGENTIC_TRIAGE_MODEL !== undefined) {
    out.model = env.CLAGENTIC_TRIAGE_MODEL;
  }

  if (env.CLAGENTIC_TRIAGE_AUTO_APPROVE !== undefined) {
    out.auto_approve = splitCsv(env.CLAGENTIC_TRIAGE_AUTO_APPROVE);
  }

  if (env.CLAGENTIC_TRIAGE_WEBHOOK_SECRET !== undefined) {
    out.webhooks = out.webhooks || {};
    out.webhooks.secret = env.CLAGENTIC_TRIAGE_WEBHOOK_SECRET;
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

  const port = cfg.webhooks.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `webhooks.port must be an integer between 1 and 65535. Got: ${port}`,
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
