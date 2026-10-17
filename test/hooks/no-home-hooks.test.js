'use strict';

// Feature 086: what the shell hooks do when there is no usable config home (IC-003, IC-010, OI-5).
// A.2 pinned 2.0 here (`HOME: unbound variable` aborts, a relative XDG_CONFIG_HOME used as given);
// B.2 flipped every pin: the hooks resolve the config home through the one `doflow-config-home v1`
// rule (an absolute XDG_CONFIG_HOME, else an absolute HOME + /.config, else none), lib.sh never
// exits for want of a home, every state path is empty, each state function returns 0 at once, and
// a guard that sources lib.sh reaches its own decision.
//
// Isolation: every spawn is `/bin/bash` with an explicit environment (PATH, plus whatever the row
// sets; HOME is absent on purpose) and a temp folder as cwd, so no hook can reach the real home.
// "Nothing created" is checked in the cwd and in every fixture folder a row names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { buildInstallMirror, encodeEnvelope } = require('../helper/hook-fixtures');

const POSIX = process.platform !== 'win32';
const ROOT = POSIX && typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const BASH = '/bin/bash';
const HARNESSES = path.resolve(__dirname, '..', '..', 'core', 'harnesses');
const POLICIES = path.join(HARNESSES, 'shared', 'hooks', 'policies');

/** Runs bash with only PATH and `extra` in its environment; the cwd is an empty temp folder. */
function bash(t, args, extra = {}, { input = '', cwd = tempDir(t, 'doflow-no-home-') } = {}) {
  const r = spawnSync(BASH, args, { cwd, env: { PATH: process.env.PATH, ...extra }, input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, cwd, untouched: fs.readdirSync(cwd).length === 0 };
}

const LIB_COPIES = [
  { name: 'shared policies', lib: path.join(POLICIES, 'lib.sh') },
  { name: 'claude', lib: path.join(HARNESSES, 'claude', 'hooks', 'lib.sh') },
  { name: 'gemini', lib: path.join(HARNESSES, 'gemini', 'hooks', 'lib.sh') },
  { name: 'codex', lib: path.join(HARNESSES, 'codex', 'hooks', 'lib.sh') },
  { name: 'kiro', lib: path.join(HARNESSES, 'kiro', 'hooks', 'lib.sh') },
];

const PRINT_STATE = 'printf "[%s][%s][%s][%s][%s]\\n" "$DOFLOW_HOME" "$STATE_DIR" "$SESSION_DIR" "$PROJECTS_DIR" "$SESSIONS_LOG"';
const EMPTY_STATE = '[][][][][]\n';
const state = (d) => `[${d}][${d}/session-env][${d}/session-env/sessions][${d}/session-env/projects][${d}/sessions.log]\n`;

for (const { name, lib } of LIB_COPIES) {
  test(`${name} lib.sh with HOME and XDG unset: no abort under set -u, every state path empty, nothing created`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', `. "$1"; ${PRINT_STATE}; echo reached`, 'x', lib]);
    assert.deepEqual([r.status, r.stderr], [0, '']);
    assert.equal(r.stdout, `${EMPTY_STATE}reached\n`);
    assert.ok(r.untouched, 'nothing was written to the cwd');
  });

  test(`${name} lib.sh with HOME unset and a relative XDG_CONFIG_HOME: no config home (IC-003 case 7)`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', `. "$1"; ${PRINT_STATE}`, 'x', lib], { XDG_CONFIG_HOME: 'rel-xdg' });
    assert.deepEqual([r.status, r.stderr, r.stdout], [0, '', EMPTY_STATE]);
    assert.ok(r.untouched, 'sourcing the library creates nothing');
  });

  test(`${name} lib.sh with a relative XDG_CONFIG_HOME and an absolute HOME: session state under $HOME/.config/doflow (case 9)`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', `. "$1"; ${PRINT_STATE}`, 'x', lib], { XDG_CONFIG_HOME: 'rel-xdg', HOME: '/nonexistent-doflow-home' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    assert.equal(r.stdout, state('/nonexistent-doflow-home/.config/doflow'));
    assert.ok(r.untouched);
  });

  test(`control: ${name} lib.sh with an absolute HOME resolves $HOME/.config/doflow, an absolute XDG wins`, { skip: !POSIX }, (t) => {
    assert.equal(bash(t, ['-c', `. "$1"; ${PRINT_STATE}`, 'x', lib], { HOME: '/nonexistent-doflow-home' }).stdout, state('/nonexistent-doflow-home/.config/doflow'));
    assert.equal(bash(t, ['-c', `. "$1"; ${PRINT_STATE}`, 'x', lib], { HOME: '/h', XDG_CONFIG_HOME: '/x' }).stdout, state('/x/doflow'));
  });

  test(`${name} lib.sh ensure_session_dir and ensure_project_dir with no home print nothing, return 0, create nothing`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', '. "$1"; s=$(ensure_session_dir s1); p=$(ensure_project_dir "$PWD"); printf "[%s][%s]" "$s" "$p"', 'x', lib]);
    assert.deepEqual([r.status, r.stderr, r.stdout], [0, '', '[][]']);
    assert.ok(r.untouched);
  });
}

