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
 * Resolve the GitHub API token for a given config.
 *
 * If GitHub App credentials are present (`source.github_app_id`), a fresh
 * installation token is minted via the App's private key. Otherwise falls back
 * to the PAT from `config.github_token()`.
 *
 * The PEM is read from the env var named by `source.github_app_private_key_env`
 * (default: `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY`) so it is never stored on
 * the config object.
 *
 * @param {object} config - Loaded triage config
 * @returns {Promise<string|null>} Token string, or null if no credentials are configured
 */
export async function _resolve_token(config) {
  const src = config.source ?? {};
  if (src.github_app_id) {
    const key_env = src.github_app_private_key_env ?? 'CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY';
    const private_key_pem = process.env[key_env];
    if (!private_key_pem) {
      throw new AdapterError(
        `GitHub App auth configured but env var "${key_env}" is not set or empty`,
        'auth_failure',
      );
    }
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
 * @returns {object}    - Normalized Event
 */
function _normalize(raw, repo, forceType = null) {
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
      draft: isPr ? Boolean(raw.draft) : false,
      merged: isPr ? Boolean(raw.pull_request?.merged_at ?? raw.merged) : false,
      head_ref: isPr ? (raw.head?.ref ?? '') : '',
      base_ref: isPr ? (raw.base?.ref ?? '') : '',
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

  // Resolve the list of repos to query.
  // When source.repos is explicit (not ['*']), use it directly — org is used
  // only to resolve the wildcard. This prevents enumerating all org repos when
  // the operator has scoped the watch to a specific list.
  let repos;
  const cfgRepos = config.source?.repos ?? ['*'];
  if (cfgRepos.includes('*')) {
    if (!config.source?.org) {
      throw new AdapterError(
        "source.repos=['*'] requires source.org to be set — cannot list all repos without an org",
      );
    }
    repos = await _listOrgRepos(config.source.org, token);
    if (repos === null) {
      // Auth failure from org listing
      return [];
    }
  } else {
    // Explicit repo list: qualify unqualified names with org if present.
    const org = config.source?.org;
    repos = cfgRepos.map((r) => (org && !r.includes('/') ? `${org}/${r}` : r));
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
    return _normalize(payload.pull_request ?? {}, repo, 'pr');
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

  // Unsupported event type — caller handles this case.
  return null;
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
