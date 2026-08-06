// The audio relay: what makes two-way audio cost nothing in stream-load time.
//
// The property that matters is the SOURCE PORT. iOS is told one audio port; it sends the microphone
// there and expects our audio to come from it. Letting talkback's ffmpeg own that port instead meant
// outbound audio left from an ephemeral one, and iOS — waiting on an advertised codec — did not
// render video until it timed out (measured 9-11s to first frame). These tests use real UDP sockets,
// because the whole point is which port packets are observed to come from.

import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';

import { startAudioRelay } from '../dist/streaming/audioRelay.js';

const bind = () =>
  new Promise((resolve) => {
    const s = createSocket('udp4');
    s.bind(0, '127.0.0.1', () => resolve(s));
  });

const nextMessage = (socket) =>
  new Promise((resolve) => socket.once('message', (msg, rinfo) => resolve({ msg, rinfo })));

const closeAll = (...sockets) => sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });

test('outbound audio reaches the phone FROM the advertised port, not an ephemeral one', async () => {
  const advertised = await bind();   // the port iOS was told about
  const local = await bind();        // where the outbound ffmpeg sends
  const phone = await bind();        // stands in for iOS
  const ffmpeg = await bind();

  const relay = startAudioRelay({
    advertised,
    local,
    target: { address: '127.0.0.1', port: phone.address().port },
  });

  const arrived = nextMessage(phone);
  ffmpeg.send(Buffer.from([0x80, 0x6e, 1, 2, 3]), local.address().port, '127.0.0.1');
  const { msg, rinfo } = await arrived;

  assert.deepEqual([...msg], [0x80, 0x6e, 1, 2, 3], 'forwarded verbatim — SRTP must not be touched');
  assert.equal(rinfo.port, advertised.address().port, 'THE point of the relay');
  assert.notEqual(rinfo.port, ffmpeg.address().port);
  assert.equal(relay.stats.outbound, 1);

  relay.stop();
  closeAll(advertised, local, phone, ffmpeg);
});

test("the phone's microphone is forwarded to the talkback port", async () => {
  const advertised = await bind();
  const local = await bind();
  const talkback = await bind();     // stands in for the talkback ffmpeg
  const phone = await bind();

  const relay = startAudioRelay({
    advertised,
    local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: talkback.address().port,
  });

  const arrived = nextMessage(talkback);
  phone.send(Buffer.from([0x80, 0x6e, 9, 9]), advertised.address().port, '127.0.0.1');
  const { msg } = await arrived;

  assert.deepEqual([...msg], [0x80, 0x6e, 9, 9]);
  assert.equal(relay.stats.inbound, 1);

  relay.stop();
  closeAll(advertised, local, talkback, phone);
});

// Without a talkback process there is nowhere for the microphone to go; dropping must not throw.
test('inbound audio is dropped harmlessly when talkback is not running', async () => {
  const advertised = await bind();
  const local = await bind();
  const phone = await bind();

  const relay = startAudioRelay({
    advertised,
    local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: undefined,
  });

  phone.send(Buffer.from([1, 2, 3]), advertised.address().port, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(relay.stats.inbound, 0);

  relay.stop();
  closeAll(advertised, local, phone);
});

test('both directions run independently over many packets', async () => {
  const advertised = await bind();
  const local = await bind();
  const talkback = await bind();
  const phone = await bind();
  const relay = startAudioRelay({
    advertised, local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: talkback.address().port,
  });

  let toPhone = 0, toTalkback = 0;
  phone.on('message', () => { toPhone += 1; });
  talkback.on('message', () => { toTalkback += 1; });
  for (let i = 0; i < 25; i++) {
    local.send(Buffer.from([i]), local.address().port, '127.0.0.1');
    phone.send(Buffer.from([i]), advertised.address().port, '127.0.0.1');
  }
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(toPhone >= 20, `expected ~25 outbound, saw ${toPhone}`);
  assert.ok(toTalkback >= 20, `expected ~25 inbound, saw ${toTalkback}`);

  relay.stop();
  closeAll(advertised, local, talkback, phone);
});

// stop() must detach the listeners, or a torn-down session keeps forwarding into closed sockets.
test('stop detaches both directions', async () => {
  const advertised = await bind();
  const local = await bind();
  const phone = await bind();
  const relay = startAudioRelay({
    advertised, local, target: { address: '127.0.0.1', port: phone.address().port },
  });
  relay.stop();

  local.send(Buffer.from([1]), local.address().port, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(relay.stats.outbound, 0);

  closeAll(advertised, local, phone);
});

// A relay error would otherwise log per packet, 50 times a second.
test('a send failure is reported once per direction, not per packet', async () => {
  const advertised = await bind();
  const local = await bind();
  const errors = [];
  const relay = startAudioRelay({
    advertised, local,
    target: { address: '127.0.0.1', port: 1 },
    onError: (direction, message) => errors.push({ direction, message }),
  });
  advertised.close(); // make every outbound send fail

  for (let i = 0; i < 5; i++) {
    local.send(Buffer.from([i]), local.address().port, '127.0.0.1');
  }
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(errors.length <= 1, `expected at most one report, got ${errors.length}`);
  relay.stop();
  closeAll(local);
});
