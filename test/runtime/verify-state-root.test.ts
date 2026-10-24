'use strict';

// 088 D.1-fix (G-O1 D4): verification state (check logs, the verify-moment upkeep) resolves through
// the store the ledger uses — DOFLOW_CONFIG_DIR, else the nearest existing `.doflow` above the
// working directory, else the runtime's own install, else an existing `~/.doflow` — never a
// `.doflow` created under the working directory. A failing verify in a dispatch attempt worktree
// used to create `<worktree>/.doflow/state/{runs,verification/logs,upkeep-due}`; later records
// split into that fragment and were deleted with the worktree. Only when no store exists anywhere
// does verify keep today's `<cwd>/.doflow`.
//
// Every spawn uses a scratch HOME (no `~/.doflow`) with pruning on, so the verify-moment upkeep
// runs and records its `storage upkeep` ledger line, and telemetry switched on.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { verifyStateRoot } = require('../../src/runtime/verification/engine.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

const scratch = createScratch('doflow-verify-state-root-', { prune: 'on' });
after(() => scratch.remove());

function git(cwd: any, ...args: any[]) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: scratch.env() });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

/** A git project whose LOW contract has one failing test command (with output, so its log is
 * persisted); `store` adds `.doflow/state/runs`. */
function project({ store = true }: any = {}) {
  const root = fs.realpathSync(suiteTempDir('doflow-verify-state-root-'));
  if (store) fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  const override: any = { parse: null, build: 'node -e 0', typecheck: null, lint: 'node -e 0', test: 'node -e "console.log(\'not ok 1 - x\'); process.exit(1)"', testTargeted: 'node -e 0 {pattern}' };
  fs.writeFileSync(path.join(root, 'plan.md'), `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(override)}\n\`\`\`\n`);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, plan: path.join(root, 'plan.md') };
}

/** A linked worktree at the dispatch attempt layout, `<root>/.doflow/state/dispatch-worktrees/<id>`. */
function attemptWorktree(p: any) {
  const wt = path.join(p.root, '.doflow', 'state', 'dispatch-worktrees', 'd-0123456789ab');
  git(p.root, 'worktree', 'add', '-q', '--detach', wt);
  return wt;
}

