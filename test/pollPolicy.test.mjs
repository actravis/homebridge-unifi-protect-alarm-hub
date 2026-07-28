// Poll-cadence policy: how often we hit /alarm-hubs, and how the realtime feed changes that.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLL_SECONDS,
  MIN_POLL_SECONDS,
  REALTIME_POLL_SECONDS,
  basePollSeconds,
  effectivePollSeconds,
} from '../dist/pollPolicy.js';

test('basePollSeconds honours a valid interval', () => {
  assert.equal(basePollSeconds(30), 30);
  assert.equal(basePollSeconds('45'), 45);
});

test('basePollSeconds falls back to the default for blank or invalid input', () => {
  for (const raw of [undefined, null, '', 'abc', NaN, 0, -5]) {
    assert.equal(basePollSeconds(raw), DEFAULT_POLL_SECONDS, `input ${String(raw)}`);
  }
});

test('basePollSeconds clamps a too-fast interval to the floor', () => {
  assert.equal(basePollSeconds(1), MIN_POLL_SECONDS);
});

test('a healthy realtime feed backs the poll off to the safety-net cadence', () => {
  assert.equal(effectivePollSeconds(10, true), REALTIME_POLL_SECONDS);
  assert.equal(effectivePollSeconds(10, false), 10);
});

test('backing off never speeds up a deliberately slower configured interval', () => {
  assert.equal(effectivePollSeconds(300, true), 300);
  assert.equal(effectivePollSeconds(300, false), 300);
});
