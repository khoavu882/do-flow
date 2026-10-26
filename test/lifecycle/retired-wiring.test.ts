'use strict';

// retired-wiring.test.ts — row 127 IC-003 wiring and IC-004: the retirement sweep inside the
// lifecycle (plan, apply, ledger, backup and rollback), retired rows as non-claimants, the lock and
// reconcile pinning only live harnesses, and antigravity's plan unchanged by retired rows (FR-7).
// The retired id is a synthetic `oldtool` replaced by `antigravity` (plan.md T-127-A3); the real
// registry is used where a real adapter plans, with that record added to its `retired` list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registryModule = require('../../src/registry/index.ts');
const { createAdapterRegistry } = require('../../src/adapters/index.ts');
const { ownershipKey, stateRoot, writeLedger, readLedger, ledgerPath } = require('../../src/state/index.ts');
const { readLock, writeLock } = require('../../src/state/lockfile.ts');
const { planLifecycle, applyLifecycle, removeLifecycle } = require('../../src/lifecycle/index.ts');
const { backupSetFromPlan } = require('../../src/install/backup-set.ts');
const { createFileBackup, planRestore, executeRestore } = require('../../src/install/backup.ts');
const { buildRetiredLedger, retiredRecord, USER_TEXT, sha } = require('../helper/retired-ledger.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');

// The CLI commands below load the registry themselves; this file's process sees the shipped registry
// with `oldtool` retired, which is the only way to reach them with a retired id while gemini is live.
// Patched before any command module is required, since they destructure loadRegistry when loaded.
const shippedLoadRegistry = registryModule.loadRegistry;
registryModule.loadRegistry = (options: any) => ({ ...shippedLoadRegistry(options), retired: [retiredRecord()] });
const realRegistry = () => registryModule.loadRegistry({ repoRoot: REPO });
const cmdInstall = require('../../src/cli/commands/install.ts');
const cmdReconcile = require('../../src/cli/commands/reconcile.ts');
const cmdStatus = require('../../src/cli/commands/status.ts');
const cmdRollback = require('../../src/cli/commands/rollback.ts');
const { listBackups } = require('../../src/install/backup.ts');
const { doflowPaths } = require('../../src/install/paths.ts');
const { lockDocument, registryLifecycleView } = require('../../src/lifecycle/view.ts');

// ------------------------------------------------------------------ a fake antigravity

/** The fixture's registry (antigravity live, oldtool retired) with one asset antigravity owns. */
function fakeRegistry(fixture: any) {
  return {
    ...fixture.registry,
    harnesses: [{ id: 'antigravity', displayName: 'antigravity', adapter: 'antigravity', scopes: ['project', 'user'], nativeTargets: {},
      capabilities: { instructions: { status: 'supported' } } }],
    assets: [{ id: 'guidance.context-layer', kind: 'guidance', source: 'ignored', appliesTo: ['antigravity'], ownership: 'managed-tree',
      projection: { antigravity: { renderer: 'copy-tree', capability: 'instructions' } } }],
    mcp: [], lifecycle: [],
  };
}

/** Antigravity holding the fixture's shared file: current on install/update (no change, or one
 * rewrite when `write`), removing it on remove. Its verifier reports the file while it exists. */
function fakeAntigravity(fixture: any, { write = false, throwOnApply = false }: any = {}) {
  const row = fixture.rows.sharedLive;
  const change = (operation: string) => ({ assetId: row.assetId, target: row.target, identity: row.identity, kind: 'copy-tree-file',
    operation, ownershipIdentity: row.ownershipIdentity, afterFingerprint: row.fingerprint, sourceVersion: 'test', projection: { renderer: 'copy-tree' } });
  return {
    discover() { return {}; },
    render() { return 'native'; },
    plan({ context = {} }: any) {
      if (context.operation === 'remove') return { changes: [change('remove')] };
      return { changes: write ? [change('update')] : [] };
    },
    apply() { if (throwOnApply) throw new Error('antigravity apply failed'); },
    remove({ changes }: any) { for (const item of changes) fs.rmSync(item.target, { force: true }); },
    verify() {
      const resources = fs.existsSync(row.target) ? [{ ...row }] : [];
      return { ok: true, statuses: [], resources };
    },
  };
}

function setup(t: any, adapterOptions: any = {}) {
  const root = tempDir(t, 'doflow-retired-wiring-');
  const fixture = buildRetiredLedger({ root });
  const registry = fakeRegistry(fixture);
  const adapters = createAdapterRegistry({ antigravity: fakeAntigravity(fixture, adapterOptions) });
  const state = stateRoot({ scope: 'global', homeDir: root });
  return { root, fixture, registry, adapters, state };
}

