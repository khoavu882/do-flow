'use strict';
// home-project-refusal.e2e.test.js — a project install, update, remove or reconcile rooted at HOME
// is refused with one line and exit 1, and the scratch HOME is byte-identical afterwards: every
// file's content and mode, and every directory, is hashed before and after. Every case runs the
// real bin/doflow.js in a scratch HOME.
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

const CASE_TIMEOUT_MS = 180_000;
const SCRATCHES = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function newScratch() {
  const scratch = createScratch('doflow-home-refusal-');
  SCRATCHES.push(scratch);
  return scratch;
}

function run(scratch, args, { cwd, home = scratch.home } = {}) {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });
  if (IS_WIN) env.USERPROFILE = home;
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** Every directory, file content hash and file mode under `root`, as one sorted list. */
function snapshot(root) {
  const entries = [];
  for (const rel of fs.readdirSync(root, { recursive: true })) {
    const full = path.join(root, rel);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) entries.push(`d ${rel}`);
    else if (stat.isSymbolicLink()) entries.push(`l ${rel} ${fs.readlinkSync(full)}`);
    else entries.push(`f ${rel} ${(stat.mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
  }
  return entries.sort();
}

/** A scratch HOME that already holds a global install of codex, pi and claude. */
function installedScratch() {
  const scratch = newScratch();
  const installed = run(scratch, ['install', '-g', '-t', 'codex,pi,claude', '-f', '--mcp', 'none'], { cwd: scratch.dir });
  assert.strictEqual(installed.status, 0, installed.stderr);
  return scratch;
}

function assertRefused(result, command, targets) {
  assert.strictEqual(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const lines = result.stderr.trimEnd().split('\n');
  assert.strictEqual(lines.length, 1, result.stderr);
  assert.match(lines[0], /is your home directory.*Nothing was changed\. Run: doflow /);
  assert.ok(lines[0].endsWith(`Run: doflow ${command} -g${targets ? ` -t ${targets}` : ''}`), lines[0]);
  assert.strictEqual(result.stdout, '');
}

const REFUSED = [
  { name: 'install', args: ['install'], tail: ['-t', 'codex', '-f'], command: 'install', targets: 'codex' },
  { name: 'update', args: ['update'], tail: ['-t', 'pi', '-f'], command: 'update', targets: 'pi' },
  { name: 'remove', args: ['remove'], tail: ['-t', 'claude', '-f'], command: 'remove', targets: 'claude' },
  { name: 'reconcile', args: ['reconcile'], tail: ['-f'], command: 'reconcile', targets: '' },
  { name: 'install --dry-run', args: ['install'], tail: ['-t', 'codex', '--dry-run'], command: 'install', targets: 'codex' },
];

for (const spec of REFUSED) {
  for (const positional of [[], ['.']]) {
    test(`refused: ${spec.name} from HOME${positional.length ? ' with "."' : ''} changes nothing`, { timeout: CASE_TIMEOUT_MS }, () => {
      const scratch = installedScratch();
      const before = snapshot(scratch.home);
      const result = run(scratch, [...spec.args, ...positional, ...spec.tail], { cwd: scratch.home });
      assertRefused(result, spec.command, spec.targets);
      assert.deepStrictEqual(snapshot(scratch.home), before);
    });
  }
}

test('refused: install with HOME as the argument, run from another directory, changes nothing', { timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  const before = snapshot(scratch.home);
  const result = run(scratch, ['install', scratch.home, '-t', 'codex', '-f'], { cwd: scratch.dir });
  assertRefused(result, 'install', 'codex');
  assert.deepStrictEqual(snapshot(scratch.home), before);
});

test('refused: a trailing separator on the HOME argument is still HOME', { timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  const before = snapshot(scratch.home);
  const result = run(scratch, ['install', `${scratch.home}${path.sep}`, '-t', 'codex', '-f'], { cwd: scratch.dir });
  assertRefused(result, 'install', 'codex');
  assert.deepStrictEqual(snapshot(scratch.home), before);
});

test('refused: HOME spelled through a symlink while the project is spelled through the real path', { skip: IS_WIN && 'symlinks need privileges on Windows', timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  const alias = path.join(scratch.dir, 'alias');
  fs.symlinkSync(scratch.home, alias, 'dir');
  const before = snapshot(scratch.home);
  const result = run(scratch, ['install', '.', '-t', 'codex', '-f'], { cwd: scratch.home, home: alias });
  assertRefused(result, 'install', 'codex');
  assert.deepStrictEqual(snapshot(scratch.home), before);
});

test('refused: HOME spelled /var while the working directory is /private/var', { skip: (IS_WIN || process.platform !== 'darwin') && '/var is a symlink to /private/var on macOS only', timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  assert.ok(scratch.home.startsWith('/private/var/'), `expected a /private/var scratch, got ${scratch.home}`);
  const viaVar = scratch.home.slice('/private'.length);
  assert.strictEqual(fs.realpathSync(viaVar), scratch.home);
  const before = snapshot(scratch.home);
  const result = run(scratch, ['install', '.', '-t', 'codex', '-f'], { cwd: scratch.home, home: viaVar });
  assertRefused(result, 'install', 'codex');
  assert.deepStrictEqual(snapshot(scratch.home), before);
});

test('not refused: a project below HOME installs, and the global ledger is untouched', { timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  const globalLedger = path.join(scratch.home, '.doflow', 'state', 'ledger.json');
  const globalBytes = fs.readFileSync(globalLedger);
  const project = path.join(scratch.home, 'work', 'app');
  fs.mkdirSync(project, { recursive: true });
  const result = run(scratch, ['install', '.', '-t', 'codex', '-f', '--mcp', 'none'], { cwd: project });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'state', 'ledger.json')));
  assert.ok(fs.readFileSync(globalLedger).equals(globalBytes));
});

test('not refused: a global install run from HOME', { timeout: CASE_TIMEOUT_MS }, () => {
  const scratch = installedScratch();
  const result = run(scratch, ['install', '-g', '-t', 'codex', '-f', '--mcp', 'none'], { cwd: scratch.home });
  assert.strictEqual(result.status, 0, result.stderr);
});
