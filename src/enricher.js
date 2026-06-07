/**
 * Enricher for clagentic:triage.
 *
 * Fetches repo intent context and contributor profile, then attaches both
 * to the normalized event before it reaches the assessor.
 *
 * Intent loading order (DD-002):
 *   1. config.intent_file (.github/triage-intent.yml) — parsed as YAML
 *   2. config.intent_file_fallback (.github/TRIAGE_INTENT.md) — stored as raw string
 *   3. Built-in generic fallback string
 *
 * enrich() never throws. Errors produce degraded context objects, not
 * exceptions — the assessor must be able to run on best-effort context.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { parseYaml } from './yaml.js';
import { _resolve_token } from './adapters/github.js';

// ---------------------------------------------------------------------------
// Package version — read once at module load time, used in User-Agent
// ---------------------------------------------------------------------------

const _pkgPath = join(fileURLToPath(import.meta.url), '..', '..', 'package.json');
let _version = '0.0.0';
try {
  const raw = await readFile(_pkgPath, 'utf8');
  _version = JSON.parse(raw).version ?? '0.0.0';
} catch {
  // Non-fatal; User-Agent will use placeholder version.
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const ACCEPT_HEADER = 'application/vnd.github+json';
const API_VERSION_HEADER = 'X-GitHub-Api-Version';
const API_VERSION = '2022-11-28';

// RT-005: repo_context_files path safety constraints.
// Only documentation-style file extensions are permitted as context file
// fetches. Binary, credential, and config files are blocked by extension.
const ALLOWED_CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.yml', '.yaml', '.json', '.rst']);

// Path segments that are always blocked regardless of extension.
const BLOCKED_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /secret/i,
  /credential/i,
  /private/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.cer$/i,
  /\.crt$/i,
  /token/i,
  /password/i,
  /\.git\//,
  /^\.git$/,
];

// Maximum number of context files to fetch per intent file.
const MAX_CONTEXT_FILES = 5;

// Maximum byte size of a single fetched context file (32 KB).
const MAX_CONTEXT_FILE_BYTES = 32 * 1024;

// RT-003: Maximum byte size of the intent file itself (YAML or Markdown).
// A legitimate triage-intent.yml is a few hundred bytes. An abnormally large
// file is either a misconfiguration or a prompt-stuffing attempt. Cap at 64 KB
// and truncate rather than reject — the truncated content is still useful for
// triage; rejection would silently degrade to the generic fallback without
// warning the operator.
const MAX_INTENT_FILE_BYTES = 64 * 1024;

/**
 * Generic fallback intent used when neither the YAML file nor the Markdown
 * fallback is found in the target repo.
 */
const GENERIC_FALLBACK_INTENT = `
Triage intent: generic fallback.

Accept:
- Bug reports that include clear reproduction steps and expected/actual behavior.
- Feature requests with a clear use-case description.

Request more information when:
- A bug report lacks reproduction steps.
- A feature request lacks motivation or use-case context.

Reject or redirect:
- General support questions — redirect to Discussions or the community forum.
- Vague or one-line reports with no actionable detail.
- Spam or off-topic submissions.

For PRs:
- Accept bug fixes accompanied by a test.
- Accept small, focused changes that reference an issue.
- Request changes on large-scope PRs without a prior issue.
`.trim();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Build standard GitHub API request headers.
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
function _headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT_HEADER,
    [API_VERSION_HEADER]: API_VERSION,
    'User-Agent': `clagentic-triage/${_version}`,
  };
}

/**
 * Fetch a single resource from the GitHub API.
 * Returns { ok, status, data } — never throws.
 *
 * @param {string} url
 * @param {string} token
 * @returns {Promise<{ ok: boolean, status: number, data: object | null }>}
 */
async function _get(url, token) {
  try {
    const res = await globalThis.fetch(url, { headers: _headers(token) });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    console.warn(`[enricher] fetch error for ${url}: ${err.message}`);
    return { ok: false, status: 0, data: null };
  }
}

