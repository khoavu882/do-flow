'use strict';

// FU-sf76tw: `hostVersion(repoRoot)` on a checkout or npm package reads `<repoRoot>/package.json`; on a projected runtime
// (`<scope root>/.doflow/runtime`, which ships no package.json) it reads the version the install recorded in the
// lock beside it (`<scope root>/.doflow/doflow.lock` `sourceVersion`); anything else is null (fail closed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { hostVersion } = require('../../src/runtime/packages/view.ts');

/** A scratch `<x>/.doflow/runtime` (no package.json) and, when `lock` is given, `<x>/.doflow/doflow.lock` holding it. */
function runtimeTree(lock: any, { parent = '.doflow' }: any = {}): any {
  const base = suiteTempDir('doflow-host-version-');
  const runtime = path.join(base, parent, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  if (lock !== undefined) fs.writeFileSync(path.join(base, parent, 'doflow.lock'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  return { base, runtime };
}
const withTree = (lock: any, options: any, body: (tree: any) => void) => {
  const tree = runtimeTree(lock, options);
  body(tree); // suiteTempDir removes the tree at suite end
};

test('a projected runtime takes the lock sourceVersion beside it', () => {
withTree({ version: 1, sourceVersion: '2.0.0-beta.7' }, {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), '2.0.0-beta.7'));
});

test('a sourceVersion that is not semver, an unreadable lock, no lock, or a non-.doflow parent gives null', () => {
  withTree({ version: 1, sourceVersion: 'garbage' }, {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
  withTree({ version: 1, sourceVersion: 'unknown' }, {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
  withTree({ version: 1 }, {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
  withTree('{not json', {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
  withTree(undefined, {}, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
  withTree({ version: 1, sourceVersion: '2.0.0' }, { parent: 'elsewhere' }, ({ runtime }: any) => assert.equal(hostVersion(runtime), null));
});

test('a package.json beside the root wins over the lock', () => {
  withTree({ version: 1, sourceVersion: '2.0.0-beta.7' }, {}, ({ runtime }: any) => {
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '3.1.4' }));
    assert.equal(hostVersion(runtime), '3.1.4');
  });
});
