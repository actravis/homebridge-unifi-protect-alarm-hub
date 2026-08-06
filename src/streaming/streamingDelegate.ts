import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import type {
  CameraController,
  CameraStreamingDelegate,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import type { RtspsStreams, TalkbackSession } from '../types';
import { redactStreamUrl } from '../util';
import type { AudioCodecChoice } from './audioCodec';
import type { AudioArgsOptions } from './ffmpegArgs';
import { supportsFpsMax, type EncodeProbe } from './ffmpegFeatures';
import {
  buildVideoArgs, effectiveBitrateKbps, encodeSrtpParams, opusFrameDuration, pickRtspsUrl, selectStreamQuality,
} from './ffmpegArgs';
import { startAudioRelay, type AudioRelay } from './audioRelay';
import { buildTalkbackArgs, buildTalkbackSdp, parseTalkbackTarget } from './talkback';

/** What the delegate needs from the client: snapshots + RTSPS stream URLs. ProtectClient satisfies this. */
export interface StreamSource {
  getSnapshot(deviceId: string): Promise<Buffer>;
  getRtspsStream(deviceId: string): Promise<RtspsStreams>;
  enableRtspsStream(deviceId: string, qualities: string[]): Promise<RtspsStreams>;
  /** Only needed when talkback is enabled. */
  startTalkbackSession?(deviceId: string): Promise<TalkbackSession>;
}

export interface StreamingDelegateOptions {
  deviceId: string;
  source: StreamSource;
  log: Logging;
  ffmpegPath: string;
  /** Clock injection for testing the snapshot cache; defaults to Date.now. */
  now?: () => number;
  /** How long a prepared-but-never-started session lives before cleanup; defaults to 30s. */
  prepareTimeoutMs?: number;
  /**
   * Reports whether the camera is answering, from the outcome of each real snapshot attempt.
   * The accessory turns this into HomeKit's StatusActive.
   */
  onHealth?: (ok: boolean) => void;
  /**
   * Process launcher, injectable so the whole start-stream path (RTSPS lookup → argument
   * building → spawn → exit handling) can be unit-tested without a real ffmpeg. Defaults to
   * `child_process.spawn`.
   */
  spawn?: typeof spawn;
  /**
   * The probed audio encoder, or undefined for video-only. MUST match what the CameraController
   * advertised: if the controller declares a codec and this is absent, iOS waits for audio that
   * never arrives and refuses to render the video either.
   */
  audioCodec?: AudioCodecChoice;
  /** Probe used to test optional ffmpeg flags; injectable so tests need no real ffmpeg. */
  encodeProbe?: EncodeProbe;
  /**
   * Enable two-way audio. Off by default, and when off this class behaves exactly as before —
   * the one-way streaming path is unchanged, including which process owns the audio RTCP port.
   */
  talkback?: boolean;
}

/**
 * Serve a cached snapshot for this long before refreshing. The Home app requests a snapshot
 * per camera tile repeatedly; without this we'd hit the console's REST API on every redraw
 * and could overwhelm it (observed: snapshots + polling all timing out).
 */
const SNAPSHOT_TTL_MS = 5000;

/**
 * Never serve a cached frame older than this. Past it we go back to the cold path, so a camera
 * that has gone offline surfaces an error instead of showing a stale image indefinitely.
 */
const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

/**
 * HomeKit normally sends 'start' within a second of 'prepare'. If it never does (the controller
 * abandoned the session), the reserved UDP socket would leak, so reap the session after this.
 * Generous, because reaping also force-closes HomeKit's stream slot.
 */
const PREPARE_TIMEOUT_MS = 30_000;

/** Grace period between asking ffmpeg to exit (SIGTERM) and killing it outright. */
const FFMPEG_TERM_GRACE_MS = 2000;

interface Session {
  targetAddress: string;
  videoPort: number;
  videoSSRC: number;
  videoKey: Buffer;
  videoSalt: Buffer;
  /** Audio counterparts, present only when audio is enabled for this camera. */
  audioPort?: number;
  audioSSRC?: number;
  audioKey?: Buffer;
  audioSalt?: Buffer;
  audioSocket?: Socket;
  audioReturnPort?: number;
  /** Reserves the advertised port until ffmpeg takes it over; undefined once released. */
  videoSocket?: Socket;
  /** The port we advertised to iOS as our RTCP endpoint (ffmpeg binds `localrtcpport` here). */
  videoReturnPort: number;
  /** Reaps the session if 'start' never arrives; cleared once it does. */
  prepareTimer?: ReturnType<typeof setTimeout>;
  ffmpeg?: ChildProcess;
  /** The second ffmpeg, decrypting HomeKit's microphone into Opus for the camera. */
  talkback?: ChildProcess;
  /** Forwards audio both ways so the advertised port keeps its owner (see audioRelay.ts). */
  relay?: AudioRelay;
  /** Socket the outbound ffmpeg sends audio to when relaying; also the relay's sender for inbound. */
  relaySocket?: Socket;
  /** Localhost port the talkback ffmpeg binds for the microphone stream. */
  talkbackInPort?: number;
}

/**
 * A random RTP synchronisation source. Masked to positive signed-int32 range: ffmpeg's
 * `-ssrc` option is a signed int and rejects values above 2^31-1 (a full uint32 would fail
 * ~half the time and the stream would never start).
 */
export function randomSsrc(): number {
  return randomBytes(4).readUInt32BE(0) & 0x7fffffff;
}

/**
 * Node dual-stack sockets report IPv4 peers in IPv4-mapped IPv6 form (`::ffff:a.b.c.d`);
 * hap-nodejs and ffmpeg both want the plain dotted IPv4. Strip the prefix when present.
 */
export function stripV4Mapped(addr: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)?.[1] ?? addr;
}