const plan = (s: any, operation = 'update') => planLifecycle({ registry: s.registry, adapters: s.adapters, scope: 'global', scopeRoot: s.root,
  targets: ['antigravity'], ledger: s.fixture.ledger, context: { operation } });
const apply = (s: any, lifecyclePlan: any, extra: any = {}) => applyLifecycle({ plan: lifecyclePlan, registry: s.registry, adapters: s.adapters,
  stateRoot: s.state, ledger: s.fixture.ledger, hasBashCapableShellFn: () => true, ...extra });
const oldtoolRows = (ledger: any) => ledger.resources.filter((row: any) => row.harness === 'oldtool');

// ------------------------------------------------------------------ plan and apply

test('an update of a current install whose ledger also holds retired rows applies the retirement, not refuses it', (t) => {
  const s = setup(t);
  const p = plan(s);
  assert.deepEqual(p.targets.map((target: any) => target.harness), ['antigravity'], 'the retired id is never a plan target');
  assert.equal(p.targets[0].changes.length, 0, 'antigravity itself is current');
  assert.equal(p.retiredHarnesses.length, 1);
  assert.equal(p.changes.length, oldtoolRows(s.fixture.ledger).length, 'one retired change per oldtool row, appended to plan.changes');
  assert.ok(p.changes.every((change: any) => change.retired === true));

  const result = apply(s, p);
  assert.ok(!fs.existsSync(s.fixture.targets.agent));
  for (const script of Object.values<string>(s.fixture.targets.scripts)) assert.ok(!fs.existsSync(script), script);
  assert.equal(fs.readFileSync(s.fixture.targets.instructions, 'utf8'), USER_TEXT);
  assert.equal(fs.readFileSync(s.fixture.targets.shared, 'utf8'), '# core\n', 'the file antigravity still claims stays');
  assert.deepEqual(oldtoolRows(result.ledger), [], 'every retired row leaves the ledger');
  assert.ok(result.ledger.resources.some((row: any) => ownershipKey(row) === ownershipKey(s.fixture.rows.sharedLive)), 'antigravity keeps its row');
  assert.equal(result.ledger.targets.oldtool, undefined, 'targets.<retired id> is deleted');
  assert.ok(result.ledger.targets.antigravity);
  assert.deepEqual(readLedger(s.state), result.ledger);

  // Idempotent: the next plan over that ledger has no retirement in it.
  const again = planLifecycle({ registry: s.registry, adapters: s.adapters, scope: 'global', scopeRoot: s.root, targets: ['antigravity'],
    ledger: result.ledger, context: { operation: 'update' } });
  assert.equal(again.retiredHarnesses, undefined);
  assert.equal(again.changes.length, 0);
});

test('the retirement runs first and a later failure records it as completed', (t) => {
  const s = setup(t, { write: true, throwOnApply: true });
  const records: any[] = [];
  const writeRecoveryRecordFn = (_root: any, record: any) => { records.push(record); return { id: 'r1', record: { ...record, id: 'r1' } }; };
  assert.throws(() => apply(s, plan(s), { writeRecoveryRecordFn }), /antigravity apply failed/);
  const failed = records.find((record) => record.status === 'failed');
  assert.deepEqual(failed.completedHarnesses, ['retired:oldtool']);
  assert.ok(!fs.existsSync(s.fixture.targets.agent), 'the retirement was applied before antigravity');
  assert.ok(records[0].changes.some((change: any) => change.retired), 'the pending record lists the retired changes');
});

test('remove does not sweep retired rows', (t) => {
  const s = setup(t);
  const p = planLifecycle({ registry: s.registry, adapters: s.adapters, scope: 'global', scopeRoot: s.root, targets: ['antigravity'],
    ledger: s.fixture.ledger, context: { operation: 'remove' } });
  assert.equal(p.retiredHarnesses, undefined);
  assert.ok(p.changes.every((change: any) => !change.retired));
});

test('control: remove -t antigravity deletes a shared file whose only other claimant is a retired row, and leaves the retired rows', (t) => {
  const s = setup(t);
  const result = removeLifecycle({ registry: s.registry, adapters: s.adapters, scope: 'global', scopeRoot: s.root, targets: ['antigravity'],
    ledger: s.fixture.ledger, stateRoot: s.state, hasBashCapableShellFn: () => true });
  assert.ok(!fs.existsSync(s.fixture.targets.shared), 'the retired row did not keep the file');
  assert.deepEqual(result.retained, []);
  assert.ok(fs.existsSync(s.fixture.targets.agent), 'nothing of the retired harness was swept');
  assert.equal(oldtoolRows(result.ledger).length, oldtoolRows(s.fixture.ledger).length, 'the retired rows stay for the next install or update');
});

