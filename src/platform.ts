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
import type { AccessoryHandler, AlarmHub, ProtectEvent } from './types';
import { SecuritySystemAccessory } from './accessories/securitySystem';
import { HubAccessory, ReadonlyContactAccessory, ZoneAccessory } from './accessories/sensors';
import { AlarmSensorAccessory, CameraAccessory, ObjectSensorAccessory } from './accessories/camera';
import { ChimeAccessory } from './accessories/chime';
import { chimeKey, planChimeAccessories } from './chimeDiscovery';
import { planAccessories, type PlannedAccessory } from './discovery';
import { basePollSeconds, effectivePollSeconds } from './pollPolicy';
import { audioSensorKey, cameraKey, objectSensorKey, objectSensorName, planCameraAccessories } from './cameraDiscovery';
import { decodeCameraEvent } from './cameraEvents';
import { alarmKindLabel, isAudioDetection, sensorKindsFor } from './detectionKinds';
import { redactPayload } from './util';
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

/**
 * How often to re-discover the non-alarm devices (cameras, chimes).
 *
 * These used to be discovered only at startup and on an events-socket reconnect, so a device added,
 * renamed, or unplugged in Protect could go unnoticed for hours. It is one request per device class
 * per interval, so it stays cheap against the console's ~10 req/s budget.
 */
const DEVICE_DISCOVERY_SECONDS = 300;

/**
 * The I/O boundaries the platform owns, injectable so discovery, reconcile and the poll
 * cadence can be unit-tested without a console or real timers — the same pattern
 * {@link ProtectClient}'s `deps` uses. Homebridge never passes this; production gets
 * {@link REAL_PLATFORM_DEPS}.
 */
export interface PlatformDeps {
  createClient: (opts: ProtectClientOptions) => ProtectClient;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
}

