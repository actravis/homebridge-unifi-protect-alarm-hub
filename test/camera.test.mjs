import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlarmSensorAccessory, CameraAccessory, ObjectSensorAccessory } from '../dist/accessories/camera.js';
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

test('ObjectSensorAccessory: an offline camera deactivates its object sensors', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door Person', 'u', 0);
  const sensor = new ObjectSensorAccessory(makePlatform(), acc, { name: 'Front Door Person', serial: 'AA:person' }, t);
  const svc = acc.getService(Service.MotionSensor);
  assert.equal(svc.value(C.StatusActive), true);
  sensor.setOnline(false);
  assert.equal(svc.value(C.StatusActive), false);
});

test('ObjectSensorAccessory: detection drives MotionDetected and safety-clears', () => {
  const t = fakeTimers();
  const acc = new FakeAccessory('Front Door Person', 'u', 0);
  const sensor = new ObjectSensorAccessory(makePlatform(), acc, { name: 'Front Door Person', serial: 'AA:person' }, t);
  const svc = acc.getService(Service.MotionSensor);
  sensor.applyDetection(true);
  assert.equal(svc.value(C.MotionDetected), true);
  t.fireLast();
  assert.equal(svc.value(C.MotionDetected), false);
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
