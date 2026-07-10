/**
 * GitHub source adapter for clagentic:triage.
 *
 * Implements the standard adapter interface against the GitHub REST API.
 * Uses Node's built-in fetch (Node 20+). No external dependencies.
 *
 * Token resolution goes through _resolve_token(): GitHub App installation tokens
 * are minted when App credentials are configured; otherwise falls back to the PAT
 * from config.github_token(). Tokens are never logged or stored.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { mint_installation_token } from './github_app.js';

// ---------------------------------------------------------------------------
// Package version — read once at module load time
// ---------------------------------------------------------------------------

const _pkgPath = join(fileURLToPath(import.meta.url), '..', '..', '..', 'package.json');
let _version = '0.0.0';
try {
  const raw = await readFile(_pkgPath, 'utf8');
  _version = JSON.parse(raw).version ?? '0.0.0';
} catch {
  // Non-fatal; version string will be a placeholder.
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL_API = 'https://api.github.com/graphql';
const ACCEPT_HEADER = 'application/vnd.github+json';
const API_VERSION_HEADER = 'X-GitHub-Api-Version';
const API_VERSION = '2022-11-28';
const PER_REPO_SAFETY_CAP = 500;
const ETAG_CACHE_TTL_MS = 300_000;

// ---------------------------------------------------------------------------
// Public name
// ---------------------------------------------------------------------------

export const name = 'github';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] - Machine-readable error code (e.g. 'auth_failure', 'rate_limited')
   */
  constructor(message, code) {
    super(message);
    this.name = 'AdapterError';
    this.code = code ?? null;
  }
}

// ---------------------------------------------------------------------------
// ETag cache — module-level, keyed by repo+url string
// ---------------------------------------------------------------------------

/** @type {Map<string, { etag: string, result: object[], cached_at: number }>} */
const _etagCache = new Map();

/**
 * Remove all cache entries whose key begins with the given repo path prefix.
 * Called after any write operation so subsequent polls re-fetch fresh data.
 *
 * @param {string} repo - "owner/repo" string
 */
