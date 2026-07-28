// Pure construction of ffmpeg arguments for RTSPS → HomeKit SRTP, plus stream-quality
// selection and SRTP/URL helpers. No process spawning, no I/O — so the parts that are easy
// to get subtly wrong are unit-testable. The StreamingDelegate feeds these to ffmpeg.

import type { RtspsStreams } from '../types';

export type StreamQuality = 'high' | 'medium' | 'low';

/** ffmpeg's `-srtp_out_params` wants base64 of the 16-byte master key followed by the 14-byte salt. */
export function encodeSrtpParams(key: Buffer, salt: Buffer): string {
  return Buffer.concat([key, salt]).toString('base64');
}

const QUALITY_FALLBACK: Record<StreamQuality, StreamQuality[]> = {
  high: ['high', 'medium', 'low'],
  medium: ['medium', 'high', 'low'],
  low: ['low', 'medium', 'high'],
};

/**
 * Pick the RTSPS URL for a quality, falling back to the nearest available substream.
 *
 * Values come straight from the console's JSON and become ffmpeg's input, so they are checked
 * rather than trusted: a non-string (or an unexpected scheme such as `file:`/`http:`) would
 * otherwise point ffmpeg's demuxers at something we never intended.
 */
export function pickRtspsUrl(streams: RtspsStreams, quality: StreamQuality): string | undefined {
  for (const q of QUALITY_FALLBACK[quality]) {
    const url = streams[q];
    if (typeof url === 'string' && /^rtsps?:\/\//i.test(url)) {
      return url;
    }
  }
  return undefined;
}

/**
 * Effective video bitrate. iOS opens streams at a very conservative bitrate (~300kbps even for
 * 720p) and expects the accessory to raise quality afterwards via `reconfigure`, which we don't
 * implement yet. Until then, floor the bitrate to something that actually looks good at the
 * requested resolution — the link is local, so the extra bandwidth is free.
 */
export function effectiveBitrateKbps(requestedKbps: number, width: number): number {
  const floor = width >= 1920 ? 4000 : width >= 1280 ? 2000 : width >= 640 ? 1000 : 300;
  return Math.max(requestedKbps, floor);
}

/** Pick which RTSPS substream to pull for a HomeKit-requested width. */
export function selectStreamQuality(requestedWidth: number): StreamQuality {
  if (requestedWidth >= 1280) {
    return 'high';
  }
  if (requestedWidth >= 640) {
    return 'medium';
  }
  return 'low';
}

/**
 * Scale to fit *inside* the requested box without distorting — and deliberately do NOT pad.
 *
 * HomeKit always asks for 16:9 resolutions, but cameras aren't all 16:9 (a 1600x1200 doorbell
 * is 4:3). The requested resolution is a maximum, not a demand: sending the camera's true
 * geometry (a 4:3 source becomes 960x720) lets the Home app letterbox it correctly for whatever
 * viewport it has. Two wrong alternatives, both tried:
 *   - a bare `scale=W:H` stretches the picture, and ffmpeg then signals a non-square pixel
 *     aspect ratio to compensate;
 *   - padding to the full 16:9 box bakes bars into the frame, which the Home app then
 *     letterboxes *again* — black on all four sides.
 * `force_divisible_by=2` keeps both dimensions even (required by H.264 / yuv420p) and
 * `setsar=1` pins square pixels so nothing downstream rescales it.
 */
export function buildScaleFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
}

export interface VideoArgsOptions {
  rtspsUrl: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /** HomeKit-negotiated H.264 profile (HAP enum: 0=baseline, 1=main, 2=high). */
  profile?: number;
  /** HomeKit-negotiated H.264 level (HAP enum: 0=3.1, 1=3.2, 2=4.0). */
  level?: number;
  /** RTP payload type HomeKit negotiated for video. */
  payloadType: number;
  /** Video SSRC HomeKit negotiated. */
  ssrc: number;
  /** SRTP output params: base64 of the 16-byte master key + 14-byte salt. */
  srtpParams: string;
  address: string;
  videoPort: number;
  /**
   * Our local RTCP port (ffmpeg `localrtcpport`), bound to the port we advertised to iOS in
   * prepareStream so receiver reports arrive where iOS expects, as the canonical hap-nodejs
   * example camera does. Omit to let ffmpeg pick.
   */
  localRtcpPort?: number;
  /** Max RTP packet size (from HomeKit's negotiated MTU). */
  mtu: number;
  /** Video encoder for transcoding (e.g. 'h264_videotoolbox'); defaults to software libx264. */
  encoder?: string;
}

