'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry/index.ts');
const { lockDocument, lockDelta, recordLock } = require('../../src/lifecycle/view.ts');
const { readLock, lockPath, defaultLock } = require('../../src/state/lockfile.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');

function scratch(t: any) { return tempDir(t, 'doflow-lockview-'); }
const projectArgs = (project: any) => ({ scope: 'project', projectRoot: project });
/** A ledger as a run leaves it, holding one resource for each named harness. */
const holding = (...harnesses: any[]) => ({ resources: harnesses.map((harness: string) => ({ harness, kind: 'skill' })) });

test('L1: lockDocument pins per-harness asset selections with native dirs, a row per planned MCP-capable target, [] included', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const doc = lockDocument({
    registry, scope: 'project', scopeRoot: project, ledger: holding('claude', 'codex', 'gemini'), plannedTargets: ['codex', 'claude', 'gemini'],
    mcpSelections: { claude: ['context7'], codex: [] },
    now: new Date('2026-08-22T00:00:00Z'),
  });
  assert.deepEqual(doc.targets.map((t: any) => t.harness), ['claude', 'codex', 'gemini']);
  assert.equal(doc.version, 1);
  assert.equal(doc.generatedAt, '2026-08-22T00:00:00.000Z');

  const ids = new Set(doc.assets.filter((a: any) => a.kind === 'skill').map((a: any) => a.id));
  assert.ok(ids.has('skills.doflow'));
  // The same shared asset appears once per targeting harness, each with that harness's native dir.
  const skillRows = doc.assets.filter((a: any) => a.id === 'skills.doflow');
  assert.equal(skillRows.length, 3);
  // Codex's re-pathed projection (Codex scans .agents/skills, never .codex/skills) must be what
  // gets pinned — a lock recording the dead destination would make drift reviewable but wrong.
  assert.equal(skillRows.find((row: any) => row.nativeDir === '../.agents/skills')?.kind, 'skill');
  assert.equal(skillRows.find((row: any) => row.nativeDir === 'skills')?.kind, 'skill');
  assert.ok(skillRows.every((row: any) => row.nativeDir), 'every pinned asset row records where it lands');

  // An empty selection is a recorded choice of none; gemini takes no servers, so it has no row.
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'], codex: [] });
});

test('L5: a run planning codex keeps the prior claude pin and its row, and drops a row for a harness the lock never pinned', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'claude' }],
    mcpSelections: { claude: ['context7'], kiro: ['context7'] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('claude', 'codex', 'kiro'),
    plannedTargets: ['codex'], mcpSelections: { codex: ['sequential-thinking'] } });
  assert.deepEqual(doc.targets.map((t: any) => t.harness), ['claude', 'codex']);
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'], codex: ['sequential-thinking'] });
  assert.ok(doc.assets.some((asset: any) => asset.nativeDir === '../.agents/skills'), 'codex assets are recomputed too');
});

test('L6: a prior target the ledger no longer holds is dropped with its row', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'claude' }, { harness: 'kiro' }],
    mcpSelections: { claude: ['context7'], kiro: [] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('claude'), plannedTargets: ['claude'] });
  assert.deepEqual(doc.targets.map((t: any) => t.harness), ['claude']);
  assert.deepEqual(doc.mcpSelections, { claude: ['context7'] });
});

test('L7: a remove-style call keeps every harness the ledger still holds, with its row', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const previous = { ...defaultLock({ scope: 'project', scopeRoot: project }), targets: [{ harness: 'codex' }, { harness: 'kiro' }],
    mcpSelections: { codex: ['sequential-thinking'], kiro: ['context7'] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding('codex') });
  assert.deepEqual(doc.targets.map((t: any) => t.harness), ['codex']);
  assert.deepEqual(doc.mcpSelections, { codex: ['sequential-thinking'] });
});

test('L8: with no pinned harness left lockDocument is null, and recordLock removes the file', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const args = projectArgs(project);
  const previous = lockDocument({ registry, scope: 'project', scopeRoot: project, ledger: holding('codex'), plannedTargets: ['codex'] });
  recordLock(args, previous);
  const next = lockDocument({ registry, scope: 'project', scopeRoot: project, previous, ledger: holding() });
  assert.equal(next, null);
  assert.deepEqual(recordLock(args, next), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(args)), false);
});