function _invalidate_cache(repo) {
  for (const key of _etagCache.keys()) {
    if (key.includes(`:${repo}:`)) {
      _etagCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Unescape a PEM string whose newlines were flattened to the two-character
 * sequence `\n` (backslash + n) rather than real newline bytes.
 *
 * A systemd `EnvironmentFile` cannot hold a literal multi-line value — an
 * operator following docs/GITHUB_APP.md's documented "newlines as \n"
 * convention ends up with the literal two-character sequence in the env var,
 * not an actual newline. Node's `crypto` PEM parser requires real newlines,
 * so without this step the documented env-var path silently produces an
 * unusable key and every mint attempt fails.
 *
 * Detection is conservative: only unescape when the string contains the
 * literal `\n` sequence AND no real newline already exists. A PEM supplied
 * with real newlines (e.g. via a multi-line config file value, or a shell
 * `export` with embedded newlines) is passed through unchanged.
 *
 * @param {string} pem
 * @returns {string}
 */
export function _unescape_pem_newlines(pem) {
  if (pem.includes('\n')) {
    return pem;
  }
  if (pem.includes('\\n')) {
    return pem.replace(/\\n/g, '\n');
  }
  return pem;
}

/**
 * Resolve the GitHub App private key PEM from config/env, per the documented
 * precedence: inline env var wins, else the file-path option, else an
 * actionable error naming both.
 *
 * @param {object} src - config.source
 * @returns {Promise<string>} PEM contents (newlines real, inline values unescaped)
 * @throws {AdapterError} when neither source is configured/readable
 */
async function _resolve_private_key_pem(src) {
  const key_env = src.github_app_private_key_env ?? 'CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY';
  const inline_pem = process.env[key_env];
  if (inline_pem) {
    return _unescape_pem_newlines(inline_pem);
  }

  const key_file_path =
    src.github_app_private_key_path ?? process.env.CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE;
  if (key_file_path) {
    let contents;
    try {
      contents = await readFile(key_file_path, 'utf8');
    } catch (err) {
      throw new AdapterError(
        `GitHub App auth configured with source.github_app_private_key_path/` +
        `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE="${key_file_path}" but the file could not be read: ${err.message}`,
        'auth_failure',
      );
    }
    return _unescape_pem_newlines(contents.trim());
  }

  throw new AdapterError(
    `GitHub App auth configured but no private key was found. Set env var "${key_env}" ` +
    `to the PEM contents, or set source.github_app_private_key_path / ` +
    `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE to a file containing the PEM.`,
    'auth_failure',
  );
}

/**
 * Resolve the GitHub API token for a given config.
 *
 * If GitHub App credentials are present (`source.github_app_id`), a fresh
 * installation token is minted via the App's private key. Otherwise falls back
 * to the PAT from `config.github_token()`.
 *
 * The private key PEM is resolved via `_resolve_private_key_pem`: an inline
 * env var (named by `source.github_app_private_key_env`, default
 * `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY`) takes precedence; otherwise a
 * file path (`source.github_app_private_key_path` or
 * `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE`) is read. The PEM itself is
 * never stored on the config object — only the env var name / file path are.
 *
 * @param {object} config - Loaded triage config
 * @returns {Promise<string|null>} Token string, or null if no credentials are configured
 */
export async function _resolve_token(config) {
  const src = config.source ?? {};
  if (src.github_app_id) {
    const private_key_pem = await _resolve_private_key_pem(src);
    return mint_installation_token({
      app_id: src.github_app_id,
      private_key_pem,
      installation_id: src.github_app_installation_id,
    });
  }
  return config.github_token();
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Build the standard headers for every GitHub API request.
 *
 * @param {string} token
 * @param {string} [etag] - Optional ETag for conditional GET
 * @returns {Record<string,string>}
 */
function _headers(token, etag) {
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT_HEADER,
    [API_VERSION_HEADER]: API_VERSION,
    'User-Agent': `clagentic-triage/${_version}`,
  };
  if (etag) {
    h['If-None-Match'] = etag;
  }
  return h;
}

/**
 * Sleep for `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check rate-limit headers and sleep if remaining < 10.
 *
 * @param {Headers} headers
 * @returns {Promise<void>}
 */
async function _handleRateLimit(headers) {
  const remaining = parseInt(headers.get('X-RateLimit-Remaining') ?? '999', 10);
  if (remaining < 10) {
    const reset = parseInt(headers.get('X-RateLimit-Reset') ?? '0', 10);
    const now = Math.floor(Date.now() / 1000);
    const delay = Math.max(0, reset - now) * 1000 + 1000;
    console.warn(`[github adapter] rate limit low (${remaining} remaining); sleeping ${delay}ms`);
    await _sleep(delay);
  }
}

/**
 * Follow Link rel="next" pagination, accumulating results.
 * Stops when there is no next page or PER_REPO_SAFETY_CAP items are collected.
 *
 * @param {string} url          - Initial URL
 * @param {string} token        - GitHub token
 * @param {string} [cacheKey]   - Optional key to use for ETag cache
 * @returns {Promise<{ items: object[], status: number }>}
 *   status 304 means cached; items will be empty and caller should use cache.
 */
async function _fetchPaginated(url, token, cacheKey) {
  const items = [];
  let nextUrl = url;
  let firstPage = true;
  let pendingEtag = null;

  while (nextUrl && items.length < PER_REPO_SAFETY_CAP) {
    // Only send ETag on first page of a paginated series, and only if not expired.
    let etag;
    if (firstPage && cacheKey) {
      const entry = _etagCache.get(cacheKey);
      if (entry) {
        if (Date.now() - entry.cached_at > ETAG_CACHE_TTL_MS) {
          // TTL expired — evict and do a full re-fetch.
          _etagCache.delete(cacheKey);
        } else {
          etag = entry.etag;
        }
      }
    }
    const res = await globalThis.fetch(nextUrl, { headers: _headers(token, etag) });

    if (firstPage && res.status === 304) {
      // Still honour rate-limit headers on 304 responses — they count against the budget.
      await _handleRateLimit(res.headers);
      return { items: [], status: 304 };
    }

    await _handleRateLimit(res.headers);

    if (res.status === 401) {
      throw new AdapterError('GitHub token invalid or missing', 'auth_failure');
    }

    if (res.status === 403) {
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter) {
        throw new AdapterError(
          `GitHub API forbidden; rate limit exceeded. Retry-After: ${retryAfter}s`,
          'rate_limited',
        );
      }
      throw new AdapterError('GitHub API forbidden (403)', 'forbidden');
    }

    if (!res.ok) {
      // Non-2xx other than the above — caller decides whether to throw or continue
      return { items: [], status: res.status };
    }

    // Capture ETag from first page. We do NOT write the cache entry here —
    // the caller writes it only after normalization succeeds, so a 304 replay
    // can never return a stale empty result from a partially-written entry.
    // The etag is threaded back via the return value's pendingEtag field.
    if (firstPage && cacheKey) {
      const newEtag = res.headers.get('ETag');
      if (newEtag) {
        pendingEtag = newEtag;
      }
    }

    const page = await res.json();
    items.push(...(Array.isArray(page) ? page : [page]));

    // Follow Link: <url>; rel="next"
    const link = res.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
    firstPage = false;
  }

  return { items, status: 200, pendingEtag };
}

// ---------------------------------------------------------------------------
// Bot detection helpers (DD-005)
// ---------------------------------------------------------------------------

/**
 * Return true if a raw GitHub issue/PR payload represents a bot event.
 * Checks both payload.sender (webhook shape) and payload.user (REST shape).
 *
 * @param {object} payload
 * @param {string[]} allowList - Logins that are allowed through even if they look like bots
 * @returns {boolean}
 */
function _isBot(payload, allowList) {
  const senderLogin = payload.sender?.login ?? payload.user?.login ?? '';
  const senderType = payload.sender?.type ?? payload.user?.type ?? '';

  if (allowList.includes(senderLogin)) {
    return false;
  }

  return senderType === 'Bot' || senderLogin.endsWith('[bot]');
}

// ---------------------------------------------------------------------------
// Actor-association filtering (DD-008)
// ---------------------------------------------------------------------------

/**
 * Decide whether an event from a given actor should be processed, based on the
 * actor's GitHub `author_association` and the operator's configured allow/deny
 * login lists. This filter is ORTHOGONAL to the bot filter (DD-005): both apply,
 * and an event must pass both to be processed.
 *
 * Precedence (highest first):
 *   1. ignore_logins (deny) — always skipped, regardless of association.
 *   2. watch_logins (allow) — always processed, regardless of association.
 *   3. watch_associations bucket — processed only if the association is in the set.
 *
 * Fail-open on unknown association: a null/missing association is treated as
 * external (processed). A missing association on a real inbound event is far
 * more likely to be an external contributor than a trusted member, and the
 * conservative failure mode for a triage tool is to triage rather than silently
 * drop. See DD-008.
 *
 * @param {object} config
 * @param {object} actor
 * @param {string} [actor.author]                  - The actor's login.
 * @param {string|null} [actor.author_association] - GitHub author_association value.
 * @returns {boolean} true if the event should be processed.
 */
export function should_process_actor(config, { author = '', author_association = null } = {}) {
  const src = config.source ?? {};
  const ignoreLogins = src.ignore_logins ?? [];
  const watchLogins = src.watch_logins ?? [];
  const watchAssociations = src.watch_associations ?? [];

  // 1. Deny list wins over everything.
  if (author && ignoreLogins.includes(author)) {
    return false;
  }

  // 2. Allow list overrides the association bucket.
  if (author && watchLogins.includes(author)) {
    return true;
  }

  // 3. Fail-open on unknown/missing association — treat as external (process).
  if (author_association === null || author_association === undefined) {
    return true;
  }

  // 4. Association bucket check.
  return watchAssociations.includes(author_association);
}

/**
 * Extract the actor descriptor ({ author, author_association }) from a raw
 * GitHub issue/PR object (REST list item or webhook sub-object) for use with
 * should_process_actor.
 *
 * @param {object} raw
 * @returns {{ author: string, author_association: string|null }}
 */
function _actorOf(raw) {
  return {
    author: raw.user?.login ?? '',
    author_association: raw.author_association ?? null,
  };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw GitHub issue or pull_request payload to the Event schema.
 *
 * @param {object} raw          - Raw object from GitHub REST or webhook payload
 * @param {string} repo         - "owner/repo" string
 * @param {string|null} [forceType] - Override type detection: 'pr' or 'issue'.
 *   Webhook callers pass this explicitly because the webhook event type header, not
 *   the presence of `raw.pull_request`, determines whether the item is a PR.
 * @param {string|null} [defaultBranch] - The repo's default branch name, when known
 *   (webhook callers read it from `payload.repository.default_branch`; poll callers
 *   pass it from `get_default_branch`). Carried in metadata so callers can detect
 *   "merged to default branch" without a second lookup. null when not resolved.
 * @param {string|null} [webhookAction] - The webhook payload's top-level `action`
 *   field (e.g. 'opened', 'ready_for_review', 'closed'), when this Event was built
 *   from a webhook delivery (T10, lr-9e35). Poll-path callers pass null — REST
 *   list items carry no equivalent "what just happened" signal, only current
 *   state. Carried in metadata so lifecycle transitions that key off a specific
 *   webhook action (as opposed to current PR state) can read it without a second
 *   payload plumb-through.
 * @returns {object}    - Normalized Event
 */
function _normalize(raw, repo, forceType = null, defaultBranch = null, webhookAction = null) {
  const isPr = forceType !== null ? forceType === 'pr' : Boolean(raw.pull_request);
  const type = isPr ? 'pr' : 'issue';

  return {
    id: `${repo}#${raw.number}`,
    type,
    title: raw.title ?? '',
    body: raw.body ?? '',
    author: raw.user?.login ?? '',
    created_at: raw.created_at ?? '',
    url: raw.html_url ?? '',
    source: 'github',
    repo,
    number: raw.number,
    metadata: {
      node_id: raw.node_id ?? '',
      labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      author_association: raw.author_association ?? null,
      state: raw.state ?? '',
      updated_at: raw.updated_at ?? '',
      draft: isPr ? Boolean(raw.draft) : false,
      // Three possible shapes for "is this PR merged": the issues-list endpoint
      // nests it under raw.pull_request.merged_at; the webhook PR payload and
      // the pulls-list REST endpoint (list_merged_prs, T6/lr-d557) carry
      // merged_at directly on the object; raw.merged is a plain boolean some
      // callers may already have resolved. Check all three, most-specific first.
      merged: isPr ? Boolean(raw.pull_request?.merged_at ?? raw.merged_at ?? raw.merged) : false,
      head_ref: isPr ? (raw.head?.ref ?? '') : '',
      base_ref: isPr ? (raw.base?.ref ?? '') : '',
      default_branch: defaultBranch,
      webhook_action: webhookAction,
    },
  };
}

// ---------------------------------------------------------------------------
// list_events
// ---------------------------------------------------------------------------

/**
 * Apply the bot filter, actor-association filter, and per-author cap to a single
 * raw GitHub issue/PR object. Returns the normalized Event if it passes all
 * filters, or null if it should be dropped.
 *
 * Mutates authorCounts in place so the cap state accumulates across pages.
 *
 * @param {object} raw
 * @param {string} repo
 * @param {object} config
 * @param {string[]} allowBotLogins
 * @param {boolean} capEnabled
 * @param {number} authorCap
 * @param {Map<string, number>} authorCounts
 * @returns {object|null} Normalized Event or null
 */
function _filterAndNormalize(raw, repo, config, allowBotLogins, capEnabled, authorCap, authorCounts) {
  // DD-005 bot filter and DD-008 actor-association filter are orthogonal;
  // an item must pass both to be processed.
  if (_isBot(raw, allowBotLogins)) {
    return null;
  }
  if (!should_process_actor(config, _actorOf(raw))) {
    return null;
  }
  // Per-author cap: applied after the above filters so filtered events
  // do not count toward the cap for a given author.
  if (capEnabled) {
    const author = raw.user?.login ?? '';
    const count = authorCounts.get(author) ?? 0;
    if (count >= authorCap) {
      if (count === authorCap) {
        // Warn exactly once per author when the cap is first hit.
        console.warn(
          `[github adapter] per-author cap reached for "${author}" (${authorCap} events); skipping further events from this author this poll`,
        );
        // Increment so the warning fires only once.
        authorCounts.set(author, count + 1);
      }
      return null;
    }
    authorCounts.set(author, count + 1);
  }
  return _normalize(raw, repo);
}

/**
 * Return true if `repo` ("owner/repo") falls within the operator's configured
 * watch scope (`config.source.repos` / `config.source.org`), without making
 * any network call.
 *
 * This is the same scoping contract `_resolveRepos` enforces for polling,
 * expressed as a pure membership check so callers that only have a single
 * candidate repo (e.g. a cross-repo ref parsed out of release-note text,
 * T6/lr-d557's `applyReleaseTransition`) can validate it without listing
 * every repo the config resolves to:
 *
 *   - `source.repos` is an explicit list (not `['*']`): `repo` must appear in
 *     it verbatim, or as `org/name` once qualified with `source.org` for any
 *     unqualified entries — mirroring `_resolveRepos`'s own qualification step.
 *   - `source.repos` is `['*']` (the default): every repo is qualified by
 *     `source.org`; a repo is in scope only if its owner matches `source.org`.
 *     With no `source.org` set, nothing is in scope (fail closed — the operator
 *     has not told triage which org it watches).
 *
 * @param {object} config
 * @param {string} repo - "owner/repo" string to check
 * @returns {boolean}
 */
export function is_repo_in_watch_scope(config, repo) {
  const cfgRepos = config.source?.repos ?? ['*'];
  const org = config.source?.org ?? null;

  if (cfgRepos.includes('*')) {
    if (!org) {
      return false;
    }
    const [repoOwner] = repo.split('/');
    return repoOwner === org;
  }

  const qualified = cfgRepos.map((r) => (org && !r.includes('/') ? `${org}/${r}` : r));
  return qualified.includes(repo);
}

/**
 * Resolve the list of "owner/repo" strings to query, expanding the `['*']`
 * wildcard against `config.source.org` when needed.
 *
 * Extracted from `list_events` so `list_merged_prs`/`list_releases` callers
 * (via `list_lifecycle_events`) share the exact same repo-scoping semantics —
 * an explicit `source.repos` list is used as-is (never expanded to the full
 * org), matching the existing "operator scoped the watch" contract.
 *
 * @param {object} config
 * @param {string} token
 * @returns {Promise<string[]|null>} resolved repo list, or null on auth failure
 *   while expanding the org wildcard.
 */
async function _resolveRepos(config, token) {
  const cfgRepos = config.source?.repos ?? ['*'];
  if (cfgRepos.includes('*')) {
    if (!config.source?.org) {
      throw new AdapterError(
        "source.repos=['*'] requires source.org to be set — cannot list all repos without an org",
      );
    }
    return _listOrgRepos(config.source.org, token);
  }
  // Explicit repo list: qualify unqualified names with org if present.
  const org = config.source?.org;
  return cfgRepos.map((r) => (org && !r.includes('/') ? `${org}/${r}` : r));
}

/**
 * List open issues and PRs updated since `since`.
 *
 * Pagination strategy: fetches one page at a time and applies the bot filter,
 * actor-association filter, and per-author cap after each page. This prevents a
 * single high-volume author from consuming the entire fetch budget before
 * legitimate events from other contributors are seen.
 *
 * Stops fetching for a repo when:
 * - No more pages (Link rel="next" exhausted), OR
 * - The post-filter accumulated count reaches max_events_per_repo_per_poll
 *
 * ETag caching still applies for the single-page (first page 304) case. When
 * paginating past page 1, the ETag path is bypassed — ETags are per-repo, not
 * per-page, so a 304 on page 1 means the entire result set is unchanged; we
 * replay from cache rather than paginating.
 *
 * Behavior on errors:
 * - 401: returns [] with a warning (adapter must not throw on auth failure per spec)
 * - Other non-2xx for a single repo: returns [] for that repo; continues
 * - repos=['*'] without an org: throws AdapterError
 *
 * @param {object} config
 * @param {string} [since]  - ISO 8601 timestamp (optional; omit to fetch all open items)
 * @returns {Promise<object[]>} Normalized Event[]
 */
export async function list_events(config, since) {
  // Validate `since` when provided. Null/undefined/empty string are allowed
  // (callers may omit it). Non-string values or strings that do not start with a
  // recognizable ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SS…) are rejected.
  if (since !== null && since !== undefined && since !== '') {
    if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(since)) {
      throw new AdapterError(
        `invalid since value: expected an ISO 8601 timestamp string (e.g. "2024-01-01T00:00:00Z"), got: ${JSON.stringify(since)}`,
        'invalid_since',
      );
    }
  }

  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty list');
    return [];
  }

  const allowBotLogins = config.source?.allow_bot_logins ?? [];

  // Per-author event cap for this poll window. Stateless: counts live only for
  // the duration of this list_events() call and are never persisted. 0 or null
  // means disabled.
  const authorCap = config.source?.max_events_per_author_per_poll ?? 20;
  const capEnabled = authorCap !== 0 && authorCap !== null;
  /** @type {Map<string, number>} */
  const authorCounts = new Map();

  // Per-repo post-filter cap: the maximum number of events that pass all filters
  // per repo per poll. Prevents any single repo from monopolizing the event
  // stream even when no single author dominates.
  const repoPostFilterCap = config.source?.max_events_per_repo_per_poll ?? 200;
  const repoCapEnabled = repoPostFilterCap !== 0 && repoPostFilterCap !== null;

  const repos = await _resolveRepos(config, token);
  if (repos === null) {
    // Auth failure from org listing
    return [];
  }

  const events = [];

  for (const repo of repos) {
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
    const page1Url = `${GITHUB_API}/repos/${repo}/issues?state=open&sort=updated&direction=desc${sinceParam}&per_page=100`;
    const cacheKey = `list_events:${repo}:${since ?? ''}`;

    try {
      // --- Page 1: single-page ETag-conditional fetch ---
      // The ETag cache operates per-repo (keyed to page 1's URL). A 304 means
      // the entire result set is unchanged — replay from cache rather than
      // paginating. Pages 2+ do not participate in ETag caching.

      let page1Etag;
      const entry = _etagCache.get(cacheKey);
      if (entry) {
        if (Date.now() - entry.cached_at > ETAG_CACHE_TTL_MS) {
          _etagCache.delete(cacheKey);
        } else {
          page1Etag = entry.etag;
        }
      }

      const page1Res = await globalThis.fetch(page1Url, { headers: _headers(token, page1Etag) });
      await _handleRateLimit(page1Res.headers);

      if (page1Res.status === 304) {
        // Cache stores already-normalized events. Re-apply bot and actor filters
        // in case config.source.allow_bot_logins or config.source.ignore_logins
        // changed since the entry was written.
        const cached = _etagCache.get(cacheKey);
        const cachedItems = cached?.result ?? [];
        for (const event of cachedItems) {
          if (_isBot({ user: { login: event.author, type: '' } }, allowBotLogins)) {
            continue;
          }
          if (
            !should_process_actor(config, {
              author: event.author,
              author_association: event.metadata?.author_association ?? null,
            })
          ) {
            continue;
          }
          if (capEnabled) {
            const count = authorCounts.get(event.author) ?? 0;
            if (count >= authorCap) {
              if (count === authorCap) {
                // Warn exactly once per author when the cap is first hit.
                console.warn(
                  `[github adapter] per-author cap reached for "${event.author}" (${authorCap} events); skipping further events from this author this poll`,
                );
                // Increment so the warning fires only once.
                authorCounts.set(event.author, count + 1);
              }
              continue;
            }
            authorCounts.set(event.author, count + 1);
          }
          events.push(event);
        }
        continue;
      }

      if (page1Res.status === 401) {
        throw new AdapterError('GitHub token invalid or missing', 'auth_failure');
      }
      if (page1Res.status === 403) {
        const retryAfter = page1Res.headers.get('Retry-After');
        if (retryAfter) {
          throw new AdapterError(
            `GitHub API forbidden; rate limit exceeded. Retry-After: ${retryAfter}s`,
            'rate_limited',
          );
        }
        throw new AdapterError('GitHub API forbidden (403)', 'forbidden');
      }
      if (!page1Res.ok) {
        console.warn(
          `[github adapter] non-2xx response (${page1Res.status}) for repo ${repo}; skipping`,
        );
        continue;
      }

      // Capture the ETag from page 1 for cache write-back after normalization.
      const pendingEtag = page1Res.headers.get('ETag') ?? null;

      // Parse page 1 body and extract the Link: rel="next" URL.
      const page1Body = await page1Res.json();
      const page1Items = Array.isArray(page1Body) ? page1Body : [page1Body];
      const page1Link = page1Res.headers.get('Link') ?? '';
      const page1NextMatch = page1Link.match(/<([^>]+)>;\s*rel="next"/);
      let nextPageUrl = page1NextMatch ? page1NextMatch[1] : null;

      // --- Post-filter pagination loop ---
      // normalized accumulates passing events for ETag cache write-back.
      const normalized = [];

      /**
       * Process a page of raw items through all filters, accumulating passing
       * events into normalized[]. Returns false when the repo post-filter cap
       * is reached so the caller can stop fetching further pages.
       *
       * @param {object[]} rawItems
       * @returns {boolean} true to continue fetching, false if repo cap hit
       */
      const processPage = (rawItems) => {
        for (const raw of rawItems) {
          if (repoCapEnabled && normalized.length >= repoPostFilterCap) {
            return false;
          }
          const event = _filterAndNormalize(
            raw, repo, config, allowBotLogins, capEnabled, authorCap, authorCounts,
          );
          if (event !== null) {
            normalized.push(event);
          }
        }
        return !(repoCapEnabled && normalized.length >= repoPostFilterCap);
      };

      let shouldContinue = processPage(page1Items);

      // Follow Link rel="next" pages, one at a time, until the post-filter cap
      // is reached or there are no more pages.
      while (nextPageUrl && shouldContinue) {
        // Pages 2+ are fetched without ETag headers — ETags are per-URL and
        // page 1's ETag covers the canonical resource, not individual pages.
        const res = await globalThis.fetch(nextPageUrl, { headers: _headers(token) });
        await _handleRateLimit(res.headers);

        if (res.status === 401) {
          throw new AdapterError('GitHub token invalid or missing', 'auth_failure');
        }
        if (res.status === 403) {
          const retryAfter = res.headers.get('Retry-After');
          if (retryAfter) {
            throw new AdapterError(
              `GitHub API forbidden; rate limit exceeded. Retry-After: ${retryAfter}s`,
              'rate_limited',
            );
          }
          throw new AdapterError('GitHub API forbidden (403)', 'forbidden');
        }
        if (!res.ok) {
          // Non-2xx on a continuation page — stop paginating for this repo.
          break;
        }

        const pageBody = await res.json();
        const rawItems = Array.isArray(pageBody) ? pageBody : [pageBody];
        shouldContinue = processPage(rawItems);

        // Follow Link rel="next"
        const link = res.headers.get('Link') ?? '';
        const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
        nextPageUrl = nextMatch ? nextMatch[1] : null;
      }

      // Persist normalized events into the ETag cache so a subsequent 304 can
      // replay them without re-normalizing. The entry is written here — after
      // normalization succeeds — not inside _fetchPaginated, so the cache never
      // contains a stale empty result from a partially-processed fetch.
      if (pendingEtag) {
        _etagCache.set(cacheKey, {
          etag: pendingEtag,
          result: normalized,
          cached_at: Date.now(),
        });
      }

      events.push(...normalized);
    } catch (err) {
      if (err instanceof AdapterError && err.code === 'auth_failure') {
        console.warn(`[github adapter] auth failure for repo ${repo}: ${err.message}`);
        return [];
      }
      console.warn(`[github adapter] error fetching repo ${repo}: ${err.message}`);
      continue;
    }
  }

  return events;
}

/**
 * List all repos for an org (up to 100 per page, paginated).
 * Returns an array of "owner/repo" strings, or null on auth failure.
 *
 * @param {string} org
 * @param {string} token
 * @returns {Promise<string[]|null>}
 */
async function _listOrgRepos(org, token) {
  const url = `${GITHUB_API}/orgs/${org}/repos?per_page=100`;
  let result;
  try {
    result = await _fetchPaginated(url, token, null);
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'auth_failure') {
      console.warn(`[github adapter] auth failure listing org repos for ${org}: ${err.message}`);
      return null;
    }
    throw err;
  }

  if (result.status !== 200) {
    console.warn(
      `[github adapter] non-2xx (${result.status}) listing repos for org ${org}; returning empty`,
    );
    return [];
  }

  return result.items.map((r) => r.full_name);
}

