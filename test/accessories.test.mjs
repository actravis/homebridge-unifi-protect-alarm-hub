import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZoneAccessory, ReadonlyContactAccessory, HubAccessory } from '../dist/accessories/sensors.js';
import { SecuritySystemAccessory } from '../dist/accessories/securitySystem.js';
import { Service, Characteristic as C, FakeAccessory, makePlatform } from './helpers/hap-mock.mjs';

/** Build an AlarmHub snapshot. `alarmHub` is the nested payload; `extra` overrides top-level fields. */
const hub = (alarmHub = {}, extra = {}) => ({
  id: 'h1',
  modelKey: 'linkstation',
  name: 'Hub',
  mac: 'AA:BB',
  state: 'CONNECTED',
  isAlarmHub: true,
  alarmHub,
  ...extra,
});

// --- ZoneAccessory (contact) ------------------------------------------------

test('ZoneAccessory (contact): a closed door reads CONTACT_DETECTED, active, no fault', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ input: { 3: { status: 'normal' } }, inputTerminalStatus: { 3: { terminalStatus: 'idle' } } }), 'Front Door');
  const svc = acc.getService(Service.ContactSensor);
  assert.equal(svc.value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
  assert.equal(svc.value(C.StatusActive), true);
  assert.equal(svc.value(C.StatusFault), C.StatusFault.NO_FAULT);
});

test('ZoneAccessory (contact): an open door reads CONTACT_NOT_DETECTED', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ inputTerminalStatus: { 3: { terminalStatus: 'triggered' } } }), 'Front Door');
  assert.equal(acc.getService(Service.ContactSensor).value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
});

test('ZoneAccessory: an offline hub → fault + inactive', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ inputTerminalStatus: { 3: { terminalStatus: 'idle' } } }, { state: 'DISCONNECTED' }), 'Front Door');
  const svc = acc.getService(Service.ContactSensor);
  assert.equal(svc.value(C.StatusFault), C.StatusFault.GENERAL_FAULT);
  assert.equal(svc.value(C.StatusActive), false);
});

test('ZoneAccessory: an unrecognised terminal state is treated as a fault (defensive EOL)', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ inputTerminalStatus: { 3: { terminalStatus: 'weird-eolr-state' } } }), 'Front Door');
  assert.equal(acc.getService(Service.ContactSensor).value(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('ZoneAccessory: hub cover open surfaces as StatusTampered on the zone', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ cover: { status: 'open' }, inputTerminalStatus: { 3: { terminalStatus: 'idle' } } }), 'Front Door');
  assert.equal(acc.getService(Service.ContactSensor).value(C.StatusTampered), C.StatusTampered.TAMPERED);
});

test('ZoneAccessory.markStale → fault + inactive', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '3', 'contact', 'AA');
  z.update(hub({ inputTerminalStatus: { 3: { terminalStatus: 'idle' } } }), 'Front Door'); // healthy first
  z.markStale();
  const svc = acc.getService(Service.ContactSensor);
  assert.equal(svc.value(C.StatusFault), C.StatusFault.GENERAL_FAULT);
  assert.equal(svc.value(C.StatusActive), false);
});

// --- ZoneAccessory (motion) -------------------------------------------------

test('ZoneAccessory (motion): an alarm status → MotionDetected true', () => {
  const acc = new FakeAccessory('Living Room', 'u', 0);
  const z = new ZoneAccessory(makePlatform(), acc, '5', 'motion', 'AA');
  z.update(hub({ input: { 5: { status: 'alarm' } } }), 'Living Room');
  assert.equal(acc.getService(Service.MotionSensor).value(C.MotionDetected), true);
});

// --- ReadonlyContactAccessory ----------------------------------------------

