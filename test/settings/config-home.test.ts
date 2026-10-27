'use strict';

// 086 B.1 (IC-003, IC-010, DD-7): the Node config-home helper over the 12 environment cases, the sites
// that resolve through it, and session state with no config home. No test reads the real home:
// `os.homedir` is replaced by a function that throws, and every path is computed, not read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO } = require('../helper/settings-fixtures.ts');
const { configHome } = require('../../src/runtime/config-home.ts');
const { failureHome } = require('../../src/runtime/failure/home.ts');
const { reportsHome } = require('../../src/runtime/lifecycle/report-store.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { stateDir, resolveIdentity } = require('../../src/runtime/context/identity.ts');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const store = require('../../src/runtime/context/summary-store.ts');
const { observeForwarding, bindingObserved } = require('../../src/runtime/worker/readiness.ts');

// XDG, HOME and the expected config home dir (null = none). `r` is a relative value, `/x` and `/h` absolute.
const U = undefined;
const CASES = [
  [1, U, U, null],
  [2, U, 'r', null],
  [3, U, '/h', '/h/.config/doflow'],
  [4, '', U, null],
  [5, '', 'r', null],
  [6, '', '/h', '/h/.config/doflow'],
  [7, 'r', U, null],
  [8, 'r', 'r', null],
  [9, 'r', '/h', '/h/.config/doflow'],
  [10, '/x', U, '/x/doflow'],
  [11, '/x', 'r', '/x/doflow'],
  [12, '/x', '/h', '/x/doflow'],
];

// configHome() joins with path.join, so on Windows '/h/.config/doflow' is spelled '\\h\\.config\\doflow'; both sides are normalized.
const norm = (v: any) => (typeof v === 'string' ? path.normalize(v) : v);

const envOf = (xdg: any, home: any) => {
  const env: any = {};
  if (xdg !== U) env.XDG_CONFIG_HOME = xdg;
  if (home !== U) env.HOME = home;
  return env;
};

/** Every os.homedir() call throws, so a fallback to the account home fails the test loudly. */
function noAccountHome(t: any) {
  const mock = t.mock.method(os, 'homedir', () => { throw new Error('os.homedir() must not be consulted for the config home'); });
  return mock;
}

for (const [n, xdg, home, dir] of CASES) {
  test(`case ${n}: XDG ${JSON.stringify(xdg)} HOME ${JSON.stringify(home)} -> ${dir ?? 'no config home'}`, (t) => {
    const homedir = noAccountHome(t);
    const env = envOf(xdg, home);
    const got = configHome(env);
    assert.equal(norm(got.dir), norm(dir));
    assert.equal(norm(got.base), dir === null ? null : norm(path.dirname(dir)));
    assert.equal(homedir.mock.callCount(), 0, 'os.homedir() was not called');
    // The sites that build a config-home path agree with the helper.
    assert.equal(norm(failureHome(env)), dir === null ? null : norm(`${dir}/failures`));
    assert.equal(norm(reportsHome(env)), dir === null ? null : norm(`${dir}/reports`));
    assert.equal(norm(stateDir(env)), dir === null ? null : norm(`${dir}/session-env`));
    const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO }), projectRoot: '/p', env });
    assert.equal(norm(roots['config-home']), norm(dir));
    // The home base is the HOME variable alone: nothing falls back to the account home.
    assert.equal(roots['user-state'], home !== U && path.isAbsolute(home) ? path.join(home, '.doflow', 'state') : null);
    assert.equal(homedir.mock.callCount(), 0, 'no site consulted os.homedir()');
  });
}

test('ignored lists each variable that is set non-empty but relative', () => {
  assert.deepEqual(configHome({ XDG_CONFIG_HOME: 'r', HOME: '/h' }).ignored, ['XDG_CONFIG_HOME']);
  assert.deepEqual(configHome({ XDG_CONFIG_HOME: 'r', HOME: 'q' }).ignored, ['XDG_CONFIG_HOME', 'HOME']);
  assert.deepEqual(configHome({ XDG_CONFIG_HOME: '/x', HOME: 'q' }).ignored, ['HOME']);
  assert.deepEqual(configHome({ XDG_CONFIG_HOME: '', HOME: '' }).ignored, [], 'empty is unset, not relative');
  assert.deepEqual(configHome({}).ignored, []);
  assert.deepEqual(configHome({ HOME: '/h' }).ignored, []);
});