/** Give up on a silent RTSP source after this long (ffmpeg wants microseconds). */
const RTSP_IO_TIMEOUT_US = 10_000_000;

/** HAP H264Profile enum (0/1/2) → ffmpeg `-profile:v` name. */
const H264_PROFILE_NAMES = ['baseline', 'main', 'high'];
/** HAP H264Level enum (0/1/2) → ffmpeg `-level:v` name. */
const H264_LEVEL_NAMES = ['3.1', '3.2', '4.0'];

/**
 * Build the ffmpeg argv to pull an RTSPS stream and emit it as SRTP to HomeKit.
 *
 * Always transcodes. A stream-copy path would be cheaper, but it is only valid when the source
 * already matches everything HomeKit negotiated — codec (several Protect cameras are HEVC),
 * resolution, bitrate cap and profile/level — and none of that is knowable from the API before
 * ffmpeg has opened the stream. Adding it means probing the source first, so it stays a
 * follow-up rather than an unreachable branch here.
 *
 * Video-only by design for now. HomeKit negotiates an audio codec regardless (hap-nodejs fakes
 * one when `streamingOptions.audio` is omitted) and renders video fine without audio packets —
 * verified against the canonical hap-nodejs example camera, which is also video-only. Adding
 * camera audio later means shipping three things together: the `streamingOptions.audio` codec,
 * an `audio` block in the PrepareStreamResponse, and a second AAC-ELD SRTP output here.
 */
export function buildVideoArgs(o: VideoArgsOptions): string[] {
  const args = [
    // Drop the version/configuration banner — pure noise that dwarfs the useful diagnostics.
    '-hide_banner',
    // Confine the input to RTSP(S) and its transports, so a bad URL can't reach other demuxers.
    '-protocol_whitelist', 'rtsp,rtsps,tls,tcp,udp,crypto',
    '-rtsp_transport', 'tcp',
    // Don't block forever if the camera stops responding mid-stream: time out so ffmpeg exits
    // and the session is torn down (and HomeKit told) instead of showing a frozen frame.
    // NOTE: `-timeout`, not `-rw_timeout` — the latter is a protocol-level option the RTSP
    // demuxer rejects outright ("Option not found"), which fails every stream. Verified live.
    '-timeout', String(RTSP_IO_TIMEOUT_US),
    '-i', o.rtspsUrl,
    '-an', '-sn', '-dn',
  ];

  args.push(
    '-codec:v', o.encoder ?? 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'mpeg',
    '-r', String(o.fps),
    // `superfast`, NOT `ultrafast`: ultrafast hard-disables CABAC/8x8dct and forces a
    // Constrained Baseline stream regardless of `-profile:v`, so it cannot satisfy the High
    // profile HomeKit negotiates. superfast keeps both, at ~the same throughput
    // (measured ~32x vs ~33x realtime).
    '-preset', 'superfast',
    // Deliberately NOT `-tune zerolatency`. It enables x264 sliced-threads (one slice-NAL per
    // CPU core per frame) and iOS silently refuses to display the result — this was the cause
    // of a long-running "stream never renders / Not Responding" bug, bisected flag by flag.
    // The part actually worth keeping from zerolatency is "no B-frames" (B-frame reordering
    // makes iOS show only keyframes, i.e. an ~8s stutter), so set that directly.
    '-bf', '0',
    // Emit an IDR (with SPS/PPS) every second so a HomeKit client joining mid-GOP starts
    // decoding promptly instead of waiting out libx264's default ~250-frame keyframe interval.
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-filter:v', buildScaleFilter(o.width, o.height),
    '-b:v', `${o.bitrateKbps}k`,
    '-maxrate', `${o.bitrateKbps}k`,
    '-bufsize', `${o.bitrateKbps * 2}k`,
    // Match the profile/level HomeKit negotiated; iOS configures its decoder accordingly.
    '-profile:v', H264_PROFILE_NAMES[o.profile ?? 0] ?? 'baseline',
    '-level:v', H264_LEVEL_NAMES[o.level ?? 0] ?? '3.1',
  );

  const localRtcp = o.localRtcpPort ? `localrtcpport=${o.localRtcpPort}&` : '';
  args.push(
    '-payload_type', String(o.payloadType),
    '-ssrc', String(o.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', o.srtpParams,
    `srtp://${o.address}:${o.videoPort}?${localRtcp}rtcpport=${o.videoPort}&pkt_size=${o.mtu}`,
  );
  return args;
}