test('control: a ledger with no retired rows plans exactly as before — no retiredHarnesses key, live changes only', (t) => {
  const s = setup(t, { write: true });
  const liveOnly = { ...s.fixture.ledger, resources: s.fixture.ledger.resources.filter((row: any) => row.harness !== 'oldtool') };
  const p = planLifecycle({ registry: s.registry, adapters: s.adapters, scope: 'global', scopeRoot: s.root, targets: ['antigravity'],
    ledger: liveOnly, context: { operation: 'update' } });
  assert.ok(!('retiredHarnesses' in p));
  assert.deepEqual(p.changes, p.targets.flatMap((target: any) => target.changes));
});

// ------------------------------------------------------------------ backup and rollback

test('the backup set holds every deleted and stripped target, and rollback restores them byte for byte', (t) => {
  const s = setup(t);
  writeLedger(s.state, s.fixture.ledger);
  const backupRoot = path.join(s.root, '.doflow', 'backups');
  const p = plan(s);
  const set = backupSetFromPlan({ plan: p, scope: 'global', scopeRoot: s.root, exclude: [backupRoot, s.state], records: [ledgerPath(s.state)] });
  const touched = [s.fixture.targets.agent, ...Object.values<string>(s.fixture.targets.scripts), s.fixture.targets.instructions, s.fixture.targets.settings];
  const backedUp = new Set(set.entries.map((entry: any) => entry.path));
  for (const file of touched) assert.ok(backedUp.has(path.resolve(file)), `backed up: ${file}`);
  assert.ok(!backedUp.has(path.resolve(s.fixture.targets.shared)), 'a released file is not backed up');
  const before = new Map(touched.map((file) => [file, fs.readFileSync(file)]));

  const backup = createFileBackup({ operation: 'update', set, backupRoot, repoRoot: REPO, sourceCommit: 'test', version: 'test', date: new Date('2026-10-26T10:00:00') });
  apply(s, p);
  assert.ok(!fs.existsSync(s.fixture.targets.agent));

  const restore = planRestore({ bid: backup.id, backupRoot, scope: 'global', scopeRoot: s.root, targets: [], explicitTargets: false, dirs: {}, ledgerFile: ledgerPath(s.state) });
  const outcome = executeRestore(restore, { backupRoot });
  assert.deepEqual(outcome.failed, []);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `restored: ${file}`);
  const restoredRows = oldtoolRows(readLedger(s.state)).map(ownershipKey).sort();
  const expected = oldtoolRows(s.fixture.ledger).filter((row: any) => backedUp.has(path.resolve(row.target))).map(ownershipKey).sort();
  assert.deepEqual(restoredRows, expected, 'the rows of the restored files come back with them');
});

// ------------------------------------------------------------------ lock (IC-004)

test('lockDocument drops a previous pin of a retired id without throwing, and pins nothing when only it remains', () => {
  const registry = realRegistry();
  const scopeRoot = '/scratch/project';
  const ledger = { resources: [{ harness: 'oldtool', kind: 'skill' }, { harness: 'claude', kind: 'skill' }] };
  const previous = { version: 1, scope: 'project', scopeRoot, targets: [{ harness: 'oldtool' }, { harness: 'claude' }], assets: [], mcpSelections: { oldtool: [] } };
  const doc = lockDocument({ registry, scope: 'project', scopeRoot, previous, ledger, plannedTargets: [] });
  assert.deepEqual(doc.targets, [{ harness: 'claude' }]);
  assert.equal(doc.mcpSelections.oldtool, undefined);
  assert.equal(lockDocument({ registry, scope: 'project', scopeRoot, previous: { ...previous, targets: [{ harness: 'oldtool' }] },
    ledger: { resources: [{ harness: 'oldtool', kind: 'skill' }] }, plannedTargets: [] }), null);
});

// ------------------------------------------------------------------ the real CLI and a real adapter

