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
const FIXED = '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list';

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

function run(dir, harness, event, policy, input = {}, args = [], env = []) {
  const childEnv = { ...process.env, DOFLOW_FAILURE_CAPTURE: 'off', ...env };
  for (const [key, value] of Object.entries(env)) if (value === null) delete childEnv[key];
  return spawnSync('bash', [path.join(dir, 'bridge/bridge.sh'), harness, event, policy, ...args], {
    cwd: dir, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input),
    env: childEnv,
  });
}

function denyPolicy() {
  return `#!/bin/bash\nprintf '\\036%s\\n' '{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"deny","code":"blocked"}' >&3\nprintf denied >&2\nexit 2\n`;
}

BRIDGE_TEST('decode is fixture-backed, harness-scoped, and only emits operation fields that apply', () => {
  const dir = makeTree();
  const cases = [
    // Native payload examples are committed in these fixture-bearing tests.
    ['claude', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, session_id: 's', cwd: '/repo', doflow_event: { version: 99 } }, 'edit', ['src/a.ts'], 'test/hooks/kiro-bridge.test.js'],
    ['codex', 'PreToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n' }, cwd: '/repo' }, 'edit', [], 'test/hooks/stream-hook-runner.test.js'],
    ['gemini', 'BeforeTool', { tool_name: 'write_file', tool_input: { path: '/repo/a' } }, 'edit', ['/repo/a'], 'test/adapters/gemini/gemini-hooks.test.js'],
    ['kiro', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/repo/a' }, session_id: 'k' }, 'edit', ['/repo/a'], 'test/hooks/kiro-bridge.test.js'],
    ['kiro', 'PreToolUse', { tool_name: 'mcp_evil_drop', tool_input: {} }, 'mcp', [], 'test/hooks/kiro-bridge.test.js (mcp-tool-guard evaluates a V3 `mcp_<server>_<tool>` ID against the policy)'],
    ['kiro', 'PreToolUse', { tool_name: '@evil/drop', tool_input: {} }, 'mcp', [], 'test/hooks/kiro-bridge.test.js (mcp-tool-guard sees `@server/tool` as mcp__server__tool and lets built-in tools through)'],
    ['antigravity', 'PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/a' } }, workspacePaths: ['/repo'], cwd: '/ignored' }, 'edit', ['/repo/a'], 'test/adapters/antigravity/adapter.test.js'],
    ['pi', 'tool_call', JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/hooks/pi/tool_call/edit.json'), 'utf8')).native, 'edit', ['src/a.js'], 'test/fixtures/hooks/pi/tool_call/edit.json'],
  ];
  for (const [harness, event, native, operation, paths, source] of cases) {
    assert.ok(fs.existsSync(path.join(ROOT, source.split(' (')[0])), `${harness} fixture source exists: ${source}`);
    const payload = { ...native, unknown_field: 'ignored' };
    const decoded = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', 'session-context', '-f', path.join(dir, 'bridge/envelope.jq')], { input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const value = JSON.parse(decoded.stdout).doflow_event;
    assert.equal(value.version, 1, harness);
    assert.equal(value.operation, operation, harness);
    if (harness === 'kiro' && operation === 'mcp') assert.equal(value.tool, native.tool_name.startsWith('@') ? 'mcp__evil__drop' : native.tool_name);
    assert.deepEqual(value.paths || [], paths, harness);
    assert.equal('projectRoot' in value, false, harness);
    assert.equal('cwd' in value, false, harness);
    assert.equal('unknown_field' in value, false, harness);
    if (harness === 'codex') assert.equal(value.patch, '*** Begin Patch\n');
    if (harness === 'claude') assert.equal(value.version, 1, 'bridge envelope replaces native doflow_event');
    const command = harness === 'pi' ? { toolName: 'bash', input: { command: 'npm test', path: 'wrong.ts' } } : { tool_name: harness === 'gemini' || harness === 'antigravity' ? 'run_shell_command' : 'Bash', tool_input: { command: 'npm test', file_path: 'wrong.ts' } };
    const cmd = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', 'session-context', '-f', path.join(dir, 'bridge/envelope.jq')], { input: JSON.stringify(command), encoding: 'utf8' });
    assert.equal(cmd.status, 0, cmd.stderr);
    const cmdEnv = JSON.parse(cmd.stdout).doflow_event;
    assert.equal(cmdEnv.operation, ['claude','codex','gemini','kiro','pi'].includes(harness) ? 'command' : 'tool', harness);
    assert.equal(cmdEnv.command, ['claude','codex','gemini','kiro','pi'].includes(harness) ? 'npm test' : undefined, harness);
    assert.equal(cmdEnv.paths, undefined, harness);
  }
});

BRIDGE_TEST('Antigravity decodes every tool name routed by the runner from its committed routing fixture', () => {
  const dir = makeTree();
  const fixturePath = path.join(ROOT, 'test/fixtures/hooks/antigravity/pre-implement-gate/routed-tools.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  for (const row of fixture.calls) {
    const decoded = spawnSync('jq', ['-c', '--arg', 'harness', 'antigravity', '--arg', 'event', 'PreToolUse', '--arg', 'policy', 'pre-implementation-gate', '-f', path.join(dir, 'bridge/envelope.jq')], {
      input: JSON.stringify(row.native), encoding: 'utf8',
    });
    assert.equal(decoded.status, 0, row.name);
    const envelope = JSON.parse(decoded.stdout).doflow_event;
    assert.equal(envelope.operation, row.operation, row.name);
    assert.equal(envelope.tool, row.name, row.name);
    if (row.operation === 'edit') assert.deepEqual(envelope.paths, ['/repo/a'], row.name);
    if (row.operation === 'command') assert.equal(envelope.command, 'rm -rf /', row.name);
  }
  assert.equal(fixture.source, 'core/harnesses/shared/hooks/stream-hook-runner.js tool-name classifiers');
});

