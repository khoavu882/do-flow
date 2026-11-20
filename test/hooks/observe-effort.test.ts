'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Row 180 IC-180-E1 (K2 a, b, e, g): the shared bridge step `observe-effort` records the main session's hook-payload
// effort level in <config home>/doflow/session-env/effort/<sessionKey>.json, never changes the bridge's output or exit
// code, and the Claude SessionEnd hook removes only the ending session's file. Fake payloads and scratch homes only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const BRIDGE_DIR = path.join(REPO, 'core/harnesses/shared/hooks/bridge');
const BRIDGE = path.join(BRIDGE_DIR, 'bridge.sh');
const POLICY = 'mcp-tool-guard';
const POSIX = process.platform !== 'win32';
const SESSION = 'main-session-0001';
const sessionKey = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
const payload = (level: any, extra: any = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SESSION, cwd: '', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'ls' },
  ...(level === null ? {} : { effort: { level } }), ...extra,
});

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-observe-effort-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const store = path.join(home, '.config', 'doflow', 'session-env');
  return { dir, home, cwd, store, file: path.join(store, 'effort', `${sessionKey(SESSION)}.json`) };
}

const baseEnv = (s: any) => {
  const env: any = { ...process.env, HOME: s.home, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '' };
  for (const name of ['XDG_CONFIG_HOME', 'DOFLOW_SESSION_ROLE', 'DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_WORKTREE', 'DOFLOW_TASK_ID', 'DOFLOW_CONFIG_DIR']) delete env[name];
  return env;
};

function bridge(s: any, native: any, { harness = 'claude', event = native.hook_event_name, env = {} }: any = {}) {
  const result = spawnSync(bashPath(), [BRIDGE, harness, event, POLICY], { cwd: s.cwd, env: { ...baseEnv(s), ...env }, input: JSON.stringify(native), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function files(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}
const effortFiles = (s: any) => files(path.join(s.store, 'effort'));

test('(a) a main-session payload with effort.level writes the exact six keys, mode 0600; the same level writes nothing; a new level rewrites', (t) => {
  const s = scratch(t);
  assert.equal(bridge(s, payload('xhigh')).status, 0);
  assert.deepEqual(effortFiles(s), [path.basename(s.file)]);
  const value = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.deepEqual(Object.keys(value), ['schema', 'harness', 'level', 'event', 'observedAt', 'session']);
  assert.deepEqual({ ...value, observedAt: 'x' }, { schema: 1, harness: 'claude', level: 'xhigh', event: 'PreToolUse', observedAt: 'x', session: sessionKey(SESSION) });
  assert.match(value.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(value.observedAt) - Date.now()) < 120000);
  if (POSIX) assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);

  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(s.file, past, past);
  const before = fs.readFileSync(s.file, 'utf8');
  bridge(s, payload('xhigh', { hook_event_name: 'Stop', tool_name: undefined }));
  assert.equal(fs.statSync(s.file).mtimeMs, past.getTime(), 'the same level is not rewritten');
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);

  bridge(s, payload('high', { hook_event_name: 'Stop', tool_name: undefined }));
  const next = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(next.level, 'high');
  assert.equal(next.event, 'Stop');
  assert.deepEqual(effortFiles(s), [path.basename(s.file)], 'no tmp file is left behind');
});

test('(b) a subagent payload, a Subagent event, a worker role, no config home, another harness or a malformed level writes nothing', (t) => {
  const cases: Array<[string, any, any]> = [
    ['agent_id set', payload('max', { agent_id: 'sub-1', agent_type: 'Explore' }), {}],
    ['SubagentStop', payload('max', { hook_event_name: 'SubagentStop', tool_name: undefined }), {}],
    ['worker role', payload('max'), { env: { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'lin', DOFLOW_ATTEMPT: '1' } }],
    ['any other role', payload('max'), { env: { DOFLOW_SESSION_ROLE: 'reviewer' } }],
    ['no config home', payload('max'), { env: { HOME: '' } }],
    ['codex payload', payload('max'), { harness: 'codex' }],
    ['malformed level', payload('high; rm -rf /'), {}],
    ['level not a string', payload(3), {}],
    ['no session id', payload('max', { session_id: undefined }), {}],
  ];
  for (const [label, native, options] of cases) {
    const s = scratch(t);
    assert.equal(bridge(s, native, options).status, 0, label);
    assert.deepEqual(files(s.store).filter((f) => f.startsWith('effort')), [], label);
  }
});

