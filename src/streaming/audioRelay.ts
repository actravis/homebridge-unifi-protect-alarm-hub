// Bidirectional audio relay for two-way audio, so talkback costs no stream-load time.
//
// The problem it solves: HAP advertises ONE audio port. iOS sends the phone's microphone to it and
// expects our audio to originate from it. A UDP port has a single owner, so when talkback's ffmpeg
// binds that port to receive the microphone, the outbound stream has to send from an ephemeral port
// instead — and iOS, which is waiting on an advertised audio codec, does not render video until it
// times out. Measured: 9-11s to first frame, against 1-2s with talkback off.
//
// So the plugin owns the advertised port and forwards both directions:
//
//   outbound ffmpeg --> 127.0.0.1:localPort --> [advertised socket] --> iOS
//   iOS --> [advertised socket] --> 127.0.0.1:talkbackPort --> talkback ffmpeg
//
// Packets are forwarded verbatim. SRTP is keyed on the SSRC rather than the transport addresses, so
// a relayed packet is byte-identical to a directly-sent one; nothing here decrypts or re-encrypts.

import type { Socket } from 'node:dgram';

export interface AudioRelayOptions {
  /** The socket bound to the port advertised to iOS. Owned by the caller; not closed here. */
  advertised: Socket;
  /** Socket receiving the outbound stream's audio from ffmpeg on localhost. */
  local: Socket;
  /** Where to send audio: the phone. */
  target: { address: string; port: number };
  /** Localhost port the talkback ffmpeg listens on, or undefined to drop inbound audio. */
  talkbackPort?: number;
  /** Diagnostics only; called at most once per direction to avoid log spam per packet. */
  onError?: (direction: 'outbound' | 'inbound', message: string) => void;
}

export interface AudioRelay {
  /** Counters for diagnostics and tests: how many packets moved each way. */
  readonly stats: { outbound: number; inbound: number };
  stop(): void;
}

/**
 * Wire up the relay. Returns a handle whose `stop` detaches the listeners; the sockets themselves
 * belong to the caller, which closes them as part of normal session teardown.
 */
export function startAudioRelay(opts: AudioRelayOptions): AudioRelay {
  const stats = { outbound: 0, inbound: 0 };
  // One report per direction: a broken relay would otherwise log per packet, 50 times a second.
  const reported = { outbound: false, inbound: false };
  const fail = (direction: 'outbound' | 'inbound', err: Error): void => {
    if (!reported[direction]) {
      reported[direction] = true;
      opts.onError?.(direction, err.message);
    }
  };

  /**
   * Forward one packet, tolerating a closed socket.
   *
   * `send` on a closed dgram socket throws SYNCHRONOUSLY (ERR_SOCKET_DGRAM_NOT_RUNNING) instead of
   * reporting through the callback. Since this runs inside a socket 'message' handler, an unguarded
   * throw is an uncaught exception — and teardown makes that reachable: a packet already queued can
   * fire after the session closed its sockets. Caught and counted as a normal relay error.
   */
  const forward = (
    socket: Socket,
    packet: Buffer,
    port: number,
    address: string,
    direction: 'outbound' | 'inbound',
  ): void => {
    try {
      socket.send(packet, port, address, (err) => {
        if (err) {
          fail(direction, err);
        } else {
          stats[direction] += 1;
        }
      });
    } catch (err) {
      fail(direction, err as Error);
    }
  };

  const onLocal = (packet: Buffer): void => {
    // Re-emit from the advertised socket, so iOS sees the source port it was told about.
    forward(opts.advertised, packet, opts.target.port, opts.target.address, 'outbound');
  };

  const onAdvertised = (packet: Buffer): void => {
    const port = opts.talkbackPort;
    if (port === undefined) {
      return; // talkback not running: the microphone has nowhere to go, so drop it
    }
    forward(opts.local, packet, port, '127.0.0.1', 'inbound');
  };

  opts.local.on('message', onLocal);
  opts.advertised.on('message', onAdvertised);

  return {
    stats,
    stop(): void {
      opts.local.off('message', onLocal);
      opts.advertised.off('message', onAdvertised);
    },
  };
}
