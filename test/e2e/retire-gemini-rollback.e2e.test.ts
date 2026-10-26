'use strict';

// retire-gemini-rollback.e2e.test.ts — row 127 FR-4 / design D2 through the real CLI: a rollback of
// the backup a gemini-sweeping run took gives back the gemini ledger rows and `targets.gemini` exactly
// as they were before that run, the released rows (no file of theirs in the backup) included, and a
// later update sweeps them again cleanly. Every spawn runs in a scratch HOME.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { buildRetiredLedger } = require('../helper/retired-ledger.ts');
const { writeLedger, stateRoot, ownershipKey } = require('../../src/state/index.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');

/** A scratch HOME holding a global gemini install beside an antigravity one (the fixture of
 * test/helper/retired-ledger.ts); `antigravity: false` drops antigravity's rows. */
function cell({ antigravity = true }: any = {}) {
  const scratch = createScratch('doflow-retire-gemini-rollback-');
  const home = scratch.home;
  const built = buildRetiredLedger({ root: home, id: 'gemini', scope: 'global' });
  if (!antigravity) {
    built.ledger.resources = built.ledger.resources.filter((row: any) => row.harness !== 'antigravity');
    delete built.ledger.targets.antigravity;
  }
  const state = stateRoot({ scope: 'global', homeDir: home });
  writeLedger(state, built.ledger);
  const run = (args: string[]) => {
    const done = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: scratch.env(), input: '\n', encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, output: `${done.stdout}\n${done.stderr}` };
  };
  const ledger = () => JSON.parse(fs.readFileSync(path.join(state, 'ledger.json'), 'utf8'));
  const gemini = (doc: any) => doc.resources.filter((row: any) => row.harness === 'gemini').map(ownershipKey).sort();
  const backups = () => fs.readdirSync(path.join(home, '.doflow', 'backups')).filter((name: string) => name.startsWith('install_')).sort();
  return { built, run, ledger, gemini, backups };
}

test('sweep then rollback: the gemini rows and targets.gemini equal the pre-run ledger\'s; the next update sweeps them cleanly', () => {
  for (const antigravity of [true, false]) {
    const c = cell({ antigravity });
    const before = c.ledger();
    assert.equal(c.gemini(before).length, 11, 'precondition: the fixture\'s gemini rows');

    const swept = c.run(['install', '-g', '-f', '-t', 'claude']);
    assert.equal(swept.status, 0, swept.output);
    assert.ok(swept.stdout.includes('[RETIRED] gemini → antigravity:'), swept.stdout);
    assert.ok(c.gemini(c.ledger()).length < 2, `the run swept gemini (antigravity: ${antigravity})`);

    const [backup] = c.backups();
    const rolled = c.run(['rollback', backup, '-g', '-f']);
    assert.equal(rolled.status, 0, rolled.output);
    const after = c.ledger();
    assert.deepEqual(c.gemini(after), c.gemini(before), `every gemini row is back, the released shared row included (antigravity: ${antigravity})`);
    assert.deepEqual(after.targets.gemini, before.targets.gemini, `targets.gemini is back (antigravity: ${antigravity})`);
    const gem = (doc: any) => doc.resources.filter((row: any) => row.harness === 'gemini').sort((a: any, b: any) => (ownershipKey(a) < ownershipKey(b) ? -1 : 1));
    assert.deepEqual(gem(after), gem(before), 'each row exactly as the pre-run ledger held it');

    const again = c.run(['update', '-g', '-f', '--no-backup']);
    assert.equal(again.status, 0, again.output);
    assert.ok(again.stdout.includes('[RETIRED] gemini → antigravity:'), again.stdout);
  }
});

test('rollback after a later antigravity install: the restored gemini claimant on GEMINI.md is released by the next update, antigravity\'s row and section kept', () => {
  const c = cell();
  const first = c.run(['install', '-g', '-f', '-t', 'claude']);
  assert.equal(first.status, 0, first.output);
  const [backup] = c.backups();
  const handed = c.run(['install', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(handed.status, 0, handed.output);
  const md = c.built.targets.instructions;
  const owners = () => c.ledger().resources.filter((row: any) => row.target === md).map((row: any) => row.harness).sort();
  assert.deepEqual(owners(), ['antigravity'], 'precondition: antigravity owns GEMINI.md');
  const handedText = fs.readFileSync(md, 'utf8');
  const antigravityRow = c.ledger().resources.find((row: any) => row.target === md);

  const rolled = c.run(['rollback', backup, '-g', '-f']);
  assert.equal(rolled.status, 0, rolled.output);
  assert.deepEqual(owners(), ['antigravity', 'gemini'], 'the gemini row comes back beside antigravity\'s');
  assert.equal(fs.readFileSync(md, 'utf8'), handedText, 'the first run never changed GEMINI.md, so rollback leaves antigravity\'s section');

  const next = c.run(['update', '-g', '-f', '--no-backup']);
  assert.equal(next.status, 0, next.output);
  // released 1 is the GEMINI.md claimant (antigravity claims the file); dropped 1 is the fixture's shared
  // runtime file, which the source no longer produces, so the live prune removes it and the sweep drops its row.
  assert.ok(next.stdout.includes('[RETIRED] gemini → antigravity: deleted 8, stripped 1, released 1, dropped 1, deferred 0, kept 0'), next.stdout);
  const ledger = c.ledger();
  assert.deepEqual(c.gemini(ledger), [], 'no gemini row is left');
  assert.equal(ledger.targets.gemini, undefined, 'targets.gemini is dropped again');
  assert.deepEqual(ledger.resources.filter((row: any) => row.target === md).map((row: any) => [row.harness, row.ownershipIdentity]),
    [['antigravity', antigravityRow.ownershipIdentity]], 'antigravity keeps its row on GEMINI.md');
  assert.equal(fs.readFileSync(md, 'utf8').split('doflow:start').length - 1, 1, 'exactly one DoFlow section in GEMINI.md');
  const quiet = c.run(['update', '-g', '-f', '--no-backup']);
  assert.equal(quiet.status, 0, quiet.output);
  assert.ok(!quiet.output.includes('[RETIRED]'), quiet.output);
});
