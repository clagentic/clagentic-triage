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

POSTs a JSON payload to a configured URL on each dispatch event. The webhook
dispatcher is the generic vehicle for routing triage verdicts into *any*
HTTP-addressable task/ticket system — see
["Worked example: dispatching accepted issues into LORE"](#worked-example-dispatching-accepted-issues-into-lore)
below for a full end-to-end config. No backend-specific dispatcher should be
written for a system reachable over HTTP; point a `webhook` config entry at
its API instead (this generic-dispatcher-over-backend-specific-code stance is
the same one behind `dispatch` being the only backend-facing action class —
see `docs/ACTION_CLASSES.md`).

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
- `secret` — optional. If set, adds `X-Clagentic-Signature: sha256=<HMAC-SHA256 hex>` to the request so the receiver can verify authenticity. Mutually exclusive with `auth`.
- `auth` — optional. Alternative to `secret` for backends that expect bearer-token auth instead of request signing:
  ```json
  { "auth": { "type": "bearer", "token_env": "INGEST_TOKEN" } }
  ```
  `token_env` names an environment variable holding the token (defaults to
  `INGEST_TOKEN` if omitted); the dispatcher reads it at dispatch time and
  sends `Authorization: Bearer <token>`. The token is never written to config
  or logs. If `auth.type` is `"bearer"` and the named env var is unset or
  empty, `create_task` throws before any network call.
- `payload` — optional. A field-mapping object that replaces the default fixed
  payload shape with your target system's body shape (see below). Omit it to
  keep the current fixed payload (`event_id`, `repo`, `type`, `author`, `url`,
  `verdict`, `confidence`, `reasoning`, `suggested_action`, `dispatched_at`) —
  this is the default and existing configs need no changes.
- `timeout_ms` — optional, default `5000`. Request is aborted after this many milliseconds.

#### Field mapping (`payload`)

Each key in `payload` names a key in the outbound JSON body; each value is a
template string resolved against the triage `event` and `assessment` objects
(the same shapes documented in `src/dispatchers/scaffold.js`):

```json
{
  "payload": {
    "title": "{{event.title}}",
    "project": "my-project",
    "description": "{{assessment.reasoning}}\n\n{{event.body}}",
    "source_url": "{{event.url}}"
  }
}
```

- `"{{path}}"` — a dot-separated path into `event` or `assessment`
  (`event.title`, `assessment.suggested_action.body`, ...). A value that is
  *exactly* one placeholder resolves to the field's native type (string,
  number, array) rather than a stringified version.
- A value with **no** `{{...}}` placeholder is sent as a literal
  (`"project": "my-project"` above).
- A value with a placeholder plus surrounding text, or more than one
  placeholder, is resolved as string interpolation
  (`"description"` above concatenates the assessment reasoning with the raw
  event body).
- An unresolvable path renders as `null` for a whole-string placeholder, or as
  `""` inside interpolated text.

