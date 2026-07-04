#!/usr/bin/env node
/**
 * CLI entry point for clagentic-triage.
 *
 * Hand-rolled argument parser — no external dep on commander or yargs.
 * Follows the clagentic CLI Naming Standard: binary is clagentic-triage,
 * env prefix is CLAGENTIC_TRIAGE_*, config at ~/.config/clagentic/triage/config.json.
 */

import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from './config/loader.js';
import { listItems, readAll, resolveItem, QueueError } from './queue.js';
import { runPipeline, processEvent } from './pipeline.js';
import { startWebhookServer } from './webhooks/server.js';
import { startStatusHookServer } from './status_hook.js';
import { dispatch } from './dispatchers/index.js';
import { check_token_scopes } from './adapters/github.js';
import { isMergedToDefaultBranch, applyMergeTransition, applyReleaseTransition } from './lifecycle.js';

// NOTE(RT-009): the `hooks` config field is stored but not yet dynamically
// imported. When hook module loading is implemented, apply _validate_module_path
// from src/dispatchers/index.js before any import() of operator-supplied hook
// module paths — same confinement rules as dispatcher modules.

// Action classes that modify repository state. An over-privileged PAT
// combined with any of these in auto_approve creates a significant blast radius.
const WRITE_ACTION_CLASSES = new Set(['respond', 'close', 'request_changes', 'approve', 'dispatch']);

/**
 * After a scope check, warn prominently when a broad-scope PAT is paired with
 * write auto_approve classes and the operator has not explicitly acknowledged
 * the risk via allow_overprivileged_token.
 *
 * Does NOT block startup — the right response is a loud, unmissable warning
 * so operators notice without breaking existing deployments that use broad
 * PATs intentionally.
 *
 * @param {object} scopeResult - Return value of check_token_scopes()
 * @param {object} config
 */
function _warnIfOverprivilegedWithWriteActions(scopeResult, config) {
  if (!scopeResult.ok || !scopeResult.warned) {
    return;
  }
  // App tokens are already scoped by installation — only warn for PAT deployments.
  if (config.source?.github_app_id) {
    return;
  }
  const hasWriteAutoAction = (config.auto_approve ?? []).some((c) => WRITE_ACTION_CLASSES.has(c));
  if (!hasWriteAutoAction) {
    return;
  }
  if (config.allow_overprivileged_token) {
    return;
  }
  process.stderr.write(
    '[clagentic:triage] WARNING: over-privileged GitHub token is paired with write auto_approve ' +
    `classes (${(config.auto_approve ?? []).filter((c) => WRITE_ACTION_CLASSES.has(c)).join(', ')}). ` +
    'A compromised or stolen token can take write actions across every repo in scope. ' +
    'Switch to a fine-grained token scoped to specific repos (see docs/GITHUB_APP.md), or set ' +
    '"allow_overprivileged_token": true in your config to silence this warning if this is intentional.\n',
  );
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse process.argv into { command, args, flags }.
 * flags is a Map of flagName -> value (boolean true for bare flags).
 *
 * @param {string[]} argv  - process.argv
 * @returns {{ command: string, args: string[], flags: Map<string,string|boolean> }}
 */
function parseArgv(argv) {
  // argv[0] = node binary, argv[1] = script path
  const tokens = argv.slice(2);
  const flags = new Map();
  const positional = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i += 2;
      } else {
        flags.set(name, true);
        i += 1;
      }
    } else {
      positional.push(tok);
      i += 1;
    }
  }

  const command = positional[0] ?? 'help';
  const args = positional.slice(1);
  return { command, args, flags };
}

// ---------------------------------------------------------------------------
// Config loading helper
// ---------------------------------------------------------------------------

/**
 * Load config, treating a missing config file gracefully when no explicit
 * --config path was given (e.g. for review/approve/reject commands that only
 * need the queue path from defaults).
 *
 * @param {Map<string,string|boolean>} flags
 * @returns {Promise<object>}
 */
