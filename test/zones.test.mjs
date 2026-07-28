import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isKnownZoneType, zoneKindFor } from '../dist/zones.js';

test('ENTRY maps to a contact sensor', () => {
  assert.equal(zoneKindFor('ENTRY'), 'contact');
});

test('MOTION maps to a motion sensor', () => {
  assert.equal(zoneKindFor('MOTION'), 'motion');
});

test('GLASS_BREAK defaults to motion, but honours the contact preference', () => {
  assert.equal(zoneKindFor('GLASS_BREAK'), 'motion');
  assert.equal(zoneKindFor('GLASS_BREAK', 'motion'), 'motion');
  assert.equal(zoneKindFor('GLASS_BREAK', 'contact'), 'contact');
});

test('unknown types fall back to contact', () => {
  assert.equal(zoneKindFor('SOME_FUTURE_TYPE'), 'contact');
});

test('isKnownZoneType recognises exactly the mapped types', () => {
  for (const t of ['ENTRY', 'MOTION', 'GLASS_BREAK']) {
    assert.equal(isKnownZoneType(t), true);
  }
  assert.equal(isKnownZoneType('SOME_FUTURE_TYPE'), false);
  assert.equal(isKnownZoneType(''), false);
});
