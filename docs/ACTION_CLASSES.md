# clagentic:triage — Action Classes

Authoritative reference for every action class the assessor can emit, which
event types (`issue`, `pr`) each is valid for, and what it does. This is the
single source of truth other docs and CLI help text point back to — see
`src/action_classes.js`, which encodes this same matrix in code so the CLI
pre-flight check (`clagentic-triage approve`/`override`) and the assessor's
re-route guard cannot drift from this table.

## Recurring confusion this doc exists to prevent

`approve` is a PR-only action class. For an **accepted issue**, the correct
class is `dispatch` (route it to a backend task system) or `respond` (post a
comment) — never `approve`. This has recurred both in human operator usage
and in LLM-suggested actions (see lr-4717, lr-757a69); the assessor prompt
constrains the model, and the execution boundary (`clagentic-triage approve`/
`override`) rejects the mismatch before it reaches the adapter.

## Matrix

| Class | issue | pr | What it does |
|---|:---:|:---:|---|
| `approve` | ✗ | ✓ | Submits a GitHub PR review with `event: 'APPROVE'`. PR-only — GitHub's review API has no issue equivalent. |
| `respond` | ✓ | ✓ | Posts a comment (`suggested_action.body`) on the issue or PR. |
| `request_changes` | ✗ | ✓ | Submits a GitHub PR review requesting changes, with `suggested_action.body` as the review comment. PR-only, same reason as `approve`. |
| `close` | ✓ | ✓ | Closes the item. Issues close with `state_reason: 'not_planned'`; PRs close without merging. |
| `dispatch` | ✓ | ✓ | Routes the item to every configured backend dispatcher (Jira, Linear, GitHub Issues, webhook, custom). The correct class for an **accepted issue** that should become a tracked task. See `docs/DISPATCHERS.md`'s [worked example](DISPATCHERS.md#worked-example-dispatching-accepted-issues-into-lore) for the full assess → `dispatch` → webhook dispatcher → external task path. |
| `escalate` | ✓ | ✓ | No adapter action — records the item in the pending queue for human review. Used when the assessor is uncertain or the LLM output failed validation (degraded assessment). |

## Multi-action verdicts

A single verdict may name more than one class (`suggested_action.classes` is
an array — see `docs/ARCHITECTURE.md`'s Assessment schema) so, for example,
an issue can be `respond`ed to and `dispatch`ed in one atomic step. Every
class named in a multi-action verdict must independently be valid for the
event's type — a verdict that names `approve` for an issue is invalid
regardless of what else is in the list.

## Where this is enforced

1. **Assessor prompt** (`src/assessor.js`) — instructs the model that
   `approve`/`request_changes` are PR-only, `dispatch` is the issue-side
   equivalent of PR approval (lr-4717).
2. **Execution boundary** (`src/cli.js`'s `cmdApprove`/`cmdOverride`, via
   `src/action_classes.js`'s `isActionClassValidForType`) — rejects a
   class/type mismatch before any adapter call, with a message naming the
   valid classes for that event's type. Fails early and legibly instead of
   surfacing a raw `AdapterError` from deep inside the adapter.
3. **Assessor re-route guard** (`src/assessor.js`'s `assess()`) — if the LLM
   itself emits an invalid class for the event's type (model non-compliance
   with rule 1 above), the assessment is downgraded to `verdict: 'escalate'`
   with every class filtered to the ones actually valid for that type, so the
   item is never silently stuck un-approvable in the queue. See
   `docs/DESIGN-DECISIONS.md` DD-017.
