'use strict';

// retired-handover.test.ts — row 127 IC-003 rule 3a and IC-007 through the lifecycle with the real
// antigravity adapter: a retired harness's global GEMINI.md section is handed over to antigravity in
// the same plan and apply (one write, one ledger write), deferred while antigravity is installed but
// not planned, and stripped when antigravity is absent or the file is project scope. The retired id
// is a synthetic `oldtool` replaced by `antigravity` (plan.md T-127-A5); the registry is the shipped
// one with that record retired.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRegistry } = require('../../src/registry/index.ts');
const { buildAdapterRegistry } = require('../../src/cli/shared.ts');
const { ownershipKey, stateRoot, writeLedger, readLedger, defaultLedger } = require('../../src/state/index.ts');
const { planLifecycle, applyLifecycle, markRetainedRemovals } = require('../../src/lifecycle/index.ts');
const { formatRetiredPlans } = require('../../src/lifecycle/retired-harnesses.ts');
const { lockDocument } = require('../../src/lifecycle/view.ts');
const { renderGuidancePointer } = require('../../src/adapters/guidance-pointer.ts');
const { MARKER_START, MARKER_END } = require('../../src/helper/marker-merge.ts');
const { retiredRecord } = require('../helper/retired-ledger.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const HANDOVER = { renderer: 'oldtool-instructions', scope: 'global', to: 'antigravity', surface: 'instruction' };
const BEFORE = '# My global notes\n\nKeep this.\n\n';
const AFTER = '\n## After the span\n\nAlso mine.\n';
/** The short marker pair the retired harness wrote, as the real ~/.gemini/GEMINI.md carries it. */
const LEGACY_START = '<!-- doflow:start -->';

const sha = (bytes: any): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** The shipped registry (antigravity is the only live harness declaring the global GEMINI.md) with
 * `oldtool` retired with the handover entry. */
function handoverRegistry() {
  return { ...loadRegistry({ repoRoot: REPO }), retired: [retiredRecord({ handover: [HANDOVER] })] };
}

/** Antigravity's section as a global install renders it. */
function antigravitySection(home: string): string {
  const body = fs.readFileSync(path.join(REPO, 'core', 'shared', 'guidance', 'pointers', 'codex.md'), 'utf8').trimEnd();
  return `${MARKER_START}\n${renderGuidancePointer(body, { scope: 'global', scopeRoot: home }).trimEnd()}\n${MARKER_END}\n`;
}

/**
 * A scratch HOME whose ~/.gemini/GEMINI.md holds the person's text around oldtool's span, and a
 * ledger holding oldtool's row on it (whole-file fingerprint, as the retired harness recorded it).
 * `installed` adds an antigravity row elsewhere (antigravity installed in the scope); `edited` changes
 * the person's text after the row was recorded; `markerless` replaces the whole file with the person's
 * text alone (no DoFlow markers left); `legacy` uses the short marker pair.
 */
function setup(t: any, { installed = false, edited = false, markerless = false, legacy = false, scope = 'global' }: any = {}) {
  const home = tempDir(t, 'doflow-handover-home-');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  const project = scope === 'project' ? tempDir(t, 'doflow-handover-project-') : home;
  const target = scope === 'project' ? path.join(project, 'GEMINI.md') : path.join(home, '.gemini', 'GEMINI.md');
  const span = `${legacy ? LEGACY_START : MARKER_START}\noldtool pointer\n${MARKER_END}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${BEFORE}${span}${AFTER}`);
  const row = { harness: 'oldtool', scope, assetId: 'guidance.core', target, ownershipIdentity: 'oldtool:instructions',
    fingerprint: sha(fs.readFileSync(target)), sourceVersion: 'test', projection: { renderer: 'oldtool-instructions' } };
  if (edited) fs.writeFileSync(target, `${BEFORE}An edit of mine.\n${span}${AFTER}`);
  if (markerless) fs.writeFileSync(target, `${BEFORE}${AFTER}`);
  const ledger = defaultLedger({ scope, scopeRoot: project });
  ledger.resources = [row];
  ledger.targets = { oldtool: { installed: true } };
  if (installed) {
    const marker = path.join(home, '.gemini', 'config', 'skills', 'marker.md');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'antigravity\n');
    ledger.resources.push({ harness: 'antigravity', scope, assetId: 'skills.doflow', target: marker, kind: 'copy-tree-file', identity: 'marker.md',
      fingerprint: sha(fs.readFileSync(marker)), ownershipIdentity: 'doflow:antigravity:copy-tree:skills.doflow:marker.md', projection: { renderer: 'copy-tree' } });
    ledger.targets.antigravity = { installed: true };
  }
  const state = stateRoot({ scope, projectRoot: project, homeDir: home });
  writeLedger(state, ledger);
  const registry = handoverRegistry();
  const adapters = buildAdapterRegistry();
  const plan = ({ targets = ['antigravity'], current = readLedger(state), force = false }: any = {}) => planLifecycle({ registry, adapters, scope, scopeRoot: project,
    targets, ledger: current, context: { repoRoot: REPO, projectRoot: project, homeDir: home, sourceVersion: 'test', operation: 'update', force } });
  const apply = (lifecyclePlan: any) => applyLifecycle({ plan: lifecyclePlan, registry, adapters, stateRoot: state, ledger: lifecyclePlan.ledger,
    hasBashCapableShellFn: () => true });
  return { home, project, target, row, state, registry, adapters, plan, apply, before: fs.readFileSync(target) };
}

