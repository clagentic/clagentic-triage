/**
 * Adapter registry.
 *
 * Maps adapter names to their module exports. All adapters must satisfy the
 * interface defined in docs/ADAPTERS.md and docs/ARCHITECTURE.md:
 *
 *   name, list_events, post_comment, close_item,
 *   request_changes, approve_pr, label_item, unlabel_item
 */

import * as github from './github.js';

export const adapters = { github };

/**
 * Look up an adapter by name. Throws if the name is not registered.
 *
 * @param {string} adapterName
 * @returns {object} Adapter module
 */
export function getAdapter(adapterName) {
  const adapter = adapters[adapterName];
  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterName}`);
  }
  return adapter;
}
