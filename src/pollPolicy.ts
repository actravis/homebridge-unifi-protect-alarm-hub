// Pure poll-cadence policy. Extracted so the "how often do we hit /alarm-hubs" decision is
// unit-testable and lives in one place; the platform just applies whatever this returns.

/** Fallback cadence when the realtime feed is unavailable (seconds). */
export const DEFAULT_POLL_SECONDS = 10;

/** Never poll faster than this, whatever the config says — the console rate-limits at ~10 req/s. */
export const MIN_POLL_SECONDS = 2;

/**
 * Cadence while the realtime device feed is connected.
 *
 * With the socket up, every alarm-hub change already arrives as a push, so the poll is only a
 * safety net for a push we somehow missed. At the 10s default it was ~8,600 redundant requests
 * a day against a console that rate-limits at ~10 req/s; a minute is plenty for a backstop.
 */
export const REALTIME_POLL_SECONDS = 60;

/** Parse the configured interval, coercing blank/invalid values to the default and clamping. */
export function basePollSeconds(raw: unknown): number {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(MIN_POLL_SECONDS, seconds) : DEFAULT_POLL_SECONDS;
}

/**
 * The interval to actually use. Backing off while realtime is healthy never *speeds up* a
 * deliberately slow configured interval — a user who asked for 5-minute polling keeps it.
 */
export function effectivePollSeconds(base: number, realtimeConnected: boolean): number {
  return realtimeConnected ? Math.max(base, REALTIME_POLL_SECONDS) : base;
}
