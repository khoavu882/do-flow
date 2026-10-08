'use strict';
// A source file that a new release no longer ships: `update` removes the copy it installed, for every
// harness, and keeps a copy the user edited. Each case runs the real bin/doflow.js from a copy of this
// package in a scratch HOME, so deleting a source file never touches the working tree.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const DROPPED = 'RESEARCH_CONFIG.md';
const SOURCE = path.join('core', 'shared', 'guidance', 'references', DROPPED);
const CASE_TIMEOUT_MS = 300_000;

const scratches = [];
let pkgScratch;
let pkg;
let doflow;

before(() => {
  pkgScratch = createScratch('doflow-dropped-source-pkg-');
  pkg = path.join(pkgScratch.dir, 'pkg');
  fs.mkdirSync(pkg);
  for (const part of ['bin', 'src', 'core', 'package.json']) fs.cpSync(path.join(REPO, part), path.join(pkg, part), { recursive: true });
  doflow = path.join(pkg, 'bin', 'doflow.js');
});

after(() => {
  pkgScratch?.remove();
  for (const scratch of scratches) scratch.remove();
});

function newScratch(label) {
  const scratch = createScratch(`doflow-dropped-source-${label}-`);
  scratches.push(scratch);
  return scratch;
}

function run(scratch, args, { cwd = scratch.home } = {}) {
  return spawnSync(process.execPath, [doflow, ...args], { cwd, env: scratch.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function runOk(scratch, args, options) {
  const r = run(scratch, args, options);
  assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r;
}

function ledgerRows(scratch) {
  const file = path.join(scratch.home, '.doflow', 'state', 'ledger.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).resources : [];
}

const namesDropped = (row) => typeof row.target === 'string' && row.target.endsWith(DROPPED);

/** Every file named RESEARCH_CONFIG.md under `home`, outside the backups an update takes first. */
function installedCopies(home) {
  const backups = path.join(home, '.doflow', 'backups') + path.sep;
  return fs.readdirSync(home, { recursive: true })
    .map((rel) => path.join(home, rel))
    .filter((full) => path.basename(full) === DROPPED && !full.startsWith(backups));
}

function dropSource() {
  fs.rmSync(path.join(pkg, SOURCE));
}

function restoreSource() {
  fs.copyFileSync(path.join(REPO, SOURCE), path.join(pkg, SOURCE));
}

/** One Kiro round: install, optionally edit the steering copy, drop the source, update. */
function kiroRound(label, { edit }) {
  const scratch = newScratch(label);
  const global = path.join(scratch.home, '.doflow', 'guidance', 'references', DROPPED);
  const steering = path.join(scratch.home, '.kiro', 'steering', 'references', DROPPED);
  runOk(scratch, ['install', '-g', '-t', 'kiro', '-f', '--mcp', 'none']);
  assert.ok(fs.existsSync(global), 'install projected the guidance copy');
  assert.ok(fs.existsSync(steering), 'install projected the Kiro steering copy');
  if (edit) fs.appendFileSync(steering, '\nA line the user added.\n');
  const edited = edit ? fs.readFileSync(steering) : null;
  dropSource();
  try {
    const update = runOk(scratch, ['update', '-g', '-t', 'kiro', '-f']);
    return { scratch, global, steering, edited, update };
  } finally {
    restoreSource();
  }
}

test('Kiro drops a guidance file: both installed copies and their rows go, and retrieve no longer returns it', { timeout: CASE_TIMEOUT_MS }, () => {
  const { scratch, global, steering, update } = kiroRound('kiro-drop', { edit: false });
  assert.equal(fs.existsSync(global), false);
  assert.equal(fs.existsSync(steering), false);
  assert.deepEqual(ledgerRows(scratch).filter(namesDropped), []);
  assert.doesNotMatch(update.stdout, /kept hand-edited/);
  const retrieve = runOk(scratch, ['retrieve', '--query', 'RESEARCH_CONFIG'], { cwd: scratch.home });
  const paths = retrieve.stdout.split('\n').filter((line) => line.includes(DROPPED));
  assert.deepEqual(paths, [], `retrieve output names no ${DROPPED}\n${retrieve.stdout}`);
});

test('Kiro drops a guidance file the user edited: the edited copy stays, its row goes, one notice names it', { timeout: CASE_TIMEOUT_MS }, () => {
  const { scratch, global, steering, edited, update } = kiroRound('kiro-edited', { edit: true });
  assert.deepEqual(fs.readFileSync(steering), edited);
  assert.equal(fs.existsSync(global), false);
  assert.deepEqual(ledgerRows(scratch).filter(namesDropped), []);
  const notices = update.stdout.split('\n').filter((line) => line.includes('kept hand-edited'));
  assert.equal(notices.length, 1, update.stdout);
  assert.ok(notices[0].includes(path.join('.kiro', 'steering', 'references', DROPPED)), notices[0]);
});

test('every harness: update removes what install projected from the dropped source, and leaves no copy no row names', { timeout: 8 * CASE_TIMEOUT_MS }, (t) => {
  const ids = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses.map((harness) => harness.id);
  assert.equal(ids.length, 8);
  const homes = ids.map((id) => {
    const scratch = newScratch(id);
    runOk(scratch, ['install', '-g', '-t', id, '-f', '--mcp', 'none']);
    return { id, scratch, hadRow: ledgerRows(scratch).some(namesDropped) };
  });
  dropSource();
  try {
    for (const { id, scratch, hadRow } of homes) {
      if (!hadRow) t.diagnostic(`${id}: install recorded no ledger row ending in ${DROPPED}`);
      runOk(scratch, ['update', '-g', '-t', id, '-f']);
    }
  } finally {
    restoreSource();
  }
  for (const { id, scratch } of homes) {
    const claimed = new Set(ledgerRows(scratch).filter(namesDropped).map((row) => row.target));
    const strays = installedCopies(scratch.home).filter((file) => !claimed.has(file));
    assert.deepEqual(strays, [], `${id} left a ${DROPPED} no ledger row names`);
    assert.deepEqual([...claimed], [], `${id} still records ${DROPPED}`);
  }
});
