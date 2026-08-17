'use strict';

// G7 — the published tarball matches the source of truth. Added during v1.0.0 release review,
// which found `bin/doflow.js.bak` (a stale pre-refactor copy of the CLI, 34 kB) and
// `core/registry/harnesses.yaml.bak` shipping inside `npm pack`. Git was clean the whole time:
// both files were gitignored, but package.json's `files` array whitelists whole directories and
// npm applies different ignore semantics than git. Scanning the whitelisted trees directly is
// cheaper and more deterministic than shelling out to `npm pack --dry-run`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const pkg = require('../../package.json');

// Mirrors .npmignore. Kept as a literal rather than parsed from that file so a mistaken edit to
// .npmignore fails this test instead of silently widening what may ship.
const DISALLOWED = /\.(bak|orig|rej|swp|tmp|pyc|pyo)$|~$|^\.DS_Store$|^Thumbs\.db$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') { out.push(path.relative(REPO, full)); continue; }
      walk(full, out);
      continue;
    }
    if (DISALLOWED.test(entry.name)) out.push(path.relative(REPO, full));
  }
  return out;
}

test('G7: no backup, editor, or bytecode artifacts live under the published `files` trees', () => {
  const offenders = pkg.files.flatMap((rel) => walk(path.join(REPO, rel)));
  assert.deepEqual(offenders, [], `these would ship in the npm tarball:\n  ${offenders.join('\n  ')}`);
});

test('G7: package.json carries the metadata npm needs to render a package page', () => {
  for (const field of ['name', 'version', 'description', 'license', 'repository', 'author', 'bugs', 'homepage']) {
    assert.ok(pkg[field], `package.json is missing "${field}"`);
  }
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, 'package.json needs keywords');
});

test('G7: a scoped package name declares public publishConfig access', () => {
  if (!pkg.name.startsWith('@')) return;
  assert.equal(
    pkg.publishConfig?.access,
    'public',
    'scoped packages default to restricted; publishing DoFlow publicly requires publishConfig.access',
  );
});

test('G7: the declared license has a matching LICENSE file', () => {
  const license = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
  assert.match(license, /MIT License/, 'LICENSE must state the MIT terms declared in package.json');
  assert.equal(pkg.license, 'MIT');
});
