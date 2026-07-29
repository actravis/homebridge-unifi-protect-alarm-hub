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

/**
 * Pick which RTSPS substream to pull for a HomeKit-requested width.
 *
 * Prefers the LARGER stream even when a smaller one matches the request exactly, because Protect's
 * substreams differ in how fast they can be joined — and join time is what a user actually feels.
 *
 * Measured geometry:
 *
 *   camera type       high              medium           low
 *   16:9 (2688x1512)  2688x1512 @24     1280x720 @24     640x360 @24
 *   4:3  doorbell     1600x1200 @30      960x720 @30     480x360 @15
 *
 * `medium` looks like the obvious choice for HomeKit's usual 1280x720 request, and it is ~4.4x
 * cheaper to decode. It was tried, and it cost four seconds of latency: every substream has a
 * 5-second keyframe interval, and ffmpeg cannot emit anything until it decodes one. Time to first
 * SRTP packet, five runs each on the same camera:
 *
 *   high    1370  1400  1420  1428  1683 ms   — always fast
 *   medium  1364  1370  1390  5611  5677 ms   — a coin flip on waiting a whole GOP
 *
 * Protect evidently serves a cached keyframe when you open the primary stream (it is the one being
 * recorded) but not on the substreams, so `medium` means waiting for the next natural IDR. Paying
 * CPU for a predictable ~1.4s join is the right trade; the way to claw the CPU back is hardware
 * encoding, not a cheaper source.
 *
 * Below 720p the smaller substreams are still worth using: the request is already far below the
 * native resolution, so nothing is gained by decoding the full-size frame.
 */
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

/** Everything needed to emit HomeKit's audio stream alongside the video one. */
export interface AudioArgsOptions {
  /** ffmpeg encoder chosen by probing this ffmpeg build (see audioCodec.ts). */
  encoder: 'libfdk_aac' | 'libopus';
  /** HomeKit's negotiated sample rate, in Hz (it reports kHz; the delegate multiplies). */
  sampleRateHz: number;
  bitrateKbps: number;
  /** RTP payload type HomeKit negotiated for audio. */
  payloadType: number;
  ssrc: number;
  /** Base64 of the AUDIO master key + salt — distinct from the video stream's. */
  srtpParams: string;
  /** HomeKit's audio port on the phone, and the port we advertised for its RTCP. */
  port: number;
  localRtcpPort?: number;
  /** Frame duration HomeKit asked for, in ms. */
  packetTimeMs?: number;
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
  /**
   * Emit `-fpsmax` to cap the frame rate. False for an ffmpeg that predates it (< 5.1), where the
   * flag is a hard error; the source's own rate then passes through, which is the desired result
   * for every Protect camera anyway. See ffmpegFeatures.ts.
   */
  capFps?: boolean;
  /** Present only when camera audio is enabled AND this ffmpeg can encode a HomeKit codec. */
  audio?: AudioArgsOptions;
}

/** Give up on a silent RTSP source after this long (ffmpeg wants microseconds). */
const RTSP_IO_TIMEOUT_US = 10_000_000;

/** RTP payload size for the audio stream. HomeKit expects small audio packets. */
const AUDIO_PKT_SIZE = 188;

/**
 * Frame durations libopus will accept, in ms. HomeKit's `packet_time` is NOT drawn from this set —
 * it commonly asks for 30ms, which libopus rejects outright ("Invalid frame duration: 30"), and
 * that failure kills the whole ffmpeg process, taking the video stream down with the audio.
 */
const OPUS_FRAME_DURATIONS = [2.5, 5, 10, 20, 40, 60];

/**
 * Snap HomeKit's requested packet time to a duration libopus supports, never rounding UP: a
 * longer frame than requested would add latency HomeKit did not budget for.
 */
export function opusFrameDuration(requestedMs: number | undefined): number {
  const wanted = requestedMs ?? 20;
  const allowed = OPUS_FRAME_DURATIONS.filter((d) => d <= wanted);
  return allowed.length ? Math.max(...allowed) : OPUS_FRAME_DURATIONS[0]!;
}

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
 * Audio is emitted as a SECOND SRTP output when `o.audio` is present, with its own port, SSRC
 * and SRTP keys — HomeKit treats the two streams as independent. Audio only works if all three
 * of these ship together: the codec declared in `streamingOptions.audio`, an `audio` block in the
 * PrepareStreamResponse, and this output. Declaring a codec and then sending no packets makes iOS
 * wait for audio and refuse to render the VIDEO too, so `o.audio` must be absent unless the other
 * two are also in place.
 */
