import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  isExpectedFfmpegNoise,
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
    // Talkback writes its SDP to stdin; record it so tests can assert on what ffmpeg was told.
    this.stdinChunks = [];
    this.stdin = Object.assign(new EventEmitter(), {
      end: (chunk) => { if (chunk) this.stdinChunks.push(String(chunk)); this.stdinEnded = true; },
    });
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

// --- Audio negotiation -------------------------------------------------------
// The controller's advertised codec and the delegate's output must never disagree: iOS responds to
// a promised-but-silent audio stream by refusing to render the VIDEO too.

const startWithAudio = (sessionID = 'a1') => ({
  type: 'start',
  sessionID,
  video: { width: 1280, height: 720, fps: 30, max_bit_rate: 299, pt: 99, mtu: 1378, profile: 2, level: 2 },
  audio: { codec: 'OPUS', channel: 1, sample_rate: 24, max_bit_rate: 24, packet_time: 30, pt: 110 },
});

test('video-only: no audio block is promised in the prepare response', async () => {
  const { delegate } = makeStreamDelegate();
  const res = await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest(), (err, r) => (err ? reject(err) : resolve(r))),
  );
  assert.equal(res.audio, undefined);
});

test('with audio: the prepare response advertises an audio endpoint of its own', async () => {
  const { delegate } = makeStreamDelegate({ audioCodec: { encoder: 'libopus', hapCodec: 'OPUS' } });
  const res = await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest(), (err, r) => (err ? reject(err) : resolve(r))),
  );
  assert.ok(res.audio, 'an audio block is required or iOS never sends audio parameters');
  assert.ok(res.audio.port > 0);
  assert.notEqual(res.audio.port, res.video.port, 'audio is an independent RTP stream');
  assert.notEqual(res.audio.ssrc, res.video.ssrc);
  // HomeKit supplies separate keys per stream; echoing the video ones would fail SRTP decryption.
  assert.deepEqual(res.audio.srtp_key, prepareRequest().audio.srtp_key);
});

test('with audio: ffmpeg gets a second output using the negotiated parameters', async () => {
  const { delegate, spawned } = makeStreamDelegate({ audioCodec: { encoder: 'libopus', hapCodec: 'OPUS' } });
  await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest('a1'), (err) => (err ? reject(err) : resolve())),
  );
  await new Promise((resolve) => delegate.handleStreamRequest(startWithAudio('a1'), resolve));

  const args = spawned[0].args.join(' ');
  assert.match(args, /-codec:a libopus/);
  assert.match(args, /-payload_type 110/);
  // HomeKit reports kHz; ffmpeg wants Hz. Passing 24 through would request 24Hz audio.
  assert.match(args, /-ar 24000/);
  assert.match(args, /-b:a 24k/);
  // packet_time 30 is illegal for libopus and would kill the whole process.
  assert.match(args, /-frame_duration 20/);
  assert.equal(args.match(/-f rtp/g).length, 2);
});

test('without a probed codec, a start request stays video-only even if iOS offers audio', async () => {
  const { delegate, spawned } = makeStreamDelegate(); // no audioCodec
  await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest('a2'), (err) => (err ? reject(err) : resolve())),
  );
  await new Promise((resolve) => delegate.handleStreamRequest(startWithAudio('a2'), resolve));

  const args = spawned[0].args.join(' ');
  assert.match(args, /-an/, 'source audio is dropped');
  assert.equal(args.match(/-f rtp/g).length, 1, 'one output only');
});

// --- ffmpeg log filtering ----------------------------------------------------
// A 24fps HEVC camera emits ~100 decoder complaints per connect while it waits for the first
// keyframe, burying the few lines that matter. They are suppressed and counted — but the filter
// must stay narrow, because one that swallows novel errors is worse than a noisy log.

test('expected mid-GOP decoder noise is recognised', () => {
  for (const line of [
    '[hevc @ 0x1] Could not find ref with POC 51',
    '[hevc @ 0x1] Error constructing the frame RPS.',
    '[hevc @ 0x1] Skipping invalid undecodable NALU: 1',
    '[hevc @ 0x1] First slice in a frame missing.',
    '[h264 @ 0x1] non-existing PPS 0 referenced',
    '[h264 @ 0x1] decode_slice_header error',
    '[h264 @ 0x1] no frame!',
    '[swscaler @ 0x1] deprecated pixel format used, make sure you did set range correctly',
  ]) {
    assert.equal(isExpectedFfmpegNoise(line), true, line);
  }
});

