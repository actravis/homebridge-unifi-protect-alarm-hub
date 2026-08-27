// End-to-end coverage of platform.ts — the glue the pure modules can't reach: reconciling
// accessories against a hub snapshot, camera discovery/pruning, routing realtime events to the
// right handler, outage handling, and the poll cadence. Driven through a fake Homebridge API,
// a fake ProtectClient and controllable timers, so nothing here touches a console or a clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProtectApiError } from '../dist/client/protectClient.js';
import { UnifiProtectPlatform } from '../dist/platform.js';
import { Characteristic as C, Service } from './helpers/hap-mock.mjs';
import { fakeApi, fakeClient, fakeClock, flush, generateUuid, makeLog } from './helpers/api-mock.mjs';

const HUB_MAC = 'AA:BB:CC';

/** A hub payload with one enabled contact zone, unless a test says otherwise. */
const hub = (alarmHub = { input: { 0: { enable: 'on', inputType: 'ENTRY', name: 'Front Door' } } }) => ({
  id: 'hub-1',
  modelKey: 'linkstation',
  name: 'Alarm Hub Kit',
  mac: HUB_MAC,
  state: 'CONNECTED',
  isAlarmHub: true,
  alarmHub,
});

const camera = (over = {}) => ({ id: 'cam-1', modelKey: 'camera', name: 'Front Yard', featureFlags: {}, ...over });

/**
 * Build a started platform: construct, fire 'didFinishLaunching', and let the first refresh and
 * camera sync settle. Returns everything a test needs to poke at it.
 */
async function startPlatform(config = {}, clientState = {}, audioCodec = { encoder: 'libopus', hapCodec: 'OPUS' }) {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient(clientState);
  const platform = new UnifiProtectPlatform(
    log,
    { platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key', ...config },
    api,
    { createClient: () => client, probeAudioCodec: async () => audioCodec, ...clock.deps },
  );
  api.emit('didFinishLaunching');
  await flush();
  return { platform, api, log, clock, client, state: client.state };
}

const names = (accessories) => accessories.map((a) => a.displayName).sort();
/**
 * The CAMERA-domain accessory with this name.
 *
 * Not `registered.find(byName)`: an alarm zone and a camera can legitimately share a name, so that
 * resolves to whichever of two independent async flows happened to register first.
 */
const cameraNamed = (api, name) =>
  api.registered.find((a) => a.context?.domain === 'camera' && a.displayName === name);
const logged = (log, level) => log.entries.filter((e) => e.level === level).map((e) => e.msg);

// --- Alarm reconcile ---------------------------------------------------------

test('registers the planned accessory set on the first successful refresh', async () => {
  const { api } = await startPlatform({}, { hubs: [hub()] });
  assert.deepEqual(names(api.registered), ['Alarm Hub Kit', 'Emergency Input', 'Front Door', 'Security System']);
  assert.equal(api.unregistered.length, 0);
});

test('a zone renamed in UniFi is renamed in HomeKit, not re-registered', async () => {
  const { api, state, clock } = await startPlatform({}, { hubs: [hub()] });
  const before = api.registered.length;

  state.hubs = [hub({ input: { 0: { enable: 'on', inputType: 'ENTRY', name: 'Side Door' } } })];
  clock.alarmInterval().fn(); // next poll
  await flush();

  assert.equal(api.registered.length, before, 'a rename must not create a second accessory');
  assert.deepEqual(names(api.updated), ['Side Door']);
});

test('disabling a terminal in UniFi prunes its accessory', async () => {
  const { api, state, clock } = await startPlatform({}, { hubs: [hub()] });

  state.hubs = [hub({ input: { 0: { enable: 'off', inputType: 'ENTRY', name: 'Front Door' } } })];
  clock.alarmInterval().fn();
  await flush();

  assert.deepEqual(names(api.unregistered), ['Front Door']);
});

// A hub payload that arrives without its input channels is a partial read, not 23 deleted
// sensors. Pruning on one would wipe the user's whole zone set — and their automations with it.
test('an incomplete hub payload is skipped, never treated as "everything was removed"', async () => {
  const { api, state, clock, log } = await startPlatform({}, { hubs: [hub()] });

  state.hubs = [hub({})]; // no `input` at all
  clock.alarmInterval().fn();
  await flush();

  assert.equal(api.unregistered.length, 0);
  assert.ok(logged(log, 'debug').some((m) => /[Ii]ncomplete hub payload/.test(m)));
});

test('no alarm hub on the console is reported, not crashed on', async () => {
  const { api, log } = await startPlatform({}, { hubs: [] });
  assert.equal(api.registered.length, 0);
  assert.ok(logged(log, 'warn').some((m) => /No alarm hub/.test(m)));
});

test('a second alarm hub is warned about exactly once', async () => {
  const second = { ...hub(), id: 'hub-2', mac: 'DD:EE:FF' };
  const { log, clock } = await startPlatform({}, { hubs: [hub(), second] });
  clock.alarmInterval().fn();
  await flush();
  assert.equal(logged(log, 'warn').filter((m) => /2 alarm hubs/.test(m)).length, 1);
});

// --- Outage handling ---------------------------------------------------------

test('an auth failure is reported once, not on every poll', async () => {
  const err = new ProtectApiError('HTTP 401 for /alarm-hubs', 401);
  const { log, clock } = await startPlatform({}, { hubs: [], hubsError: err });
  for (let i = 0; i < 3; i++) {
    clock.alarmInterval().fn();
    await flush();
  }
  const authErrors = logged(log, 'error').filter((m) => /Authentication failed/.test(m));
  assert.equal(authErrors.length, 1, `expected one auth error, got ${authErrors.length}`);
});

test('a sustained outage marks accessories stale, and recovery clears it', async () => {
  const { state, clock, api, log } = await startPlatform({}, { hubs: [hub()] });
  const zone = api.registered.find((a) => a.displayName === 'Front Door');
  assert.equal(zone.getService(Service.ContactSensor).value(C.StatusActive), true);

  state.hubsError = new Error('ECONNREFUSED');
  for (let i = 0; i < 3; i++) {
    clock.alarmInterval().fn();
    await flush();
  }

  assert.equal(zone.getService(Service.ContactSensor).value(C.StatusActive), false);
  assert.ok(logged(log, 'warn').some((m) => /unreachable for a while/.test(m)));

  state.hubsError = undefined;
  clock.alarmInterval().fn();
  await flush();

  assert.equal(zone.getService(Service.ContactSensor).value(C.StatusActive), true);
  assert.ok(logged(log, 'info').some((m) => /Reconnected/.test(m)));
});

test('two failures are not enough to mark accessories stale', async () => {
  const { state, clock, api } = await startPlatform({}, { hubs: [hub()] });
  const zone = api.registered.find((a) => a.displayName === 'Front Door');
  state.hubsError = new Error('blip');
  for (let i = 0; i < 2; i++) {
    clock.alarmInterval().fn();
    await flush();
  }
  assert.equal(zone.getService(Service.ContactSensor).value(C.StatusActive), true);
});

// --- Poll cadence ------------------------------------------------------------

test('the poll backs off while the realtime feed is up, and speeds back up when it drops', async () => {
  const { state, clock } = await startPlatform({}, { hubs: [hub()] });
  assert.equal(clock.alarmInterval().ms, 10_000, 'starts at the configured cadence');

  state.devices.hooks.onStatus(true);
  assert.equal(clock.alarmInterval().ms, 60_000, 'realtime up → backstop cadence');

  state.devices.hooks.onStatus(false);
  assert.equal(clock.alarmInterval().ms, 10_000, 'realtime down → configured cadence');
});

test('a realtime drop also triggers an immediate refresh', async () => {
  const { state, clock } = await startPlatform({}, { hubs: [hub()] });
  state.devices.hooks.onStatus(true);
  const before = state.calls.getAlarmHubs;

  state.devices.hooks.onStatus(false);
  clock.runTimeouts(); // the coalescing window
  await flush();

  assert.ok(state.calls.getAlarmHubs > before, 'state may have changed while the feed was down');
});

test('a configured interval slower than the backstop is left alone', async () => {
  // 180s, not 300s: the fake clock tells the two intervals apart by period, and 300s is the
  // camera re-discovery one.
  const { state, clock } = await startPlatform({ refreshInterval: 180 }, { hubs: [hub()] });
  state.devices.hooks.onStatus(true);
  assert.equal(clock.alarmInterval().ms, 180_000);
});

// --- Cameras -----------------------------------------------------------------

test('a camera is ONE accessory carrying a contact sensor per detection type', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person', 'package'] } })] },
  );
  // The accessory count is the point: one per camera however many detections it supports, which is
  // what keeps a large site under HomeKit's 149-per-bridge ceiling.
  assert.deepEqual(names(api.registered).filter((n) => n.startsWith('Front Yard')), ['Front Yard']);

  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  assert.ok(cam.getServiceById(Service.ContactSensor, 'smartDetect.person'), 'person sensor');
  assert.ok(cam.getServiceById(Service.ContactSensor, 'smartDetect.package'), 'package sensor');
});

