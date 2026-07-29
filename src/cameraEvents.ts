// Pure decoding of the realtime `/subscribe/events` feed into normalized camera detections.
// No I/O, no state — so the mapping (verified against the spike's captured event shapes) is
// unit-testable directly. The platform routes each Detection to the matching accessory.

import type { ProtectEvent } from './types';

/** 'motion' | 'ring' | a smart-detect object type ('person' | 'vehicle' | 'animal' | 'package' | …). */
export type DetectionKind = string;

export interface Detection {
  /** The camera the detection belongs to (`item.device`). */
  deviceId: string;
  kind: DetectionKind;
  /** True while the detection is ongoing; false once it has ended. */
  active: boolean;
}

/**
 * Decode one realtime event into zero or more detections.
 *
 * Observed shapes (spike): `motion` and `ring` carry a `start`, then an `update` adds an
 * `end`; `smartDetectZone`/`smartDetectLine` carry `smartDetectTypes` (person/vehicle/…).
 * So `active = (item.end == null)`: an event with an `end` marks the detection over. Events
 * we don't handle (e.g. `alarmHubEntryOpened`, which belongs to the alarm path) yield [].
 *
 * Any `smart*` type is handled, not just the `smartDetect*` ones seen in the spike. Protect keeps
 * inventing variants — `smartDetectLine`, `smartDetectLoiterZone`, and audio detection, which is
 * named `smartAudioDetect` and so did NOT match a `smartDetect` prefix. That miss silently
 * dropped every smoke and CO alarm detection, which is exactly the failure an allow-list of
 * known names invites. Matching the family and reading whatever types the payload carries means
 * a new variant arrives working rather than absent.
 *
 * An empty result is still the platform's cue to log the payload once, so a shape we genuinely
 * cannot decode leaves evidence instead of vanishing.
 */
export function decodeCameraEvent(event: ProtectEvent | undefined): Detection[] {
  const item = event?.item;
  const deviceId = item?.device;
  const type = item?.type;
  if (!deviceId || !type) {
    return [];
  }
  const active = item.end == null;
  if (type === 'motion' || type === 'ring') {
    return [{ deviceId, kind: type, active }];
  }
  if (type.startsWith('smart')) {
    return (item.smartDetectTypes ?? []).map((kind) => ({ deviceId, kind, active }));
  }
  return [];
}
