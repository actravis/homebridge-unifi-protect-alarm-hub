import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactPayload, redactStreamUrl } from '../dist/util.js';

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
