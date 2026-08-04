import type { PlatformAccessory, Service } from 'homebridge';
import type { UnifiProtectPlatform } from '../platform';
import { DEFAULT_CHIME_VOLUME, settingsAtVolume, type ChimePlan } from '../chimeDiscovery';
import type { ChimeRingSetting } from '../types';

/** What the accessory needs from the client. ProtectClient satisfies this. */
export interface ChimeSource {
  fireWebhook(triggerId: string): Promise<void>;
  patchChime(id: string, patch: { ringSettings?: ChimeRingSetting[] }): Promise<unknown>;
}

/** HAP subtypes, so two Switch services can coexist on one accessory. */
const RING = 'ring';
const MUTE = 'mute';

/**
 * A doorbell chime, exposing up to two independent controls:
 *
 * - **Ring** — a momentary switch that rings the chime via an Alarm Manager webhook. It resets
 *   itself to off so it reads as a button and works as an automation action. See chimeDiscovery.ts
 *   for why ringing cannot go through a chime endpoint.
 * - **Mute** — a stateful switch meaning "audible": on restores the last non-zero volume, off sets
 *   every paired camera's volume to zero. This is the automatable half ("silent after 10pm").
 *
 * The pre-mute volume is kept in `accessory.context` so it survives a Homebridge restart. Without
 * that, unmuting after a restart would fall back to a default and quietly change a level the user
 * had chosen — and because the failure is inaudible until somebody rings the doorbell, it would go
 * unnoticed.
 */
