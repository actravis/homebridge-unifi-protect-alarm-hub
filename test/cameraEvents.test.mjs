import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeCameraEvent } from '../dist/cameraEvents.js';

const evt = (item, type = 'add') => ({ type, item: { modelKey: 'event', ...item } });

test('a motion "add" (no end) is an active motion detection', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'motion', device: 'cam1', start: 1 })), [
    { deviceId: 'cam1', kind: 'motion', active: true },
  ]);
});

test('a motion "update" with an end clears the detection', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'motion', device: 'cam1', start: 1, end: 2 }, 'update')), [
    { deviceId: 'cam1', kind: 'motion', active: false },
  ]);
});

test('a ring add fires the doorbell; a ring end does not', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'ring', device: 'db', start: 1 })), [
    { deviceId: 'db', kind: 'ring', active: true },
  ]);
  assert.deepEqual(decodeCameraEvent(evt({ type: 'ring', device: 'db', start: 1, end: 9 }, 'update')), [
    { deviceId: 'db', kind: 'ring', active: false },
  ]);
});

test('smartDetectZone fans out to one detection per smart-detect type', () => {
  const out = decodeCameraEvent(evt({ type: 'smartDetectZone', device: 'cam1', start: 1, smartDetectTypes: ['person', 'vehicle'] }));
  assert.deepEqual(out, [
    { deviceId: 'cam1', kind: 'person', active: true },
    { deviceId: 'cam1', kind: 'vehicle', active: true },
  ]);
});

test('smartDetectLine is treated like smartDetectZone', () => {
  const out = decodeCameraEvent(evt({ type: 'smartDetectLine', device: 'cam1', start: 1, smartDetectTypes: ['animal'] }));
  assert.deepEqual(out, [{ deviceId: 'cam1', kind: 'animal', active: true }]);
});

test('unhandled event types (e.g. alarm-hub events) yield nothing', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'alarmHubEntryOpened', device: 'hub', start: 1 })), []);
});

test('events missing a device or type are ignored', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'motion', start: 1 })), []); // no device
  assert.deepEqual(decodeCameraEvent(evt({ device: 'cam1', start: 1 })), []); // no type
  assert.deepEqual(decodeCameraEvent(undefined), []);
  assert.deepEqual(decodeCameraEvent({}), []);
});

test('a smartDetectZone with no types yields nothing', () => {
  assert.deepEqual(decodeCameraEvent(evt({ type: 'smartDetectZone', device: 'cam1', start: 1 })), []);
});

// --- Forward compatibility ---------------------------------------------------

test('any smartDetect* variant is decoded, not just the two seen in the spike', () => {
  for (const type of ['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone', 'smartAudioDetect']) {
    const decoded = decodeCameraEvent({ item: { type, device: 'c1', smartDetectTypes: ['package'] } });
    assert.deepEqual(
      decoded,
      type.startsWith('smartDetect') ? [{ deviceId: 'c1', kind: 'package', active: true }] : [],
      `type ${type}`,
    );
  }
});

