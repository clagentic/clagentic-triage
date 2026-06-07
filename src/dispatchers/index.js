/**
 * Dispatcher loader and runner for clagentic:triage.
 *
 * Core triage logic never imports a concrete backend. Dispatchers are resolved
 * at runtime from the `dispatchers` config list — either a bundled reference
 * dispatcher (by `name`) or any operator-supplied module (by `module` path).
 *
 *   loadDispatchers(config)               -> resolved dispatcher modules
 *   dispatch(config, event, assessment)   -> per-dispatcher { name, result | error }
 *
 * See docs/DISPATCHERS.md for the dispatcher interface contract.
 */

import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// A bundled dispatcher name must be a plain, lowercase token. This bounds a
// config-supplied `name` to a single file inside this directory: no slashes,
// no dots, no leading hyphen, so it can never traverse out of ./ (RT-009).
const BUNDLED_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Validate an operator-supplied module path before dynamic import (RT-009).
 *
 * Three forms are accepted:
 *   - Bare specifiers (npm package names, scoped packages) — anything that
 *     does not start with `/`, `./`, or `../`, and does not use a blocked URL
 *     scheme. These resolve via node_modules.
 *
 * Dangerous URL schemes (data:, file:, javascript:, vbscript:, blob:) are
 * rejected unconditionally before the relative/absolute check.
 *   - Relative paths (`./...`, `../...`) — only if the resolved absolute path
 *     remains within `cwd`. Paths that escape via `../` traversal are rejected.
 *   - Absolute paths — only if they start with `cwd`. Absolute paths that point
 *     outside `cwd` (e.g. `/etc/passwd`) are rejected.
 *
 * @param {string} modulePath - operator-supplied module field value
 * @param {string} [cwd]      - confinement root (default: process.cwd())
 * @returns {{ valid: true, resolvedPath: string|null } | { valid: false, reason: string }}
 *   resolvedPath is the absolute filesystem path for relative/absolute inputs,
 *   or null for bare npm specifiers (which are not filesystem paths).
 *   Callers MUST import resolvedPath (as a file:// URL) rather than the raw
 *   modulePath so the validated path and the loaded path are identical.
 */
// URL schemes that Node's ESM loader can execute directly. A config-supplied
// module path that matches one of these is rejected regardless of whether it
// looks like a filesystem path, because it bypasses the cwd-confinement check
// entirely (data: is run by the VM, file: is an explicit FS URL, javascript:
// and vbscript: execute script, blob: is a runtime object URL).
const BLOCKED_URL_SCHEME_RE = /^(data:|file:|javascript:|vbscript:|blob:)/i;

export function _validate_module_path(modulePath, cwd = process.cwd()) {
  if (typeof modulePath !== 'string') {
    return { valid: false, reason: 'module path must be a string' };
  }

  // Null bytes are always rejected — they can truncate C-level path operations.
  if (modulePath.includes('\0')) {
    return { valid: false, reason: 'module path contains a null byte' };
  }

  // Reject dangerous URL schemes before any other check. These bypass the
  // filesystem path confinement logic: data: is executed directly by the VM,
  // file: is an explicit filesystem URL, javascript:/vbscript:/blob: execute
  // script or reference runtime objects. Belt-and-suspenders against cwd check.
  if (BLOCKED_URL_SCHEME_RE.test(modulePath)) {
    return {
      valid: false,
      reason: 'module path uses a blocked URL scheme (data:, file:, javascript:, blob:)',
    };
  }

  const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
  const isAbsolute = modulePath.startsWith('/');

  if (!isRelative && !isAbsolute) {
    // Bare specifier (npm package, scoped package) — not a filesystem path, so
    // path-traversal confinement does not apply. Blocked URL schemes are already
    // rejected above before this branch is reached.
    return { valid: true, resolvedPath: null };
  }

  // For relative or absolute paths, resolve to an absolute path and verify
  // that the result is confined within cwd.
  const resolved = resolve(cwd, modulePath);
  // Append sep so that a cwd that is a prefix of another directory name does
  // not accidentally pass (e.g. /tmp vs /tmp-evil).
  const root = cwd.endsWith(sep) ? cwd : cwd + sep;

  if (resolved !== cwd && !resolved.startsWith(root)) {
    return {
      valid: false,
      reason: `module path resolves to "${resolved}" which is outside the project root "${cwd}"`,
    };
  }

  // Return the resolved absolute path so the caller imports exactly the file
  // that was validated — not the raw specifier which ESM would resolve from a
  // different base (the importing module's directory, not cwd).
  return { valid: true, resolvedPath: resolved };
}

/**
 * Resolve a single dispatchers config entry to a loaded module, or null.
 *
 * Resolution rules:
 *   - `module` set  -> validate path (RT-009), then dynamic-import.
 *   - `name` only   -> resolve a bundled dispatcher at ./<name>.js, after the
 *                      name passes BUNDLED_NAME_RE validation.
 *
 * Any failure (bad name, path validation, import error, missing create_task)
 * logs a warning and returns null so the caller can skip the entry without
 * crashing the pipeline.
 *
 * @param {object} entry - one element of config.dispatchers
 * @returns {Promise<object|null>} loaded dispatcher module, or null to skip
 */
async function resolveDispatcher(entry) {
  if (!entry || typeof entry !== 'object') {
    console.warn('[dispatchers] skipping invalid dispatcher entry (not an object)');
    return null;
  }

  const label = entry.name ?? entry.module ?? '(unnamed)';
  let specifier;

  if (entry.module) {
    // Operator-supplied module path: validate before import (RT-009).
    const check = _validate_module_path(entry.module);
    if (!check.valid) {
      console.warn(
        `[dispatchers] skipping dispatcher "${label}": module path rejected — ${check.reason}`,
      );
      return null;
    }
    // Use the resolved absolute path (as a file:// URL) for filesystem specifiers
    // so the path that was validated is exactly the path that is loaded. Using the
    // raw entry.module would let ESM resolve it relative to this file's directory
    // (src/dispatchers/), not cwd — making the confinement check meaningless for
    // relative paths.
    specifier = check.resolvedPath
      ? pathToFileURL(check.resolvedPath).href
      : entry.module;
  } else if (entry.name) {
    if (!BUNDLED_NAME_RE.test(entry.name)) {
      console.warn(
        `[dispatchers] skipping dispatcher "${entry.name}": invalid bundled name ` +
        `(must match ${BUNDLED_NAME_RE}); use a "module" path for external dispatchers`,
      );
      return null;
    }
    // Resolve to a bundled dispatcher relative to this directory.
    specifier = new URL(`./${entry.name}.js`, import.meta.url).href;
  } else {
    console.warn('[dispatchers] skipping dispatcher entry with neither "name" nor "module"');
    return null;
  }

  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    console.warn(`[dispatchers] failed to load dispatcher "${label}": ${err.message}`);
    return null;
  }

  if (typeof mod.create_task !== 'function') {
    console.warn(`[dispatchers] dispatcher "${label}" is missing create_task; skipping`);
    return null;
  }

  return mod;
}

