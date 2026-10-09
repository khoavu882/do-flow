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
const { createAdapterRegistry } = require('../../src/adapters');
const { defaultLedger } = require('../../src/state');
const { planLifecycle, applyLifecycle, removeLifecycle, markRetainedRemovals, retentionSummary } = require('../../src/lifecycle');
const { planTree, applyTree, removeTree, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices } = require('../../src/adapters/copy-tree');
const { interpreterSpawn, withinPath, msysArgConvGuards } = require('../helper-platform');

const REPO = path.resolve(__dirname, "../..");
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

test('P4: an MCP entry removal is retained only while another harness claims that same entry', () => {
  // Claude and Copilot share <project>/.mcp.json. A claim on an MCP entry is per entry, so Copilot
  // keeps an entry Claude also owns, and still removes one only Copilot owns although Claude owns
  // another entry in the same file.
  const file = '/p/.mcp.json';
  const mcpRow = (harness, id) => ({ harness, scope: 'project', assetId: 'guidance.core', target: file,
    ownershipIdentity: `doflow:${harness}:mcp-server:${id}`, kind: 'mcp-server', identity: id });
  const ledger = { ...defaultLedger({ scope: 'project', scopeRoot: '/p' }),
    resources: [mcpRow('claude', 'context7'), mcpRow('claude', 'sequential-thinking'), mcpRow('copilot', 'context7'), mcpRow('copilot', 'playwright')] };
  const removal = (id) => ({ ...mcpRow('copilot', id), operation: 'remove' });
  const [copilot] = markRetainedRemovals([{ harness: 'copilot', skipped: false, changes: [removal('context7'), removal('playwright')] }], ledger, 'project');
  assert.deepEqual(copilot.changes.map((change) => [change.identity, change.retained ?? false]), [['context7', true], ['playwright', false]]);
  assert.deepEqual(copilot.changes[0].retainedFor, ['claude']);
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

// ------------------------------------------- two claimants on one tree, from different releases

/** A harness driving the real copy-tree engine over one shared tree from its own source. Two of
 * them stand for two releases of the same shared files: each writes its release, and each must
 * accept what the other left behind without accepting a hand edit. */
function copyTreeAdapter(id, assetId, { sourceDir, destDir }) {
  const sha = (file) => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {
    discover() { return {}; },
    render() { return 'native'; },
    plan({ ledger }) {
      const result = planTree({ sourceDir, destDir, previousResources: ledgerFileResources(ledger.resources, id, assetId),
        siblingFingerprints: ledgerSiblingFingerprints(ledger.resources, id) });
      return {
        conflicts: result.conflicts.map((reason) => `${assetId}: ${reason}`),
        notices: siblingReplacedNotices([result]),
        changes: result.changes.map((change) => ({
          assetId, target: change.target, source: change.source, operation: change.operation,
          ownershipIdentity: `doflow:${id}:${assetId}:${change.relPath}`, kind: 'copy-tree-file', identity: change.relPath,
          afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'test', projection: { renderer: 'fake' },
        })),
      };
    },
    apply({ changes }) { applyTree({ changes }); },
    remove() {},
    verify() {
      const target = path.join(destDir, 'run');
      return { ok: true, statuses: [], resources: fs.existsSync(target) ? [{
        assetId, target, identity: 'run', kind: 'copy-tree-file',
        ownershipIdentity: `doflow:${id}:${assetId}:run`, fingerprint: sha(target), sourceVersion: 'test', projection: { renderer: 'fake' },
      }] : [] };
    },
  };
}

/** Two claimants of one asset's tree, from different releases: alpha writes `new`, beta writes `old`. */
function twoReleases(assetId) {
  const root = scratch('mixed');
  const destDir = path.join(root, 'shared');
  const releases = { alpha: 'new\n', beta: 'old\n' };
  const adapters = {};
  for (const [id, content] of Object.entries(releases)) {
    const sourceDir = path.join(root, `src-${id}`);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'run'), content);
    adapters[id] = copyTreeAdapter(id, assetId, { sourceDir, destDir });
  }
  const registryAdapters = createAdapterRegistry(adapters);
  const assetRegistry = { ...registry, assets: [{ ...registry.assets[0], id: assetId }] };
  const stateRoot = path.join(root, '.doflow', 'state');
  let ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  const plan = (harness) => planLifecycle({ registry: assetRegistry, adapters: registryAdapters, scope: 'project', scopeRoot: root, targets: [harness], ledger });
  const apply = (harness) => {
    const planned = plan(harness);
    assert.deepEqual(planned.conflicts, [], `${harness} must be accepted`);
    ledger = applyLifecycle({ plan: planned, registry: assetRegistry, adapters: registryAdapters, stateRoot, ledger }).ledger;
  };
  const rowOf = (harness) => ledger.resources.find((resource) => resource.harness === harness).fingerprint;
  return { plan, apply, rowOf, run: path.join(destDir, 'run') };
}

const sha = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');