// ---------------------------------------------------------------------------
// Intent loading
// ---------------------------------------------------------------------------

/**
 * Fetch raw file content from a GitHub repo via the contents API.
 * Returns the decoded string content, or null if the file is not found (404)
 * or any other error occurs.
 *
 * @param {string} repo    - "owner/repo"
 * @param {string} path    - File path in the repo
 * @param {string} token
 * @returns {Promise<string | null>}
 */
async function _fetchRepoFile(repo, path, token) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const result = await _get(url, token);

  if (!result.ok) {
    return null;
  }

  const { data } = result;

  // The GitHub contents API returns base64-encoded content for files.
  if (data && typeof data.content === 'string') {
    try {
      // content may have embedded newlines from GitHub's line-wrapped base64
      const clean = data.content.replace(/\s/g, '');
      return Buffer.from(clean, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Load the intent context for a repo, following DD-002 fallback order.
 *
 * @param {object} config
 * @param {string} repo   - "owner/repo"
 * @param {string} token
 * @returns {Promise<{ intent: object, _source: 'yaml'|'markdown'|'generic' }>}
 *   intent is always a plain object — never a raw string.
 */
async function _loadIntent(config, repo, token) {
  const yamlPath = config.intent_file ?? '.github/triage-intent.yml';
  const mdPath = config.intent_file_fallback ?? '.github/TRIAGE_INTENT.md';

  // --- Attempt 1: YAML intent file ---
  let yamlContent = await _fetchRepoFile(repo, yamlPath, token);
  if (yamlContent !== null) {
    // RT-003: cap intent file size to prevent prompt-stuffing via a large file
    // committed to the repo by its maintainers.
    if (yamlContent.length > MAX_INTENT_FILE_BYTES) {
      console.warn(
        `[enricher] intent file "${yamlPath}" exceeds ${MAX_INTENT_FILE_BYTES} bytes (${yamlContent.length}); truncating`,
      );
      yamlContent = yamlContent.slice(0, MAX_INTENT_FILE_BYTES) + '\n# [truncated by clagentic-triage: file exceeds size limit]';
    }
    const parsed = parseYaml(yamlContent);

    // If the parsed intent has a repo_context_files array, fetch each listed
    // path from the same repo and inject their content.
    const contextFiles = parsed.repo_context_files;
    if (Array.isArray(contextFiles) && contextFiles.length > 0) {
      const resolved = {};
      // RT-005: cap the number of files, validate each path before fetching.
      const safeCandidates = contextFiles.slice(0, MAX_CONTEXT_FILES);
      await Promise.all(
        safeCandidates.map(async (entry) => {
          // Each entry is expected to be an object with a `path` key.
          const filePath = typeof entry === 'object' && entry !== null ? entry.path : null;
          if (!filePath || typeof filePath !== 'string') {
            return;
          }
          // RT-005: reject blocked path patterns (credentials, keys, etc.)
          if (BLOCKED_PATH_PATTERNS.some((re) => re.test(filePath))) {
            console.warn(`[enricher] repo_context_files: blocked path "${filePath}" (matches credential/secret pattern)`);
            return;
          }
          // RT-005: enforce extension allowlist
          const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
          if (!ALLOWED_CONTEXT_EXTENSIONS.has(ext)) {
            console.warn(`[enricher] repo_context_files: blocked path "${filePath}" (extension "${ext}" not in allowlist)`);
            return;
          }
          const content = await _fetchRepoFile(repo, filePath, token);
          if (content !== null) {
            // RT-005: enforce per-file size cap
            const truncated = content.length > MAX_CONTEXT_FILE_BYTES
              ? content.slice(0, MAX_CONTEXT_FILE_BYTES) + '\n[...truncated]'
              : content;
            resolved[filePath] = truncated;
          }
        }),
      );
      if (Object.keys(resolved).length > 0) {
        parsed._resolved_files = resolved;
      }
    }

    parsed._source = 'yaml';
    return parsed;
  }

  // --- Attempt 2: Markdown fallback ---
  let mdContent = await _fetchRepoFile(repo, mdPath, token);
  if (mdContent !== null) {
    // RT-003: same size cap for the Markdown fallback.
    if (mdContent.length > MAX_INTENT_FILE_BYTES) {
      console.warn(
        `[enricher] intent file "${mdPath}" exceeds ${MAX_INTENT_FILE_BYTES} bytes (${mdContent.length}); truncating`,
      );
      mdContent = mdContent.slice(0, MAX_INTENT_FILE_BYTES) + '\n<!-- [truncated by clagentic-triage: file exceeds size limit] -->';
    }
    return {
      description: mdContent,
      _source: 'markdown',
    };
  }

  // --- Attempt 3: Generic built-in fallback ---
  return {
    description: GENERIC_FALLBACK_INTENT,
    _source: 'generic',
  };
}

// ---------------------------------------------------------------------------
// Contributor profile
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub user's public profile.
 * Returns a normalized contributor object. On any error, returns a minimal
 * object with just the login — never throws.
 *
 * @param {string} login  - GitHub username
 * @param {string} token
 * @returns {Promise<object>}
 */
async function _fetchContributor(login, token) {
  const minimal = { login };

  if (!login) {
    return minimal;
  }

  const url = `${GITHUB_API}/users/${login}`;
  const result = await _get(url, token);

  if (!result.ok || result.data === null) {
    return minimal;
  }

  const d = result.data;
  return {
    login: d.login ?? login,
    name: d.name ?? null,
    public_repos: typeof d.public_repos === 'number' ? d.public_repos : null,
    followers: typeof d.followers === 'number' ? d.followers : null,
    created_at: d.created_at ?? null,
    company: d.company ?? null,
    bio: d.bio ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich a normalized Event with repo intent and contributor context.
 *
 * Returns an EnrichedEvent: { ...event, context: { intent, contributor } }.
 * This function never throws — errors produce degraded context.
 *
 * @param {object} config   - Loaded config object (must expose github_token())
 * @param {object} event    - Normalized Event from the adapter
 * @param {object} _adapter - Source adapter (reserved for future use)
 * @returns {Promise<object>} EnrichedEvent
 */
export async function enrich(config, event, _adapter) {
  const token = await _resolve_token(config);

  // Degraded-context sentinel: used if auth is completely absent or fails.
  const genericFallbackIntent = {
    description: GENERIC_FALLBACK_INTENT,
    _source: 'generic',
  };
  const minimalContributor = { login: event.author ?? '' };

  // If no token is available, return minimal context without any API calls.
  if (!token) {
    console.warn('[enricher] no GitHub token available; returning degraded context');
    return {
      ...event,
      context: {
        intent: genericFallbackIntent,
        contributor: minimalContributor,
      },
    };
  }

  // Run intent loading and contributor fetch concurrently.
  const [intentResult, contributorResult] = await Promise.allSettled([
    _loadIntent(config, event.repo, token),
    _fetchContributor(event.author, token),
  ]);

  // Handle auth failures (401/403): both tasks should have succeeded or
  // failed together, but we guard each independently.
  const intent =
    intentResult.status === 'fulfilled' ? intentResult.value : genericFallbackIntent;

  const contributor =
    contributorResult.status === 'fulfilled' ? contributorResult.value : minimalContributor;

  // If intentResult rejected (unexpected — _loadIntent should not throw),
  // log the reason.
  if (intentResult.status === 'rejected') {
    console.warn(`[enricher] intent load failed unexpectedly: ${intentResult.reason}`);
  }
  if (contributorResult.status === 'rejected') {
    console.warn(`[enricher] contributor fetch failed unexpectedly: ${contributorResult.reason}`);
  }

  return {
    ...event,
    context: {
      intent,
      contributor,
    },
  };
}