/**
 * Load and validate all dispatchers declared in config.dispatchers.
 *
 * Entries that cannot be resolved (bad name, path validation failure, import
 * error, missing create_task) are warned about and dropped. An empty or absent
 * list yields [].
 *
 * @param {object} config - loaded triage config
 * @returns {Promise<object[]>} resolved dispatcher modules, in config order
 */
export async function loadDispatchers(config) {
  const entries = Array.isArray(config?.dispatchers) ? config.dispatchers : [];
  const loaded = [];

  for (const entry of entries) {
    const mod = await resolveDispatcher(entry);
    if (mod) {
      loaded.push(mod);
    }
  }

  return loaded;
}

/**
 * Run create_task on every configured dispatcher.
 *
 * Each dispatcher is isolated: one that throws is recorded as { name, error }
 * and does not stop the others. Successful dispatchers yield { name, result }.
 * An empty dispatchers list is a clean no-op returning [].
 *
 * @param {object} config      - loaded triage config
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {Promise<Array<{ name: string, result?: object, error?: string }>>}
 */
export async function dispatch(config, event, assessment) {
  const dispatchers = await loadDispatchers(config);
  const results = [];

  for (const mod of dispatchers) {
    const name = mod.name ?? '(unnamed)';
    try {
      const result = await mod.create_task(config, event, assessment);
      results.push({ name, result });
    } catch (err) {
      console.warn(`[dispatchers] dispatcher "${name}" create_task failed: ${err.message}`);
      results.push({ name, error: err.message ?? String(err) });
    }
  }

  return results;
}
