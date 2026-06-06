#!/usr/bin/env node
/**
 * CLI entry point for clagentic-triage.
 *
 * Hand-rolled argument parser — no external dep on commander or yargs.
 * Follows the clagentic CLI Naming Standard: binary is clagentic-triage,
 * env prefix is CLAGENTIC_TRIAGE_*, config at ~/.config/clagentic/triage/config.json.
 */

import { loadConfig, ConfigError } from './config/loader.js';
import { listItems, resolveItem, QueueError } from './queue.js';
import { runPipeline } from './pipeline.js';

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
    if (err instanceof ConfigError && typeof configPath !== 'string') {
      // No explicit config file and no project config — use bare defaults.
      // loadConfig always returns defaults when no files exist, so a
      // ConfigError here means something else (e.g. bad env var). Re-throw.
    }
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
// Commands
// ---------------------------------------------------------------------------

async function cmdWatch(flags) {
  const config = await getConfig(flags);
  const intervalSec = parseInt(flags.get('interval') ?? '60', 10);
  const { list_events } = await import(`./adapters/${config.source.adapter}.js`);
  const adapter = { list_events };

  out(`[clagentic-triage] watch: polling every ${intervalSec}s. Ctrl-C to stop.`);

  const tick = async () => {
    try {
      const events = await list_events(config);
      const { dispatched, queued, errors } = await runPipeline(config, events, adapter);
      out(
        `[clagentic-triage] cycle: dispatched=${dispatched.length} queued=${queued.length} errors=${errors.length}`,
      );
    } catch (e) {
      err(`[clagentic-triage] cycle error: ${e.message}`);
    }
  };

  await tick();
  const timer = setInterval(tick, intervalSec * 1000);

  process.on('SIGINT', () => {
    clearInterval(timer);
    out('[clagentic-triage] watch: stopped.');
    process.exit(0);
  });
}

async function cmdRun(flags) {
  const config = await getConfig(flags);
  const { list_events } = await import(`./adapters/${config.source.adapter}.js`);
  const adapter = { list_events };

  const events = await list_events(config);
  const { dispatched, queued, errors } = await runPipeline(config, events, adapter);

  out(
    `[clagentic-triage] run complete: dispatched=${dispatched.length} queued=${queued.length} errors=${errors.length}`,
  );

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
  const updated = await resolveItem(config, id, { action: 'approved' });
  out(`Approved: ${updated.id}`);
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
  const updated = await resolveItem(config, id, {
    action: 'overridden',
    resolved_action_class: actionClass,
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
  CLAGENTIC_TRIAGE_GITHUB_TOKEN   GitHub personal access token
  CLAGENTIC_TRIAGE_ADAPTER        Source adapter (github, gitlab, forgejo)
  CLAGENTIC_TRIAGE_ORG            GitHub org to watch
  CLAGENTIC_TRIAGE_REPOS          Comma-separated repo list (default: *)
  CLAGENTIC_TRIAGE_MODEL          LLM model name
  CLAGENTIC_TRIAGE_RUNNER         LLM runner (claude-cli, anthropic-api, openai-compatible, clagentic-router)
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

main();