test('a camera removed from Protect is pruned, and the alarm side is untouched', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  assert.ok(names(api.registered).includes('Front Yard'));

  state.cameras = [];
  clock.cameraInterval().fn(); // camera re-discovery
  await flush();

  assert.deepEqual(names(api.unregistered), ['Front Yard']);
});

// A pruned camera can still own a live ffmpeg transcode and a pending motion safety-clear.
// Once its map entry is gone nothing can reach them again, so the process would survive until
// Homebridge restarts. (Reaching into the handler map is deliberate: `shutdown` is the contract
// under test and there is no public surface that reports it.)
test('pruning a camera shuts its handler down before dropping it', async () => {
  const { platform, api, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const camUuid = api.registered.find((a) => a.displayName === 'Front Yard').UUID;
  const stopped = [];
  const handler = platform.cameraHandlers.get(camUuid);
  const real = handler.shutdown.bind(handler);
  // A pruned camera can hold a live ffmpeg transcode and pending safety-clear timers; once the map
  // entry is gone nothing can reach them, so shutdown MUST happen before the drop.
  handler.shutdown = () => {
    stopped.push(camUuid);
    real();
  };

  state.cameras = [];
  clock.cameraInterval().fn();
  await flush();

  assert.deepEqual(stopped, [camUuid]);
});

// --- Camera include/exclude filter -------------------------------------------
// The point of the filter is splitting a large site across two child bridges, each with its own
// 149-accessory budget — so it must gate accessory CREATION, not just visibility.

test('only the included cameras get accessories', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false, includeCameras: ['Front Yard'] },
    {
      hubs: [hub()],
      cameras: [
        camera({ featureFlags: { smartDetectTypes: ['person'] } }),
        camera({ id: 'cam-2', name: 'Back Yard', featureFlags: { smartDetectTypes: ['person'] } }),
      ],
    },
  );
  const registered = names(api.registered);
  assert.ok(registered.includes('Front Yard'));
  // An excluded camera must produce no accessory at all.
  assert.ok(!registered.some((n) => n.startsWith('Back Yard')), `unexpected: ${registered.join(', ')}`);
});

test('excludeCameras drops a camera that would otherwise be exposed', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false, excludeCameras: ['cam-1'] },
    { hubs: [hub()], cameras: [camera(), camera({ id: 'cam-2', name: 'Back Yard' })] },
  );
  assert.deepEqual(names(api.registered).filter((n) => n.includes('Yard')), ['Back Yard']);
});

// Excluding a camera that is already paired must reconcile it away, not orphan its tile.
test('a camera added to the exclude list is pruned on the next discovery pass', async () => {
  const { api, state, clock, platform } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  assert.ok(names(api.registered).includes('Front Yard'));

  platform.config.excludeCameras = ['Front Yard'];
  clock.cameraInterval().fn();
  await flush();

  assert.deepEqual(names(api.unregistered), ['Front Yard']);
  assert.equal(state.cameras.length, 1, 'the camera is still on the console, only filtered out');
});

// A typo silently exposes nothing (include) or exposes something meant to stay private (exclude),
// and both read as a plugin fault with nothing in the log to explain them.
test('a filter entry matching no camera warns once, not once per discovery pass', async () => {
  const { log, clock } = await startPlatform(
    { exposeCameraStreams: false, includeCameras: ['Front Yard', 'Frnt Yrd'], excludeCameras: ['nosuch'] },
    { hubs: [hub()], cameras: [camera()] },
  );
  clock.cameraInterval().fn();
  await flush();

  const warnings = logged(log, 'warn').filter((m) => /matches no camera/.test(m));
  assert.equal(warnings.length, 2, `expected one per bad entry: ${warnings.join(' | ')}`);
  assert.ok(warnings.some((m) => m.includes('frnt yrd')));
  assert.ok(warnings.some((m) => m.includes('nosuch')));
  assert.ok(!warnings.some((m) => m.includes('front yard')), 'a matching entry must not warn');
});

test('a camera renamed in Protect renames its services and its detection sensors', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');

  state.cameras = [camera({ name: 'Driveway', featureFlags: { smartDetectTypes: ['person'] } })];
  clock.cameraInterval().fn();
  await flush();

  assert.equal(cam.displayName, 'Driveway');
  // The service label matters as much as the accessory name: HomeKit reads both, and leaving
  // the old one there is how a renamed camera keeps showing its old name in the Home app.
  assert.equal(cam.getService(Service.MotionSensor).value(C.Name), 'Driveway');
  // The detection sensors are labelled FROM the camera's name, so they have to follow it.
  const person = cam.getServiceById(Service.ContactSensor, 'smartDetect.person');
  assert.equal(person.value(C.Name), 'Driveway Person');
  assert.equal(person.value(C.ConfiguredName), 'Driveway Person');
  assert.equal(api.unregistered.length, 0, 'a rename must not re-create the accessories');
});

test('requestRefresh coalesces a burst of realtime deltas into one fetch', async () => {
  const { state, clock } = await startPlatform({}, { hubs: [hub()] });
  const before = state.calls.getAlarmHubs;

  for (let i = 0; i < 5; i++) {
    state.devices.onChange();
  }
  clock.runTimeouts();
  await flush();

  assert.equal(state.calls.getAlarmHubs, before + 1, 'five deltas must not mean five requests');
});

