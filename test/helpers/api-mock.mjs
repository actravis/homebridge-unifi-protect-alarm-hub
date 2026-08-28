// A fake Homebridge `API` plus the platform's injectable deps, so UnifiProtectPlatform can be
// driven end to end under `node --test` — no console, no network, no real timers. Registration
// calls and log lines are recorded so tests assert on what HomeKit would actually have been told.

import { createHash } from 'node:crypto';

import { Characteristic, FakeAccessory, Service, makeLog } from './hap-mock.mjs';

/** Real hap Categories values for the ones the platform uses. */
const Categories = { SECURITY_SYSTEM: 11, SENSOR: 10, SWITCH: 8, CAMERA: 17, VIDEO_DOORBELL: 18 };

/**
 * Deterministic stand-in for hap's uuid.generate. Only the mapping matters here — the property
 * under test is that discovery and event routing derive the *same* id from the same seed.
 */
function generateUuid(seed) {
  return createHash('sha1').update(String(seed)).digest('hex').slice(0, 32);
}

/** Controllable timers: nothing fires until a test says so. */
export function fakeClock() {
  const intervals = [];
  const timeouts = [];
  // Starts well above 0 so code that treats a zero timestamp as "unset" cannot pass by accident.
  let nowMs = 1_700_000_000_000;
  return {
    intervals,
    timeouts,
    /** Move the clock forward. Fires nothing on its own — run the intervals you want by hand. */
    advance(ms) {
      nowMs += ms;
    },
    now: () => nowMs,
    deps: {
      now: () => nowMs,
      setInterval(fn, ms) {
        const handle = { fn, ms, cleared: false };
        intervals.push(handle);
        return handle;
      },
      clearInterval(handle) {
        if (handle) {
          handle.cleared = true;
        }
      },
      setTimeout(fn, ms) {
        const handle = { fn, ms, cleared: false };
        timeouts.push(handle);
        return handle;
      },
    },
    /**
     * The live alarm-poll interval. The platform replaces this one whenever the cadence changes
     * (realtime up/down), so it is identified by exclusion: the camera-rediscovery interval is
     * the only other one, it runs at a fixed 300s, and it is created once and never re-armed.
     */
    alarmInterval() {
      return intervals.filter((i) => !i.cleared && i.ms !== 300_000).at(-1);
    },
    /** The camera re-discovery interval; call `.fn()` to run a discovery pass. */
    cameraInterval() {
      return intervals.filter((i) => !i.cleared && i.ms === 300_000).at(-1);
    },
    /** Run every pending one-shot timer (e.g. requestRefresh's 400ms coalescing window). */
    runTimeouts() {
      const pending = timeouts.splice(0, timeouts.length);
      for (const t of pending) {
        if (!t.cleared) {
          t.fn();
        }
      }
    },
  };
}

/**
 * A fake ProtectClient. Every method is a jest-style spy over data the test supplies; the
 * realtime subscriptions expose their callbacks so tests can push events and connection
 * transitions by hand.
 */
export function fakeClient(overrides = {}) {
  const state = {
    hubs: [],
    cameras: [],
    chimes: [],
    version: { applicationVersion: '7.1.87' },
    /** Set to an Error (or a function returning one) to make getAlarmHubs reject. */
    hubsError: undefined,
    camerasError: undefined,
    chimesError: undefined,
    /** Every fireWebhook call, so tests assert on which Alarm Manager trigger was fired. */
    webhooks: [],
    /** Every patchChime call, so tests assert on what was actually written. */
    chimePatches: [],
    calls: { getAlarmHubs: 0, getCameras: 0, getChimes: 0 },
    closed: false,
    devices: undefined, // { onChange, log, hooks, dispose }
    events: undefined,
    ...overrides,
  };

  const client = {
    state,
    async getVersion() {
      return state.version;
    },
    async getAlarmHubs() {
      state.calls.getAlarmHubs += 1;
      if (state.hubsError) {
        throw state.hubsError;
      }
      return state.hubs;
    },
    async getCameras() {
      state.calls.getCameras += 1;
      if (state.camerasError) {
        throw state.camerasError;
      }
      return state.cameras;
    },
    async getChimes() {
      state.calls.getChimes += 1;
      if (state.chimesError) {
        throw state.chimesError;
      }
      return state.chimes;
    },
    async patchChime(id, patch) {
      state.chimePatches.push({ id, patch });
      if (state.chimePatchError) {
        throw state.chimePatchError;
      }
      // Mirror the console: the write replaces ringSettings wholesale.
      const chime = state.chimes.find((c) => c.id === id);
      if (chime && patch.ringSettings) {
        chime.ringSettings = patch.ringSettings;
      }
      return chime;
    },
    async getSnapshot() {
      return Buffer.from([0]);
    },
    async getRtspsStream() {
      return {};
    },
    async enableRtspsStream() {
      return {};
    },
    async fireWebhook(triggerId) {
      state.webhooks.push(triggerId);
      if (state.webhookError) {
        throw state.webhookError;
      }
    },
    subscribeDevices(onChange, log, hooks = {}) {
      state.devices = { onChange, log, hooks, disposed: false };
      return () => {
        state.devices.disposed = true;
      };
    },
    subscribeEvents(onEvent, log, hooks = {}) {
      state.events = { onEvent, log, hooks, disposed: false };
      return () => {
        state.events.disposed = true;
      };
    },
    async close() {
      state.closed = true;
    },
  };
  return client;
}

/** A fake Homebridge API recording every accessory registration/removal. */
export function fakeApi() {
  const handlers = new Map();
  const registered = [];
  const unregistered = [];
  const updated = [];

  return {
    registered,
    unregistered,
    updated,
    /** Invoke a lifecycle hook the platform subscribed to ('didFinishLaunching' | 'shutdown'). */
    emit(event) {
      handlers.get(event)?.();
    },
    hap: {
      Service,
      Characteristic,
      Categories,
      uuid: { generate: generateUuid },
      HapStatusError: class extends Error {},
      HAPStatus: { READ_ONLY_CHARACTERISTIC: -70404, SERVICE_COMMUNICATION_FAILURE: -70402 },
      CameraController: class {
        constructor(config) {
          this.config = config;
          this.delegate = config.delegate;
        }
        forceStopStreamingSession() {}
      },
      SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
      H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
      H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
    },
    platformAccessory: FakeAccessory,
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
    },
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      unregistered.push(...accessories);
    },
    updatePlatformAccessories(accessories) {
      updated.push(...accessories);
    },
  };
}

export { Categories, generateUuid, makeLog };

/** Let queued promise callbacks run — the platform's refresh/sync paths are fire-and-forget. */
export function flush(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}
