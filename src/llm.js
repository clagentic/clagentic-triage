/**
 * LLM subprocess wrapper for clagentic:triage.
 *
 * All LLM calls go through callLlm(). No other module invokes the claude CLI
 * directly (DD-003).
 *
 * The claude binary is resolved via process.env.CLAUDE_PATH, then falls back
 * to 'claude' (relies on PATH). No absolute path is hardcoded.
 */

import { spawn as _nodeSpawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Fields that must be present in the LLM response JSON for a successful parse.
 */
const REQUIRED_FIELDS = ['verdict', 'confidence', 'reasoning', 'suggested_action'];

/**
 * Strict schema constraints on the LLM response payload (RT-007).
 * Type coercion bypasses the confidence threshold gate — all fields are
 * validated to exact types and enum values before the payload is returned.
 */
const VALID_VERDICTS = ['accept', 'needs_changes', 'reject', 'escalate', 'defer'];
const VALID_ACTION_CLASSES = [
  'approve', 'respond', 'request_changes', 'close', 'dispatch', 'escalate',
];

/**
 * Threshold above which a prompt is written to stdin rather than passed as
 * a --print argument. Keeps argv within safe limits on all platforms.
 */
const STDIN_THRESHOLD = 4_000;

// ---------------------------------------------------------------------------
// Spawn override (test injection)
// ---------------------------------------------------------------------------

/**
 * The spawn function used by _spawnClaude. Tests may override this via
 * _setSpawnFn() to inject a mock without touching the process environment.
 *
 * @type {Function}
 */
let _spawnFn = _nodeSpawn;

/**
 * Replace the spawn function. Call with no argument (or null) to reset to
 * the real Node spawn. Intended for tests only.
 *
 * @param {Function|null} fn
 */
export function _setSpawnFn(fn) {
  _spawnFn = fn ?? _nodeSpawn;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {'parse_error'|'timeout'|'exit_nonzero'|'missing_fields'|null} [code]
   */
  constructor(message, code) {
    super(message);
    this.name = 'LlmError';
    this.code = code ?? null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the claude CLI binary path. Checks CLAUDE_PATH env var first,
 * then falls back to bare 'claude' (resolved via PATH at exec time).
 *
 * @returns {string}
 */
function _claudeBin() {
  return process.env.CLAUDE_PATH || 'claude';
}

/**
 * Spawn the claude CLI and collect stdout/stderr.
 * Resolves with { stdout, stderr, code } regardless of exit status.
 *
 * When useStdin is true the prompt is written to the process's stdin and
 * --print is omitted from the arguments.
 *
 * @param {string}   prompt
 * @param {string}   model
 * @param {boolean}  useStdin
 * @param {number}   timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
function _spawnClaude(prompt, model, useStdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['--output-format', 'json'];

    if (model) {
      args.push('--model', model);
    }

    if (!useStdin) {
      args.push('--print', prompt);
    }

    const bin = _claudeBin();
    const child = _spawnFn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout, stderr, code: null, timedOut: true });
      } else {
        resolve({ stdout, stderr, code, timedOut: false });
      }
    });

    if (useStdin) {
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call the claude CLI and return parsed JSON from its stdout.
 *
 * @param {string} prompt          - The full prompt text
 * @param {object} [opts]
 * @param {string} [opts.model]    - Model identifier to pass via --model
 * @param {number} [opts.timeout_ms] - Timeout in milliseconds (default: 120000)
 * @returns {Promise<object>}      - Parsed JSON response from the LLM
 * @throws {LlmError}              - On timeout, non-zero exit, parse failure, or missing fields
 */
export async function callLlm(prompt, opts = {}) {
  const model = opts.model ?? null;
  const timeoutMs = typeof opts.timeout_ms === 'number' ? opts.timeout_ms : DEFAULT_TIMEOUT_MS;
  const useStdin = prompt.length > STDIN_THRESHOLD;

  let result;
  try {
    result = await _spawnClaude(prompt, model, useStdin, timeoutMs);
  } catch (spawnErr) {
    // spawn() itself threw — binary not found or similar OS-level error.
    throw new LlmError(`Failed to spawn claude CLI: ${spawnErr.message}`, 'exit_nonzero');
  }

  if (result.timedOut) {
    throw new LlmError('LLM call timed out', 'timeout');
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(0, 500) || '(no stderr)';
    throw new LlmError(`claude CLI exited with code ${result.code}: ${detail}`, 'exit_nonzero');
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const snippet = result.stdout.slice(0, 500);
    throw new LlmError(`LLM output is not valid JSON: ${snippet}`, 'parse_error');
  }

  // The claude CLI --output-format json wraps the response. If the result
  // contains a 'result' field that is a string, attempt to parse that as the
  // actual LLM JSON payload. This handles the CLI's envelope format.
  let payload = parsed;
  if (typeof parsed === 'object' && parsed !== null && typeof parsed.result === 'string') {
    try {
      payload = JSON.parse(parsed.result);
    } catch {
      const snippet = parsed.result.slice(0, 500);
      throw new LlmError(`LLM result field is not valid JSON: ${snippet}`, 'parse_error');
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
      throw new LlmError(
        `LLM response missing required field: ${field}`,
        'missing_fields',
      );
    }
  }

  // RT-007: Strict type and enum validation. Presence checks above are not
  // sufficient — a type-coerced confidence ("1.0" as string) bypasses the
  // threshold gate in the assessor. Validate everything before returning.
  if (!VALID_VERDICTS.includes(payload.verdict)) {
    throw new LlmError(
      `LLM response verdict "${payload.verdict}" is not a valid value. Expected one of: ${VALID_VERDICTS.join(', ')}`,
      'bad_response',
    );
  }

  if (typeof payload.confidence !== 'number' || payload.confidence < 0 || payload.confidence > 1) {
    throw new LlmError(
      `LLM response confidence must be a number between 0 and 1, got: ${JSON.stringify(payload.confidence)}`,
      'bad_response',
    );
  }

  if (typeof payload.reasoning !== 'string' || payload.reasoning.trim().length === 0) {
    throw new LlmError(
      'LLM response reasoning must be a non-empty string',
      'bad_response',
    );
  }

  if (typeof payload.suggested_action !== 'object' || payload.suggested_action === null) {
    throw new LlmError(
      'LLM response suggested_action must be an object',
      'bad_response',
    );
  }

  if (!VALID_ACTION_CLASSES.includes(payload.suggested_action.class)) {
    throw new LlmError(
      `LLM response suggested_action.class "${payload.suggested_action.class}" is not valid. Expected one of: ${VALID_ACTION_CLASSES.join(', ')}`,
      'bad_response',
    );
  }

  return payload;
}
