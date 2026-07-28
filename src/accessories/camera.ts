import type { PlatformAccessory, Service } from 'homebridge';
import type { UnifiProtectPlatform } from '../platform';
import type { DetectionKind } from '../cameraEvents';
import { ProtectStreamingDelegate, type StreamSource } from '../streaming/streamingDelegate';
import { buildCameraController } from '../streaming/cameraOptions';
import { resolveFfmpegPath } from '../streaming/ffmpegPath';

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

/** If an 'end' event is missed (e.g. lost across a reconnect), clear motion after this long. */
const MOTION_SAFETY_CLEAR_MS = 60_000;

/** A MotionDetected characteristic driven by start/end detections, with a safety auto-clear. */
class MotionController {
  private handle?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    private readonly service: Service,
    private readonly timers: Timers,
  ) {}

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
    if (this.handle) {
      this.timers.clear(this.handle);
      this.handle = undefined;
    }
  }

  set(active: boolean): void {
    const C = this.platform.Characteristic;
    if (this.handle) {
      this.timers.clear(this.handle);
      this.handle = undefined;
    }
    this.service.updateCharacteristic(C.MotionDetected, active);
    if (active) {
      // Guard against a missed 'end' leaving the sensor stuck on.
      this.handle = this.timers.set(() => {
        this.handle = undefined;
        this.service.updateCharacteristic(C.MotionDetected, false);
      }, MOTION_SAFETY_CLEAR_MS);
    }
  }
}

/**
 * One HomeKit accessory per camera: an overall motion sensor, a CameraController for
 * snapshots/live video, and — for doorbells — a Doorbell service, so a motion or ring
 * notification carries a snapshot from the same accessory. Driven by decoded realtime
 * detections, with reachability from periodic discovery.
 */
export class CameraAccessory {
  /** True if this accessory has a Doorbell service (physical doorbell OR trigger-enabled). */
  readonly canRing: boolean;
  private readonly motion: MotionController;
  private readonly doorbell?: Service;
  /** The optional "ring from an automation" switch, kept so a rename can relabel it. */
  private trigger?: Service;
  /** Present only when streaming is enabled; retained so shutdown can stop live sessions. */
  private readonly streaming?: ProtectStreamingDelegate;
  /** Protect's reported reachability, from the last discovery pass. */
  private deviceOnline = true;
  /** Whether the last snapshot attempt succeeded — a camera can be "CONNECTED" but not answering. */
  private snapshotOk = true;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    accessory: PlatformAccessory,
    opts: {
      name: string;
      serial: string;
      isDoorbell: boolean;
      doorbellTrigger?: boolean;
      /** Attach a HomeKit CameraController (camera tile, snapshots, live view). */
      streaming?: boolean;
      /** Snapshot + RTSPS source (the ProtectClient). Required when `streaming` is set. */
      source?: StreamSource;
    },
    timers: Timers = REAL_TIMERS,
  ) {
    const { Service, Characteristic } = platform;
    platform.applyInfo(accessory, opts.serial, 'UniFi Protect Camera');
    const motionSvc = accessory.getService(Service.MotionSensor) ?? accessory.addService(Service.MotionSensor);
    motionSvc.updateCharacteristic(Characteristic.Name, opts.name);
    motionSvc.updateCharacteristic(Characteristic.StatusActive, true);
    this.motion = new MotionController(platform, motionSvc, timers);

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
      const sw = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch);
      this.trigger = sw;
      sw.updateCharacteristic(Characteristic.Name, `${opts.name} Doorbell Trigger`);
      sw.getCharacteristic(Characteristic.On).onSet((value) => {
        if (value) {
          this.ring();
          sw.updateCharacteristic(Characteristic.On, false); // momentary — reset after firing
        }
      });
    }

    if (opts.streaming && opts.source) {
      const delegate = new ProtectStreamingDelegate({
        deviceId: opts.serial,
        source: opts.source,
        log: platform.log,
        ffmpegPath: resolveFfmpegPath(),
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
      const controller = buildCameraController(platform.api.hap, delegate);
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
  setName(name: string): void {
    this.motion.setName(name);
    this.trigger?.updateCharacteristic(this.platform.Characteristic.Name, `${name} Doorbell Trigger`);
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
    this.motion.setActive(this.deviceOnline && this.snapshotOk);
  }

  /** Stop any live streams for this camera (called on Homebridge shutdown). */
  shutdown(): void {
    this.motion.dispose();
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
}

/** A standalone motion sensor for one smart-detect object type (person/vehicle/animal/package). */
export class ObjectSensorAccessory {
  private readonly motion: MotionController;
  private online = true;

  constructor(
    platform: UnifiProtectPlatform,
    accessory: PlatformAccessory,
    opts: { name: string; serial: string },
    timers: Timers = REAL_TIMERS,
  ) {
    const { Service, Characteristic } = platform;
    platform.applyInfo(accessory, opts.serial, 'UniFi Protect Camera');
    const svc = accessory.getService(Service.MotionSensor) ?? accessory.addService(Service.MotionSensor);
    svc.updateCharacteristic(Characteristic.Name, opts.name);
    svc.updateCharacteristic(Characteristic.StatusActive, true);
    this.motion = new MotionController(platform, svc, timers);
  }

  applyDetection(active: boolean): void {
    this.motion.set(active);
  }

  /** Mirror the parent camera's reachability — an offline camera detects nothing. */
  setOnline(online: boolean): void {
    if (this.online === online) {
      return; // discovery runs every few minutes; don't rewrite an unchanged characteristic
    }
    this.online = online;
    this.motion.setActive(online);
  }

  /** Follow a rename of the parent camera (the sensor's label is derived from it). */
  setName(name: string): void {
    this.motion.setName(name);
  }

  shutdown(): void {
    this.motion.dispose();
  }
}
