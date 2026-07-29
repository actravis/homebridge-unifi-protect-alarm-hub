// The CameraController configuration and the ffmpeg-binary lookup. Both are small, but both
// are single points of failure: a wrong streamingOptions block makes HomeKit negotiate something
// the delegate cannot deliver, and a wrong ffmpeg path makes every live view fail at spawn.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCameraController } from '../dist/streaming/cameraOptions.js';
import { resolveFfmpegPath } from '../dist/streaming/ffmpegPath.js';

/** The slice of hap the builder reads, with the real enum values. */
const hap = {
  CameraController: class {
    constructor(config) {
      this.config = config;
    }
  },
  SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
  H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
  H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
};

const config = () => buildCameraController(hap, 'the-delegate').config;

test('the controller is wired to the delegate it was given', () => {
  assert.equal(config().delegate, 'the-delegate');
});

test('the advertised profiles and levels cover what iOS negotiates', () => {
  // iOS asks for High/4.0 on a modern iPhone; offering only Baseline would cap quality, and
  // offering a profile the encoder args can't satisfy makes the stream fail after negotiation.
  const { video } = config().streamingOptions;
  assert.deepEqual(video.codec.profiles, [0, 1, 2]);
  assert.deepEqual(video.codec.levels, [0, 1, 2]);
});

// Deliberate, and load-bearing: hap-nodejs fakes an audio codec when this is omitted, and the
// delegate returns no audio endpoint. Advertising audio and then never sending any makes iOS
// wait for it and refuse to render video at all.
test('no audio codec is advertised while the delegate is video-only', () => {
  assert.equal(config().streamingOptions.audio, undefined);
});

test('every advertised resolution maps to an RTSPS substream the delegate can pick', async () => {
  const { selectStreamQuality } = await import('../dist/streaming/ffmpegArgs.js');
  for (const [width, height, fps] of config().streamingOptions.video.resolutions) {
    assert.ok(width > 0 && height > 0 && fps > 0);
    assert.ok(['high', 'medium', 'low'].includes(selectStreamQuality(width)), `no substream for ${width}px`);
  }
});

test('the SRTP suite matches the one the ffmpeg output args use', () => {
  assert.deepEqual(config().streamingOptions.supportedCryptoSuites, [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80]);
});

test('more than one viewer can watch a camera at once', () => {
  assert.ok(config().cameraStreamCount >= 2);
});

// ffmpeg-for-homebridge is an optionalDependency: it is absent on unsupported platforms and
// whenever a user installs with --omit=optional (as CI does). Falling back to a system ffmpeg
// must be silent, not a crash at the first live view.
test('resolveFfmpegPath returns a usable path whether or not the bundle is installed', () => {
  const path = resolveFfmpegPath();
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0);
  assert.ok(path === 'ffmpeg' || path.includes('ffmpeg'), `unexpected ffmpeg path: ${path}`);
});

// --- Audio declaration -------------------------------------------------------
// The controller ADVERTISES a codec and the delegate SENDS it. If they disagree in the direction
// of "advertised but never sent", iOS waits for audio that never arrives and refuses to render the
// VIDEO either — so this is the one invariant worth asserting explicitly.

const withAudio = (codec) => buildCameraController(hap, 'd', codec).config.streamingOptions.audio;

test('no audio is advertised when no codec was probed', () => {
  assert.equal(withAudio(undefined), undefined, 'advertising audio we cannot send breaks video');
});

test('a probed codec is advertised with the parameters the delegate can deliver', () => {
  const audio = withAudio({ encoder: 'libopus', hapCodec: 'OPUS' });
  assert.ok(audio, 'a probed codec must be advertised or iOS never sends audio parameters');
  assert.equal(audio.codecs.length, 1);
  assert.equal(audio.codecs[0].type, 'OPUS');
  assert.equal(audio.codecs[0].audioChannels, 1, 'HomeKit camera audio is mono');
  // Only rates the encoder was verified against on real hardware.
  assert.deepEqual(audio.codecs[0].samplerate, [16, 24]);
});

test('AAC-ELD is advertised under its HAP name, not the ffmpeg encoder name', () => {
  const audio = withAudio({ encoder: 'libfdk_aac', hapCodec: 'AAC-eld' });
  assert.equal(audio.codecs[0].type, 'AAC-eld');
  // A common slip: advertising "libfdk_aac", which HomeKit does not recognise.
  assert.doesNotMatch(JSON.stringify(audio), /libfdk|libopus/);
});

// twoWayAudio is what enables talkback; it must stay off until the reverse path exists, or the
// Home app offers a microphone button that does nothing.
test('two-way audio is not claimed while talkback is unimplemented', () => {
  assert.notEqual(withAudio({ encoder: 'libopus', hapCodec: 'OPUS' })?.twoWayAudio, true);
});
