'use strict';

// lifecycle-shared-ownership.test.js — removal reclaims only what no other installed harness still
// claims (NFR-007).
//
// Several assets project to ONE destination for several harnesses: `scripts.doflow` is a single
// `<project>/.doflow/scripts` tree for claude, codex and gemini, gemini and copilot both resolve to
// `<root>/.agents` at project scope, and opencode and pi both merge into `<root>/AGENTS.md`.
// Ownership, though, is recorded per harness. Before this file existed, `remove -t gemini` deleted
// every file gemini's own ledger rows named — which took the shared runtime out from under claude
// and codex, left 78 of their rows pointing at files that no longer existed, and (with a global
// install present) left claude's locator silently answering from a *different* install's registries
// and state instead of failing.
//
// The unit cases pin the decision itself; the end-to-end case drives the real CLI, because the
// defect was invisible to every per-harness test — each harness was individually correct.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAdapterRegistry } = require('../src/adapters');
const { defaultLedger } = require('../src/state');
const { planLifecycle, applyLifecycle, removeLifecycle, markRetainedRemovals, retentionSummary } = require('../src/lifecycle');
const { planTree, removeTree } = require('../src/adapters/copy-tree');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');

function scratch(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `doflow-shared-${tag}-`)); }

// ------------------------------------------------------------------ a two-harness shared asset

const registry = {
  harnesses: ['alpha', 'beta'].map((id) => ({
    id, displayName: id, adapter: id, scopes: ['project', 'user'], nativeTargets: {},
    capabilities: { instructions: { status: 'supported' } },
  })),
  assets: [{
    id: 'shared.tree', kind: 'scripts', source: 'ignored', appliesTo: ['alpha', 'beta'], ownership: 'managed-file',
    projection: { alpha: { renderer: 'fake', capability: 'instructions' }, beta: { renderer: 'fake', capability: 'instructions' } },
  }],
  mcp: [], lifecycle: [],
};

/** A harness that owns one shared file (the same path for both harnesses, like the dispatcher) and
 * one of its own. It writes and deletes for real, and its verifier reports whatever is on disk —
 * that last part matters: a verifier that observes a retained file must not be able to resurrect
 * the claim the removal just released. */
function fileAdapter(id, { shared, own }) {
  const files = [{ identity: 'shared', target: shared }, { identity: 'own', target: own }];
  const deleted = [];
  return {
    deleted,
    discover() { return {}; },
    render() { return 'native'; },
    plan({ context = {} }) {
      const removing = context.operation === 'remove';
      return {
        changes: files.map((file) => ({
          assetId: 'shared.tree', target: file.target, identity: file.identity,
          operation: removing ? 'remove' : 'create',
          ownershipIdentity: `doflow:${id}:shared.tree:${file.identity}`,
          afterFingerprint: 'fp', sourceVersion: 'test', projection: { renderer: 'fake' },
        })),
      };
    },
    apply({ changes }) {
      for (const change of changes) {
        fs.mkdirSync(path.dirname(change.target), { recursive: true });
        fs.writeFileSync(change.target, 'managed\n');
      }
    },
    remove({ changes }) {
      for (const change of changes) { deleted.push(change.target); fs.rmSync(change.target, { force: true }); }
    },
    verify() {
      const resources = files.filter((file) => fs.existsSync(file.target)).map((file) => ({
        assetId: 'shared.tree', target: file.target, identity: file.identity,
        ownershipIdentity: `doflow:${id}:shared.tree:${file.identity}`,
        fingerprint: 'fp', sourceVersion: 'test', projection: { renderer: 'fake' },
      }));
      return { ok: true, statuses: [], resources };
    },
  };
}

