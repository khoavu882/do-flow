'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LOCK_VERSION, lockPath, defaultLock, validateLock, readLock, writeLock, diffLocks, lockPackages } = require('../../src/state/lockfile.ts');
const { tempDir } = require('../helper/tmp');

function scratch(t) { return tempDir(t, 'doflow-lock-'); }
const projectScope = (project) => ({ scope: 'project', projectRoot: project });

function sampleLock(project, overrides = {}) {
  const lock = defaultLock({ scope: 'project', scopeRoot: project });
  Object.assign(lock, {
    generatedAt: '2026-08-22T00:00:00.000Z',
    sourceVersion: 'registry-v1',
    targets: [{ harness: 'codex' }, { harness: 'claude' }],
    assets: [
      { id: 'skills.doflow', kind: 'skill', nativeDir: '../.agents/skills' },
      { id: 'agents.shared', kind: 'agent', nativeDir: 'agents' },
    ],
    mcpSelections: { codex: ['context7'] },
    ...overrides,
  });
  return lock;
}

test('lock paths are neutral and scope-specific under .doflow/', (t) => {
  const home = scratch(t);
  const project = scratch(t);
  assert.equal(lockPath(projectScope(project)), path.join(project, '.doflow', 'doflow.lock'));
  assert.equal(lockPath({ scope: 'global', homeDir: home }), path.join(home, '.doflow', 'doflow.lock'));
  assert.throws(() => lockPath({ scope: 'team', projectRoot: project }), /Invalid lock scope/);
});

test('lock writes atomically, round-trips, and is deterministically ordered', (t) => {
  const project = scratch(t);
  const lock = sampleLock(project);
  writeLock(projectScope(project), lock);
  const onDisk = fs.readFileSync(path.join(project, '.doflow', 'doflow.lock'), 'utf8');
  const parsed = JSON.parse(onDisk);
  assert.deepEqual(readLock(projectScope(project)), parsed);
  // Deterministic serialization: targets and assets sorted by identity, object keys stable.
  assert.deepEqual(parsed.targets.map((t) => t.harness), ['claude', 'codex']);
  assert.deepEqual(parsed.assets.map((a) => a.id), ['agents.shared', 'skills.doflow']);
  assert.ok(fs.readdirSync(path.join(project, '.doflow')).every((f) => !f.endsWith('.tmp')));
});

test('validate rejects foreign versions and malformed shapes', (t) => {
  const project = scratch(t);
  const lock = sampleLock(project);
  validateLock(lock);
  assert.throws(() => validateLock({ ...lock, version: LOCK_VERSION + 1 }), /Unsupported doflow.lock version/);
  assert.throws(() => validateLock({ ...lock, scopeRoot: './relative' }), /scopeRoot must be absolute/);
  assert.throws(() => validateLock({ ...lock, assets: 'nope' }), /assets must be an array/);
  assert.throws(() => writeLock(projectScope(project), { ...sampleLock(project), version: 99 }), /Unsupported doflow\.lock version/);
  // A corrupted file on disk surfaces as an actionable read error.
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(project, '.doflow', 'doflow.lock'), '{ not json');
  assert.throws(() => readLock(projectScope(project)), /Cannot read doflow\.lock/);
});

test('diffLocks reports added/removed/changed per section and a clean verdict', (t) => {
  const project = scratch(t);
  const before = sampleLock(project);
  assert.equal(diffLocks(before, before).clean, true);

  const after = sampleLock(project);
  after.targets = [{ harness: 'codex' }, { harness: 'kiro' }];            // claude removed, kiro added
  after.assets[1].nativeDir = 'moved';                                     // changed in place
  after.mcpSelections.codex = [];                                          // selection withdrawn
  after.sourceVersion = 'registry-v2';                                     // meta bump

  const diff = diffLocks(before, after);
  assert.deepEqual(diff.targets.added, [{ harness: 'kiro' }]);
  assert.deepEqual(diff.targets.removed, [{ harness: 'claude' }]);
  assert.deepEqual(diff.assets.changed, [{ id: 'agents.shared', kind: 'agent', nativeDir: 'moved' }]);
  assert.deepEqual(diff.mcpSelections.changed, [{ harness: 'codex', before: ['context7'], after: [] }]);
  assert.deepEqual(diff.meta.sourceVersion, { before: 'registry-v1', after: 'registry-v2' });
  assert.equal(diff.clean, false);
});

