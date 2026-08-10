// Doorbell screen (LCD) messages: pure planning and patch building. No HAP, no I/O.
//
// A doorbell with a screen can display a message. HomeKit has no text-entry control, so each message
// is exposed as its own switch: on sets that message, off clears the screen. Only one message can be
// displayed, so turning one on implicitly turns the others off.
//
// Everything here was verified against a real G4 Doorbell Pro:
//
//   SET    PATCH /cameras/{id}  {"lcdMessage":{"type":"LEAVE_PACKAGE_AT_DOOR"}}                -> 200
//          PATCH /cameras/{id}  {"lcdMessage":{"type":"CUSTOM_MESSAGE","text":"BE RIGHT THERE"}} -> 200
//   CLEAR  PATCH /cameras/{id}  {"lcdMessage":{...,"resetAt":<a past timestamp>}}              -> 200,
//          after which the console reports `lcdMessage: {}` like a camera that never had one.
//
// Things that do NOT work, each tried:
//   - `{"lcdMessage":{}}`                     -> 500 AJV_PARSE_ERROR
//   - `{"type":"NONE"}` / `{"type":""}`       -> 500 AJV_PARSE_ERROR
//   - `{"type":"CUSTOM_MESSAGE","text":""}`   -> 200 but the screen does not change
//   - a FUTURE `resetAt` to schedule an auto-clear: the console overwrites the value with roughly
//     "now", so no duration/auto-expiry feature is offered — it would be a control that looks
//     functional and silently does nothing.
//
// And one behaviour that is easy to miss: a SET must pass `resetAt: null` explicitly. Without it the
// console stamps its own timestamp and the message later disappears on its own, leaving a HomeKit
// switch stuck on for a message that is no longer displayed.

import type { LcdMessage } from './types';

/** The two messages Protect itself defines; anything else is CUSTOM_MESSAGE with text. */
export const PRESET_MESSAGES = [
  { id: 'LEAVE_PACKAGE_AT_DOOR', label: 'Leave Package At Door' },
  { id: 'DO_NOT_DISTURB', label: 'Do Not Disturb' },
] as const;

export type PresetId = (typeof PRESET_MESSAGES)[number]['id'];

export interface MessagePlan {
  /** Stable key for the HAP service subtype and the accessory UUID seed. */
  key: string;
  /** Switch name shown in HomeKit. */
  label: string;
  /** Protect message type. */
  type: PresetId | 'CUSTOM_MESSAGE';
  /** Text for a custom message; absent for a preset (Protect supplies its own wording). */
  text?: string;
}

export interface DoorbellMessageConfig {
  /** Master toggle (default off): these are extra switches per doorbell. */
  exposeDoorbellMessages?: boolean;
  /** Custom message texts to offer, alongside the two Protect presets. */
  doorbellMessages?: unknown;
}

/**
 * Which message switches a doorbell should have.
 *
 * Returns nothing unless explicitly enabled — every entry is another tile in the user's house, and
 * most doorbells never need one. Custom entries are validated here rather than trusted: the config
 * is user input, and a blank or non-string entry would otherwise become a switch that the console
 * rejects on every press (an empty `text` returns 200 and changes nothing, which is worse).
 */
export function planDoorbellMessages(config: DoorbellMessageConfig = {}): MessagePlan[] {
  if (config.exposeDoorbellMessages !== true) {
    return [];
  }
  const plans: MessagePlan[] = PRESET_MESSAGES.map((p) => ({ key: p.id, label: p.label, type: p.id }));

  const custom = Array.isArray(config.doorbellMessages) ? config.doorbellMessages : [];
  const seen = new Set<string>(plans.map((p) => p.label.toLowerCase()));
  for (const entry of custom) {
    if (typeof entry !== 'string') {
      continue;
    }
    const text = entry.trim();
    // A duplicate would produce two switches that fight over one screen.
    if (text === '' || seen.has(text.toLowerCase())) {
      continue;
    }
    seen.add(text.toLowerCase());
    plans.push({ key: `custom:${text}`, label: text, type: 'CUSTOM_MESSAGE', text });
  }
  return plans;
}

/** Accessory-key seed for a message switch, so creation and lookup cannot drift. */
export function messageKey(deviceId: string, key: string): string {
  return `${deviceId}:message:${key}`;
}

/**
 * The patch body that displays a planned message.
 *
 * `resetAt: null` is REQUIRED, not decorative. Omit it and the console stamps its own timestamp,
 * after which the message clears itself — measured: a preset set without it was gone by the next
 * check, while the same message with `resetAt: null` stayed put. A switch that silently turns itself
 * off minutes later is worse than no switch, so every message we set is permanent until cleared.
 */
export function setMessagePatch(plan: MessagePlan): { lcdMessage: LcdMessage } {
  return {
    lcdMessage: plan.text === undefined
      ? { type: plan.type, resetAt: null }
      : { type: plan.type, text: plan.text, resetAt: null },
  };
}

/**
 * The patch body that clears the screen.
 *
 * A `resetAt` in the past is the only mechanism the API offers — see the module comment for the
 * alternatives that fail. `type` and `text` must still be present or the request fails validation,
 * so the caller passes whatever is currently displayed.
 *
 * `now` is injected so the behaviour is testable without a real clock.
 */
export function clearMessagePatch(current: LcdMessage | undefined, now: number): { lcdMessage: LcdMessage } {
  return {
    lcdMessage: {
      // Fall back to a preset when nothing is displayed: the field is required, and the past
      // `resetAt` means it is cleared rather than shown.
      type: current?.type ?? 'LEAVE_PACKAGE_AT_DOOR',
      ...(current?.text !== undefined ? { text: current.text } : {}),
      resetAt: now - 60_000,
    },
  };
}

/**
 * Which planned message the console is currently displaying, or undefined for a blank screen.
 *
 * Matched on type for presets and on text for custom messages, because Protect echoes its own
 * wording for presets (`LEAVE PACKAGE AT DOOR`) rather than what was sent.
 */
export function activeMessageKey(
  plans: MessagePlan[],
  current: LcdMessage | undefined,
): string | undefined {
  if (!current?.type) {
    return undefined;
  }
  if (current.type !== 'CUSTOM_MESSAGE') {
    return plans.find((p) => p.type === current.type)?.key;
  }
  const text = current.text?.trim().toLowerCase();
  return text ? plans.find((p) => p.text?.trim().toLowerCase() === text)?.key : undefined;
}