async function getConfig(flags) {
  const configPath = flags.get('config');
  try {
    if (typeof configPath === 'string') {
      return await loadConfig({ configPath });
    }
    return await loadConfig();
  } catch (err) {
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(msg) {
  process.stdout.write(msg + '\n');
}

function err(msg) {
  process.stderr.write(msg + '\n');
}

/**
 * Format a single queue item as a human-readable summary line.
 *
 * @param {object} item
 * @returns {string}
 */
function formatItem(item) {
  const title = item.event?.title ?? item.event?.id ?? '(no title)';
  const verdict = item.assessment?.verdict ?? '(no verdict)';
  const confidence =
    typeof item.assessment?.confidence === 'number'
      ? item.assessment.confidence.toFixed(2)
      : '?';
  const reason = item.queue_reason ?? '(unknown)';
  return `[${item.id}] ${title}\n  verdict=${verdict} confidence=${confidence} reason=${reason} status=${item.status}`;
}

// ---------------------------------------------------------------------------
// Adapter loading
// ---------------------------------------------------------------------------

/**
 * Load the source adapter named by config and return it as a plain object.
 *
 * Spreads the full adapter module rather than cherry-picking methods. The
 * webhook server needs the webhook interface (verify_webhook, get_delivery_id,
 * normalize_webhook, is_bot_sender) in addition to the poll/action methods; a
 * hand-maintained subset silently drifts from the adapter interface and leaves
 * webhook methods undefined at runtime. Exported so the wiring contract can be
 * tested without spawning the CLI.
 *
 * @param {object} config
 * @returns {Promise<object>} the adapter (all named exports of the module)
 */
export async function loadAdapter(config) {
  const adapterModule = await import(`./adapters/${config.source.adapter}.js`);
  return { ...adapterModule };
}

// ---------------------------------------------------------------------------
// Event routing (T6, lr-d557)
// ---------------------------------------------------------------------------

/**
 * Route a single normalized Event to either a lifecycle transition (merged PR,
 * published release) or the LLM-assessment pipeline (issue/PR triage).
 *
 * Lifecycle events are deterministic state transitions, not something an LLM
 * should assess — they never reach enrich/assess (src/lifecycle.js docblock).
 * Both ingress paths (webhook `onEvent`, poll `tick`) call this single
 * function so the branch lives in exactly one place.
 *
 * @param {object} config
 * @param {object} event   - Normalized Event
 * @param {object} adapter - source adapter
 * @returns {Promise<object>} a summary object for logging — shape varies by branch
 */
export async function routeEvent(config, event, adapter) {
  if (event.type === 'release') {
    const result = await applyReleaseTransition(config, adapter, event);
    return { kind: 'release', event_id: event.id, ...result };
  }

  if (event.type === 'pr' && isMergedToDefaultBranch(event)) {
    const result = await applyMergeTransition(config, adapter, event);
    return { kind: 'merge', event_id: event.id, ...result };
  }

  const result = await processEvent(config, event, adapter);
  return { kind: 'triage', ...result };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdWatch(flags) {
  const config = await getConfig(flags);

  // RT-006: warn on over-privileged tokens before entering the loop.
  const scopeResult = await check_token_scopes(config);
  if (!scopeResult.ok) {
    err(`[clagentic:triage] WARNING: Could not verify GitHub token scopes: ${scopeResult.error}`);
  }
  _warnIfOverprivilegedWithWriteActions(scopeResult, config);

  const intervalSec = flags.has('interval')
    ? parseInt(flags.get('interval'), 10)
    : (config.source?.poll_interval_seconds ?? 60);
  const adapter = await loadAdapter(config);

  let webhookServer = null;
  let statusHookServer = null;

  // Webhook mode: if webhooks.enabled, start the inbound webhook server so that
  // real-time deliveries from GitHub feed directly into the pipeline.
  // The poll loop continues running in parallel as a fallback (e.g. for events
  // that arrived while the process was down). The webhook replay set de-dups
  // within the webhook path only; cross-path (webhook vs poll) dedup is the
  // pipeline's responsibility. Operators who want webhook-only delivery set
  // poll_interval_seconds to a large value.
  if (config.webhooks?.enabled) {
    const webhookOnEvent = async (event) => {
      const result = await routeEvent(config, event, adapter);
      if (result.kind === 'triage') {
        out(`[clagentic-triage] webhook event: id=${result.event_id} status=${result.status}`);
      } else {
        out(
          `[clagentic-triage] webhook lifecycle event: kind=${result.kind} id=${result.event_id} ` +
          `applied=${result.applied} issues=${result.issues.length}`,
        );
      }
    };
    webhookServer = await startWebhookServer(config, adapter, { onEvent: webhookOnEvent });
    const addr = webhookServer.address();
    out(`[clagentic-triage] webhook server started on ${addr.address}:${addr.port}`);
  }

  // Status-hook mode (T3, lr-f848): if status_hooks.enabled, start the inbound
  // "task shipped" callback server so any configured dispatcher backend can
  // report a task's terminal state back to the originating issue/PR.
  if (config.status_hooks?.enabled) {
    statusHookServer = await startStatusHookServer(config, adapter);
    const addr = statusHookServer.address();
    out(`[clagentic-triage] status-hook server started on ${addr.address}:${addr.port}`);
  }

  out(`[clagentic-triage] watch: polling every ${intervalSec}s. Ctrl-C to stop.`);

  const tick = async () => {
    try {
      const events = await adapter.list_events(config);
      const { dispatched, queued, errors } = await runPipeline(config, events, adapter);
      out(
        `[clagentic-triage] cycle: dispatched=${dispatched.length} queued=${queued.length} errors=${errors.length}`,
      );
    } catch (e) {
      err(`[clagentic-triage] cycle error: ${e.message}`);
    }

    // Lifecycle poll (T6, lr-d557): merged PRs and published releases are
    // deterministic transitions, not LLM-assessed — routed directly to
    // src/lifecycle.js, never through runPipeline/processEvent. Optional on
    // adapters that do not implement list_lifecycle_events (interface is
    // additive; other adapters may not have it yet).
    if (typeof adapter.list_lifecycle_events === 'function') {
      try {
        const { mergedPrs, releases } = await adapter.list_lifecycle_events(config);
        let appliedCount = 0;
        for (const event of [...mergedPrs, ...releases]) {
          const result = await routeEvent(config, event, adapter);
          if (result.applied) {
            appliedCount += 1;
          }
        }
        out(
          `[clagentic-triage] lifecycle cycle: merged_prs=${mergedPrs.length} releases=${releases.length} applied=${appliedCount}`,
        );
      } catch (e) {
        err(`[clagentic-triage] lifecycle cycle error: ${e.message}`);
      }
    }
  };

  await tick();
  const timer = setInterval(tick, intervalSec * 1000);

  // Single teardown handler tears down both the poll timer and (if running)
  // the webhook server.
  process.on('SIGINT', () => {
    clearInterval(timer);
    if (webhookServer) {
      webhookServer.close();
    }
    if (statusHookServer) {
      statusHookServer.close();
    }
    out('[clagentic-triage] watch: stopped.');
    process.exit(0);
  });
}

async function cmdRun(flags) {
  const config = await getConfig(flags);

  // RT-006: warn on over-privileged tokens before the run pass.
  const scopeResult = await check_token_scopes(config);
  if (!scopeResult.ok) {
    err(`[clagentic:triage] WARNING: Could not verify GitHub token scopes: ${scopeResult.error}`);
  }
  _warnIfOverprivilegedWithWriteActions(scopeResult, config);

  const adapter = await loadAdapter(config);

  const events = await adapter.list_events(config);
  const { dispatched, queued, errors } = await runPipeline(config, events, adapter);

  out(
    `[clagentic-triage] run complete: dispatched=${dispatched.length} queued=${queued.length} errors=${errors.length}`,
  );

  // Lifecycle poll (T6, lr-d557) — see cmdWatch's tick for the rationale on
  // routing these outside runPipeline.
  if (typeof adapter.list_lifecycle_events === 'function') {
    const { mergedPrs, releases } = await adapter.list_lifecycle_events(config);
    let appliedCount = 0;
    for (const event of [...mergedPrs, ...releases]) {
      const result = await routeEvent(config, event, adapter);
      if (result.applied) {
        appliedCount += 1;
      }
    }
    out(
      `[clagentic-triage] lifecycle run: merged_prs=${mergedPrs.length} releases=${releases.length} applied=${appliedCount}`,
    );
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

async function cmdReview(flags) {
  const config = await getConfig(flags);
  const statusArg = flags.get('status');
  const statusFilter = typeof statusArg === 'string' ? [statusArg] : ['pending'];

  const items = await listItems(config, { status: statusFilter });

  if (items.length === 0) {
    out(`No items with status: ${statusFilter.join(', ')}`);
    return;
  }

  out(`${items.length} item(s) with status: ${statusFilter.join(', ')}\n`);
  for (const item of items) {
    out(formatItem(item));
  }
}

async function cmdApprove(args, flags) {
  const id = args[0];
  if (!id) {
    err('Usage: clagentic-triage approve <id> [--config <path>]');
    process.exit(1);
  }

  const config = await getConfig(flags);

  // Read the item before resolving so we can inspect its action class.
  const all = await readAll(config);
  const item = all.find((i) => i.id === id);

  if (!item) {
    err(`No item found with id: ${id}`);
    process.exit(1);
  }

  const adapter = await loadAdapter(config);
  const actionClass = item.assessment?.suggested_action?.class;
  const body = item.assessment?.suggested_action?.body ?? '';
  let dispatchResults = null;

  // Execute the adapter action that was held for human approval.
  switch (actionClass) {
    case 'respond':
      await adapter.post_comment(config, item.event, body);
      break;
    case 'request_changes':
      await adapter.request_changes(config, item.event, body);
      break;
    case 'approve':
      await adapter.approve_pr(config, item.event);
      break;
    case 'close':
      await adapter.close_item(config, item.event);
      break;
    case 'dispatch':
      // Fire all configured dispatchers.
      dispatchResults = await dispatch(config, item.event, item.assessment);
      break;
    case 'escalate':
    default:
      // Nothing to execute — approval just records the human decision.
      break;
  }

  const updated = await resolveItem(config, id, { action: 'approved', dispatch_results: dispatchResults });
  out(`Approved and dispatched: ${updated.id} (action=${actionClass})`);
}

async function cmdOverride(args, flags) {
  const id = args[0];
  const actionClass = flags.get('action');

  if (!id) {
    err('Usage: clagentic-triage override <id> --action <class> [--config <path>]');
    process.exit(1);
  }
  if (typeof actionClass !== 'string') {
    err('--action <class> is required for override. Valid classes: respond, close, request_changes, dispatch, escalate, approve');
    process.exit(1);
  }

  const config = await getConfig(flags);

  // When the operator overrides to 'dispatch', run dispatchers before resolving
  // so the results are recorded on the queue entry.
  // dispatch() handles per-dispatcher errors internally — it never throws.
  let dispatchResults = null;
  if (actionClass === 'dispatch') {
    const all = await readAll(config);
    const item = all.find((i) => i.id === id);
    if (item) {
      dispatchResults = await dispatch(config, item.event, item.assessment);
    }
  }

  const updated = await resolveItem(config, id, {
    action: 'overridden',
    resolved_action_class: actionClass,
    dispatch_results: dispatchResults,
  });
  out(`Overridden: ${updated.id} (action_class=${updated.resolved_action})`);
}

async function cmdReject(args, flags) {
  const id = args[0];
  if (!id) {
    err('Usage: clagentic-triage reject <id> [--config <path>]');
    process.exit(1);
  }

  const config = await getConfig(flags);
  const updated = await resolveItem(config, id, { action: 'rejected' });
  out(`Rejected: ${updated.id}`);
}

function cmdHelp() {
  out(`clagentic-triage - LLM-powered triage agent

Usage:
  clagentic-triage watch [--config <path>] [--interval <seconds>]
    Start the poll loop. Ctrl-C to stop.

  clagentic-triage run [--config <path>]
    Single poll pass. Exits 0 on success, 1 on error.

  clagentic-triage review [--config <path>] [--status pending|approved|rejected|overridden]
    List pending queue items (default: pending).

  clagentic-triage approve <id> [--config <path>]
    Approve a pending item.

  clagentic-triage override <id> --action <class> [--config <path>]
    Override the suggested action. <class>: respond, close, request_changes, dispatch, escalate, approve

  clagentic-triage reject <id> [--config <path>]
    Reject a pending item.

  clagentic-triage help
    Print this usage message.

Environment:
  CLAGENTIC_TRIAGE_GITHUB_TOKEN        GitHub personal access token
  CLAGENTIC_TRIAGE_ADAPTER             Source adapter (github, gitlab, forgejo)
  CLAGENTIC_TRIAGE_ORG                 GitHub org to watch
  CLAGENTIC_TRIAGE_REPOS               Comma-separated repo list (default: *)
  CLAGENTIC_TRIAGE_MODEL               LLM model name
  CLAGENTIC_TRIAGE_RUNNER              LLM runner (claude-cli, anthropic-api, openai-compatible, clagentic-router)
  CLAGENTIC_TRIAGE_WEBHOOK_SECRET      Webhook HMAC secret (required when webhooks.enabled)
  CLAGENTIC_TRIAGE_WEBHOOK_PORT        Webhook server port (default: 8742)
  CLAGENTIC_TRIAGE_STATUS_HOOK_SECRET  Status-callback HMAC secret (required when status_hooks.enabled)
  CLAGENTIC_TRIAGE_STATUS_HOOK_PORT    Status-callback server port (default: 8743)
  CLAGENTIC_TRIAGE_RELEASE_COMMENT_TEMPLATE  Release-notice comment template (default: "Shipped in {version}: {task_url}")
  CLAGENTIC_TRIAGE_CONFIDENCE_THRESHOLD  Float 0-1 (default: 0.7)

Config file: ~/.config/clagentic/triage/config.json or triage.config.json in cwd
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { command, args, flags } = parseArgv(process.argv);

  try {
    switch (command) {
      case 'watch':
        await cmdWatch(flags);
        break;

      case 'run':
        await cmdRun(flags);
        break;

      case 'review':
        await cmdReview(flags);
        break;

      case 'approve':
        await cmdApprove(args, flags);
        break;

      case 'override':
        await cmdOverride(args, flags);
        break;

      case 'reject':
        await cmdReject(args, flags);
        break;

      case 'help':
      default:
        cmdHelp();
        break;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`[clagentic-triage] config error: ${e.message}`);
    } else if (e instanceof QueueError) {
      err(`[clagentic-triage] queue error: ${e.message} (${e.code})`);
    } else {
      err(`[clagentic-triage] error: ${e.message}`);
    }
    process.exit(1);
  }
}

// Run only when invoked directly as the CLI entry point — not when imported
// (e.g. by tests that exercise loadAdapter). argv[1] is the executed script.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