export class ChimeAccessory {
  private readonly accessory: PlatformAccessory;
  private ringService?: Service;
  private muteService?: Service;
  /** Ring settings from the last discovery pass; the shape we must preserve when writing. */
  private ringSettings: ChimeRingSetting[] = [];
  private online = true;
  private triggerId?: string;
  private pairedCameras = 0;
  private audible = true;
  /** Set while a ring is in flight, so a double-tap can't queue a second alarm. */
  private ringing = false;
  /** Set while a mute write is in flight, so an overlapping discovery pass can't flap the switch. */
  private writing = false;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    accessory: PlatformAccessory,
    private readonly opts: { name: string; serial: string; source: ChimeSource },
  ) {
    this.accessory = accessory;
    platform.applyInfo(accessory, opts.serial, 'UniFi Protect Chime');
  }

  /** Apply the latest discovery snapshot, creating or removing services as config dictates. */
  update(plan: ChimePlan): void {
    const C = this.platform.Characteristic;
    this.online = plan.online;
    this.triggerId = plan.triggerId;
    this.pairedCameras = plan.pairedCameras;
    // Taken verbatim from the console, so a later write preserves ringtone and repeat count.
    this.ringSettings = plan.ringSettings;

    this.syncRingService(plan);
    this.syncMuteService(plan);

    // Only remember a genuinely audible level. Recording 0 would make unmute a no-op.
    if (!plan.muted && plan.volume > 0) {
      this.rememberedVolume = plan.volume;
    }
    // Don't let a discovery pass that overlaps our own write flap the switch back: discovery runs
    // every few minutes and could report the pre-write state while the PATCH is still in flight.
    if (this.muteService && !this.writing) {
      this.audible = !plan.muted;
      this.muteService.updateCharacteristic(C.On, this.audible);
    }
  }

  /**
   * Add or remove the ring button to match config.
   *
   * Removing matters: if the user clears the Trigger ID, a cached accessory would otherwise keep a
   * button that can no longer ring anything.
   */
  private syncRingService(plan: ChimePlan): void {
    const { Service, Characteristic } = this.platform;
    const existing = this.accessory.getServiceById(Service.Switch, RING);
    if (!plan.triggerId) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.ringService = undefined;
      return;
    }
    const svc = existing ?? this.accessory.addService(Service.Switch, `${plan.name} Ring`, RING);
    if (!existing) {
      // Always reports off: it is a button, and a stuck-on button can never be pressed again.
      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => {
          if (value === true) {
            void this.ring();
          }
        });
    }
    this.ringService = svc;
  }

  /** Add or remove the mute switch to match config. */
  private syncMuteService(plan: ChimePlan): void {
    const { Service, Characteristic } = this.platform;
    const existing = this.accessory.getServiceById(Service.Switch, MUTE);
    if (!plan.mutable) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.muteService = undefined;
      return;
    }
    const svc = existing ?? this.accessory.addService(Service.Switch, `${plan.name} Audible`, MUTE);
    if (!existing) {
      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.audible)
        .onSet((value) => this.setAudible(value === true));
    }
    this.muteService = svc;
  }

  /** The volume remembered across restarts, so unmute restores what the user actually had. */
  private get rememberedVolume(): number {
    const stored = (this.accessory.context as { chimeVolume?: unknown }).chimeVolume;
    return typeof stored === 'number' && stored > 0 ? stored : DEFAULT_CHIME_VOLUME;
  }

  private set rememberedVolume(volume: number) {
    (this.accessory.context as { chimeVolume?: number }).chimeVolume = volume;
  }

  setName(name: string): void {
    const C = this.platform.Characteristic;
    this.ringService?.updateCharacteristic(C.Name, `${name} Ring`);
    this.muteService?.updateCharacteristic(C.Name, `${name} Audible`);
  }

  /**
   * Fire the Alarm Manager webhook, then snap the switch back off.
   *
   * The reset runs in `finally` so a failed ring still leaves a pressable button. Errors are logged
   * rather than thrown: HomeKit has already shown the press, and a HapStatusError here would leave
   * the tile in an error state that only a restart clears.
   */
  private async ring(): Promise<void> {
    const C = this.platform.Characteristic;
    const reset = () => this.ringService?.updateCharacteristic(C.On, false);
    if (!this.triggerId || this.ringing) {
      reset();
      return;
    }
    if (!this.online) {
      this.platform.log.warn(`Chime "${this.opts.name}" is offline; not ringing.`);
      reset();
      return;
    }
    this.ringing = true;
    try {
      await this.opts.source.fireWebhook(this.triggerId);
      this.platform.log.info(`Rang chime "${this.opts.name}".`);
    } catch (err) {
      // A wrong Trigger ID is the likely mistake and the API says so precisely ("Invalid webhook
      // ID", HTTP 400), so pass the message through rather than flattening it.
      this.platform.log.error(`Could not ring chime "${this.opts.name}": ${(err as Error).message}`);
    } finally {
      this.ringing = false;
      reset();
    }
  }

  private async setAudible(audible: boolean): Promise<void> {
    const { hap } = this.platform.api;
    if (this.pairedCameras === 0) {
      this.platform.log.warn(
        `Chime "${this.opts.name}" is not paired to any camera, so there is no volume to change.`,
      );
      throw new hap.HapStatusError(hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }
    if (!this.online) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    // Capture the level to restore BEFORE muting, or the mute itself overwrites it.
    const target = audible ? this.rememberedVolume : 0;
    if (!audible) {
      const current = Math.max(...this.ringSettings.map((s) => s.volume ?? 0), 0);
      if (current > 0) {
        this.rememberedVolume = current;
      }
    }
    this.writing = true;
    try {
      await this.opts.source.patchChime(this.opts.serial, {
        ringSettings: settingsAtVolume(this.ringSettings, target),
      });
      this.ringSettings = settingsAtVolume(this.ringSettings, target);
      this.audible = audible;
      this.platform.log.info(
        `Chime "${this.opts.name}" ${audible ? `unmuted (volume ${target})` : 'muted'}.`,
      );
    } catch (err) {
      this.platform.log.error(`Could not change chime "${this.opts.name}": ${(err as Error).message}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.writing = false;
    }
  }

  /** Nothing to tear down — kept so the platform can treat every device handler alike. */
  shutdown(): void {
    /* no background work */
  }
}