test('(b) a link in place of the file is never followed or replaced', { skip: !POSIX }, (t) => {
  const s = scratch(t);
  const target = path.join(s.dir, 'target.json');
  fs.writeFileSync(target, 'x');
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.symlinkSync(target, s.file);
  assert.equal(bridge(s, payload('xhigh')).status, 0);
  assert.equal(fs.lstatSync(s.file).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
});

test('the step changes no stream and no exit code: with and without effort, and with a read-only store', { skip: !POSIX }, (t) => {
  const plain = bridge(scratch(t), payload(null));
  const s = scratch(t);
  assert.deepEqual(bridge(s, payload('xhigh')), plain);
  assert.equal(effortFiles(s).length, 1);
  const locked = scratch(t);
  fs.mkdirSync(locked.store, { recursive: true });
  fs.chmodSync(locked.store, 0o500); // tempDir's removal restores owner write permission
  assert.deepEqual(bridge(locked, payload('xhigh')), plain);
  assert.deepEqual(files(locked.store), []);
});

test('(e) the Claude SessionEnd hook removes only the ending session\'s effort file', { skip: !POSIX }, (t) => {
  const mirror = buildInstallMirror(path.join(suiteTempDir('doflow-observe-effort-mirror-'), 'm'));
  const s = scratch(t);
  const cwd = fs.realpathSync(s.cwd);
  const record = (id: string) => {
    const file = path.join(s.store, 'effort', `${sessionKey(id)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 1, harness: 'claude', level: 'high', event: 'Stop', observedAt: '2026-11-20T00:00:00Z', session: sessionKey(id) })}\n`);
    return file;
  };
  const ending = record('ending-session');
  const other = record('other-session');
  const end = (session: string, env: any = {}) => spawnSync(bashPath(), [path.join(mirror, '.claude/hooks/session-end.sh')], {
    cwd, input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: session, cwd }),
    env: { PATH: process.env.PATH, HOME: s.home, DOFLOW_TELEMETRY: 'off', ...env }, encoding: 'utf8',
  });
  const result = end('ending-session');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(ending), false, 'the ending session\'s file is gone');
  assert.equal(fs.existsSync(other), true, 'another session\'s file is kept');
  const link = path.join(s.store, 'effort', `${sessionKey('linked')}.json`);
  const target = path.join(s.dir, 'linked-target.json');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, link);
  assert.equal(end('linked').status, 0);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a link is never removed');
});

test('(g) the step finishes under 20 ms over a no-op baseline: median of 20 runs, steady state and write path, each less an interleaved no-op run of the same function', { skip: !POSIX }, (t) => {
  // The baseline is the step's fixed process starts (bash and jq); the 20 ms bar limits DoFlow's own work above them.
  const s = scratch(t);
  const encode = (level: string) => {
    const out = spawnSync('jq', ['-c', '--arg', 'harness', 'claude', '--arg', 'event', 'PreToolUse', '--arg', 'policy', POLICY, '--arg', 'mode', 'encode', '-f', path.join(BRIDGE_DIR, 'envelope.jq')],
      { input: JSON.stringify(payload(level)), encoding: 'utf8', env: { ...baseEnv(s) } });
    return out.stdout.trim().split('\n').pop() as string;
  };
  const envelopes = { high: encode('high'), xhigh: encode('xhigh') };
  const env = baseEnv(s);
  const timed = (args: string[]) => {
    const started = process.hrtime.bigint();
    const result = spawnSync(bashPath(), args, { cwd: s.cwd, env });
    assert.equal(result.status, 0);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const invoke = (harness: string, envelope: string) => timed(['-c', `( . "$1/observe-effort.sh" && doflow_observe_effort "$2" "$3"${harness === '' ? '; jq -n . >/dev/null' : ''} ) >/dev/null 2>&1 </dev/null || true`, '_', BRIDGE_DIR, harness, envelope]);
  const step = (envelope: string) => ({ base: invoke('', envelope), step: invoke('claude', envelope) });
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[9] + sorted[10]) / 2; };
  step(envelopes.high);
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).level, 'high');
  const steadyRuns = Array.from({ length: 20 }, () => step(envelopes.high));
  const writeRuns = Array.from({ length: 20 }, (_, i) => step(i % 2 === 0 ? envelopes.xhigh : envelopes.high));
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).level, 'high', 'the write runs alternated the level, ending on high');
  const steady = median(steadyRuns.map((r) => r.step));
  const steadyBase = median(steadyRuns.map((r) => r.base));
  const writes = median(writeRuns.map((r) => r.step));
  const writesBase = median(writeRuns.map((r) => r.base));
  t.diagnostic(`observe-effort median of 20 (step vs no-op baseline): steady ${steady.toFixed(2)} ms vs baseline ${steadyBase.toFixed(2)} ms, write ${writes.toFixed(2)} ms vs baseline ${writesBase.toFixed(2)} ms`);
  assert.ok(steady - steadyBase < 20, `steady-state median ${steady} ms, baseline ${steadyBase} ms`);
  assert.ok(writes - writesBase < 20, `write-path median ${writes} ms, baseline ${writesBase} ms`);
});