function twoHarnessInstall(tag) {
  const root = scratch(tag);
  const shared = path.join(root, 'shared', 'dispatcher');
  const adapters = {
    alpha: fileAdapter('alpha', { shared, own: path.join(root, 'alpha', 'own') }),
    beta: fileAdapter('beta', { shared, own: path.join(root, 'beta', 'own') }),
  };
  const registryAdapters = createAdapterRegistry(adapters);
  const stateRoot = path.join(root, '.doflow', 'state');
  let ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  for (const harness of ['alpha', 'beta']) {
    const plan = planLifecycle({ registry, adapters: registryAdapters, scope: 'project', scopeRoot: root, targets: [harness], ledger });
    ledger = applyLifecycle({ plan, registry, adapters: registryAdapters, stateRoot, ledger }).ledger;
  }
  assert.equal(fs.readFileSync(shared, 'utf8'), 'managed\n');
  assert.equal(ledger.resources.filter((resource) => resource.target === shared).length, 2, 'both harnesses must claim the shared file');
  return { root, shared, adapters, registryAdapters, stateRoot, ledger };
}

test('a removal releases its claim on a shared file without deleting it, and says so', () => {
  const { shared, adapters, registryAdapters, stateRoot, ledger, root } = twoHarnessInstall('release');

  const result = removeLifecycle({ registry, adapters: registryAdapters, scope: 'project', scopeRoot: root,
    targets: ['alpha'], stateRoot, ledger });

  assert.ok(fs.existsSync(shared), 'a file beta still claims must survive alpha being removed');
  assert.deepEqual(adapters.alpha.deleted, [path.join(root, 'alpha', 'own')],
    'the adapter must never be handed a change it must not execute — only alpha\'s own file');

  // The claim is released even though the file stays: alpha really is uninstalled, and a row left
  // behind would make beta's removal think a third party still needed the file.
  assert.deepEqual(result.ledger.resources.filter((resource) => resource.harness === 'alpha'), []);
  assert.deepEqual(result.ledger.resources.map((resource) => resource.target), [shared, path.join(root, 'beta', 'own')]);

  assert.deepEqual(result.retained, [{ harness: 'alpha', assetId: 'shared.tree', target: shared, retainedFor: ['beta'] }]);
  assert.deepEqual(retentionSummary(result.retained), ['alpha: retained 1 shared resource(s) still claimed by beta']);
});

test('the last claimant\'s removal reclaims the shared file', () => {
  const { shared, registryAdapters, stateRoot, ledger, root } = twoHarnessInstall('reclaim');
  const afterFirst = removeLifecycle({ registry, adapters: registryAdapters, scope: 'project', scopeRoot: root,
    targets: ['alpha'], stateRoot, ledger }).ledger;

  const result = removeLifecycle({ registry, adapters: registryAdapters, scope: 'project', scopeRoot: root,
    targets: ['beta'], stateRoot, ledger: afterFirst });

  assert.equal(fs.existsSync(shared), false, 'nothing claims it any more, so it must be reclaimed');
  assert.deepEqual(result.retained, []);
  assert.deepEqual(result.ledger.resources, []);
});

test('removing every claimant at once reclaims the shared file in one pass', () => {
  const { shared, registryAdapters, stateRoot, ledger, root } = twoHarnessInstall('batch');
  const result = removeLifecycle({ registry, adapters: registryAdapters, scope: 'project', scopeRoot: root,
    targets: ['alpha', 'beta'], stateRoot, ledger });
  assert.equal(fs.existsSync(shared), false, 'a claimant that is itself being removed is not a reason to keep the file');
  assert.deepEqual(result.retained, []);
  assert.deepEqual(result.ledger.resources, []);
});

test('a harness whose every resource is shared is removed without the adapter being called', () => {
  // The whole plan is a ledger release. It must still run — the harness is uninstalled and its
  // rows must go — but nothing native may be touched.
  const root = scratch('allshared');
  const shared = path.join(root, 'shared', 'dispatcher');
  const alpha = fileAdapter('alpha', { shared, own: shared });
  const beta = fileAdapter('beta', { shared, own: shared });
  const adapters = createAdapterRegistry({ alpha, beta });
  const stateRoot = path.join(root, '.doflow', 'state');
  let ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  for (const harness of ['alpha', 'beta']) {
    const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: [harness], ledger });
    ledger = applyLifecycle({ plan, registry, adapters, stateRoot, ledger }).ledger;
  }

  const result = removeLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['alpha'], stateRoot, ledger });

  assert.deepEqual(alpha.deleted, [], 'nothing was exclusively alpha\'s, so the adapter had nothing to do');
  assert.ok(fs.existsSync(shared));
  assert.deepEqual(result.ledger.resources.map((resource) => resource.harness), ['beta', 'beta']);
});

