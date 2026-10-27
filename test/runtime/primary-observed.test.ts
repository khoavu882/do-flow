'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Row 093 E.5 (IC-018 a): `doflow primary --action observed` lists the project's checkouts and the
// hook records of sessions that worked in them, joined by session key. A scratch HOME, config home
// and git repository (one linked and one detached worktree, plus a second project); the hook
// records come from the real `observe-model.sh` (through bridge.sh) and `session-context.sh`.
// No path, raw session id or other project's record reaches the output, and the verb writes nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { encodeEnvelope } = require('../helper/hook-fixtures.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const BRIDGE = path.join(REPO, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const SESSION_CONTEXT = path.join(REPO, 'core/harnesses/shared/hooks/policies/session-context.sh');
const COMMIT_DATE = '2026-01-02T03:04:05Z';
const S1 = 'e5-session-alpha-RAWID-1';
const S2 = 'e5-session-beta-RAWID-2';
const S3 = 'e5-session-other-project-RAWID-3';
const LAUNCHED = 'L.r9.lin2.3';
const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // GUARD: needs bash + jq

const sessionKey = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

function treeSnapshot(root: string) {
  const entries: any = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const base = { mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
      const rel = path.relative(root, file);
      if (info.isDirectory()) { entries[rel] = { type: 'dir', ...base }; visit(file); }
      else if (info.isFile()) entries[rel] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...base };
      else entries[rel] = { type: 'other', ...base };
    }
  };
  const top = fs.lstatSync(root, { bigint: true });
  entries['.'] = { mtimeNs: top.mtimeNs.toString(), ino: top.ino.toString() };
  visit(root);
  return entries;
}

function baseEnv(f: any): any {
  return {
    HOME: f.home, XDG_CONFIG_HOME: f.config, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off',
    CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', DOFLOW_PROJECT_DIR: '', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '',
  };
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_COMMITTER_DATE: COMMIT_DATE, GIT_AUTHOR_DATE: COMMIT_DATE },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}

