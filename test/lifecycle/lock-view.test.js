'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry');
const { lockDocument, lockDelta, recordLock } = require('../../src/lifecycle/view');
const { readLock, lockPath, defaultLock } = require('../../src/state/lockfile');

const REPO = path.resolve(__dirname, '..', '..');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lockview-')); }
const projectArgs = (project) => ({ scope: 'project', projectRoot: project });

test('lockDocument pins per-harness asset selections with native dirs and sorts targets', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const doc = lockDocument({
    registry, scope: 'project', scopeRoot: project, targets: ['codex', 'claude'],
    mcpSelections: { claude: ['context7'], codex: [], gemini: ['context7'] },
    now: new Date('2026-08-22T00:00:00Z'),
  });
  assert.deepEqual(doc.targets.map((t) => t.harness), ['claude', 'codex']);
  assert.equal(doc.version, 1);
  assert.equal(doc.generatedAt, '2026-08-22T00:00:00.000Z');

  const ids = new Set(doc.assets.filter((a) => a.kind === 'skill').map((a) => a.id));
  assert.ok(ids.has('skills.doflow'));
  // The same shared asset appears once per targeting harness, each with that harness's native dir.
  const skillRows = doc.assets.filter((a) => a.id === 'skills.doflow');
  assert.equal(skillRows.length, 2);
  // Codex's re-pathed projection (Codex scans .agents/skills, never .codex/skills) must be what
  // gets pinned — a lock recording the dead destination would make drift reviewable but wrong.
  assert.equal(skillRows.find((row) => row.nativeDir === '../.agents/skills')?.kind, 'skill');
  assert.equal(skillRows.find((row) => row.nativeDir === 'skills')?.kind, 'skill');
  assert.ok(skillRows.every((row) => row.nativeDir), 'every pinned asset row records where it lands');

  // Empty selections are "chose none" and are dropped; selections for non-targets are dropped.
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'] });
});

test('recordLock reports created -> unchanged -> changed, and removeLock clears', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const args = projectArgs(project);

  const first = recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, targets: ['codex'] }));
  assert.deepEqual(first, { changed: true, summary: 'created' });

  const again = recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, targets: ['codex'] }));
  assert.deepEqual(again, { changed: false, summary: 'unchanged' }, 'identical re-pins must not manufacture noise');

  const grown = recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, targets: ['codex', 'kiro'] }));
  assert.equal(grown.changed, true);
  assert.match(grown.summary, /^\d+ change\(s\)$/); // kiro target row plus its asset rows

  const shrunk = recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, targets: ['kiro'] }));
  assert.equal(shrunk.changed, true);
  assert.ok(readLock(args).targets.length === 1);

  const { removeLock } = require('../../src/state/lockfile');
  assert.equal(removeLock(args), true);
  assert.equal(removeLock(args), false, 'clearing twice is a no-op');
  assert.equal(fs.existsSync(lockPath(args)), false);
});

test('recordLock tolerates a pre-existing legacy-free empty directory (defaultLock shape)', () => {
  const project = scratch();
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  const registry = loadRegistry({ repoRoot: REPO });
  const result = recordLock(projectArgs(project),
    { ...defaultLock({ scope: 'project', scopeRoot: project }), generatedAt: 'x', sourceVersion: null, targets: [], assets: [], mcpSelections: {} });
  assert.deepEqual(result, { changed: true, summary: 'created' });
});

test('recordLock leaves an unchanged lock byte for byte on a re-run', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const args = projectArgs(project);
  const pin = (now) => lockDocument({
    registry, scope: 'project', scopeRoot: project, targets: ['claude', 'codex'],
    mcpSelections: { claude: ['context7'] }, now,
  });
  recordLock(args, pin(new Date('2026-10-01T00:00:00Z')));
  const bytes = fs.readFileSync(lockPath(args));
  // A later timestamp is not a change: the file keeps the first run's bytes.
  assert.deepEqual(recordLock(args, pin(new Date('2026-10-02T00:00:00Z'))), { changed: false, summary: 'unchanged' });
  assert.deepEqual(fs.readFileSync(lockPath(args)), bytes);
});

test('lockDelta names created, unchanged, cleared and counted changes', () => {
  const project = scratch();
  const base = { ...defaultLock({ scope: 'project', scopeRoot: project }), sourceVersion: '1', targets: [{ harness: 'claude' }] };
  assert.deepEqual(lockDelta(null, base), { changed: true, summary: 'created' });
  assert.deepEqual(lockDelta(base, { ...base, generatedAt: 'later' }), { changed: false, summary: 'unchanged' });
  assert.deepEqual(lockDelta(base, null), { changed: true, summary: 'cleared' });
  assert.deepEqual(lockDelta(null, null), { changed: false, summary: 'unchanged' });
  assert.deepEqual(lockDelta(base, { ...base, mcpSelections: { claude: [] } }), { changed: true, summary: '1 change(s)' });
});

test('recordLock with no lock to pin removes the file, and is silent when there was none', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const args = projectArgs(project);
  recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, targets: ['codex'] }));
  assert.deepEqual(recordLock(args, null), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(args)), false);
  assert.deepEqual(recordLock(args, null), { changed: false, summary: 'unchanged' });
});
