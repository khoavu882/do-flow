'use strict';

// maint-thin P2: the class seat floor binds unless autopilot is verifiably off. Uncertain reads as unattended.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { reviewUnattended } = require('../../src/runtime/settings/autopilot.ts');

function home(t: any, settings?: any) {
  const dir = tempDir(t, 'doflow-review-unattended-');
  fs.mkdirSync(path.join(dir, '.config', 'doflow'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(dir, '.config', 'doflow', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
}

test('verifiably off is attended: the shipped off, a settings off and the sentinel', (t) => {
  assert.equal(reviewUnattended(home(t)), false);
  assert.equal(reviewUnattended(home(t, { schema: 1, 'autopilot.enabled': 'off' })), false);
  const env = home(t, { schema: 1, 'autopilot.enabled': 'on' });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'doflow', 'autopilot'), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'doflow', 'autopilot', 'off'), 'x\n');
  assert.equal(reviewUnattended(env), false);
});

test('on, an invalid value, unreadable settings or no config home is unattended', (t) => {
  assert.equal(reviewUnattended(home(t, { schema: 1, 'autopilot.enabled': 'on' })), true);
  assert.equal(reviewUnattended(home(t, { schema: 1, 'autopilot.enabled': 'maybe' })), true);
  assert.equal(reviewUnattended(home(t, '{not json')), true);
  assert.equal(reviewUnattended({}), true);
});

test('an explicit process-local DOFLOW_AUTOPILOT_ENABLED=off is attended; any other value is not', (t) => {
  const env = home(t, { schema: 1, 'autopilot.enabled': 'on' });
  assert.equal(reviewUnattended({ ...env, DOFLOW_AUTOPILOT_ENABLED: 'off' }), false);
  assert.equal(reviewUnattended({ ...env, DOFLOW_AUTOPILOT_ENABLED: 'OFF' }), true);
  assert.equal(reviewUnattended({ DOFLOW_AUTOPILOT_ENABLED: 'off' }), false);
});
