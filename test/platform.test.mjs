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

test('cameras and their smart-detect sensors are registered', async () => {
  const { api } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person', 'package'] } })] },
  );
  const registered = names(api.registered);
  assert.ok(registered.includes('Front Yard'));
  assert.ok(registered.includes('Front Yard Person'));
  assert.ok(registered.includes('Front Yard Package'));
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
  const objUuid = api.registered.find((a) => a.displayName === 'Front Yard Person').UUID;
  const stopped = [];
  for (const [uuid, map] of [[camUuid, platform.cameraHandlers], [objUuid, platform.objectHandlers]]) {
    const handler = map.get(uuid);
    const real = handler.shutdown.bind(handler);
    handler.shutdown = () => {
      stopped.push(uuid);
      real();
    };
  }

  state.cameras = [];
  clock.cameraInterval().fn();
  await flush();

  assert.deepEqual(stopped.sort(), [camUuid, objUuid].sort());
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
  assert.ok(registered.includes('Front Yard Person'));
  // Not just the camera: an excluded camera must produce none of its derived sensors either.
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

  assert.deepEqual(names(api.unregistered), ['Front Yard', 'Front Yard Person']);
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

test('a camera renamed in Protect renames its services and its object sensors', async () => {
  const { api, state, clock } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  const person = api.registered.find((a) => a.displayName === 'Front Yard Person');

  state.cameras = [camera({ name: 'Driveway', featureFlags: { smartDetectTypes: ['person'] } })];
  clock.cameraInterval().fn();
  await flush();

  assert.equal(cam.displayName, 'Driveway');
  // The service label matters as much as the accessory name: HomeKit reads both, and leaving
  // the old one there is how a renamed camera keeps showing its old name in the Home app.
  assert.equal(cam.getService(Service.MotionSensor).value(C.Name), 'Driveway');
  assert.equal(person.displayName, 'Driveway Person');
  assert.equal(person.getService(Service.MotionSensor).value(C.Name), 'Driveway Person');
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
  const person = api.registered.find((a) => a.displayName === 'Front Yard Person');

  state.cameras = [camera({ state: 'DISCONNECTED', featureFlags: { smartDetectTypes: ['person'] } })];
  clock.cameraInterval().fn();
  await flush();

  assert.equal(api.unregistered.length, 0, 'an offline camera must not be pruned');
  assert.equal(cam.getService(Service.MotionSensor).value(C.StatusActive), false);
  assert.equal(person.getService(Service.MotionSensor).value(C.StatusActive), false);
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

test('a smart detection reaches its own object sensor, not the camera', async () => {
  const { api, state } = await startPlatform(
    { exposeCameraStreams: false },
    { hubs: [hub()], cameras: [camera({ featureFlags: { smartDetectTypes: ['person'] } })] },
  );
  const cam = api.registered.find((a) => a.displayName === 'Front Yard');
  const person = api.registered.find((a) => a.displayName === 'Front Yard Person');

  state.events.onEvent({ item: { type: 'smartDetectZone', device: 'cam-1', smartDetectTypes: ['person'] } });

  assert.equal(person.getService(Service.MotionSensor).value(C.MotionDetected), true);
  assert.notEqual(cam.getService(Service.MotionSensor).value(C.MotionDetected), true);
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
  const person = api.registered.find((a) => a.displayName === 'Front Yard Person');
  assert.equal(cam.UUID, generateUuid('cam-1:camera'));
  assert.equal(person.UUID, generateUuid('cam-1:object:person'));
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
  const twoWay = (name) =>
    api.registered.find((a) => a.displayName === name)?.controller?.config?.streamingOptions?.audio?.twoWayAudio;

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
  const ctl = api.registered.find((a) => a.displayName === 'Front Door')?.controller;
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
  const acc = api.registered.find((a) => a.displayName === 'Front Door');
  assert.equal(acc?.getServiceById(Service.Switch, 'led'), undefined);
});

// Past HAP's 149-per-bridge limit HomeKit silently stops accepting accessories, which reads as
// "some cameras are missing" with nothing to explain it. 6 accessories per camera with object and
// audio sensors on means a 20-camera site plus a full alarm hub lands right at the edge.
test('the bridge warns once as it approaches the HomeKit accessory limit', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `cam${i}`, modelKey: 'camera', name: `Camera ${i}`,
    featureFlags: { smartDetectTypes: ['person', 'vehicle', 'animal'] },
    smartDetectSettings: { objectTypes: ['person', 'vehicle', 'animal'] },
  }));
  const { log, clock } = await startPlatform(
    { exposeCameraStreams: false, exposeObjectSensors: true },
    { hubs: [hub()], cameras: many },
  );
  const budget = () => logged(log, 'warn').filter((m) => /HomeKit's limit is 149/.test(m));
  assert.equal(budget().length, 1, `expected one budget warning, got ${budget().length}`);
  // The remedy that keeps every accessory must be named FIRST; losing sensors is the fallback.
  assert.match(budget()[0], /child bridge/i, 'offers the split that keeps everything');
  assert.match(budget()[0], /exposeCameras|exposeAlarm|includeCameras/, 'says how to split');
  assert.match(budget()[0], /exposeObjectSensors/, 'still says which setting reduces the count');
  assert.ok(
    budget()[0].indexOf('child bridge') < budget()[0].indexOf('exposeObjectSensors'),
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
