// The secret scanner's rules. This is the check that stands between a live credential and a public
// repo, so its own logic needs covering — and it has been wrong twice: once missing untracked files
// (the very leak it was written for), once admitting a low-entropy value whose hash was then
// brute-forceable in seconds.
//
// The module guards its CLI behind an invoked-directly check, so importing it here neither scans the
// repo nor exits the test process.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MIN_ENTROPY_BITS, entropyBits, isPlaceholder, parseDenylist, scanContent, sha,
} from '../scripts/scan-secrets.mjs';

const at = (findings, i = 0) => findings[i] ?? {};

// Fixtures for the pattern layer are ASSEMBLED AT RUNTIME rather than written as literals.
// A literal that matches this scanner's pattern also matches GitHub's own secret detectors, and
// push protection rejects the commit — twice, on a Stripe-shaped and then a Slack-shaped string.
// Joining the pieces keeps the shape under test while leaving no matchable literal in the source.
// (None of these are real credentials; the payloads say so.)
const NOT_REAL = 'EXAMPLENOTAREALVALUE00';
const fixture = {
  githubToken: ['ghp', NOT_REAL].join('_'),
  slackToken: ['xoxb', '000000000000', NOT_REAL].join('-'),
  awsKeyId: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJub3RlIjoiTk9UX1JFQUwifQ', `${NOT_REAL}_SIG`].join('.'),
  bearer: `Bearer ${NOT_REAL}${NOT_REAL}`,
};

// --- entropy guard -----------------------------------------------------------
// .secret-hashes is committed, so a weak value is disclosed by its own hash.

test('a MAC address is below the threshold — its hash is brute-forceable', () => {
  assert.ok(entropyBits('D8B3707DF905') < MIN_ENTROPY_BITS);
});

test('short identifiers people might try to add are all refused', () => {
  for (const weak of ['192.168.1.197', '1234', '7004', 'AA:BB:CC:DD:EE:FF', 'admin']) {
    assert.ok(entropyBits(weak) < MIN_ENTROPY_BITS, `${weak} must be refused`);
  }
});

test('a UUID, a 24-hex device id and a 32-char key all clear the threshold', () => {
  assert.ok(entropyBits('3f7a91c2-5d84-4b16-9e03-7c62a8fd1e50') >= MIN_ENTROPY_BITS);
  assert.ok(entropyBits('5a1c93f70d284b16e9037c62') >= MIN_ENTROPY_BITS);
  assert.ok(entropyBits('aB3dEf7hJ2kLm9nPq4rStU6vWx8yZ0aC') >= MIN_ENTROPY_BITS);
});

// A long string of one repeated character has length but no secrecy.
test('entropy accounts for alphabet size, not just length', () => {
  assert.ok(entropyBits('a'.repeat(64)) < entropyBits('aB3dEf7hJ2kLm9nPq4rStU6vWx8yZ0aC'));
});

// --- placeholders ------------------------------------------------------------
// A check that cries wolf on documentation is a check people learn to ignore.

test('documentation placeholders are not treated as secrets', () => {
  for (const v of ['your-api-key', 'YOUR_TOKEN_HERE', 'example-secret-value', 'changeme',
    'xxxxxxxxxxxxxxxxxxxxxxxx', '<your-key>', 'redacted', 'REPLACE_ME_WITH_A_KEY']) {
    assert.ok(isPlaceholder(v), `${v} should read as a placeholder`);
  }
});

test('an obviously-fake test constant is not treated as a secret', () => {
  assert.ok(isPlaceholder('11111111-2222-3333-4444-555555555555'));
});

// Fixtures deliberately avoid real vendors' live-key prefixes. An earlier version used a
// Stripe-shaped `sk_live_…` string and GitHub Push Protection rejected the push — correctly: a
// fabricated value that imitates a real credential format is still a bad fixture.
test('a real-looking value is not excused as a placeholder', () => {
  assert.ok(!isPlaceholder('9f2Ka83jdKQ0zzXpQm71vB4tZx'));
  assert.ok(!isPlaceholder('3f7a91c2-5d84-4b16-9e03-7c62a8fd1e50'));
});

