'use strict';

// 122 B.8-fix: the package view reads `packages.disabled` through a settings view limited to that key (`only`). A full
// load validates every key of a layer file, and the `review.preset` value list holds the presets of active packages
// (IC-014), which is the package view again: before the fix that nested read threw "depends on itself" and the view
// failed closed for every third-party package. The CLI paths are in package-scenarios.test.js; this file pins the seam.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createSettingsEnv } = require('../helper/settings-fixtures');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');

/** The shipped settings registry, with `review.preset` and `debate.preset` value lists that must never be read. */
function guardedRegistry() {
  const loaded = loadSettingsRegistry();
  assert.equal(loaded.ok, true, loaded.detail);
  const asked = [];
  const registry = {
    ...loaded.registry,
    enumValues(key) {
      if (key === 'review.preset' || key === 'debate.preset') {
        asked.push(key);
        throw new Error(`the ${key} list was read`);
      }
      return loaded.registry.enumValues(key);
    },
  };
  return { registry, asked };
}

test('a settings view limited to packages.disabled reads its value without resolving another key\'s value list', (t) => {
  const f = createSettingsEnv(t, { prefix: 'doflow-pcycle-' });
  fs.writeFileSync(f.projectFile('settings.json'), `${JSON.stringify({ schema: 1, 'packages.disabled': ['acme'], 'review.preset': 'acme.strict', 'debate.preset': 'acme.talk' })}\n`);
  const { registry, asked } = guardedRegistry();

  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry, only: ['packages.disabled'] });
  const resolution = view.get('packages.disabled');
  assert.deepEqual(resolution.value, ['acme']);
  assert.equal(resolution.state, 'ok');
  assert.equal(resolution.origin.layer, 'project');
  assert.deepEqual(asked, [], 'no preset value list was read');
  assert.throws(() => view.get('review.preset'), /not in this view/);

  // Without `only` the same file read does need the preset lists: the guard is what the limited view avoids.
  assert.throws(() => loadSettings({ projectRoot: f.project, env: f.env(), registry }).get('packages.disabled'), /list was read/);
});

test('a limited view keeps the fail-safe: an invalid packages.disabled is state invalid', (t) => {
  const f = createSettingsEnv(t, { prefix: 'doflow-pcycle-' });
  fs.writeFileSync(f.projectFile('settings.json'), `${JSON.stringify({ schema: 1, 'packages.disabled': 'acme', 'review.preset': 'acme.strict' })}\n`);
  const { registry, asked } = guardedRegistry();
  const resolution = loadSettings({ projectRoot: f.project, env: f.env(), registry, only: ['packages.disabled'] }).get('packages.disabled');
  assert.equal(resolution.state, 'invalid');
  assert.deepEqual(asked, []);
});