test('everything diagnostic is still logged', () => {
  for (const line of [
    'Input #0, rtsp, from \'rtsps://…\':',
    'Stream mapping:',
    '  Stream #0:2 -> #0:0 (hevc (native) -> h264 (libx264))',
    '[libx264 @ 0x1] profile High, level 4.0, 4:2:0, 8-bit',
    'frame=  20 fps=0.0 q=29.0 size=  184KiB speed=1.32x',
    // The problems this session actually hunted down — none may ever be hidden.
    '[aost#1:0/libopus] Non-monotonic DTS; previous: 238920, current: 238680',
    '[libopus @ 0x1] Queue input is backward in time',
    '[libopus @ 0x1] Invalid frame duration: 30.',
    '[libfdk_aac @ 0x1] Unable to initialize the encoder: Transport library initialization error',
    'Conversion failed!',
    'Error while opening encoder - maybe incorrect parameters',
    '[rtsp @ 0x1] Option not found',
  ]) {
    assert.equal(isExpectedFfmpegNoise(line), false, line);
  }
});

test('ffmpeg stderr is logged per line, and the noise is summarised once', async () => {
  const log = makeLog();
  const { delegate, spawned } = makeStreamDelegate({ log });
  await startStream(delegate);
  const proc = spawned[0].proc;

  // ffmpeg writes in bursts that do not align with line boundaries.
  proc.stderr.emit('data', Buffer.from(
    'Stream mapping:\n[hevc @ 0x1] Could not find ref with POC 1\n[hevc @ 0x1] First slice in a frame missing.\n',
  ));
  proc.stderr.emit('data', Buffer.from('[hevc @ 0x1] Skipping invalid undecodable NALU: 1\nreal problem here\n'));
  proc.emit('exit', 0, null);

  const lines = log.entries.map((e) => e.msg);
  assert.ok(lines.some((m) => /Stream mapping:/.test(m)), 'diagnostics survive');
  assert.ok(lines.some((m) => /real problem here/.test(m)), 'unrecognised lines survive');
  assert.ok(!lines.some((m) => /Could not find ref with POC/.test(m)), 'noise is suppressed');
  const summary = lines.filter((m) => /suppressed 3 expected decoder warnings/.test(m));
  assert.equal(summary.length, 1, `expected one summary line, got ${summary.length}`);
});

// --- Talkback (two-way audio) -----------------------------------------------
// The camera's talkback listener is a plain RTP sink on the CAMERA's IP; HomeKit's microphone
// arrives as SRTP on the audio port we advertised. So talkback is a second ffmpeg, and the audio
// port changes owner — which is the part most likely to break one-way streaming if it regresses.

const OPUS = { encoder: 'libopus', hapCodec: 'OPUS' };
const talkbackStart = (sessionID = 's1') => ({
  ...startRequest(sessionID),
  audio: { port: 50002, pt: 110, sample_rate: 24, max_bit_rate: 24, packet_time: 20 },
});

/** prepare + start with audio negotiated, so the talkback path is reachable. */
async function runWithAudio(delegate, sessionID = 's1') {
  await new Promise((resolve, reject) =>
    delegate.prepareStream(prepareRequest(sessionID), (err) => (err ? reject(err) : resolve())),
  );
  return new Promise((resolve) => delegate.handleStreamRequest(talkbackStart(sessionID), resolve));
}

const talkbackDeps = (over = {}) => ({
  audioCodec: OPUS,
  talkback: true,
  source: {
    getSnapshot: async () => Buffer.from([1]),
    getRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
    enableRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
    startTalkbackSession: async () => ({ url: 'rtp://192.168.1.197:7004', codec: 'opus', samplingRate: 24000 }),
  },
  ...over,
});