test('two claimants of the runtime tree from different releases install and update over each other, a hand edit is still refused, and the replacement is noticed once', () => {
  const { plan, apply, rowOf, run } = twoReleases('runtime.lib');

  apply('beta');
  assert.equal(fs.readFileSync(run, 'utf8'), 'old\n');
  assert.deepEqual(plan('beta').notices, [], 'a harness replacing nothing a sibling wrote prints no notice');
  const replacing = plan('alpha');   // a tree beta wrote, matching neither alpha's source nor any alpha row
  assert.deepEqual(replacing.notices, [{ harness: 'alpha', notice: 'replaced shared files written by beta; reinstall that harness to restore them' }]);
  assert.equal(replacing.safe, true, 'a notice never blocks');
  apply('alpha');
  assert.equal(fs.readFileSync(run, 'utf8'), 'new\n');
  assert.deepEqual(plan('alpha').notices, [], 'nothing left to replace, so nothing to say');
  assert.equal(rowOf('beta'), sha('old\n'), 'a sibling\'s row keeps the fingerprint it recorded');
  assert.equal(rowOf('alpha'), sha('new\n'));
  assert.equal(plan('beta').notices.length, 1, 'beta replaces what alpha wrote, from the other direction');
  apply('beta');
  assert.equal(rowOf('beta'), sha('old\n'));
  assert.equal(rowOf('alpha'), sha('new\n'), 'only the updating harness\'s row changes');

  fs.writeFileSync(run, 'hand edited\n');
  for (const harness of ['alpha', 'beta']) {
    assert.deepEqual(plan(harness).conflicts.map((conflict) => conflict.reason), ['runtime.lib: run was modified outside DoFlow']);
  }
});

test('a sibling row of a skills or generic shared-tree asset does not excuse a differing file', () => {
  for (const assetId of ['skills.core', 'shared.tree']) {
    const { plan, apply, run } = twoReleases(assetId);
    apply('beta');
    assert.equal(fs.readFileSync(run, 'utf8'), 'old\n');
    assert.deepEqual(plan('alpha').conflicts.map((conflict) => conflict.reason), [`${assetId}: run was modified outside DoFlow`], assetId);
  }
});

test('two claimants of the guidance tree from different releases install over each other with a notice, and a hand edit is still refused', () => {
  for (const assetId of ['guidance.context-layer', 'kiro.guidance-tree']) {
    const { plan, apply, rowOf, run } = twoReleases(assetId);
    apply('beta');
    assert.deepEqual(plan('beta').notices, [], assetId);
    const replacing = plan('alpha');   // guidance beta wrote, matching neither alpha's source nor any alpha row
    assert.deepEqual(replacing.conflicts, [], assetId);
    assert.deepEqual(replacing.notices, [{ harness: 'alpha', notice: 'replaced shared files written by beta; reinstall that harness to restore them' }], assetId);
    assert.equal(replacing.safe, true, 'a notice never blocks');
    apply('alpha');
    assert.equal(fs.readFileSync(run, 'utf8'), 'new\n');
    assert.equal(rowOf('beta'), sha('old\n'), 'a sibling\'s row keeps the fingerprint it recorded');
    fs.writeFileSync(run, 'hand edited\n');
    for (const harness of ['alpha', 'beta']) {
      assert.deepEqual(plan(harness).conflicts.map((conflict) => conflict.reason), [`${assetId}: run was modified outside DoFlow`], `${assetId} ${harness}`);
    }
  }
});

// ------------------------------------------------------------------------------ the real thing

test('CLI: removing one of three harnesses that share .doflow leaves the runtime standing', { timeout: 120000 }, () => {
  const root = scratch('cli');
  const home = path.join(root, 'home');
  // os.homedir() ignores HOME on Windows; USERPROFILE must be redirected alongside it.
  const homeEnv = process.platform === 'win32' ? { HOME: home, USERPROFILE: home } : { HOME: home };
  const cli = (args) => spawnSync('node', [CLI, ...args], { cwd: REPO, encoding: 'utf8', input: '\n', env: { ...process.env, ...homeEnv } });
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
  // The locator is a POSIX script, so on win32 it is spawned through Git Bash (interpreterSpawn)
  // instead of being skipped — CreateProcess can neither honor a shebang nor consult exec bits.
  const { file, args: locatorArgs } = interpreterSpawn(path.join(root, '.claude', 'bin', 'doflow-run'), ['paths', '--json']);
  const paths = spawnSync(file, locatorArgs,
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...homeEnv, DOFLOW_CONFIG_DIR: undefined, DOFLOW_CLI: undefined, ...msysArgConvGuards() } });
  assert.equal(paths.status, 0, paths.stderr);
  // constitution_base echoes `pwd` from inside the script, which under Git Bash is /c/... MSYS
  // form; withinPath() compares that against realpath()'s native form portably.
  assert.ok(withinPath(JSON.parse(paths.stdout).constitution_base, fs.realpathSync(root)),
    `constitution_base ${JSON.parse(paths.stdout).constitution_base} is not inside ${fs.realpathSync(root)} — the locator must reach this project's runtime, not another install's`);

  const last = cli(['remove', root, '-f', '-t', 'claude,codex']);
  assert.equal(last.status, 0, last.stderr);
  assert.equal(fs.existsSync(dispatcher), false, 'the last claimant\'s removal must reclaim the shared tree');
  assert.deepEqual(ledgerOf().resources, []);
});
