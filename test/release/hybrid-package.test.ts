'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('../guards/_shared.ts');
const { tempDir } = require('../helper/tmp.ts');
const { buildPackage } = require('../../src/release/build-package.ts');

test('staged npm package contains the Semble bridge as a Python runtime asset', (t) => {
  const out = path.join(tempDir(t, 'doflow-hybrid-package-'), 'package');
  buildPackage(out, { repoRoot: REPO });
  const source = path.join(REPO, 'src/runtime/knowledge/semble-bridge.py');
  const staged = path.join(out, 'src/runtime/knowledge/semble-bridge.py');
  assert.equal(fs.existsSync(staged), true, 'package.json files includes src/ recursively');
  assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(source));
  assert.match(fs.readFileSync(staged, 'utf8'), /SembleIndex\.load_from_disk/);
});