// The two reconcilers walk the same accessory map. Without the domain tag, whichever ran last
// would delete everything the other owns.
test('camera discovery never prunes alarm accessories, and vice versa', async () => {
  const { api, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  clock.cameraInterval().fn(); // camera pass
  clock.alarmInterval().fn(); // alarm pass
  await flush();
  assert.equal(api.unregistered.length, 0);
});

test('camera discovery failure warns once and recovers loudly', async () => {
  const { log, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [], camerasError: new Error('timeout') },
  );
  assert.equal(logged(log, 'warn').filter((m) => /Camera discovery failed/.test(m)).length, 1);

  clock.cameraInterval().fn();
  await flush();
  assert.equal(logged(log, 'warn').filter((m) => /Camera discovery failed/.test(m)).length, 1, 'still once');

  state.camerasError = undefined;
  clock.cameraInterval().fn();
  await flush();
  assert.ok(logged(log, 'info').some((m) => /Camera discovery recovered/.test(m)));
});

test('a disconnected camera keeps its accessory but is marked unavailable', async () => {
  const { api, log, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');

  state.cameras = [camera({ state: 'DISCONNECTED', featureFlags: { smartDetectTypes: ['person'] } })];
  clock.cameraInterval().fn();
  await flush();

  assert.equal(api.unregistered.length, 0, 'an offline camera must not be pruned');
  assert.equal(cam.getService(Service.MotionSensor).value(C.StatusActive), false);
  // The detection sensors are fed by the same event stream, so they are exactly as stale.
  assert.equal(
    cam.getServiceById(Service.ContactSensor, 'smartDetect.person').value(C.StatusActive), false,
  );
  assert.ok(logged(log, 'warn').some((m) => /Front Yard.*disconnected/.test(m)));
});

test('detection types switched off in Protect are called out once', async () => {
  const { log, clock } = await startPlatform(
    { exposeCameraStreams: false },
    {
      hubs: [hub()],
      cameras: [
        camera({
          featureFlags: { smartDetectTypes: ['person', 'package'] },
          smartDetectSettings: { objectTypes: ['person'] },
        }),
      ],
    },
  );
  const notices = logged(log, 'info').filter((m) => /package.*turned off in Protect/.test(m));
  assert.equal(notices.length, 1);

  clock.cameraInterval().fn();
  await flush();
  assert.equal(logged(log, 'info').filter((m) => /turned off in Protect/.test(m)).length, 1, 'once, not per pass');
});

// --- Event routing -----------------------------------------------------------

test('a motion event reaches the camera it belongs to', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');

  state.events.onEvent({ type: 'add', item: { type: 'motion', device: 'cam-1' } });
  assert.equal(cam.getService(Service.MotionSensor).value(C.MotionDetected), true);

  state.events.onEvent({ type: 'update', item: { type: 'motion', device: 'cam-1', end: 123 } });
  assert.equal(cam.getService(Service.MotionSensor).value(C.MotionDetected), false);
});

test('a smart detection trips its own contact sensor, not the camera motion sensor', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  const person = cam.getServiceById(Service.ContactSensor, 'smartDetect.person');

  state.events.onEvent({ item: { type: 'smartDetectZone', device: 'cam-1', smartDetectTypes: ['person'] } });

  assert.equal(person.value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  // The camera's MotionSensor is HomeKit's singular "this camera detected motion" signal and drives
  // its notifications; an object detection must not also claim it, or one event reports twice.
  assert.equal(cam.getService(Service.MotionSensor).value(C.MotionDetected), false);
});

test('a ring from a camera we did not flag as a doorbell warns once with the fix', async () => {
  const { state, log } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  state.events.onEvent({ item: { type: 'ring', device: 'cam-1' } });
  state.events.onEvent({ item: { type: 'ring', device: 'cam-1' } });

  const warns = logged(log, 'warn').filter((m) => /doorbellDeviceIds/.test(m));
  assert.equal(warns.length, 1);
});

test('an event for an unknown camera is warned about once, not silently dropped', async () => {
  const { state, log } = await startPlatform({ exposeCameraStreams: false }, { hubs: [hub()], cameras: [camera()] });
  state.events.onEvent({ item: { type: 'motion', device: 'ghost-cam' } });
  state.events.onEvent({ item: { type: 'motion', device: 'ghost-cam' } });
  assert.equal(logged(log, 'warn').filter((m) => /ghost-cam/.test(m)).length, 1);
});

// A detection we expect but never see (the standing example is package detection) is
// indistinguishable from one Protect never sent — unless the undecodable payloads are captured.
test('an event we decode nothing from is logged once per type, with its payload', async () => {
  const { state, log } = await startPlatform({ exposeCameraStreams: false }, { hubs: [hub()], cameras: [camera()] });
  state.events.onEvent({ item: { type: 'alarmHubEntryOpened', device: 'hub-1' } });
  state.events.onEvent({ item: { type: 'alarmHubEntryOpened', device: 'hub-1' } });
  state.events.onEvent({ item: { type: 'somethingBrandNew', device: 'cam-1', metadata: { a: 1 } } });

  const notes = logged(log, 'debug').filter((m) => /no camera detection decoded/.test(m));
  assert.equal(notes.length, 2, 'once per type');
  assert.ok(notes.some((m) => /somethingBrandNew/.test(m) && /"a":1/.test(m)), 'payload captured');
});

// The alarm hub's own events share the camera feed, and its entry events carry the keypad PIN
// used to disarm. Dumping the payload verbatim would write that PIN into a log people paste
// into bug reports.
test('an unhandled alarm event is logged without its keypad PIN', async () => {
  const { state, log } = await startPlatform({ exposeCameraStreams: false }, { hubs: [hub()], cameras: [camera()] });

  state.events.onEvent({
    item: {
      type: 'alarmHubEntryOpened',
      device: 'hub-1',
      metadata: { deviceName: 'Front Door', status: 'opened', pin: '4821' },
    },
  });

  const all = log.entries.map((e) => e.msg).join('\n');
  assert.ok(!all.includes('4821'), 'the keypad PIN reached the log');
  assert.ok(all.includes('<redacted>'), 'the field should still be shown as present but hidden');
});

test('discovery and event routing agree on the accessory id', async () => {
  // The one thing that silently breaks every detection: the two sides deriving different UUIDs.
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  assert.equal(cam.UUID, generateUuid('cam-1:camera'));
  // Detections resolve to the SAME accessory and then to a subtyped service on it, so the routing
  // key is the camera's — a detection landing anywhere else is the failure this guards.
  assert.ok(cam.getServiceById(Service.ContactSensor, 'smartDetect.person'));
});

// --- Config gates + lifecycle ------------------------------------------------

test('missing credentials leave the plugin idle instead of half-started', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  new UnifiProtectPlatform(log, { platform: 'UnifiProtectIntegration' }, api, {
    createClient: () => {
      throw new Error('should not build a client without credentials');
    },
    ...clock.deps,
  });
  api.emit('didFinishLaunching');
  await flush();
  assert.ok(logged(log, 'error').some((m) => /Missing "host" or "apiKey"/.test(m)));
  assert.equal(api.registered.length, 0);
});

