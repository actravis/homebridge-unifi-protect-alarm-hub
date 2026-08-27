// Pure planning for chime accessories. No HAP, no I/O.
//
// A chime is exposed as a momentary switch that RINGS it. That is the thing people want from a
// chime in HomeKit ("ring the chime when the gate opens"), and it is not something the official
// Integration API can do directly: `/chimes/{id}` exposes only `ringSettings`, and every play-style
// endpoint returns 404 (probed: play, play-speaker, play-sound, ring, test, chime, speaker, trigger,
// play-buzzer, buzzer). hjdhjd's plugin rings chimes through Protect's *private* API, which needs a
// login session and is the surface Ubiquiti breaks between firmware releases.
//
// The supported route is the one this plugin already uses for arm/disarm: an Alarm Manager alarm
// with a Webhook trigger and a "play chime" action. Alarm Manager can act on hardware the REST API
// won't expose, so firing `POST /alarm-manager/webhook/{id}` rings the chime. That makes the ring
// button config-gated: without a Trigger ID there is no way to ring, so no button is created.

import type { Chime, ChimeRingSetting } from './types';

/**
 * `ringSettings` as something safe to iterate.
 *
 * Typed `ChimeRingSetting[] | undefined`, but the console supplies it: a non-array value has no
 * `.every`/`.map` and threw out of planning. That no longer crashes the process — the discovery pass
 * catches it — but it surfaced as an internal-defect log rather than ordinary degradation. Treating a
 * malformed value like an ABSENT one is right: both mean "no usable pairing info", which already has
 * defined behaviour (an unpaired chime reports not-muted and offers no volume to change).
 */
function ringSettings(settings: ChimeRingSetting[] | undefined): ChimeRingSetting[] {
  return Array.isArray(settings) ? settings.filter((s) => typeof s === 'object' && s !== null) : [];
}

/** Volume restored when unmuting a chime whose previous level we never observed. */
export const DEFAULT_CHIME_VOLUME = 100;

export interface ChimePlan {
  deviceId: string;
  name: string;
  /** False when Protect reports the chime disconnected — a disconnected chime cannot ring. */
  online: boolean;
  /** The Alarm Manager webhook that rings this chime; absent means no ring button. */
  triggerId?: string;
  /** True when the mute switch should exist for this chime. */
  mutable: boolean;
  /** True when every paired camera's ring volume is zero. */
  muted: boolean;
  /** The level to restore on unmute: the loudest currently configured, if any is non-zero. */
  volume: number;
  /** How many cameras ring this chime; 0 means it is paired to nothing and cannot be muted. */
  pairedCameras: number;
  /**
   * The chime's ring settings exactly as the console reports them. Carried through verbatim
   * because a write replaces the whole array: rebuilding it would drop `ringtoneId` and
   * `repeatTimes` and silently reset the user's chosen ringtone.
   */
  ringSettings: ChimeRingSetting[];
}

/**
 * True when the chime is silent for every camera it is paired to.
 *
 * An unpaired chime (no ring settings) is reported as NOT muted: there is nothing to silence, and
 * showing the switch as off would imply the user had muted something.
 */
export function isChimeMuted(settings: ChimeRingSetting[] | undefined): boolean {
  const entries = ringSettings(settings);
  return entries.length > 0 && entries.every((s) => (s.volume ?? 0) === 0);
}

/**
 * The volume to restore when unmuting: the loudest level configured across paired cameras.
 *
 * The loudest rather than an average, because a chime paired to several cameras at different levels
 * should come back audible everywhere rather than at some level the user never chose. Falls back to
 * {@link DEFAULT_CHIME_VOLUME} when everything is already zero, so unmuting a chime that was muted
 * before the plugin ever saw it still produces sound.
 */
export function loudestVolume(settings: ChimeRingSetting[] | undefined): number {
  const volumes = ringSettings(settings).map((s) => s.volume ?? 0).filter((v) => v > 0);
  return volumes.length ? Math.max(...volumes) : DEFAULT_CHIME_VOLUME;
}

/**
 * `ringSettings` with every volume set to `volume`, preserving every other field.
 *
 * Preserving matters: the API replaces the whole array on write, so dropping `ringtoneId` or
 * `repeatTimes` would silently reset the user's chosen ringtone. `cameraId` identifies the entry
 * and must survive too.
 */
export function settingsAtVolume(
  settings: ChimeRingSetting[] | undefined,
  volume: number,
): ChimeRingSetting[] {
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  return ringSettings(settings).map((s) => ({ ...s, volume: clamped }));
}

/**
 * Accessory-key seed for a chime. Hashed into a HomeKit UUID in two places — where the accessory
 * is created and where it is looked up — so it lives here to stop the two sides drifting.
 */
export function chimeKey(deviceId: string): string {
  return `${deviceId}:chime`;
}

export interface ChimePlanConfig {
  /** Master toggle for chime accessories (default on). */
  exposeChimes?: boolean;
  /** Alarm Manager Trigger ID for an alarm whose action rings the chime. Enables the ring button. */
  chimeTriggerId?: string;
  /** Add a mute switch per chime — opt-in, since it is a second tile per chime. */
  exposeChimeMute?: boolean;
}

/**
 * Plan the chime accessories: a ring button when a Trigger ID is configured, a mute switch when
 * `exposeChimeMute` is on. The two are independent — either, both, or neither.
 *
 * Returns nothing when neither is enabled. In particular a ring button without a Trigger ID is
 * worse than no button, because it looks functional in the Home app and fails silently when
 * automated.
 */
export function planChimeAccessories(chimes: Chime[], config: ChimePlanConfig = {}): ChimePlan[] {
  const triggerId = config.chimeTriggerId?.trim() || undefined;
  const mutable = config.exposeChimeMute === true;
  if (config.exposeChimes === false || (!triggerId && !mutable)) {
    return [];
  }
  return chimes.map((chime) => ({
    deviceId: chime.id,
    name: chime.name ?? 'Chime',
    // Absent state is treated as online, matching the camera rule: marking a healthy device
    // unavailable is a worse failure than briefly trusting a dead one.
    online: chime.state !== 'DISCONNECTED',
    triggerId,
    mutable,
    muted: isChimeMuted(chime.ringSettings),
    volume: loudestVolume(chime.ringSettings),
    pairedCameras: ringSettings(chime.ringSettings).length,
    ringSettings: ringSettings(chime.ringSettings),
  }));
}
