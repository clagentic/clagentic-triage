/**
 * Bundled hook: clagentic-console
 *
 * Fires when an assessment verdict is 'escalate'. Launches the
 * `clagentic-console` CLI as a detached child process and passes a brief
 * summary prompt via the --message flag (or stdin — configurable via
 * hookConfig.prompt_via).
 *
 * The hook is fire-and-forget: it does not wait for the console session to
 * complete and does not influence the pipeline outcome.
 *
 * Config keys (all optional):
 *   command    - CLI binary to invoke. Default: 'clagentic-console'
 *   args       - extra CLI arguments prepended before --message. Default: []
 *   prompt_via - how to pass the prompt: 'flag' (--message) or 'stdin'.
 *                Default: 'flag'
 */

import { spawn } from 'node:child_process';

/**
 * Build a concise escalation prompt from the event and assessment.
 *
 * @param {object} event
 * @param {object} assessment
 * @returns {string}
 */
export function buildPrompt(event, assessment) {
  const repo = event.repo ?? event.repository ?? '(unknown repo)';
  const number = event.number ?? event.id ?? '(unknown)';
  const title = event.title ?? '(no title)';
  const verdict = assessment.verdict ?? 'escalate';
  const confidence = typeof assessment.confidence === 'number'
    ? assessment.confidence.toFixed(2)
    : '?';
  const suggestedAction = Array.isArray(assessment.suggested_action?.classes)
    ? assessment.suggested_action.classes.join('+')
    : assessment.suggested_action ?? 'escalate';

  return (
    `Triage escalation: ${repo}#${number} — "${title}". ` +
    `Verdict: ${verdict} (confidence ${confidence}). ` +
    `Suggested action: ${suggestedAction}. ` +
    `Please review and determine the appropriate response.`
  );
}

/**
 * Hook entry point. Fires only on escalate verdicts.
 *
 * @param {object} event
 * @param {object} assessment
 * @param {object} [hookConfig]
 * @returns {Promise<{ skipped: true, reason: string } | { launched: true, pid: number }>}
 */
export async function run(event, assessment, hookConfig = {}) {
  if (assessment.verdict !== 'escalate') {
    return { skipped: true, reason: 'verdict is not escalate' };
  }

  const prompt = buildPrompt(event, assessment);
  const cmd = hookConfig.command ?? 'clagentic-console';
  const extraArgs = Array.isArray(hookConfig.args) ? hookConfig.args : [];
  const promptVia = hookConfig.prompt_via ?? 'flag';

  let args;
  let spawnOpts;

  if (promptVia === 'stdin') {
    args = [...extraArgs];
    spawnOpts = {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    };
  } else {
    // Default: pass prompt as --message argument.
    args = [...extraArgs, '--message', prompt];
    spawnOpts = {
      detached: true,
      stdio: 'ignore',
    };
  }

  const child = spawn(cmd, args, spawnOpts);

  if (promptVia === 'stdin') {
    // Suppress EPIPE — the child may exit before we finish writing (e.g. in
    // tests with a fast-exiting command). Fire-and-forget: we don't care.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  }

  // Detach so the parent process does not wait for the console session.
  child.unref();

  return { launched: true, pid: child.pid };
}