// --- pattern layer -----------------------------------------------------------

const cases = [
  ['a PEM private key', 'x.pem', '-----BEGIN RSA PRIVATE KEY-----', /PEM private key/],
  ['a GitHub token', 'a.js', `const t = "${fixture.githubToken}";`, /GitHub token/],
  ['an AWS key id', 'a.js', `id: "${fixture.awsKeyId}",`, /AWS access key id/],
  ['a Slack token', 'a.js', fixture.slackToken, /Slack token/],
  ['a bearer literal', 'a.js', `Authorization: ${fixture.bearer}`, /Bearer/],
  ['an api key assignment', 'a.js', 'const c = { apiKey: "9f2Ka83jdKQ0zzXpQm71vB4tZ" };', /secret-looking/],
  ['a password assignment', 'a.js', 'password = "Zq83Kd0aLm92PqRs74TuVw56Xy"', /secret-looking/],
];
for (const [label, file, line, expect] of cases) {
  test(`the pattern layer catches ${label}`, () => {
    const f = scanContent(file, line);
    assert.equal(f.length, 1, `expected one finding, got ${JSON.stringify(f)}`);
    assert.match(at(f).what, expect);
    assert.equal(at(f).line, 1);
  });
}

test('a JWT is caught', () => {
  assert.match(at(scanContent('a.js', `token: "${fixture.jwt}"`)).what, /JWT/);
});

test('ordinary code produces no findings', () => {
  const src = 'const port = 7004;\nfunction ring() { return fetch(url); }\n// password handling below\n';
  assert.deepEqual(scanContent('a.js', src), []);
});

test('a placeholder assignment produces no finding', () => {
  assert.deepEqual(scanContent('README.md', 'apiKey: "your-api-key-here-goes"'), []);
});

test('the line number reported is 1-indexed and correct', () => {
  const src = 'line one\nline two\nconst k = { token: "Zq83Kd0aLm92PqRs74TuVw56Xy" };\n';
  assert.equal(at(scanContent('a.js', src)).line, 3);
});

// --- denylist layer ----------------------------------------------------------

// A synthetic UUID: high-entropy so it is not dismissed as a placeholder, and deliberately NOT a
// real Trigger ID. Using a real one here is exactly the leak this scanner exists to catch — and it
// caught precisely that mistake in this file.
const SECRET = '3f7a91c2-5d84-4b16-9e03-7c62a8fd1e50';
const denylist = () => new Map([[sha(SECRET), 'Alarm Manager Trigger ID']]);

// The layer that matters most: a live credential that looks like any other UUID.
test('a known secret is caught even though no pattern matches it', () => {
  const f = scanContent('test/x.test.mjs', `const TRIGGER = '${SECRET}';`, denylist());
  assert.equal(f.length, 1);
  assert.match(at(f).what, /KNOWN SECRET \(Alarm Manager Trigger ID\)/);
});

test('the finding truncates the value rather than reprinting it', () => {
  const f = scanContent('a.js', SECRET, denylist());
  assert.ok(!at(f).detail.includes(SECRET), 'a report must not leak the secret it found');
  assert.match(at(f).detail, /^3f7a91c2…$/);
});

test('a different value with no denylist entry is clean', () => {
  assert.deepEqual(scanContent('a.js', "const t = '11111111-2222-3333-4444-555555555555';", denylist()), []);
});

// The scanner names the patterns it hunts, so it is exempt from the pattern layer — but never from
// the denylist: a real value must not live here either.
test('the scanner exempts itself from patterns but not from the denylist', () => {
  assert.deepEqual(scanContent('scan-secrets.mjs', 'const re = /ghp_[A-Za-z0-9]{16,}/;'), []);
  const f = scanContent('scan-secrets.mjs', `const x = '${SECRET}';`, denylist());
  assert.equal(f.length, 1, 'a known secret must still be caught in the scanner itself');
});