test('exposeAlarm:false exposes cameras only and never polls the hub', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeAlarm: false, exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  assert.deepEqual(names(api.registered), ['Front Yard']);
  assert.equal(state.calls.getAlarmHubs, 0);
  assert.equal(clock.intervals.filter((i) => i.ms === 10_000).length, 0, 'no alarm poll timer');
});

test('exposeCameras:false skips camera discovery and its subscription entirely', async () => {
  const { api, state } = await startPlatform({ exposeCameras: false }, { hubs: [hub()], cameras: [camera()] });
  assert.ok(!names(api.registered).includes('Front Yard'));
  assert.equal(state.calls.getCameras, 0);
  assert.equal(state.events, undefined, 'no events subscription without cameras');
});

// Without realtime, cameras used to vanish entirely — discovery lived inside the realtime branch.
test('useRealtime:false still exposes cameras, just without live detections', async () => {
  const { api, state, log } = await startPlatform(
    { useRealtime: false, exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  assert.ok(names(api.registered).includes('Front Yard'));
  assert.equal(state.devices, undefined);
  assert.equal(state.events, undefined);
  assert.ok(logged(log, 'info').some((m) => /Realtime is off/.test(m)));
});

test('shutdown clears both timers, disposes the feeds, and closes the client', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  api.emit('shutdown');
  await flush();

  assert.ok(clock.intervals.every((i) => i.cleared), 'no timer may outlive the platform');
  assert.equal(state.devices.disposed, true);
  assert.equal(state.events.disposed, true);
  assert.equal(state.closed, true);
});

test('restored cached accessories are reused rather than registered again', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient({ hubs: [hub()] });
  const platform = new UnifiProtectPlatform(
    log,
    { platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key' },
    api,
    { createClient: () => client, probeAudioCodec: async () => ({ encoder: 'libopus', hapCodec: 'OPUS' }), ...clock.deps },
  );
  // Homebridge replays the cached accessories before didFinishLaunching.
  const cached = new api.platformAccessory('Front Door', generateUuid(`${HUB_MAC}:zone:0:contact`), 10);
  cached.context.domain = 'alarm';
  platform.configureAccessory(cached);

  api.emit('didFinishLaunching');
  await flush();

  assert.ok(!names(api.registered).includes('Front Door'), 'the cached zone was reused');
  assert.equal(api.unregistered.length, 0);
});

// --- Audio alarm sensors (end to end) ----------------------------------------

/** A camera shaped like the live Front Door: smoke + CO + the combined type all enabled. */
const alarmCamera = () =>
  camera({
    featureFlags: { smartDetectTypes: ['person'], smartDetectAudioTypes: ['alrmSmoke', 'alrmCmonx'] },
    smartDetectSettings: { objectTypes: ['person'], audioTypes: ['smoke_cmonx', 'alrmSmoke', 'alrmCmonx'] },
  });

test('audio sensors are not created unless the option is on', async () => {
  const { api } = await startPlatform({ exposeCameraStreams: false }, { hubs: [hub()], cameras: [alarmCamera()] });
  const registered = names(api.registered);
  assert.ok(!registered.some((n) => /Smoke|CO Alarm/.test(n)), `unexpected alarm sensors: ${registered}`);
});

test('enabling audio sensors registers one native sensor per service', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    { hubs: [hub()], cameras: [alarmCamera()] },
  );
  const registered = names(api.registered);
  // Exactly one of each despite three overlapping Protect types being enabled.
  assert.equal(registered.filter((n) => n === 'Front Yard Smoke Alarm').length, 1);
  assert.equal(registered.filter((n) => n === 'Front Yard CO Alarm').length, 1);
});

test('a smoke detection reaches the native SmokeSensor, not a motion sensor', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    { hubs: [hub()], cameras: [alarmCamera()] },
  );
  const smoke = api.registered.find((a) => a.displayName === 'Front Yard Smoke Alarm');

  state.events.onEvent({ item: { type: 'smartAudioDetect', device: 'cam-1', smartDetectTypes: ['alrmSmoke'] } });

  assert.equal(smoke.getService(Service.SmokeSensor).value(C.SmokeDetected), C.SmokeDetected.SMOKE_DETECTED);

  state.events.onEvent({
    item: { type: 'smartAudioDetect', device: 'cam-1', smartDetectTypes: ['alrmSmoke'], end: 1 },
  });
  assert.equal(smoke.getService(Service.SmokeSensor).value(C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED);
});

// One Protect detection, two HomeKit sensors. Collapsing it to smoke alone would silently drop CO
// for anyone automating on it.
test('a combined smoke/CO detection fires both sensors', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    { hubs: [hub()], cameras: [alarmCamera()] },
  );
  const smoke = api.registered.find((a) => a.displayName === 'Front Yard Smoke Alarm');
  const co = api.registered.find((a) => a.displayName === 'Front Yard CO Alarm');

  state.events.onEvent({ item: { type: 'smartAudioDetect', device: 'cam-1', smartDetectTypes: ['smoke_cmonx'] } });

  assert.equal(smoke.getService(Service.SmokeSensor).value(C.SmokeDetected), C.SmokeDetected.SMOKE_DETECTED);
  assert.equal(
    co.getService(Service.CarbonMonoxideSensor).value(C.CarbonMonoxideDetected),
    C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL,
  );
});

test('an audio detection with the option off is warned about, not silently dropped', async () => {
  const { state, log } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [alarmCamera()] },
  );
  state.events.onEvent({ item: { type: 'smartAudioDetect', device: 'cam-1', smartDetectTypes: ['alrmSmoke'] } });
  state.events.onEvent({ item: { type: 'smartAudioDetect', device: 'cam-1', smartDetectTypes: ['alrmSmoke'] } });

  const warns = logged(log, 'warn').filter((m) => /exposeAudioSensors/.test(m));
  assert.equal(warns.length, 1, 'warned once, with the fix named');
});

test('an offline camera deactivates its alarm sensors too', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    { hubs: [hub()], cameras: [alarmCamera()] },
  );
  const smoke = api.registered.find((a) => a.displayName === 'Front Yard Smoke Alarm');

  state.cameras = [{ ...alarmCamera(), state: 'DISCONNECTED' }];
  clock.cameraInterval().fn();
  await flush();

  assert.equal(smoke.getService(Service.SmokeSensor).value(C.StatusActive), false);
});

// --- Chimes ------------------------------------------------------------------

const CHIME_TRIGGER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const chimeDevice = (over = {}) => ({
  id: 'chime-1', modelKey: 'chime', name: 'Doorbell Chime', state: 'CONNECTED',
  cameraIds: ['cam-1'],
  ringSettings: [{ cameraId: 'cam-1', volume: 80, ringtoneId: 'ring-1', repeatTimes: 2 }],
  ...over,
});

const withChime = { exposeCameraStreams: false, chimeTriggerId: CHIME_TRIGGER };

