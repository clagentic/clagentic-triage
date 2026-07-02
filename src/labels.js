/**
 * Label vocabulary — namespaced axes and validation helpers.
 *
 * clagentic:triage uses a namespaced label vocabulary (DD-012) with a single
 * state axis (`status/*`) and independent, orthogonal axes (`kind/*`,
 * `priority/*`, `area/*`). This module is ticketing-agnostic: it only reasons
 * about label strings, never about a specific backend (GitHub, Jira, Linear,
 * etc). Adapters and dispatchers call these helpers; they must not duplicate
 * vocabulary logic.
 *
 * The vocabulary itself is config-driven (`config.labels`), not hardcoded, so
 * operators can rename or extend it per repo/org without touching this module.
 */

// ---------------------------------------------------------------------------
// Built-in default vocabulary
// ---------------------------------------------------------------------------

/** The namespace that represents the single lifecycle-state axis. */
export const STATUS_NAMESPACE = 'status';

/**
 * Default `status/*` values, in rough lifecycle order. `released` is the
 * terminal success state; NOT_PLANNED closures use a separate set of
 * terminal labels (wontfix/duplicate/invalid) that are intentionally NOT
 * part of the status axis — they close the item rather than describe an
 * in-flight state.
 */
export const DEFAULT_STATUS_VALUES = [
  'needs-triage',
  'accepted',
  'needs-info',
  'blocked',
  'in-progress',
  'in-review',
  'awaiting-release',
  'released',
];

/** Default terminal "not planned" closure labels — orthogonal to status/*. */
export const DEFAULT_NOT_PLANNED_VALUES = ['wontfix', 'duplicate', 'invalid'];

/** Default orthogonal (non-state) axes. Each may appear alongside status/* freely. */
export const DEFAULT_AXES = {
  kind: ['bug', 'feature', 'chore', 'docs', 'question'],
  priority: ['p0', 'p1', 'p2', 'p3'],
  area: [],
};

/**
 * Build the default vocabulary object in the same shape `config.labels`
 * expects. Used when an operator supplies no `config.labels` block at all.
 *
 * @returns {object}
 */
