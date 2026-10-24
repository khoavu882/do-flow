'use strict';

// Feature 086: what the shell hooks do when there is no usable config home (IC-003, IC-010, OI-5).
// A.2 pinned 2.0 here (`HOME: unbound variable` aborts, a relative XDG_CONFIG_HOME used as given);
// B.2 flipped every pin: the hooks resolve the config home through the one `doflow-config-home v1`
// rule (an absolute XDG_CONFIG_HOME, else an absolute HOME + /.config, else none), lib.sh never
// exits for want of a home, every state path is empty, each state function returns 0 at once, and
// a guard that sources lib.sh reaches its own decision.
//
// Isolation: every spawn is bash (through the shared home-less helper) with an explicit environment (PATH, plus whatever the row
// sets; HOME is absent on purpose) and a temp folder as cwd, so no hook can reach the real home.
// "Nothing created" is checked in the cwd and in every fixture folder a row names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { buildInstallMirror, encodeEnvelope } = require('../helper/hook-fixtures.ts');
const { spawnBash } = require('../helper/home-less-bash.ts');

const POSIX = process.platform !== 'win32';
const ROOT = POSIX && typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const HARNESSES = path.resolve(__dirname, '..', '..', 'core', 'harnesses');
const POLICIES = path.join(HARNESSES, 'shared', 'hooks', 'policies');

