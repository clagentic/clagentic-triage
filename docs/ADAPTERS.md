# clagentic:triage — Source Adapters

Adapters normalize events from external platforms into the common Event schema. Each adapter lives in `src/adapters/{name}.js`.

## Included adapters

| Adapter | Status | Notes |
|---|---|---|
| `github` | planned | GitHub REST API + webhook receiver |
| `gitlab` | planned | GitLab REST API |
| `forgejo` | planned | Forgejo/Gitea-compatible REST API |

## Writing an adapter

An adapter module must export:

```js
// src/adapters/myadapter.js — ESM
export const name = 'myadapter'
export async function list_events(config, since) { }              // returns Event[]
export async function post_comment(config, event, body) { }
export async function close_item(config, event) { }
export async function request_changes(config, event, body) { }
export async function approve_pr(config, event) { }
export async function label_item(config, event, labels) { }
```

`since` is an ISO timestamp string. Return only events newer than `since`.

The adapter must not throw on auth failure — return an empty array and log a warning.
