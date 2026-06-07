/**
 * Test fixture: a hook that always throws from run() with "crash" message.
 * Used by the "runs all hooks and isolates a failing one" test.
 */

export async function run() {
  throw new Error('crash');
}