/** A scratch HOME and project with antigravity installed in it by the real install command. */
function installedProject(t: any) {
  const home = tempDir(t, 'doflow-retired-home-');
  const project = tempDir(t, 'doflow-retired-project-');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  const lines: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'log', (...args: any[]) => { lines.push(args.join(' ')); });
  t.mock.method(console, 'error', (...args: any[]) => { errors.push(args.join(' ')); });
  const options = (extra: any = {}) => ({ positional: [project], targets: [], mcp: null, dryRun: false, force: true, adopt: false,
    noBackup: true, prune: null, global: false, json: false, ...extra });
  cmdInstall(options({ targets: ['antigravity'] }));
  lines.length = 0;
  errors.length = 0;
  return { home, project, lines, errors, options, state: stateRoot({ scope: 'project', projectRoot: project }) };
}

/** The fixture's oldtool rows under `project`, the shared one moved onto a file antigravity installed. */
function addRetiredRows(project: string, state: string) {
  const shared = path.join(project, '.doflow', 'guidance', 'PRINCIPLES.md');
  const installed = fs.readFileSync(shared);
  const fixture = buildRetiredLedger({ root: project, scope: 'project' });
  fs.rmSync(fixture.targets.shared);   // the fixture's own stand-in for a shared file, which no row here names
  const ledger = readLedger(state);
  const sharedRow = { ...fixture.rows.shared, target: shared, identity: 'PRINCIPLES.md', fingerprint: sha(installed),
    ownershipIdentity: 'doflow:oldtool:copy-tree:guidance.context-layer:PRINCIPLES.md' };
  const rows = [sharedRow, fixture.rows.agent, ...fixture.rows.scripts, fixture.rows.instructions, fixture.rows.settings];
  writeLedger(state, { ...ledger, resources: [...ledger.resources, ...rows], targets: { ...ledger.targets, oldtool: { installed: true } } });
  return { fixture, rows, shared, installed };
}

test('reconcile with a lock pinning a retired id warns, drops it and converges the rest, retirement included', (t) => {
  const s = installedProject(t);
  const { fixture, shared, installed } = addRetiredRows(s.project, s.state);
  const lockArgs = { scope: 'project', projectRoot: s.project };
  const lock = readLock(lockArgs);
  writeLock(lockArgs, { ...lock, targets: [...lock.targets, { harness: 'oldtool' }] });
  const liveRows = readLedger(s.state).resources.filter((row: any) => row.harness === 'antigravity').length;

  cmdReconcile(s.options());
  assert.ok(s.lines.includes('[WARN] oldtool: retired (use antigravity); dropped from the pinned targets'), s.lines.join('\n'));
  assert.ok(!s.lines.some((line) => line.includes('oldtool: installed')), 'a retired harness is not reported as unpinned');
  assert.ok(s.lines.includes('[INFO] antigravity: clean'), s.lines.join('\n'));
  assert.ok(s.lines.includes('[RETIRED] oldtool → antigravity: deleted 8, stripped 2, released 1, kept 0'), s.lines.join('\n'));
  assert.ok(s.lines.some((line) => line.startsWith('[OK] Reconciliation complete')), s.lines.join('\n'));
  assert.notEqual(process.exitCode, 1);

  const after = readLedger(s.state);
  assert.deepEqual(oldtoolRows(after), []);
  assert.equal(after.targets.oldtool, undefined);
  assert.equal(after.resources.filter((row: any) => row.harness === 'antigravity').length, liveRows, 'antigravity rows untouched');
  assert.deepEqual(fs.readFileSync(shared), installed, 'the shared file stays');
  assert.ok(!fs.existsSync(fixture.targets.agent));
  assert.equal(fs.readFileSync(fixture.targets.instructions, 'utf8'), USER_TEXT);
});

test('reconcile with a lock pinning only a retired id says nothing is pinned', (t) => {
  const s = installedProject(t);
  const lockArgs = { scope: 'project', projectRoot: s.project };
  writeLock(lockArgs, { ...readLock(lockArgs), targets: [{ harness: 'oldtool' }] });
  cmdReconcile(s.options());
  assert.deepEqual(s.lines.slice(0, 2), [
    '[WARN] oldtool: retired (use antigravity); dropped from the pinned targets',
    '[WARN] antigravity: installed (ledger holds ' + readLedger(s.state).resources.length + ' resource(s)) but absent from doflow.lock; reconcile does not converge it.',
  ]);
  assert.ok(s.lines.some((line) => line.startsWith('[INFO] No doflow.lock in this scope')), s.lines.join('\n'));
});

