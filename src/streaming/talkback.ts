// Two-way audio (talkback): HomeKit microphone → camera speaker.
//
// The reverse of live streaming, and the only path where audio flows *into* Protect. HomeKit sends
// the phone's microphone to us as SRTP on the audio port we advertised in `prepareStream`; the
// camera listens for plain Opus RTP on a port the console tells us. So talkback is a second ffmpeg
// process, decrypting one and re-encoding to the other.
//
// Verified against real hardware: `POST /cameras/{id}/talkback-session` returns a *stable* target
// (`rtp://<camera-ip>:7004` on every call, not a per-session allocation) and there is no session to
// tear down — GET and DELETE both 404. Note the target is the **camera's own IP**, not the console's,
// so talkback needs a route to the camera itself; RTSPS only ever talks to the console. A UDP probe
// confirmed a listener on that port (control port on the same host gave ECONNREFUSED).
//
// Everything here is pure string building so it can be unit-tested without ffmpeg, a phone, or a
// camera; the process and socket plumbing lives in streamingDelegate.ts.

/** What the console told us about where to send audio. */
export interface TalkbackTarget {
  host: string;
  port: number;
  /** Opus sample rate the camera expects (24000 on observed hardware). */
  sampleRate: number;
}

/**
 * Parse and validate the console's talkback URL.
 *
 * This value is external input that ends up as an ffmpeg argument, so it is validated rather than
 * trusted: only `rtp://host:port` is accepted. Without this a hostile or malformed response could
 * hand ffmpeg a different protocol (`file:`, `concat:`, `http:`) and turn a talkback session into a
 * file read or an outbound request. Returns undefined rather than throwing so the caller can decline
 * talkback and still serve one-way audio.
 */
export function parseTalkbackTarget(
  url: string | undefined,
  sampleRate: number | undefined,
): TalkbackTarget | undefined {
  if (!url) {
    return undefined;
  }
  // Deliberately strict: scheme, host and port only. No path, query, userinfo or options.
  const m = /^rtp:\/\/([A-Za-z0-9._-]+):(\d{1,5})\/?$/.exec(url.trim());
  if (!m?.[1] || !m[2]) {
    return undefined;
  }
  const host = m[1];
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  // 24000 on observed hardware. Fall back rather than fail: a missing rate is not a reason to
  // refuse talkback, and Opus resamples internally.
  const rate = typeof sampleRate === 'number' && sampleRate >= 8000 && sampleRate <= 48000
    ? sampleRate
    : 24000;
  return { host, port, sampleRate: rate };
}

export interface TalkbackSdpOptions {
  /** The local port HomeKit sends its microphone audio to (our advertised audio port). */
  port: number;
  /** RTP payload type HomeKit will use (from the start-stream request). */
  payloadType: number;
  /** HomeKit's audio sample rate in Hz. */
  sampleRate: number;
  /** True when the negotiated HomeKit codec is Opus; false means AAC-ELD. */
  opus: boolean;
  /** SRTP key+salt, base64 — the same crypto material as the outbound audio stream. */
  srtp: string;
}

/**
 * An SDP describing the *incoming* SRTP audio stream, fed to ffmpeg on stdin.
 *
 * ffmpeg needs a session description to decrypt SRTP; there is no command-line way to express the
 * crypto line. `RTP/SAVP` (not AVP) is what makes it treat the stream as encrypted.
 */
export function buildTalkbackSdp(o: TalkbackSdpOptions): string {
  const pt = o.payloadType;
  // AAC-ELD's fmtp is a fixed HomeKit configuration; Opus needs only the FEC hints.
  const codecLines = o.opus
    ? [`a=rtpmap:${pt} opus/${o.sampleRate}/1`, `a=fmtp:${pt} minptime=10;useinbandfec=1`]
    : [
        `a=rtpmap:${pt} MPEG4-GENERIC/${o.sampleRate}/1`,
        `a=fmtp:${pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;` +
          'indexdeltalength=3;config=F8F0212C00BC00',
      ];
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=HomeKit Talkback',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${o.port} RTP/SAVP ${pt}`,
    ...codecLines,
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${o.srtp}`,
    '',
  ].join('\n');
}

export interface TalkbackArgsOptions {
  target: TalkbackTarget;
  /** Opus frame duration in ms; must be a value libopus accepts (see opusFrameDuration). */
  frameDurationMs: number;
  /** Encoder bitrate in kbit/s. Voice at 24 kHz needs very little. */
  bitrateKbps?: number;
}

/**
 * ffmpeg args to turn HomeKit's SRTP microphone stream into Opus RTP for the camera.
 *
 * The SDP arrives on stdin, so `-nostdin` must NOT be used here — unlike every other ffmpeg
 * invocation in this plugin, where stdin is closed deliberately.
 */
export function buildTalkbackArgs(o: TalkbackArgsOptions): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    // Whitelist exactly what an SDP-on-stdin SRTP session needs. ffmpeg refuses unlisted protocols,
    // which is a second line of defence behind parseTalkbackTarget.
    '-protocol_whitelist', 'pipe,udp,rtp,crypto,data',
    '-f', 'sdp',
    '-i', 'pipe:0',
    '-map', '0:a:0',
    '-c:a', 'libopus',
    '-application', 'voip',        // tuned for speech, not music
    '-ar', String(o.target.sampleRate),
    '-ac', '1',                    // the camera speaker is mono
    '-b:a', `${o.bitrateKbps ?? 24}k`,
    '-frame_duration', String(o.frameDurationMs),
    // The phone's clock and the camera's differ; without this the stream drifts and eventually
    // stalls rather than dropping a sample here and there.
    '-af', 'aresample=async=1',
    '-f', 'rtp',
    `rtp://${o.target.host}:${o.target.port}`,
  ];
}
