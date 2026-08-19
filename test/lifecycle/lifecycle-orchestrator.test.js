'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapterRegistry } = require('../../src/adapters');
const { defaultLedger, readLedger } = require('../../src/state');
const { loadRegistry } = require('../../src/registry');
const { planLifecycle, applyLifecycle, removeLifecycle, normalizeRemovalVerification, mcpIndexPath } = require('../../src/lifecycle');

const REPO = path.resolve(__dirname, "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-'));
const registry = {
  harnesses: [{ id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } }],
  assets: [{ id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake'], ownership: 'managed-file', projection: { fake: { renderer: 'fake', capability: 'instructions' } } }],
  mcp: [], lifecycle: [],
};
// Real registry's MCP catalog (core/registry/mcp.yaml, loaded via loadRegistry) supplies the
// actual short-flag/doc pairs MCP_INDEX.md rendering depends on; everything else about the
// fixture (fake harness/adapter, scratch scopeRoot) stays the same lightweight pattern used above.
// The fake harness also needs its own 'mcp' capability declared (projectAdapterInput rejects a
// non-empty selection otherwise) — the base 'fake' harness above has none since its own tests
// never select MCP servers.
const mcpRegistry = {
  ...registry,
  harnesses: [{ ...registry.harnesses[0], capabilities: { ...registry.harnesses[0].capabilities, mcp: { status: 'supported' } } }],
  mcp: loadRegistry({ repoRoot: REPO }).mcp,
};

function fakeAdapter({ conflict = false, prerequisite = null } = {}) {
  const calls = [];
  return {
    calls,
    discover(input) { calls.push(['discover', input.harness.id]); return { existing: [] }; },
    render() { return 'native'; },
    plan(input) { return { changes: [{ assetId: 'guidance.fake', target: 'FAKE.md', operation: input.context.operation === 'remove' ? 'remove' : 'create', ownershipIdentity: 'fake:guidance', afterFingerprint: 'after' }], conflicts: conflict ? ['foreign file'] : [], prerequisites: prerequisite ? [prerequisite] : [] }; },
    apply(input) { calls.push(['apply', input.changes.length]); },
    remove(input) { calls.push(['remove', input.changes.length]); },
    verify(input) { calls.push(['verify', input.operation]); return { ok: true, resources: input.operation === 'remove' ? [] : [{ assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'verified', sourceVersion: 'test', projection: { renderer: 'fake' } }] }; },
  };
}

test('planning is non-mutating and returns normalized adapter changes', () => {
  const adapter = fakeAdapter();
  const plan = planLifecycle({ registry, adapters: createAdapterRegistry({ fake: adapter }), scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.equal(plan.safe, true);
  assert.deepEqual(adapter.calls, [['discover', 'fake']]);
  assert.deepEqual(plan.changes[0], { assetId: 'guidance.fake', target: 'FAKE.md', operation: 'create', ownershipIdentity: 'fake:guidance', afterFingerprint: 'after', harness: 'fake' });
  assert.deepEqual(plan.targets[0].adapterInput.assets[0], {
    id: 'guidance.fake', kind: 'guidance', source: 'ignored', ownership: 'managed-file', renderer: 'fake',
    capability: 'instructions', capabilityStatus: 'supported', nativeTarget: null, nativeDir: null, layout: null, prerequisites: [],
  });
});

test('apply refuses an empty native plan before journalling or ledger writes', () => {
  const adapter = fakeAdapter();
  adapter.plan = () => ({ changes: [] });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.throws(() => applyLifecycle({ plan, registry, adapters, stateRoot }), /no required native resources/);
  assert.ok(!fs.existsSync(path.join(stateRoot, 'ledger.json')));
  assert.ok(!fs.existsSync(path.join(stateRoot, 'recovery')));
});

test('apply journals, verifies, then persists only verified neutral ownership', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, ledger, targets: ['fake'] });
  const result = applyLifecycle({ plan, registry, adapters, stateRoot, ledger });
  assert.equal(result.verification.ok, true);
  assert.deepEqual(adapter.calls, [['discover', 'fake'], ['apply', 1], ['verify', 'apply']]);
  assert.equal(readLedger(stateRoot).resources[0].fingerprint, 'verified');
  assert.ok(fs.existsSync(path.join(stateRoot, 'recovery', `${result.recovery.id}.json`)));
});

test('conflicts and unmet prerequisites block apply before native mutation', () => {
  for (const options of [{ conflict: true }, { prerequisite: 'review native config' }]) {
    const adapter = fakeAdapter(options);
    const adapters = createAdapterRegistry({ fake: adapter });
    const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });
    assert.equal(plan.safe, false);
    assert.throws(() => applyLifecycle({ plan, registry, adapters, stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-')) }), /unsafe lifecycle plan/);
    assert.deepEqual(adapter.calls, [['discover', 'fake']]);
  }
});

test('adapter failures are promoted to lifecycle conflicts and fail closed', () => {
  const adapter = fakeAdapter();
  adapter.plan = () => ({ ok: false, changes: [], failures: [['config', { conflicts: ['foreign settings'] }]] });
  const plan = planLifecycle({ registry, adapters: createAdapterRegistry({ fake: adapter }), scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.equal(plan.safe, false);
  assert.deepEqual(plan.conflicts, [{ harness: 'fake', reason: 'config: foreign settings' }]);
});

test('remove lifecycle asks adapters for a remove plan and applies only after verification', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  ledger.resources.push({ harness: 'fake', scope: 'project', assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'owned' });
  const result = removeLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'], stateRoot, ledger });
  assert.equal(result.verification.ok, true);
  assert.ok(adapter.calls.some(([name]) => name === 'remove'));
  assert.ok(adapter.calls.some(([name, operation]) => name === 'verify' && operation === 'remove'));
  assert.equal(result.ledger.resources.length, 0, 'ownership is removed only after absence verification succeeds');
  assert.equal(result.verification.verifications[0].statuses[0].status, 'removed');
});

test('a mid-loop adapter throw during apply marks the recovery record failed with the harnesses that completed, instead of leaving it pending forever', () => {
  const multiRegistry = {
    harnesses: [
      { id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } },
      { id: 'fake2', displayName: 'Fake2', adapter: 'fake2', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } },
    ],
    assets: [{ id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake', 'fake2'], ownership: 'managed-file',
      projection: { fake: { renderer: 'fake', capability: 'instructions' }, fake2: { renderer: 'fake', capability: 'instructions' } } }],
    mcp: [], lifecycle: [],
  };
  const adapter1 = fakeAdapter();
  const adapter2 = fakeAdapter();
  adapter2.apply = () => { throw new Error('disk full'); };
  const adapters = createAdapterRegistry({ fake: adapter1, fake2: adapter2 });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry: multiRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake', 'fake2'] });
  assert.throws(() => applyLifecycle({ plan, registry: multiRegistry, adapters, stateRoot }), /disk full/);
  const recoveryDir = path.join(stateRoot, 'recovery');
  const files = fs.readdirSync(recoveryDir);
  assert.equal(files.length, 1, 'one recovery record, updated in place rather than left as a second pending one');
  const record = JSON.parse(fs.readFileSync(path.join(recoveryDir, files[0]), 'utf8'));
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.completedHarnesses, ['fake']);
  assert.equal(record.error, 'disk full');
  assert.ok(!fs.existsSync(path.join(stateRoot, 'ledger.json')), 'ledger must not be updated on a partial failure');
});

