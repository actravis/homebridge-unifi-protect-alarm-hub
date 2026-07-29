// Audio codec detection. This is probed by actually running the encoder rather than by reading
// `ffmpeg -encoders`, and that is not fussiness: the bundled ffmpeg-for-homebridge build LISTS
// libfdk_aac while failing to initialise AAC-ELD at every sample rate and bitrate. A presence
// check would have advertised a codec we cannot deliver — and iOS responds to a promised-but-
// silent audio stream by refusing to render the video either, so the whole live view dies.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUDIO_CANDIDATES,
  buildProbeArgs,
  detectAudioCodec,
  probeAudioCodec,
  resetAudioCodecCache,
} from '../dist/streaming/audioCodec.js';

/** A probe that accepts only the named encoders. */
const probeAllowing = (...encoders) => {
  const calls = [];
  const probe = async (path, args) => {
    calls.push(args);
    return encoders.some((e) => args.includes(e));
  };
  return { probe, calls };
};

test('AAC-ELD is preferred when ffmpeg can encode it', async () => {
  const { probe } = probeAllowing('libfdk_aac', 'libopus');
  assert.deepEqual(await detectAudioCodec('ffmpeg', probe), { encoder: 'libfdk_aac', hapCodec: 'AAC-eld' });
});

// The real-world case for the bundled binary: libfdk_aac exists but cannot do ELD.
test('Opus is used when AAC-ELD fails to initialise', async () => {
  const { probe } = probeAllowing('libopus');
  assert.deepEqual(await detectAudioCodec('ffmpeg', probe), { encoder: 'libopus', hapCodec: 'OPUS' });
});

test('no usable encoder means video-only, not a guess', async () => {
  const { probe } = probeAllowing();
  assert.equal(await detectAudioCodec('ffmpeg', probe), undefined);
});

test('a probe that throws degrades to video-only instead of breaking discovery', async () => {
  resetAudioCodecCache();
  const codec = await probeAudioCodec('ffmpeg-that-explodes', async () => {
    throw new Error('spawn failed');
  });
  assert.equal(codec, undefined);
});

test('the result is cached so discovery does not spawn ffmpeg per camera', async () => {
  resetAudioCodecCache();
  let runs = 0;
  const probe = async (_p, args) => {
    runs += 1;
    return args.includes('libopus');
  };
  const first = await probeAudioCodec('/bin/ffmpeg', probe);
  const runsAfterFirst = runs;
  const second = await probeAudioCodec('/bin/ffmpeg', probe);

  assert.deepEqual(first, second);
  assert.equal(runs, runsAfterFirst, 'the second call must not re-probe');
});

test('candidates are probed in preference order, stopping at the first success', async () => {
  const { probe, calls } = probeAllowing('libfdk_aac', 'libopus');
  await detectAudioCodec('ffmpeg', probe);
  assert.equal(calls.length, 1, 'a successful first candidate must not probe the rest');
  assert.ok(calls[0].includes('libfdk_aac'));
});

// The probe must exercise the SAME settings buildVideoArgs emits — proving an encoder works with
// different parameters proves nothing about the stream we actually ask for.
test('probe args mirror the real encoder settings', () => {
  const aac = AUDIO_CANDIDATES.find((c) => c.encoder === 'libfdk_aac');
  assert.ok(aac.encoderArgs.join(' ').includes('-profile:a aac_eld'), 'ELD profile must be proven, not just AAC');
  const opus = AUDIO_CANDIDATES.find((c) => c.encoder === 'libopus');
  assert.ok(opus.encoderArgs.join(' ').includes('-application lowdelay'));
  // 20ms is what opusFrameDuration snaps HomeKit's usual 30ms request to; probing another value
  // would leave the one we actually use unverified.
  assert.ok(opus.encoderArgs.join(' ').includes('-frame_duration 20'));
});

test('the probe needs no camera, no network and writes nothing', () => {
  const args = buildProbeArgs(['-codec:a', 'libopus']);
  const joined = args.join(' ');
  assert.match(joined, /-f lavfi -i anullsrc/, 'input is generated silence');
  assert.match(joined, /-f null -$/, 'output is discarded');
  assert.match(joined, /-t 0\.2/, 'a fraction of a second is enough');
  assert.doesNotMatch(joined, /rtsp|srtp|http/, 'the probe must not touch the network');
});
