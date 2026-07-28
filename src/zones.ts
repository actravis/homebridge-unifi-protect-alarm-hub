// Pure mapping from UniFi alarm-hub input types to HomeKit sensor kinds.
// Kept dependency-free (no Homebridge imports) so it can be unit-tested directly.

/** The HomeKit sensor services we expose an alarm-hub zone as. */
export type ZoneKind = 'contact' | 'motion';

/** Input types we recognise and map deterministically. Anything else is treated as unknown. */
const KNOWN_ZONE_TYPES = new Set(['ENTRY', 'GLASS_BREAK', 'MOTION']);

export function isKnownZoneType(inputType: string): boolean {
  return KNOWN_ZONE_TYPES.has(inputType);
}

/**
 * Map a UniFi input type to a HomeKit sensor kind.
 *
 * - `ENTRY` (door/window) → contact
 * - `MOTION` → motion
 * - `GLASS_BREAK` → user's choice (HomeKit has no glass-break service); defaults to motion
 * - anything else → contact, a safe visible fallback. Callers can use `isKnownZoneType`
 *   to log a one-time warning for unrecognised types.
 */
export function zoneKindFor(inputType: string, glassBreakAs?: 'contact' | 'motion'): ZoneKind {
  switch (inputType) {
    case 'MOTION':
      return 'motion';
    case 'GLASS_BREAK':
      return glassBreakAs === 'contact' ? 'contact' : 'motion';
    case 'ENTRY':
      return 'contact';
    default:
      return 'contact';
  }
}