test('recordLock reports created -> unchanged -> changed, and removeLock clears', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const args = projectArgs(project);

  const pin = (harnesses: any) => lockDocument({ registry, scope: 'project', scopeRoot: project, previous: readLock(args), ledger: holding(...harnesses), plannedTargets: harnesses });
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

  const { removeLock } = require('../../src/state/lockfile.ts');
  assert.equal(removeLock(args), true);
  assert.equal(removeLock(args), false, 'clearing twice is a no-op');
  assert.equal(fs.existsSync(lockPath(args)), false);
});

test('recordLock tolerates a pre-existing legacy-free empty directory (defaultLock shape)', (t) => {
  const project = scratch(t);
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  const registry = loadRegistry({ repoRoot: REPO });
  const result = recordLock(projectArgs(project),
    { ...defaultLock({ scope: 'project', scopeRoot: project }), generatedAt: 'x', sourceVersion: null, targets: [], assets: [], mcpSelections: {} });
  assert.deepEqual(result, { changed: true, summary: 'created' });
});

test('recordLock leaves an unchanged lock byte for byte on a re-run', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const args = projectArgs(project);
  const pin = (now: any) => lockDocument({
    registry, scope: 'project', scopeRoot: project, previous: readLock(args), ledger: holding('claude', 'codex'), plannedTargets: ['claude', 'codex'],
    mcpSelections: { claude: ['context7'], codex: [] }, now,
  });
  recordLock(args, pin(new Date('2026-10-01T00:00:00Z')));
  const bytes = fs.readFileSync(lockPath(args));
  // A later timestamp is not a change: the file keeps the first run's bytes.
  assert.deepEqual(recordLock(args, pin(new Date('2026-10-02T00:00:00Z'))), { changed: false, summary: 'unchanged' });
  assert.deepEqual(fs.readFileSync(lockPath(args)), bytes);
});

test('lockDelta names created, unchanged, cleared and counted changes', (t) => {
  const project = scratch(t);
  const base = { ...defaultLock({ scope: 'project', scopeRoot: project }), sourceVersion: '1', targets: [{ harness: 'claude' }] };
  assert.deepEqual(lockDelta(null, base), { changed: true, summary: 'created' });
  assert.deepEqual(lockDelta(base, { ...base, generatedAt: 'later' }), { changed: false, summary: 'unchanged' });
  assert.deepEqual(lockDelta(base, null), { changed: true, summary: 'cleared' });
  assert.deepEqual(lockDelta(null, null), { changed: false, summary: 'unchanged' });
  assert.deepEqual(lockDelta(base, { ...base, mcpSelections: { claude: [] } }), { changed: true, summary: '1 change(s)' });
});

test('recordLock with no lock to pin removes the file, and is silent when there was none', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const project = scratch(t);
  const args = projectArgs(project);
  recordLock(args, lockDocument({ registry, scope: 'project', scopeRoot: project, ledger: holding('codex'), plannedTargets: ['codex'] }));
  assert.deepEqual(recordLock(args, null), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(args)), false);
  assert.deepEqual(recordLock(args, null), { changed: false, summary: 'unchanged' });
});

// ── packages survive an install, a remove and an update (122 IC-007) ─────────────────────────────
const globalArgs = (home: string) => ({ scope: 'global', homeDir: home });
const row = (id: string, overrides: any = {}) => ({
  id, version: '1.0.0', source: { type: 'local', path: `/abs/${id}` }, contentDigest: 'a'.repeat(64),
  capabilityDigest: 'b'.repeat(64), enabled: false, addedAt: '2026-10-24T09:00:00.000Z', ...overrides,
});
const withPackages = (home: string, packages: any[], targets: string[] = []) => ({
  ...defaultLock({ scope: 'global', scopeRoot: home }), generatedAt: 'x', sourceVersion: 'old',
  targets: targets.map((harness: string) => ({ harness })), packages,
});

