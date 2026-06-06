/**
 * Test fixture: a minimal third-party dispatcher loaded by module path.
 * Not a runtime dependency — used only by tests/dispatchers.test.js.
 */

export const name = 'fake-tracker';

export async function create_task(_config, event, _assessment) {
  return { id: `fake-${event?.id ?? 'x'}`, url: 'https://tracker.example/fake/1' };
}

export async function update_task() {}
