'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('../helper/tmp');
const { buildInstallMirror } = require('../helper/hook-fixtures');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE_SOURCE = path.join(ROOT, 'core/harnesses/shared/hooks/bridge');
const POLICY_SOURCE = path.join(ROOT, 'core/harnesses/shared/hooks/policies');
const POLICIES = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-context', 'stop-check', 'user-prompt-submit', 'subagent-audit'];
const BLOCKING = new Set(['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check']);
const REASON = '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list';

function bridgeTree(t) {
  const root = tempDir(t, 'doflow-fault-taxonomy-');
  fs.cpSync(BRIDGE_SOURCE, path.join(root, 'bridge'), { recursive: true });
  fs.cpSync(POLICY_SOURCE, path.join(root, 'policies'), { recursive: true });
  return root;
}

function installPolicy(root, policy, body) {
  const file = path.join(root, 'policies', `${policy}.sh`);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function runBridge(root, harness, event, policy, profile, { input = {}, env = {}, args = ['--emit', 'decision'] } = {}) {
  const xdg = path.join(root, `xdg-${harness}-${profile}`);
  const result = spawnSync('bash', [path.join(root, 'bridge/bridge.sh'), harness, event, policy, ...args], {
    cwd: root,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg, HOME: path.join(root, 'home'), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: profile, ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, xdg };
}

function diagnosticKinds(result) {
  const file = path.join(result.xdg, 'doflow/failures/events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind) : [];
}

function faultPolicy(fault, policy, root) {
  if (fault === 'crash-exit-1') return '#!/bin/bash\nexit 1\n';
  if (fault === 'exit-127') return '#!/bin/bash\nexit 127\n';
  if (fault === 'syntax-error') return '#!/bin/bash\nif then\n';
  if (fault === 'recorded-error') return `#!/bin/bash\n. ${JSON.stringify(path.join(root, 'policies/capture-failure.sh'))}\ndoflow_capture_failure ${policy} dependency-missing:jq\nprintf '\\036%s\\n' '{"v":1,"policy":"${policy}","policyVersion":1,"outcome":"error","code":"dependency-missing:jq"}' >&3\nexit 0\n`;
  if (fault === 'config-missing') return `#!/bin/bash\n. ${JSON.stringify(path.join(root, 'policies/capture-failure.sh'))}\ndoflow_capture_failure ${policy} patterns-missing\nprintf '\\036%s\\n' '{"v":1,"policy":"${policy}","policyVersion":1,"outcome":"error","code":"patterns-missing"}' >&3\nexit 0\n`;
  if (fault === 'recorded-unsupported') return `#!/bin/bash\n. ${JSON.stringify(path.join(root, 'policies/capture-failure.sh'))}\ndoflow_capture_failure ${policy} unsupported:envelope-version\nprintf '\\036%s\\n' '{"v":1,"policy":"${policy}","policyVersion":1,"outcome":"unsupported","code":"unsupported:envelope-version"}' >&3\nexit 0\n`;
  if (fault === 'edit-without-target') return `#!/bin/bash\n. ${JSON.stringify(path.join(root, 'policies/capture-failure.sh'))}\ndoflow_capture_failure ${policy} edit-without-target\nprintf '\\036%s\\n' '{"v":1,"policy":"${policy}","policyVersion":1,"outcome":"unsupported","code":"edit-without-target"}' >&3\nexit 0\n`;
  if (fault === 'allow') return '#!/bin/bash\nexit 0\n';
  return '#!/bin/bash\nexit 0\n';
}

const bridgeRows = [
  ['claude', 'PreToolUse', 'pre-implementation-gate'],
  ['codex', 'PreToolUse', 'pre-implementation-gate'],
  ['gemini', 'BeforeTool', 'pre-implementation-gate'],
  ['kiro', 'PreToolUse', 'pre-implementation-gate'],
  ['antigravity', 'PreToolUse', 'pre-implementation-gate'],
  ['pi', 'tool_call', 'pre-implementation-gate'],
];

// Installed front doors resolve the shared bridge from a relative path, so fault
// cases must exercise the same projected tree used by an actual installation.
const shellDoors = [
  ['claude', '.claude/hooks/pre-implement-gate.sh', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }],
  ['codex', '.codex/hooks/pre-implement-gate.sh', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }],
  ['gemini', '.gemini/hooks/pre-implement-gate.sh', { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: 'src/a.js' } }],
  ['kiro', '.kiro/hooks/pre-implement-gate.sh', { hook_event_name: 'PreToolUse', toolName: 'Write', input: { path: 'src/a.js' } }],
];

