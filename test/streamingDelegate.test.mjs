import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  pickAddressOverride,
  ProtectStreamingDelegate,
  randomSsrc,
  stripV4Mapped,
} from '../dist/streaming/streamingDelegate.js';
import { makeLog } from './helpers/hap-mock.mjs';

// hap throws if addressOverride's IP version differs from the version iOS asked for, and it
// calls us from an un-caught promise chain — so a mismatch takes Homebridge down. Only send an
// override when we're certain it matches; otherwise let hap work it out.
test('pickAddressOverride only overrides when the IP version matches the request', () => {
  assert.equal(pickAddressOverride('192.168.1.148', 'ipv4'), '192.168.1.148');
  assert.equal(pickAddressOverride('::ffff:192.168.1.148', 'ipv4'), '192.168.1.148'); // unwrapped
  assert.equal(pickAddressOverride('fe80::1', 'ipv6'), 'fe80::1');

  // Mismatches must yield undefined rather than a throwing override.
  assert.equal(pickAddressOverride('fe80::1', 'ipv4'), undefined);
  assert.equal(pickAddressOverride('192.168.1.148', 'ipv6'), undefined);
  // A zoned link-local breaks downstream address parsing even when the family matches.
  assert.equal(pickAddressOverride('fe80::1%en0', 'ipv6'), undefined);
});
test('randomSsrc stays within ffmpeg\'s signed-int32 range', () => {
  for (let i = 0; i < 1000; i++) {
    const s = randomSsrc();
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0x7fffffff, `out of range: ${s}`);
  }
});

test('stripV4Mapped unwraps IPv4-mapped IPv6, leaves other addresses intact', () => {
  assert.equal(stripV4Mapped('::ffff:192.168.1.148'), '192.168.1.148');
  assert.equal(stripV4Mapped('192.168.1.148'), '192.168.1.148'); // already plain v4
  assert.equal(stripV4Mapped('fe80::1'), 'fe80::1'); // genuine IPv6 untouched
});

