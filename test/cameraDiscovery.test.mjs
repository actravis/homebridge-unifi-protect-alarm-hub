import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  audioSensorKey,
  cameraKey,
  isDoorbell,
  objectSensorKey,
  planCameraAccessories,
  selectCameras,
} from '../dist/cameraDiscovery.js';

const cam = (over = {}) => ({ id: 'c1', modelKey: 'camera', name: 'Front Door', featureFlags: {}, ...over });

test('plans one entry per camera with its name and object types', () => {
  const plan = planCameraAccessories([cam({ featureFlags: { smartDetectTypes: ['person', 'vehicle'] } })], {});
  assert.equal(plan.length, 1);
  assert.equal(plan[0].deviceId, 'c1');
  assert.equal(plan[0].name, 'Front Door');
  assert.deepEqual(plan[0].objectTypes, ['person', 'vehicle']);
});

test('a camera with an LCD screen is treated as a doorbell', () => {
  assert.equal(isDoorbell(cam({ lcdMessage: { text: 'HELLO' } })), true);
  assert.equal(isDoorbell(cam({ lcdMessage: { type: 'LEAVE_PACKAGE_AT_DOOR' } })), true);
  assert.equal(isDoorbell(cam()), false);
});

// REGRESSION: the live API returns `lcdMessage: {}` — an empty object, NOT null/absent — for
// every non-doorbell camera. A `!= null` check therefore matched all of them and every camera
// was published as a VIDEO_DOORBELL. These fixtures are the shapes the real console returns.
test('an empty lcdMessage object is NOT a doorbell', () => {
  const plainCamera = { lcdMessage: {}, featureFlags: { hasSpeaker: false, smartDetectTypes: ['person', 'vehicle', 'animal'] } };
  assert.equal(isDoorbell(cam(plainCamera)), false);

  const realDoorbell = {
    lcdMessage: { type: 'LEAVE_PACKAGE_AT_DOOR', resetAt: null, text: 'LEAVE PACKAGE AT DOOR' },
    featureFlags: { hasSpeaker: true, smartDetectTypes: ['person', 'vehicle', 'animal', 'package'] },
  };
  assert.equal(isDoorbell(cam(realDoorbell)), true);
});

test('speaker + package detection identifies a doorbell with no LCD message set', () => {
  const flags = { hasSpeaker: true, smartDetectTypes: ['person', 'vehicle', 'animal', 'package'] };
  assert.equal(isDoorbell(cam({ lcdMessage: {}, featureFlags: flags })), true);
  // Either signal alone is not enough — plain cameras have a mic but no speaker/package.
  assert.equal(isDoorbell(cam({ featureFlags: { hasSpeaker: true, smartDetectTypes: ['person'] } })), false);
  assert.equal(isDoorbell(cam({ featureFlags: { hasSpeaker: false, smartDetectTypes: ['package'] } })), false);
});

test('doorbellDeviceIds overrides the heuristic', () => {
  assert.equal(isDoorbell(cam(), { doorbellDeviceIds: ['c1'] }), true);
  assert.equal(isDoorbell(cam({ lcdMessage: { text: 'x' } }), { doorbellDeviceIds: ['other'] }), true); // heuristic still applies
});

test('exposeCameras:false plans nothing', () => {
  assert.deepEqual(planCameraAccessories([cam()], { exposeCameras: false }), []);
});

test('exposeObjectSensors:false keeps the camera but drops object types', () => {
  const plan = planCameraAccessories([cam({ featureFlags: { smartDetectTypes: ['person'] } })], { exposeObjectSensors: false });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].objectTypes, []);
});

test('a camera with no smart-detect capability plans no object types', () => {
  assert.deepEqual(planCameraAccessories([cam({ featureFlags: {} })], {})[0].objectTypes, []);
});

test('an unnamed camera falls back to "Camera"', () => {
  assert.equal(planCameraAccessories([cam({ name: undefined })], {})[0].name, 'Camera');
});