test('a configured chime is registered as a ring button', async () => {
  const { api, state } = await startPlatform(withChime, { hubs: [hub()], cameras: [], chimes: [chimeDevice()] });
  assert.ok(names(api.registered).includes('Doorbell Chime'));
  assert.equal(state.calls.getChimes, 1);
});

// The API has no ring endpoint, so without a Trigger ID there is nothing the button could do.
// Skipping discovery entirely also saves a request against a 10/s rate limit.
test('with neither control configured there is no chime accessory and no chime request', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
  );
  assert.ok(!names(api.registered).includes('Doorbell Chime'));
  assert.equal(state.calls.getChimes, 0);
});

test('exposeChimes:false skips chime discovery even with a Trigger ID', async () => {
  const { api, state } = await startPlatform(
    { ...withChime, exposeChimes: false },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
  );
  assert.ok(!names(api.registered).includes('Doorbell Chime'));
  assert.equal(state.calls.getChimes, 0);
});

test('pressing the chime button fires the configured Alarm Manager webhook', async () => {
  const { api, state } = await startPlatform(withChime, { hubs: [hub()], cameras: [], chimes: [chimeDevice()] });
  const accessory = api.registered.find((a) => a.displayName === 'Doorbell Chime');
  await accessory.getServiceById(Service.Switch, 'ring').getCharacteristic(C.On).setHandler(true);

  assert.deepEqual(state.webhooks, [CHIME_TRIGGER]);
});

// The two controls are independent config knobs, so the mute switch must work with no Trigger ID.
test('the mute switch alone is enough to create a chime accessory', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false, exposeChimeMute: true },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
  );
  const accessory = api.registered.find((a) => a.displayName === 'Doorbell Chime');
  assert.ok(accessory, 'accessory exists with no Trigger ID configured');
  assert.equal(accessory.getServiceById(Service.Switch, 'ring'), undefined, 'no ring button');

  await accessory.getServiceById(Service.Switch, 'mute').getCharacteristic(C.On).setHandler(false);
  assert.deepEqual(state.chimePatches.map((p) => p.patch.ringSettings[0].volume), [0]);
  assert.deepEqual(state.webhooks, []);
});

// Chimes and cameras are reconciled separately; the domain tag is what stops each prune from
// deleting the other's accessories.
test('the camera reconcile never prunes a chime, and vice versa', async () => {
  const { api, clock } = await startPlatform(withChime, { hubs: [hub()], cameras: [camera()], chimes: [chimeDevice()] });
  assert.ok(names(api.registered).includes('Doorbell Chime'));
  assert.ok(names(api.registered).includes('Front Yard'));

  clock.cameraInterval().fn();
  await flush();

  assert.equal(api.unregistered.length, 0);
});

test('a chime removed from Protect is pruned', async () => {
  const { api, state, clock } = await startPlatform(withChime, { hubs: [hub()], cameras: [], chimes: [chimeDevice()] });
  state.chimes = [];
  clock.cameraInterval().fn();
  await flush();
  assert.deepEqual(names(api.unregistered), ['Doorbell Chime']);
});

test('chime discovery failure warns once and does not stop camera discovery', async () => {
  const { api, log, state } = await startPlatform(
    withChime,
    { hubs: [hub()], cameras: [camera()], chimes: [], chimesError: new Error('timeout') },
  );
  assert.equal(logged(log, 'warn').filter((m) => /Chime discovery failed/.test(m)).length, 1);
  // The camera side must be unaffected by the chime failure.
  assert.ok(names(api.registered).includes('Front Yard'));
  assert.ok(state.calls.getCameras > 0);
});

// --- Orphaned accessories when a feature is switched off ----------------------
// Skipping a domain by returning early leaves any cached accessory registered with no handler
// bound: HomeKit shows the tile at its last cached value and silently discards writes. That is
// exactly what happened in the field — a chime switch stuck "on" that did nothing after the chime
// gained a config gate it had not needed before.

/** Replay a cached accessory the way Homebridge does, before didFinishLaunching. */
async function startWithCached(config, clientState, cachedName, domain, seed) {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient(clientState);
  const platform = new UnifiProtectPlatform(
    log,
    { platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key', ...config },
    api,
    { createClient: () => client, probeAudioCodec: async () => ({ encoder: 'libopus', hapCodec: 'OPUS' }), ...clock.deps },
  );
  const cached = new api.platformAccessory(cachedName, generateUuid(seed), 8);
  cached.context.domain = domain;
  platform.configureAccessory(cached);
  api.emit('didFinishLaunching');
  await flush();
  return { api, log, state: client.state };
}

test('a cached chime accessory is pruned when no chime controls are configured', async () => {
  const { api, log, state } = await startWithCached(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
    'Doorbell Chime', 'chime', 'chime-1:chime',
  );
  assert.deepEqual(names(api.unregistered), ['Doorbell Chime'], 'a dead switch must not linger');
  assert.equal(state.calls.getChimes, 0, 'and no request is wasted discovering chimes');
  assert.ok(logged(log, 'info').some((m) => /no chime controls configured/.test(m)));
});

test('a cached chime accessory is pruned when exposeChimes is turned off', async () => {
  const { api, log } = await startWithCached(
    { exposeCameraStreams: false, exposeChimes: false, chimeTriggerId: CHIME_TRIGGER },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
    'Doorbell Chime', 'chime', 'chime-1:chime',
  );
  assert.deepEqual(names(api.unregistered), ['Doorbell Chime']);
  assert.ok(logged(log, 'info').some((m) => /exposeChimes is off/.test(m)));
});

test('a configured chime accessory is kept, not pruned', async () => {
  const { api } = await startWithCached(
    { exposeCameraStreams: false, chimeTriggerId: CHIME_TRIGGER },
    { hubs: [hub()], cameras: [], chimes: [chimeDevice()] },
    'Doorbell Chime', 'chime', 'chime-1:chime',
  );
  assert.equal(api.unregistered.length, 0);
});

test('a cached camera accessory is pruned when exposeCameras is turned off', async () => {
  const { api, log } = await startWithCached(
    { exposeCameras: false },
    { hubs: [hub()], cameras: [camera()] },
    'Front Yard', 'camera', 'cam-1:camera',
  );
  assert.deepEqual(names(api.unregistered), ['Front Yard']);
  assert.ok(logged(log, 'info').some((m) => /exposeCameras is off/.test(m)));
});

// Pruning must not take the alarm side with it — the domains are independent.
test('pruning a disabled domain leaves other domains alone', async () => {
  const { api } = await startWithCached(
    { exposeCameras: false },
    { hubs: [hub()] },
    'Front Yard', 'camera', 'cam-1:camera',
  );
  assert.deepEqual(names(api.unregistered), ['Front Yard']);
  assert.ok(names(api.registered).includes('Security System'), 'alarm accessories still registered');
});

// Talkback is offered only to cameras that actually have a speaker. Asking a speakerless camera is
// answered 503, and a retried 503 cost ~7s of blocked video; the capability comes free from data
// discovery already fetched. User-visible consequence: the microphone button only on the doorbell.
test('twoWayAudio is declared only for cameras with a speaker', async () => {
  const { api } = await startPlatform(
    { exposeCameraAudio: true, exposeTalkback: true },
    {
      hubs: [hub()],
      cameras: [
        { id: 'bell', modelKey: 'camera', name: 'Front Door', featureFlags: { hasSpeaker: true, hasMic: true } },
        { id: 'plain', modelKey: 'camera', name: 'Gatehouse', featureFlags: { hasSpeaker: false, hasMic: true } },
      ],
    },
  );
  // Scoped to the CAMERA domain deliberately: an alarm zone and a camera can share a name (the
  // real console has both a "Front Door" zone and a "Front Door" doorbell), so a bare find-by-name
  // resolves to whichever registered first — an ordering these two independent async flows do not
  // and should not guarantee.
  const twoWay = (name) =>
    cameraNamed(api, name)?.controller?.config?.streamingOptions?.audio?.twoWayAudio;

  assert.equal(twoWay('Front Door'), true, 'the doorbell has a speaker');
  assert.equal(twoWay('Gatehouse'), false, 'a speakerless camera must not offer a microphone');
});

test('exposeTalkback:false declares twoWayAudio nowhere, speaker or not', async () => {
  const { api } = await startPlatform(
    { exposeCameraAudio: true },
    {
      hubs: [hub()],
      cameras: [{ id: 'bell', modelKey: 'camera', name: 'Front Door', featureFlags: { hasSpeaker: true } }],
    },
  );
  // Camera-scoped: the hub fixture also has a zone called "Front Door".
  const ctl = cameraNamed(api, 'Front Door')?.controller;
  assert.equal(ctl?.config?.streamingOptions?.audio?.twoWayAudio, false);
});

// The status light is controllable on only some models; on the rest the console ignores the write, so
// the switch must not exist there at all.
test('a status-light switch appears only on cameras that can control their LED', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false, exposeStatusLed: true },
    {
      hubs: [hub()],
      cameras: [
        { id: 'bell', modelKey: 'camera', name: 'Front Door', featureFlags: { hasLedStatus: true } },
        { id: 'plain', modelKey: 'camera', name: 'Gatehouse', featureFlags: { hasLedStatus: false } },
      ],
    },
  );
  const led = (name) =>
    api.registered.find((a) => a.displayName === name)?.getServiceById(Service.Switch, 'led');

  assert.ok(led('Front Door'), 'the doorbell reports a controllable LED');
  assert.equal(led('Gatehouse'), undefined, 'a camera that cannot must get no switch');
});

