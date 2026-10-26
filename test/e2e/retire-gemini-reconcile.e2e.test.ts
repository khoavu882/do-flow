'use strict';

// retire-gemini-reconcile.e2e.test.ts — row 127 FR-4 on the third verb it names (end review V-3):
// a `doflow reconcile` that sweeps a retired harness takes a backup first, as install and update
// do, so `doflow rollback` of that backup gives back the swept files, the gemini ledger rows and
// `targets.gemini`; one whose sweep only gives up rows backs up the ledger alone; and a reconcile
// with no retired change takes no backup, as before. Every spawn runs in a scratch HOME.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { buildRetiredLedger } = require('../helper/retired-ledger.ts');
const { writeLedger, stateRoot, ownershipKey } = require('../../src/state/index.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const RETIRED = /^\[RETIRED\] gemini/m;

const sha = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir` mapped to its digest ({} when the directory is absent). */
function digests(dir: string): any {
  if (!fs.existsSync(dir)) return {};
  const walk = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true })
    .flatMap((entry: any) => (entry.isDirectory() ? walk(path.join(current, entry.name)) : [path.join(current, entry.name)]));
  return Object.fromEntries(walk(dir).sort().map((file) => [path.relative(dir, file), sha(fs.readFileSync(file))]));
}

/** A scratch HOME with a global claude install pinned in doflow.lock. `gemini` lays the fixture's
 * gemini rows into the ledger with a gemini pin in the lock; `files: false` deletes the gemini files
 * first, so the sweep only drops rows and touches no file. */
function cell({ gemini = true, files = true }: any = {}) {
  const scratch = createScratch('doflow-retire-gemini-reconcile-');
  const home = scratch.home;
  const state = stateRoot({ scope: 'global', homeDir: home });
  const run = (args: string[]) => {
    const done = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: scratch.env(), input: '\n', encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, output: `${done.stdout}\n${done.stderr}` };
  };
  const ledger = () => JSON.parse(fs.readFileSync(path.join(state, 'ledger.json'), 'utf8'));
  const base = run(['install', '-g', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(base.status, 0, base.output);
  const built = buildRetiredLedger({ root: home, id: 'gemini', scope: 'global' });
  const geminiDir = path.join(home, '.gemini');
  if (gemini) {
    const doc = ledger();
    // The fixture's shared CORE.md row is claimed by its antigravity row, absent here: leave it out,
    // so every gemini row sits under ~/.gemini.
    doc.resources.push(...built.ledger.resources.filter((row: any) => row.harness === 'gemini' && row !== built.rows.shared));
    doc.targets.gemini = { installed: true };
    writeLedger(state, doc);
    const lockFile = path.join(home, '.doflow', 'doflow.lock');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.targets.push({ harness: 'gemini' });
    fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (!files) fs.rmSync(geminiDir, { recursive: true, force: true });
  const backupRoot = path.join(home, '.doflow', 'backups');
  const backups = () => (fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter((name: string) => !name.startsWith('.')).sort() : []);
  const geminiRows = (doc: any) => doc.resources.filter((row: any) => row.harness === 'gemini')
    .sort((a: any, b: any) => (ownershipKey(a) < ownershipKey(b) ? -1 : 1));
  return { home, geminiDir, run, ledger, backups, geminiRows };
}

test('reconcile that sweeps gemini files backs them up first; rollback restores the files, the rows and targets.gemini', () => {
  const c = cell();
  const before = { files: digests(c.geminiDir), ledger: c.ledger() };
  assert.equal(Object.keys(before.files).length, 10, 'precondition: seven scripts, the agent, settings.json and GEMINI.md');
  assert.deepEqual(c.backups(), [], 'precondition: no backup yet');

  const healed = c.run(['reconcile', '-g', '-f']);
  assert.equal(healed.status, 0, healed.output);
  assert.match(healed.stdout, RETIRED);
  assert.ok(!fs.existsSync(path.join(c.geminiDir, 'hooks')), 'the sweep deleted the hook scripts');
  assert.deepEqual(c.geminiRows(c.ledger()), [], 'the sweep released every gemini row');
  const taken = c.backups();
  assert.equal(taken.length, 1, `reconcile took one backup before the sweep: ${healed.output}`);
  assert.match(taken[0], /^reconcile_/);
  assert.ok(healed.output.includes(`Backup created: ${taken[0]}`), healed.output);

  const rolled = c.run(['rollback', taken[0], '-g', '-f']);
  assert.equal(rolled.status, 0, rolled.output);
  assert.deepEqual(digests(c.geminiDir), before.files, 'every swept gemini file is back byte for byte');
  const after = c.ledger();
  assert.deepEqual(c.geminiRows(after), c.geminiRows(before.ledger), 'every gemini row is back exactly');
  assert.deepEqual(after.targets.gemini, before.ledger.targets.gemini, 'targets.gemini is back');
});

test('reconcile whose sweep only gives up rows backs up the ledger; rollback restores the rows and targets.gemini', () => {
  const c = cell({ files: false });
  const before = c.ledger();
  assert.ok(c.geminiRows(before).length > 0, 'precondition: gemini rows with no file left');

  const healed = c.run(['reconcile', '-g', '-f']);
  assert.equal(healed.status, 0, healed.output);
  assert.match(healed.stdout, RETIRED);
  assert.deepEqual(c.geminiRows(c.ledger()), [], 'the sweep dropped every gemini row');
  assert.equal(c.ledger().targets.gemini, undefined, 'and targets.gemini');
  const taken = c.backups();
  assert.equal(taken.length, 1, `a ledger-only sweep still takes a backup: ${healed.output}`);

  const rolled = c.run(['rollback', taken[0], '-g', '-f']);
  assert.equal(rolled.status, 0, rolled.output);
  const after = c.ledger();
  assert.deepEqual(c.geminiRows(after), c.geminiRows(before), 'every gemini row is back exactly');
  assert.deepEqual(after.targets.gemini, before.targets.gemini, 'targets.gemini is back');
  assert.ok(!fs.existsSync(c.geminiDir), 'a ledger-only backup writes no gemini file back');
});

test('reconcile with no retired change takes no backup, as before', () => {
  const c = cell({ gemini: false });
  // Live drift only: a claude file DoFlow owns is gone, so reconcile has something to heal.
  const row = c.ledger().resources.find((item: any) => item.harness === 'claude' && item.kind === 'copy-tree-file');
  assert.ok(row, 'precondition: a claude copy-tree file');
  fs.rmSync(row.target);

  const healed = c.run(['reconcile', '-g', '-f']);
  assert.equal(healed.status, 0, healed.output);
  assert.ok(healed.stdout.includes('[OK] Reconciliation complete'), healed.stdout);
  assert.doesNotMatch(healed.stdout, RETIRED);
  assert.ok(fs.existsSync(row.target), 'the live drift is healed');
  assert.deepEqual(c.backups(), [], 'no backup is taken');
  assert.ok(!/Backup/.test(healed.output), `no backup line is printed: ${healed.output}`);
});
