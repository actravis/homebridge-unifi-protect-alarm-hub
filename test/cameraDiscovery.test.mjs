import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cameraKey, isDoorbell, objectSensorKey, planCameraAccessories } from '../dist/cameraDiscovery.js';

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
