'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = path.join(ROOT, 'core/harnesses/pi/extensions/doflow-guard.js');
const CORPUS = path.join(ROOT, 'test/fixtures/hooks/pi/tool_call');
function loadExtension(t, bridgePath) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const source = template.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(bridgePath).href)});`,
  );
  assert.notEqual(source, template, 'test bridge path substitution happened');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  let handler;
  const pi = { on(name, callback) { assert.equal(name, 'tool_call'); handler = callback; } };
  return import(moduleUrl).then(({ default: register }) => {
    register(pi);
    assert.equal(typeof handler, 'function');
    return handler;
  });
}

function installPiTree(repo, t) {
  const sharedSource = path.join(ROOT, 'core/harnesses/shared/hooks');
  const sharedTarget = path.join(repo, '.doflow/shared/hooks');
  fs.mkdirSync(path.dirname(sharedTarget), { recursive: true });
  fs.cpSync(sharedSource, sharedTarget, { recursive: true });
  const extensionDir = path.join(repo, '.pi/extensions');
  fs.mkdirSync(extensionDir, { recursive: true });
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const rendered = template.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    "const BRIDGE = new URL('../../.doflow/shared/hooks/bridge/bridge.sh', import.meta.url);",
  );
  assert.notEqual(rendered, template, 'install-shaped bridge path substitution happened');
  const extensionPath = path.join(extensionDir, 'doflow-guard.js');
  fs.writeFileSync(extensionPath, rendered);
  t.after(() => fs.rmSync(path.join(repo, '.pi'), { recursive: true, force: true }));
  return extensionPath;
}

function makePolicyRepo(t, state) {
  const repo = tempDir(t, 'doflow-pi-real-bridge-');
  execFileSync('git', ['init', '-b', 'feat/pi-gate', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'DoFlow test']);
  if (state !== 'none') {
    const featureDir = path.join(repo, 'agent-docs/doflow/pi-gate');
    fs.mkdirSync(featureDir, { recursive: true });
    if (state === 'all-artifacts') {
      fs.writeFileSync(path.join(featureDir, 'requirement.md'), '# Requirement\n');
      fs.writeFileSync(path.join(featureDir, 'design.md'), '# Design\n');
      fs.writeFileSync(path.join(featureDir, 'plan.md'), '# Plan\n');
    } else if (state === 'no-plan') {
      fs.writeFileSync(path.join(featureDir, 'requirement.md'), '# Requirement\n');
      fs.writeFileSync(path.join(featureDir, 'design.md'), '# Design\n');
    }
  }
  return repo;
}

function decisionTrace(t, repo) {
  const trace = path.join(repo, 'bridge-decisions.jsonl');
  const previous = process.env.DOFLOW_BRIDGE_TRACE;
  process.env.DOFLOW_BRIDGE_TRACE = trace;
  t.after(() => {
    if (previous === undefined) delete process.env.DOFLOW_BRIDGE_TRACE;
    else process.env.DOFLOW_BRIDGE_TRACE = previous;
  });
  return trace;
}

async function waitForText(filename, text) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8').includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${text} in ${filename}`);
}

function captureRecorder(root) {
  const policies = path.join(root, 'policies');
  fs.mkdirSync(policies, { recursive: true });
  const log = path.join(root, 'captures.log');
  const script = path.join(policies, 'capture-failure.sh');
  fs.writeFileSync(script, `#!/bin/bash\nprintf '%s %s\\n' "$2" "$3" >> ${JSON.stringify(log)}\n`);
  fs.chmodSync(script, 0o755);
  return log;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(CORPUS, `${name}.json`), 'utf8'));
}

function context(cwd, signal) {
  return { cwd, signal, sessionManager: { getSessionId: () => 'pi-session' } };
}

