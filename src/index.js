/**
 * Public entry point for @clagentic/triage.
 *
 * Re-exports the stable public surface for external callers.
 * Internal modules (enricher, assessor internals, llm) are not exported here.
 */

export { loadConfig, ConfigError } from './config/index.js';
export { runPipeline, processEvent } from './pipeline.js';
export { getAdapter } from './adapters/index.js';
export { AdapterError } from './adapters/github.js';
export { AssessorError } from './assessor.js';
export { LlmError } from './llm.js';
