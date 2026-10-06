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
/** A ledger as a run leaves it, holding one resource for each named harness. */
const holding = (...harnesses) => ({ resources: harnesses.map((harness) => ({ harness, kind: 'skill' })) });

test('L1: lockDocument pins per-harness asset selections with native dirs, a row per planned MCP-capable target, [] included', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const doc = lockDocument({
    registry, scope: 'project', scopeRoot: project, ledger: holding('claude', 'codex', 'gemini'), plannedTargets: ['codex', 'claude', 'gemini'],
    mcpSelections: { claude: ['context7'], codex: [] },
    now: new Date('2026-08-22T00:00:00Z'),
  });
  assert.deepEqual(doc.targets.map((t) => t.harness), ['claude', 'codex', 'gemini']);
  assert.equal(doc.version, 1);
  assert.equal(doc.generatedAt, '2026-08-22T00:00:00.000Z');

  const ids = new Set(doc.assets.filter((a) => a.kind === 'skill').map((a) => a.id));
  assert.ok(ids.has('skills.doflow'));
  // The same shared asset appears once per targeting harness, each with that harness's native dir.
  const skillRows = doc.assets.filter((a) => a.id === 'skills.doflow');
  assert.equal(skillRows.length, 3);
  // Codex's re-pathed projection (Codex scans .agents/skills, never .codex/skills) must be what
  // gets pinned — a lock recording the dead destination would make drift reviewable but wrong.
  assert.equal(skillRows.find((row) => row.nativeDir === '../.agents/skills')?.kind, 'skill');
  assert.equal(skillRows.find((row) => row.nativeDir === 'skills')?.kind, 'skill');
  assert.ok(skillRows.every((row) => row.nativeDir), 'every pinned asset row records where it lands');

  // An empty selection is a recorded choice of none; gemini takes no servers, so it has no row.
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'], codex: [] });
});

test('L5: a run planning codex keeps the prior claude pin and its row, and drops a row for a harness the lock never pinned', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'claude' }],
    mcpSelections: { claude: ['context7'], kiro: ['context7'] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('claude', 'codex', 'kiro'),
    plannedTargets: ['codex'], mcpSelections: { codex: ['sequential-thinking'] } });
  assert.deepEqual(doc.targets.map((t) => t.harness), ['claude', 'codex']);
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'], codex: ['sequential-thinking'] });
  assert.ok(doc.assets.some((asset) => asset.nativeDir === '../.agents/skills'), 'codex assets are recomputed too');
});

test('L6: a prior target the ledger no longer holds is dropped with its row', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'claude' }, { harness: 'kiro' }],
    mcpSelections: { claude: ['context7'], kiro: [] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('claude'), plannedTargets: ['claude'] });
  assert.deepEqual(doc.targets.map((t) => t.harness), ['claude']);
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'] });
});

test('L7: a remove-style call keeps every harness the ledger still holds, with its row', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'codex' }, { harness: 'kiro' }],
    mcpSelections: { codex: ['sequential-thinking'], kiro: ['context7'] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('codex') });
  assert.deepEqual(doc.targets.map((t) => t.harness), ['codex']);
  assert.deepEqual(doc.mcpSelections, { codex: ['sequential-thinking'] });
});

test('L8: with no pinned harness left lockDocument is null, and recordLock removes the file', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const args = projectArgs(project);
  const previous = lockDocument({ registry, scope: 'project', scopeRoot: project, ledger: holding('codex'), plannedTargets: ['codex'] });
  recordLock(args, previous);
  const next = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding() });
  assert.equal(next, null);
  assert.deepEqual(recordLock(args, next), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(args)), false);
});

test('recordLock reports created -> unchanged -> changed, and removeLock clears', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch();
  const args = projectArgs(project);

  const pin = (harnesses) => lockDocument({ registry, scope: 'project', scopeRoot: project, previous: readLock(args), ledger: holding(...harnesses), plannedTargets: harnesses });
  const first = recordLock(args, pin(['codex']));
  assert.deepEqual(first, { changed: true, summary: 'created' });

  const again = recordLock(args, pin(['codex']));
  assert.deepEqual(again, { changed: false, summary: 'unchanged' }, 'identical re-pins must not manufacture noise');

  const grown = recordLock(args, pin(['kiro', 'codex']));
  assert.equal(grown.changed, true);
  assert.match(grown.summary, /^\d+ change\(s\)$/); // kiro target row plus its asset rows

  // Codex's last resource is gone from the ledger, so its pin goes with it.
  const shrunk = recordLock(args, pin(['kiro']));
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
    registry, scope: 'project', scopeRoot: project, previous: readLock(args), ledger: holding('claude', 'codex'), plannedTargets: ['claude', 'codex'],
    mcpSelections: { claude: ['context7'], codex: [] }, now,
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
  recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, ledger: holding('codex'), plannedTargets: ['codex'] }));
  assert.deepEqual(recordLock(args, null), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(args)), false);
  assert.deepEqual(recordLock(args, null), { changed: false, summary: 'unchanged' });
});
