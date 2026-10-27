'use strict';

// A test env literal that isolates git (GIT_CONFIG_NOSYSTEM) must also switch off git's background
// maintenance (GIT_NO_MAINTENANCE_ENV from test/helper/tmp.ts): a detached gc/maintenance started by a
// fixture commit rewrites .git/objects while the repo is copied or checked (ci-beta7).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, '..');
const NEEDLE = ['GIT_CONFIG_NOSYSTEM', ": '1'"].join('');
const SPREAD = `${NEEDLE}, ...GIT_NO_MAINTENANCE_ENV`;

function files(dir: any): any {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' ? [] : files(p);
    return /\.(ts|js|cjs|mjs)$/.test(e.name) ? [p] : [];
  });
}

test('every test env literal that sets GIT_CONFIG_NOSYSTEM spreads GIT_NO_MAINTENANCE_ENV', () => {
  const bad: any = [];
  for (const file of files(TEST_DIR)) {
    if (file === __filename) continue;
    const text = fs.readFileSync(file, 'utf8');
    let at = text.indexOf(NEEDLE);
    while (at !== -1) {
      if (!text.startsWith(SPREAD, at)) bad.push(`${path.relative(TEST_DIR, file)}:${text.slice(0, at).split('\n').length}`);
      at = text.indexOf(NEEDLE, at + 1);
    }
  }
  assert.deepEqual(bad, []);
});