const rowsOf = (ledger: any, harness: string) => ledger.resources.filter((row: any) => row.harness === harness);
const sectionRow = (ledger: any, target: string) => ledger.resources.find((row: any) => row.harness === 'antigravity' && row.target === target);
const instructionChanges = (lifecyclePlan: any, target: string) => lifecyclePlan.changes.filter((change: any) => !change.retired && change.target === target);

// ------------------------------------------------------------------ failing first: the handover

for (const legacy of [false, true]) {
  test(`handover${legacy ? ' (short marker pair)' : ''}: the global GEMINI.md keeps a DoFlow section, now antigravity's, and the row is swapped in one ledger write`, (t) => {
    const s = setup(t, { legacy });
    const p = s.plan();
    const [retired] = p.retiredHarnesses;
    assert.deepEqual(retired.changes.map((change: any) => change.action), ['handover']);
    assert.equal(retired.counts.released, 1, 'a handover counts as released');
    assert.deepEqual(formatRetiredPlans(p.retiredHarnesses).map((line: string) => line.replace(/\\/g, '/')), ['[RETIRED] oldtool → antigravity: deleted 0, stripped 0, released 1, dropped 0, deferred 0, kept 0']);
    const agy = p.targets.find((target: any) => target.harness === 'antigravity');
    assert.deepEqual(agy.adapterInput.context.handovers, [{ target: s.target, fromKey: ownershipKey(s.row), edited: false }]);
    const [change] = instructionChanges(p, s.target);
    assert.equal(change.operation, 'update', 'the span is replaced, never removed and re-added');
    assert.ok(!p.changes.some((item: any) => item.target === s.target && item.operation === 'remove' && !item.retired));

    let ledgerWrites = 0;
    const result = applyLifecycle({ plan: p, registry: s.registry, adapters: s.adapters, stateRoot: s.state, ledger: p.ledger,
      hasBashCapableShellFn: () => true, writeLedgerFn: (root: any, doc: any) => { ledgerWrites += 1; writeLedger(root, doc); } });
    assert.equal(ledgerWrites, 1);
    assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${antigravitySection(s.home)}${AFTER}`, 'user text before and after the markers is byte-identical');
    assert.deepEqual(rowsOf(result.ledger, 'oldtool'), [], 'no oldtool row remains');
    assert.equal(result.ledger.targets.oldtool, undefined);
    const row = sectionRow(result.ledger, s.target);
    assert.ok(row, 'the section row is antigravity\'s');
    assert.equal(row.assetId, 'guidance.codex-pointer');
    assert.equal(row.kind, 'instructions-section');
    assert.equal(row.identity, 'GEMINI.md');
    assert.equal(row.ownershipIdentity, 'doflow:antigravity:instructions:managed-section');
    assert.equal(row.projection.renderer, 'antigravity-instructions');
    assert.equal(row.fingerprint, sha(fs.readFileSync(s.target)));
    assert.equal(row.retainedEdit, undefined);

    const again = s.plan({ current: result.ledger });
    assert.equal(again.retiredHarnesses, undefined, 'nothing retired is left to sweep');
    assert.deepEqual(instructionChanges(again, s.target), [], 'the next run converges');
  });
}

// ------------------------------------------------------------------ (a) no state without a marker pair

test('control (a): no write or unlink of the target ever leaves it without a DoFlow marker pair', (t) => {
  const s = setup(t);
  const p = s.plan();
  const events: string[] = [];
  const check = (op: string) => {
    events.push(op);
    const text = fs.existsSync(s.target) ? fs.readFileSync(s.target, 'utf8') : '';
    assert.ok(text.includes(MARKER_START) && text.includes(MARKER_END), `after ${op} the file has a DoFlow marker pair`);
  };
  const spy = (name: string, touches: (args: any[]) => boolean) => {
    const original = fs[name];
    t.mock.method(fs, name, function (this: any, ...args: any[]) {
      const out = original.apply(this, args);
      if (touches(args)) check(name);
      return out;
    });
  };
  const is = (value: any) => value !== undefined && path.resolve(String(value)) === s.target;
  for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'truncateSync']) spy(name, (args) => is(args[0]) || (name === 'copyFileSync' && is(args[1])));
  spy('renameSync', (args) => is(args[0]) || is(args[1]));
  s.apply(p);
  t.mock.restoreAll();
  assert.ok(events.length >= 1, 'the handover wrote the target');
  assert.ok(fs.readFileSync(s.target, 'utf8').includes(antigravitySection(s.home)));
});

test('control (a): a throw in antigravity\'s apply leaves the file and the ledger as they were before the run', (t) => {
  const s = setup(t);
  const ledgerBefore = readLedger(s.state);
  const p = s.plan();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (this: any, from: any, to: any) {
    if (path.resolve(String(to)) === s.target) throw new Error('injected: disk full');
    return rename.call(this, from, to);
  });
  assert.throws(() => s.apply(p), /injected: disk full/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(s.target), s.before, 'the old span and the user text are intact');
  assert.deepEqual(readLedger(s.state), ledgerBefore, 'the oldtool row is still the owner');
  assert.deepEqual(fs.readdirSync(path.dirname(s.target)).filter((name: string) => name !== 'GEMINI.md' && name !== 'config'), [], 'no temporary file is left beside it');
});

test('V-2: a retry after a throw between the handover write and the ledger write recognises DoFlow\'s own section — no "changed before handover" notice, no retainedEdit, no --force', (t) => {
  const s = setup(t);
  const ledgerBefore = readLedger(s.state);
  const p = s.plan();
  assert.throws(() => applyLifecycle({ plan: p, registry: s.registry, adapters: s.adapters, stateRoot: s.state, ledger: p.ledger,
    hasBashCapableShellFn: () => true, writeLedgerFn: () => { throw new Error('injected: ledger write'); } }), /injected: ledger write/);
  assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${antigravitySection(s.home)}${AFTER}`, 'the handover write landed');
  assert.deepEqual(readLedger(s.state), ledgerBefore, 'the oldtool row still holds its old fingerprint');

  const retry = s.plan();
  assert.deepEqual(retry.retiredHarnesses[0].changes.map((change: any) => change.action), ['handover']);
  assert.ok(!retry.notices.some((item: any) => String(item.notice).includes('changed before handover')), JSON.stringify(retry.notices));
  assert.deepEqual(instructionChanges(retry, s.target), [], 'the span is already antigravity\'s: nothing to write');
  const result = s.apply(retry);
  assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${antigravitySection(s.home)}${AFTER}`);
  assert.deepEqual(rowsOf(result.ledger, 'oldtool'), [], 'no oldtool row remains');
  const row = sectionRow(result.ledger, s.target);
  assert.ok(row, 'antigravity owns the section');
  assert.equal(row.retainedEdit, undefined, 'DoFlow\'s own write is not a person\'s edit');
  assert.equal(row.fingerprint, sha(fs.readFileSync(s.target)));
  const again = s.plan({ current: result.ledger });
  assert.equal(again.retiredHarnesses, undefined);
  assert.deepEqual(instructionChanges(again, s.target), [], 'converged without --force');
  assert.ok(!again.notices.some((item: any) => String(item.notice).includes('changed before handover')));
});

// ------------------------------------------------------------------ (b) person-edited: retainedEdit until --force

test('control (b): a whole-file fingerprint mismatch keeps the span, marks the row retainedEdit, and only --force rewrites it', (t) => {
  const s = setup(t, { edited: true });
  const edited = fs.readFileSync(s.target);
  const notice = 'kept ~/.gemini/GEMINI.md: changed before handover; --force replaces the DoFlow section';
  const p = s.plan();
  assert.deepEqual(p.retiredHarnesses[0].changes.map((change: any) => change.action), ['handover']);
  assert.deepEqual(p.targets.find((target: any) => target.harness === 'antigravity').adapterInput.context.handovers,
    [{ target: s.target, fromKey: ownershipKey(s.row), edited: true }]);
  assert.deepEqual(instructionChanges(p, s.target), [], 'no write is planned');
  assert.ok(p.notices.some((item: any) => item.harness === 'antigravity' && String(item.notice).replace(/\\/g, '/') === notice), JSON.stringify(p.notices));
  const first = s.apply(p);
  assert.deepEqual(fs.readFileSync(s.target), edited, 'the span is not rewritten');
  assert.deepEqual(rowsOf(first.ledger, 'oldtool'), []);
  const row = sectionRow(first.ledger, s.target);
  assert.equal(row.retainedEdit, true);
  assert.equal(row.fingerprint, sha(edited), 'the row carries the current whole-file fingerprint');

  // The next run keeps it, and one with other work to do (a deleted skill file) records it again as kept.
  const skill = first.ledger.resources.find((item: any) => item.harness === 'antigravity' && item.assetId === 'skills.doflow');
  fs.rmSync(skill.target);
  const next = s.plan({ current: first.ledger });
  assert.deepEqual(instructionChanges(next, s.target), []);
  assert.ok(next.changes.some((change: any) => change.target === skill.target), 'the run has other work');
  assert.ok(next.notices.some((item: any) => String(item.notice).replace(/\\/g, '/') === notice));
  const second = s.apply(next);
  assert.deepEqual(fs.readFileSync(s.target), edited);
  assert.equal(sectionRow(second.ledger, s.target).retainedEdit, true);

  // --force rewrites the span and clears the flag.
  const forced = s.plan({ current: second.ledger, force: true });
  assert.equal(instructionChanges(forced, s.target).length, 1);
  const third = s.apply(forced);
  assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}An edit of mine.\n${antigravitySection(s.home)}${AFTER}`);
  assert.equal(sectionRow(third.ledger, s.target).retainedEdit, undefined);
  assert.deepEqual(instructionChanges(s.plan({ current: third.ledger }), s.target), [], 'converged after --force');
});