/** A minimal PrepareStreamRequest; only the fields the delegate actually reads. */
const prepareRequest = (sessionID = 's1') => ({
  sessionID,
  sourceAddress: '10.0.0.1',
  targetAddress: '10.0.0.2',
  addressVersion: 'ipv4',
  video: { port: 50000, srtp_key: Buffer.alloc(16, 7), srtp_salt: Buffer.alloc(14, 9) },
  audio: { port: 50002, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
});

test('prepareStream advertises the source address and a video-only response', async () => {
  const d = new ProtectStreamingDelegate({
    deviceId: 'cam1', source: {}, log: makeLog(), ffmpegPath: 'ffmpeg', prepareTimeoutMs: 20,
  });
  const res = await new Promise((resolve, reject) =>
    d.prepareStream(prepareRequest(), (err, r) => (err ? reject(err) : resolve(r))),
  );
  assert.equal(res.addressOverride, '10.0.0.1');
  assert.ok(res.video.port > 0);
  assert.ok(Number.isInteger(res.video.ssrc));
  // Video-only: promising an audio endpoint we never feed makes iOS refuse to render video.
  assert.equal(res.audio, undefined);
});

// A prepared session holds a reserved UDP socket. If HomeKit never sends 'start' (abandoned
// session), it must be reaped rather than leaking the descriptor for the process lifetime.
test('a prepared session that never starts is reaped', async () => {
  const d = new ProtectStreamingDelegate({
    deviceId: 'cam1', source: {}, log: makeLog(), ffmpegPath: 'ffmpeg', prepareTimeoutMs: 10,
  });
  await new Promise((resolve, reject) =>
    d.prepareStream(prepareRequest('abandoned'), (err) => (err ? reject(err) : resolve())),
  );
  await new Promise((r) => setTimeout(r, 40));

  // Reaped: a later 'start' for that session is rejected instead of resurrecting it.
  const err = await new Promise((resolve) =>
    d.handleStreamRequest(
      { type: 'start', sessionID: 'abandoned', video: { width: 1280, height: 720, fps: 30, max_bit_rate: 299, pt: 99, mtu: 1378 } },
      resolve,
    ),
  );
  assert.match(err.message, /No prepared session/);
});

/** Invoke handleSnapshotRequest and resolve/reject with its callback. */
const snapshot = (delegate) =>
  new Promise((resolve, reject) =>
    delegate.handleSnapshotRequest({}, (err, buf) => (err ? reject(err) : resolve(buf))),
  );

/** Construct a delegate with a snapshot source and an injectable clock. */
const makeDelegate = (deviceId, getSnapshot, now = () => 0) =>
  new ProtectStreamingDelegate({ deviceId, source: { getSnapshot }, log: makeLog(), ffmpegPath: 'ffmpeg', now });

const flush = () => new Promise((r) => setImmediate(r));

test('cold: fetches from the source, serves it, and caches', async () => {
  let calls = 0;
  const d = makeDelegate('cam1', async () => {
    calls += 1;
    return Buffer.from([1, 2, 3]);
  });
  assert.deepEqual([...(await snapshot(d))], [1, 2, 3]);
  assert.equal(calls, 1);
});

test('within TTL: serves the cached frame without hitting the source again', async () => {
  let calls = 0;
  let t = 0;
  const d = makeDelegate('cam1', async () => Buffer.from([++calls]), () => t);
  await snapshot(d); // cold → calls=1
  t = 1000; // < 5s TTL
  assert.deepEqual([...(await snapshot(d))], [1]); // cached
  assert.equal(calls, 1); // no second console hit
});

test('stale: serves the cached frame immediately and refreshes in the background', async () => {
  let calls = 0;
  let t = 0;
  const d = makeDelegate('cam1', async () => Buffer.from([++calls]), () => t);
  await snapshot(d); // cold → calls=1, cache=[1]
  t = 6000; // > 5s TTL → stale
  assert.deepEqual([...(await snapshot(d))], [1]); // stale frame served instantly
  await flush(); // let the background refresh run
  assert.equal(calls, 2); // refreshed for next time
});

test('errors when cold and the fetch fails', async () => {
  const d = makeDelegate('cam1', async () => {
    throw new Error('down');
  });
  await assert.rejects(() => snapshot(d), /down/);
});

test('passes the configured deviceId to the source', async () => {
  let seen;
  const d = makeDelegate('the-device-id', async (id) => {
    seen = id;
    return Buffer.from([0]);
  });
  await snapshot(d);
  assert.equal(seen, 'the-device-id');
});

// --- Offline cameras ---------------------------------------------------------
// Letting requests through for a camera Protect already reports as disconnected costs one
// timing-out console request per Home-app tile refresh — how one dead camera degrades the rest.

test('an offline camera refuses snapshots without touching the source', async () => {
  let calls = 0;
  const d = makeDelegate('cam1', async () => {
    calls += 1;
    return Buffer.from([1]);
  });
  d.setDeviceOnline(false);
  await assert.rejects(() => snapshot(d), /offline/);
  assert.equal(calls, 0);
});

test('going offline suppresses even a warm cached frame', async () => {
  const d = makeDelegate('cam1', async () => Buffer.from([1]));
  await snapshot(d); // warms the cache
  d.setDeviceOnline(false);
  // A picture from before it went down implies a working camera; "unavailable" is the truth.
  await assert.rejects(() => snapshot(d), /offline/);
});

test('an offline camera refuses to start a stream before any RTSPS work', async () => {
  let rtspsCalls = 0;
  const d = new ProtectStreamingDelegate({
    deviceId: 'cam1',
    source: { getRtspsStream: async () => (rtspsCalls++, {}) },
    log: makeLog(),
    ffmpegPath: 'ffmpeg',
    prepareTimeoutMs: 500,
  });
  await new Promise((resolve, reject) =>
    d.prepareStream(prepareRequest('off1'), (err) => (err ? reject(err) : resolve())),
  );
  d.setDeviceOnline(false);

  const err = await new Promise((resolve) =>
    d.handleStreamRequest(
      { type: 'start', sessionID: 'off1', video: { width: 1280, height: 720, fps: 30, max_bit_rate: 299, pt: 99, mtu: 1378 } },
      resolve,
    ),
  );
  assert.match(err.message, /offline/);
  assert.equal(rtspsCalls, 0, 'no RTSPS handshake for a camera we know is down');
});

test('snapshot outcomes are reported to the health callback', async () => {
  const seen = [];
  let ok = true;
  let t = 0;
  const d = new ProtectStreamingDelegate({
    deviceId: 'cam1',
    source: {
      getSnapshot: async () => {
        if (!ok) {
          throw new Error('down');
        }
        return Buffer.from([1]);
      },
    },
    log: makeLog(),
    ffmpegPath: 'ffmpeg',
    now: () => t,
    onHealth: (healthy) => seen.push(healthy),
  });
  await snapshot(d);
  assert.deepEqual(seen, [true]);

  // Age the cache past its maximum so the next request takes the cold path and really asks.
  ok = false;
  t = 10 * 60_000;
  await assert.rejects(() => snapshot(d), /down/);
  assert.deepEqual(seen, [true, false]);
});

// --- Live stream lifecycle ---------------------------------------------------
// The start path was previously untestable because `spawn` was captured at import time. With it
// injected, everything from RTSPS lookup through argument building to child-process teardown is
// covered without a real ffmpeg.

/** A stand-in ChildProcess: records signals, and lets a test drive 'exit'/'error'. */
class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
}

