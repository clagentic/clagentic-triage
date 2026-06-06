/**
 * LLM runner dispatch for clagentic:triage.
 *
 * All LLM calls go through callLlm(). No other module invokes any LLM backend
 * directly (DD-003). The runner backend is selected via opts.runner or
 * config.runner (default: 'claude-cli').
 *
 * Supported runners: claude-cli, anthropic-api, openai-compatible, clagentic-router.
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

/**
 * Valid runner backend identifiers.
 */
export const VALID_RUNNERS = [
  'claude-cli',
  'anthropic-api',
  'openai-compatible',
  'clagentic-router',
];

// Module-level API endpoint constants. These are defaults only — config drives
// runner_url for openai-compatible and clagentic-router, so nothing is truly
// hardcoded into business logic.
const ANTHROPIC_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const CLAGENTIC_ROUTER_DEFAULT_URL = 'http://localhost:4200';

// ---------------------------------------------------------------------------
// Spawn override (test injection)
// ---------------------------------------------------------------------------

/**
 * The spawn function used by _runClaudeCli. Tests may override this via
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
   * @param {'parse_error'|'timeout'|'exit_nonzero'|'missing_fields'|'bad_response'|null} [code]
   */
  constructor(message, code) {
    super(message);
    this.name = 'LlmError';
    this.code = code ?? null;
  }
}

// ---------------------------------------------------------------------------
// Runner: claude-cli
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
 * Resolves with { stdout, stderr, code, timedOut } regardless of exit status.
 *
 * When useStdin is true the prompt is written to the process's stdin and
 * --print is omitted from the arguments.
 *
 * @param {string}   prompt
 * @param {string}   model
 * @param {boolean}  useStdin
 * @param {number}   timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, timedOut: boolean }>}
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

/**
 * Run the claude CLI and return a parsed JSON payload.
 *
 * @param {string} prompt
 * @param {string|null} model
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 * @throws {LlmError}
 */
async function _runClaudeCli(prompt, model, timeoutMs) {
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
  if (typeof parsed === 'object' && parsed !== null && typeof parsed.result === 'string') {
    try {
      return JSON.parse(parsed.result);
    } catch {
      const snippet = parsed.result.slice(0, 500);
      throw new LlmError(`LLM result field is not valid JSON: ${snippet}`, 'parse_error');
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Runner: anthropic-api
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Messages API directly via fetch and return a parsed JSON payload.
 *
 * @param {string} prompt
 * @param {string|null} model
 * @param {number} timeoutMs
 * @param {object|null} config
 * @returns {Promise<object>}
 * @throws {LlmError}
 */
async function _runAnthropicApi(prompt, model, timeoutMs, config) {
  const apiKeyEnv = config?.runner_api_key_env ?? 'ANTHROPIC_API_KEY';
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    throw new LlmError(
      `anthropic-api runner: API key not configured. Set the env var named by runner_api_key_env (default: ANTHROPIC_API_KEY).`,
      'exit_nonzero',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await globalThis.fetch(ANTHROPIC_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey || '',
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    if (fetchErr.name === 'AbortError') {
      throw new LlmError('LLM call timed out', 'timeout');
    }
    throw new LlmError(`anthropic-api fetch failed: ${fetchErr.message}`, 'exit_nonzero');
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new LlmError(
      `anthropic-api returned HTTP ${response.status}`,
      'exit_nonzero',
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new LlmError('anthropic-api response is not valid JSON', 'parse_error');
  }

  const text = body?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new LlmError('anthropic-api response missing content[0].text', 'parse_error');
  }

  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 500);
    throw new LlmError(`anthropic-api content is not valid JSON: ${snippet}`, 'parse_error');
  }
}

// ---------------------------------------------------------------------------
// Runner: openai-compatible
// ---------------------------------------------------------------------------

/**
 * Call an OpenAI-compatible /chat/completions endpoint and return a parsed JSON payload.
 *
 * @param {string} prompt
 * @param {string|null} model
 * @param {number} timeoutMs
 * @param {object|null} config
 * @returns {Promise<object>}
 * @throws {LlmError}
 */
async function _runOpenAiCompatible(prompt, model, timeoutMs, config) {
  const runnerUrl = config?.runner_url;
  if (!runnerUrl) {
    throw new LlmError(
      'openai-compatible runner requires runner_url to be set in config',
      'exit_nonzero',
    );
  }

  const endpoint = `${runnerUrl.replace(/\/$/, '')}/chat/completions`;
  const apiKeyEnv = config?.runner_api_key_env ?? 'OPENAI_API_KEY';
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : '';

  const headers = { 'content-type': 'application/json' };
  // Only add Authorization if the key env var is set and non-empty (covers Ollama local).
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'gpt-4o',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    if (fetchErr.name === 'AbortError') {
      throw new LlmError('LLM call timed out', 'timeout');
    }
    throw new LlmError(`openai-compatible fetch failed: ${fetchErr.message}`, 'exit_nonzero');
  }
  clearTimeout(timer);

  if (!response.ok) {
    let bodySnippet = '';
    try {
      const rawBody = await response.text();
      bodySnippet = rawBody.slice(0, 200);
    } catch {
      // ignore body read failure
    }
    throw new LlmError(
      `openai-compatible returned HTTP ${response.status}: ${bodySnippet}`,
      'exit_nonzero',
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new LlmError('openai-compatible response is not valid JSON', 'parse_error');
  }

  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new LlmError('openai-compatible response missing choices[0].message.content', 'parse_error');
  }

  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 500);
    throw new LlmError(`openai-compatible content is not valid JSON: ${snippet}`, 'parse_error');
  }
}