function bridgeShim(t, { stdout = '', status = 0, stderr = '', delay = 0, recordArgs, recordInput, backgroundPid, root } = {}) {
  const dir = root || tempDir(t, 'doflow-pi-bridge-shim-');
  const filename = path.join(dir, 'bridge.sh');
  fs.writeFileSync(filename, `#!/bin/bash\n${recordArgs ? `printf '%s\\n' "$*" > ${JSON.stringify(recordArgs)}\n` : ''}cat ${recordInput ? `> ${JSON.stringify(recordInput)}` : '>/dev/null'}\n${backgroundPid ? `sleep ${delay || 10} & echo $! > ${JSON.stringify(backgroundPid)}; wait\n` : delay ? `sleep ${delay}\n` : ''}printf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`);
  fs.chmodSync(filename, 0o755);
  return filename;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function emitToolCall(handlers, event, ctx) {
  for (const handler of handlers) {
    try {
      const result = await handler(event, ctx);
      if (result?.block) return result;
    } catch (error) {
      return { block: true, reason: error.message };
    }
  }
  return undefined;
}

test('corpus fixtures cover each routed policy and the no-spawn read', () => {
  const cases = fs.readdirSync(CORPUS).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  for (const name of ['edit-deny', 'edit-allow', 'write-deny', 'write-allow', 'bash-deny', 'bash-allow', 'nested-mcp-deny', 'read', 'perf-edit', 'perf-bash', 'perf-mcp']) {
    assert.ok(cases.includes(name), `fixture exists: ${name}`);
    const row = fixture(name);
    assert.ok(row.native && row.expect && Object.hasOwn(row, 'policy'), `${name} is a complete IC-028 row`);
    assert.ok(row.env && Object.hasOwn(row, 'fault') && Object.hasOwn(row.expect, 'decision'), `${name} carries Pi IC-028 env, fault and decision fields`);
  }
});

test('corpus fixtures route through the extension and preserve the serialized call', async (t) => {
  const names = fs.readdirSync(CORPUS).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
  names.unshift(names.splice(names.indexOf('nested-mcp-deny'), 1)[0]);
  for (const name of names) {
    const row = fixture(name);
    const dir = tempDir(t, 'doflow-pi-route-');
    const argFile = path.join(dir, 'args');
    const inputFile = path.join(dir, 'input.json');
    const shim = bridgeShim(t, { recordArgs: argFile, recordInput: inputFile });
    const handler = await loadExtension(t, shim);
    const input = deepFreeze(row.native.input);
    const event = Object.freeze({ ...row.native, input });
    const result = await handler(event, context('/tmp'));
    assert.equal(result, undefined, `${name} route-only shim has no response`);
    if (row.policy) assert.equal(fs.readFileSync(argFile, 'utf8').trim(), `pi tool_call ${row.policy}`, `${name} bridge route`);
    else assert.equal(row.expect.spawn, false, `${name} stays local`);
    if (row.policy) {
      assert.deepEqual(JSON.parse(fs.readFileSync(inputFile, 'utf8').trim()), {
        type: row.native.type,
        toolName: row.native.toolName,
        toolCallId: row.native.toolCallId,
        ...(row.native.parentToolCallId ? { parentToolCallId: row.native.parentToolCallId } : {}),
        input: row.native.input,
        cwd: '/tmp',
        sessionId: 'pi-session',
      }, `${name} serialized payload`);
    }
    assert.deepEqual(event.input, row.native.input, `${name} input retained`);
  }
});

test('installed Pi extension drives the real bridge and policies in fixture-selected repo states', async (t) => {
  const cases = ['edit-deny', 'edit-allow', 'write-deny', 'write-allow', 'bash-deny', 'nested-mcp-deny'];
  for (const name of cases) {
    await t.test(name, async (subtest) => {
      const row = fixture(name);
      const repo = makePolicyRepo(subtest, row.state);
      const extensionPath = installPiTree(repo, subtest);
      const trace = decisionTrace(subtest, repo);
      const previousProfile = process.env.DOFLOW_FAULT_PROFILE;
      process.env.DOFLOW_FAULT_PROFILE = row.env.DOFLOW_FAULT_PROFILE;
      subtest.after(() => {
        if (previousProfile === undefined) delete process.env.DOFLOW_FAULT_PROFILE;
        else process.env.DOFLOW_FAULT_PROFILE = previousProfile;
      });
      if (name === 'nested-mcp-deny') {
        fs.appendFileSync(path.join(repo, '.doflow/shared/hooks/policies/mcp-policy.conf'), 'github__delete_issue\tPi fixture MCP deny\n');
      }
      let handler;
      const pi = { on(event, callback) { assert.equal(event, 'tool_call'); handler = callback; } };
      const { default: register } = await import(pathToFileURL(extensionPath).href);
      register(pi);
      assert.equal(typeof handler, 'function');
      const event = row.native;
      const result = await handler(event, context(repo));
      if (row.expect.result === null) assert.equal(result, undefined);
      else {
        assert.equal(result?.block, true);
        assert.equal(result?.reason, row.expect.result.reason);
      }
      await waitForText(trace, '"outcome"');
      const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
      assert.deepEqual(
        { outcome: decision.outcome, code: decision.code, effect: decision.effect },
        row.expect.decision,
      );
      assert.equal(decision.harness, 'pi');
      assert.equal(decision.event, 'tool_call');
    });
  }
});

test('frozen event input, including nested calls, is never changed', async (t) => {
  const dir = tempDir(t, 'doflow-pi-frozen-');
  const argFile = path.join(dir, 'args');
  const handler = await loadExtension(t, bridgeShim(t, { recordArgs: argFile, root: dir }));
  const input = deepFreeze({ path: 'src/a.js', content: 'x', metadata: { nested: ['unchanged'] } });
  const event = Object.freeze({ type: 'tool_call', toolName: 'edit', toolCallId: 'outer/1', parentToolCallId: 'outer', input });
  const before = JSON.stringify(event);
  await handler(event, context('/tmp'));
  assert.equal(fs.readFileSync(argFile, 'utf8').trim(), 'pi tool_call pre-implementation-gate');
  assert.equal(JSON.stringify(event), before);
});

test('simulated Pi dispatch stops at the first block and treats thrown handlers as blocks', async (t) => {
  const handler = await loadExtension(t, bridgeShim(t, { stdout: '{"block":true,"reason":"denied"}' }));
  let laterHandlerCalls = 0;
  const event = { type: 'tool_call', toolName: 'bash', toolCallId: 'dispatch', input: { command: 'true' } };
  assert.deepEqual(await emitToolCall([handler, async () => { laterHandlerCalls += 1; }], event, context('/tmp')), {
    block: true,
    reason: 'denied',
  });
  assert.equal(laterHandlerCalls, 0);
  assert.deepEqual(await emitToolCall([async () => { throw new Error('handler failed'); }], event, context('/tmp')), {
    block: true,
    reason: 'handler failed',
  });
});

test('read, grep, find, ls, powershell and non-string tool names do not spawn a bridge', async (t) => {
  const dir = tempDir(t, 'doflow-pi-unrouted-');
  const args = path.join(dir, 'args');
  const handler = await loadExtension(t, bridgeShim(t, { recordArgs: args, root: dir }));
  for (const [index, toolName] of ['read', 'grep', 'find', 'ls', 'powershell', 42].entries()) {
    assert.equal(await handler({ type: 'tool_call', toolName, toolCallId: `unrouted-${index}`, input: {} }, context('/tmp')), undefined, toolName);
  }
  assert.equal(fs.existsSync(args), false);
});

test('spawn errors and timeout proceed and request detached failure capture', async (t) => {
  const root = tempDir(t, 'doflow-pi-missing-');
  const bridgeDir = path.join(root, 'bridge');
  const policyDir = path.join(root, 'policies');
  fs.mkdirSync(bridgeDir);
  fs.mkdirSync(policyDir);
  const captureLog = path.join(root, 'captured');
  const capture = path.join(policyDir, 'capture-failure.sh');
  fs.writeFileSync(capture, `#!/bin/bash\nprintf '%s %s\\n' "$2" "$3" >> ${JSON.stringify(captureLog)}\n`);
  fs.chmodSync(capture, 0o755);
  const missing = path.join(bridgeDir, 'bridge.sh');
  fs.writeFileSync(missing, 'exit 7\n');
  const handler = await loadExtension(t, missing);
  assert.equal(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'spawn', input: { command: 'true' } }, context('/tmp')), undefined);
  assert.equal(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'sync-spawn', input: { command: 'true' } }, context(42)), undefined);
  let captureContents = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(captureLog)) captureContents = fs.readFileSync(captureLog, 'utf8');
    if (captureContents.endsWith('\n') && captureContents.includes('pre-bash-guard bridge-spawn')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(captureContents.endsWith('\n'), 'spawn capture is a complete line');
  assert.match(captureContents, /pre-bash-guard bridge-spawn/);

  const slow = bridgeShim(t, { delay: 10, root: bridgeDir });
  const timeoutHandler = await loadExtension(t, slow);
  assert.equal(await timeoutHandler({ type: 'tool_call', toolName: 'bash', toolCallId: 'timeout', input: { command: 'true' } }, context('/tmp')), undefined);
  for (let attempt = 0; attempt < 100 && !fs.readFileSync(captureLog, 'utf8').includes('bridge-timeout'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(captureLog, 'utf8'), /pre-bash-guard bridge-timeout/);
});

