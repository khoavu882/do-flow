'use strict';

/**
 * test/runtime/verification-impact.test.js: task A.3 (IC-009, DD-7, DD-8).
 *
 * Impacted test selector: static relative specifier resolution, spawn wildcard,
 * guard directory inclusion, and unknown-file full suite expansion.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '../..');
const IMPACT_SRC_PATH = path.join(REPO, 'src/runtime/verification/impact.ts');

function fixtureProject(t, { script = 'node --test test/', files = {} } = {}) {
  const root = tempDir(t, 'doflow-impact-fixture-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: script } }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const found = {
    source: 'package.json',
    command: 'node --test {pattern}',
    derivation: 'declared',
    testDirs: ['test'],
  };
  return { root, found };
}

// Execute mutated modules in memory per worker-rules and test/runtime/verification-inflight.test.js:476-
function mutated(file, before, after) {
  const Module = require('node:module');
  const filename = path.join(REPO, 'src/runtime/verification', file);
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), `mutation target exists: ${before}`);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source.replace(before, after)), filename);
  return instance.exports;
}

test('IC-009 pure: impact.ts does not contain child_process or mutating fs calls', () => {
  const source = fs.readFileSync(IMPACT_SRC_PATH, 'utf8');
  assert.doesNotMatch(source, /\bchild_process\b/, 'impact.ts must not reference child_process');
  assert.doesNotMatch(source, /\bwriteFile\b/, 'impact.ts must not write files');
  assert.doesNotMatch(source, /\bmkdir\b/, 'impact.ts must not create directories');
  assert.doesNotMatch(source, /\brename\b/, 'impact.ts must not rename files');
});

test('IC-009 null convention: returns null when conventionFor(found) returns null', () => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  assert.equal(selectImpactedTests({ root: '/tmp', found: null, changedFiles: ['src/a.ts'] }), null);
  assert.equal(selectImpactedTests({ root: '/tmp', found: { source: 'unknown' }, changedFiles: ['src/a.ts'] }), null);
});

test('IC-009 module change: transitive reachability selects reaching tests + spawn tests + guard directory', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/a.test.js': "const m1 = require('../src/m1.ts');\n",
      'test/b.test.js': "const m2 = require('../src/m2.ts');\n",
      'test/spawn.test.js': "const { spawnSync } = require('node:child_process');\nspawnSync('bin/doflow', ['verify']);\n",
      'test/guards/g.test.js': "// guard test\n",
      'src/m1.ts': "const c = require('./common.ts');\n",
      'src/m2.ts': "const o = require('./other.ts');\n",
      'src/common.ts': "// common module\n",
      'src/other.ts': "// other module\n",
      'src/unreached.ts': "// unreached module\n",
    },
  });

  const res = selectImpactedTests({
    root,
    found,
    changedFiles: ['src/common.ts'],
  });

  assert.ok(res !== null, 'expected result object');
  assert.equal(res.mode, 'selected');
  assert.deepEqual(res.unknownFiles, []);
  assert.equal(res.totalCount, 4);
  assert.equal(res.spawnTests, 1);
  assert.equal(typeof res.graphMs, 'number');
  assert.ok(res.graphMs >= 0, 'graphMs is non-negative');

  // m1 imports common. a.test imports m1. test/spawn is a spawn wildcard. test/guards/g is guard.
  assert.deepEqual(res.tests, [
    'test/a.test.js',
    'test/guards/g.test.js',
    'test/spawn.test.js',
  ]);
});

test('IC-009 test file change: changed test selects itself without pulling spawn wildcard', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/a.test.js': "const m1 = require('../src/m1.ts');\n",
      'test/b.test.js': "const m2 = require('../src/m2.ts');\n",
      'test/spawn.test.js': "const { spawnSync } = require('node:child_process');\nspawnSync('bin/doflow', ['verify']);\n",
      'test/guards/g.test.js': "// guard test\n",
      'src/m1.ts': "// m1\n",
      'src/m2.ts': "// m2\n",
    },
  });

  const res = selectImpactedTests({
    root,
    found,
    changedFiles: ['test/b.test.js'],
  });

  assert.ok(res !== null);
  assert.equal(res.mode, 'selected');
  assert.deepEqual(res.unknownFiles, []);
  assert.deepEqual(res.tests, [
    'test/b.test.js',
    'test/guards/g.test.js',
  ]);
});

test('IC-009 unknown files: registry, package.json, lockfile, md, unreached src give mode "full"', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/a.test.js': "const m1 = require('../src/m1.ts');\n",
      'test/guards/g.test.js': "// guard\n",
      'src/m1.ts': "// m1\n",
      'src/unreached.ts': "// unreached\n",
      'core/registry/settings.json': "{}\n",
      'package-lock.json': "{}\n",
      'README.md': "# Readme\n",
    },
  });

  const cases = [
    ['core/registry/settings.json'],
    ['package.json'],
    ['package-lock.json'],
    ['README.md'],
    ['src/unreached.ts'],
    ['core/registry/settings.json', 'src/m1.ts'],
  ];

  for (const changedFiles of cases) {
    const res = selectImpactedTests({ root, found, changedFiles });
    assert.ok(res !== null, `expected non-null for ${changedFiles}`);
    assert.equal(res.mode, 'full', `expected mode full for ${changedFiles}`);
    assert.deepEqual(res.tests, ['test/a.test.js', 'test/guards/g.test.js']);
    const expectedUnknown = changedFiles.filter((f) => f !== 'src/m1.ts').sort();
    assert.deepEqual(res.unknownFiles, expectedUnknown);
  }
});

test('IC-009 empty changedFiles: selects just guard dir tests, or empty array when none', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root: rootWithGuard, found: foundWithGuard } = fixtureProject(t, {
    files: {
      'test/a.test.js': "// a\n",
      'test/guards/g.test.js': "// g\n",
    },
  });
  const resWithGuard = selectImpactedTests({ root: rootWithGuard, found: foundWithGuard, changedFiles: [] });
  assert.equal(resWithGuard.mode, 'selected');
  assert.deepEqual(resWithGuard.tests, ['test/guards/g.test.js']);
  assert.deepEqual(resWithGuard.unknownFiles, []);

  const { root: rootNoGuard, found: foundNoGuard } = fixtureProject(t, {
    files: {
      'test/a.test.js': "// a\n",
    },
  });
  const resNoGuard = selectImpactedTests({ root: rootNoGuard, found: foundNoGuard, changedFiles: [] });
  assert.equal(resNoGuard.mode, 'selected');
  assert.deepEqual(resNoGuard.tests, []);
  assert.deepEqual(resNoGuard.unknownFiles, []);
});

test('IC-009 deleted files: deleted test is non-unknown; deleted source without graph entry is unknown', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/a.test.js': "require('../src/lib.ts');\n",
      'test/guards/g.test.js': "// g\n",
      'src/lib.ts': "// lib\n",
    },
  });

  // A deleted test file absent on disk:
  const resDeletedTest = selectImpactedTests({
    root,
    found,
    changedFiles: ['test/deleted.test.js'],
  });
  assert.equal(resDeletedTest.mode, 'selected');
  assert.deepEqual(resDeletedTest.unknownFiles, []);
  assert.deepEqual(resDeletedTest.tests, ['test/guards/g.test.js']);

  // A deleted test file passed via deletedFiles:
  const resDeletedFilesArg = selectImpactedTests({
    root,
    found,
    changedFiles: [],
    deletedFiles: ['test/deleted.test.js'],
  });
  assert.equal(resDeletedFilesArg.mode, 'selected');
  assert.deepEqual(resDeletedFilesArg.unknownFiles, []);

  // A deleted module absent on disk and not in current graph:
  const resDeletedModule = selectImpactedTests({
    root,
    found,
    changedFiles: ['src/deleted-mod.ts'],
  });
  assert.equal(resDeletedModule.mode, 'full');
  assert.deepEqual(resDeletedModule.unknownFiles, ['src/deleted-mod.ts']);

  const resDeletedModuleArg = selectImpactedTests({
    root,
    found,
    changedFiles: [],
    deletedFiles: ['src/deleted-mod.ts'],
  });
  assert.equal(resDeletedModuleArg.mode, 'full');
  assert.deepEqual(resDeletedModuleArg.unknownFiles, ['src/deleted-mod.ts']);
});

test('IC-009 resolution: handles exact path, .ts, .js, /index.ts, /index.js', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/t1.test.js': "require('../src/exact.ts');\n",
      'test/t2.test.js': "require('../src/tsmodule');\n",
      'test/t3.test.js': "require('../src/jsmodule');\n",
      'test/t4.test.js': "require('../src/tsindex');\n",
      'test/t5.test.js': "require('../src/jsindex');\n",
      'src/exact.ts': "// exact\n",
      'src/tsmodule.ts': "// tsmodule\n",
      'src/jsmodule.js': "// jsmodule\n",
      'src/tsindex/index.ts': "// tsindex\n",
      'src/jsindex/index.js': "// jsindex\n",
    },
  });

  const check = (changed, expectedTest) => {
    const res = selectImpactedTests({ root, found, changedFiles: [changed] });
    assert.equal(res.mode, 'selected');
    assert.deepEqual(res.tests, [expectedTest]);
  };

  check('src/exact.ts', 'test/t1.test.js');
  check('src/tsmodule.ts', 'test/t2.test.js');
  check('src/jsmodule.js', 'test/t3.test.js');
  check('src/tsindex/index.ts', 'test/t4.test.js');
  check('src/jsindex/index.js', 'test/t5.test.js');
});

test('IC-009 import forms: supports import, import(), and multiline import statements', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/esm.test.js': `
        import defaultA from '../src/mod-a.ts';
        import {
          namedB,
          otherB
        } from '../src/mod-b.ts';
        import * as nsC from '../src/mod-c.ts';
        import '../src/mod-d.ts';
        async function load() {
          const modE = await import('../src/mod-e.ts');
        }
      `,
      'src/mod-a.ts': "// a\n",
      'src/mod-b.ts': "// b\n",
      'src/mod-c.ts': "// c\n",
      'src/mod-d.ts': "// d\n",
      'src/mod-e.ts': "// e\n",
    },
  });

  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    const res = selectImpactedTests({ root, found, changedFiles: [`src/mod-${letter}.ts`] });
    assert.equal(res.mode, 'selected', `expected selected for mod-${letter}`);
    assert.deepEqual(res.tests, ['test/esm.test.js']);
  }
});

test('IC-009 spawn test detection: recognizes bin/doflow and doflow-run with child_process functions', (t) => {
  const { selectImpactedTests } = require('../../src/runtime/verification/impact.ts');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/t1.test.js': "const { execSync } = require('child_process');\nexecSync('doflow-run verify');\n",
      'test/t2.test.js': "const cp = require('node:child_process');\ncp.execFile('bin/doflow', []);\n",
      'test/t3.test.js': "const { fork } = require('node:child_process');\nfork('bin/doflow');\n",
      'test/regular.test.js': "require('../src/lib.ts');\n",
      'src/lib.ts': "// lib\n",
    },
  });

  const res = selectImpactedTests({ root, found, changedFiles: ['src/lib.ts'] });
  assert.equal(res.mode, 'selected');
  assert.equal(res.spawnTests, 3);
  assert.deepEqual(res.tests, [
    'test/regular.test.js',
    'test/t1.test.js',
    'test/t2.test.js',
    'test/t3.test.js',
  ]);
});

test('negative control: removing the spawn wildcard drops a spawning test from a module change', (t) => {
  const mutant = mutated('impact.ts', '/* SPAWN_WILDCARD */ for (const spawnTest of spawnTests) selectedTests.add(spawnTest);', '');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/regular.test.js': "require('../src/lib.ts');\n",
      'test/spawn.test.js': "const { spawnSync } = require('node:child_process');\nspawnSync('bin/doflow');\n",
      'src/lib.ts': "// lib\n",
    },
  });

  const out = mutant.selectImpactedTests({ root, found, changedFiles: ['src/lib.ts'] });
  // In mutated code, test/spawn.test.js is dropped:
  assert.throws(() => {
    assert.deepEqual(out.tests, ['test/regular.test.js', 'test/spawn.test.js']);
  }, assert.AssertionError, 'spawn wildcard removal drops spawning test');
  assert.deepEqual(out.tests, ['test/regular.test.js']);
});

test('negative control: treating unknown files as no-op turns the registry case red', (t) => {
  const mutant = mutated('impact.ts', '/* UNKNOWN_EXPANSION */ if (unknownFiles.size > 0) return fullSuite();', '');
  const { root, found } = fixtureProject(t, {
    files: {
      'test/a.test.js': "require('../src/lib.ts');\n",
      'core/registry/settings.json': "{}\n",
      'src/lib.ts': "// lib\n",
    },
  });

  const out = mutant.selectImpactedTests({ root, found, changedFiles: ['core/registry/settings.json'] });
  // In mutated code, unknown files do not trigger mode: 'full':
  assert.throws(() => {
    assert.equal(out.mode, 'full');
  }, assert.AssertionError, 'unknown file expansion removal leaves mode as selected');
  assert.equal(out.mode, 'selected');
});
