'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  evaluateToolCall, evaluatePayload, resolveProjectRoot,
  evaluateEvent, resolveAgent, resolveAdapter, resolvePolicyScript,
  classifyPreToolUsePolicy, sniffEventFromPayload,
} = require('../../core/harnesses/shared/hooks/stream-hook-runner');
const geminiAdapter = require('../../core/harnesses/shared/hooks/adapters/gemini');
const antigravityAdapter = require('../../core/harnesses/shared/hooks/adapters/antigravity');

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
  const root = resolveProjectRoot([require('node:os').tmpdir(), process.cwd()]);
  assert.equal(root, process.cwd());
});

test('stream-hook-runner: evaluateToolCall allows benign tool calls', () => {
  const result = evaluateToolCall({
    name: 'view_file',
    args: { AbsolutePath: '/some/path/file.txt' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateToolCall blocks destructive commands', () => {
  // Delegates to the Canonical Policy Library's pre-bash-guard.sh (022-normalize-hooks Phase B) —
  // the reason text is now that script's, not the old inlined regex's "SAFETY INVARIANT BLOCKED".
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'rm -rf /' },
  }, process.cwd());

  assert.equal(result.decision, 'deny');
  assert.ok(result.reason.includes('pre-bash-guard'));
  assert.ok(result.reason.toLowerCase().includes('blocked'));
});

test('stream-hook-runner: evaluateToolCall blocks a denied MCP tool call (022-normalize-hooks: newly wired)', (t) => {
  // mcp-policy.conf ships with zero active patterns by design, so this only exercises the
  // dispatch path (MCP_TOOL_PATTERN -> mcp-tool-guard.sh), not a real deny — asserting a real
  // deny would require mutating the shared policy conf, which no test should do.
  const result = evaluateToolCall({
    name: 'mcp__example__tool',
    args: {},
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateToolCall allows safe run_command', () => {
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'npm test' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PreInvocation hook payloads', () => {
  const result = evaluatePayload({
    invocationNum: 1,
    initialNumSteps: 5,
  }, process.cwd());

  assert.deepEqual(result, { injectSteps: [] });
});

test('stream-hook-runner: evaluatePayload handles Stop hook payloads', () => {
  const result = evaluatePayload({
    executionNum: 1,
    terminationReason: 'model_stop',
    fullyIdle: true,
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PostToolUse hook payloads', () => {
  const result = evaluatePayload({
    stepIdx: 3,
    error: '',
  }, process.cwd());

  assert.deepEqual(result, {});
});

// ── 022-normalize-hooks Phase B: event dispatcher / adapter seam ──────────────

test('stream-hook-runner: classifyPreToolUsePolicy routes by tool name', () => {
  assert.equal(classifyPreToolUsePolicy('mcp__github__create_issue'), 'mcp-tool-guard.sh');
  assert.equal(classifyPreToolUsePolicy('mcp_github_create_issue'), 'mcp-tool-guard.sh');
  assert.equal(classifyPreToolUsePolicy('Edit'), 'pre-implementation-gate.sh');
  assert.equal(classifyPreToolUsePolicy('write_to_file'), 'pre-implementation-gate.sh');
  assert.equal(classifyPreToolUsePolicy('Bash'), 'pre-bash-guard.sh');
  assert.equal(classifyPreToolUsePolicy('run_command'), 'pre-bash-guard.sh');
  assert.equal(classifyPreToolUsePolicy('read_file'), null);
});

test('stream-hook-runner: resolveAgent reads DOFLOW_AGENT, defaults to antigravity', () => {
  const prev = process.env.DOFLOW_AGENT;
  try {
    process.env.DOFLOW_AGENT = 'gemini';
    assert.equal(resolveAgent(), 'gemini');
    process.env.DOFLOW_AGENT = 'antigravity';
    assert.equal(resolveAgent(), 'antigravity');
    delete process.env.DOFLOW_AGENT;
    assert.equal(resolveAgent(), 'antigravity');
  } finally {
    if (prev === undefined) delete process.env.DOFLOW_AGENT; else process.env.DOFLOW_AGENT = prev;
  }
});

test('stream-hook-runner: resolveAgent warns on stderr for an unrecognized non-empty DOFLOW_AGENT (022-diagnose follow-up)', () => {
  const prev = process.env.DOFLOW_AGENT;
  const originalWrite = process.stderr.write;
  let written = '';
  process.stderr.write = (chunk) => { written += chunk; return true; };
  try {
    process.env.DOFLOW_AGENT = 'gemni';
    assert.equal(resolveAgent(), 'antigravity');
    assert.ok(written.includes('gemni'));

    written = '';
    process.env.DOFLOW_AGENT = 'antigravity';
    resolveAgent();
    assert.equal(written, '');

    written = '';
    delete process.env.DOFLOW_AGENT;
    resolveAgent();
    assert.equal(written, '');
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) delete process.env.DOFLOW_AGENT; else process.env.DOFLOW_AGENT = prev;
  }
});

test('stream-hook-runner: resolveAdapter picks the matching adapter module', () => {
  assert.equal(resolveAdapter('gemini'), geminiAdapter);
  assert.equal(resolveAdapter('antigravity'), antigravityAdapter);
  assert.equal(resolveAdapter('unknown'), antigravityAdapter);
});

test('stream-hook-runner: sniffEventFromPayload infers event from payload shape', () => {
  assert.equal(sniffEventFromPayload({ toolCall: { name: 'Edit' } }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ tool_name: 'Edit' }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ invocationNum: 1 }), 'PreInvocation');
  assert.equal(sniffEventFromPayload({ terminationReason: 'model_stop' }), 'Stop');
  assert.equal(sniffEventFromPayload({ executionNum: 1 }), 'Stop');
  assert.equal(sniffEventFromPayload({ stepIdx: 1 }), 'PostToolUse');
  assert.equal(sniffEventFromPayload({ session_id: 'x', cwd: '/tmp' }), 'SessionStart');
  assert.equal(sniffEventFromPayload({}), null);
});

test('stream-hook-runner: sniffEventFromPayload does not misclassify PreToolUse as PostToolUse when toolCall is present but falsy (022-code-review regression)', () => {
  // A real Antigravity PreToolUse payload can carry a null/empty toolCall alongside stepIdx (also
  // present on PostToolUse payloads) — the fix checks key presence ('toolCall' in payload), not
  // truthiness, so this still classifies as PreToolUse instead of silently skipping the gate.
  assert.equal(sniffEventFromPayload({ toolCall: null, stepIdx: 3, workspacePaths: ['/tmp'] }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ toolCall: {}, stepIdx: 3 }), 'PreToolUse');
});

