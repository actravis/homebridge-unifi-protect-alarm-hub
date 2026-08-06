import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeFingerprint, ProtectApiError, ProtectClient } from '../dist/client/protectClient.js';

// --- Certificate pinning ----------------------------------------------------
// A pin that silently fails to parse is worse than no pin: the user believes the connection is
// verified while the client accepts any certificate. These must fail closed.

test('normalizeFingerprint accepts valid fingerprints in either notation', () => {
  const hex = 'a'.repeat(64);
  assert.equal(normalizeFingerprint(hex), hex);
  assert.equal(normalizeFingerprint(hex.toUpperCase()), hex);
  const colons = hex.replace(/(..)(?=.)/g, '$1:'); // AA:BB:CC… form copied from a browser
  assert.equal(normalizeFingerprint(colons), hex);
  assert.equal(normalizeFingerprint(` ${colons} `), hex);
});

test('normalizeFingerprint treats blank/absent as "not pinning"', () => {
  assert.equal(normalizeFingerprint(undefined), undefined);
  assert.equal(normalizeFingerprint(''), undefined);
  assert.equal(normalizeFingerprint('   '), undefined);
});

test('normalizeFingerprint refuses a malformed pin instead of silently skipping pinning', () => {
  assert.throws(() => normalizeFingerprint(':'.repeat(47)), /not a valid SHA-256 fingerprint/);
  assert.throws(() => normalizeFingerprint('ab'), /not a valid SHA-256 fingerprint/); // truncated
  assert.throws(() => normalizeFingerprint('z'.repeat(64)), /not a valid SHA-256 fingerprint/); // non-hex
  assert.throws(() => normalizeFingerprint('a'.repeat(63)), /not a valid SHA-256 fingerprint/); // short
  assert.throws(() => normalizeFingerprint('a'.repeat(65)), /not a valid SHA-256 fingerprint/); // long
});

test('a malformed pin makes the client refuse to construct', () => {
  assert.throws(
    () => new ProtectClient({ host: 'h', apiKey: 'k', certificateSha256: 'nonsense' }),
    /not a valid SHA-256 fingerprint/,
  );
});

// --- Test doubles -----------------------------------------------------------

/** Build a fake undici Response with just the surface the client reads. */
function makeResponse({ status = 200, json, text, headers = {}, bytes } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  const bodyText = text !== undefined ? text : json !== undefined ? JSON.stringify(json) : '';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    text: async () => bodyText,
    json: async () => (json !== undefined ? json : JSON.parse(bodyText)),
    arrayBuffer: async () => {
      const src = bytes ?? new TextEncoder().encode(bodyText);
      return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    },
  };
}

function makeFakeWs() {
  const listeners = {};
  return {
    closed: false,
    /** How many times close() was entered — a recursion counter for the guard below. */
    closeCalls: 0,
    /**
     * Model undici's *failed-handshake* socket. Closing one of those runs
     * failWebsocketConnection, which fires 'error' synchronously from inside close() instead of
     * emitting a clean 'close'. Our error handler calls close(), so this is a re-entrant loop.
     */
    closeFiresError: false,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    // Mirrors undici: close() eventually emits a 'close' event (once).
    close() {
      this.closeCalls += 1;
      if (this.closeFiresError) {
        this.emit('error', new Error('handshake failed'));
        return;
      }
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.emit('close');
    },
    /**
     * Simulate a real abnormal drop. undici emits 'error' AND THEN an independent 'close' —
     * the previous double only ever emitted 'close' from close(), which masked a bug where the
     * pair produced two parallel reconnect chains.
     */
    dropAbnormally() {
      this.emit('error', new Error('socket hang up'));
      if (!this.closed) {
        this.closed = true;
      }
      this.emit('close'); // arrives regardless of whether our handler already called close()
    },
    emit(type, ev) {
      (listeners[type] ?? []).forEach((fn) => fn(ev));
    },
  };
}

/**
 * Wire a ProtectClient to fakes. `fetchImpl(url, init, callIndex)` returns a fake response
 * (or throws to simulate a transport error). Timers fire synchronously — so retries/backoff
 * run instantly — while recording the requested delay so we can assert on it.
 */
function makeClient(fetchImpl, options = {}) {
  const calls = [];
  const timers = [];
  const wsList = [];
  const watchdogs = []; // liveness watchdogs; never auto-fire — tests trigger .fn() to simulate silence
  const deps = {
    fetch: (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init, calls.length - 1);
    },
    now: () => 0,
    setTimer: (fn, ms) => {
      timers.push(ms);
      fn();
    },
    setWatchdog: (fn, ms) => {
      const wd = { fn, ms, canceled: false };
      watchdogs.push(wd);
      return () => {
        wd.canceled = true;
      };
    },
    createWebSocket: () => {
      const ws = makeFakeWs();
      wsList.push(ws);
      return ws;
    },
  };
  const client = new ProtectClient({ host: '10.0.0.1', apiKey: 'k', timeoutMs: 100, ...options }, deps);
  return { client, calls, timers, wsList, watchdogs };
}

