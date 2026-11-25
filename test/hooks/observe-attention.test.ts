'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Row 180 IC-180-D1, IC-180-D2 (K3a b, c, d, h, i): the shared bridge step `observe-attention` records an ask that
// waits on the person in <config home>/doflow/session-env/sessions/<session id>/attention.log, from the harness's
// `attention` entry projected to bridge/attention.json, and marks it answered from the hooks already wired. Front doors
// run from a scratch install mirror; fake payloads and scratch homes only, no harness runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { STEP_BAR_BASELINES, stepBarMs, CONTROL_EXTRA_WORK } = require('../helper/hook-step-bar.ts');

const POSIX = process.platform !== 'win32';
const MIRROR = buildInstallMirror(path.join(suiteTempDir('doflow-observe-attention-mirror-'), 'm'));
const DOORS = path.join(MIRROR, '.claude', 'hooks');
const STEP_DIR = path.join(MIRROR, '.doflow', 'shared', 'hooks', 'bridge');
const SESSION = 'attention-session-0001';

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-observe-attention-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const sessions = path.join(home, '.config', 'doflow', 'session-env', 'sessions');
  return { dir, home, cwd, sessions, log: path.join(sessions, SESSION, 'attention.log') };
}

const baseEnv = (s: any, extra: any = {}) => {
  const env: any = { ...process.env, HOME: s.home, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '', ...extra };
  for (const name of ['XDG_CONFIG_HOME', 'DOFLOW_SESSION_ROLE', 'DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_WORKTREE', 'DOFLOW_TASK_ID', 'DOFLOW_CONFIG_DIR', 'SESSION_DIR']) if (!(name in extra)) delete env[name];
  return env;
};

/** One front door of the mirror, as the harness runs it. */
function door(s: any, file: string, native: any, args: string[] = [], extra: any = {}) {
  const r = spawnSync(bashPath(), [path.join(DOORS, file), ...args], { cwd: s.cwd, env: baseEnv(s, extra), input: JSON.stringify(native), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []);
const shape = (l: any) => (l.event === 'answered' ? `answered:${l.via}` : `${l.event}:${l.kind}:${l.tool}`);
const shapes = (s: any) => lines(s.log).map(shape);

const permission = (tool = 'Bash', extra: any = {}) => ({
  session_id: SESSION, transcript_path: '/x/SECRET-transcript.jsonl', cwd: '/x', permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: tool, tool_input: { command: 'echo SECRET', description: 'SECRET description' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: tool, ruleContent: 'echo SECRET' }], behavior: 'allow', destination: 'localSettings' }], ...extra,
});
const notification = (type: any, extra: any = {}) => ({
  session_id: SESSION, transcript_path: '/x/t.jsonl', cwd: '/x', hook_event_name: 'Notification', message: 'SECRET message', title: 'SECRET title',
  ...(type === undefined ? {} : { notification_type: type }), ...extra,
});
const ask = (s: any, native: any) => door(s, 'attention-audit.sh', native, [native.hook_event_name]);

test('(b) a PermissionRequest appends one line with kind permission and the tool; no tool input, message or path reaches the file', (t) => {
  const s = scratch(t);
  const r = ask(s, permission('Bash'));
  assert.deepEqual(r, { status: 0, stdout: '', stderr: '' }, 'no output and exit 0: the permission flow is unchanged');
  const [line, ...rest] = lines(s.log);
  assert.deepEqual(rest, []);
  assert.deepEqual(Object.keys(line), ['schema', 'at', 'event', 'kind', 'tool']);
  assert.deepEqual({ ...line, at: 'x' }, { schema: 1, at: 'x', event: 'PermissionRequest', kind: 'permission', tool: 'Bash' });
  assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(line.at) - Date.now()) < 120000);
  assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /SECRET|echo|description|transcript/);
  assert.deepEqual(fs.readdirSync(path.dirname(s.log)), ['attention.log']);
  if (POSIX) assert.equal(fs.statSync(s.log).mode & 0o777, 0o600);
  // An ask from a subagent still waits on the person: it records as for the main session.
  ask(s, permission('Write', { agent_id: 'sub-1', agent_type: 'Explore' }));
  assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash', 'PermissionRequest:permission:Write']);
});

