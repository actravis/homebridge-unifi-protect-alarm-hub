import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildScaleFilter,
  buildVideoArgs,
  effectiveBitrateKbps,
  encodeSrtpParams,
  opusFrameDuration,
  pickRtspsUrl,
  selectStreamQuality,
} from '../dist/streaming/ffmpegArgs.js';

// Substream choice is a latency/CPU trade-off settled by measurement, not by pixel counting.
// `medium` matches HomeKit's 720p request exactly and is ~4.4x cheaper to decode, but every
// substream has a 5s keyframe interval and only the primary stream serves a cached keyframe on
// connect. Time to first packet, 5 runs each: high 1370-1683ms consistently; medium 1364-1390ms
// three times and 5611/5677ms twice. A predictable join beats a cheaper decode.
test('selectStreamQuality prefers the substream that joins predictably fast', () => {
  assert.equal(selectStreamQuality(1920), 'high');
  assert.equal(selectStreamQuality(1280), 'high', 'medium matches 720p but risks a 4s GOP wait');
  // Below 720p the request is far under native, so a smaller source costs nothing in latency terms.
  assert.equal(selectStreamQuality(1024), 'medium');
  assert.equal(selectStreamQuality(640), 'medium');
  assert.equal(selectStreamQuality(480), 'low');
  assert.equal(selectStreamQuality(320), 'low');
});

const base = {
  rtspsUrl: 'rtsps://10.0.0.1:7441/streamkey',
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 800,
  payloadType: 99,
  ssrc: 12345,
  srtpParams: 'BASE64SRTP',
  address: '10.0.0.2',
  videoPort: 50000,
  mtu: 1378,
};

// ffmpeg reads stdin for keyboard control, and the delegate spawns it with stdin ignored (an
// immediate EOF). Verified fine on the bundled build; this makes it explicit for other builds.
test('buildVideoArgs: disables ffmpeg stdin handling', () => {
  assert.match(buildVideoArgs({ ...base }).join(' '), /-nostdin/);
});

test('buildVideoArgs: common RTSPS input + SRTP output flags are present', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-rtsp_transport tcp/);
  assert.match(a, /-i rtsps:\/\/10\.0\.0\.1:7441\/streamkey/);
  assert.match(a, /-payload_type 99/);
  assert.match(a, /-ssrc 12345/);
  assert.match(a, /-srtp_out_suite AES_CM_128_HMAC_SHA1_80/);
  assert.match(a, /-srtp_out_params BASE64SRTP/);
  assert.match(a, /srtp:\/\/10\.0\.0\.2:50000\?rtcpport=50000&pkt_size=1378/);
});

// We always transcode. A stream-copy path is only valid when the source already matches every
// negotiated parameter (codec — several Protect cameras are HEVC — plus resolution, bitrate cap
// and profile/level), none of which the API reports before ffmpeg opens the stream. It existed
// here as an option nothing could ever set; it comes back with source probing or not at all.
test('buildVideoArgs: always encodes, never stream-copies', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.doesNotMatch(a, /-codec:v copy/);
});

test('buildVideoArgs: sets encoder, scale, bitrate caps and forced keyframes', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-codec:v libx264/);
  assert.match(a, /-filter:v scale=1280:720/);
  assert.match(a, /-b:v 800k/);
  assert.match(a, /-maxrate 800k/);
  assert.match(a, /-bufsize 1600k/);
  assert.match(a, /-fpsmax 30/);
  assert.match(a, /-force_key_frames expr:gte\(t,n_forced\*1\)/); // HomeKit fast-join
});

// REGRESSION: `-r 30` treats HomeKit's MAXIMUM fps as a target, so a 24fps camera got 6 invented
// frames per second — 25% wasted encoding, and judder because duplicates land at irregular
// intervals. Measured in a live log: `dup` climbing to 97 over 15s on a 24fps camera while a
// 30fps camera held at 2. `-fpsmax` caps without upsampling.
test('buildVideoArgs: caps fps without duplicating frames on a slower camera', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-fpsmax 30/);
  assert.doesNotMatch(a, /(^| )-r 30/, '-r would upsample a 24fps source to 30fps');
});

// REGRESSION GUARD — the bug that made live view never render. `-tune zerolatency` turns on
// x264 sliced-threads and iOS silently refuses to display the result. `-bf 0` gives us the
// no-B-frames behaviour we actually wanted. Do not "restore" zerolatency.
test('buildVideoArgs: never emits -tune zerolatency; disables B-frames instead', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.doesNotMatch(a, /zerolatency/);
  assert.match(a, /-bf 0/);
});

// `ultrafast` hard-disables CABAC/8x8dct, forcing Constrained Baseline regardless of
// -profile:v, so it can never satisfy the High profile HomeKit negotiates.
test('buildVideoArgs: uses superfast, never ultrafast', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-preset superfast/);
  assert.doesNotMatch(a, /ultrafast/);
});

