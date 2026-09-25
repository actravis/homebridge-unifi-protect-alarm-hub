/**
 * How this client decides to trust the console's TLS certificate.
 *
 * Split out from the client itself and kept pure so the decision can be unit-tested exhaustively:
 * every combination here is a security posture, and the one that matters most — "the user asked for
 * verification and did not get it" — is invisible at runtime until someone is already exposed.
 * Building a real connector to find out what it decided is not a test.
 */

/**
 * Normalise a user-supplied SHA-256 certificate fingerprint to bare lowercase hex.
 *
 * Blank/absent means "not pinning" and returns undefined. Anything else MUST be a valid
 * fingerprint: a value that merely *looks* wrong (truncated paste, base64, a string of colons)
 * used to strip down to an empty string and silently fall through to the unpinned path — so the
 * user believed pinning was on while the client accepted any certificate. Fail closed instead.
 */
export function normalizeFingerprint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const hex = value.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      'certificateSha256 is not a valid SHA-256 fingerprint (expected 64 hex characters, ' +
        'optionally colon-separated). Refusing to start rather than silently skip pinning.',
    );
  }
  return hex;
}

/** What the user asked for, before any of it is turned into connector options. */
export interface TlsPolicyInput {
  /** Skip chain validation entirely. Only honoured when nothing stronger is configured. */
  trustSelfSignedCert?: boolean;
  /** SHA-256 fingerprint to pin, in either notation. */
  certificateSha256?: string;
  /** A CA certificate in PEM form, already loaded from wherever the user put it. */
  caCertificate?: string;
}

/** The resolved posture, in the shape undici's `buildConnector` wants. */
export interface TlsPolicy {
  /** Whether Node validates the chain (and, with it, the hostname against the cert's SANs). */
  rejectUnauthorized: boolean;
  /** A CA to validate against, when the user supplied one. */
  ca?: string;
  /** Fingerprint the connector must check on every handshake, when pinning. */
  pinnedFingerprint?: string;
  /**
   * TLS session cache size. Forced to 0 whenever pinning, because a resumed session makes
   * `getPeerCertificate()` return an empty object — the fingerprint check would then pass only on
   * the first, full handshake and fail on every reused connection. (Shipped as a real bug in 0.1.4.)
   */
  maxCachedSessions?: number;
  /** One-line summary of the resulting posture, for the startup log. */
  description: string;
}

/**
 * Turn the user's TLS settings into a single posture.
 *
 * The three mechanisms compose rather than compete, strongest first:
 *
 * - **A CA turns chain validation ON.** That is the whole point of supplying one, so it overrides
 *   `trustSelfSignedCert`: a user who provides a CA and also left the trust-anything box ticked
 *   asked for two contradictory things, and honouring the weaker one silently would be exactly the
 *   "believed they were protected" failure this module exists to prevent.
 * - **A pin is checked whether or not a CA is present.** With both, the connection must chain to
 *   the CA *and* present the pinned certificate — strictly stronger than either alone.
 * - **A pin WITHOUT a CA cannot validate a chain**, because a self-signed console certificate has
 *   none to validate. The fingerprint is the entire proof of identity in that case.
 *
 * With none of the three, `trustSelfSignedCert` decides, and it fails closed: only an explicit
 * `true` disables validation, so a missing or malformed value verifies rather than trusts.
 */
export function resolveTlsPolicy(input: TlsPolicyInput): TlsPolicy {
  const pinnedFingerprint = normalizeFingerprint(input.certificateSha256);
  const ca = input.caCertificate?.trim() ? input.caCertificate : undefined;

  // Anything non-empty here must already be PEM — `loadCaCertificate` is what turns a path into one.
  // Without this check a path handed straight to the client becomes undici's `ca`, every handshake
  // fails, and the only symptom is "fetch failed": no mention of certificates, nothing naming the
  // setting at fault. Caught by a live handshake test; the unit tests could not see it, because they
  // only ever fed this function what the platform had already loaded.
  if (ca && !ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      'caCertificate must be PEM text (it does not contain a BEGIN CERTIFICATE header). If you ' +
        'meant to give a path, load it with loadCaCertificate() first — the platform does this for ' +
        'values coming from config.',
    );
  }

  if (ca) {
    return {
      rejectUnauthorized: true,
      ca,
      pinnedFingerprint,
      ...(pinnedFingerprint ? { maxCachedSessions: 0 } : {}),
      description: pinnedFingerprint
        ? 'verifying the console certificate against your CA, and pinning its fingerprint'
        : 'verifying the console certificate against your CA',
    };
  }
  if (pinnedFingerprint) {
    return {
      rejectUnauthorized: false,
      pinnedFingerprint,
      maxCachedSessions: 0,
      description: 'pinning the console certificate by fingerprint (no chain validation)',
    };
  }
  return {
    rejectUnauthorized: input.trustSelfSignedCert !== true,
    description:
      input.trustSelfSignedCert === true
        ? 'trusting the console\'s certificate without verifying it — set "caCertificate" or ' +
          '"certificateSha256" to fix that'
        : 'verifying the console certificate against the system trust store',
  };
}

/** Reads a file, injected so the loader can be tested without touching a real filesystem. */
export type ReadTextFile = (path: string) => string;

/**
 * Resolve the `caCertificate` setting to PEM text.
 *
 * Accepts either the PEM itself or a path to it. A path is what almost everyone has — a CA
 * certificate is a file on disk, and pasting 4096-bit RSA into a settings form is miserable — but
 * PEM-in-config is the only option in a container where the file is not mounted, so both work.
 * They are told apart by the PEM header, which a filesystem path cannot contain.
 *
 * Throws on anything it cannot turn into a usable CA. Returning undefined would fall back to the
 * unverified path while the user believed a CA was in force, which is the failure this whole module
 * is written to avoid — the same reason {@link normalizeFingerprint} throws on a malformed pin.
 */
export function loadCaCertificate(value: string | undefined, readFile: ReadTextFile): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.includes('-----BEGIN CERTIFICATE-----')) {
    // Returned trimmed. A settings form adds surrounding whitespace freely, and OpenSSL's PEM
    // reader does not require a trailing newline; trimming only touches the ends, so a
    // concatenated bundle keeps the separators between its certificates.
    return raw;
  }
  let contents: string;
  try {
    contents = readFile(raw);
  } catch (err) {
    throw new Error(
      `caCertificate could not be read from "${raw}": ${(err as Error).message}. Give the path to ` +
        'a PEM certificate readable by the Homebridge user, or paste the PEM itself. Refusing to ' +
        'start rather than run without the verification you asked for.',
    );
  }
  if (!contents.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      `caCertificate at "${raw}" is not a PEM certificate (no BEGIN CERTIFICATE header). A DER/.cer ` +
        'file needs converting first: openssl x509 -inform der -in ca.cer -out ca.pem',
    );
  }
  return contents;
}
