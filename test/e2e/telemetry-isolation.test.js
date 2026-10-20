'use strict';

// 088 D.3 (G-O3, FR-002, NFR-005, IC-004, IC-006): compare real CLI and shared-bridge hook
// outcomes as raw bytes with telemetry on, off and faulted. The loops keep all harness variants on
// one install mirror and reuse one project per command; no command or fault case is dropped.
// 091 E.1 (NFR-002): `trace`, `stats`, `discover` and `trace spans` print the same bytes with
// telemetry on, off and with an OTLP endpoint configured; no export command runs, so nothing connects.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, removeTree } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const HOOK_FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const MIRROR_SCRIPT = path.join(REPO, 'test/hooks/build-install-mirror.sh');
const BASH = '/bin/bash';
const SLUG = 'feat-isolation';
const FIXED_MS = 1792000000000;
const FIXED_DATE = new Date(FIXED_MS).toISOString().slice(0, 10);
const SCRATCH = suiteTempDir('doflow-telemetry-isolation-');
const TEST_BIN = path.join(SCRATCH, 'bin');
const PRELOAD_FIXED = path.join(SCRATCH, 'fixed-clock.js');
const PRELOAD_STABLE_DATE = path.join(SCRATCH, 'stable-date.js');
const PRELOAD_FAULT = path.join(SCRATCH, 'telemetry-clock-fault.js');
const PRELOAD_FAULT_STABLE_DATE = path.join(SCRATCH, 'telemetry-clock-fault-stable-date.js');
const INJECT_FROM = 'session:dft_token($d.identity.session)';
const INJECT_TO = 'session:error("x")';
const FS_FAULTS = ['telemetry-dir-unwritable', 'fifo-target', 'directory-target', 'runs-unwritable'];
const PROFILES = ['compat-1', 'strict-1'];

after(() => removeTree(SCRATCH));

fs.mkdirSync(TEST_BIN, { recursive: true });
fs.symlinkSync(process.execPath, path.join(TEST_BIN, 'node'));
fs.symlinkSync(BASH, path.join(TEST_BIN, 'bash'));

fs.writeFileSync(PRELOAD_FIXED, `Date.now = () => ${FIXED_MS};\n`);

fs.writeFileSync(PRELOAD_STABLE_DATE, [
  'const realDate = Date;',
  `const fixedMs = ${FIXED_MS};`,
  'class FixedDate extends realDate { constructor(...args) { super(...(args.length ? args : [fixedMs])); } static now() { return fixedMs; } }',
  'global.Date = FixedDate;',
].join('\n') + '\n');

const faultPrelude = [
  'const crypto = require("node:crypto");',
  // Only the DIRECT caller counts: a stack that merely passes through task-run.ts also holds the
  // product's own clock reads, which are not telemetry and must not be faulted. Frame 4 is the caller
  // of the wrapper (0 Error, 1 callerFrame, 2 fail, 3 wrapper).
  'const callerFrame = () => (new Error().stack || "").split("\\n")[4] || "";',
  'const TELEMETRY = /telemetry(?:-emit)?\\.ts/;',
  'const fail = (name, pattern) => { if (pattern.test(callerFrame())) throw new Error("088 injected " + name + " fault"); };',
  'const realRandomBytes = crypto.randomBytes;',
  'crypto.randomBytes = function(...args) { fail("crypto.randomBytes", /(?:telemetry(?:-emit)?|task-run)\\.ts/); return realRandomBytes.apply(this, args); };',
  'const realNow = Date.now;',
  'Date.now = function(...args) { fail("Date.now", TELEMETRY); return realNow.apply(this, args); };',
  'const realHrtime = process.hrtime;',
  'const realHrtimeBigint = process.hrtime.bigint;',
  'const patchedHrtime = function(...args) { fail("process.hrtime", /(?:telemetry(?:-emit)?|contract-runner)\\.ts/); return realHrtime.apply(this, args); };',
  'patchedHrtime.bigint = function(...args) { fail("process.hrtime", /(?:telemetry(?:-emit)?|contract-runner)\\.ts/); return realHrtimeBigint.apply(realHrtime, args); };',
  'process.hrtime = patchedHrtime;',
];
fs.writeFileSync(PRELOAD_FAULT, [
  `const fixedMs = ${FIXED_MS};`,
  'Date.now = () => fixedMs;',
  ...faultPrelude,
].join('\n') + '\n');
fs.writeFileSync(PRELOAD_FAULT_STABLE_DATE, [
  'const realDate = Date;',
  `const fixedMs = ${FIXED_MS};`,
  'class FixedDate extends realDate { constructor(...args) { super(...(args.length ? args : [fixedMs])); } static now() { return fixedMs; } }',
  'global.Date = FixedDate;',
  ...faultPrelude,
].join('\n') + '\n');

