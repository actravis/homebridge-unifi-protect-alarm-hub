// Pure chime planning. The load-bearing property: a chime yields NO accessory unless at least one
// control is actually usable. A ring button with no Trigger ID cannot ring (the API has no ring
// endpoint), and it would fail silently inside an automation while looking fine in the Home app.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CHIME_VOLUME, chimeKey, isChimeMuted, loudestVolume, planChimeAccessories, settingsAtVolume,
} from '../dist/chimeDiscovery.js';

// A syntactically valid but fake UUID — never the real console's Trigger ID.
const TRIGGER = '11111111-2222-3333-4444-555555555555';
const setting = (over = {}) => ({ cameraId: 'cam-1', volume: 80, ringtoneId: 'ring-1', repeatTimes: 2, ...over });
const chime = (over = {}) => ({
  id: 'c1', modelKey: 'chime', name: 'Doorbell Chime', state: 'CONNECTED', ringSettings: [setting()], ...over,
});
const ring = { chimeTriggerId: TRIGGER };
const mute = { exposeChimeMute: true };

test('the accessory key is stable and namespaced to the device', () => {
  assert.equal(chimeKey('abc'), 'abc:chime');
  assert.notEqual(chimeKey('abc'), chimeKey('abcd'));
});

// --- what gets planned -------------------------------------------------------

test('a Trigger ID alone plans a ring button and no mute switch', () => {
  const [p] = planChimeAccessories([chime()], ring);
  assert.equal(p.triggerId, TRIGGER);
  assert.equal(p.mutable, false);
});

test('the mute switch alone plans a mute and no ring button', () => {
  const [p] = planChimeAccessories([chime()], mute);
  assert.equal(p.triggerId, undefined);
  assert.equal(p.mutable, true);
});

test('both controls can be enabled together', () => {
  const [p] = planChimeAccessories([chime()], { ...ring, ...mute });
  assert.equal(p.triggerId, TRIGGER);
  assert.equal(p.mutable, true);
});

test('neither control enabled means no accessory at all', () => {
  assert.deepEqual(planChimeAccessories([chime()], {}), []);
  assert.deepEqual(planChimeAccessories([chime()], { exposeChimeMute: false }), []);
});

// Homebridge's config UI leaves a cleared text field as "" or whitespace rather than removing it.
test('a blank or whitespace Trigger ID counts as unconfigured', () => {
  assert.deepEqual(planChimeAccessories([chime()], { chimeTriggerId: '' }), []);
  assert.deepEqual(planChimeAccessories([chime()], { chimeTriggerId: '   ' }), []);
});

test('a Trigger ID is trimmed, so a pasted value with stray whitespace still works', () => {
  assert.equal(planChimeAccessories([chime()], { chimeTriggerId: `  ${TRIGGER}\n` })[0].triggerId, TRIGGER);
});

test('exposeChimes:false wins over both controls', () => {
  assert.deepEqual(planChimeAccessories([chime()], { ...ring, ...mute, exposeChimes: false }), []);
});

test('a disconnected chime is planned but marked offline', () => {
  assert.equal(planChimeAccessories([chime({ state: 'DISCONNECTED' })], ring)[0].online, false);
});

test('a chime with no state is assumed online', () => {
  assert.equal(planChimeAccessories([chime({ state: undefined })], ring)[0].online, true);
});

test('a nameless chime gets a fallback name', () => {
  assert.equal(planChimeAccessories([chime({ name: undefined })], ring)[0].name, 'Chime');
});

test('several chimes all share the one configured trigger', () => {
  const plans = planChimeAccessories([chime(), chime({ id: 'c2', name: 'Hallway' })], ring);
  assert.deepEqual(plans.map((p) => p.name), ['Doorbell Chime', 'Hallway']);
  assert.ok(plans.every((p) => p.triggerId === TRIGGER));
});

test('no chimes on the console yields no accessories', () => {
  assert.deepEqual(planChimeAccessories([], ring), []);
});

test('the plan carries ring settings through verbatim', () => {
  assert.deepEqual(planChimeAccessories([chime()], mute)[0].ringSettings, [setting()]);
  assert.equal(planChimeAccessories([chime()], mute)[0].pairedCameras, 1);
});

test('a chime with no ringSettings is planned with an empty array, not undefined', () => {
  const [p] = planChimeAccessories([chime({ ringSettings: undefined })], mute);
  assert.deepEqual(p.ringSettings, []);
  assert.equal(p.pairedCameras, 0);
});

// --- volume arithmetic -------------------------------------------------------

test('muted means every paired camera is silent', () => {
  assert.equal(isChimeMuted([setting({ volume: 0 })]), true);
  assert.equal(isChimeMuted([setting({ volume: 0 }), setting({ cameraId: 'b', volume: 50 })]), false);
});

// An unpaired chime has nothing to silence; reporting it muted would imply the user had done so.
test('a chime with no ring settings is not considered muted', () => {
  assert.equal(isChimeMuted([]), false);
  assert.equal(isChimeMuted(undefined), false);
});

test('a missing volume field counts as silent', () => {
  assert.equal(isChimeMuted([{ cameraId: 'a' }]), true);
});

test('the restore level is the loudest configured, so it comes back audible everywhere', () => {
  assert.equal(loudestVolume([setting({ volume: 30 }), setting({ cameraId: 'b', volume: 70 })]), 70);
});

test('an already-silent chime falls back to a default, so unmute still makes noise', () => {
  assert.equal(loudestVolume([setting({ volume: 0 })]), DEFAULT_CHIME_VOLUME);
  assert.equal(loudestVolume([]), DEFAULT_CHIME_VOLUME);
  assert.equal(loudestVolume(undefined), DEFAULT_CHIME_VOLUME);
});

// The PATCH replaces the whole array, so anything dropped here is silently reset on the console.
test('setting a volume preserves ringtone, repeat count and camera id', () => {
  assert.deepEqual(settingsAtVolume([setting()], 0), [
    { cameraId: 'cam-1', volume: 0, ringtoneId: 'ring-1', repeatTimes: 2 },
  ]);
});

test('volumes are clamped to 0-100 and rounded', () => {
  assert.equal(settingsAtVolume([setting()], 250)[0].volume, 100);
  assert.equal(settingsAtVolume([setting()], -5)[0].volume, 0);
  assert.equal(settingsAtVolume([setting()], 62.6)[0].volume, 63);
});

test('setting a volume on an empty list is a no-op, not a crash', () => {
  assert.deepEqual(settingsAtVolume(undefined, 50), []);
});
