import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeRetryDelay,
  exponentialBackoff,
  jitter,
  reconnectDelay,
  reserveSlot,
} from '../dist/client/timing.js';

const ZERO = () => 0;

test('exponentialBackoff doubles per attempt and respects the cap', () => {
  assert.equal(exponentialBackoff(0, 8000), 1000);
  assert.equal(exponentialBackoff(1, 8000), 2000);
  assert.equal(exponentialBackoff(3, 8000), 8000);
  assert.equal(exponentialBackoff(10, 8000), 8000); // capped
});

test('jitter stays within [0, maxMs)', () => {
  assert.equal(jitter(250, ZERO), 0);
  assert.equal(jitter(250, () => 0.999999), 249);
  for (let i = 0; i < 100; i++) {
    const j = jitter(250);
    assert.ok(j >= 0 && j < 250);
  }
});

test('computeRetryDelay uses exponential backoff for non-429, with jitter', () => {
  assert.equal(computeRetryDelay({ status: 503, attempt: 0, rand: ZERO }), 1000);
  assert.equal(computeRetryDelay({ status: 500, attempt: 2, rand: ZERO }), 4000);
  // Jitter is applied on the non-429 path too (no synchronised retries).
  assert.equal(computeRetryDelay({ status: 503, attempt: 0, rand: () => 0.5 }), 1125);
});

test('computeRetryDelay honours a 429 Retry-After header (seconds)', () => {
  assert.equal(computeRetryDelay({ status: 429, retryAfterSeconds: 2, attempt: 0, rand: ZERO }), 2000);
});

test('computeRetryDelay honours a 429 body windowMs when no header', () => {
  assert.equal(computeRetryDelay({ status: 429, windowMs: 1000, attempt: 0, rand: ZERO }), 1000);
});

test('computeRetryDelay prefers Retry-After over windowMs', () => {
  const d = computeRetryDelay({ status: 429, retryAfterSeconds: 3, windowMs: 1000, attempt: 0, rand: ZERO });
  assert.equal(d, 3000);
});

test('computeRetryDelay caps an absurd server hint at MAX_RETRY_DELAY_MS', () => {
  assert.equal(computeRetryDelay({ status: 429, retryAfterSeconds: 999999, attempt: 0, rand: ZERO }), 60000);
  assert.equal(computeRetryDelay({ status: 429, windowMs: 10 * 60_000, attempt: 0, rand: ZERO }), 60000);
});

test('computeRetryDelay falls back to exponential for a 429 with no hints, plus jitter', () => {
  assert.equal(computeRetryDelay({ status: 429, attempt: 1, rand: ZERO }), 2000);
  assert.equal(computeRetryDelay({ status: 429, attempt: 1, rand: () => 0.5 }), 2125); // +floor(0.5*250)
});

test('reconnectDelay grows exponentially, caps at 30s, and adds jitter', () => {
  assert.equal(reconnectDelay(0, ZERO), 1000);
  assert.equal(reconnectDelay(10, ZERO), 30000); // capped
  assert.equal(reconnectDelay(0, () => 0.5), 1125);
});

test('reserveSlot: first caller waits 0 and advances the cursor by the gap', () => {
  const { waitMs, nextAt } = reserveSlot(0, 1000, 120);
  assert.equal(waitMs, 0);
  assert.equal(nextAt, 1120);
});

test('reserveSlot: a second caller at the same instant is spaced by the gap', () => {
  const first = reserveSlot(0, 1000, 120);
  const second = reserveSlot(first.nextAt, 1000, 120);
  assert.equal(second.waitMs, 120);
  assert.equal(second.nextAt, 1240);
});

test('reserveSlot: no debt accrues after an idle period', () => {
  // nextAt is far in the past relative to now → wait 0, cursor re-based on now.
  const { waitMs, nextAt } = reserveSlot(500, 2000, 120);
  assert.equal(waitMs, 0);
  assert.equal(nextAt, 2120);
});