function runInstalledDoor(t, harness, hook, input, profile, policyBody, policy = 'pre-implementation-gate') {
  const root = tempDir(t, `doflow-installed-${harness}-`);
  buildInstallMirror(root);
  const policyPath = path.join(root, '.doflow/shared/hooks/policies', `${policy}.sh`);
  if (policyBody === null) fs.unlinkSync(policyPath);
  else {
    fs.writeFileSync(policyPath, policyBody);
    fs.chmodSync(policyPath, 0o755);
  }
  const xdg = path.join(root, `xdg-${profile}`);
  const result = spawnSync('bash', [path.join(root, hook)], {
    cwd: root, input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: xdg,
      DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: profile, DOFLOW_PROJECT_DIR: root },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, xdg };
}

function failureKinds(result) {
  const file = path.join(result.xdg, 'doflow/failures/events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind) : [];
}

function runPolicyDirect(root, policy, input, { pathValue = process.env.PATH, env = {} } = {}) {
  const policyPath = path.join(root, 'policies', `${policy}.sh`);
  const child = spawnSync('bash', [policyPath], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: pathValue, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
      DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_DECISION_FD: '3', DOFLOW_AGENT: 'claude', ...env },
  });
  assert.equal(child.error, undefined, child.error?.message);
  return { ...child, xdg: path.join(root, 'xdg'), records: (child.output[3] || Buffer.from('')).toString('utf8') };
}

function pathWithoutJq(t) {
  const bin = path.join(tempDir(t, 'doflow-no-jq-'), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const command of ['bash', 'tr', 'mkdir', 'dirname', 'sed', 'head', 'date', 'pwd']) {
    const candidate = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
      .map((dir) => path.join(dir, command)).find((file) => fs.existsSync(file));
    assert.ok(candidate, `system command exists: ${command}`);
    fs.symlinkSync(candidate, path.join(bin, command));
  }
  return bin;
}

test('IC-011 fault taxonomy follows both profiles on all six bridge identities', (t) => {
  const cases = [
    ['crash exit 1', 'crash-exit-1', 'eval-error:exit-1'],
    ['exit 127', 'exit-127', 'eval-error:exit-127'],
    ['syntax error exit 2', 'syntax-error', 'eval-error:exit-2-unmarked'],
    ['bridge spawn failure', 'missing-policy', 'bridge-spawn'],
    ['jq missing recorded by policy', 'recorded-error', 'dependency-missing:jq'],
    ['config missing recorded by policy', 'config-missing', 'patterns-missing'],
    ['unknown envelope version', 'recorded-unsupported', 'unsupported:envelope-version'],
    ['edit without target', 'edit-without-target', 'edit-without-target'],
  ];
  for (const [harness, event, policy] of bridgeRows) {
    for (const profile of ['compat-1', 'strict-1']) {
      for (const [label, fault, point] of cases) {
        t.test(`${harness} ${profile}: ${label}`, (subtest) => {
          const root = bridgeTree(subtest);
          if (fault === 'missing-policy') fs.unlinkSync(path.join(root, 'policies', `${policy}.sh`));
          else installPolicy(root, policy, faultPolicy(fault, policy, root));
          const input = fault === 'recorded-unsupported'
            ? { doflow_event: { version: 2, harness, event, operation: 'edit' } }
            : fault === 'edit-without-target'
              ? { doflow_event: { version: 1, harness, event, operation: 'edit' } }
              : {};
          const result = runBridge(root, harness, event, policy, profile, { input });
          const decision = JSON.parse(result.stdout.trim());
          let compatEffect = 'proceed';
          if (fault === 'missing-policy') compatEffect = 'proceed';
          else if (fault === 'crash-exit-1' || fault === 'exit-127') {
            if (['claude', 'codex', 'gemini', 'antigravity', 'pi'].includes(harness)) compatEffect = 'block';
          } else if (fault === 'syntax-error') compatEffect = 'block';
          const expectedEffect = profile === 'strict-1' && BLOCKING.has(policy) ? 'block' : compatEffect;
          assert.equal(decision.effect, expectedEffect, 'IC-011 fault effect');
          assert.equal(decision.faultProfile, profile);
          assert.deepEqual(diagnosticKinds(result), [point], 'IC-008 diagnostic point is captured once');
          assert.equal(decision.reason, decision.code, 'fault reason is not model-visible policy stderr');
        });
      }
    }
  }
});

