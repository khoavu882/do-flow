'use strict';
// rollback-retired.test.ts — row 127 FR-4 / design D2: a rollback of a backup whose run swept a
// retired harness gives that harness's ledger rows and `targets.<id>` back as the backup's ledger
// holds them, including the rows the sweep only released (no file effect, so no file of theirs is in
// the backup). Every other part of the ledger merge stays per restored file. Scratch roots only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { buildRetiredLedger, USER_TEXT } = require('../helper/retired-ledger.ts');
const { createFileBackup, planRestore, executeRestore } = require('../../src/install/backup.ts') as any;
const { stateRoot, ledgerPath, writeLedger, readLedger, ownershipKey } = require('../../src/state/index.ts');
const { planRetiredHarnesses, retiredReleaseKeys } = require('../../src/lifecycle/retired-harnesses.ts');

const REPO = path.resolve(__dirname, '../..');
const byKey = (rows: any[]) => [...rows].sort((a, b) => (ownershipKey(a) < ownershipKey(b) ? -1 : 1));
const of = (ledger: any, id: string) => byKey(ledger.resources.filter((row: any) => row.harness === id));

/** A global scope holding an `oldtool` install (retired into antigravity), a backup taken the way a
 * sweeping run takes it (the files it deletes or strips, plus the ledger), and then the sweep's
 * effect on disk and in the ledger: oldtool's files gone or stripped, its rows and target entry
 * dropped, and a live row a later run wrote. `backedUp` names the oldtool files the run changed. */
function swept({ backedUp = ['agent', 'scripts', 'instructions', 'settings'] }: any = {}) {
  const scopeRoot = path.join(suiteTempDir('doflow-rollback-retired-'), 'home');
  fs.mkdirSync(scopeRoot);
  const built = buildRetiredLedger({ root: scopeRoot, id: 'oldtool', scope: 'global' });
  const state = stateRoot({ scope: 'global', homeDir: scopeRoot });
  const ledgerFile = ledgerPath(state);
  writeLedger(state, built.ledger);
  const backupRoot = path.join(scopeRoot, '.doflow', 'backups');

  const files = backedUp.flatMap((name: string) => (name === 'scripts' ? Object.values<string>(built.targets.scripts) : [built.targets[name]]));
  const entry = (file: string, harnesses: string[]) => {
    const st = fs.statSync(file);
    return { path: file, rel: path.relative(scopeRoot, file).split(path.sep).join('/'), harnesses, reasons: ['change'], kind: 'file', size: st.size, mode: st.mode & 0o7777 };
  };
  const entries = [...files.map((file: string) => entry(file, ['oldtool'])), entry(ledgerFile, [])];
  const backup = createFileBackup({ operation: 'update', set: { scope: 'global', scopeRoot, entries, excluded: [], count: entries.length },
    backupRoot, repoRoot: REPO, sourceCommit: 'test', version: 'test', date: new Date('2026-10-26T10:00:00') });
  const bytes = new Map(files.map((file: string) => [file, fs.readFileSync(file)]));

  // The sweep: files changed, every oldtool row and targets.oldtool gone; a later live row appears.
  for (const file of files) {
    if (file === built.targets.instructions) fs.writeFileSync(file, USER_TEXT);
    else if (file === built.targets.settings) fs.writeFileSync(file, '{}\n');
    else fs.rmSync(file);
  }
  const after = JSON.parse(JSON.stringify(built.ledger));
  after.resources = after.resources.filter((row: any) => row.harness !== 'oldtool');
  delete after.targets.oldtool;
  after.resources.push({ ...built.rows.sharedLive, harness: 'claude', ownershipIdentity: 'doflow:claude:later', assetId: 'later', target: path.join(scopeRoot, '.claude', 'later.md') });
  after.targets.claude = { installed: true };
  writeLedger(state, after);

  const restore = (extra: any = {}) => executeRestore(planRestore({ bid: backup.id, backupRoot, scope: 'global', scopeRoot, targets: ['claude'],
    explicitTargets: false, dirs: {}, ledgerFile, ...extra }), { backupRoot, registry: built.registry });
  return { scopeRoot, built, state, ledgerFile, after, bytes, restore };
}