test('buildVideoArgs: matches the negotiated H.264 profile/level', () => {
  const high = buildVideoArgs({ ...base, profile: 2, level: 2 }).join(' ');
  assert.match(high, /-profile:v high -level:v 4\.0/);
  const main = buildVideoArgs({ ...base, profile: 1, level: 1 }).join(' ');
  assert.match(main, /-profile:v main -level:v 3\.2/);
  // Defaults when unspecified, and when an unknown enum arrives: baseline / 3.1.
  assert.match(buildVideoArgs({ ...base }).join(' '), /-profile:v baseline -level:v 3\.1/);
  const odd = buildVideoArgs({ ...base, profile: 99, level: 99 }).join(' ');
  assert.match(odd, /-profile:v baseline -level:v 3\.1/);
});

test('buildVideoArgs: a hardware encoder overrides libx264', () => {
  const a = buildVideoArgs({ ...base, encoder: 'h264_videotoolbox' }).join(' ');
  assert.match(a, /-codec:v h264_videotoolbox/);
  assert.doesNotMatch(a, /libx264/);
});

test('buildVideoArgs: video-only — no audio input, output or codec', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-an/);
  assert.doesNotMatch(a, /libfdk_aac/);
  assert.doesNotMatch(a, /anullsrc/);
  assert.doesNotMatch(a, /aac_eld/);
});

test('buildVideoArgs: localRtcpPort binds the RTCP port to the advertised port', () => {
  const a = buildVideoArgs({ ...base, localRtcpPort: 51000 }).join(' ');
  assert.match(a, /srtp:\/\/10\.0\.0\.2:50000\?localrtcpport=51000&rtcpport=50000/);
});

test('buildVideoArgs: no localrtcpport when not provided', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.doesNotMatch(a, /localrtcpport=/);
});

// Binding ffmpeg's RTP *source* address broke delivery on a multi-homed host; we advertise
// sourceAddress via addressOverride instead and never pass localaddr.
test('buildVideoArgs: never binds the RTP source address (localaddr)', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.doesNotMatch(a, /localaddr/);
});

test('buildScaleFilter: fits inside the box, keeps aspect, never pads', () => {
  const f = buildScaleFilter(1280, 720);
  assert.match(f, /scale=1280:720:force_original_aspect_ratio=decrease/);
  assert.match(f, /force_divisible_by=2/); // H.264/yuv420p need even dimensions
  assert.match(f, /setsar=1/);
  // Padding bakes bars into the frame and the Home app then letterboxes again — bars all round.
  assert.doesNotMatch(f, /pad=/);
});

test('effectiveBitrateKbps floors the conservative bitrate iOS asks for', () => {
  // iOS opens at ~299kbps even for 720p; floor by resolution so the picture is usable.
  assert.equal(effectiveBitrateKbps(299, 1280), 2000);
  assert.equal(effectiveBitrateKbps(299, 1920), 4000);
  assert.equal(effectiveBitrateKbps(299, 640), 1000);
  assert.equal(effectiveBitrateKbps(299, 320), 300);
  // A request above the floor is honoured as-is.
  assert.equal(effectiveBitrateKbps(6000, 1920), 6000);
});

test('encodeSrtpParams base64-encodes key followed by salt', () => {
  const key = Buffer.alloc(16, 1);
  const salt = Buffer.alloc(14, 2);
  assert.equal(encodeSrtpParams(key, salt), Buffer.concat([key, salt]).toString('base64'));
});

// Shaped like the console's real response: rtsps://<host>:7441/<streamKey>
const H = 'rtsps://10.0.0.1:7441/highkey';
const M = 'rtsps://10.0.0.1:7441/medkey';
const L = 'rtsps://10.0.0.1:7441/lowkey';

test('pickRtspsUrl returns the requested quality when present', () => {
  assert.equal(pickRtspsUrl({ high: H, medium: M, low: L }, 'medium'), M);
});

test('pickRtspsUrl falls back to the nearest available substream', () => {
  assert.equal(pickRtspsUrl({ low: L }, 'high'), L);
  assert.equal(pickRtspsUrl({ high: H }, 'low'), H);
});

test('pickRtspsUrl returns undefined when nothing is available', () => {
  assert.equal(pickRtspsUrl({}, 'high'), undefined);
});

// These values become ffmpeg's input, so anything that isn't an RTSP(S) URL is refused rather
// than handed to some other demuxer (file:, http:, concat:, …) or stringified into `-i`.
test('pickRtspsUrl rejects non-RTSPS values from the API', () => {
  assert.equal(pickRtspsUrl({ high: 'file:///etc/passwd' }, 'high'), undefined);
  assert.equal(pickRtspsUrl({ high: 'http://evil.example/x' }, 'high'), undefined);
  assert.equal(pickRtspsUrl({ high: { nested: 'object' } }, 'high'), undefined);
  assert.equal(pickRtspsUrl({ high: 42 }, 'high'), undefined);
  // A plain rtsp:// URL is still acceptable.
  assert.equal(pickRtspsUrl({ high: 'rtsp://10.0.0.1:7447/k' }, 'high'), 'rtsp://10.0.0.1:7447/k');
});

