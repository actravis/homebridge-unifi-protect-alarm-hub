// FROZEN CONTRACT — accessory identity.
//
// A HomeKit accessory's identity is the UUID derived from these key strings. Change one and
// HomeKit does not see a renamed accessory, it sees the old one deleted and a new one added:
// the user loses its room assignment, its name, its icon, and every automation and scene that
// referenced it. There is no migration path and no warning.
//
// The expected values below are transcribed from the v0.1.4 release — the last version
// published to npm — so any refactor that changes derivation fails here instead of in
// someone's house. If a key genuinely must change, that is a breaking release with release
// notes, not a silent edit to this file.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAccessories } from '../dist/discovery.js';
import { zoneKindFor } from '../dist/zones.js';

/** A hub exercising every accessory kind the alarm domain produces. */
const hub = {
  id: 'hub-1',
  modelKey: 'linkstation',
  name: 'Alarm Hub Kit',
  mac: 'AA:BB:CC:DD:EE:FF',
  state: 'CONNECTED',
  isAlarmHub: true,
  alarmHub: {
    armed: 'off',
    input: {
      0: { enable: 'on', inputType: 'ENTRY', name: 'Front Door' },
      1: { enable: 'on', inputType: 'MOTION', name: 'Hallway' },
      2: { enable: 'on', inputType: 'GLASS_BREAK', name: 'Living Room Glass Break' },
      3: { enable: 'on', inputType: 'FUTURE_TYPE', name: 'Unknown Thing' },
      4: { enable: 'off', inputType: 'ENTRY', name: 'Disabled' },
    },
    output: { 0: { enable: 'on', name: 'Beeper' }, 1: { enable: 'off', name: 'Off' } },
  },
};

test('accessory keys match the v0.1.4 release exactly', () => {
  const { accessories } = planAccessories(hub, {});
  assert.deepEqual(
    accessories.map((a) => a.key),
    [
      'security',
      'hub',
      'zone:0:contact', // ENTRY
      'zone:1:motion', // MOTION
      'zone:2:motion', // GLASS_BREAK, default rendering
      'zone:3:contact', // unrecognised type falls back to contact
      'output:0',
      'emergency',
    ],
  );
});

test('glassBreakAs=contact keeps its own frozen key', () => {
  // A user who set this has accessories registered under the contact key; it must stay stable
  // independently of the default.
  const { accessories } = planAccessories(hub, { glassBreakAs: 'contact' });
  assert.ok(accessories.some((a) => a.key === 'zone:2:contact'));
  assert.ok(!accessories.some((a) => a.key === 'zone:2:motion'));
});

// The zone kind is part of the key, so this mapping is part of the identity contract: flipping
// what ENTRY maps to would re-create every door sensor in every install.
test('zone kind mapping is frozen', () => {
  assert.equal(zoneKindFor('ENTRY'), 'contact');
  assert.equal(zoneKindFor('MOTION'), 'motion');
  assert.equal(zoneKindFor('GLASS_BREAK'), 'motion');
  assert.equal(zoneKindFor('GLASS_BREAK', 'contact'), 'contact');
  assert.equal(zoneKindFor('GLASS_BREAK', 'motion'), 'motion');
  assert.equal(zoneKindFor('ANYTHING_NEW'), 'contact');
});

// Serial numbers are the other half of accessory identity — HomeKit uses them to recognise a
// device across restarts. These strings are built inside the accessory classes; the values are
// transcribed from v0.1.4.
test('accessory serial numbers match the v0.1.4 release exactly', async () => {
  const { SecuritySystemAccessory } = await import('../dist/accessories/securitySystem.js');
  const { HubAccessory, ReadonlyContactAccessory, ZoneAccessory } = await import('../dist/accessories/sensors.js');
  const { Characteristic: C, FakeAccessory, Service, makePlatform } = await import('./helpers/hap-mock.mjs');

  const serialOf = (build) => {
    const accessory = new FakeAccessory('x', 'u', 0);
    build(makePlatform(), accessory);
    return accessory.getService(Service.AccessoryInformation).value(C.SerialNumber);
  };
  const mac = 'AA:BB:CC:DD:EE:FF';

  assert.equal(serialOf((p, a) => new SecuritySystemAccessory(p, a, mac)), `${mac}-security`);
  assert.equal(serialOf((p, a) => new HubAccessory(p, a, mac)), `${mac}-hub`);
  assert.equal(serialOf((p, a) => new ZoneAccessory(p, a, '3', 'contact', mac)), `${mac}-zone-3-contact`);
  assert.equal(
    serialOf((p, a) => new ReadonlyContactAccessory(p, a, { kind: 'output', channel: '0' }, mac)),
    `${mac}-output-0`,
  );
  assert.equal(
    serialOf((p, a) => new ReadonlyContactAccessory(p, a, { kind: 'emergency' }, mac)),
    `${mac}-emergency`,
  );
});
