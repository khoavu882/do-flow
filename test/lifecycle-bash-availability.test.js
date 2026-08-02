'use strict';

// FR-003: hook-bearing installs must refuse to proceed when no bash-capable shell is invocable,
// rather than installing hooks that will error silently at runtime. Covers the preflight in
// isolation (hasBashCapableShell, targetNeedsHooks, assertBashAvailableForHooks) and its wiring
// into applyLifecycle, using the same fake-adapter fixture pattern as
// test/lifecycle-orchestrator.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapterRegistry } = require('../src/adapters');
const { defaultLedger } = require('../src/state');
const { hasBashCapableShell } = require('../src/lifecycle/bash-availability');
const { planLifecycle, applyLifecycle, targetNeedsHooks, assertBashAvailableForHooks } = require('../src/lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-'));

// --- hasBashCapableShell() in isolation -------------------------------------------------------

test('hasBashCapableShell returns true when the injected execFileSyncImpl does not throw', () => {
  assert.equal(hasBashCapableShell(() => Buffer.from('')), true);
});

test('hasBashCapableShell returns false on an ENOENT-style throw (bash not on PATH)', () => {
  const error = new Error('spawnSync bash ENOENT');
  error.code = 'ENOENT';
  assert.equal(hasBashCapableShell(() => { throw error; }), false);
});

test('hasBashCapableShell returns false on a non-zero-exit-style throw (bash present but --version failed)', () => {
  const error = new Error('Command failed: bash --version');
  error.status = 1;
  assert.equal(hasBashCapableShell(() => { throw error; }), false);
});

test('hasBashCapableShell invokes bash --version, not a bare presence check', () => {
  const calls = [];
  hasBashCapableShell((command, args, options) => { calls.push({ command, args, options }); });
  assert.deepEqual(calls, [{ command: 'bash', args: ['--version'], options: { stdio: 'ignore' } }]);
});

// --- targetNeedsHooks(target) in isolation ----------------------------------------------------

test('targetNeedsHooks is true for a Claude-shaped target (selected asset kind "hooks" + matching change)', () => {
  const target = {
    assets: [{ id: 'claude.hooks-scripts', kind: 'hooks' }, { id: 'guidance.fake', kind: 'guidance' }],
    changes: [{ assetId: 'guidance.fake', operation: 'create' }, { assetId: 'claude.hooks-scripts', operation: 'create' }],
  };
  assert.equal(targetNeedsHooks(target), true);
});

test('targetNeedsHooks is true for a Codex/Gemini-shaped target (change tagged nativeComponent: "hooks")', () => {
  const target = {
    assets: [{ id: 'codex.config', kind: 'settings' }],
    changes: [{ assetId: 'codex.config', operation: 'update', nativeComponent: 'hooks' }],
  };
  assert.equal(targetNeedsHooks(target), true);
});

test('targetNeedsHooks is false when a target has neither a hooks-kind asset change nor a nativeComponent: "hooks" change', () => {
  const target = {
    assets: [{ id: 'guidance.fake', kind: 'guidance' }],
    changes: [{ assetId: 'guidance.fake', operation: 'create' }],
  };
  assert.equal(targetNeedsHooks(target), false);
});

test('targetNeedsHooks is false for a target with no assets/changes at all', () => {
  assert.equal(targetNeedsHooks({}), false);
  assert.equal(targetNeedsHooks({ assets: [], changes: [] }), false);
});

// --- assertBashAvailableForHooks(plan, mode, hasBashCapableShellFn) in isolation --------------

function hookPlan({ skipped = false } = {}) {
  return {
    targets: [{
      harness: 'claude',
      skipped,
      assets: [{ id: 'claude.hooks-scripts', kind: 'hooks' }],
      changes: [{ assetId: 'claude.hooks-scripts', operation: 'create' }],
    }],
  };
}

function nonHookPlan() {
  return {
    targets: [{
      harness: 'fake',
      skipped: false,
      assets: [{ id: 'guidance.fake', kind: 'guidance' }],
      changes: [{ assetId: 'guidance.fake', operation: 'create' }],
    }],
  };
}