/** Build a delegate whose ffmpeg is a FakeProc, plus the spawn calls it recorded. */
function makeStreamDelegate({ streams = { high: 'rtsps://10.0.0.1:7441/key' }, enableResult, ...over } = {}) {
  const spawned = [];
  const enabled = [];
  const delegate = new ProtectStreamingDelegate({
    deviceId: 'cam1',
    log: makeLog(),
    ffmpegPath: '/usr/bin/ffmpeg',
    prepareTimeoutMs: 1000,
    source: {
      getSnapshot: async () => Buffer.from([1]),
      getRtspsStream: async () => streams,
      enableRtspsStream: async (id, qualities) => {
        enabled.push({ id, qualities });
        return enableResult ?? { high: 'rtsps://10.0.0.1:7441/enabled' };
      },
    },
    spawn: (path, args, opts) => {
      const proc = new FakeProc();
      spawned.push({ path, args, opts, proc });
      return proc;
    },
    ...over,
  });
  return { delegate, spawned, enabled };
}

const startRequest = (sessionID = 's1') => ({
  type: 'start',
  sessionID,
  video: { width: 1280, height: 720, fps: 30, max_bit_rate: 299, pt: 99, mtu: 1378, profile: 2, level: 2 },
});

/** prepare + start, resolving with whatever the start callback was given. */
async function startStream(delegate, sessionID = 's1') {
  await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest(sessionID), (err) => (err ? reject(err) : resolve())),
  );
  return new Promise((resolve) => delegate.handleStreamRequest(startRequest(sessionID), resolve));
}

test('start pulls the RTSPS URL and spawns ffmpeg with the negotiated parameters', async () => {
  const { delegate, spawned } = makeStreamDelegate();

  const err = await startStream(delegate);

  assert.equal(err, undefined, 'start must succeed');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].path, '/usr/bin/ffmpeg');
  const args = spawned[0].args.join(' ');
  assert.match(args, /-i rtsps:\/\/10\.0\.0\.1:7441\/key/);
  assert.match(args, /-profile:v high -level:v 4\.0/); // what HomeKit asked for
  assert.match(args, /-b:v 2000k/); // iOS opened at 299kbps; floored for 720p
  assert.match(args, /srtp:\/\/10\.0\.0\.2:50000\?/);
});