test('status names a retired harness the ledger still holds rows of, and nothing when it holds none', (t) => {
  const s = installedProject(t);
  cmdStatus(s.options({ targets: ['antigravity'] }));
  assert.ok(!s.lines.some((line) => line.includes('Retired harness')), s.lines.join('\n'));
  const { rows } = addRetiredRows(s.project, s.state);
  s.lines.length = 0;
  cmdStatus(s.options({ targets: ['antigravity'] }));
  assert.ok(s.lines.includes(`  Retired harness:      oldtool (use antigravity): ${rows.length} ledger row(s); the next 'doflow install' or 'doflow update' in this scope releases them`), s.lines.join('\n'));
  assert.ok(s.lines.includes('  Antigravity verification:verified'), 'the live harness is judged on its own plan');
  assert.ok(s.lines.includes(`  Registry lifecycle:   ${rows.length} pending, 0 conflict(s)`), 'the pending retirement is counted');
});

test('rollback of a sweep backup restores the retired files and rows byte for byte, and names no retired id', (t) => {
  const s = installedProject(t);
  const { fixture } = addRetiredRows(s.project, s.state);
  const touched = [fixture.targets.agent, ...Object.values<string>(fixture.targets.scripts), fixture.targets.instructions, fixture.targets.settings];
  const before = new Map(touched.map((file) => [file, fs.readFileSync(file)]));
  const rowsBefore = oldtoolRows(readLedger(s.state)).filter((row: any) => touched.includes(row.target)).map((row: any) => JSON.stringify(row)).sort();
  const paths = doflowPaths({ scopeRoot: s.project });

  cmdInstall(s.options({ targets: ['antigravity'], noBackup: false }));
  assert.ok(!fs.existsSync(fixture.targets.agent), 'the install swept the retired files');
  const [backup] = listBackups(paths.backupRoot);
  assert.ok(backup, 'the sweep took a backup');

  const cwd = process.cwd();
  process.chdir(s.project);
  t.after(() => process.chdir(cwd));
  s.errors.length = 0;
  s.lines.length = 0;
  cmdRollback({ positional: [backup.id], targets: [], dryRun: false, force: true, global: false });

  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `restored: ${file}`);
  const rowsAfter = oldtoolRows(readLedger(s.state)).map((row: any) => JSON.stringify(row)).sort();
  assert.deepEqual(rowsAfter, rowsBefore, 'the rows of the restored files come back byte for byte');
  const output = [...s.errors, ...s.lines].join('\n');
  assert.ok(!output.includes('undefined'), output);
  assert.ok(!output.includes('oldtool'), output);
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
  assert.ok(!('oldtool' in manifest.tools), `manifest tools: ${Object.keys(manifest.tools)}`);
  assert.ok('antigravity' in manifest.tools, 'the live harness is still recorded');
});

test('FR-7: antigravity plans identically over a ledger with and without retired rows on its shared files', (t) => {
  const s = installedProject(t);
  const registry = realRegistry();
  const ledger = readLedger(s.state);
  // The real shape (design D2): the retired harness holds a row on every shared file antigravity holds.
  const shadow = ledger.resources.filter((row: any) => row.harness === 'antigravity' && row.kind === 'copy-tree-file')
    .map((row: any) => ({ ...row, harness: 'oldtool', ownershipIdentity: row.ownershipIdentity.replace('doflow:antigravity:', 'doflow:oldtool:') }));
  assert.ok(shadow.length > 10, `antigravity installed shared files (${shadow.length})`);
  const view = (operation: string) => registryLifecycleView({ registry, repoRoot: REPO, scope: { global: false, projectRoot: s.project },
    targets: ['antigravity'], operation });
  const live = (v: any) => {
    const target = v.plan.targets.find((item: any) => item.harness === 'antigravity');
    return JSON.stringify({ changes: target.changes, conflicts: target.conflicts, notices: target.notices, prerequisites: target.prerequisites,
      required: target.requiredNativeResources, planChanges: v.plan.changes.filter((change: any) => !change.retired), safe: v.plan.safe });
  };
  for (const operation of ['update', 'remove']) {
    writeLedger(s.state, ledger);
    const without = live(view(operation));
    writeLedger(s.state, { ...ledger, resources: [...ledger.resources, ...shadow], targets: { ...ledger.targets, oldtool: { installed: true } } });
    const withRetired = view(operation);
    // A boolean, not the two documents: each is about a megabyte of JSON.
    assert.ok(live(withRetired) === without, `${operation}: antigravity's plan is byte-identical`);
    if (operation === 'update') {
      assert.equal(withRetired.plan.retiredHarnesses[0].counts.released, shadow.length, 'every shadow row is released, none deleted');
      assert.equal(withRetired.plan.retiredHarnesses[0].counts.deleted, 0);
    } else {
      assert.equal(withRetired.plan.retiredHarnesses, undefined);
    }
  }
});