test('negative control: a scratch lib.sh whose ensure_session_dir lacks its early return fails with no home', { skip: !POSIX || ROOT }, (t) => {
  const copy = tempDir(t, 'doflow-no-home-lib-');
  fs.cpSync(POLICIES, copy, { recursive: true });
  const file = path.join(copy, 'lib.sh');
  const text = fs.readFileSync(file, 'utf8');
  const guard = '  [ -n "$SESSION_DIR" ] || return 0\n';
  assert.equal(text.split(guard).length, 2, 'one guard in ensure_session_dir');
  fs.writeFileSync(file, text.replace(guard, ''));
  const r = bash(t, ['-c', '. "$1"; s=$(ensure_session_dir s1); printf "[%s]" "$s"', 'x', file]);
  // The unguarded function tries `mkdir -p /s1` and hands back a path under `/`: the caller would
  // then write session state there.
  assert.equal(r.stdout, '[/s1]');
  assert.match(r.stderr, /mkdir/);
});

// ── shared lib.sh helpers that read HOME or the state paths ─────────────────────────────────────

test('lib.sh nudge helpers with HOME unset: no abort, nothing read under /, nothing created', { skip: !POSIX }, (t) => {
  const lib = path.join(POLICIES, 'lib.sh');
  const r = bash(t, ['-c', [
    '. "$1"',
    'printf "marker[%s]\\n" "$(nudge_marker_file s1)"',
    'nudge_mark s1 nudged && echo "mark=0" || echo "mark=$?"',
    'printf "setting[%s]\\n" "$(nudge_setting "")"',
    'nudge_ledger_active "$PWD" s && echo "ledger=0" || echo "ledger=$?"',
    'nudge_registry "" "" && echo "registry=0" || echo "registry=$?"',
  ].join('\n'), 'x', lib], { XDG_CONFIG_HOME: 'rel-xdg' });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, 'marker[]\nmark=0\nsetting[on]\nledger=1\nregistry=1\n');
  assert.ok(r.untouched);
  // control: the DOFLOW_CONFIG_DIR branch of nudge_ledger_active never reads HOME
  const ok = bash(t, ['-c', '. "$1"; nudge_ledger_active "$PWD" s && echo "rc=0" || echo "rc=$?"', 'x', lib],
    { XDG_CONFIG_HOME: 'rel-xdg', DOFLOW_CONFIG_DIR: '/nonexistent-doflow-config' });
  assert.deepEqual([ok.stderr, ok.stdout], ['', 'rc=1\n']);
});

// ── the state libraries sourced after lib.sh ────────────────────────────────────────────────────

test('summary-store.sh with no config home has no store: scope, peek and adopt find nothing, nothing created', { skip: !POSIX }, (t) => {
  const body = [
    '. "$1"; . "$2"',
    '_doflow_ss_root && echo "root=0[$_DF_SS_ROOT]" || echo "root=$?[$_DF_SS_ROOT]"',
    'doflow_summary_scope "$PWD" r1 w1 && echo "scope=0" || echo "scope=$?[$DF_SUMMARY_SCOPE]"',
    'doflow_grant_peek r1 w1 4096; echo "grant=$DF_GRANT"',
    'doflow_summary_adopt_legacy "$PWD" "$PWD" && echo "adopt=0" || echo "adopt=$?"',
  ].join('\n');
  const args = ['-c', body, 'x', path.join(POLICIES, 'lib.sh'), path.join(POLICIES, 'summary-store.sh')];
  const r = bash(t, args);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, 'root=1[]\nscope=1[]\ngrant=none\nadopt=1\n');
  assert.ok(r.untouched);
  // control: a relative XDG with an absolute HOME takes $HOME/.config (case 9); sourced alone, no STATE_DIR is no store
  assert.match(bash(t, args, { XDG_CONFIG_HOME: 'rel-xdg', HOME: '/h' }).stdout, /^root=0\[\/h\/\.config\/doflow\/session-env\]\n/);
  assert.equal(bash(t, ['-c', '. "$1"; _doflow_ss_root || echo "root=$?[$_DF_SS_ROOT]"', 'x', path.join(POLICIES, 'summary-store.sh')], { HOME: '/h' }).stdout, 'root=1[]\n');
});