test('retention is decided per ownership row, not per harness', () => {
  // beta releases its claim on `shared` in the same run while keeping its claim on `other`. Only
  // the row that survives may hold a file back, so alpha's removal of `shared` must go through
  // while its removal of `other` must not.
  const ledger = {
    ...defaultLedger({ scope: 'project', scopeRoot: '/p' }),
    resources: [
      { harness: 'beta', scope: 'project', assetId: 'shared.tree', target: '/p/shared', ownershipIdentity: 'beta:shared' },
      { harness: 'beta', scope: 'project', assetId: 'shared.tree', target: '/p/other', ownershipIdentity: 'beta:other' },
    ],
  };
  const harnessPlans = [
    { harness: 'alpha', skipped: false, changes: [
      { harness: 'alpha', assetId: 'shared.tree', target: '/p/shared', ownershipIdentity: 'alpha:shared', operation: 'remove' },
      { harness: 'alpha', assetId: 'shared.tree', target: '/p/other', ownershipIdentity: 'alpha:other', operation: 'remove' },
    ] },
    { harness: 'beta', skipped: false, changes: [
      { harness: 'beta', assetId: 'shared.tree', target: '/p/shared', ownershipIdentity: 'beta:shared', operation: 'remove' },
    ] },
  ];
  const [alpha] = markRetainedRemovals(harnessPlans, ledger, 'project');
  assert.deepEqual(alpha.changes.map((change) => change.retained ?? false), [false, true]);
  assert.deepEqual(alpha.changes[1].retainedFor, ['beta']);
});

test('a non-removal change is never annotated, and a plan with nothing shared is untouched', () => {
  const harnessPlans = [{ harness: 'alpha', skipped: false, changes: [{ harness: 'alpha', assetId: 'a', target: '/p/x', ownershipIdentity: 'alpha:x', operation: 'create' }] }];
  const ledger = { ...defaultLedger({ scope: 'project', scopeRoot: '/p' }),
    resources: [{ harness: 'beta', scope: 'project', assetId: 'a', target: '/p/x', ownershipIdentity: 'beta:x' }] };
  assert.equal(markRetainedRemovals(harnessPlans, ledger, 'project')[0].changes[0].retained, undefined);
  assert.deepEqual(markRetainedRemovals(harnessPlans, defaultLedger({ scope: 'project', scopeRoot: '/p' }), 'project'), harnessPlans);
});

test('retentionSummary groups by harness and claimant set', () => {
  assert.deepEqual(retentionSummary([
    { harness: 'gemini', target: '/a', retainedFor: ['claude', 'codex'] },
    { harness: 'gemini', target: '/b', retainedFor: ['claude', 'codex'] },
    { harness: 'gemini', target: '/c', retainedFor: ['copilot'] },
  ]), [
    'gemini: retained 2 shared resource(s) still claimed by claude, codex',
    'gemini: retained 1 shared resource(s) still claimed by copilot',
  ]);
  assert.deepEqual(retentionSummary([]), []);
});

// ------------------------------------------------------- copy-tree: what counts as a safe delete

test('copy-tree removal accepts the current source bytes as well as the recorded fingerprint', () => {
  const root = scratch('copytree');
  const sourceDir = path.join(root, 'src');
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'run'), 'v2\n');
  fs.writeFileSync(path.join(destDir, 'run'), 'v2\n');

  // A sibling harness's update rewrote the shared tree to v2; this harness's row still describes
  // v1. Refusing here would strand its claim with no way to release it, so bytes that equal what
  // the source would write today are removable — and the observed fingerprint travels with the
  // change, so removeTree's own pre-delete re-check agrees instead of throwing.
  const stale = [{ relPath: 'run', target: path.join(destDir, 'run'), fingerprint: 'sha-of-v1' }];
  const plan = planTree({ sourceDir, destDir, previousResources: stale, operation: 'remove' });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.changes.length, 1);
  assert.equal(removeTree({ changes: plan.changes }).removed, 1);
  assert.equal(fs.existsSync(path.join(destDir, 'run')), false);
});

