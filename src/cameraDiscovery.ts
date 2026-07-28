// Pure planning of camera accessories from the /cameras list. No HAP, no side effects, so
// the "what to expose" rules are unit-testable. The platform maps each plan to a real
// accessory (camera = overall motion + optional doorbell; object types = separate sensors).

import type { Camera } from './types';

export interface CameraPlan {
  deviceId: string;
  name: string;
  /** Whether to expose a Doorbell service on this camera's accessory. */
  isDoorbell: boolean;
  /** Smart-detect object types to expose as separate sensors (person/vehicle/animal/package). */
  objectTypes: string[];
  /** False when Protect reports the camera as disconnected — the accessory stays, marked inactive. */
  online: boolean;
  /**
   * Object types the camera supports but that are switched OFF in Protect right now. Their
   * sensors are still exposed (the user may enable detection later, and we only re-discover
   * periodically), but they cannot fire — worth telling the user rather than leaving them
   * wondering why a sensor never triggers.
   */
  disabledObjectTypes: string[];
}

/**
 * Accessory-key seeds for a camera and its per-type smart-detect sensors.
 *
 * These are hashed into HomeKit UUIDs in two independent places — where accessories are created
 * and where realtime detections are routed to them. Building the strings inline in both spots
 * meant a typo in either would silently route every detection to nothing, with no error. Keep
 * them here so the two sides cannot drift.
 */
export function cameraKey(deviceId: string): string {
  return `${deviceId}:camera`;
}

export function objectSensorKey(deviceId: string, objectType: string): string {
  return `${deviceId}:object:${objectType}`;
}

/**
 * The HomeKit name for a camera's per-type sensor, e.g. "Front Door" + "person" → "Front Door
 * Person". Derived from the camera's name, so it is built here rather than inline: it is needed
 * both when the sensor is created and when a camera rename has to be followed through to it.
 */
export function objectSensorName(cameraName: string, objectType: string): string {
  return `${cameraName} ${objectType.charAt(0).toUpperCase()}${objectType.slice(1)}`;
}

export interface CameraPlanConfig {
  /** Master toggle for all camera accessories (default on). */
  exposeCameras?: boolean;
  /** Expose per-type smart-detect sensors (default on). */
  exposeObjectSensors?: boolean;
  /** Device IDs to force-treat as doorbells, overriding the heuristic. */
  doorbellDeviceIds?: string[];
}

/**
 * Decide a doorbell from the camera object. The Integration API has no explicit `isDoorbell`
 * field, so this is a heuristic — overridable via `doorbellDeviceIds`. The platform also logs
 * if a `ring` ever arrives from a camera we didn't flag, so a miss is caught, not swallowed.
 *
 * Signals, in order:
 *  1. Explicit config override.
 *  2. A populated `lcdMessage` — only doorbells have the LCD screen. IMPORTANT: the API returns
 *     `lcdMessage: {}` (an empty object, NOT null or absent) for every non-doorbell camera, so
 *     a plain null check matches everything and makes every camera a doorbell. Verified against
 *     the live console: 4 plain cameras → `{}`, the doorbell → `{type, text, resetAt}`.
 *  3. Speaker + `package` smart-detect — a doorbell-class combination, and the fallback for a
 *     doorbell whose LCD message simply isn't set right now. Plain cameras report neither.
 */
export function isDoorbell(camera: Camera, config: CameraPlanConfig = {}): boolean {
  if (config.doorbellDeviceIds?.includes(camera.id)) {
    return true;
  }
  const lcd = camera.lcdMessage;
  if (lcd && (lcd.type != null || lcd.text != null)) {
    return true;
  }
  const flags = camera.featureFlags;
  return flags?.hasSpeaker === true && flags.smartDetectTypes?.includes('package') === true;
}

/**
 * A camera is treated as online unless Protect explicitly says otherwise. Every field of this
 * API is optional in practice, and defaulting an absent `state` to "offline" would mark healthy
 * cameras unavailable in HomeKit — a far worse failure than briefly trusting a dead one.
 */
export function isCameraOnline(camera: Camera): boolean {
  return camera.state !== 'DISCONNECTED';
}

export function planCameraAccessories(cameras: Camera[], config: CameraPlanConfig = {}): CameraPlan[] {
  if (config.exposeCameras === false) {
    return [];
  }
  return cameras.map((camera) => {
    const supported = config.exposeObjectSensors === false ? [] : camera.featureFlags?.smartDetectTypes ?? [];
    // `smartDetectSettings.objectTypes` is what's actually switched on; featureFlags is only what
    // the hardware can do. An absent settings block means "unknown" — assume everything is on.
    const enabled = camera.smartDetectSettings?.objectTypes;
    return {
      deviceId: camera.id,
      name: camera.name ?? 'Camera',
      isDoorbell: isDoorbell(camera, config),
      objectTypes: supported,
      online: isCameraOnline(camera),
      disabledObjectTypes: enabled ? supported.filter((type) => !enabled.includes(type)) : [],
    };
  });
}
