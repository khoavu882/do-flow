'use strict';

// Feature 088 B.2 (IC-003, IC-004; FR-002, FR-004, NFR-005, NFR-008): the shared bridge writes one
// hook line per allowlisted invocation to <config>/state/runs/telemetry/<UTC date>.jsonl, from the
// try-wrapped tuple the encode jq emits first. Telemetry on, off or faulted changes no byte of a
// hook's stdout or stderr and no exit code, and a fault in the tuple never switches off the guard.
// Every case runs in a scratch install mirror with its own .doflow; telemetry is switched on here
// explicitly, because the shared hook helpers default it off.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInstallMirror, createScratch } = require('../helper/hook-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const HOOK_FIXTURE = path.join(REPO, 'test/fixtures/telemetry/hook.jsonl');
const ENVELOPE = '.doflow/shared/hooks/bridge/envelope.jq';
const BASH = '/bin/bash';
const LINE_KEYS = ['kind', 'harness', 'event', 'policy', 'verdict', 'duration_ms', 'emit_reason', 'emit_bytes', 'emit_digest', 'timestamp', 'session', 'tool', 'tool_call_id', 'run', 'lineage', 'attempt', 'role', 'worker_run', 'tool_duration_ms', 'test_class'];
const TEST_CLASS_VALUES = new Set(['verify.verb', 'test.full', 'test.scoped', 'test.other', 'none']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INJECT_FROM = 'session:dft_token($d.identity.session)';
const INJECT_TO = 'session:error("088-injected-tuple-fault")';

const scratch = createScratch('doflow-hook-line-');
after(() => scratch.remove());
let projects = 0;
let homes = 0;

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

/** An install-shaped project: front doors under .<harness>/hooks, the bridge under .doflow/shared. */
function project({ state = 'runs', envelope } = {}) {
  const root = scratch.path(`project-${projects += 1}`);
  buildInstallMirror(root);
  if (state === 'runs') fs.mkdirSync(path.join(root, '.doflow/state/runs'), { recursive: true });
  if (state === 'state') fs.mkdirSync(path.join(root, '.doflow/state'), { recursive: true });
  if (envelope) {
    const file = path.join(root, ENVELOPE);
    const source = fs.readFileSync(file, 'utf8');
    const changed = envelope(source);
    assert.notEqual(changed, source, 'the scratch encoder was changed');
    fs.writeFileSync(file, changed);
  }
  return root;
}

/** The dispatch attempt layout leaves its delivery pack in a nested worktree-local .doflow. */
function dispatchWorktree(root) {
  const worktree = path.join(root, '.doflow/state/dispatch-worktrees/d-000000000001');
  const delivery = path.join(worktree, '.doflow/state/delivery');
  fs.mkdirSync(delivery, { recursive: true });
  fs.writeFileSync(path.join(delivery, 'A.1.json'), '{}\n');
  return worktree;
}

function baseEnv(root, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_') || key === 'EPOCHREALTIME') delete env[key];
  const home = scratch.path(`home-${homes += 1}`); // fresh per run: session-scoped policy state never carries over
  fs.mkdirSync(home, { recursive: true });
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'on', GIT_CONFIG_GLOBAL: '/dev/null', ...extra };
}

function fixtureNative(surface) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, surface.fixture), 'utf8')).native;
}

/** A native payload for `command` on a pre-bash-guard surface. */
function commandNative(surface, command) {
  const native = fixtureNative(surface);
  if (surface.harness === 'antigravity') native.toolCall.args.CommandLine = command;
  else if (surface.harness === 'pi') native.input.command = command;
  else native.tool_input.command = command;
  return native;
}