test('expected removed absence recomputes a provisional false verification, but unrelated missing remains false', () => {
  const removal = { harness: 'fake', assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', operation: 'remove' };
  const expected = normalizeRemovalVerification({ harness: 'fake', ok: false, resources: [], statuses: [{ ...removal, status: 'missing' }], conflicts: [] }, [removal]);
  assert.equal(expected.ok, true);
  assert.equal(expected.statuses[0].status, 'removed');

  const unrelated = normalizeRemovalVerification({ harness: 'fake', ok: false, resources: [], statuses: [
    { ...removal, status: 'missing' },
    { harness: 'fake', assetId: 'other.asset', target: 'OTHER.md', ownershipIdentity: 'other', status: 'missing' },
  ], conflicts: [] }, [removal]);
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.statuses[1].status, 'missing');
});

// Regression: `doflow remove -g` on an install predating the 14->5 agent consolidation aborted with
// "Lifecycle verification failed; ledger was not updated", leaving the config half-stripped. The
// plan correctly removed the 14 names the ledger owned, but codex's verifier enumerates the 5 the
// *current source* declares and reported the 4 never installed here as 'missing'. Those matched no
// change, so nothing reconciled them. Reproduced with the real identities from the failure.
test('removal tolerates a source-declared resource the ledger never owned (post-rename upgrade)', () => {
  const oldNames = ['backend-architect', 'python-expert', 'technical-writer'];
  const newNames = ['core-implementer', 'quality-guardian', 'research-writer'];
  const own = (name) => `doflow:codex:custom-agent:agent:${name}`;
  const changes = oldNames.map((name) => ({
    harness: 'codex', assetId: 'agents.shared', target: `/x/${name}.toml`,
    ownershipIdentity: own(name), operation: 'remove',
  }));
  const ledger = { resources: oldNames.map((name) => ({ harness: 'codex', ownershipIdentity: own(name) })) };
  const verification = {
    harness: 'codex', ok: false, resources: [], conflicts: [],
    // What the codex verifier actually produced: the new names it looked for and did not find.
    statuses: newNames.map((name) => ({
      harness: 'codex', assetId: 'agents.shared', target: `/x/${name}.toml`,
      ownershipIdentity: own(name), status: 'missing',
    })),
  };

  const result = normalizeRemovalVerification(verification, changes, ledger);
  assert.equal(result.ok, true, 'a never-installed resource must not fail the removal');
  assert.ok(result.statuses.every((s) => s.status !== 'missing'), 'no unresolved missing remains');
  assert.equal(result.statuses.filter((s) => s.expectedAbsence).length, newNames.length);
  assert.deepEqual(result.conflicts, []);
});

