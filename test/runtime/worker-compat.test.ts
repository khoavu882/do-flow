'use strict';
// 081 IC-032 (DEC-007, DEC-013): compatibility and zero-dependency obligations. Every check is a
// function over injected data, so each negative control runs in memory against a mutated copy and
// no test starts a process (NFR-002). Nothing here consults the real registry from a child.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const { tempDir } = require('../helper/tmp.ts');
const { FAKE_CLI, linkBin } = require('../helper/fake-harness-cli.ts');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'src');
const WORKER_DIR = path.join(SRC, 'runtime', 'worker');
const PACKAGE = require('../../package.json');
const HARNESSES = require('../../core/registry/harnesses.json');
const LIFECYCLE = require('../../core/registry/lifecycle.json');
const ORCHESTRATION_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink on POSIX' };
const DEPENDENCY_KEYS: any = ['dependencies', 'devDependencies', 'optionalDependencies'];
const BUILTINS: any = new Set(builtinModules.filter((name: any) => !name.startsWith('_')));

/** Findings for a package.json object carrying any dependency key (NFR-001). */
function dependencyFindings(pkg: any) {
  return DEPENDENCY_KEYS.filter((key: any) => Object.hasOwn(pkg, key)).map((key: any) => `package.json has '${key}'`);
}

/**
 * Findings for one module's text: every require must name a `node:` built-in or a relative path
 * resolving under src/. A require whose argument is not a string literal is a finding too, so a
 * computed specifier cannot slip past the scan.
 */
