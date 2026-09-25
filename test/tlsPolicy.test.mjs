import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCaCertificate, normalizeFingerprint, resolveTlsPolicy } from '../dist/client/tlsPolicy.js';

const PIN = 'a'.repeat(64);
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

// --- resolveTlsPolicy --------------------------------------------------------
//
// Every case here is a security posture. The one that has to hold above all others is that a
// setting asking for MORE verification is never quietly resolved into less.

test('with nothing configured, the chain is verified against the system store', () => {
  const policy = resolveTlsPolicy({});
  assert.equal(policy.rejectUnauthorized, true);
  assert.equal(policy.ca, undefined);
  assert.equal(policy.pinnedFingerprint, undefined);
});

test('only an explicit trustSelfSignedCert:true disables verification', () => {
  assert.equal(resolveTlsPolicy({ trustSelfSignedCert: true }).rejectUnauthorized, false);
  // Anything else — absent, false, or a stray non-boolean from hand-edited config — fails closed.
  assert.equal(resolveTlsPolicy({ trustSelfSignedCert: false }).rejectUnauthorized, true);
  assert.equal(resolveTlsPolicy({}).rejectUnauthorized, true);
  assert.equal(resolveTlsPolicy({ trustSelfSignedCert: 'yes' }).rejectUnauthorized, true);
});

test('a pin alone cannot validate a chain, so it verifies the fingerprint instead', () => {
  const policy = resolveTlsPolicy({ certificateSha256: PIN });
  assert.equal(policy.pinnedFingerprint, PIN);
  assert.equal(policy.rejectUnauthorized, false, 'a self-signed console certificate has no chain');
  // Session resumption makes getPeerCertificate() return {}, which would fail the fingerprint check
  // on every reused connection — the bug shipped in 0.1.4.
  assert.equal(policy.maxCachedSessions, 0);
});

test('a CA turns on chain verification', () => {
  const policy = resolveTlsPolicy({ caCertificate: PEM });
  assert.equal(policy.rejectUnauthorized, true);
  assert.equal(policy.ca, PEM);
  assert.equal(policy.pinnedFingerprint, undefined);
  // Nothing reads the peer certificate here, so resumption is free to do its job.
  assert.equal(policy.maxCachedSessions, undefined);
});

// The whole point of supplying a CA is to be verified against it. A user who provides one and also
// leaves the trust-anything box ticked has asked for two contradictory things, and silently
// honouring the weaker one is precisely the "believed they were protected" failure being guarded.
test('a CA overrides trustSelfSignedCert rather than being overridden by it', () => {
  const policy = resolveTlsPolicy({ caCertificate: PEM, trustSelfSignedCert: true });
  assert.equal(policy.rejectUnauthorized, true);
  assert.equal(policy.ca, PEM);
});

test('a CA and a pin compose — both are enforced', () => {
  const policy = resolveTlsPolicy({ caCertificate: PEM, certificateSha256: PIN });
  assert.equal(policy.rejectUnauthorized, true, 'the chain must still validate');
  assert.equal(policy.ca, PEM);
  assert.equal(policy.pinnedFingerprint, PIN, 'and the certificate must still be the pinned one');
  assert.equal(policy.maxCachedSessions, 0, 'reading the peer certificate needs a full handshake');
});

test('a blank CA is treated as absent, not as an empty trust store', () => {
  // An empty `ca` would reject every certificate on earth, so this must fall through to the
  // ordinary path rather than producing a client that can never connect.
  const policy = resolveTlsPolicy({ caCertificate: '   ' });
  assert.equal(policy.ca, undefined);
  assert.equal(policy.rejectUnauthorized, true);
});

// Found by a live handshake, not by unit tests: they only ever fed this function values the
// platform had already loaded, so a raw path reached undici as a CA and every request died as an
// opaque "fetch failed" — nothing about certificates, nothing naming the setting.
test('a CA value that is not PEM is refused with a message that says so', () => {
  assert.throws(() => resolveTlsPolicy({ caCertificate: '/path/to/ca.crt' }), /must be PEM text/);
  assert.throws(() => resolveTlsPolicy({ caCertificate: '/path/to/ca.crt' }), /loadCaCertificate/);
});

test('a malformed pin throws rather than silently skipping pinning', () => {
  assert.throws(() => resolveTlsPolicy({ certificateSha256: 'not-a-fingerprint' }), /valid SHA-256/);
});

test('the policy describes itself for the log, distinguishably', () => {
  const descriptions = [
    resolveTlsPolicy({}).description,
    resolveTlsPolicy({ trustSelfSignedCert: true }).description,
    resolveTlsPolicy({ certificateSha256: PIN }).description,
    resolveTlsPolicy({ caCertificate: PEM }).description,
    resolveTlsPolicy({ caCertificate: PEM, certificateSha256: PIN }).description,
  ];
  // A log line that reads the same for a verified and an unverified connection would be worse than
  // none: it is the only signal the user gets about which posture they actually ended up in.
  assert.equal(new Set(descriptions).size, descriptions.length, 'each posture reads differently');
  assert.match(resolveTlsPolicy({ trustSelfSignedCert: true }).description, /without verifying/);
});

// --- normalizeFingerprint ----------------------------------------------------

test('normalizeFingerprint still accepts both notations after the move', () => {
  const colons = PIN.replace(/(..)(?=.)/g, '$1:');
  assert.equal(normalizeFingerprint(colons), PIN);
  assert.equal(normalizeFingerprint(undefined), undefined);
});

// --- loadCaCertificate -------------------------------------------------------

test('loadCaCertificate passes PEM through without touching the filesystem', () => {
  const read = () => assert.fail('must not read a file when given PEM directly');
  // Trimmed, because a settings form adds whitespace around a pasted value and PEM does not need a
  // trailing newline. Only the ends are touched, so a concatenated bundle keeps its separators.
  assert.equal(loadCaCertificate(`\n  ${PEM}  \n`, read), PEM.trim());
});

test('loadCaCertificate reads a path', () => {
  const seen = [];
  const read = (path) => {
    seen.push(path);
    return PEM;
  };
  assert.equal(loadCaCertificate('  /etc/ssl/homeCA.crt  ', read), PEM);
  assert.deepEqual(seen, ['/etc/ssl/homeCA.crt'], 'the path is trimmed before use');
});

test('an absent or blank setting means "no CA"', () => {
  const read = () => assert.fail('must not read a file');
  assert.equal(loadCaCertificate(undefined, read), undefined);
  assert.equal(loadCaCertificate('  ', read), undefined);
});

// Returning undefined here would fall back to the unverified path while the user believed a CA was
// in force — the same failure normalizeFingerprint throws to prevent.
test('an unreadable CA file throws rather than falling back to no verification', () => {
  const read = () => {
    throw new Error('ENOENT: no such file or directory');
  };
  assert.throws(() => loadCaCertificate('/nope/ca.crt', read), /could not be read.*ENOENT/s);
});

test('a file that is not PEM is rejected, with the conversion command', () => {
  const read = () => '\x30\x82\x03 binary DER contents';
  assert.throws(() => loadCaCertificate('/etc/ssl/ca.der', read), /not a PEM certificate/);
  assert.throws(() => loadCaCertificate('/etc/ssl/ca.der', read), /openssl x509 -inform der/);
});