// ---------------------------------------------------------------------------
// get_default_branch (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * Fetch a repo's default branch name.
 *
 * The REST issues-list endpoint used by `list_events` does not include
 * repo-level fields like `default_branch`, so the poll path resolves it with a
 * dedicated call. The webhook path gets it for free from
 * `payload.repository.default_branch` (see `normalize_webhook`).
 *
 * @param {object} config
 * @param {string} repo - "owner/repo"
 * @returns {Promise<string|null>} default branch name, or null on failure
 */
export async function get_default_branch(config, repo) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${repo}`;

  const res = await globalThis.fetch(url, { headers: _headers(token) });
  if (!res.ok) {
    console.warn(`[github adapter] get_default_branch failed (${res.status}) for ${repo}`);
    return null;
  }

  const data = await res.json();
  return data.default_branch ?? null;
}

// ---------------------------------------------------------------------------
// list_merged_prs (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * List recently-merged, closed PRs for a repo (poll-path equivalent of the
 * `pull_request` webhook's merged-to-default signal).
 *
 * Filters to `state=closed` PRs with a non-null `merged_at`, sorted by
 * `updated` so the caller can bound how far back to look via `since`. The
 * default-branch check happens in the caller (lifecycle layer) using
 * `get_default_branch`, since this listing does not repeat that call per PR.
 *
 * @param {object} config
 * @param {string} repo    - "owner/repo"
 * @param {string} [since] - ISO 8601 timestamp; PRs updated before this are excluded
 * @returns {Promise<object[]>} Normalized PR Events (type='pr') with metadata.merged=true
 */
export async function list_merged_prs(config, repo, since) {
  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty list');
    return [];
  }

  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const url = `${GITHUB_API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc${sinceParam}&per_page=100`;

  let result;
  try {
    result = await _fetchPaginated(url, token, null);
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'auth_failure') {
      console.warn(`[github adapter] auth failure listing merged PRs for ${repo}: ${err.message}`);
      return [];
    }
    throw err;
  }

  if (result.status !== 200) {
    console.warn(
      `[github adapter] non-2xx (${result.status}) listing merged PRs for ${repo}; returning empty`,
    );
    return [];
  }

  const defaultBranch = await get_default_branch(config, repo);

  return result.items
    .filter((raw) => Boolean(raw.merged_at))
    .map((raw) => _normalize(raw, repo, 'pr', defaultBranch));
}

// ---------------------------------------------------------------------------
// list_open_prs (T10, lr-9e35)
// ---------------------------------------------------------------------------

/**
 * List open (unmerged) PRs for a repo — poll-path equivalent of the
 * `pull_request` webhook's `opened`/`ready_for_review` signals.
 *
 * The main poll path (`list_events`) already fetches open PRs via the
 * issues-list endpoint, but routes every result through the LLM-assessment
 * pipeline (`processEvent`) — appropriate for triaging a *new* issue/PR, but
 * wrong for the deterministic in-progress/in-review transitions, which must
 * never reach the assessor (same rule `list_merged_prs`/`list_releases`
 * follow). This is a dedicated pulls-list fetch, mirroring `list_merged_prs`'s
 * shape (`state=open` in place of `state=closed` + merged_at filter), so the
 * lifecycle poll cycle can source open PRs without repurposing/duplicating
 * `list_events`'s own filtering (bot/actor/cap logic that has no bearing on a
 * deterministic state transition).
 *
 * @param {object} config
 * @param {string} repo - "owner/repo"
 * @returns {Promise<object[]>} Normalized PR Events (type='pr'), metadata.merged=false
 */
export async function list_open_prs(config, repo) {
  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty list');
    return [];
  }

  const url = `${GITHUB_API}/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`;

  let result;
  try {
    result = await _fetchPaginated(url, token, null);
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'auth_failure') {
      console.warn(`[github adapter] auth failure listing open PRs for ${repo}: ${err.message}`);
      return [];
    }
    throw err;
  }

  if (result.status !== 200) {
    console.warn(
      `[github adapter] non-2xx (${result.status}) listing open PRs for ${repo}; returning empty`,
    );
    return [];
  }

  return result.items.map((raw) => _normalize(raw, repo, 'pr', null));
}

// ---------------------------------------------------------------------------
// list_releases (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * List published releases for a repo (poll-path equivalent of the `release`
 * webhook's `published` action).
 *
 * GitHub's `GET /repos/{owner}/{repo}/releases` only returns published
 * releases (drafts are excluded by the API itself unless the caller has push
 * access and asks for them explicitly via a different scope) — no extra
 * draft filter is needed here.
 *
 * @param {object} config
 * @param {string} repo - "owner/repo"
 * @returns {Promise<object[]>} Normalized Release Events (type='release')
 */
export async function list_releases(config, repo) {
  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty list');
    return [];
  }

  const url = `${GITHUB_API}/repos/${repo}/releases?per_page=100`;

  let result;
  try {
    result = await _fetchPaginated(url, token, null);
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'auth_failure') {
      console.warn(`[github adapter] auth failure listing releases for ${repo}: ${err.message}`);
      return [];
    }
    throw err;
  }

  if (result.status !== 200) {
    console.warn(
      `[github adapter] non-2xx (${result.status}) listing releases for ${repo}; returning empty`,
    );
    return [];
  }

  return result.items
    .filter((raw) => !raw.draft)
    .map((raw) => _normalizeRelease(raw, repo));
}

// ---------------------------------------------------------------------------
// list_lifecycle_events (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * Poll-path entry point for the three lifecycle-transition signals: merged
 * PRs, published releases, and open PRs (T10, lr-9e35 — in-progress/in-review
 * auto-transitions), across every repo `config.source` resolves to.
 *
 * Kept as a single function (rather than requiring the CLI poll loop to call
 * `list_merged_prs`/`list_releases`/`list_open_prs` per-repo itself) so the
 * repo-scoping logic (`_resolveRepos` — org-wildcard expansion vs an explicit
 * repo list) is exercised in exactly one place, matching `list_events`'s
 * existing contract.
 *
 * Does not apply the `since` timestamp for releases (`list_releases` has no
 * `since` parameter — GitHub's releases-list endpoint is small enough per repo
 * that `applyReleaseTransition`'s idempotent close/label calls make repeated
 * processing of already-released issues a no-op) but does pass it through to
 * `list_merged_prs`. `list_open_prs` also has no `since` parameter — every
 * still-open PR is re-observed each poll cycle, which is safe because
 * `applyPrOpenedTransition`/`applyPrReadyForReviewTransition` are idempotent
 * (T10, lr-9e35).
 *
 * @param {object} config
 * @param {string} [since] - ISO 8601 timestamp, passed through to list_merged_prs
 * @returns {Promise<{ mergedPrs: object[], releases: object[], openPrs: object[] }>}
 */
export async function list_lifecycle_events(config, since) {
  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty lifecycle lists');
    return { mergedPrs: [], releases: [], openPrs: [] };
  }

  const repos = await _resolveRepos(config, token);
  if (repos === null) {
    return { mergedPrs: [], releases: [], openPrs: [] };
  }

  const mergedPrs = [];
  const releases = [];
  const openPrs = [];

  for (const repo of repos) {
    try {
      const prs = await list_merged_prs(config, repo, since);
      mergedPrs.push(...prs);
    } catch (err) {
      console.warn(`[github adapter] error listing merged PRs for ${repo}: ${err.message}`);
    }

    try {
      const rels = await list_releases(config, repo);
      releases.push(...rels);
    } catch (err) {
      console.warn(`[github adapter] error listing releases for ${repo}: ${err.message}`);
    }

    try {
      const open = await list_open_prs(config, repo);
      openPrs.push(...open);
    } catch (err) {
      console.warn(`[github adapter] error listing open PRs for ${repo}: ${err.message}`);
    }
  }

  return { mergedPrs, releases, openPrs };
}

// ---------------------------------------------------------------------------
// list_issues_by_label (T10, lr-9e35)
// ---------------------------------------------------------------------------

/**
 * List open issues carrying a specific label, across every repo
 * `config.source` resolves to.
 *
 * Used by the stale needs-info auto-close sweep (src/stale.js) to find every
 * issue currently in the `status/needs-info` state without repurposing
 * `list_events`'s bot/actor-association/cap filtering — a deterministic
 * idle-close sweep must see every open needs-info issue regardless of who
 * commented on it last, unlike ordinary intake triage. GitHub's issues-list
 * endpoint accepts a `labels` query param natively (server-side AND filter for
 * comma-separated values; a single label here means server-side exact match).
 *
 * @param {object} config
 * @param {string} label - fully-namespaced label to filter by (e.g. "status/needs-info")
 * @returns {Promise<object[]>} Normalized Events (type='issue'), metadata.updated_at populated
 */
export async function list_issues_by_label(config, label) {
  const token = await _resolve_token(config);
  if (!token) {
    console.warn('[github adapter] no GitHub token configured; returning empty list');
    return [];
  }

  const repos = await _resolveRepos(config, token);
  if (repos === null) {
    return [];
  }

  const issues = [];
  for (const repo of repos) {
    const url = `${GITHUB_API}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`;
    try {
      const result = await _fetchPaginated(url, token, null);
      if (result.status !== 200) {
        console.warn(
          `[github adapter] non-2xx (${result.status}) listing "${label}" issues for ${repo}; returning empty`,
        );
        continue;
      }
      // The issues-list endpoint also returns PRs with the given label; filter
      // them out here since the stale-close sweep is issue-only (a PR's own
      // lifecycle is driven by the PR-event transitions, not needs-info).
      for (const raw of result.items) {
        if (raw.pull_request) {
          continue;
        }
        issues.push(_normalize(raw, repo, 'issue'));
      }
    } catch (err) {
      console.warn(`[github adapter] error listing "${label}" issues for ${repo}: ${err.message}`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// post_comment
// ---------------------------------------------------------------------------

/**
 * Post a comment on an issue or PR.
 * Works for both because GitHub's issues/{number}/comments endpoint accepts PRs.
 *
 * @param {object} config
 * @param {object} event   - Normalized Event
 * @param {string} body    - Markdown comment body
 * @returns {Promise<string>} URL of the created comment
 */
export async function post_comment(config, event, body) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}/comments`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    throw new AdapterError(`post_comment failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  _invalidate_cache(event.repo);
  return data.html_url;
}

// ---------------------------------------------------------------------------
// list_comments
// ---------------------------------------------------------------------------

/**
 * List all comments on an issue or PR.
 *
 * Used by idempotency checks (e.g. the status-callback route, T3) that need to
 * scan existing comments before posting a duplicate. Not part of the poll/webhook
 * ingress path — issue_comment events are already delivered via normalize_webhook.
 *
 * @param {object} config
 * @param {object} event - Normalized Event
 * @returns {Promise<object[]>} Raw GitHub comment objects (id, body, user, html_url, created_at)
 */
export async function list_comments(config, event) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}/comments?per_page=100`;

  const result = await _fetchPaginated(url, token, null);
  if (result.status !== 200) {
    throw new AdapterError(`list_comments failed: ${result.status}`);
  }
  return result.items;
}

// ---------------------------------------------------------------------------
// close_item
// ---------------------------------------------------------------------------

/**
 * Close an issue or PR.
 *
 * Issues: PATCH /repos/{owner}/{repo}/issues/{number} { state: 'closed', state_reason: 'not_planned' }
 * PRs:    PATCH /repos/{owner}/{repo}/pulls/{number}  { state: 'closed' }
 *
 * @param {object} config
 * @param {object} event - Normalized Event
 * @returns {Promise<void>}
 */
export async function close_item(config, event) {
  const token = await _resolve_token(config);

  let url;
  let patchBody;

  if (event.type === 'pr') {
    url = `${GITHUB_API}/repos/${event.repo}/pulls/${event.number}`;
    patchBody = { state: 'closed' };
  } else {
    url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}`;
    patchBody = { state: 'closed', state_reason: 'not_planned' };
  }

  const res = await globalThis.fetch(url, {
    method: 'PATCH',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  });

  if (!res.ok) {
    throw new AdapterError(`close_item failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// close_item_completed (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * Close an issue as genuinely resolved (`state_reason: 'completed'`), distinct
 * from `close_item`'s `not_planned` reason.
 *
 * `close_item` is used by the LLM-assessed `close` action class, where
 * `not_planned` is the correct semantic (the triage verdict was to reject/
 * decline the issue, not to say it shipped). The release lifecycle transition
 * (src/lifecycle.js) closes an issue because its fix was released — the
 * opposite meaning — so it needs its own method rather than overloading
 * `close_item`'s hardcoded reason. Issues only; PRs are already closed by the
 * merge that triggered this path.
 *
 * Idempotent: PATCHing state=closed on an already-closed issue is a no-op on
 * GitHub's side (no error), safe to call unconditionally.
 *
 * @param {object} config
 * @param {object} event - Normalized Event (issue shape: repo, number)
 * @returns {Promise<void>}
 */
export async function close_item_completed(config, event) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}`;

  const res = await globalThis.fetch(url, {
    method: 'PATCH',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });

  if (!res.ok) {
    throw new AdapterError(`close_item_completed failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// request_changes
// ---------------------------------------------------------------------------

/**
 * Submit a REQUEST_CHANGES review on a PR.
 * Throws AdapterError if called on a non-PR event.
 *
 * @param {object} config
 * @param {object} event   - Normalized Event (must be type='pr')
 * @param {string} body    - Review body
 * @returns {Promise<void>}
 */
export async function request_changes(config, event, body) {
  if (event.type !== 'pr') {
    throw new AdapterError(`request_changes is only valid for PRs; got type='${event.type}'`);
  }

  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/pulls/${event.number}/reviews`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'REQUEST_CHANGES', body }),
  });

  if (!res.ok) {
    throw new AdapterError(`request_changes failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// approve_pr
// ---------------------------------------------------------------------------

/**
 * Submit an APPROVE review on a PR.
 * Throws AdapterError if called on a non-PR event.
 *
 * @param {object} config
 * @param {object} event - Normalized Event (must be type='pr')
 * @returns {Promise<void>}
 */
export async function approve_pr(config, event) {
  if (event.type !== 'pr') {
    throw new AdapterError(`approve_pr is only valid for PRs; got type='${event.type}'`);
  }

  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/pulls/${event.number}/reviews`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'APPROVE' }),
  });

  if (!res.ok) {
    throw new AdapterError(`approve_pr failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// get_item_labels
// ---------------------------------------------------------------------------

/**
 * Fetch the current label set on an issue or PR.
 *
 * Used by callers that must enforce the single-status invariant
 * (src/labels.js enforceSingleStatus) against the item's live label state
 * rather than a possibly-stale local copy — e.g. the release-notify path (T3)
 * looks this up fresh before deciding which status/* label to remove.
 *
 * @param {object} config
 * @param {object} event - Normalized Event
 * @returns {Promise<string[]>} current label names
 */
export async function get_item_labels(config, event) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}`;

  const res = await globalThis.fetch(url, { headers: _headers(token) });

  if (!res.ok) {
    throw new AdapterError(`get_item_labels failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
}

// ---------------------------------------------------------------------------
// label_item
// ---------------------------------------------------------------------------

/**
 * Add labels to an issue or PR.
 *
 * @param {object}   config
 * @param {object}   event   - Normalized Event
 * @param {string[]} labels  - Labels to add
 * @returns {Promise<void>}
 */
export async function label_item(config, event, labels) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}/labels`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels }),
  });

  if (!res.ok) {
    throw new AdapterError(`label_item failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// unlabel_item