test('ReadonlyContactAccessory (output): an active output reads CONTACT_NOT_DETECTED', () => {
  const acc = new FakeAccessory('Beeper', 'u', 0);
  const r = new ReadonlyContactAccessory(makePlatform(), acc, { kind: 'output', channel: '0' }, 'AA');
  r.update(hub({ output: { 0: { active: 'on' } } }), 'Beeper');
  assert.equal(acc.getService(Service.ContactSensor).value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
});

test('ReadonlyContactAccessory (emergency): a triggered terminal reads CONTACT_NOT_DETECTED', () => {
  const acc = new FakeAccessory('Emergency', 'u', 0);
  const r = new ReadonlyContactAccessory(makePlatform(), acc, { kind: 'emergency' }, 'AA');
  r.update(hub({ emergencyTerminalStatus: { terminalStatus: 'triggered' } }), 'Emergency');
  assert.equal(acc.getService(Service.ContactSensor).value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
});

test('ReadonlyContactAccessory.markStale → inactive', () => {
  const acc = new FakeAccessory('Beeper', 'u', 0);
  const r = new ReadonlyContactAccessory(makePlatform(), acc, { kind: 'output', channel: '0' }, 'AA');
  r.markStale();
  assert.equal(acc.getService(Service.ContactSensor).value(C.StatusActive), false);
});

// --- HubAccessory -----------------------------------------------------------

test('HubAccessory: battery ok vs low mapping', () => {
  const acc = new FakeAccessory('Hub', 'u', 0);
  const h = new HubAccessory(makePlatform(), acc, 'AA');
  h.update(hub({ battery: { batteryStatus: 'ok' } }), 'Hub');
  const bat = acc.getService(Service.Battery);
  assert.equal(bat.value(C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  assert.equal(bat.value(C.BatteryLevel), 100);
  h.update(hub({ battery: { batteryStatus: 'low' } }), 'Hub');
  assert.equal(bat.value(C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW);
});

test('HubAccessory: cover open → tampered', () => {
  const acc = new FakeAccessory('Hub', 'u', 0);
  const h = new HubAccessory(makePlatform(), acc, 'AA');
  h.update(hub({ cover: { status: 'open' } }), 'Hub');
  assert.equal(acc.getService(Service.ContactSensor).value(C.StatusTampered), C.StatusTampered.TAMPERED);
});

test('HubAccessory.markStale → inactive', () => {
  const acc = new FakeAccessory('Hub', 'u', 0);
  const h = new HubAccessory(makePlatform(), acc, 'AA');
  h.markStale();
  assert.equal(acc.getService(Service.ContactSensor).value(C.StatusActive), false);
});

// --- SecuritySystemAccessory ------------------------------------------------

const armConfig = { armAwayTriggerId: 'a', armNightTriggerId: 'n', disarmTriggerId: 'd' };

test('SecuritySystem: a disarmed hub reports DISARMED', () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const s = new SecuritySystemAccessory(makePlatform(armConfig), acc, 'AA');
  s.update(hub({ armed: 'off' }), 'Security');
  assert.equal(acc.getService(Service.SecuritySystem).value(C.SecuritySystemCurrentState), C.SecuritySystemCurrentState.DISARMED);
});

test('SecuritySystem: an armed hub with an unlearned profile defaults to AWAY_ARM', () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const s = new SecuritySystemAccessory(makePlatform(armConfig), acc, 'AA');
  s.update(hub({ armed: 'on', input: { 1: { triggerOnCurrentArmingProfile: 'on' } } }), 'Security');
  assert.equal(acc.getService(Service.SecuritySystem).value(C.SecuritySystemCurrentState), C.SecuritySystemCurrentState.AWAY_ARM);
});

test('SecuritySystem: ALARM_TRIGGERED requires two consecutive triggered reads (chirp debounce)', () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const s = new SecuritySystemAccessory(makePlatform(armConfig), acc, 'AA');
  const breach = hub({ armed: 'on', output: { 0: { active: 'on' } }, input: { 1: { triggerOnCurrentArmingProfile: 'on' } } });
  const svc = acc.getService(Service.SecuritySystem);
  s.update(breach, 'Security');
  assert.notEqual(svc.value(C.SecuritySystemCurrentState), C.SecuritySystemCurrentState.ALARM_TRIGGERED);
  s.update(breach, 'Security');
  assert.equal(svc.value(C.SecuritySystemCurrentState), C.SecuritySystemCurrentState.ALARM_TRIGGERED);
});

test('SecuritySystem.markStale sets fault; a later successful update clears it', () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const s = new SecuritySystemAccessory(makePlatform(armConfig), acc, 'AA');
  s.markStale();
  const svc = acc.getService(Service.SecuritySystem);
  assert.equal(svc.value(C.StatusFault), C.StatusFault.GENERAL_FAULT);
  s.update(hub({ armed: 'off' }), 'Security');
  assert.equal(svc.value(C.StatusFault), C.StatusFault.NO_FAULT);
});

// --- SecuritySystem: the arm/disarm write path ------------------------------
// This is the plugin's only state-changing action; everything else is read-only.

/** Invoke the SecuritySystemTargetState onSet handler the way HAP would. */
const setTarget = (acc, value) =>
  acc.getService(Service.SecuritySystem).getCharacteristic(C.SecuritySystemTargetState).setHandler(value);

/** A platform whose client records fired webhooks (or throws, when `fail` is set). */
function armPlatform(config, { fail = false } = {}) {
  const fired = [];
  const platform = makePlatform(config);
  platform.client = {
    fireWebhook: (id) => {
      fired.push(id);
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
    },
  };
  return { platform, fired };
}

const allTriggers = { armAwayTriggerId: 'away-id', armNightTriggerId: 'night-id', disarmTriggerId: 'disarm-id' };

test('SecuritySystem: validValues follow which trigger IDs are configured', () => {
  const targets = (config) => {
    const acc = new FakeAccessory('Security', 'u', 0);
    new SecuritySystemAccessory(makePlatform(config), acc, 'AA');
    return acc.getService(Service.SecuritySystem).getCharacteristic(C.SecuritySystemTargetState).props.validValues;
  };
  assert.deepEqual(targets(allTriggers), [
    C.SecuritySystemTargetState.AWAY_ARM,
    C.SecuritySystemTargetState.NIGHT_ARM,
    C.SecuritySystemTargetState.DISARM,
  ]);
  assert.deepEqual(targets({ armAwayTriggerId: 'a' }), [C.SecuritySystemTargetState.AWAY_ARM]);
  assert.deepEqual(targets({ armNightTriggerId: 'n' }), [C.SecuritySystemTargetState.NIGHT_ARM]);
  // No triggers at all: HomeKit still needs one selectable value, and disarm is the safe one.
  assert.deepEqual(targets({}), [C.SecuritySystemTargetState.DISARM]);
});

// REGRESSION: the seeded value must itself be legal. With only an "away" trigger, validValues is
// [AWAY_ARM], so seeding a bare DISARM produced the very HAP warning the seed exists to avoid.
test('SecuritySystem: the seeded target is always one of the valid values', () => {
  for (const config of [allTriggers, { armAwayTriggerId: 'a' }, { armNightTriggerId: 'n' }, {}]) {
    const acc = new FakeAccessory('Security', 'u', 0);
    new SecuritySystemAccessory(makePlatform(config), acc, 'AA');
    const char = acc.getService(Service.SecuritySystem).getCharacteristic(C.SecuritySystemTargetState);
    assert.ok(
      char.props.validValues.includes(char.value),
      `seeded ${char.value} is not in ${JSON.stringify(char.props.validValues)}`,
    );
  }
});

// REGRESSION: the seed was clamped but the *refresh* path was not. On every poll while the hub
// reported disarmed, update() wrote a bare DISARM — illegal in an arm-only setup, so HAP logged
// "value 3 is not in valid values" repeatedly. Every write to `target` must go through clamping.
test('SecuritySystem: every reported target stays within validValues', () => {
  const disarmedHub = { id: 'h', modelKey: 'linkstation', name: 'Hub', state: 'CONNECTED', alarmHub: { armed: 'off' } };
  const armedHub = { ...disarmedHub, alarmHub: { armed: 'on', input: { 0: { triggerOnCurrentArmingProfile: 'on' } } } };

  for (const config of [allTriggers, { armAwayTriggerId: 'a' }, { armNightTriggerId: 'n' }, {}]) {
    for (const hub of [disarmedHub, armedHub]) {
      const acc = new FakeAccessory('Security', 'u', 0);
      const handler = new SecuritySystemAccessory(makePlatform(config), acc, 'AA');
      const char = acc.getService(Service.SecuritySystem).getCharacteristic(C.SecuritySystemTargetState);

      handler.update(hub, 'Security');

      assert.ok(
        char.props.validValues.includes(char.value),
        `reported ${char.value} is not in ${JSON.stringify(char.props.validValues)} ` +
          `(config ${JSON.stringify(config)}, armed=${hub.alarmHub.armed})`,
      );
    }
  }
});

test('SecuritySystem: setting a target fires that mode\'s webhook', async () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const { platform, fired } = armPlatform(allTriggers);
  new SecuritySystemAccessory(platform, acc, 'AA');

  await setTarget(acc, C.SecuritySystemTargetState.AWAY_ARM);
  assert.deepEqual(fired, ['away-id']);
  await setTarget(acc, C.SecuritySystemTargetState.NIGHT_ARM);
  assert.deepEqual(fired, ['away-id', 'night-id']);
  await setTarget(acc, C.SecuritySystemTargetState.DISARM);
  assert.deepEqual(fired, ['away-id', 'night-id', 'disarm-id']);
});