test('stream-hook-runner: resolvePolicyScript finds the Phase A canonical script', () => {
  const script = resolvePolicyScript(process.cwd(), 'pre-bash-guard.sh');
  assert.ok(script);
  assert.ok(script.includes(path.join('shared', 'hooks', 'policies', 'pre-bash-guard.sh')));
});

test('stream-hook-runner: evaluateEvent SessionStart never denies', () => {
  const result = evaluateEvent('SessionStart', { session_id: 'x', cwd: process.cwd() }, process.cwd(), 'gemini');
  assert.deepEqual(result, { decision: 'allow' });
});

test('stream-hook-runner: evaluateEvent Stop delegates to stop-check.sh', () => {
  const result = evaluateEvent('Stop', { session_id: '', transcript_path: '' }, process.cwd(), 'gemini');
  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateEvent PostToolUse/PreInvocation are ack-only placeholders', () => {
  assert.deepEqual(evaluateEvent('PostToolUse', {}, process.cwd(), 'gemini'), { decision: 'allow' });
  assert.deepEqual(evaluateEvent('PreInvocation', {}, process.cwd(), 'antigravity'), { decision: 'allow' });
});

test('stream-hook-runner adapters: gemini.toCanonical reads its own field names before falling back to toolCall', () => {
  const canonical = geminiAdapter.toCanonical('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  assert.equal(canonical.tool_name, 'Bash');
  assert.equal(canonical.tool_input.command, 'ls');
});

test('stream-hook-runner adapters: gemini.toNative emits a flat {decision,reason} shape', () => {
  assert.deepEqual(
    geminiAdapter.toNative('PreToolUse', { decision: 'deny', reason: 'blocked' }),
    { decision: 'deny', reason: 'blocked' },
  );
  assert.deepEqual(geminiAdapter.toNative('PreToolUse', { decision: 'allow' }), { decision: 'allow' });
});

test('stream-hook-runner adapters: antigravity.toNative Stop uses the continue/silence vocabulary', () => {
  assert.deepEqual(
    antigravityAdapter.toNative('Stop', { decision: 'deny', reason: 'unfinished work' }),
    { decision: 'continue', reason: 'unfinished work' },
  );
  // Allow is silence (empty object), NOT {decision:'allow'} — Stop's documented asymmetry from
  // PreToolUse's allow/deny vocabulary (design.md C2 / adapters/antigravity.js header).
  assert.deepEqual(antigravityAdapter.toNative('Stop', { decision: 'allow' }), {});
});

// ── Failure capture (feature 046, IC-010, IC-018) ─────────────────────────────────────────────────
// The runner carries its own copy of the classifier and of the Node writer. Every spawn runs under a
// scratch HOME and XDG_CONFIG_HOME (DEC-041); each capture point runs with capture on and off and the
// two must agree byte for byte on stdout, stderr and exit status.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const runnerModule = require('../../core/harnesses/shared/hooks/stream-hook-runner');
const nodeClassifier = require('../../src/runtime/failure/classifier');
const { fingerprint } = require('../../src/runtime/failure/store');

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
  const full = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: 'gemini', ...env };
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
  const dir = fs.mkdtempSync(path.join(capScratch.dir, 'hooks-'));
  fs.cpSync(HOOKS_DIR, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policies', 'pre-bash-guard.sh'), `#!/usr/bin/env bash\ncat >/dev/null   # read the payload like a real policy: a script that exits first makes the runner's stdin write fail with EPIPE\n${body}\n`, { mode: 0o755 });
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
  assert.deepEqual([line.source, line.command, line.harness, line.kind, line.message, line.exit], ['hook', 'stream-hook-runner', 'gemini', 'runner-exception', '', null]);
  assert.match(line.frame, /^stream-hook-runner\.js:\w+$/);
  assert.equal(line.version, require('../../package.json').version);
});

test('stream-hook-runner capture: malformed or empty stdin is not an exception and records nothing', () => {
  for (const stdin of ['{not json', '', '   ', '[]', '{"tool_name":"Read"}']) {
    const { on, a } = capPair(RUNNER, ['PreToolUse'], stdin);
    assert.equal(a.status, 0, JSON.stringify(stdin));
    assert.equal(capLines(on).length, 0, JSON.stringify(stdin));
  }
});

test('stream-hook-runner capture: runner-exception with HOME unset and no XDG_CONFIG_HOME is skipped, output identical', () => {
  const { a } = capPair(RUNNER, ['PreToolUse'], 'null', { dropHome: true });
  assert.equal(a.stdout, '{"decision":"allow"}\n');
});

test('stream-hook-runner capture: a relative XDG_CONFIG_HOME is skipped', () => {
  const m = capMachine('relxdg');
  const r = runRunner(m, RUNNER, ['PreToolUse'], 'null', { env: { XDG_CONFIG_HOME: 'rel/cfg' } });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(m.cwd, 'rel')), false);
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

const PRE_BASH = JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'ls' } });

test('stream-hook-runner capture: policy-exec-fault:<signal> when the policy is killed by a signal; the decision is unchanged', () => {
  const runner = runnerWithPolicy('kill -9 $$');
  const { on, a } = capPair(runner, ['PreToolUse'], PRE_BASH);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '{"decision":"allow"}\n');
  const [line] = capLines(on);
  assert.equal(capLines(on).length, 1);
  assert.deepEqual([line.source, line.command, line.kind, line.message, line.frame, line.exit], ['hook', 'pre-bash-guard', 'policy-exec-fault:SIGKILL', '', null, null]);
});

test('stream-hook-runner capture: SIGTERM, SIGINT and SIGPIPE are not recorded; other signals get their own kind', () => {
  for (const signal of ['TERM', 'INT', 'PIPE']) {
    const { on, a } = capPair(runnerWithPolicy(`kill -${signal} $$`), ['PreToolUse'], PRE_BASH);
    assert.equal(a.stdout, '{"decision":"allow"}\n', signal);
    assert.equal(capLines(on).length, 0, `SIG${signal} is not a fault`);
  }
  const segv = capPair(runnerWithPolicy('kill -SEGV $$'), ['PreToolUse'], PRE_BASH);
  const kill = capPair(runnerWithPolicy('kill -KILL $$'), ['PreToolUse'], PRE_BASH);
  const [a] = capLines(segv.on);
  const [b] = capLines(kill.on);
  assert.deepEqual([a.kind, b.kind], ['policy-exec-fault:SIGSEGV', 'policy-exec-fault:SIGKILL']);
  assert.notEqual(fingerprint(a), fingerprint(b), 'a SEGV and a KILL do not share a fingerprint');
});

test('stream-hook-runner capture: a policy deny, an allow and a missing bash are not recorded, and the output is identical', () => {
  for (const body of ['echo "[pre-bash-guard] blocked" >&2\nexit 2', 'exit 0', 'exit 1']) {
    const { on } = capPair(runnerWithPolicy(body), ['PreToolUse'], PRE_BASH);
    assert.equal(capLines(on).length, 0, body);
  }
  const runner = runnerWithPolicy('exit 0');
  const { on, a } = capPair(runner, ['PreToolUse'], PRE_BASH, { env: { PATH: path.join(capScratch.dir, 'no-such-bin') } });
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '{"decision":"allow"}\n');
  assert.equal(capLines(on).length, 0, 'a missing bash is the environment, not a DoFlow fault');
});

test('stream-hook-runner capture: the deny output of a real policy is unchanged by capture', () => {
  const { on, a } = capPair(RUNNER, ['PreToolUse'], JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'rm -rf /' } }));
  assert.match(a.stdout, /"decision":"deny"/);
  assert.equal(capLines(on).length, 0);
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

test('stream-hook-runner capture: a runner line and a bash-style line with the same fields share one fingerprint', () => {
  const m = capMachine('fp');
  const env = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '' };
  runnerModule.captureHookFailure({ command: 'pre-bash-guard', kind: 'patterns-missing' }, env);
  const [line] = capLines(m);
  assert.equal(fingerprint(line), fingerprint({ ...line, version: '0.0.1', project: '~/other', at: '2030-01-01T00:00:00.000Z' }));
});
