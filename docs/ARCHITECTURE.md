# clagentic:triage — Architecture

## Overview

clagentic:triage is a pipeline that ingests inbound signals from external collaboration platforms (GitHub, GitLab, etc.), runs LLM-based triage assessment, and routes the result to one or more action targets.

The pipeline is intentionally human-in-the-loop by default. The LLM produces a verdict and suggested action. That suggestion either waits for human approval or executes automatically if `auto_approve` is enabled for that action class in config.

## Pipeline

```
Source (GitHub/GitLab/...)
  → Adapter (normalize to Event)
    → Enricher (fetch context: repo intent file, recent history, contributor profile)
      → Assessor (LLM: does this meet intent? what action?)
        → Router (map verdict → action class)
          → Approval gate (human OR auto, per action class config)
            → Dispatcher (Jira / Linear / GitHub Issues / webhook / ...)
              → Hook (optional: Slack, custom webhook, etc.)
```

## Interfaces

### Adapter

Every source adapter exports:

```js
{
  list_events(config, since)        // → Event[]
  post_comment(config, event, body) // → void
  close_item(config, event)         // → void
  request_changes(config, event, body) // → void
  approve_pr(config, event)         // → void
  label_item(config, event, labels) // → void
}
```

Event schema (normalized):

```js
{
  id: string,
  type: 'issue' | 'pr' | 'pr_comment' | 'issue_comment',
  title: string,
  body: string,
  author: string,
  created_at: string,
  url: string,
  source: string,          // adapter name, e.g. 'github'
  repo: string,            // owner/repo
  metadata: {}             // adapter-specific extras
}
```

### Assessor

The assessor takes an enriched event and a config-defined intent specification and returns:

```js
{
  verdict: 'accept' | 'needs_changes' | 'reject' | 'escalate' | 'defer',
  confidence: 0.0–1.0,
  reasoning: string,
  suggested_action: {
    class: 'approve' | 'respond' | 'request_changes' | 'close' | 'dispatch' | 'escalate',
    body: string | null,      // comment/response text if applicable
    dispatch_target: string | null,
    labels: string[]
  },
  model_used: string
}
```

### Dispatcher

Every backend dispatcher exports:

```js
{
  create_task(config, event, assessment) // → { id, url }
  update_task(config, task_id, patch)   // → void
}
```

### Hook

Optional integration hooks. Each hook exports:

```js
{
  name: string,
  on_assessment(config, event, assessment) // → void (fire and forget)
  on_action_taken(config, event, action)   // → void
}
```

## Model selection

The assessor respects `config.model`:
- If set to a bare model string (e.g. `claude-sonnet-4-5`), it calls that model directly via `claude` CLI.
- If set to `clagentic:router`, it delegates to the router service for chain selection.
- Default: `clagentic:router` if the router is reachable, else falls back to the configured fallback model.

## Human-in-the-loop

The approval gate checks `config.auto_approve[]`. Each entry is an action class (`approve`, `respond`, `close`, `dispatch`, `escalate`). If the assessed action class appears in `auto_approve`, it executes immediately. Otherwise the verdict is written to the pending queue for human review.

The pending queue is a simple JSONL file (or pluggable store) that a human reviews and approves/overrides via CLI or web UI.

## Dispatch hooks — universality

Hooks are config-declared modules. A hook module is any file/package that exports the hook interface above. The `clagentic:console` push hook is one example. A Slack notification hook is another. They are loaded dynamically from the hook paths declared in config — no built-in knowledge of any specific hook.

This means adding a new push target requires only:
1. Writing a module that exports the hook interface.
2. Declaring it in `config.hooks[]`.

No core changes required.