test('copy-tree removal still refuses a file that matches neither the record nor the source', () => {
  const root = scratch('handedit');
  const sourceDir = path.join(root, 'src');
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'run'), 'v2\n');
  fs.writeFileSync(path.join(destDir, 'run'), 'v2\n# hand edit\n');

  const plan = planTree({ sourceDir, destDir, operation: 'remove',
    previousResources: [{ relPath: 'run', target: path.join(destDir, 'run'), fingerprint: 'sha-of-v1' }] });
  assert.deepEqual(plan.conflicts, ['run was modified outside DoFlow']);
  assert.deepEqual(plan.changes, []);
  assert.ok(fs.existsSync(path.join(destDir, 'run')), 'a refused removal never deletes');
});

test('copy-tree removal reads no source when the recorded fingerprint already matches', () => {
  const root = scratch('nosource');
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'run'), 'v1\n');
  const fingerprint = require('node:crypto').createHash('sha256').update('v1\n').digest('hex');

  // A source directory that no longer exists must not make removal impossible: an asset can be
  // removed long after its source moved.
  const plan = planTree({ sourceDir: path.join(root, 'gone'), destDir, operation: 'remove',
    previousResources: [{ relPath: 'run', target: path.join(destDir, 'run'), fingerprint }] });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.changes[0].fingerprint, fingerprint);
});

// ------------------------------------------------------------------------------ the real thing

test('CLI: removing one of three harnesses that share .doflow leaves the runtime standing', { timeout: 120000 }, () => {
  const root = scratch('cli');
  const home = path.join(root, 'home');
  const cli = (args) => spawnSync('node', [CLI, ...args], { cwd: REPO, encoding: 'utf8', input: '\n', env: { ...process.env, HOME: home } });
  const ledgerOf = () => JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'ledger.json'), 'utf8'));
  const dispatcher = path.join(root, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');

  const installed = cli(['install', root, '-f', '--no-backup', '-t', 'claude,codex,gemini']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(fs.existsSync(dispatcher));
  assert.equal(ledgerOf().resources.filter((resource) => resource.target === dispatcher).length, 3,
    'the fixture only means something while all three claim the dispatcher');

  const removed = cli(['remove', root, '-f', '-t', 'gemini']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(fs.existsSync(dispatcher), 'gemini\'s removal must not take claude and codex\'s runtime with it');
  assert.match(removed.stdout, /gemini: retained \d+ shared resource\(s\) still claimed by claude, codex/,
    'a removal that keeps files must say so, not report a bare success');

  const after = ledgerOf();
  assert.deepEqual(after.resources.filter((resource) => resource.harness === 'gemini'), []);
  assert.deepEqual(after.resources.filter((resource) => resource.target.startsWith(root) && !fs.existsSync(resource.target)), [],
    'a row pointing at a file that no longer exists is the dangling state this fix exists to prevent');

  // The runtime is not merely present, it still answers from THIS project — the failure that hid
  // the original defect was claude's locator falling through to a global install and working.
  const paths = spawnSync(path.join(root, '.claude', 'bin', 'doflow-run'), ['paths', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, DOFLOW_CONFIG_DIR: undefined, DOFLOW_CLI: undefined } });
  assert.equal(paths.status, 0, paths.stderr);
  assert.match(JSON.parse(paths.stdout).constitution_base, new RegExp(`^${fs.realpathSync(root)}/`),
    'the locator must reach this project\'s runtime, not another install\'s');

  const last = cli(['remove', root, '-f', '-t', 'claude,codex']);
  assert.equal(last.status, 0, last.stderr);
  assert.equal(fs.existsSync(dispatcher), false, 'the last claimant\'s removal must reclaim the shared tree');
  assert.deepEqual(ledgerOf().resources, []);
});
