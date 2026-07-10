/**
 * Tests for src/action_classes.js — action-class/event-type matrix (lr-757a69).
 * Run with: node --test tests/action_classes.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_ACTION_CLASSES,
  validTypesForClass,
  validClassesForType,
  isActionClassValidForType,
  mismatchMessage,
} from '../src/action_classes.js';

describe('validTypesForClass', () => {
  it('restricts approve to PR only', () => {
    assert.deepEqual(validTypesForClass('approve'), ['pr']);
  });

  it('restricts request_changes to PR only', () => {
    assert.deepEqual(validTypesForClass('request_changes'), ['pr']);
  });

  it('allows respond for both issue and pr', () => {
    assert.deepEqual(validTypesForClass('respond'), ['issue', 'pr']);
  });

  it('allows close for both issue and pr', () => {
    assert.deepEqual(validTypesForClass('close'), ['issue', 'pr']);
  });

  it('allows dispatch for both issue and pr', () => {
    assert.deepEqual(validTypesForClass('dispatch'), ['issue', 'pr']);
  });

  it('allows escalate for both issue and pr', () => {
    assert.deepEqual(validTypesForClass('escalate'), ['issue', 'pr']);
  });

  it('returns an empty array for an unknown class', () => {
    assert.deepEqual(validTypesForClass('bogus'), []);
  });
});

describe('validClassesForType', () => {
  it('excludes approve/request_changes for issues', () => {
    const classes = validClassesForType('issue');
    assert.ok(!classes.includes('approve'), 'approve must not be valid for issue');
    assert.ok(!classes.includes('request_changes'), 'request_changes must not be valid for issue');
    assert.ok(classes.includes('respond'));
    assert.ok(classes.includes('dispatch'));
    assert.ok(classes.includes('close'));
    assert.ok(classes.includes('escalate'));
  });

  it('includes every class for PRs', () => {
    const classes = validClassesForType('pr');
    assert.deepEqual(classes, ALL_ACTION_CLASSES);
  });

  it('returns an empty array for an unknown type', () => {
    assert.deepEqual(validClassesForType('release'), []);
  });
});

describe('isActionClassValidForType', () => {
  it('rejects approve for an issue', () => {
    assert.equal(isActionClassValidForType('approve', 'issue'), false);
  });

  it('accepts approve for a pr', () => {
    assert.equal(isActionClassValidForType('approve', 'pr'), true);
  });

  it('rejects request_changes for an issue', () => {
    assert.equal(isActionClassValidForType('request_changes', 'issue'), false);
  });

  it('accepts dispatch for an issue (the correct class for an accepted issue)', () => {
    assert.equal(isActionClassValidForType('dispatch', 'issue'), true);
  });

  it('returns false for an unknown class regardless of type', () => {
    assert.equal(isActionClassValidForType('bogus', 'pr'), false);
  });

  it('returns false for an unknown/missing event type', () => {
    assert.equal(isActionClassValidForType('respond', undefined), false);
    assert.equal(isActionClassValidForType('respond', 'release'), false);
  });
});

describe('mismatchMessage', () => {
  it('names the invalid class, the type, and the valid alternatives', () => {
    const msg = mismatchMessage('approve', 'issue');
    assert.ok(msg.includes('"approve"'), 'should name the invalid class');
    assert.ok(msg.includes('"issue"'), 'should name the event type');
    assert.ok(msg.includes('dispatch'), 'should list dispatch as a valid alternative');
    assert.ok(!msg.includes('approve,'), 'approve itself should not be listed as valid for issue');
  });

  it('lists every class as valid for a pr mismatch is impossible, but message still resolves for other types', () => {
    const msg = mismatchMessage('approve', 'release');
    assert.ok(msg.includes('(none)'), 'no classes are valid for an unmodeled type');
  });
});
