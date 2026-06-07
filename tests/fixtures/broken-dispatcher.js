/**
 * Test fixture: a dispatcher module that exports name but is missing create_task.
 * Used to verify that loadDispatchers skips modules without the required export.
 */

export const name = 'broken';
