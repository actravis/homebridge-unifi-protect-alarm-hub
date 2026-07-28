# homebridge-unifi-protect-integration

[![npm version](https://img.shields.io/npm/v/homebridge-unifi-protect-integration)](https://www.npmjs.com/package/homebridge-unifi-protect-integration)
[![CI](https://github.com/actravis/homebridge-unifi-protect-alarm-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/actravis/homebridge-unifi-protect-alarm-hub/actions/workflows/ci.yml)

HomeKit for **UniFi Protect**, built entirely on the **official UniFi Protect
Integration API** — no reverse-engineering, a revocable API key instead of a stored
account password, and local-only operation.

> **Renamed.** This plugin was previously published as `homebridge-unifi-protect-alarm-hub`.
> It now covers more of Protect, so it was renamed. If you're upgrading from the old
> package: install this one, remove the old one, and update the platform block in your
> Homebridge config from `"platform": "UnifiProtectAlarmHub"` to
> `"platform": "UnifiProtectIntegration"`.

## Why this plugin

The excellent [`homebridge-unifi-protect`](https://github.com/hjdhjd/homebridge-unifi-protect)
by hjdhjd is the most complete Protect integration there is, and remains the best choice
for camera streaming. This plugin is a different trade-off:

- **Official API, not reverse-engineered** — stable across Protect updates by contract.
- **Security-first** — authenticates with a revocable API key (not a full-management
  account username/password), a small dependency footprint, and an auditable codebase.
- **Alarm Hub support** — arm/disarm and full sensor status for the UniFi Protect **Alarm
  Hub**, which other plugins don't cover. This is the reason the plugin exists.

If you want the richest camera experience (including HomeKit Secure Video), run hjdhjd's
plugin. The two coexist fine.

## What works today

- **Alarm Hub → HomeKit Security System** — Away / Night / Off, fully two-way.
  - Recognises which profile is active when the system is armed from a **fob, the app, or a
    keypad**. The Integration API never reports the active profile, so the plugin identifies it
    by fingerprinting which zones the hub has made live. It learns that fingerprint the first
    time you arm each mode *from HomeKit* — so arm Away once and Night once from the Home app,
    and external arms are labelled correctly from then on. Until a mode has been learned, an
    externally-armed system shows as **Away**.
  - Shows **triggered** when the alarm sounds (optionally restricted to specific siren
    output channel(s) so entry/exit chirps aren't mistaken for an alarm).
- **Automatic zone discovery** — every enabled hub terminal appears as a Contact or Motion
  sensor, named as it is in UniFi. Enable a new terminal in UniFi and it shows up on the
  next refresh — no config changes, no restart.
- **Alarm Hub status** — enclosure tamper, backup-battery health, reachability.
- **Outputs & emergency input** — exposed as read-only sensors (see limitations).
- **Realtime** — ~1–2s updates via the console's push feed, with polling as a fallback. While
  the feed is connected the poll backs off automatically, so the console isn't asked for state
  it has already pushed; the full rate resumes the moment the feed drops.
- **Cameras** — each camera appears in HomeKit with:
  - **Live video** — pulled from the camera's RTSPS stream and transcoded by ffmpeg
    (typically ~2s to first frame). No account password, no cloud.
  - **Snapshots** — including the thumbnail on motion and doorbell notifications.
  - **Motion + smart detection** — a motion sensor per camera plus optional per-type sensors
    (person / vehicle / animal / package), driven by the realtime events feed.
  - **Doorbell** — ring events for doorbell cameras, and an optional per-camera trigger
    switch so any camera can ring the doorbell from an automation.

  Cameras appear automatically with the bridge — no per-camera pairing. Cameras are
  re-discovered every few minutes, so one added, renamed, or unplugged in Protect is picked up
  without a restart; a camera Protect reports as disconnected is marked unavailable in HomeKit
  rather than left showing a stale picture.

## Roadmap

- **Camera audio** — the stream is video-only today; the API also supports two-way talkback.
- **Devices & settings** — chimes, lights, sensors, liveviews, and camera setting switches.
- **Adaptive bitrate** — honour HomeKit's `reconfigure` requests instead of using a
  fixed per-resolution bitrate.

## Requirements

- Homebridge v1.8+ (or v2 beta), Node 18.17+.
- A UniFi console (UDM / Cloud Key / NVR) running UniFi Protect.
- For the Alarm Hub features: a Protect **Alarm Hub**.
- An **API key**: UniFi OS → Settings → Control Plane → Integrations.
- For live video: **ffmpeg**. The `ffmpeg-for-homebridge` optional dependency normally
  supplies it automatically; otherwise the plugin falls back to `ffmpeg` on `PATH`. Only
  needed if you leave camera streaming enabled.

## Setup

1. **API key** — create one under Settings → Control Plane → Integrations and paste it into
   the plugin config, along with your console's address.
2. **Arm/disarm (optional)** — the Integration API can't set the arm profile directly while
   the Global Alarm Manager is enabled, so arming is done through Alarm Manager webhooks:
   - In **Protect → Alarm Manager**, create an alarm with **Trigger = Webhook** and
     **Action = Arm** (choose the profile) or **Action = Disarm**.
   - Copy the alarm's **Trigger ID** into the matching field in the plugin config.
   - Repeat for each mode you use (Away, Night, Disarm). Leave a field blank to omit that
     mode; leave all three blank and the tile is status-only.
3. Save and restart Homebridge. Zones, the hub, and outputs are discovered automatically.

All settings are documented inline in the Homebridge UI — you shouldn't need this file to
configure the plugin.

## Limitations

- **Outputs are read-only.** UniFi does not yet expose a way to trigger alarm-hub outputs
  from the Integration API, so outputs — including the Beeper — appear as status-only
  sensors. They will become switchable once UniFi exposes control.
- **Zone tamper vs. EOL trouble** is not yet distinguished. Zones report open/closed, and
  any other supervised state is surfaced as a generic *fault*.
- **SuperLink / wireless sensors** are not yet supported (they are adopted as separate
  devices); planned for a future release.
- **Camera streams are video-only.** Audio (both camera audio and talkback) is not wired up
  yet. Live video is transcoded, so several simultaneous viewers cost CPU on the Homebridge
  host; the stream bitrate is a fixed floor per resolution rather than adapting to HomeKit's
  requests.

## How it works

Two independent domains share one connection to the console.

**The alarm side is poll-driven.** The Integration API's push feed sends only thin "something
changed" deltas for the hub, so the plugin uses them as a trigger and re-reads the full
`/alarm-hubs` snapshot. Every refresh re-derives which accessories *should* exist from that
snapshot and reconciles: new terminals appear, disabled ones are removed, renames follow. There
is no static device list anywhere. Because the push feed covers every change, the poll is only
a backstop and slows to once a minute while the feed is healthy.

**The camera side is event-driven.** Detections arrive already decoded on a second socket
(`/subscribe/events`) and are routed straight to the matching accessory. Discovery is separate
and periodic, because "this camera was renamed / added / went offline" is not something the
events feed reports. Live video is a per-camera ffmpeg process pulling the camera's RTSPS
substream and re-emitting it as SRTP to the iOS device.

Two ideas run through the codebase:

- **Decisions are pure functions, I/O is injected.** "Which accessories should exist"
  (`discovery.ts`, `cameraDiscovery.ts`), "how long to back off" (`client/timing.ts`,
  `pollPolicy.ts`), "which ffmpeg arguments" (`streaming/ffmpegArgs.ts`) and "what does this
  event mean" (`cameraEvents.ts`) are all dependency-free and directly unit-tested. The classes
  that talk to Homebridge, the console, or a child process take their boundaries as constructor
  dependencies so tests can supply fakes.
- **Never present stale state as current.** A console outage marks accessories inactive rather
  than leaving a door showing "closed"; a disconnected camera stops serving cached snapshots.

| Module | Responsibility |
| --- | --- |
| `platform.ts` | Homebridge lifecycle, accessory reconcile, event routing, poll cadence |
| `client/protectClient.ts` | The only code that talks to the console: REST + two WebSockets, TLS pinning, rate-limit throttling and retry |
| `discovery.ts` / `cameraDiscovery.ts` | Pure "what should exist" planning for the alarm and camera domains |
| `armState.ts` | Recognising the active arm profile from the hub's zone fingerprint |
| `cameraEvents.ts` | Decoding realtime events into normalised detections |
| `accessories/*` | HomeKit services, one class per accessory kind |
| `streaming/*` | CameraController wiring, ffmpeg argument construction, the live-stream delegate |

## Development

```bash
npm install && npm test
```

`npm test` compiles first (the tests import from `dist/`), then runs the suite with Node's
built-in test runner. `npm run lint` runs ESLint, type-aware for `src`. CI runs both on Node
18/20/22, type-checks against the Homebridge v2 beta, and audits production dependencies.

Tests live in `test/*.test.mjs` and are plain ESM — no framework, no transpile step. The fakes
in `test/helpers/` (a HAP mock and a Homebridge `API` mock) are what make it possible to drive
the platform end to end without a console, a HomeKit controller, or real timers.

## Security notes

- The API key is stored in your Homebridge config and sent only to your console. It is a
  revocable token — if it leaks, revoke it in the UniFi UI. (Note: UniFi API keys are
  currently console-wide, so treat it as sensitive and keep your Homebridge host locked
  down.)
- UniFi consoles use self-signed certificates; the plugin trusts the configured console
  only (scoped to the plugin, not a global TLS override). Set `certificateSha256` to pin
  the exact certificate for the strongest posture.

## License

MIT