/** Runs a surface the way its harness does: front door, Antigravity runner, or the Pi bridge call. */
function run(root, surface, native, { env = {}, cwd = root } = {}) {
  const payload = JSON.parse(JSON.stringify(native));
  if (Array.isArray(payload.workspacePaths)) payload.workspacePaths = [root];
  const input = `${JSON.stringify(payload)}\n`;
  const options = { cwd, input, encoding: 'utf8', timeout: 20000, env: baseEnv(root, { DOFLOW_AGENT: surface.harness, ...env }) };
  let result;
  if (surface.runner) result = spawnSync(process.execPath, [path.join(root, '.doflow/shared/hooks/stream-hook-runner.js'), surface.event], { ...options, env: { ...options.env, DOFLOW_PROJECT_DIR: root } });
  else if (surface.bridge) result = spawnSync(BASH, [path.join(root, '.doflow/shared/hooks/bridge/bridge.sh'), surface.harness, surface.event, surface.policy], options);
  else result = spawnSync(BASH, [path.join(root, surface.door)], options);
  assert.equal(result.error, undefined, `${surface.harness}/${surface.policy}: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function telemetryDir(configDir) { return path.join(configDir, 'state/runs/telemetry'); }

function hookLines(configDir) {
  const dir = telemetryDir(configDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((name) => {
    assert.match(name, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  });
}

function denied(surface, result) {
  if (surface.harness === 'kiro') return result.status === 2 && /Catastrophic delete blocked/.test(result.stderr);
  if (surface.harness === 'claude' || surface.harness === 'codex') return /"permissionDecision":\s*"deny"/.test(result.stdout);
  if (surface.harness === 'pi') return /"block":\s*true/.test(result.stdout);
  return /"decision":\s*"deny"/.test(result.stdout);
}

function utcDates() {
  const now = Date.now();
  return [now, now + 86400000].map((ms) => new Date(ms).toISOString().slice(0, 10));
}

const COUNTED_COMMANDS = ['bash', 'cat', 'cksum', 'date', 'dirname', 'jq', 'mkdir'];
let forkShimSets = 0;

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function executableOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir || process.cwd(), name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  assert.fail(`cannot count ${name}: executable was not found on PATH`);
}

function commandShims() {
  const dir = scratch.path(`fork-count-shims-${forkShimSets += 1}`);
  fs.mkdirSync(dir);
  for (const name of COUNTED_COMMANDS) {
    const target = executableOnPath(name);
    const script = `#!/bin/bash\nprintf '%s\\n' ${shellQuote(name)} >> "$DOFLOW_FORK_LOG"\nexec ${shellQuote(target)} "$@"\n`;
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  return dir;
}

function runCounted(root, surface, native, mode, shimDir) {
  const log = scratch.path(`fork-count-${surface.harness}-${surface.policy}-${mode}.log`);
  fs.writeFileSync(log, '');
  const result = run(root, surface, native, {
    env: {
      DOFLOW_TELEMETRY: mode,
      DOFLOW_FORK_LOG: log,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    },
  });
  return {
    result,
    commands: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

function commandCountDelta(off, on) {
  const names = new Set([...off.commands, ...on.commands]);
  return Object.fromEntries([...names].sort().flatMap((name) => {
    const delta = on.commands.filter((command) => command === name).length
      - off.commands.filter((command) => command === name).length;
    return delta === 0 ? [] : [[name, delta]];
  }));
}

function commandCountMap(off) {
  const commands = Array.isArray(off) ? off : off.commands;
  const names = [...new Set(commands)].sort();
  return Object.fromEntries(names.map((name) => [name, commands.filter((c) => c === name).length]));
}

const OFF_BASELINES = {
  'claude:pre-bash-guard': { bash: 1, cat: 2, dirname: 1, jq: 2 },
  'claude:user-prompt-submit': { bash: 1, cat: 2, dirname: 1, jq: 3, mkdir: 1 },
};

function assertForkBudget(counts, label) {
  const delta = counts.on.commands.length - counts.off.commands.length;
  assert.ok(delta <= 1, `${label}: telemetry adds ${delta} external commands; budget is 1`);
}

function compareForkCounts(root, surface, native, shimDir) {
  const off = runCounted(root, surface, native, 'off', shimDir);
  const on = runCounted(root, surface, native, 'on', shimDir);
  return { off, on, deltaByCommand: commandCountDelta(off, on) };
}

test('telemetry adds at most one external command on pre-bash-guard and user-prompt-submit', () => {
  const shimDir = commandShims();
  for (const key of ['claude:pre-bash-guard', 'claude:user-prompt-submit']) {
    const surface = SURFACES[key];
    const root = project();
    const counts = compareForkCounts(root, surface, fixtureNative(surface), shimDir);
    assertForkBudget(counts, key);
    assert.deepEqual(commandCountMap(counts.off), OFF_BASELINES[key], `${key}: exact baseline OFF-mode command counts`);
    assert.deepEqual(counts.deltaByCommand, { mkdir: 1 }, `${key}: mkdir is the only added external command`);
    assert.deepEqual(counts.on.result, counts.off.result, `${key}: telemetry leaves hook output unchanged`);
    assert.equal(hookLines(path.join(root, '.doflow')).length, 1, `${key}: ON wrote one line`);
    // Once the telemetry directory exists, telemetry adds no counted command at all (rider R1, 091).
    const later = runCounted(root, surface, fixtureNative(surface), 'on', shimDir);
    assert.deepEqual(commandCountDelta(counts.off, later), {}, `${key}: a later ON run adds no external command`);
    assert.deepEqual(later.result, counts.off.result, `${key}: a later ON run leaves hook output unchanged`);
  }
});

test('negative control: a planted date fork exceeds the one-command telemetry budget', () => {
  const shimDir = commandShims();
  const root = project();
  const bridgePath = path.join(root, '.doflow/shared/hooks/bridge/bridge.sh');
  const bridge = fs.readFileSync(bridgePath, 'utf8');
  const append = 'f=$d/state/runs/telemetry/$day.jsonl';
  assert.ok(bridge.includes(append), 'the scratch bridge has the hook-line append point');
  fs.writeFileSync(bridgePath, bridge.replace(append, `date >/dev/null 2>&1 || true\n  ${append}`));

  const surface = SURFACES['claude:pre-bash-guard'];
  const counts = compareForkCounts(root, surface, fixtureNative(surface), shimDir);
  assert.deepEqual(counts.deltaByCommand, { date: 1, mkdir: 1 }, 'the planted date is counted with mkdir');
  assert.throws(() => assertForkBudget(counts, 'planted date negative control'), /adds 2 external commands; budget is 1/);
});

test('one allowlisted hook line per harness fixture, with the contract keys and no content', () => {
  const root = project();
  const env = { DOFLOW_RUN_ID: 'run-088', DOFLOW_LINEAGE_ID: 'lineage-088', DOFLOW_ATTEMPT: '2' };
  for (const surface of Object.values(SURFACES)) {
    const before = hookLines(path.join(root, '.doflow')).length;
    const native = fixtureNative(surface);
    const result = run(root, surface, native, { env });
    const lines = hookLines(path.join(root, '.doflow'));
    assert.equal(lines.length, before + 1, `${surface.harness}/${surface.policy}: one line`);
    const line = lines.at(-1);
    const expectedKeys = LINE_KEYS;
    assert.deepEqual(Object.keys(line), expectedKeys, `${surface.harness}/${surface.policy}: key order`);
    if (surface.policy === 'pre-bash-guard') {
      assert.ok(Object.hasOwn(line, 'test_class') && TEST_CLASS_VALUES.has(line.test_class), `${surface.harness}/${surface.policy}: test_class uses the closed vocabulary`);
    } else {
      assert.equal(line.test_class, null, `${surface.harness}/${surface.policy}: test_class is null`);
    }
    assert.match(line.timestamp, TIMESTAMP);
    assert.deepEqual({ ...line, timestamp: 'T' }, {
      kind: 'hook', harness: surface.harness, event: surface.event, policy: surface.policy, verdict: 'allow',
      duration_ms: null,
      // Rider R1 (091): null off the prompt policy; there, emit with the stdout byte count, else silence.
      ...(surface.policy === 'pre-bash-guard'
        ? { emit_reason: null, emit_bytes: null, emit_digest: null }
        : result.stdout === '{}\n'
          ? { emit_reason: 'silent:unchanged', emit_bytes: 0, emit_digest: null }
          : { emit_reason: 'emit', emit_bytes: Buffer.byteLength(result.stdout), emit_digest: /^[0-9a-f]{8}$/.test(line.emit_digest) ? line.emit_digest : 'not-8-hex' }),
      timestamp: 'T', session: native.session_id || null, tool: surface.tool,
      tool_call_id: surface.harness === 'pi' ? native.toolCallId : null, run: 'run-088', lineage: 'lineage-088', attempt: 2, role: null, worker_run: null,
      tool_duration_ms: null,
      test_class: surface.policy === 'pre-bash-guard' ? 'none' : null,
    }, `${surface.harness}/${surface.policy}: line`);
    const content = native.prompt || native.tool_input?.command || native.input?.command || native.toolCall?.args?.CommandLine;
    assert.ok(content && !JSON.stringify(line).includes(content), `${surface.harness}/${surface.policy}: no command or prompt in the line`);
  }
});

test('the committed hook fixture strictly pins bridge keys, including test_class and tool_duration_ms', () => {
  const root = project();
  run(root, SURFACES['claude:pre-bash-guard'], fixtureNative(SURFACES['claude:pre-bash-guard']));
  const [written] = hookLines(path.join(root, '.doflow'));
  const fixture = fs.readFileSync(HOOK_FIXTURE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(fixture.length, 1);
  assert.deepEqual(Object.keys(fixture[0]), Object.keys(written));
  assert.equal(written.test_class, fixture[0].test_class);
  assert.equal(written.duration_ms, null);
  assert.equal(written.tool_duration_ms, fixture[0].tool_duration_ms);
});

test('a non-command hook line carries "test_class":null, and telemetry off writes no line', () => {
  for (const key of ['claude:user-prompt-submit', 'codex:user-prompt-submit']) {
    const surface = SURFACES[key];
    const root = project();
    run(root, surface, fixtureNative(surface));
    const lines = hookLines(path.join(root, '.doflow'));
    assert.equal(lines.length, 1, `${key}: one line written`);
    assert.equal(lines[0].test_class, null, `${key}: test_class is null`);
    assert.deepEqual(Object.keys(lines[0]), LINE_KEYS, `${key}: keys match LINE_KEYS`);

    const offRoot = project();
    run(offRoot, surface, fixtureNative(surface), { env: { DOFLOW_TELEMETRY: 'off' } });
    assert.deepEqual(hookLines(path.join(offRoot, '.doflow')), [], `${key}: no line written when off`);
    assert.equal(fs.existsSync(telemetryDir(path.join(offRoot, '.doflow'))), false, `${key}: no telemetry dir`);
  }
});

test('identifiers that fail their rule are null: run local, a bad lineage, attempt 0, a session with a space', () => {
  const root = project();
  const surface = SURFACES['claude:pre-bash-guard'];
  const native = { ...fixtureNative(surface), session_id: 'has space', tool_use_id: 'toolu_088' };
  run(root, surface, native, { env: { DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: 'bad/lineage', DOFLOW_ATTEMPT: '0' } });
  const [line] = hookLines(path.join(root, '.doflow'));
  assert.deepEqual([line.run, line.lineage, line.attempt, line.session, line.tool_call_id], [null, null, null, null, 'toolu_088']);
});

test('an MCP tool name is never recorded as the tool (canary)', () => {
  const root = project();
  const surface = SURFACES['pi:pre-bash-guard'];
  run(root, surface, { ...fixtureNative(surface), toolName: 'mcp__canary088server__canary088tool' });
  const lines = hookLines(path.join(root, '.doflow'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tool, null);
  assert.ok(!JSON.stringify(lines).includes('canary088'));
});

const WORKER_RUN = 'w-0123456789ab';
const STRIP_KEYS = (source) => source
  .replace(/,\n\s*role:\(if \$ENV\.DOFLOW_SESSION_ROLE[^\n]*\),\n\s*worker_run:\([^\n]*\)\}\) catch/, '}) catch');

/** The role and worker_run assertions, shared by the production test and its negative control. */
function assertRoleAndWorkerRun(root) {
  const surface = SURFACES['claude:pre-bash-guard'];
  const config = path.join(root, '.doflow');
  run(root, surface, fixtureNative(surface), { env: { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKER_RUN: WORKER_RUN } });
  run(root, surface, fixtureNative(surface), { env: { DOFLOW_SESSION_ROLE: 'main' } });
  run(root, surface, fixtureNative(surface));
  const lines = hookLines(config);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => [line.role, line.worker_run]), [['worker', WORKER_RUN], ['main', null], [null, null]]);
  assert.deepEqual(Object.keys(lines[0]).slice(-4), ['role', 'worker_run', 'tool_duration_ms', 'test_class']);
}

test('role and worker_run are written when the env has them and are null otherwise', () => {
  assertRoleAndWorkerRun(project());
});

test('negative control: a tuple without the role and worker_run keys fails the role/worker_run test', () => {
  const root = project({ envelope: STRIP_KEYS });
  assert.throws(() => assertRoleAndWorkerRun(root), assert.AssertionError);
});

test('a role outside main|worker and a worker_run outside ^w-[0-9a-f]{12}$ are written as null', () => {
  const root = project();
  const surface = SURFACES['claude:pre-bash-guard'];
  const bad = ['W-0123456789AB', 'w-0123456789a', 'w-0123456789abc', 'w-0123456789ag', 'x-0123456789ab', 'free text', 'w-0123456789ab\n', '../etc/passwd'];
  for (const value of bad) run(root, surface, fixtureNative(surface), { env: { DOFLOW_SESSION_ROLE: 'intruder', DOFLOW_WORKER_RUN: value } });
  const lines = hookLines(path.join(root, '.doflow'));
  assert.equal(lines.length, bad.length);
  for (const line of lines) assert.deepEqual([line.role, line.worker_run], [null, null]);
  assert.ok(!JSON.stringify(lines).includes('intruder'));
});

test('telemetry off writes no file even with role and worker_run set', () => {
  const root = project();
  for (const surface of Object.values(SURFACES)) run(root, surface, fixtureNative(surface), { env: { DOFLOW_TELEMETRY: 'off', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKER_RUN: WORKER_RUN } });
  assert.equal(fs.existsSync(telemetryDir(path.join(root, '.doflow'))), false);
});

test('a deny is recorded as a deny on every pre-bash-guard harness', () => {
  const root = project();
  for (const surface of GUARDS) {
    const result = run(root, surface, commandNative(surface, 'rm -rf /'));
    assert.ok(denied(surface, result), `${surface.harness}: rm -rf / denied\n${result.stdout}${result.stderr}`);
    assert.equal(hookLines(path.join(root, '.doflow')).at(-1).verdict, 'deny', `${surface.harness}: verdict`);
  }
});

test('a surface outside the allowlist writes nothing', () => {
  const root = project();
  const config = path.join(root, '.doflow');
  const bridge = path.join(root, '.doflow/shared/hooks/bridge/bridge.sh');
  for (const [harness, event, policy] of [['claude', 'PreToolUse', 'mcp-tool-guard'], ['claude', 'PreToolUse', 'pre-implementation-gate'], ['gemini', 'BeforeTool', 'user-prompt-submit'], ['claude', 'Stop', 'pre-bash-guard'], ['opencode', 'PreToolUse', 'pre-bash-guard']]) {
    const result = spawnSync(BASH, [bridge, harness, event, policy], { cwd: root, input: '{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Bash","tool_input":{"command":"ls"}}\n', encoding: 'utf8', env: baseEnv(root, {}) });
    assert.equal(result.error, undefined);
    assert.deepEqual(hookLines(config), [], `${harness}:${event}:${policy} writes nothing`);
  }
  assert.equal(fs.existsSync(telemetryDir(config)), false, 'and creates no telemetry directory');
});

test('telemetry off writes nothing and creates nothing', () => {
  const root = project();
  for (const surface of Object.values(SURFACES)) run(root, surface, fixtureNative(surface), { env: { DOFLOW_TELEMETRY: 'off' } });
  assert.equal(fs.existsSync(telemetryDir(path.join(root, '.doflow'))), false);
});

test('no write without <config>/state, and no directory above runs/telemetry is created', () => {
  const surface = SURFACES['claude:pre-bash-guard'];
  const bare = project({ state: 'none' });
  run(bare, surface, fixtureNative(surface));
  assert.equal(fs.existsSync(path.join(bare, '.doflow/state')), false, 'no state directory');
  const stateOnly = project({ state: 'state' });
  run(stateOnly, surface, fixtureNative(surface));
  assert.deepEqual(fs.readdirSync(path.join(stateOnly, '.doflow/state')), [], 'no runs directory under state');
});

test('no store above cwd: the bridge returns 0 without treating /state as a config', (t) => {
  const cwd = tempDir(t, 'doflow-no-store-');
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    assert.equal(fs.existsSync(path.join(dir, '.doflow')), false, `${dir} has no .doflow store`);
    if (dir === path.dirname(dir)) break;
  }

  const marker = path.join(cwd, 'mkdir.log');
  const startup = path.join(cwd, 'bash-env');
  fs.writeFileSync(marker, '');
  fs.writeFileSync(startup, [
    '[() {',
    '  if [[ "$#" -eq 3 && "$1" == -d && "$2" == /state && "$3" == "]" ]]; then return 0; fi',
    '  builtin [ "$@"',
    '}',
    'mkdir() { printf "%s\\n" "$*" >> "$DOFLOW_TEST_MKDIR_LOG"; return 1; }',
    '',
  ].join('\n'));

  const bridgePath = path.join(REPO, 'core/harnesses/shared/hooks/bridge/bridge.sh');
  const result = spawnSync(BASH, [
    '-c', 'source "$2"; source "$1"; doflow_bridge_hook_line codex PreToolUse pre-bash-guard', 'bash', bridgePath, startup,
  ], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: '',
      XDG_CONFIG_HOME: '',
      PATH: process.env.PATH,
      DOFLOW_FAILURE_CAPTURE: 'off',
      DOFLOW_TEST_MKDIR_LOG: marker,
      DOFLOW_TELEMETRY: 'on',
      DF_TUPLE: '{"dft":1,"date":"2026-10-18","timestamp":"2026-10-18T00:00:00.000Z"}',
      DF_BRIDGE_OUTCOME: 'allow',
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(marker, 'utf8'), '', 'the bridge never attempts to create /state/runs/telemetry');
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['bash-env', 'mkdir.log'], 'the no-store call creates no files');
});