test('a 1.18.0-shaped lock validates and a non-array MCP row is rejected', (t) => {
  const project = scratch(t);
  // 1.18.0 wrote rows only for claude and codex, and none for an empty selection.
  const legacy = sampleLock(project, {
    targets: [{ harness: 'claude' }, { harness: 'codex' }, { harness: 'gemini' }],
    mcpSelections: { claude: ['context7', 'sequential-thinking'], codex: ['context7'] },
  });
  assert.equal(validateLock(legacy), legacy);
  assert.throws(() => validateLock({ ...legacy, mcpSelections: { claude: 'context7' } }),
    { message: 'Invalid doflow.lock: mcpSelections.claude must be an array of server ids' });
  assert.throws(() => validateLock({ ...legacy, mcpSelections: { codex: [7] } }),
    { message: 'Invalid doflow.lock: mcpSelections.codex must be an array of server ids' });
});

test('diffLocks tells an absent MCP row from an empty one and ignores rows of non-targets', (t) => {
  const project = scratch(t);
  const before = sampleLock(project, { mcpSelections: { codex: ['context7'] } });
  const after = sampleLock(project, { mcpSelections: { codex: ['context7'], claude: [] } });
  const diff = diffLocks(before, after);
  assert.deepEqual(diff.mcpSelections.changed, [{ harness: 'claude', before: null, after: [] }]);
  assert.equal(diff.clean, false);

  const stray = sampleLock(project, { mcpSelections: { codex: ['context7'], kiro: ['context7'] } });
  assert.equal(diffLocks(before, stray).clean, true, 'kiro is not a target, so its row is not pinned');
});

test('a failing rename leaves the prior lock bytes and no temp file', (t) => {
  const project = scratch(t);
  writeLock(projectScope(project), sampleLock(project));
  const file = lockPath(projectScope(project));
  const priorBytes = fs.readFileSync(file);
  const failingRename = { ...fs, renameSync() { throw new Error('rename failed'); } };
  assert.throws(() => writeLock(projectScope(project), sampleLock(project, { sourceVersion: 'registry-v2' }), { fsImpl: failingRename }),
    /rename failed/);
  assert.deepEqual(fs.readFileSync(file), priorBytes);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['doflow.lock']);
});

// ── lock v2 `packages` section (122 IC-007) ──────────────────────────────────────────────────────
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const D3 = 'c'.repeat(64);
const pkg = (id, overrides = {}) => ({
  id, version: '1.2.0', source: { type: 'local', path: `/abs/${id}` },
  contentDigest: D1, capabilityDigest: D2, enabled: false, addedAt: '2026-10-24T09:00:00.000Z', ...overrides,
});
const globalScope = (home) => ({ scope: 'global', homeDir: home });
function globalLock(home, overrides = {}) {
  return Object.assign(sampleLock(home, { sourceVersion: 'registry-v1' }), { scope: 'global', scopeRoot: path.resolve(home) }, overrides);
}

test('LOCK_VERSION is 2 and validateLock accepts versions 1 and 2 only', (t) => {
  const home = scratch(t);
  assert.equal(LOCK_VERSION, 2);
  const lock = globalLock(home);
  assert.equal(validateLock({ ...lock, version: 1 }).version, 1);
  assert.equal(validateLock({ ...lock, version: 2 }).version, 2);
  assert.throws(() => validateLock({ ...lock, version: 3 }), /Unsupported doflow\.lock version: '3'/);
  assert.throws(() => validateLock({ ...lock, version: 0 }), /Unsupported doflow\.lock version: '0'/);
});

