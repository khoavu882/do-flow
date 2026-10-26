'use strict';

// Console package shape (feature 093, IC-001; FR-014, NFR-001). `checkManifest` is a pure function over
// the manifest text, so each rule has a control that runs it on a planted mutation of that text and
// expects the failure to name the rule.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHostRange, satisfiesHostRange } = require('../../src/helper/semver.ts');

const MANIFEST_FILE = path.join(__dirname, '..', 'package.json');
const CORE_MANIFEST_FILE = path.join(__dirname, '..', '..', 'package.json');
const FORBIDDEN_DEPENDENCY_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Every error starts with the id of the rule it breaks, then a colon.
function checkManifest(manifestText: string, coreText: string): string[] {
  let manifest: any;
  let core: any;
  try {
    manifest = JSON.parse(manifestText);
    core = JSON.parse(coreText);
  } catch (error: any) {
    return [`manifest: not valid JSON (${error.message})`];
  }
  const errors: string[] = [];
  const same = (id: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${id}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
    }
  };
  same('name', manifest.name, '@khoavu882/doflow-ui');
  same('version', manifest.version, '0.1.0');
  same('private', manifest.private, true);
  same('license', manifest.license, 'MIT');
  same('type', manifest.type, 'commonjs');
  same('bin', manifest.bin, { 'doflow-ui': 'bin/doflow-ui.js' });
  same('engines.node', manifest.engines?.node, core.engines?.node);
  same('files', manifest.files, ['bin/', 'src/', 'web/']);
  const scripts = manifest.scripts ?? {};
  same('scripts.test', scripts.test, 'node --test "test/**/*.test.ts"');
  same('scripts.typecheck', scripts.typecheck, 'npx -y -p typescript@5.7.2 tsc -p tsconfig.json');
  same('scripts.build:diagrams', scripts['build:diagrams'], 'node scripts/build-diagrams.ts');

  // doflowCore: a host range with an upper bound (092 IC-013) that accepts the core in this checkout.
  const range = manifest.doflowCore;
  const parsed = parseHostRange(range);
  if (!parsed.ok) errors.push(`doflowCore: ${parsed.error.message}`);
  else if (!satisfiesHostRange(core.version, parsed)) errors.push(`doflowCore: "${range}" does not accept the core ${core.version}`);

  for (const key of FORBIDDEN_DEPENDENCY_KEYS) {
    if (key in manifest) errors.push(`no-dependency-maps: package.json has ${key}`);
  }
  if ('devDependencies' in manifest) {
    const dev = manifest.devDependencies;
    const keys = dev && typeof dev === 'object' && !Array.isArray(dev) ? Object.keys(dev) : null;
    if (keys === null) errors.push('devDependencies: not an object');
    else {
      for (const key of keys) {
        if (key !== 'pele') errors.push(`devDependencies: only pele is allowed, found ${key}`);
        else if (typeof dev[key] !== 'string' || !EXACT_VERSION.test(dev[key])) errors.push(`devDependencies: pele must be an exact version, found ${JSON.stringify(dev[key])}`);
      }
    }
  }
  return errors;
}

const RULE_IDS = ['name', 'version', 'private', 'license', 'type', 'bin', 'engines.node', 'files', 'scripts.test',
  'scripts.typecheck', 'scripts.build:diagrams', 'doflowCore', 'no-dependency-maps', 'devDependencies'];