export function defaultVocabulary() {
  return {
    status_namespace: STATUS_NAMESPACE,
    status_values: DEFAULT_STATUS_VALUES.slice(),
    not_planned_values: DEFAULT_NOT_PLANNED_VALUES.slice(),
    axes: {
      kind: DEFAULT_AXES.kind.slice(),
      priority: DEFAULT_AXES.priority.slice(),
      area: DEFAULT_AXES.area.slice(),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a namespaced label into { namespace, value }. Labels without a "/"
 * have namespace === null (unnamespaced / free-form label).
 *
 * @param {string} label
 * @returns {{ namespace: string|null, value: string }}
 */
function _splitNamespace(label) {
  const idx = label.indexOf('/');
  if (idx === -1) {
    return { namespace: null, value: label };
  }
  return { namespace: label.slice(0, idx), value: label.slice(idx + 1) };
}

/**
 * Resolve the effective vocabulary from config, falling back to defaults for
 * any field the operator did not supply. Never mutates `config`.
 *
 * @param {object} config
 * @returns {object} Effective vocabulary (see defaultVocabulary() shape)
 */
export function resolveVocabulary(config) {
  const def = defaultVocabulary();
  const supplied = config?.labels;
  if (!supplied || typeof supplied !== 'object') {
    return def;
  }

  return {
    status_namespace:
      typeof supplied.status_namespace === 'string' && supplied.status_namespace.length > 0
        ? supplied.status_namespace
        : def.status_namespace,
    status_values: Array.isArray(supplied.status_values) ? supplied.status_values.slice() : def.status_values,
    not_planned_values: Array.isArray(supplied.not_planned_values)
      ? supplied.not_planned_values.slice()
      : def.not_planned_values,
    axes: {
      kind: Array.isArray(supplied.axes?.kind) ? supplied.axes.kind.slice() : def.axes.kind,
      priority: Array.isArray(supplied.axes?.priority) ? supplied.axes.priority.slice() : def.axes.priority,
      area: Array.isArray(supplied.axes?.area) ? supplied.axes.area.slice() : def.axes.area,
      // Operator-defined additional axes (beyond kind/priority/area) pass through
      // unchanged; this module only special-cases the status axis.
      ...Object.fromEntries(
        Object.entries(supplied.axes ?? {}).filter(([k]) => !['kind', 'priority', 'area'].includes(k)),
      ),
    },
  };
}

/**
 * Build the flat set of every label string the vocabulary allows, including
 * the namespaced status/* values, the not-planned closure labels (unnamespaced
 * by convention — they read naturally as GitHub-style close reasons), and
 * every namespaced axis value.
 *
 * @param {object} vocabulary - Output of resolveVocabulary()
 * @returns {Set<string>}
 */
export function allowedLabelSet(vocabulary) {
  const out = new Set();

  for (const value of vocabulary.status_values) {
    out.add(`${vocabulary.status_namespace}/${value}`);
  }
  for (const value of vocabulary.not_planned_values) {
    out.add(value);
  }
  for (const [axis, values] of Object.entries(vocabulary.axes ?? {})) {
    for (const value of values) {
      out.add(`${axis}/${value}`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return true if `label` belongs to the status/* namespace for the given
 * (resolved) vocabulary.
 *
 * @param {string} label
 * @param {object} vocabulary - Output of resolveVocabulary()
 * @returns {boolean}
 */
export function isStatusLabel(label, vocabulary) {
  const { namespace } = _splitNamespace(label);
  return namespace === vocabulary.status_namespace;
}

/**
 * Normalize and validate a list of candidate labels against the effective
 * vocabulary (config.labels, or built-in defaults).
 *
 * Labels not present in the vocabulary are rejected (not silently dropped)
 * so callers can decide how to handle rejects (log, escalate, etc) rather
 * than have this module make that policy decision.
 *
 * @param {object}   config
 * @param {string[]} labels - Candidate labels (e.g. assessment.suggested_action.labels)
 * @returns {{ accepted: string[], rejected: string[] }}
 */
export function normalizeLabels(config, labels) {
  const vocabulary = resolveVocabulary(config);
  const allowed = allowedLabelSet(vocabulary);

  const accepted = [];
  const rejected = [];

  for (const raw of labels ?? []) {
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (label.length > 0 && allowed.has(label)) {
      accepted.push(label);
    } else {
      rejected.push(raw);
    }
  }

  return { accepted, rejected };
}

/**
 * Enforce the "exactly one status/* label at a time" invariant for a target
 * set of labels an item currently carries plus labels about to be added.
 *
 * Given the item's current labels and the labels about to be applied, returns
 * the status/* label(s) that must be removed so the item ends up with at
 * most one status/* label — the newest one being applied wins. If no new
 * status/* label is being applied, existing status/* labels are left alone
 * (this helper never removes status without a replacement).
 *
 * This is a pure function — it does not call any adapter. Callers (e.g. the
 * pipeline, or a future state-machine transition helper — T7) are
 * responsible for actually removing the returned labels via the adapter's
 * label-removal method.
 *
 * @param {object}   config
 * @param {string[]} currentLabels - Labels the item currently has
 * @param {string[]} incomingLabels - Labels about to be applied
 * @returns {{ toRemove: string[], toApply: string[] }}
 *   toRemove: existing status/* labels that must be removed to keep the
 *             single-status invariant (excludes any that are also incoming).
 *   toApply: the incoming labels, unchanged (pass-through for caller convenience).
 */
export function enforceSingleStatus(config, currentLabels, incomingLabels) {
  const vocabulary = resolveVocabulary(config);

  const incomingStatusLabels = (incomingLabels ?? []).filter((l) => isStatusLabel(l, vocabulary));

  if (incomingStatusLabels.length > 1) {
    throw new RangeError(
      `enforceSingleStatus: incomingLabels contains more than one status/* label: ${incomingStatusLabels.join(', ')}. ` +
      'Only one status/* label may be applied at a time.',
    );
  }

  if (incomingStatusLabels.length === 0) {
    // No new status transition requested; leave existing status label(s) alone.
    return { toRemove: [], toApply: incomingLabels ?? [] };
  }

  const incomingStatus = incomingStatusLabels[0];
  const toRemove = (currentLabels ?? []).filter(
    (l) => isStatusLabel(l, vocabulary) && l !== incomingStatus,
  );

  return { toRemove, toApply: incomingLabels ?? [] };
}
