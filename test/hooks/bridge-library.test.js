'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE = path.join(ROOT, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const JQ = spawnSync('jq', ['--version']);
const BRIDGE_TEST = JQ.status === 0 ? test : test.skip;
const POLICIES = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-context', 'stop-check', 'user-prompt-submit', 'subagent-audit'];

function makeTree(policyBody) {
  const dir = suiteTempDir('doflow-bridge-library-');
  fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'policies'), { recursive: true });
  for (const file of ['bridge.sh', 'envelope.jq', 'respond.sh']) fs.copyFileSync(path.join(ROOT, 'core/harnesses/shared/hooks/bridge', file), path.join(dir, 'bridge', file));
  for (const file of ['deny-json.sh', 'capture-failure.sh']) fs.copyFileSync(path.join(ROOT, 'core/harnesses/shared/hooks/policies', file), path.join(dir, 'policies', file));
  for (const id of POLICIES) {
    fs.writeFileSync(path.join(dir, 'policies', `${id}.sh`), policyBody || `#!/bin/bash\nprintf '\\036%s\\n' '{"v":1,"policy":"${id}","policyVersion":1,"outcome":"allow","code":"allow"}' >&3\nexit 0\n`);
    fs.chmodSync(path.join(dir, 'policies', `${id}.sh`), 0o755);
  }
  return dir;
}

function run(dir, harness, event, policy, input, args = [], env = {}) {
  return spawnSync('bash', [path.join(dir, 'bridge/bridge.sh'), harness, event, policy, ...args], {
    cwd: dir, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, DOFLOW_FAILURE_CAPTURE: 'off', ...env },
  });
}

BRIDGE_TEST('envelope decoder maps committed native fixture shapes and omits unknown fields', () => {
  const dir = makeTree();
  const cases = [
    // Native payload names are evidenced by test/hooks/kiro-bridge.test.js.
    ['claude', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, session_id: 's', cwd: '/repo' }, 'edit', 'src/a.ts'],
    ['codex', 'PreToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n' } }, 'edit', null],
    ['gemini', 'BeforeTool', { tool_name: 'write_file', tool_input: { path: '/repo/a' } }, 'edit', '/repo/a'],
    ['kiro', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/repo/a' }, session_id: 'k' }, 'edit', '/repo/a'],
    // Antigravity's native toolCall is covered by test/hooks/stream-hook-runner.test.js and
    // adapters/antigravity.test.js; Pi call fields are pinned by IC-004 types fixtures.
    ['antigravity', 'PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/a' } }, workspacePaths: ['/repo'], cwd: '/ignored' }, 'edit', '/repo/a'],
    ['pi', 'tool_call', { toolName: 'edit', input: { path: '/repo/a' }, sessionId: 'pi-s', toolCallId: 'c1', parentToolCallId: 'c0' }, 'edit', '/repo/a'],
  ];
  for (const [harness, event, native, operation, expectedPath] of cases) {
    const decoded = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', 'session-context', '-f', path.join(dir, 'bridge/envelope.jq')], { input: JSON.stringify(native), encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const value = JSON.parse(decoded.stdout).doflow_event;
    assert.equal(value.version, 1, harness);
    assert.equal(value.operation, operation, harness);
    if (expectedPath) assert.deepEqual(value.paths, [expectedPath], harness);
    assert.equal('projectRoot' in value, false, harness);
    assert.equal('cwd' in value, false, harness);
    assert.equal('unknown' in value, false, harness);
    if (harness === 'codex') assert.equal(value.patch, '*** Begin Patch\n');
  }
});

BRIDGE_TEST('bridge encodes native input once and passes the merged payload to its policy', () => {
  const dir = makeTree('#!/bin/bash\ncat > "$CAPTURE_INPUT_PATH"\nexit 0\n');
  const capture = path.join(dir, 'captured.json');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'jq-calls');
  const realJq = spawnSync('which', ['jq'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'jq'), `#!/bin/bash\nprintf 'jq\\n' >> '${calls}'\nexec '${realJq}' "$@"\n`);
  fs.chmodSync(path.join(bin, 'jq'), 0o755);
  const result = run(dir, 'claude', 'PreToolUse', 'session-context', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, cwd: '/not-project', custom_native: true }, [], { PATH: `${bin}:${process.env.PATH}`, CAPTURE_INPUT_PATH: capture });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'one jq process for an allow');
  const payload = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(payload.custom_native, true);
  assert.equal(payload.doflow_event.version, 1);
  assert.equal(payload.doflow_event.projectRoot, undefined);
  assert.equal(payload.doflow_event.identity, undefined);
  assert.equal(payload.doflow_event.paths[0], 'src/a.ts');
});