test('S1: a hook from a dispatch worktree writes one line to the project store only', () => {
  const root = project();
  const worktree = dispatchWorktree(root);
  run(root, SURFACES['codex:pre-bash-guard'], fixtureNative(SURFACES['codex:pre-bash-guard']), { cwd: worktree });
  assert.equal(hookLines(path.join(root, '.doflow')).length, 1, 'the project gets one line');
  assert.deepEqual(hookLines(path.join(worktree, '.doflow')), [], 'the worktree gets no line');
  assert.equal(fs.existsSync(path.join(worktree, '.doflow/state/runs')), false, 'the worktree gets no state/runs');
});

test('S2: an old worktree state/runs fragment does not shadow the project store', () => {
  const root = project();
  const worktree = dispatchWorktree(root);
  fs.mkdirSync(path.join(worktree, '.doflow/state/runs'), { recursive: true });
  run(root, SURFACES['codex:pre-bash-guard'], fixtureNative(SURFACES['codex:pre-bash-guard']), { cwd: worktree });
  assert.equal(hookLines(path.join(root, '.doflow')).length, 1, 'the project gets one line');
  assert.deepEqual(hookLines(path.join(worktree, '.doflow')), [], 'the old fragment gets no line');
  assert.equal(fs.existsSync(telemetryDir(path.join(worktree, '.doflow'))), false, 'the old fragment gets no telemetry directory');
});

