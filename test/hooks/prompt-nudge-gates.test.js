'use strict';

// The gate helpers the prompt nudge hook uses (IC-006, IC-008, IC-009): repository root walk, the
// opt-out setting, the marker file, the feature-folder and run-ledger probes, and the registry lookup.
// Each function is called from `bash -c` after sourcing the shared lib.sh, under a scratch HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'lib.sh');
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';
const scratch = createScratch('doflow-nudge-gates-');
const NUDGE_DIR = path.join(scratch.xdg, 'doflow', 'session-env', 'nudge');
const USER_SETTING = path.join(scratch.xdg, 'doflow', 'prompt-nudge');

test.after(() => scratch.remove());

let seq = 0;
function fresh(name = 'd') {
  const dir = path.join(scratch.dir, `${name}${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A scratch git repository on `branch`; `commit` makes one commit so worktrees can be added. */
function repo(branch = 'main', { commit = false } = {}) {
  const dir = fresh('repo');
  git(dir, 'init', '-q', '-b', branch);
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** Runs `fn args...` from lib.sh in a fresh bash; returns { status, stdout, stderr }. */
function call(fn, args = [], env = {}) {
  const r = spawnSync(BASH, ['-c', 'source "$1"; shift; "$@"', 'bash', LIB, fn, ...args], {
    env: scratch.env(env), encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const out = (fn, args, env) => {
  const r = call(fn, args, env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, '');
};

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('sourcing lib.sh prints nothing and defines the nudge functions', () => {
  const quiet = spawnSync(BASH, ['-c', 'source "$1"', 'bash', LIB], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  for (const fn of ['nudge_repo_root', 'nudge_setting', 'nudge_safe_id', 'nudge_marker_file', 'nudge_mark',
    'nudge_feature_active', 'nudge_ledger_active', 'nudge_registry']) {
    assert.equal(call('declare', ['-F', fn]).status, 0, `${fn} is not defined`);
  }
});

test('lib.sh adds no trap and no top-level statement for the nudge helpers', () => {
  const text = fs.readFileSync(LIB, 'utf8');
  assert.ok(!/trap\s+[^\n]*\bERR\b/.test(text));
});

// ── nudge_repo_root ─────────────────────────────────────────────────────────

test('root walk: repository root, a subdirectory, a linked worktree, a non-git directory', () => {
  const root = repo('main', { commit: true });
  assert.equal(out('nudge_repo_root', [root]), root);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(out('nudge_repo_root', [sub]), root);
  assert.equal(out('nudge_repo_root', [`${root}/`]), root);

  const wt = path.join(fresh('wt'), 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'a linked worktree has a .git file');
  const wtSub = path.join(wt, 'a');
  fs.mkdirSync(wtSub);
  assert.equal(out('nudge_repo_root', [wtSub]), fs.realpathSync(wt));

  const plain = fresh('plain');
  assert.equal(out('nudge_repo_root', [plain]), plain);
});

// ── nudge_setting ───────────────────────────────────────────────────────────

function setting(root, { project, user } = {}) {
  fs.rmSync(path.join(root, '.doflow'), { recursive: true, force: true });
  fs.rmSync(USER_SETTING, { force: true });
  if (project !== undefined) write(path.join(root, '.doflow', 'prompt-nudge'), project);
  if (user !== undefined) write(USER_SETTING, user);
  return out('nudge_setting', [root]);
}

test('setting: project file wins over the user file, neither gives on', () => {
  const root = fresh('proj');
  assert.equal(setting(root), 'on');
  assert.equal(setting(root, { project: 'on\n', user: 'off\n' }), 'on');
  assert.equal(setting(root, { project: 'off\n', user: 'on\n' }), 'off');
  assert.equal(setting(root, { user: 'off\n' }), 'off');
  assert.equal(setting(root, { user: 'on\n' }), 'on');
});

test('setting: an empty, unknown or malformed present file counts as off and blocks lower precedence', () => {
  const root = fresh('proj');
  assert.equal(setting(root, { project: '', user: 'on\n' }), 'off');
  assert.equal(setting(root, { project: 'maybe\n', user: 'on\n' }), 'off');
  assert.equal(setting(root, { project: '\n', user: 'on\n' }), 'off');
  assert.equal(setting(root, { user: '' }), 'off');
  assert.equal(setting(root, { user: 'maybe' }), 'off');
});

test('setting: first line only, trimmed and case-insensitive, no trailing newline needed', () => {
  const root = fresh('proj');
  assert.equal(setting(root, { project: ' OFF \n' }), 'off');
  assert.equal(setting(root, { project: 'On' }), 'on');
  assert.equal(setting(root, { project: 'off\r\n' }), 'off');
  assert.equal(setting(root, { project: '\ton\t\nignored\n' }), 'on');
  assert.equal(setting(root, { project: 'on\noff\n' }), 'on');
  assert.equal(setting(root, { project: 'onoff\n' }), 'off');
});

test('setting: an unreadable project file counts as off', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const root = fresh('proj');
  const file = write(path.join(root, '.doflow', 'prompt-nudge'), 'on\n');
  fs.chmodSync(file, 0o000);
  try {
    fs.rmSync(USER_SETTING, { force: true });
    write(USER_SETTING, 'on\n');
    const r = call('nudge_setting', [root]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'off');
    assert.equal(r.stderr, '');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('setting: a directory in place of the file counts as off', () => {
  const root = fresh('proj');
  fs.rmSync(USER_SETTING, { force: true });
  fs.mkdirSync(path.join(root, '.doflow', 'prompt-nudge'), { recursive: true });
  const r = call('nudge_setting', [root]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'off');
});

test('setting: an empty root consults only the user file', () => {
  fs.rmSync(USER_SETTING, { force: true });
  assert.equal(out('nudge_setting', ['']), 'on');
  write(USER_SETTING, 'off\n');
  assert.equal(out('nudge_setting', ['']), 'off');
  fs.rmSync(USER_SETTING, { force: true });
});

// ── nudge_safe_id / nudge_marker_file / nudge_mark ──────────────────────────

test('safe ids: a UUID and plain names pass; empty, traversal, slash, space, newline and 129 characters fail', () => {
  const ok = ['9b6f2c1e-3a4d-4e5f-8a7b-0c1d2e3f4a5b', 'A', 'a.b_c-d', '0'.repeat(128)];
  const bad = ['', '../x', 'a/b', 'a b', '.hidden', '-lead', 'a\nb', 'a'.repeat(129), '_x'];
  for (const id of ok) assert.equal(call('nudge_safe_id', [id]).status, 0, `accepts ${JSON.stringify(id)}`);
  for (const id of bad) assert.notEqual(call('nudge_safe_id', [id]).status, 0, `rejects ${JSON.stringify(id)}`);
});

test('marker file path is <state>/nudge/<id>', () => {
  assert.equal(out('nudge_marker_file', ['abc-1']), path.join(NUDGE_DIR, 'abc-1'));
});

test('exclusive create: first call wins, second fails and leaves the first content', () => {
  fs.rmSync(NUDGE_DIR, { recursive: true, force: true });
  const first = call('nudge_mark', ['sess-a', 'nudged']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.equal(first.stderr, '');
  const file = path.join(NUDGE_DIR, 'sess-a');
  assert.equal(fs.readFileSync(file, 'utf8'), 'nudged\n');
  const second = call('nudge_mark', ['sess-a', 'suppressed']);
  assert.notEqual(second.status, 0);
  assert.equal(second.stderr, '');
  assert.equal(fs.readFileSync(file, 'utf8'), 'nudged\n');
});

test('marker content is one word and a newline; two sessions get two markers', () => {
  fs.rmSync(NUDGE_DIR, { recursive: true, force: true });
  assert.equal(call('nudge_mark', ['s1', 'suppressed']).status, 0);
  assert.equal(call('nudge_mark', ['s2', 'nudged']).status, 0);
  assert.equal(fs.readFileSync(path.join(NUDGE_DIR, 's1'), 'utf8'), 'suppressed\n');
  assert.equal(fs.readFileSync(path.join(NUDGE_DIR, 's2'), 'utf8'), 'nudged\n');
});

test('an unsafe id or an unknown word creates nothing', () => {
  fs.rmSync(NUDGE_DIR, { recursive: true, force: true });
  assert.notEqual(call('nudge_mark', ['../escape', 'nudged']).status, 0);
  assert.notEqual(call('nudge_mark', ['ok-id', 'prompt text here']).status, 0);
  assert.equal(fs.existsSync(path.join(NUDGE_DIR, 'ok-id')), false);
  assert.equal(fs.existsSync(path.join(NUDGE_DIR, '..', 'escape')), false);
});

test('pruning: after a create, a marker older than 30 days is removed and a newer one kept', () => {
  fs.rmSync(NUDGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(NUDGE_DIR, { recursive: true });
  const old = write(path.join(NUDGE_DIR, 'old'), 'nudged\n');
  const recent = write(path.join(NUDGE_DIR, 'recent'), 'nudged\n');
  const day = 24 * 3600 * 1000;
  fs.utimesSync(old, new Date(Date.now() - 31 * day), new Date(Date.now() - 31 * day));
  fs.utimesSync(recent, new Date(Date.now() - 29 * day), new Date(Date.now() - 29 * day));
  assert.equal(call('nudge_mark', ['new', 'nudged']).status, 0);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(path.join(NUDGE_DIR, 'new')), true);
});

test('an unwritable state directory fails the create silently', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const state = path.join(scratch.xdg, 'doflow', 'session-env');
  fs.rmSync(NUDGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.chmodSync(state, 0o500);
  try {
    const r = call('nudge_mark', ['locked', 'nudged']);
    assert.notEqual(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    fs.chmodSync(state, 0o755);
  }
});

// ── nudge_feature_active (S2) ───────────────────────────────────────────────

function featureCase({ branch, folder, context }) {
  const root = repo(branch);
  if (folder) fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', folder), { recursive: true });
  const session = fresh('session');
  if (context !== undefined) write(path.join(session, 'git-context.json'), JSON.stringify(context));
  return call('nudge_feature_active', [root, root, session]).status;
}

test('feature probe: a feature branch with its agent-docs folder fires', () => {
  assert.equal(featureCase({ branch: 'feat/900-demo', folder: '900-demo' }), 0);
  assert.equal(featureCase({ branch: 'kai/900-demo', folder: '900-demo' }), 0);
  assert.equal(featureCase({ branch: '900-demo', folder: '900-demo' }), 0);
});

test('feature probe: no folder, a different folder, or a protected branch does not fire', () => {
  assert.notEqual(featureCase({ branch: 'feat/900-demo' }), 0);
  assert.notEqual(featureCase({ branch: 'feat/900-demo', folder: '901-other' }), 0);
  for (const b of ['main', 'master', 'develop', 'trunk']) {
    assert.notEqual(featureCase({ branch: b, folder: b }), 0, `${b} never fires`);
  }
});

test('feature probe: no repository, an empty root, or a plain directory never fires', () => {
  const plain = fresh('plain');
  fs.mkdirSync(path.join(plain, 'agent-docs', 'doflow', 'x'), { recursive: true });
  assert.notEqual(call('nudge_feature_active', [plain, plain, fresh('session')]).status, 0);
  assert.notEqual(call('nudge_feature_active', [plain, '', fresh('session')]).status, 0);
});

test('feature probe: the branch comes from git-context.json when present, else from git', () => {
  // Repo is on main, the session recorded the feature branch: fires.
  assert.equal(featureCase({ branch: 'main', folder: '900-demo', context: { branch: 'feat/900-demo' } }), 0);
  // Repo is on the feature branch, the session recorded main: does not fire.
  assert.notEqual(featureCase({ branch: 'feat/900-demo', folder: '900-demo', context: { branch: 'main' } }), 0);
  // An empty recorded branch (detached or no repository at session start) does not fall back to git.
  assert.notEqual(featureCase({ branch: 'feat/900-demo', folder: '900-demo', context: { branch: '' } }), 0);
  // An unparsable context file falls back to git.
  const root = repo('feat/900-demo');
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '900-demo'), { recursive: true });
  const session = fresh('session');
  write(path.join(session, 'git-context.json'), 'not json');
  assert.equal(call('nudge_feature_active', [root, root, session]).status, 0);
});

test('feature probe: works from a subdirectory cwd with the root passed in', () => {
  const root = repo('feat/900-demo');
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '900-demo'), { recursive: true });
  const sub = path.join(root, 'src');
  fs.mkdirSync(sub);
  assert.equal(call('nudge_feature_active', [sub, root, fresh('session')]).status, 0);
});

// ── nudge_ledger_active (S3) ────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

function ledgerCase({ lines, name, captured, configEnv = true }) {
  const cwd = fresh('ledger');
  const config = path.join(cwd, '.doflow');
  const runs = path.join(config, 'state', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  if (lines !== undefined) write(path.join(runs, name || `${today()}.jsonl`), lines);
  const session = fresh('session');
  if (captured !== undefined) write(path.join(session, 'git-context.json'), JSON.stringify({ captured_at: captured }));
  const env = configEnv ? { DOFLOW_CONFIG_DIR: config } : {};
  return call('nudge_ledger_active', [cwd, session], env).status;
}

const rec = (ts) => `{"timestamp":"${ts}","verb":"x","exit_code":0,"duration_ms":1,"arg_count":0}\n`;

test('ledger probe: a last line newer than captured_at fires, older does not, equal fires', () => {
  const cap = '2026-10-09T10:00:00Z';
  assert.equal(ledgerCase({ lines: rec('2026-10-09T09:00:00Z') + rec('2026-10-09T10:30:00Z'), captured: cap }), 0);
  assert.equal(ledgerCase({ lines: rec('2026-10-09T10:00:00Z'), captured: cap }), 0);
  assert.notEqual(ledgerCase({ lines: rec('2026-10-09T11:00:00Z') + rec('2026-10-09T09:59:59Z'), captured: cap }), 0);
  assert.notEqual(ledgerCase({ lines: rec('2026-10-08T23:00:00Z'), captured: cap }), 0);
});

test('ledger probe: unknown captured_at fires only for a ledger file named today (UTC)', () => {
  assert.equal(ledgerCase({ lines: rec('2026-10-09T09:00:00Z') }), 0);
  assert.notEqual(ledgerCase({ lines: rec('2026-10-09T09:00:00Z'), name: '2001-01-01.jsonl' }), 0);
  // A context file without captured_at behaves as unknown.
  const cwd = fresh('ledger');
  const config = path.join(cwd, '.doflow');
  write(path.join(config, 'state', 'runs', `${today()}.jsonl`), rec('2026-10-09T09:00:00Z'));
  const session = fresh('session');
  write(path.join(session, 'git-context.json'), '{"branch":"main"}');
  assert.equal(call('nudge_ledger_active', [cwd, session], { DOFLOW_CONFIG_DIR: config }).status, 0);
});

test('ledger probe: an unparsable last line fires', () => {
  assert.equal(ledgerCase({ lines: rec('2026-10-09T09:00:00Z') + 'not json\n', captured: '2026-10-09T10:00:00Z' }), 0);
  assert.equal(ledgerCase({ lines: '{"verb":"x"}\n', captured: '2026-10-09T10:00:00Z' }), 0);
  assert.equal(ledgerCase({ lines: rec('garbage'), captured: '2026-10-09T10:00:00Z' }), 0);
});

test('ledger probe: no ledger, an empty ledger or no runs directory does not fire', () => {
  assert.notEqual(ledgerCase({ captured: '2026-10-09T10:00:00Z' }), 0);
  assert.notEqual(ledgerCase({ lines: '', captured: '2026-10-09T10:00:00Z' }), 0);
  const cwd = fresh('ledger');
  assert.notEqual(call('nudge_ledger_active', [cwd, fresh('session')], { DOFLOW_CONFIG_DIR: path.join(cwd, 'none') }).status, 0);
});

test('ledger probe: the lexically last file is the one read', () => {
  const cap = '2026-10-09T10:00:00Z';
  const cwd = fresh('ledger');
  const runs = path.join(cwd, '.doflow', 'state', 'runs');
  write(path.join(runs, '2026-10-01.jsonl'), rec('2026-10-09T12:00:00Z'));
  write(path.join(runs, '2026-10-08.jsonl'), rec('2026-10-08T12:00:00Z'));
  const session = fresh('session');
  write(path.join(session, 'git-context.json'), JSON.stringify({ captured_at: cap }));
  assert.notEqual(call('nudge_ledger_active', [cwd, session], { DOFLOW_CONFIG_DIR: path.join(cwd, '.doflow') }).status, 0);
});

test('ledger probe: config dir from DOFLOW_CONFIG_DIR, then the nearest .doflow above cwd, then HOME/.doflow', () => {
  const cap = '2026-10-09T10:00:00Z';
  const session = fresh('session');
  write(path.join(session, 'git-context.json'), JSON.stringify({ captured_at: cap }));
  const fires = (cwd, env) => call('nudge_ledger_active', [cwd, session], env).status === 0;

  // nearest .doflow at or above cwd
  const proj = fresh('proj');
  const sub = path.join(proj, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  write(path.join(proj, '.doflow', 'state', 'runs', '2026-10-09.jsonl'), rec('2026-10-09T10:05:00Z'));
  assert.equal(fires(sub, {}), true);
  assert.equal(fires(proj, {}), true);

  // DOFLOW_CONFIG_DIR beats the walk
  const other = fresh('other');
  assert.equal(fires(sub, { DOFLOW_CONFIG_DIR: path.join(other, '.doflow') }), false);
  write(path.join(other, '.doflow', 'state', 'runs', '2026-10-09.jsonl'), rec('2026-10-09T10:06:00Z'));
  assert.equal(fires(sub, { DOFLOW_CONFIG_DIR: path.join(other, '.doflow') }), true);

  // no .doflow above cwd: HOME/.doflow
  const bare = fresh('bare');
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  assert.equal(fires(bare, {}), false);
  write(path.join(scratch.home, '.doflow', 'state', 'runs', '2026-10-09.jsonl'), rec('2026-10-09T10:07:00Z'));
  assert.equal(fires(bare, {}), true);
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
});

// ── nudge_registry ──────────────────────────────────────────────────────────

test('registry lookup follows IC-006 order and fails when no candidate exists', () => {
  const base = fresh('reg');
  const policy = path.join(base, 'x', 'shared', 'hooks', 'policies');
  fs.mkdirSync(policy, { recursive: true });
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const c1 = path.join(base, 'x', 'runtime', 'core', 'registry', 'workflows.json');
  const c3 = path.join(root, '.doflow', 'runtime', 'core', 'registry', 'workflows.json');
  const c4 = path.join(scratch.home, '.doflow', 'runtime', 'core', 'registry', 'workflows.json');
  const resolve = () => {
    const r = call('nudge_registry', [policy, root]);
    return r.status === 0 ? fs.realpathSync(r.stdout.trim()) : null;
  };
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  assert.equal(resolve(), null);
  assert.notEqual(call('nudge_registry', [policy, root]).status, 0);

  write(c4, '{}');
  assert.equal(resolve(), fs.realpathSync(c4));
  write(c3, '{}');
  assert.equal(resolve(), fs.realpathSync(c3));

  // candidate 2 is `<policy>/../../../../registry/workflows.json`: four levels above the policy folder
  const srcPolicy = path.join(base, 'core', 'harnesses', 'shared', 'hooks', 'policies');
  fs.mkdirSync(srcPolicy, { recursive: true });
  write(path.join(base, 'core', 'registry', 'workflows.json'), '{}');
  const r2 = call('nudge_registry', [srcPolicy, root]);
  assert.equal(r2.status, 0);
  assert.equal(fs.realpathSync(r2.stdout.trim()), fs.realpathSync(path.join(base, 'core', 'registry', 'workflows.json')));

  write(c1, '{}');
  assert.equal(resolve(), fs.realpathSync(c1));
});

test('registry lookup skips a directory candidate and an empty policy folder argument', () => {
  const base = fresh('reg');
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, '.doflow', 'runtime', 'core', 'registry', 'workflows.json'), { recursive: true });
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  assert.notEqual(call('nudge_registry', ['', root]).status, 0);
  const file = path.join(scratch.home, '.doflow', 'runtime', 'core', 'registry', 'workflows.json');
  write(file, '{}');
  const r = call('nudge_registry', ['', root]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), file);
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
});

test('the shipped source tree resolves its own registry through candidate 2', () => {
  const policy = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
  fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  const r = call('nudge_registry', [policy, fresh('project')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.realpathSync(r.stdout.trim()), path.join(REPO, 'core', 'registry', 'workflows.json'));
});