function requireFindings(text: any, file: any) {
  const findings: any = [];
  const label = path.relative(REPO, file);
  for (const match of text.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const literal = /^(['"])([^'"`]+)\1$/.exec(match[1]);
    if (!literal) {
      findings.push(`${label}: require with a non-literal specifier ${match[1]}`);
      continue;
    }
    const spec = literal[2];
    if (spec.startsWith('node:')) {
      if (!BUILTINS.has(spec.slice(5))) findings.push(`${label}: '${spec}' is not a node built-in`);
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      const back = path.relative(SRC, path.resolve(path.dirname(file), spec));
      if (!back || back.startsWith('..') || path.isAbsolute(back)) findings.push(`${label}: '${spec}' leaves src/`);
    } else {
      findings.push(`${label}: '${spec}' is neither a node: built-in nor a relative src/ path`);
    }
  }
  return findings;
}

// 118 IC-004 adds `nest` after be752d8; the copy covers the five operations that existed then.
function withoutNest(block: any) { const { nest: _nest, ...rest } = block ?? {}; return block === undefined ? undefined : rest; }

/** Findings where a harness's orchestration block differs from the be752d8 copy (FR-001). */
function orchestrationFindings(registry: any, fixture: any) {
  const findings: any = [];
  const ids = registry.harnesses.map((h: any) => h.id);
  for (const id of Object.keys(fixture)) if (!ids.includes(id)) findings.push(`fixture harness '${id}' is not registered`);
  for (const h of registry.harnesses) {
    if (!Object.hasOwn(fixture, h.id)) findings.push(`harness '${h.id}' has no be752d8 orchestration copy`);
    else if (!isDeepStrictEqual(withoutNest(h.orchestration), fixture[h.id])) findings.push(`harness '${h.id}' orchestration differs from be752d8`);
  }
  return findings;
}

/** Findings for any identity behaviour row that is not `limitation`, or a harness with none (DEC-007). */
function identityFindings(lifecycle: any, registry: any) {
  const rows = (lifecycle.coverage?.behaviours ?? []).filter((row: any) => row.behaviour === 'identity');
  const findings = rows.filter((row: any) => row.status !== 'limitation')
    .map((row: any) => `identity row for '${row.harness}' is '${row.status}', not 'limitation'`);
  for (const h of registry.harnesses) {
    if (!rows.some((row: any) => row.harness === h.id)) findings.push(`harness '${h.id}' has no identity row`);
  }
  return findings;
}

/** The PATH directories holding an entry named `name`, in lookup order. */
function resolveOnPath(name: any, childPath: any) {
  return childPath.split(path.delimiter).filter((dir: any) => dir && fs.existsSync(path.join(dir, name)));
}

test('compat: package.json declares no dependency key (NFR-001)', () => {
  assert.deepEqual(dependencyFindings(PACKAGE), []);
});

test('compat: package.json control, an added devDependencies key is reported', () => {
  assert.deepEqual(dependencyFindings({ ...PACKAGE, devDependencies: { undici: '7.0.0' } }), ["package.json has 'devDependencies'"]);
});

test('compat: every require under src/runtime/worker/ is a node: built-in or a relative src/ path (NFR-001)', () => {
  const files = fs.readdirSync(WORKER_DIR).filter((name: any) => name.endsWith('.ts')).map((name: any) => path.join(WORKER_DIR, name));
  assert.ok(files.length >= 9, `expected the worker modules, found ${files.length}`);
  let scanned = 0;
  const findings: any = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    scanned += [...text.matchAll(/\brequire\s*\(/g)].length;
    findings.push(...requireFindings(text, file));
  }
  assert.ok(scanned > 0, 'the scan must see require calls');
  assert.deepEqual(findings, []);
});

test('compat: require scan control, an in-memory module requiring undici is reported', () => {
  const file = path.join(WORKER_DIR, 'in-memory.ts');
  const text = [
    "const fs = require('node:fs');",
    "const { readRuns } = require('./run-store.ts');",
    "const { request } = require('undici');",
    "const nope = require('node:not-a-builtin');",
    "const outside = require('../../../test/helper/tmp.ts');",
    'const computed = require(name);',
  ].join('\n');
  assert.deepEqual(requireFindings(text, file), [
    "src/runtime/worker/in-memory.ts: 'undici' is neither a node: built-in nor a relative src/ path",
    "src/runtime/worker/in-memory.ts: 'node:not-a-builtin' is not a node built-in",
    "src/runtime/worker/in-memory.ts: '../../../test/helper/tmp.ts' leaves src/",
    'src/runtime/worker/in-memory.ts: require with a non-literal specifier name',
  ]);
});

test('compat: every harness orchestration block equals the be752d8 copy (FR-001)', () => {
  assert.equal(Object.keys(ORCHESTRATION_BE752D8).length, HARNESSES.harnesses.length);
  assert.deepEqual(orchestrationFindings(HARNESSES, ORCHESTRATION_BE752D8), []);
});

test('compat: orchestration control, one changed status is reported naming its harness', () => {
  const copy = structuredClone(HARNESSES);
  const target = copy.harnesses.find((h: any) => h.id === 'codex');
  const key = Object.keys(target.orchestration)[0];
  target.orchestration[key].status = target.orchestration[key].status === 'supported' ? 'unknown' : 'supported';
  assert.deepEqual(orchestrationFindings(copy, ORCHESTRATION_BE752D8), ["harness 'codex' orchestration differs from be752d8"]);
});

test('compat: every identity behaviour row stays limitation (DEC-007)', () => {
  const rows = LIFECYCLE.coverage.behaviours.filter((row: any) => row.behaviour === 'identity');
  assert.equal(rows.length, HARNESSES.harnesses.length, 'one identity row per registered harness');
  assert.deepEqual(identityFindings(LIFECYCLE, HARNESSES), []);
});

test('compat: identity control, a row promoted to supported is reported', () => {
  const copy = structuredClone(LIFECYCLE);
  const row = copy.coverage.behaviours.find((r: any) => r.behaviour === 'identity' && r.harness === 'claude');
  row.status = 'supported';
  delete row.limitation;
  assert.deepEqual(identityFindings(copy, HARNESSES), ["identity row for 'claude' is 'supported', not 'limitation'"]);
});

// RK9: the scratch PATH is the scratch bin plus the directory of process.execPath. That node
// directory can hold real harness binaries (on some machines claude, codex and others sit beside
// node), so this test does not claim the node directory is empty of them. It asserts what keeps
// them unreachable: the scratch bin holds only fake links, every fake name resolves to the scratch
// bin alone, and no fake name is a real registry binary name, so no test lookup lands on one.
test('compat: a scratch PATH from the fake-CLI helper resolves no linked name outside its own bin (RK9)', POSIX_ONLY, (t) => {
  const names = Object.values(DESCRIPTORS).map((block) => block.cli.binary);
  const realBinaries = HARNESSES.harnesses.map((h: any) => h.worker.cli.binary);
  const bin = path.join(tempDir(t, 'doflow-compat-'), 'bin');
  const childPath = linkBin(bin, names);
  const nodeDir = path.dirname(process.execPath);

  assert.deepEqual(childPath.split(path.delimiter), [bin, nodeDir], 'scratch bin plus the node directory, nothing else');
  assert.deepEqual(fs.readdirSync(bin).sort(), [...names].sort(), 'the scratch bin holds only the links the helper made');
  for (const name of fs.readdirSync(bin)) {
    assert.equal(fs.realpathSync(path.join(bin, name)), fs.realpathSync(FAKE_CLI), `${name} is a link to the fake CLI`);
  }
  for (const name of names) {
    assert.ok(!realBinaries.includes(name), `${name} is not a real registry binary name`);
    assert.deepEqual(resolveOnPath(name, childPath), [bin], `${name} resolves only to the scratch bin`);
  }
  for (const real of realBinaries) {
    assert.ok(!resolveOnPath(real, childPath).includes(bin), `real binary '${real}' is not in the scratch bin`);
  }
  const besideNode = realBinaries.filter((real: any) => fs.existsSync(path.join(nodeDir, real)));
  if (besideNode.length) t.diagnostic(`real harness binaries beside node (unreachable by fake names): ${besideNode.join(', ')}`);
});

test('compat: scratch PATH control, an extra entry or a stray real-named link is reported', POSIX_ONLY, (t) => {
  const dir = tempDir(t, 'doflow-compat-');
  const bin = path.join(dir, 'bin');
  const other = path.join(dir, 'other');
  linkBin(bin, ['fake-claude']);
  linkBin(other, ['fake-claude']);
  const widened = [bin, other].join(path.delimiter);
  assert.deepEqual(resolveOnPath('fake-claude', widened), [bin, other], 'a second directory holding the name is seen');
  fs.symlinkSync(FAKE_CLI, path.join(bin, 'codex'));
  assert.notDeepEqual(fs.readdirSync(bin).sort(), ['fake-claude'], 'a stray link breaks the only-fake-links assertion');
});
