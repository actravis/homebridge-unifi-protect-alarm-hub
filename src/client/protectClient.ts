import type { TLSSocket } from 'node:tls';
import { Agent, buildConnector, fetch, WebSocket } from 'undici';
import type {
  AlarmHub, Camera, CameraSettingsPatch, Chime, ChimeSettingsPatch, ProtectEvent, RtspsStreams,
  TalkbackSession,
} from '../types';
import { computeRetryDelay, exponentialBackoff, jitter, reconnectDelay, reserveSlot } from './timing';

/** Undici's Response type (avoids depending on the DOM lib for a global `Response`). */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** Realtime log sink shared by the WebSocket subscriptions. */
type RealtimeLog = (level: 'debug' | 'warn', msg: string) => void;

/** Optional lifecycle callbacks for a realtime subscription. */
export interface SubscribeHooks {
  /**
   * Fires after the feed recovers from a drop — NOT on the first connect. Messages sent during
   * the gap are gone, so the caller should resync whatever state the feed would have updated.
   */
  onReconnect?: () => void;
  /**
   * Fires on every connection-state change: true when a socket opens, false when it drops.
   * Lets the caller adapt to the feed's health — e.g. slow a redundant poll while it is up.
   */
  onStatus?: (connected: boolean) => void;
}

/** The slice of a WebSocket we use — kept minimal so tests can supply a fake. */
interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: unknown) => void): void;
  close(): void;
}

/** Close a socket, tolerating one that is already closing/closed. */
function closeQuietly(socket: WebSocketLike | null | undefined): void {
  try {
    socket?.close();
  } catch {
    /* already closing */
  }
}

/**
 * External boundaries the client depends on, injectable so the retry/throttle/reconnect
 * logic can be unit-tested deterministically. Production uses {@link REAL_DEPS}; tests pass
 * a fake `fetch`, a controllable `now`, an immediate `setTimer`, and a fake `createWebSocket`.
 */
export interface ClientDeps {
  fetch: typeof fetch;
  now: () => number;
  /** One-shot delay (backoff, throttle spacing, socket stagger). Not cancelable. */
  setTimer: (fn: () => void, ms: number) => void;
  /** Cancelable one-shot timer for the realtime liveness watchdog; returns a canceller. */
  setWatchdog: (fn: () => void, ms: number) => () => void;
  createWebSocket: (url: string, init: { headers: Record<string, string>; dispatcher: Agent }) => WebSocketLike;
}

const REAL_DEPS: ClientDeps = {
  fetch,
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    setTimeout(fn, ms);
  },
  setWatchdog: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  createWebSocket: (url, init) => new WebSocket(url, init) as unknown as WebSocketLike,
};

export class ProtectApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'ProtectApiError';
  }
}

export interface ProtectClientOptions {
  host: string;
  apiKey: string;
  timeoutMs?: number;
  /** UniFi consoles use self-signed certs; when true we skip chain validation for THIS host only. */
  trustSelfSignedCert?: boolean;
  /** Optional SHA-256 fingerprint to pin (hex, colons optional). Takes precedence over trustSelfSignedCert. */
  certificateSha256?: string;
  /**
   * Force a realtime reconnect if no frame arrives within this window (ms). Off by default
   * ({@link DEFAULT_WS_LIVENESS_MS}): this API sends no keepalives, so idle ≠ dead and TCP
   * keepalive already catches dead peers. Only set this if your deployment has reliably
   * frequent events and wants an extra backstop; pick a value well above your quiet gaps.
   */
  realtimeIdleTimeoutMs?: number;
}

/** Give up after this many retries on 429 / 5xx / transport errors. */
const MAX_RETRIES = 3;

/**
 * Normalise a user-supplied SHA-256 certificate fingerprint to bare lowercase hex.
 *
 * Blank/absent means "not pinning" and returns undefined. Anything else MUST be a valid
 * fingerprint: a value that merely *looks* wrong (truncated paste, base64, a string of colons)
 * used to strip down to an empty string and silently fall through to the unpinned path — so the
 * user believed pinning was on while the client accepted any certificate. Fail closed instead.
 */
export function normalizeFingerprint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const hex = value.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      'certificateSha256 is not a valid SHA-256 fingerprint (expected 64 hex characters, ' +
        'optionally colon-separated). Refusing to start rather than silently skip pinning.',
    );
  }
  return hex;
}

