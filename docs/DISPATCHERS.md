# clagentic:triage — Backend Dispatchers

Dispatchers push triage verdicts and actions into external task/ticket systems.
clagentic:triage is backend-agnostic by design: the core pipeline knows nothing
about any specific backend. A dispatcher is a small module that implements a
standard interface and is wired in by configuration — you plug in whichever
system you use (an issue tracker, a ticketing system, a task manager, an
internal tool, a plain webhook).

## Dispatcher interface

A dispatcher is an ESM module that exports a `name` plus one or both lifecycle
functions:

```js
// my-dispatcher.js — ESM
export const name = 'my-dispatcher';

// Create a task/ticket from a triage verdict. Returns { id, url }.
export async function create_task(config, event, assessment) { }

// Update an existing task (optional). Returns void.
export async function update_task(config, task_id, patch) { }
```

- `event` is the normalized event (issue/PR) the verdict was produced for.
- `assessment` is the full assessor output object — use whatever fields you need.
- The returned `{ id, url }` is stored on the pending-queue entry so later
  `update_task` calls can reference it.

The core never imports a dispatcher directly. Dispatchers are resolved at
runtime from the `dispatchers` config list, so adding a backend never requires
changing core code.

## Configuring dispatchers

```json
{
  "dispatchers": [
    { "name": "webhook", "url": "https://example.com/triage-hook" }
  ]
}
```

Each entry names a dispatcher and carries its own backend-specific config keys.
The pipeline runs cleanly with an empty `dispatchers` list (no dispatch).

## Reference dispatchers

clagentic:triage ships a small set of generic reference dispatchers. They are
examples of the interface, not a privileged list — any backend is equally
first-class once you point config at its module.

| Dispatcher | Status  | Notes                                   |
|---|---|---|
| `webhook`  | planned | Generic outbound HTTP POST              |
| `noop`     | planned | Logs only — useful for dry-run          |

Common ticketing backends (Jira, Linear, GitHub Issues, etc.) are implemented
as dispatchers using the same interface; see each integration's own
documentation.

## Third-party / private dispatchers

You are not limited to the bundled dispatchers. To plug in a backend that is not
part of this repo — including an internal or proprietary system — point a
`dispatchers` entry at any resolvable module path:

```json
{
  "dispatchers": [
    { "name": "my-tracker", "module": "@myscope/triage-dispatcher-my-tracker" }
  ]
}
```

The module must implement the interface above. This is the supported path for
internal tools: keep the dispatcher in your own package, outside this repo, and
load it by module path. The triage core stays generic and ships nothing
backend-specific.
