'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { resolveProjectRoot, delegateToPolicy, evaluateEvent, classifyPreToolUsePolicy } = require('../../core/harnesses/shared/hooks/stream-hook-runner');
const antigravityAdapter = require('../../core/harnesses/shared/hooks/adapters/antigravity');

// The in-process delegateToPolicy calls spawn the bridge with this process's environment and cwd;
// hook lines (088) default off in tests so none lands in the .doflow found above the checkout.
process.env.DOFLOW_TELEMETRY ??= 'off';

test('stream-hook-runner: resolveProjectRoot resolves valid workspace paths', () => {
  const root = resolveProjectRoot([__dirname]);
  assert.ok(typeof root === 'string');
  assert.ok(root.length > 0);
});

test('stream-hook-runner: resolveProjectRoot resolves to the git toplevel, not a subdirectory (022-code-review regression)', () => {
  const root = resolveProjectRoot([path.join(process.cwd(), 'core', 'harnesses')]);
  assert.equal(root, process.cwd());
});

test('stream-hook-runner: resolveProjectRoot skips a non-git workspacePaths entry in a multi-root list (022-code-review regression)', () => {
  // A multi-root workspace listing a non-git directory first must not stop the search — the
  // Antigravity shim this runner replaced iterated every entry, not just the first that exists.
  const root = resolveProjectRoot([suiteTempDir('doflow-runner-nongit-'), process.cwd()]);
  assert.equal(root, process.cwd());
});

test('stream-hook-runner: policy routing classifies native Antigravity tool calls', () => {
  assert.equal(classifyPreToolUsePolicy('mcp__github__create_issue'), 'mcp-tool-guard.sh');
  assert.equal(classifyPreToolUsePolicy('Edit'), 'pre-implementation-gate.sh');
  assert.equal(classifyPreToolUsePolicy('run_command'), 'pre-bash-guard.sh');
  assert.equal(classifyPreToolUsePolicy('view_file'), null);
});

test('stream-hook-runner: delegateToPolicy evaluates native payloads through the bridge', () => {
  const benign = delegateToPolicy(process.cwd(), 'antigravity', 'PreToolUse', 'pre-bash-guard', JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } }));
  assert.equal(benign.effect, 'proceed');
  const blocked = delegateToPolicy(process.cwd(), 'antigravity', 'PreToolUse', 'pre-bash-guard', JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } } }));
  assert.equal(blocked.effect, 'block');
  assert.match(blocked.reason, /pre-bash-guard.*blocked/i);
});

test('stream-hook-runner: evaluateEvent delegates Stop and leaves observation events alone', () => {
  const result = evaluateEvent('Stop', { session_id: '', transcript_path: '' }, '{}', process.cwd(), 'antigravity');
  assert.equal(result.effect, 'proceed');
  assert.deepEqual(evaluateEvent('PostToolUse', {}, '{}', process.cwd(), 'antigravity'), { decision: 'allow' });
  assert.deepEqual(evaluateEvent('PreInvocation', {}, '{}', process.cwd(), 'antigravity'), { decision: 'allow' });
});

test('stream-hook-runner adapter: Antigravity Stop uses continue/silence vocabulary', () => {
  assert.deepEqual(antigravityAdapter.toNative('Stop', { decision: 'deny', reason: 'unfinished work' }), { decision: 'continue', reason: 'unfinished work' });
  assert.deepEqual(antigravityAdapter.toNative('Stop', { decision: 'allow' }), {});
});

test('stream-hook-runner adapter: native pre-tool deny renders from bridge decision', () => {
  assert.deepEqual(antigravityAdapter.toNative('PreToolUse', { outcome: 'deny', effect: 'block', reason: '[pre-implementation-gate] blocked' }), { decision: 'deny', reason: '[pre-implementation-gate] blocked' });
});

// ── Failure capture (feature 046, IC-010, IC-018) ─────────────────────────────────────────────────
// The runner carries its own copy of the classifier and of the Node writer. Every spawn runs under a
// scratch HOME and XDG_CONFIG_HOME (DEC-041); each capture point runs with capture on and off and the
// two must agree byte for byte on stdout, stderr and exit status.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const runnerModule = require('../../core/harnesses/shared/hooks/stream-hook-runner');
const nodeClassifier = require('../../src/runtime/failure/classifier.ts');
const { fingerprint } = require('../../src/runtime/failure/store.ts');

