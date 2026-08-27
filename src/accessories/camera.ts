import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { UnifiProtectPlatform } from '../platform';
import type { DetectionKind } from '../cameraEvents';
import type { SensorKind } from '../detectionKinds';
import { ProtectStreamingDelegate, type StreamSource } from '../streaming/streamingDelegate';
import { buildCameraController } from '../streaming/cameraOptions';
import {
  activeMessageKey, clearMessagePatch, setMessagePatch, type MessagePlan,
} from '../doorbellMessages';
import { objectSensorName } from '../cameraDiscovery';
import type { CameraSettingsPatch, LcdMessage } from '../types';

/** HAP subtype for the doorbell-trigger switch, so message switches can coexist with it. */
const TRIGGER_SUBTYPE = 'trigger';
/** HAP subtype prefix for a doorbell-screen message switch. */
const MESSAGE_SUBTYPE = 'msg';
/** HAP subtype for the status-light switch. */
const LED_SUBTYPE = 'led';
import { resolveFfmpegPath } from '../streaming/ffmpegPath';
import type { AudioCodecChoice } from '../streaming/audioCodec';

/** Injectable timers so the motion safety-clear is unit-testable. */
export interface Timers {
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

export const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.(); // a pending safety-clear must never hold the process open at shutdown
    return handle;
  },
  clear: (handle) => clearTimeout(handle),
};

/** If an 'end' event is missed (e.g. lost across a reconnect), clear the detection after this long. */
const MOTION_SAFETY_CLEAR_MS = 60_000;

/**
 * A characteristic that latches when a detection starts and auto-clears if its 'end' never arrives.
 *
 * ONE implementation for all three kinds of detection sensor — motion, the per-type contact sensors,
 * and the smoke/CO alarms. They differ only in which characteristic they drive and what its
 * "tripped" and "clear" values are; the auto-clear is the part worth not duplicating, because a
 * missed 'end' event leaves a sensor stuck reporting a detection and firing automations forever, and
 * three separate copies of that reasoning had already accumulated.
 */
class LatchingCharacteristic {
  private handle?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly service: Service,
    private readonly characteristic: WithUUID<new () => Characteristic>,
    private readonly trippedValue: CharacteristicValue,
    private readonly clearValue: CharacteristicValue,
    private readonly timers: Timers,
  ) {}

  set(active: boolean): void {
    this.cancel();
    this.service.updateCharacteristic(this.characteristic, active ? this.trippedValue : this.clearValue);
    if (active) {
      this.handle = this.timers.set(() => {
        this.handle = undefined;
        this.service.updateCharacteristic(this.characteristic, this.clearValue);
      }, MOTION_SAFETY_CLEAR_MS);
    }
  }

  /** Seed the cleared value without arming a timer — for construction, see CameraAccessory. */
  seedClear(): void {
    this.service.updateCharacteristic(this.characteristic, this.clearValue);
  }

  /** Cancel any pending safety-clear (shutdown, or a superseding write). */
  cancel(): void {
    if (this.handle) {
      this.timers.clear(this.handle);
      this.handle = undefined;
    }
  }
}

/** A MotionDetected characteristic driven by start/end detections, with a safety auto-clear. */
class MotionController {
  private readonly latch: LatchingCharacteristic;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    private readonly service: Service,
    timers: Timers,
  ) {
    const C = platform.Characteristic;
    this.latch = new LatchingCharacteristic(service, C.MotionDetected, true, false, timers);
  }

  /**
   * Flag whether this sensor's readings can be trusted. An unreachable camera sends no
   * detections at all, so without this HomeKit would keep showing a confident "no motion".
   * Also clears a stuck detection, which can no longer be ended by an event.
   */
  setActive(active: boolean): void {
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, active);
    if (!active) {
      this.set(false);
    }
  }

  /** Follow a rename made in Protect through to the service label HomeKit reads. */
  setName(name: string): void {
    this.service.updateCharacteristic(this.platform.Characteristic.Name, name);
  }

  /** Cancel any pending safety-clear (shutdown). */
  dispose(): void {
    this.latch.cancel();
  }

  set(active: boolean): void {
    this.latch.set(active);
  }
}