test('assertBashAvailableForHooks throws naming the missing shell and remediation when a hooks-needing target is present and the shell-check returns false', () => {
  assert.throws(
    () => assertBashAvailableForHooks(hookPlan(), 'apply', () => false),
    (error) => {
      assert.match(error.message, /No bash-capable shell detected/);
      assert.match(error.message, /Git Bash for Windows/);
      assert.match(error.message, /WSL/);
      assert.match(error.message, /claude/);
      return true;
    },
  );
});

test('assertBashAvailableForHooks does not throw when the shell-check returns true', () => {
  assert.doesNotThrow(() => assertBashAvailableForHooks(hookPlan(), 'apply', () => true));
});

test('assertBashAvailableForHooks does not throw, and never calls the shell-check function, when no target needs hooks', () => {
  let calls = 0;
  assertBashAvailableForHooks(nonHookPlan(), 'apply', () => { calls += 1; return false; });
  assert.equal(calls, 0, 'the shell-check function must not be invoked when no plan target needs hooks');
});

test('assertBashAvailableForHooks is a no-op for mode "remove" even when the shell-check function would return false', () => {
  let calls = 0;
  assert.doesNotThrow(() => assertBashAvailableForHooks(hookPlan(), 'remove', () => { calls += 1; return false; }));
  assert.equal(calls, 0, 'remove mode returns before consulting the shell-check function at all');
});

test('assertBashAvailableForHooks skips a skipped target even if it would otherwise need hooks', () => {
  let calls = 0;
  assertBashAvailableForHooks(hookPlan({ skipped: true }), 'apply', () => { calls += 1; return false; });
  assert.equal(calls, 0, 'a skipped target contributes no hook requirement, so the shell-check is never consulted');
});

// --- Integration through applyLifecycle --------------------------------------------------------
// Same fake-adapter fixture pattern as test/lifecycle-orchestrator.test.js: a minimal raw
// registry object (bypassing loadRegistry's file-backed validation) plus a fake adapter that
// records every call it receives.

const hooksRegistry = {
  harnesses: [{
    id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {},
    capabilities: { instructions: { status: 'supported' }, hooks: { status: 'supported' } },
  }],
  assets: [
    { id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake'], ownership: 'managed-file',
      projection: { fake: { renderer: 'fake', capability: 'instructions' } } },
    { id: 'hooks.fake', kind: 'hooks', source: 'ignored', appliesTo: ['fake'], ownership: 'managed-tree',
      projection: { fake: { renderer: 'fake', capability: 'hooks' } }, nativeDir: { fake: 'hooks' } },
  ],
  mcp: [], lifecycle: [],
};

function fakeHooksAdapter({ includeHooks = true } = {}) {
  const calls = [];
  return {
    calls,
    discover(input) { calls.push(['discover', input.harness.id]); return { existing: [] }; },
    render() { return 'native'; },
    plan(input) {
      const op = input.context.operation === 'remove' ? 'remove' : 'create';
      const changes = [{ assetId: 'guidance.fake', target: 'FAKE.md', operation: op, ownershipIdentity: 'fake:guidance', afterFingerprint: 'after' }];
      if (includeHooks) {
        changes.push({ assetId: 'hooks.fake', target: 'hooks/fake.sh', operation: op, ownershipIdentity: 'fake:hooks', afterFingerprint: 'after-hooks' });
      }
      return { changes, conflicts: [], prerequisites: [] };
    },
    apply(input) { calls.push(['apply', input.changes.length]); },
    remove(input) { calls.push(['remove', input.changes.length]); },
    verify(input) {
      calls.push(['verify', input.operation]);
      if (input.operation === 'remove') return { ok: true, resources: [] };
      const resources = [{ assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'verified', sourceVersion: 'test', projection: { renderer: 'fake' } }];
      if (includeHooks) resources.push({ assetId: 'hooks.fake', target: 'hooks/fake.sh', ownershipIdentity: 'fake:hooks', fingerprint: 'verified-hooks', sourceVersion: 'test', projection: { renderer: 'fake' } });
      return { ok: true, resources };
    },
  };
}