// --- Audio output ------------------------------------------------------------

const audio = (over = {}) => ({
  encoder: 'libopus', sampleRateHz: 16000, bitrateKbps: 24,
  payloadType: 110, ssrc: 222, srtpParams: 'AUDIOSRTP', port: 50002, ...over,
});

test('buildVideoArgs: video-only strips the source audio', () => {
  const a = buildVideoArgs({ ...base }).join(' ');
  assert.match(a, /-an/);
  assert.doesNotMatch(a, /libopus|libfdk_aac/);
  assert.equal(a.match(/-f rtp/g).length, 1, 'exactly one output');
});

test('buildVideoArgs: audio adds a SECOND SRTP output with its own keys and SSRC', () => {
  const a = buildVideoArgs({ ...base, audio: audio() }).join(' ');
  assert.doesNotMatch(a, /-an/, 'audio must not be stripped when we intend to send it');
  assert.equal(a.match(/-f rtp/g).length, 2, 'video + audio outputs');
  assert.match(a, /-codec:a libopus/);
  assert.match(a, /-payload_type 110 -ssrc 222/);
  assert.match(a, /-srtp_out_params AUDIOSRTP/);
  // HomeKit treats the streams independently, so audio has its own port and small packets.
  assert.match(a, /srtp:\/\/10\.0\.0\.2:50002\?rtcpport=50002&pkt_size=188/);
  assert.match(a, /-ac 1/, 'HomeKit camera audio is mono');
  assert.match(a, /-ar 16000/);
});

// Some Protect cameras publish no audio track. A non-optional map makes ffmpeg exit at once,
// killing the VIDEO stream over a missing microphone.
// The RTSP source intermittently delivers an audio packet whose timestamp precedes the previous
// one; measured on an HEVC camera, 2 of 5 stream starts logged "Non-monotonic DTS" and the muxer
// silently rewrote the timestamp. aresample realigns by filling/trimming instead. `first_pts=0` is
// deliberately absent: zeroing only the audio stream's start would create a lip-sync offset.
test('buildVideoArgs: keeps the audio timeline monotonic', () => {
  const a = buildVideoArgs({ ...base, audio: audio() }).join(' ');
  assert.match(a, /-filter:a aresample=async=1(?![\d])/);
  assert.doesNotMatch(a, /first_pts/);
});

test('buildVideoArgs: no audio filter on a video-only stream', () => {
  assert.doesNotMatch(buildVideoArgs({ ...base }).join(' '), /-filter:a/);
});

test('buildVideoArgs: the audio mapping is optional so a mic-less camera still streams video', () => {
  assert.match(buildVideoArgs({ ...base, audio: audio() }).join(' '), /-map 0:a:0\?/);
});

// Cameras publish several streams (observed live: two audio tracks then the video at index 2), so
// each output must select explicitly or ffmpeg's defaults put audio into the video output.
test('buildVideoArgs: each output selects its stream explicitly', () => {
  const a = buildVideoArgs({ ...base, audio: audio() }).join(' ');
  assert.match(a, /-map 0:v:0/);
  assert.match(a, /-map 0:a:0\?/);
});

test('buildVideoArgs: AAC-ELD asks for the ELD profile specifically', () => {
  const a = buildVideoArgs({ ...base, audio: audio({ encoder: 'libfdk_aac' }) }).join(' ');
  assert.match(a, /-codec:a libfdk_aac/);
  assert.match(a, /-profile:a aac_eld/, 'plain AAC is not a codec HomeKit accepts');
  assert.doesNotMatch(a, /-application lowdelay/, 'that is an Opus option');
});

// REGRESSION: HomeKit commonly asks for packet_time 30, which libopus rejects outright ("Invalid
// frame duration: 30") — and that failure kills the whole process, video included. Caught against
// real hardware, not in review.
test('opusFrameDuration snaps to a duration libopus accepts, never rounding up', () => {
  assert.equal(opusFrameDuration(30), 20, "HomeKit's usual request must be snapped down");
  assert.equal(opusFrameDuration(20), 20);
  assert.equal(opusFrameDuration(60), 60);
  assert.equal(opusFrameDuration(45), 40);
  assert.equal(opusFrameDuration(undefined), 20);
  assert.equal(opusFrameDuration(1), 2.5, 'below the minimum, clamp up to the smallest legal value');
  for (const ms of [1, 7, 20, 30, 45, 55, 60, 100, 1000]) {
    assert.ok([2.5, 5, 10, 20, 40, 60].includes(opusFrameDuration(ms)), `illegal duration for ${ms}`);
  }
});

test('buildVideoArgs: Opus frame duration is always a legal value', () => {
  const a = buildVideoArgs({ ...base, audio: audio({ packetTimeMs: 30 }) }).join(' ');
  assert.match(a, /-frame_duration 20/);
  assert.doesNotMatch(a, /-frame_duration 30/);
});
