// Which audio codec can this ffmpeg actually produce, and what do we advertise to HomeKit?
//
// This is probed FUNCTIONALLY — by asking ffmpeg to encode a fraction of a second of silence —
// rather than by reading `ffmpeg -encoders`. Listing the encoder proves nothing: the bundled
// ffmpeg-for-homebridge build lists `libfdk_aac`, yet AAC-ELD fails to initialise on it at every
// sample rate and bitrate ("Transport library initialization error" from FDK's LATM layer, which
// ELD requires). A presence check would therefore have advertised AAC-ELD and then delivered
// nothing — and an advertised-but-silent audio stream makes iOS refuse to render the VIDEO too,
// so the cost of guessing wrong here is losing live view entirely.
//
// Probing costs one short ffmpeg run per candidate, once per process.

import { spawn } from 'node:child_process';

export interface AudioCodecChoice {
  /** ffmpeg `-codec:a` value. */
  encoder: 'libfdk_aac' | 'libopus';
  /** HAP AudioStreamingCodecType value. */
  hapCodec: 'AAC-eld' | 'OPUS';
}

/**
 * Candidates in preference order. AAC-ELD is what iOS natively negotiates for cameras, so it is
 * tried first even though the bundled build cannot do it — a user on a full ffmpeg build gets the
 * better codec automatically.
 *
 * `encoderArgs` are the settings the probe must prove, and deliberately mirror what
 * `buildVideoArgs` emits: probing a configuration we don't actually use would prove nothing.
 */
export const AUDIO_CANDIDATES: (AudioCodecChoice & { encoderArgs: string[] })[] = [
  {
    encoder: 'libfdk_aac',
    hapCodec: 'AAC-eld',
    encoderArgs: ['-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-ac', '1', '-ar', '24000', '-b:a', '24k'],
  },
  {
    encoder: 'libopus',
    hapCodec: 'OPUS',
    // 20ms is the frame duration `opusFrameDuration` snaps to for HomeKit's usual 30ms request.
    encoderArgs: [
      '-codec:a', 'libopus', '-application', 'lowdelay', '-frame_duration', '20',
      '-ac', '1', '-ar', '24000', '-b:a', '24k',
    ],
  },
];

/**
 * Full argv for a probe: encode 0.2s of generated silence and throw it away. No camera, no
 * network, no output file — the only question is whether the encoder opens.
 */
export function buildProbeArgs(encoderArgs: string[]): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
    '-t', '0.2',
    ...encoderArgs,
    '-f', 'null', '-',
  ];
}

/** Runs ffmpeg with the given args and resolves true if it exited cleanly. Injectable for tests. */
export type EncodeProbe = (ffmpegPath: string, args: string[]) => Promise<boolean>;

export const REAL_PROBE: EncodeProbe = (ffmpegPath, args) =>
  new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    } catch {
      return resolve(false); // ffmpeg missing entirely
    }
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });

/** Pick the first candidate this ffmpeg can actually encode, or undefined for no audio. */
export async function detectAudioCodec(ffmpegPath: string, probe: EncodeProbe): Promise<AudioCodecChoice | undefined> {
  for (const candidate of AUDIO_CANDIDATES) {
    if (await probe(ffmpegPath, buildProbeArgs(candidate.encoderArgs))) {
      return { encoder: candidate.encoder, hapCodec: candidate.hapCodec };
    }
  }
  return undefined;
}

/**
 * Cached per ffmpeg path: the answer cannot change while the process runs, and camera discovery
 * re-runs every few minutes across every camera.
 */
const cache = new Map<string, Promise<AudioCodecChoice | undefined>>();

export function probeAudioCodec(
  ffmpegPath: string,
  probe: EncodeProbe = REAL_PROBE,
): Promise<AudioCodecChoice | undefined> {
  let pending = cache.get(ffmpegPath);
  if (!pending) {
    // A failed probe resolves to undefined rather than rejecting: no audio is a degraded stream,
    // but a throw here would abort camera discovery entirely.
    pending = detectAudioCodec(ffmpegPath, probe).catch(() => undefined);
    cache.set(ffmpegPath, pending);
  }
  return pending;
}

/** Test seam: forget probe results so a test can vary the outcome. */
export function resetAudioCodecCache(): void {
  cache.clear();
}
