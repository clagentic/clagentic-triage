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
module.exports = {
  name: 'myadapter',
  list_events(config, since) { },     // returns Promise<Event[]>
  post_comment(config, event, body) { },
  close_item(config, event) { },
  request_changes(config, event, body) { },
  approve_pr(config, event) { },
  label_item(config, event, labels) { }
}
```

`since` is an ISO timestamp string. Return only events newer than `since`.

The adapter must not throw on auth failure — return an empty array and log a warning.