// The expected bytes are pinned by digest: they were produced by develop 601973d4's own `writeLock`
// (its src tree read with `git archive develop src`) from the document below, scope global.
const DEVELOP_V1_SHA256 = '4ea11b999454dac71f8a817b9893aae869c252ac2de33527ff47ac838cebabfb';
function developFixtureLock() {
  return {
    ...defaultLock({ scope: 'global', scopeRoot: '/home/fixture' }),
    generatedAt: '2026-08-22T00:00:00.000Z', sourceVersion: 'registry-v1',
    targets: [{ harness: 'codex' }, { harness: 'claude' }],
    assets: [{ id: 'skills.doflow', kind: 'skill', nativeDir: '../.agents/skills' }, { id: 'agents.shared', kind: 'agent', nativeDir: 'agents' }],
    mcpSelections: { codex: ['context7'] },
  };
}

test('NFR-001: a lock with an empty or absent packages list is byte-identical to the develop v1 file', (t) => {
  for (const extra of [{}, { packages: [] }]) {
    const home = scratch(t);
    writeLock(globalScope(home), { ...developFixtureLock(), ...extra });
    const bytes = fs.readFileSync(lockPath(globalScope(home)));
    // the fixture's scopeRoot is fixed, so the digest holds whatever scratch home the test uses
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), DEVELOP_V1_SHA256, JSON.stringify(extra));
    const parsed = JSON.parse(bytes);
    assert.equal(parsed.version, 1);
    assert.equal('packages' in parsed, false);
  }
});

test('a v2 lock round-trips, with packages sorted by id and the version raised to 2', (t) => {
  const home = scratch(t);
  const lock = globalLock(home, { packages: [pkg('zeta'), pkg('acme', { enabled: true }), pkg('mid')] });
  writeLock(globalScope(home), lock);
  const parsed = JSON.parse(fs.readFileSync(lockPath(globalScope(home)), 'utf8'));
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.packages.map((row) => row.id), ['acme', 'mid', 'zeta'], 'sorted by id, not by the rows\' JSON text');
  assert.deepEqual(readLock(globalScope(home)), parsed);
  assert.deepEqual(lockPackages(readLock(globalScope(home))).map((row) => row.id), ['acme', 'mid', 'zeta']);
  // writing the same document again leaves the same bytes
  const first = fs.readFileSync(lockPath(globalScope(home)));
  writeLock(globalScope(home), readLock(globalScope(home)));
  assert.deepEqual(fs.readFileSync(lockPath(globalScope(home))), first);
});

test('lockPackages reads a v1 lock, an absent section and no lock as an empty list', (t) => {
  const home = scratch(t);
  writeLock(globalScope(home), globalLock(home));
  const v1 = readLock(globalScope(home));
  assert.equal(v1.version, 1);
  assert.deepEqual(lockPackages(v1), []);
  assert.deepEqual(lockPackages(null), []);
  assert.deepEqual(lockPackages({}), []);
});

