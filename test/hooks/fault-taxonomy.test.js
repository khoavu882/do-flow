'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('../helper/tmp');

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

test('real Pi extension maps bridge spawn faults by profile without throwing', async (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'core/harnesses/pi/extensions/doflow-guard.js'), 'utf8');
  const absentBridge = path.join(tempDir(t, 'doflow-fault-pi-spawn-'), 'absent-bridge.sh');
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
  t.after(() => { if (prior === undefined) delete process.env.DOFLOW_FAULT_PROFILE; else process.env.DOFLOW_FAULT_PROFILE = prior; });
  for (const profile of ['compat-1', 'strict-1']) {
    process.env.DOFLOW_FAULT_PROFILE = profile;
    const result = await handler({ type: 'tool_call', toolName: 'edit', toolCallId: profile, input: { path: 'src/a.js' } }, {
      cwd: path.dirname(absentBridge), sessionManager: { getSessionId: () => 'fault-test' },
    });
    if (profile === 'compat-1') assert.equal(result, undefined, 'Pi compat-1 spawn fault proceeds');
    else assert.deepEqual(result, { block: true, reason: REASON }, 'Pi strict-1 spawn fault blocks with its native response');
  }

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