const REAL_PLATFORM_DEPS: PlatformDeps = {
  createClient: (opts) => new ProtectClient(opts),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
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
  private readonly objectHandlers = new Map<string, ObjectSensorAccessory>();
  /** Native smoke / CO sensors driven by the cameras' audio detection, keyed by accessory UUID. */
  private readonly alarmHandlers = new Map<string, AlarmSensorAccessory>();
  private readonly chimeHandlers = new Map<string, ChimeAccessory>();
  private chimeDiscoveryOk = true;
  /** Talkback-without-audio is warned about once, not on every discovery pass. */
  private warnedTalkback = false;
  private disposeEvents?: () => void;
  private syncingCameras = false;
  private resyncCameras = false;
  private cameraDiscoveryOk = true;
  private readonly warnedTypes = new Set<string>();
  private readonly warnedRingDevices = new Set<string>();
  private readonly warnedDisabledDetections = new Set<string>();
  /** Event types we've already reported as undecodable, so the log stays one line per type. */
  private readonly seenUnhandledEvents = new Set<string>();
  /** Detections that decoded but had no handler, keyed device:kind — warned once each. */
  private readonly warnedUnrouted = new Set<string>();
  /** Cameras currently reported offline, so the log records transitions rather than every pass. */
  private readonly offlineCameras = new Set<string>();
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
        void this.syncDevices();
        // Detections arrive over the events socket, but a device being added, renamed, or going
        // offline does not — that only shows up in a discovery pass.
        this.cameraTimer = this.deps.setInterval(() => void this.syncDevices(), DEVICE_DISCOVERY_SECONDS * 1000);
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
      ...this.cameraHandlers.keys(), ...this.objectHandlers.keys(),
      ...this.alarmHandlers.keys(), ...this.chimeHandlers.keys(),
    ]) {
      this.shutdownCameraHandler(uuid);
    }
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
    let chimes;
    try {
      chimes = await client.getChimes();
    } catch (err) {
      if (this.chimeDiscoveryOk) {
        this.chimeDiscoveryOk = false;
        this.log.warn(`Chime discovery failed: ${(err as Error).message}. Will keep retrying.`);
      }
      return;
    }
    if (this.stopped) {
      return;
    }
    if (!this.chimeDiscoveryOk) {
      this.chimeDiscoveryOk = true;
      this.log.info('Chime discovery recovered.');
    }

    const { Categories, uuid } = this.api.hap;
    const desired = new Set<string>();
    for (const plan of planChimeAccessories(chimes, this.config)) {
      const id = uuid.generate(chimeKey(plan.deviceId));
      desired.add(id);
      let handler = this.chimeHandlers.get(id);
      if (!handler) {
        const accessory = this.acquireAccessory(id, plan.name, Categories.SWITCH, 'chime');
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

    for (const [id, accessory] of this.accessories) {
      if (accessory.context.domain === 'chime' && !desired.has(id)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(id);
        this.chimeHandlers.delete(id);
        this.log.info(`Removed chime accessory "${accessory.displayName}".`);
      }
    }
  }

  /** Discover cameras and create/prune their accessories (overall motion, doorbell, object sensors). */
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
      } while (this.resyncCameras);
    } catch (err) {
      // Fire-and-forget callers (start/reconnect) can't catch — swallow so it can't crash.
      this.log.debug(`Camera sync error: ${(err as Error).message}`);
    } finally {
      this.syncingCameras = false;
    }
  }

  private async syncCamerasOnce(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    let cameras;
    try {
      cameras = await client.getCameras();
    } catch (err) {
      // Surface the first failure: a user whose cameras never appear should not have to switch
      // on debug logging to find out why. Subsequent failures stay quiet until it recovers.
      if (this.cameraDiscoveryOk) {
        this.cameraDiscoveryOk = false;
        this.log.warn(`Camera discovery failed: ${(err as Error).message}. Will keep retrying.`);
      } else {
        this.log.debug(`Camera discovery failed: ${(err as Error).message}`);
      }
      return;
    }
    if (this.stopped) {
      return; // shut down while we were awaiting the console
    }
    if (!this.cameraDiscoveryOk) {
      this.cameraDiscoveryOk = true;
      this.log.info('Camera discovery recovered.');
    }

    const { Categories, uuid } = this.api.hap;
    const streaming = this.config.exposeCameraStreams !== false;
    if (streaming && this.config.exposeCameraAudio === true) {
      await this.ensureAudioCodec();
    }
    // Talkback needs an audio session to ride on. Warn once rather than silently omitting the
    // microphone button and leaving the user to guess why.
    if (this.config.exposeTalkback === true && !this.audioCodec && !this.warnedTalkback) {
      this.warnedTalkback = true;
      this.log.warn(
        'exposeTalkback is on but camera audio is not available, so two-way audio is disabled. ' +
          'Enable exposeCameraAudio (and check the startup log for the audio codec probe result).',
      );
    }
    const desired = new Set<string>();

    for (const plan of planCameraAccessories(cameras, this.config)) {
      const camId = uuid.generate(cameraKey(plan.deviceId));
      desired.add(camId);
      this.reportCameraReachability(plan.deviceId, plan.name, plan.online);
      // A supported-but-switched-off detection type can never fire; say so once, or the user is
      // left staring at a sensor that looks broken when it is actually just disabled in Protect.
      if (plan.disabledObjectTypes.length && !this.warnedDisabledDetections.has(plan.deviceId)) {
        this.warnedDisabledDetections.add(plan.deviceId);
        this.log.info(
          `"${plan.name}": ${plan.disabledObjectTypes.join(', ')} detection is turned off in Protect, ` +
            'so those sensors will never trigger. Enable it in Protect > camera > Smart Detections.',
        );
      }
      if (!this.cameraHandlers.has(camId)) {
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
          talkback: this.config.exposeTalkback === true && !!this.audioCodec,
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
        const accessory = this.acquireAccessory(camId, plan.name, category);
        this.cameraHandlers.set(camId, new CameraAccessory(this, accessory, opts));
      } else if (this.renameAccessory(camId, plan.name)) {
        // Renamed in Protect. The service label has to follow the accessory name, or HomeKit
        // keeps showing the old one — the alarm-side handlers do this on every refresh.
        this.cameraHandlers.get(camId)?.setName(plan.name);
      }
      this.cameraHandlers.get(camId)?.setOnline(plan.online);
      for (const type of plan.objectTypes) {
        const objId = uuid.generate(objectSensorKey(plan.deviceId, type));
        desired.add(objId);
        const name = objectSensorName(plan.name, type);
        if (!this.objectHandlers.has(objId)) {
          const accessory = this.acquireAccessory(objId, name, Categories.SENSOR);
          this.objectHandlers.set(objId, new ObjectSensorAccessory(this, accessory, { name, serial: `${plan.deviceId}:${type}` }));
        } else if (this.renameAccessory(objId, name)) {
          // These names are derived from the camera's, so a camera rename renames them all.
          this.objectHandlers.get(objId)?.setName(name);
        }
        this.objectHandlers.get(objId)?.setOnline(plan.online);
      }
      for (const kind of plan.alarmKinds) {
        const alarmId = uuid.generate(audioSensorKey(plan.deviceId, kind));
        desired.add(alarmId);
        const name = `${plan.name} ${alarmKindLabel(kind)}`;
        if (!this.alarmHandlers.has(alarmId)) {
          const accessory = this.acquireAccessory(alarmId, name, Categories.SENSOR);
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

    // Prune camera-domain accessories that are no longer present.
    for (const [id, accessory] of this.accessories) {
      if (accessory.context.domain === 'camera' && !desired.has(id)) {
        // Shut the handler down BEFORE dropping it: a pruned camera can have a live ffmpeg
        // transcode and a pending motion safety-clear, and once the map entry is gone nothing
        // can ever reach them again — the process would survive until Homebridge restarts.
        this.shutdownCameraHandler(id);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(id);
        this.cameraHandlers.delete(id);
        this.objectHandlers.delete(id);
        this.alarmHandlers.delete(id);
        this.log.info(`Removed camera accessory "${accessory.displayName}".`);
      }
    }
    // Forget per-device warning/reachability state for cameras that no longer exist, so these
    // sets track the live camera list rather than everything ever seen.
    const liveDevices = new Set(cameras.map((c) => c.id));
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
    this.audioCodec = await probeAudioCodec(resolveFfmpegPath());
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

  /** Stop a camera or object-sensor handler's background work, whichever kind it is. */
  /**
   * Unregister every accessory in a domain.
   *
   * Called when a feature is switched off or was never configured. Returning early WITHOUT this
   * leaves a cached accessory registered with no handler bound: HomeKit keeps showing the tile at
   * whatever value it last cached and silently discards writes, which is exactly the "control that
   * looks functional but cannot work" failure. Reconciling to an empty set is the only safe way to
   * skip a domain.
   */
  private pruneDomain(domain: 'camera' | 'chime', reason: string): void {
    // Snapshot: unregistering mutates the map we are iterating.
    for (const [id, accessory] of [...this.accessories]) {
      if (accessory.context.domain !== domain) {
        continue;
      }
      this.shutdownCameraHandler(id);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(id);
      this.cameraHandlers.delete(id);
      this.chimeHandlers.delete(id);
      this.objectHandlers.delete(id);
      this.log.info(`Removed ${domain} accessory "${accessory.displayName}" (${reason}).`);
    }
  }

  private shutdownCameraHandler(uuid: string): void {
    try {
      this.cameraHandlers.get(uuid)?.shutdown();
      this.objectHandlers.get(uuid)?.shutdown();
      this.alarmHandlers.get(uuid)?.shutdown();
      this.chimeHandlers.get(uuid)?.shutdown();
    } catch (err) {
      this.log.debug(`Camera shutdown failed: ${(err as Error).message}`);
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
  private acquireAccessory(
    uuid: string,
    name: string,
    category: number,
    domain: 'camera' | 'chime' = 'camera',
  ): PlatformAccessory {
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid, category);
      accessory.context.domain = domain;
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added accessory "${name}".`);
    } else {
      accessory.context.domain = domain; // ensure a restored cached accessory is tagged
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
        const objectHandler = this.objectHandlers.get(this.api.hap.uuid.generate(objectSensorKey(d.deviceId, d.kind)));
        if (!objectHandler) {
          this.noteUnroutedDetection(
            `${d.deviceId}:${d.kind}`,
            `"${d.kind}" detection from ${d.deviceId} has no sensor — the camera does not advertise that ` +
              'detection type. Restart Homebridge if you just enabled it in Protect.',
          );
          continue;
        }
        objectHandler.applyDetection(d.active);
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
