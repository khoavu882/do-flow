'use strict';

// Fixture-and-measure helper for the verb byte budget (feature 137, IC-009, CH1). It builds the one
// fixture the guard measures on, runs a verb through the dispatcher, normalises machine paths and
// counts UTF-8 bytes, and holds the ceiling rule, so a ceiling always comes from built output.
//
// Fixture: a git repo (`git init -b develop`, one empty commit), an empty HOME, an environment of
// PATH and HOME only, seeded through the dispatcher with 200 follow-ups and one goal with two items
// both checked.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, GIT_NO_MAINTENANCE_ENV } = require('./tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const FOLLOWUP_COUNT = 200;
const STATEMENT_LENGTH = 172;
const DOCTOR_MARGIN = 1024;
const MAX_MARGIN = 512;

/** The IC-009 measured rows (argv after `doflow-run`), in table order. */
const IC009_ROWS: readonly (readonly string[])[] = Object.freeze([
  ['followup', '--action', 'list', '--json'],
  ['followup', '--action', 'list', '--view', 'full', '--json'],
  ['classify', '--task-class', 'feature', '--calling-skill', 'do-design', '--json'],
  ['classify', '--task-class', 'feature', '--calling-skill', 'do-design', '--view', 'brief', '--json'],
  ['classify', '--task-class', 'nope', '--calling-skill', 'do-design', '--json'],
  ['lifecycle', '--action', 'overview', '--json'],
  ['lifecycle', '--action', 'overview', '--view', 'brief', '--json'],
  ['lifecycle', '--action', 'overview', '--maintain', '--json'],
  ['lifecycle', '--action', 'overview', '--maintain', '--view', 'brief', '--json'],
  ['goal', '--action', 'list', '--json'],
  ['workflow', '--task-class', 'feature', '--json'],
  ['rules', '--json'],
  ['capabilities', '--json'],
  ['discover', '--json'],
  ['paths', '--json'],
  ['config', '--json'],
  ['doctor', '--json'],
  ['storage', '--json'],
  ['indicators', '--json'],
  ['package', '--action', 'list', '--json'],
  ['failure', '--action', 'list', '--json'],
  ['git-state', '--json'],
  ['inventory', '--json'],
  ['attendance', '--task-id', 'x', '--json'],
].map((row) => Object.freeze(row)));

/** The fixture's follow-up statement for index `n`: `Fixture follow-up NNN: ` padded with `x`. */
function followupStatement(n: number) {
  return `Fixture follow-up ${String(n).padStart(3, '0')}: `.padEnd(STATEMENT_LENGTH, 'x');
}

function realOf(p: string) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** The environment of a spawn: PATH and the fixture HOME only. */
function fixtureEnv(home: string) {
  return { PATH: process.env.PATH || '', HOME: home };
}

/**
 * Runs the dispatcher with `argv` from `cwd`, stdout piped.
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runVerb(fixture: any, argv: readonly string[]) {
  const out = spawnSync(DISPATCHER, [...argv], { cwd: fixture.root, env: fixtureEnv(fixture.home), encoding: 'utf8', timeout: 120000 });
  return { status: out.status, stdout: out.stdout || '', stderr: out.stderr || '' };
}

function git(cwd: string, home: string, args: string[]) {
  const env = {
    ...fixtureEnv(home),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
  const out = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
}

/**
 * Builds the fixture once: scratch dirs from the shared temp helper (cleaned at suite end), a git repo
 * on `develop` with one empty commit, an empty HOME, and the seeded follow-ups and goal.
 * @returns {{root: string, home: string, followupIds: string[]}}
 */
function buildFixture() {
  const base = suiteTempDir('doflow-verb-fixture-');
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  git(root, home, ['init', '-q', '-b', 'develop']);
  git(root, home, ['commit', '-q', '--allow-empty', '-m', 'fixture base']);
  const fixture: any = { root, home, base };
  const batch = path.join(base, 'followups.json');
  const items = Array.from({ length: FOLLOWUP_COUNT }, (_, n) => ({ statement: followupStatement(n), stage: 'manual', source: 'manual' }));
  fs.writeFileSync(batch, JSON.stringify(items));
  const seed = [
    ['followup', '--action', 'add', '--source', 'manual', '--batch', batch, '--json'],
    ['goal', '--action', 'add', '--goal', 'fixture-goal', '--statement', 'Fixture goal', '--item', 'one', '--item', 'two', '--json'],
    ['goal', '--action', 'check', '--goal', 'fixture-goal', '--item', 'C1', '--evidence', 'fixture', '--json'],
    ['goal', '--action', 'check', '--goal', 'fixture-goal', '--item', 'C2', '--evidence', 'fixture', '--json'],
  ];
  for (const argv of seed) {
    const out = runVerb(fixture, argv);
    if (out.status !== 0) throw new Error(`fixture seed failed (${argv.slice(0, 3).join(' ')}): exit ${out.status}: ${out.stdout}${out.stderr}`);
  }
  return fixture;
}

/** Replaces the fixture root, HOME (each as given and as the real path) and the repository root. */
function normalize(text: string, fixture: any) {
  const pairs: [string, string][] = [];
  for (const p of new Set([fixture.root, realOf(fixture.root)])) pairs.push([p, '<ROOT>']);
  for (const p of new Set([fixture.home, realOf(fixture.home)])) pairs.push([p, '<HOME>']);
  for (const p of new Set([REPO, realOf(REPO)])) pairs.push([p, '<RUNTIME>']);
  // Longest path first, so a path that contains another is not cut by the shorter one.
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/** UTF-8 length of `text`. */
function byteCount(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

function roundUp64(n: number) {
  return Math.ceil(n / 64) * 64;
}

/**
 * The IC-009 ceiling rule: `roundUp64(measured + min(ceil(measured * 0.05), 512))`; `doctor` takes a
 * flat 1,024 B margin instead (design R7).
 * @param {number} measured
 * @param {{doctor?: boolean}} [options]
 */
function ceilingFor(measured: number, { doctor = false }: { doctor?: boolean } = {}) {
  const margin = doctor ? DOCTOR_MARGIN : Math.min(Math.ceil(measured * 0.05), MAX_MARGIN);
  return roundUp64(measured + margin);
}

/**
 * Runs `argv` on the fixture and measures the normalised stdout.
 * @returns {{argv: string[], status: number|null, bytes: number, stdout: string}}
 */
function measureVerb(fixture: any, argv: readonly string[]) {
  const out = runVerb(fixture, argv);
  const stdout = normalize(out.stdout, fixture);
  return { argv: [...argv], status: out.status, bytes: byteCount(stdout), stdout };
}

module.exports = {
  REPO, DISPATCHER, FOLLOWUP_COUNT, IC009_ROWS,
  buildFixture, runVerb, measureVerb, normalize, byteCount, ceilingFor, followupStatement,
};
