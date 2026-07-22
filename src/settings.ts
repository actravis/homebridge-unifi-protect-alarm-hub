import type { PlatformConfig } from 'homebridge';

/** Must match the `pluginAlias` in config.schema.json. */
export const PLATFORM_NAME = 'UnifiProtectAlarmHub';

/** Must match the package name in package.json. */
export const PLUGIN_NAME = 'homebridge-unifi-protect-alarm-hub';

export interface UapahConfig extends PlatformConfig {
  host?: string;
  apiKey?: string;

  securityName?: string;
  armAwayTriggerId?: string;
  armNightTriggerId?: string;
  disarmTriggerId?: string;

  glassBreakAs?: 'motion' | 'contact';
  exposeOutputs?: boolean;
  exposeEmergencyInput?: boolean;
  /** Comma-separated, 1-indexed output channel(s) that mean a real alarm. Blank = any output. */
  sirenOutputChannels?: string;

  refreshInterval?: number;
  useRealtime?: boolean;
  trustSelfSignedCert?: boolean;
  /** Optional SHA-256 cert fingerprint to pin (hex, colons optional). Overrides trustSelfSignedCert. */
  certificateSha256?: string;
}