test('exposeStatusLed:false creates no switch even on a capable camera', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [{ id: 'bell', modelKey: 'camera', name: 'Front Door', featureFlags: { hasLedStatus: true } }] },
  );
  // Camera-scoped: the hub fixture also has a "Front Door" ZONE, which never has a switch — so a
  // bare find-by-name would satisfy this assertion without ever looking at the camera.
  const acc = cameraNamed(api, 'Front Door');
  assert.equal(acc?.getServiceById(Service.Switch, 'led'), undefined);
});

// Past HAP's 149-per-bridge limit HomeKit silently stops accepting accessories, which reads as
// "some cameras are missing" with nothing to explain it. A camera is ONE accessory, so reaching the
// ceiling now takes a large site with the smoke/CO sensors on, or a hub contributing one per zone.
test('the bridge warns once as it approaches the HomeKit accessory limit', async () => {
  // A camera is one accessory now, so reaching 130 takes a real site: 45 cameras with the smoke/CO
  // sensors on is 45 x 3 = 135. That those two stay separate accessories is exactly why the ceiling
  // is still reachable at all.
  const many = Array.from({ length: 45 }, (_, i) => ({
    id: `cam${i}`, modelKey: 'camera', name: `Camera ${i}`,
    featureFlags: { smartDetectTypes: ['person', 'vehicle', 'animal'] },
    smartDetectSettings: { objectTypes: ['person', 'vehicle', 'animal'], audioTypes: ['alrmSmoke', 'alrmCmonx'] },
  }));
  const { log, clock } = await startPlatform(
    { exposeCameraStreams: false, exposeObjectSensors: true, exposeAudioSensors: true },
    { hubs: [hub()], cameras: many },
  );
  const budget = () => logged(log, 'warn').filter((m) => /HomeKit's limit is 149/.test(m));
  assert.equal(budget().length, 1, `expected one budget warning, got ${budget().length}`);
  // The remedy that keeps every accessory must be named FIRST; losing sensors is the fallback.
  assert.match(budget()[0], /child bridge/i, 'offers the split that keeps everything');
  assert.match(budget()[0], /exposeCameras|exposeAlarm|includeCameras/, 'says how to split');
  assert.match(budget()[0], /exposeAudioSensors/, 'still says which setting reduces the count');
  assert.ok(
    budget()[0].indexOf('child bridge') < budget()[0].indexOf('exposeAudioSensors'),
    'the lossless fix must come before the lossy one',
  );

  // A second discovery pass must not repeat it.
  clock.cameraInterval().fn();
  await flush();
  assert.equal(budget().length, 1, 'warned once, not per pass');
});

test('a small bridge gets no budget warning', async () => {
  const { log } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  assert.equal(logged(log, 'warn').filter((m) => /accessor/i.test(m)).length, 0);
});

// --- One accessory per camera ------------------------------------------------
// The layout the plugin commits to: a camera is a single HomeKit accessory whose smart detections
// are ContactSensor services on it. There is no per-type-accessory alternative, so these pin the
// properties that made it the right choice.

const camWithTypes = (over = {}) => camera({
  featureFlags: { smartDetectTypes: ['person', 'vehicle'] },
  smartDetectSettings: { objectTypes: ['person', 'vehicle'] },
  ...over,
});

test('a camera is ONE accessory however many detection types it supports', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camWithTypes()] },
  );
  const cameraSide = names(api.registered).filter((n) => n.startsWith('Front Yard'));
  assert.deepEqual(cameraSide, ['Front Yard'], `expected only the camera, got: ${cameraSide.join(', ')}`);
});

test('a detection trips its contact sensor and clears on the end event', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camWithTypes()] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  const person = cam.getServiceById(Service.ContactSensor, 'smartDetect.person');
  assert.ok(person, 'the camera carries a person contact sensor');

  state.events.onEvent({ item: { type: 'smartDetectZone', device: 'cam-1', smartDetectTypes: ['person'] } });
  assert.equal(person.value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  // The camera's own motion signal stays untouched — that is the point of using contact sensors.
  // Asserted as exactly false, not merely "not true": construction seeds it false, so `notEqual`
  // would also pass on an unwritten characteristic and prove nothing about the routing.
  assert.equal(cam.getService(Service.MotionSensor).value(C.MotionDetected), false);

  state.events.onEvent({ item: { type: 'smartDetectZone', device: 'cam-1', smartDetectTypes: ['person'], end: 9 } });
  assert.equal(person.value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
});

