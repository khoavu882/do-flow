'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LOCK_VERSION, lockPath, defaultLock, validateLock, readLock, writeLock, diffLocks } = require('../../src/state/lockfile');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lock-')); }
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

test('lock paths are neutral and scope-specific under .doflow/', () => {
  const home = scratch();
  const project = scratch();
  assert.equal(lockPath(projectScope(project)), path.join(project, '.doflow', 'doflow.lock'));
  assert.equal(lockPath({ scope: 'global', homeDir: home }), path.join(home, '.doflow', 'doflow.lock'));
  assert.throws(() => lockPath({ scope: 'team', projectRoot: project }), /Invalid lock scope/);
});

test('lock writes atomically, round-trips, and is deterministically ordered', () => {
  const project = scratch();
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

test('validate rejects foreign versions and malformed shapes', () => {
  const project = scratch();
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

test('diffLocks reports added/removed/changed per section and a clean verdict', () => {
  const project = scratch();
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
