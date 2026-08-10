// Doorbell screen messages. Pure logic, so no console needed — but every rule encoded here was
// established by probing a real G4 Doorbell Pro, including the several ways of clearing the screen
// that do NOT work (see the module comment).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRESET_MESSAGES, activeMessageKey, clearMessagePatch, messageKey, planDoorbellMessages,
  setMessagePatch,
} from '../dist/doorbellMessages.js';

const keys = (plans) => plans.map((p) => p.key);
const on = { exposeDoorbellMessages: true };

// --- planning ----------------------------------------------------------------

test('no switches unless explicitly enabled', () => {
  assert.deepEqual(planDoorbellMessages({}), []);
  assert.deepEqual(planDoorbellMessages({ exposeDoorbellMessages: false, doorbellMessages: ['Hi'] }), []);
});

test('enabling offers both Protect presets', () => {
  assert.deepEqual(keys(planDoorbellMessages(on)), ['LEAVE_PACKAGE_AT_DOOR', 'DO_NOT_DISTURB']);
  assert.deepEqual(PRESET_MESSAGES.map((p) => p.id), ['LEAVE_PACKAGE_AT_DOOR', 'DO_NOT_DISTURB']);
});

test('custom texts are added alongside the presets', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['Be right there', 'Go away'] });
  assert.deepEqual(keys(plans).slice(2), ['custom:Be right there', 'custom:Go away']);
  assert.equal(plans[2].type, 'CUSTOM_MESSAGE');
  assert.equal(plans[2].text, 'Be right there');
});

// The config is user input. An empty text returns 200 from the console and changes nothing, so a
// switch for it would look functional and silently do nothing.
test('blank, whitespace and non-string entries are dropped', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['', '   ', 42, null, {}, 'Real'] });
  assert.deepEqual(keys(plans).slice(2), ['custom:Real']);
});

test('surrounding whitespace is trimmed', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['  Padded  '] });
  assert.equal(plans[2].text, 'Padded');
});

// Two switches for one message would fight over a single screen.
test('duplicates are dropped, case-insensitively, including against presets', () => {
  const plans = planDoorbellMessages({
    ...on,
    doorbellMessages: ['Hello', 'HELLO', 'hello ', 'Do Not Disturb'],
  });
  assert.deepEqual(keys(plans).slice(2), ['custom:Hello']);
});

test('a non-array doorbellMessages value is ignored rather than throwing', () => {
  assert.deepEqual(keys(planDoorbellMessages({ ...on, doorbellMessages: 'Hello' })), keys(planDoorbellMessages(on)));
});

test('the accessory key is stable and namespaced per device', () => {
  assert.equal(messageKey('cam1', 'DO_NOT_DISTURB'), 'cam1:message:DO_NOT_DISTURB');
  assert.notEqual(messageKey('cam1', 'a'), messageKey('cam2', 'a'));
});

// --- setting -----------------------------------------------------------------

test('a preset is sent as a bare type — Protect supplies its own wording', () => {
  const [preset] = planDoorbellMessages(on);
  assert.deepEqual(setMessagePatch(preset), {
    lcdMessage: { type: 'LEAVE_PACKAGE_AT_DOOR', resetAt: null },
  });
});

test('a custom message sends type and text', () => {
  const plan = planDoorbellMessages({ ...on, doorbellMessages: ['Back soon'] })[2];
  assert.deepEqual(setMessagePatch(plan), {
    lcdMessage: { type: 'CUSTOM_MESSAGE', text: 'Back soon', resetAt: null },
  });
});

// Without an explicit null the console stamps its own resetAt and the message later clears itself,
// stranding the HomeKit switch in the on position. Measured on real hardware.
test('every set is permanent: resetAt is explicitly null', () => {
  for (const plan of planDoorbellMessages({ ...on, doorbellMessages: ['Back soon'] })) {
    assert.equal(setMessagePatch(plan).lcdMessage.resetAt, null, `${plan.key} must be permanent`);
  }
});

// --- clearing ----------------------------------------------------------------
// A past resetAt is the ONLY mechanism that clears the screen; {} and type:'NONE' are both HTTP 500,
// and an empty text is accepted but ignored.

test('clearing sends a resetAt in the past', () => {
  const now = 1_000_000_000_000;
  const patch = clearMessagePatch({ type: 'CUSTOM_MESSAGE', text: 'Hi' }, now);
  assert.ok(patch.lcdMessage.resetAt < now, 'resetAt must be in the past to clear');
  assert.equal(patch.lcdMessage.type, 'CUSTOM_MESSAGE');
  assert.equal(patch.lcdMessage.text, 'Hi', 'type and text must still be present or validation fails');
});

test('clearing a preset keeps its type and omits text', () => {
  const patch = clearMessagePatch({ type: 'DO_NOT_DISTURB' }, 1_000);
  assert.equal(patch.lcdMessage.type, 'DO_NOT_DISTURB');
  assert.ok(!('text' in patch.lcdMessage));
});

// The field is required, so clearing an already-blank screen still needs a type.
test('clearing an already-blank screen still sends a valid body', () => {
  for (const current of [undefined, {}]) {
    const patch = clearMessagePatch(current, 5_000);
    assert.ok(patch.lcdMessage.type, 'a type is mandatory');
    assert.ok(patch.lcdMessage.resetAt < 5_000);
  }
});

// --- reflecting what the console shows ---------------------------------------

test('a blank screen means no switch is on', () => {
  const plans = planDoorbellMessages(on);
  assert.equal(activeMessageKey(plans, undefined), undefined);
  assert.equal(activeMessageKey(plans, {}), undefined);
});

// Protect echoes its own wording for a preset, so presets must match on type, not text.
test('a preset is recognised from its type despite Protect rewording the text', () => {
  const plans = planDoorbellMessages(on);
  const live = { type: 'LEAVE_PACKAGE_AT_DOOR', text: 'LEAVE PACKAGE AT DOOR', resetAt: null };
  assert.equal(activeMessageKey(plans, live), 'LEAVE_PACKAGE_AT_DOOR');
});

test('a custom message is recognised from its text, case- and space-insensitively', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['Be right there'] });
  assert.equal(activeMessageKey(plans, { type: 'CUSTOM_MESSAGE', text: 'be right there' }), 'custom:Be right there');
  assert.equal(activeMessageKey(plans, { type: 'CUSTOM_MESSAGE', text: ' Be Right There ' }), 'custom:Be right there');
});

// Someone may set a message in the Protect app that we do not offer a switch for; no switch should
// claim to be it.
test('a message set outside HomeKit that we do not offer matches nothing', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['Known'] });
  assert.equal(activeMessageKey(plans, { type: 'CUSTOM_MESSAGE', text: 'Set in the app' }), undefined);
  assert.equal(activeMessageKey(plans, { type: 'SOME_FUTURE_PRESET' }), undefined);
});

test('a custom message with no text matches nothing rather than the first custom switch', () => {
  const plans = planDoorbellMessages({ ...on, doorbellMessages: ['Known'] });
  assert.equal(activeMessageKey(plans, { type: 'CUSTOM_MESSAGE' }), undefined);
});
