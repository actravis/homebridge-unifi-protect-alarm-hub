// Packaging invariants. These are silent, total failures if they ever drift: Homebridge matches
// a config block to a plugin by `pluginAlias`/package name, and the settings UI writes whatever
// keys config.schema.json declares. Get either wrong and the plugin loads but never sees its
// config — with no error anywhere to explain it. Cheap to assert, so assert it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_NAME, PLUGIN_NAME } from '../dist/settings.js';

const read = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));
const pkg = read('package.json');
const schema = read('config.schema.json');

test('the schema alias and plugin name match the constants the platform registers with', () => {
  assert.equal(schema.pluginAlias, PLATFORM_NAME);
  assert.equal(pkg.name, PLUGIN_NAME);
  assert.equal(schema.pluginType, 'platform');
  assert.equal(schema.singular, true, 'one console per plugin instance');
});

test('every schema property is a key the plugin actually reads', () => {
  // ProtectConfig is a type, so it cannot be reflected at runtime; the declaration is the
  // source of truth and this parses it. A schema key the code never reads is a dead control
  // in the settings UI — the user changes it and nothing happens.
  const source = readFileSync(fileURLToPath(new URL('../src/settings.ts', import.meta.url)), 'utf8');
  const declared = new Set([...source.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]));
  // `name` and `platform` come from Homebridge's own PlatformConfig, not our interface.
  const inherited = new Set(['name', 'platform']);

  for (const key of Object.keys(schema.schema.properties)) {
    assert.ok(
      declared.has(key) || inherited.has(key),
      `config.schema.json exposes "${key}", which ProtectConfig does not declare`,
    );
  }
});

test('the required fields are exactly the two the plugin refuses to start without', () => {
  assert.deepEqual([...schema.schema.required].sort(), ['apiKey', 'host']);
});

test('the API key field is masked in the settings UI', () => {
  // It grants console-wide access; it must not render as plain text in a browser.
  assert.equal(schema.schema.properties.apiKey.format, 'password');
});

test('every layout entry references a property that exists', () => {
  const properties = new Set(Object.keys(schema.schema.properties));
  for (const group of schema.layout) {
    for (const item of group.items) {
      const key = typeof item === 'string' ? item : item.key;
      assert.ok(properties.has(key), `layout references unknown property "${key}"`);
    }
  }
});

test('every property is reachable from the layout', () => {
  // A property missing from the layout is invisible in the settings UI, so the only way to set
  // it is by hand-editing config.json.
  const laidOut = new Set(schema.layout.flatMap((g) => g.items.map((i) => (typeof i === 'string' ? i : i.key))));
  for (const key of Object.keys(schema.schema.properties)) {
    assert.ok(laidOut.has(key), `property "${key}" is not shown anywhere in the settings UI`);
  }
});

test('the published tarball carries everything Homebridge needs', () => {
  // `files` is an allow-list: anything missing here simply is not in the tarball, and the
  // failure only shows up for users who installed from npm.
  for (const entry of ['dist', 'config.schema.json', 'CHANGELOG.md', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `package.json "files" is missing ${entry}`);
  }
  assert.equal(pkg.main, 'dist/index.js');
  assert.ok(pkg.keywords.includes('homebridge-plugin'), 'required for the Homebridge plugin registry');
});

test('runtime dependencies stay minimal and auditable', () => {
  // A security-first plugin's dependency list is part of its threat model; anything added here
  // runs in the Homebridge process with access to config.json — including the API key.
  assert.deepEqual(Object.keys(pkg.dependencies), ['undici']);
  assert.deepEqual(Object.keys(pkg.optionalDependencies), ['ffmpeg-for-homebridge']);
});