test('installed shell front doors apply IC-011 to real bridge faults', (t) => {
  const faultCases = [
    ['crash exit 1', '#!/bin/bash\nexit 1\n', 'block'],
    ['exit 127', '#!/bin/bash\nexit 127\n', 'block'],
    ['syntax error', '#!/bin/bash\nif then\n', 'block'],
    ['policy spawn fault', null, 'proceed'],
  ];
  for (const [harness, hook, input] of shellDoors) {
    for (const profile of ['compat-1', 'strict-1']) {
      for (const [label, body, compatEffect] of faultCases) {
        t.test(`${harness} installed door ${profile}: ${label}`, (st) => {
          const result = runInstalledDoor(st, harness, hook, input, profile, body);
          const shouldBlock = (profile === 'strict-1') || compatEffect === 'block';
          const kiroPassThrough = harness === 'kiro' && profile === 'compat-1' && body && body !== '#!/bin/bash\nif then\n';
          const expectedStatus = harness === 'kiro' && shouldBlock ? (kiroPassThrough ? (label === 'exit 127' ? 127 : 1) : 2) : 0;
          assert.equal(result.status, expectedStatus,
            `${harness} native exit communicates ${shouldBlock ? 'block' : 'proceed'}`);
          if (shouldBlock) assert.match(`${result.stdout}${result.stderr}`, /DoFlow policy error/);
          else assert.equal(result.stdout, '', 'non-blocking gate front door is silent');
          if (body === null) assert.deepEqual(failureKinds(result), ['bridge-spawn']);
          else assert.deepEqual(failureKinds(result), [`eval-error:${label === 'syntax error' ? 'exit-2-unmarked' : label === 'exit 127' ? 'exit-127' : 'exit-1'}`]);
        });
      }
    }
  }
});

test('installed front doors exercise every blocking policy and native Stop fault row', (t) => {
  const blockingDoors = [
    ...shellDoors.flatMap(([harness]) => {
      const hookRoot = `.${harness}/hooks/`;
      const inputFor = (tool) => harness === 'gemini'
        ? { hook_event_name: 'BeforeTool', tool_name: tool === 'Bash' ? 'run_shell_command' : tool === 'MCP' ? 'mcp_search' : 'write_file', tool_input: { command: 'echo ok', file_path: 'src/a.js' } }
        : harness === 'kiro'
          ? { hook_event_name: 'PreToolUse', toolName: tool === 'Bash' ? 'Shell' : tool === 'MCP' ? 'MCP' : 'Write', input: { command: 'echo ok', path: 'src/a.js' } }
          : { hook_event_name: 'PreToolUse', tool_name: tool === 'Bash' ? 'Bash' : tool === 'MCP' ? 'mcp__test__search' : 'Edit', tool_input: { command: 'echo ok', file_path: 'src/a.js' } };
      return [
        ['pre-implementation-gate', `${hookRoot}pre-implement-gate.sh`, inputFor('Edit')],
        ['pre-bash-guard', `${hookRoot}pre-bash-guard.sh`, inputFor('Bash')],
        ['mcp-tool-guard', `${hookRoot}mcp-tool-guard.sh`, inputFor('MCP')],
      ];
    }),
  ];
  for (const [policy, hook, input] of blockingDoors) {
    const harness = hook.split('/')[0].slice(1);
    for (const profile of ['compat-1', 'strict-1']) {
      const result = runInstalledDoor(t, harness, hook, input, profile, '#!/bin/bash\nexit 1\n', policy);
      const shouldBlock = profile === 'strict-1' || harness !== 'kiro';
      const expectedStatus = harness === 'kiro' ? (shouldBlock ? 2 : 1) : 0;
      assert.equal(result.status, expectedStatus, `${harness}/${policy}/${profile} native exit`);
      assert.deepEqual(failureKinds(result), ['eval-error:exit-1'], `${harness}/${policy}/${profile} fault point`);
      if (shouldBlock && harness !== 'kiro') assert.match(result.stdout, /deny/);
    }
  }

  const stopDoors = [
    ['claude', '.claude/hooks/stop-check.sh', 1],
    ['codex', '.codex/hooks/stop-check.sh', 0],
    ['kiro', '.kiro/hooks/stop-check.sh', 0],
  ];
  for (const [harness, hook, compatStatus] of stopDoors) {
    for (const profile of ['compat-1', 'strict-1']) {
      const result = runInstalledDoor(t, harness, hook, { hook_event_name: 'Stop' }, profile, '#!/bin/bash\nexit 1\n', 'stop-check');
      const expected = profile === 'strict-1' ? 2 : compatStatus;
      assert.equal(result.status, expected, `${harness} Stop ${profile} native status`);
      assert.deepEqual(failureKinds(result), ['eval-error:exit-1']);
      if (harness === 'codex' && profile === 'compat-1') assert.equal(result.stdout, '{}\n');
    }
  }
});

