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

## How dispatchers are resolved

The loader (`src/dispatchers/index.js`) walks the `dispatchers` list and
resolves each entry to a module:

- **`module` set** — the path is validated before import (RT-009). Relative
  (`./...`, `../...`) and absolute (`/...`) paths must resolve to a location
  inside `process.cwd()` — traversal outside the project root is rejected and
  the entry is skipped with a warning. The resolved absolute path is what
  gets imported, so the validated path and the loaded path are always identical.
  Bare npm package names and scoped packages (`@scope/pkg`) are not filesystem
  paths and pass without confinement checks. The operator is trusting any loaded
  module; the core does not sandbox it.
- **`name` only** — resolves a bundled reference dispatcher at
  `./<name>.js` inside the dispatchers directory. The name is validated against
  `^[a-z][a-z0-9-]*$` first: a name containing slashes, dots, a leading hyphen,
  uppercase, or any path-traversal sequence is rejected and the entry is
  skipped. A config-supplied `name` can therefore never escape the dispatchers
  directory. To load anything that is not a bundled dispatcher, use `module`.

A dispatcher that fails to import, or that loads but does not export a
`create_task` function, is logged as a warning and skipped — it never crashes
the loader. The loader returns the resolved modules in config order.

## Running dispatchers

`dispatch(config, event, assessment)` loads the configured dispatchers and runs
`create_task` on each. Dispatchers are isolated from one another: it returns one
entry per dispatcher, either `{ name, result }` on success or `{ name, error }`
on failure, so a single throwing dispatcher does not stop the others. With an
empty `dispatchers` list it is a clean no-op returning `[]`.

## Reference dispatchers

clagentic:triage ships a small set of generic reference dispatchers. They are
examples of the interface, not a privileged list — any backend is equally
first-class once you point config at its module.

| Dispatcher | Status  | Notes                                   |
|---|---|---|
| `webhook`  | shipped | Generic outbound HTTP POST with optional HMAC-SHA256 signing |
| `noop`     | shipped | Logs only — dry-run; copy as a template |

### webhook dispatcher

POSTs a structured JSON payload to a configured URL on each dispatch event.

```json
{
  "dispatchers": [
    {
      "name": "webhook",
      "url": "https://example.com/triage-hook",
      "secret": "optional-hmac-secret",
      "timeout_ms": 5000
    }
  ]
}
```

- `url` — required. POST target.
- `secret` — optional. If set, adds `X-Clagentic-Signature: sha256=<HMAC-SHA256 hex>` to the request so the receiver can verify authenticity.
- `timeout_ms` — optional, default `5000`. Request is aborted after this many milliseconds.

The payload includes structured verdict fields only — raw issue/PR body and
context blocks are never sent.

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
