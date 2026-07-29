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
  /** Expose per-type smart-detect sensors (person/vehicle/animal/package) — default on. */
  exposeObjectSensors?: boolean;
  /** Expose smoke/CO sensors driven by the cameras' audio detection — default off (experimental). */
  exposeAudioSensors?: boolean;
  /** Attach a HomeKit camera (tile, snapshots, live video) — default on. */
  exposeCameraStreams?: boolean;
  /** Include camera audio in the live stream — default off (experimental). */
  exposeCameraAudio?: boolean;
  /** Add a per-camera "Doorbell Trigger" switch that fires a ring from automations — default off. */
  exposeDoorbellTriggers?: boolean;
  /** Device IDs to force-treat as doorbells, overriding the LCD-screen heuristic. */
  doorbellDeviceIds?: string[];
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