const HOOKS_DIR = path.resolve(__dirname, '..', '..', 'core', 'harnesses', 'shared', 'hooks');
const RUNNER = path.join(HOOKS_DIR, 'stream-hook-runner.js');
const capScratch = createScratch('doflow-runner-capture-');
test.after(() => capScratch.remove());

let capN = 0;
function capMachine(name) {
  const dir = path.join(capScratch.dir, `${name}-${capN++}`);
  const m = { dir, home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), cwd: path.join(dir, 'project') };
  for (const d of [m.home, m.xdg, m.cwd]) fs.mkdirSync(d, { recursive: true });
  m.failures = path.join(m.xdg, 'doflow', 'failures');
  m.events = path.join(m.failures, 'events.jsonl');
  return m;
}
const capLines = (m) => (fs.existsSync(m.events) ? fs.readFileSync(m.events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function runRunner(m, runner, args, stdin, { env = {}, dropHome = false } = {}) {
  const full = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: 'antigravity', ...env };
  if (dropHome) { delete full.HOME; delete full.XDG_CONFIG_HOME; }
  const r = spawnSync(process.execPath, [runner, ...args], { cwd: m.cwd, env: full, input: stdin, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function capPair(runner, args, stdin, options = {}) {
  const on = capMachine('on');
  const off = capMachine('off');
  const a = runRunner(on, runner, args, stdin, options);
  const b = runRunner(off, runner, args, stdin, { ...options, env: { ...(options.env || {}), DOFLOW_FAILURE_CAPTURE: 'off' } });
  assert.deepEqual(a, b, 'output or exit status differs between capture on and off');
  assert.equal(fs.existsSync(off.failures), false, 'capture off creates no folder');
  return { on, a };
}

/** A scratch copy of the hooks folder whose pre-bash-guard.sh is replaced by `body`. */
function runnerWithPolicy(body) {
  const dir = suiteTempDir('doflow-runner-hooks-');
  fs.cpSync(HOOKS_DIR, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policies', 'pre-bash-guard.sh'), `#!/usr/bin/env bash\ncat >/dev/null   # read the payload like a real policy: a script that exits first makes the runner's stdin write fail with EPIPE\n${body}\n`, { mode: 0o755 });
  return path.join(dir, 'stream-hook-runner.js');
}

function runnerWithBridge(body) {
  const dir = suiteTempDir('doflow-runner-bridge-');
  fs.cpSync(HOOKS_DIR, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge', 'bridge.sh'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return path.join(dir, 'stream-hook-runner.js');
}

function runnerWithoutBridge() {
  const dir = suiteTempDir('doflow-runner-missing-bridge-');
  fs.cpSync(HOOKS_DIR, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'bridge', 'bridge.sh'));
  return path.join(dir, 'stream-hook-runner.js');
}

test('stream-hook-runner capture: the runner\'s classifier copy answers like src/runtime/failure/classifier.js on every fixture', () => {
  const fixtures = [
    new TypeError('x'), new RangeError('x'), new ReferenceError('x'), new SyntaxError('x'), new Error('x'),
    Object.assign(new Error('x'), { name: 'AssertionError' }),
    Object.assign(new Error('x'), { code: 'ERR_ASSERTION' }),
    Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }),
    Object.assign(new Error('x'), { code: 'ENOENT', syscall: 'open' }),
    Object.assign(new Error('x'), { code: 'EACCES', errno: -13 }),
    Object.assign(new Error('x'), { code: 'EPIPE', syscall: 'write', errno: -32 }),
    Object.assign(new Error('x'), { code: 'EPIPE' }),
    Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' }),
    Object.assign(new SyntaxError('x'), { code: 'ERR_X', syscall: 'x' }),
    Object.assign(new Error('x'), { code: 'E_CUSTOM' }),
    Object.assign(new Error('x'), { code: 7, syscall: 'x' }),
    new (class RefusalError extends Error {})('x'),
    'boom', null, undefined, 42, { message: 'x' }, {},
    { get code() { throw new Error('no'); }, get name() { throw new Error('no'); } },
    Object.defineProperty(new TypeError('x'), 'name', { get() { throw new Error('no'); } }),
    Object.defineProperty(new RangeError('x'), 'code', { get() { throw new Error('no'); } }),
  ];
  for (const fixture of fixtures) {
    assert.equal(runnerModule.isProgrammingError(fixture), nodeClassifier.isProgrammingError(fixture), String(fixture && fixture.message));
  }
});

test('stream-hook-runner capture: runner-exception is recorded once; output and exit status identical with capture off', () => {
  // `null` parses as JSON and then fails on `payload.workspacePaths`: a TypeError inside main().
  const { on, a } = capPair(RUNNER, ['PreToolUse'], 'null');
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '{"decision":"allow"}\n');
  assert.match(a.stderr, /^\[stream-hook-runner error\] Cannot read properties of null/);
  const [line] = capLines(on);
  assert.equal(capLines(on).length, 1);
  assert.deepEqual(Object.keys(line), ['v', 'at', 'source', 'command', 'harness', 'version', 'project', 'kind', 'message', 'frame', 'exit']);
  assert.deepEqual([line.source, line.command, line.harness, line.kind, line.message, line.exit], ['hook', 'stream-hook-runner', 'antigravity', 'runner-exception', '', null]);
  assert.match(line.frame, /^stream-hook-runner\.js:\w+$/);
  assert.equal(line.version, require('../../package.json').version);
});

test('stream-hook-runner capture: missing event acknowledges allow and records runner-event-missing', () => {
  for (const stdin of ['{not json', '', '   ', '[]', '{"tool_name":"Read"}']) {
    const { on, a } = capPair(RUNNER, [], stdin);
    assert.equal(a.status, 0, JSON.stringify(stdin));
    assert.equal(a.stdout, '{"decision":"allow"}\n', JSON.stringify(stdin));
    assert.deepEqual(capLines(on).map((line) => line.kind), ['runner-event-missing'], JSON.stringify(stdin));
  }
  const missing = capPair(RUNNER, [], '{}');
  assert.equal(missing.a.stdout, '{"decision":"allow"}\n');
  assert.deepEqual(capLines(missing.on).map((line) => line.kind), ['runner-event-missing']);
  const unknown = capPair(RUNNER, ['UnknownEvent'], '{}');
  assert.equal(unknown.a.stdout, '{"decision":"allow"}\n');
  assert.deepEqual(capLines(unknown.on).map((line) => line.kind), ['runner-event-missing']);
});

test('stream-hook-runner capture: runner-exception with HOME unset and no XDG_CONFIG_HOME is skipped, output identical', () => {
  const { a } = capPair(RUNNER, ['PreToolUse'], 'null', { dropHome: true });
  assert.equal(a.stdout, '{"decision":"allow"}\n');
});

// 086 C23 (IC-003 case 9): a relative XDG_CONFIG_HOME is ignored, so a usable HOME decides.
test('stream-hook-runner capture: a relative XDG_CONFIG_HOME is ignored and the line lands under $HOME/.config', () => {
  const m = capMachine('relxdg');
  const r = runRunner(m, RUNNER, ['PreToolUse'], 'null', { env: { XDG_CONFIG_HOME: 'rel/cfg' } });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(m.cwd, 'rel')), false, 'never read against the working directory');
  const events = path.join(m.home, '.config', 'doflow', 'failures', 'events.jsonl');
  assert.deepEqual(fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind), ['runner-exception']);
});

test('stream-hook-runner capture: a relative XDG_CONFIG_HOME with HOME unset has no config home, output identical', () => {
  const on = capMachine('relxdg-nohome');
  const off = capMachine('relxdg-nohome-off');
  const go = (m, extra) => {
    const env = { ...process.env, XDG_CONFIG_HOME: 'rel/cfg', DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: 'antigravity', ...extra };
    delete env.HOME;
    const r = spawnSync(process.execPath, [RUNNER, 'PreToolUse'], { cwd: m.cwd, env, input: 'null', encoding: 'utf8' });
    return [r.status, r.stdout, r.stderr];
  };
  const a = go(on, {});
  assert.deepEqual(a, go(off, { DOFLOW_FAILURE_CAPTURE: 'off' }));
  assert.deepEqual(fs.readdirSync(on.cwd), [], 'nothing created in the working directory');
});

test('stream-hook-runner capture: failure.capture "off" in settings.json beside the failure home turns capture off', () => {
  const m = capMachine('settings-off');
  fs.mkdirSync(path.join(m.xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(m.xdg, 'doflow', 'settings.json'), '{"schema":1,"failure.capture":"off"}\n');
  runRunner(m, RUNNER, ['PreToolUse'], 'null');
  assert.equal(fs.existsSync(m.failures), false);
  // control: "on" leaves capture on
  const c = capMachine('settings-on');
  fs.mkdirSync(path.join(c.xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(c.xdg, 'doflow', 'settings.json'), '{"schema":1,"failure.capture":"on"}\n');
  runRunner(c, RUNNER, ['PreToolUse'], 'null');
  assert.equal(capLines(c).length, 1);
});

test('stream-hook-runner capture: an unwritable store is silent', () => {
  const m = capMachine('unwritable');
  const blocker = path.join(m.dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const a = runRunner(m, RUNNER, ['PreToolUse'], 'null', { env: { XDG_CONFIG_HOME: blocker } });
  const b = runRunner(m, RUNNER, ['PreToolUse'], 'null', { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
  assert.deepEqual(a, b);
});

test('stream-hook-runner capture: the sentinel and the environment switch turn capture off', () => {
  const m = capMachine('switch');
  fs.mkdirSync(m.failures, { recursive: true });
  fs.writeFileSync(path.join(m.failures, 'off'), 'x');
  runRunner(m, RUNNER, ['PreToolUse'], 'null', { env: { DOFLOW_FAILURE_CAPTURE: 'on' } });
  assert.deepEqual(fs.readdirSync(m.failures), ['off']);
  for (const value of ['off', '0', 'false', 'no']) {
    const other = capMachine('switch-env');
    runRunner(other, RUNNER, ['PreToolUse'], 'null', { env: { DOFLOW_FAILURE_CAPTURE: value } });
    assert.equal(fs.existsSync(other.failures), false, value);
  }
});

const PRE_BASH = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } });

test('stream-hook-runner capture: bridge classifies a policy signal and returns its effect decision', () => {
  const runner = runnerWithPolicy('kill -9 $$');
  const { on, a } = capPair(runner, ['PreToolUse'], PRE_BASH);
  assert.equal(a.status, 0);
  assert.match(a.stdout, /"decision":"allow"/);
  const [line] = capLines(on);
  assert.equal(capLines(on).length, 1);
  assert.deepEqual([line.source, line.command, line.kind, line.message, line.frame, line.exit], ['hook', 'pre-bash-guard', 'eval-error:signal-KILL', '', null, null]);
});

test('stream-hook-runner capture: SIGTERM, SIGINT and SIGPIPE are not recorded; other signals get their own kind', () => {
  for (const signal of ['TERM', 'INT', 'PIPE']) {
    const { on, a } = capPair(runnerWithPolicy(`kill -${signal} $$`), ['PreToolUse'], PRE_BASH);
    assert.match(a.stdout, /"decision":"allow"/, signal);
    assert.equal(capLines(on).length, 0, `SIG${signal} is not a fault`);
  }
  const segv = capPair(runnerWithPolicy('kill -SEGV $$'), ['PreToolUse'], PRE_BASH);
  const kill = capPair(runnerWithPolicy('kill -KILL $$'), ['PreToolUse'], PRE_BASH);
  const [a] = capLines(segv.on);
  const [b] = capLines(kill.on);
  assert.deepEqual([a.kind, b.kind], ['eval-error:signal-SEGV', 'eval-error:signal-KILL']);
  assert.notEqual(fingerprint(a), fingerprint(b), 'a SEGV and a KILL do not share a fingerprint');
});

test('stream-hook-runner capture: policy exit stubs become bridge decisions with the same allow/deny effects', () => {
  for (const [body, expected] of [
    ['echo "[pre-bash-guard] blocked" >&2\nexit 2', 'deny'],
    ['exit 0', 'allow'],
    ['exit 1', 'deny'],
  ]) {
    const { a } = capPair(runnerWithPolicy(body), ['PreToolUse'], PRE_BASH);
    assert.equal(JSON.parse(a.stdout).decision, expected, body);
  }
  const runner = runnerWithPolicy('exit 0');
  const { on, a } = capPair(runner, ['PreToolUse'], PRE_BASH, { env: { PATH: path.join(capScratch.dir, 'no-such-bin') } });
  assert.equal(a.status, 0);
  assert.equal(JSON.parse(a.stdout).decision, 'allow');
});

test('stream-hook-runner capture: payload event sniffing is retired and missing event is diagnosed', () => {
  const { on, a } = capPair(RUNNER, [], JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'rm -rf /' } }));
  assert.equal(a.stdout, '{"decision":"allow"}\n');
  assert.deepEqual(capLines(on).map((line) => line.kind), ['runner-event-missing']);
});

test('stream-hook-runner: a bridge timeout is a compat proceed and a strict blocking decision', () => {
  const runner = runnerWithBridge('exec sleep 20');
  const native = JSON.stringify({ toolCall: { name: 'write_to_file', args: { AbsolutePath: 'src/a.js' } } });
  const compat = capMachine('timeout-compat');
  const proceeded = runRunner(compat, runner, ['PreToolUse'], native);
  assert.equal(proceeded.status, 0);
  assert.deepEqual(JSON.parse(proceeded.stdout), { decision: 'allow' });
  assert.deepEqual(capLines(compat).map((line) => line.kind), ['bridge-timeout']);

  const strict = capMachine('timeout-strict');
  const blocked = runRunner(strict, runner, ['PreToolUse'], native, { env: { DOFLOW_FAULT_PROFILE: 'strict-1' } });
  assert.equal(blocked.status, 0);
  assert.deepEqual(JSON.parse(blocked.stdout), { decision: 'deny', reason: '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list' });
  assert.deepEqual(capLines(strict).map((line) => line.kind), ['bridge-timeout']);
});

test('stream-hook-runner: missing bridge is out of step while a failing bridge follows the fault profile', () => {
  const missingRunner = runnerWithoutBridge();
  const failingRunner = runnerWithBridge('exit 1');
  const gateInput = JSON.stringify({ toolCall: { name: 'write_to_file', args: { AbsolutePath: 'src/a.js' } } });
  const stopInput = JSON.stringify({ terminationReason: 'finished' });
  const reason = '[doflow] shared hooks lack the bridge; run: doflow update -t antigravity';

  for (const profile of ['compat-1', 'strict-1']) {
    const env = { DOFLOW_FAULT_PROFILE: profile };
    const gateMissing = capMachine(`missing-gate-${profile}`);
    const gate = runRunner(gateMissing, missingRunner, ['PreToolUse'], gateInput, { env });
    assert.equal(gate.status, 0);
    assert.deepEqual(JSON.parse(gate.stdout), { decision: 'deny', reason });
    assert.deepEqual(capLines(gateMissing).map((line) => line.kind), ['bridge-missing']);

    const stopMissing = capMachine(`missing-stop-${profile}`);
    const stop = runRunner(stopMissing, missingRunner, ['Stop'], stopInput, { env });
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '');
    assert.deepEqual(capLines(stopMissing).map((line) => line.kind), ['bridge-missing']);
  }

  const gateCompat = capMachine('failing-gate-compat');
  const allow = runRunner(gateCompat, failingRunner, ['PreToolUse'], gateInput, { env: { DOFLOW_FAULT_PROFILE: 'compat-1' } });
  assert.deepEqual(JSON.parse(allow.stdout), { decision: 'allow' });
  assert.deepEqual(capLines(gateCompat).map((line) => line.kind), ['bridge-answer-invalid']);

  const gateStrict = capMachine('failing-gate-strict');
  const deny = runRunner(gateStrict, failingRunner, ['PreToolUse'], gateInput, { env: { DOFLOW_FAULT_PROFILE: 'strict-1' } });
  assert.deepEqual(JSON.parse(deny.stdout), { decision: 'deny', reason: '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list' });
  assert.deepEqual(capLines(gateStrict).map((line) => line.kind), ['bridge-answer-invalid']);

  const stopCompat = runRunner(capMachine('failing-stop-compat'), failingRunner, ['Stop'], stopInput, { env: { DOFLOW_FAULT_PROFILE: 'compat-1' } });
  assert.equal(stopCompat.stdout, '');
  const stopStrict = runRunner(capMachine('failing-stop-strict'), failingRunner, ['Stop'], stopInput, { env: { DOFLOW_FAULT_PROFILE: 'strict-1' } });
  assert.deepEqual(JSON.parse(stopStrict.stdout), { decision: 'continue', reason: '[stop-check] DoFlow policy error; details: doflow-run failure list' });
});

test('stream-hook-runner: a bridge that exits before reading a large payload is an invalid answer, not a spawn fault', () => {
  // Far more than a pipe holds, so the bridge's exit reaches the runner's stdin write as EPIPE.
  const native = JSON.stringify({ toolCall: { name: 'write_to_file', args: { AbsolutePath: 'src/a.js', Contents: 'x'.repeat(2 * 1024 * 1024) } } });
  const machine = capMachine('epipe-gate');
  const out = runRunner(machine, runnerWithBridge('exit 1'), ['PreToolUse'], native, { env: { DOFLOW_FAULT_PROFILE: 'compat-1' } });
  assert.deepEqual(JSON.parse(out.stdout), { decision: 'allow' });
  assert.deepEqual(capLines(machine).map((line) => line.kind), ['bridge-answer-invalid']);
});

test('stream-hook-runner capture: captureHookFailure writes the IC-011 line, caps it at 2048 bytes, rotates at 1 MiB and keeps four', () => {
  const m = capMachine('unit');
  const env = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: 'codex' };
  assert.equal(runnerModule.captureHookFailure({ command: 'pre-bash-guard', kind: 'patterns-missing' }, env), true);
  assert.equal(runnerModule.captureHookFailure({ command: '/tmp/some arg', kind: 'x'.repeat(500), frame: 'f'.repeat(100) }, env), true);
  const [first, second] = capLines(m);
  assert.deepEqual([first.command, first.harness, first.kind], ['pre-bash-guard', 'codex', 'patterns-missing']);
  assert.equal(second.command, 'unknown');
  assert.equal(second.kind.length, 80);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) + 1 <= 2048);
  // Rotation and retention.
  for (const stampName of ['20250101T000000Z-1', '20250102T000000Z-1', '20250103T000000Z-1', '20250104T000000Z-1', '20250105T000000Z-1']) {
    fs.writeFileSync(path.join(m.failures, `events-${stampName}.jsonl`), '');
    fs.truncateSync(path.join(m.failures, `events-${stampName}.jsonl`), 1048576);
  }
  fs.truncateSync(m.events, 1048576);
  assert.equal(runnerModule.captureHookFailure({ command: 'mcp-tool-guard', kind: 'policy-file-missing' }, env), true);
  const names = fs.readdirSync(m.failures).sort();
  assert.equal(names.filter((n) => n.startsWith('events-')).length, 4);
  assert.equal(capLines(m).length, 1, 'the new live file holds the one new line');
});

test('stream-hook-runner capture: a FIFO at the failure file is skipped at once, never opened for a blocking write', { skip: process.platform === 'win32' }, () => {
  const m = capMachine('fifo');
  fs.mkdirSync(m.failures, { recursive: true });
  require('node:child_process').execFileSync('mkfifo', [m.events]);
  const env = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '' };
  // In a child process with a time limit: a blocking open would hang this test, not just fail it.
  const child = require('node:child_process').spawnSync(process.execPath, ['-e',
    `console.log(require(${JSON.stringify(RUNNER)}).captureHookFailure({ command: 'pre-bash-guard', kind: 'x' }))`], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'false');
});

test('stream-hook-runner capture: the project label is ~ for a symlinked HOME, and a bare folder name with no HOME', { skip: process.platform === 'win32' }, () => {
  const m = capMachine('proj');
  const physical = path.join(m.dir, 'physical-home');
  fs.mkdirSync(path.join(physical, 'app'), { recursive: true });
  const link = path.join(m.dir, 'linked-home');
  fs.symlinkSync(physical, link);
  const capture = (cwd, env) => {
    fs.rmSync(m.events, { force: true });
    const child = require('node:child_process').spawnSync(process.execPath, ['-e',
      `console.log(require(${JSON.stringify(RUNNER)}).captureHookFailure({ command: 'pre-bash-guard', kind: 'x' }))`], { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.stdout.trim(), 'true', child.stderr);
    return capLines(m)[0].project;
  };
  const base = { ...process.env, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '' };
  assert.equal(capture(path.join(physical, 'app'), { ...base, HOME: link }), '~/app');
  const noHome = { ...base };
  delete noHome.HOME;
  assert.equal(capture(path.join(physical, 'app'), noHome), 'app');
});

test('stream-hook-runner capture: a runner line and a bash-style line with the same fields share one fingerprint', () => {
  const m = capMachine('fp');
  const env = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '' };
  runnerModule.captureHookFailure({ command: 'pre-bash-guard', kind: 'patterns-missing' }, env);
  const [line] = capLines(m);
  assert.equal(fingerprint(line), fingerprint({ ...line, version: '0.0.1', project: '~/other', at: '2030-01-01T00:00:00.000Z' }));
});