test('a line marked allow-secret is skipped', () => {
  assert.deepEqual(scanContent('a.js', `const t = "${fixture.githubToken}"; // allow-secret`), []);
});

// --- file-level rules --------------------------------------------------------

test('a tracked .env file is a finding on its own', () => {
  const f = scanContent('.env', 'NOTHING=1');
  assert.equal(f.length, 1);
  assert.match(at(f).what, /tracked \.env file/);
});

test('.env.example is allowed', () => {
  assert.deepEqual(scanContent('.env.example', 'API_KEY='), []);
});

test('binary content is skipped rather than scanned as text', () => {
  assert.deepEqual(scanContent('a.bin', `\0\0${fixture.githubToken}`), []);
});

test('empty content is not a finding', () => {
  assert.deepEqual(scanContent('a.js', ''), []);
});

// --- denylist parsing --------------------------------------------------------

test('comments and blank lines are ignored, labels are kept', () => {
  const map = parseDenylist(`# a comment\n\n${'a'.repeat(64)}  the label\n`);
  assert.equal(map.size, 1);
  assert.equal(map.get('a'.repeat(64)), 'the label');
});

test('a malformed line is ignored rather than fatal', () => {
  const map = parseDenylist(`not-a-hash  x\nzz  y\n${'b'.repeat(64)}  ok\n`);
  assert.deepEqual([...map.values()], ['ok']);
});

test('a hash with no label still gets one', () => {
  assert.equal(parseDenylist('c'.repeat(64)).get('c'.repeat(64)), 'known secret');
});

// --- CLI contract ------------------------------------------------------------
// The exit code is what makes CI fail, so assert on it directly.

// Pointed at a temp denylist: if the guard ever breaks, the write must not land in the committed
// file. It did exactly that once, during mutation testing, putting a real MAC hash back in the repo.
const tempDenylist = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scan-secrets-')), 'hashes');
  writeFileSync(file, '');
  return file;
};

test('--add refuses a low-entropy value with a non-zero exit', () => {
  const file = tempDenylist();
  assert.throws(
    () => execFileSync('node', ['scripts/scan-secrets.mjs', '--add', 'a MAC'], {
      input: 'D8B3707DF905', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SECRET_HASHES_FILE: file },
    }),
    (err) => {
      assert.equal(err.status, 2);
      assert.match(err.stderr, /brute-forceable/);
      return true;
    },
  );
  assert.equal(readFileSync(file, 'utf8'), '', 'a refused value must not be written anywhere');
});

test('--add accepts a high-entropy value and stores only its hash', () => {
  const file = tempDenylist();
  const value = '3f7a91c2-5d84-4b16-9e03-7c62a8fd1e50';
  execFileSync('node', ['scripts/scan-secrets.mjs', '--add', 'a probe'], {
    input: value, encoding: 'utf8', env: { ...process.env, SECRET_HASHES_FILE: file },
  });
  const written = readFileSync(file, 'utf8');
  assert.match(written, new RegExp(`^${sha(value)}\\s+a probe$`, 'm'));
  assert.ok(!written.includes(value), 'the value itself must never be stored');
});

test('a clean repo scan exits zero', () => {
  const out = execFileSync('node', ['scripts/scan-secrets.mjs'], { encoding: 'utf8' });
  assert.match(out, /No secrets found/);
});

// This file is pattern-exempt (it is full of secret-shaped fixtures), which must not become a
// blind spot for real values.
test('this test file is pattern-exempt but still denylist-checked', () => {
  assert.deepEqual(scanContent('scanSecrets.test.mjs', `const t = "${fixture.githubToken}";`), []);
  const f = scanContent('scanSecrets.test.mjs', `const x = '${SECRET}';`, denylist());
  assert.equal(f.length, 1, 'a real secret must still be caught in the scanner test file');
});