/** Runs bash with only PATH and `extra` in its environment; the cwd is an empty temp folder. */
function bash(t, args, extra = {}, { input = '', cwd = tempDir(t, 'doflow-no-home-') } = {}) {
  const r = spawnBash(args, { cwd, env: { PATH: process.env.PATH, ...extra }, input, encoding: 'utf8' });
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

test('stop-check with no config home allows flagged repeats without creating state', { skip: !POSIX || !HAS_JQ }, (t) => {
  const done = policyPair(t, 'stop-check', 'Stop', { session_id: 'sess-1', cwd: null, last_assistant_message: 'done' });
  assert.deepEqual([done.none.status, done.none.stdout, done.none.stderr], [done.withHome.status, done.withHome.stdout, done.withHome.stderr]);
  assert.deepEqual(fs.readdirSync(done.cwd), []);

  const payload = { session_id: 'sess-1', cwd: null, last_assistant_message: 'Here it is:\n```js\n// TODO: finish this\n```' };
  const first = policyPair(t, 'stop-check', 'Stop', payload);
  assert.equal(first.none.status, 0, first.none.stderr);
  assert.equal(first.none.stdout, '');
  assert.equal(first.none.stderr, '');
  assert.equal(first.withHome.status, 2, first.withHome.stderr);
  assert.match(first.withHome.stderr, /unfinished-work marker/);
  assert.deepEqual(fs.readdirSync(first.cwd), [], 'the no-home branch creates no state');

  const repeated = policyPair(t, 'stop-check', 'Stop', payload);
  assert.equal(repeated.none.status, 0, repeated.none.stderr);
  assert.equal(repeated.none.stderr, '', 'a repeated flagged message cannot block without persisted state');
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

// ── session/state hooks in the installed shape (B.2b) ───────────────────────────────────────────
// Each row runs one hook with a payload that reaches its state write: with a temp HOME the state
// lands under <HOME>/.config/doflow (the control: the row really exercises the state path); with HOME
// unset, and with HOME unset and a relative XDG_CONFIG_HOME, the hook exits 0, prints what it prints
// with a HOME, writes nothing to stderr and creates nothing in the cwd.

let MIRROR = null;
/** One install-shaped mirror for this file (built on first use, removed with the suite). */
function mirror() {
  if (MIRROR === null) MIRROR = buildInstallMirror(path.join(suiteTempDir('doflow-no-home-mirror-'), 'm'));
  return MIRROR;
}
const SESSIONS = 'session-env/sessions/s1';
const STATE_HOOKS = [
  { door: '.claude/hooks/session-start.sh', native: (cwd) => ({ session_id: 's1', cwd, hook_event_name: 'SessionStart' }), wrote: `${SESSIONS}/git-context.json` },
  { door: '.claude/hooks/subagent-audit.sh', native: () => ({ session_id: 's1', hook_event_name: 'SubagentStart', agent_type: 'worker', agent_id: 'a1' }), wrote: `${SESSIONS}/subagent-audit.log` },
  { door: '.claude/hooks/session-end.sh', native: (cwd) => ({ session_id: 's1', cwd }), wrote: 'sessions.log' },
  { door: '.codex/hooks/session-end.impl.sh', native: (cwd) => ({ session_id: 's1', cwd }), wrote: 'sessions.log' },
  { door: '.gemini/hooks/session-end.impl.sh', native: (cwd) => ({ session_id: 's1', cwd }), wrote: 'sessions.log' },
  { door: '.claude/hooks/post-compact.sh', native: (cwd) => ({ session_id: 's1', cwd, trigger: 'manual', compact_summary: 'the summary' }), wrote: 'session-env/summaries' },
  { door: '.claude/hooks/post-tool-failure.sh', native: () => ({ session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_response: { error: 'x' } }), wrote: `${SESSIONS}/tool-failures.log` },
  { door: '.claude/hooks/permission-audit.sh', native: () => ({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), wrote: `${SESSIONS}/permission-audit.log` },
  { door: '.claude/hooks/skill-config-audit.sh', native: () => ({ session_id: 's1', hook_event_name: 'ConfigChange' }), wrote: `${SESSIONS}/skill-config-audit.log` },
  { door: '.claude/hooks/post-edit-lint.sh', native: () => ({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/tmp/doflow-no-home-a.js' } }), wrote: `${SESSIONS}/edited-files.txt` },
  { door: '.gemini/hooks/post-edit-lint.sh', native: () => ({ session_id: 's1', tool_name: 'write_file', tool_input: { file_path: '/tmp/doflow-no-home-a.js' } }), wrote: `${SESSIONS}/edited-files.txt` },
  { door: '.codex/hooks/post-edit-lint.impl.sh', native: () => ({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/tmp/doflow-no-home-a.js' } }), wrote: `${SESSIONS}/edited-files.txt` },
];

for (const row of STATE_HOOKS) {
  test(`${row.door.slice(1)} with no config home: exit 0, same stdout as with a HOME, no stderr, nothing created`, { skip: !POSIX || !HAS_JQ }, (t) => {
    const door = path.join(mirror(), row.door);
    const run = (extra) => {
      const cwd = tempDir(t, 'doflow-no-home-cwd-');
      return bash(t, [door], { DOFLOW_TELEMETRY: 'off', ...extra }, { input: JSON.stringify(row.native(cwd)), cwd });
    };
    const home = tempDir(t, 'doflow-no-home-home-');
    const withHome = run({ HOME: home });
    assert.equal(withHome.status, 0, withHome.stderr);
    assert.ok(fs.existsSync(path.join(home, '.config', 'doflow', row.wrote)), `control: with a HOME the hook writes ${row.wrote}`);
    for (const extra of [{}, { XDG_CONFIG_HOME: 'rel-xdg' }]) {
      const none = run(extra);
      assert.deepEqual([none.status, none.stderr, none.stdout], [0, '', withHome.stdout], JSON.stringify(extra));
      assert.ok(none.untouched, `nothing created in the cwd ${JSON.stringify(extra)}`);
    }
  });
}

test('negative control: an installed session-end.sh without its no-home guard fails with HOME unset', { skip: !POSIX || !HAS_JQ }, (t) => {
  const copy = path.join(tempDir(t, 'doflow-no-home-unguarded-'), 'm');
  buildInstallMirror(copy);
  const file = path.join(copy, '.claude', 'hooks', 'session-end.sh');
  const text = fs.readFileSync(file, 'utf8');
  const guard = 'if [[ -z "$STATE_DIR" ]]; then\n  start_storage_upkeep\n  exit 0\nfi\n';
  assert.equal(text.split(guard).length, 2, 'session-end.sh has one no-home guard');
  fs.writeFileSync(file, text.replace(guard, ''));
  const cwd = tempDir(t, 'doflow-no-home-cwd-');
  const r = bash(t, [file], { DOFLOW_TELEMETRY: 'off' }, { input: JSON.stringify({ session_id: 's1', cwd }), cwd });
  assert.notEqual(r.status, 0, 'the append to an empty SESSIONS_LOG stops the hook');
});

test('stop-check with an absolute XDG_CONFIG_HOME and HOME unset lints the queued files without reading HOME', { skip: !POSIX || !HAS_JQ }, (t) => {
  const xdg = tempDir(t, 'doflow-no-home-xdg-');
  const queue = path.join(xdg, 'doflow', SESSIONS, 'edited-files.txt');
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(queue, '/tmp/doflow-no-home-missing.txt\n');
  const cwd = tempDir(t, 'doflow-no-home-cwd-');
  const input = encodeEnvelope('claude', 'Stop', 'stop-check', JSON.stringify({ session_id: 's1', cwd, last_assistant_message: 'done' }));
  const r = bash(t, [path.join(POLICIES, 'stop-check.sh')], { DOFLOW_AGENT: 'claude', DOFLOW_TELEMETRY: 'off', XDG_CONFIG_HOME: xdg }, { input, cwd });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.ok(!fs.existsSync(queue), 'the queue was taken');
  assert.ok(r.untouched);
});

test('stop-check with no config home allows an unfinished-work marker because it cannot persist state', { skip: !POSIX || !HAS_JQ }, (t) => {
  const cwd = tempDir(t, 'doflow-no-home-cwd-');
  const input = encodeEnvelope('claude', 'Stop', 'stop-check', JSON.stringify({ session_id: 's1', cwd, last_assistant_message: 'Here it is:\n```js\n// TODO: finish this\n```' }));
  for (let i = 0; i < 2; i += 1) {
    const r = bash(t, [path.join(POLICIES, 'stop-check.sh')], { DOFLOW_AGENT: 'claude', DOFLOW_TELEMETRY: 'off' }, { input, cwd });
    assert.equal(r.status, 0, `call ${i + 1}: no state directory means allow`);
    assert.equal(r.stderr, '');
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});