// ---------------------------------------------------------------------------
// Runner: clagentic-router
// ---------------------------------------------------------------------------

/**
 * Call the clagentic:router /v1/assess endpoint and return the assessment JSON.
 * The router validates output and returns the assessment directly — no unwrapping needed.
 *
 * @param {string} prompt
 * @param {string|null} model
 * @param {number} timeoutMs
 * @param {object|null} config
 * @returns {Promise<object>}
 * @throws {LlmError}
 */
async function _runClagenticRouter(prompt, model, timeoutMs, config) {
  const runnerUrl = config?.runner_url ?? CLAGENTIC_ROUTER_DEFAULT_URL;
  const endpoint = `${runnerUrl.replace(/\/$/, '')}/v1/assess`;

  const apiKeyEnv = config?.runner_api_key_env ?? 'CLAGENTIC_ROUTER_TOKEN';
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : '';

  const headers = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model || 'auto', prompt }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    if (fetchErr.name === 'AbortError') {
      throw new LlmError('LLM call timed out', 'timeout');
    }
    throw new LlmError(`clagentic-router fetch failed: ${fetchErr.message}`, 'exit_nonzero');
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new LlmError(
      `clagentic-router returned HTTP ${response.status}`,
      'exit_nonzero',
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new LlmError('clagentic-router response is not valid JSON', 'parse_error');
  }

  // The router returns the assessment JSON directly — no envelope to unwrap.
  return body;
}

// ---------------------------------------------------------------------------
// Schema validation (shared across all runners)
// ---------------------------------------------------------------------------

/**
 * Validate a raw payload object against the assessment schema.
 * Throws LlmError with code 'missing_fields' or 'bad_response' on any failure.
 *
 * @param {object} payload
 * @returns {object} The validated payload (same reference)
 * @throws {LlmError}
 */
function _validatePayload(payload) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
      throw new LlmError(
        `LLM response missing required field: ${field}`,
        'missing_fields',
      );
    }
  }

  // RT-007: Strict type and enum validation.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch prompt to the selected runner backend and return the raw payload
 * object WITHOUT schema validation. Used by callers (e.g. pre_filter.js) that
 * expect a response format different from the standard assessment schema.
 *
 * The runner is selected in priority order:
 *   1. opts.runner (explicit per-call override)
 *   2. opts.config?.runner (from loaded config)
 *   3. 'claude-cli' (built-in default)
 *
 * @param {string} prompt            - The full prompt text
 * @param {object} [opts]
 * @param {string} [opts.runner]     - Runner override
 * @param {string} [opts.model]      - Model identifier
 * @param {number} [opts.timeout_ms] - Timeout in milliseconds (default: 120000)
 * @param {object} [opts.config]     - Full config object for runner-specific settings
 * @returns {Promise<object|string>} - Raw parsed payload from the runner (no schema check)
 * @throws {LlmError}                - On timeout, non-zero exit, or parse failure
 */
export async function callLlmRaw(prompt, opts = {}) {
  const runner = opts.runner ?? opts.config?.runner ?? 'claude-cli';
  const model = opts.model ?? opts.config?.model ?? null;
  const timeoutMs = typeof opts.timeout_ms === 'number' ? opts.timeout_ms : DEFAULT_TIMEOUT_MS;
  const config = opts.config ?? null;

  switch (runner) {
    case 'claude-cli':
      return _runClaudeCli(prompt, model, timeoutMs);

    case 'anthropic-api':
      return _runAnthropicApi(prompt, model, timeoutMs, config);

    case 'openai-compatible':
      return _runOpenAiCompatible(prompt, model, timeoutMs, config);

    case 'clagentic-router':
      return _runClagenticRouter(prompt, model, timeoutMs, config);

    default:
      throw new LlmError(
        `Unknown runner: "${runner}". Valid runners: ${VALID_RUNNERS.join(', ')}`,
        'exit_nonzero',
      );
  }
}

/**
 * Call an LLM backend and return a validated assessment JSON payload.
 *
 * The runner is selected in priority order:
 *   1. opts.runner (explicit per-call override)
 *   2. opts.config?.runner (from loaded config)
 *   3. 'claude-cli' (built-in default)
 *
 * @param {string} prompt            - The full prompt text
 * @param {object} [opts]
 * @param {string} [opts.runner]     - Runner override ('claude-cli' | 'anthropic-api' | 'openai-compatible' | 'clagentic-router')
 * @param {string} [opts.model]      - Model identifier (semantics depend on runner)
 * @param {number} [opts.timeout_ms] - Timeout in milliseconds (default: 120000)
 * @param {object} [opts.config]     - Full config object for runner-specific settings
 * @returns {Promise<object>}        - Validated assessment JSON
 * @throws {LlmError}                - On timeout, non-zero exit, parse failure, or schema violation
 */
export async function callLlm(prompt, opts = {}) {
  const rawPayload = await callLlmRaw(prompt, opts);
  return _validatePayload(rawPayload);
}
