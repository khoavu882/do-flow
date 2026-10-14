'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../../helper/tmp');
const { createPiAdapter } = require('../../../src/adapters/pi/index.ts');
const { planPiHooks, targetPath, OWNERSHIP, ASSET_ID } = require('../../../src/adapters/pi/hooks.ts');
const { updateLedger } = require('../../../src/lifecycle/index.ts');
const { fingerprint } = require('../../../src/adapters/copy-tree.ts');
const { defaultLedger } = require('../../../src/state/index.ts');

const ROOT = path.resolve(__dirname, '../../..');
const HOOKS = path.join(ROOT, 'core/harnesses/shared/hooks');
const ASSETS = [
  { id: 'hooks.shared', kind: 'hooks', source: 'core/harnesses/shared/hooks', renderer: 'copy-tree', capability: 'hooks', nativeDir: '../.doflow/shared/hooks' },
  { id: ASSET_ID, kind: 'hooks', source: 'core/harnesses/pi/extensions/doflow-guard.js', renderer: 'pi-guard-extension', capability: 'hooks' },
];

function tempHome() { return suiteTempDir('doflow-pi-hooks-'); }
function baseInput(home, { env = {}, operation = 'apply', scope = 'global', ledger = defaultLedger({ scope, scopeRoot: home }) } = {}) {
  return { scope, scopeRoot: home, assets: ASSETS, ledger, context: { repoRoot: ROOT, operation }, env };
}
function plan(adapter, input) {
  const discovery = adapter.discover(input);
  const result = adapter.plan({ ...input, discovery });
  return { discovery, result };
}
function install(adapter, input) {
  const { discovery, result } = plan(adapter, input);
  assert.deepEqual(result.conflicts, []);
  adapter.apply({ changes: result.changes });
  const plannedWrites = result.changes.filter((change) => change.operation === 'create' || change.operation === 'update').map((change) => change.target);
  const verification = adapter.verify({ ...input, discovery, context: { ...input.context, plannedWrites } });
  const ledger = updateLedger({ ledger: input.ledger, scope: input.scope, scopeRoot: input.scopeRoot,
    verifications: [{ ...verification, harness: 'pi' }], changes: result.changes, recoveryRef: 'pi-hooks-test' });
  return { discovery, result, verification, ledger };
}

test('pi guard extension installs at user scope beside a verified shared bridge tree', () => {
  const home = tempHome();
  const adapter = createPiAdapter({ env: {} });
  const input = baseInput(home);
  const userExtension = path.join(home, '.pi/agent/extensions/user-extension.js');
  fs.mkdirSync(path.dirname(userExtension), { recursive: true });
  fs.writeFileSync(userExtension, 'export default function userExtension() {}\n');
  const installed = install(adapter, input);
  const target = targetPath(home, {});
  assert.ok(fs.existsSync(target));
  assert.ok(fs.existsSync(path.join(home, '.doflow/shared/hooks/bridge/bridge.sh')));
  assert.match(fs.readFileSync(target, 'utf8'), /\.\.\/\.\.\/\.\.\/\.doflow\/shared\/hooks\/bridge\/bridge\.sh/);
  assert.ok(installed.ledger.resources.some((row) => row.assetId === ASSET_ID && row.target === target
    && row.ownershipIdentity === OWNERSHIP && row.fingerprint === fingerprint(fs.readFileSync(target, 'utf8'))));
  assert.equal(fs.existsSync(userExtension), true);

  const next = plan(adapter, { ...input, ledger: installed.ledger });
  assert.deepEqual(next.result.changes, []);
  assert.deepEqual(next.result.conflicts, []);
  const removal = plan(adapter, { ...input, context: { ...input.context, operation: 'remove' }, ledger: installed.ledger });
  adapter.remove({ changes: removal.result.changes });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(userExtension), true);
});

