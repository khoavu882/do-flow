'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { suiteTempDir } = require('../../helper/tmp');
const { planPiHooks, removePiHooks, targetPath, ASSET_ID, OWNERSHIP } = require('../../../src/adapters/pi/hooks.ts');
const { fingerprint } = require('../../../src/adapters/copy-tree.ts');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE = path.join(ROOT, 'core/harnesses/pi/extensions/doflow-guard.js');
const ASSETS = [{ id: ASSET_ID }];

async function loadExtension(t, bridgePath) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const source = template.replace(
    "const BRIDGE = new URL('../../shared/hooks/bridge/bridge.sh', import.meta.url);",
    `const BRIDGE = new URL(${JSON.stringify(pathToFileURL(bridgePath).href)});`,
  );
  assert.notEqual(source, template, 'test bridge path substitution happened');
  let handler;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { default: register } = await import(moduleUrl);
  register({ on(name, callback) { assert.equal(name, 'tool_call'); handler = callback; } });
  return handler;
}

function bridgeTree(t, { stdout = '' } = {}) {
  const root = suiteTempDir('doflow-pi-hardening-');
  const bridgeDir = path.join(root, 'bridge');
  const policyDir = path.join(root, 'policies');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(policyDir, { recursive: true });
  const bridgePath = path.join(bridgeDir, 'bridge.sh');
  fs.writeFileSync(bridgePath, `#!/bin/sh\ncat > ${JSON.stringify(path.join(root, 'payload.json'))}\nprintf '%s' ${JSON.stringify(stdout)}\n`);
  fs.chmodSync(bridgePath, 0o755);
  const capturePath = path.join(policyDir, 'capture-failure.sh');
  const logPath = path.join(root, 'captures.log');
  fs.writeFileSync(capturePath, `#!/bin/bash\nprintf '%s %s\\n' "$2" "$3" >> ${JSON.stringify(logPath)}\n`);
  fs.chmodSync(capturePath, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, bridgePath, logPath, payloadPath: path.join(root, 'payload.json') };
}

async function waitForLines(filename, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8').trim().split('\n').length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${expected} capture record(s)`);
}

test('Pi tool_call serializes a null session id when sessionManager is absent', async (t) => {
  const tree = bridgeTree(t);
  const handler = await loadExtension(t, tree.bridgePath);
  const previous = process.env.DOFLOW_FAULT_PROFILE;
  delete process.env.DOFLOW_FAULT_PROFILE;
  t.after(() => {
    if (previous === undefined) delete process.env.DOFLOW_FAULT_PROFILE;
    else process.env.DOFLOW_FAULT_PROFILE = previous;
  });

  assert.equal(await handler({ type: 'tool_call', toolName: 'edit', input: { path: 'src/a.js' } }, { cwd: tree.root }), undefined);
  assert.equal(JSON.parse(fs.readFileSync(tree.payloadPath, 'utf8')).sessionId, null);
  assert.equal(fs.existsSync(tree.logPath), false);
});

test('Pi captures an unknown fault profile once for each routed call', async (t) => {
  const tree = bridgeTree(t);
  const handler = await loadExtension(t, tree.bridgePath);
  const previous = process.env.DOFLOW_FAULT_PROFILE;
  process.env.DOFLOW_FAULT_PROFILE = 'future-profile';
  t.after(() => {
    if (previous === undefined) delete process.env.DOFLOW_FAULT_PROFILE;
    else process.env.DOFLOW_FAULT_PROFILE = previous;
  });

  assert.equal(await handler({ type: 'tool_call', toolName: 'edit', input: {} }, { cwd: tree.root }), undefined);
  await waitForLines(tree.logPath, 1);
  assert.deepEqual(fs.readFileSync(tree.logPath, 'utf8').trim().split('\n'), ['pre-implementation-gate fault-profile-unknown']);
});

test('Pi remove uses its single owned ledger target if PI_CODING_AGENT_DIR is absent', () => {
  const home = suiteTempDir('doflow-pi-remove-override-');
  const agentDir = path.join(home, 'alternate-agent');
  const installEnv = { PI_CODING_AGENT_DIR: agentDir };
  const target = targetPath(home, installEnv);
  const content = 'owned extension\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  const ledger = { resources: [{ harness: 'pi', assetId: ASSET_ID, ownershipIdentity: OWNERSHIP, target, fingerprint: fingerprint(content) }] };
  const result = planPiHooks({ scope: 'user', scopeRoot: home, assets: ASSETS, ledger,
    context: { operation: 'remove' }, env: {} });

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].target, target);
  assert.equal(removePiHooks(result.changes), 1);
  assert.equal(fs.existsSync(target), false);
});
