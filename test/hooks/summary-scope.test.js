'use strict';

// Feature 078, IC-012 and IC-014 through the installed front doors: compact summaries are scoped by
// (worktree, run, lineage), a worker claims nothing it was not granted, a grant is delivered once,
// and the pre-078 project-level summary is carried over once and never written again. Every hook
// runs from an install-shaped mirror under a scratch HOME and XDG_CONFIG_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInstallMirror } = require('../helper/hook-fixtures');
const { createScratch } = require('../helper/scratch-env');
const { grantSummary } = require('../../src/runtime/context/summary-store.ts');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'lib.sh');
const scratch = createScratch('doflow-summary-scope-');
const mirror = path.join(scratch.dir, 'mirror');
const STORE = path.join(scratch.xdg, 'doflow', 'session-env');

test.before(() => buildInstallMirror(mirror));
test.after(() => scratch.remove());

let seq = 0;
/** A fresh real-path directory, standing for one worktree. */
function worktree(name = 'wt') {
  const dir = path.join(scratch.dir, `${name}${seq++}`);
  fs.mkdirSync(dir);
  return fs.realpathSync(dir);
}

function hashOf(dir) {
  const r = spawnSync('bash', ['-c', 'source "$1"; cwd_hash "$2"', 'bash', LIB, dir], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const scopeFile = (dir, run = 'local', lineage = 'main') => path.join(STORE, 'summaries', hashOf(dir), run, lineage, 'summary.md');
const legacyFile = (dir) => path.join(STORE, 'projects', hashOf(dir), 'last-compact-summary.md');

function hook(root, harness, script, payload, env = {}) {
  const r = spawnSync('bash', [path.join(root, `.${harness}`, 'hooks', script)], {
    input: JSON.stringify(payload), env: scratch.env(env), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// Session state is shared by every test in this file (one scratch store), and a bootstrapped
// session stays silent, so each test's session ids carry a suffix unique to that test.
let run = 0;
const sid = (name) => `${name}-t${run}`;
test.beforeEach(() => { run += 1; });

function compact(sessionId, cwd, summary, { env = {}, root = mirror } = {}) {
  hook(root, 'claude', 'post-compact.sh', { session_id: sid(sessionId), cwd, trigger: 'auto', compact_summary: summary }, env);
}

/** One prompt event; returns the parsed response and its additionalContext ('' when none). */
function prompt(sessionId, cwd, { env = {}, root = mirror, harness = 'claude' } = {}) {
  const out = JSON.parse(hook(root, harness, 'user-prompt-submit.sh', { session_id: sid(sessionId), cwd }, env) || '{}');
  return { out, ctx: out.additionalContext ?? out.hookSpecificOutput?.additionalContext ?? '' };
}

const launched = (run, lineage) => ({ DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: lineage, DOFLOW_ATTEMPT: '1' });

/**
 * Two main sessions, each in its own worktree, compact; the next session in each worktree gets its
 * own summary and never the other's. `byEnv` names the worktree with DOFLOW_WORKTREE over one shared
 * cwd; otherwise each session runs with the worktree as its cwd.
 */
function isolationScenario(root, { byEnv }) {
  const shared = worktree('cwd');
  const [w1, w2] = [worktree('wt'), worktree('wt')];
  const place = (dir) => (byEnv ? { cwd: shared, env: { DOFLOW_WORKTREE: dir } } : { cwd: dir, env: {} });
  const tag = `${byEnv ? 'ENV' : 'CWD'}${seq++}`;
  compact(`A1-${tag}`, place(w1).cwd, `SUMMARY-ONE-${tag}`, { env: place(w1).env, root });
  compact(`A2-${tag}`, place(w2).cwd, `SUMMARY-TWO-${tag}`, { env: place(w2).env, root });
  const next1 = prompt(`N1-${tag}`, place(w1).cwd, { env: place(w1).env, root }).ctx;
  const next2 = prompt(`N2-${tag}`, place(w2).cwd, { env: place(w2).env, root }).ctx;
  assert.match(next1, new RegExp(`SUMMARY-ONE-${tag}`), 'worktree 1 gets its own summary');
  assert.doesNotMatch(next1, new RegExp(`SUMMARY-TWO-${tag}`), 'worktree 1 never gets worktree 2\'s summary');
  assert.match(next2, new RegExp(`SUMMARY-TWO-${tag}`), 'worktree 2 gets its own summary');
  assert.doesNotMatch(next2, new RegExp(`SUMMARY-ONE-${tag}`), 'worktree 2 never gets worktree 1\'s summary');
  if (byEnv) assert.equal(fs.existsSync(scopeFile(shared)), false, 'nothing is scoped to the shared cwd');
}

test('IC-012: two main sessions in two worktrees (two cwds) each hand the next session only their own summary', () => {
  isolationScenario(mirror, { byEnv: false });
});

test('IC-012: two worktrees named by DOFLOW_WORKTREE over one cwd stay isolated', () => {
  isolationScenario(mirror, { byEnv: true });
});

test('negative control: a store keyed by session_id instead of worktree fails the isolation test', () => {
  const sabotaged = path.join(scratch.dir, 'mirror-session-keyed');
  buildInstallMirror(sabotaged);
  const store = path.join(sabotaged, '.doflow', 'shared', 'hooks', 'policies', 'summary-store.sh');
  // Redefine the scope after the real one: the key is the caller's `session` (bash dynamic scope:
  // doflow_summary_write and doflow_emit_prompt both hold it as a local) instead of cwd_hash.
  fs.appendFileSync(store, [
    '',
    'doflow_summary_scope() {',
    '  DF_SUMMARY_SCOPE=""',
    '  _doflow_ss_id_ok "${2:-}" && _doflow_ss_id_ok "${3:-}" && [ "$3" != solo ] || return 1',
    '  [ -n "${session:-}" ] || return 1',
    '  _doflow_ss_root',
    '  DF_SUMMARY_SCOPE="$_DF_SS_ROOT/summaries/session-${session//[!A-Za-z0-9_-]/_}/$2/$3"',
    '  return 0',
    '}',
    '',
  ].join('\n'));
  // The real store passes the same scenario in the two tests above; this one must fail it, and on
  // the isolation assertion rather than on a hook error.
  for (const byEnv of [false, true]) {
    assert.throws(() => isolationScenario(sabotaged, { byEnv }), { name: 'AssertionError', message: 'worktree 1 gets its own summary' });
  }
});

test('IC-012: an ungranted launched worker gets {} and the main summary stays pending', () => {
  const dir = worktree();
  compact('A', dir, 'MAIN-SUMMARY-UNGRANTED');
  const before = fs.readFileSync(scopeFile(dir));
  const { out, ctx } = prompt('W', dir, { env: launched('r2', 'w2') });
  assert.deepEqual(out, {});
  assert.doesNotMatch(ctx, /MAIN-SUMMARY-UNGRANTED/);
  assert.deepEqual(fs.readFileSync(scopeFile(dir)), before, 'the main summary is untouched');
  assert.match(prompt('M', dir).ctx, /MAIN-SUMMARY-UNGRANTED/, 'the next main session still receives it');
});

test('IC-012, IC-013: a granted worker receives the summary once over two prompts; the owner keeps its copy', () => {
  const dir = worktree();
  compact('A', dir, 'MAIN-SUMMARY-GRANTED');
  const granted = grantSummary({
    summary: 'pending', toRun: 'r1', toLineage: 'w1', fromWorktree: dir, fromRun: 'local', fromLineage: 'main', env: scratch.env(),
  });
  assert.ok(fs.existsSync(granted.path));
  const worker = launched('r1', 'w1');
  const first = prompt('W', dir, { env: worker }).ctx;
  assert.match(first, /^\[Granted summary from lineage main\b/m);
  assert.match(first, /MAIN-SUMMARY-GRANTED/);
  assert.equal(fs.existsSync(granted.path), false, 'the grant is consumed');
  const second = prompt('W', dir, { env: worker });
  assert.doesNotMatch(second.ctx, /MAIN-SUMMARY-GRANTED/, 'the second prompt does not repeat it');
  assert.equal(fs.readdirSync(path.dirname(granted.path)).length, 0, 'no grant or claim file is left');
  assert.match(fs.readFileSync(scopeFile(dir), 'utf8'), /MAIN-SUMMARY-GRANTED/, 'the owner summary is still pending');
  assert.match(prompt('M', dir).ctx, /^\[Prior session summary/m, 'and its own lineage still claims it');
});

test('IC-014: a pre-078 project summary is adopted once, removed, and never written again', () => {
  const dir = worktree();
  const old = legacyFile(dir);
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '---\ncompacted_at: 2026-01-01T00:00:00Z\nsession_id: OLD\ntrigger: auto\nbranch: unknown\n---\n\nSUMMARY-PRE-078\n');
  assert.match(prompt('P', dir).ctx, /SUMMARY-PRE-078/, 'the first main session receives it');
  assert.equal(fs.existsSync(old), false, 'the old file is removed');
  assert.equal(fs.existsSync(scopeFile(dir)), false, 'the adopted copy was claimed');
  assert.doesNotMatch(prompt('Q', dir).ctx, /SUMMARY-PRE-078/, 'a later session does not receive it again');
  compact('Q', dir, 'SUMMARY-POST-078');
  assert.equal(fs.existsSync(old), false, 'a compaction never writes the old path');
  assert.match(fs.readFileSync(scopeFile(dir), 'utf8'), /SUMMARY-POST-078/);
  assert.doesNotMatch(prompt('R', dir).ctx, /SUMMARY-PRE-078/);
  assert.equal(fs.existsSync(old), false);
});