test('real policy code emits jq, config, version and target fault records', (t) => {
  const gateRoot = bridgeTree(t);
  const unsupported = runPolicyDirect(gateRoot, 'pre-implementation-gate', {
    doflow_event: { version: 2, harness: 'claude', event: 'PreToolUse', operation: 'edit' },
  });
  assert.equal(unsupported.status, 0, 'unsupported envelope keeps the gate policy exit');
  assert.equal(JSON.parse(unsupported.records.trim().split('\n').at(-1).slice(1)).code, 'envelope-version');
  assert.deepEqual(diagnosticKinds(unsupported), ['unsupported:envelope-version']);

  const targetRoot = bridgeTree(t);
  const noTarget = runPolicyDirect(targetRoot, 'pre-implementation-gate', {
    doflow_event: { version: 1, harness: 'claude', event: 'PreToolUse', operation: 'edit' },
  });
  assert.equal(JSON.parse(noTarget.records.trim().split('\n').at(-1).slice(1)).code, 'edit-without-target');
  assert.deepEqual(diagnosticKinds(noTarget), ['edit-without-target']);

  const bashRoot = bridgeTree(t);
  fs.unlinkSync(path.join(bashRoot, 'policies/blocked-patterns.conf'));
  const missingConfig = runPolicyDirect(bashRoot, 'pre-bash-guard', {
    doflow_event: { version: 1, harness: 'claude', event: 'PreToolUse', operation: 'command', tool: 'Bash', command: 'echo ok' },
  });
  assert.equal(JSON.parse(missingConfig.records.trim().split('\n').at(-1).slice(1)).code, 'patterns-missing');
  assert.deepEqual(diagnosticKinds(missingConfig), ['patterns-missing']);

  const jqRoot = bridgeTree(t);
  const jqMissing = runPolicyDirect(jqRoot, 'pre-implementation-gate', {}, { pathValue: pathWithoutJq(t) });
  assert.equal(JSON.parse(jqMissing.records.trim().split('\n').at(-1).slice(1)).code, 'dependency-missing:jq');
  assert.deepEqual(diagnosticKinds(jqMissing), ['dependency-missing:jq']);
});

test('DEC-028 decision-mismatch is in decision and trace, never the failure store', (t) => {
  const root = bridgeTree(t);
  const trace = path.join(root, 'bridge-trace.jsonl');
  installPolicy(root, 'pre-implementation-gate', '#!/bin/bash\nprintf \'\\036%s\\n\' \'{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"deny","code":"fixture-deny"}\' >&3\nexit 0\n');
  const result = runBridge(root, 'claude', 'PreToolUse', 'pre-implementation-gate', 'compat-1', { env: { DOFLOW_BRIDGE_TRACE: trace } });
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.code, 'decision-mismatch');
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8').trim()).code, 'decision-mismatch');
  assert.deepEqual(diagnosticKinds(result), []);
});

test('real Antigravity runner covers strict-1 spawn, timeout and unknown profile faults', (t) => {
  for (const profile of ['compat-1', 'strict-1']) {
    const root = tempDir(t, `doflow-runner-real-${profile}-`);
    buildInstallMirror(root);
    const runner = path.join(root, '.doflow/shared/hooks/stream-hook-runner.js');
    const payload = { toolCall: { name: 'write_to_file', args: { TargetFile: 'src/a.ts' } } };
    const run = (env) => spawnSync(process.execPath, ['-e', `const r=require(${JSON.stringify(runner)}); process.stdout.write(JSON.stringify(r.evaluateEvent('PreToolUse',${JSON.stringify(payload)},${JSON.stringify(JSON.stringify(payload))},process.cwd(),'antigravity')))`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, `xdg-${profile}`), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: profile, ...env },
    });
    fs.unlinkSync(path.join(root, '.doflow/shared/hooks/policies/pre-implementation-gate.sh'));
    const spawnFault = run({});
    assert.equal(spawnFault.status, 0, spawnFault.stderr);
    assert.equal(JSON.parse(spawnFault.stdout).effect, profile === 'strict-1' ? 'block' : 'proceed', 'runner spawn follows profile');
    const kindsPath = path.join(root, `xdg-${profile}/doflow/failures/events.jsonl`);
    assert.deepEqual(fs.readFileSync(kindsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind), ['bridge-spawn']);

    const slow = path.join(root, '.doflow/shared/hooks/policies/pre-implementation-gate.sh');
    fs.writeFileSync(slow, '#!/bin/bash\nsleep 10\n');
    fs.chmodSync(slow, 0o755);
    const timeout = run({});
    assert.equal(timeout.status, 0, timeout.stderr);
    assert.equal(JSON.parse(timeout.stdout).code, 'bridge-timeout');
    assert.equal(JSON.parse(timeout.stdout).effect, profile === 'strict-1' ? 'block' : 'proceed');
    const points = fs.readFileSync(kindsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
    assert.deepEqual(points, ['bridge-spawn', 'bridge-timeout'], 'runner faults reach failure store');
  }

  const root = tempDir(t, 'doflow-runner-unknown-');
  buildInstallMirror(root);
  const runner = path.join(root, '.doflow/shared/hooks/stream-hook-runner.js');
  const result = spawnSync(process.execPath, ['-e', `const r=require(${JSON.stringify(runner)}); process.stdout.write(JSON.stringify(r.evaluateEvent('PreToolUse',{toolCall:{name:'write_to_file',args:{TargetFile:'src/a.ts'}}},'{}',process.cwd(),'antigravity')))`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: 'mystery' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).effect, 'proceed');
  assert.ok(failureKinds({ xdg: path.join(root, 'xdg') }).includes('fault-profile-unknown'));
});