/**
 * The address to advertise as our RTP endpoint, or undefined to let hap-nodejs work it out.
 *
 * We prefer the address iOS opened the HAP session to, so a multi-homed host advertises the
 * interface iOS is actually talking to. But hap throws (and, being inside an un-caught promise
 * chain, takes Homebridge down with it) if the override's IP version doesn't match the version
 * iOS asked for — and the control connection's family is independent of the RTP family on a
 * dual-stack LAN. A zoned link-local address (`fe80::1%en0`) also breaks downstream parsing.
 * In any of those cases, return undefined and let hap pick.
 */
export function pickAddressOverride(sourceAddress: string, addressVersion: string): string | undefined {
  const addr = stripV4Mapped(sourceAddress);
  if (addr.includes('%')) {
    return undefined;
  }
  return isIPv4(addr) === (addressVersion !== 'ipv6') ? addr : undefined;
}

/**
 * Decoder complaints that are EXPECTED when joining a live stream, and only mean "we connected
 * partway through a group of pictures and are waiting for the next keyframe".
 *
 * Every Protect substream has a ~5s keyframe interval, so a 24fps HEVC camera emits roughly a
 * hundred of these per connect — enough to bury the handful of lines that actually matter (the
 * stream mapping, the negotiated output, real errors). They are counted and summarised instead.
 *
 * Deliberately narrow: each pattern is a known mid-GOP artefact. Anything unrecognised is still
 * logged, because a filter that swallows novel errors is worse than a noisy log.
 */
const EXPECTED_DECODER_NOISE = [
  /Could not find ref with POC/,
  /Error constructing the frame RPS/,
  /Skipping invalid undecodable NALU/,
  /First slice in a frame missing/,
  // The H.264 equivalents of the same mid-GOP situation.
  /non-existing PPS .* referenced/,
  /decode_slice_header error/,
  /no frame!/,
  // swscaler, once per stream: the camera reports a JPEG-range pixel format. Harmless and not
  // something a user can act on.
  /deprecated pixel format used/,
];

/** True if this ffmpeg output line is expected mid-GOP noise rather than a real problem. */
export function isExpectedFfmpegNoise(line: string): boolean {
  return EXPECTED_DECODER_NOISE.some((pattern) => pattern.test(line));
}

/** Close a socket, tolerating an already-closed one (Node throws in that case). */
function closeSocket(socket?: Socket): void {
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
}