// --- Accessory key agreement ------------------------------------------------
// These seeds are hashed into HomeKit UUIDs in two independent places: where accessories are
// created (syncCamerasOnce) and where realtime detections are routed to them (routeEvent).
// They were inline template strings in both; a typo in either silently sent every detection
// to a handler that didn't exist, with no error anywhere.

test('cameraKey/objectSensorKey are stable and distinct', () => {
  assert.equal(cameraKey('abc123'), 'abc123:camera');
  assert.equal(objectSensorKey('abc123', 'person'), 'abc123:object:person');

  // A camera key can never collide with one of its own object-sensor keys...
  assert.notEqual(cameraKey('abc123'), objectSensorKey('abc123', 'camera'));
  // ...nor can two different cameras or two different detection types collide.
  assert.notEqual(cameraKey('abc123'), cameraKey('abc124'));
  assert.notEqual(objectSensorKey('abc123', 'person'), objectSensorKey('abc123', 'vehicle'));
  assert.notEqual(objectSensorKey('abc123', 'person'), objectSensorKey('abc124', 'person'));
});

test('every planned object type produces a routable key', () => {
  const types = ['person', 'vehicle', 'animal', 'package'];
  const plan = planCameraAccessories([cam({ featureFlags: { smartDetectTypes: types } })], {})[0];
  // What discovery creates must equal what event routing looks up, for every type.
  for (const type of plan.objectTypes) {
    assert.equal(objectSensorKey(plan.deviceId, type), `${plan.deviceId}:object:${type}`);
  }
  assert.deepEqual(plan.objectTypes, types);
});

// --- Reachability + detection-settings gaps ---------------------------------

test('a DISCONNECTED camera is planned as offline, everything else as online', () => {
  assert.equal(planCameraAccessories([cam({ state: 'DISCONNECTED' })], {})[0].online, false);
  assert.equal(planCameraAccessories([cam({ state: 'CONNECTED' })], {})[0].online, true);
  // An absent state must not be read as offline — marking a healthy camera unavailable in
  // HomeKit is a worse failure than briefly trusting a dead one.
  assert.equal(planCameraAccessories([cam()], {})[0].online, true);
  assert.equal(planCameraAccessories([cam({ state: 'SOMETHING_NEW' })], {})[0].online, true);
});

test('object types the camera supports but has switched off are reported', () => {
  const plan = planCameraAccessories(
    [
      cam({
        featureFlags: { smartDetectTypes: ['person', 'vehicle', 'package'] },
        smartDetectSettings: { objectTypes: ['person'] },
      }),
    ],
    {},
  )[0];
  // The sensors are still exposed — the user may switch detection on later.
  assert.deepEqual(plan.objectTypes, ['person', 'vehicle', 'package']);
  assert.deepEqual(plan.disabledObjectTypes, ['vehicle', 'package']);
});

test('no settings block means "unknown", not "everything is disabled"', () => {
  const plan = planCameraAccessories([cam({ featureFlags: { smartDetectTypes: ['person'] } })], {})[0];
  assert.deepEqual(plan.disabledObjectTypes, []);
});

// --- Audio alarm sensors -----------------------------------------------------

test('audio alarm sensors are off unless explicitly enabled', () => {
  const c = cam({ smartDetectSettings: { audioTypes: ['alrmSmoke', 'alrmCmonx'] } });
  assert.deepEqual(planCameraAccessories([c], {})[0].alarmKinds, []);
  assert.deepEqual(planCameraAccessories([c], { exposeAudioSensors: false })[0].alarmKinds, []);
});

test('enabled audio types become the matching native sensors', () => {
  const plan = planCameraAccessories(
    [cam({ smartDetectSettings: { audioTypes: ['alrmSmoke', 'alrmCmonx'] } })],
    { exposeAudioSensors: true },
  )[0];
  assert.deepEqual(plan.alarmKinds, ['smoke', 'carbonMonoxide']);
});

