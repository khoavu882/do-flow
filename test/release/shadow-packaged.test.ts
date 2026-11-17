'use strict';

// Row 174 R-01: a shadow decision-model call works in the published package, where every source is `.js`. The package
// is built the way the release gate builds it (buildPackage), the PACKED dispatcher is required, and one shadow call
// runs against a fake decision server on an ephemeral port with HOME and XDG_CONFIG_HOME in a temp dir, so no real
// model is reached. The detached child must start from the packed tree and write its pick record.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPackage } = require('../../src/release/build-package.ts');
const { tempDir } = require('../helper/tmp.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');

async function waitFor(check: () => any, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** Builds the package into a temp dir and returns the packed modules a shadow call needs, a fake model and a store. */
async function packedShadow(t: any) {
  const dir = tempDir(t, 'doflow-shadow-packaged-');
  const packed = buildPackage(path.join(dir, 'package'));
  const dispatcher = path.join(packed, 'src/runtime/advice/shadow-dispatcher.js');
  assert.ok(fs.existsSync(dispatcher), 'the packed dispatcher exists');
  const { interceptDecisionPoint } = require(dispatcher);
  const { loadStorageRegistry } = require(path.join(packed, 'src/runtime/storage/registry.js'));
  const { resolveRoots } = require(path.join(packed, 'src/runtime/storage/roots.js'));
  const { readWindow } = require(path.join(packed, 'src/runtime/advice/record.js'));
  const { loadAdviceRegistry } = require(path.join(packed, 'src/runtime/advice/registry.js'));
  const { materializeKind } = require(path.join(packed, 'src/runtime/advice/kinds.js'));

  const fake: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering(() => 'frontier') } });
  t.after(() => fake.close());
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot);
  const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: packed }), projectRoot, env });
  fs.mkdirSync(roots['config-home'], { recursive: true });
  fs.writeFileSync(path.join(roots['config-home'], 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': fake.origin, 'advice.model': 'clef-flash',
  }));
  const adviceRegistry = loadAdviceRegistry({ repoRoot: packed }).registry;
  const state = 'Implement an integration spanning several runtime modules.';
  const question = materializeKind('tier', { adviceRegistry }).question;
  return {
    packed,
    asks: () => fake.requests.filter((request: any) => request.pathname === '/v1/systemone').length,
    lines: () => readWindow({ roots }).records.map((entry: any) => entry.record),
    call: () => interceptDecisionPoint({
      kind: 'tier', caller: 'brief-tools', state, staticPick: 'light', taskId: 'task-packaged',
      questionSet: { state, questions: [question] }, adviceRegistry, projectRoot, env,
    }, { roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } }),
  };
}

test('R-01: a shadow call from the packed package starts its detached child and records a pick', async (t) => {
  const p = await packedShadow(t);
  const res = await p.call();
  assert.equal(res.mode, 'shadow');
  const lines = await waitFor(() => (p.lines().length ? p.lines() : null));
  assert.deepEqual((lines || []).map((line: any) => [line.type, line.mode, line.pick, line.reason]), [['pick', 'shadow', 'frontier', undefined]],
    'the packed child started and recorded its pick');
  assert.equal(p.asks(), 1);
});

test('R-01: with the runner missing from the package, the call records a spawn-failed miss before it returns', async (t) => {
  const p = await packedShadow(t);
  fs.rmSync(path.join(p.packed, 'src/runtime/advice/shadow-runner.js'));
  const res = await p.call();
  assert.equal(res.mode, 'shadow');
  assert.deepEqual(p.lines().map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'shadow', 'spawn-failed']]);
  assert.equal(p.asks(), 0);
});

test('R-01: a child that cannot load the modules it asks with records a spawn-failed miss, never silence', async (t) => {
  const p = await packedShadow(t);
  // This process has loaded the client already; the detached child loads it fresh and fails.
  fs.writeFileSync(path.join(p.packed, 'src/runtime/advice/client.js'), "throw new Error('broken module');\n");
  const res = await p.call();
  assert.equal(res.mode, 'shadow');
  const lines = await waitFor(() => (p.lines().length ? p.lines() : null));
  assert.deepEqual((lines || []).map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'shadow', 'spawn-failed']]);
  assert.equal(p.asks(), 0);
});
