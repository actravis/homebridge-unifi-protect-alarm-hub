// The chime accessory's two independent controls: a momentary Ring button (fires an Alarm Manager
// webhook) and an Audible mute switch (PATCHes ringSettings). Both are Switch services on one
// accessory, told apart by HAP subtype.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChimeAccessory } from '../dist/accessories/chime.js';
import { Characteristic as C, FakeAccessory, Service, makeLog } from './helpers/hap-mock.mjs';

// A syntactically valid but fake UUID — never the real console's Trigger ID.
const TRIGGER = '11111111-2222-3333-4444-555555555555';
const setting = (over = {}) => ({ cameraId: 'cam-1', volume: 80, ringtoneId: 'ring-1', repeatTimes: 2, ...over });

/**
 * Build a handler and run one discovery pass. `plan` overrides let a test choose which controls
 * exist (triggerId → ring button, mutable → mute switch) and the chime's reported state.
 */
function setup({ fireError, patchError, fireGate, patchGate, ...plan } = {}) {
  const log = makeLog();
  const fired = [];
  const patches = [];
  const platform = {
    log,
    Service,
    Characteristic: C,
    api: {
      hap: {
        HapStatusError: class extends Error {},
        HAPStatus: { READ_ONLY_CHARACTERISTIC: -70404, SERVICE_COMMUNICATION_FAILURE: -70402 },
      },
    },
    applyInfo() {},
  };
  const accessory = new FakeAccessory('Doorbell Chime', 'uuid-1');
  const source = {
    async fireWebhook(id) {
      fired.push(id);
      if (fireGate) {
        await fireGate;
      }
      if (fireError) {
        throw fireError;
      }
    },
    async patchChime(id, patch) {
      patches.push({ id, patch });
      if (patchGate) {
        await patchGate;
      }
      if (patchError) {
        throw patchError;
      }
    },
  };
  const handler = new ChimeAccessory(platform, accessory, {
    name: 'Doorbell Chime', serial: 'c1', source,
  });
  const apply = (over = {}) => handler.update({
    deviceId: 'c1', name: 'Doorbell Chime', online: true, triggerId: TRIGGER,
    mutable: true, muted: false, volume: 80, pairedCameras: 1, ringSettings: [setting()],
    ...plan, ...over,
  });
  apply();
  const ring = () => accessory.getServiceById(Service.Switch, 'ring');
  const mute = () => accessory.getServiceById(Service.Switch, 'mute');
  return { handler, accessory, apply, ring, mute, fired, patches, log,
    press: () => ring().getCharacteristic(C.On).setHandler(true),
    setAudible: (v) => mute().getCharacteristic(C.On).setHandler(v) };
}

const logged = (log, level) => log.entries.filter((e) => e.level === level).map((e) => e.msg);

// --- which services exist ----------------------------------------------------

test('both controls produce two distinct Switch services', () => {
  const { ring, mute } = setup();
  assert.ok(ring(), 'ring button exists');
  assert.ok(mute(), 'mute switch exists');
  assert.notEqual(ring(), mute(), 'they must not collide into one service');
  assert.equal(ring().value(C.Name), 'Doorbell Chime Ring');
  assert.equal(mute().value(C.Name), 'Doorbell Chime Audible');
});

test('no Trigger ID means no ring button, but mute still works', () => {
  const { ring, mute } = setup({ triggerId: undefined });
  assert.equal(ring(), undefined);
  assert.ok(mute());
});

test('mute disabled leaves only the ring button', () => {
  const { ring, mute } = setup({ mutable: false });
  assert.ok(ring());
  assert.equal(mute(), undefined);
});

// A cached accessory would otherwise keep a button that can no longer ring anything.
test('clearing the Trigger ID removes the ring button on the next pass', () => {
  const { apply, ring } = setup();
  assert.ok(ring());
  apply({ triggerId: undefined });
  assert.equal(ring(), undefined);
});

test('turning off the mute switch in config removes that service', () => {
  const { apply, mute } = setup();
  assert.ok(mute());
  apply({ mutable: false });
  assert.equal(mute(), undefined);
});

test('repeated discovery passes do not duplicate services', () => {
  const { apply, accessory } = setup();
  apply(); apply();
  const switches = accessory.services.filter((s) => s.token === Service.Switch);
  assert.equal(switches.length, 2);
});

// --- ringing -----------------------------------------------------------------

test('pressing the button fires the configured webhook', async () => {
  const { press, fired } = setup();
  await press();
  assert.deepEqual(fired, [TRIGGER]);
});

test('the switch returns to off after a ring, so it reads as a button', async () => {
  const { press, ring } = setup();
  await press();
  assert.equal(ring().value(C.On), false);
});

test('the ring button always reads off', async () => {
  const { ring } = setup();
  assert.equal(await ring().getCharacteristic(C.On).getHandler(), false);
});

