/**
 * Test fixture: a hook that always throws from run().
 * Used to verify that runHooks() isolates a failing hook without stopping
 * the others.
 */

export async function run() {
  throw new Error('boom');
}
