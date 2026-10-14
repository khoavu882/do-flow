'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = path.join(ROOT, 'core/harnesses/pi/extensions/doflow-guard.js');
const CORPUS = path.join(ROOT, 'test/fixtures/hooks/pi/tool_call');
function loadExtension(t, bridgePath) {
  const source = fs.readFileSync(TEMPLATE, 'utf8').replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(bridgePath).href)});`,
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  let handler;
  const pi = { on(name, callback) { assert.equal(name, 'tool_call'); handler = callback; } };
  return import(moduleUrl).then(({ default: register }) => {
    register(pi);
    assert.equal(typeof handler, 'function');
    return handler;
  });
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
  for (const name of ['edit-deny', 'edit-allow', 'write-deny', 'bash-deny', 'bash-allow', 'nested-mcp-deny', 'read', 'perf-edit', 'perf-bash', 'perf-mcp']) {
    assert.ok(cases.includes(name), `fixture exists: ${name}`);
    const row = fixture(name);
    assert.ok(row.native && row.expect && Object.hasOwn(row, 'policy'), `${name} is a complete IC-028 row`);
  }
});

test('every corpus case matches its expected result and policy route', async (t) => {
  const names = fs.readdirSync(CORPUS).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
  names.unshift(names.splice(names.indexOf('nested-mcp-deny'), 1)[0]);
  for (const name of names) {
    const row = fixture(name);
    const dir = tempDir(t, 'doflow-pi-route-');
    const argFile = path.join(dir, 'args');
    const inputFile = path.join(dir, 'input.json');
    const shim = bridgeShim(t, { stdout: row.expect.result?.block ? '{"block":true,"reason":"denied"}' : '', recordArgs: argFile, recordInput: inputFile });
    const handler = await loadExtension(t, shim);
    const input = deepFreeze(row.native.input);
    const event = Object.freeze({ ...row.native, input });
    const result = await handler(event, context('/tmp'));
    if (row.expect.result?.block) assert.deepEqual(result, { block: true, reason: 'denied' }, name);
    else assert.equal(result, undefined, name);
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

test('read, grep, find, ls and powershell do not spawn a bridge', async (t) => {
  const dir = tempDir(t, 'doflow-pi-unrouted-');
  const args = path.join(dir, 'args');
  const handler = await loadExtension(t, bridgeShim(t, { recordArgs: args, root: dir }));
  for (const [index, toolName] of ['read', 'grep', 'find', 'ls', 'powershell'].entries()) {
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
  const handler = await loadExtension(t, missing);
  assert.equal(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'spawn', input: { command: 'true' } }, context('/tmp')), undefined);
  assert.equal(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'sync-spawn', input: { command: 'true' } }, context(42)), undefined);
  for (let attempt = 0; attempt < 100 && !fs.existsSync(captureLog); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(captureLog, 'utf8'), /pre-bash-guard bridge-spawn/);

  const slow = bridgeShim(t, { delay: 10, root: bridgeDir });
  const timeoutHandler = await loadExtension(t, slow);
  assert.equal(await timeoutHandler({ type: 'tool_call', toolName: 'bash', toolCallId: 'timeout', input: { command: 'true' } }, context('/tmp')), undefined);
  for (let attempt = 0; attempt < 100 && !fs.readFileSync(captureLog, 'utf8').includes('bridge-timeout'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(captureLog, 'utf8'), /pre-bash-guard bridge-timeout/);
});

test('strict-1 blocks a bridge spawn failure with the fixed reason', async (t) => {
  const old = process.env.DOFLOW_FAULT_PROFILE;
  process.env.DOFLOW_FAULT_PROFILE = 'strict-1';
  t.after(() => { if (old === undefined) delete process.env.DOFLOW_FAULT_PROFILE; else process.env.DOFLOW_FAULT_PROFILE = old; });
  const handler = await loadExtension(t, path.join(tempDir(t, 'doflow-pi-strict-'), 'absent.sh'));
  assert.deepEqual(await handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'strict', input: { command: 'true' } }, context('/tmp')), {
    block: true,
    reason: '[pre-bash-guard] DoFlow policy error; details: doflow-run failure list',
  });
});

test('an abort signal kills the active child process', async (t) => {
  const dir = tempDir(t, 'doflow-pi-abort-');
  const pidFile = path.join(dir, 'child.pid');
  const shim = bridgeShim(t, { delay: 10, backgroundPid: pidFile, root: dir });
  const handler = await loadExtension(t, shim);
  const controller = new AbortController();
  const running = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'abort', input: { command: 'true' } }, context('/tmp', controller.signal));
  for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile), 'bridge child started');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  setTimeout(() => controller.abort(), 30);
  assert.equal(await running, undefined);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

