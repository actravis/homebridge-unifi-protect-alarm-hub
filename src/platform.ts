import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, type UapahConfig } from './settings';
import { ProtectApiError, ProtectClient } from './client/protectClient';
import type { AccessoryHandler, AlarmHub } from './types';
import { SecuritySystemAccessory } from './accessories/securitySystem';
import { HubAccessory, ReadonlyContactAccessory, ZoneAccessory, type ZoneKind } from './accessories/sensors';

interface AccessorySpec {
  uuid: string;
  name: string;
  category: number;
  make: (accessory: PlatformAccessory) => AccessoryHandler;
}

export class UnifiAlarmHubPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly client?: ProtectClient;
  /** 0-indexed output channels that indicate a real alarm (empty = any active output). */
  readonly sirenChannels: Set<string>;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, AccessoryHandler>();
  private readonly warnedTypes = new Set<string>();
  private firmware?: string;
  private refreshTimer?: NodeJS.Timeout;
  private disposeRealtime?: () => void;
  private refreshQueued = false;
  private refreshing = false;
  private rerun = false;
  private warnedMultiHub = false;
  private lastRefreshOk = true;
  private authErrorLogged = false;

  constructor(
    readonly log: Logging,
    readonly config: UapahConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    // Config is 1-indexed to match the UniFi UI; store 0-indexed to match API output keys.
    this.sirenChannels = new Set(
      String(config.sirenOutputChannels ?? '')
        .split(',')
        .map((s) => Number(s.trim()) - 1)
        .filter((n) => Number.isInteger(n) && n >= 0)
        .map(String),
    );

    if (!config.host || !config.apiKey) {
      this.log.error('Missing "host" or "apiKey" — open the plugin settings and fill them in. Plugin is idle.');
      return;
    }

    this.client = new ProtectClient({
      host: config.host,
      apiKey: config.apiKey,
      trustSelfSignedCert: config.trustSelfSignedCert !== false,
      certificateSha256: config.certificateSha256,
    });

    if (!config.certificateSha256 && config.trustSelfSignedCert !== false) {
      this.log.info('Trusting the console\'s self-signed certificate without pinning; set "certificateSha256" to pin it.');
    }

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  /** Fire-and-forget a refresh cycle without leaking unhandled rejections. */
  private tick(): void {
    void this.refreshLoop().catch((err) => this.log.debug(`Refresh loop error: ${(err as Error).message}`));
  }

  /** Restore cached accessories on launch. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  applyInfo(accessory: PlatformAccessory, serial: string): void {
    const { Service, Characteristic } = this;
    const info =
      accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, 'UniFi Protect Alarm Hub')
      .setCharacteristic(Characteristic.SerialNumber, serial)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmware ?? '0.0.0');
  }

  /** Coalesce bursts (realtime deltas, arm/disarm actions) into a single fetch. */
  requestRefresh(): void {
    if (this.refreshQueued) {
      return;
    }
    this.refreshQueued = true;
    setTimeout(() => {
      this.refreshQueued = false;
      this.tick();
    }, 400);
  }

  /** Set up the poll interval + realtime feed, then kick off the first refresh. Runs once. */
  private start(): void {
    if (!this.client) {
      return;
    }
    try {
      const raw = Number(this.config.refreshInterval);
      const seconds = Number.isFinite(raw) && raw > 0 ? Math.max(2, raw) : 10;
      this.refreshTimer = setInterval(() => this.tick(), seconds * 1000);

      if (this.config.useRealtime !== false) {
        this.disposeRealtime = this.client.subscribeDevices(
          () => this.requestRefresh(),
          (level, msg) => this.log[level](`[realtime] ${msg}`),
        );
      }
      if (this.sirenChannels.size) {
        const shown = [...this.sirenChannels].map((c) => Number(c) + 1).join(', ');
        this.log.info(`Treating output channel(s) ${shown} as the alarm siren.`);
      }
    } catch (err) {
      this.log.error(`Startup failed: ${(err as Error).message}`);
    }
    this.tick();
  }

  private stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.disposeRealtime?.();
    void this.client?.close();
  }

  /** Serialise refreshes so overlapping triggers can't double-register accessories. */
  private async refreshLoop(): Promise<void> {
    if (!this.client) {
      return;
    }
    if (this.refreshing) {
      this.rerun = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.rerun = false;
        await this.refresh();
      } while (this.rerun);
    } finally {
      this.refreshing = false;
    }
  }

  private async ensureFirmware(): Promise<void> {
    if (this.firmware || !this.client) {
      return;
    }
    try {
      this.firmware = (await this.client.getVersion()).applicationVersion;
      // Backfill any accessories created before the version was known.
      for (const accessory of this.accessories.values()) {
        accessory
          .getService(this.Service.AccessoryInformation)
          ?.updateCharacteristic(this.Characteristic.FirmwareRevision, this.firmware);
      }
    } catch {
      /* version is cosmetic; try again next cycle */
    }
  }

  private async refresh(): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.ensureFirmware();

    let hubs: AlarmHub[];
    try {
      hubs = await this.client.getAlarmHubs();
    } catch (err) {
      this.reportFailure(err);
      return;
    }
    if (!this.lastRefreshOk) {
      this.log.info('Reconnected to the UniFi console.');
    }
    this.lastRefreshOk = true;
    this.authErrorLogged = false;

    const hub = hubs.find((h) => h.isAlarmHub) ?? hubs[0];
    if (!hub) {
      this.log.warn('No alarm hub found on this UniFi console.');
      return;
    }
    if (!this.warnedMultiHub) {
      const count = hubs.filter((h) => h.isAlarmHub).length;
      if (count > 1) {
        this.warnedMultiHub = true;
        this.log.warn(`Found ${count} alarm hubs; this plugin manages "${hub.name}" only.`);
      }
    }
    // Guard against partial reads: a hub with no input channels would otherwise
    // prune every zone accessory. Skip the cycle and keep the last-known state.
    if (!hub.alarmHub?.input || Object.keys(hub.alarmHub.input).length === 0) {
      this.log.debug('Incomplete hub payload (no input channels); skipping this refresh.');
      return;
    }
    this.sync(hub);
  }

  /** Surface connection/auth failures at a visible level, but only once per outage. */
  private reportFailure(err: unknown): void {
    const status = err instanceof ProtectApiError ? err.status : undefined;
    const message = (err as Error).message;
    if (status === 401 || status === 403) {
      if (!this.authErrorLogged) {
        this.authErrorLogged = true;
        this.log.error(`Authentication failed (HTTP ${status}). Check your API key and that the Integration API is enabled.`);
      }
    } else if (this.lastRefreshOk) {
      this.log.warn(`Cannot reach the UniFi console: ${message}. Will keep retrying.`);
    } else {
      this.log.debug(`Refresh failed: ${message}`);
    }
    this.lastRefreshOk = false;
  }

  private sync(hub: AlarmHub): void {
    const { Categories } = this.api.hap;
    const mac = hub.mac ?? hub.id;
    const uuid = (key: string): string => this.api.hap.uuid.generate(`${mac}:${key}`);
    const specs: AccessorySpec[] = [];

    specs.push({
      uuid: uuid('security'),
      name: this.config.securityName?.trim() || 'Security System',
      category: Categories.SECURITY_SYSTEM,
      make: (a) => new SecuritySystemAccessory(this, a, mac),
    });
    specs.push({
      uuid: uuid('hub'),
      name: hub.name,
      category: Categories.SENSOR,
      make: (a) => new HubAccessory(this, a, mac),
    });

    for (const [channel, input] of Object.entries(hub.alarmHub?.input ?? {})) {
      if (input.enable !== 'on' || !input.inputType) {
        continue; // only enabled, typed terminals — new sensors appear automatically
      }
      const kind = this.zoneKind(input.inputType);
      specs.push({
        // Kind is part of the identity so a terminal's type change re-creates cleanly.
        uuid: uuid(`zone:${channel}:${kind}`),
        name: input.name ?? `${input.inputType} ${Number(channel) + 1}`,
        category: Categories.SENSOR,
        make: (a) => new ZoneAccessory(this, a, channel, kind, mac),
      });
    }

    if (this.config.exposeOutputs !== false) {
      for (const [channel, output] of Object.entries(hub.alarmHub?.output ?? {})) {
        if (output.enable !== 'on') {
          continue;
        }
        specs.push({
          uuid: uuid(`output:${channel}`),
          name: output.name ?? `Output ${Number(channel) + 1}`,
          category: Categories.SENSOR,
          make: (a) => new ReadonlyContactAccessory(this, a, { kind: 'output', channel }, mac),
        });
      }
    }

    if (this.config.exposeEmergencyInput !== false) {
      specs.push({
        uuid: uuid('emergency'),
        name: 'Emergency Input',
        category: Categories.SENSOR,
        make: (a) => new ReadonlyContactAccessory(this, a, { kind: 'emergency' }, mac),
      });
    }

    this.reconcile(specs, hub);
  }

  private reconcile(specs: AccessorySpec[], hub: AlarmHub): void {
    const desired = new Set(specs.map((s) => s.uuid));

    for (const [id, accessory] of this.accessories) {
      if (!desired.has(id)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(id);
        this.handlers.delete(id);
        this.log.info(`Removed accessory "${accessory.displayName}" (no longer present).`);
      }
    }

    for (const spec of specs) {
      let accessory = this.accessories.get(spec.uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(spec.name, spec.uuid, spec.category);
        this.accessories.set(spec.uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added accessory "${spec.name}".`);
      } else if (accessory.displayName !== spec.name) {
        accessory.displayName = spec.name;
        this.api.updatePlatformAccessories([accessory]);
      }

      let handler = this.handlers.get(spec.uuid);
      if (!handler) {
        handler = spec.make(accessory);
        this.handlers.set(spec.uuid, handler);
      }
      try {
        handler.update(hub, spec.name);
      } catch (err) {
        this.log.debug(`Update failed for "${spec.name}": ${(err as Error).message}`);
      }
    }
  }

  private zoneKind(inputType: string): ZoneKind {
    switch (inputType) {
      case 'MOTION':
        return 'motion';
      case 'GLASS_BREAK':
        return this.config.glassBreakAs === 'contact' ? 'contact' : 'motion';
      case 'ENTRY':
        return 'contact';
      default:
        if (!this.warnedTypes.has(inputType)) {
          this.warnedTypes.add(inputType);
          this.log.info(`Unknown sensor type "${inputType}" — exposing as a contact sensor. Please report this.`);
        }
        return 'contact';
    }
  }
}