/**
 * Default: app-level idle watchdog is OFF (0).
 *
 * Measurement showed the Integration API sends NO application-level keepalive frames, so
 * "no frames for N seconds" does NOT mean the socket is dead — it usually just means nothing
 * happened. An idle watchdog would therefore false-fire and churn the socket every quiet
 * period. Dead peers are instead caught by TCP keepalive (see buildConnect) plus the normal
 * close/error → reconnect path. The watchdog remains available as an opt-in backstop via
 * `realtimeIdleTimeoutMs` for deployments with reliably frequent events.
 */
const DEFAULT_WS_LIVENESS_MS = 0;

/**
 * Thin client for the official UniFi Protect Integration API
 * (`/proxy/protect/integration/v1`). Auth is an `X-API-KEY` header.
 *
 * The console enforces a strict rate limit (~10 req/s, and it closes a second WebSocket
 * opened in the same tick with close code 1008), so this client both **throttles** request
 * starts and **staggers** socket opens — see the "rate-limit guards" fields and `timing.ts`.
 */
export class ProtectClient {
  private readonly base: string;
  private readonly wsBase: string;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: Agent;
  private readonly timeoutMs: number;
  /** Silence window before the liveness watchdog forces a realtime reconnect. */
  private readonly wsLivenessMs: number;

  // --- Rate-limit guards (see class doc). Values are "next allowed time" cursors that
  // reserveSlot() advances; they space out REST requests and WebSocket opens respectively.
  /** Minimum gap between request starts (~8 req/s, comfortably under the ~10/s limit). */
  private readonly minReqGapMs = 120;
  private nextReqAt = 0;
  /** Minimum gap between WebSocket opens across all subscriptions. */
  private readonly wsConnectGapMs = 1500;
  private nextWsConnectAt = 0;

