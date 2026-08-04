// Talkback arg/SDP building. Pure strings, so this needs no ffmpeg, phone, or camera.
// The security-relevant case is parseTalkbackTarget: the URL comes from the console and ends up as
// an ffmpeg argument, so anything that isn't plain rtp://host:port must be refused.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTalkbackArgs, buildTalkbackSdp, parseTalkbackTarget } from '../dist/streaming/talkback.js';

// --- parseTalkbackTarget ------------------------------------------------------

test('a normal console response parses', () => {
  assert.deepEqual(parseTalkbackTarget('rtp://192.168.1.197:7004', 24000), {
    host: '192.168.1.197', port: 7004, sampleRate: 24000,
  });
});

test('a hostname target parses, not just an IP', () => {
  assert.equal(parseTalkbackTarget('rtp://cam-1.local:7004', 24000)?.host, 'cam-1.local');
});

test('a trailing slash is tolerated', () => {
  assert.equal(parseTalkbackTarget('rtp://10.0.0.5:7004/', 24000)?.port, 7004);
});

test('surrounding whitespace is tolerated', () => {
  assert.equal(parseTalkbackTarget('  rtp://10.0.0.5:7004\n', 24000)?.port, 7004);
});

// Each of these would otherwise become an ffmpeg output argument.
for (const [label, url] of [
  ['a file URL', 'file:///etc/passwd'],
  ['an http URL', 'http://evil.example/x'],
  ['an ffmpeg concat trick', 'concat:/etc/passwd'],
  ['a tcp URL', 'tcp://10.0.0.5:7004'],
  ['no scheme', '192.168.1.197:7004'],
  ['no port', 'rtp://192.168.1.197'],
  ['a path appended', 'rtp://192.168.1.197:7004/../x'],
  ['a query appended', 'rtp://192.168.1.197:7004?listen=1'],
  ['userinfo', 'rtp://user:pass@10.0.0.5:7004'],
  ['a shell metacharacter', 'rtp://10.0.0.5:7004;id'],
  ['a space and a second arg', 'rtp://10.0.0.5:7004 -y /tmp/x'],
  ['port 0', 'rtp://10.0.0.5:0'],
  ['port out of range', 'rtp://10.0.0.5:70000'],
  ['empty', ''],
]) {
  test(`parseTalkbackTarget refuses ${label}`, () => {
    assert.equal(parseTalkbackTarget(url, 24000), undefined);
  });
}

test('a missing URL is refused rather than throwing', () => {
  assert.equal(parseTalkbackTarget(undefined, 24000), undefined);
});

// A missing or silly rate shouldn't cost us talkback entirely.
test('an absent or out-of-range sample rate falls back to 24000', () => {
  assert.equal(parseTalkbackTarget('rtp://10.0.0.5:7004', undefined)?.sampleRate, 24000);
  assert.equal(parseTalkbackTarget('rtp://10.0.0.5:7004', 96000)?.sampleRate, 24000);
  assert.equal(parseTalkbackTarget('rtp://10.0.0.5:7004', 0)?.sampleRate, 24000);
});

test('a valid non-default sample rate is honoured', () => {
  assert.equal(parseTalkbackTarget('rtp://10.0.0.5:7004', 16000)?.sampleRate, 16000);
});

// --- buildTalkbackSdp --------------------------------------------------------

const sdpOpts = { port: 5000, payloadType: 110, sampleRate: 24000, opus: true, srtp: 'BASE64KEY' };

test('the SDP declares SAVP so ffmpeg decrypts rather than reading plaintext RTP', () => {
  const sdp = buildTalkbackSdp(sdpOpts);
  assert.match(sdp, /^m=audio 5000 RTP\/SAVP 110$/m);
  assert.ok(!/RTP\/AVP /.test(sdp), 'AVP would mean ffmpeg ignores the crypto line');
});

test('the SDP carries the SRTP crypto line', () => {
  assert.match(buildTalkbackSdp(sdpOpts), /^a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:BASE64KEY$/m);
});

test('an Opus session maps opus at the negotiated rate, mono', () => {
  assert.match(buildTalkbackSdp(sdpOpts), /^a=rtpmap:110 opus\/24000\/1$/m);
});

test('an AAC-ELD session maps MPEG4-GENERIC with the HomeKit config', () => {
  const sdp = buildTalkbackSdp({ ...sdpOpts, opus: false, sampleRate: 16000 });
  assert.match(sdp, /^a=rtpmap:110 MPEG4-GENERIC\/16000\/1$/m);
  assert.match(sdp, /mode=AAC-hbr/);
});

test('the payload type from the request is used throughout', () => {
  const sdp = buildTalkbackSdp({ ...sdpOpts, payloadType: 97 });
  assert.match(sdp, /^m=audio 5000 RTP\/SAVP 97$/m);
  assert.match(sdp, /^a=rtpmap:97 /m);
});

test('the SDP ends with a newline, which ffmpeg requires', () => {
  assert.ok(buildTalkbackSdp(sdpOpts).endsWith('\n'));
});

// --- buildTalkbackArgs -------------------------------------------------------

const target = { host: '192.168.1.197', port: 7004, sampleRate: 24000 };
const args = (over = {}) => buildTalkbackArgs({ target, frameDurationMs: 20, ...over });

test('the SDP is read from stdin', () => {
  const a = args();
  assert.deepEqual([a[a.indexOf('-f')], a[a.indexOf('-f') + 1]], ['-f', 'sdp']);
  assert.equal(a[a.indexOf('-i') + 1], 'pipe:0');
});

// Every other ffmpeg call in this plugin passes -nostdin; here stdin IS the input.
test('-nostdin is absent, because the SDP arrives on stdin', () => {
  assert.ok(!args().includes('-nostdin'));
});

test('the protocol whitelist is present and excludes file and http', () => {
  const list = args()[args().indexOf('-protocol_whitelist') + 1];
  assert.equal(list, 'pipe,udp,rtp,crypto,data');
  assert.ok(!/file|http/.test(list));
});

test('output is mono Opus at the rate the camera asked for', () => {
  const a = args();
  assert.equal(a[a.indexOf('-c:a') + 1], 'libopus');
  assert.equal(a[a.indexOf('-ar') + 1], '24000');
  assert.equal(a[a.indexOf('-ac') + 1], '1');
  assert.equal(a[a.indexOf('-application') + 1], 'voip');
});

test('output goes to the parsed rtp target and nowhere else', () => {
  const a = args();
  assert.equal(a.at(-1), 'rtp://192.168.1.197:7004');
  assert.equal(a[a.length - 3], '-f');
  assert.equal(a[a.length - 2], 'rtp');
});

test('the frame duration is passed through, so an illegal value cannot be invented here', () => {
  assert.equal(args({ frameDurationMs: 40 })[args({ frameDurationMs: 40 }).indexOf('-frame_duration') + 1], '40');
});

// The phone's clock and the camera's are independent; without this the stream drifts and stalls.
test('async resampling is enabled', () => {
  assert.match(args()[args().indexOf('-af') + 1], /aresample=async=1/);
});

test('the bitrate defaults to something sane and is overridable', () => {
  assert.equal(args()[args().indexOf('-b:a') + 1], '24k');
  assert.equal(args({ bitrateKbps: 32 })[args({ bitrateKbps: 32 }).indexOf('-b:a') + 1], '32k');
});
