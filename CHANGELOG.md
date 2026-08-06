# Changelog

Notable changes to this plugin. Releases before 0.2.0 predate this file; see the git history.

## 0.2.0 — unreleased

Grows the plugin from Alarm Hub support into general UniFi Protect support, still entirely on
the official Integration API. Cameras, live video and smart detections are new; the Alarm Hub
side gained a substantial round of reliability and security work.

### Breaking

- **The plugin has been renamed** from `homebridge-unifi-protect-alarm-hub` to
  `homebridge-unifi-protect-integration`, because it now covers more than the Alarm Hub.
- **Update your config**: change `"platform": "UnifiProtectAlarmHub"` to
  `"platform": "UnifiProtectIntegration"`. Install the new package and remove the old one.
- Alarm Hub accessories are **unchanged** across the rename — their identities are identical,
  so rooms, custom names, and automations carry over without re-pairing.

### Known issues

- **Camera writes can return a transient HTTP 403.** Observed on an all-access API key: every camera
  write (`rtsps-stream`, `talkback-session`) returned 403 for one window, with 200 before and after,
  not reproducible by bursting. Talkback reports it once and retries on the next stream. If RTSPS is
  already enabled on your cameras this is invisible, since only the read path is needed.

### Security

- **Updated `undici` to 6.28.0**, clearing three advisories against the plugin's only runtime
  dependency — most relevantly response desynchronisation via the retry interceptor, which this
  client uses. Also updated a dev-only transitive dependency (`brace-expansion`).
- **The dependency audit is now stricter where it matters.** Runtime dependencies fail the build at
  **moderate** severity rather than high: there is only one, and it carries every HTTPS call, the
  API key and the realtime socket. Dev dependencies fail at high. Those three advisories had been
  sitting unnoticed under a high-only gate.
- **`npm run verify`** runs lint, audit, secret scan and tests in one command — the same set CI
  runs, and what `prepublishOnly` now uses.

### Fixed

- **A disabled feature no longer leaves a dead accessory behind.** Turning off cameras or chimes
  (or leaving a chime unconfigured) skipped reconciliation entirely, so an accessory cached from an
  earlier config stayed registered with nothing driving it: HomeKit showed the tile at its last
  known value and silently ignored every change. Those accessories are now removed.

### Added

- **Cameras.** Each camera appears in HomeKit with live video, snapshots, and a motion sensor.
  Live video is transcoded from the camera's RTSPS substream by ffmpeg (typically ~2s to first
  frame). Snapshots include the thumbnail on motion and doorbell notifications.
- **Smart detections.** Optional per-type motion sensors for every detection a camera supports
  (person, vehicle, animal, package), driven by the realtime events feed.
- **Doorbells.** Ring events for doorbell cameras, plus an optional per-camera "Doorbell
  Trigger" switch so any camera can ring the doorbell from an automation.
- **Automatic camera re-discovery.** Cameras added, renamed, or unplugged in Protect are picked
  up within a few minutes, with no restart.
- **Offline cameras are marked unavailable** rather than left serving a stale picture, and stop
  being polled for snapshots — one unreachable camera used to be enough to overload the console.
- **Camera audio in the live stream (experimental, off by default).** Enable with
  `exposeCameraAudio`. The plugin probes ffmpeg at startup by actually running the encoder and
  picks the best codec HomeKit accepts — AAC-ELD where available, otherwise Opus — and logs which
  it chose, or falls back to video-only if neither works.
- **Smoke and CO alarm sensors (experimental, off by default).** Protect's cameras can recognise a
  sounding smoke or CO alarm; those detections now become **native** HomeKit `SmokeSensor` and
  `CarbonMonoxideSensor` accessories rather than generic motion sensors, so a sounding alarm is a
  first-class automation trigger and can raise a Home hub critical notification. Only detections
  you have enabled in Protect are exposed. Enable with `exposeAudioSensors`.
- **Two-way audio (talkback, experimental, off by default).** Costs nothing in stream startup: the
  plugin owns the audio port HomeKit was told about and relays both directions, so outbound audio
  still reaches iOS from the source port it expects. Enable with `exposeTalkback` (needs
  `exposeCameraAudio`). Talk from the Home app to a camera's speaker: HomeKit's microphone arrives
  as SRTP and is re-encoded to the Opus RTP the camera expects, by a second ffmpeg process.

  The console's talkback target is the **camera's own IP**, not the console's, so Homebridge needs a
  network route to the camera itself. The URL is validated strictly before it becomes an ffmpeg
  argument — only `rtp://host:port` is accepted. A camera without a speaker, or any talkback
  failure, degrades to one-way audio rather than taking the live stream down.
- **Doorbell chimes.** A chime can be exposed with two independent, optional controls:
  - a **Ring button** that rings it on demand or from an automation, enabled by setting
    `chimeTriggerId`;
  - an **Audible switch** that mutes and unmutes it, enabled with `exposeChimeMute`.

  Ringing goes through an Alarm Manager webhook because the Integration API has no ring endpoint
  for chimes: create an alarm in Protect with a **Webhook** trigger and a chime action, then paste
  its Trigger ID into `chimeTriggerId`. Without a Trigger ID no ring button is created, since a
  button that cannot ring would fail silently inside an automation. Muting sets the ring volume to
  0 for every paired camera and restores the previous level on unmute, preserving each camera's
  chosen ringtone and repeat count.
- New options: `exposeCameras`, `exposeObjectSensors`, `exposeAudioSensors`, `exposeCameraStreams`,
  `exposeCameraAudio`, `exposeTalkback`, `exposeChimes`, `chimeTriggerId`, `exposeChimeMute`,
  `exposeDoorbellTriggers`, `doorbellDeviceIds`, `exposeAlarm` (for a cameras-only setup), and
  `realtimeIdleTimeout`.
