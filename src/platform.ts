import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, type ProtectConfig } from './settings';
import { ProtectApiError, ProtectClient, type ProtectClientOptions } from './client/protectClient';
import type { AccessoryHandler, AlarmHub, Camera, ProtectEvent } from './types';
import { SecuritySystemAccessory } from './accessories/securitySystem';
import { HubAccessory, ReadonlyContactAccessory, ZoneAccessory } from './accessories/sensors';
import { AlarmSensorAccessory, CameraAccessory } from './accessories/camera';
import { ChimeAccessory } from './accessories/chime';
import { chimeKey, planChimeAccessories } from './chimeDiscovery';
import { planDoorbellMessages } from './doorbellMessages';
import { planAccessories, type PlannedAccessory } from './discovery';
import { basePollSeconds, effectivePollSeconds } from './pollPolicy';
import {
  audioSensorKey,
  cameraKey,
  planCameraAccessories,
  selectCameras,
  type CameraPlan,
} from './cameraDiscovery';
import { decodeCameraEvent } from './cameraEvents';
import { alarmKindLabel, isAudioDetection, sensorKindsFor } from './detectionKinds';
import { isDeviceList, redactPayload } from './util';
import { probeAudioCodec, type AudioCodecChoice } from './streaming/audioCodec';
import { resolveFfmpegPath } from './streaming/ffmpegPath';

interface AccessorySpec {
  uuid: string;
  name: string;
  category: number;
  make: (accessory: PlatformAccessory) => AccessoryHandler;
}

/**
 * Consecutive failed refreshes before we mark accessories unavailable — long enough to ride
 * out brief blips (≈30s at the default 10s interval), short enough not to trust stale state.
 */
const STALE_AFTER_FAILURES = 3;

/** HomeKit's hard limit on accessories behind a single bridge. */
const ACCESSORY_LIMIT = 149;
/** Warn from here, leaving headroom to act before accessories start being dropped. */
const ACCESSORY_WARN_AT = 130;

/**
 * How often to re-discover the non-alarm devices (cameras, chimes).
 *
 * These used to be discovered only at startup and on an events-socket reconnect, so a device added,
 * renamed, or unplugged in Protect could go unnoticed for hours. It is one request per device class
 * per interval, so it stays cheap against the console's ~10 req/s budget.
 */
const DEVICE_DISCOVERY_SECONDS = 300;

/**
 * How long a device must stay missing from the console before its accessory is unregistered.
 *
 * Unregistering is the one genuinely destructive thing this plugin does: it takes the user's room
 * assignment and every automation referencing the accessory with it, and re-adding the device does
 * NOT bring those back. A successful read is not proof a device is gone — a console mid-reboot or
 * mid-adoption can answer 200 with a short list, or an empty one — so a disappearance is treated as
 * a claim to be confirmed by a later pass rather than acted on at once.
 *
 * The default spans two discovery passes, so a device has to be absent twice, minutes apart.
 * Configurable via `deviceRemovalDelay`; 0 restores the old remove-on-sight behaviour.
 */
const DEVICE_REMOVAL_GRACE_SECONDS = 300;

/**
 * How long discovery must have been healthy before any graced removal is allowed to fire.
 *
 * Separate from the grace above and not redundant with it: the grace answers "has it been gone long
 * enough?", this answers "is the console currently trustworthy enough to be believed about it?".
 * They come apart exactly when it matters — a console that goes away and comes back mid-grace
 * returns a list we should not act on destructively, however long the device has been missing.
 * Also covers startup, where the very first read is the least trustworthy one we ever take.
 */
const REMOVAL_STABILITY_SECONDS = 60;

/**
 * The I/O boundaries the platform owns, injectable so discovery, reconcile and the poll
 * cadence can be unit-tested without a console or real timers — the same pattern
 * {@link ProtectClient}'s `deps` uses. Homebridge never passes this; production gets
 * {@link REAL_PLATFORM_DEPS}.
 */
export interface PlatformDeps {
  createClient: (opts: ProtectClientOptions) => ProtectClient;
  /**
   * Probe for a usable HomeKit audio encoder. Injectable so tests are deterministic: the real one
   * spawns ffmpeg, which makes the outcome depend on the host's build (see rule: tests inject I/O).
   */
  probeAudioCodec: (ffmpegPath: string) => Promise<AudioCodecChoice | undefined>;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  /**
   * Wall clock for the removal grace and stability window. Injected for the same reason
   * {@link ProtectClient} injects one: a test asserting "not yet, then yes" must be able to move
   * time without waiting minutes for it.
   */
  now: () => number;
}

const REAL_PLATFORM_DEPS: PlatformDeps = {
  createClient: (opts) => new ProtectClient(opts),
  probeAudioCodec,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  now: () => Date.now(),
};

