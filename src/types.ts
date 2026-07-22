// Typed shapes for the subset of the UniFi Protect Integration API we consume.
// Reverse-engineered from a UDM-Pro on Protect 7.1.87. All fields
// are optional/defensive because this is an undocumented, evolving API.

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
}
