import type { AlarmHub } from './types';

/**
 * The active arm profile (e.g. Away vs Night) is not exposed directly in Global mode,
 * but each profile lights up a distinct set of zones via `triggerOnCurrentArmingProfile`.
 * We fingerprint that set so we can recognise the profile later — even when the system
 * was armed externally (fob/app/keypad).
 */
export function computeFingerprint(hub: AlarmHub): string {
  const input = hub.alarmHub?.input ?? {};
  return Object.entries(input)
    .filter(([, c]) => c.triggerOnCurrentArmingProfile === 'on')
    .map(([channel]) => channel)
    .sort((a, b) => Number(a) - Number(b))
    .join(',');
}

export function isArmed(hub: AlarmHub): boolean {
  return hub.alarmHub?.armed === 'on';
}

/**
 * True when a hub output is firing while armed — our proxy for "alarm triggered".
 * If `sirenChannels` is given (0-indexed channel keys), only those outputs count;
 * otherwise any active output does.
 */
export function isTriggered(hub: AlarmHub, sirenChannels?: ReadonlySet<string>): boolean {
  if (!isArmed(hub)) {
    return false;
  }
  const outputs = hub.alarmHub?.output ?? {};
  const restrict = sirenChannels && sirenChannels.size > 0;
  return Object.entries(outputs).some(
    ([channel, o]) => o.active === 'on' && (!restrict || sirenChannels!.has(channel)),
  );
}