function verify(p: any, cwd: any, extra: any = {}) {
  const res = spawnSync(process.execPath, [DOFLOW, 'verify', '--task-id', 'T-1', '--risk', 'LOW', '--plan-path', p.plan,
    '--scope', 'pkg/a.js', '--json'], {
    cwd, encoding: 'utf8',
    env: scratch.env({ DOFLOW_TELEMETRY: 'on', DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_CONFIG_DIR: undefined, ...extra }),
  });
  assert.equal(res.status, 1, `the failing contract exits 1: ${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).status, 'FAIL');
  return res;
}

const lines = (dir: any) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f: any) => f.endsWith('.jsonl')).sort()
  .flatMap((f: any) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l: any) => JSON.parse(l))) : []);

/** What a store holds: check logs, verify.run telemetry lines, storage upkeep ledger lines. */
function holdings(configDir: any) {
  const logs = path.join(configDir, 'state', 'verification', 'logs');
  const runs = path.join(configDir, 'state', 'runs');
  return {
    logs: fs.existsSync(logs) ? fs.readdirSync(logs).length : 0,
    verifyRuns: lines(path.join(runs, 'telemetry')).filter((l: any) => l.kind === 'verify.run').length,
    upkeep: lines(runs).filter((l: any) => l.verb === 'storage' && l.kind === 'upkeep').length,
  };
}

/** Two failing verifies from `cwd`: no `.doflow` appears under it and both land in `store`. */
function assertNoFragment(p: any, cwd: any, extra: any = {}) {
  const store = path.join(p.root, '.doflow');
  verify(p, cwd, extra);
  assert.equal(fs.existsSync(path.join(cwd, '.doflow')), false, `the first failing verify created ${path.join(cwd, '.doflow')}`);
  const first = holdings(store);
  assert.ok(first.logs >= 1, 'the failing check log is in the resolved store');
  assert.equal(first.verifyRuns, 1, 'the verify.run line is in the resolved store');
  assert.ok(first.upkeep >= 1, 'the verify-moment upkeep ran on the resolved store and recorded its line there');
  verify(p, cwd, extra);
  assert.equal(fs.existsSync(path.join(cwd, '.doflow')), false, 'the second failing verify created a .doflow under the cwd');
  const second = holdings(store);
  assert.equal(second.verifyRuns, 2, 'the second verify wrote to the same store (no split)');
  assert.ok(second.logs > first.logs, 'the second failing check log is in the same store');
}

test('a failing verify from a project subdirectory creates no .doflow there; state goes to the project store', () => {
  const p = project();
  assertNoFragment(p, path.join(p.root, 'pkg'));
});

test('a failing verify in an attempt worktree, DOFLOW_CONFIG_DIR unset, writes to the store the walk-up finds', () => {
  const p = project();
  assertNoFragment(p, attemptWorktree(p));
});

test('N1: a failing verify in an attempt worktree with planted delivery pack writes to <P>, not <W>', (t) => {
  const p = project();
  const wt = path.join(p.root, '.doflow', 'state', 'dispatch-worktrees', 'd-000000000001');
  git(p.root, 'worktree', 'add', '-q', '--detach', wt);
  const deliveryDir = path.join(wt, '.doflow', 'state', 'delivery');
  fs.mkdirSync(deliveryDir, { recursive: true });
  fs.writeFileSync(path.join(deliveryDir, 'A.1.json'), '{}');

  const scratchDir = tempDir(t, 'doflow-verify-scratch-');
  const home = path.join(scratchDir, 'home');
  const xdg = path.join(scratchDir, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'doflow', 'prune'), 'on\n');
  const env: any = { HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_CONFIG_DIR: undefined };

  const store = path.join(p.root, '.doflow');
  verify(p, wt, env);
  const first = holdings(store);
  assert.ok(first.logs >= 1, 'logs land in <P>');
  assert.equal(first.verifyRuns, 1, 'verify.run lands in <P>');
  assert.ok(first.upkeep >= 1, 'upkeep line lands in <P>');
  const wtState = path.join(wt, '.doflow', 'state');
  assert.deepEqual(fs.readdirSync(wtState).sort(), ['delivery'], 'nothing is created under <W>/.doflow/state besides delivery/ after first verify');

  verify(p, wt, env);
  const second = holdings(store);
  assert.equal(second.verifyRuns, 2, 'a second verify still in <P>');
  assert.ok(second.logs > first.logs, 'second verify logs still in <P>');
  assert.deepEqual(fs.readdirSync(wtState).sort(), ['delivery'], 'nothing is created under <W>/.doflow/state besides delivery/ after second verify');

  const res = verifyStateRoot({ start: wt, env });
  assert.equal(res.projectRoot, p.root, 'verifyStateRoot projectRoot = <P>');
});

test('a failing verify in an attempt worktree with DOFLOW_CONFIG_DIR set writes to that store', () => {
  const p = project();
  assertNoFragment(p, attemptWorktree(p), { DOFLOW_CONFIG_DIR: path.join(p.root, '.doflow') });
});

test('an explicit DOFLOW_CONFIG_DIR wins over a nearer .doflow that holds state/runs', () => {
  const p = project();
  const wt = attemptWorktree(p);
  const near = path.join(wt, '.doflow');
  fs.mkdirSync(path.join(near, 'state', 'runs'), { recursive: true }); // a fragment left by an older runtime
  verify(p, wt, { DOFLOW_CONFIG_DIR: path.join(p.root, '.doflow') });
  assert.deepEqual(holdings(near), { logs: 0, verifyRuns: 0, upkeep: 0 }, 'nothing went to the nearer .doflow');
  const store = holdings(path.join(p.root, '.doflow'));
  assert.ok(store.logs >= 1 && store.verifyRuns === 1 && store.upkeep >= 1, JSON.stringify(store));
});

test('a project with no store anywhere keeps the <cwd>/.doflow fallback', () => {
  const p = project({ store: false });
  // Its own HOME: any earlier verb's user-state upkeep line creates `~/.doflow`, which is a store.
  const fresh = createScratch('doflow-verify-state-root-nostore-', { prune: 'on' });
  after(() => fresh.remove());
  verify(p, p.root, { HOME: fresh.home, XDG_CONFIG_HOME: fresh.xdg });
  const logs = path.join(p.root, '.doflow', 'state', 'verification', 'logs');
  assert.ok(fs.existsSync(logs) && fs.readdirSync(logs).length >= 1, 'the check log is under the project root, as before');
});

test('verifyStateRoot order: DOFLOW_CONFIG_DIR, walk-up, the runtime install, an existing ~/.doflow, then the cwd', () => {
  const base = fs.realpathSync(suiteTempDir('doflow-verify-state-order-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'sub');
  const install = path.join(base, 'proj', '.doflow');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(install, 'runtime'), { recursive: true });
  const at = (env: any, installRoot: any) => verifyStateRoot({ start: cwd, env, homeDir: home, installRoot });

  // Nothing anywhere: the cwd fallback, project root = cwd (today's behaviour).
  assert.deepEqual(at({}, path.join(base, 'checkout')), { configDir: path.join(cwd, '.doflow'), projectRoot: cwd });
  // An existing ~/.doflow.
  fs.mkdirSync(path.join(home, '.doflow'));
  assert.deepEqual(at({}, path.join(base, 'checkout')), { configDir: path.join(home, '.doflow'), projectRoot: home });
  // The install this runtime was copied into beats ~/.doflow.
  assert.deepEqual(at({}, path.join(install, 'runtime')), { configDir: install, projectRoot: path.join(base, 'proj') });
  // An existing .doflow above the cwd beats the install.
  fs.mkdirSync(path.join(base, 'work', '.doflow'));
  assert.deepEqual(at({}, path.join(install, 'runtime')), { configDir: path.join(base, 'work', '.doflow'), projectRoot: path.join(base, 'work') });
  // DOFLOW_CONFIG_DIR beats everything; one not named .doflow has no project root for upkeep.
  const custom = path.join(base, 'custom-store');
  assert.deepEqual(at({ DOFLOW_CONFIG_DIR: custom }, path.join(install, 'runtime')), { configDir: custom, projectRoot: null });
  assert.deepEqual(at({ DOFLOW_CONFIG_DIR: install }, null), { configDir: install, projectRoot: path.join(base, 'proj') });
});