test('control (b, markerless): a person-edited GEMINI.md with no DoFlow markers left stays byte-identical across plain runs under a retainedEdit row, and only --force appends the section', (t) => {
  const s = setup(t, { markerless: true });
  const edited = fs.readFileSync(s.target);
  const notice = 'kept ~/.gemini/GEMINI.md: changed before handover; --force replaces the DoFlow section';
  const p = s.plan();
  assert.deepEqual(p.retiredHarnesses[0].changes.map((change: any) => change.action), ['handover']);
  assert.deepEqual(p.targets.find((target: any) => target.harness === 'antigravity').adapterInput.context.handovers,
    [{ target: s.target, fromKey: ownershipKey(s.row), edited: true }]);
  assert.deepEqual(instructionChanges(p, s.target), [], 'no write is planned');
  assert.ok(p.notices.some((item: any) => item.harness === 'antigravity' && String(item.notice).replace(/\\/g, '/') === notice), JSON.stringify(p.notices));
  const first = s.apply(p);
  assert.deepEqual(fs.readFileSync(s.target), edited, 'the file is not written');
  assert.deepEqual(rowsOf(first.ledger, 'oldtool'), []);
  const row = sectionRow(first.ledger, s.target);
  assert.ok(row, 'antigravity owns the file under a retained row although it holds no DoFlow markers');
  assert.equal(row.retainedEdit, true);
  assert.equal(row.ownershipIdentity, 'doflow:antigravity:instructions:managed-section');
  assert.equal(row.fingerprint, sha(edited), 'the row carries the current whole-file fingerprint');

  // A plain run with no handover left keeps the file and the flag, and says so; it has other work (a
  // deleted skill file), so verify records the kept row again.
  const skill = first.ledger.resources.find((item: any) => item.harness === 'antigravity' && item.assetId === 'skills.doflow');
  fs.rmSync(skill.target);
  const next = s.plan({ current: first.ledger });
  assert.equal(next.retiredHarnesses, undefined, 'nothing retired is left to sweep');
  assert.deepEqual(instructionChanges(next, s.target), [], 'no handover and no --force: still no write');
  assert.ok(next.changes.some((change: any) => change.target === skill.target), 'the run has other work');
  assert.ok(next.notices.some((item: any) => String(item.notice).replace(/\\/g, '/') === notice), JSON.stringify(next.notices));
  const second = s.apply(next);
  assert.deepEqual(fs.readFileSync(s.target), edited);
  assert.equal(sectionRow(second.ledger, s.target).retainedEdit, true);

  // --force appends the section after the person's text and clears the flag.
  const forced = s.plan({ current: second.ledger, force: true });
  assert.equal(instructionChanges(forced, s.target).length, 1);
  const third = s.apply(forced);
  assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${AFTER}\n${antigravitySection(s.home)}`);
  assert.equal(sectionRow(third.ledger, s.target).retainedEdit, undefined);
  assert.deepEqual(instructionChanges(s.plan({ current: third.ledger }), s.target), [], 'converged after --force');
});

// ------------------------------------------------------------------ (c) installed, not planned: defer

test('control (c): antigravity installed but not planned (update -g -t claude) defers — file and row untouched, notice, no pin, no claim', (t) => {
  const s = setup(t, { installed: true });
  const p = s.plan({ targets: ['claude'] });
  const [retired] = p.retiredHarnesses;
  assert.deepEqual(retired.changes.map((change: any) => change.action), ['defer']);
  assert.deepEqual(formatRetiredPlans(p.retiredHarnesses).map((line: string) => line.replace(/\\/g, '/')), [
    '[RETIRED] oldtool → antigravity: deleted 0, stripped 0, released 0, dropped 0, deferred 1, kept 0',
    '  .gemini/GEMINI.md: handed over on the next run that targets antigravity',
  ]);
  const result = s.apply(p);
  assert.deepEqual(fs.readFileSync(s.target), s.before, 'file untouched');
  assert.deepEqual(rowsOf(result.ledger, 'oldtool'), [s.row], 'row untouched');
  assert.ok(result.ledger.targets.oldtool, 'targets.oldtool stays while a deferred row remains');
  const lock = lockDocument({ registry: s.registry, scope: 'global', scopeRoot: s.home, ledger: result.ledger, plannedTargets: ['claude'],
    previous: { version: 1, scope: 'global', scopeRoot: s.home, targets: [{ harness: 'oldtool' }, { harness: 'antigravity' }], assets: [], mcpSelections: {} } });
  assert.ok(!lock.targets.some((entry: any) => entry.harness === 'oldtool'), 'the lock does not pin oldtool');
  // Not a claimant: a removal of that file by a live harness is not kept for the deferred row.
  const removal = Object.freeze({ harness: 'antigravity', assetId: 'guidance.codex-pointer', target: s.target, operation: 'remove',
    ownershipIdentity: 'doflow:antigravity:instructions:managed-section' });
  const [marked] = markRetainedRemovals([{ harness: 'antigravity', changes: [removal], requiredNativeResources: [] }], result.ledger, 'global', s.registry);
  assert.equal(marked.changes[0].retained, undefined);

  // The next run that targets antigravity hands it over.
  const handed = s.plan({ current: result.ledger });
  assert.deepEqual(handed.retiredHarnesses[0].changes.map((change: any) => change.action), ['handover']);
});

// ------------------------------------------------------------------ (d) not installed: strip

for (const legacy of [true, false]) {
  test(`control (d)${legacy ? ' (short marker pair)' : ''}: antigravity neither installed nor planned — the section is stripped as before`, (t) => {
    const s = setup(t, { legacy });
    const p = s.plan({ targets: ['claude'] });
    assert.deepEqual(p.retiredHarnesses[0].changes.map((change: any) => change.action), ['strip-section']);
    const result = s.apply(p);
    assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${AFTER}`);
    assert.deepEqual(rowsOf(result.ledger, 'oldtool'), []);
  });
}

