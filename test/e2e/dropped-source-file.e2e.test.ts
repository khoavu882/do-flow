'use strict';
// A source file that a new release no longer ships: `update` removes the copy it installed, for every
// harness, and keeps a copy the user edited. Each case runs the real bin/doflow.js from a copy of this
// package in a scratch HOME, so deleting a source file never touches the working tree.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { dropCoreFile, restoreEdited } = require('../helper/drop-core-file.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DROPPED = 'RESEARCH_CONFIG.md';
const SOURCE = path.join('core', 'shared', 'guidance', 'references', DROPPED);
// A file in Kiro's steering core set (DOFLOW_CORE.md and what it imports), unlike RESEARCH_CONFIG.md
// which Kiro's steering no longer holds.
const CORE_DROPPED = 'RULE_04_QUESTIONS.md';
const CORE_SOURCE = path.join('core', 'shared', 'guidance', 'rules', CORE_DROPPED);
const CASE_TIMEOUT_MS = 300_000;

const scratches: any = [];
let pkgScratch: any;
let pkg: any;
let doflow: any;

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

function newScratch(label: any) {
  const scratch = createScratch(`doflow-dropped-source-${label}-`);
  scratches.push(scratch);
  return scratch;
}

function run(scratch: any, args: any, { cwd = scratch.home } = {}) {
  return spawnSync(process.execPath, [doflow, ...args], { cwd, env: scratch.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function runOk(scratch: any, args: any, options?: any) {
  const r = run(scratch, args, options);
  assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r;
}

function ledgerRows(scratch: any) {
  const file = path.join(scratch.home, '.doflow', 'state', 'ledger.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).resources : [];
}

const namesFile = (name: any) => (row: any) => typeof row.target === 'string' && row.target.endsWith(name);
const namesDropped = namesFile(DROPPED);

/** Every file named RESEARCH_CONFIG.md under `home`, outside the backups an update takes first. */
function installedCopies(home: any) {
  const backups = path.join(home, '.doflow', 'backups') + path.sep;
  return fs.readdirSync(home, { recursive: true })
    .map((rel: any) => path.join(home, rel))
    .filter((full: any) => path.basename(full) === DROPPED && !full.startsWith(backups));
}

let importEdits: any = [];

/** Drop a source file the way a real change does: the `@import` lines naming it go with it. */
function dropSource(source = SOURCE) {
  importEdits = dropCoreFile(path.join(pkg, 'core', 'shared', 'guidance'), path.join(pkg, source));
}

function restoreSource(source = SOURCE) {
  fs.copyFileSync(path.join(REPO, source), path.join(pkg, source));
  restoreEdited(importEdits);
  importEdits = [];
}

/** One Kiro round: install, optionally edit the steering copy, drop the source, update. `dir` and
 * `source` name the dropped file under guidance/ and in the package; it must be a core-set file when
 * the steering copy is expected, because Kiro's steering holds only the core set. */
function kiroRound(label: any, { edit, name = CORE_DROPPED, dir = 'rules', source = CORE_SOURCE }: any) {
  const scratch = newScratch(label);
  const global = path.join(scratch.home, '.doflow', 'guidance', dir, name);
  const steering = path.join(scratch.home, '.kiro', 'steering', dir, name);
  runOk(scratch, ['install', '-g', '-t', 'kiro', '-f', '--mcp', 'none']);
  assert.ok(fs.existsSync(global), 'install projected the guidance copy');
  assert.ok(fs.existsSync(steering), 'install projected the Kiro steering copy');
  if (edit) fs.appendFileSync(steering, '\nA line the user added.\n');
  const edited = edit ? fs.readFileSync(steering) : null;
  dropSource(source);
  try {
    const update = runOk(scratch, ['update', '-g', '-t', 'kiro', '-f']);
    return { scratch, global, steering, edited, update };
  } finally {
    restoreSource(source);
  }
}

test('Kiro drops a core guidance file: both installed copies and their rows go, and retrieve no longer returns it', { timeout: CASE_TIMEOUT_MS }, () => {
  const { scratch, global, steering, update } = kiroRound('kiro-drop', { edit: false });
  assert.equal(fs.existsSync(global), false);
  assert.equal(fs.existsSync(steering), false);
  assert.deepEqual(ledgerRows(scratch).filter(namesFile(CORE_DROPPED)), []);
  assert.doesNotMatch(update.stdout, /kept hand-edited/);
  const retrieve = runOk(scratch, ['retrieve', '--query', 'RULE_04_QUESTIONS'], { cwd: scratch.home });
  // Result lines are `N. [score] <path>`; other guidance files still mention the dropped one in their text.
  const paths = retrieve.stdout.split('\n').filter((line: any) => /^\s*\d+\.\s+\[[^\]]*\]\s+\S*RULE_04_QUESTIONS\.md/.test(line));
  assert.deepEqual(paths, [], `retrieve output names no ${CORE_DROPPED}\n${retrieve.stdout}`);
});

test('Kiro drops a non-core guidance file: only the shared copy existed, and it and its row go', { timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = newScratch('kiro-drop-noncore');
  const global = path.join(scratch.home, '.doflow', 'guidance', 'references', DROPPED);
  const steering = path.join(scratch.home, '.kiro', 'steering', 'references', DROPPED);
  runOk(scratch, ['install', '-g', '-t', 'kiro', '-f', '--mcp', 'none']);
  assert.ok(fs.existsSync(global), 'install projected the guidance copy');
  assert.equal(fs.existsSync(steering), false, 'Kiro steering holds the core set only');
  dropSource();
  try {
    runOk(scratch, ['update', '-g', '-t', 'kiro', '-f']);
  } finally {
    restoreSource();
  }
  assert.equal(fs.existsSync(global), false);
  assert.deepEqual(ledgerRows(scratch).filter(namesDropped), []);
});

test('Kiro drops a core guidance file the user edited: the edited copy stays, its row goes, one notice names it', { timeout: CASE_TIMEOUT_MS }, () => {
  const { scratch, global, steering, edited, update } = kiroRound('kiro-edited', { edit: true });
  assert.deepEqual(fs.readFileSync(steering), edited);
  assert.equal(fs.existsSync(global), false);
  assert.deepEqual(ledgerRows(scratch).filter(namesFile(CORE_DROPPED)), []);
  const notices = update.stdout.split('\n').filter((line: any) => line.includes('kept hand-edited'));
  assert.equal(notices.length, 1, update.stdout);
  assert.ok(notices[0].includes(path.join('.kiro', 'steering', 'rules', CORE_DROPPED)), notices[0]);
});

test('every harness: update removes what install projected from the dropped source, and leaves no copy no row names', { timeout: 8 * CASE_TIMEOUT_MS }, () => {
  const ids = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses.map((harness: any) => harness.id);
  assert.equal(ids.length, 8);
  const homes = ids.map((id: any) => {
    const scratch = newScratch(id);
    runOk(scratch, ['install', '-g', '-t', id, '-f', '--mcp', 'none']);
    // Without a row for the file, the checks below would pass with nothing dropped to remove.
    assert.ok(ledgerRows(scratch).some(namesDropped), `${id}: install recorded a ledger row ending in ${DROPPED}`);
    return { id, scratch };
  });
  dropSource();
  try {
    for (const { id, scratch } of homes) runOk(scratch, ['update', '-g', '-t', id, '-f']);
  } finally {
    restoreSource();
  }
  for (const { id, scratch } of homes) {
    const claimed = new Set(ledgerRows(scratch).filter(namesDropped).map((row: any) => row.target));
    const strays = installedCopies(scratch.home).filter((file: any) => !claimed.has(file));
    assert.deepEqual(strays, [], `${id} left a ${DROPPED} no ledger row names`);
    assert.deepEqual([...claimed], [], `${id} still records ${DROPPED}`);
  }
});