test('removal still fails when a resource the ledger DOES own is missing', () => {
  // The other half of the contract: this is a removal that genuinely did not happen, and silently
  // passing it would report success over a resource still unaccounted for.
  const owned = { harness: 'codex', assetId: 'agents.shared', target: '/x/kept.toml', ownershipIdentity: 'doflow:codex:custom-agent:agent:kept' };
  const removal = { harness: 'codex', assetId: 'agents.shared', target: '/x/gone.toml', ownershipIdentity: 'doflow:codex:custom-agent:agent:gone', operation: 'remove' };
  const ledger = { resources: [{ harness: 'codex', ownershipIdentity: owned.ownershipIdentity }] };

  const result = normalizeRemovalVerification({
    harness: 'codex', ok: false, resources: [], conflicts: [],
    statuses: [{ ...removal, status: 'missing' }, { ...owned, status: 'missing' }],
  }, [removal], ledger);
  assert.equal(result.ok, false);
  assert.equal(result.statuses[1].status, 'missing', 'a ledger-owned missing resource stays a failure');
});

test('removal without a ledger keeps the strict reading, since non-ownership cannot be proven', () => {
  const removal = { harness: 'fake', assetId: 'a', target: 'A.md', ownershipIdentity: 'fake:a', operation: 'remove' };
  const result = normalizeRemovalVerification({
    harness: 'fake', ok: false, resources: [], conflicts: [],
    statuses: [{ ...removal, status: 'missing' }, { harness: 'fake', assetId: 'b', target: 'B.md', ownershipIdentity: 'fake:b', status: 'missing' }],
  }, [removal], undefined);
  assert.equal(result.ok, false);
});

test('install with a non-empty MCP selection writes MCP_INDEX.md containing only the selected servers\' short flags', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-mcpindex-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: ['context7', 'sequential-thinking'] });
  applyLifecycle({ plan, registry: mcpRegistry, adapters, stateRoot });

  const indexFile = mcpIndexPath(scopeRoot);
  assert.ok(fs.existsSync(indexFile));
  const content = fs.readFileSync(indexFile, 'utf8');
  assert.match(content, /--c7/);
  assert.match(content, /--seq/);
});