test('Antigravity Stop native fault row distinguishes numeric exit from signal', (t) => {
  const root = tempDir(t, 'doflow-runner-stop-');
  buildInstallMirror(root);
  const runner = path.join(root, '.doflow/shared/hooks/stream-hook-runner.js');
  const policy = path.join(root, '.doflow/shared/hooks/policies/stop-check.sh');
  const call = (profile, body) => {
    fs.writeFileSync(policy, `#!/bin/bash\n${body}\n`);
    fs.chmodSync(policy, 0o755);
    const script = `const r=require(${JSON.stringify(runner)}); process.stdout.write(JSON.stringify(r.evaluateEvent('Stop',{},'{}',process.cwd(),'antigravity')))`;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: path.join(root, `xdg-${profile}`), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: profile },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const profile of ['compat-1', 'strict-1']) {
    assert.equal(call(profile, 'exit 1').effect, 'block', `numeric Stop exit blocks under ${profile}`);
    assert.equal(call(profile, 'kill -TERM $$').effect, profile === 'strict-1' ? 'block' : 'proceed', `signal Stop effect under ${profile}`);
  }
  const kindsFile = path.join(root, 'xdg-compat-1/doflow/failures/events.jsonl');
  const kinds = fs.readFileSync(kindsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['eval-error:exit-1'], 'SIGTERM is not captured as a fault');
});

test('Antigravity runner drives each blocking policy through its installed runner path', (t) => {
  const root = tempDir(t, 'doflow-runner-policy-grid-');
  buildInstallMirror(root);
  const runner = path.join(root, '.doflow/shared/hooks/stream-hook-runner.js');
  const policies = path.join(root, '.doflow/shared/hooks/policies');
  const rows = [
    ['pre-implementation-gate', 'PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: 'src/a.ts' } } }],
    ['pre-bash-guard', 'PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'echo ok' } } }],
    ['mcp-tool-guard', 'PreToolUse', { toolCall: { name: 'mcp_search', args: {} } }],
    ['stop-check', 'Stop', {}],
  ];
  for (const profile of ['compat-1', 'strict-1']) {
    for (const [policy, event, payload] of rows) {
      const file = path.join(policies, `${policy}.sh`);
      fs.writeFileSync(file, '#!/bin/bash\nexit 1\n');
      const script = `const r=require(${JSON.stringify(runner)}); process.stdout.write(JSON.stringify(r.evaluateEvent(${JSON.stringify(event)},${JSON.stringify(payload)},${JSON.stringify(JSON.stringify(payload))},process.cwd(),'antigravity')))`;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: root, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: path.join(root, `xdg-${profile}`), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: profile },
      });
      assert.equal(result.status, 0, result.stderr);
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.effect, 'block', `Antigravity ${policy} ${profile} fault blocks`);
      assert.equal(decision.code, 'exit-1');
      fs.writeFileSync(file, fs.readFileSync(path.join(POLICY_SOURCE, `${policy}.sh`)));
    }
  }
  const kindsFile = path.join(root, 'xdg-compat-1/doflow/failures/events.jsonl');
  const kinds = fs.readFileSync(kindsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, rows.map(() => 'eval-error:exit-1'), 'runner policy faults reach the shared failure store');
});

