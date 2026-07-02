# clagentic:triage — Source Adapters

Adapters normalize events from external platforms into the common Event schema. Each adapter lives in `src/adapters/{name}.js`.

## Included adapters

| Adapter | Status | Notes |
|---|---|---|
| `github` | shipped | GitHub REST API + webhook receiver |
| `gitlab` | planned | GitLab REST API |
| `forgejo` | planned | Forgejo/Gitea-compatible REST API |

## Writing an adapter

An adapter module must export:

```js
// src/adapters/myadapter.js — ESM
export const name = 'myadapter'

// --- Poll interface (required) ---
export async function list_events(config, since) { }              // returns Event[]
export async function post_comment(config, event, body) { }
export async function close_item(config, event) { }
export async function request_changes(config, event, body) { }
export async function approve_pr(config, event) { }
export async function label_item(config, event, labels) { }         // add labels
export async function unlabel_item(config, event, label) { }        // remove a single label
export async function get_item_labels(config, event) { }            // returns string[] — current labels
export async function list_comments(config, event) { }               // returns raw comment objects

// --- Webhook interface (required for inbound webhook server) ---
export function verify_webhook(rawBody, headers, secret) { }      // returns boolean
export function get_delivery_id(headers) { }                      // returns string|null
export function normalize_webhook(headers, payload) { }           // returns Event|null
export function is_bot_sender(payload, allowList) { }             // returns boolean
```

`since` is an ISO timestamp string. Return only events newer than `since`.

The adapter must not throw on auth failure from `list_events` — return an empty array and log a warning.

**`unlabel_item(config, event, label) -> void`**

Remove a single label from an item. Additive to the interface — `label_item` (add) and
`unlabel_item` (remove) are separate methods rather than one method with an add/remove flag,
so existing callers of `label_item` are unaffected. Implementations should treat "label not
currently applied" as an idempotent no-op, not an error, since callers enforcing the
single-status invariant (`src/labels.js`) may attempt to remove a label that is already absent.

**`get_item_labels(config, event) -> string[]`**

Fetch the item's current label set fresh from the backend. Used by callers (e.g.
`src/release_notify.js`, DD-013) that must enforce the single-status invariant against
live state rather than a possibly-stale local copy.

**`list_comments(config, event) -> object[]`**

List all comments on an item as raw provider objects. Used by idempotency checks (DD-013)
that need to scan for a prior marker before posting a duplicate comment. Not part of the
poll/webhook ingress path — new comments are already delivered as `issue_comment` events on
the GitHub webhook path.

### Webhook interface

The inbound webhook server (`src/webhooks/server.js`) is provider-agnostic. It delegates all
provider-specific logic to the adapter via the four webhook interface methods:

**`verify_webhook(rawBody, headers, secret) -> boolean`**

Verify the authenticity of an inbound delivery. The server calls this before parsing the body
or doing anything else with the payload. Returns `true` if the delivery is genuine.

Provider examples:
- GitHub: HMAC-SHA256 of the raw body, compared against `x-hub-signature-256` using `timingSafeEqual`.
- GitLab: plain-text token comparison against `x-gitlab-token`.
- Gitea: similar to GitLab; check `x-gitea-signature`.

The implementation MUST use a timing-safe comparison to prevent side-channel attacks.

**`get_delivery_id(headers) -> string|null`**

Extract a unique delivery identifier from the headers for replay protection.
Return `null` if the provider does not send a delivery ID — the server will skip replay
checking for that delivery.

Provider examples:
- GitHub: `x-github-delivery` (UUID per delivery).
- GitLab: no standard delivery ID — return `null`.

**`normalize_webhook(headers, payload) -> Event|null`**

Map a provider's raw webhook payload to the standard Event schema. The adapter reads
provider-specific headers (such as an event-type header) from `headers` internally.
Return `null` for event types the adapter does not support — the server will acknowledge
the delivery with a 200 and log it as unsupported.

This method should share normalization logic with the poll path (`list_events` / `_normalize`)
so the Event shape is identical regardless of ingress path.

**`is_bot_sender(payload, allowList) -> boolean`**

Return `true` if the webhook payload represents a bot sender (DD-005). The server
filters bot deliveries at ingress using this method, consistent with the poll path filter
in `list_events`. `allowList` is `config.source.allow_bot_logins`.

**`actor_allowed(config, event) -> boolean`** (optional)

Return `true` if a normalized Event should be processed under the actor-association
filter (DD-008). The server calls this AFTER `normalize_webhook`, so the Event's
`author` and `metadata.author_association` are available. Orthogonal to
`is_bot_sender` — both must pass. If an adapter does not export this method, the
server processes all (non-bot) events (no actor policy). The github adapter also
applies the same decision on the poll path inside `list_events`, and exports the
pure decision function `should_process_actor(config, { author, author_association })`.