test('rollback of a sweeping run restores every retired row, the released ones included, and targets.<id>', () => {
  const s = swept();
  const outcome = s.restore();
  assert.deepEqual(outcome.failed, []);
  for (const [file, bytes] of s.bytes) assert.deepEqual(fs.readFileSync(file), bytes, `restored: ${file}`);
  const ledger = readLedger(s.state);
  assert.deepEqual(of(ledger, 'oldtool'), of(s.built.ledger, 'oldtool'), 'the retired rows are the backup\'s, the released shared row included');
  assert.deepEqual(ledger.targets.oldtool, s.built.ledger.targets.oldtool, 'targets.oldtool is the backup\'s');
  for (const id of ['antigravity', 'claude']) assert.deepEqual(of(ledger, id), of(s.after, id), `${id}'s rows are the current ones`);
  assert.deepEqual(ledger.targets.claude, s.after.targets.claude, 'a live target entry stays the current one');
  assert.equal(ledger.resources.length, s.built.ledger.resources.length + 1, 'no row is duplicated');
});

test('a second rollback of the same backup changes no ledger byte', () => {
  const s = swept();
  s.restore();
  const first = fs.readFileSync(s.ledgerFile, 'utf8');
  s.restore();
  assert.equal(fs.readFileSync(s.ledgerFile, 'utf8'), first);
  assert.deepEqual(of(readLedger(s.state), 'oldtool'), of(s.built.ledger, 'oldtool'));
});

test('rows the replacement now owns get the retired claimant back, and the next sweep releases it without touching the file', () => {
  // The run deferred the instructions row (not backed up); a later run handed the file to antigravity.
  const s = swept({ backedUp: ['agent', 'scripts', 'settings'] });
  const handed = { ...s.built.rows.instructions, harness: 'antigravity', ownershipIdentity: 'doflow:antigravity:instructions:managed-section', projection: { renderer: 'marker-merge' } };
  const current = readLedger(s.state);
  current.resources.push(handed);
  writeLedger(s.state, current);
  s.restore();

  const ledger = readLedger(s.state);
  assert.deepEqual(of(ledger, 'oldtool'), of(s.built.ledger, 'oldtool'));
  const onFile = ledger.resources.filter((row: any) => row.target === s.built.targets.instructions).map((row: any) => row.harness).sort();
  assert.deepEqual(onFile, ['antigravity', 'oldtool'], 'antigravity keeps its row; the retired one sits beside it');

  const plans = planRetiredHarnesses({ registry: s.built.registry, ledger, scope: 'global', scopeRoot: s.scopeRoot });
  const action = (target: string) => plans[0].changes.find((change: any) => change.target === target).action;
  assert.equal(action(s.built.targets.instructions), 'release', 'a file antigravity claims is released: row dropped, file stays');
  assert.equal(action(s.built.targets.shared), 'release');
  assert.equal(retiredReleaseKeys(plans).size, of(ledger, 'oldtool').length, 'every retired row leaves the ledger in that run');
});

test('--target narrows the retired rows with the files: none of an untargeted retired harness comes back', () => {
  const s = swept();
  s.restore({ explicitTargets: true });
  const ledger = readLedger(s.state);
  assert.deepEqual(of(ledger, 'oldtool'), []);
  assert.equal(ledger.targets.oldtool, undefined);
});

test('control: a backup with no retired rows merges exactly as before (the current ledger, byte for byte, here)', () => {
  const s = swept();
  // Rewrite the stored backup ledger so the backup holds no retired row and no retired target.
  const bkRoot = path.join(s.scopeRoot, '.doflow', 'backups');
  const [bid] = fs.readdirSync(bkRoot).filter((name: string) => !name.startsWith('.'));
  const stored = path.join(bkRoot, bid, 'files', path.relative(s.scopeRoot, s.ledgerFile).split(path.sep).join('/'));
  const live = { ...s.built.ledger, resources: s.built.ledger.resources.filter((row: any) => row.harness !== 'oldtool'), targets: { antigravity: { installed: true } } };
  fs.writeFileSync(stored, JSON.stringify(live));
  const before = fs.readFileSync(s.ledgerFile, 'utf8');
  s.restore();
  // The restored files are oldtool's and neither ledger has a row of them, so nothing changes.
  assert.equal(fs.readFileSync(s.ledgerFile, 'utf8'), before);
});
