#!/usr/bin/env node
// Fails if a secret looks like it is about to be committed. Runs in CI and locally (same command,
// so the two cannot drift) and is dependency-free.
//
// Two layers, because neither alone is enough:
//
//   1. PATTERNS — shapes that are secret by construction (PEM blocks, `ghp_…`, `AKIA…`, a JWT), plus
//      a high-entropy value assigned to a secret-ish name. Catches unknown secrets, but cannot flag
//      a value that looks ordinary.
//   2. HASH DENYLIST — SHA-256 of known-real values from this environment, in `.secret-hashes`.
//      Hashes are safe to commit; the secrets are not. This is the layer that catches a real
//      credential that looks like any other UUID — the actual incident that prompted this script:
//      a live Alarm Manager Trigger ID used as a test constant, invisible to any pattern rule.
//
// Add a value to the denylist without it ever reaching argv or shell history (see rule: secrets
// never appear in CLI arguments):
//
//   printf %s 'the-secret' | node scripts/scan-secrets.mjs --add 'what it is'
//
// Usage: node scripts/scan-secrets.mjs [--staged]
//   default    scan every tracked file
//   --staged   scan only staged content (for a pre-commit hook)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DENYLIST_FILE = '.secret-hashes';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Shapes that are secret by construction. */
const PATTERNS = [
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Authorization: Bearer literal', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  // A long opaque value assigned to a secret-ish name. Deliberately narrow: the value must be
  // quoted, long, and free of spaces, or every prose mention of "password" would trip it.
  {
    name: 'secret-looking assignment',
    re: /["']?(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9/+_=-]{24,})["']/i,
    capture: 1,
  },
];

/**
 * Obvious non-secrets. Without this the script cries wolf on documentation and schema placeholders,
 * and a check people learn to ignore protects nothing.
 */
const PLACEHOLDER = /^(?:x+|0+|1+|your|my|the)?[-_]?(?:your|example|sample|placeholder|redacted|dummy|fake|test|changeme|todo|xxx+|abc123|api[-_]?key|secret|token|password|<[^>]*>)/i;
const isPlaceholder = (v) =>
  PLACEHOLDER.test(v) ||
  /^(?:1234|abcd)/i.test(v) ||
  /^(1)\1+$/.test(v.replace(/-/g, '')) ||
  new Set(v.replace(/-/g, '')).size <= 2; // e.g. 11111111-2222-... style fakes

/** Tokens worth hashing against the denylist: UUIDs and long opaque runs. */
const CANDIDATE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z0-9]{16,}\b/g;

function loadDenylist() {
  if (!existsSync(DENYLIST_FILE)) {
    return new Map();
  }
  const entries = new Map();
  for (const line of readFileSync(DENYLIST_FILE, 'utf8').split('\n')) {
    const text = line.replace(/#.*$/, '').trim();
    if (!text) {
      continue;
    }
    const [hash, ...label] = text.split(/\s+/);
    if (/^[0-9a-f]{64}$/.test(hash)) {
      entries.set(hash, label.join(' ') || 'known secret');
    }
  }
  return entries;
}

/**
 * Rough entropy of a value, in bits: length x log2(observed alphabet size).
 *
 * The denylist is published (that is the point — hashes are safe to commit), so a low-entropy value
 * must never go in it: its hash is a brute-force target, not a protection. A MAC address is the
 * cautionary case — 48 bits, and the first 24 are a published vendor OUI, so the remaining space is
 * ~16.7M candidates. Measured: the MAC was recovered from its SHA-256 in 5.3 seconds.
 */
function entropyBits(value) {
  const alphabet = new Set(value).size;
  return value.length * Math.log2(Math.max(alphabet, 2));
}

/** Below this, hashing does not hide the value from anyone who can read the file. */
const MIN_ENTROPY_BITS = 64;

function addToDenylist(label) {
  const value = readFileSync(0, 'utf8').trim(); // stdin: never argv
  if (!value) {
    console.error('Nothing on stdin. Usage: printf %s \'secret\' | node scripts/scan-secrets.mjs --add \'label\'');
    process.exit(2);
  }
  const bits = entropyBits(value);
  if (bits < MIN_ENTROPY_BITS) {
    console.error(
      `Refusing to add: ~${Math.round(bits)} bits of entropy is brute-forceable from the hash ` +
        `(need ${MIN_ENTROPY_BITS}+).\nThe denylist is committed, so a weak value would be disclosed ` +
        'by its own hash. Keep short identifiers (MACs, IPs, PINs) out of the repo by other means.',
    );
    process.exit(2);
  }
  appendFileSync(DENYLIST_FILE, `${sha(value)}  ${label || 'secret'}\n`);
  console.log(`Added a hash for ${label || 'secret'} (${value.length} chars). The value itself was not stored.`);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function filesToScan(staged) {
  // `--others --exclude-standard` matters: a brand-new file is untracked until `git add`, and a
  // freshly-pasted credential lives in exactly such a file. Scanning only `ls-files` would miss it
  // (it did — this scanner failed to catch the incident it was written for until this was added).
  const out = staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : git(['ls-files', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.split('\n').filter(Boolean))];
}

function contentOf(path, staged) {
  try {
    return staged ? git(['show', `:${path}`]) : readFileSync(path, 'utf8');
  } catch {
    return ''; // deleted, binary, or unreadable — nothing to scan
  }
}

const staged = process.argv.includes('--staged');
if (process.argv.includes('--add')) {
  const i = process.argv.indexOf('--add');
  addToDenylist(process.argv[i + 1]);
  process.exit(0);
}

const denylist = loadDenylist();
const findings = [];

for (const file of filesToScan(staged)) {
  // A tracked env file is a finding regardless of contents.
  if (/^\.env(\.|$)/.test(basename(file)) && !/example|sample|template/i.test(file)) {
    findings.push({ file, line: 0, what: 'tracked .env file', detail: file });
    continue;
  }
  const content = contentOf(file, staged);
  if (!content || content.includes('\0')) {
    continue; // empty or binary
  }
  const self = basename(file) === 'scan-secrets.mjs'; // this file names the patterns it hunts

  content.split('\n').forEach((line, i) => {
    if (/scan-secrets|secret-hashes|allow-secret/.test(line)) {
      return; // opt-out for lines that must mention a pattern
    }
    if (!self) {
      for (const { name, re, capture } of PATTERNS) {
        const m = re.exec(line);
        if (m && !isPlaceholder(capture ? m[capture] : m[0])) {
          findings.push({ file, line: i + 1, what: name, detail: `${(capture ? m[capture] : m[0]).slice(0, 12)}…` });
        }
      }
    }
    // The denylist layer applies even to this file: a real value must never appear here either.
    for (const token of line.match(CANDIDATE) ?? []) {
      const label = denylist.get(sha(token));
      if (label) {
        findings.push({ file, line: i + 1, what: `KNOWN SECRET (${label})`, detail: `${token.slice(0, 8)}…` });
      }
    }
  });
}

if (findings.length === 0) {
  const scope = staged ? 'staged content' : 'tracked files';
  console.log(`No secrets found in ${scope} (${denylist.size} known value(s) on the denylist).`);
  process.exit(0);
}

console.error(`\nSecret scan FAILED — ${findings.length} finding(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.what}  ${f.detail}`);
}
console.error(`
Remove the value and use a fake. If it is genuinely not a secret, make that obvious
(a placeholder like "your-api-key") or append "allow-secret" to the line.\n`);
process.exit(1);
