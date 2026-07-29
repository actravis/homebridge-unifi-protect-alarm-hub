// Which optional ffmpeg flags does THIS build understand?
//
// The plugin normally runs the bundled ffmpeg-for-homebridge binary, but that is an
// optionalDependency: on an unsupported platform, or after `npm install --omit=optional`, it falls
// back to whatever `ffmpeg` is on PATH. That could be years old.
//
// `-fpsmax` matters and was only added in ffmpeg 5.1. Debian 11 and Ubuntu 20.04 — both still
// common Homebridge hosts — ship 4.x, where an unknown option is a hard error, so every live stream
// would fail with nothing to indicate why. Probed rather than assumed, because the fallback
// (omitting the flag) is perfectly serviceable: without it the source's own frame rate passes
// through untouched, which is what we want anyway for a 24 or 30fps camera.

import { spawn } from 'node:child_process';

/** Runs ffmpeg and resolves true if it exited cleanly. Injectable for tests. */
export type EncodeProbe = (ffmpegPath: string, args: string[]) => Promise<boolean>;

export const REAL_PROBE: EncodeProbe = (ffmpegPath, args) =>
  new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });

/**
 * Argv that succeeds only if `-fpsmax` is understood: encode a few generated frames and discard
 * them. Nothing touches the network, and it takes a fraction of a second.
 */
export function buildFpsMaxProbeArgs(): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30',
    '-frames:v', '5',
    '-codec:v', 'libx264', '-preset', 'ultrafast',
    '-fpsmax', '30',
    '-f', 'null', '-',
  ];
}

/** Cached per ffmpeg path: a binary's option set cannot change while we run. */
const cache = new Map<string, Promise<boolean>>();

export function supportsFpsMax(ffmpegPath: string, probe: EncodeProbe = REAL_PROBE): Promise<boolean> {
  let pending = cache.get(ffmpegPath);
  if (!pending) {
    // A probe that fails for any reason resolves false: omitting the flag degrades gracefully,
    // whereas passing an unsupported one loses the stream entirely.
    pending = probe(ffmpegPath, buildFpsMaxProbeArgs()).catch(() => false);
    cache.set(ffmpegPath, pending);
  }
  return pending;
}

/** Test seam: forget probe results so a test can vary the outcome. */
export function resetFeatureCache(): void {
  cache.clear();
}
