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

// A bundled dispatcher name must be a plain, lowercase token. This bounds a
// config-supplied `name` to a single file inside this directory: no slashes,
// no dots, no leading hyphen, so it can never traverse out of ./ (RT-009).
const BUNDLED_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve a single dispatchers config entry to a loaded module, or null.
 *
 * Resolution rules:
 *   - `module` set  -> dynamic-import that path as given (operator opt-in;
 *                      the operator is trusting that module).
 *   - `name` only   -> resolve a bundled dispatcher at ./<name>.js, after the
 *                      name passes BUNDLED_NAME_RE validation.
 *
 * Any failure (bad name, import error, missing create_task) logs a warning and
 * returns null so the caller can skip the entry without crashing the pipeline.
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
    // Operator-supplied module path: imported as given.
    specifier = entry.module;
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
 * Entries that cannot be resolved (bad name, import failure, missing
 * create_task) are warned about and dropped. An empty or absent list yields [].
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