- ffmpeg is supplied automatically via the optional `ffmpeg-for-homebridge` dependency, falling
  back to `ffmpeg` on `PATH`.

### Fixed

- **The security tile no longer reports an illegal state.** With only an arm trigger configured
  and no disarm trigger, every refresh while disarmed wrote a target value outside the tile's
  allowed set, producing a repeated HomeKit warning.
- **Smart audio detections were being dropped entirely.** Protect names these events
  `smartAudioDetect`, which did not match the `smartDetect` prefix the decoder tested for, so
  every smoke and CO alarm detection was discarded silently. The decoder now matches the whole
  `smart*` family and reads whatever detection types the payload carries, so a variant Protect
  adds in future arrives working rather than absent.
- **Camera audio timestamps stay monotonic.** The RTSP source intermittently delivers an audio
  packet whose timestamp precedes the previous one; measured on an HEVC camera, 2 of 5 stream starts
  logged "Non-monotonic DTS" and the muxer silently rewrote the timestamp, which risks audio drifting
  out of sync over a long viewing session. An `aresample` filter now realigns the audio timeline
  instead. Zero occurrences across 8 subsequent runs, with no change in audio delivered.
- **A dropped realtime connection reconnects once, not twice.** A single drop emits both `error`
  and `close`, and each was starting its own reconnect loop — two connections racing to reopen,
  which the console's rate limiter then punished.
- **A late event from a replaced socket can no longer disturb the live one.** Handlers were bound
  to a mutable reference, so a stale socket's `error` could close its own replacement.
- Socket opens are spaced and every backoff path has jitter, so retries can't synchronise into
  bursts.

### Security

- **Certificate pinning fails closed.** A `certificateSha256` that failed to parse (a stray
  paste, a string of colons) was silently discarded and the connection ran *unpinned* while the
  UI still showed a pin configured. It now refuses to start with a clear error.
- **TLS verification defaults to on** inside the API client. The plugin always passed an explicit
  value, so behaviour is unchanged — but the unsafe default is gone.
- **Detection-type lookups are no longer vulnerable to prototype pollution.** Detection and zone
  type names come from the console and were used as plain-object keys, so a type named `constructor`
  or `toString` resolved to a function off `Object.prototype`. Camera discovery iterates that result,
  meaning a single such name would abort discovery and leave **no cameras at all**; the accessory
  labeller would have used a function's source text as a HomeKit name. Both tables are now Maps.
- **Arm-profile memory is no longer vulnerable to prototype pollution.** The learned profile map
  is keyed by fingerprints derived from console-supplied channel data; a zone named `__proto__`
  or `constructor` could previously make a lookup return an inherited value and write it
  straight to a HomeKit characteristic.
- **Credentials are kept out of the logs.** RTSPS URLs embed a stream key and ffmpeg echoes its
  input URL, so ffmpeg output is scrubbed. Unrecognised realtime payloads — which are logged
  verbatim for diagnostics — are redacted by field name first, because alarm-hub entry events
  arrive on the same feed carrying the keypad PIN.

### Changed

- **Frame rate is capped, not targeted.** HomeKit's requested fps is a maximum, but `-r` treated it
  as a goal: against a 24fps camera ffmpeg invented six frames a second to reach 30, costing 25%
  extra encoding and making motion judder because the duplicates landed at irregular intervals. The
  `-fpsmax` flag this uses only exists in ffmpeg 5.1+, so support is probed at runtime and the flag
  omitted on older builds — where an unknown option is a hard error that would fail every stream.
- **The fallback poll backs off while the realtime feed is connected**, from every 10s to every
  60s, returning to the configured rate the moment the feed drops. With the push feed up every
  change already arrives in ~1–2s, so this removes roughly 8,600 redundant requests a day
  against a console that rate-limits at ~10 requests/second.
- **Rate-limit discipline.** Requests are proactively spaced to ~8/second rather than relying on
  hitting the limit and backing off. `429` responses honour the server's own window — the
  `Retry-After` header in both delay-seconds and HTTP-date forms, and the body's `windowMs` —
  and every retry delay is capped at 60s so a bogus server hint can't stall the plugin for hours.
- **Sustained outages no longer show confidently stale state.** After three consecutive failed
  refreshes, accessories are marked unavailable, so a door doesn't keep reporting "closed" when
  the console can't be reached. The next successful refresh restores real values. Outages are
  logged once, with an explicit message on recovery.
- **Dead connections are detected at the transport layer.** TCP keepalive is enabled, which is
  the correct signal here: this API sends no application-level keepalive frames, so "no messages"
  means "quiet", not "dead". `realtimeIdleTimeout` adds an optional app-level watchdog.
- Cleaner shutdown: live ffmpeg processes are terminated, and work already in flight can no
  longer touch HomeKit after Homebridge has begun tearing down.

### Documentation

- Corrected the claim about externally-armed systems. The plugin does recognise which profile is
  active when you arm from a fob, app or keypad — but it learns each mode's zone fingerprint the
  first time you arm that mode *from HomeKit*. Until then, an externally armed system reports
  **Away**. Arm each mode once from the Home app to seed it.
- The README now explains how the plugin works internally and how to develop on it.

### Internal

- Continuous integration on Node 18/20/22, with linting, a Homebridge v2 type-check, and a
  production-dependency audit.
- Extensive unit tests, including a frozen contract for accessory UUIDs and serial numbers so no
  future refactor can silently re-create anyone's accessories.