const LAUNCHED = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1' };
const PRINT_ID = 'printf "%s %s\\n" "$DF_ID_KIND" "$DF_ID_UNIT"';

test('identity.sh with no config home binds no launched unit (solo, like an unwritable store) and creates nothing', { skip: !POSIX }, (t) => {
  const identity = path.join(POLICIES, 'identity.sh');
  for (const extra of [{}, { XDG_CONFIG_HOME: 'rel-xdg' }]) {
    const r = bash(t, ['-c', `. "$1"; doflow_identity sess-1 "$PWD"; ${PRINT_ID}`, 'x', identity], { ...LAUNCHED, ...extra });
    assert.deepEqual([r.status, r.stderr, r.stdout], [0, '', 'solo sess-1\n'], JSON.stringify(extra));
    assert.ok(r.untouched);
  }
  // through lib.sh, which leaves SESSION_DIR empty
  const viaLib = bash(t, ['-c', `. "$1"; doflow_identity sess-1 "$PWD"; ${PRINT_ID}`, 'x', path.join(POLICIES, 'lib.sh')], LAUNCHED);
  assert.deepEqual([viaLib.status, viaLib.stderr, viaLib.stdout], [0, '', 'solo sess-1\n']);
  // control: a relative XDG with an absolute HOME binds under $HOME/.config/doflow (case 9)
  const home = tempDir(t, 'doflow-no-home-h-');
  const bound = bash(t, ['-c', `. "$1"; doflow_identity sess-1 "$PWD"; ${PRINT_ID}`, 'x', identity], { ...LAUNCHED, XDG_CONFIG_HOME: 'rel-xdg', HOME: home });
  assert.deepEqual([bound.status, bound.stderr, bound.stdout], [0, '', 'launched L.r1.w1.1\n']);
  assert.equal(fs.readFileSync(path.join(home, '.config', 'doflow', 'session-env', 'sessions', 'L.r1.w1.1', 'bound'), 'utf8'), 'sess-1\n');
  assert.ok(bound.untouched, 'the relative XDG is never used against the cwd');
});

test('emission.sh with no config home prints the silent response (silent:no-home, as arbitrate.ts) and creates nothing', { skip: !POSIX }, (t) => {
  const body = [
    'set -euo pipefail',
    '. "$1/lib.sh"; . "$1/summary-store.sh"; . "$1/emission-rules.sh"; . "$1/emission.sh"',
    'doflow_emit_prompt sess-1 "$PWD" "" "" ""',
    'printf "reason=%s\\n" "$DF_EMIT_REASON"',
  ].join('\n');
  const r = bash(t, ['-c', body, 'x', POLICIES], { DOFLOW_AGENT: 'claude' });
  assert.deepEqual([r.status, r.stderr, r.stdout], [0, '', '{}\nreason=silent:no-home\n']);
  assert.ok(r.untouched);
});

// ── policies and entry points ───────────────────────────────────────────────────────────────────

/** One shared policy run directly with a claude envelope, with HOME unset and with a temp HOME. */
function policyPair(t, policy, event, native) {
  const cwd = tempDir(t, 'doflow-no-home-cwd-');
  const home = tempDir(t, 'doflow-no-home-home-');
  const payload = { ...native };
  if ('cwd' in payload) payload.cwd = cwd;
  const input = encodeEnvelope('claude', event, policy, JSON.stringify(payload));
  const script = path.join(POLICIES, `${policy}.sh`);
  const none = bash(t, [script], { DOFLOW_AGENT: 'claude', DOFLOW_TELEMETRY: 'off' }, { input, cwd });
  const withHome = bash(t, [script], { DOFLOW_AGENT: 'claude', DOFLOW_TELEMETRY: 'off', HOME: home }, { input, cwd: tempDir(t, 'doflow-no-home-cwd2-') });
  return { none, withHome, cwd, home };
}

