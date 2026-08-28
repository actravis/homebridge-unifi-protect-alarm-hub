import type { PlatformConfig } from 'homebridge';

/** Must match the `pluginAlias` in config.schema.json. */
export const PLATFORM_NAME = 'UnifiProtectIntegration';

/** Must match the package name in package.json. */
export const PLUGIN_NAME = 'homebridge-unifi-protect-integration';

export interface ProtectConfig extends PlatformConfig {
  host?: string;
  apiKey?: string;

  securityName?: string;
  armAwayTriggerId?: string;
  armNightTriggerId?: string;
  disarmTriggerId?: string;

  /** Expose the alarm domain (security system, hub, zones, outputs, emergency) — default on.
   *  Turn off to expose cameras only (e.g. a cameras-only setup or a focused smoke test). */
  exposeAlarm?: boolean;

  glassBreakAs?: 'motion' | 'contact';
  exposeOutputs?: boolean;
  exposeEmergencyInput?: boolean;

  /** Expose cameras (overall motion + doorbell) — default on. */
  exposeCameras?: boolean;
  /**
   * If non-empty, expose ONLY these cameras (device ID or name, case-insensitive). Used to split a
   * large site across two platform instances in separate child bridges, since HomeKit caps a bridge
   * at 149 accessories; also works as a privacy control.
   */
  includeCameras?: string[];
  /** Never expose these cameras (device ID or name, case-insensitive). Applied after the include list. */
  excludeCameras?: string[];
  /**
   * Seconds a device must stay missing from the console before its accessory is removed — default
   * 300, `0` removes on sight.
   *
   * Removing an accessory discards its room assignment and any automation using it, and re-adding
   * the device does not restore them. A console that is mid-restart can answer successfully with an
   * incomplete list, so the default waits for a second pass to agree before doing anything
   * irreversible. Does not delay removals you asked for by changing config.
   */
  deviceRemovalDelay?: number;
  /**
   * Expose per-type smart-detect sensors (person/vehicle/animal/package) — default on.
   *
   * They are ContactSensor services on the camera's own accessory, not accessories of their own, so
   * enabling them costs no extra HomeKit accessories. Switch it off to reduce a camera to overall
   * motion only.
   */
  exposeObjectSensors?: boolean;
  /** Expose smoke/CO sensors driven by the cameras' audio detection — default off (experimental). */
  exposeAudioSensors?: boolean;
  /** Attach a HomeKit camera (tile, snapshots, live video) — default on. */
  exposeCameraStreams?: boolean;
  /** Include camera audio in the live stream — default off (experimental). */
  exposeCameraAudio?: boolean;
  /**
   * Two-way audio: talk from the Home app to the camera's speaker. Default off (experimental).
   * Requires `exposeCameraAudio`, and requires Homebridge to have a network route to the camera
   * itself — the talkback target is the camera's IP, not the console's.
   */
  exposeTalkback?: boolean;
  /**
   * Alarm Manager Trigger ID for an alarm whose action rings the chime. Required for the chime
   * ring button: the Integration API has no play/ring endpoint, so this webhook is the only
   * supported way to ring one. Without it, no ring button is created.
   */
  chimeTriggerId?: string;
  /** Add a per-chime "Audible" mute switch — opt-in, since it is a second tile per chime. */
  exposeChimeMute?: boolean;
  /** Add a per-camera "Doorbell Trigger" switch that fires a ring from automations — default off. */
  exposeDoorbellTriggers?: boolean;
  /**
   * Add a switch per doorbell-screen message — opt-in, since each is another tile. Offers Protect's
   * two presets plus anything in `doorbellMessages`.
   */
  exposeDoorbellMessages?: boolean;
  /** Extra custom message texts to offer as switches (blank and duplicate entries are ignored). */
  doorbellMessages?: string[];
  /**
   * Add a "Status Light" switch for cameras with a controllable LED — opt-in. Only models reporting
   * `hasLedStatus` get one; the rest cannot turn it off, so no switch is created for them.
   */
  exposeStatusLed?: boolean;
  /** Device IDs to force-treat as doorbells, overriding the LCD-screen heuristic. */
  doorbellDeviceIds?: string[];
  /** Master toggle for chime accessories — default on; also needs a ring trigger and/or mute. */
  exposeChimes?: boolean;
  /** Comma-separated, 1-indexed output channel(s) that mean a real alarm. Blank = any output. */
  sirenOutputChannels?: string;

  refreshInterval?: number;
  useRealtime?: boolean;
  /** Seconds of realtime silence before forcing a reconnect (~2× the console's keepalive interval). */
  realtimeIdleTimeout?: number;
  trustSelfSignedCert?: boolean;
  /** Optional SHA-256 cert fingerprint to pin (hex, colons optional). Overrides trustSelfSignedCert. */
  certificateSha256?: string;
}
