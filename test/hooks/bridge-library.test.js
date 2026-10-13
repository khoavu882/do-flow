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
  return spawnSync('bash', [path.join(dir, 'bridge/bridge.sh'), harness, event, policy, ...args], {
    cwd: dir, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, DOFLOW_FAILURE_CAPTURE: 'off', ...env },
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
    ['antigravity', 'PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/a' } }, workspacePaths: ['/repo'], cwd: '/ignored' }, 'edit', ['/repo/a'], 'test/adapters/antigravity/adapter.test.js'],
    ['pi', 'tool_call', JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/hooks/pi/tool_call/edit.json'), 'utf8')), 'edit', ['/repo/a'], 'test/fixtures/hooks/pi/tool_call/edit.json'],
  ];
  for (const [harness, event, native, operation, paths, source] of cases) {
    assert.ok(fs.existsSync(path.join(ROOT, source)), `${harness} fixture source exists: ${source}`);
    const payload = { ...native, unknown_field: 'ignored' };
    const decoded = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', 'session-context', '-f', path.join(dir, 'bridge/envelope.jq')], { input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const value = JSON.parse(decoded.stdout).doflow_event;
    assert.equal(value.version, 1, harness);
    assert.equal(value.operation, operation, harness);
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
  for (const profile of ['compat-1','strict-1']) {
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
      assert.equal(JSON.parse(result.stdout).effect,expected,`${profile} ${b.h}:${b.e} ${scenario}`);
    }
  }
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
  run(nonobject,'claude','PreToolUse','session-context','17'); assert.equal(fs.readFileSync(capture,'utf8').trim(),'17');
});
