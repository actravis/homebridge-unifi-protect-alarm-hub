import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { UnifiProtectPlatform } from '../platform';
import type { AccessoryHandler, AlarmHub } from '../types';
import { computeFingerprint, isArmed, isTriggered } from '../armState';

/** How long a "learn this profile" intent stays pending before we give up (arm never took). */
const LEARN_TIMEOUT_MS = 120_000;

/**
 * HomeKit SecuritySystem tile. Arm/disarm is written via Alarm Manager webhooks;
 * state is read from the hub. Because the API doesn't expose the active profile,
 * we learn each profile's zone fingerprint the first time we arm it, then recognise
 * it thereafter — even when armed externally.
 */
export class SecuritySystemAccessory implements AccessoryHandler {
  private readonly service: Service;
  private readonly learned: Record<string, number>;
  private readonly validTargets: Set<number>;
  private target: number;
  private current: number;
  private pendingLearn: number | null = null;
  private pendingLearnExpiry = 0;
  private prevTriggered = false;
  private lastName?: string;

  constructor(
    private readonly platform: UnifiProtectPlatform,
    private readonly accessory: PlatformAccessory,
    hubMac: string,
  ) {
    const { Service, Characteristic } = platform;
    platform.applyInfo(accessory, `${hubMac}-security`);
    this.service =
      accessory.getService(Service.SecuritySystem) ?? accessory.addService(Service.SecuritySystem);

    // Null-prototype: the keys are fingerprints derived from console-supplied channel names, so
    // a channel called `constructor`/`__proto__` would otherwise make a lookup return something
    // off Object.prototype and write it straight to a HomeKit characteristic.
    this.learned = Object.assign(Object.create(null) as Record<string, number>, accessory.context.armProfiles);
    this.validTargets = new Set(this.computeValidTargets());
    // Clamped, not a bare DISARM: with only an "away" trigger configured, validTargets is
    // [AWAY_ARM] and seeding DISARM would itself be the illegal value the seed exists to avoid.
    this.target = this.clampTarget(Characteristic.SecuritySystemTargetState.DISARM);
    this.current = Characteristic.SecuritySystemCurrentState.DISARMED;

    const targetChar = this.service.getCharacteristic(Characteristic.SecuritySystemTargetState);
    // Seed a valid value before restricting validValues, or HAP warns that the characteristic's
    // default (0 / Stay) isn't in the list.
    targetChar.updateValue(this.target);
    targetChar
      .setProps({ validValues: [...this.validTargets] })
      .onGet(() => this.target)
      .onSet((v) => this.setTarget(v));

    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).onGet(() => this.current);
  }

  private computeValidTargets(): number[] {
    const T = this.platform.Characteristic.SecuritySystemTargetState;
    const c = this.platform.config;
    const values: number[] = [];
    if (c.armAwayTriggerId) {
      values.push(T.AWAY_ARM);
    }
    if (c.armNightTriggerId) {
      values.push(T.NIGHT_ARM);
    }
    if (c.disarmTriggerId) {
      values.push(T.DISARM);
    }
    // HomeKit requires at least one selectable target; disarm is the safe default.
    return values.length ? values : [T.DISARM];
  }

  /**
   * Keep a reported target within the values HomeKit accepts (avoids illegal-value warnings).
   * Every fallback must itself be in `validTargets` — returning a bare DISARM used to be illegal
   * in a night-only setup, which is exactly the warning this exists to prevent.
   */
  private clampTarget(target: number): number {
    const T = this.platform.Characteristic.SecuritySystemTargetState;
    for (const candidate of [target, T.AWAY_ARM, T.DISARM]) {
      if (this.validTargets.has(candidate)) {
        return candidate;
      }
    }
    // computeValidTargets never returns an empty set, so the first entry is always there; the
    // `??` only satisfies the compiler, and DISARM is the same safe default it guarantees.
    return [...this.validTargets][0] ?? T.DISARM;
  }

  private triggerIdFor(target: number): string | undefined {
    const T = this.platform.Characteristic.SecuritySystemTargetState;
    const c = this.platform.config;
    switch (target) {
      case T.AWAY_ARM:
        return c.armAwayTriggerId;
      case T.NIGHT_ARM:
        return c.armNightTriggerId;
      case T.DISARM:
        return c.disarmTriggerId;
      default:
        return undefined;
    }
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const { hap } = this.platform.api;
    const T = this.platform.Characteristic.SecuritySystemTargetState;
    const target = value as number;
    const triggerId = this.triggerIdFor(target);
    if (!triggerId) {
      this.platform.log.warn(`No webhook Trigger ID configured for target state ${target}; ignoring.`);
      throw new hap.HapStatusError(hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }
    if (!this.platform.client) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    try {
      await this.platform.client.fireWebhook(triggerId);
    } catch (err) {
      this.platform.log.error(`Arm/disarm webhook failed: ${(err as Error).message}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.target = target;
    // Remember which profile we armed so we can fingerprint it on the next refresh.
    if (target === T.DISARM) {
      this.pendingLearn = null;
    } else {
      this.pendingLearn = target;
      this.pendingLearnExpiry = Date.now() + LEARN_TIMEOUT_MS;
    }
    this.platform.requestRefresh();
  }

  update(hub: AlarmHub, name: string): void {
    const C = this.platform.Characteristic;

    if (name !== this.lastName) {
      this.service.updateCharacteristic(C.Name, name);
      this.lastName = name;
    }

    // Expire a stale learn intent (an arm that never took effect).
    if (this.pendingLearn !== null && Date.now() > this.pendingLearnExpiry) {
      this.pendingLearn = null;
    }
    // Learn the fingerprint of a profile we just armed.
    if (this.pendingLearn !== null && isArmed(hub)) {
      const fingerprint = computeFingerprint(hub);
      if (fingerprint) {
        this.learned[fingerprint] = this.pendingLearn;
        this.accessory.context.armProfiles = this.learned;
      }
      this.pendingLearn = null;
    }

    // Require two consecutive triggered reads so a brief entry/exit chirp isn't reported as an alarm.
    const triggeredNow = isTriggered(hub, this.platform.sirenChannels);
    const triggered = triggeredNow && this.prevTriggered;
    this.prevTriggered = triggeredNow;

    if (triggered) {
      this.current = C.SecuritySystemCurrentState.ALARM_TRIGGERED;
    } else if (!isArmed(hub)) {
      this.current = C.SecuritySystemCurrentState.DISARMED;
      // Don't clobber the user's selection while an arm is still taking effect (exit delay).
      if (this.pendingLearn === null) {
        // Clamped, like every other write to `target`. With only an arm trigger configured
        // (say night-only), DISARM is not in validValues, and writing it here made HAP log
        // "value 3 is not in valid values" on every single refresh while disarmed.
        this.target = this.clampTarget(C.SecuritySystemTargetState.DISARM);
      }
    } else {
      // Arm-mode current/target enum values coincide (AWAY_ARM=1, NIGHT_ARM=2).
      const remembered = this.learned[computeFingerprint(hub)];
      const profile = typeof remembered === 'number' ? remembered : C.SecuritySystemTargetState.AWAY_ARM;
      this.current = profile;
      this.target = this.clampTarget(profile);
    }

    this.service.updateCharacteristic(C.SecuritySystemCurrentState, this.current);
    this.service.updateCharacteristic(C.SecuritySystemTargetState, this.target);
    // A successful update means the console is reachable — clear any stale-state fault.
    this.service.updateCharacteristic(C.StatusFault, C.StatusFault.NO_FAULT);
  }

  markStale(): void {
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT);
  }
}