// Observed live: Front Door has both `alrmSmoke` and the combined `smoke_cmonx` enabled. Both
// mean smoke, and two accessories called "Front Door Smoke Alarm" would be useless.
test('overlapping types collapse to one sensor per HomeKit service', () => {
  const plan = planCameraAccessories(
    [cam({ smartDetectSettings: { audioTypes: ['smoke_cmonx', 'alrmSmoke', 'alrmCmonx'] } })],
    { exposeAudioSensors: true },
  )[0];
  assert.deepEqual(plan.alarmKinds, ['smoke', 'carbonMonoxide']);
});

test('audio types with no native service produce no alarm sensor', () => {
  const plan = planCameraAccessories(
    [cam({ smartDetectSettings: { audioTypes: ['alrmBabyCry', 'alrmSpeak'] } })],
    { exposeAudioSensors: true },
  )[0];
  assert.deepEqual(plan.alarmKinds, []);
});

test('audioSensorKey is keyed by service and cannot collide with other sensors', () => {
  assert.equal(audioSensorKey('c1', 'smoke'), 'c1:audio:smoke');
  assert.notEqual(audioSensorKey('c1', 'smoke'), audioSensorKey('c1', 'carbonMonoxide'));
  assert.notEqual(audioSensorKey('c1', 'smoke'), objectSensorKey('c1', 'smoke'));
  assert.notEqual(audioSensorKey('c1', 'smoke'), cameraKey('c1'));
});

// Talkback capability is decided once here, from data /cameras already returns, so the plugin never
// spends a request finding out. Asking a speakerless camera answers 503, and a retried 503 cost ~7s
// of blocked video — see the platform gate.
test('a camera with a speaker is planned as talkback-capable', () => {
  const [plan] = planCameraAccessories(
    [{ id: 'c1', modelKey: 'camera', name: 'Front Door', featureFlags: { hasSpeaker: true } }],
    {},
  );
  assert.equal(plan.hasSpeaker, true);
});

test('a camera without a speaker is not, and an absent flag is treated as no speaker', () => {
  const plans = planCameraAccessories(
    [
      { id: 'c1', modelKey: 'camera', name: 'Gatehouse', featureFlags: { hasSpeaker: false } },
      { id: 'c2', modelKey: 'camera', name: 'Side Yard', featureFlags: {} },
      { id: 'c3', modelKey: 'camera', name: 'Side Deck' },
    ],
    {},
  );
  assert.deepEqual(plans.map((p) => p.hasSpeaker), [false, false, false]);
});

// The status light is only controllable on some models. Offering the switch elsewhere would be a
// control whose writes the console silently ignores, so capability is decided once here from data
// /cameras already returns.
test('a camera reporting a controllable LED is planned as status-led capable', () => {
  const [plan] = planCameraAccessories(
    [{ id: 'c1', modelKey: 'camera', name: 'Front Door', featureFlags: { hasLedStatus: true } }],
    {},
  );
  assert.equal(plan.hasStatusLed, true);
});

test('a camera without a controllable LED is not, and an absent flag means no', () => {
  const plans = planCameraAccessories(
    [
      { id: 'c1', modelKey: 'camera', name: 'A', featureFlags: { hasLedStatus: false } },
      { id: 'c2', modelKey: 'camera', name: 'B', featureFlags: {} },
      { id: 'c3', modelKey: 'camera', name: 'C' },
    ],
    {},
  );
  assert.deepEqual(plans.map((p) => p.hasStatusLed), [false, false, false]);
});

test('the light reads as on unless the console says otherwise', () => {
  const cam = (ledSettings) => ({ id: 'c', modelKey: 'camera', name: 'A', featureFlags: { hasLedStatus: true }, ledSettings });
  assert.equal(planCameraAccessories([cam({ isEnabled: true })], {})[0].statusLedOn, true);
  assert.equal(planCameraAccessories([cam({ isEnabled: false })], {})[0].statusLedOn, false);
  // A missing field must not make the switch claim the light is off.
  assert.equal(planCameraAccessories([cam({})], {})[0].statusLedOn, true);
  assert.equal(planCameraAccessories([cam(undefined)], {})[0].statusLedOn, true);
});

// --- selectCameras (the include/exclude filter) -------------------------------