const nodeEnv = (root, telemetry, extra = {}) => {
  const env = cleanEnv();
  const home = path.join(SCRATCH, `home-node-${++homeSequence}`);
  fs.mkdirSync(path.join(home, 'xdg'), { recursive: true });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    PATH: `${TEST_BIN}${path.delimiter}${process.env.PATH || ''}`,
    TMPDIR: SCRATCH,
    TZ: 'UTC',
    DOFLOW_CONFIG_DIR: path.join(root, '.doflow'),
    DOFLOW_TELEMETRY: telemetry,
    DOFLOW_RUN_ID: 'run-088',
    DOFLOW_LINEAGE_ID: 'lineage-088',
    DOFLOW_ATTEMPT: '1',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
};

let homeSequence = 0;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOFLOW_') || key.startsWith('OTEL_') || key === 'EPOCHREALTIME' || key === 'FORCE_COLOR') delete env[key];
  }
  return env;
}

function commandResult(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  return {
    status: result.status,
    stdout: result.stdout || Buffer.alloc(0),
    stderr: result.stderr || Buffer.alloc(0),
  };
}

function sameOutcome(expected, actual, label) {
  assert.deepStrictEqual(actual, expected, `${label}: telemetry changed status/stdout/stderr bytes`);
}

/**
 * `trace spans` READS the telemetry directory, so a FIFO or directory planted as a partition is input
 * it must report, not a write fault it may ignore: the output is the unfaulted output plus exactly one
 * located `unparseable` gap for that partition (C.2d), and nothing else differs.
 */
function sameSpansPlusGap(expected, actual, label) {
  assert.equal(actual.status, expected.status, `${label}: status`);
  assert.deepStrictEqual(actual.stderr, expected.stderr, `${label}: stderr`);
  const base = JSON.parse(expected.stdout.toString());
  const view = JSON.parse(actual.stdout.toString());
  const gap = { kind: 'telemetry', locator: `runs/telemetry/${FIXED_DATE}.jsonl`, reason: 'unparseable' }; // keys sorted, as the verb prints them
  assert.deepStrictEqual(view.gaps.filter((entry) => JSON.stringify(entry) !== JSON.stringify(gap)), base.gaps, `${label}: gaps other than the planted partition`);
  assert.equal(view.gaps.filter((entry) => JSON.stringify(entry) === JSON.stringify(gap)).length, 1, `${label}: the planted partition is one located gap`);
  assert.deepStrictEqual({ ...view, gaps: null }, { ...base, gaps: null }, `${label}: traces and spans`);
}

function telemetryDir(root) {
  return path.join(root, '.doflow', 'state', 'runs', 'telemetry');
}

function regularTelemetryFiles(root) {
  const dir = telemetryDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile()) return [];
    return [{ name, bytes: fs.readFileSync(file) }];
  });
}

function telemetrySnapshot(root) {
  return regularTelemetryFiles(root).map(({ name, bytes }) => [name, bytes.toString('base64')]);
}

function resetState(root) {
  const state = path.join(root, '.doflow', 'state');
  if (fs.existsSync(state)) fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
}

