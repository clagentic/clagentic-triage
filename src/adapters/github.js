/**
 * GitHub source adapter for clagentic:triage.
 *
 * Implements the standard adapter interface against the GitHub REST API.
 * Uses Node's built-in fetch (Node 20+). No external dependencies.
 *
 * Token is always sourced from config.github_token() — never hardcoded or
 * read from any other env var. The token is never logged or stored.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

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

/** @type {Map<string, { etag: string, result: object[] }>} */
const _etagCache = new Map();

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

  while (nextUrl && items.length < PER_REPO_SAFETY_CAP) {
    // Only send ETag on first page of a paginated series
    const etag = firstPage && cacheKey ? _etagCache.get(cacheKey)?.etag : undefined;
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

    // Capture ETag from first page for next call
    if (firstPage && cacheKey) {
      const newEtag = res.headers.get('ETag');
      if (newEtag) {
        // Placeholder — updated after we collect all pages
        _etagCache.set(cacheKey, { etag: newEtag, result: [] });
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

  return { items, status: 200 };
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
 * List open issues and PRs updated since `since`.
 *
 * Behavior on errors:
 * - 401: returns [] with a warning (adapter must not throw on auth failure per spec)
 * - Other non-2xx for a single repo: returns [] for that repo; continues
 * - repos=['*'] without an org: throws AdapterError
 *
 * @param {object} config
 * @param {string} since  - ISO 8601 timestamp
 * @returns {Promise<object[]>} Normalized Event[]
 */
export async function list_events(config, since) {
  const token = config.github_token();
  if (!token) {
    console.warn('[github adapter] CLAGENTIC_TRIAGE_GITHUB_TOKEN is not set; returning empty list');
    return [];
  }

  const allowBotLogins = config.source?.allow_bot_logins ?? [];

  // Resolve the list of repos to query
  let repos;
  if (config.source?.org) {
    repos = await _listOrgRepos(config.source.org, token);
    if (repos === null) {
      // Auth failure from org listing
      return [];
    }
  } else {
    const cfgRepos = config.source?.repos ?? ['*'];
    if (cfgRepos.includes('*')) {
      throw new AdapterError(
        "source.repos=['*'] requires source.org to be set — cannot list all repos without an org",
      );
    }
    repos = cfgRepos;
  }

  const events = [];

  for (const repo of repos) {
    const url = `${GITHUB_API}/repos/${repo}/issues?state=open&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=100`;
    const cacheKey = `list_events:${repo}:${since}`;

    try {
      const result = await _fetchPaginated(url, token, cacheKey);
      if (result.status === 304) {
        // Cache stores already-normalized events; push them directly.
        const cached = _etagCache.get(cacheKey);
        events.push(...(cached?.result ?? []));
        continue;
      }

      if (result.status !== 200) {
        console.warn(
          `[github adapter] non-2xx response (${result.status}) for repo ${repo}; skipping`,
        );
        continue;
      }

      // Normalize and filter the raw items for this repo.
      const normalized = [];
      for (const raw of result.items) {
        if (_isBot(raw, allowBotLogins)) {
          continue;
        }
        normalized.push(_normalize(raw, repo));
      }

      // Persist normalized events into the ETag cache entry so a subsequent
      // 304 can return them without re-normalizing.
      const cached = _etagCache.get(cacheKey);
      if (cached) {
        cached.result = normalized;
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
  const token = config.github_token();
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
  const token = config.github_token();

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

  const token = config.github_token();
  const url = `${GITHUB_API}/repos/${event.repo}/pulls/${event.number}/reviews`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'REQUEST_CHANGES', body }),
  });

  if (!res.ok) {
    throw new AdapterError(`request_changes failed: ${res.status} ${res.statusText}`);
  }
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

  const token = config.github_token();
  const url = `${GITHUB_API}/repos/${event.repo}/pulls/${event.number}/reviews`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'APPROVE' }),
  });

  if (!res.ok) {
    throw new AdapterError(`approve_pr failed: ${res.status} ${res.statusText}`);
  }
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
  const token = config.github_token();
  const url = `${GITHUB_API}/repos/${event.repo}/issues/${event.number}/labels`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { ..._headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels }),
  });

  if (!res.ok) {
    throw new AdapterError(`label_item failed: ${res.status} ${res.statusText}`);
  }
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
 * A length guard runs before `timingSafeEqual` because Node throws on unequal
 * buffer lengths — the guard is NOT a timing shortcut, the comparison terminates
 * via the signature-absent path above the caller when no header is present.
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