BRIDGE_TEST('non-object stdin passes through unchanged and captures envelope-encode', () => {
  const dir = makeTree('#!/bin/bash\ncat > "$CAPTURE_INPUT_PATH"\nexit 0\n');
  const capture = path.join(dir, 'captured.json');
  const xdg = path.join(dir, 'xdg');
  const result = run(dir, 'claude', 'PreToolUse', 'session-context', '17', [], {
    CAPTURE_INPUT_PATH: capture, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'on',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), '17');
  const failure = fs.readFileSync(path.join(xdg, 'doflow/failures/events.jsonl'), 'utf8');
  assert.match(failure, /"kind":"envelope-encode"/);
});

BRIDGE_TEST('classification handles deny, unmarked exit 2, mismatch and syntax error before init', () => {
  const dir = makeTree(`#!/bin/bash\n${'\n'}printf '%s' >&2\nexit 2\n`);
  const p = path.join(dir, 'policies/pre-implementation-gate.sh');
  fs.writeFileSync(p, '#!/bin/bash\nprintf \'\\036%s\\n\' \'{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"deny","code":"blocked"}\' >&3\nprintf denied >&2\nexit 2\n');
  fs.chmodSync(p, 0o755);
  let result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {} , ['--emit', 'decision']);
  let decision = JSON.parse(result.stdout);
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason, 'denied');
  fs.writeFileSync(p, '#!/bin/bash\nexit 2\n');
  result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  assert.equal(JSON.parse(result.stdout).code, 'exit-2-unmarked');
  fs.writeFileSync(p, '#!/bin/bash\nexit 0\n');
  result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  assert.equal(JSON.parse(result.stdout).code, 'allow');
  fs.writeFileSync(p, '#!/bin/bash\nthis is not valid syntax (\n');
  result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  assert.equal(JSON.parse(result.stdout).code, 'exit-2-unmarked');
});

BRIDGE_TEST('compat-1 and strict-1 effects, fixed error reason, and native rendering', () => {
  const dir = makeTree('#!/bin/bash\nprintf raw-secret >&2\nexit 9\n');
  let r = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  let d = JSON.parse(r.stdout);
  assert.equal(d.effect, 'block');
  assert.equal(d.reason, '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list');
  assert.equal(JSON.stringify(d).includes('raw-secret'), false);
  r = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision'], { DOFLOW_FAULT_PROFILE: 'strict-1' });
  assert.equal(JSON.parse(r.stdout).effect, 'block');
  r = run(dir, 'claude', 'PreToolUse', 'session-context', {}, ['--emit', 'decision'], { DOFLOW_FAULT_PROFILE: 'strict-1' });
  assert.equal(JSON.parse(r.stdout).effect, 'proceed');
  const recordedFault = makeTree(`#!/bin/bash\nprintf '\\036%s\\n' '{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"error","code":"dependency-missing:jq"}' >&3\nexit 0\n`);
  r = run(recordedFault, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  assert.equal(JSON.parse(r.stdout).effect, 'proceed');
  r = run(recordedFault, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision'], { DOFLOW_FAULT_PROFILE: 'strict-1' });
  assert.equal(JSON.parse(r.stdout).effect, 'block');
  const deny = makeTree(`#!/bin/bash\nprintf '\\036%s\\n' '{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"deny","code":"blocked"}' >&3\nprintf reason >&2\nexit 2\n`);
  r = run(deny, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'native']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, 'reason');
});

BRIDGE_TEST('sourced form is safe under errexit and trace is opt-in; executable decision form works', () => {
  const dir = makeTree();
  const sourced = spawnSync('bash', ['-euo', 'pipefail', '-c', `. "${path.join(dir, 'bridge/bridge.sh')}"; declare -F doflow_bridge >/dev/null`], { encoding: 'utf8' });
  assert.equal(sourced.status, 0, sourced.stderr);
  const trace = path.join(dir, 'trace.jsonl');
  run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
  assert.equal(fs.existsSync(trace), false);
  const executed = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision'], { DOFLOW_BRIDGE_TRACE: trace });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8')).policy, 'pre-implementation-gate');
});