test('C1: telemetry off writes nothing in the project or worktree store', () => {
  const root = project();
  const worktree = dispatchWorktree(root);
  run(root, SURFACES['codex:pre-bash-guard'], fixtureNative(SURFACES['codex:pre-bash-guard']), {
    cwd: worktree, env: { DOFLOW_TELEMETRY: 'off' },
  });
  assert.deepEqual(hookLines(path.join(root, '.doflow')), [], 'the project gets no line');
  assert.deepEqual(hookLines(path.join(worktree, '.doflow')), [], 'the worktree gets no line');
  assert.equal(fs.existsSync(telemetryDir(path.join(root, '.doflow'))), false, 'the project gets no telemetry directory');
  assert.equal(fs.existsSync(telemetryDir(path.join(worktree, '.doflow'))), false, 'the worktree gets no telemetry directory');
});

test('C2: a flat project without runs does not fall through to the HOME store', () => {
  const root = project({ state: 'state' });
  const home = scratch.path(`flat-home-${homes += 1}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, '.doflow/state/runs'), { recursive: true });
  const surface = SURFACES['codex:pre-bash-guard'];
  run(root, surface, fixtureNative(surface), {
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  });
  assert.deepEqual(hookLines(path.join(root, '.doflow')), [], 'the flat project gets no line');
  assert.deepEqual(hookLines(path.join(home, '.doflow')), [], 'HOME gets no line');
  assert.equal(fs.existsSync(path.join(root, '.doflow/state/runs')), false, 'the project does not gain runs');
  assert.equal(fs.existsSync(telemetryDir(path.join(home, '.doflow'))), false, 'HOME gets no telemetry directory');
});

test('a linked worktree subdirectory writes to the store of the checkout it lives in; DOFLOW_CONFIG_DIR wins', () => {
  const root = project();
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
  };
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git('init', '-q', '-b', 'main');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'a');
  git('worktree', 'add', '-q', '-b', 'wt', 'tmp/wt');
  const sub = path.join(root, 'tmp/wt/sub');
  fs.mkdirSync(sub);
  const surface = SURFACES['pi:pre-bash-guard'];
  run(root, surface, fixtureNative(surface));
  run(root, surface, fixtureNative(surface), { cwd: sub });
  assert.equal(hookLines(path.join(root, '.doflow')).length, 2, 'main checkout and worktree share one store');
  assert.equal(fs.existsSync(path.join(root, 'tmp/wt/.doflow')), false, 'nothing is created in the worktree');
  const other = scratch.path(`config-${projects}`);
  fs.mkdirSync(path.join(other, 'state/runs'), { recursive: true });
  run(root, surface, fixtureNative(surface), { cwd: sub, env: { DOFLOW_CONFIG_DIR: other } });
  assert.equal(hookLines(other).length, 1, 'DOFLOW_CONFIG_DIR store');
  assert.equal(hookLines(path.join(root, '.doflow')).length, 2);
});

test('duration_ms is null on bash < 5 even when EPOCHREALTIME comes from the environment', () => {
  const version = Number(spawnSync(BASH, ['-c', 'printf %s "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }).stdout);
  const root = project();
  const surface = SURFACES['claude:pre-bash-guard'];
  run(root, surface, fixtureNative(surface), { env: { EPOCHREALTIME: '1700000000.000000' } });
  const [line] = hookLines(path.join(root, '.doflow'));
  if (version < 5) assert.equal(line.duration_ms, null);
  else assert.ok(Number.isInteger(line.duration_ms) && line.duration_ms >= 0);
});

/** Every fault the store can show: a FIFO, a directory or nothing writable where the line goes. */
function faultedProjects() {
  const fifo = project();
  fs.mkdirSync(telemetryDir(path.join(fifo, '.doflow')));
  for (const date of utcDates()) assert.equal(spawnSync('mkfifo', [path.join(telemetryDir(path.join(fifo, '.doflow')), `${date}.jsonl`)]).status, 0);
  const directory = project();
  for (const date of utcDates()) fs.mkdirSync(path.join(telemetryDir(path.join(directory, '.doflow')), `${date}.jsonl`), { recursive: true });
  const unwritable = project();
  fs.mkdirSync(telemetryDir(path.join(unwritable, '.doflow')));
  fs.chmodSync(telemetryDir(path.join(unwritable, '.doflow')), 0o500);
  const unwritableRuns = project();
  fs.chmodSync(path.join(unwritableRuns, '.doflow/state/runs'), 0o500);
  const tupleFault = project({ envelope: (source) => source.replace(INJECT_FROM, INJECT_TO) });
  return { fifo, directory, unwritable, unwritableRuns, tupleFault };
}

test('stdout, stderr and exit are byte-equal with telemetry on, off and faulted, and no fault blocks', () => {
  const on = project();
  const faulted = faultedProjects();
  try {
    for (const surface of Object.values(SURFACES)) {
      const natives = surface.policy === 'pre-bash-guard'
        ? [['allow', commandNative(surface, 'printf safe')], ['deny', commandNative(surface, 'rm -rf /')]]
        : [['prompt', fixtureNative(surface)]];
      for (const [kind, native] of natives) {
        const label = `${surface.harness}/${surface.policy}/${kind}`;
        const expected = run(on, surface, native, { env: { DOFLOW_TELEMETRY: 'off' } });
        assert.deepEqual(run(on, surface, native), expected, `${label}: on`);
        for (const [name, root] of Object.entries(faulted)) {
          const started = Date.now();
          assert.deepEqual(run(root, surface, native), expected, `${label}: ${name}`);
          assert.ok(Date.now() - started < 15000, `${label}: ${name} does not block`);
        }
      }
    }
  } finally {
    fs.chmodSync(telemetryDir(path.join(faulted.unwritable, '.doflow')), 0o700);
    fs.chmodSync(path.join(faulted.unwritableRuns, '.doflow/state/runs'), 0o700);
  }
  assert.equal(hookLines(path.join(faulted.tupleFault, '.doflow')).length, 0, 'a caught tuple fault writes no line');
  assert.ok(hookLines(path.join(on, '.doflow')).length > 0);
});

test('an injected encode-tuple fault still denies rm -rf / on every pre-bash-guard harness, under compat-1 and strict-1', () => {
  const root = project({ envelope: (source) => source.replace(INJECT_FROM, INJECT_TO) });
  for (const surface of GUARDS) {
    for (const profile of ['compat-1', 'strict-1']) {
      const result = run(root, surface, commandNative(surface, 'rm -rf /'), { env: { DOFLOW_FAULT_PROFILE: profile } });
      assert.ok(denied(surface, result), `${surface.harness}/${profile}: rm -rf / still denied\n${result.stdout}${result.stderr}`);
    }
  }
});

test('negative control: the same fault without the try wrapper switches the guard off under compat-1', () => {
  const root = project({
    envelope: (source) => {
      assert.ok(source.includes('[try (') && source.includes(') catch {dft:1}]'), 'the production tuple is try-wrapped');
      return source.replace(INJECT_FROM, INJECT_TO).replace('[try (', '[(').replace(') catch {dft:1}]', ')]');
    },
  });
  const surface = SURFACES['claude:pre-bash-guard'];
  const result = run(root, surface, commandNative(surface, 'rm -rf /'));
  assert.equal(denied(surface, result), false, 'an uncaught telemetry fault is a guard bypass; the try is what prevents it');
});
