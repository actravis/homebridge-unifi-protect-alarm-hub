import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAccessories } from '../dist/discovery.js';

const hub = (alarmHub = {}) => ({ id: 'h', modelKey: 'linkstation', name: 'Hub', alarmHub });
const ofKind = (plan, kind) => plan.accessories.filter((a) => a.kind === kind);

test('a bare hub plans security + hub + emergency by default', () => {
  const { accessories } = planAccessories(hub(), {});
  assert.deepEqual(accessories.map((a) => a.kind).sort(), ['emergency', 'hub', 'security']);
});

test('an enabled ENTRY channel becomes a named contact zone with a stable key', () => {
  const plan = planAccessories(hub({ input: { 3: { enable: 'on', inputType: 'ENTRY', name: 'Front Door' } } }), {});
  const z = ofKind(plan, 'zone')[0];
  assert.equal(z.name, 'Front Door');
  assert.equal(z.zoneKind, 'contact');
  assert.equal(z.channel, '3');
  assert.equal(z.key, 'zone:3:contact');
});

test('disabled or untyped channels are not planned (prune-on-disable)', () => {
  const plan = planAccessories(hub({ input: { 1: { enable: 'off', inputType: 'ENTRY' }, 2: { enable: 'on' } } }), {});
  assert.equal(ofKind(plan, 'zone').length, 0);
});

test('GLASS_BREAK maps to motion by default, contact when configured', () => {
  const kindOf = (cfg) =>
    ofKind(planAccessories(hub({ input: { 4: { enable: 'on', inputType: 'GLASS_BREAK', name: 'GB' } } }), cfg), 'zone')[0].zoneKind;
  assert.equal(kindOf({}), 'motion');
  assert.equal(kindOf({ glassBreakAs: 'contact' }), 'contact');
});

test('an unknown input type is planned as contact and reported in unknownTypes', () => {
  const plan = planAccessories(hub({ input: { 7: { enable: 'on', inputType: 'FUTURE_TYPE' } } }), {});
  assert.equal(ofKind(plan, 'zone')[0].zoneKind, 'contact');
  assert.deepEqual(plan.unknownTypes, ['FUTURE_TYPE']);
});

test('an unnamed zone falls back to "<type> <1-indexed channel>"', () => {
  const plan = planAccessories(hub({ input: { 0: { enable: 'on', inputType: 'ENTRY' } } }), {});
  assert.equal(ofKind(plan, 'zone')[0].name, 'ENTRY 1');
});

test('enabled outputs are planned unless exposeOutputs is false', () => {
  const on = planAccessories(hub({ output: { 0: { enable: 'on', name: 'Beeper' } } }), {});
  assert.equal(ofKind(on, 'output').length, 1);
  assert.equal(ofKind(on, 'output')[0].name, 'Beeper');
  const off = planAccessories(hub({ output: { 0: { enable: 'on' } } }), { exposeOutputs: false });
  assert.equal(ofKind(off, 'output').length, 0);
});

test('disabled outputs are not planned; unnamed outputs get a 1-indexed fallback', () => {
  assert.equal(ofKind(planAccessories(hub({ output: { 1: { enable: 'off' } } }), {}), 'output').length, 0);
  const plan = planAccessories(hub({ output: { 1: { enable: 'on' } } }), {});
  assert.equal(ofKind(plan, 'output')[0].name, 'Output 2');
});

test('emergency input is omitted when exposeEmergencyInput is false', () => {
  assert.equal(ofKind(planAccessories(hub(), { exposeEmergencyInput: false }), 'emergency').length, 0);
});

test('securityName overrides the default tile name', () => {
  assert.equal(ofKind(planAccessories(hub(), { securityName: 'Alarm' }), 'security')[0].name, 'Alarm');
});