// One or more planted mutations per rule, each applied to a parsed copy of the real manifest text.
const MUTATIONS: Record<string, Array<[string, (m: any) => void]>> = {
  name: [['renamed', (m) => { m.name = '@khoavu882/doflow'; }]],
  version: [['bumped', (m) => { m.version = '0.2.0'; }]],
  private: [['public', (m) => { m.private = false; }], ['absent', (m) => { delete m.private; }]],
  license: [['other license', (m) => { m.license = 'ISC'; }]],
  type: [['module', (m) => { m.type = 'module'; }], ['absent', (m) => { delete m.type; }]],
  bin: [['other command', (m) => { m.bin = { doflow: 'bin/doflow-ui.js' }; }], ['other file', (m) => { m.bin = { 'doflow-ui': 'bin/other.js' }; }], ['absent', (m) => { delete m.bin; }]],
  'engines.node': [['lower floor', (m) => { m.engines = { node: '>=18' }; }], ['absent', (m) => { delete m.engines; }]],
  files: [['ships scripts', (m) => { m.files = ['bin/', 'src/', 'web/', 'scripts/']; }], ['ships test', (m) => { m.files.push('test/'); }], ['missing web', (m) => { m.files = ['bin/', 'src/']; }]],
  'scripts.test': [['other command', (m) => { m.scripts.test = 'node --test test/'; }]],
  'scripts.typecheck': [['other tsc', (m) => { m.scripts.typecheck = 'npx -y -p typescript@5.8.0 tsc -p tsconfig.json'; }]],
  'scripts.build:diagrams': [['absent', (m) => { delete m.scripts['build:diagrams']; }]],
  doflowCore: [['absent', (m) => { delete m.doflowCore; }], ['no upper bound', (m) => { m.doflowCore = '>=2.0.0-beta.7'; }], ['excludes the core', (m) => { m.doflowCore = '>=9.0.0 <10.0.0'; }], ['caret range', (m) => { m.doflowCore = '^2.0.0'; }]],
  'no-dependency-maps': FORBIDDEN_DEPENDENCY_KEYS.map((key): [string, (m: any) => void] => [key, (m) => { m[key] = key.startsWith('bundle') ? [] : {}; }]),
  devDependencies: [['caret pele', (m) => { m.devDependencies = { pele: '^1.0.0' }; }], ['tilde pele', (m) => { m.devDependencies = { pele: '~1.0.0' }; }], ['other package', (m) => { m.devDependencies = { typescript: '5.7.2' }; }], ['pele plus another', (m) => { m.devDependencies = { pele: '1.0.0', left: '1.0.0' }; }]],
};

const manifestText = fs.readFileSync(MANIFEST_FILE, 'utf8');
const coreText = fs.readFileSync(CORE_MANIFEST_FILE, 'utf8');
const mutate = (fn: (m: any) => void) => { const m = JSON.parse(manifestText); fn(m); return JSON.stringify(m); };
const failing = (errors: string[], id: string) => errors.filter((e) => e.startsWith(`${id}:`));

test('package shape: the real manifest breaks no rule', () => {
  assert.deepEqual(checkManifest(manifestText, coreText), []);
});

for (const id of RULE_IDS) {
  test(`package shape: rule ${id} has a control for every planted mutation`, () => {
    const mutations = MUTATIONS[id];
    assert.ok(mutations && mutations.length > 0, `rule ${id} has no mutation control`);
    for (const [label, fn] of mutations) {
      const errors = checkManifest(mutate(fn), coreText);
      assert.ok(failing(errors, id).length > 0, `${id} / ${label}: mutated manifest did not fail the rule (${JSON.stringify(errors)})`);
    }
  });
}

test('package shape: pele at an exact version is accepted and the control table names every rule', () => {
  assert.deepEqual(checkManifest(mutate((m) => { m.devDependencies = { pele: '1.2.3' }; }), coreText), []);
  assert.deepEqual(Object.keys(MUTATIONS).sort(), [...RULE_IDS].sort());
});

test('package shape: engines.node follows the core manifest rather than a literal', () => {
  const movedCore = JSON.stringify({ ...JSON.parse(coreText), engines: { node: '>=99.0.0' } });
  assert.ok(failing(checkManifest(manifestText, movedCore), 'engines.node').length > 0);
});

test('package shape: a manifest that is not JSON fails', () => {
  assert.ok(checkManifest('{ nope', coreText)[0].startsWith('manifest:'));
});