By default the fixed payload never forwards `event.body` — it is untrusted
user content (see [Security model](../README.md#security-model)). A `payload`
mapping is an explicit, per-field, operator-configured opt-in: if you map
`event.body` into a target field (as the LORE example above does, folding it
into `description`), you are choosing to forward it to that specific
backend. Nothing else in the pipeline forwards it implicitly.

The payload includes structured verdict fields only — raw issue/PR body and
context blocks are never sent — *unless* a `payload` mapping explicitly opts
a field into `event.body`, as above.

Common ticketing backends (Jira, Linear, GitHub Issues, etc.) are implemented
as dispatchers using the same interface; see each integration's own
documentation.

#### Worked example: dispatching accepted issues into LORE

This is the concrete, end-to-end path from an accepted issue to a LORE task,
using nothing but the generic `webhook` dispatcher — no LORE-specific
dispatcher exists or should be written (locked decision: core triage knows no
backend; see `docs/ACTION_CLASSES.md`'s `dispatch` row).

1. **Assessment.** The assessor evaluates an inbound issue against repo
   intent and returns a verdict. For an issue it wants tracked as a task, the
   suggested action includes the `dispatch` class — the only class an
   *issue* dispatches through; `approve`/`request_changes` are PR-only (see
   `docs/ACTION_CLASSES.md`'s matrix and its "recurring confusion" note).
2. **Dispatch class fires dispatchers.** Once the verdict is approved (or
   auto-approved for `dispatch`), the pipeline runs every configured entry in
   `dispatchers` via `src/dispatchers/index.js`'s `dispatch()`.
3. **The `webhook` dispatcher runs**, mapping the event and assessment onto
   the exact body shape LORE's Archivist HTTP task API expects
   (`POST /api/tasks`, body `{project, title, description, priority, tags,
   assigned_to, created_by}`, `Authorization: Bearer <INGEST_TOKEN>`):

   ```json
   {
     "dispatchers": [
       {
         "name": "webhook",
         "url": "http://<archivist-host>:7490/api/tasks",
         "auth": { "type": "bearer", "token_env": "INGEST_TOKEN" },
         "payload": {
           "project": "clagentic-triage",
           "title": "{{event.title}}",
           "description": "{{assessment.reasoning}}\n\nSource: {{event.url}}\n\n{{event.body}}",
           "created_by": "clagentic-triage"
         }
       }
     ]
   }
   ```

   `<archivist-host>` is whatever host/port the operator's LORE Archivist
   instance is reachable at — this repo hardcodes no LORE-specific value
   anywhere; the URL and token env var are both operator config.
4. **Result.** LORE creates the task and returns its own `{id, url}`-shaped
   response body; the dispatcher stores `{ id: event.id, url }` on the pending
   queue entry (the `url` here is the *webhook target URL*, not a URL parsed
   out of LORE's response — see `create_task`'s return contract above if your
   backend's response needs a task URL echoed back instead).

The same pattern — one `webhook` entry, a `payload` mapping tailored to the
target's body shape, and either `auth` or `secret` for the target's auth
scheme — is how you route triage verdicts into *any* HTTP-addressable task
system, not just LORE. See ["How do I make triage create tasks in my
tracker?"](../README.md#documentation) in the README for the pointer back
here.

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

## Building a dispatcher

Use the scaffold at `src/dispatchers/scaffold.js` as your starting point. It
contains the full interface with every field documented inline.

### Steps

**1. Copy the scaffold**

```
cp src/dispatchers/scaffold.js /path/to/my-pkg/src/my-backend.js
```

The scaffold is self-contained — no imports from clagentic:triage core are
needed or expected.

**2. Rename and implement**

```js
export const name = 'my-backend'; // must match config "name" key

export async function create_task(config, event, assessment) {
  const cfg = config?.dispatchers?.find((d) => d.name === name) ?? {};
  // cfg holds your backend-specific keys (url, token_env, ...)
  const token = process.env[cfg.token_env ?? 'MY_BACKEND_TOKEN'];

  // Build your payload from structured fields — never include event.body
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `[triage] ${event.title ?? event.id}`,
      source_url: event.url,
      verdict: assessment.verdict,
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
    }),
  });
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  const data = await res.json();
  return { id: String(data.id), url: data.url ?? null };
}

// Optional — omit if your backend has no update concept
export async function update_task(config, task_id, patch) { }
```

**3. Register in config**

```json
{
  "dispatchers": [
    {
      "name": "my-backend",
      "module": "@myscope/triage-dispatcher-my-backend",
      "url": "https://my-backend.example.com/api/tasks",
      "token_env": "MY_BACKEND_TOKEN"
    }
  ]
}
```

Any keys in the config entry beyond `name` and `module` are available to your
dispatcher as `config.dispatchers.find(d => d.name === 'my-backend')`.

**4. Test**

Run `clagentic-triage run --dry-run` with `auto_approve: ["dispatch"]` in the
top-level config. Check that `create_task` is called with the expected event
shape and returns a `{ id, url }` object.

### Event and assessment fields

See the JSDoc in `src/dispatchers/scaffold.js` for the full field list with
types and null behavior. The key constraint: **never include `event.body` in
your backend payload**. The body is untrusted user content; only structured
fields extracted by the pipeline (title, url, repo, verdict, confidence, etc.)
are safe to forward.

### Naming convention

Published dispatcher packages should follow the pattern
`@scope/triage-dispatcher-<backend>` so they are discoverable and consistent
with the clagentic naming standard. The `name` export value should be
`<backend>` without any scope or prefix.