test('context faults stay invisible at each installed harness surface', (t) => {
  const contextDoors = [
    ['claude', '.claude/hooks/session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' }],
    ['codex', '.codex/hooks/session-start.sh', { hook_event_name: 'SessionStart', cwd: '/tmp/project' }],
    ['gemini', '.gemini/hooks/session-start.sh', { hook_event_name: 'SessionStart', session_id: 's' }],
    ['kiro', '.kiro/hooks/session-start.sh', { hook_event_name: 'SessionStart', session_id: 's' }],
  ];
  for (const [harness, hook, input] of contextDoors) {
    const result = runInstalledDoor(t, harness, hook, input, 'strict-1', '#!/bin/bash\nprintf model-context\nprintf hidden-diagnostic >&2\nexit 1\n', 'session-context');
    assert.equal(result.stdout, 'model-context', `${harness} context fault preserves only the policy's existing stdout bytes`);
    assert.equal(result.stderr.includes('policy error'), false, `${harness} context error renders no bridge reason`);
    assert.deepEqual(failureKinds(result), ['eval-error:exit-1']);
  }

  const root = tempDir(t, 'doflow-context-runner-');
  buildInstallMirror(root);
  const runner = path.join(root, '.doflow/shared/hooks/stream-hook-runner.js');
  fs.writeFileSync(path.join(root, '.doflow/shared/hooks/policies/session-context.sh'), '#!/bin/bash\nprintf model-context\nprintf hidden-diagnostic >&2\nexit 1\n');
  const result = spawnSync(process.execPath, ['-e', `const r=require(${JSON.stringify(runner)}); const x=r.evaluateEvent('SessionStart',{},'{}',process.cwd(),'antigravity'); process.stdout.write(JSON.stringify(x))`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'), DOFLOW_FAILURE_CAPTURE: 'on', DOFLOW_FAULT_PROFILE: 'strict-1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'allow');
  assert.equal(result.stdout.includes('model-context'), false, 'runner context fault does not expose policy bytes');
  assert.deepEqual(failureKinds({ xdg: path.join(root, 'xdg') }), ['eval-error:exit-1']);
});

test('unknown fault profile falls back to compat-1 and records its diagnostic', (t) => {
  for (const [harness, event, policy] of bridgeRows) {
    const root = bridgeTree(t);
    installPolicy(root, policy, faultPolicy('recorded-unsupported', policy, root));
    const result = runBridge(root, harness, event, policy, 'mystery');
    const decision = JSON.parse(result.stdout.trim());
    assert.equal(decision.faultProfile, 'compat-1', `${harness} effective profile`);
    assert.equal(decision.effect, 'proceed', `${harness} compat fallback`);
    assert.deepEqual(diagnosticKinds(result), ['unsupported:envelope-version', 'fault-profile-unknown']);
  }
});

test('advisory faults preserve model-visible bytes in compat-1 and strict-1', (t) => {
  for (const profile of ['compat-1', 'strict-1']) {
    const root = bridgeTree(t);
    installPolicy(root, 'session-context', '#!/bin/bash\nprintf \'context\'; printf \'private diagnostic\\n\' >&2; exit 1\n');
    const result = runBridge(root, 'claude', 'SessionStart', 'session-context', profile, { args: ['--emit', 'native'] });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'context', `${profile} advisory fault preserves the context bytes`);
    assert.equal(result.stderr.includes('policy error'), false, `${profile} advisory fault has no rendered error`);
    assert.deepEqual(diagnosticKinds(result), ['eval-error:exit-1']);
  }
});