test('update with a changed MCP selection overwrites MCP_INDEX.md with the new selection only, no stale content', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-mcpindex-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));

  const planA = planLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: ['context7'] });
  const resultA = applyLifecycle({ plan: planA, registry: mcpRegistry, adapters, stateRoot });
  const indexFile = mcpIndexPath(scopeRoot);
  assert.match(fs.readFileSync(indexFile, 'utf8'), /--c7/);

  // Simulate `doflow update` after the user changed their MCP selection: same scopeRoot/stateRoot,
  // plan+apply run again with a different selection, no prompt involved — purely a function of mcpIds.
  const planB = planLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: ['sequential-thinking'], ledger: resultA.ledger });
  applyLifecycle({ plan: planB, registry: mcpRegistry, adapters, stateRoot, ledger: resultA.ledger });

  const content = fs.readFileSync(indexFile, 'utf8');
  assert.match(content, /--seq/);
  assert.doesNotMatch(content, /--c7/, 'stale selection A content must not survive an update to selection B');
});

test('an empty MCP selection leaves MCP_INDEX.md absent rather than writing an empty file', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-mcpindex-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: [] });
  applyLifecycle({ plan, registry: mcpRegistry, adapters, stateRoot });

  assert.ok(!fs.existsSync(mcpIndexPath(scopeRoot)));
});

test('remove deletes MCP_INDEX.md regardless of what selection would otherwise apply', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-mcpindex-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));

  const installPlan = planLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: ['context7'] });
  const installResult = applyLifecycle({ plan: installPlan, registry: mcpRegistry, adapters, stateRoot });
  const indexFile = mcpIndexPath(scopeRoot);
  assert.ok(fs.existsSync(indexFile), 'precondition: install produced the index file');

  const removed = removeLifecycle({ registry: mcpRegistry, adapters, scope: 'project', scopeRoot, targets: ['fake'], mcpIds: ['context7'], stateRoot, ledger: installResult.ledger });
  assert.equal(removed.verification.ok, true);
  assert.ok(!fs.existsSync(indexFile), 'remove deletes the index file even though mcpIds still resolves to a non-empty selection');
});

