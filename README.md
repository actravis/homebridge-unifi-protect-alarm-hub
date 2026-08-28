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
    (typically ~2s to first frame). No account password, no cloud. Camera audio is available
    behind `exposeCameraAudio`, and two-way talkback behind `exposeTalkback`.
  - **Snapshots** — including the thumbnail on motion and doorbell notifications.
  - **Motion + smart detection** — a motion sensor per camera, plus a contact sensor per
    smart-detect type it supports (person / vehicle / animal / package), driven by the realtime
    events feed. All of it is one HomeKit accessory per camera — see [Scale](#scale).
  - **Doorbell** — ring events for doorbell cameras, and an optional per-camera trigger
    switch so any camera can ring the doorbell from an automation.
  - **Status light** — an optional switch (`exposeStatusLed`) to turn a camera's status LED off.
    Only cameras that report a controllable LED get one; on the rest the console ignores the write,
    so no switch is created.
  - **Doorbell screen messages** — optional switches (`exposeDoorbellMessages`) for Protect's two
    presets plus your own texts (`doorbellMessages`). One message shows at a time, so turning one on
    turns the others off; turning the active one off clears the screen. A message set in the Protect
    app shows up on the matching switch.

- **Doorbell chimes** — a chime can appear with either or both of:
  - a **Ring button** to ring it on demand or from an automation (set `chimeTriggerId`);
  - an **Audible switch** to mute and unmute it (`exposeChimeMute`), for automations like
    "silent after 10pm". Muting preserves each camera's ringtone and repeat count.

  Ringing needs a one-time setup step because the Integration API has no ring endpoint for
  chimes — see [Ringing a chime](#ringing-a-chime).

  Cameras appear automatically with the bridge — no per-camera pairing. Cameras are
  re-discovered every few minutes, so one added, renamed, or unplugged in Protect is picked up
  without a restart; a camera Protect reports as disconnected is marked unavailable in HomeKit
  rather than left showing a stale picture.

  A device that stops being reported is **not** removed straight away. Removing an accessory also
  discards its room assignment and any automation using it, and re-adding the device does not bring
  those back — so a device has to stay missing across a second discovery pass, with the console
  steady in between, before anything irreversible happens. That means a console reboot no longer
  costs you your setup. Tune it with `deviceRemovalDelay` (seconds, default 300; `0` removes on
  sight). Removals you ask for by changing settings — switching a feature off, or adding a camera to
  `excludeCameras` — are never delayed.

## Roadmap

- **Devices & settings** — lights, sensors, liveviews, and camera setting switches.
- **Adaptive bitrate** — honour HomeKit's `reconfigure` requests instead of using a
  fixed per-resolution bitrate.

## Requirements

- Homebridge v1.8+ (or v2 beta), Node 18.17+.
- A UniFi console (UDM / Cloud Key / NVR) running UniFi Protect.
- For the Alarm Hub features: a Protect **Alarm Hub**.
- An **API key**: UniFi OS → **Integrations**.
- For live video: **ffmpeg**. The `ffmpeg-for-homebridge` optional dependency normally
  supplies it automatically; otherwise the plugin falls back to `ffmpeg` on `PATH`. Only
  needed if you leave camera streaming enabled.

## Setup

1. **API key** — create one under **Integrations**, a top-level area in UniFi OS (older guides
   put it under Settings → Control Plane), and paste it into the plugin config along with your
   console's address.
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

## Ringing a chime

The official API exposes a chime's settings but has no endpoint to make it ring, so the plugin
rings it through **Alarm Manager**, which can act on hardware the REST API does not expose:

1. In UniFi Protect, open **Alarm Manager** and create an alarm.
2. Give it a **Webhook** trigger and an action that plays your chime.
3. Copy the alarm's **Trigger ID** into the plugin's `chimeTriggerId` setting.

The ring button appears once a Trigger ID is set. With none configured, no ring button is created
at all — a button that cannot ring looks functional in the Home app and then fails silently inside
an automation.

The webhook requires your API key, so the Trigger ID is not on its own enough for someone on your
network to fire it. The mute switch (`exposeChimeMute`) needs no setup; it uses the chime's normal
settings endpoint.

## Scale

**A camera is one HomeKit accessory.** Its smart detections (person, vehicle, animal, package) are
contact sensors *on* that accessory rather than accessories of their own, so adding detection types
costs nothing against HomeKit's limit of **149 accessories per one bridge**.

That limit is therefore out of reach for most homes. It is still reachable on a large site, because
two things do add accessories: `exposeAudioSensors` adds up to 2 per camera (the smoke and CO sensors
stay separate — HomeKit treats a native `SmokeSensor` as a critical alert, which is the entire reason
to expose one), and the alarm hub contributes one per zone. Past the limit HomeKit silently stops
accepting accessories, which looks like devices going missing with nothing in any log to explain it —
so the plugin warns once as it approaches, at 130.

The limit is **per bridge**, and the plugin does **not** split itself automatically. If you approach
it, the fix that keeps every accessory is to run two platform instances in separate Homebridge
[child bridges](https://github.com/homebridge/homebridge/wiki/Child-Bridges), each with its own
budget. Existing accessories keep their identities, so nothing needs re-pairing.

Discovery does not scale with device count either way: one request each for cameras, chimes and hubs
per pass, regardless of how many devices exist. Per-camera requests happen only when a stream starts.

### Split one: alarm on one bridge, cameras on another

This is the simplest split and usually enough. No camera lists — just turn each domain off on the
instance that shouldn't have it.

```json
{
  "platforms": [
    {
      "platform": "UnifiProtectIntegration",
      "name": "UniFi Protect Alarm",
      "host": "192.168.1.1",
      "apiKey": "…",
      "exposeCameras": false,
      "_bridge": { "username": "0E:2C:41:1A:BB:01", "port": 51820 }
    },
    {
      "platform": "UnifiProtectIntegration",
      "name": "UniFi Protect Cameras",
      "host": "192.168.1.1",
      "apiKey": "…",
      "exposeAlarm": false,
      "_bridge": { "username": "0E:2C:41:1A:BB:02", "port": 51821 }
    }
  ]
}
```

### Split two: divide the cameras themselves

Only needed when the cameras alone overflow one bridge — around 49 cameras with the smoke/CO sensors
on, or 149 without them. Add `includeCameras` to each camera instance:

```json
{
  "exposeAlarm": false,
  "includeCameras": ["Front Door", "Driveway"],
  "_bridge": { "username": "0E:2C:41:1A:BB:02", "port": 51821 }
}
```

...with the remaining cameras listed on a third instance, on its own bridge again.

Points that matter for either split:

- Each `_bridge` needs its **own** `username` (any unused MAC-shaped value) and `port`. Homebridge
  can generate these for you from the plugin's settings screen.
- Expose the alarm on exactly **one** instance (`exposeAlarm: false` on the others), or you get
  duplicate alarm accessories. The same goes for `exposeChimes`.
- Each instance opens its own connection to the console, so keep the count small — two or three.
- `includeCameras` and `excludeCameras` match a camera's **name or device ID**, case-insensitively.
  An entry that matches nothing is reported in the log rather than silently ignored, since a typo in
  an include list would otherwise expose no cameras at all.
- **The alarm hub cannot be split.** There is no per-zone filter, so all of its accessories live on
  whichever bridge exposes it. In practice a hub's zone count is bounded well under the limit.

### Why the sensors are on the camera

The smart-detection sensors are **contact** sensors on the camera accessory, not motion sensors on
accessories of their own. Two reasons, and both are deliberate:

- **Accessory budget.** One accessory per camera instead of up to five is what puts the 149 limit out
  of reach for a normal home.
- **HomeKit's motion signal is singular.** A camera accessory's motion sensor *is* "this camera
  detected motion" — it drives the camera's notifications and its recording. Adding a motion service
  per detection type would make five services all claim to be that camera's motion, so one person
  walking past reports several times.

They remain individually visible and usable in automations; they appear grouped under the camera
rather than as separate tiles. The one thing to know when building automations: the trigger reads
**Opens**, not *Detects Motion*.

Set `exposeObjectSensors: false` to drop them entirely and leave a camera reporting overall motion
only. That reduces clutter, not accessory count — they were never separate accessories.

`excludeCameras` also works on its own as a privacy control: a camera listed there is never exposed
to HomeKit.

## Limitations

- **Outputs are read-only.** UniFi does not yet expose a way to trigger alarm-hub outputs
  from the Integration API, so outputs — including the Beeper — appear as status-only
  sensors. They will become switchable once UniFi exposes control.
- **Zone tamper vs. EOL trouble** is not yet distinguished. Zones report open/closed, and
  any other supervised state is surfaced as a generic *fault*.
- **SuperLink / wireless sensors** are not yet supported (they are adopted as separate
  devices); planned for a future release.
- **Chimes cannot be rung by the API directly.** Ringing requires an Alarm Manager webhook (see
  [Ringing a chime](#ringing-a-chime)); every chime play/ring endpoint returns 404. Ringtones
  cannot be listed or changed either — the plugin preserves whatever you set in Protect.
- **Talkback can fail with HTTP 403, sometimes transiently.** A read-only API key will always be
  refused, but an all-access key has also been observed returning 403 for every camera write during
  one window, with 200 before and after and no way to reproduce it. The plugin keeps retrying on the
  next stream and reports the problem once rather than treating it as permanent.
- **Talkback needs a route to the camera itself.** The console hands back an RTP target on the
  **camera's** IP, not the console's, so Homebridge must be able to reach the camera directly —
  unlike live video, which only ever talks to the console. Cameras on an isolated IoT VLAN will
  stream fine but cannot receive talkback.
- **Camera audio and talkback are experimental.** One-way audio works behind
  `exposeCameraAudio`, but which codec you get depends on your ffmpeg build: HomeKit wants AAC-ELD,
  and the bundled ffmpeg lists `libfdk_aac` yet cannot initialise the ELD profile, so it falls back
  to Opus. Live video is transcoded, so several simultaneous viewers cost CPU on the Homebridge
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

Before starting work and before any release, run the full gate:

```
npm run verify
```

That is lint, dependency audit, secret scan and tests — the same checks CI runs, so the two cannot
drift. The audit uses two thresholds: runtime dependencies fail at **moderate** (there is one,
`undici`, and it carries every HTTPS call and the API key), dev dependencies at **high**.

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
