// Minimal Homebridge/HAP test double — just enough surface for the accessory classes and
// platform to run under `node --test`, recording every characteristic write so tests can
// assert on HomeKit-visible state. Enum values mirror real HAP so assertions are meaningful.

/** A characteristic identity token that doubles as a namespace for its enum constants. */
function char(name, values = {}) {
  return { charName: name, ...values };
}

export const Characteristic = {
  Name: char('Name'),
  Manufacturer: char('Manufacturer'),
  Model: char('Model'),
  SerialNumber: char('SerialNumber'),
  FirmwareRevision: char('FirmwareRevision'),
  MotionDetected: char('MotionDetected'),
  ContactSensorState: char('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
  StatusActive: char('StatusActive'),
  StatusFault: char('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
  StatusTampered: char('StatusTampered', { NOT_TAMPERED: 0, TAMPERED: 1 }),
  StatusLowBattery: char('StatusLowBattery', { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }),
  BatteryLevel: char('BatteryLevel'),
  ChargingState: char('ChargingState', { NOT_CHARGING: 0 }),
  SecuritySystemCurrentState: char('SecuritySystemCurrentState', {
    STAY_ARM: 0,
    AWAY_ARM: 1,
    NIGHT_ARM: 2,
    DISARMED: 3,
    ALARM_TRIGGERED: 4,
  }),
  SecuritySystemTargetState: char('SecuritySystemTargetState', {
    STAY_ARM: 0,
    AWAY_ARM: 1,
    NIGHT_ARM: 2,
    DISARM: 3,
  }),
  ProgrammableSwitchEvent: char('ProgrammableSwitchEvent', { SINGLE_PRESS: 0, DOUBLE_PRESS: 1, LONG_PRESS: 2 }),
  SmokeDetected: char('SmokeDetected', { SMOKE_NOT_DETECTED: 0, SMOKE_DETECTED: 1 }),
  CarbonMonoxideDetected: char('CarbonMonoxideDetected', { CO_LEVELS_NORMAL: 0, CO_LEVELS_ABNORMAL: 1 }),
  On: char('On'),
};

function svc(name) {
  return { svcName: name };
}

export const Service = {
  AccessoryInformation: svc('AccessoryInformation'),
  ContactSensor: svc('ContactSensor'),
  MotionSensor: svc('MotionSensor'),
  Battery: svc('Battery'),
  SecuritySystem: svc('SecuritySystem'),
  Doorbell: svc('Doorbell'),
  Switch: svc('Switch'),
  SmokeSensor: svc('SmokeSensor'),
  CarbonMonoxideSensor: svc('CarbonMonoxideSensor'),
};

class FakeCharacteristic {
  constructor() {
    this.value = undefined;
    this.props = undefined;
    this.getHandler = undefined;
    this.setHandler = undefined;
  }
  updateValue(v) {
    this.value = v;
    return this;
  }
  setProps(p) {
    this.props = p;
    return this;
  }
  onGet(fn) {
    this.getHandler = fn;
    return this;
  }
  onSet(fn) {
    this.setHandler = fn;
    return this;
  }
}

class FakeService {
  constructor(token) {
    this.token = token;
    this.characteristics = new Map();
  }
  getCharacteristic(token) {
    if (!this.characteristics.has(token)) {
      this.characteristics.set(token, new FakeCharacteristic());
    }
    return this.characteristics.get(token);
  }
  updateCharacteristic(token, value) {
    this.getCharacteristic(token).value = value;
    return this;
  }
  setCharacteristic(token, value) {
    this.getCharacteristic(token).value = value;
    return this;
  }
  /** Test helper: the last value written to a characteristic. */
  value(token) {
    return this.characteristics.get(token)?.value;
  }
}

export class FakeAccessory {
  constructor(name, uuid, category) {
    this.displayName = name;
    this.UUID = uuid;
    this.category = category;
    this.context = {};
    /**
     * Keyed store for getService/getServiceById.
     *
     * `services` (below) is exposed as an ARRAY because that is what hap-nodejs exposes. A Map here
     * made `[...accessory.services]` yield [key, value] pairs in tests while yielding Services in
     * production, so code that scans services for stale entries silently did nothing under test —
     * a mock that lies about a shape hides exactly the bug it should catch.
     */
    this.serviceMap = new Map();
    /** Set by configureController — how tests reach the streaming delegate. */
    this.controller = undefined;
  }
  /**
   * Services are keyed by type *and* subtype, because HAP lets one accessory carry several services
   * of the same type distinguished only by subtype — a chime does exactly that, with a ring button
   * and a mute switch both being Switches.
   */
  static key(token, subtype) {
    return subtype === undefined ? token : `${token?.svcName ?? String(token)}::${subtype}`;
  }
  /** Matches hap-nodejs: an array of Service. */
  get services() {
    return [...this.serviceMap.values()];
  }
  getService(token) {
    return this.serviceMap.get(token);
  }
  getServiceById(token, subtype) {
    return this.serviceMap.get(FakeAccessory.key(token, subtype));
  }
  addService(token, name, subtype) {
    const service = new FakeService(token);
    if (name !== undefined) {
      service.updateCharacteristic(Characteristic.Name, name);
    }
    service.subtype = subtype;
    this.serviceMap.set(FakeAccessory.key(token, subtype), service);
    return service;
  }
  removeService(token) {
    for (const [key, service] of this.serviceMap) {
      if (service === token || key === token) {
        this.serviceMap.delete(key);
      }
    }
  }
  configureController(controller) {
    this.controller = controller;
  }
}

/** Stand-in for hap.CameraController; keeps the config so tests can reach the delegate. */
class FakeCameraController {
  constructor(config) {
    this.config = config;
    this.delegate = config.delegate;
    this.forceStopped = [];
  }
  forceStopStreamingSession(sessionID) {
    this.forceStopped.push(sessionID);
  }
}

export function makeLog() {
  const entries = [];
  const record = (level) => (msg) => entries.push({ level, msg });
  return { entries, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
}

class HapStatusError extends Error {
  constructor(status) {
    super(`HapStatusError ${status}`);
    this.status = status;
  }
}

/** A stand-in for UnifiProtectPlatform, sufficient to construct/drive the accessory handlers. */
export function makePlatform(config = {}) {
  const log = makeLog();
  const platform = {
    Service,
    Characteristic,
    log,
    config,
    sirenChannels: new Set(),
    client: undefined,
    api: {
      hap: {
        HapStatusError,
        HAPStatus: { READ_ONLY_CHARACTERISTIC: -70404, SERVICE_COMMUNICATION_FAILURE: -70402 },
        CameraController: FakeCameraController,
        SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
        H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
        H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
      },
    },
    requestRefresh() {},
    applyInfo(accessory, serial, model = 'UniFi Protect Alarm Hub') {
      const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
      info
        .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
        .setCharacteristic(Characteristic.Model, model)
        .setCharacteristic(Characteristic.SerialNumber, serial)
        .setCharacteristic(Characteristic.FirmwareRevision, '0.0.0');
    },
  };
  return platform;
}