export class UnifiProtectPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly client?: ProtectClient;
  /** 0-indexed output channels that indicate a real alarm (empty = any active output). */
  readonly sirenChannels: Set<string>;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, AccessoryHandler>();
  private readonly cameraHandlers = new Map<string, CameraAccessory>();
  /** Native smoke / CO sensors driven by the cameras' audio detection, keyed by accessory UUID. */
  private readonly alarmHandlers = new Map<string, AlarmSensorAccessory>();
  private readonly chimeHandlers = new Map<string, ChimeAccessory>();

  /** So an unexpected discovery throw is reported once rather than every interval. */
  private deviceSyncErrorLogged = false;
  /** The accessory-budget warning is reported once, not on every discovery pass. */
  private warnedAccessoryBudget = false;
  /** Talkback-without-audio is warned about once, not on every discovery pass. */
  private warnedTalkback = false;
  private disposeEvents?: () => void;
  private syncingCameras = false;
  private resyncCameras = false;
  /**
   * Per-device-class discovery health, so each reports its FIRST failure and its recovery once.
   * Keyed by the label {@link readDeviceList} is called with.
   */
  private readonly discoveryOk = new Map<string, boolean>();
  /**
   * When each device class's discovery last became healthy, keyed by the same label as
   * {@link discoveryOk}. Reset on every failure, so the stability window restarts after any
   * disruption rather than counting time across one.
   */
  private readonly discoveryHealthySince = new Map<string, number>();
  /**
   * Accessories seen missing from a successful read, and the time they may be unregistered.
   * Keyed by accessory UUID. An entry disappears the moment its device comes back.
   */
  private readonly pendingRemovals = new Map<string, number>();
  private readonly warnedTypes = new Set<string>();
  private readonly warnedRingDevices = new Set<string>();
  private readonly warnedDisabledDetections = new Set<string>();
  /** Event types we've already reported as undecodable, so the log stays one line per type. */
  private readonly seenUnhandledEvents = new Set<string>();
  /** Detections that decoded but had no handler, keyed device:kind — warned once each. */
  private readonly warnedUnrouted = new Set<string>();
  /** Cameras currently reported offline, so the log records transitions rather than every pass. */
  private readonly offlineCameras = new Set<string>();
  /** Include/exclude entries already reported as matching nothing — warned once each. */
  private readonly warnedUnmatchedCameras = new Set<string>();
  private cameraTimer?: NodeJS.Timeout;
  private firmware?: string;
  private refreshTimer?: NodeJS.Timeout;
  /** Configured poll cadence, before the realtime-healthy back-off is applied. */
  private pollSeconds = 0;
  /** Cadence the current timer is running at, so we only rebuild it when it actually changes. */
  private activePollSeconds?: number;
  private realtimeConnected = false;
  private disposeRealtime?: () => void;
  private refreshQueued = false;
  private refreshing = false;
  private rerun = false;
  private warnedMultiHub = false;
  private lastRefreshOk = true;
  private authErrorLogged = false;
  private consecutiveFailures = 0;
  /** Set on Homebridge shutdown; every async path checks it before touching the accessory API. */
  private stopped = false;
  /** So the chosen-codec line is logged once, not on every discovery pass. */
  private audioReported = false;
  /** Probed once: which audio codec this ffmpeg can encode, or undefined for video-only. */
  private audioCodec?: AudioCodecChoice;

  constructor(
    readonly log: Logging,
    readonly config: ProtectConfig,
    readonly api: API,
    private readonly deps: PlatformDeps = REAL_PLATFORM_DEPS,
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

    const idleTimeout = Number(config.realtimeIdleTimeout);
    try {
      this.client = this.deps.createClient({
        host: config.host,
        apiKey: config.apiKey,
        trustSelfSignedCert: config.trustSelfSignedCert !== false,
        certificateSha256: config.certificateSha256,
        realtimeIdleTimeoutMs: Number.isFinite(idleTimeout) && idleTimeout > 0 ? idleTimeout * 1000 : undefined,
      });
    } catch (err) {
      // e.g. a malformed certificate pin. Stay idle rather than run with weaker TLS than asked for.
      this.log.error(`${(err as Error).message} Plugin is idle.`);
      return;
    }

    if (!config.certificateSha256 && config.trustSelfSignedCert !== false) {
      this.log.info('Trusting the console\'s self-signed certificate without pinning; set "certificateSha256" to pin it.');
    }

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  /**
   * Fire-and-forget a device discovery pass without leaking unhandled rejections.
   *
   * This is the net `tick()` and the snapshot path always had and this path did not: `syncDevices`
   * was called as a bare `void`, so ANY throw inside it became an unhandled rejection, which Node
   * treats as fatal — one malformed `/chimes` body took the whole bridge down and logged nothing
   * about chimes. The specific failures are reported by the passes themselves; reaching here means
   * a defect, so it is loud once and quiet after, rather than repeating every discovery interval.
   */
  private discoverDevices(): void {
    void this.syncDevices().catch((err) => {
      const message = `Device discovery failed unexpectedly: ${(err as Error).message}`;
      if (this.deviceSyncErrorLogged) {
        this.log.debug(message);
        return;
      }
      this.deviceSyncErrorLogged = true;
      this.log.error(`${message} — please report this with debug logging on.`);
    });
  }

  /** Fire-and-forget a refresh cycle without leaking unhandled rejections. */
  private tick(): void {
    void this.refreshLoop().catch((err) => this.log.debug(`Refresh loop error: ${(err as Error).message}`));
  }

  /** Restore cached accessories on launch. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  applyInfo(accessory: PlatformAccessory, serial: string, model = 'UniFi Protect Alarm Hub'): void {
    const { Service, Characteristic } = this;
    const info =
      accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, serial)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmware ?? '0.0.0');
  }

  /** Coalesce bursts (realtime deltas, arm/disarm actions) into a single fetch. */
  requestRefresh(): void {
    if (this.refreshQueued) {
      return;
    }
    this.refreshQueued = true;
    this.deps.setTimeout(() => {
      this.refreshQueued = false;
      this.tick();
    }, 400);
  }

  /** Set up the poll interval + realtime feed, then kick off the first refresh. Runs once. */
  private start(): void {
    if (!this.client) {
      return;
    }
    const alarmEnabled = this.config.exposeAlarm !== false;
    try {
      if (alarmEnabled) {
        this.pollSeconds = basePollSeconds(this.config.refreshInterval);
        this.applyPollInterval();
      } else {
        this.log.info('Alarm accessories disabled (exposeAlarm=false); exposing cameras only.');
      }

      if (this.config.useRealtime !== false) {
        // The device feed drives the alarm poll; only subscribe when the alarm domain is on.
        if (alarmEnabled) {
          this.disposeRealtime = this.client.subscribeDevices(
            () => this.requestRefresh(),
            (level, msg) => this.log[level](`[realtime] ${msg}`),
            {
              // On reconnect, state may have changed during the gap — resync immediately.
              onReconnect: () => this.requestRefresh(),
              // While the feed is up the poll is only a backstop, so slow it right down; a drop
              // restores the configured cadence, which is what actually keeps state fresh then.
              onStatus: (connected) => this.setRealtimeConnected(connected),
            },
          );
        }

        if (this.config.exposeCameras !== false) {
          this.disposeEvents = this.client.subscribeEvents(
            (event) => this.routeEvent(event),
            (level, msg) => this.log[level](`[events] ${msg}`),
            // Detections during the gap are lost; re-discover cameras on recovery.
            { onReconnect: () => void this.syncCameras() },
          );
        }
      }
      // Discover cameras regardless of the realtime setting. This used to live inside the
      // realtime branch, so `useRealtime: false` silently produced no camera accessories at
      // all. Without realtime the accessories still work; they just don't get live detections.
      if (this.config.exposeCameras !== false && this.config.useRealtime === false) {
        this.log.info('Realtime is off: cameras are exposed but motion/doorbell events will not fire.');
      }
      if (this.config.exposeCameras !== false || this.config.exposeChimes !== false) {
        this.discoverDevices();
        // Detections arrive over the events socket, but a device being added, renamed, or going
        // offline does not — that only shows up in a discovery pass.
        this.cameraTimer = this.deps.setInterval(() => this.discoverDevices(), DEVICE_DISCOVERY_SECONDS * 1000);
      }
      if (alarmEnabled && this.sirenChannels.size) {
        const shown = [...this.sirenChannels].map((c) => Number(c) + 1).join(', ');
        this.log.info(`Treating output channel(s) ${shown} as the alarm siren.`);
      }
    } catch (err) {
      this.log.error(`Startup failed: ${(err as Error).message}`);
    }
    if (alarmEnabled) {
      this.tick();
    }
  }

  /**
   * Track the realtime device feed's health and re-cadence the poll around it.
   *
   * A drop also triggers an immediate refresh: pushes stopped arriving at some unknown point
   * before we noticed, so the first thing the slow path owes the user is current state.
   */
  private setRealtimeConnected(connected: boolean): void {
    if (this.realtimeConnected === connected) {
      return;
    }
    this.realtimeConnected = connected;
    this.applyPollInterval();
    if (!connected) {
      this.requestRefresh();
    }
  }

  /** (Re)arm the poll timer at the cadence the current realtime health calls for. */
  private applyPollInterval(): void {
    if (this.pollSeconds <= 0) {
      return; // alarm domain disabled — there is nothing to poll
    }
    const seconds = effectivePollSeconds(this.pollSeconds, this.realtimeConnected);
    if (seconds === this.activePollSeconds) {
      return;
    }
    this.activePollSeconds = seconds;
    if (this.refreshTimer) {
      this.deps.clearInterval(this.refreshTimer);
    }
    this.refreshTimer = this.deps.setInterval(() => this.tick(), seconds * 1000);
    this.log.debug(`Alarm poll interval now ${seconds}s (realtime ${this.realtimeConnected ? 'up' : 'down'}).`);
  }

  private stop(): void {
    // A refresh or camera sync may be mid-await right now. Without this flag it would resume
    // after shutdown and register accessories against an API that is already tearing down.
    this.stopped = true;
    if (this.refreshTimer) {
      this.deps.clearInterval(this.refreshTimer);
    }
    if (this.cameraTimer) {
      this.deps.clearInterval(this.cameraTimer);
    }
    this.disposeRealtime?.();
    this.disposeEvents?.();
    // Node does NOT kill child processes on exit: without this, every live ffmpeg transcode
    // survives a Homebridge restart, keeps its sockets, and accumulates on each restart.
    // Each shutdown is isolated, or one throwing handler would skip the rest AND the client
    // close below — turning a cosmetic failure into leaked processes and sockets.
    for (const uuid of [
      ...this.cameraHandlers.keys(),
      ...this.alarmHandlers.keys(), ...this.chimeHandlers.keys(),
    ]) {
      this.shutdownHandler(uuid);
    }
    // undici's Agent.close() REJECTS (ClientDestroyedError) if the agent is already closed, and a
    // bare `void` would turn that into an unhandled rejection during shutdown.
    void this.client?.close().catch((err: unknown) => {
      this.log.debug(`Closing the console connection failed: ${(err as Error).message}`);
    });
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
    if (!this.client || this.stopped || this.config.exposeAlarm === false) {
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
    if (this.stopped) {
      return; // shut down while we were awaiting the console
    }
    if (!this.lastRefreshOk) {
      this.log.info('Reconnected to the UniFi console.');
    }
    this.lastRefreshOk = true;
    this.authErrorLogged = false;
    this.consecutiveFailures = 0;

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
    this.consecutiveFailures++;
    // After a sustained outage, stop presenting confidently-stale state in HomeKit (fires once).
    if (this.consecutiveFailures === STALE_AFTER_FAILURES) {
      this.log.warn('UniFi console unreachable for a while; marking accessories unavailable until it returns.');
      this.markAllStale();
    }
  }

  /**
   * Flag every accessory as unreliable during a sustained console outage.
   * Known limitation: if Homebridge starts while the console is already down, no handlers
   * exist yet (they're created on the first successful sync), so restored/cached accessories
   * keep showing their last HomeKit state until the console is first reached.
   */
  private markAllStale(): void {
    for (const handler of this.handlers.values()) {
      try {
        handler.markStale?.();
      } catch (err) {
        this.log.debug(`markStale failed: ${(err as Error).message}`);
      }
    }
  }

  private sync(hub: AlarmHub): void {
    const { Categories } = this.api.hap;
    const mac = hub.mac ?? hub.id;
    const uuid = (key: string): string => this.api.hap.uuid.generate(`${mac}:${key}`);

    // The "what should exist" decision is pure and unit-tested (see discovery.ts); here we
    // just map each plan to a real accessory + reconcile against what's currently registered.
    const { accessories, unknownTypes } = planAccessories(hub, this.config);
    for (const type of unknownTypes) {
      if (!this.warnedTypes.has(type)) {
        this.warnedTypes.add(type);
        this.log.info(`Unknown sensor type "${type}" — exposing as a contact sensor. Please report this.`);
      }
    }

    const specs: AccessorySpec[] = accessories.map((p) => ({
      uuid: uuid(p.key),
      name: p.name,
      category: p.category === 'security' ? Categories.SECURITY_SYSTEM : Categories.SENSOR,
      make: this.makeFor(p, mac),
    }));
    this.reconcile(specs, hub);
  }

  /** Build the accessory-handler factory for a planned accessory. */
  private makeFor(plan: PlannedAccessory, mac: string): (accessory: PlatformAccessory) => AccessoryHandler {
    switch (plan.kind) {
      case 'security':
        return (a) => new SecuritySystemAccessory(this, a, mac);
      case 'hub':
        return (a) => new HubAccessory(this, a, mac);
      case 'zone':
        return (a) => new ZoneAccessory(this, a, plan.channel!, plan.zoneKind!, mac);
      case 'output':
        return (a) => new ReadonlyContactAccessory(this, a, { kind: 'output', channel: plan.channel! }, mac);
      case 'emergency':
        return (a) => new ReadonlyContactAccessory(this, a, { kind: 'emergency' }, mac);
    }
  }

  private reconcile(specs: AccessorySpec[], hub: AlarmHub): void {
    const desired = new Set(specs.map((s) => s.uuid));

    for (const [id, accessory] of this.accessories) {
      // Only prune alarm-domain accessories; cameras are managed by syncCameras. (Accessories
      // cached before the camera feature existed have no domain → treat them as alarm.)
      if ((accessory.context.domain ?? 'alarm') !== 'alarm') {
        continue;
      }
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
        accessory.context.domain = 'alarm';
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

  // ---- Cameras (event-driven; separate from the alarm-hub poll/reconcile) ----

  /** One discovery pass over every non-alarm device class. */
  private async syncDevices(): Promise<void> {
    await this.syncCameras();
    await this.syncChimes();
    this.checkAccessoryBudget();
  }

  /**
   * Warn as the bridge approaches HomeKit's per-bridge accessory limit.
   *
   * HAP allows 149 accessories on one bridge. A camera is ONE accessory — its smart detections are
   * services on it — so this is normally only reachable with `exposeAudioSensors` on (which adds up
   * to 2 per camera, since HomeKit treats smoke/CO as critical alerts and they have to stay separate)
   * or with a large alarm hub, which contributes one per zone. Past the limit HomeKit simply stops
   * accepting accessories, which reads as "some cameras are missing" with nothing to explain it.
   *
   * The limit is per BRIDGE, so the remedy offered is splitting across child bridges — that keeps
   * every accessory. Switching sensors off is named second because it costs the user functionality;
   * leading with it steers people into losing features they could have kept.
   */
  private checkAccessoryBudget(): void {
    const count = this.accessories.size;
    if (count < ACCESSORY_WARN_AT || this.warnedAccessoryBudget) {
      return;
    }
    this.warnedAccessoryBudget = true;
    this.log.warn(
      `This bridge now has ${count} accessories; HomeKit's limit is ${ACCESSORY_LIMIT} per bridge, ` +
        'and past it accessories are silently dropped. The limit is per bridge, so the fix that ' +
        'keeps everything is to split this platform into two instances in separate Homebridge ' +
        'child bridges — one for the alarm (exposeCameras: false) and one for the cameras ' +
        '(exposeAlarm: false), or split the cameras themselves with includeCameras. See the ' +
        'Scale section of the plugin README. Failing that, turning off exposeAudioSensors ' +
        'reduces the count, at the cost of the smoke/CO sensors.',
    );
  }

  /**
   * Discover chimes and reconcile their accessories.
   *
   * Kept separate from the camera reconcile rather than folded into it: they are different device
   * classes with different config gates, and a failure fetching one must not stop the other.
   */
  private async syncChimes(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) {
      return;
    }
    // With neither a ring trigger nor the mute switch there is nothing to expose, so don't spend a
    // request discovering chimes — but DO prune, or a chime accessory cached from an earlier config
    // lingers as a dead switch.
    const anyChimeControl = !!this.config.chimeTriggerId?.trim() || this.config.exposeChimeMute === true;
    if (this.config.exposeChimes === false || !anyChimeControl) {
      this.pruneDomain(
        'chime',
        this.config.exposeChimes === false ? 'exposeChimes is off' : 'no chime controls configured',
      );
      return;
    }
    const chimes = await this.readDeviceList('Chime', '/chimes', () => client.getChimes());
    if (!chimes || this.stopped) {
      return; // failed read, or shut down while we were awaiting the console
    }

    const { Categories, uuid } = this.api.hap;
    const desired = new Set<string>();
    for (const plan of planChimeAccessories(chimes, this.config)) {
      const id = uuid.generate(chimeKey(plan.deviceId));
      desired.add(id);
      let handler = this.chimeHandlers.get(id);
      if (!handler) {
        const accessory = this.acquireAccessory(id, plan.name, Categories.SWITCH, 'chime', plan.deviceId);
        if (!accessory) {
          continue; // registration failed; it stays in `desired` so nothing prunes it meanwhile
        }
        handler = new ChimeAccessory(this, accessory, {
          name: plan.name,
          serial: plan.deviceId,
          source: client,
        });
        this.chimeHandlers.set(id, handler);
      } else if (this.renameAccessory(id, plan.name)) {
        handler.setName(plan.name);
      }
      handler.update(plan);
    }

    this.pruneDomain('chime', 'no longer on the console', desired, new Set(chimes.map((c) => c.id)));
  }

  /** Discover cameras and create/prune their accessories, serialising overlapping requests. */
  private async syncCameras(): Promise<void> {
    if (!this.client || this.stopped) {
      return;
    }
    if (this.config.exposeCameras === false) {
      this.pruneDomain('camera', 'exposeCameras is off');
      return;
    }
    if (this.syncingCameras) {
      // Queue instead of dropping: a resync requested during a slow sync (e.g. the events
      // socket reconnected while the first discovery was still retrying) must still happen,
      // or we stay stale until the next reconnect — which may be hours away.
      this.resyncCameras = true;
      return;
    }
    this.syncingCameras = true;
    try {
      do {
        this.resyncCameras = false;
        await this.syncCamerasOnce();
        // Re-checked per iteration: a resync queued just before shutdown would otherwise issue one
        // more round of console requests after Homebridge asked us to stop.
      } while (this.resyncCameras && !this.stopped);
    } catch (err) {
      // Fire-and-forget callers (start/reconnect) can't catch — swallow so it can't crash.
      this.log.debug(`Camera sync error: ${(err as Error).message}`);
    } finally {
      this.syncingCameras = false;
    }
  }

  /**
   * One reconcile pass over the camera domain: read, filter, plan, apply, prune.
   *
   * Deliberately kept to that narrative — each step below is a named method, because this used to be
   * one 200-line function mixing console I/O, payload validation, filter diagnostics, HomeKit
   * accessory construction and pruning, and the shape of the pass was invisible inside it.
   */
  private async syncCamerasOnce(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const cameras = await this.readDeviceList('Camera', '/cameras', () => client.getCameras());
    if (!cameras || this.stopped) {
      return; // failed read, or shut down while we were awaiting the console
    }

    const streaming = this.config.exposeCameraStreams !== false;
    if (streaming && this.config.exposeCameraAudio === true) {
      await this.ensureAudioCodec();
    }
    this.warnIfTalkbackUnavailable();

    // Filter BEFORE planning, so an excluded camera produces no accessories of any kind — and so
    // its cached ones fall out of the prune loop below like any other camera that went away.
    const { selected, unmatched } = selectCameras(cameras, this.config);
    this.reportUnmatchedFilters(unmatched);

    const desired = new Set<string>();
    for (const plan of planCameraAccessories(selected, this.config)) {
      const camId = this.api.hap.uuid.generate(cameraKey(plan.deviceId));
      desired.add(camId);
      this.reportCameraReachability(plan.deviceId, plan.name, plan.online);
      this.reportDisabledDetections(plan);

      if (!this.cameraHandlers.has(camId)) {
        if (!this.createCameraHandler(plan, camId, streaming, client)) {
          continue; // HomeKit refused it; it stays in `desired` so nothing prunes it meanwhile
        }
      } else if (this.renameAccessory(camId, plan.name)) {
        // Renamed in Protect. The service label has to follow the accessory name, or HomeKit
        // keeps showing the old one — the alarm-side handlers do this on every refresh.
        this.cameraHandlers.get(camId)?.setName(plan.name);
      }
      this.applyCameraState(plan, camId);
      this.syncAudioSensors(plan, desired);
    }

    // `cameras`, not `selected`: a camera the console still reports but the filter excludes is a
    // config decision and goes at once, while a camera that truly vanished gets the grace period.
    this.pruneDomain('camera', 'no longer on the console', desired, new Set(cameras.map((c) => c.id)));
    this.forgetVanishedCameras(selected);
  }

  /**
   * Read one device class's list, or undefined when this pass must change nothing.
   *
   * Undefined covers BOTH a failed request and a successful one carrying an unusable body, because
   * they mean the same thing to the caller: we do not know what exists, so touch nothing.
   *
   * Shared by the camera and chime reconcilers deliberately. The policy is small but subtle — an
   * unreadable payload must never be read as "no devices", because each reconciler prunes against
   * what it just read, so an empty list would unregister the user's accessories and take their rooms
   * and automations with them. Two copies of that rule DID drift: the chime copy never checked the
   * payload shape at all, which crashed the whole bridge, and its error path forgot the debug
   * fallback so repeat failures logged nothing. One implementation cannot diverge from itself.
   */
  private async readDeviceList<T extends { id: string }>(
    label: 'Camera' | 'Chime',
    path: string,
    fetch: () => Promise<T[]>,
  ): Promise<T[] | undefined> {
    const healthy = this.discoveryOk.get(label) !== false;
    let devices: unknown;
    try {
      devices = await fetch();
    } catch (err) {
      // Surface the FIRST failure: a user whose devices never appear should not have to switch on
      // debug logging to find out why. Repeats stay quiet until it recovers.
      const message = `${label} discovery failed: ${(err as Error).message}`;
      if (healthy) {
        this.discoveryOk.set(label, false);
        this.log.warn(`${message}. Will keep retrying.`);
      } else {
        this.log.debug(message);
      }
      // Any failure restarts the stability window: whatever the next successful read says, it is
      // the first one after a disruption and must not be trusted to delete anything.
      this.discoveryHealthySince.delete(label);
      return undefined;
    }
    if (this.stopped) {
      return undefined; // shut down while we were awaiting the console
    }
    if (!isDeviceList(devices)) {
      if (healthy) {
        this.discoveryOk.set(label, false);
        this.log.warn(
          `${label} discovery returned data this plugin could not read, so this pass was skipped and ` +
            `your ${label.toLowerCase()}s were left as they are. Will keep retrying. Turn on debug ` +
            'logging to see the payload.',
        );
      }
      this.log.debug(`Unusable ${path} payload: ${redactPayload(devices)}`);
      this.discoveryHealthySince.delete(label);
      return undefined;
    }
    if (!healthy) {
      this.discoveryOk.set(label, true);
      this.log.info(`${label} discovery recovered.`);
    }
    // Stamped on the FIRST healthy read and left alone while it stays healthy, so this measures how
    // long the class has been continuously good — not how long since the last pass.
    if (!this.discoveryHealthySince.has(label)) {
      this.discoveryHealthySince.set(label, this.deps.now());
    }
    // Justified by the guard above: it proves every entry is an object with a string id, which is
    // all this function promises. Field-level shape is each planner's business.
    return devices as T[];
  }

  /**
   * Talkback needs an audio session to ride on. Warned once rather than silently omitting the
   * microphone button and leaving the user to guess why.
   */
  private warnIfTalkbackUnavailable(): void {
    if (this.config.exposeTalkback === true && !this.audioCodec && !this.warnedTalkback) {
      this.warnedTalkback = true;
      this.log.warn(
        'exposeTalkback is on but camera audio is not available, so two-way audio is disabled. ' +
          'Enable exposeCameraAudio (and check the startup log for the audio codec probe result).',
      );
    }
  }

  /**
   * Report include/exclude entries that matched nothing, once each.
   *
   * A typo silently exposes no cameras (include) or exposes one meant to stay private (exclude),
   * and both read as a plugin fault with nothing in the log to explain them.
   */
  private reportUnmatchedFilters(unmatched: string[]): void {
    for (const entry of unmatched) {
      if (this.warnedUnmatchedCameras.has(entry)) {
        continue;
      }
      this.warnedUnmatchedCameras.add(entry);
      this.log.warn(
        `Camera filter entry "${entry}" matches no camera on this console. ` +
          'Use the camera\'s name or device ID exactly as Protect reports it.',
      );
    }
  }

  /**
   * A supported-but-switched-off detection type can never fire; say so once, or the user is left
   * staring at a sensor that looks broken when it is actually just disabled in Protect.
   */
  private reportDisabledDetections(plan: CameraPlan): void {
    if (plan.disabledObjectTypes.length && !this.warnedDisabledDetections.has(plan.deviceId)) {
      this.warnedDisabledDetections.add(plan.deviceId);
      this.log.info(
        `"${plan.name}": ${plan.disabledObjectTypes.join(', ')} detection is turned off in Protect, ` +
          'so those sensors will never trigger. Enable it in Protect > camera > Smart Detections.',
      );
    }
  }

  /** Create the accessory and handler for a camera. False when HomeKit refused to register it. */
  private createCameraHandler(
    plan: CameraPlan,
    camId: string,
    streaming: boolean,
    client: ProtectClient,
  ): boolean {
    const { Categories } = this.api.hap;
    const opts = {
      name: plan.name,
      serial: plan.deviceId,
      isDoorbell: plan.isDoorbell,
      doorbellTrigger: this.config.exposeDoorbellTriggers === true,
      streaming,
      source: client,
      audioCodec: this.audioCodec,
      // Talkback rides on the audio path: without a codec there is no audio session for
      // HomeKit to send a microphone over, so requesting it alone cannot work.
      //
      // Also gated on the camera actually HAVING a speaker, decided from data discovery already
      // fetched. Asking a speakerless camera answers 503, which the retry policy treated as
      // transient — measured ~7s of backoff, all of it blocking video from starting. On observed
      // hardware only the doorbell has a speaker.
      talkback: this.config.exposeTalkback === true && !!this.audioCodec && plan.hasSpeaker,
      // Screen messages only make sense on a device with a screen. planDoorbellMessages
      // returns nothing unless the feature is switched on, so a non-doorbell costs nothing.
      messages: plan.isDoorbell ? planDoorbellMessages(this.config) : [],
      messageSink: client,
      // Only cameras that report a controllable LED; the rest silently ignore the write.
      statusLed: this.config.exposeStatusLed === true && plan.hasStatusLed,
      // The smart-detect sensors are contact services on THIS accessory, so a camera is one
      // HomeKit accessory however many detection types it supports. See CameraAccessory.
      objectTypes: plan.objectTypes,
    };
    // Cameras are bridged like everything else: they appear automatically with the bridge,
    // are cached/restored across restarts, and prune normally. (Publishing them as external
    // accessories — which costs the user a manual add each — was tried and is NOT required;
    // HomeKit streams a bridged camera fine. Verified end to end on real hardware.)
    const category = streaming
      ? opts.isDoorbell
        ? Categories.VIDEO_DOORBELL
        : Categories.CAMERA
      : Categories.SENSOR;
    const accessory = this.acquireAccessory(camId, plan.name, category, 'camera', plan.deviceId);
    if (!accessory) {
      return false;
    }
    this.cameraHandlers.set(camId, new CameraAccessory(this, accessory, opts));
    return true;
  }

  /** Push the console's current state for one camera onto its handler. */
  private applyCameraState(plan: CameraPlan, camId: string): void {
    const handler = this.cameraHandlers.get(camId);
    if (!handler) {
      return;
    }
    // Reconcile every pass, not just at construction: a detection type switched off in Protect,
    // or one a firmware update adds, is picked up without a Homebridge restart.
    //
    // Deliberately unconditional, which makes it redundant on the pass that just built the
    // handler (the constructor already applied `opts.objectTypes`). Mutation-testing confirms
    // that: emptying the constructor's copy fails nothing, because this line puts them back. The
    // redundancy is the point — one line guarantees the invariant on every branch, where calling
    // it only in the `else` would mean two places had to agree forever. Keep both: the
    // constructor's copy is what makes a CameraAccessory correct standalone, which is how the
    // unit tests build one.
    handler.setObjectTypes(plan.objectTypes);
    handler.setOnline(plan.online);
    // The console is the source of truth for the screen: a message set in the Protect app should
    // show up on the matching HomeKit switch.
    handler.updateMessages(plan.lcdMessage);
    handler.updateStatusLed(plan.statusLedOn);
  }

  /**
   * Reconcile the native smoke / CO sensors a camera's audio detection warrants.
   *
   * These stay SEPARATE accessories rather than services on the camera, unlike the smart-detect
   * sensors: HomeKit treats a native SmokeSensor as a critical alert, which is the only reason to
   * expose one at all, and it only gets that treatment as an accessory in its own right.
   */
  private syncAudioSensors(plan: CameraPlan, desired: Set<string>): void {
    const { Categories, uuid } = this.api.hap;
    for (const kind of plan.alarmKinds) {
      const alarmId = uuid.generate(audioSensorKey(plan.deviceId, kind));
      desired.add(alarmId);
      const name = `${plan.name} ${alarmKindLabel(kind)}`;
      if (!this.alarmHandlers.has(alarmId)) {
        // The camera's device ID, not a per-sensor one: these live and die with their camera, so
        // the prune loop should judge them by whether that camera is still on the console.
        const accessory = this.acquireAccessory(alarmId, name, Categories.SENSOR, 'camera', plan.deviceId);
        if (!accessory) {
          continue; // registration failed; it stays in `desired` so nothing prunes it meanwhile
        }
        this.alarmHandlers.set(
          alarmId,
          new AlarmSensorAccessory(this, accessory, { name, serial: `${plan.deviceId}:${kind}`, kind }),
        );
      } else if (this.renameAccessory(alarmId, name)) {
        this.alarmHandlers.get(alarmId)?.setName(name);
      }
      this.alarmHandlers.get(alarmId)?.setOnline(plan.online);
    }
  }

  /**
   * Forget per-device warning and reachability state for cameras that no longer exist, so these
   * sets track the live camera list rather than everything ever seen.
   *
   * Keyed off the SELECTED list, not every camera on the console: a filtered-out camera is never
   * reported on again, so holding its warning state would keep it alive for the process lifetime.
   */
  private forgetVanishedCameras(selected: Camera[]): void {
    const liveDevices = new Set(selected.map((c) => c.id));
    for (const set of [this.offlineCameras, this.warnedDisabledDetections, this.warnedRingDevices]) {
      for (const deviceId of set) {
        if (!liveDevices.has(deviceId)) {
          set.delete(deviceId);
        }
      }
    }
  }

  /**
   * Probe ffmpeg's audio encoders once, before any CameraController is built.
   *
   * Must happen before accessory creation: the controller advertises the codec at construction,
   * and advertising one the delegate cannot deliver makes iOS refuse to render video at all.
   */
  private async ensureAudioCodec(): Promise<void> {
    if (this.audioReported) {
      return;
    }
    // No local "already probed" flag guarding the await: setting one before awaiting would let a
    // concurrent caller see "probed" while the result was still undefined, and quietly build a
    // CameraController with no audio. probeAudioCodec caches the PROMISE, so awaiting it repeatedly
    // costs nothing and always yields the same answer.
    this.audioCodec = await this.deps.probeAudioCodec(resolveFfmpegPath());
    this.audioReported = true;
    if (this.audioCodec) {
      this.log.info(`Camera audio enabled using ${this.audioCodec.encoder} (${this.audioCodec.hapCodec}).`);
    } else {
      this.log.warn(
        'Camera audio is switched on, but this ffmpeg cannot encode a codec HomeKit accepts ' +
          '(needs AAC-ELD via libfdk_aac, or Opus via libopus). Streaming video only.',
      );
    }
  }

  /** Stop whatever background work the handler at `uuid` holds, whichever domain it belongs to. */
  /**
   * Unregister every accessory in a domain.
   *
   * Called when a feature is switched off or was never configured. Returning early WITHOUT this
   * leaves a cached accessory registered with no handler bound: HomeKit keeps showing the tile at
   * whatever value it last cached and silently discards writes, which is exactly the "control that
   * looks functional but cannot work" failure. Reconciling to an empty set is the only safe way to
   * skip a domain.
   */
  private pruneDomain(
    domain: 'camera' | 'chime',
    reason: string,
    keep?: Set<string>,
    onConsole?: Set<string>,
  ): void {
    // A device that came back cancels its pending removal. Done before the sweep so a device that
    // reappeared in this very pass can never be removed by it.
    for (const id of keep ?? []) {
      if (this.pendingRemovals.delete(id)) {
        this.log.info(`"${this.accessories.get(id)?.displayName ?? id}" is back; it will not be removed.`);
      }
    }
    // Snapshot: unregistering mutates the map we are iterating.
    for (const [id, accessory] of [...this.accessories]) {
      if (accessory.context.domain !== domain || keep?.has(id)) {
        continue;
      }
      const deviceId = (accessory.context as { deviceId?: unknown }).deviceId;
      const stillOnConsole = typeof deviceId === 'string' && onConsole?.has(deviceId) === true;
      if (keep && this.deferRemoval(domain, id, accessory.displayName, stillOnConsole)) {
        continue;
      }
      this.removeAccessory(domain, id, accessory, reason);
    }
  }

  /**
   * Whether this accessory's removal should wait, marking it on the first sighting.
   *
   * Only reconcile-driven removals are deferred. A prune with no `keep` set is the user switching a
   * feature off, and a device the console still reports but config now excludes (`stillOnConsole`)
   * is the user editing a filter — both are explicit intent with a deterministic answer, so they
   * take effect at once. Leaving those lingering would be its own bug: an accessory the plugin no
   * longer drives is a control that looks functional and cannot work.
   *
   * An accessory cached before this version carries no device ID, so `stillOnConsole` is false and
   * it takes the graced path. That is the right way round to be wrong: the cost is a late removal,
   * where the other way costs the user their automations.
   */
  private deferRemoval(
    domain: 'camera' | 'chime',
    uuid: string,
    name: string,
    stillOnConsole: boolean,
  ): boolean {
    const graceMs = this.removalGraceMs();
    if (graceMs <= 0 || stillOnConsole) {
      this.pendingRemovals.delete(uuid);
      return false;
    }
    const now = this.deps.now();
    const deadline = this.pendingRemovals.get(uuid);
    if (deadline === undefined) {
      this.pendingRemovals.set(uuid, now + graceMs);
      this.log.info(
        `"${name}" is no longer reported by the console. Waiting ${Math.round(graceMs / 1000)}s ` +
          'before removing it, in case the console is only mid-restart.',
      );
      return true;
    }
    if (now < deadline) {
      return true;
    }
    // Gone long enough — but only act on a console that has been steady since. A read taken just
    // after a reconnect is exactly the one most likely to be short.
    if (!this.discoveryStable(domain)) {
      this.log.debug(`Removal of "${name}" is due, but ${domain} discovery has not been steady long enough.`);
      return true;
    }
    return false;
  }

  /** The configured removal grace in ms. Non-numeric or negative config falls back to the default. */
  private removalGraceMs(): number {
    const configured = Number(this.config.deviceRemovalDelay);
    const seconds = Number.isFinite(configured) && configured >= 0 ? configured : DEVICE_REMOVAL_GRACE_SECONDS;
    return seconds * 1000;
  }

  /** True once this device class's discovery has been healthy for the full stability window. */
  private discoveryStable(domain: 'camera' | 'chime'): boolean {
    const since = this.discoveryHealthySince.get(domain === 'camera' ? 'Camera' : 'Chime');
    return since !== undefined && this.deps.now() - since >= REMOVAL_STABILITY_SECONDS * 1000;
  }

  /** Shut the handler down, unregister the accessory, and forget every trace of it. */
  private removeAccessory(
    domain: 'camera' | 'chime',
    uuid: string,
    accessory: PlatformAccessory,
    reason: string,
  ): void {
    this.shutdownHandler(uuid);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.delete(uuid);
    this.pendingRemovals.delete(uuid);
    // EVERY handler map, not just the domain's obvious one: an entry left behind is a handler
    // realtime routing can still find, writing to an accessory HomeKit no longer has.
    this.cameraHandlers.delete(uuid);
    this.alarmHandlers.delete(uuid);
    this.chimeHandlers.delete(uuid);
    this.log.info(`Removed ${domain} accessory "${accessory.displayName}" (${reason}).`);
  }

  private shutdownHandler(uuid: string): void {
    try {
      this.cameraHandlers.get(uuid)?.shutdown();
      this.alarmHandlers.get(uuid)?.shutdown();
      this.chimeHandlers.get(uuid)?.shutdown();
    } catch (err) {
      this.log.debug(`Handler shutdown failed: ${(err as Error).message}`);
    }
  }

  /** Log a camera going offline/online, once per transition rather than once per discovery pass. */
  private reportCameraReachability(deviceId: string, name: string, online: boolean): void {
    if (online === !this.offlineCameras.has(deviceId)) {
      return;
    }
    if (online) {
      this.offlineCameras.delete(deviceId);
      this.log.info(`Camera "${name}" is back online.`);
    } else {
      this.offlineCameras.add(deviceId);
      this.log.warn(`Camera "${name}" is disconnected in Protect; marking it unavailable in HomeKit.`);
    }
  }

  /**
   * Follow a rename made in Protect through to the HomeKit accessory.
   * Returns true if it actually changed, so the caller can also relabel the services.
   */
  private renameAccessory(uuid: string, name: string): boolean {
    const accessory = this.accessories.get(uuid);
    if (!accessory || accessory.displayName === name) {
      return false;
    }
    const previous = accessory.displayName;
    accessory.displayName = name;
    this.api.updatePlatformAccessories([accessory]);
    this.log.info(`Renamed accessory "${previous}" to "${name}".`);
    return true;
  }

  /**
   * Get-or-create a registered accessory tagged with its device domain.
   *
   * The domain is what keeps the reconcilers from deleting each other's work: each one only prunes
   * accessories it owns. Chimes get their own domain rather than borrowing the cameras' — sharing it
   * would mean the camera prune had to special-case every non-camera accessory it encountered.
   */
  /**
   * The accessory for `uuid`, creating and registering it if HomeKit does not have it yet.
   *
   * Returns undefined when it could not be registered, and the caller skips that device for this
   * pass. Registration comes BEFORE the bookkeeping, and that order is load-bearing: caching first
   * meant a failed registration left the plugin believing the accessory existed while HomeKit had
   * never received it — and because the cache hit short-circuits, it was never retried. One
   * transient failure hid a camera permanently, with nothing in the log. Not caching a failure lets
   * the next discovery pass simply try again.
   */
  private acquireAccessory(
    uuid: string,
    name: string,
    category: number,
    domain: 'camera' | 'chime' = 'camera',
    deviceId?: string,
  ): PlatformAccessory | undefined {
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid, category);
      accessory.context.domain = domain;
      // Recorded so the prune loop can tell "the console no longer reports this device" from "config
      // now filters it out" — the first deserves a grace period, the second does not.
      accessory.context.deviceId = deviceId;
      try {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } catch (err) {
        // Reported per device rather than once globally: which accessory failed is the whole of
        // the diagnostic, and the next pass retries so this is not a permanent state.
        this.log.warn(
          `HomeKit refused the accessory "${name}": ${(err as Error).message}. Will retry on the ` +
            'next discovery pass.',
        );
        return undefined;
      }
      this.accessories.set(uuid, accessory);
      this.log.info(`Added accessory "${name}".`);
    } else {
      accessory.context.domain = domain; // ensure a restored cached accessory is tagged
      // Backfill for accessories cached before device IDs were recorded, so they stop taking the
      // conservative unknown-device path on the very next pass.
      accessory.context.deviceId = deviceId;
      // Category is baked into the cached accessory. Turning `exposeCameraStreams` on for a
      // camera that was first discovered as a plain sensor would otherwise leave it showing a
      // sensor tile forever, because reuse skipped the constructor that sets this.
      if (accessory.category !== category) {
        accessory.category = category;
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    return accessory;
  }

  /** Route a realtime event to the matching camera / object-sensor handler. */
  private routeEvent(event: ProtectEvent): void {
    // Decode once. This runs for every frame on the events feed, including the alarm hub's own
    // events, so it is the one genuinely hot path in the plugin.
    const detections = decodeCameraEvent(event);
    if (detections.length === 0) {
      this.noteUnhandledEvent(event);
      return;
    }
    for (const d of detections) {
      this.log.debug(`[camera] ${d.kind} ${d.active ? 'start' : 'end'} on ${d.deviceId}`);
      if (d.kind === 'motion' || d.kind === 'ring') {
        const handler = this.cameraHandlers.get(this.api.hap.uuid.generate(cameraKey(d.deviceId)));
        if (!handler) {
          this.noteUnroutedDetection(`${d.deviceId}:${d.kind}`, `${d.kind} from unknown camera ${d.deviceId}`);
          continue;
        }
        // A ring from a camera we didn't detect as a doorbell would be silently dropped —
        // warn once so the user can add it to "doorbellDeviceIds".
        if (d.kind === 'ring' && d.active && !handler.canRing && !this.warnedRingDevices.has(d.deviceId)) {
          this.warnedRingDevices.add(d.deviceId);
          this.log.warn(`Ring from a camera not detected as a doorbell (${d.deviceId}); add it to "doorbellDeviceIds" to expose a doorbell.`);
        }
        handler.applyDetection(d.kind, d.active);
      } else if (isAudioDetection(d.kind)) {
        // Smoke / CO. One Protect type can drive two HomeKit sensors (a combined smoke+CO alarm),
        // and two types can drive the same one, so fan out over the mapped services.
        let routed = false;
        for (const kind of sensorKindsFor(d.kind)) {
          const handler = this.alarmHandlers.get(this.api.hap.uuid.generate(audioSensorKey(d.deviceId, kind)));
          if (handler) {
            handler.applyDetection(d.active);
            routed = true;
          }
        }
        if (!routed) {
          this.noteUnroutedDetection(
            `${d.deviceId}:${d.kind}`,
            `"${d.kind}" audio detection from ${d.deviceId} has no sensor — turn on "exposeAudioSensors" ` +
              'to expose smoke/CO sensors for it.',
          );
        }
      } else {
        // A smart detection is a contact service on the camera's own accessory, so one lookup
        // reaches it. This is the plugin's only hot path.
        const camera = this.cameraHandlers.get(this.api.hap.uuid.generate(cameraKey(d.deviceId)));
        if (camera?.hasObjectSensor(d.kind)) {
          camera.applyObjectDetection(d.kind, d.active);
          continue;
        }
        this.noteUnroutedDetection(
          `${d.deviceId}:${d.kind}`,
          `"${d.kind}" detection from ${d.deviceId} has no sensor — the camera does not advertise that ` +
            'detection type. Restart Homebridge if you just enabled it in Protect.',
        );
      }
    }
  }

  /**
   * Record a camera event we produced nothing from — once per type, with the payload.
   *
   * Most are the alarm hub's own events sharing this feed, hence debug rather than warn. The
   * point is diagnostic: a detection the user expects but never sees in HomeKit is otherwise
   * indistinguishable from one Protect never sent, and this captures the real shape either way.
   *
   * The payload goes through `redactPayload` because these events are not ours and we do not
   * control what they contain — alarm-hub entry events, which arrive on this very feed, carry
   * the keypad PIN in `metadata.pin`, and debug logs end up in bug reports.
   */
  private noteUnhandledEvent(event: ProtectEvent): void {
    const type = event.item?.type;
    if (!type || this.seenUnhandledEvents.has(type)) {
      return;
    }
    this.seenUnhandledEvents.add(type);
    this.log.debug(`[events] no camera detection decoded from "${type}": ${redactPayload(event.item)}`);
  }

  /** A detection that decoded fine but has nowhere to go — a real gap, so warn (once). */
  private noteUnroutedDetection(key: string, message: string): void {
    if (this.warnedUnrouted.has(key)) {
      return;
    }
    this.warnedUnrouted.add(key);
    this.log.warn(message);
  }
}