  constructor(
    opts: ProtectClientOptions,
    private readonly deps: ClientDeps = REAL_DEPS,
  ) {
    const host = opts.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.base = `https://${host}/proxy/protect/integration/v1`;
    this.wsBase = `wss://${host}/proxy/protect/integration/v1`;
    this.headers = { 'X-API-KEY': opts.apiKey, Accept: 'application/json' };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.wsLivenessMs = opts.realtimeIdleTimeoutMs ?? DEFAULT_WS_LIVENESS_MS;
    // Scoped to this client's connections only — NOT a global TLS override.
    this.dispatcher = new Agent({
      connect: this.buildConnect(opts),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
  }

  private buildConnect(opts: ProtectClientOptions) {
    // TCP keepalive so the OS detects a silently-dead peer and closes the socket (→ reconnect).
    // The Integration API sends NO application-level keepalive frames (measured: zero over 60s
    // of active use), so this transport-level probe — not inbound data — is our liveness signal.
    const keepalive = { keepAlive: true, keepAliveInitialDelay: 60_000 };
    const pinned = normalizeFingerprint(opts.certificateSha256);
    if (!pinned) {
      // Fail closed when the caller didn't decide: only an explicit `true` disables validation.
      return buildConnector({ ...keepalive, rejectUnauthorized: opts.trustSelfSignedCert !== true });
    }
    // Pinning: skip CA validation and verify the fingerprint ourselves on every handshake.
    // maxCachedSessions:0 disables TLS session resumption — on a resumed session
    // getPeerCertificate() returns an empty object, which would fail the fingerprint check
    // on every reused connection (only the first, full handshake would pass).
    const base = buildConnector({ ...keepalive, rejectUnauthorized: false, maxCachedSessions: 0 });
    const connect: typeof base = (options, callback) =>
      base(options, (err, socket) => {
        if (err || !socket) {
          return callback(err, socket ?? null);
        }
        const fingerprint = (socket as unknown as TLSSocket)
          .getPeerCertificate?.()
          ?.fingerprint256?.replace(/[^a-f0-9]/gi, '')
          .toLowerCase();
        if (fingerprint !== pinned) {
          socket.destroy();
          return callback(new Error(`TLS certificate fingerprint mismatch (got ${fingerprint ?? 'none'})`), null);
        }
        return callback(null, socket);
      });
    return connect;
  }

  // ---- Alarm hub / console ----

  getAlarmHubs(): Promise<AlarmHub[]> {
    return this.request<AlarmHub[]>('/alarm-hubs');
  }

  getVersion(): Promise<{ applicationVersion: string }> {
    return this.request<{ applicationVersion: string }>('/meta/info');
  }

  fireWebhook(triggerId: string): Promise<void> {
    return this.request<void>(`/alarm-manager/webhook/${encodeURIComponent(triggerId)}`, { method: 'POST' });
  }

  /**
   * Update a chime's writable settings. Only `ringSettings` is verified to round-trip; the API
   * rejects unknown fields, and the write REPLACES the whole array (see ChimeSettingsPatch).
   */
  patchChime(id: string, patch: ChimeSettingsPatch): Promise<Chime> {
    return this.request<Chime>(`/chimes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      // A plain object: `request` serializes it. Passing a pre-stringified body double-encodes it
      // and the console answers 400.
      body: patch,
    });
  }

  // ---- Cameras ----

  getCameras(): Promise<Camera[]> {
    return this.request<Camera[]>('/cameras');
  }

  /**
   * Update a camera's writable settings. Only `lcdMessage` is verified to round-trip; the API
   * rejects unknown fields with HTTP 500 rather than ignoring them.
   */
  patchCamera(id: string, patch: CameraSettingsPatch): Promise<Camera> {
    return this.request<Camera>(`/cameras/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  /**
   * Ask the camera where to send talkback audio. POST arms the camera's listener and returns the
   * target; it is idempotent in practice (same target every call) and there is no session to close.
   */
  startTalkbackSession(id: string): Promise<TalkbackSession> {
    return this.request<TalkbackSession>(
      `/cameras/${encodeURIComponent(id)}/talkback-session`,
      // Deliberately NOT retried. A camera without a speaker answers 503, which the normal policy
      // treats as transient and retries with backoff — measured ~7s, all of it spent blocking the
      // video stream from starting. One attempt (~85ms) is the whole budget this deserves.
      { method: 'POST', maxRetries: 0 },
    );
  }

  /**
   * RTSPS URLs per quality (high/medium/low[/package]). Requires RTSPS enabled on the camera.
   * The URLs embed a stream key — never log them raw; use `redactStreamUrl` (util.ts).
   */
  getRtspsStream(id: string): Promise<RtspsStreams> {
    return this.request<RtspsStreams>(`/cameras/${encodeURIComponent(id)}/rtsps-stream`);
  }

  /**
   * Enable RTSPS for the given qualities (e.g. ["high"]) and return the resulting URLs.
   * URLs are credential-bearing — redact before logging (see `redactStreamUrl`).
   */
  enableRtspsStream(id: string, qualities: string[]): Promise<RtspsStreams> {
    return this.request<RtspsStreams>(`/cameras/${encodeURIComponent(id)}/rtsps-stream`, {
      method: 'POST',
      body: { qualities },
    });
  }

  /**
   * Current JPEG snapshot for a camera (raw image bytes, not JSON).
   *
   * Fail-fast (no retries): HomeKit's snapshot request has a short deadline, and a retry
   * chain would blow it and show a broken tile. The accessory layer should cache the last
   * good frame and serve it if this rejects.
   */
  async getSnapshot(id: string): Promise<Buffer> {
    const res = await this.fetchRaw(`/cameras/${encodeURIComponent(id)}/snapshot`, {}, 0, 0);
    if (!res.ok) {
      const body = await res.text();
      throw new ProtectApiError(`HTTP ${res.status} for camera snapshot`, res.status, body.slice(0, 200));
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ---- Chimes ----

  getChimes(): Promise<Chime[]> {
    return this.request<Chime[]>('/chimes');
  }


  /** Free the connection pool. */
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  // ---- HTTP core ----

  /** Issue a JSON request and parse the body, throwing {@link ProtectApiError} on non-2xx. */
  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; maxRetries?: number } = {},
  ): Promise<T> {
    const res = await this.fetchRaw(path, init, 0, init.maxRetries ?? MAX_RETRIES);
    const text = await res.text();
    if (!res.ok) {
      throw new ProtectApiError(`HTTP ${res.status} for ${path}`, res.status, text.slice(0, 300));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Perform the request with proactive rate-limit throttling and retry/backoff.
   * Retries 429 (honouring the server's retry window) + 5xx + transport errors, up to
   * {@link MAX_RETRIES}. Returns the raw Response so callers can read JSON or binary.
   * 4xx are returned as-is (not retried) for the caller to surface.
   */
  private async fetchRaw(
    path: string,
    init: { method?: string; body?: unknown } = {},
    attempt = 0,
    maxRetries = MAX_RETRIES,
  ): Promise<FetchResponse> {
    await this.throttle();
    try {
      const res = await this.deps.fetch(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...this.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const delayMs = await this.retryDelayFor(res, attempt);
        // Drain the discarded response so its connection returns to the pool. (For a 429 the
        // body was already read for windowMs, so this is a no-op/locked and simply ignored.)
        try {
          await res.body?.cancel();
        } catch {
          /* already consumed */
        }
        await this.sleep(delayMs);
        return this.fetchRaw(path, init, attempt + 1, maxRetries);
      }
      return res;
    } catch (err) {
      // Transport-level failure (timeout, reset, DNS) — back off, then surface.
      if (attempt < maxRetries) {
        await this.sleep(exponentialBackoff(attempt, 8000) + jitter(250));
        return this.fetchRaw(path, init, attempt + 1, maxRetries);
      }
      throw new ProtectApiError(`Request to ${path} failed: ${(err as Error).message}`);
    }
  }

  /** Space out request starts to stay under the console's ~10 req/s limit (spike-measured). */
  private async throttle(): Promise<void> {
    const { waitMs, nextAt } = reserveSlot(this.nextReqAt, this.deps.now(), this.minReqGapMs);
    this.nextReqAt = nextAt;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  /**
   * Compute the retry delay for a failed response, reading the server's 429 window off the
   * wire (Retry-After header, else body `windowMs`) and delegating the arithmetic to the
   * pure `computeRetryDelay`.
   */
  private async retryDelayFor(res: FetchResponse, attempt: number): Promise<number> {
    if (res.status !== 429) {
      return computeRetryDelay({ status: res.status, attempt });
    }
    const retryAfterSeconds = this.parseRetryAfter(res.headers.get('retry-after'));
    let windowMs: number | undefined;
    if (retryAfterSeconds === undefined) {
      try {
        const body = (await res.json()) as { windowMs?: number };
        windowMs = typeof body?.windowMs === 'number' ? body.windowMs : undefined;
      } catch {
        /* body wasn't JSON — fall through to exponential */
      }
    }
    return computeRetryDelay({ status: 429, retryAfterSeconds, windowMs, attempt });
  }

  /** Parse a `Retry-After` header (numeric delay-seconds OR an HTTP-date) into seconds. */
  private parseRetryAfter(raw: string | null): number | undefined {
    if (!raw) {
      return undefined;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? seconds : undefined;
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      const delta = (dateMs - this.deps.now()) / 1000;
      return delta > 0 ? delta : undefined;
    }
    return undefined;
  }

  /** Promise that resolves after `ms`, via the injected timer (so tests don't actually wait). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimer(() => resolve(), ms));
  }

  // ---- Realtime (WebSocket) ----

  /**
   * Subscribe to the realtime device feed. The push payloads are thin deltas, so we only
   * use them as a change signal: `onHubChange` fires when the alarm hub updates and the
   * caller re-fetches full state. Reconnects with backoff until the returned disposer runs.
   * See {@link SubscribeHooks} for the recovery/health callbacks.
   */
  subscribeDevices(onHubChange: () => void, log: RealtimeLog, hooks: SubscribeHooks = {}): () => void {
    return this.subscribe('/subscribe/devices', (msg) => {
      const modelKey = (msg as { item?: { modelKey?: string } })?.item?.modelKey;
      if (modelKey === 'linkstation') {
        onHubChange();
      }
    }, log, hooks);
  }

  /**
   * Subscribe to the semantic events feed (motion, smartDetectZone, ring, alarmHubEntryOpened, …).
   * Unlike `subscribeDevices`, these payloads are decoded events, usable directly. Events sent
   * during a drop are lost, so use {@link SubscribeHooks.onReconnect} to resync device state.
   */
  subscribeEvents(onEvent: (event: ProtectEvent) => void, log: RealtimeLog, hooks: SubscribeHooks = {}): () => void {
    return this.subscribe('/subscribe/events', (msg) => onEvent(msg as ProtectEvent), log, hooks);
  }

  /**
   * Shared WebSocket plumbing: connect, dispatch parsed messages, and keep the feed alive.
   * Reconnects with backoff on close/error, and a liveness watchdog forces a reconnect if the
   * socket goes silent (a "zombie" connection that never fires close/error). The first open is
   * the initial connect; every subsequent open is a recovery and fires `onReconnect`.
   */
  private subscribe(
    path: string,
    onMessage: (msg: unknown) => void,
    log: RealtimeLog,
    hooks: SubscribeHooks = {},
  ): () => void {
    let ws: WebSocketLike | null = null;
    let disposed = false;
    let attempt = 0;
    let everOpened = false;
    let connected = false;
    let cancelWatchdog: (() => void) | undefined;

    // Report transitions only, so callers can treat onStatus as an edge rather than a level:
    // a failed reconnect attempt tears down and would otherwise re-announce "disconnected"
    // on every retry.
    const notifyStatus = (next: boolean): void => {
      if (connected === next) {
        return;
      }
      connected = next;
      hooks.onStatus?.(next);
    };

    // (Re)start the silence timer for a SPECIFIC socket. Any frame re-arms it; if it elapses,
    // that socket is presumed dead and closed to trigger a reconnect. Taking the socket as an
    // argument matters: a timer armed for a previous connection must never close its successor.
    const armWatchdog = (socket: WebSocketLike): void => {
      if (this.wsLivenessMs <= 0) {
        return; // watchdog disabled — this API has no keepalives, so idle ≠ dead
      }
      cancelWatchdog?.();
      cancelWatchdog = this.deps.setWatchdog(() => {
        log('warn', `realtime idle > ${this.wsLivenessMs}ms (${path}); forcing reconnect`);
        closeQuietly(socket);
      }, this.wsLivenessMs);
    };

    const stopWatchdog = (): void => {
      cancelWatchdog?.();
      cancelWatchdog = undefined;
    };

    const connect = (): void => {
      if (disposed) {
        return;
      }
      // Capture THIS socket. Every handler below is bound to it and checks that it is still the
      // current connection, so a late event from a superseded socket can't close its replacement
      // or start a second reconnect chain (undici emits 'error' *and* 'close' on a drop, and a
      // stale pair used to yield two parallel connect loops — the exact thrash gatedConnect
      // exists to prevent).
      const socket = this.deps.createWebSocket(`${this.wsBase}${path}`, {
        headers: this.headers,
        dispatcher: this.dispatcher,
      });
      ws = socket;
      const isCurrent = (): boolean => !disposed && ws === socket;
      // Exactly one reconnect per connection, whether we learn of the failure via close, error,
      // or both.
      let teardownDone = false;
      // Separate from `teardownDone`, which is skipped for a superseded socket: this one must
      // hold for ANY socket, because it breaks a re-entrancy loop rather than a duplicate
      // reconnect. See the 'error' listener below.
      let errorHandled = false;
      const teardown = (): void => {
        if (teardownDone || !isCurrent()) {
          return;
        }
        teardownDone = true;
        stopWatchdog();
        notifyStatus(false);
        scheduleReconnect();
      };

      // Arm before 'open' so a handshake that never completes is also recovered.
      armWatchdog(socket);

      socket.addEventListener('open', () => {
        if (!isCurrent()) {
          return closeQuietly(socket);
        }
        attempt = 0;
        armWatchdog(socket);
        log('debug', `realtime connected (${path})`);
        notifyStatus(true);
        if (everOpened) {
          hooks.onReconnect?.();
        }
        everOpened = true;
      });
      socket.addEventListener('message', (ev) => {
        if (!isCurrent()) {
          return;
        }
        armWatchdog(socket); // any traffic proves the socket is alive
        const data = (ev as { data?: unknown }).data;
        try {
          onMessage(JSON.parse(String(data)));
        } catch {
          // Every frame this API sends is JSON (it sends no keepalives — see
          // DEFAULT_WS_LIVENESS_MS), so this is a malformed or truncated frame. Dropping it is
          // right: one bad frame must not tear down a working feed. It still proves liveness.
        }
      });
      socket.addEventListener('close', teardown);
      socket.addEventListener('error', () => {
        // Re-entrancy guard, and it is load-bearing: undici's `close()` on a socket that never
        // finished its handshake runs failWebsocketConnection, which fires 'error' *synchronously*
        // from inside the call. Without this the handler re-enters itself until the stack blows
        // ("Maximum call stack size exceeded") — observed live when the console refused a second
        // socket. It must stay outside `teardown`, whose isCurrent() check would skip it.
        if (errorHandled) {
          return;
        }
        errorHandled = true;
        closeQuietly(socket); // close the socket that errored, never the current one
        teardown(); // in case 'close' never arrives
      });
    };

    const scheduleReconnect = (): void => {
      if (disposed) {
        return;
      }
      const delayMs = reconnectDelay(attempt++);
      log('debug', `realtime disconnected (${path}); reconnecting in ${delayMs}ms`);
      this.deps.setTimer(() => this.gatedConnect(connect), delayMs);
    };

    this.gatedConnect(connect);
    return () => {
      disposed = true;
      stopWatchdog();
      closeQuietly(ws);
    };
  }

  /**
   * Open WebSockets one at a time, spaced by `wsConnectGapMs`. Opening two sockets in the same
   * tick makes the console close one with code 1008 (rate limit); staggering avoids it and
   * stops reconnect storms from thrashing.
   */
  private gatedConnect(open: () => void): void {
    const { waitMs, nextAt } = reserveSlot(this.nextWsConnectAt, this.deps.now(), this.wsConnectGapMs);
    this.nextWsConnectAt = nextAt;
    this.deps.setTimer(open, waitMs);
  }
}
