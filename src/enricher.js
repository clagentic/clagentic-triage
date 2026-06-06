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
// Minimal YAML parser
//
// Handles the triage-intent.yml schema only:
//   - Key: value pairs (string scalar values, possibly multi-line `|` block)
//   - Simple arrays with `- item` entries
//   - Nested objects (indented key: value)
//   - Comments (#)
//
// Does NOT handle anchors, aliases, flow mappings, or complex types.
// If the input does not look like YAML (no colon-separated key), it is
// returned as { description: rawString }.
// ---------------------------------------------------------------------------

/**
 * Remove inline YAML comments, but only outside of block scalars.
 * Strips everything from the first ` #` that is preceded by whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
function _stripComment(line) {
  // Only strip free-standing comments — not `#` that is part of a value.
  // A comment must be preceded by whitespace (or start of line) and be followed
  // by a space or end of string. This avoids stripping `#issue-123` or similar.
  return line.replace(/(^|\s)#(\s|$).*$/, '').trimEnd();
}

/**
 * Count leading spaces (indentation level).
 *
 * @param {string} line
 * @returns {number}
 */
function _indent(line) {
  return line.length - line.trimStart().length;
}

/**
 * Parse a minimal YAML string into a plain object.
 * Scoped to the triage-intent.yml schema — not a general YAML parser.
 *
 * @param {string} yaml
 * @returns {object}
 */
