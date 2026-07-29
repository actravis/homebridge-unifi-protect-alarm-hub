// Pure classification of Protect detection types into the HomeKit service that represents them.
// No HAP, no I/O — the accessory layer asks this what to build, and the platform asks it where to
// route a decoded detection.
//
// Object detections (person/vehicle/animal/package) have no native HomeKit equivalent, so they
// become motion sensors. Audio detections mostly DO have native equivalents, and using them
// matters: a HomeKit SmokeSensor shows the right icon, reads correctly in the Home app, and — the
// real point — is a first-class trigger that automations and Home hub notifications understand.
// Reporting a smoke alarm as "motion detected" throws all of that away.

/** The HomeKit service a detection should drive. */
export type SensorKind = 'motion' | 'smoke' | 'carbonMonoxide';

/**
 * Protect audio-detection type → HomeKit service.
 *
 * Values are the ones the console reports in `featureFlags.smartDetectAudioTypes` and
 * `smartDetectSettings.audioTypes`. `smoke_cmonx` is real and undocumented: it appears in the
 * *enabled* list on a camera configured for combined smoke/CO alarm detection even though it is
 * absent from the supported list, so it is treated as both.
 *
 * A Map, not an object literal, because the KEY is a string straight from the console. A plain
 * object would resolve `constructor` or `toString` off Object.prototype and hand back a function
 * where a SensorKind[] is expected — `alarmSensorKinds` iterates that result, so a single zone or
 * detection named `constructor` would throw out of camera discovery and leave the user with no
 * cameras at all. Maps have no such inherited keys.
 */
const AUDIO_KINDS = new Map<string, SensorKind[]>([
  ['alrmSmoke', ['smoke']],
  ['alrmCmonx', ['carbonMonoxide']],
  ['smoke_cmonx', ['smoke', 'carbonMonoxide']],
  // Supported by the hardware but with no native HomeKit service; a motion sensor is the honest
  // fallback — it fires, and the accessory name says what it means.
  ['alrmBabyCry', ['motion']],
  ['alrmSpeak', ['motion']],
]);

/** True if this is an audio detection rather than an object detection. */
export function isAudioDetection(type: string): boolean {
  return AUDIO_KINDS.has(type) || type.startsWith('alrm');
}

/**
 * The HomeKit services a detection type should drive. One type can map to several: a combined
 * smoke/CO alarm is a single Protect detection but two distinct HomeKit sensors, and a user
 * automating on CO must not have it silently folded into "smoke".
 */
export function sensorKindsFor(type: string): SensorKind[] {
  const known = AUDIO_KINDS.get(type);
  if (known) {
    return known;
  }
  // An unrecognised `alrm*` type is still an alarm of some sort — expose it rather than drop it.
  // Everything else (object detections, and anything new Protect invents) is a motion sensor.
  return ['motion'];
}

/** The kinds that have a real HomeKit alarm service, as opposed to the motion fallback. */
const NATIVE_ALARM_KINDS: SensorKind[] = ['smoke', 'carbonMonoxide'];

export function isAlarmKind(kind: SensorKind): boolean {
  return NATIVE_ALARM_KINDS.includes(kind);
}

/**
 * Which alarm sensors a camera warrants, given the audio types Protect has ENABLED on it.
 *
 * Keyed by HomeKit service, not by Protect type, and deliberately so: a camera can have both
 * `alrmSmoke` and `smoke_cmonx` enabled at once (observed live), and both mean "smoke". One
 * SmokeSensor fed by either is what a user wants — two sensors called the same thing is not.
 *
 * Types that only map to the motion fallback (baby cry, speaking) are excluded. They are out of
 * scope for now: nothing enables them by default, and keying by service would collapse them into
 * one indistinguishable sensor. They fall through to the unhandled-detection log instead.
 */
export function alarmSensorKinds(enabledAudioTypes: string[] | undefined): SensorKind[] {
  const kinds = new Set<SensorKind>();
  for (const type of enabledAudioTypes ?? []) {
    for (const kind of sensorKindsFor(type)) {
      if (isAlarmKind(kind)) {
        kinds.add(kind);
      }
    }
  }
  // Stable order so accessory creation and pruning agree run to run.
  return NATIVE_ALARM_KINDS.filter((k) => kinds.has(k));
}

/** Label for an alarm sensor accessory, e.g. "Front Door Smoke Alarm". */
export function alarmKindLabel(kind: SensorKind): string {
  return kind === 'smoke' ? 'Smoke Alarm' : kind === 'carbonMonoxide' ? 'CO Alarm' : 'Alarm';
}

/** Human-readable suffix for the accessory name. A Map for the same reason as AUDIO_KINDS: a
 *  plain object would return Object.prototype.toString's source as an accessory NAME. */
const LABELS = new Map<string, string>([
  ['alrmSmoke', 'Smoke Alarm'],
  ['alrmCmonx', 'CO Alarm'],
  ['smoke_cmonx', 'Smoke/CO Alarm'],
  ['alrmBabyCry', 'Baby Cry'],
  ['alrmSpeak', 'Speaking'],
]);

/**
 * Label for a detection type. Object types are simply capitalised ("person" → "Person"); audio
 * types get a spelled-out name, because "AlrmCmonx" is not something to show a user.
 */
export function detectionLabel(type: string, kind?: SensorKind): string {
  const explicit = LABELS.get(type);
  if (explicit) {
    // A combined type drives two sensors, so each needs its own distinguishable label.
    if (type === 'smoke_cmonx' && kind) {
      return kind === 'smoke' ? 'Smoke Alarm' : 'CO Alarm';
    }
    return explicit;
  }
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}
