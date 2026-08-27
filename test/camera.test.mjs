import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlarmSensorAccessory, CameraAccessory } from '../dist/accessories/camera.js';
import { Service, Characteristic as C, FakeAccessory, makePlatform } from './helpers/hap-mock.mjs';

/** Fake timers that record scheduled callbacks so tests can fire the safety-clear on demand. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    set(fn, ms) {
      const handle = { fn, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clear(handle) {
      if (handle) handle.cleared = true;
    },
    fireLast() {
      scheduled.at(-1).fn();
    },
  };
}

test('CameraAccessory: motion active → MotionDetected true, end → false', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Front Door', serial: 'AA', isDoorbell: false }, t);
  const svc = acc.getService(Service.MotionSensor);
  cam.applyDetection('motion', true);
  assert.equal(svc.value(C.MotionDetected), true);
  cam.applyDetection('motion', false);
  assert.equal(svc.value(C.MotionDetected), false);
});

test('CameraAccessory: motion auto-clears if the end event never arrives', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Front Door', serial: 'AA', isDoorbell: false }, t);
  const svc = acc.getService(Service.MotionSensor);
  cam.applyDetection('motion', true);
  assert.equal(svc.value(C.MotionDetected), true);
  t.fireLast(); // simulate the safety timer elapsing
  assert.equal(svc.value(C.MotionDetected), false);
});

test('CameraAccessory: a new motion cancels the prior safety timer', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Front Door', serial: 'AA', isDoorbell: false }, t);
  cam.applyDetection('motion', true);
  const first = t.scheduled.at(-1);
  cam.applyDetection('motion', true);
  assert.equal(first.cleared, true); // the earlier timer was cancelled
});

test('CameraAccessory (doorbell): a ring fires the ProgrammableSwitchEvent', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Doorbell', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Doorbell', serial: 'AA', isDoorbell: true }, t);
  cam.applyDetection('ring', true);
  assert.equal(
    acc.getService(Service.Doorbell).value(C.ProgrammableSwitchEvent),
    C.ProgrammableSwitchEvent.SINGLE_PRESS,
  );
});

test('CameraAccessory (not a doorbell): a ring is ignored (no Doorbell service)', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Cam', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Cam', serial: 'AA', isDoorbell: false }, t);
  cam.applyDetection('ring', true);
  assert.equal(acc.getService(Service.Doorbell), undefined);
});

test('CameraAccessory reports Model "UniFi Protect Camera", not the alarm hub', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Cam', 'u', 0);
  new CameraAccessory(makePlatform(), acc, { name: 'Cam', serial: 'AA', isDoorbell: false }, t);
  assert.equal(acc.getService(Service.AccessoryInformation).value(C.Model), 'UniFi Protect Camera');
});

test('CameraAccessory: a doorbell-trigger switch rings the doorbell and self-resets', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Driveway', 'u', 0);
  new CameraAccessory(makePlatform(), acc, { name: 'Driveway', serial: 'AA', isDoorbell: false, doorbellTrigger: true }, t);
  // Subtyped now that doorbell-screen message switches share this accessory.
  const sw = acc.getServiceById(Service.Switch, 'trigger');
  assert.ok(sw, 'a trigger switch is created');
  assert.ok(acc.getService(Service.Doorbell), 'a doorbell service exists so the camera can ring');
  // an automation flips the switch on (e.g. driveway vehicle detected):
  sw.getCharacteristic(C.On).setHandler(true);
  assert.equal(
    acc.getService(Service.Doorbell).value(C.ProgrammableSwitchEvent),
    C.ProgrammableSwitchEvent.SINGLE_PRESS,
  );
  assert.equal(sw.value(C.On), false); // momentary — resets itself after firing
});

test('CameraAccessory.canRing reflects a physical doorbell OR a trigger', () => {
  const t = fakeTimers();
  const mk = (o) => new CameraAccessory(makePlatform(), new FakeAccessory('c', 'u', 0), { name: 'c', serial: 'AA', ...o }, t);
  assert.equal(mk({ isDoorbell: true }).canRing, true);
  assert.equal(mk({ isDoorbell: false, doorbellTrigger: true }).canRing, true);
  assert.equal(mk({ isDoorbell: false }).canRing, false);
});

test('CameraAccessory: no trigger switch unless doorbellTrigger is set', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Cam', 'u', 0);
  new CameraAccessory(makePlatform(), acc, { name: 'Cam', serial: 'AA', isDoorbell: true }, t);
  assert.equal(acc.getService(Service.Switch), undefined);
});

// --- Reachability ------------------------------------------------------------
// A camera Protect reports as DISCONNECTED keeps its accessory (room, name and automations
// survive the outage) but must stop presenting confident readings.

test('CameraAccessory: an offline camera is marked inactive and its motion cleared', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Side Yard', 'u', 0);
  const cam = new CameraAccessory(makePlatform(), acc, { name: 'Side Yard', serial: 'AA', isDoorbell: false }, t);
  const svc = acc.getService(Service.MotionSensor);
  assert.equal(svc.value(C.StatusActive), true); // healthy by default

  cam.applyDetection('motion', true);
  cam.setOnline(false);

  assert.equal(svc.value(C.StatusActive), false);
  // The 'end' event for that detection can never arrive now, so it must not stay latched on.
  assert.equal(svc.value(C.MotionDetected), false);

  cam.setOnline(true);
  assert.equal(svc.value(C.StatusActive), true);
});

test('CameraAccessory: a failing snapshot marks the camera inactive, a good one restores it', async () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Garage', 'u', 0);
  let healthy = false;
  const source = {
    getSnapshot: async () => {
      if (!healthy) {
        throw new Error('camera not responding');
      }
      return Buffer.from([1]);
    },
  };
  new CameraAccessory(makePlatform(), acc, { name: 'Garage', serial: 'AA', isDoorbell: false, streaming: true, source }, t);
  const svc = acc.getService(Service.MotionSensor);
  const delegate = acc.controller.delegate;
  const snapshot = () =>
    new Promise((resolve) => delegate.handleSnapshotRequest({}, (err, buf) => resolve(err ?? buf)));

  await snapshot();
  assert.equal(svc.value(C.StatusActive), false); // the console can't reach it either

  healthy = true;
  await snapshot();
  assert.equal(svc.value(C.StatusActive), true);
});

test('CameraAccessory: an offline camera is not asked for snapshots at all', async () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Garage', 'u', 0);
  let calls = 0;
  const source = {
    getSnapshot: async () => {
      calls += 1;
      return Buffer.from([1]);
    },
  };
  const cam = new CameraAccessory(
    makePlatform(),
    acc,
    { name: 'Garage', serial: 'AA', isDoorbell: false, streaming: true, source },
    t,
  );
  const delegate = acc.controller.delegate;
  cam.setOnline(false);

  const err = await new Promise((resolve) => delegate.handleSnapshotRequest({}, resolve));

  assert.match(err.message, /offline/);
  assert.equal(calls, 0, 'an offline camera must not generate console requests');
});

// --- Audio alarm sensors -----------------------------------------------------
// Smoke/CO use their NATIVE HomeKit services rather than motion sensors, because only those are
// first-class automation triggers and earn a Home hub critical notification.

test('AlarmSensorAccessory: smoke uses SmokeSensor with the right enum values', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door Smoke Alarm', 'u', 0);
  const s = new AlarmSensorAccessory(
    makePlatform(), acc, { name: 'Front Door Smoke Alarm', serial: 'AA:smoke', kind: 'smoke' }, t);
  const svc = acc.getService(Service.SmokeSensor);
  assert.ok(svc, 'a native SmokeSensor service is created');
  assert.equal(acc.getService(Service.MotionSensor), undefined, 'not a motion sensor');
  assert.equal(svc.value(C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED);

  s.applyDetection(true);
  assert.equal(svc.value(C.SmokeDetected), C.SmokeDetected.SMOKE_DETECTED);
  s.applyDetection(false);
  assert.equal(svc.value(C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED);
});

test('AlarmSensorAccessory: CO uses CarbonMonoxideSensor', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door CO Alarm', 'u', 0);
  const s = new AlarmSensorAccessory(
    makePlatform(), acc, { name: 'Front Door CO Alarm', serial: 'AA:co', kind: 'carbonMonoxide' }, t);
  const svc = acc.getService(Service.CarbonMonoxideSensor);
  assert.ok(svc);
  assert.equal(acc.getService(Service.SmokeSensor), undefined);
  s.applyDetection(true);
  assert.equal(svc.value(C.CarbonMonoxideDetected), C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);
});

// A latched alarm sensor would keep re-firing automations forever if the end event were lost.
test('AlarmSensorAccessory: auto-clears if the end event never arrives', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Smoke', 'u', 0);
  const s = new AlarmSensorAccessory(makePlatform(), acc, { name: 'Smoke', serial: 'AA', kind: 'smoke' }, t);
  s.applyDetection(true);
  t.fireLast();
  assert.equal(acc.getService(Service.SmokeSensor).value(C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED);
});

test('AlarmSensorAccessory: an offline camera deactivates and clears the sensor', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Smoke', 'u', 0);
  const s = new AlarmSensorAccessory(makePlatform(), acc, { name: 'Smoke', serial: 'AA', kind: 'smoke' }, t);
  const svc = acc.getService(Service.SmokeSensor);
  s.applyDetection(true);
  s.setOnline(false);
  assert.equal(svc.value(C.StatusActive), false);
  assert.equal(svc.value(C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED);
});

// --- Doorbell screen messages -------------------------------------------------
// One switch per message, mutually exclusive because the screen shows one thing. Clearing works only
// via a past `resetAt` (see doorbellMessages.ts for the alternatives that return HTTP 500).

const MESSAGES = [
  { key: 'LEAVE_PACKAGE_AT_DOOR', label: 'Leave Package At Door', type: 'LEAVE_PACKAGE_AT_DOOR' },
  { key: 'custom:Back soon', label: 'Back soon', type: 'CUSTOM_MESSAGE', text: 'Back soon' },
];

function withMessages({ patchError, now = () => 1_000_000 } = {}) {
  const patches = [];
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const platform = makePlatform();
  const handler = new CameraAccessory(platform, acc, {
    name: 'Front Door', serial: 'bell1', isDoorbell: true,
    messages: MESSAGES,
    messageSink: {
      async patchCamera(id, patch) {
        patches.push({ id, patch });
        if (patchError) {
          throw patchError;
        }
      },
    },
    now,
  });
  const sw = (key) => acc.getServiceById(Service.Switch, `msg:${key}`);
  return { handler, acc, platform, patches, sw };
}

test('a switch is created per configured message, with its label', () => {
  const { sw } = withMessages();
  assert.ok(sw('LEAVE_PACKAGE_AT_DOOR'));
  assert.ok(sw('custom:Back soon'));
  assert.equal(sw('custom:Back soon').value(C.Name), 'Back soon');
});

test('turning a preset on sends a bare type', async () => {
  const { sw, patches } = withMessages();
  await sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(true);
  assert.deepEqual(patches, [{ id: 'bell1', patch: { lcdMessage: { type: 'LEAVE_PACKAGE_AT_DOOR', resetAt: null } } }]);
});

test('turning a custom message on sends type and text', async () => {
  const { sw, patches } = withMessages();
  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  assert.deepEqual(patches[0].patch, { lcdMessage: { type: 'CUSTOM_MESSAGE', text: 'Back soon', resetAt: null } });
});

// The screen shows one message, so HomeKit must not show two switches on.
test('setting a second message turns the first switch off', async () => {
  const { sw } = withMessages();
  await sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(true);
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), true);

  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  assert.equal(sw('custom:Back soon').value(C.On), true);
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), false, 'only one message can be displayed');
});

test('turning the active switch off clears the screen with a past resetAt', async () => {
  const { sw, patches } = withMessages({ now: () => 5_000_000 });
  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(false);

  const cleared = patches[1].patch.lcdMessage;
  assert.ok(cleared.resetAt < 5_000_000, 'a past resetAt is the only thing that clears it');
  assert.equal(cleared.type, 'CUSTOM_MESSAGE', 'type must still be present or validation fails');
  assert.equal(cleared.text, 'Back soon');
  assert.equal(sw('custom:Back soon').value(C.On), false);
});

// HomeKit sweeps "all off" across a room; that must not wipe a message another switch just set.
test('turning an inactive switch off is a no-op, not a clear', async () => {
  const { sw, patches } = withMessages();
  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  await sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(false);

  assert.equal(patches.length, 1, 'no second write');
  assert.equal(sw('custom:Back soon').value(C.On), true, 'the active message survives');
});

test('a failed write surfaces an error rather than a false success', async () => {
  const { sw, platform } = withMessages({ patchError: new Error('HTTP 500') });
  await assert.rejects(() => sw('custom:Back soon').getCharacteristic(C.On).setHandler(true));
  assert.ok(platform.log.entries.some((e) => e.level === 'error' && /HTTP 500/.test(e.msg)));
});

// The console is the source of truth: a message set in the Protect app should show up in HomeKit.
test('a message set outside HomeKit is reflected on the right switch', () => {
  const { handler, sw } = withMessages();
  handler.updateMessages({ type: 'LEAVE_PACKAGE_AT_DOOR', text: 'LEAVE PACKAGE AT DOOR', resetAt: null });
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), true);

  handler.updateMessages({});
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), false, 'a blank screen means every switch off');
});

test('an unrecognised message leaves every switch off rather than guessing', () => {
  const { handler, sw } = withMessages();
  handler.updateMessages({ type: 'CUSTOM_MESSAGE', text: 'Typed in the app' });
  assert.equal(sw('custom:Back soon').value(C.On), false);
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), false);
});

test('no message switches when none are configured', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  new CameraAccessory(makePlatform(), acc, { name: 'Front Door', serial: 'b', isDoorbell: true });
  assert.equal(acc.services.filter((s) => s.subtype?.startsWith('msg:')).length, 0);
});

// A cached accessory keeps services from a previous config; a switch for a removed message would
// still write it.
test('a switch for a message no longer configured is removed', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const platform = makePlatform();
  const sink = { async patchCamera() {} };
  new CameraAccessory(platform, acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, messages: MESSAGES, messageSink: sink,
  });
  assert.equal(acc.services.filter((s) => s.subtype?.startsWith('msg:')).length, 2);

  // Re-created with only one message, as happens after a config edit + restart.
  new CameraAccessory(platform, acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, messages: [MESSAGES[0]], messageSink: sink,
  });
  const left = acc.services.filter((s) => s.subtype?.startsWith('msg:'));
  assert.deepEqual(left.map((s) => s.subtype), ['msg:LEAVE_PACKAGE_AT_DOOR']);
});

// --- Status light -------------------------------------------------------------

function withStatusLed({ patchError, statusLed = true } = {}) {
  const patches = [];
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const platform = makePlatform();
  const handler = new CameraAccessory(platform, acc, {
    name: 'Front Door', serial: 'bell1', isDoorbell: true, statusLed,
    messageSink: {
      async patchCamera(id, patch) {
        patches.push({ id, patch });
        if (patchError) {
          throw patchError;
        }
      },
    },
  });
  return { handler, acc, platform, patches, sw: () => acc.getServiceById(Service.Switch, 'led') };
}

test('a status-light switch is created, labelled, and defaults to on', () => {
  const { sw } = withStatusLed();
  assert.ok(sw());
  assert.equal(sw().value(C.Name), 'Front Door Status Light');
});

// Only isEnabled is sent: the console MERGES a partial ledSettings write, so welcomeLed and floodLed
// keep whatever the user set in Protect. (A chime's ringSettings replaces instead — do not confuse.)
test('turning the light off sends only isEnabled', async () => {
  const { sw, patches } = withStatusLed();
  await sw().getCharacteristic(C.On).setHandler(false);
  assert.deepEqual(patches, [{ id: 'bell1', patch: { ledSettings: { isEnabled: false } } }]);
});

test('turning it back on sends isEnabled true', async () => {
  const { sw, patches } = withStatusLed();
  await sw().getCharacteristic(C.On).setHandler(false);
  await sw().getCharacteristic(C.On).setHandler(true);
  assert.deepEqual(patches[1].patch, { ledSettings: { isEnabled: true } });
  assert.equal(sw().value(C.On), true);
});

test('a failed write surfaces an error rather than a false success', async () => {
  const { sw, platform } = withStatusLed({ patchError: new Error('HTTP 500') });
  await assert.rejects(() => sw().getCharacteristic(C.On).setHandler(false));
  assert.ok(platform.log.entries.some((e) => e.level === 'error' && /HTTP 500/.test(e.msg)));
});

test('a change made in Protect is reflected on the switch', () => {
  const { handler, sw } = withStatusLed();
  handler.updateStatusLed(false);
  assert.equal(sw().value(C.On), false);
  handler.updateStatusLed(true);
  assert.equal(sw().value(C.On), true);
});

test('no switch for a camera that cannot control its light', () => {
  const { sw } = withStatusLed({ statusLed: false });
  assert.equal(sw(), undefined);
});

// A cached accessory would otherwise keep a switch whose writes the console ignores.
test('a cached status-light switch is removed when the camera cannot control it', () => {
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const platform = makePlatform();
  const sink = { async patchCamera() {} };
  new CameraAccessory(platform, acc, { name: 'Front Door', serial: 'b', isDoorbell: true, statusLed: true, messageSink: sink });
  assert.ok(acc.getServiceById(Service.Switch, 'led'));

  new CameraAccessory(platform, acc, { name: 'Front Door', serial: 'b', isDoorbell: true, statusLed: false, messageSink: sink });
  assert.equal(acc.getServiceById(Service.Switch, 'led'), undefined);
});

// Discovery runs every few minutes and could report the pre-write value.
test('a discovery pass mid-write does not flap the switch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const handler = new CameraAccessory(makePlatform(), acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, statusLed: true,
    messageSink: { async patchCamera() { await gate; } },
  });
  const sw = acc.getServiceById(Service.Switch, 'led');

  const pending = sw.getCharacteristic(C.On).setHandler(false);
  handler.updateStatusLed(true);          // stale snapshot arrives mid-write
  assert.notEqual(sw.value(C.On), true, 'the in-flight write must win over a stale snapshot');
  release();
  await pending;
  assert.equal(sw.value(C.On), false);
});

// Two quick taps used to fire concurrent PATCHes; whichever landed last won, so HomeKit could show a
// different message than the console until the next discovery pass minutes later.
test('rapid message presses apply in order, and the last one wins', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const handler = new CameraAccessory(makePlatform(), acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, messages: MESSAGES,
    messageSink: {
      async patchCamera(_id, patch) {
        order.push(patch.lcdMessage.type === 'CUSTOM_MESSAGE' ? patch.lcdMessage.text : patch.lcdMessage.type);
        if (order.length === 1) {
          await gate; // hold the first write open so the second must queue
        }
      },
    },
  });
  const sw = (k) => acc.getServiceById(Service.Switch, `msg:${k}`);

  // The queue chains off a resolved promise, so a write starts on a microtask, not synchronously.
  const tick = () => new Promise((r) => setImmediate(r));
  const first = sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(true);
  await tick();
  assert.deepEqual(order, ['LEAVE_PACKAGE_AT_DOOR'], 'the first write started');
  const second = sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  await tick();
  assert.deepEqual(order, ['LEAVE_PACKAGE_AT_DOOR'], 'the second must wait, not race');
  release();
  await Promise.all([first, second]);

  assert.deepEqual(order, ['LEAVE_PACKAGE_AT_DOOR', 'Back soon'], 'applied in the order pressed');
  assert.equal(sw('custom:Back soon').value(C.On), true, 'the last press wins');
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), false);
  handler.updateMessages({ type: 'CUSTOM_MESSAGE', text: 'Back soon' });
});

// A failed write must not wedge the queue for everything after it.
test('a failed write does not block the next one', async () => {
  let n = 0;
  const acc = new FakeAccessory('Front Door', 'u', 0);
  new CameraAccessory(makePlatform(), acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, messages: MESSAGES,
    messageSink: {
      async patchCamera() {
        n += 1;
        if (n === 1) {
          throw new Error('HTTP 500');
        }
      },
    },
  });
  const sw = (k) => acc.getServiceById(Service.Switch, `msg:${k}`);
  await assert.rejects(() => sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(true));
  await sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  assert.equal(n, 2, 'the queue kept moving after a failure');
  assert.equal(sw('custom:Back soon').value(C.On), true);
});

// The guard must hold for the whole queue, not just the write currently in flight.
test('a discovery pass while writes are queued does not flap the switches', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const acc = new FakeAccessory('Front Door', 'u', 0);
  const handler = new CameraAccessory(makePlatform(), acc, {
    name: 'Front Door', serial: 'b', isDoorbell: true, messages: MESSAGES,
    messageSink: { async patchCamera() { await gate; } },
  });
  const sw = (k) => acc.getServiceById(Service.Switch, `msg:${k}`);

  const a = sw('LEAVE_PACKAGE_AT_DOOR').getCharacteristic(C.On).setHandler(true);
  const b = sw('custom:Back soon').getCharacteristic(C.On).setHandler(true);
  // A stale snapshot that matches a real plan, arriving while both writes are still queued.
  handler.updateMessages({ type: 'LEAVE_PACKAGE_AT_DOOR', text: 'LEAVE PACKAGE AT DOOR' });
  release();
  await Promise.all([a, b]);

  assert.equal(sw('custom:Back soon').value(C.On), true, 'the queued writes win over the stale snapshot');
  assert.equal(sw('LEAVE_PACKAGE_AT_DOOR').value(C.On), false);
});

// --- Smart-detect sensors ----------------------------------------------------
// The detections live on the camera accessory as CONTACT sensors, one accessory per camera. Contact
// rather than motion is load-bearing: a camera accessory's MotionSensor is HomeKit's singular "this
// camera detected motion" signal (it drives camera notifications and HKSV recording), so extra
// motion services would make one physical event report several times.

const withTypes = (t, types, name = 'Gatehouse') => {
  const acc = new FakeAccessory(name, 'u', 0);
  const cam = new CameraAccessory(
    makePlatform(), acc, { name, serial: 'AA', isDoorbell: false, objectTypes: types }, t,
  );
  return { acc, cam };
};
const contact = (acc, type) => acc.getServiceById(Service.ContactSensor, `smartDetect.${type}`);

test('one contact sensor per detection type, and exactly one motion sensor', () => {
  const { acc } = withTypes(fakeTimers(), ['person', 'vehicle']);
  assert.ok(contact(acc, 'person'), 'person contact sensor exists');
  assert.ok(contact(acc, 'vehicle'), 'vehicle contact sensor exists');
  assert.equal(acc.services.filter((s) => s.token === Service.MotionSensor).length, 1);
  assert.equal(contact(acc, 'person').value(C.Name), 'Gatehouse Person');
  assert.equal(contact(acc, 'vehicle').value(C.Name), 'Gatehouse Vehicle');
});

test('no objectTypes means no contact sensors at all (motion only)', () => {
  const { acc } = withTypes(fakeTimers(), []);
  assert.equal(acc.services.filter((s) => s.token === Service.ContactSensor).length, 0);
});

test('a smart detection trips its own contact sensor and nothing else', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person', 'vehicle']);
  cam.applyObjectDetection('person', true);

  assert.equal(contact(acc, 'person').value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(contact(acc, 'vehicle').value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
  // The camera's own motion sensor is NOT tripped by an object detection routed here — that
  // signal belongs to the camera's motion event, and double-reporting is the thing being avoided.
  assert.equal(acc.getService(Service.MotionSensor).value(C.MotionDetected), false);

  cam.applyObjectDetection('person', false);
  assert.equal(contact(acc, 'person').value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
});

test('hasObjectSensor reports only the types this camera actually carries', () => {
  const { cam } = withTypes(fakeTimers(), ['person']);
  assert.equal(cam.hasObjectSensor('person'), true);
  assert.equal(cam.hasObjectSensor('vehicle'), false);
  // Guards the routing fallback: an unknown type must not be swallowed here.
  assert.equal(cam.hasObjectSensor('constructor'), false);
});

// A missed 'end' would otherwise leave a detection latched, firing automations forever.
test('a smart detection safety-clears like the motion sensor does', () => {
  const t = fakeTimers();
  const { acc, cam } = withTypes(t, ['person']);
  cam.applyObjectDetection('person', true);
  assert.equal(contact(acc, 'person').value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);

  t.fireLast();
  assert.equal(contact(acc, 'person').value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
});

test('an offline camera deactivates its detection sensors and clears a latched one', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person']);
  cam.applyObjectDetection('person', true);
  cam.setOnline(false);

  assert.equal(contact(acc, 'person').value(C.StatusActive), false);
  assert.equal(contact(acc, 'person').value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);

  cam.setOnline(true);
  assert.equal(contact(acc, 'person').value(C.StatusActive), true);
});

test('a camera rename renames its detection sensors too', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person']);
  cam.setName('Gate House');
  assert.equal(contact(acc, 'person').value(C.Name), 'Gate House Person');
  assert.equal(contact(acc, 'person').value(C.ConfiguredName), 'Gate House Person');
});

// REGRESSION: with only `Name` set, the Home app listed these as "Contact Sensor 1/2/3" — it reads
// ConfiguredName for services it shows as separate controls under one accessory. Caught in the
// real Home app, not by any test, because the HAP structure looked correct either way.
test('detection sensors carry ConfiguredName, which is what the Home app displays', () => {
  const { acc } = withTypes(fakeTimers(), ['person', 'vehicle']);
  assert.equal(contact(acc, 'person').value(C.ConfiguredName), 'Gatehouse Person');
  assert.equal(contact(acc, 'vehicle').value(C.ConfiguredName), 'Gatehouse Vehicle');
});

// Turning a detection type off in Protect must not leave a control
// that HomeKit still shows and nothing can ever drive.
test('a contact sensor for a type no longer wanted is removed on the next construction', () => {
  const acc = new FakeAccessory('Gatehouse', 'u', 0);
  const opts = { name: 'Gatehouse', serial: 'AA', isDoorbell: false };
  new CameraAccessory(makePlatform(), acc, { ...opts, objectTypes: ['person', 'vehicle'] }, fakeTimers());
  assert.ok(contact(acc, 'vehicle'));

  new CameraAccessory(makePlatform(), acc, { ...opts, objectTypes: ['person'] }, fakeTimers());
  assert.ok(contact(acc, 'person'), 'the still-wanted sensor survives');
  assert.equal(contact(acc, 'vehicle'), undefined, 'the dropped one is removed');

  new CameraAccessory(makePlatform(), acc, { ...opts, objectTypes: [] }, fakeTimers());
  assert.equal(acc.services.filter((s) => s.token === Service.ContactSensor).length, 0);
});

// --- Restored-from-cache state ------------------------------------------------
// Homebridge restores an accessory's cached characteristic VALUES. A detection that was still live
// when Homebridge stopped therefore comes back latched, and the safety timeout cannot help: it only
// covers detections seen in the current session. These simulate the restore by pre-setting the
// characteristic before construction, which is the shape the real bug had.

test('a camera restored with motion latched ON is cleared at construction', () => {
  const acc = new FakeAccessory('Gatehouse', 'u', 0);
  acc.addService(Service.MotionSensor).updateCharacteristic(C.MotionDetected, true);

  new CameraAccessory(makePlatform(), acc, { name: 'Gatehouse', serial: 'AA', isDoorbell: false }, fakeTimers());

  assert.equal(acc.getService(Service.MotionSensor).value(C.MotionDetected), false);
});

test('a contact sensor restored TRIPPED is cleared at construction', () => {
  const acc = new FakeAccessory('Gatehouse', 'u', 0);
  acc.addService(Service.ContactSensor, 'Gatehouse Person', 'smartDetect.person')
    .updateCharacteristic(C.ContactSensorState, C.ContactSensorState.CONTACT_NOT_DETECTED);

  new CameraAccessory(
    makePlatform(), acc,
    { name: 'Gatehouse', serial: 'AA', isDoorbell: false, objectTypes: ['person'] },
    fakeTimers(),
  );

  assert.equal(
    acc.getServiceById(Service.ContactSensor, 'smartDetect.person').value(C.ContactSensorState),
    C.ContactSensorState.CONTACT_DETECTED,
  );
});

// setObjectTypes runs on EVERY discovery pass now. If it rebuilt the services or their controllers,
// a detection that was live would be cleared every few minutes, and any pending safety-clear lost.
test('reconciling unchanged types is idempotent and preserves a live detection', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person', 'vehicle']);
  const before = acc.getServiceById(Service.ContactSensor, 'smartDetect.person');
  cam.applyObjectDetection('person', true);

  cam.setObjectTypes(['person', 'vehicle']); // a later discovery pass, nothing changed

  assert.equal(
    acc.getServiceById(Service.ContactSensor, 'smartDetect.person'), before,
    'the same service object must be reused, not replaced',
  );
  assert.equal(
    before.value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED,
    'a live detection must survive a discovery pass',
  );
});

test('reconciling adds a newly-enabled type and drops a removed one', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person']);

  cam.setObjectTypes(['person', 'animal']);
  assert.ok(contact(acc, 'animal'), 'a type enabled in Protect appears without a restart');

  cam.setObjectTypes(['animal']);
  assert.equal(contact(acc, 'person'), undefined, 'a removed type leaves no dead control');
  // And routing must agree with what actually exists.
  assert.equal(cam.hasObjectSensor('person'), false);
  assert.equal(cam.hasObjectSensor('animal'), true);
});

// REGRESSION: `opts.name` is the name at CONSTRUCTION. A handler outlives a rename in Protect, so
// anything deriving a label from it produced the OLD camera name — visible when a detection type is
// enabled in Protect after a rename: the new sensor disagreed with its siblings.
test('a sensor added AFTER a rename uses the new camera name', () => {
  const { acc, cam } = withTypes(fakeTimers(), ['person']);

  cam.setName('Back Gate');
  cam.setObjectTypes(['person', 'animal']); // a type enabled in Protect after the rename

  assert.equal(contact(acc, 'person').value(C.Name), 'Back Gate Person', 'existing sensor follows');
  assert.equal(contact(acc, 'animal').value(C.Name), 'Back Gate Animal', 'and so does a new one');
  assert.equal(contact(acc, 'animal').value(C.ConfiguredName), 'Back Gate Animal');
});