/** The real observe-model step, through bridge.sh, for one main session. */
function observe(f: any, sessionId: string, cwd: string, model = 'claude-sonnet-4') {
  const native = { hook_event_name: 'SessionStart', session_id: sessionId, model, cwd };
  const r = spawnSync(bashPath(), [BRIDGE, 'claude', 'SessionStart', 'mcp-tool-guard'], { cwd, env: baseEnv(f), input: JSON.stringify(native), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** The real session-context.sh SessionStart policy for one session. */
function sessionStart(f: any, sessionId: string, cwd: string) {
  const env = { ...baseEnv(f), DOFLOW_AGENT: 'claude' };
  const input = encodeEnvelope('claude', 'SessionStart', 'session-context', JSON.stringify({ session_id: sessionId, cwd, source: 'startup' }), env);
  const r = spawnSync(bashPath(), [SESSION_CONTEXT], { cwd, env, input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture(t: any) {
  const root = tempDir(t, 'doflow-primary-observed-');
  const f: any = {
    root, home: path.join(root, 'home'), config: path.join(root, 'config'),
    main: path.join(root, 'proj'), linked: path.join(root, 'proj-linked'), detached: path.join(root, 'proj-detached'), other: path.join(root, 'other'),
  };
  fs.mkdirSync(f.home);
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  repo(f.main);
  git(f.main, 'worktree', 'add', '-q', '-b', 'feat-x', f.linked);
  git(f.main, 'worktree', 'add', '-q', '--detach', f.detached);
  repo(f.other);
  f.store = path.join(f.config, 'doflow', 'session-env');

  // S1: an observation and a session directory for one id in the linked worktree: one entry.
  observe(f, S1, f.linked);
  sessionStart(f, S1, f.linked);
  // S2: an observation only, in the main checkout.
  observe(f, S2, f.main, 'claude-opus-4');
  // S3: a session of a second project, both records.
  observe(f, S3, f.other);
  sessionStart(f, S3, f.other);
  // A launched unit's directory in the detached worktree.
  const unit = path.join(f.store, 'sessions', LAUNCHED);
  fs.mkdirSync(unit, { recursive: true });
  fs.writeFileSync(path.join(unit, 'bound'), 'raw-bound-session-RAWID-4\n');
  fs.writeFileSync(path.join(unit, 'git-context.json'), JSON.stringify({ branch: '', sha: '', cwd: path.join(f.detached, 'src'), captured_at: '2026-01-03T00:00:00Z' }));
  // An unparsable git-context.json is counted, never shown.
  const broken = path.join(f.store, 'sessions', 'e5-broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'git-context.json'), '{not json');

  assert.ok(fs.existsSync(path.join(f.store, 'primary', cwdHash(f.linked), 'claude', `${sessionKey(S1)}.json`)), 'observe-model wrote S1');
  assert.ok(fs.existsSync(path.join(f.store, 'sessions', S1, 'git-context.json')), 'session-context wrote S1');
  return f;
}

function cli(f: any, args: string[], { cwd = f.main, env = baseEnv(f) }: any = {}) {
  return spawnSync(process.execPath, [CLI, 'primary', ...args], { cwd, env, encoding: 'utf8' });
}

const CHECKOUT_KEYS = ['worktreeKey', 'role', 'current', 'branch', 'head', 'headCommittedAt'];
const SESSION_KEYS = ['sessionKey', 'worktreeKey', 'kind', 'harness', 'model', 'modelFirstSeenAt', 'startedAt', 'branchAtStart', 'lastHookRecordAt', 'launched'];

HOOK_TEST('observed lists the checkouts and joins hook records by session key (IC-018 a)', (t) => {
  const f = fixture(t);
  const r = cli(f, ['--action', 'observed', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(body), ['v', 'store', 'checkouts', 'sessions', 'truncated', 'unreadable']);
  assert.equal(body.v, 1);
  assert.equal(body.store, 'present');
  assert.equal(body.truncated, false);
  assert.equal(body.unreadable, 1);

  const head = git(f.main, 'rev-parse', 'HEAD').slice(0, 12);
  const byKey = Object.fromEntries(body.checkouts.map((c: any) => [c.worktreeKey, c]));
  for (const c of body.checkouts) assert.deepEqual(Object.keys(c), CHECKOUT_KEYS);
  assert.equal(body.checkouts.length, 3);
  assert.deepEqual(byKey[cwdHash(f.main)], { worktreeKey: cwdHash(f.main), role: 'main', current: true, branch: 'main', head, headCommittedAt: '2026-01-02T03:04:05.000Z' });
  assert.deepEqual(byKey[cwdHash(f.linked)], { worktreeKey: cwdHash(f.linked), role: 'linked', current: false, branch: 'feat-x', head, headCommittedAt: '2026-01-02T03:04:05.000Z' });
  assert.deepEqual(byKey[cwdHash(f.detached)], { worktreeKey: cwdHash(f.detached), role: 'linked', current: false, branch: null, head, headCommittedAt: '2026-01-02T03:04:05.000Z' });

  for (const s of body.sessions) assert.deepEqual(Object.keys(s), SESSION_KEYS);
  const sessions = Object.fromEntries(body.sessions.map((s: any) => [s.sessionKey, s]));
  assert.deepEqual(Object.keys(sessions).sort(), [sessionKey(S1), sessionKey(S2), sessionKey(LAUNCHED)].sort(), 'one entry per key; the other project absent');

  const obs1 = JSON.parse(fs.readFileSync(path.join(f.store, 'primary', cwdHash(f.linked), 'claude', `${sessionKey(S1)}.json`), 'utf8'));
  const ctx1 = JSON.parse(fs.readFileSync(path.join(f.store, 'sessions', S1, 'git-context.json'), 'utf8'));
  const newest = (dir: string) => new Date(Math.max(...fs.readdirSync(dir).map((n: string) => fs.lstatSync(path.join(dir, n))).filter((s: any) => s.isFile()).map((s: any) => s.mtimeMs))).toISOString();
  assert.deepEqual(sessions[sessionKey(S1)], {
    sessionKey: sessionKey(S1), worktreeKey: cwdHash(f.linked), kind: 'hook', harness: 'claude', model: 'claude-sonnet-4',
    modelFirstSeenAt: obs1.observedAt, startedAt: ctx1.captured_at, branchAtStart: 'feat-x',
    lastHookRecordAt: newest(path.join(f.store, 'sessions', S1)), launched: null,
  });
  const obs2 = JSON.parse(fs.readFileSync(path.join(f.store, 'primary', cwdHash(f.main), 'claude', `${sessionKey(S2)}.json`), 'utf8'));
  assert.deepEqual(sessions[sessionKey(S2)], {
    sessionKey: sessionKey(S2), worktreeKey: cwdHash(f.main), kind: 'hook', harness: 'claude', model: 'claude-opus-4',
    modelFirstSeenAt: obs2.observedAt, startedAt: null, branchAtStart: null, lastHookRecordAt: null, launched: null,
  });
  assert.deepEqual(sessions[sessionKey(LAUNCHED)], {
    sessionKey: sessionKey(LAUNCHED), worktreeKey: cwdHash(f.detached), kind: 'launched', harness: null, model: null,
    modelFirstSeenAt: null, startedAt: '2026-01-03T00:00:00Z', branchAtStart: null,
    lastHookRecordAt: newest(path.join(f.store, 'sessions', LAUNCHED)), launched: { run: 'r9', lineage: 'lin2', attempt: '3' },
  });

  for (const marker of [f.root, f.main, f.linked, f.detached, f.other, S1, S2, S3, 'RAWID', 'git-context']) {
    assert.ok(!r.stdout.includes(marker), `output carries no ${marker}`);
  }
  assert.ok(!r.stdout.includes(sessionKey(S3)), "the other project's session key is absent");
});

HOOK_TEST('observed writes nothing: project, user-state and config-home trees stay byte-identical (IC-018)', (t) => {
  const f = fixture(t);
  const before = treeSnapshot(f.root);
  const json = cli(f, ['--action', 'observed', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const text = cli(f, ['--action', 'observed'], { cwd: f.linked });
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(treeSnapshot(f.root), before);
  assert.ok(!text.stdout.includes(f.root) && !text.stdout.includes(S1), 'the text form carries no path or raw id');
});

test('no config home gives store absent, empty sessions, exit 0 (IC-018 a)', (t) => {
  const root = tempDir(t, 'doflow-primary-observed-nohome-');
  const main = path.join(root, 'proj');
  repo(main);
  const env: any = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, HOME: 'relative-home' };
  const before = treeSnapshot(root);
  const r = spawnSync(process.execPath, [CLI, 'primary', '--action', 'observed', '--json'], { cwd: main, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.store, 'absent');
  assert.deepEqual(body.sessions, []);
  assert.equal(body.checkouts.length, 1);
  assert.equal(body.checkouts[0].worktreeKey, cwdHash(main));
  assert.deepEqual(treeSnapshot(root), before);
});

test('git unable to list checkouts exits 1 with cannot-list-checkouts (IC-018 a)', (t) => {
  const root = tempDir(t, 'doflow-primary-observed-nogit-');
  const env: any = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: path.join(root, 'no-bin') };
  const r = spawnSync(process.execPath, [CLI, 'primary', '--action', 'observed', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { v: 1, error: 'cannot-list-checkouts' });
});

test('observed takes only --action and --json (IC-018 a)', (t) => {
  const root = tempDir(t, 'doflow-primary-observed-flags-');
  const env: any = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = spawnSync(process.execPath, [CLI, 'primary', '--action', 'observed', '--kind', 'review'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 2);
});