test('applyLifecycle: a hooks-bearing plan with hasBashCapableShellFn returning false throws before any adapter apply and before any recovery record is written', () => {
  const adapter = fakeHooksAdapter({ includeHooks: true });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-state-'));
  const plan = planLifecycle({ registry: hooksRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.equal(plan.safe, true, 'precondition: plan itself has no conflicts, so the throw below is solely the bash preflight');

  assert.throws(
    () => applyLifecycle({ plan, registry: hooksRegistry, adapters, stateRoot, hasBashCapableShellFn: () => false }),
    /No bash-capable shell detected/,
  );
  assert.deepEqual(adapter.calls, [['discover', 'fake']], 'no apply/verify call reached the adapter');
  assert.ok(!fs.existsSync(path.join(stateRoot, 'recovery')), 'no recovery record was written before the preflight ran');
  assert.ok(!fs.existsSync(path.join(stateRoot, 'ledger.json')), 'ledger untouched');
});

test('applyLifecycle: the same hooks-bearing plan with hasBashCapableShellFn returning true succeeds', () => {
  const adapter = fakeHooksAdapter({ includeHooks: true });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-state-'));
  const plan = planLifecycle({ registry: hooksRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });

  const result = applyLifecycle({ plan, registry: hooksRegistry, adapters, stateRoot, hasBashCapableShellFn: () => true });
  assert.equal(result.verification.ok, true);
  assert.deepEqual(adapter.calls, [['discover', 'fake'], ['apply', 2], ['verify', 'apply']]);
  assert.ok(fs.existsSync(path.join(stateRoot, 'recovery', `${result.recovery.id}.json`)));
});

test('applyLifecycle: the same hooks-bearing plan succeeds with the real hasBashCapableShell check on this machine (no override)', () => {
  const adapter = fakeHooksAdapter({ includeHooks: true });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-state-'));
  const plan = planLifecycle({ registry: hooksRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });

  const result = applyLifecycle({ plan, registry: hooksRegistry, adapters, stateRoot });
  assert.equal(result.verification.ok, true, 'this machine has a real bash on PATH, so the default hasBashCapableShellFn must pass');
});

test('applyLifecycle: a plan touching only a non-hooks asset succeeds regardless of the shell-check stub', () => {
  for (const hasBashCapableShellFn of [() => false, () => true]) {
    const adapter = fakeHooksAdapter({ includeHooks: false });
    const adapters = createAdapterRegistry({ fake: adapter });
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-state-'));
    const plan = planLifecycle({ registry: hooksRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });

    const result = applyLifecycle({ plan, registry: hooksRegistry, adapters, stateRoot, hasBashCapableShellFn });
    assert.equal(result.verification.ok, true);
    assert.deepEqual(adapter.calls, [['discover', 'fake'], ['apply', 1], ['verify', 'apply']]);
  }
});

test('applyLifecycle: mode "remove" on a hooks-bearing plan succeeds even with hasBashCapableShellFn returning false', () => {
  const adapter = fakeHooksAdapter({ includeHooks: true });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bash-availability-state-'));
  const ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  ledger.resources.push(
    { harness: 'fake', scope: 'project', assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'owned' },
    { harness: 'fake', scope: 'project', assetId: 'hooks.fake', target: 'hooks/fake.sh', ownershipIdentity: 'fake:hooks', fingerprint: 'owned-hooks' },
  );
  const plan = planLifecycle({ registry: hooksRegistry, adapters, scope: 'project', scopeRoot: root, ledger, targets: ['fake'], context: { operation: 'remove' } });

  const result = applyLifecycle({ plan, registry: hooksRegistry, adapters, stateRoot, ledger, mode: 'remove', hasBashCapableShellFn: () => false });
  assert.equal(result.verification.ok, true, 'removal is exempt from the bash preflight (uninstalling hook files does not require running them)');
  assert.ok(adapter.calls.some(([name]) => name === 'remove'));
});