// ---------------------------------------------------------------------------

/**
 * Remove a single label from an issue or PR.
 *
 * GitHub returns 404 both when the item doesn't exist and when the label
 * isn't currently applied to it. The latter is treated as a no-op success
 * (idempotent removal) rather than an error — callers enforcing the
 * single-status invariant (src/labels.js) may attempt to remove a label
 * that was already removed by a prior call or never applied.
 *
 * @param {object} config
 * @param {object} event - Normalized Event
 * @param {string} label - Label name to remove
 * @returns {Promise<void>}
 */
export async function unlabel_item(config, event, label) {
  const token = await _resolve_token(config);
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}/labels/${encodeURIComponent(label)}`;

  const res = await globalThis.fetch(url, {
    method: 'DELETE',
    headers: _headers(token),
  });

  if (!res.ok && res.status !== 404) {
    throw new AdapterError(`unlabel_item failed: ${res.status} ${res.statusText}`);
  }

  _invalidate_cache(event.repo);
}

// ---------------------------------------------------------------------------
// Webhook interface methods
// ---------------------------------------------------------------------------

/**
 * Verify an inbound webhook delivery using the GitHub HMAC-SHA256 scheme.
 *
 * GitHub signs each delivery with `HMAC-SHA256(secret, rawBody)` and sends the
 * result as `sha256=<hex>` in the `x-hub-signature-256` header.
 * Comparison uses `crypto.timingSafeEqual` to prevent timing side-channels.
 * A missing signature header returns false up front. A length guard runs before
 * `timingSafeEqual` because Node throws on unequal-length buffers; it is a
 * correctness requirement, not a timing shortcut, since a length mismatch
 * already guarantees the signatures differ.
 *
 * @param {Buffer} rawBody   - The raw request body as a Buffer (before any parsing)
 * @param {object} headers   - Lowercase HTTP request headers object
 * @param {string} secret    - Webhook secret configured in GitHub
 * @returns {boolean}        - true if signature is valid
 */
export function verify_webhook(rawBody, headers, secret) {
  const sigHeader = headers['x-hub-signature-256'] ?? '';
  if (!sigHeader) {
    return false;
  }
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sigHeader, 'utf8');
  if (a.length !== b.length) {
    // Length mismatch means the signature cannot match; return false immediately.
    // This is not a timing leak: timingSafeEqual would throw on unequal lengths,
    // and we cannot pad without leaking information about the expected length.
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Extract the delivery ID from inbound webhook headers.
 * Used by the server for replay protection.
 *
 * GitHub sends a UUID in `x-github-delivery`. Other providers use different
 * headers or none — they return null, and the server skips replay checking.
 *
 * @param {object} headers - Lowercase HTTP request headers object
 * @returns {string|null}  - Delivery ID string, or null if not present
 */
export function get_delivery_id(headers) {
  return headers['x-github-delivery'] ?? null;
}

/**
 * Normalize a GitHub webhook payload to the standard Event schema.
 *
 * Supported GitHub event types (driven by the `x-github-event` header):
 *   issues, pull_request, issue_comment, pull_request_review
 *
 * For `issue_comment` and `pull_request_review`, the parent issue/PR fields are
 * sourced from `payload.issue` / `payload.pull_request` respectively, and the
 * body comes from the comment or review sub-object. This matches the shape
 * produced by `list_events` (poll path) so downstream pipeline stages see a
 * consistent Event schema regardless of ingress path.
 *
 * @param {object} headers  - Lowercase HTTP request headers object
 * @param {object} payload  - Parsed JSON webhook payload (already verified)
 * @returns {object|null}   - Normalized Event, or null if the event type is unsupported
 */
export function normalize_webhook(headers, payload) {
  const eventType = headers['x-github-event'] ?? '';
  const repo = payload.repository?.full_name ?? '';

  if (eventType === 'issues') {
    // payload.issue has the same shape as a REST list item; pass forceType='issue'
    // because issue webhook objects never carry a pull_request key.
    return _normalize(payload.issue ?? {}, repo, 'issue');
  }

  if (eventType === 'pull_request') {
    // payload.pull_request is the PR object, but lacks the REST-list's pull_request
    // sentinel field that _normalize uses to detect PRs. Pass forceType='pr'.
    // payload.repository.default_branch is carried into metadata so callers (T6,
    // lr-d557) can detect "merged to default branch" without a second API call —
    // the webhook payload already has it; the poll path resolves it separately
    // via get_default_branch since the REST issues-list endpoint does not include it.
    // payload.action ('opened', 'ready_for_review', 'closed', ...) is carried
    // through as metadata.webhook_action (T10, lr-9e35) so the auto-transition
    // layer (src/lifecycle.js) can key off the specific event that fired, not
    // just the PR's current state.
    const defaultBranch = payload.repository?.default_branch ?? null;
    return _normalize(payload.pull_request ?? {}, repo, 'pr', defaultBranch, payload.action ?? null);
  }

  if (eventType === 'issue_comment') {
    const issue = payload.issue ?? {};
    const comment = payload.comment ?? {};
    const isPr = Boolean(issue.pull_request);
    // Build a synthetic raw object that _normalize can process: use the issue
    // fields for structure, overlay comment body/author/created_at/url/node_id.
    const synthetic = {
      ...issue,
      body: comment.body ?? '',
      user: comment.user ?? issue.user,
      created_at: comment.created_at ?? issue.created_at,
      html_url: comment.html_url ?? issue.html_url,
      node_id: comment.node_id ?? issue.node_id,
      // Carry the association of the comment author if present, else fall back
      // to the parent issue/PR's association so the actor filter (DD-008) has a
      // signal to work with on the comment path.
      author_association: comment.author_association ?? issue.author_association ?? null,
    };
    return _normalize(synthetic, repo, isPr ? 'pr' : 'issue');
  }

  if (eventType === 'pull_request_review') {
    const pr = payload.pull_request ?? {};
    const review = payload.review ?? {};
    // Build a synthetic raw object using PR structure but review content.
    const synthetic = {
      ...pr,
      body: review.body ?? '',
      user: review.user ?? pr.user,
      created_at: review.submitted_at ?? pr.created_at,
      html_url: review.html_url ?? pr.html_url,
      node_id: review.node_id ?? pr.node_id,
      // Carry the review author's association if present, else the parent PR's.
      author_association: review.author_association ?? pr.author_association ?? null,
    };
    return _normalize(synthetic, repo, 'pr');
  }

  if (eventType === 'release') {
    // Only a published release (not draft creation/edit/deletion) advances the
    // lifecycle. GitHub sends this event for every release action
    // (published, unpublished, created, edited, deleted, released, prereleased);
    // "created" fires for both drafts and immediate publishes, so `published` is
    // the one unambiguous "this is now live" signal (also fired for prereleases).
    if (payload.action !== 'published') {
      return null;
    }
    return _normalizeRelease(payload.release ?? {}, repo);
  }

  // Unsupported event type — caller handles this case.
  return null;
}

/**
 * Normalize a raw GitHub release object (REST or webhook payload.release) to a
 * Release-shaped Event.
 *
 * Distinct `type: 'release'` — a release is not an issue or PR, so it does not
 * fit the issue/PR Event shape. Callers (T6, lr-d557) branch on `event.type`
 * before routing to the lifecycle transition, never into the LLM-assessment
 * pipeline (enrich/assess assume issue/PR content).
 *
 * @param {object} raw  - Raw GitHub release object
 * @param {string} repo - "owner/repo" string
 * @returns {object} Release Event
 */
function _normalizeRelease(raw, repo) {
  return {
    id: `${repo}#release-${raw.id}`,
    type: 'release',
    title: raw.name ?? raw.tag_name ?? '',
    body: raw.body ?? '',
    author: raw.author?.login ?? '',
    created_at: raw.created_at ?? '',
    url: raw.html_url ?? '',
    source: 'github',
    repo,
    number: null,
    metadata: {
      tag_name: raw.tag_name ?? '',
      target_commitish: raw.target_commitish ?? '',
      draft: Boolean(raw.draft),
      prerelease: Boolean(raw.prerelease),
      published_at: raw.published_at ?? null,
    },
  };
}