BRIDGE_TEST('policy mode 0644 is byte-identical to 0755 for allow, deny, and error outcomes', () => {
  const rows = [
    ['allow', `#!/bin/bash\nprintf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3\nexit 0\n`],
    ['deny', denyPolicy()],
    ['error', '#!/bin/bash\necho raw-error >&2\nexit 9\n'],
  ];
  for (const [label, body] of rows) {
    const dir = makeTree();
    const policy = path.join(dir, 'policies/pre-implementation-gate.sh');
    fs.writeFileSync(policy, body, { mode: 0o755 });
    const executable = run(dir, 'antigravity', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'native']);
    fs.chmodSync(policy, 0o644);
    const nonExecutable = run(dir, 'antigravity', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'native']);
    assert.deepEqual(
      { status: nonExecutable.status, stdout: nonExecutable.stdout, stderr: nonExecutable.stderr },
      { status: executable.status, stdout: executable.stdout, stderr: executable.stderr },
      `${label}: policy file permissions do not affect bridge behavior`,
    );
  }
});

BRIDGE_TEST('bridge replaces a stale native doflow_event with its v1 envelope before policy evaluation', () => {
  const dir = makeTree();
  const policy = path.join(dir,'policies/pre-implementation-gate.sh');
  fs.writeFileSync(policy, `#!/bin/bash
if jq -e '.doflow_event.version == 1' >/dev/null; then
  printf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3
else
  printf '\\036%s\\n' '{"outcome":"unsupported","code":"unsupported-version","policyVersion":1}' >&3
fi
exit 0
`);
  const result = run(dir,'claude','PreToolUse','pre-implementation-gate',{
    tool_name:'Edit', tool_input:{file_path:'src/a.ts'}, doflow_event:{version:99},
  },['--emit','native'],{DOFLOW_FAULT_PROFILE:'strict-1'});
  assert.equal(result.status,0);
  assert.equal(result.stdout,'','v1 envelope replaces stale native version 99 and proceeds');
});