/** HAP subtype prefix for a consolidated smart-detect contact sensor. */
const SMART_DETECT_SUBTYPE = 'smartDetect';

/**
 * Label a service the Home app will show as its own control.
 *
 * `Name` alone is NOT enough for a grouped sub-service: the Home app reads **ConfiguredName** for
 * services it lists individually under one accessory, and without it falls back to a generic label
 * — the consolidated detections showed up as "Contact Sensor 1/2/3". ConfiguredName is optional on
 * ContactSensor, so it has to be added before it can be written.
 */
function setServiceName(
  platform: UnifiProtectPlatform,
  service: Service,
  name: string,
): void {
  const { Characteristic } = platform;
  service.updateCharacteristic(Characteristic.Name, name);
  if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
  }
  service.updateCharacteristic(Characteristic.ConfiguredName, name);
}

/**
 * A ContactSensorState driven by start/end detections, with the same safety auto-clear as
 * {@link MotionController}.
 *
 * Contact, not motion, is deliberate and is the whole reason consolidation is safe. A camera
 * accessory's MotionSensor is a privileged, singular signal in HomeKit — it *is* "this camera
 * detected motion", and it drives the camera's notifications and (once implemented) HKSV recording.
 * Adding a MotionSensor service per detection type would make five services all claim to be that
 * camera's motion, so one physical event double-reports. Contact sensors say "which object" without
 * competing for that meaning. This mirrors homebridge-unifi-protect, which reaches the same shape.
 */
class ContactController {
  private readonly latch: LatchingCharacteristic;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    private readonly service: Service,
    timers: Timers,
  ) {
    const C = platform.Characteristic;
    // CONTACT_NOT_DETECTED ("open") is the tripped state; CONTACT_DETECTED ("closed") is clear.
    this.latch = new LatchingCharacteristic(
      service,
      C.ContactSensorState,
      C.ContactSensorState.CONTACT_NOT_DETECTED,
      C.ContactSensorState.CONTACT_DETECTED,
      timers,
    );
  }

  setActive(active: boolean): void {
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, active);
    if (!active) {
      this.set(false);
    }
  }

  setName(name: string): void {
    setServiceName(this.platform, this.service, name);
  }

  dispose(): void {
    this.latch.cancel();
  }

  set(active: boolean): void {
    this.latch.set(active);
  }

  /** Seed the cleared state at construction; see CameraAccessory for why that is necessary. */
  seedClear(): void {
    this.latch.seedClear();
  }
}

/**
 * One HomeKit accessory per camera: an overall motion sensor, a CameraController for
 * snapshots/live video, and — for doorbells — a Doorbell service, so a motion or ring
 * notification carries a snapshot from the same accessory. Driven by decoded realtime
 * detections, with reachability from periodic discovery.
 *
 * The per-type smart detections live here too, as ContactSensor services — see
 * {@link ContactController} for why contact and not motion. One accessory per camera rather than one
 * per detection type is what keeps a large site under HomeKit's 149-per-bridge ceiling: it is the
 * difference between 5 accessories per camera and 1. The smoke/CO sensors are deliberately NOT
 * folded in (see {@link AlarmSensorAccessory}), so with `exposeAudioSensors` on a camera is 1 plus
 * up to 2.
 */
