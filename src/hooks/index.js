/**
 * Hook loader and runner for clagentic:triage.
 *
 * Hooks are lightweight callbacks that fire after assessment. They are
 * optional — the pipeline runs cleanly with an empty hooks list.
 *
 * Hook modules must export:
 *   run(event, assessment, hookConfig) -> Promise<object>
 *
 *   loadHooks(config)                  -> array of resolved hook modules
 *   runHooks(config, event, assessment) -> array of { name, result | error }
 *
 * See docs/CONFIG.md ## Hooks for the config format.
 */

import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Import the path validator from dispatchers — same confinement rules apply
// to operator-supplied hook module paths.
import { _validate_module_path } from '../dispatchers/index.js';

// Bundled hook names must be a plain, lowercase token. Same constraint as
// dispatcher names — no traversal chars, no dots, no leading hyphen.
const BUNDLED_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve a single hooks config entry to a loaded module, or null.
 *
 * Resolution rules:
 *   - `module` set  -> validate path, then dynamic-import.
 *   - `name` only   -> resolve a bundled hook at ./<name>.js, after the name
 *                      passes BUNDLED_NAME_RE validation.
 *
 * Any failure (bad name, path validation, import error, missing run)
 * logs a warning and returns null so the caller can skip the entry.
 *
 * @param {object} entry - one element of config.hooks
 * @returns {Promise<object|null>} loaded hook module, or null to skip
 */
async function resolveHook(entry) {
  if (!entry || typeof entry !== 'object') {
    console.warn('[hooks] skipping invalid hook entry (not an object)');
    return null;
  }

  const label = entry.name ?? entry.module ?? '(unnamed)';
  let specifier;

  if (entry.module) {
    const check = _validate_module_path(entry.module);
    if (!check.valid) {
      console.warn(
        `[hooks] skipping hook "${label}": module path rejected — ${check.reason}`,
      );
      return null;
    }
    specifier = check.resolvedPath
      ? pathToFileURL(check.resolvedPath).href
      : entry.module;
  } else if (entry.name) {
    if (!BUNDLED_NAME_RE.test(entry.name)) {
      console.warn(
        `[hooks] skipping hook "${entry.name}": invalid bundled name ` +
        `(must match ${BUNDLED_NAME_RE}); use a "module" path for external hooks`,
      );
      return null;
    }
    specifier = new URL(`./${entry.name}.js`, import.meta.url).href;
  } else {
    console.warn('[hooks] skipping hook entry with neither "name" nor "module"');
    return null;
  }

  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    console.warn(`[hooks] failed to load hook "${label}": ${err.message}`);
    return null;
  }

  if (typeof mod.run !== 'function') {
    console.warn(`[hooks] hook "${label}" is missing run; skipping`);
    return null;
  }

  return { ...mod, _name: label };
}

/**
 * Load and validate all hooks declared in config.hooks.
 *
 * Entries that cannot be resolved (bad name, path validation failure, import
 * error, missing run) are warned about and dropped. An empty or absent list
 * yields [].
 *
 * @param {object} config - loaded triage config
 * @returns {Promise<object[]>} resolved hook modules, in config order
 */
export async function loadHooks(config) {
  const entries = Array.isArray(config?.hooks) ? config.hooks : [];
  const loaded = [];

  for (const entry of entries) {
    const mod = await resolveHook(entry);
    if (mod) {
      loaded.push({ mod, hookConfig: entry.config ?? {} });
    }
  }

  return loaded;
}

/**
 * Run all configured hooks after assessment.
 *
 * Each hook is isolated: one that throws is recorded as { name, error } and
 * does not stop the others. Successful hooks yield { name, result }.
 * An empty hooks list is a clean no-op returning [].
 *
 * Hook failures never propagate — callers must not assume hooks succeed.
 *
 * @param {object} config      - loaded triage config
 * @param {object} event       - normalized Event
 * @param {object} assessment  - full assessor output
 * @returns {Promise<Array<{ name: string, result?: object, error?: string }>>}
 */
export async function runHooks(config, event, assessment) {
  const hooks = await loadHooks(config);
  const results = [];

  for (const { mod, hookConfig } of hooks) {
    const name = mod._name ?? '(unnamed)';
    try {
      const result = await mod.run(event, assessment, hookConfig);
      results.push({ name, result });
    } catch (err) {
      console.warn(`[hooks] hook "${name}" run failed: ${err.message}`);
      results.push({ name, error: err.message ?? String(err) });
    }
  }

  return results;
}