test('Pi user extensions survive install, update and remove at both scopes', () => {
  for (const scope of ['global', 'project']) {
    const root = tempHome();
    const adapter = createPiAdapter({ env: {} });
    const input = baseInput(root, { scope });
    const extensionDir = scope === 'global' ? path.join(root, '.pi/agent/extensions') : path.join(root, '.pi/extensions');
    const userExtension = path.join(extensionDir, 'user-extension.js');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(userExtension, 'export default function userExtension() {}\n');

    const installed = install(adapter, input);
    const updateInput = { ...input, ledger: installed.ledger, context: { ...input.context, operation: 'update' } };
    const update = plan(adapter, updateInput);
    assert.deepEqual(update.result.conflicts, [], `${scope} update has no conflict`);
    adapter.apply({ changes: update.result.changes });
    assert.equal(fs.readFileSync(userExtension, 'utf8'), 'export default function userExtension() {}\n', `${scope} user extension survives update`);

    const removal = plan(adapter, { ...input, ledger: installed.ledger, context: { ...input.context, operation: 'remove' } });
    adapter.remove({ changes: removal.result.changes });
    assert.equal(fs.readFileSync(userExtension, 'utf8'), 'export default function userExtension() {}\n', `${scope} user extension survives remove`);
  }
});

test('pi guard extension follows PI_CODING_AGENT_DIR for user install, verification and removal', () => {
  const home = tempHome();
  const agentDir = path.join(home, 'alternate-agent');
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const adapter = createPiAdapter({ env });
  const input = baseInput(home, { env });
  const installed = install(adapter, input);
  const target = path.join(agentDir, 'extensions/doflow-guard.js');
  assert.equal(fs.existsSync(target), true);
  const hookStatus = installed.verification.statuses.find((item) => item.assetId === ASSET_ID);
  assert.equal(hookStatus.piCodingAgentDir, agentDir);
  assert.equal(hookStatus.fingerprintMatches, false, 'first verification is recorded by lifecycle from its planned write');

  const verified = adapter.verify({ ...input, ledger: installed.ledger });
  const status = verified.statuses.find((item) => item.assetId === ASSET_ID);
  assert.equal(status.status, 'managed');
  assert.equal(status.fingerprintMatches, true);
  assert.equal(status.bridgePath, path.join(home, '.doflow/shared/hooks/bridge/bridge.sh'));
  assert.equal(status.bridgeExists, true);
  assert.equal(status.bash, true);
  assert.equal(status.jq, true);

  const removalInput = baseInput(home, { env, operation: 'remove', ledger: installed.ledger });
  const removal = plan(adapter, removalInput);
  assert.deepEqual(removal.result.conflicts, []);
  adapter.remove({ changes: removal.result.changes });
  assert.equal(fs.existsSync(target), false);
});

test('pi guard extension installs, verifies and removes at project scope with the shared ownership identity', () => {
  const root = tempHome();
  const adapter = createPiAdapter({ env: {} });
  const input = baseInput(root, { scope: 'project' });
  const installed = install(adapter, input);
  const target = path.join(root, '.pi/extensions/doflow-guard.js');
  assert.equal(fs.existsSync(target), true);
  assert.ok(fs.existsSync(path.join(root, '.doflow/shared/hooks/bridge/bridge.sh')));
  assert.match(fs.readFileSync(target, 'utf8'), /\.\.\/\.\.\/\.doflow\/shared\/hooks\/bridge\/bridge\.sh/);
  const resource = installed.ledger.resources.find((row) => row.assetId === ASSET_ID && row.target === target);
  assert.equal(resource.ownershipIdentity, OWNERSHIP);
  const verified = adapter.verify({ ...input, ledger: installed.ledger });
  const status = verified.statuses.find((item) => item.assetId === ASSET_ID);
  assert.equal(status.status, 'managed');
  assert.deepEqual(status.prerequisites, ['project-trust']);
  assert.equal(status.fingerprintMatches, true);

  const removal = plan(adapter, { ...input, context: { ...input.context, operation: 'remove' }, ledger: installed.ledger });
  adapter.remove({ changes: removal.result.changes });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(root, '.pi/extensions')), true);
});

