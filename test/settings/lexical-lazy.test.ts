'use strict';

// 086 B.4a: the lexical failure.capture rule is loaded only when a capture decision is made, never on
// a verb's start. Every Node verb loads failure/capture.ts (and through it failure/home.ts); a `.ts`
// module costs about 1 ms to load even from the compile cache, so loading lexical.ts there was a cost
// every verb paid for a read only a failure needs. The switch's answers are unchanged (lexical.test.js,
// capture-agreement.test.js); this checks only when the module is loaded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');

const LEXICAL = path.join(REPO, 'src', 'runtime', 'settings', 'lexical.ts');
const CAPTURE = path.join(REPO, 'src', 'runtime', 'failure', 'capture.ts');
const HOME_TS = path.join(REPO, 'src', 'runtime', 'failure', 'home.ts');

const loaded = `Object.keys(require.cache).includes(${JSON.stringify(LEXICAL)})`;

test('loading the failure capture modules does not load the lexical rule', (t) => {
  const fx = createSettingsEnv(t);
  const out = fx.node(`require(${JSON.stringify(CAPTURE)}); require(${JSON.stringify(HOME_TS)});
    process.stdout.write(JSON.stringify({ loaded: ${loaded} }));`);
  assert.deepEqual(out, { loaded: false });
});

test('the first capture decision loads the lexical rule and still reads settings.json', (t) => {
  const fx = createSettingsEnv(t);
  fx.writeUserSettings({ 'failure.capture': 'off' });
  const out = fx.node(`const h = require(${JSON.stringify(HOME_TS)});
    const home = h.failureHome(process.env);
    const before = ${loaded};
    const off = h.captureIsOff(home, process.env);
    const sw = h.captureSwitch(home, process.env);
    process.stdout.write(JSON.stringify({ before, off, effective: sw.effective, settings: sw.settings, after: ${loaded} }));`);
  assert.deepEqual(out, { before: false, off: true, effective: 'off', settings: 'off', after: true });
});