/** Bind a UDP socket to an ephemeral port, resolving once bound. */
function bindUdp(family: 'udp4' | 'udp6'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(family);
    const onError = (err: Error): void => {
      closeSocket(socket); // don't leak the handle when the bind fails
      reject(err);
    };
    socket.once('error', onError);
    socket.bind(() => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * HomeKit camera delegate: snapshots (with a short-lived cache) and live video by pulling the
 * camera's RTSPS substream through ffmpeg and re-emitting it as SRTP to the HomeKit client.
 *
 * Live streaming is host/network-dependent (ffmpeg build, RTSPS TLS on :7441, transcode load) —
 * the ffmpeg args, quality selection and SRTP encoding are unit-tested; the socket/process
 * wiring here is validated live. Video-only for now; camera audio and talkback are follow-ups.
 */
export class ProtectStreamingDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, Session>();
  private lastSnapshot?: Buffer;
  private lastSnapshotAt = 0;
  private refreshingSnapshot = false;
  /** In-flight cold-path fetch, shared by concurrent requests so we hit the console once. */
  private pendingSnapshot?: Promise<Buffer>;
  /** Set by the accessory so we can tell HomeKit when a stream dies underneath it. */
  private controller?: CameraController;
  /** Protect's reported reachability; false suppresses snapshot/stream attempts entirely. */
  private deviceOnline = true;
  /** So the unimplemented-reconfigure notice appears once per camera, not once per request. */
  private reconfigureReported = false;
  /** Talkback failures are persistent (permissions, no speaker) — report them once, not per stream. */
  private talkbackWarned = false;

  constructor(private readonly opts: StreamingDelegateOptions) {}

  /**
   * Tell the delegate whether Protect currently considers the camera reachable.
   *
   * While it isn't, every snapshot and stream request is refused up front. Letting them through
   * means one timing-out console request per Home-app tile refresh — which is how a single dead
   * camera ends up degrading every other accessory the plugin owns.
   */
  setDeviceOnline(online: boolean): void {
    this.deviceOnline = online;
  }

  /**
   * Give the delegate its CameraController. Without it we cannot tell HomeKit that a stream
   * ended unexpectedly, and its stream slot stays busy until Homebridge restarts.
   */
  setController(controller: CameraController): void {
    this.controller = controller;
  }

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private cacheSnapshot(buffer: Buffer): void {
    this.lastSnapshot = buffer;
    this.lastSnapshotAt = this.nowMs();
  }

  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    // A camera Protect reports as disconnected gets no requests at all — and no cached frame
    // either. Serving a picture from before it went down implies a working camera; better that
    // HomeKit shows the tile as unavailable, which is the truth.
    if (!this.deviceOnline) {
      callback(new Error(`Camera ${this.opts.deviceId} is offline.`));
      return;
    }
    // Serve a cached frame instantly when we have a usable one, refreshing a stale cache in the
    // background so tiles stay fresh without hammering the console.
    const age = this.nowMs() - this.lastSnapshotAt;
    if (this.lastSnapshot && age < SNAPSHOT_MAX_AGE_MS) {
      callback(undefined, this.lastSnapshot);
      if (age >= SNAPSHOT_TTL_MS) {
        this.refreshSnapshot();
      }
      return;
    }
    // Cold (or too stale): coalesce concurrent requests onto one fetch. The Home app asks for
    // every tile at once on launch, which would otherwise be N simultaneous console hits.
    this.pendingSnapshot ??= this.opts.source.getSnapshot(this.opts.deviceId).finally(() => {
      this.pendingSnapshot = undefined;
    });
    // Both handlers are throw-proof, so this promise can never reject. That matters: it is
    // detached, and a HAP callback that threw would surface as an unhandled rejection — which
    // Node treats as fatal, taking down every other accessory Homebridge is serving.
    void this.pendingSnapshot.then(
      (buffer) => {
        this.cacheSnapshot(buffer);
        this.reportHealth(true);
        this.answer(() => callback(undefined, buffer));
      },
      (err: unknown) => {
        this.reportHealth(false);
        this.answer(() => callback(err as Error));
      },
    );
  }

  /** Invoke a HAP callback, containing any throw from it rather than letting it escape. */
  private answer(respond: () => void): void {
    try {
      respond();
    } catch (err) {
      this.opts.log.error(`Answering a snapshot request failed: ${(err as Error).message}`);
    }
  }

  /** Fetch a fresh snapshot in the background (one in flight at a time) to update the cache. */
  private refreshSnapshot(): void {
    if (this.refreshingSnapshot) {
      return;
    }
    this.refreshingSnapshot = true;
    this.opts.source
      .getSnapshot(this.opts.deviceId)
      .then(
        (buffer) => {
          this.cacheSnapshot(buffer);
          this.reportHealth(true);
        },
        (err: unknown) => {
          this.opts.log.debug(`Snapshot refresh failed: ${(err as Error).message}`);
          this.reportHealth(false);
        },
      )
      .finally(() => {
        this.refreshingSnapshot = false;
      });
  }

  /** Pass a snapshot outcome up to the accessory, without letting its handler break us. */
  private reportHealth(ok: boolean): void {
    try {
      this.opts.onHealth?.(ok);
    } catch (err) {
      this.opts.log.debug(`Health callback failed: ${(err as Error).message}`);
    }
  }

  /**
   * The interface declares this `void`, and hap-nodejs calls it without awaiting — so the async
   * work has to be a separate method with its own catch. Returning a promise here instead would
   * turn any rejection into an unhandled one, which is fatal to the Homebridge process.
   */
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    void this.doPrepareStream(request, callback).catch((err: unknown) => {
      // doPrepareStream already answers `callback` on every failure it can see; reaching here
      // means the callback itself threw, so there is nobody left to tell but the log.
      this.opts.log.error(`Preparing the stream failed: ${(err as Error).message}`);
      this.stopStream(request.sessionID);
    });
  }

  private async doPrepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.opts.log.debug(`[stream] prepare (${this.opts.deviceId}) → ${request.targetAddress}:${request.video.port}`);
    let response: Parameters<PrepareStreamCallback>[1];
    try {
      const family = request.addressVersion === 'ipv6' ? 'udp6' : 'udp4';
      const videoSSRC = randomSsrc();
      const addressOverride = pickAddressOverride(request.sourceAddress, request.addressVersion);
      const videoSocket = await bindUdp(family);
      videoSocket.on('error', (err) => this.opts.log.debug(`Video return socket error: ${err.message}`));
      const videoReturnPort = videoSocket.address().port;

      // Audio is an independent RTP stream: its own port, SSRC and SRTP keys. Reserve the port the
      // same way, so ffmpeg can later bind it as its audio RTCP endpoint.
      //
      // Bound inside its own try: a failure here happens AFTER the video socket exists, and the
      // outer catch only answers the callback — it has no reference to release, so the descriptor
      // would leak for the lifetime of the process, once per failed stream attempt.
      const wantAudio = this.opts.audioCodec !== undefined;
      let audioSocket: Socket | undefined;
      if (wantAudio) {
        try {
          audioSocket = await bindUdp(family);
        } catch (err) {
          closeSocket(videoSocket);
          throw err;
        }
      }
      audioSocket?.on('error', (err) => this.opts.log.debug(`Audio return socket error: ${err.message}`));
      const audioSSRC = wantAudio ? randomSsrc() : undefined;
      this.opts.log.debug(
        `[stream] prepared (${this.opts.deviceId}) videoPort=${videoReturnPort} ssrc=${videoSSRC} ` +
          `src=${addressOverride ?? 'auto'} target=${request.targetAddress}`,
      );
      // Reap the session if 'start' never arrives, so an abandoned prepare can't leak the socket.
      const prepareTimer = setTimeout(() => {
        this.opts.log.debug(`[stream] prepare timed out without start (${this.opts.deviceId})`);
        this.endSession(request.sessionID);
      }, this.opts.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS);
      prepareTimer.unref?.(); // never hold the process open on this timer

      // Defensive: a re-prepare for a live session id would otherwise orphan its socket/timer.
      this.stopStream(request.sessionID);
      this.sessions.set(request.sessionID, {
        targetAddress: request.targetAddress,
        videoPort: request.video.port,
        videoSSRC,
        videoKey: request.video.srtp_key,
        videoSalt: request.video.srtp_salt,
        videoSocket,
        videoReturnPort,
        audioPort: wantAudio ? request.audio.port : undefined,
        audioSSRC,
        audioKey: wantAudio ? request.audio.srtp_key : undefined,
        audioSalt: wantAudio ? request.audio.srtp_salt : undefined,
        audioSocket,
        audioReturnPort: audioSocket?.address().port,
        prepareTimer,
      });
      response = {
        ...(addressOverride ? { addressOverride } : {}),
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        // Present only when we will really send audio; see StreamingDelegateOptions.audioCodec.
        ...(wantAudio && audioSocket
          ? {
              audio: {
                port: audioSocket.address().port,
                ssrc: audioSSRC!,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt,
              },
            }
          : {}),
      };
    } catch (err) {
      callback(err as Error);
      return;
    }
    // Call the success callback OUTSIDE the try: hap-nodejs wraps it in `once`, so if it were to
    // throw synchronously our catch would call it a second time (a hard "already called" error).
    // hap validates the response and can throw; it invokes us from an un-caught promise chain, so
    // swallow it here rather than let it become a process-killing unhandled rejection.
    try {
      callback(undefined, response);
    } catch (err) {
      this.opts.log.error(`Preparing the stream failed: ${(err as Error).message}`);
      this.stopStream(request.sessionID);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    this.opts.log.debug(`[stream] request '${request.type}' (${this.opts.deviceId})`);
    if (request.type === 'start') {
      // startStream is async: without this catch, anything it throws past its own try (spawn
      // failures, arg building) becomes an unhandled rejection and can kill the process.
      void this.startStream(request, callback).catch((err: unknown) => {
        this.opts.log.error(`Starting the stream failed: ${(err as Error).message}`);
        this.endSession(request.sessionID);
      });
    } else if (request.type === 'stop') {
      this.stopStream(request.sessionID);
      callback();
    } else {
      // 'reconfigure' — HomeKit asking for a different bitrate/fps mid-stream, which it does
      // because it opens every stream at a very conservative ~300kbps and expects to negotiate
      // upward. Honouring it means killing and respawning ffmpeg on the same SRTP session, which
      // visibly interrupts the picture; `effectiveBitrateKbps` instead starts at a sensible floor
      // for the resolution, so there is nothing to negotiate up from on a local link. Reported at
      // info the first time so this shows up in a bug report rather than only in debug logs.
      if (!this.reconfigureReported) {
        this.reconfigureReported = true;
        this.opts.log.info(
          `HomeKit asked to reconfigure the stream for ${this.opts.deviceId}; the plugin keeps the ` +
            'current stream instead of restarting it. Report this if picture quality looks wrong.',
        );
      }
      this.opts.log.debug(`[stream] reconfigure ignored (${this.opts.deviceId}); stream continues`);
      callback();
    }
  }

  private async startStream(
    request: Extract<StreamingRequest, { type: 'start' }>,
    callback: StreamRequestCallback,
  ): Promise<void> {
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      callback(new Error('No prepared session for this stream request.'));
      return;
    }
    // 'start' arrived — the session is live now, so it no longer needs reaping.
    clearTimeout(session.prepareTimer);
    session.prepareTimer = undefined;
    if (!this.deviceOnline) {
      // Fail immediately rather than spend the RTSPS handshake + ffmpeg spawn discovering it.
      this.stopStream(request.sessionID);
      callback(new Error(`Camera ${this.opts.deviceId} is offline.`));
      return;
    }
    const v = request.video;

    let url: string | undefined;
    let talkbackTarget: ReturnType<typeof parseTalkbackTarget>;
    try {
      const quality = selectStreamQuality(v.width);
      let streams = await this.opts.source.getRtspsStream(this.opts.deviceId);
      url = pickRtspsUrl(streams, quality);
      if (!url) {
        // RTSPS not yet enabled on the camera — turn it on for the chosen quality, then retry.
        streams = await this.opts.source.enableRtspsStream(this.opts.deviceId, [quality]);
        url = pickRtspsUrl(streams, quality);
      }
      // Talkback is best-effort: a camera without a speaker, or an older console, must not cost
      // the user their live video. Failure here degrades to one-way audio.
      if (
        this.opts.talkback && session.audioSocket && session.audioReturnPort !== undefined &&
        this.opts.source.startTalkbackSession
      ) {
        try {
          const s = await this.opts.source.startTalkbackSession(this.opts.deviceId);
          talkbackTarget = parseTalkbackTarget(s.url, s.samplingRate);
          if (talkbackTarget) {
            // Recovered: re-arm the warning so a later failure is reported rather than swallowed.
            this.talkbackWarned = false;
          }
          if (!talkbackTarget) {
            this.warnTalkbackOnce('the console returned an unusable target');
          }
        } catch (err) {
          const e = err as { status?: number; message: string };
          // A 403 from this endpoint is NOT reliably a permissions problem. Observed on real
          // hardware: the same all-access key returned 403 for every camera write during one window
          // and 200 before and after, unreproducible by bursting. So report both possibilities and
          // keep retrying rather than latching a diagnosis.
          this.warnTalkbackOnce(
            e.status === 403
              ? 'the console refused the request (HTTP 403). This is often transient and later ' +
                'attempts may succeed; if it persists, check the API key has write access for cameras'
              : e.message,
          );
        }
      }
    } catch (err) {
      this.stopStream(request.sessionID); // release the reserved socket
      callback(err as Error);
      return;
    }
    // Those awaits can take seconds (throttled, retrying HTTP). HomeKit may have stopped the
    // session meanwhile; spawning now would orphan an ffmpeg nothing can ever kill.
    if (this.sessions.get(request.sessionID) !== session) {
      callback(new Error('Stream was cancelled before it started.'));
      return;
    }
    if (!url) {
      this.stopStream(request.sessionID);
      callback(new Error('No RTSPS URL available for this camera.'));
      return;
    }
    this.opts.log.debug(
      `[stream] start ${v.width}x${v.height}@${v.fps} ${v.max_bit_rate}kbps profile=${v.profile} level=${v.level} ` +
        `mtu=${v.mtu} → ${this.opts.deviceId}`,
    );

    // With talkback on, the plugin keeps the advertised audio port and relays both directions, so
    // the outbound stream still reaches iOS from the port it expects. Bind the two private sockets
    // that makes possible before building args, since the args reference the relay port.
    if (talkbackTarget) {
      try {
        // Always IPv4: both relay hops are localhost (ffmpeg -> us, us -> talkback ffmpeg). Only
        // the advertised socket talks to the phone, and it keeps whatever family prepareStream chose.
        const relaySocket = await bindUdp('udp4');
        relaySocket.on('error', (err) => this.opts.log.debug(`Audio relay socket error: ${err.message}`));
        const talkbackIn = await bindUdp('udp4');
        session.talkbackInPort = talkbackIn.address().port;
        // Hand the port straight to the talkback ffmpeg: it must bind it to read the SDP stream.
        closeSocket(talkbackIn);
        session.relaySocket = relaySocket;
      } catch (err) {
        this.warnTalkbackOnce(`could not set up the audio relay: ${(err as Error).message}`);
        talkbackTarget = undefined;
        closeSocket(session.relaySocket);
        session.relaySocket = undefined;
        session.talkbackInPort = undefined;
      }
    }

    // Cached after the first stream, so this costs one short ffmpeg run per process.
    const capFps = await supportsFpsMax(this.opts.ffmpegPath, this.opts.encodeProbe);
    const args = buildVideoArgs({
      rtspsUrl: url,
      width: v.width,
      height: v.height,
      fps: v.fps,
      bitrateKbps: effectiveBitrateKbps(v.max_bit_rate, v.width),
      profile: v.profile,
      level: v.level,
      payloadType: v.pt,
      ssrc: session.videoSSRC,
      srtpParams: encodeSrtpParams(session.videoKey, session.videoSalt),
      address: session.targetAddress,
      videoPort: session.videoPort,
      localRtcpPort: session.videoReturnPort,
      mtu: v.mtu,
      capFps,
      audio: this.audioArgsFor(session, request, !!talkbackTarget),
    });

    // Hand the reserved ports over to ffmpeg, which binds them as its RTCP sockets
    // (localrtcpport) so receiver reports arrive on the ports we advertised to iOS.
    closeSocket(session.videoSocket);
    session.videoSocket = undefined;
    if (talkbackTarget) {
      // Keep it: the plugin owns the advertised audio port for the whole session and relays through
      // it. Handing it to ffmpeg is what cost 9-11s of load time.
      this.opts.log.debug(`[talkback] relaying audio via the advertised port (${this.opts.deviceId})`);
    } else {
      closeSocket(session.audioSocket);
      session.audioSocket = undefined;
    }

    this.opts.log.debug(`[stream] spawning ffmpeg (${this.opts.deviceId})`);
    // stdin/stdout are explicitly ignored, only stderr is piped. ffmpeg writes the stream to a
    // network URL, so stdout carries nothing we want — but an unread pipe fills its 64KB buffer
    // and then blocks the writer forever, and an open stdin pipe lets ffmpeg stall waiting on
    // input that never comes. Ignoring both also saves two descriptors per live stream.
    const proc = (this.opts.spawn ?? spawn)(this.opts.ffmpegPath, args, {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    session.ffmpeg = proc;

    if (talkbackTarget && session.audioKey && session.audioSalt && request.audio) {
      this.startTalkback(session, request, talkbackTarget);
      if (session.audioSocket && session.relaySocket) {
        session.relay = startAudioRelay({
          advertised: session.audioSocket,
          local: session.relaySocket,
          // The phone's audio port comes from prepareStream, not the start request.
          target: { address: session.targetAddress, port: session.audioPort as number },
          talkbackPort: session.talkbackInPort,
          onError: (direction, message) =>
            this.opts.log.debug(`[talkback] ${direction} relay error: ${message}`),
        });
      }
    }

    // ffmpeg echoes its input URL in the startup banner, and RTSPS URLs embed the stream key —
    // redact before anything reaches a log line (see redactStreamUrl's contract).
    const scrub = (text: string): string => text.split(url).join(redactStreamUrl(url));
    // Split per line rather than logging each chunk whole: ffmpeg writes in bursts that do not
    // align with line boundaries, so chunk-logging interleaved unrelated lines into each other.
    let suppressed = 0;
    proc.stderr?.on('data', (d: Buffer) => {
      for (const raw of d.toString().split('\n')) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        if (isExpectedFfmpegNoise(line)) {
          suppressed += 1;
          continue;
        }
        this.opts.log.debug(`[ffmpeg ${this.opts.deviceId}] ${scrub(line)}`);
      }
    });
    proc.on('error', (err) => {
      this.opts.log.error(`ffmpeg failed to start (is ffmpeg installed?): ${err.message}`);
      this.endSession(request.sessionID, session);
    });
    proc.on('exit', (code, signal) => {
      if (suppressed > 0) {
        this.opts.log.debug(
          `[ffmpeg ${this.opts.deviceId}] suppressed ${suppressed} expected decoder warnings ` +
            '(joined mid-GOP, waiting for the first keyframe)',
        );
      }
      this.opts.log.debug(`[ffmpeg ${this.opts.deviceId}] exited code=${code} signal=${signal ?? '-'}`);
      // An exit we didn't ask for (camera rebooted, RTSPS dropped) would otherwise leave HomeKit
      // showing a frozen frame and holding the stream slot forever.
      if (this.sessions.get(request.sessionID) === session) {
        this.opts.log.info(`Camera stream ended unexpectedly (${this.opts.deviceId}).`);
        this.endSession(request.sessionID, session);
      }
    });
    callback();
  }

  /**
   * The audio half of the ffmpeg command, or undefined for a video-only stream.
   *
   * HomeKit reports the sample rate in kHz (its AudioStreamingSamplerate enum is 8/16/24) while
   * ffmpeg wants Hz, hence the multiply — passing 24 straight through would ask for 24Hz audio.
   */
  /** Report a talkback problem once per camera; these causes are persistent, not per-stream. */
  private warnTalkbackOnce(reason: string): void {
    if (this.talkbackWarned) {
      return;
    }
    this.talkbackWarned = true;
    this.opts.log.warn(`Talkback unavailable for ${this.opts.deviceId}: ${reason}`);
  }

  /**
   * Spawn the talkback ffmpeg: HomeKit's SRTP microphone in, Opus RTP to the camera out.
   *
   * Failures are logged and swallowed. Talkback is an extra on top of a working stream, so a
   * missing speaker or a busy port must never take the live view down with it.
   */
  private startTalkback(
    session: Session,
    request: Extract<StreamingRequest, { type: 'start' }>,
    target: NonNullable<ReturnType<typeof parseTalkbackTarget>>,
  ): void {
    const a = request.audio;
    const sdp = buildTalkbackSdp({
      // The relay's private port, NOT the advertised one — the plugin keeps that and forwards to
      // here, so the outbound stream can still send from it.
      port: session.talkbackInPort as number,
      payloadType: a.pt,
      sampleRate: a.sample_rate * 1000,
      opus: this.opts.audioCodec?.encoder === 'libopus',
      srtp: encodeSrtpParams(session.audioKey as Buffer, session.audioSalt as Buffer),
    });
    const args = buildTalkbackArgs({
      target,
      // Reuse the same clamp as the outbound stream: libopus rejects an illegal frame duration
      // outright and kills the process.
      frameDurationMs: opusFrameDuration(a.packet_time),
    });
    let proc: ChildProcess;
    try {
      // stdin is a pipe here — unlike every other spawn in this class — because the SDP is the
      // input. stdout is ignored; an unread pipe would fill and block ffmpeg forever.
      proc = (this.opts.spawn ?? spawn)(this.opts.ffmpegPath, args, {
        env: process.env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      this.opts.log.warn(`Talkback failed to start: ${(err as Error).message}`);
      return;
    }
    session.talkback = proc;
    proc.on('error', (err) => this.opts.log.warn(`Talkback ffmpeg error: ${err.message}`));
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        this.opts.log.debug(`[talkback] ${line}`);
      }
    });
    // A write to a process that died between spawn and now would throw EPIPE.
    proc.stdin?.on('error', (err: Error) => this.opts.log.debug(`Talkback stdin: ${err.message}`));
    proc.stdin?.end(sdp);
    this.opts.log.debug(`[talkback] → ${target.host}:${target.port} @${target.sampleRate}Hz`);
  }

  private audioArgsFor(
    session: Session,
    request: Extract<StreamingRequest, { type: 'start' }>,
    talkbackOwnsPort = false,
  ): AudioArgsOptions | undefined {
    const codec = this.opts.audioCodec;
    const a = request.audio;
    if (
      !codec || !a || session.audioPort === undefined || session.audioSSRC === undefined ||
      !session.audioKey || !session.audioSalt
    ) {
      return undefined;
    }
    return {
      encoder: codec.encoder,
      sampleRateHz: a.sample_rate * 1000,
      bitrateKbps: a.max_bit_rate,
      payloadType: a.pt,
      ssrc: session.audioSSRC,
      srtpParams: encodeSrtpParams(session.audioKey, session.audioSalt),
      port: session.audioPort,
      // A UDP port has one owner, and with talkback on that owner must be the plugin: iOS sends the
      // microphone to the advertised port AND expects our audio to come from it.
      //
      // An earlier version let the talkback ffmpeg take the port and had the outbound stream send
      // from an ephemeral one. That measured 9-11s to first frame (49573 instead of the advertised
      // 55555, so iOS never associated the audio and waited for it before rendering video at all —
      // see cameraOptions.ts). Now the outbound stream sends to a localhost relay socket and the
      // plugin re-emits from the advertised port, so the wire looks exactly as it does with talkback
      // off. `localRtcpPort` is therefore irrelevant on the relayed path — ffmpeg is talking to
      // localhost, not to the phone.
      localRtcpPort: talkbackOwnsPort ? undefined : session.audioReturnPort,
      relayPort: talkbackOwnsPort ? session.relaySocket?.address().port : undefined,
      packetTimeMs: a.packet_time,
    };
  }

  /**
   * Tear a session down AND tell HomeKit, so its stream slot is released. Use this for failures;
   * `stopStream` alone is for when HomeKit already knows (it asked us to stop).
   */
  private endSession(sessionID: string, expected?: Session): void {
    if (expected && this.sessions.get(sessionID) !== expected) {
      return; // already replaced or torn down
    }
    const known = this.sessions.has(sessionID);
    this.stopStream(sessionID);
    if (known) {
      try {
        this.controller?.forceStopStreamingSession(sessionID);
      } catch (err) {
        this.opts.log.debug(`forceStopStreamingSession failed: ${(err as Error).message}`);
      }
    }
  }

  private stopStream(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionID); // delete first: the exit handler checks identity
    clearTimeout(session.prepareTimer);
    closeSocket(session.audioSocket);
    session.relay?.stop();
    session.relay = undefined;
    closeSocket(session.relaySocket);
    session.relaySocket = undefined;
    // Kill talkback first: it has no RTSP session to close cleanly.
    const talk = session.talkback;
    session.talkback = undefined;
    if (talk && talk.exitCode === null && !talk.killed) {
      try {
        talk.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    const proc = session.ffmpeg;
    if (proc && proc.exitCode === null && !proc.killed) {
      // Ask ffmpeg to close the RTSP session cleanly, then insist.
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, FFMPEG_TERM_GRACE_MS);
      hard.unref?.();
      proc.once('exit', () => clearTimeout(hard));
    }
    closeSocket(session.videoSocket);
  }

  /** Stop every session for this camera — called when the plugin shuts down. */
  shutdown(): void {
    for (const sessionID of [...this.sessions.keys()]) {
      this.stopStream(sessionID);
    }
  }
}
