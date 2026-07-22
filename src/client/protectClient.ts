import type { TLSSocket } from 'node:tls';
import { Agent, buildConnector, fetch, WebSocket } from 'undici';
import type { AlarmHub } from '../types';

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
}

const MAX_RETRIES = 3;

/**
 * Thin client for the official UniFi Protect Integration API
 * (`/proxy/protect/integration/v1`). Auth is an `X-API-KEY` header.
 */
export class ProtectClient {
  private readonly base: string;
  private readonly wsBase: string;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: Agent;
  private readonly timeoutMs: number;

  constructor(opts: ProtectClientOptions) {
    const host = opts.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.base = `https://${host}/proxy/protect/integration/v1`;
    this.wsBase = `wss://${host}/proxy/protect/integration/v1`;
    this.headers = { 'X-API-KEY': opts.apiKey, Accept: 'application/json' };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    // Scoped to this client's connections only — NOT a global TLS override.
    this.dispatcher = new Agent({
      connect: this.buildConnect(opts),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
  }

  private buildConnect(opts: ProtectClientOptions) {
    const pinned = opts.certificateSha256?.replace(/[^a-f0-9]/gi, '').toLowerCase();
    if (!pinned) {
      return buildConnector({ rejectUnauthorized: opts.trustSelfSignedCert === false });
    }
    // Pinning: skip CA validation and verify the fingerprint ourselves on every handshake.
    // maxCachedSessions:0 disables TLS session resumption — on a resumed session
    // getPeerCertificate() returns an empty object, which would fail the fingerprint check
    // on every reused connection (only the first, full handshake would pass).
    const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
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

  getAlarmHubs(): Promise<AlarmHub[]> {
    return this.request<AlarmHub[]>('/alarm-hubs');
  }

  getVersion(): Promise<{ applicationVersion: string }> {
    return this.request<{ applicationVersion: string }>('/meta/info');
  }

  fireWebhook(triggerId: string): Promise<void> {
    return this.request<void>(`/alarm-manager/webhook/${encodeURIComponent(triggerId)}`, { method: 'POST' });
  }

  /** Free the connection pool. */
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}, attempt = 0): Promise<T> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...this.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        return this.retry(path, init, attempt);
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ProtectApiError(`HTTP ${res.status} for ${path}`, res.status, text.slice(0, 300));
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof ProtectApiError) {
        throw err;
      }
      // Transport-level failure (timeout, reset, DNS) — retry, then surface.
      if (attempt < MAX_RETRIES) {
        return this.retry(path, init, attempt);
      }
      throw new ProtectApiError(`Request to ${path} failed: ${(err as Error).message}`);
    }
  }

  private async retry<T>(path: string, init: { method?: string; body?: unknown }, attempt: number): Promise<T> {
    const delayMs = Math.min(1000 * 2 ** attempt, 8000);
    await new Promise((r) => setTimeout(r, delayMs));
    return this.request<T>(path, init, attempt + 1);
  }

  /**
   * Subscribe to the realtime device feed. The push payloads are thin deltas, so we only
   * use them as a change signal: `onHubChange` fires when the alarm hub updates and the
   * caller re-fetches full state. Reconnects with backoff until the returned disposer runs.
   */
  subscribeDevices(onHubChange: () => void, log: (level: 'debug' | 'warn', msg: string) => void): () => void {
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;

    const connect = (): void => {
      if (disposed) {
        return;
      }
      ws = new WebSocket(`${this.wsBase}/subscribe/devices`, {
        headers: this.headers,
        dispatcher: this.dispatcher,
      });

      ws.addEventListener('open', () => {
        attempt = 0;
        log('debug', 'realtime connected');
      });
      ws.addEventListener('message', (ev) => {
        const data = (ev as { data?: unknown }).data;
        try {
          const msg = JSON.parse(String(data));
          if (msg?.item?.modelKey === 'linkstation') {
            onHubChange();
          }
        } catch {
          /* non-JSON keepalive/error frame — ignore */
        }
      });
      ws.addEventListener('close', () => scheduleReconnect());
      ws.addEventListener('error', () => {
        try {
          ws?.close();
        } catch {
          /* already closing */
        }
      });
    };

    const scheduleReconnect = (): void => {
      if (disposed) {
        return;
      }
      const delayMs = Math.min(1000 * 2 ** attempt++, 30_000);
      log('debug', `realtime disconnected; reconnecting in ${delayMs}ms`);
      setTimeout(connect, delayMs);
    };

    connect();
    return () => {
      disposed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }
}