test('a missing bridge blocks routed tool calls and captures bridge-missing', async (t) => {
  const root = tempDir(t, 'doflow-pi-bridge-missing-');
  const captureLog = captureRecorder(root);
  const missing = path.join(root, 'bridge', 'bridge.sh');
  const handler = await loadExtension(t, missing);
  assert.deepEqual(await handler({ type: 'tool_call', toolName: 'edit', toolCallId: 'missing', input: {} }, context('/tmp')), {
    block: true,
    reason: '[doflow] shared hooks lack the bridge; run: doflow update -t pi',
  });
  await waitForText(captureLog, 'pre-implementation-gate bridge-missing');
  assert.deepEqual(fs.readFileSync(captureLog, 'utf8').trim().split('\n'), ['pre-implementation-gate bridge-missing']);
});

test('output overflow, non-zero exit and malformed bridge answer allow with one capture each', async (t) => {
  const cases = [
    ['output overflow', { stdout: 'x'.repeat(1024 * 1024 + 1) }, 'bridge-spawn'],
    ['non-zero exit', { status: 7 }, 'bridge-spawn'],
    ['malformed answer', { stdout: '{"block":false}\n' }, 'bridge-spawn'],
  ];
  for (const [name, options, point] of cases) {
    await t.test(name, async (subtest) => {
      const root = tempDir(subtest, 'doflow-pi-fault-');
      const captureLog = captureRecorder(root);
      const bridgeDir = path.join(root, 'bridge');
      fs.mkdirSync(bridgeDir);
      const bridge = bridgeShim(subtest, { ...options, root: bridgeDir });
      const handler = await loadExtension(subtest, bridge);
      const result = await handler({ type: 'tool_call', toolName: 'bash', toolCallId: name, input: { command: 'true' } }, context('/tmp'));
      assert.equal(result, undefined, 'compat-1 allows bridge faults');
      await waitForText(captureLog, `pre-bash-guard ${point}`);
      assert.deepEqual(fs.readFileSync(captureLog, 'utf8').trim().split('\n'), [`pre-bash-guard ${point}`]);
    });
  }
});

