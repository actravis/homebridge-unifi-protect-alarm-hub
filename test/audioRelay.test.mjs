// The audio relay: what makes two-way audio cost nothing in stream-load time.
//
// The property that matters is the SOURCE PORT. iOS is told one audio port; it sends the microphone
// there and expects our audio to come from it. Letting talkback's ffmpeg own that port instead meant
// outbound audio left from an ephemeral one, and iOS — waiting on an advertised codec — did not
// render video until it timed out (measured 9-11s to first frame). These tests use real UDP sockets,
// because which port a packet is observed to come from is the whole point.
//
// Cleanup is registered with `t.after` rather than written at the end of each test. A test that
// closes its sockets only on the success path leaks them on failure, and a leaked socket is an open
// handle: `node --test` then hangs with no output instead of reporting. That turned a mutation run
// into a five-minute timeout before this was fixed.

import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';

import { startAudioRelay } from '../dist/streaming/audioRelay.js';

/** Bind `count` localhost sockets and guarantee they are closed when the test ends. */
async function sockets(t, count) {
  const made = [];
  t.after(() => {
    for (const s of made) {
      try {
        s.close();
      } catch { /* already closed by the test */ }
    }
  });
  for (let i = 0; i < count; i++) {
    made.push(await new Promise((resolve) => {
      const s = createSocket('udp4');
      s.bind(0, '127.0.0.1', () => resolve(s));
    }));
  }
  return made;
}

/** A relay that is always detached when the test ends, however it ends. */
function relayFor(t, opts) {
  const relay = startAudioRelay(opts);
  t.after(() => relay.stop());
  return relay;
}

/**
 * Wait for one packet, or resolve null after `ms`.
 *
 * Bounded deliberately: an unbounded wait turns "the packet was dropped" into a hung runner rather
 * than a failed assertion.
 */
const nextMessage = (socket, ms = 400) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once('message', (msg, rinfo) => {
      clearTimeout(timer);
      resolve({ msg, rinfo });
    });
  });

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// --- the source port, which is the whole point --------------------------------

test('outbound audio reaches the phone FROM the advertised port, not an ephemeral one', async (t) => {
  const [advertised, local, phone, ffmpeg] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local, target: { address: '127.0.0.1', port: phone.address().port },
  });

  const arrived = nextMessage(phone);
  ffmpeg.send(Buffer.from([0x80, 0x6e, 1, 2, 3]), local.address().port, '127.0.0.1');
  const got = await arrived;

  assert.ok(got, 'no packet reached the phone');
  assert.deepEqual([...got.msg], [0x80, 0x6e, 1, 2, 3], 'forwarded verbatim — SRTP must not be touched');
  assert.equal(got.rinfo.port, advertised.address().port, 'THE point of the relay');
  assert.notEqual(got.rinfo.port, ffmpeg.address().port);
  assert.equal(relay.stats.outbound, 1);
});

test("the phone's microphone is forwarded to the talkback port", async (t) => {
  const [advertised, local, talkback, phone] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: talkback.address().port,
  });

  const arrived = nextMessage(talkback);
  phone.send(Buffer.from([0x80, 0x6e, 9, 9]), advertised.address().port, '127.0.0.1');
  const got = await arrived;

  assert.ok(got, 'the microphone never reached talkback');
  assert.deepEqual([...got.msg], [0x80, 0x6e, 9, 9]);
  assert.equal(relay.stats.inbound, 1);
});

test('both directions run independently over many packets', async (t) => {
  const [advertised, local, talkback, phone] = await sockets(t, 4);
  const relay = relayFor(t, {
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
  await settle(250);

  assert.ok(toPhone >= 20, `expected ~25 outbound, saw ${toPhone}`);
  assert.ok(toTalkback >= 20, `expected ~25 inbound, saw ${toTalkback}`);
  assert.equal(relay.stats.dropped, 0);
});

// --- the source filter --------------------------------------------------------
// The advertised port is reachable by anything on the network, and inbound packets are forwarded to a
// process that drives the camera's speaker. SRTP authentication stops forged audio being played, but
// without this filter any host could drive that forwarding path at will.

test('inbound audio from an address other than the phone is dropped', async (t) => {
  const [advertised, local, talkback, attacker] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: 9 },
    talkbackPort: talkback.address().port,
    allowFrom: '10.99.99.99', // the "phone" — deliberately not localhost
  });

  let reached = 0;
  talkback.on('message', () => { reached += 1; });
  attacker.send(Buffer.from([0x80, 0x6e, 1]), advertised.address().port, '127.0.0.1');
  await settle();

  assert.equal(reached, 0, 'a stranger must not reach the talkback process');
  assert.equal(relay.stats.inbound, 0);
  assert.equal(relay.stats.dropped, 1);
});

