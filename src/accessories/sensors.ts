import type { PlatformAccessory, Service } from 'homebridge';
import type { UnifiAlarmHubPlatform } from '../platform';
import type { AccessoryHandler, AlarmHub } from '../types';

export type ZoneKind = 'contact' | 'motion';

function online(hub: AlarmHub): boolean {
  return hub.state === 'CONNECTED';
}

function hubTampered(hub: AlarmHub): boolean {
  const cover = hub.alarmHub?.cover?.status;
  return cover !== undefined && cover !== 'close';
}

/** A wired alarm-hub zone (contact/motion/glass-break). */
export class ZoneAccessory implements AccessoryHandler {
  private readonly service: Service;
  private lastName?: string;

  constructor(
    private readonly platform: UnifiAlarmHubPlatform,
    accessory: PlatformAccessory,
    private readonly channel: string,
    private readonly kind: ZoneKind,
    hubMac: string,
  ) {
    const { Service } = platform;
    // Kind is in the serial as well as the UUID so a type-change transition can't collide.
    platform.applyInfo(accessory, `${hubMac}-zone-${channel}-${kind}`);
    this.service =
      kind === 'motion'
        ? accessory.getService(Service.MotionSensor) ?? accessory.addService(Service.MotionSensor)
        : accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor);
  }

  update(hub: AlarmHub, name: string): void {
    const C = this.platform.Characteristic;
    if (name !== this.lastName) {
      this.service.updateCharacteristic(C.Name, name);
      this.lastName = name;
    }

    const input = hub.alarmHub?.input?.[this.channel];
    const terminal = hub.alarmHub?.inputTerminalStatus?.[this.channel]?.terminalStatus;

    const open = terminal === 'triggered' || input?.status === 'alarm';
    // Defensive EOL handling: idle/triggered/disabled are known; anything else is a fault.
    const known = terminal === undefined || ['idle', 'triggered', 'disabled'].includes(terminal);
    const fault = !online(hub) || !known;

    if (this.kind === 'motion') {
      this.service.updateCharacteristic(C.MotionDetected, open);
    } else {
      const state = open ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED;
      this.service.updateCharacteristic(C.ContactSensorState, state);
    }
    this.service.updateCharacteristic(C.StatusActive, online(hub) && terminal !== 'disabled');
    this.service.updateCharacteristic(C.StatusFault, fault ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
    this.service.updateCharacteristic(
      C.StatusTampered,
      hubTampered(hub) ? C.StatusTampered.TAMPERED : C.StatusTampered.NOT_TAMPERED,
    );
  }
}

type ReadonlySource = { kind: 'output'; channel: string } | { kind: 'emergency' };

/** Read-only status indicator for a hub output or the emergency input (open = active). */
export class ReadonlyContactAccessory implements AccessoryHandler {
  private readonly service: Service;
  private lastName?: string;

  constructor(
    private readonly platform: UnifiAlarmHubPlatform,
    accessory: PlatformAccessory,
    private readonly source: ReadonlySource,
    hubMac: string,
  ) {
    const { Service } = platform;
    const suffix = source.kind === 'output' ? `output-${source.channel}` : 'emergency';
    platform.applyInfo(accessory, `${hubMac}-${suffix}`);
    this.service =
      accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor);
  }

  update(hub: AlarmHub, name: string): void {
    const C = this.platform.Characteristic;
    if (name !== this.lastName) {
      this.service.updateCharacteristic(C.Name, name);
      this.lastName = name;
    }

    const active =
      this.source.kind === 'output'
        ? hub.alarmHub?.output?.[this.source.channel]?.active === 'on'
        : hub.alarmHub?.emergencyTerminalStatus?.terminalStatus === 'triggered';

    this.service.updateCharacteristic(
      C.ContactSensorState,
      active ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED,
    );
    this.service.updateCharacteristic(C.StatusActive, online(hub));
  }
}

/** The alarm hub itself: enclosure tamper + backup-battery status + reachability. */
export class HubAccessory implements AccessoryHandler {
  private readonly tamper: Service;
  private readonly battery: Service;
  private lastName?: string;

  constructor(private readonly platform: UnifiAlarmHubPlatform, accessory: PlatformAccessory, hubMac: string) {
    const { Service } = platform;
    platform.applyInfo(accessory, `${hubMac}-hub`);
    this.tamper = accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor);
    this.battery = accessory.getService(Service.Battery) ?? accessory.addService(Service.Battery);
  }

  update(hub: AlarmHub, name: string): void {
    const C = this.platform.Characteristic;
    if (name !== this.lastName) {
      this.tamper.updateCharacteristic(C.Name, name);
      this.lastName = name;
    }

    const tampered = hubTampered(hub);
    this.tamper.updateCharacteristic(
      C.ContactSensorState,
      tampered ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED,
    );
    this.tamper.updateCharacteristic(C.StatusActive, online(hub));
    this.tamper.updateCharacteristic(
      C.StatusTampered,
      tampered ? C.StatusTampered.TAMPERED : C.StatusTampered.NOT_TAMPERED,
    );

    // The API reports battery health (ok/low), not a percentage; approximate for HomeKit.
    const batteryOk = (hub.alarmHub?.battery?.batteryStatus ?? 'ok') === 'ok';
    this.battery.updateCharacteristic(
      C.StatusLowBattery,
      batteryOk ? C.StatusLowBattery.BATTERY_LEVEL_NORMAL : C.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.battery.updateCharacteristic(C.BatteryLevel, batteryOk ? 100 : 10);
    this.battery.updateCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGING);
  }
}