const three = [
  { id: 'aaa', modelKey: 'camera', name: 'Front Door' },
  { id: 'bbb', modelKey: 'camera', name: 'Side Yard' },
  { id: 'ccc', modelKey: 'camera', name: 'Garage / Parking' },
];
const picked = (config) => selectCameras(three, config).selected.map((c) => c.id);

test('no filter configured selects every camera', () => {
  assert.deepEqual(picked({}), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(picked({ includeCameras: [], excludeCameras: [] }), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(selectCameras(three).selected.length, 3);
});

test('a non-empty include list selects only those cameras', () => {
  assert.deepEqual(picked({ includeCameras: ['Front Door', 'ccc'] }), ['aaa', 'ccc']);
});

test('cameras match by device ID or by name', () => {
  assert.deepEqual(picked({ includeCameras: ['bbb'] }), ['bbb']);
  assert.deepEqual(picked({ includeCameras: ['Side Yard'] }), ['bbb']);
});

test('matching ignores case and surrounding whitespace', () => {
  assert.deepEqual(picked({ includeCameras: ['  fRoNt DoOr  ', 'CCC'] }), ['aaa', 'ccc']);
  assert.deepEqual(selectCameras([{ id: 'x', modelKey: 'camera', name: '  Padded  ' }], { includeCameras: ['padded'] }).selected.length, 1);
});

test('exclude is applied after include, so an entry in both is excluded', () => {
  assert.deepEqual(picked({ includeCameras: ['aaa', 'bbb'], excludeCameras: ['Side Yard'] }), ['aaa']);
});

test('exclude alone drops just that camera', () => {
  assert.deepEqual(picked({ excludeCameras: ['Garage / Parking'] }), ['aaa', 'bbb']);
});

// The config comes from a hand-edited config.json, so entries can be anything at all.
test('blank and non-string entries are ignored, not treated as a filter', () => {
  assert.deepEqual(picked({ includeCameras: ['', '   ', null, 42, {}, 'bbb'] }), ['bbb']);
  // An include list of nothing BUT junk must not silently hide every camera.
  assert.deepEqual(picked({ includeCameras: ['', '  '] }), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(picked({ includeCameras: 'Front Door' }), ['aaa', 'bbb', 'ccc']);
});

test('a camera with no name is still selectable by ID', () => {
  const unnamed = [{ id: 'zzz', modelKey: 'camera' }];
  assert.deepEqual(selectCameras(unnamed, { includeCameras: ['zzz'] }).selected.length, 1);
  assert.deepEqual(selectCameras(unnamed, { excludeCameras: ['zzz'] }).selected.length, 0);
});

// A typo in an include list otherwise exposes NO cameras, and a typo in an exclude list silently
// exposes one meant to stay private — both look like plugin faults with nothing to explain them.
test('entries matching no camera are reported as unmatched', () => {
  const { unmatched } = selectCameras(three, { includeCameras: ['Front Dor'], excludeCameras: ['ddd'] });
  assert.deepEqual(unmatched.sort(), ['ddd', 'front dor']);
});

test('entries that do match are not reported', () => {
  assert.deepEqual(selectCameras(three, { includeCameras: ['AAA', 'Side Yard'], excludeCameras: ['ccc'] }).unmatched, []);
});

test('duplicate entries collapse, so a repeat is reported once', () => {
  const { unmatched } = selectCameras(three, { includeCameras: ['nope', 'NOPE', ' nope '] });
  assert.deepEqual(unmatched, ['nope']);
  // Including across the two lists — the same typo pasted into both is still one problem.
  assert.deepEqual(selectCameras(three, { includeCameras: ['nope'], excludeCameras: ['NOPE'] }).unmatched, ['nope']);
});

test('the filter never mutates or reorders the camera list it was given', () => {
  const input = [...three];
  const { selected } = selectCameras(input, { excludeCameras: ['bbb'] });
  assert.deepEqual(input, three);
  assert.notEqual(selected, input);
  assert.deepEqual(selected.map((c) => c.id), ['aaa', 'ccc']);
});