/**
 * Return true if an inbound webhook payload represents a bot sender.
 * Applies the same check as poll ingress (DD-005).
 *
 * Exported so the server can delegate bot-filtering to the adapter rather than
 * reimplementing the check itself.
 *
 * @param {object}   payload   - Parsed JSON webhook payload (already verified)
 * @param {string[]} allowList - Logins allowed through even if they look like bots
 * @returns {boolean}
 */
export function is_bot_sender(payload, allowList) {
  return _isBot(payload, allowList);
}

/**
 * Return true if a normalized webhook Event should be processed under the
 * actor-association filter (DD-008). The server calls this AFTER normalize_webhook
 * so the author and author_association are available on the Event.
 *
 * Exported so the provider-agnostic server can delegate actor-filtering to the
 * adapter rather than reaching into the Event schema itself, keeping the actor
 * policy co-located with the adapter that produced the association signal.
 *
 * @param {object} config - Loaded triage config
 * @param {object} event  - Normalized Event (from normalize_webhook)
 * @returns {boolean}
 */
export function actor_allowed(config, event) {
  return should_process_actor(config, {
    author: event.author ?? '',
    author_association: event.metadata?.author_association ?? null,
  });
}

// ---------------------------------------------------------------------------
// check_token_scopes (RT-006)
// ---------------------------------------------------------------------------