// --- Request / retry semantics ----------------------------------------------

test('request parses JSON on 2xx and hits the right path', async () => {
  const { client, calls } = makeClient(() => makeResponse({ json: [{ id: 'c1', modelKey: 'camera' }] }));
  const cams = await client.getCameras();
  assert.equal(cams.length, 1);
  assert.equal(cams[0].id, 'c1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/cameras$/);
});

test('4xx throws ProtectApiError and is NOT retried', async () => {
  const { client, calls } = makeClient(() => makeResponse({ status: 404, text: 'nope' }));
  await assert.rejects(
    () => client.getCameras(),
    (e) => e instanceof ProtectApiError && e.status === 404,
  );
  assert.equal(calls.length, 1);
});

test('429 is retried, then succeeds', async () => {
  const responses = [makeResponse({ status: 429, json: { windowMs: 1000 } }), makeResponse({ json: { applicationVersion: '7.1.87' } })];
  const { client, calls } = makeClient((_u, _i, n) => responses[n]);
  const v = await client.getVersion();
  assert.equal(v.applicationVersion, '7.1.87');
  assert.equal(calls.length, 2);
});

test('a 429 Retry-After header (seconds) sets the retry delay', async () => {
  const responses = [makeResponse({ status: 429, headers: { 'Retry-After': '2' } }), makeResponse({ json: {} })];
  const { client, timers } = makeClient((_u, _i, n) => responses[n]);
  await client.getVersion();
  // 2s + jitter (<250ms) should appear among the requested timer delays.
  assert.ok(timers.some((ms) => ms >= 2000 && ms < 2250), `expected ~2000ms retry, got ${timers}`);
});

test('a 429 Retry-After HTTP-date is honoured', async () => {
  // The harness clock is 0; a date at epoch +3s ⇒ ~3s delay. (toUTCString drops millis.)
  const when = new Date(3000).toUTCString();
  const responses = [makeResponse({ status: 429, headers: { 'Retry-After': when } }), makeResponse({ json: {} })];
  const { client, timers } = makeClient((_u, _i, n) => responses[n]);
  await client.getVersion();
  assert.ok(timers.some((ms) => ms >= 3000 && ms < 3250), `expected ~3000ms retry, got ${timers}`);
});

test('persistent 5xx gives up after MAX_RETRIES and throws with the status', async () => {
  const { client, calls } = makeClient(() => makeResponse({ status: 503, text: 'busy' }));
  await assert.rejects(
    () => client.getVersion(),
    (e) => e instanceof ProtectApiError && e.status === 503,
  );
  assert.equal(calls.length, 4); // initial + 3 retries
});

test('a transport error is retried then surfaced as ProtectApiError', async () => {
  const { client, calls } = makeClient(() => {
    throw new Error('ECONNRESET');
  });
  await assert.rejects(
    () => client.getVersion(),
    (e) => e instanceof ProtectApiError && /ECONNRESET/.test(e.message),
  );
  assert.equal(calls.length, 4);
});

test('a transient transport error recovers on retry', async () => {
  let n = 0;
  const { client } = makeClient(() => {
    if (n++ === 0) {
      throw new Error('reset');
    }
    return makeResponse({ json: { applicationVersion: 'x' } });
  });
  const v = await client.getVersion();
  assert.equal(v.applicationVersion, 'x');
});

// --- Camera-specific requests -----------------------------------------------

test('getSnapshot returns the raw image bytes', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const { client } = makeClient(() => makeResponse({ bytes }));
  const buf = await client.getSnapshot('cam1');
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf], [0xff, 0xd8, 0xff, 0x00]);
});

test('getSnapshot fails fast on an error status (no retries)', async () => {
  const { client, calls } = makeClient(() => makeResponse({ status: 500, text: 'err' }));
  await assert.rejects(() => client.getSnapshot('cam1'), (e) => e instanceof ProtectApiError);
  assert.equal(calls.length, 1); // HomeKit's snapshot deadline is short — don't retry
});

test('enableRtspsStream POSTs the qualities body to the right path', async () => {
  const { client, calls } = makeClient(() => makeResponse({ json: { high: 'rtsps://h/k' } }));
  await client.enableRtspsStream('cam1', ['high']);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { qualities: ['high'] });
  assert.match(calls[0].url, /\/cameras\/cam1\/rtsps-stream$/);
});

