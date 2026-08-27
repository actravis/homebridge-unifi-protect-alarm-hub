/**
 * Redact a UniFi stream/talkback URL for logging. RTSPS URLs embed the stream key in the
 * path and talkback URLs are live sessions — both are credential-bearing, so accessory code
 * must run any such URL through this before it touches a log line.
 *
 * Keeps scheme + host:port (useful for debugging connectivity) and drops the path + query
 * (which carry the secret).
 */
export function redactStreamUrl(url: string | undefined): string {
  if (!url) {
    return '<none>';
  }
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '<redacted-url>';
  }
}

/**
 * Field names whose values must never reach a log line, matched case-insensitively as a
 * substring so `pin`, `userPin`, `apiKey` and `access_token` are all caught.
 *
 * `pin` is not hypothetical: alarm-hub entry events on the realtime feed carry the keypad PIN
 * used to disarm, in `item.metadata.pin`. Homebridge logs get pasted into GitHub issues.
 */
const SENSITIVE_KEY_PATTERN = /pin|code|password|passwd|secret|token|apikey|api_key|credential|auth/i;

/** How much of a diagnostic payload to keep; a stray huge object shouldn't flood the log. */
const MAX_PAYLOAD_CHARS = 500;

/**
 * Render an arbitrary API payload for a diagnostic log line, with any sensitive-looking field
 * replaced by a placeholder and the result length-capped.
 *
 * Used where we deliberately dump an unrecognised payload to learn its shape. Redaction is by
 * key name rather than by value, so a field we have never seen before is still caught the first
 * time it appears — the alternative (an allow-list of safe keys) would suppress exactly the
 * novel fields these log lines exist to reveal.
 */
export function redactPayload(value: unknown, maxChars = MAX_PAYLOAD_CHARS): string {
  const seen = new WeakSet<object>();
  const scrub = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (seen.has(input)) {
      return '<circular>';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map(scrub);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '<redacted>' : scrub(item);
    }
    return out;
  };
  let text: string;
  try {
    text = JSON.stringify(scrub(value)) ?? String(value);
  } catch {
    return '<unserialisable>';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Node dual-stack sockets report IPv4 peers in IPv4-mapped IPv6 form (`::ffff:a.b.c.d`);
 * hap-nodejs and ffmpeg both want the plain dotted IPv4. Strip the prefix when present.
 *
 * Lives here rather than in a streaming module because both the delegate and the audio relay need
 * it, and importing between those two created a circular dependency.
 */
export function stripV4Mapped(addr: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)?.[1] ?? addr;
}

/**
 * True when an API response really is a list of devices we can reconcile against.
 *
 * Every device list is typed `Device[]`, but that is a promise about the API, not a fact about the
 * payload. `request()` deliberately returns `undefined` for an empty 200 body, and a firmware change
 * or an intercepting proxy can answer with a JSON object instead of an array — measured: five such
 * shapes each turned `chimes.map(...)` into a TypeError that reached an unhandled rejection and took
 * the whole Homebridge process down, with nothing about chimes in the log.
 *
 * A device needs a string `id` because that IS its identity: every accessory UUID is derived from it,
 * so an entry without one cannot be reconciled, only guessed at.
 *
 * CRITICAL — callers must treat `false` as a FAILED READ, not as "no devices". Coercing a malformed
 * payload to `[]` would be worse than the crash it prevents: every reconciler prunes against the list
 * it just read, so an empty list means "every device was removed" and would unregister the user's
 * accessories, destroying their room assignments and any automation referencing them. A transient bad
 * response must never be able to do that. Skip the pass, keep what exists, and report it.
 */
export function isDeviceList(value: unknown): value is { id: string }[] {
  return Array.isArray(value)
    && value.every((d) => typeof d === 'object' && d !== null
      && typeof (d as { id?: unknown }).id === 'string' && (d as { id: string }).id !== '');
}
