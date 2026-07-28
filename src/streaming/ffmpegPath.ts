/**
 * Resolve the ffmpeg binary to use: prefer the bundled `ffmpeg-for-homebridge` binary (an
 * optional dependency), falling back to `ffmpeg` on PATH. Returns 'ffmpeg' if the optional
 * package isn't installed or has no binary for this platform.
 */
export function resolveFfmpegPath(): string {
  try {
    // Optional dependency — guarded require so a missing/opted-out install degrades gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod: unknown = require('ffmpeg-for-homebridge');
    const path = typeof mod === 'string' ? mod : (mod as { default?: string } | null)?.default;
    if (path) {
      return path;
    }
  } catch {
    /* not installed — fall back to system ffmpeg */
  }
  return 'ffmpeg';
}