// --- hookWiringStatus: the general per-harness hook-wiring status (task 006-D.2) ---
// Real registry + real adapters, installed into a scratch project, exercising the actual
// prerequisite declarations in core/registry/harnesses.yaml (Codex) and the live trust
// computation in src/adapters/gemini/hooks.js (Gemini) rather than a fake harness/adapter.
{
  const { verifyLifecycle, hookWiringStatus } = require('../../src/lifecycle');
  const realClaude = require('../../src/adapters/claude');
  const realCodex = require('../../src/adapters/codex');
  const { createGeminiAdapter } = require('../../src/adapters/gemini');
  const { createKiroAdapter } = require('../../src/adapters/kiro');

  function hookFixture(targets) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-hook-wiring-'));
    const realRegistry = loadRegistry({ repoRoot: REPO });
    const adapters = createAdapterRegistry({
      claude: realClaude, codex: realCodex, gemini: createGeminiAdapter(), kiro: createKiroAdapter(),
    });
    const context = {
      repoRoot: REPO, projectRoot: project, homeDir: project, sourceVersion: '2.4.4',
      codexConfigResources: [],
      codexAgentsSourceDir: path.join(REPO, 'core', 'harnesses', 'codex', 'agents'),
      codexHooksSourceFile: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'),
      codexHooksSourceDir: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks'),
      geminiHooksSourceFile: path.join(REPO, 'core', 'harnesses', 'gemini', 'hooks', 'hooks.json'),
      geminiHooksSourceDir: path.join(REPO, 'core', 'harnesses', 'gemini', 'hooks'),
    };
    const installPlan = planLifecycle({ registry: realRegistry, adapters, scope: 'project', scopeRoot: project, targets, context });
    const install = applyLifecycle({ plan: installPlan, registry: realRegistry, adapters, stateRoot: stateRootFor(project) });
    return { project, realRegistry, adapters, context, ledger: install.ledger };
  }

  function stateRootFor(project) {
    const { stateRoot } = require('../../src/state');
    return stateRoot({ scope: 'project', projectRoot: project });
  }

  function verifyInstalled({ realRegistry, adapters, project, context, ledger, targets }) {
    const rePlan = planLifecycle({ registry: realRegistry, adapters, scope: 'project', scopeRoot: project, targets, context, ledger });
    return verifyLifecycle({ plan: rePlan, adapters, context: { registry: realRegistry } });
  }

  test('hookWiringStatus: Claude reports active once its hooks resource is installed', () => {
    const fixture = hookFixture(['claude']);
    const verification = verifyInstalled({ ...fixture, targets: ['claude'] });
    const claudeVerification = verification.verifications.find((item) => item.harness === 'claude');
    assert.equal(claudeVerification.hookWiring.status, 'active');
    assert.deepEqual(claudeVerification.hookWiring.prerequisites, []);
  });

  test('hookWiringStatus: Kiro reports active immediately, since Kiro hooks have no trust/review prerequisite', () => {
    const fixture = hookFixture(['kiro']);
    const verification = verifyInstalled({ ...fixture, targets: ['kiro'] });
    const kiroVerification = verification.verifications.find((item) => item.harness === 'kiro');
    assert.equal(kiroVerification.hookWiring.status, 'active');
    assert.deepEqual(kiroVerification.hookWiring.prerequisites, []);
  });

  test('hookWiringStatus: Codex reports installed-pending (unmet hook-review prerequisite) even after install', () => {
    const fixture = hookFixture(['codex']);
    const verification = verifyInstalled({ ...fixture, targets: ['codex'] });
    const codexVerification = verification.verifications.find((item) => item.harness === 'codex');
    assert.equal(codexVerification.hookWiring.status, 'installed-pending');
    assert.deepEqual(codexVerification.hookWiring.prerequisites, ['trusted-project', 'hook-review']);
  });

  test('hookWiringStatus: Gemini reports installed-pending from its own live trust computation, not a static registry prerequisite', () => {
    const fixture = hookFixture(['gemini']);
    // Gemini's registry capability declares no `prerequisites` field at all — confirms the
    // installed-pending verdict below comes from src/adapters/gemini/hooks.js's live trust check, not a
    // static registry list (unlike Codex).
    const geminiCapability = fixture.realRegistry.harnesses.find((h) => h.id === 'gemini').capabilities.hooks;
    assert.equal(geminiCapability.prerequisites, undefined);

    const verification = verifyInstalled({ ...fixture, targets: ['gemini'] });
    const geminiVerification = verification.verifications.find((item) => item.harness === 'gemini');
    assert.equal(geminiVerification.hookWiring.status, 'installed-pending');
    assert.ok(geminiVerification.hookWiring.prerequisites.length > 0);
  });

  test('hookWiringStatus: a harness with no hooks resource installed reports absent', () => {
    // Claude's own plan target with nothing applied yet: the freshly-built plan's own `changes`
    // still carry the pending create, but there is no ledger/verification yet, so nothing is owned.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-hook-wiring-absent-'));
    const realRegistry = loadRegistry({ repoRoot: REPO });
    const adapters = createAdapterRegistry({ claude: realClaude });
    const context = { repoRoot: REPO, projectRoot: project, homeDir: project, sourceVersion: '2.4.4' };
    const freshPlan = planLifecycle({ registry: realRegistry, adapters, scope: 'project', scopeRoot: project, targets: ['claude'], context });
    const verification = verifyLifecycle({ plan: freshPlan, adapters, context: { registry: realRegistry } });
    const claudeVerification = verification.verifications.find((item) => item.harness === 'claude');
    assert.equal(claudeVerification.hookWiring.status, 'absent');
  });

  test('hookWiringStatus falls back to absent for a skipped/missing target', () => {
    assert.deepEqual(hookWiringStatus({ id: 'claude', capabilities: {} }, { skipped: true }, { resources: [] }), { status: 'absent', prerequisites: [] });
    assert.deepEqual(hookWiringStatus({ id: 'claude', capabilities: {} }, null, { resources: [] }), { status: 'absent', prerequisites: [] });
  });
}