test('negative control: a non-empty XDG check (instead of absolute) disagrees with the table on case 9', () => {
  const relaxed = (env: any) => (env.XDG_CONFIG_HOME ? `${env.XDG_CONFIG_HOME}/doflow` : null);
  const case9 = CASES[8];
  assert.notEqual(norm(relaxed(envOf(case9[1], case9[2]))), norm(case9[3]));
  assert.equal(norm(configHome(envOf(case9[1], case9[2])).dir), norm(case9[3]));
});

test('with no argument it reads process.env, and HOME unset yields none without a home lookup', (t) => {
  const homedir = noAccountHome(t);
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    assert.deepEqual(configHome(), { base: null, dir: null, ignored: [] });
    process.env.HOME = '/h';
    assert.equal(norm(configHome().dir), norm('/h/.config/doflow'));
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
  }
  assert.equal(homedir.mock.callCount(), 0);
});

// ── IC-010: session state with no config home ──────────────────────────────────────────────────

function tree(dir: any) {
  const out: any = [];
  const walk = (d: any) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { out.push(path.join(d, e.name)); if (e.isDirectory()) walk(path.join(d, e.name)); } };
  walk(dir);
  return out.sort();
}

test('IC-010: with no config home every session-state reader skips and nothing is created', (t) => {
  const homedir = noAccountHome(t);
  const root = tempDir(t, 'doflow-no-home-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const env = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };
  assert.equal(stateDir(env), null);

  // A launched identity cannot bind: it is an inherited session (L1-04) and nothing is written.
  const id = resolveIdentity(env, { cwd, sessionId: 'sess-1', bind: true });
  assert.equal(id.lineageKind, 'solo');
  assert.deepEqual(id.diagnostics, ['identity-inherited']);

  const emitted = emitContext({ event: 'prompt', cwd, env, sessionId: 'sess-1' });
  assert.equal(emitted.decision.emit, false);
  assert.equal(emitted.decision.reason, 'silent:no-home');
  assert.equal(emitted.text, null);
  assert.equal(emitted.committed, false);

  assert.equal(store.summaryScope(cwd, 'r1', 'w1', env), null);
  assert.deepEqual(store.peekGrant('r1', 'w1', 1000, env), { grant: 'none', file: null, id: null, bytes: null });
  assert.equal(store.claimGrant('r1', 'w1', 'u1', 's-20260101T000000Z-abcdef', env).claimed, null);
  assert.equal(store.legacySummary(cwd, env), null);
  assert.deepEqual(store.scopeContext(cwd, 'r1', 'w1', env).grants, []);
  assert.throws(() => store.grantSummary({ summary: 'pending', toRun: 'r2', toLineage: 'w2', env, fromWorktree: cwd, fromRun: 'r1', fromLineage: 'w1' }),
    (e: any) => e.exitCode === 2 && /no config home/.test(e.message));

  // readiness: no binding and no sessions.log can be observed
  assert.equal(bindingObserved(env, 'L.r1.w1.1'), false);
  const identity = { run: 'r1', lineage: 'w1' };
  const seen = observeForwarding({ env, identity, cwd, startedAtMs: 0, at: '2026-01-01T00:00:00Z' });
  assert.equal(seen.hooksLoaded.state, 'no');
  assert.equal(seen.hooksLoaded.reason, 'no-session-start-observed');

  assert.deepEqual(tree(root), [cwd], 'nothing was created under the scratch tree');
  assert.equal(homedir.mock.callCount(), 0);
});

test('control IC-010: the same calls with a config home do create session state', (t) => {
  const root = tempDir(t, 'doflow-with-home-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const env = { HOME: path.join(root, 'home'), DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };
  const id = resolveIdentity(env, { cwd, sessionId: 'sess-1', bind: true });
  assert.equal(id.lineageKind, 'launched');
  assert.equal(fs.existsSync(path.join(root, 'home', '.config', 'doflow', 'session-env', 'sessions', 'L.r1.w1.1', 'bound')), true);
});

test('IC-010: sessions.log under no config home reads as no START line', (t) => {
  noAccountHome(t);
  const observe = observeForwarding;
  const root = tempDir(t, 'doflow-sessions-log-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const home = path.join(root, 'home');
  const log = path.join(home, '.config', 'doflow', 'sessions.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `${new Date().toISOString()} START sess-9 ${cwd}\n`);
  const identity = { run: 'r1', lineage: 'w1' };
  const at = '2026-01-01T00:00:00Z';
  const withHome = observe({ env: { HOME: home }, identity, cwd, startedAtMs: 0, at });
  const without = observe({ env: {}, identity, cwd, startedAtMs: 0, at });
  assert.equal(withHome.hooksLoaded.reason, 'session-start-logged', 'the log is read under a config home');
  assert.equal(without.hooksLoaded.reason, 'no-session-start-observed', 'and not looked for without one');
});