test('strict-1 blocks a bridge spawn failure with the fixed reason', async (t) => {
  const old = process.env.DOFLOW_FAULT_PROFILE;
  process.env.DOFLOW_FAULT_PROFILE = 'strict-1';
  t.after(() => { if (old === undefined) delete process.env.DOFLOW_FAULT_PROFILE; else process.env.DOFLOW_FAULT_PROFILE = old; });
  const missing = path.join(tempDir(t, 'doflow-pi-strict-'), 'absent.sh');
  fs.writeFileSync(missing, 'exit 7\n');
  const handler = await loadExtension(t, missing);
  assert.deepEqual(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'strict', input: { command: 'true' } }, context('/tmp')), {
    block: true,
    reason: '[pre-bash-guard] DoFlow policy error; details: doflow-run failure list',
  });
});

test('an abort signal kills the active child process', async (t) => {
  const dir = tempDir(t, 'doflow-pi-abort-');
  const captureLog = captureRecorder(dir);
  const bridgeDir = path.join(dir, 'bridge');
  fs.mkdirSync(bridgeDir);
  const pidFile = path.join(dir, 'child.pid');
  const shim = bridgeShim(t, { delay: 10, backgroundPid: pidFile, root: bridgeDir });
  const handler = await loadExtension(t, shim);
  const controller = new AbortController();
  const running = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'abort', input: { command: 'true' } }, context('/tmp', controller.signal));
  let pidContents = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(pidFile)) pidContents = fs.readFileSync(pidFile, 'utf8');
    if (pidContents.trim()) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pidContents.trim(), 'bridge child PID is written');
  const childPid = Number(pidContents.trim());
  setTimeout(() => controller.abort(), 30);
  assert.equal(await running, undefined);
  let reaped = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') reaped = true; else throw error; }
    if (reaped) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reaped, true, 'aborted bridge process was killed and reaped');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(captureLog), false, 'abort is not recorded as a bridge fault');
});

