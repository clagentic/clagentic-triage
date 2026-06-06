# clagentic:triage — Backend Dispatchers

Dispatchers push triage verdicts and actions into external task/ticket systems. Each dispatcher lives in `src/dispatchers/{name}.js`.

## Included dispatchers

| Dispatcher | Status | Notes |
|---|---|---|
| `lore` | planned | Creates lore tasks via CLI |
| `jira` | planned | Jira REST API |
| `linear` | planned | Linear GraphQL API |
| `github-issue` | planned | Opens/links GitHub issues as tasks |
| `webhook` | planned | Generic outbound webhook |
| `noop` | planned | Logs only — useful for dry-run |

## Writing a dispatcher

```js
module.exports = {
  name: 'mydispatcher',
  create_task(config, event, assessment) { },  // returns Promise<{id, url}>
  update_task(config, task_id, patch) { }       // returns Promise<void>
}
```

`assessment` is the full assessor output object. The dispatcher can use whatever fields it needs.

## Lore dispatcher notes

The lore dispatcher calls `lore task create` via shell, passing:
- Title derived from the event title
- Description synthesized by the assessor
- Project from `dispatchers[].project` config

It stores the returned task ID in the pending queue entry so follow-up updates can call `lore task update`.
