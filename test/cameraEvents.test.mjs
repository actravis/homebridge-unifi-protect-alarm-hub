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

test('every smart* variant is decoded, whatever Protect names it', () => {
  // This list is deliberately not an allow-list in the source: the previous `smartDetect` prefix
  // excluded `smartAudioDetect` and dropped every smoke/CO detection without a trace.
  for (const type of ['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone', 'smartAudioDetect']) {
    assert.deepEqual(
      decodeCameraEvent({ item: { type, device: 'c1', smartDetectTypes: ['package'] } }),
      [{ deviceId: 'c1', kind: 'package', active: true }],
      `type ${type}`,
    );
  }
});


// REGRESSION: the prefix was `smartDetect`, and Protect names audio detection `smartAudioDetect`
// — which does not match. Every smoke and CO alarm detection was being silently dropped. Match
// the whole `smart*` family and read whatever types the payload carries.
test('audio detections are decoded, not dropped by a too-narrow prefix', () => {
  assert.deepEqual(
    decodeCameraEvent({ item: { type: 'smartAudioDetect', device: 'c1', smartDetectTypes: ['alrmSmoke'] } }),
    [{ deviceId: 'c1', kind: 'alrmSmoke', active: true }],
  );
  // The combined smoke/CO type the live console reports.
  assert.deepEqual(
    decodeCameraEvent({ item: { type: 'smartAudioDetect', device: 'c1', smartDetectTypes: ['smoke_cmonx'] } }),
    [{ deviceId: 'c1', kind: 'smoke_cmonx', active: true }],
  );
});

test('non-smart event types are still left to the alarm path', () => {
  for (const type of ['alarmHubEntryOpened', 'alarmHubEntryClosed', 'somethingElse']) {
    assert.deepEqual(decodeCameraEvent({ item: { type, device: 'h1' } }), [], type);
  }
});