/**
 * Scopes that indicate a classic PAT is over-privileged for triage use.
 * Fine-grained tokens don't return x-oauth-scopes and are already scoped by
 * construction — they need no check here.
 */
const BROAD_SCOPES = new Set([
  'repo',
  'admin:org',
  'delete_repo',
  'write:packages',
  'admin:repo_hook',
]);

/**
 * Check whether the configured GitHub token carries overly broad OAuth scopes.
 *
 * Uses the GitHub root endpoint (GET https://api.github.com/) which returns
 * `x-oauth-scopes` in the response headers without consuming any rate-limit
 * budget. Fine-grained PATs do not return this header — their absence signals
 * that the token is already repository-scoped, so no warning is warranted.
 *
 * This function never throws. All error conditions are returned as
 * `{ ok: false, error: string }` so a scope-check failure cannot block startup.
 *
 * @param {object} config - Loaded triage config (must expose github_token())
 * @returns {Promise<
 *   | { ok: true, type: 'fine-grained', scopes: null }
 *   | { ok: true, type: 'classic', scopes: string[], warned: boolean }
 *   | { ok: false, error: string }
 * >}
 */
export async function check_token_scopes(config) {
  const token = await _resolve_token(config);
  if (!token) {
    return { ok: false, error: 'no token configured' };
  }

  try {
    const res = await globalThis.fetch(`${GITHUB_API}/`, {
      headers: _headers(token),
    });

    const scopeHeader = res.headers.get('x-oauth-scopes');

    // Fine-grained PATs do not set x-oauth-scopes. Treat absence as
    // already-scoped — no warning needed.
    if (scopeHeader === null) {
      return { ok: true, type: 'fine-grained', scopes: null };
    }

    // Classic token: parse the comma-separated scope list.
    const scopes = scopeHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const broadFound = scopes.filter((s) => BROAD_SCOPES.has(s));
    const warned = broadFound.length > 0;

    if (warned) {
      process.stderr.write(
        `[clagentic:triage] WARNING: GitHub token has broad scope(s): ${broadFound.join(', ')}. Consider using a fine-grained token scoped to specific repos. See docs/GITHUB_APP.md.\n`,
      );
    }

    return { ok: true, type: 'classic', scopes, warned };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// get_pr_closing_issues (T5, lr-6857)
// ---------------------------------------------------------------------------

/**
 * GraphQL query for a PR's `closingIssuesReferences` — the authoritative
 * same-repo closing set. REST has no equivalent endpoint (verified against
 * community #24706, cli/cli #10529): a PR merge only auto-closes issues in
 * the SAME repo via body keyword refs, and GraphQL is the only API surface
 * that exposes the resolved set directly, without re-implementing GitHub's
 * own keyword-parsing rules.
 */
const CLOSING_ISSUES_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100) {
          nodes {
            number
            title
            url
            state
            repository {
              owner { login }
              name
            }
          }
        }
      }
    }
  }