test('real Pi extension blocks a missing bridge as an out-of-step install', async (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'core/harnesses/pi/extensions/doflow-guard.js'), 'utf8');
  const piMirror = tempDir(t, 'doflow-fault-pi-spawn-');
  buildInstallMirror(piMirror);
  const absentBridge = path.join(piMirror, '.doflow/shared/hooks/bridge/bridge.sh');
  fs.unlinkSync(absentBridge);
  const rendered = source.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(absentBridge).href)});`,
  );
  assert.notEqual(rendered, source, 'real Pi extension bridge URL redirected to a missing executable');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(rendered).toString('base64')}`;
  const { default: register } = await import(moduleUrl);
  let handler;
  register({ on(event, callback) { assert.equal(event, 'tool_call'); handler = callback; } });
  const prior = process.env.DOFLOW_FAULT_PROFILE;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const piXdg = path.join(path.dirname(absentBridge), 'xdg');
  process.env.XDG_CONFIG_HOME = piXdg;
  process.env.DOFLOW_FAILURE_CAPTURE = 'on';
  t.after(() => {
    if (prior === undefined) delete process.env.DOFLOW_FAULT_PROFILE; else process.env.DOFLOW_FAULT_PROFILE = prior;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  });
  const missingLog = path.join(piXdg, 'doflow/failures/events.jsonl');
  for (const [index, profile] of ['compat-1', 'strict-1'].entries()) {
    process.env.DOFLOW_FAULT_PROFILE = profile;
    const result = await handler({ type: 'tool_call', toolName: 'edit', toolCallId: profile, input: { path: 'src/a.js' } }, {
      cwd: path.dirname(absentBridge), sessionManager: { getSessionId: () => 'fault-test' },
    });
    assert.deepEqual(result, { block: true, reason: '[doflow] shared hooks lack the bridge; run: doflow update -t pi' }, `Pi ${profile} missing bridge blocks with the out-of-step response`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(missingLog) && fs.readFileSync(missingLog, 'utf8').trim().split('\n').length >= index + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(fs.existsSync(missingLog), 'missing bridge capture file is created');
  assert.deepEqual(fs.readFileSync(missingLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind), ['bridge-missing', 'bridge-missing'], 'missing bridge is captured for each profile');

  const spawnRoot = tempDir(t, 'doflow-fault-pi-present-bridge-');
  buildInstallMirror(spawnRoot);
  const presentBridge = path.join(spawnRoot, '.doflow/shared/hooks/bridge/bridge.sh');
  fs.writeFileSync(presentBridge, '#!/bin/bash\nexit 1\n');
  const spawnSource = source.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(presentBridge).href)});`,
  );
  assert.notEqual(spawnSource, source, 'Pi spawn-fault case points at an existing bridge');
  const { default: registerSpawn } = await import(`data:text/javascript;base64,${Buffer.from(spawnSource).toString('base64')}`);
  let spawnHandler;
  registerSpawn({ on(_event, callback) { spawnHandler = callback; } });
  const spawnXdg = path.join(spawnRoot, 'xdg');
  process.env.DOFLOW_FAULT_PROFILE = 'compat-1';
  process.env.XDG_CONFIG_HOME = spawnXdg;
  const spawnResult = await spawnHandler({ type: 'tool_call', toolName: 'edit', toolCallId: 'present-bridge-spawn-failure', input: { path: 'src/a.js' } }, {
    cwd: spawnRoot, sessionManager: { getSessionId: () => 'fault-test' },
  });
  assert.equal(spawnResult, undefined, 'Pi compat-1 proceeds when the present bridge exits unsuccessfully');
  const spawnLog = path.join(spawnXdg, 'doflow/failures/events.jsonl');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(spawnLog); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(spawnLog), 'present bridge spawn fault capture file is created');
  assert.deepEqual(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind), ['bridge-spawn'], 'present-but-failing bridge is captured once as bridge-spawn');
  process.env.XDG_CONFIG_HOME = piXdg;

  const slowBridge = path.join(path.dirname(absentBridge), 'slow-bridge.sh');
  const slowStarted = path.join(path.dirname(absentBridge), 'slow-started');
  fs.writeFileSync(slowBridge, `#!/bin/sh\nprintf started > ${JSON.stringify(slowStarted)}\n/bin/sleep 10\n`);
  fs.chmodSync(slowBridge, 0o755);
  const slowSource = source.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(slowBridge).href)});`,
  );
  const slowUrl = `data:text/javascript;base64,${Buffer.from(slowSource).toString('base64')}`;
  const { default: registerSlow } = await import(slowUrl);
  let slowHandler;
  registerSlow({ on(_event, callback) { slowHandler = callback; } });
  for (const profile of ['compat-1', 'strict-1']) {
    process.env.DOFLOW_FAULT_PROFILE = profile;
    const result = await slowHandler({ type: 'tool_call', toolName: 'edit', toolCallId: `timeout-${profile}`, input: { path: 'src/a.js' } }, {
      cwd: path.dirname(absentBridge), sessionManager: { getSessionId: () => 'fault-test' },
    });
    if (profile === 'compat-1') assert.equal(result, undefined, 'Pi compat-1 timeout proceeds');
    else assert.deepEqual(result, { block: true, reason: REASON }, 'Pi strict-1 timeout blocks');
  }
  assert.equal(fs.readFileSync(slowStarted, 'utf8'), 'started', 'Pi timeout cases launched the slow bridge process');
  process.env.DOFLOW_FAULT_PROFILE = 'mystery';
  const piRoot = tempDir(t, 'doflow-fault-pi-profile-');
  buildInstallMirror(piRoot);
  const realBridgeSource = source.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(path.join(piRoot, '.doflow/shared/hooks/bridge/bridge.sh')).href)});`,
  );
  assert.notEqual(realBridgeSource, source, 'Pi unknown-profile case reaches the real installed bridge');
  const { default: registerReal } = await import(`data:text/javascript;base64,${Buffer.from(realBridgeSource).toString('base64')}`);
  let realHandler;
  registerReal({ on(_event, callback) { realHandler = callback; } });
  await realHandler({ type: 'tool_call', toolName: 'edit', toolCallId: 'unknown-profile', input: { path: 'src/a.js' } }, {
    cwd: piRoot, sessionManager: { getSessionId: () => 'fault-test' },
  });
  for (const profile of ['compat-1', 'strict-1']) {
    process.env.DOFLOW_FAULT_PROFILE = profile;
    for (const [toolName, policy, input] of [
      ['edit', 'pre-implementation-gate', { path: 'src/a.js' }],
      ['bash', 'pre-bash-guard', { command: 'echo ok' }],
      ['mcp__test__search', 'mcp-tool-guard', {}],
    ]) {
      const policyPath = path.join(piRoot, `.doflow/shared/hooks/policies/${policy}.sh`);
      fs.writeFileSync(policyPath, '#!/bin/bash\nexit 1\n');
      const policyFault = await realHandler({ type: 'tool_call', toolName, toolCallId: `${policy}-${profile}`, input }, {
        cwd: piRoot, sessionManager: { getSessionId: () => 'fault-test' },
      });
      assert.deepEqual(policyFault, { block: true, reason: `[${policy}] DoFlow policy error; details: doflow-run failure list` }, `Pi ${policy} real policy fault blocks under ${profile}`);
      fs.writeFileSync(policyPath, fs.readFileSync(path.join(POLICY_SOURCE, `${policy}.sh`)));
    }

    const withoutTarget = await realHandler({ type: 'tool_call', toolName: 'edit', toolCallId: `target-${profile}`, input: {} }, {
      cwd: piRoot, sessionManager: { getSessionId: () => 'fault-test' },
    });
    if (profile === 'strict-1') assert.deepEqual(withoutTarget, { block: true, reason: REASON }, 'Pi strict profile blocks real edit-without-target');
    else assert.equal(withoutTarget, undefined, 'Pi compat profile proceeds on real edit-without-target');
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const piStore = path.join(piXdg, 'doflow/failures/events.jsonl');
  const piKinds = fs.readFileSync(piStore, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.ok(piKinds.includes('bridge-missing'), 'Pi missing bridge reaches failure store');
  assert.ok(piKinds.includes('bridge-timeout'), 'Pi timeout fault reaches failure store');
  assert.ok(piKinds.includes('fault-profile-unknown'), 'unknown Pi profile reaches failure store');
});