export function buildVideoArgs(o: VideoArgsOptions): string[] {
  const args = [
    // Drop the version/configuration banner — pure noise that dwarfs the useful diagnostics.
    '-hide_banner',
    // The delegate spawns ffmpeg with stdin ignored, which hands it an immediate EOF. The
    // bundled build tolerates that (verified against real hardware), but ffmpeg reads stdin for
    // keyboard control by default and users may be on any system build, so say so explicitly
    // rather than rely on every build behaving the same way.
    '-nostdin',
    // Confine the input to RTSP(S) and its transports, so a bad URL can't reach other demuxers.
    '-protocol_whitelist', 'rtsp,rtsps,tls,tcp,udp,crypto',
    '-rtsp_transport', 'tcp',
    // Don't block forever if the camera stops responding mid-stream: time out so ffmpeg exits
    // and the session is torn down (and HomeKit told) instead of showing a frozen frame.
    // NOTE: `-timeout`, not `-rw_timeout` — the latter is a protocol-level option the RTSP
    // demuxer rejects outright ("Option not found"), which fails every stream. Verified live.
    '-timeout', String(RTSP_IO_TIMEOUT_US),
    '-i', o.rtspsUrl,
    // Never carry subtitle or data streams through; they have no HomeKit representation.
    '-sn', '-dn',
  ];

  // Video output. `-map` becomes necessary once there is a second output: without it ffmpeg's
  // default stream selection would put the camera's audio track into the video output too.
  args.push('-map', '0:v:0');
  if (!o.audio) {
    args.push('-an'); // video-only: drop the source's audio rather than transcode it for nothing
  }

  args.push(
    '-codec:v', o.encoder ?? 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'mpeg',
    // `-fpsmax`, NOT `-r`. HomeKit's fps is a MAXIMUM, and `-r` treats it as a target: against a
    // 24fps camera it duplicates frames to reach 30 (observed live: `dup` climbing steadily, ~6
    // duplicates a second). That costs 25% more encoding work than the source contains AND makes
    // motion judder, because the duplicates land at irregular intervals. Capping instead passes
    // the source's own cadence through untouched and only intervenes if a camera exceeds the rate.
    // HomeKit's fps is a MAXIMUM, and `-r` treats it as a target: on a 24fps camera ffmpeg
    // duplicated six frames a second to reach 30, which wasted a quarter of the encoding work and
    // made motion judder because the duplicates landed at irregular intervals.
    ...(o.capFps === false ? [] : ['-fpsmax', String(o.fps)]),
    // `superfast`, NOT `ultrafast`: ultrafast hard-disables CABAC/8x8dct and forces a
    // Constrained Baseline stream regardless of `-profile:v`, so it cannot satisfy the High
    // profile HomeKit negotiates.
    //
    // Software encoding is deliberate, not a fallback. Hardware encoding was measured on Apple
    // Silicon against a real 20s camera clip, transcoding flat out to 720p:
    //
    //   libx264 -preset superfast   25.3x realtime   5.83 CPU-seconds
    //   h264_videotoolbox           11.2x realtime   3.84 CPU-seconds
    //   h264_videotoolbox -realtime  4.8x realtime   4.16 CPU-seconds
    //
    // libx264 is more than twice as fast in throughput and needs ~0.29 of one core to sustain a
    // live stream, against ~0.19 for VideoToolbox — a saving too small to justify an encoder whose
    // bitstream has never been shown to render on iOS, given how much time a non-rendering stream
    // has cost this project before. 25x headroom means CPU is not the constraint.
    '-preset', 'superfast',
    // Deliberately NOT `-tune zerolatency`. It enables x264 sliced-threads (one slice-NAL per CPU
    // core per frame) and iOS silently refuses to display the result — the cause of a long-running
    // "stream never renders" bug, bisected flag by flag. The part worth keeping from it is "no
    // B-frames" (reordering makes iOS show only keyframes, an ~8s stutter), so set that directly.
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

  if (o.audio) {
    const a = o.audio;
    const audioRtcp = a.localRtcpPort ? `localrtcpport=${a.localRtcpPort}&` : '';
    args.push(
      // `0:a:0?` — the trailing question mark makes the mapping OPTIONAL. Some Protect cameras
      // publish no audio track at all, and a non-optional map would make ffmpeg exit immediately,
      // taking the video stream down with it over a missing microphone.
      '-map', '0:a:0?',
      // Keep the audio timeline monotonic. The RTSP source occasionally hands ffmpeg a packet
      // whose timestamp precedes the previous one — measured on an HEVC camera, 2 of 5 stream
      // starts produced "Queue input is backward in time" and "Non-monotonic DTS", which the
      // muxer papers over by rewriting the timestamp. `async=1` lets the resampler fill or trim
      // to realign instead, which eliminated it across every run at no cost in audio packets.
      //
      // Deliberately NOT `first_pts=0`: forcing the audio stream to start at zero while video
      // keeps its own timestamps would introduce a lip-sync offset to fix a warning.
      '-filter:a', 'aresample=async=1',
      '-codec:a', a.encoder,
      '-ac', '1', // HomeKit camera audio is mono
      '-ar', String(a.sampleRateHz),
      '-b:a', `${a.bitrateKbps}k`,
    );
    if (a.encoder === 'libfdk_aac') {
      // AAC-ELD is a distinct profile, not just AAC at low latency; iOS negotiates it by name.
      args.push('-profile:a', 'aac_eld');
    } else {
      // Opus fallback: ask for the low-delay mode and match HomeKit's requested frame duration,
      // or the decoder and encoder disagree about packet boundaries.
      args.push('-application', 'lowdelay', '-frame_duration', String(opusFrameDuration(a.packetTimeMs)));
    }
    args.push(
      '-payload_type', String(a.payloadType),
      '-ssrc', String(a.ssrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', a.srtpParams,
      `srtp://${o.address}:${a.port}?${audioRtcp}rtcpport=${a.port}&pkt_size=${AUDIO_PKT_SIZE}`,
    );
  }
  return args;
}
