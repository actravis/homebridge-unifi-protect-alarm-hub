// Typed shapes for the subset of the official UniFi Protect Integration API we consume.
// Modelled from live responses on a UDM-Pro running Protect 7.1.87: the API is supported and
// stable, but its schema is only partly documented, so every field here is optional and read
// defensively — a firmware update that adds, renames, or omits one must not break the plugin.

export type OnOff = 'on' | 'off';

export interface InputChannel {
  name?: string;
  /** ENTRY | GLASS_BREAK | MOTION | (future types). */
  inputType?: string;
  /** normal | alarm (mirrors terminal open/closed). */
  status?: string;
  /** nc | no wiring. */
  type?: string;
  enable?: OnOff;
  /** "on" when this zone is active under the currently-armed profile (the arm-profile fingerprint). */
  triggerOnCurrentArmingProfile?: OnOff;
  allowedArmingProfiles?: string[];
  lastTriggeredAt?: number;
}

export interface InputTerminalStatus {
  /** idle (closed) | triggered (open) | disabled | (tamper/fault strings: unknown, treated as fault). */
  terminalStatus?: string;
  plusPinStatus?: string;
  minusPinStatus?: string;
  idleSubState?: string;
}

export interface OutputChannel {
  active?: OnOff;
  enable?: OnOff;
  status?: string;
  name?: string;
  duration?: number;
}

export interface AlarmHubData {
  /** on | off — binary armed state; the active profile is not exposed directly (see armState.ts). */
  armed?: OnOff;
  battery?: { batteryStatus?: string; connection?: string; voltage?: number };
  cover?: { status?: string; distance?: number };
  input?: Record<string, InputChannel>;
  inputTerminalStatus?: Record<string, InputTerminalStatus>;
  output?: Record<string, OutputChannel>;
  emergencyTerminalStatus?: { terminalStatus?: string; plusPinStatus?: string; minusPinStatus?: string };
}

export interface AlarmHub {
  id: string;
  modelKey: string;
  name: string;
  mac?: string;
  /** CONNECTED | ... (device reachability). */
  state?: string;
  isAlarmHub?: boolean;
  alarmHub?: AlarmHubData;
}

/** Every accessory handler refreshes itself from the latest hub snapshot. */
export interface AccessoryHandler {
  update(hub: AlarmHub, name: string): void;
  /**
   * Mark the accessory as unreliable when the console has been unreachable for a while, so
   * HomeKit doesn't keep showing confidently-stale state (e.g. a door as "closed" when we
   * can't actually tell). The next successful `update` restores real values.
   */
  markStale?(): void;
}

// ---- Cameras (official Integration API) ----
// The `/cameras` object is metadata + settings only — no stream or channel information. Live
// video comes from the separate RTSPS endpoint, and live detections from the events WebSocket;
// see `RtspsStreams` and `ProtectEvent` below.

/** Fields every Protect device carries; `Camera` extends it. */
export interface ProtectDevice {
  id: string;
  modelKey: string;
  name?: string;
  mac?: string;
  /** CONNECTED | ... (device reachability). */
  state?: string;
}

export interface CameraFeatureFlags {
  /** Object detections this camera supports: person | vehicle | animal | package. */
  smartDetectTypes?: string[];
  /** Audio detections: alrmSmoke | alrmCmonx | alrmBabyCry | alrmSpeak. */
  smartDetectAudioTypes?: string[];
  videoModes?: string[];
  hasHdr?: boolean;
  hasMic?: boolean;
  hasSpeaker?: boolean;
  hasLedStatus?: boolean;
  supportFullHdSnapshot?: boolean;
}

export interface Camera extends ProtectDevice {
  isMicEnabled?: boolean;
  micVolume?: number;
  videoMode?: string;
  hdrType?: string;
  hasPackageCamera?: boolean;
  lcdMessage?: { type?: string; text?: string; resetAt?: number | null };
  ledSettings?: { isEnabled?: boolean };
  /** Which detections are currently enabled on the camera (subset of featureFlags). */
  smartDetectSettings?: { objectTypes?: string[]; audioTypes?: string[] };
  featureFlags?: CameraFeatureFlags;
}

/** RTSPS stream URLs by quality, from GET/POST /cameras/{id}/rtsps-stream. */
export interface RtspsStreams {
  high?: string;
  medium?: string;
  low?: string;
  package?: string;
}

/**
 * A semantic event from the `/subscribe/events` WebSocket — far richer than the thin
 * `/subscribe/devices` deltas. `item.type` is the event kind (motion, smartDetectZone,
 * ring, alarmHubEntryOpened, …); `item.device` is the source device id; smart detections
 * carry `item.smartDetectTypes`.
 */
export interface ProtectEvent {
  /** "add" | "update" */
  type?: string;
  item?: {
    id?: string;
    modelKey?: string;
    type?: string;
    start?: number;
    end?: number;
    device?: string;
    smartDetectTypes?: string[];
    metadata?: Record<string, unknown>;
  };
}