// `request` serializes the body itself, so a method that pre-stringifies double-encodes it and the
// console answers 400. Asserting the parsed body is an object catches that; asserting only that the
// request was made does not. (Regression: patchChime shipped double-encoded and 400'd on hardware.)
test('patchChime PATCHes a JSON object body, not a double-encoded string', async () => {
  const ringSettings = [{ cameraId: 'cam1', volume: 0, ringtoneId: 'r1', repeatTimes: 1 }];
  const { client, calls } = makeClient(() => makeResponse({ json: { id: 'chime1', ringSettings } }));
  await client.patchChime('chime1', { ringSettings });

  assert.equal(calls[0].init.method, 'PATCH');
  assert.match(calls[0].url, /\/chimes\/chime1$/);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const parsed = JSON.parse(calls[0].init.body);
  assert.equal(typeof parsed, 'object', 'a double-encoded body parses to a string');
  assert.deepEqual(parsed, { ringSettings });
});

test('patchChime percent-encodes the device id', async () => {
  const { client, calls } = makeClient(() => makeResponse({ json: {} }));
  await client.patchChime('a/b', { ringSettings: [] });
  assert.match(calls[0].url, /\/chimes\/a%2Fb$/);
});

// --- Realtime WebSocket -----------------------------------------------------

test('subscribeDevices fires only on linkstation changes, reconnects on close, and disposes cleanly', () => {
  let changes = 0;
  const { client, wsList } = makeClient(() => makeResponse({}));
  const dispose = client.subscribeDevices(() => changes++, () => {});

  assert.equal(wsList.length, 1); // connected (gate + timer fire synchronously)
  const ws1 = wsList[0];

  ws1.emit('message', { data: JSON.stringify({ item: { modelKey: 'camera' } }) });
  assert.equal(changes, 0); // not a linkstation delta

  ws1.emit('message', { data: JSON.stringify({ item: { modelKey: 'linkstation' } }) });
  assert.equal(changes, 1);

  ws1.emit('close');
  assert.equal(wsList.length, 2); // reconnected

  dispose();
  const ws2 = wsList[1];
  assert.equal(ws2.closed, true); // disposer closed the live socket
  ws2.emit('close');
  assert.equal(wsList.length, 2); // disposed → no further reconnect
});

test('subscribeEvents delivers parsed events', () => {
  const events = [];
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents((e) => events.push(e), () => {});
  wsList[0].emit('message', { data: JSON.stringify({ type: 'add', item: { type: 'motion', device: 'cam1' } }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].item.type, 'motion');
});

test('malformed realtime frames are ignored, not thrown', () => {
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => assert.fail('should not be called'), () => {});
  assert.doesNotThrow(() => wsList[0].emit('message', { data: 'not json {' }));
});

test('a second subscription is staggered so two sockets never open in the same tick', () => {
  const { client, timers } = makeClient(() => makeResponse({}));
  client.subscribeDevices(() => {}, () => {});
  client.subscribeEvents(() => {}, () => {});
  // First open is scheduled immediately (0ms); the second is pushed out by the stagger gap.
  assert.ok(timers.includes(0), `expected an immediate first open, got ${timers}`);
  assert.ok(timers.includes(1500), `expected a 1500ms stagger for the second socket, got ${timers}`);
});

test('the liveness watchdog is OFF by default (this API sends no keepalives)', () => {
  const { client, watchdogs } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => {}, () => {});
  assert.equal(watchdogs.length, 0); // nothing armed unless a timeout is configured
});

test('when enabled, the liveness watchdog force-reconnects a silent (zombie) socket', () => {
  const { client, wsList, watchdogs } = makeClient(() => makeResponse({}), { realtimeIdleTimeoutMs: 5000 });
  client.subscribeEvents(() => {}, () => {});
  assert.equal(wsList.length, 1);
  // No frames arrive and no close/error fires — simulate the silence deadline elapsing:
  watchdogs.at(-1).fn();
  assert.equal(wsList[0].closed, true); // watchdog forced it closed
  assert.equal(wsList.length, 2); // → reconnected
});

test('realtimeIdleTimeoutMs configures the watchdog window', () => {
  const { client, watchdogs } = makeClient(() => makeResponse({}), { realtimeIdleTimeoutMs: 5000 });
  client.subscribeEvents(() => {}, () => {});
  assert.equal(watchdogs.at(-1).ms, 5000);
});

test('when enabled, any incoming frame re-arms the liveness watchdog', () => {
  const { client, wsList, watchdogs } = makeClient(() => makeResponse({}), { realtimeIdleTimeoutMs: 5000 });
  client.subscribeEvents(() => {}, () => {});
  const armedBefore = watchdogs.length;
  wsList[0].emit('message', { data: '{}' });
  assert.ok(watchdogs.length > armedBefore, 'a frame should re-arm the watchdog');
  assert.equal(watchdogs[armedBefore - 1].canceled, true, 'the previous watchdog should be canceled');
});