`;

/**
 * Closing-keyword regex, shared by the cross-repo body-parse supplement.
 * Matches "close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved"
 * (case-insensitive) followed by either a cross-repo `owner/repo#N` or a
 * bare same-repo `#N` reference.
 */
const CLOSING_KEYWORD_REF_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

/**
 * Parse a PR body for closing-keyword references (close/closes/closed/fix/
 * fixes/fixed/resolve/resolves/resolved followed by an issue reference).
 *
 * GitHub's automatic keyword-close behavior is SAME-REPO ONLY: a cross-repo
 * `owner/repo#N` reference in a closing-keyword position creates a link but
 * does NOT auto-close the target issue on merge. This function surfaces
 * cross-repo refs separately from same-repo refs so callers never conflate
 * "linked" with "will close" — same-repo truth should come from
 * `get_pr_closing_issues` (GraphQL), not from this body-parse.
 *
 * @param {string} body       - PR body/description text
 * @param {string} defaultRepo - "owner/repo" of the PR itself, used to label
 *   same-repo bare `#N` refs found in the body (for completeness; the
 *   authoritative same-repo closing set still comes from GraphQL).
 * @returns {{ sameRepoRefs: {owner: string, repo: string, number: number}[],
 *             crossRepoRefs: {owner: string, repo: string, number: number}[] }}
 */
