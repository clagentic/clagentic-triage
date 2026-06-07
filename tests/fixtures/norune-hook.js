/**
 * Test fixture: a hook module that exports name but is missing run().
 * Used to verify that loadHooks skips modules without the required export.
 */

export const name = 'norune';