test('Pi project-scope headless coverage stays unknown and records project trust', () => {
  const coverage = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/registry/lifecycle.json'), 'utf8')).coverage;
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const row = coverage.rows.find((item) => item.harness === 'pi' && item.policy === policy
      && item.event === 'tool_call' && item.profile === 'project-headless');
    assert.ok(row, `${policy} project-headless row exists`);
    assert.equal(row.class, 'unknown');
    assert.equal(row.verification, 'unverified');
    assert.ok(row.prerequisites.includes('project-trust'));
    assert.ok(row.caveats.some((item) => item.includes('project-trust')));
  }
});

test('Claude and Pi retain the shared hooks tree until the last harness is removed at both scopes and orders', () => {
  for (const scope of ['project', 'global']) {
    for (const order of [['claude', 'pi'], ['pi', 'claude']]) {
      const home = tempHome();
      const project = path.join(home, 'project');
      fs.mkdirSync(project, { recursive: true });
      const sharedRoot = scope === 'project' ? project : home;
      const shared = path.join(sharedRoot, '.doflow/shared/hooks');
      const run = (verb, harnesses) => {
        const args = verb === 'install'
          ? (scope === 'global' ? ['install', '-g', '-t', harnesses.join(','), '-f'] : ['install', project, '-t', harnesses.join(','), '-f'])
          : (scope === 'global' ? ['remove', '-g', '-t', harnesses.join(','), '-f'] : ['remove', project, '-t', harnesses.join(','), '-f']);
        const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/doflow.js'), ...args], {
          cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home, DOFLOW_CONFIG_DIR: undefined },
        });
        assert.equal(result.status, 0, `${scope} ${verb} ${harnesses}: ${result.stderr}`);
      };
      run('install', ['claude', 'pi']);
      assert.ok(fs.existsSync(path.join(shared, 'bridge/bridge.sh')));
      for (const harness of order) {
        run('remove', [harness]);
        if (harness === order[0]) assert.ok(fs.existsSync(path.join(shared, 'bridge/bridge.sh')), `${scope} tree survives removal of ${harness}`);
      }
      assert.equal(fs.existsSync(shared), false, `${scope} tree is reclaimed after both removals`);
      const extension = scope === 'project'
        ? path.join(project, '.pi/extensions/doflow-guard.js')
        : path.join(home, '.pi/agent/extensions/doflow-guard.js');
      assert.equal(fs.existsSync(extension), false, `${scope} Pi extension is removed`);
    }
  }
});

test('an unowned user extension is reported and left unchanged', () => {
  const home = tempHome();
  const target = targetPath(home, {});
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'user extension\n');
  const result = planPiHooks({ scope: 'user', scopeRoot: home, assets: ASSETS, ledger: { resources: [] }, context: { repoRoot: ROOT } });
  assert.deepEqual(result.changes, []);
  assert.match(result.conflicts.join('\n'), /already exists and is not owned by DoFlow/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user extension\n');
});

test('removal releases a modified extension but removes only an unchanged owned file', () => {
  const home = tempHome();
  const adapter = createPiAdapter({ env: {} });
  const input = baseInput(home);
  const installed = install(adapter, input);
  const target = targetPath(home, {});
  fs.writeFileSync(path.join(path.dirname(target), 'keep-me.js'), 'user file\n');
  fs.appendFileSync(target, '// user edit\n');
  const removal = planPiHooks({ scope: 'user', scopeRoot: home, assets: ASSETS, ledger: installed.ledger,
    context: { repoRoot: ROOT, operation: 'remove' } });
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].release, true);
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.readFileSync(target, 'utf8').endsWith('// user edit\n'), true);
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'keep-me.js')), true);

  const cleanHome = tempHome();
  const cleanAdapter = createPiAdapter({ env: {} });
  const clean = install(cleanAdapter, baseInput(cleanHome));
  const cleanTarget = targetPath(cleanHome, {});
  const cleanRemoval = planPiHooks({ scope: 'user', scopeRoot: cleanHome, assets: ASSETS, ledger: clean.ledger,
    context: { repoRoot: ROOT, operation: 'remove' } });
  cleanAdapter.remove({ changes: cleanRemoval.changes });
  assert.equal(fs.existsSync(cleanTarget), false);
});
