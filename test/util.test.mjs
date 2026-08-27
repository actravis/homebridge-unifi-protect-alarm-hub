import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDeviceList, redactPayload, redactStreamUrl } from '../dist/util.js';

test('redactStreamUrl reports missing URLs plainly', () => {
  assert.equal(redactStreamUrl(undefined), '<none>');
  assert.equal(redactStreamUrl(''), '<none>');
});

test('redactStreamUrl drops the stream key from an RTSPS URL', () => {
  const secret = 'SUPERSECRETSTREAMKEY123';
  const out = redactStreamUrl(`rtsps://192.168.1.1:7441/${secret}?enableSrtp`);
  // The whole point: the key must never survive into a log line.
  assert.ok(!out.includes(secret), `stream key leaked: ${out}`);
  assert.ok(out.startsWith('rtsps://'), out);
  assert.ok(out.includes('192.168.1.1:7441'), out);
});

test('redactStreamUrl handles non-URL input safely', () => {
  assert.equal(redactStreamUrl('not a url'), '<redacted-url>');
});

// --- Diagnostic payload redaction -------------------------------------------
// We deliberately dump unrecognised realtime payloads to learn their shape. Those events are
// not ours and we do not control what they contain — and Homebridge logs get pasted into
// GitHub issues, so anything secret in one is effectively published.

test('redactPayload strips the alarm keypad PIN from an entry event', () => {
  // This is the real shape: alarm-hub entry events arrive on the camera events feed and carry
  // the PIN used to disarm the system.
  const item = {
    type: 'alarmHubEntryOpened',
    device: 'hub-1',
    metadata: { deviceName: 'Front Door', cameraName: 'Front Yard', status: 'opened', pin: '4821' },
  };

  const out = redactPayload(item);

  assert.ok(!out.includes('4821'), `the PIN leaked: ${out}`);
  assert.match(out, /"pin":"<redacted>"/);
  // Everything else must survive, or the log line stops being useful.
  assert.match(out, /alarmHubEntryOpened/);
  assert.match(out, /Front Door/);
});

test('redactPayload catches secret-ish keys by name, at any depth', () => {
  const out = redactPayload({
    a: { userPin: '1', accessToken: '2', api_key: '3', PASSWORD: '4', credentials: '5' },
    keep: 'visible',
  });
  for (const secret of ['"1"', '"2"', '"3"', '"4"', '"5"']) {
    assert.ok(!out.includes(secret), `${secret} survived redaction: ${out}`);
  }
  assert.match(out, /"keep":"visible"/);
});

test('redactPayload handles arrays, primitives and circular references', () => {
  assert.equal(redactPayload({ list: [{ pin: 'x' }, 'plain'] }), '{"list":[{"pin":"<redacted>"},"plain"]}');
  assert.equal(redactPayload(undefined), 'undefined');
  assert.equal(redactPayload(42), '42');
  const loop = { name: 'a' };
  loop.self = loop;
  assert.equal(redactPayload(loop), '{"name":"a","self":"<circular>"}');
});

test('redactPayload caps the length so one huge object cannot flood the log', () => {
  const out = redactPayload({ blob: 'x'.repeat(5000) }, 100);
  assert.ok(out.length <= 101, `expected a truncated string, got ${out.length} chars`);
  assert.ok(out.endsWith('…'));
});

// --- isDeviceList ------------------------------------------------------------
// The guard that stands between a malformed console response and either a crashed Homebridge or —
// worse — a reconciler that reads "no devices" and unregisters everything the user had.

test('isDeviceList accepts a real device list, including an empty one', () => {
  assert.equal(isDeviceList([]), true, 'genuinely zero devices is a valid answer');
  assert.equal(isDeviceList([{ id: 'a' }, { id: 'b', name: 'B' }]), true);
});

test('isDeviceList rejects the shapes that crashed the plugin', () => {
  // `request()` returns undefined for an empty 200 body — the most reachable of these, and the one
  // that turned `chimes.map(...)` into a fatal unhandled rejection.
  assert.equal(isDeviceList(undefined), false);
  assert.equal(isDeviceList(null), false);
  assert.equal(isDeviceList({}), false, 'a JSON object is not a list');
  assert.equal(isDeviceList('oops'), false, 'a string would iterate per character');
  assert.equal(isDeviceList(42), false);
  assert.equal(isDeviceList([null]), false, 'one junk entry makes the whole payload untrustworthy');
  assert.equal(isDeviceList([42]), false);
});

test('isDeviceList requires a usable id, because that IS the accessory identity', () => {
  // Every accessory UUID is derived from the id; an entry without one cannot be reconciled at all.
  assert.equal(isDeviceList([{ name: 'no id' }]), false);
  assert.equal(isDeviceList([{ id: '' }]), false, 'empty is not an identity');
  assert.equal(isDeviceList([{ id: 7 }]), false, 'a numeric id has no .toLowerCase()');
  assert.equal(isDeviceList([{ id: 'a' }, { id: undefined }]), false, 'one bad id spoils the list');
});
