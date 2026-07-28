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
- New options: `exposeCameras`, `exposeObjectSensors`, `exposeCameraStreams`,
  `exposeDoorbellTriggers`, `doorbellDeviceIds`, `exposeAlarm` (for a cameras-only setup), and
  `realtimeIdleTimeout`.
- ffmpeg is supplied automatically via the optional `ffmpeg-for-homebridge` dependency, falling
  back to `ffmpeg` on `PATH`.

### Fixed

- **The security tile no longer reports an illegal state.** With only an arm trigger configured
  and no disarm trigger, every refresh while disarmed wrote a target value outside the tile's
  allowed set, producing a repeated HomeKit warning.
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
- **Arm-profile memory is no longer vulnerable to prototype pollution.** The learned profile map
  is keyed by fingerprints derived from console-supplied channel data; a zone named `__proto__`
  or `constructor` could previously make a lookup return an inherited value and write it
  straight to a HomeKit characteristic.
- **Credentials are kept out of the logs.** RTSPS URLs embed a stream key and ffmpeg echoes its
  input URL, so ffmpeg output is scrubbed. Unrecognised realtime payloads — which are logged
  verbatim for diagnostics — are redacted by field name first, because alarm-hub entry events
  arrive on the same feed carrying the keypad PIN.

### Changed

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