// Turning the feature off must not leave a control HomeKit still shows and nothing can drive.
test('exposeObjectSensors:false removes the detection sensors, keeping the camera', async () => {
  const { api, platform, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camWithTypes()] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  assert.ok(cam.getServiceById(Service.ContactSensor, 'smartDetect.person'));

  platform.config.exposeObjectSensors = false;
  clock.cameraInterval().fn();
  await flush();

  assert.equal(
    cam.getServiceById(Service.ContactSensor, 'smartDetect.person'), undefined,
    'a dead contact sensor would still appear in the Home app with nothing driving it',
  );
  assert.equal(api.unregistered.length, 0, 'the camera accessory itself stays');
  assert.ok(cam.getService(Service.MotionSensor), 'overall motion survives');
});

// Documented behaviour worth pinning: the OBJECT sensors live on the camera, but the smoke/CO
// sensors deliberately stay their own accessories, because HomeKit treats a native SmokeSensor as a
// critical alert — which is the only reason to expose them. The README and CHANGELOG both state the
// resulting count, so a silent change here would make the docs wrong.
test('smoke/CO stay separate accessories while object sensors do not', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    {
      hubs: [hub()],
      cameras: [camera({
        featureFlags: { smartDetectTypes: ['person', 'vehicle'] },
        smartDetectSettings: { objectTypes: ['person', 'vehicle'], audioTypes: ['alrmSmoke'] },
      })],
    },
  );
  const mine = names(api.registered).filter((n) => n.startsWith('Front Yard'));
  assert.deepEqual(mine, ['Front Yard', 'Front Yard Smoke Alarm']);

  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  assert.ok(cam.getServiceById(Service.ContactSensor, 'smartDetect.person'), 'objects live on the camera');
});

// --- Malformed console payloads ----------------------------------------------
// A successful request can still carry an unusable body: `request()` returns undefined for an empty
// 200, and a proxy or firmware change can answer with a JSON object. Measured before the fix: five
// such shapes each reached an unhandled rejection through `void this.syncDevices()`, which Node
// treats as fatal — the whole bridge died with a bare TypeError and nothing about chimes in the log.
//
// The property that matters most is NOT "does not crash". It is "does not prune". Every reconciler
// reconciles against the payload it just read, so coercing a bad one to [] would read as "every
// device was removed" and unregister the user's accessories, losing their rooms and automations.
// That would be worse than the crash. These pin the failed-read behaviour instead.

const badPayloads = [
  ['an empty 200 body', undefined],
  ['a JSON object', {}],
  ['a bare string', 'oops'],
  ['a list with a junk entry', [null]],
  ['a list entry with no id', [{ name: 'nameless' }]],
];

for (const [label, payload] of badPayloads) {
  test(`a /cameras response of ${label} leaves existing cameras registered`, async () => {
    const { api, platform, clock, client } = await startPlatform(
      { exposeCameraStreams: false },
      { hubs: [hub()], cameras: [camera()] },
    );
    assert.ok(names(api.registered).includes('Front Yard'), 'registered on the good pass');

    client.getCameras = async () => payload;
    clock.cameraInterval().fn();
    await flush();

    assert.deepEqual(api.unregistered, [], 'a bad payload must never prune a camera');
    assert.ok(platform.cameraHandlers.size > 0, 'the handler must survive to keep driving the tile');
  });

  test(`a /chimes response of ${label} leaves existing chimes registered`, async () => {
    const cfg = { exposeCameras: false, exposeChimes: true, chimeTriggerId: 'trig-1', exposeCameraStreams: false };
    const { api, clock, client } = await startPlatform(cfg, { hubs: [hub()], chimes: [{ id: 'ch-1', name: 'Hallway Chime' }] });
    assert.ok(names(api.registered).includes('Hallway Chime'), 'registered on the good pass');

    client.getChimes = async () => payload;
    clock.cameraInterval().fn();
    await flush();

    assert.deepEqual(api.unregistered, [], 'a bad payload must never prune a chime');
  });
}

test('an unreadable payload is reported once, and recovery is announced', async () => {
  const { log, clock, client } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  const unreadable = () => logged(log, 'warn').filter((m) => /could not read/.test(m));

  client.getCameras = async () => ({});
  clock.cameraInterval().fn();
  await flush();
  assert.equal(unreadable().length, 1, 'the user must be told, not just the debug log');

  // Every 5 minutes forever would be log spam, so it reports the transition only.
  clock.cameraInterval().fn();
  await flush();
  assert.equal(unreadable().length, 1, 'reported once while it persists');

  client.getCameras = async () => [camera()];
  clock.cameraInterval().fn();
  await flush();
  assert.ok(logged(log, 'info').some((m) => /Camera discovery recovered/.test(m)), 'recovery is loud too');
});

// One odd camera used to abort the whole pass, so EVERY camera vanished from HomeKit — and the only
// trace was a debug line. A cosmetic field must not cost the user their other cameras.
test('a camera with a non-string name does not cost the other cameras', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera(), camera({ id: 'cam-2', name: 42 })] },
  );
  assert.ok(names(api.registered).includes('Front Yard'), 'the healthy camera still appears');
  assert.equal(api.registered.filter((a) => a.context?.domain === 'camera').length, 2);
});

// The outer safety net. `syncDevices` was called as a bare `void`, so anything throwing inside it
// became an unhandled rejection — fatal in Node. The chime reconcile is the half with no try/catch
// of its own, so a throw there is what actually reaches this net. If it were missing, node:test
// would report an unhandled rejection rather than these assertions failing.
test('an unexpected throw in a discovery pass is reported, not fatal', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient({ hubs: [hub()], chimes: [{ id: 'ch-1', name: 'Hallway Chime' }] });
  const boom = new Error('HAP said no');
  // From the accessory constructor, not from registration: a registration failure is now handled
  // inside acquireAccessory (logged, retried next pass) and deliberately does NOT reach this net.
  api.platformAccessory = function failing() {
    throw boom;
  };
  new UnifiProtectPlatform(
    log,
    {
      platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key',
      exposeCameras: false, exposeChimes: true, chimeTriggerId: 'trig-1',
    },
    api,
    { createClient: () => client, probeAudioCodec: async () => undefined, ...clock.deps },
  );
  api.emit('didFinishLaunching');
  await flush(8);

  const reported = logged(log, 'error').filter((m) => /Device discovery failed unexpectedly/.test(m));
  assert.equal(reported.length, 1, 'a defect here must be reportable, not silent');
  assert.match(reported[0], /HAP said no/, 'the cause is preserved, not flattened');
});

// undici's Agent.close() rejects (ClientDestroyedError) when the agent is already closed. A bare
// `void` on it made that an unhandled rejection during shutdown; node:test would surface one here.
test('a failure closing the console connection does not escape shutdown', async () => {
  const { platform, client, log } = await startPlatform({ exposeCameras: false }, { hubs: [hub()] });
  client.close = async () => {
    throw new Error('The client is destroyed');
  };

  platform.api.emit('shutdown');
  await flush();

  assert.ok(
    logged(log, 'debug').some((m) => /Closing the console connection failed/.test(m)),
    'the failure is recorded rather than thrown into the void',
  );
});