// Without this the tile stays stuck on after a failure and can never be pressed again.
test('a failed ring still leaves the button pressable', async () => {
  const { press, ring, log } = setup({ fireError: new Error('HTTP 400 Invalid webhook ID') });
  await press();
  assert.equal(ring().value(C.On), false);
  assert.ok(logged(log, 'error').some((m) => /Invalid webhook ID/.test(m)), 'passes the API reason through');
});

test('a ring failure is not thrown at HomeKit', async () => {
  const { press } = setup({ fireError: new Error('boom') });
  await press();
});

test('turning the ring switch off is not a ring', async () => {
  const { ring, fired } = setup();
  await ring().getCharacteristic(C.On).setHandler(false);
  assert.deepEqual(fired, []);
});

test('an offline chime is not rung, and says why', async () => {
  const { press, fired, log, ring } = setup({ online: false });
  await press();
  assert.deepEqual(fired, []);
  assert.equal(ring().value(C.On), false);
  assert.ok(logged(log, 'warn').some((m) => /offline/.test(m)));
});

// A double-tap in the Home app must not queue two alarms.
test('a double-tap mid-ring fires only once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { press, fired } = setup({ fireGate: gate });
  const first = press();
  await press();   // second tap while the first is still in flight
  release();
  await first;
  assert.deepEqual(fired, [TRIGGER], 'the in-flight guard dropped the second tap');
});

test('the button rings again after the previous ring completes', async () => {
  const { press, fired } = setup();
  await press();
  await press();
  assert.deepEqual(fired, [TRIGGER, TRIGGER]);
});

// --- muting ------------------------------------------------------------------

test('muting writes volume 0 to every paired camera', async () => {
  const { setAudible, patches } = setup();
  await setAudible(false);
  assert.deepEqual(patches, [{ id: 'c1', patch: { ringSettings: [setting({ volume: 0 })] } }]);
});

test('unmuting restores the volume observed before the mute', async () => {
  const { setAudible, patches } = setup();
  await setAudible(false);
  await setAudible(true);
  assert.equal(patches[1].patch.ringSettings[0].volume, 80);
});

// The context survives a Homebridge restart, so the level the user chose is not lost.
test('the pre-mute volume is remembered in accessory context', async () => {
  const { setAudible, accessory } = setup();
  await setAudible(false);
  assert.equal(accessory.context.chimeVolume, 80);
});

test('a chime already muted at startup unmutes to a sane default', async () => {
  const { setAudible, patches } = setup({ muted: true, volume: 100, ringSettings: [setting({ volume: 0 })] });
  await setAudible(true);
  assert.equal(patches[0].patch.ringSettings[0].volume, 100);
});

test('a chime paired to no camera refuses the write', async () => {
  const { setAudible, patches, log } = setup({ pairedCameras: 0, ringSettings: [] });
  await assert.rejects(() => setAudible(false));
  assert.deepEqual(patches, []);
  assert.ok(logged(log, 'warn').some((m) => /not paired to any camera/.test(m)));
});

test('an offline chime refuses the write', async () => {
  const { setAudible, patches } = setup({ online: false });
  await assert.rejects(() => setAudible(false));
  assert.deepEqual(patches, []);
});

test('a failed write surfaces an error instead of a false success', async () => {
  const { setAudible, mute, log } = setup({ patchError: new Error('HTTP 500') });
  await assert.rejects(() => setAudible(false));
  assert.equal(mute().value(C.On), true, 'the switch must not claim the mute succeeded');
  assert.ok(logged(log, 'error').some((m) => /HTTP 500/.test(m)));
});

test('a discovery pass reflects a mute made outside HomeKit', () => {
  const { apply, mute } = setup();
  apply({ muted: true, ringSettings: [setting({ volume: 0 })] });
  assert.equal(mute().value(C.On), false);
});

// Discovery runs every few minutes and can report pre-write state while a PATCH is in flight.
// Without the in-flight guard the stale snapshot flips the switch back on under the user's finger.
test('a discovery pass mid-write does not flap the switch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { setAudible, apply, mute } = setup({ patchGate: gate });

  const pending = setAudible(false);            // blocked inside patchChime
  // HAP writes the requested value optimistically before onSet resolves; the mock does not, so
  // do it explicitly — otherwise this test cannot distinguish "held" from "never set".
  mute().updateCharacteristic(C.On, false);
  apply({ muted: false });                      // stale snapshot: the console still reports audible

  assert.equal(mute().value(C.On), false, 'the in-flight write must win over a stale snapshot');
  release();
  await pending;
  assert.equal(mute().value(C.On), false, 'and it stays muted once the write lands');
});

test('a rename is pushed to both services', () => {
  const { handler, ring, mute } = setup();
  handler.setName('Hallway Chime');
  assert.equal(ring().value(C.Name), 'Hallway Chime Ring');
  assert.equal(mute().value(C.Name), 'Hallway Chime Audible');
});

test('shutdown is safe to call', () => {
  setup().handler.shutdown();
});