test('inbound audio from the phone is forwarded when a filter is set', async (t) => {
  const [advertised, local, talkback, phone] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: talkback.address().port,
    allowFrom: '127.0.0.1',
  });

  const arrived = nextMessage(talkback);
  phone.send(Buffer.from([0x80, 0x6e, 7]), advertised.address().port, '127.0.0.1');

  assert.ok(await arrived, 'the phone must not be filtered out');
  assert.equal(relay.stats.inbound, 1);
  assert.equal(relay.stats.dropped, 0);
});

// A dual-stack socket reports an IPv4 peer as ::ffff:a.b.c.d; a notation difference must not reject
// the phone.
test('the source filter tolerates IPv4-mapped IPv6 notation', async (t) => {
  const [advertised, local, talkback, phone] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: talkback.address().port,
    allowFrom: '::ffff:127.0.0.1',
  });

  const arrived = nextMessage(talkback);
  phone.send(Buffer.from([1]), advertised.address().port, '127.0.0.1');

  assert.ok(await arrived, 'IPv4-mapped notation must compare equal');
  assert.equal(relay.stats.inbound, 1);
});

// --- absent talkback ---------------------------------------------------------

// Outbound must keep working when talkback is absent: ffmpeg already addresses the relay socket, so
// dropping the relay would leave the phone with no audio and stall iOS on the advertised codec.
test('outbound still flows with no talkback port configured', async (t) => {
  const [advertised, local, phone, ffmpeg] = await sockets(t, 4);
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: undefined,
    allowFrom: '127.0.0.1',
  });

  const arrived = nextMessage(phone);
  ffmpeg.send(Buffer.from([0x80, 0x6e, 5]), local.address().port, '127.0.0.1');
  const got = await arrived;

  assert.ok(got, 'outbound audio must flow even with talkback absent');
  assert.equal(got.rinfo.port, advertised.address().port);
  assert.equal(relay.stats.outbound, 1);
});

test('inbound audio is dropped harmlessly when talkback is not running', async (t) => {
  const [advertised, local, phone] = await sockets(t, 3);
  const relay = relayFor(t, {
    advertised, local, target: { address: '127.0.0.1', port: phone.address().port },
    talkbackPort: undefined,
  });

  phone.send(Buffer.from([1, 2, 3]), advertised.address().port, '127.0.0.1');
  await settle();
  assert.equal(relay.stats.inbound, 0);
});

// --- teardown and error reporting --------------------------------------------

test('stop detaches both directions', async (t) => {
  const [advertised, local, phone] = await sockets(t, 3);
  const relay = relayFor(t, {
    advertised, local, target: { address: '127.0.0.1', port: phone.address().port },
  });
  relay.stop();

  local.send(Buffer.from([1]), local.address().port, '127.0.0.1');
  await settle();
  assert.equal(relay.stats.outbound, 0);
});

// send() on a closed socket throws SYNCHRONOUSLY inside a 'message' handler — an uncaught exception
// unless guarded, and teardown makes it reachable. A broken relay must also not log per packet.
test('a send failure is caught and reported once per direction, not per packet', async (t) => {
  const [advertised, local] = await sockets(t, 2);
  const errors = [];
  const relay = relayFor(t, {
    advertised, local,
    target: { address: '127.0.0.1', port: 1 },
    onError: (direction, message) => errors.push({ direction, message }),
  });
  advertised.close(); // make every outbound send fail

  for (let i = 0; i < 5; i++) {
    local.send(Buffer.from([i]), local.address().port, '127.0.0.1');
  }
  await settle(200);

  assert.ok(errors.length <= 1, `expected at most one report, got ${errors.length}`);
  assert.equal(relay.stats.outbound, 0);
});