test('a malformed package row is refused naming its field', (t) => {
  const home = scratch(t);
  const bad = (row, expected) => assert.throws(
    () => validateLock(globalLock(home, { version: 2, packages: [row] })), (error) => expected.test(error.message), JSON.stringify(row));
  bad(pkg('acme', { id: 'Acme' }), /packages\[0\]\.id/);
  bad(pkg('acme', { id: 'a--b' }), /packages\[0\]\.id/);
  bad(pkg('acme', { version: '' }), /packages\[0\]\.version/);
  bad(pkg('acme', { source: 'local' }), /packages\[0\]\.source/);
  bad(pkg('acme', { source: { type: 'ftp' } }), /packages\[0\]\.source/);
  bad(pkg('acme', { contentDigest: 'abc' }), /packages\[0\]\.contentDigest/);
  bad(pkg('acme', { capabilityDigest: 'G'.repeat(64) }), /packages\[0\]\.capabilityDigest/);
  bad(pkg('acme', { enabled: 'yes' }), /packages\[0\]\.enabled/);
  bad(pkg('acme', { addedAt: 'yesterday' }), /packages\[0\]\.addedAt/);
  bad({ ...pkg('acme'), defaultEnabled: true }, /packages\[0\]\.defaultEnabled/);
  const missing = pkg('acme'); delete missing.capabilityDigest;
  bad(missing, /packages\[0\]\.capabilityDigest/);
  bad('acme', /packages\[0\]/);
  assert.throws(() => validateLock(globalLock(home, { version: 2, packages: 'nope' })), /packages must be an array/);
  assert.throws(() => validateLock(globalLock(home, { version: 2, packages: [pkg('acme'), pkg('beta'), pkg('acme')] })),
    /packages\[2\]\.id.*duplicate/);
  // writeLock refuses the same document before touching the file
  assert.throws(() => writeLock(globalScope(home), globalLock(home, { packages: [pkg('acme', { enabled: 1 })] })), /packages\[0\]\.enabled/);
  assert.equal(fs.existsSync(lockPath(globalScope(home))), false);
});

test('a project-scope lock with a packages key is refused, empty or not, on validate, write and read', (t) => {
  const project = scratch(t);
  for (const packages of [[pkg('acme')], []]) {
    const lock = { ...sampleLock(project), packages };
    assert.throws(() => validateLock(lock), /packages/);
    assert.throws(() => writeLock(projectScope(project), lock), /packages/);
  }
  assert.equal(fs.existsSync(lockPath(projectScope(project))), false);
  fs.mkdirSync(path.dirname(lockPath(projectScope(project))), { recursive: true });
  fs.writeFileSync(lockPath(projectScope(project)), JSON.stringify({ ...sampleLock(project), version: 2, packages: [pkg('acme')] }));
  assert.throws(() => readLock(projectScope(project)), /Cannot read doflow\.lock.*packages/);
});

test('diffLocks compares packages by id on version, digests and enabled', (t) => {
  const home = scratch(t);
  const before = globalLock(home, { packages: [pkg('acme'), pkg('beta')] });
  assert.equal(diffLocks(before, before).clean, true);
  assert.deepEqual(diffLocks(before, before).packages, { added: [], removed: [], changed: [] });

  const changed = (overrides) => diffLocks(before, globalLock(home, { packages: [pkg('acme', overrides), pkg('beta')] }));
  for (const overrides of [{ contentDigest: D3 }, { capabilityDigest: D3 }, { version: '1.3.0' }, { enabled: true }]) {
    const diff = changed(overrides);
    assert.deepEqual(diff.packages.changed.map((row) => row.id), ['acme'], JSON.stringify(overrides));
    assert.equal(diff.clean, false, JSON.stringify(overrides));
  }
  // addedAt and source are record keeping, not drift
  assert.equal(changed({ addedAt: '2027-01-01T00:00:00.000Z' }).clean, true);
  assert.equal(changed({ source: { type: 'local', path: '/elsewhere' } }).clean, true);

  const grown = diffLocks(before, globalLock(home, { packages: [pkg('acme'), pkg('beta'), pkg('gamma')] }));
  assert.deepEqual(grown.packages.added.map((row) => row.id), ['gamma']);
  const shrunk = diffLocks(before, globalLock(home, { packages: [pkg('acme')] }));
  assert.deepEqual(shrunk.packages.removed.map((row) => row.id), ['beta']);
  assert.equal(shrunk.clean, false);
  // a lock without the section reads as an empty one
  assert.deepEqual(diffLocks(globalLock(home), globalLock(home, { packages: [] })).clean, true);
  assert.equal(diffLocks(globalLock(home), before).packages.added.length, 2);
});
