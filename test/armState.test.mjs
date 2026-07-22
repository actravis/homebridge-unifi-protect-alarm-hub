import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeFingerprint, isArmed, isTriggered } from '../dist/armState.js';

const hub = (alarmHub) => ({ id: 'h', modelKey: 'linkstation', name: 'Hub', alarmHub });

test('computeFingerprint collects active-profile channels, numerically sorted', () => {
  const h = hub({
    input: {
      '2': { triggerOnCurrentArmingProfile: 'on' },
      '10': { triggerOnCurrentArmingProfile: 'on' },
      '1': { triggerOnCurrentArmingProfile: 'off' },
    },
  });
  assert.equal(computeFingerprint(h), '2,10');
});

test('computeFingerprint differs between profiles (Away vs Night)', () => {
  const away = hub({ input: { '1': { triggerOnCurrentArmingProfile: 'on' }, '9': { triggerOnCurrentArmingProfile: 'on' } } });
  const night = hub({ input: { '1': { triggerOnCurrentArmingProfile: 'on' }, '9': { triggerOnCurrentArmingProfile: 'off' } } });
  assert.notEqual(computeFingerprint(away), computeFingerprint(night));
});

test('isArmed reflects the binary armed flag', () => {
  assert.equal(isArmed(hub({ armed: 'on' })), true);
  assert.equal(isArmed(hub({ armed: 'off' })), false);
  assert.equal(isArmed(hub({})), false);
});

test('isTriggered only when armed AND an output is active', () => {
  assert.equal(isTriggered(hub({ armed: 'on', output: { '0': { active: 'on' } } })), true);
  assert.equal(isTriggered(hub({ armed: 'off', output: { '0': { active: 'on' } } })), false);
  assert.equal(isTriggered(hub({ armed: 'on', output: { '0': { active: 'off' } } })), false);
});

test('isTriggered honours a siren-channel restriction', () => {
  const h = hub({ armed: 'on', output: { '0': { active: 'on' }, '1': { active: 'off' } } });
  assert.equal(isTriggered(h, new Set(['0'])), true); // ch0 is the siren and active
  assert.equal(isTriggered(h, new Set(['1'])), false); // only ch1 counts, and it's inactive
  assert.equal(isTriggered(h, new Set()), true); // empty restriction = any active output
});