export function parseYaml(yaml) {
  // If the input looks like pure prose (no `key: value` line at top level),
  // treat it as a raw description string.
  const hasKeyValueLine = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(yaml);
  if (!hasKeyValueLine) {
    return { description: yaml };
  }

  const lines = yaml.split('\n');

  /**
   * Recursive parse: consume lines starting at `startIdx` that have
   * indentation > `parentIndent`. Returns { result, nextIdx }.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: object | string[], nextIdx: number }}
   */
  function parseBlock(startIdx, parentIndent) {
    // Peek at the first non-empty, non-comment line to decide if this block
    // is a mapping (key: value) or a sequence (- item).
    let peekIdx = startIdx;
    while (peekIdx < lines.length) {
      const raw = lines[peekIdx];
      const stripped = _stripComment(raw);
      if (stripped.trim() === '' || stripped.trim().startsWith('#')) {
        peekIdx++;
        continue;
      }
      break;
    }

    if (peekIdx >= lines.length) {
      return { result: {}, nextIdx: startIdx };
    }

    const peekLine = _stripComment(lines[peekIdx]);
    const isSequence = peekLine.trimStart().startsWith('- ') || peekLine.trimStart() === '-';

    if (isSequence) {
      return parseSequence(startIdx, parentIndent);
    }
    return parseMapping(startIdx, parentIndent);
  }

  /**
   * Parse a YAML mapping block.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: object, nextIdx: number }}
   */
  function parseMapping(startIdx, parentIndent) {
    const obj = {};
    let i = startIdx;

    while (i < lines.length) {
      const rawLine = lines[i];
      const strippedLine = _stripComment(rawLine);

      // Skip blank lines and pure comment lines
      if (strippedLine.trim() === '') {
        i++;
        continue;
      }

      const currentIndent = _indent(strippedLine);

      // Stop when we step back to or above the parent indent level
      if (currentIndent <= parentIndent && i !== startIdx) {
        break;
      }

      const trimmed = strippedLine.trimStart();

      // Check for a key: (value?) pattern
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        // Not a key line — skip (could be a continuation, handled below)
        i++;
        continue;
      }

      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();

      i++;

      if (rest === '|') {
        // Block scalar — collect indented lines that follow
        const scalarLines = [];
        while (i < lines.length) {
          const nextRaw = lines[i];
          if (nextRaw.trim() === '') {
            // Blank lines are part of the block scalar
            scalarLines.push('');
            i++;
            continue;
          }
          const nextIndent = _indent(nextRaw);
          if (nextIndent <= currentIndent) {
            break;
          }
          // Preserve relative indentation by stripping the base indent
          const baseIndent = currentIndent + 2;
          const stripped = nextRaw.slice(Math.min(baseIndent, nextIndent));
          scalarLines.push(stripped);
          i++;
        }
        // Trim trailing blank lines, join with newline
        while (scalarLines.length > 0 && scalarLines[scalarLines.length - 1] === '') {
          scalarLines.pop();
        }
        obj[key] = scalarLines.join('\n');
      } else if (rest === '' || rest === null) {
        // No inline value — look ahead for a nested block
        if (i < lines.length) {
          const nextRaw = lines[i];
          const nextStripped = _stripComment(nextRaw);
          if (nextStripped.trim() === '') {
            obj[key] = null;
          } else {
            const nextIndent = _indent(nextStripped);
            if (nextIndent > currentIndent) {
              const nested = parseBlock(i, currentIndent);
              obj[key] = nested.result;
              i = nested.nextIdx;
            } else {
              obj[key] = null;
            }
          }
        } else {
          obj[key] = null;
        }
      } else {
        // Inline scalar value — strip optional surrounding quotes
        obj[key] = _unquote(rest);
      }
    }

    return { result: obj, nextIdx: i };
  }

  /**
   * Parse a YAML sequence block.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: Array, nextIdx: number }}
   */
  function parseSequence(startIdx, parentIndent) {
    const arr = [];
    let i = startIdx;

    while (i < lines.length) {
      const rawLine = lines[i];
      const strippedLine = _stripComment(rawLine);

      if (strippedLine.trim() === '') {
        i++;
        continue;
      }

      const currentIndent = _indent(strippedLine);

      // Stop when we step back to or above parent indent
      if (currentIndent <= parentIndent && i !== startIdx) {
        break;
      }

      const trimmed = strippedLine.trimStart();

      if (!trimmed.startsWith('- ') && trimmed !== '-') {
        // Not a sequence item at this level — stop
        break;
      }

      const itemContent = trimmed.slice(2).trim(); // strip leading "- "
      i++;

      if (itemContent === '') {
        // Multi-line sequence item — parse as a nested block
        if (i < lines.length) {
          const nextStripped = _stripComment(lines[i]);
          if (nextStripped.trim() !== '' && _indent(nextStripped) > currentIndent) {
            const nested = parseBlock(i, currentIndent);
            arr.push(nested.result);
            i = nested.nextIdx;
          } else {
            arr.push(null);
          }
        } else {
          arr.push(null);
        }
      } else if (itemContent.includes(':')) {
        // Inline mapping shorthand: `- key: value`
        // Parse the item as a single-entry mapping plus any indented continuation
        const colonIdx = itemContent.indexOf(':');
        const itemKey = itemContent.slice(0, colonIdx).trim();
        const itemVal = itemContent.slice(colonIdx + 1).trim();

        const entryObj = {};
        entryObj[itemKey] = itemVal === '' ? null : _unquote(itemVal);

        // Look ahead for additional keys at the same indent level (indented relative to `- `)
        while (i < lines.length) {
          const nextRaw = lines[i];
          const nextStripped = _stripComment(nextRaw);
          if (nextStripped.trim() === '') {
            i++;
            continue;
          }
          const nextIndent = _indent(nextStripped);
          if (nextIndent <= currentIndent) {
            break;
          }
          const nextTrimmed = nextStripped.trimStart();
          const nextColonIdx = nextTrimmed.indexOf(':');
          if (nextColonIdx === -1) {
            break;
          }
          const nextKey = nextTrimmed.slice(0, nextColonIdx).trim();
          const nextVal = nextTrimmed.slice(nextColonIdx + 1).trim();
          entryObj[nextKey] = nextVal === '' ? null : _unquote(nextVal);
          i++;
        }

        arr.push(entryObj);
      } else {
        arr.push(_unquote(itemContent));
      }
    }

    return { result: arr, nextIdx: i };
  }

  /**
   * Strip surrounding single or double quotes from a scalar value.
   *
   * @param {string} s
   * @returns {string}
   */
  function _unquote(s) {
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  try {
    const { result } = parseBlock(0, -1);
    return result;
  } catch (err) {
    // If parsing fails for any reason, return the raw input as a description.
    console.warn(`[enricher] YAML parse error: ${err.message}`);
    return { description: yaml };
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
  const yamlContent = await _fetchRepoFile(repo, yamlPath, token);
  if (yamlContent !== null) {
    const parsed = parseYaml(yamlContent);

    // If the parsed intent has a repo_context_files array, fetch each listed
    // path from the same repo and inject their content.
    const contextFiles = parsed.repo_context_files;
    if (Array.isArray(contextFiles) && contextFiles.length > 0) {
      const resolved = {};
      await Promise.all(
        contextFiles.map(async (entry) => {
          // Each entry is expected to be an object with a `path` key.
          const filePath = typeof entry === 'object' && entry !== null ? entry.path : null;
          if (!filePath || typeof filePath !== 'string') {
            return;
          }
          const content = await _fetchRepoFile(repo, filePath, token);
          if (content !== null) {
            resolved[filePath] = content;
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
  const mdContent = await _fetchRepoFile(repo, mdPath, token);
  if (mdContent !== null) {
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
  const token = config.github_token ? config.github_token() : null;

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