// ------------------------------------------------------------------ (e) project scope: strip, AGENTS.md unchanged

for (const legacy of [true, false]) {
  test(`control (e)${legacy ? ' (short marker pair)' : ''}: a project-scope GEMINI.md is stripped, and the project AGENTS.md plan is byte-identical`, (t) => {
  const s = setup(t, { scope: 'project', legacy });
  const agentsPlan = (current: any) => JSON.stringify(s.plan({ current }).targets.find((target: any) => target.harness === 'antigravity')
    .changes.filter((change: any) => change.projection?.renderer === 'antigravity-instructions'));
  const ledger = readLedger(s.state);
  const withRetired = agentsPlan(ledger);
  const without = agentsPlan({ ...ledger, resources: [], targets: {} });
  assert.ok(withRetired.includes('AGENTS.md'), 'the project plan writes AGENTS.md');
  assert.equal(withRetired, without);
  const p = s.plan();
  assert.equal(p.targets.find((target: any) => target.harness === 'antigravity').adapterInput.context.handovers, undefined);
  assert.deepEqual(p.retiredHarnesses[0].changes.map((change: any) => change.action), ['strip-section']);
  s.apply(p);
  assert.equal(fs.readFileSync(s.target, 'utf8'), `${BEFORE}${AFTER}`);
});
}