test('P1: install keeps a recorded package, and a lock without packages gets no packages key', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const home = scratch(t);
  const previous = withPackages(home, [row('acme'), row('beta', { enabled: true })]);
  const doc: any = lockDocument({ registry, scope: 'global', scopeRoot: home, previous, ledger: holding('claude'), plannedTargets: ['claude'] });
  assert.deepEqual(doc.packages, previous.packages);
  assert.deepEqual(doc.targets, [{ harness: 'claude' }]);

  const bare = lockDocument({ registry, scope: 'global', scopeRoot: home, previous: { ...previous, packages: [] }, ledger: holding('claude'), plannedTargets: ['claude'] });
  assert.equal('packages' in bare, false);
  const none = lockDocument({ registry, scope: 'project', scopeRoot: home, ledger: holding('claude'), plannedTargets: ['claude'] });
  assert.equal('packages' in none, false);
});

test('P2: remove of the last harness leaves a packages-only lock, not a removed file; with no packages the file still goes', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const home = scratch(t);
  const args = globalArgs(home);
  recordLock(args, withPackages(home, [row('acme')], ['claude']));
  const next: any = lockDocument({ registry, scope: 'global', scopeRoot: home, previous: readLock(args), ledger: holding() });
  assert.deepEqual(next.targets, []);
  assert.deepEqual(next.assets, []);
  assert.deepEqual(next.mcpSelections, {});
  assert.deepEqual(next.packages, [row('acme')]);
  assert.equal(recordLock(args, next).changed, true);
  const kept: any = readLock(args);
  assert.equal(kept.version, 2);
  assert.deepEqual(kept.targets, []);
  assert.deepEqual(kept.packages, [row('acme')]);

  // a second identical remove is a no-op and the file keeps its bytes
  const bytes = fs.readFileSync(lockPath(args));
  const again: any = lockDocument({ registry, scope: 'global', scopeRoot: home, previous: readLock(args), ledger: holding() });
  assert.deepEqual(recordLock(args, again), { changed: false, summary: 'unchanged' });
  assert.deepEqual(fs.readFileSync(lockPath(args)), bytes);

  // the earlier L8 behaviour is unchanged for a lock holding no packages
  const lone = scratch(t);
  recordLock(globalArgs(lone), withPackages(lone, [], ['claude']));
  const gone: any = lockDocument({ registry, scope: 'global', scopeRoot: lone, previous: readLock(globalArgs(lone)), ledger: holding() });
  assert.equal(gone, null);
  assert.deepEqual(recordLock(globalArgs(lone), gone), { changed: true, summary: 'cleared' });
  assert.equal(fs.existsSync(lockPath(globalArgs(lone))), false);
});

test('P3: lockDelta counts package changes, and a pinned-only re-run leaves the packages and the file alone', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const home = scratch(t);
  const base = withPackages(home, [row('acme')], ['claude']);
  assert.deepEqual(lockDelta(base, base), { changed: false, summary: 'unchanged' });
  assert.deepEqual(lockDelta(base, { ...base, packages: [row('acme', { enabled: true })] }), { changed: true, summary: '1 change(s)' });
  assert.deepEqual(lockDelta(base, { ...base, packages: [row('acme'), row('beta')] }), { changed: true, summary: '1 change(s)' });
  assert.deepEqual(lockDelta(base, { ...base, packages: [] }), { changed: true, summary: '1 change(s)' });
  const { packages: _none, ...bare } = base;
  assert.deepEqual(lockDelta({ ...bare, packages: [] }, bare), { changed: false, summary: 'unchanged' }, 'absent and empty are the same list');

  const args = globalArgs(home);
  const pin = (now: Date) => lockDocument({ registry, scope: 'global', scopeRoot: home, previous: readLock(args), ledger: holding('claude'), plannedTargets: ['claude'], now });
  recordLock(args, { ...pin(new Date('2026-10-01T00:00:00Z')), packages: [row('acme')] });
  const bytes = fs.readFileSync(lockPath(args));
  assert.deepEqual(recordLock(args, pin(new Date('2026-10-02T00:00:00Z'))), { changed: false, summary: 'unchanged' });
  assert.deepEqual(fs.readFileSync(lockPath(args)), bytes);
  assert.deepEqual(readLock(args).packages, [row('acme')]);
});