BRIDGE_TEST('IC-036 malformed and non-object stdin reaches every bridge as a minimal envelope', () => {
  const bridges = [
    ['claude', 'PreToolUse'], ['codex', 'PreToolUse'], ['gemini', 'BeforeTool'],
    ['kiro', 'PreToolUse'], ['antigravity', 'PreToolUse'], ['pi', 'tool_call'],
  ];
  const inputs = [['empty', ''], ['malformed', 'not json'], ['array', '[]'], ['string', '"s"'], ['null', 'null']];
  for (const [harness, event] of bridges) {
    for (const [label, input] of inputs) {
      const dir = makeTree();
      const payloadFile = path.join(dir, 'policy-input.json');
      fs.writeFileSync(path.join(dir, 'policies/pre-implementation-gate.sh'), `#!/bin/bash\ncat >"$PAYLOAD_FILE"\nprintf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3\nexit 0\n`);
      const result = run(dir, harness, event, 'pre-implementation-gate', input, ['--emit', 'decision'], {
        DOFLOW_FAILURE_CAPTURE: 'on', XDG_CONFIG_HOME: path.join(dir, 'xdg'), PAYLOAD_FILE: payloadFile,
      });
      assert.equal(result.status, 0, `${harness}:${event} ${label}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(payloadFile, 'utf8')), {
        doflow_event: { version: 1, harness, event, operation: 'tool' },
      }, `${harness}:${event} ${label} minimal envelope`);
      assert.equal(JSON.parse(result.stdout).code, 'envelope-encode', `${harness}:${event} ${label} diagnostic`);
      const events = path.join(dir, 'xdg/doflow/failures/events.jsonl');
      assert.match(fs.readFileSync(events, 'utf8'), /"kind":"envelope-encode"/, `${harness}:${event} ${label} captured`);
    }
  }
});

BRIDGE_TEST('IC-036 encode fault preserves compat result and blocks strict blocking policies', () => {
  const bridges = [
    ['claude', 'PreToolUse'], ['codex', 'PreToolUse'], ['gemini', 'BeforeTool'],
    ['kiro', 'PreToolUse'], ['antigravity', 'PreToolUse'], ['pi', 'tool_call'],
  ];
  const blocking = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check'];
  for (const [harness, event] of bridges) {
    for (const policy of [...blocking, 'session-context', 'user-prompt-submit', 'subagent-audit']) {
      for (const profile of ['compat-1', 'strict-1']) {
        const dir = makeTree();
        const result = run(dir, harness, event, policy, 'not json', ['--emit', 'decision'], {
          DOFLOW_FAULT_PROFILE: profile,
        });
        const decision = JSON.parse(result.stdout);
        assert.equal(decision.code, 'envelope-encode', `${harness}:${event} ${policy} ${profile}`);
        assert.equal(decision.effect, profile === 'strict-1' && blocking.includes(policy) ? 'block' : 'proceed', `${harness}:${event} ${policy} ${profile}`);
      }
    }
  }
});

BRIDGE_TEST('IC-036 minimal envelope maps non-tool events to the canonical operation', () => {
  const dir = makeTree();
  const policy = path.join(dir, 'policies/session-context.sh');
  const payloadFile = path.join(dir, 'policy-input.json');
  fs.writeFileSync(policy, `#!/bin/bash\ncat >"$PAYLOAD_FILE"\nprintf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3\nexit 0\n`);
  const rows = [
    ['SessionStart', 'session-start'], ['SessionEnd', 'session-end'], ['UserPromptSubmit', 'prompt'],
    ['Stop', 'stop'], ['SubagentStart', 'subagent-start'], ['SubagentStop', 'subagent-stop'],
    ['PreCompact', 'compact'], ['PostToolUse', 'post-tool'], ['unknown-event', 'tool'],
  ];
  for (const [event, operation] of rows) {
    run(dir, 'claude', event, 'session-context', 'not json', ['--emit', 'decision'], { PAYLOAD_FILE: payloadFile });
    const envelope = JSON.parse(fs.readFileSync(payloadFile, 'utf8')).doflow_event;
    assert.deepEqual(envelope, { version: 1, harness: 'claude', event, operation }, event);
  }
});

BRIDGE_TEST('IC-007 classifies signal names, ordinary exit 255, spawn failure, and mismatch', () => {
  const dir = makeTree();
  const p = path.join(dir, 'policies/pre-implementation-gate.sh');
  for (const [status, code] of [[139, 'signal-SEGV'], [130, 'signal-INT'], [141, 'signal-PIPE'], [143, 'signal-TERM'], [255, 'exit-255'], [127, 'exit-127']]) {
    fs.writeFileSync(p, `#!/bin/bash\nexit ${status}\n`);
    const result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']);
    assert.equal(JSON.parse(result.stdout).code, code, `IC-007 status ${status}`);
  }
  fs.writeFileSync(p, '#!/bin/bash\nthis is a syntax error (\n');
  const syntax = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit','decision']);
  assert.equal(JSON.parse(syntax.stdout).code, 'exit-2-unmarked', 'syntax error before init is IC-007 row 5');
  fs.writeFileSync(p, '#!/bin/bash\nprintf \'\\036%s\\n\' \'{"outcome":"deny","code":"x","policyVersion":1}\' >&3\nexit 0\n');
  assert.equal(JSON.parse(run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision']).stdout).code, 'decision-mismatch');
  const missing = run(dir, 'claude', 'PreToolUse', 'missing-policy', {}, ['--emit', 'decision']);
  assert.equal(JSON.parse(missing.stdout).code, 'bridge-spawn');
});

BRIDGE_TEST('unsupported blocks under strict-1 with the fixed native reason; deny keeps its own reason', () => {
  const dir = makeTree();
  const p = path.join(dir,'policies/pre-implementation-gate.sh');
  const rows = [['claude','PreToolUse'],['codex','PreToolUse'],['gemini','BeforeTool'],['kiro','PreToolUse'],['claude','Stop'],['codex','Stop'],['kiro','Stop'],['kiro','Stop',{DOFLOW_KIRO_ENGINE:'v3'}],['antigravity','PreToolUse'],['antigravity','Stop'],['pi','tool_call']];
  for (const [harness,event,env={}] of rows) {
    fs.writeFileSync(p, `#!/bin/bash\nprintf '\\036%s\\n' '{"outcome":"unsupported","code":"unsupported-test","policyVersion":1}' >&3\nprintf raw-secret >&2\nexit 0\n`);
    const result=run(dir,harness,event,'pre-implementation-gate',{},['--emit','native'],{DOFLOW_FAULT_PROFILE:'strict-1',...env});
    assert.equal((result.stdout+result.stderr).includes('raw-secret'),false,`${harness}:${event} hides stub stderr`);
    if ((harness === 'claude' && event === 'PreToolUse') || (harness === 'codex' && event === 'PreToolUse')) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason,FIXED);
    else if (harness === 'gemini' || harness === 'antigravity' || harness === 'pi') assert.equal(JSON.parse(result.stdout).reason,FIXED);
    else if (harness === 'kiro' && event === 'Stop' && env.DOFLOW_KIRO_ENGINE === 'v3') assert.equal(JSON.parse(result.stdout).reason,FIXED);
    else if (harness === 'codex' && event === 'Stop') { assert.equal(result.stdout.trim(),'{}'); assert.ok(result.stderr.includes(FIXED)); }
    else assert.ok(result.stderr.includes(FIXED));
  }
  fs.writeFileSync(p, denyPolicy());
  const denied=run(dir,'claude','PreToolUse','pre-implementation-gate',{},['--emit','native']);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason,'denied');
});

BRIDGE_TEST('IC-011 full profile, harness, outcome grid including unknown-profile fallback', () => {
  const dir = makeTree();
  const rows = [
    ['claude','PreToolUse','pre-implementation-gate','error','exit-2-unmarked','block'],
    ['claude','PreToolUse','pre-implementation-gate','error','exit-9','block'],
    ['claude','PreToolUse','pre-implementation-gate','error','signal-SEGV','block'],
    ['codex','PreToolUse','pre-implementation-gate','error','exit-9','block'],
    ['gemini','BeforeTool','pre-implementation-gate','error','signal-SEGV','block'],
    ['claude','PreToolUse','pre-implementation-gate','deny','denied','block'],
    ['codex','PreToolUse','pre-implementation-gate','deny','denied','block'],
    ['gemini','BeforeTool','pre-implementation-gate','deny','denied','block'],
    ['kiro','PreToolUse','pre-implementation-gate','error','exit-9','proceed'],
    ['kiro','PreToolUse','pre-implementation-gate','error','signal-SEGV','proceed'],
    ['kiro','PreToolUse','pre-implementation-gate','unsupported','x','proceed'],
    ['kiro','PreToolUse','pre-implementation-gate','deny','denied','block'],
    ['claude','Stop','stop-check','error','exit-9','proceed'],
    ['claude','Stop','stop-check','error','exit-2-unmarked','block'],
    ['claude','Stop','stop-check','error','signal-SEGV','proceed'],
    ['claude','Stop','stop-check','unsupported','x','proceed'],
    ['claude','Stop','stop-check','deny','denied','block'],
    ['codex','Stop','stop-check','error','exit-9','proceed'],
    ['codex','Stop','stop-check','error','exit-2-unmarked','block'],
    ['codex','Stop','stop-check','error','signal-SEGV','proceed'],
    ['codex','Stop','stop-check','unsupported','x','proceed'],
    ['codex','Stop','stop-check','deny','denied','block'],
    ['kiro','Stop','stop-check','error','exit-9','proceed'],
    ['kiro','Stop','stop-check','error','exit-2-unmarked','block'],
    ['kiro','Stop','stop-check','error','signal-SEGV','proceed'],
    ['kiro','Stop','stop-check','unsupported','x','proceed'],
    ['kiro','Stop','stop-check','deny','denied','block'],
    ['antigravity','PreToolUse','pre-implementation-gate','error','exit-9','block'],
    ['antigravity','Stop','stop-check','error','exit-9','block'],
    ['antigravity','Stop','stop-check','error','signal-SEGV','proceed'],
    ['antigravity','Stop','stop-check','unsupported','x','proceed'],
    ['antigravity','Stop','stop-check','deny','denied','block'],
    ['pi','tool_call','pre-implementation-gate','error','exit-9','block'],
    ['pi','tool_call','pre-implementation-gate','error','signal-SEGV','block'],
    ['pi','tool_call','pre-implementation-gate','unsupported','x','proceed'],
    ['pi','tool_call','pre-implementation-gate','deny','denied','block'],
    ['claude','PreToolUse','pre-implementation-gate','unsupported','x','proceed'],
    ['claude','PreToolUse','pre-implementation-gate','bridgefault','bridge-spawn','proceed'],
    ['session','SessionStart','session-context','error','exit-9','proceed'],
  ];
  for (const profile of ['compat-1', 'strict-1', 'mystery']) {
    for (const [harness0,event,policy,outcome,code,compat] of rows) {
      const harness = harness0 === 'session' ? 'claude' : harness0;
      const expected = profile === 'strict-1' && ['pre-implementation-gate','stop-check'].includes(policy) && ['error','unsupported','bridgefault'].includes(outcome) ? 'block' : compat;
      if (outcome === 'bridgefault') {
        const policyPath = path.join(dir, 'policies', `${policy}.sh`);
        fs.renameSync(policyPath, `${policyPath}.missing`);
        const res = run(dir, harness, event, policy, {}, ['--emit','decision'], {DOFLOW_FAULT_PROFILE:profile});
        fs.renameSync(`${policyPath}.missing`, policyPath);
        const d = JSON.parse(res.stdout);
        assert.equal(d.effect, profile === 'strict-1' ? 'block' : 'proceed', `${profile} ${harness}:${event} spawn`);
        if (profile === 'mystery') assert.equal(d.faultProfile, 'compat-1');
        const native=run(dir,harness,event,policy,{},['--emit','native'],{DOFLOW_FAULT_PROFILE:profile});
        assert.equal(native.status,profile === 'strict-1' && (harness === 'kiro' || event === 'Stop') ? 2 : 0,`${profile} ${harness}:${event} spawn native exit`);
        if (profile !== 'strict-1') {
          assert.equal(native.stderr,'',`${profile} ${harness}:${event} spawn native stderr`);
          const expectedStdout=harness === 'codex' && event === 'Stop' ? '{}\n' : harness === 'antigravity' && event === 'PreToolUse' ? '{"decision":"allow"}\n' : '';
          assert.equal(native.stdout,expectedStdout,`${profile} ${harness}:${event} spawn proceed stdout`);
        } else {
          assert.notEqual(native.stdout+native.stderr,'',`${profile} ${harness}:${event} spawn block response`);
          assert.equal((native.stdout+native.stderr).includes('DoFlow policy error'),true,`${profile} ${harness}:${event} spawn fixed reason`);
        }
        continue;
      }
      const p = path.join(dir, 'policies', `${policy}.sh`);
      const status = code === 'exit-2-unmarked' || outcome === 'deny' ? 2 : code.startsWith('signal-') ? 139 : code === 'exit-9' ? 9 : 0;
      const record = outcome === 'error' || outcome === 'unsupported' || outcome === 'deny' ? `printf '\\036%s\\n' '{"outcome":"${outcome}","code":"${code}","policyVersion":1}' >&3\n` : '';
      fs.writeFileSync(p, `#!/bin/bash\n${record}exit ${status}\n`);
      const res = run(dir, harness, event, policy, {}, ['--emit','decision'], {DOFLOW_FAULT_PROFILE:profile});
      const d = JSON.parse(res.stdout);
      assert.equal(d.effect, expected, `${profile} ${harness}:${event} ${outcome}/${code}`);
      if (outcome !== 'deny') assert.equal(d.reason, d.code, `${profile} ${harness}:${event} decision reason is its code`);
      if (profile === 'mystery') assert.equal(d.faultProfile, 'compat-1');
    }
  }
});

BRIDGE_TEST('IC-011 table-driven full effect grid for each bridge and both profiles', () => {
  const dir = makeTree();
  const bridges = [
    {h:'claude',e:'PreToolUse',p:'pre-implementation-gate',kind:'claude'},
    {h:'codex',e:'PreToolUse',p:'pre-implementation-gate',kind:'codex'},
    {h:'gemini',e:'BeforeTool',p:'pre-implementation-gate',kind:'claude'},
    {h:'kiro',e:'PreToolUse',p:'pre-implementation-gate',kind:'kiro-tool'},
    {h:'claude',e:'Stop',p:'stop-check',kind:'claude-stop'},
    {h:'codex',e:'Stop',p:'stop-check',kind:'codex-stop'},
    {h:'kiro',e:'Stop',p:'stop-check',kind:'kiro-stop'},
    {h:'antigravity',e:'PreToolUse',p:'pre-implementation-gate',kind:'antigravity'},
    {h:'antigravity',e:'Stop',p:'stop-check',kind:'antigravity'},
    {h:'pi',e:'tool_call',p:'pre-implementation-gate',kind:'pi'},
    {h:'claude',e:'SessionStart',p:'session-context',kind:'context'},
  ];
  const scenarios = ['deny','unmarked','numeric','signal','recorded-error','unsupported','bridge-spawn'];
  for (const profile of ['compat-1','strict-1','mystery']) {
    for (const b of bridges) for (const scenario of scenarios) {
      if (b.kind === 'context' && scenario === 'deny') continue;
      const isBlocking = b.kind !== 'context';
      const expected = scenario === 'deny' || (scenario === 'unmarked' && b.kind !== 'context')
        ? 'block'
        : profile === 'strict-1' && isBlocking && ['numeric','signal','recorded-error','unsupported','bridge-spawn'].includes(scenario) ? 'block'
        : scenario === 'bridge-spawn' ? (profile === 'strict-1' && isBlocking ? 'block' : 'proceed')
          : scenario === 'unsupported' || scenario === 'recorded-error' ? (profile === 'strict-1' && isBlocking ? 'block' : 'proceed')
            : scenario === 'numeric' ? (['claude','codex','gemini','pi','antigravity'].includes(b.kind) ? 'block' : 'proceed')
              : scenario === 'signal' ? (['claude','codex','gemini','pi'].includes(b.kind) ? 'block' : 'proceed')
                : 'proceed';
      if (scenario === 'bridge-spawn') {
        const target = path.join(dir,'policies',`${b.p}.sh`);
        fs.renameSync(target,`${target}.missing`);
        const result=run(dir,b.h,b.e,b.p,{},['--emit','decision'],{DOFLOW_FAULT_PROFILE:profile});
        fs.renameSync(`${target}.missing`,target);
        assert.equal(JSON.parse(result.stdout).effect,expected,`${profile} ${b.h}:${b.e} bridge-spawn`);
        continue;
      }
      const record = scenario === 'deny' ? `printf '\\036%s\\n' '{"outcome":"deny","code":"blocked","policyVersion":1}' >&3\nprintf denied >&2\n`
        : scenario === 'recorded-error' || scenario === 'unsupported' ? `printf '\\036%s\\n' '{"outcome":"${scenario === 'unsupported' ? 'unsupported' : 'error'}","code":"table-case","policyVersion":1}' >&3\n`
          : '';
      const status = scenario === 'deny' || scenario === 'unmarked' ? 2 : scenario === 'numeric' ? 9 : scenario === 'signal' ? 139 : 0;
      fs.writeFileSync(path.join(dir,'policies',`${b.p}.sh`),`#!/bin/bash\n${record}exit ${status}\n`);
      const result=run(dir,b.h,b.e,b.p,{},['--emit','decision'],{DOFLOW_FAULT_PROFILE:profile});
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.effect,expected,`${profile} ${b.h}:${b.e} ${scenario}`);
      assert.equal(result.status,0,`${profile} ${b.h}:${b.e} ${scenario} decision exit`);
      assert.equal(result.stderr,'',`${profile} ${b.h}:${b.e} ${scenario} decision stderr`);

      const native=run(dir,b.h,b.e,b.p,{},['--emit','native'],{DOFLOW_FAULT_PROFILE:profile});
      const passThrough = scenario === 'numeric' || scenario === 'signal';
      const shouldPassStatus = expected === 'proceed' && (
        (passThrough && (b.kind === 'context' || b.kind === 'kiro-tool' || b.kind === 'claude-stop')) ||
        (scenario === 'unmarked' && b.kind === 'context')
      );
      const nativeBlockStatus = expected === 'block' && (b.kind === 'kiro-tool' || (b.e === 'Stop' && b.kind !== 'antigravity')) ? 2 : 0;
      assert.equal(native.status, shouldPassStatus ? (scenario === 'signal' ? 139 : scenario === 'unmarked' ? 2 : 9) : nativeBlockStatus,
        `${profile} ${b.h}:${b.e} ${scenario} native exit`);
      assert.equal(native.stderr.includes('raw-secret'),false,`${profile} ${b.h}:${b.e} ${scenario} hides child stderr`);
      if (expected === 'proceed') {
        const expectedStdout = b.kind === 'codex-stop' ? '{}\n' : b.kind === 'antigravity' && b.e === 'PreToolUse' ? '{"decision":"allow"}\n' : '';
        assert.equal(native.stdout,expectedStdout,`${profile} ${b.h}:${b.e} ${scenario} proceed stdout`);
        if (expected === 'proceed' && ['numeric','signal'].includes(scenario) && (b.kind === 'kiro-tool' || b.kind === 'claude-stop')) assert.equal(native.stderr,`[${b.p}] DoFlow policy error; details: doflow-run failure list${b.kind === 'claude-stop' ? '\n' : ''}`,`${profile} ${b.h}:${b.e} ${scenario} fixed diagnostic on stderr`);
        else assert.equal(native.stderr,'',`${profile} ${b.h}:${b.e} ${scenario} proceed stderr`);
      } else {
        assert.notEqual(native.stdout + native.stderr,'',`${profile} ${b.h}:${b.e} ${scenario} block has native response`);
        if (scenario !== 'deny') assert.ok((native.stdout + native.stderr).includes(`[${b.p}] DoFlow policy error; details: doflow-run failure list`),`${profile} ${b.h}:${b.e} ${scenario} native fixed reason`);
      }
      if (profile === 'mystery') assert.equal(decision.faultProfile,'compat-1',`${b.h}:${b.e} unknown profile falls back`);
    }
  }
});

BRIDGE_TEST('DEC-026 preserves door-specific policy streams for every allow/proceed cell', () => {
  const dir = makeTree();
  const bridges = [
    {h:'claude',e:'PreToolUse',p:'pre-implementation-gate',kind:'claude'},
    {h:'codex',e:'PreToolUse',p:'pre-implementation-gate',kind:'codex'},
    {h:'gemini',e:'BeforeTool',p:'pre-implementation-gate',kind:'gemini'},
    {h:'kiro',e:'PreToolUse',p:'pre-implementation-gate',kind:'kiro-tool'},
    {h:'claude',e:'Stop',p:'stop-check',kind:'claude-stop'},
    {h:'codex',e:'Stop',p:'stop-check',kind:'codex-stop'},
    {h:'kiro',e:'Stop',p:'stop-check',kind:'kiro-stop'},
    {h:'antigravity',e:'PreToolUse',p:'pre-implementation-gate',kind:'antigravity-tool'},
    {h:'antigravity',e:'Stop',p:'stop-check',kind:'antigravity-stop'},
    {h:'pi',e:'tool_call',p:'pre-implementation-gate',kind:'pi'},
    {h:'claude',e:'SessionStart',p:'session-context',kind:'context'},
  ];
  const rawStderr = 'policy stderr\n\n';
  for (const profile of ['compat-1','strict-1','mystery']) {
    for (const b of bridges) {
      for (const scenario of ['allow','numeric','signal','recorded-error','unsupported']) {
        const policy = path.join(dir,'policies',`${b.p}.sh`);
        const outcome = scenario === 'recorded-error' ? 'error' : scenario;
        const code = scenario === 'allow' ? 'allow' : scenario === 'numeric' ? 'exit-9' : scenario === 'signal' ? 'signal-SEGV' : scenario;
        const record = scenario === 'numeric' || scenario === 'signal' ? '' : `printf '\\036%s\\n' '{"outcome":"${outcome}","code":"${code}","policyVersion":1}' >&3\n`;
        const status = scenario === 'numeric' ? 9 : scenario === 'signal' ? 139 : 0;
        fs.writeFileSync(policy, `#!/bin/bash\nprintf 'policy stdout\\n'\nprintf 'policy stderr\\n\\n' >&2\n${record}exit ${status}\n`);

        const expectedEffect = profile === 'strict-1' && b.kind !== 'context' && scenario !== 'allow' ? 'block'
          : scenario === 'numeric' ? (['claude','codex','gemini','antigravity-tool','antigravity-stop','pi'].includes(b.kind) ? 'block' : 'proceed')
            : scenario === 'signal' ? (['claude','codex','gemini','pi'].includes(b.kind) ? 'block' : 'proceed')
              : 'proceed';
        if (expectedEffect !== 'proceed') continue;

        const result = run(dir,b.h,b.e,b.p,{},['--emit','native'],{DOFLOW_FAULT_PROFILE:profile});
        const label = `${profile} ${b.h}:${b.e} ${scenario}`;
        const decision = run(dir,b.h,b.e,b.p,{},['--emit','decision'],{DOFLOW_FAULT_PROFILE:profile});
        assert.equal(JSON.parse(decision.stdout).effect,'proceed',`${label}: table cell proceeds`);
        const dropToolStreams = ['claude','codex','gemini','kiro-tool','antigravity-tool','antigravity-stop','pi'].includes(b.kind) && ['pre-implementation-gate','pre-bash-guard','mcp-tool-guard'].includes(b.p);
        const dropToolStderr = ['claude','codex','gemini','antigravity-tool','antigravity-stop','pi'].includes(b.kind) && ['pre-implementation-gate','pre-bash-guard','mcp-tool-guard'].includes(b.p);
        const dropKiroStopStdout = b.kind === 'kiro-stop' && b.p === 'stop-check';
        if (b.kind === 'context' && scenario !== 'allow') {
          assert.equal(result.stderr,'',`${label}: context fault is silent`);
        } else if (b.kind === 'kiro-stop' && ['numeric','signal'].includes(scenario)) {
          assert.equal(result.stderr,'',`${label}: failed Kiro Stop stderr stays private`);
        } else if ((b.kind === 'kiro-tool' || b.kind === 'claude-stop') && ['numeric','signal'].includes(scenario)) {
          assert.equal(result.stderr,`[${b.p}] DoFlow policy error; details: doflow-run failure list${b.kind === 'claude-stop' ? '\n' : ''}`,`${label}: fixed IC-013 reason`);
        } else if (dropToolStderr) {
          assert.equal(result.stderr,'',`${label}: tool door drops policy stderr`);
        } else {
          assert.equal(result.stderr,rawStderr,`${label}: exact stderr pass-through`);
        }
        assert.equal(result.stdout.includes('policy stdout'),!dropToolStreams && !dropKiroStopStdout,`${label}: policy stdout follows IC-012/077 Kiro Stop rule`);
      }
    }
  }
});

BRIDGE_TEST('DEC-025 missing policy is a captured bridge-spawn for every policy kind', () => {
  const cases = [
    ['pre-implementation-gate','claude','PreToolUse',true], ['pre-bash-guard','claude','PreToolUse',true],
    ['mcp-tool-guard','claude','PreToolUse',true], ['stop-check','claude','Stop',true],
    ['session-context','claude','SessionStart',false], ['user-prompt-submit','claude','UserPromptSubmit',false],
    ['subagent-audit','claude','SubagentStart',false],
  ];
  for (const [policyId, harness, event, canDeny] of cases) {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, `policies/${policyId}.sh`));
    const xdg = path.join(dir, `xdg-${policyId}`);
    const env = { DOFLOW_FAILURE_CAPTURE: 'on', XDG_CONFIG_HOME: xdg };
    const result = run(dir, harness, event, policyId, {}, ['--emit','native'], env);
    const decisionResult = run(dir, harness, event, policyId, {}, ['--emit','decision'], { ...env, DOFLOW_FAILURE_CAPTURE: 'off' });
    const decision = JSON.parse(decisionResult.stdout);
    assert.equal(decision.outcome, 'error', `${policyId}: IC-007 bridge-spawn classification`);
    assert.equal(decision.code, 'bridge-spawn', `${policyId}: bridge-spawn code`);
    assert.equal(decision.effect, 'proceed', `${policyId}: compat-1 proceeds`);
    assert.equal(result.status, 0, `${policyId}: compat-1 never leaks native 127`);
    const events = fs.readFileSync(path.join(xdg, 'doflow/failures/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(events.length, 1, `${policyId}: one diagnostic`);
    assert.equal(JSON.parse(events[0]).kind, 'bridge-spawn', `${policyId}: bridge-spawn diagnostic`);

    const strictResult = run(dir, harness, event, policyId, {}, ['--emit','native'], { ...env, DOFLOW_FAULT_PROFILE: 'strict-1', XDG_CONFIG_HOME: `${xdg}-strict` });
    const strictDecision = run(dir, harness, event, policyId, {}, ['--emit','decision'], { ...env, DOFLOW_FAULT_PROFILE: 'strict-1', DOFLOW_FAILURE_CAPTURE: 'off' });
    assert.equal(JSON.parse(strictDecision.stdout).effect, canDeny ? 'block' : 'proceed', `${policyId}: strict-1 effect`);
    if (canDeny) {
      if (event === 'PreToolUse') assert.equal(JSON.parse(strictResult.stdout).hookSpecificOutput.permissionDecision, 'deny', `${policyId}: strict native deny`);
      else {
        assert.equal(strictResult.status, 2, `${policyId}: strict Stop exit`);
        assert.match(strictResult.stderr, new RegExp(`^\\[${policyId}\\] DoFlow policy error`), `${policyId}: strict Stop reason`);
      }
    } else assert.equal(strictResult.status, 0, `${policyId}: context/advisory remains non-blocking`);
  }
});

BRIDGE_TEST('tool-door policy stdout cannot precede a native deny response', () => {
  const dir = makeTree(`#!/bin/bash\nprintf 'stub stdout\\n'\nprintf 'private reason\\n' >&2\nexit 1\n`);
  const result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', {}, ['--emit','native']);
  const response = JSON.parse(result.stdout);
  assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(response.hookSpecificOutput.permissionDecisionReason, FIXED);
  assert.equal(result.stderr, '');
});

BRIDGE_TEST('unknown-profile fallback records fault-profile-unknown', () => {
  const dir=makeTree();
  const failures=path.join(dir,'config');
  const result=run(dir,'claude','PreToolUse','pre-implementation-gate',{},['--emit','decision'],{
    DOFLOW_FAULT_PROFILE:'mystery', XDG_CONFIG_HOME:failures, DOFLOW_FAILURE_CAPTURE:'on',
  });
  assert.equal(JSON.parse(result.stdout).faultProfile,'compat-1');
  const events=fs.readFileSync(path.join(failures,'doflow/failures/events.jsonl'),'utf8');
  assert.match(events, /"kind":"fault-profile-unknown"/);
});

BRIDGE_TEST('--emit native renders blocking outcomes for every IC-012 native response and hides stub stderr', () => {
  const dir = makeTree();
  const cases = [
    ['claude','PreToolUse',{}], ['codex','PreToolUse',{}], ['gemini','BeforeTool',{}],
    ['kiro','PreToolUse',{}], ['antigravity','PreToolUse',{}], ['antigravity','Stop',{}],
    ['pi','tool_call',{}], ['claude','Stop',{}], ['codex','Stop',{}], ['kiro','Stop',{}], ['kiro','Stop',{}, {DOFLOW_KIRO_ENGINE:'v3'}],
  ];
  for (const [harness,event,input,env={}] of cases) {
    const p = path.join(dir, 'policies/pre-implementation-gate.sh');
    fs.writeFileSync(p, `#!/bin/bash\nprintf raw-secret >&2\nexit 2\n`);
    const result = run(dir, harness, event, 'pre-implementation-gate', input, ['--emit','native'], env);
    assert.notEqual(result.stdout + result.stderr, '', `${harness}:${event} has native block response`);
    assert.equal((result.stdout + result.stderr).includes('raw-secret'), false, `${harness}:${event} hides policy stderr`);
    assert.ok(Buffer.byteLength(FIXED) <= 80);
    if ((harness === 'claude' && event === 'PreToolUse') || (harness === 'codex' && event === 'PreToolUse')) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, FIXED);
    else if (harness === 'gemini' || harness === 'antigravity') assert.equal(JSON.parse(result.stdout).reason, FIXED);
    else if (harness === 'pi') assert.equal(JSON.parse(result.stdout).reason, FIXED);
    else if (harness === 'codex' && event === 'Stop') { assert.equal(result.stdout.trim(), '{}'); assert.ok(result.stderr.includes(FIXED)); }
    else if (harness === 'kiro' && event === 'Stop' && env.DOFLOW_KIRO_ENGINE === 'v3') assert.equal(JSON.parse(result.stdout).reason, FIXED);
    else assert.ok(result.stderr.includes(FIXED), `${harness}:${event} fixed reason on stderr`);
    const decision = run(dir,harness,event,'pre-implementation-gate',input,['--emit','decision'],env);
    const object = JSON.parse(decision.stdout);
    assert.equal(JSON.stringify(object).includes('raw-secret'),false,`${harness}:${event} decision hides policy stderr`);
    assert.equal(object.reason,object.code,`${harness}:${event} IC-008 error reason is code`);
  }
});

BRIDGE_TEST('--emit native covers every IC-012 bridge row and Kiro engine', () => {
  const dir = makeTree();
  const cases = [
    ['claude','PreToolUse','pre-implementation-gate'], ['claude','PreToolUse','pre-bash-guard'], ['claude','PreToolUse','mcp-tool-guard'],
    ['claude','SessionStart','session-context'], ['claude','UserPromptSubmit','user-prompt-submit'], ['claude','SubagentStart','subagent-audit'],
    ['claude','SubagentStop','subagent-audit'], ['claude','Stop','stop-check'],
    ['codex','PreToolUse','pre-implementation-gate'], ['codex','PreToolUse','pre-bash-guard'], ['codex','PreToolUse','mcp-tool-guard'],
    ['codex','SessionStart','session-context'], ['codex','UserPromptSubmit','user-prompt-submit'], ['codex','SubagentStart','subagent-audit'], ['codex','SubagentStop','subagent-audit'], ['codex','Stop','stop-check'],
    ['gemini','BeforeTool','pre-implementation-gate'], ['gemini','BeforeTool','pre-bash-guard'], ['gemini','BeforeTool','mcp-tool-guard'], ['gemini','SessionStart','session-context'],
    ['kiro','PreToolUse','pre-implementation-gate'], ['kiro','SessionStart','session-context'], ['kiro','agentSpawn','session-context'],
    ['kiro','Stop','stop-check'], ['kiro','Stop','stop-check',{DOFLOW_KIRO_ENGINE:'v3'}],
    ['antigravity','PreToolUse','pre-implementation-gate'], ['antigravity','PreToolUse','stop-check'], ['antigravity','Stop','pre-implementation-gate'], ['antigravity','Stop','stop-check'],
    ['pi','tool_call','pre-implementation-gate'], ['pi','tool_call','pre-bash-guard'], ['pi','tool_call','mcp-tool-guard'],
  ];
  for (const [harness,event,policy,env={}] of cases) {
    const result = run(dir,harness,event,policy,{},['--emit','native'],env);
    assert.equal(result.status,0,`${harness}:${event}:${policy} ${result.stderr}`);
    if (harness === 'codex' && event === 'Stop') assert.equal(result.stdout.trim(),'{}');
    if (harness === 'antigravity' && event === 'PreToolUse') assert.equal(result.stdout.trim(),' {"decision":"allow"}'.trim());
    if (harness === 'pi' && event === 'tool_call') assert.equal(result.stdout,'');
  }
});

BRIDGE_TEST('Kiro agent camelCase events share IDE effects and rendering while traces retain native names', () => {
  const dir = makeTree();
  const policy = path.join(dir, 'policies/pre-implementation-gate.sh');
  const cases = [
    {
      event: 'preToolUse', status: 2, body: '#!/bin/bash\necho private >&2\nexit 2\n',
      stderr: `${FIXED}`, stdout: '',
    },
    {
      event: 'PreToolUse', status: 2, body: '#!/bin/bash\necho private >&2\nexit 2\n',
      stderr: `${FIXED}`, stdout: '',
    },
    {
      event: 'preToolUse', status: 1, body: '#!/bin/bash\necho private >&2\nexit 1\n',
      stderr: FIXED, stdout: '',
    },
  ];
  for (const row of cases) {
    fs.writeFileSync(policy, row.body);
    const result = run(dir, 'kiro', row.event, 'pre-implementation-gate');
    assert.equal(result.status, row.status, `${row.event} preserves Kiro PreToolUse status`);
    assert.equal(result.stdout, row.stdout, `${row.event} native stdout`);
    assert.equal(result.stderr, row.stderr, `${row.event} renders fixed reason without extra newline`);
    assert.equal(result.stderr.includes('private'), false, `${row.event} hides stub stderr`);
  }

  const trace = path.join(dir, 'agent-stop-trace.jsonl');
  fs.writeFileSync(path.join(dir, 'policies/stop-check.sh'), `#!/bin/bash\nprintf '{"x":1}\\n'\nprintf '\\036%s\\n' '{"outcome":"deny","code":"unfinished-work","policyVersion":1}' >&3\necho stop-reason >&2\nexit 2\n`);
  const stop = run(dir, 'kiro', 'stop', 'stop-check', {}, [], { DOFLOW_KIRO_ENGINE: '2x', DOFLOW_BRIDGE_TRACE: trace });
  assert.equal(stop.status, 2, 'agent stop alias selects Kiro Stop block effect');
  assert.equal(stop.stdout, '', 'Kiro Stop always discards policy stdout');
  assert.equal(stop.stderr, 'stop-reason', 'agent stop alias renders the real deny reason');
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8')).event, 'stop', 'trace keeps the native event verbatim');

  const sessionTrace = path.join(dir, 'agent-session-trace.jsonl');
  fs.writeFileSync(path.join(dir, 'policies/session-context.sh'), '#!/bin/bash\nexit 0\n');
  const session = run(dir, 'kiro', 'agentSpawn', 'session-context', {}, [], { DOFLOW_BRIDGE_TRACE: sessionTrace });
  assert.equal(session.status, 0, 'agentSpawn alias renders SessionStart behavior');
  assert.equal(JSON.parse(fs.readFileSync(sessionTrace, 'utf8')).event, 'agentSpawn', 'session trace keeps native event');
});

BRIDGE_TEST('sourced bridge survives set -euo pipefail; jq and node process counts, trace and decode edge cases', () => {
  const dir = makeTree();
  const errorDir = makeTree('#!/bin/bash\nprintf raw-secret >&2\nexit 2\n');
  const sourced = spawnSync('bash', ['-c', `set -euo pipefail; . "${path.join(errorDir, 'bridge/bridge.sh')}"; if doflow_bridge claude PreToolUse pre-implementation-gate </dev/null; then code=0; else code=$?; fi; printf 'AFTER:%s' "$code"`], { encoding: 'utf8' });
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.match(sourced.stdout, /permissionDecisionReason/);
  assert.match(sourced.stdout, /AFTER:0/);
  assert.equal(sourced.stderr.includes('raw-secret'), false);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const realJq = spawnSync('which', ['jq'], { encoding:'utf8' }).stdout.trim();
  const counts = path.join(dir, 'counts');
  for (const cmd of ['jq','node']) {
    const real = cmd === 'jq' ? realJq : spawnSync('which',['node'],{encoding:'utf8'}).stdout.trim();
    fs.writeFileSync(path.join(bin,cmd), `#!/bin/bash\nprintf '${cmd}\\n' >> '${counts}'\nexec '${real}' "$@"\n`); fs.chmodSync(path.join(bin,cmd),0o755);
  }
  const ok = run(dir,'claude','PreToolUse','session-context',{},['--emit','native'],{PATH:`${bin}:${process.env.PATH}`});
  assert.equal(ok.status,0,ok.stderr);
  const calls=fs.readFileSync(counts,'utf8').trim().split('\n');
  assert.equal(calls.filter(x=>x==='jq').length,1,'one jq for allow');
  assert.equal(calls.includes('node'),false,'no node in bridge');
  const trace=path.join(dir,'trace');
  run(dir,'claude','PreToolUse','session-context',{},['--emit','decision']); assert.equal(fs.existsSync(trace),false);
  run(dir,'claude','PreToolUse','session-context',{},['--emit','decision'],{DOFLOW_BRIDGE_TRACE:trace}); assert.equal(fs.existsSync(trace),true);
  const capture=path.join(dir,'captured');
  const nonobject=makeTree(`#
#!/bin/bash
cat > '${capture}'
exit 0
`);
  run(nonobject,'claude','PreToolUse','session-context','17'); assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')), { doflow_event: { version: 1, harness: 'claude', event: 'PreToolUse', operation: 'tool' } });

  const noJqTree=makeTree();
  const noJqBin=path.join(noJqTree,'no-jq-bin'); fs.mkdirSync(noJqBin);
  for (const cmd of ['bash','cat','dirname','date','mkdir','mktemp','rm','tr']) {
    const executable=spawnSync('which',[cmd],{encoding:'utf8'}).stdout.trim();
    fs.symlinkSync(executable,path.join(noJqBin,cmd));
  }
  const config=path.join(noJqTree,'config');
  const noJq=spawnSync('bash',[path.join(noJqTree,'bridge/bridge.sh'),'claude','PreToolUse','pre-implementation-gate'],{
    cwd:noJqTree,encoding:'utf8',input:'{}',env:{...process.env,PATH:noJqBin,DOFLOW_FAILURE_CAPTURE:'on',XDG_CONFIG_HOME:config},
  });
  assert.equal(noJq.status,0,noJq.stderr);
  assert.equal(noJq.stdout,'','jq absent preserves front-door silent allow');
  assert.equal(noJq.stderr,'','jq absent allow has no model-visible diagnostic');
  const noJqEvents=fs.readFileSync(path.join(config,'doflow/failures/events.jsonl'),'utf8');
  assert.match(noJqEvents, /"kind":"dependency-missing:jq"/);
});

BRIDGE_TEST('DEC-006 preserves a caller-set DOFLOW_AGENT across all six bridges', () => {
  const dir = makeTree(`#!/bin/bash\nprintf '%s' "$DOFLOW_AGENT" > "$AGENT_CAPTURE"\nprintf '\\036%s\\n' '{"v":1,"policy":"pre-implementation-gate","policyVersion":1,"outcome":"allow","code":"allow"}' >&3\nexit 0\n`);
  const harnesses = ['claude', 'codex', 'gemini', 'kiro', 'antigravity', 'pi'];
  for (const harness of harnesses) {
    const capture = path.join(dir, `agent-${harness}`);
    const unset = run(dir, harness, 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision'], { DOFLOW_AGENT: null, AGENT_CAPTURE: capture });
    assert.equal(unset.status, 0, `${harness}: unset caller value exits cleanly`);
    assert.equal(fs.readFileSync(capture, 'utf8'), harness, `${harness}: unset DOFLOW_AGENT defaults to harness id`);

    const callerValue = `caller-${harness}`;
    const set = run(dir, harness, 'PreToolUse', 'pre-implementation-gate', {}, ['--emit', 'decision'], { DOFLOW_AGENT: callerValue, AGENT_CAPTURE: capture });
    assert.equal(set.status, 0, `${harness}: set caller value exits cleanly`);
    assert.equal(fs.readFileSync(capture, 'utf8'), callerValue, `${harness}: caller-set DOFLOW_AGENT passes through`);
  }
});