export class CameraAccessory {
  /** True if this accessory has a Doorbell service (physical doorbell OR trigger-enabled). */
  readonly canRing: boolean;
  private readonly motion: MotionController;
  private readonly doorbell?: Service;
  /** The optional "ring from an automation" switch, kept so a rename can relabel it. */
  private trigger?: Service;
  /** Consolidated smart-detect contact sensors by object type (empty unless consolidating). */
  private readonly objectSensors = new Map<string, ContactController>();
  /**
   * The camera's CURRENT name. `opts.name` is only its name at construction: a handler outlives a
   * rename in Protect, and `setName` relabels services without touching `opts`. Anything that
   * derives a label or a log line from the camera's name must read this instead, or a sensor added
   * after a rename is labelled from the old name while its siblings show the new one.
   */
  private displayName: string;
  /** Doorbell-screen message switches by plan key. */
  private readonly messageServices = new Map<string, Service>();
  /** Which message the console currently displays, or undefined for a blank screen. */
  private activeMessage?: string;
  /** The console's raw lcdMessage; a clear must echo its type/text back or validation fails. */
  private currentMessage?: LcdMessage;
  /**
   * Serialises setting writes and doubles as the discovery guard.
   *
   * Two quick taps used to fire concurrent PATCHes: whichever response landed last won, so HomeKit
   * could show a different message than the console until the next discovery pass minutes later.
   * Writes now queue, so they apply in the order pressed and the last press wins.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  private pendingWrites = 0;
  /** The status-light switch, when this camera has a controllable LED. */
  private ledService?: Service;
  private ledOn = true;
  /** Present only when streaming is enabled; retained so shutdown can stop live sessions. */
  private readonly streaming?: ProtectStreamingDelegate;
  /** Protect's reported reachability, from the last discovery pass. */
  private deviceOnline = true;
  /** Whether the last snapshot attempt succeeded — a camera can be "CONNECTED" but not answering. */
  private snapshotOk = true;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    private readonly accessory: PlatformAccessory,
    // Retained: the message switches read their plans, sink and clock from here after construction.
    private readonly opts: {
      name: string;
      serial: string;
      isDoorbell: boolean;
      doorbellTrigger?: boolean;
      /** Enable two-way audio (talkback) for this camera. */
      talkback?: boolean;
      /** Doorbell-screen message switches to expose (empty for none). */
      messages?: MessagePlan[];
      /** Expose a status-light switch. Only set for cameras that actually have a controllable LED. */
      statusLed?: boolean;
      /**
       * Writes camera settings (screen message, status light). Required when `messages` is non-empty
       * or `statusLed` is set. ProtectClient satisfies this.
       */
      messageSink?: { patchCamera(id: string, patch: CameraSettingsPatch): Promise<unknown> };
      /** Clock injection so the clear-patch timestamp is testable. */
      now?: () => number;
      /** Attach a HomeKit CameraController (camera tile, snapshots, live view). */
      streaming?: boolean;
      /** Snapshot + RTSPS source (the ProtectClient). Required when `streaming` is set. */
      source?: StreamSource;
      /**
       * Probed audio encoder, or undefined for video-only. Passed to BOTH the controller (which
       * advertises it) and the delegate (which sends it) — they must never disagree.
       */
      audioCodec?: AudioCodecChoice;
      /**
       * Smart-detect types to expose as ContactSensor services on this accessory. Empty or absent
       * means this camera reports overall motion only (`exposeObjectSensors: false`, or a camera
       * whose model supports no smart detection).
       */
      objectTypes?: string[];
    },
    // Retained rather than used only here: `setObjectTypes` runs again on every discovery pass and
    // builds controllers of its own, which must share the injected clock. Taking them as a second
    // parameter there instead let a caller silently hand a sensor real 60s timers while its
    // siblings had the test's — the safety-clear then simply could not be exercised.
    private readonly timers: Timers = REAL_TIMERS,
  ) {
    const { Service, Characteristic } = platform;
    this.displayName = opts.name;
    platform.applyInfo(accessory, opts.serial, 'UniFi Protect Camera');
    const motionSvc = accessory.getService(Service.MotionSensor) ?? accessory.addService(Service.MotionSensor);
    motionSvc.updateCharacteristic(Characteristic.Name, opts.name);
    motionSvc.updateCharacteristic(Characteristic.StatusActive, true);
    // Seed the cleared state: Homebridge restores an accessory's cached characteristic values, so a
    // detection that was still live when it stopped would come back latched with no 'end' event
    // left to clear it. The safety timeout only covers detections seen in THIS session.
    motionSvc.updateCharacteristic(Characteristic.MotionDetected, false);
    this.motion = new MotionController(platform, motionSvc, timers);

    this.setObjectTypes(opts.objectTypes ?? []);

    // A doorbell service is present for real doorbells and for trigger-enabled cameras (so any
    // camera can "ring" from an automation, e.g. driveway camera → vehicle → ring).
    this.canRing = opts.isDoorbell || !!opts.doorbellTrigger;
    if (this.canRing) {
      this.doorbell = accessory.getService(Service.Doorbell) ?? accessory.addService(Service.Doorbell);
    } else {
      // A cached accessory may carry services from a previous run (e.g. before the doorbell
      // heuristic was fixed, when every camera looked like a doorbell). Drop them so HomeKit
      // doesn't keep showing a doorbell that can never ring.
      const stale = accessory.getService(Service.Doorbell);
      if (stale) {
        accessory.removeService(stale);
      }
    }
    if (opts.doorbellTrigger) {
      // Subtyped now that message switches share this accessory: a bare getService(Service.Switch)
      // would otherwise match whichever Switch happened to come first. A cached accessory from
      // before this change carries a subtype-less Switch, so migrate it rather than leaving a
      // duplicate tile that nothing drives.
      const legacy = accessory.getService(Service.Switch);
      if (legacy && legacy.subtype === undefined) {
        accessory.removeService(legacy);
      }
      const sw = accessory.getServiceById(Service.Switch, TRIGGER_SUBTYPE)
        ?? accessory.addService(Service.Switch, `${opts.name} Doorbell Trigger`, TRIGGER_SUBTYPE);
      this.trigger = sw;
      sw.updateCharacteristic(Characteristic.Name, `${opts.name} Doorbell Trigger`);
      sw.getCharacteristic(Characteristic.On).onSet((value) => {
        if (value) {
          this.ring();
          sw.updateCharacteristic(Characteristic.On, false); // momentary — reset after firing
        }
      });
    }

    this.buildMessageSwitches(accessory, opts.messages ?? []);
    this.buildStatusLedSwitch(accessory, opts.statusLed === true);

    if (opts.streaming && opts.source) {
      const delegate = new ProtectStreamingDelegate({
        deviceId: opts.serial,
        source: opts.source,
        log: platform.log,
        ffmpegPath: resolveFfmpegPath(),
        audioCodec: opts.audioCodec,
        talkback: opts.talkback,
        // Snapshots are the most frequent contact we have with a camera, so their outcome is
        // the freshest reachability signal available between discovery passes.
        onHealth: (ok) => {
          if (this.snapshotOk !== ok) {
            this.snapshotOk = ok;
            this.applyReachability();
          }
        },
      });
      // The delegate needs the controller back so it can tell HomeKit when a stream dies
      // underneath it (otherwise that stream slot stays busy until Homebridge restarts).
      const controller = buildCameraController(platform.api.hap, delegate, opts.audioCodec, !!opts.talkback);
      delegate.setController(controller);
      accessory.configureController(controller);
      this.streaming = delegate;
    }
  }

  /**
   * Follow a rename made in Protect. The accessory's displayName alone is not enough — HomeKit
   * reads the service's Name characteristic too, and the alarm-side handlers already keep the
   * two in step on every refresh. The doorbell-trigger switch keeps its own derived label.
   */
  /**
   * One switch per configured doorbell-screen message, mutually exclusive.
   *
   * Only one message can be displayed, so switching one on turns the others off in HomeKit. The
   * console is the source of truth: `update` reflects whatever it reports, including a message set
   * from the Protect app.
   */
  private buildMessageSwitches(accessory: PlatformAccessory, plans: MessagePlan[]): void {
    const { Service, Characteristic } = this.platform;
    const wanted = new Set(plans.map((p) => `${MESSAGE_SUBTYPE}:${p.key}`));
    // Drop switches for messages no longer configured, or a cached accessory keeps a tile that
    // writes a message the user removed.
    for (const service of [...accessory.services]) {
      const sub = service.subtype;
      if (sub?.startsWith(`${MESSAGE_SUBTYPE}:`) && !wanted.has(sub)) {
        accessory.removeService(service);
      }
    }
    for (const plan of plans) {
      const subtype = `${MESSAGE_SUBTYPE}:${plan.key}`;
      const existing = accessory.getServiceById(Service.Switch, subtype);
      const svc = existing ?? accessory.addService(Service.Switch, plan.label, subtype);
      this.messageServices.set(plan.key, svc);
      if (!existing) {
        svc
          .getCharacteristic(Characteristic.On)
          .onGet(() => this.activeMessage === plan.key)
          .onSet((value) => this.writeMessage(plan, value === true));
      }
    }
  }

  /**
   * Add or remove the status-light switch.
   *
   * Removing matters: a cached accessory from when the feature was on (or from a camera whose model
   * cannot control its LED) would otherwise keep a switch whose writes the console ignores.
   */
  private buildStatusLedSwitch(accessory: PlatformAccessory, wanted: boolean): void {
    const { Service, Characteristic } = this.platform;
    const existing = accessory.getServiceById(Service.Switch, LED_SUBTYPE);
    if (!wanted) {
      if (existing) {
        accessory.removeService(existing);
      }
      this.ledService = undefined;
      return;
    }
    const svc = existing ?? accessory.addService(Service.Switch, `${this.displayName} Status Light`, LED_SUBTYPE);
    if (!existing) {
      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.ledOn)
        .onSet((value) => this.writeStatusLed(value === true));
    }
    this.ledService = svc;
  }

  /**
   * Queue a settings write, so concurrent taps apply in order rather than racing.
   *
   * Each write waits for the previous one — including a failed one, hence the two-arm `then` — and
   * `pendingWrites` stays above zero until the queue drains, which is what keeps a discovery pass
   * from overwriting state mid-sequence.
   */
  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    this.pendingWrites += 1;
    const run = this.writeChain.then(work, work);
    this.writeChain = run.catch(() => undefined);
    return run.finally(() => {
      this.pendingWrites -= 1;
    });
  }

  /** Apply the status-light state the console reports. */
  updateStatusLed(on: boolean): void {
    // Don't fight our own in-flight write: the console may still report the previous value.
    if (!this.ledService || this.pendingWrites > 0) {
      return;
    }
    this.ledOn = on;
    this.ledService.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  /**
   * Turn the status light on or off.
   *
   * Only `isEnabled` is sent: a partial `ledSettings` write is merged by the console (verified), so
   * `welcomeLed` and `floodLed` keep whatever the user configured in Protect.
   */
  private async writeStatusLed(on: boolean): Promise<void> {
    const { hap } = this.platform.api;
    const sink = this.opts.messageSink;
    if (!sink) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await this.enqueueWrite(async () => {
      await sink.patchCamera(this.opts.serial, { ledSettings: { isEnabled: on } });
      this.ledOn = on;
      this.ledService?.updateCharacteristic(this.platform.Characteristic.On, on);
      this.platform.log.info(`Status light on "${this.displayName}" turned ${on ? 'on' : 'off'}.`);
    }).catch((err: unknown) => {
      this.platform.log.error(
        `Could not change the status light on "${this.displayName}": ${(err as Error).message}`,
      );
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  }

  /** Apply the screen state the console reports. */
  updateMessages(current: LcdMessage | undefined): void {
    const plans = this.opts.messages ?? [];
    if (plans.length === 0) {
      return;
    }
    // Don't fight our own in-flight write: the console may still report the previous message.
    if (this.pendingWrites > 0) {
      return;
    }
    this.activeMessage = activeMessageKey(plans, current);
    this.currentMessage = current;
    this.reflectMessageSwitches();
  }

  private reflectMessageSwitches(): void {
    const On = this.platform.Characteristic.On;
    for (const [key, svc] of this.messageServices) {
      svc.updateCharacteristic(On, this.activeMessage === key);
    }
  }

  /**
   * Set or clear the screen.
   *
   * Errors surface as a HAP failure rather than a silent no-op: the whole point of the switch is that
   * the screen changed, so a write that did not land must not read as success.
   */
  private async writeMessage(plan: MessagePlan, on: boolean): Promise<void> {
    const { hap } = this.platform.api;
    const sink = this.opts.messageSink;
    if (!sink) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    // Turning off a switch that is not the active message is a no-op, not a clear — otherwise
    // HomeKit's own "all off" sweep would wipe a message the user just set from another switch.
    if (!on && this.activeMessage !== plan.key) {
      return;
    }
    await this.enqueueWrite(async () => {
      // Built inside the queued task: `currentMessage` may have changed while this write waited.
      const patch = on
        ? setMessagePatch(plan)
        : clearMessagePatch(this.currentMessage, (this.opts.now ?? Date.now)());
      await sink.patchCamera(this.opts.serial, patch);
      this.activeMessage = on ? plan.key : undefined;
      this.currentMessage = patch.lcdMessage;
      this.reflectMessageSwitches();
      this.platform.log.info(
        on
          ? `Doorbell screen on "${this.displayName}" set to "${plan.label}".`
          : `Doorbell screen on "${this.displayName}" cleared.`,
      );
    }).catch((err: unknown) => {
      this.platform.log.error(
        `Could not change the doorbell screen on "${this.displayName}": ${(err as Error).message}`,
      );
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  }

  setName(name: string): void {
    this.displayName = name;
    this.motion.setName(name);
    this.trigger?.updateCharacteristic(this.platform.Characteristic.Name, `${name} Doorbell Trigger`);
    // Consolidated sensor labels are derived from the camera's, so they follow a rename too.
    for (const [type, sensor] of this.objectSensors) {
      sensor.setName(objectSensorName(name, type));
    }
  }

  /**
   * Apply Protect's reported reachability from the latest discovery pass.
   *
   * A disconnected camera keeps its accessory (so it returns in place when it comes back, with
   * its HomeKit room, name and automations intact) but is marked inactive, and we stop asking it
   * for snapshots and streams — every such request would fail after a timeout, and doing that
   * per tile refresh is exactly how the console gets overloaded.
   */
  setOnline(online: boolean): void {
    if (this.deviceOnline === online) {
      return;
    }
    this.deviceOnline = online;
    if (online) {
      // Any earlier snapshot failures are explained by the outage; give it a clean slate.
      this.snapshotOk = true;
    }
    this.streaming?.setDeviceOnline(online);
    this.applyReachability();
  }

  /** Push the combined reachability verdict to HomeKit. */
  private applyReachability(): void {
    const usable = this.deviceOnline && this.snapshotOk;
    this.motion.setActive(usable);
    // The consolidated sensors are fed by the same event stream, so they are exactly as stale.
    for (const sensor of this.objectSensors.values()) {
      sensor.setActive(usable);
    }
  }

  /** Stop any live streams for this camera (called on Homebridge shutdown). */
  shutdown(): void {
    this.motion.dispose();
    for (const sensor of this.objectSensors.values()) {
      sensor.dispose();
    }
    this.streaming?.shutdown();
  }

  /** Fire the doorbell's single-press event (no-op if this camera has no doorbell service). */
  private ring(): void {
    const C = this.platform.Characteristic;
    this.doorbell?.updateCharacteristic(C.ProgrammableSwitchEvent, C.ProgrammableSwitchEvent.SINGLE_PRESS);
  }

  /** Apply a decoded detection routed to this camera (kind is 'motion' or 'ring'). */
  applyDetection(kind: DetectionKind, active: boolean): void {
    if (kind === 'motion') {
      this.motion.set(active);
    } else if (kind === 'ring' && active) {
      this.ring();
    }
  }

  /**
   * Reconcile this camera's smart-detect contact sensors to `types`.
   *
   * Runs on every discovery pass rather than only at construction, so the handler stays consistent
   * with the console without a restart — a camera whose supported detection types change (a firmware
   * update adding one, say) is picked up by the next pass.
   *
   * Note the asymmetry with `buildStatusLedSwitch` / `buildMessageSwitches`, which run once: those
   * are driven purely by plugin config, and a config change restarts Homebridge anyway, so a
   * per-pass rebuild would buy nothing. This one also tracks a console-side capability.
   */
  setObjectTypes(types: string[]): void {
    const { Service, Characteristic } = this.platform;
    const wanted = new Set(types);
    for (const svc of this.accessory.services.filter((s) => s.subtype?.startsWith(`${SMART_DETECT_SUBTYPE}.`))) {
      // The filter guarantees a subtype, so no assertion is needed to narrow it.
      const type = svc.subtype?.slice(SMART_DETECT_SUBTYPE.length + 1) ?? '';
      if (!wanted.has(type)) {
        this.objectSensors.get(type)?.dispose(); // cancel any pending safety-clear before dropping it
        this.objectSensors.delete(type);
        this.accessory.removeService(svc);
      }
    }
    for (const type of wanted) {
      if (this.objectSensors.has(type)) {
        continue; // already built; its label follows the camera name via setName
      }
      const subtype = `${SMART_DETECT_SUBTYPE}.${type}`;
      const label = objectSensorName(this.displayName, type);
      const svc = this.accessory.getServiceById(Service.ContactSensor, subtype)
        ?? this.accessory.addService(Service.ContactSensor, label, subtype);
      setServiceName(this.platform, svc, label);
      svc.updateCharacteristic(Characteristic.StatusActive, true);
      const sensor = new ContactController(this.platform, svc, this.timers);
      // Seed the cleared state explicitly. A restored accessory carries its last cached value, so a
      // detection that was live when Homebridge stopped would come back tripped with no 'end' event
      // ever coming to clear it — a sensor stuck open, firing automations. Seeded THROUGH the
      // controller so only one place knows which value means "clear".
      sensor.seedClear();
      this.objectSensors.set(type, sensor);
    }
  }

  /** True when this camera carries a consolidated sensor for `type`, so routing can prefer it. */
  hasObjectSensor(type: string): boolean {
    return this.objectSensors.has(type);
  }

  /** Apply a smart detection to this camera's consolidated contact sensor for that type. */
  applyObjectDetection(type: string, active: boolean): void {
    this.objectSensors.get(type)?.set(active);
  }
}

/**
 * A native HomeKit smoke or CO sensor driven by a camera's audio detection.
 *
 * This reports that a camera HEARD an alarm — it is not a detector itself, and the accessory name
 * ("Front Door Smoke Alarm") is worded to say so. The value is the bridge it creates: a sounding
 * alarm becomes a first-class HomeKit trigger, so it can turn on lights, unlock doors, or raise a
 * critical notification. A motion sensor could do none of that.
 *
 * Detections auto-clear on the end event, with the same safety timeout the motion sensors use —
 * an alarm sensor stuck ON after a missed end event would keep firing automations.
 */
export class AlarmSensorAccessory {
  private readonly service: Service;
  private readonly latch: LatchingCharacteristic;
  private online = true;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    accessory: PlatformAccessory,
    opts: { name: string; serial: string; kind: SensorKind },
    timers: Timers = REAL_TIMERS,
  ) {
    const { Service, Characteristic } = platform;
    platform.applyInfo(accessory, opts.serial, 'UniFi Protect Camera');
    let characteristic: WithUUID<new () => Characteristic>;
    let detectedValue: number;
    let clearValue: number;
    if (opts.kind === 'carbonMonoxide') {
      this.service =
        accessory.getService(Service.CarbonMonoxideSensor) ?? accessory.addService(Service.CarbonMonoxideSensor);
      characteristic = Characteristic.CarbonMonoxideDetected;
      detectedValue = Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL;
      clearValue = Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
    } else {
      this.service = accessory.getService(Service.SmokeSensor) ?? accessory.addService(Service.SmokeSensor);
      characteristic = Characteristic.SmokeDetected;
      detectedValue = Characteristic.SmokeDetected.SMOKE_DETECTED;
      clearValue = Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    }
    this.latch = new LatchingCharacteristic(this.service, characteristic, detectedValue, clearValue, timers);
    this.service.updateCharacteristic(Characteristic.Name, opts.name);
    this.service.updateCharacteristic(Characteristic.StatusActive, true);
    // Seeded, not left to the restored cache: a detection still live when Homebridge stopped comes
    // back latched with no 'end' event left to clear it. Worst here of all three sensor kinds — a
    // smoke sensor stuck in alarm is a HomeKit critical alert that nothing will retract.
    this.latch.seedClear();
  }

  applyDetection(active: boolean): void {
    this.latch.set(active);
  }

  /** Mirror the parent camera's reachability — an offline camera hears nothing. */
  setOnline(online: boolean): void {
    if (this.online === online) {
      return;
    }
    this.online = online;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, online);
    if (!online) {
      this.applyDetection(false);
    }
  }

  setName(name: string): void {
    this.service.updateCharacteristic(this.platform.Characteristic.Name, name);
  }

  shutdown(): void {
    this.latch.cancel();
  }
}