// The default path is the one already live-verified; talkback must not disturb it.
test('with talkback off only one ffmpeg runs and audio keeps its RTCP port', async () => {
  const { delegate, spawned } = makeStreamDelegate({ audioCodec: OPUS });
  const err = await runWithAudio(delegate);
  assert.ifError(err);
  assert.equal(spawned.length, 1, 'no second process');
  // localrtcpport is an output-URL query parameter, not a flag.
  const audioUrl = spawned[0].args.at(-1);
  assert.match(audioUrl, /^srtp:\/\/10\.0\.0\.2:50002\?/);
  assert.match(audioUrl, /localrtcpport=\d+/, 'the audio stream owns the port when talkback is off');
});

test('with talkback on a second ffmpeg is spawned for the reverse path', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  const err = await runWithAudio(delegate);
  assert.ifError(err);
  assert.equal(spawned.length, 2);
  const args = spawned[1].args.join(' ');
  assert.match(args, /-f sdp -i pipe:0/);
  assert.ok(args.endsWith('rtp://192.168.1.197:7004'), 'output goes to the camera');
});

test('the talkback SDP is written to stdin and describes an encrypted stream', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  await runWithAudio(delegate);
  const sdp = spawned[1].proc.stdinChunks.join('');
  assert.match(sdp, /RTP\/SAVP 110/);
  assert.match(sdp, /a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:/);
  assert.match(sdp, /a=rtpmap:110 opus\/24000\/1/);
  assert.ok(spawned[1].proc.stdinEnded, 'stdin must be closed or ffmpeg waits forever');
});

test('talkback gets stdin as a pipe, unlike the one-way stream', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  await runWithAudio(delegate);
  assert.deepEqual(spawned[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.deepEqual(spawned[1].opts.stdio, ['pipe', 'ignore', 'pipe']);
});

// Two processes cannot bind the same UDP port; the outbound stream would die on startup.
// Two processes cannot bind the same UDP port: the outbound stream would fail to start.
test('when talkback owns the audio port the outbound stream does not also claim it', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  await runWithAudio(delegate);
  const urls = spawned[0].args.filter((a) => /^srtp:\/\//.test(a));
  const [videoUrl, audioUrl] = urls;
  assert.equal(urls.length, 2);
  assert.match(videoUrl, /localrtcpport=\d+/, 'video keeps its own RTCP port');
  assert.ok(!/localrtcpport/.test(audioUrl), 'audio must yield the port to talkback');
});

test('a failed talkback session still leaves the live stream working', async () => {
  const { delegate, spawned } = makeStreamDelegate(
    talkbackDeps({
      source: {
        getSnapshot: async () => Buffer.from([1]),
        getRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
        enableRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
        startTalkbackSession: async () => { throw new Error('no speaker'); },
      },
    }),
  );
  const err = await runWithAudio(delegate);
  assert.ifError(err, 'video must survive a talkback failure');
  assert.equal(spawned.length, 1);
});

// The URL is external input that becomes an ffmpeg argument.
test('an unusable talkback URL is refused and does not spawn anything', async () => {
  const { delegate, spawned } = makeStreamDelegate(
    talkbackDeps({
      source: {
        getSnapshot: async () => Buffer.from([1]),
        getRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
        enableRtspsStream: async () => ({ high: 'rtsps://10.0.0.1:7441/key' }),
        startTalkbackSession: async () => ({ url: 'file:///etc/passwd', samplingRate: 24000 }),
      },
    }),
  );
  assert.ifError(await runWithAudio(delegate));
  assert.equal(spawned.length, 1);
});

test('talkback is skipped entirely when there is no audio codec', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps({ audioCodec: undefined }));
  await startStream(delegate);
  assert.equal(spawned.length, 1);
});

test('stopping the stream kills the talkback process too', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  await runWithAudio(delegate);
  delegate.handleStreamRequest({ type: 'stop', sessionID: 's1' }, () => {});
  assert.ok(spawned[1].proc.killed, 'a surviving talkback would hold the audio port');
});

test('shutdown kills the talkback process too', async () => {
  const { delegate, spawned } = makeStreamDelegate(talkbackDeps());
  await runWithAudio(delegate);
  delegate.shutdown();
  assert.ok(spawned[1].proc.killed);
});