test('SecuritySystem: a target with no configured trigger is read-only, and fires nothing', async () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const { platform, fired } = armPlatform({ armAwayTriggerId: 'away-id' }); // no night/disarm
  new SecuritySystemAccessory(platform, acc, 'AA');

  await assert.rejects(() => setTarget(acc, C.SecuritySystemTargetState.NIGHT_ARM), (err) => {
    assert.equal(err.status, -70404); // READ_ONLY_CHARACTERISTIC
    return true;
  });
  assert.deepEqual(fired, []);
  assert.ok(platform.log.entries.some((e) => e.level === 'warn' && /No webhook Trigger ID/.test(e.msg)));
});

test('SecuritySystem: no client → communication failure', async () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const platform = makePlatform(allTriggers); // client stays undefined
  new SecuritySystemAccessory(platform, acc, 'AA');

  await assert.rejects(() => setTarget(acc, C.SecuritySystemTargetState.AWAY_ARM), (err) => {
    assert.equal(err.status, -70402); // SERVICE_COMMUNICATION_FAILURE
    return true;
  });
});

test('SecuritySystem: a failing webhook surfaces as a communication failure and is logged', async () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const { platform, fired } = armPlatform(allTriggers, { fail: true });
  new SecuritySystemAccessory(platform, acc, 'AA');

  await assert.rejects(() => setTarget(acc, C.SecuritySystemTargetState.AWAY_ARM), (err) => {
    assert.equal(err.status, -70402);
    return true;
  });
  assert.deepEqual(fired, ['away-id']); // it was attempted
  assert.ok(platform.log.entries.some((e) => e.level === 'error' && /webhook failed/.test(e.msg)));
});

test('SecuritySystem: a successful arm is remembered and reported back', async () => {
  const acc = new FakeAccessory('Security', 'u', 0);
  const { platform } = armPlatform(allTriggers);
  const s = new SecuritySystemAccessory(platform, acc, 'AA');

  await setTarget(acc, C.SecuritySystemTargetState.NIGHT_ARM);
  // The armed hub is fingerprinted against the pending learn, so the mode survives a refresh.
  s.update(hub({ armed: 'on', input: { 1: { triggerOnCurrentArmingProfile: 'on' } } }), 'Security');
  const svc = acc.getService(Service.SecuritySystem);
  assert.equal(svc.value(C.SecuritySystemCurrentState), C.SecuritySystemCurrentState.NIGHT_ARM);
});
