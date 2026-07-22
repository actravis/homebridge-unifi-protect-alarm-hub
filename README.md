# homebridge-unifi-protect-alarm-hub

[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm version](https://img.shields.io/npm/v/homebridge-unifi-protect-alarm-hub)](https://www.npmjs.com/package/homebridge-unifi-protect-alarm-hub)

Expose your **UniFi Protect Alarm Hub** to Apple HomeKit — arm/disarm the security
system and see the status of every contact, glass-break and motion zone, using the
**official UniFi Protect Integration API** (API key + Alarm Manager webhooks).

Built because the Alarm Hub forces UniFi's **Global Alarm Manager** mode, in which the
usual arm/disarm API paths are unavailable — this plugin arms via Alarm Manager webhooks
and reads state (including the active arm profile) straight from the hub.

## Features

- **Security System tile** — Away / Night / Off, fully two-way.
  - Correct state even when armed from a **fob, the app, or a keypad** (the active profile
    is recognised from the hub's per-zone fingerprint).
  - Shows **triggered** when the alarm sounds (optionally restrict to specific siren
    output channel(s) so entry/exit chirps aren't mistaken for an alarm).
- **Automatic zone discovery** — every enabled hub terminal appears as a Contact or Motion
  sensor, named as it is in UniFi. Enable a new terminal in UniFi and it shows up on the
  next refresh — no config changes, no restart. (New accessories take their UniFi name; if
  you *rename* an existing sensor in UniFi, HomeKit may keep the original name until you
  remove and re-add that accessory — HomeKit caches accessory names.)
- **Alarm Hub status** — enclosure tamper, backup-battery health, reachability.
- **Outputs & emergency input** — exposed as read-only sensors (see limitations).
- **Realtime** — ~1–2s updates via the console's push feed, with polling as a fallback.

## Requirements

- Homebridge v1.8+ (or v2 beta), Node 18.17+.
- A UniFi console (UDM / Cloud Key / NVR) running UniFi Protect with an **Alarm Hub**.
- An **API key**: UniFi OS → Settings → Control Plane → Integrations.

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
  from the Integration API (the Alarm Manager "Output" action isn't available for external
  automation yet), so outputs — including the Beeper — appear as status-only sensors. They
  will become switchable in a future release once UniFi exposes control.
- **Zone tamper vs. EOL trouble** is not yet distinguished. Zones report open/closed, and
  any other supervised state is surfaced as a generic *fault*. Distinguishing tamper from
  end-of-line trouble is planned for a future release.
- **SuperLink / wireless sensors** are not yet supported (they are adopted as separate
  devices); planned for a future release.

## Security notes

- The API key is stored in your Homebridge config and sent only to your console.
- UniFi consoles use self-signed certificates; the plugin trusts the configured console
  only (this is scoped to the plugin, not a global TLS override).

## License

MIT
