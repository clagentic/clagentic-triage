/**
 * Test fixture: a dispatcher that always throws from create_task.
 * Used to verify that dispatch() isolates a failing dispatcher without
 * stopping the others.
 */

export const name = 'boom';

export async function create_task() {
  throw new Error('kaboom');
}