function writeProject(root) {
  fs.mkdirSync(path.join(root, '.doflow'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', SLUG), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  writeVerificationPlan(root, false);
}

function writeVerificationPlan(root, fail) {
  const plan = [
    '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
    '- [ ] A.1 telemetry isolation; owner: core-implementer; files: src/a.js', '',
    '```doflow-verification',
    JSON.stringify({ parse: null, build: 'node -e 0', typecheck: null, lint: 'node -e 0', test: fail ? 'node -e "process.exit(1)"' : 'node -e 0', testTargeted: 'node -e 0 {pattern}' }),
    '```', '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', SLUG, 'plan.md'), plan);
  // A minimal, read-only Git metadata fixture lets the CLI resolve the branch during resume.
  // No git command is run to create or mutate it.
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `ref: refs/heads/${SLUG}\n`);
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
}

function runCli(root, args, { telemetry = 'on', preload = null, extraEnv = {}, label = '' } = {}) {
  const selectedPreload = preload || (args[0] === 'task-attempt' ? PRELOAD_STABLE_DATE : PRELOAD_FIXED);
  const result = spawnSync(process.execPath, ['--require', selectedPreload, CLI, ...args], {
    cwd: root,
    env: nodeEnv(root, telemetry, extraEnv),
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return commandResult(result, `${label ? `${label}: ` : ''}doflow ${args.join(' ')}`);
}

function taskAttempt(root, action, args = [], telemetry = 'off') {
  const result = runCli(root, ['task-attempt', '--action', action, '--slug', SLUG, '--json', ...args], { telemetry });
  return result;
}

function seedTaskRun(root, paused = false) {
  const started = taskAttempt(root, 'start', ['--by', 'orchestrator']);
  assert.equal(started.status, 0, `seed start: ${started.stderr.toString()}`);
  if (!paused) return null;
  const pausedResult = taskAttempt(root, 'pause', ['--by', 'orchestrator', '--reason', 'isolation fixture']);
  assert.equal(pausedResult.status, 0, `seed pause: ${pausedResult.stderr.toString()}`);
  const preview = taskAttempt(root, 'resume');
  assert.equal(preview.status, 1, `resume preview: ${preview.stderr.toString()}`);
  const digest = JSON.parse(preview.stdout.toString()).digest;
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  return digest;
}

function seedTraceInputs(root) {
  const runs = path.join(root, '.doflow', 'state', 'runs');
  fs.mkdirSync(path.join(runs, 'telemetry'), { recursive: true });
  fs.writeFileSync(path.join(runs, `${FIXED_DATE}.jsonl`), `${JSON.stringify({
    timestamp: `${FIXED_DATE}T00:00:00.000Z`, verb: 'verify', outcome: 'ok', duration_ms: 1,
  })}\n`);
  fs.writeFileSync(path.join(runs, 'telemetry', `${FIXED_DATE}.jsonl`), `${JSON.stringify({
    timestamp: `${FIXED_DATE}T00:00:01.000Z`, kind: 'hook', harness: 'claude', event: 'PreToolUse',
    policy: 'pre-bash-guard', verdict: 'allow', duration_ms: null, run: null, lineage: null, attempt: null,
    session: 'session-088', tool: 'Bash', tool_call_id: null,
  })}\n`);
}

function makeNodeCases(root) {
  const verifyArgs = (fail, json) => [
    'verify', '--task-id', 'A.1', '--risk', 'LOW', '--plan-path', path.join(root, 'agent-docs', 'doflow', SLUG, 'plan.md'),
    '--scope', 'src/a.js,agent-docs/doflow/feat-isolation/plan.md',
    ...(json ? ['--json'] : []),
  ];
  return [
    ...[false, true].flatMap((fail) => [
      { id: `verify-${fail ? 'fail' : 'pass'}-json`, prepare: () => writeVerificationPlan(root, fail), args: verifyArgs(fail, true), expectedStatus: fail ? 1 : 0, writesTelemetry: true },
      { id: `verify-${fail ? 'fail' : 'pass'}-text`, prepare: () => writeVerificationPlan(root, fail), args: verifyArgs(fail, false), expectedStatus: fail ? 1 : 0, writesTelemetry: true },
    ]),
    { id: 'task-attempt-start', prepare: () => {}, args: ['task-attempt', '--action', 'start', '--slug', SLUG, '--by', 'orchestrator', '--json'], expectedStatus: 0 },
    { id: 'task-attempt-pause', prepare: () => { seedTaskRun(root); }, args: ['task-attempt', '--action', 'pause', '--slug', SLUG, '--by', 'orchestrator', '--reason', 'isolation fixture', '--json'], expectedStatus: 0 },
    { id: 'task-attempt-resume', prepare: () => { const digest = seedTaskRun(root, true); return ['--ack', digest, '--by', 'orchestrator']; }, args: ['task-attempt', '--action', 'resume', '--slug', SLUG, '--json'], expectedStatus: 0 },
    { id: 'task-attempt-inspect', prepare: () => { seedTaskRun(root, true); }, args: ['task-attempt', '--action', 'inspect', '--slug', SLUG, '--json'], expectedStatus: 0 },
    { id: 'trace-spans-json', prepare: () => { const data = path.join(root, 'trace-project'); fs.mkdirSync(path.join(data, '.doflow', 'state', 'runs'), { recursive: true }); seedTraceInputs(data); }, args: ['trace', 'spans', '--json', path.join(root, 'trace-project')], expectedStatus: 0 },
    { id: 'trace-stats', prepare: () => { const data = path.join(root, 'stats-project'); fs.mkdirSync(path.join(data, '.doflow', 'state', 'runs'), { recursive: true }); seedTraceInputs(data); }, args: ['stats', '--json', path.join(root, 'stats-project')], expectedStatus: 0 },
  ];
}

function fixedDateTarget(root) {
  return path.join(telemetryDir(root), `${FIXED_DATE}.jsonl`);
}

function prepareNodeFault(root, fault) {
  const tel = telemetryDir(root);
  const runs = path.join(root, '.doflow', 'state', 'runs');
  if (fault === 'telemetry-dir-unwritable') {
    fs.mkdirSync(tel, { recursive: true });
    fs.chmodSync(tel, 0o500);
  } else if (fault === 'fifo-target') {
    fs.mkdirSync(tel, { recursive: true });
    const made = spawnSync('mkfifo', [fixedDateTarget(root)]);
    assert.equal(made.status, 0, `mkfifo failed: ${made.stderr?.toString() || ''}`);
  } else if (fault === 'directory-target') {
    fs.mkdirSync(fixedDateTarget(root), { recursive: true });
  } else if (fault === 'runs-unwritable') {
    fs.chmodSync(runs, 0o500);
  }
}

function restoreNodeFault(root, fault) {
  if (fault === 'telemetry-dir-unwritable') {
    const tel = telemetryDir(root);
    if (fs.existsSync(tel)) fs.chmodSync(tel, 0o700);
  }
  if (fault === 'runs-unwritable') fs.chmodSync(path.join(root, '.doflow', 'state', 'runs'), 0o700);
}

function runNodeTrial(root, testCase, mode) {
  resetState(root);
  const extraArgs = testCase.prepare();
  const telemetry = mode === 'off' ? 'off' : 'on';
  const fault = mode.startsWith('fault:') ? mode.slice('fault:'.length) : null;
  const preload = fault === 'telemetry-preload'
    ? (testCase.id.startsWith('task-attempt') ? PRELOAD_FAULT_STABLE_DATE : PRELOAD_FAULT)
    : null;
  const before = telemetrySnapshot(root);
  if (fault && fault !== 'telemetry-preload') prepareNodeFault(root, fault);
  let result;
  try {
    result = runCli(root, [...testCase.args, ...(extraArgs || [])], { telemetry, preload, label: `${testCase.id}/${mode}` });
    assert.equal(result.status, testCase.expectedStatus, `${testCase.id}/${mode}: unexpected exit\n${result.stderr.toString()}\n${result.stdout.toString()}`);
    const afterBytes = telemetrySnapshot(root);
    if (mode === 'off') {
      assert.deepEqual(afterBytes, before, `${testCase.id}: telemetry off wrote a file`);
      if (testCase.id !== 'trace-spans-json' && testCase.id !== 'trace-stats') {
        assert.equal(fs.existsSync(telemetryDir(root)), false, `${testCase.id}: telemetry off created its directory`);
      }
    }
    if (mode === 'on' && testCase.writesTelemetry) assert.ok(afterBytes.length > 0, `${testCase.id}: telemetry on wrote no record`);
    if (fault && fault !== 'telemetry-preload') assert.equal(regularTelemetryFiles(root).length, 0, `${testCase.id}/${fault}: fault wrote a telemetry line`);
    return result;
  } finally {
    if (fault && fault !== 'telemetry-preload') restoreNodeFault(root, fault);
  }
}

const SURFACES = {
  'claude:pre-bash-guard': { harness: 'claude', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.claude/hooks/pre-bash-guard.sh', fixture: 'claude/pre-bash-guard/perf.json', tool: 'Bash' },
  'codex:pre-bash-guard': { harness: 'codex', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.codex/hooks/pre-bash-guard.sh', fixture: 'codex/pre-bash-guard/perf.json', tool: 'Bash' },
  'gemini:pre-bash-guard': { harness: 'gemini', event: 'BeforeTool', policy: 'pre-bash-guard', door: '.gemini/hooks/pre-bash-guard.sh', fixture: 'gemini/pre-bash-guard/perf.json', tool: 'run_shell_command' },
  'kiro:pre-bash-guard': { harness: 'kiro', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.kiro/hooks/pre-bash-guard.sh', fixture: 'kiro/pre-bash-guard/perf.json', tool: 'Bash' },
  'antigravity:pre-bash-guard': { harness: 'antigravity', event: 'PreToolUse', policy: 'pre-bash-guard', runner: true, fixture: 'antigravity/pre-bash-guard/perf.json', tool: 'run_command' },
  'pi:pre-bash-guard': { harness: 'pi', event: 'tool_call', policy: 'pre-bash-guard', bridge: true, fixture: 'pi/tool_call/perf-bash.json', tool: 'bash' },
  'claude:user-prompt-submit': { harness: 'claude', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.claude/hooks/user-prompt-submit.sh', fixture: 'claude/user-prompt-submit/perf.json', tool: null },
  'codex:user-prompt-submit': { harness: 'codex', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.codex/hooks/user-prompt-submit.sh', fixture: 'codex/user-prompt-submit/perf.json', tool: null },
};
const GUARDS = Object.values(SURFACES).filter((surface) => surface.policy === 'pre-bash-guard');

function buildMirror(root) {
  const result = spawnSync(BASH, [MIRROR_SCRIPT, root], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `install mirror: ${result.stderr || ''}`);
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
}

function fixtureNative(surface) {
  return JSON.parse(fs.readFileSync(path.join(HOOK_FIXTURES, surface.fixture), 'utf8')).native;
}

function commandNative(surface, command, root) {
  const native = JSON.parse(JSON.stringify(fixtureNative(surface)));
  if (Array.isArray(native.workspacePaths)) native.workspacePaths = [root];
  if (surface.harness === 'antigravity') native.toolCall.args.CommandLine = command;
  else if (surface.harness === 'pi') native.input.command = command;
  else native.tool_input.command = command;
  return native;
}

function utcTargetDates() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return [today, tomorrow];
}

function clearHookTelemetry(root) {
  const tel = telemetryDir(root);
  if (fs.existsSync(tel)) {
    const mode = fs.statSync(tel).mode;
    if ((mode & 0o200) === 0) fs.chmodSync(tel, 0o700);
    fs.rmSync(tel, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
}

function prepareHookFault(root, fault) {
  const tel = telemetryDir(root);
  const runs = path.join(root, '.doflow', 'state', 'runs');
  if (fault === 'telemetry-dir-unwritable') {
    fs.mkdirSync(tel, { recursive: true });
    fs.chmodSync(tel, 0o500);
  } else if (fault === 'fifo-target') {
    fs.mkdirSync(tel, { recursive: true });
    for (const date of utcTargetDates()) {
      const result = spawnSync('mkfifo', [path.join(tel, `${date}.jsonl`)]);
      assert.equal(result.status, 0, `mkfifo failed: ${result.stderr?.toString() || ''}`);
    }
  } else if (fault === 'directory-target') {
    for (const date of utcTargetDates()) fs.mkdirSync(path.join(tel, `${date}.jsonl`), { recursive: true });
  } else if (fault === 'runs-unwritable') {
    fs.chmodSync(runs, 0o500);
  }
}

function restoreHookFault(root, fault) {
  if (fault === 'telemetry-dir-unwritable') {
    const tel = telemetryDir(root);
    if (fs.existsSync(tel)) fs.chmodSync(tel, 0o700);
  }
  if (fault === 'runs-unwritable') fs.chmodSync(path.join(root, '.doflow', 'state', 'runs'), 0o700);
}

function hookEnv(root, surface, telemetry, profile) {
  const home = path.join(SCRATCH, `home-hook-${++homeSequence}`);
  fs.mkdirSync(path.join(home, 'xdg'), { recursive: true });
  const env = cleanEnv();
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    PATH: `${TEST_BIN}${path.delimiter}${process.env.PATH || ''}`,
    TMPDIR: SCRATCH,
    TZ: 'UTC',
    DOFLOW_CONFIG_DIR: path.join(root, '.doflow'),
    DOFLOW_AGENT: surface.harness,
    DOFLOW_TELEMETRY: telemetry,
    DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_FAULT_PROFILE: profile,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function runHook(root, surface, native, { telemetry = 'on', profile = 'compat-1' } = {}) {
  const payload = JSON.parse(JSON.stringify(native));
  if (Array.isArray(payload.workspacePaths)) payload.workspacePaths = [root];
  const options = {
    cwd: root,
    input: Buffer.from(`${JSON.stringify(payload)}\n`),
    env: hookEnv(root, surface, telemetry, profile),
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  };
  let result;
  if (surface.runner) {
    result = spawnSync(process.execPath, [path.join(root, '.doflow/shared/hooks/stream-hook-runner.js'), surface.event], {
      ...options, env: { ...options.env, DOFLOW_PROJECT_DIR: root },
    });
  } else if (surface.bridge) {
    result = spawnSync(BASH, [path.join(root, '.doflow/shared/hooks/bridge/bridge.sh'), surface.harness, surface.event, surface.policy], options);
  } else {
    result = spawnSync(BASH, [path.join(root, surface.door)], options);
  }
  return commandResult(result, `${surface.harness}/${surface.policy}`);
}

function hookLines(root) {
  const files = regularTelemetryFiles(root);
  return files.flatMap(({ bytes }) => bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

function denied(surface, result) {
  if (surface.harness === 'kiro') return result.status === 2 && /Catastrophic delete blocked/.test(result.stderr.toString());
  if (surface.harness === 'claude' || surface.harness === 'codex') return /"permissionDecision":\s*"deny"/.test(result.stdout.toString());
  if (surface.harness === 'pi') return /"block":\s*true/.test(result.stdout.toString());
  return /"decision":\s*"deny"/.test(result.stdout.toString());
}

function makeHookCases(root) {
  const cases = [];
  for (const surface of GUARDS) {
    cases.push({ id: `${surface.harness}/harmless`, surface, profile: 'compat-1', native: commandNative(surface, 'printf safe', root), danger: false });
    for (const profile of PROFILES) {
      cases.push({ id: `${surface.harness}/dangerous/${profile}`, surface, profile, native: commandNative(surface, 'rm -rf /', root), danger: true });
    }
  }
  for (const key of ['claude:user-prompt-submit', 'codex:user-prompt-submit']) {
    const surface = SURFACES[key];
    cases.push({ id: key, surface, profile: 'compat-1', native: fixtureNative(surface), danger: false });
  }
  return cases;
}

function runHookTrial(root, hookCase, mode) {
  clearHookTelemetry(root);
  const fault = mode.startsWith('fault:') ? mode.slice('fault:'.length) : null;
  if (fault) prepareHookFault(root, fault);
  let result;
  try {
    result = runHook(root, hookCase.surface, hookCase.native, {
      telemetry: mode === 'off' ? 'off' : 'on', profile: hookCase.profile,
    });
    const lines = hookLines(root);
    if (mode === 'off') assert.equal(fs.existsSync(telemetryDir(root)), false, `${hookCase.id}: off created the telemetry directory`);
    else if (mode === 'on') assert.equal(lines.length, 1, `${hookCase.id}: telemetry on should write one hook line`);
    else assert.equal(lines.length, 0, `${hookCase.id}/${fault}: fault wrote a hook line`);
    if (hookCase.danger) assert.equal(denied(hookCase.surface, result), true, `${hookCase.id}: rm -rf / must be denied`);
    else if (hookCase.surface.policy === 'pre-bash-guard') assert.equal(denied(hookCase.surface, result), false, `${hookCase.id}: harmless command should be allowed`);
    return result;
  } finally {
    if (fault) restoreHookFault(root, fault);
  }
}

function injectTupleFault(root, unwrap) {
  const file = path.join(root, '.doflow/shared/hooks/bridge/envelope.jq');
  const original = fs.readFileSync(file, 'utf8');
  assert.ok(original.includes(INJECT_FROM), 'the production tuple expression is present');
  let changed = original.replace(INJECT_FROM, INJECT_TO);
  if (unwrap) {
    assert.ok(changed.includes('[try (') && changed.includes(') catch {dft:1}]'), 'the production expression is try-wrapped');
    changed = changed.replace('[try (', '[(').replace(') catch {dft:1}]', ')]');
  }
  assert.notEqual(changed, original);
  fs.writeFileSync(file, changed);
  return () => fs.writeFileSync(file, original);
}

function runNodeMatrix() {
  const root = path.join(SCRATCH, 'node-project');
  fs.mkdirSync(root, { recursive: true });
  writeProject(root);
  const cases = makeNodeCases(root);
  let comparisons = 0;
  for (const testCase of cases) {
    const off = runNodeTrial(root, testCase, 'off');
    const on = runNodeTrial(root, testCase, 'on');
    sameOutcome(off, on, `${testCase.id}/on`);
    assert.equal(on.status, testCase.expectedStatus, `${testCase.id}: positive control`);
    comparisons += 1;
    for (const fault of FS_FAULTS) {
      const faulted = runNodeTrial(root, testCase, `fault:${fault}`);
      if (testCase.id === 'trace-spans-json' && (fault === 'fifo-target' || fault === 'directory-target')) {
        sameSpansPlusGap(off, faulted, `${testCase.id}/${fault}`);
      } else {
        sameOutcome(off, faulted, `${testCase.id}/${fault}`);
      }
      comparisons += 1;
    }
    sameOutcome(off, runNodeTrial(root, testCase, 'fault:telemetry-preload'), `${testCase.id}/telemetry-preload`);
    comparisons += 1;
  }
  return { root, cases, comparisons };
}

function runHookMatrix() {
  const root = path.join(SCRATCH, 'hook-project');
  buildMirror(root);
  const cases = makeHookCases(root);
  let comparisons = 0;
  for (const hookCase of cases) {
    const off = runHookTrial(root, hookCase, 'off');
    sameOutcome(off, runHookTrial(root, hookCase, 'on'), `${hookCase.id}/on`);
    comparisons += 1;
    for (const fault of FS_FAULTS) {
      sameOutcome(off, runHookTrial(root, hookCase, `fault:${fault}`), `${hookCase.id}/${fault}`);
      comparisons += 1;
    }
  }
  const restore = injectTupleFault(root, false);
  try {
    for (const hookCase of cases) {
      sameOutcome(runHookTrial(root, hookCase, 'off'), runHookTrial(root, hookCase, 'fault:encode-tuple'), `${hookCase.id}/encode-tuple`);
      comparisons += 1;
    }
  } finally {
    restore();
  }
  return { root, cases, comparisons };
}

function runEncodeBypassNegativeControl() {
  const root = path.join(SCRATCH, 'encode-bypass-project');
  fs.cpSync(path.join(SCRATCH, 'hook-project'), root, { recursive: true });
  clearHookTelemetry(root);
  const surface = SURFACES['claude:pre-bash-guard'];
  const native = commandNative(surface, 'rm -rf /', root);
  const safeOutcome = runHook(root, surface, native, { telemetry: 'off', profile: 'compat-1' });
  assert.equal(denied(surface, safeOutcome), true, 'the scratch off baseline denies the dangerous command');
  const restore = injectTupleFault(root, true);
  try {
    const bypass = runHook(root, surface, native, { telemetry: 'on', profile: 'compat-1' });
    assert.equal(denied(surface, bypass), false, 'the unwrapped encode fault is the planted guard bypass');
    assert.throws(() => sameOutcome(safeOutcome, bypass, 'negative control: encode bypass'), assert.AssertionError);
  } finally {
    restore();
  }
}

test('G-O3: CLI verbs and bridge hooks are byte-identical on, off and faulted', { timeout: 119000 }, () => {
  const started = Date.now();
  const node = runNodeMatrix();
  const hooks = runHookMatrix();
  // These controls prove the same comparator catches exit-code, stderr and guard-bypass changes.
  const baseline = { status: 0, stdout: Buffer.from('allow'), stderr: Buffer.alloc(0) };
  assert.throws(() => sameOutcome(baseline, { ...baseline, status: 1 }, 'negative control: exit'), assert.AssertionError);
  assert.throws(() => sameOutcome(baseline, { ...baseline, stderr: Buffer.from('extra stderr\n') }, 'negative control: stderr'), assert.AssertionError);
  runEncodeBypassNegativeControl();

  assert.equal(node.cases.length, 10, 'fixed Node verb list');
  assert.equal(hooks.cases.length, 20, 'fixed hook list, including both guard profiles');
  assert.ok(Date.now() - started < 119000, 'the complete matrix stays under 120 seconds');
  assert.equal(node.comparisons, 60, '10 Node commands × on plus five faults');
  assert.equal(hooks.comparisons, 120, '20 hook commands × on plus five faults');
  assert.equal(hookLines(hooks.root).length, 0, 'fault comparisons leave no telemetry line behind');
});


/** A 127.0.0.1 port that was bound and released, so a connection to it is refused. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('091 E.1 NFR-002: trace, stats, discover and trace spans are byte-identical with telemetry on, off and an OTLP endpoint set', { timeout: 60000 }, async () => {
  const port = await closedPort();
  const root = path.join(SCRATCH, 'read-verbs-project');
  const data = path.join(root, 'data');
  fs.mkdirSync(root, { recursive: true });
  writeProject(root);
  const cases = [
    ['trace'], ['trace', '--json'], ['stats'], ['stats', '--json'],
    ['discover'], ['discover', '--json'], ['trace', 'spans'], ['trace', 'spans', '--json'],
  ];
  const modes = [
    { id: 'off', telemetry: 'off', extraEnv: {} },
    { id: 'on', telemetry: 'on', extraEnv: {} },
    { id: 'otlp-endpoint', telemetry: 'on', extraEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` } },
  ];
  let comparisons = 0;
  for (const args of cases) {
    const outcomes = modes.map((mode) => {
      // Each trial reads freshly seeded stores at the same path, so a write by an earlier trial cannot leak into a later one.
      fs.rmSync(data, { recursive: true, force: true });
      fs.mkdirSync(path.join(data, '.doflow', 'state', 'runs'), { recursive: true });
      seedTraceInputs(data);
      const result = runCli(root, [...args, data], { telemetry: mode.telemetry, extraEnv: mode.extraEnv, label: mode.id });
      assert.equal(result.status, 0, `${args.join(' ')}/${mode.id}: ${result.stderr.toString()}`);
      assert.ok(result.stdout.length > 0, `${args.join(' ')}/${mode.id}: printed nothing`);
      return result;
    });
    for (let i = 1; i < outcomes.length; i += 1) {
      sameOutcome(outcomes[0], outcomes[i], `${args.join(' ')}/${modes[i].id}`);
      comparisons += 1;
    }
  }
  assert.equal(comparisons, cases.length * 2, 'every read verb compared on and with an endpoint against off');
});
