// Pure timing/backoff helpers for the Protect client.
//
// These are deliberately free of any I/O, clock, or randomness-by-default so the
// console's rate-limit behaviour can be unit-tested to the millisecond. The client
// wires them to the real clock and `Math.random`; tests pass a fixed `rand` and
// known timestamps.

/** Upper bound on any single retry wait — stops a bogus server hint from stalling us for hours. */
export const MAX_RETRY_DELAY_MS = 60_000;

/** Exponential backoff: 1s base, doubling each attempt (0-based), capped at `capMs`. */
export function exponentialBackoff(attempt: number, capMs: number): number {
  return Math.min(1000 * 2 ** attempt, capMs);
}

/** A random spread in `[0, maxMs)`, added to delays so retries/reconnects don't synchronise. */
export function jitter(maxMs: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * maxMs);
}

/**
 * How long to wait before retrying a failed request. Every path gets jitter so retries
 * don't synchronise.
 *
 * For HTTP 429 (rate limited) we honour the server's own window so we wait exactly as long
 * as it asks — preferring the `Retry-After` header (seconds), then the body's `windowMs`.
 * Everything else (5xx, and 429s with no server hint) uses exponential backoff.
 */
export function computeRetryDelay(opts: {
  status: number;
  /** Parsed `Retry-After` header value, in seconds, if it was numeric. */
  retryAfterSeconds?: number;
  /** `windowMs` from the 429 response body, if present. */
  windowMs?: number;
  attempt: number;
  rand?: () => number;
}): number {
  const spread = jitter(250, opts.rand);
  if (opts.status === 429) {
    // Honour the server's window, but never let a bogus value stall us for hours.
    if (opts.retryAfterSeconds && opts.retryAfterSeconds > 0) {
      return Math.min(opts.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS) + spread;
    }
    if (opts.windowMs && opts.windowMs > 0) {
      return Math.min(opts.windowMs, MAX_RETRY_DELAY_MS) + spread;
    }
  }
  return exponentialBackoff(opts.attempt, 8000) + spread;
}

/** Reconnect backoff for a realtime WebSocket: exponential capped at 30s, plus jitter. */
export function reconnectDelay(attempt: number, rand: () => number = Math.random): number {
  return exponentialBackoff(attempt, 30_000) + jitter(250, rand);
}

/**
 * Reserve the next slot in a rate-limited schedule (used for both the ~10 req/s REST limit
 * and the "no two WebSocket opens in the same tick" rule).
 *
 * Given the earliest time the next action is allowed (`nextAt`), the current time (`now`),
 * and the minimum gap between actions, returns how long the caller should wait and the new
 * `nextAt` value to store. Consecutive callers are spaced `gapMs` apart; after an idle
 * period `nextAt` is in the past, so `waitMs` is 0 and no "debt" accumulates.
 */
export function reserveSlot(
  nextAt: number,
  now: number,
  gapMs: number,
): { waitMs: number; nextAt: number } {
  const waitMs = Math.max(0, nextAt - now);
  return { waitMs, nextAt: Math.max(now, nextAt) + gapMs };
}