test('(b) under a permissive umask the session folder the step creates is mode 0700, and the log 0600', { skip: !POSIX }, (t) => {
  const s = scratch(t);
  assert.equal(fs.existsSync(s.sessions), false, 'no session folder before the ask');
  const r = spawnSync(bashPath(), ['-c', 'umask 022; exec "$0" "$@"', bashPath(), path.join(DOORS, 'attention-audit.sh'), 'PermissionRequest'],
    { cwd: s.cwd, env: baseEnv(s), input: JSON.stringify(permission('Bash')), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(fs.statSync(path.dirname(s.log)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(s.log).mode & 0o777, 0o600);
});

test('(c) Notification types map to permission, question, idle and other; skipped types write nothing; no message or title is read', (t) => {
  const cases: Array<[any, string | null]> = [
    ['permission_prompt', 'permission'], ['elicitation_dialog', 'question'], ['elicitation_url_dialog', 'question'], ['idle_prompt', 'idle'],
    ['agent_needs_input', 'question'], ['auth_storage_failure', 'other'], ['a_type_added_later', 'other'], [7, 'other'], [undefined, 'other'],
    ['auth_success', null], ['elicitation_complete', null], ['plugin_notification', null],
  ];
  for (const [type, kind] of cases) {
    const s = scratch(t);
    assert.equal(ask(s, notification(type)).status, 0);
    assert.deepEqual(shapes(s), kind === null ? [] : [`Notification:${kind}:`], String(type));
    if (kind !== null) assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /SECRET/);
    if (kind === null) assert.equal(fs.existsSync(path.dirname(s.log)), false, `${type}: not even the session folder`);
  }
});

test('(c) a permission_prompt after its PermissionRequest is not written twice; another tool, another kind or a new ask after an answer is', (t) => {
  const s = scratch(t);
  ask(s, permission('Bash'));
  ask(s, notification('permission_prompt'));
  ask(s, permission('Bash'));
  assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash'], 'one open ask, one line');
  ask(s, permission('Write'));
  ask(s, notification('idle_prompt'));
  ask(s, notification('idle_prompt'));
  assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash', 'PermissionRequest:permission:Write', 'Notification:idle:']);
  door(s, 'stop-check.sh', { session_id: SESSION, hook_event_name: 'Stop', cwd: s.cwd });
  ask(s, notification('permission_prompt'));
  assert.deepEqual(shapes(s).slice(-2), ['answered:Stop', 'Notification:permission:']);
});

test('(c) the step is data-driven: a fixture map naming a second harness records for it, and a harness absent from the map writes nothing', (t) => {
  const s = scratch(t);
  const hooks = path.join(s.dir, 'install', 'hooks');
  fs.cpSync(path.join(MIRROR, '.doflow', 'shared', 'hooks'), hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'bridge', 'attention.json'), JSON.stringify({
    'second-harness': { sessionField: 'sid', asks: [{ event: 'AskEvent', kindField: 'what', kinds: { q: 'question' }, otherwise: 'other', toolField: 'tool' }], answeredBy: ['DoneEvent'] },
  }));
  const step = (fn: string, args: string[], native: any = {}) => spawnSync(bashPath(), ['-c', `( . "$1" && ${fn} "\${@:2}" ) || true`, '_', path.join(hooks, 'bridge', 'observe-attention.sh'), ...args],
    { cwd: s.cwd, env: baseEnv(s), input: JSON.stringify(native), encoding: 'utf8' });
  const fake = path.join(s.sessions, 'second-1', 'attention.log');
  assert.equal(step('doflow_observe_attention', ['second-harness', 'AskEvent'], { sid: 'second-1', what: 'q', tool: 'Lookup', session_id: SESSION, message: 'SECRET' }).status, 0);
  assert.deepEqual(lines(fake).map(shape), ['AskEvent:question:Lookup']);
  step('doflow_observe_attention', ['claude', 'PermissionRequest'], permission('Bash'));
  step('doflow_observe_attention', ['second-harness', 'PermissionRequest'], { sid: 'second-1', what: 'q' });
  assert.equal(fs.existsSync(s.log), false, 'claude is not in this map: nothing for its session');
  assert.deepEqual(lines(fake).map(shape), ['AskEvent:question:Lookup'], 'an event the map does not list as an ask writes nothing');
  step('doflow_attention_answered', ['second-harness', 'Stop', 'second-1']);
  step('doflow_attention_answered', ['second-harness', 'DoneEvent', 'second-1']);
  assert.deepEqual(lines(fake).map(shape), ['AskEvent:question:Lookup', 'answered:DoneEvent']);
});

test('(d) an answering event appends answered once after an ask, never twice, and nothing without a log or for an event not in answeredBy', (t) => {
  const s = scratch(t);
  const stop = () => door(s, 'stop-check.sh', { session_id: SESSION, hook_event_name: 'Stop', cwd: s.cwd });
  const before = stop();
  assert.equal(fs.existsSync(s.log), false, 'no log: nothing is created');
  ask(s, permission('Bash'));
  door(s, 'mcp-tool-guard.sh', { session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: {}, cwd: s.cwd });
  door(s, 'subagent-audit.sh', { session_id: SESSION, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', cwd: s.cwd });
  assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash'], 'PreToolUse and SubagentStart are not in answeredBy');
  assert.deepEqual(stop(), before, 'the bridge output and exit code are the same with a log');
  stop();
  assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash', 'answered:Stop']);
  const [, answered] = lines(s.log);
  assert.deepEqual(Object.keys(answered), ['schema', 'at', 'event', 'via']);
});

test('(d) each answering hook already wired marks the open ask answered: prompt, denial, tool use and tool failure', (t) => {
  const tool = (event: string, name: string) => ({ session_id: SESSION, hook_event_name: event, tool_name: name, tool_input: { file_path: '/x/f.js', command: 'ls' }, tool_response: { error: 'x' }, cwd: '/x' });
  const on = { DOFLOW_TELEMETRY: 'on' };
  const rows: Array<[string, any, string[], any, string | null]> = [
    ['user-prompt-submit.sh', { session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'go on', cwd: '/x' }, [], {}, 'UserPromptSubmit'],
    ['permission-audit.sh', { ...tool('PermissionDenied', 'Bash'), permission_decision_reason: 'r' }, [], {}, 'PermissionDenied'],
    ['post-tool-failure.sh', tool('PostToolUseFailure', 'Edit'), [], {}, 'PostToolUseFailure'],
    ['post-edit-lint.sh', tool('PostToolUse', 'Edit'), [], {}, 'PostToolUse'],
    ['post-shell-observe.sh', tool('PostToolUse', 'Bash'), ['PostToolUse'], on, 'PostToolUse'],
    // A Bash failure runs post-shell-observe and post-tool-failure at once; only post-tool-failure answers it.
    ['post-shell-observe.sh', tool('PostToolUseFailure', 'Bash'), ['PostToolUseFailure'], on, null],
    // Ceiling: with telemetry off the observer exits before it reads stdin (pinned in command-class.test.ts).
    ['post-shell-observe.sh', tool('PostToolUse', 'Bash'), ['PostToolUse'], {}, null],
  ];
  for (const [file, native, args, extra, via] of rows) {
    const s = scratch(t);
    ask(s, permission('Bash'));
    const r = door(s, file, native, args, extra);
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    assert.deepEqual(shapes(s), ['PermissionRequest:permission:Bash', ...(via ? [`answered:${via}`] : [])], `${file} ${args.join(' ')} ${JSON.stringify(extra)}`);
  }
});

test('(h) no config home: the ask and the answered paths write nothing and still exit 0 with no output', (t) => {
  const s = scratch(t);
  const env = { HOME: '' };
  assert.deepEqual(door(s, 'attention-audit.sh', permission('Bash'), ['PermissionRequest'], env), { status: 0, stdout: '', stderr: '' });
  assert.equal(door(s, 'permission-audit.sh', { session_id: SESSION, hook_event_name: 'PermissionDenied', tool_name: 'Bash' }, [], env).status, 0);
  assert.deepEqual(fs.readdirSync(s.home), []);
  assert.deepEqual(fs.readdirSync(s.cwd), []);
  // A bad session id or a link in place of the log writes nothing either.
  assert.equal(ask(s, permission('Bash', { session_id: '../escape' })).status, 0);
  assert.equal(fs.existsSync(path.join(s.home, '.config')), false);
});

test('(h) a link in place of the log is never followed', { skip: !POSIX }, (t) => {
  const s = scratch(t);
  const target = path.join(s.dir, 'target.log');
  fs.writeFileSync(target, 'x\n');
  fs.mkdirSync(path.dirname(s.log), { recursive: true });
  fs.symlinkSync(target, s.log);
  ask(s, permission('Bash'));
  door(s, 'stop-check.sh', { session_id: SESSION, hook_event_name: 'Stop', cwd: s.cwd });
  assert.equal(fs.readFileSync(target, 'utf8'), 'x\n');
});

test('(i) the ask step and the answered step each finish within four no-op baselines over one (about 20 ms on the reference Mac): median of 20 runs, step less an interleaved no-op run of the same function; the ask step with extra work fails the bar', { skip: !POSIX }, (t) => {
  // The baseline is the step's fixed process starts (bash and jq); the bar limits DoFlow's own work above them and
  // scales with the runner's own baseline (test/helper/hook-step-bar.ts).
  const s = scratch(t);
  const env = baseEnv(s);
  const stepFile = path.join(STEP_DIR, 'observe-attention.sh');
  const timed = (args: string[], input = '') => {
    const started = process.hrtime.bigint();
    const result = spawnSync(bashPath(), args, { cwd: s.cwd, env, input });
    assert.equal(result.status, 0);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const invoke = (fn: string, args: string[], input: string, jq = '') => timed(['-c', `( . "$1" && ${fn} "\${@:2}"${jq} ) >/dev/null 2>&1 || true`, '_', stepFile, ...args], input);
  const run = (fn: string, args: string[], input = '') => ({ base: invoke(fn, [], input, '; jq -n . >/dev/null'), step: invoke(fn, args, input) });
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[9] + sorted[10]) / 2; };
  const askRuns: { base: number; step: number }[] = [];
  const answeredRuns: { base: number; step: number }[] = [];
  const quietRuns: { base: number; step: number }[] = [];
  for (let i = 0; i < 20; i += 1) quietRuns.push(run('doflow_attention_answered', ['claude', 'PostToolUse', SESSION]));
  assert.equal(fs.existsSync(s.log), false);
  for (let i = 0; i < 20; i += 1) {
    askRuns.push(run('doflow_observe_attention', ['claude', 'PermissionRequest'], JSON.stringify(permission(i % 2 ? 'Bash' : 'Write'))));
    answeredRuns.push(run('doflow_attention_answered', ['claude', 'PostToolUse', SESSION]));
  }
  assert.equal(lines(s.log).length, 40, 'every timed run wrote its line');
  // The control: the ask step plus extra process starts (CONTROL_EXTRA_WORK) must fail the same bar, so a bar that
  // scales with the runner does not pass a step that grew.
  const controlRuns: { base: number; step: number }[] = [];
  for (let i = 0; i < 20; i += 1) {
    const input = JSON.stringify(permission(i % 2 ? 'Bash' : 'Write'));
    controlRuns.push({ base: invoke('doflow_observe_attention', [], input, '; jq -n . >/dev/null'), step: invoke('doflow_observe_attention', ['claude', 'PermissionRequest'], input, `; ${CONTROL_EXTRA_WORK}`) });
  }
  const stats = (runs: { base: number; step: number }[]) => ({ step: median(runs.map((r) => r.step)), base: median(runs.map((r) => r.base)) });
  const [a, b, q, c] = [stats(askRuns), stats(answeredRuns), stats(quietRuns), stats(controlRuns)];
  const show = (x: { step: number; base: number }) => `${x.step.toFixed(2)} ms vs baseline ${x.base.toFixed(2)} ms`;
  t.diagnostic(`observe-attention median of 20 (step vs no-op baseline, bar ${STEP_BAR_BASELINES} baselines): ask ${show(a)}, answered ${show(b)}, answered with no log ${show(q)}, control ${show(c)}`);
  assert.ok(c.step - c.base >= stepBarMs(c.base), `the control with extra work must fail the bar: median ${c.step} ms, baseline ${c.base} ms, bar ${stepBarMs(c.base)} ms`);
  assert.ok(a.step - a.base < stepBarMs(a.base), `ask median ${a.step} ms, baseline ${a.base} ms, bar ${stepBarMs(a.base)} ms`);
  assert.ok(b.step - b.base < stepBarMs(b.base), `answered median ${b.step} ms, baseline ${b.base} ms, bar ${stepBarMs(b.base)} ms`);
  assert.ok(q.step - q.base < stepBarMs(q.base), `answered (no log) median ${q.step} ms, baseline ${q.base} ms, bar ${stepBarMs(q.base)} ms`);
});
