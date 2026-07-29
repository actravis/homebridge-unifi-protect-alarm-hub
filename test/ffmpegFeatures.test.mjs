// Optional ffmpeg flag detection. `-fpsmax` only exists in ffmpeg >= 5.1, and an unknown option is
// a HARD error — so on a system ffmpeg 4.x (Debian 11, Ubuntu 20.04) passing it unconditionally
// would fail every live stream with nothing to explain why.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFpsMaxProbeArgs, resetFeatureCache, supportsFpsMax } from '../dist/streaming/ffmpegFeatures.js';

test('the probe exercises -fpsmax itself, with no network and no output', () => {
  const args = buildFpsMaxProbeArgs().join(' ');
  assert.match(args, /-fpsmax 30/, 'the flag under test must actually be passed');
  assert.match(args, /-f lavfi -i testsrc/, 'input is generated, not a camera');
  assert.match(args, /-f null -$/, 'output is discarded');
  assert.match(args, /-frames:v 5/, 'a handful of frames is enough');
  assert.doesNotMatch(args, /rtsp|srtp|http/);
});

test('a modern ffmpeg reports support', async () => {
  resetFeatureCache();
  assert.equal(await supportsFpsMax('ffmpeg', async () => true), true);
});

test('an old ffmpeg reports no support rather than failing the stream', async () => {
  resetFeatureCache();
  assert.equal(await supportsFpsMax('ffmpeg', async () => false), false);
});

// Degrading to "no cap" is serviceable; passing an unsupported flag is not.
test('a probe that throws degrades to unsupported', async () => {
  resetFeatureCache();
  assert.equal(
    await supportsFpsMax('ffmpeg', async () => {
      throw new Error('ENOENT');
    }),
    false,
  );
});

test('the result is cached so it costs one ffmpeg run per process', async () => {
  resetFeatureCache();
  let runs = 0;
  const probe = async () => {
    runs += 1;
    return true;
  };
  await supportsFpsMax('/bin/ffmpeg', probe);
  await supportsFpsMax('/bin/ffmpeg', probe);
  await supportsFpsMax('/bin/ffmpeg', probe);
  assert.equal(runs, 1);
});