// stdout/stdin are pipes nobody reads by default: a full 64KB stdout buffer blocks ffmpeg
// forever, and an open stdin lets it stall waiting for input that never arrives.
test('ffmpeg is spawned with stdin/stdout ignored and only stderr piped', async () => {
  const { delegate, spawned } = makeStreamDelegate();
  await startStream(delegate);
  assert.deepEqual(spawned[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
});

test('RTSPS is enabled on demand when the camera has no stream URL yet', async () => {
  const { delegate, spawned, enabled } = makeStreamDelegate({ streams: {} });

  await startStream(delegate);

  assert.deepEqual(enabled, [{ id: 'cam1', qualities: ['high'] }]);
  assert.match(spawned[0].args.join(' '), /rtsps:\/\/10\.0\.0\.1:7441\/enabled/);
});

test('a camera with no RTSPS URL at all fails the start instead of spawning', async () => {
  // Enabling RTSPS didn't produce a URL either — a camera that simply cannot stream.
  const { delegate, spawned } = makeStreamDelegate({ streams: {}, enableResult: {} });

  const err = await startStream(delegate);

  assert.match(err.message, /No RTSPS URL/);
  assert.equal(spawned.length, 0);
});

// RTSPS URLs embed a stream key. ffmpeg echoes its input URL in the startup banner, so without
// scrubbing, turning on debug logging would print a working credential to the Homebridge log.
test('the stream key never reaches the log via ffmpeg stderr', async () => {
  const log = makeLog();
  const { delegate, spawned } = makeStreamDelegate({ log });
  await startStream(delegate);

  spawned[0].proc.stderr.emit('data', Buffer.from("Input #0, rtsp, from 'rtsps://10.0.0.1:7441/key':"));

  const lines = log.entries.map((e) => e.msg).join('\n');
  assert.ok(!lines.includes('7441/key'), 'the stream key leaked into the log');
  assert.ok(lines.includes('rtsps://10.0.0.1:7441/…'), 'the redacted host should still be logged');
});

test('stopping a stream terminates ffmpeg', async () => {
  const { delegate, spawned } = makeStreamDelegate();
  await startStream(delegate);

  await new Promise((resolve) => delegate.handleStreamRequest({ type: 'stop', sessionID: 's1' }, resolve));

  assert.deepEqual(spawned[0].proc.signals, ['SIGTERM']);
});

// An ffmpeg that dies on its own (camera rebooted, RTSPS dropped) leaves HomeKit showing a
// frozen frame and holding the stream slot until Homebridge restarts.
test('an ffmpeg that exits unexpectedly releases the HomeKit stream slot', async () => {
  const { delegate, spawned } = makeStreamDelegate();
  const forceStopped = [];
  delegate.setController({ forceStopStreamingSession: (id) => forceStopped.push(id) });
  await startStream(delegate);

  spawned[0].proc.emit('exit', 1, null);

  assert.deepEqual(forceStopped, ['s1']);
});

test('an ffmpeg that fails to launch is reported and cleaned up', async () => {
  const log = makeLog();
  const { delegate, spawned } = makeStreamDelegate({ log });
  const forceStopped = [];
  delegate.setController({ forceStopStreamingSession: (id) => forceStopped.push(id) });
  await startStream(delegate);

  spawned[0].proc.emit('error', new Error('ENOENT'));

  assert.ok(log.entries.some((e) => e.level === 'error' && /ffmpeg failed to start/.test(e.msg)));
  assert.deepEqual(forceStopped, ['s1']);
});

test('shutdown terminates every live stream', async () => {
  const { delegate, spawned } = makeStreamDelegate();
  await startStream(delegate, 'a');
  await startStream(delegate, 'b');

  delegate.shutdown();

  assert.equal(spawned.length, 2);
  assert.ok(spawned.every((s) => s.proc.signals.includes('SIGTERM')));
});

// hap-nodejs invokes these callbacks from a detached promise chain. A throw from one used to
// become an unhandled rejection, which Node treats as fatal — taking Homebridge down with it.
test('a throwing HAP snapshot callback is contained, not fatal', async () => {
  const log = makeLog();
  const d = new ProtectStreamingDelegate({
    deviceId: 'cam1',
    source: { getSnapshot: async () => Buffer.from([1]) },
    log,
    ffmpegPath: 'ffmpeg',
    now: () => 0,
  });
  let unhandled;
  const onUnhandled = (err) => {
    unhandled = err;
  };
  process.once('unhandledRejection', onUnhandled);

  d.handleSnapshotRequest({}, () => {
    throw new Error('hap exploded');
  });
  await new Promise((r) => setTimeout(r, 20)); // give an unhandled rejection time to surface
  process.removeListener('unhandledRejection', onUnhandled);

  assert.equal(unhandled, undefined, 'the throw must not escape as an unhandled rejection');
  assert.ok(log.entries.some((e) => e.level === 'error' && /hap exploded/.test(e.msg)));
});