test('user-prompt-submit with HOME unset: exit 0, the silent response, nothing created; with a HOME it bootstraps', { skip: !POSIX || !HAS_JQ }, (t) => {
  const { none, withHome, cwd } = policyPair(t, 'user-prompt-submit', 'UserPromptSubmit', { session_id: 'sess-1', cwd: null, prompt: 'hello there' });
  assert.deepEqual([none.status, none.stderr, none.stdout], [0, '', '{}\n']);
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.equal(withHome.status, 0);
  assert.match(withHome.stdout, /additionalContext/, 'control: with a home the first prompt renders');
});

test('stop-check with HOME unset: same output and status as with a HOME, nothing created', { skip: !POSIX || !HAS_JQ }, (t) => {
  for (const message of ['done', 'left a TODO: finish this']) {
    const { none, withHome, cwd } = policyPair(t, 'stop-check', 'Stop', { session_id: 'sess-1', cwd: null, last_assistant_message: message });
    assert.deepEqual([none.status, none.stdout, none.stderr], [withHome.status, withHome.stdout, withHome.stderr], message);
    assert.deepEqual(fs.readdirSync(cwd), [], message);
  }
});

test('session-context (session-start) with HOME unset: exit 0 and nothing created', {
  skip: !POSIX || !HAS_JQ,
  todo: 'needs `[ -n "$SESSION_DIR" ] || exit 0` in policies/session-context.sh before its first state write (outside the B.2 write set)',
}, (t) => {
  const { none, cwd } = policyPair(t, 'session-context', 'SessionStart', { session_id: 'sess-1', cwd: null });
  assert.deepEqual([none.status, none.stderr, none.stdout], [0, '', '']);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('kiro pre-bash-guard (installed shape) with HOME unset still denies rm -rf /, exactly as with a HOME', { skip: !POSIX || !HAS_JQ }, (t) => {
  const mirror = buildInstallMirror(path.join(tempDir(t, 'doflow-no-home-mirror-'), 'm'));
  const door = path.join(mirror, '.kiro', 'hooks', 'pre-bash-guard.sh');
  const deny = JSON.stringify({ tool_name: 'shell', tool_input: { command: 'rm -rf /' } });
  const allow = JSON.stringify({ tool_name: 'shell', tool_input: { command: 'ls -la' } });
  for (const [input, status] of [[deny, 2], [allow, 0]]) {
    const none = bash(t, [door], { DOFLOW_TELEMETRY: 'off' }, { input });
    const withHome = bash(t, [door], { DOFLOW_TELEMETRY: 'off', HOME: tempDir(t, 'doflow-no-home-home-') }, { input });
    assert.equal(none.status, status, none.stderr);
    assert.deepEqual([none.status, none.stdout, none.stderr], [withHome.status, withHome.stdout, withHome.stderr]);
    assert.ok(none.untouched);
  }
});

// Entry points run from the source tree with empty stdin: each that needs no session state exits as
// it does with a HOME. The two session-end scripts append to SESSIONS_LOG before any session check.
const ENTRY_POINTS = [
  ['claude', 'pre-compact.sh'], ['gemini', 'pre-compact.sh'],
  ['kiro', 'session-start.sh'], ['kiro', 'stop-check.sh'], ['kiro', 'pre-bash-guard.sh'], ['kiro', 'mcp-tool-guard.sh'],
];
for (const [harness, script] of ENTRY_POINTS) {
  test(`${harness}/hooks/${script} with HOME unset: no abort in lib.sh, same output and status as with a HOME, nothing created`, { skip: !POSIX }, (t) => {
    const file = path.join(HARNESSES, harness, 'hooks', script);
    const none = bash(t, [file], { DOFLOW_TELEMETRY: 'off' });
    const withHome = bash(t, [file], { DOFLOW_TELEMETRY: 'off', HOME: tempDir(t, 'doflow-no-home-home-') });
    assert.doesNotMatch(none.stderr, /unbound variable/);
    assert.deepEqual([none.status, none.stdout, none.stderr], [withHome.status, withHome.stdout, withHome.stderr]);
    assert.ok(none.untouched);
  });
}
for (const [harness, script, line] of [['claude', 'session-end.sh', 29], ['codex', 'session-end.impl.sh', 30]]) {
  test(`${harness}/hooks/${script} with HOME unset: exit 0 and nothing created`, {
    skip: !POSIX,
    todo: `needs a guard on SESSIONS_LOG / STATE_DIR in ${harness}/hooks/${script} (line ${line} appends to an empty SESSIONS_LOG; outside the B.2 write set)`,
  }, (t) => {
    const r = bash(t, [path.join(HARNESSES, harness, 'hooks', script)], { DOFLOW_TELEMETRY: 'off' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    assert.ok(r.untouched);
  });
}