test('onReconnect fires on recovery but not on the initial open', () => {
  let reconnects = 0;
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => {}, () => {}, { onReconnect: () => reconnects++ });
  wsList[0].emit('open');
  assert.equal(reconnects, 0); // first open is the initial connect, not a recovery
  wsList[0].emit('close'); // → reconnect → wsList[1]
  wsList[1].emit('open');
  assert.equal(reconnects, 1);
});

test('onStatus reports connection transitions, and only transitions', () => {
  const seen = [];
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeDevices(() => {}, () => {}, { onStatus: (up) => seen.push(up) });

  wsList[0].emit('open');
  assert.deepEqual(seen, [true]);

  wsList[0].dropAbnormally(); // error + close from one drop must report a single "down"
  assert.deepEqual(seen, [true, false]);

  // The reconnect attempt also fails before ever opening — still down, so no new edge.
  wsList[1].emit('close');
  assert.deepEqual(seen, [true, false]);

  wsList[2].emit('open');
  assert.deepEqual(seen, [true, false, true]);
});

// --- Stale-socket handling --------------------------------------------------
// Every listener used to close over a mutable `ws`, so events from a superseded socket acted
// on its replacement: a late 'error' closed the live socket, and 'error'+'close' from one drop
// started two parallel reconnect chains — the thrash the connect gate exists to prevent.

test('an abnormal drop (error THEN close) reconnects exactly once', () => {
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => {}, () => {});
  wsList[0].emit('open');

  wsList[0].dropAbnormally();

  assert.equal(wsList.length, 2, 'error+close must yield one reconnect, not two');
});

// Found by running against the real console: opening a second socket was refused, and closing
// the failed one re-fired 'error' from inside close(), so the handler re-entered itself until
// "RangeError: Maximum call stack size exceeded" took the process down.
test("an 'error' fired from inside close() does not recurse into itself", () => {
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => {}, () => {});
  const ws = wsList[0];
  ws.closeFiresError = true;

  ws.emit('error', new Error('handshake refused'));

  assert.equal(ws.closeCalls, 1, 'the error handler must close the socket exactly once');
  assert.equal(wsList.length, 2, 'and the connection is still recovered');
});

test('a late event from a superseded socket cannot disturb the current one', () => {
  const { client, wsList } = makeClient(() => makeResponse({}));
  client.subscribeEvents(() => {}, () => {});
  const stale = wsList[0];
  stale.emit('open');
  stale.emit('close'); // → reconnect
  assert.equal(wsList.length, 2);
  const current = wsList[1];
  current.emit('open');

  // The old socket now errors and closes late (undici does this on a torn-down connection).
  stale.dropAbnormally();

  assert.equal(current.closed, false, 'the live socket must not be closed by a stale error');
  assert.equal(wsList.length, 2, 'a stale close must not start another reconnect');
});

test('a watchdog armed for an old socket never closes its replacement', () => {
  const { client, wsList, watchdogs } = makeClient(() => makeResponse({}), { realtimeIdleTimeoutMs: 5000 });
  client.subscribeEvents(() => {}, () => {});
  const staleWatchdog = watchdogs.at(-1);
  wsList[0].emit('close'); // → reconnect → wsList[1]
  assert.equal(wsList.length, 2);

  staleWatchdog.fn(); // fires late, after the socket it was armed for is gone

  assert.equal(wsList[1].closed, false, 'the replacement socket must survive');
});

test('dispose cancels the watchdog and blocks further reconnects', () => {
  const { client, wsList, watchdogs } = makeClient(() => makeResponse({}), { realtimeIdleTimeoutMs: 5000 });
  const dispose = client.subscribeEvents(() => {}, () => {});
  const wd = watchdogs.at(-1);
  dispose();
  assert.equal(wd.canceled, true);
  wsList[0].emit('close');
  assert.equal(wsList.length, 1); // disposed → no reconnect
});

// A speakerless camera answers 503 here. The normal policy retries 5xx with backoff, which turned an
// ~85ms refusal into ~7s — all of it spent blocking the video stream from starting. This call gets
// exactly one attempt.
test('startTalkbackSession does not retry a 503, so it cannot delay a stream', async () => {
  const { client, calls } = makeClient(() => makeResponse({ status: 503, text: 'unavailable' }));
  await assert.rejects(() => client.startTalkbackSession('cam1'), (e) => e instanceof ProtectApiError);
  assert.equal(calls.length, 1, `expected a single attempt, got ${calls.length}`);
});

// Contrast: an ordinary state read SHOULD ride out a transient 5xx.
test('an ordinary request still retries a 503', async () => {
  let n = 0;
  const { client, calls } = makeClient(() => {
    n += 1;
    return n === 1 ? makeResponse({ status: 503, text: 'blip' }) : makeResponse({ json: [] });
  });
  await client.getCameras();
  assert.ok(calls.length > 1, 'a transient 5xx on a read must be retried');
});