test('Antigravity runner classifies bridge spawn and timeout faults under both profiles', (t) => {
  const dir = tempDir(t, 'doflow-fault-runner-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const runnerPath = path.join(ROOT, 'core/harnesses/shared/hooks/stream-hook-runner.js');
  const script = `const runner = require(${JSON.stringify(runnerPath)});\nconst result = runner.evaluateEvent('PreToolUse', {toolCall:{name:'write_to_file',args:{TargetFile:'src/a.ts'}}}, '{"toolCall":{"name":"write_to_file","args":{"TargetFile":"src/a.ts"}}}', process.cwd(), 'antigravity');\nprocess.stdout.write(JSON.stringify(result));`;
  const spawnFailure = spawnSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: dir, DOFLOW_FAULT_PROFILE: 'compat-1', XDG_CONFIG_HOME: path.join(dir, 'xdg'), DOFLOW_FAILURE_CAPTURE: 'on' },
  });
  assert.equal(spawnFailure.status, 0, spawnFailure.stderr);
  assert.equal(JSON.parse(spawnFailure.stdout).effect, 'proceed', 'runner compat-1 spawn fault proceeds');

  fs.writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\n/bin/sleep 10\n');
  fs.chmodSync(path.join(bin, 'bash'), 0o755);
  for (const profile of ['compat-1', 'strict-1']) {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir, encoding: 'utf8', timeout: 7000,
      env: { ...process.env, PATH: bin, DOFLOW_FAULT_PROFILE: profile, XDG_CONFIG_HOME: path.join(dir, `xdg-${profile}`), DOFLOW_FAILURE_CAPTURE: 'on' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).effect, profile === 'strict-1' ? 'block' : 'proceed', `runner ${profile} timeout effect`);
    assert.equal(JSON.parse(result.stdout).code, 'bridge-timeout');
  }
});

test('negative control: mapping strict-1 to compat-1 loses the strict block', (t) => {
  const root = bridgeTree(t);
  const script = path.join(root, 'bridge/bridge.sh');
  const source = fs.readFileSync(script, 'utf8');
  const original = '[ "$profile" = strict-1 ] && [ "$block" -eq 1 ]';
  assert.ok(source.includes(original), 'production strict effect branch is present');
  fs.writeFileSync(script, source.replace(original, '[ "$profile" = compat-1 ] && [ "$block" -eq 1 ]'));
  installPolicy(root, 'pre-implementation-gate', faultPolicy('recorded-error', 'pre-implementation-gate', root));
  const result = runBridge(root, 'claude', 'PreToolUse', 'pre-implementation-gate', 'strict-1');
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.effect, 'proceed', 'reverted strict mapping fails the real strict-block assertion');
});
