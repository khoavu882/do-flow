'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry');
const { lockDocument, recordLock } = require('../../src/lifecycle/view');
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