export function parse_closing_keyword_refs(body, defaultRepo) {
  const [defaultOwner, defaultRepoName] = (defaultRepo ?? '').split('/');
  const sameRepoRefs = [];
  const crossRepoRefs = [];

  if (!body) {
    return { sameRepoRefs, crossRepoRefs };
  }

  // Reset lastIndex defensively: the regex is a module-level /g literal, and
  // an uncaught throw mid-iteration in a prior call could otherwise leave it
  // pointing mid-string for the next call.
  CLOSING_KEYWORD_REF_RE.lastIndex = 0;

  let match;
  while ((match = CLOSING_KEYWORD_REF_RE.exec(body)) !== null) {
    const [, owner, repo, numberStr] = match;
    const number = parseInt(numberStr, 10);

    if (owner && repo) {
      crossRepoRefs.push({ owner, repo, number });
    } else if (defaultOwner && defaultRepoName) {
      sameRepoRefs.push({ owner: defaultOwner, repo: defaultRepoName, number });
    }
  }

  return { sameRepoRefs, crossRepoRefs };
}

/**
 * Read a PR's reliable closing-issue links.
 *
 * Combines two sources, kept structurally distinct because they answer
 * different questions:
 *   - `closingIssues`: the same-repo closing set from GraphQL
 *     `closingIssuesReferences` — the authoritative source GitHub itself
 *     uses to decide what closes on merge. REST exposes no equivalent.
 *   - `crossRepoRefs`: cross-repo `owner/repo#N` closing-keyword references
 *     found by parsing the PR body. GitHub's keyword auto-close is same-repo
 *     only, so a cross-repo keyword ref LINKS the issue but does not close
 *     it — surfacing it separately prevents a caller from treating it as
 *     "will close" by mistake.
 *
 * Do not substitute commit-message parsing for either source: squash/merge
 * strategies make commit messages an unreliable carrier of the original PR
 * body's closing keywords.
 *
 * @param {object} config
 * @param {object} event - Normalized Event (type='pr'); event.repo is
 *   "owner/repo", event.number is the PR number.
 * @returns {Promise<{
 *   closingIssues: {owner: string, repo: string, number: number, title: string, url: string, state: string}[],
 *   crossRepoRefs: {owner: string, repo: string, number: number}[],
 * }>}
 */
export async function get_pr_closing_issues(config, event) {
  if (event.type !== 'pr') {
    throw new AdapterError(`get_pr_closing_issues is only valid for PRs; got type='${event.type}'`);
  }

  const token = await _resolve_token(config);
  const [owner, name] = event.repo.split('/');

  const res = await globalThis.fetch(GITHUB_GRAPHQL_API, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: CLOSING_ISSUES_QUERY,
      variables: { owner, name, number: event.number },
    }),
  });

  if (res.status === 401) {
    throw new AdapterError('GitHub token invalid or missing', 'auth_failure');
  }

  if (!res.ok) {
    throw new AdapterError(`get_pr_closing_issues failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  // GraphQL returns 200 with an `errors` array on query-level failures
  // (e.g. bad credentials can surface here instead of via HTTP status).
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const authError = data.errors.find((e) => e.type === 'UNAUTHORIZED' || e.type === 'FORBIDDEN');
    if (authError) {
      throw new AdapterError(`GitHub GraphQL auth failure: ${authError.message}`, 'auth_failure');
    }
    throw new AdapterError(
      `get_pr_closing_issues GraphQL error: ${data.errors.map((e) => e.message).join('; ')}`,
    );
  }

  const nodes = data.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
  const closingIssues = nodes.map((n) => ({
    owner: n.repository?.owner?.login ?? '',
    repo: n.repository?.name ?? '',
    number: n.number,
    title: n.title ?? '',
    url: n.url ?? '',
    state: n.state ?? '',
  }));

  const { crossRepoRefs } = parse_closing_keyword_refs(event.body, event.repo);

  return { closingIssues, crossRepoRefs };
}
