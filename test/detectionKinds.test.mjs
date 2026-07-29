// Detection-type classification. The mapping matters beyond cosmetics: a smoke alarm surfaced as
// a native HomeKit SmokeSensor is a first-class automation trigger and gets a Home hub critical
// notification; the same event surfaced as "motion detected" gets neither.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alarmSensorKinds, detectionLabel, isAudioDetection, sensorKindsFor } from '../dist/detectionKinds.js';

test('object detections become motion sensors', () => {
  for (const type of ['person', 'vehicle', 'animal', 'package']) {
    assert.deepEqual(sensorKindsFor(type), ['motion'], type);
    assert.equal(isAudioDetection(type), false, type);
  }
});

test('smoke and CO map to their native HomeKit services', () => {
  assert.deepEqual(sensorKindsFor('alrmSmoke'), ['smoke']);
  assert.deepEqual(sensorKindsFor('alrmCmonx'), ['carbonMonoxide']);
  assert.equal(isAudioDetection('alrmSmoke'), true);
  assert.equal(isAudioDetection('alrmCmonx'), true);
});

// Observed live on a camera configured for combined alarm detection: `smoke_cmonx` appears in the
// ENABLED list while being absent from the supported list. One Protect detection, two HomeKit
// sensors — folding it into "smoke" alone would silently drop CO for anyone automating on it.
test('a combined smoke/CO type drives both sensors', () => {
  assert.deepEqual(sensorKindsFor('smoke_cmonx'), ['smoke', 'carbonMonoxide']);
  assert.equal(isAudioDetection('smoke_cmonx'), true);
});

test('audio types with no native HomeKit service fall back to motion', () => {
  assert.deepEqual(sensorKindsFor('alrmBabyCry'), ['motion']);
  assert.deepEqual(sensorKindsFor('alrmSpeak'), ['motion']);
});

// Protect keeps adding detection types. An unknown one must still produce a working sensor.
test('an unrecognised type still yields a sensor rather than nothing', () => {
  assert.deepEqual(sensorKindsFor('somethingBrandNew'), ['motion']);
  assert.deepEqual(sensorKindsFor('alrmGlassBreak'), ['motion']);
  assert.equal(isAudioDetection('alrmGlassBreak'), true, 'the alrm prefix marks it as audio');
});

test('labels are readable, never raw API identifiers', () => {
  assert.equal(detectionLabel('person'), 'Person');
  assert.equal(detectionLabel('package'), 'Package');
  assert.equal(detectionLabel('alrmSmoke'), 'Smoke Alarm');
  assert.equal(detectionLabel('alrmCmonx'), 'CO Alarm');
  assert.equal(detectionLabel('alrmBabyCry'), 'Baby Cry');
  // A combined type needs a distinct label per sensor, or two accessories collide on one name.
  assert.equal(detectionLabel('smoke_cmonx', 'smoke'), 'Smoke Alarm');
  assert.equal(detectionLabel('smoke_cmonx', 'carbonMonoxide'), 'CO Alarm');
  // No label should ever leak an identifier like "AlrmCmonx" to the Home app.
  for (const type of ['alrmSmoke', 'alrmCmonx', 'smoke_cmonx', 'alrmBabyCry', 'alrmSpeak']) {
    assert.doesNotMatch(detectionLabel(type), /alrm/i, type);
  }
});

// --- Prototype pollution -----------------------------------------------------
// Detection types are strings straight from the console. With plain-object lookup tables,
// `sensorKindsFor('constructor')` returned Object.prototype.constructor — a FUNCTION where a
// SensorKind[] was expected. `alarmSensorKinds` iterates that result, so one detection or zone
// named `constructor` threw out of planCameraAccessories and left the user with NO cameras at all.
// `detectionLabel` was worse still: it would have used a function's source text as a HomeKit
// accessory name.
const INHERITED = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

test('inherited Object keys cannot masquerade as detection types', () => {
  for (const key of INHERITED) {
    const kinds = sensorKindsFor(key);
    assert.ok(Array.isArray(kinds), `sensorKindsFor(${key}) returned ${typeof kinds}, not an array`);
    assert.deepEqual(kinds, ['motion'], key);
    assert.equal(isAudioDetection(key), false, key);
  }
});

test('an inherited key still yields a sane accessory label', () => {
  for (const key of INHERITED) {
    const label = detectionLabel(key);
    assert.equal(typeof label, 'string');
    assert.ok(label.length < 40, `label for ${key} looks like leaked source: ${label}`);
    assert.doesNotMatch(label, /function|\[native code\]|=>/, key);
  }
});

test('alarmSensorKinds survives inherited keys instead of throwing out of discovery', () => {
  // This is the path that mattered: a throw here aborts camera discovery entirely.
  assert.doesNotThrow(() => alarmSensorKinds(INHERITED));
  assert.deepEqual(alarmSensorKinds(INHERITED), []);
  // And a real type mixed in with them still works.
  assert.deepEqual(alarmSensorKinds([...INHERITED, 'alrmSmoke']), ['smoke']);
});