// A resync queued mid-pass is normally right: an events-socket reconnect during a slow discovery
// must still be honoured. But once Homebridge has asked us to stop, honouring it means a fresh round
// of console requests against a tearing-down bridge.
test('a resync queued as Homebridge shuts down is abandoned', async () => {
  const { platform, api, client, clock } = await startPlatform(
    { exposeCameraStreams: false, exposeChimes: false },
    { hubs: [hub()], cameras: [camera()] },
  );
  // Gate the next fetch so the pass is still in flight while we queue a resync and shut down.
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  client.getCameras = async () => {
    client.state.calls.getCameras += 1;
    await gate;
    return [camera()];
  };
  const before = client.state.calls.getCameras;

  clock.cameraInterval().fn(); // pass 1 — now parked on the gate
  await flush();
  clock.cameraInterval().fn(); // pass 2 — sees one in flight, so queues a resync
  await flush();
  api.emit('shutdown');
  release();
  await flush(8);

  assert.equal(
    client.state.calls.getCameras - before, 1,
    'the queued resync must not fetch again after shutdown',
  );
  assert.equal(platform.stopped, true);
});

// Reaching the outer net means a defect, so it has to be reportable — but repeating every discovery
// interval forever would bury the log it is meant to help someone read.
test('an unexpected discovery failure is reported once, then only at debug', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient({ hubs: [hub()], chimes: [{ id: 'ch-1', name: 'Hallway Chime' }] });
  // Thrown from the accessory CONSTRUCTOR, not from registration: `acquireAccessory` caches the
  // accessory before registering it, so a registration failure does not recur on the next pass.
  // This one does, which is what makes "once, then quietly" observable at all.
  api.platformAccessory = function failing() {
    throw new Error('HAP said no');
  };
  new UnifiProtectPlatform(
    log,
    {
      platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key',
      exposeCameras: false, exposeChimes: true, chimeTriggerId: 'trig-1',
    },
    api,
    { createClient: () => client, probeAudioCodec: async () => undefined, ...clock.deps },
  );
  api.emit('didFinishLaunching');
  await flush(8);

  clock.cameraInterval().fn(); // it fails the same way every pass
  await flush(8);

  const errors = logged(log, 'error').filter((m) => /Device discovery failed unexpectedly/.test(m));
  const debugs = logged(log, 'debug').filter((m) => /Device discovery failed unexpectedly/.test(m));
  assert.equal(errors.length, 1, 'loud exactly once');
  assert.ok(debugs.length >= 1, 'still recorded on later passes, just quietly');
});


// A transient registration failure used to hide the accessory FOREVER: the plugin cached it before
// registering, so it believed the accessory existed while HomeKit had never received it, and the
// cache hit meant no pass ever tried again. Nothing was logged either.
test('an accessory HomeKit refuses is retried on the next pass, not lost', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient({ hubs: [], cameras: [camera()] });
  const realRegister = api.registerPlatformAccessories.bind(api);
  let failNext = true;
  api.registerPlatformAccessories = (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('HAP registration failed');
    }
    return realRegister(...args);
  };
  new UnifiProtectPlatform(
    log,
    { platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key', exposeCameraStreams: false, exposeChimes: false },
    api,
    { createClient: () => client, probeAudioCodec: async () => undefined, ...clock.deps },
  );
  api.emit('didFinishLaunching');
  await flush(8);

  assert.equal(api.registered.length, 0, 'the failure really did stop it reaching HomeKit');
  assert.ok(
    logged(log, 'warn').some((m) => /HomeKit refused the accessory "Front Yard"/.test(m)),
    'and the user is told which accessory, rather than it vanishing silently',
  );

  clock.cameraInterval().fn();
  await flush(8);

  assert.deepEqual(names(api.registered), ['Front Yard'], 'the next pass registers it for real');
});

// One device HomeKit will not accept must not cost the others their pass.
test('a refused accessory does not stop the rest of the cameras registering', async () => {
  const log = makeLog();
  const api = fakeApi();
  const clock = fakeClock();
  const client = fakeClient({
    hubs: [],
    cameras: [camera(), camera({ id: 'cam-2', name: 'Back Yard' })],
  });
  const realRegister = api.registerPlatformAccessories.bind(api);
  api.registerPlatformAccessories = (plugin, platformName, accessories) => {
    if (accessories.some((a) => a.displayName === 'Front Yard')) {
      throw new Error('HAP registration failed');
    }
    return realRegister(plugin, platformName, accessories);
  };
  new UnifiProtectPlatform(
    log,
    { platform: 'UnifiProtectIntegration', host: '10.0.0.1', apiKey: 'key', exposeCameraStreams: false, exposeChimes: false },
    api,
    { createClient: () => client, probeAudioCodec: async () => undefined, ...clock.deps },
  );
  api.emit('didFinishLaunching');
  await flush(8);

  assert.deepEqual(names(api.registered), ['Back Yard'], 'the healthy camera is unaffected');
  assert.deepEqual(api.unregistered, [], 'and the refused one is not pruned either');
});

// --- Pruning is one implementation for every caller --------------------------
// Three near-identical prune loops had drifted: the chime reconcile's copy skipped the handler
// shutdown, and the feature-off copy never cleared the audio-sensor handlers. Both are the kind of
// gap that is invisible until the handler grows background work or a stale entry gets routed to.

test('a pruned chime has its handler shut down before it is dropped', async () => {
  const cfg = { exposeCameras: false, exposeChimes: true, chimeTriggerId: 'trig-1', exposeCameraStreams: false };
  const { platform, api, client, clock } = await startPlatform(cfg, {
    hubs: [hub()],
    chimes: [{ id: 'ch-1', name: 'Hallway Chime' }],
  });
  const id = api.registered.find((a) => a.displayName === 'Hallway Chime').UUID;
  let shutdownCalled = false;
  const handler = platform.chimeHandlers.get(id);
  const real = handler.shutdown.bind(handler);
  handler.shutdown = () => {
    shutdownCalled = true;
    real();
  };

  client.state.chimes = [];
  clock.cameraInterval().fn();
  await flush();

  assert.deepEqual(names(api.unregistered), ['Hallway Chime']);
  assert.equal(shutdownCalled, true, 'once the map entry is gone nothing can reach the handler');
  assert.equal(platform.chimeHandlers.size, 0);
});

test('switching a domain off clears every handler map, not just the obvious one', async () => {
  const { platform, api, clock } = await startPlatform(
    { exposeCameraStreams: false, exposeAudioSensors: true },
    {
      hubs: [hub()],
      cameras: [camera({ smartDetectSettings: { audioTypes: ['alrmSmoke'] } })],
    },
  );
  assert.ok(names(api.registered).includes('Front Yard Smoke Alarm'), 'the audio sensor exists first');
  assert.equal(platform.alarmHandlers.size, 1);

  // Driven through the real discovery interval, not by poking a private method: an optional call
  // like `platform.syncCameras?.()` silently becomes a no-op if the method is ever renamed, and the
  // test would keep passing while testing nothing.
  platform.config.exposeCameras = false;
  clock.cameraInterval().fn();
  await flush();

  assert.ok(names(api.unregistered).includes('Front Yard Smoke Alarm'));
  assert.equal(
    platform.alarmHandlers.size, 0,
    'a leftover handler is one realtime routing can still find, writing to a removed accessory',
  );
});
