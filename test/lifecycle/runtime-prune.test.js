'use strict';

// runtime-prune.test.js — 073 T4: a runtime file the current source no longer ships is pruned on
// any install or update, whichever harnesses the run targets, when its bytes prove DoFlow wrote it.
//
// The orphan used to survive a partial update: markRetainedRemovals keeps a removal any harness
// outside the run still claims, and a bare `update` targets claude alone. These cases drive the
// real copy-tree engine through planLifecycle/applyLifecycle for two harnesses sharing one runtime
// tree, then pin each way a file must be kept instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAdapterRegistry } = require('../../src/adapters/index.ts');
const { defaultLedger, ownershipKey } = require('../../src/state/index.ts');
const { planLifecycle, applyLifecycle, removeLifecycle } = require('../../src/lifecycle/index.ts');
const { planTree, applyTree, removeTree, verifyTree, ledgerFileResources, ledgerSiblingFingerprints, sharedTreeDestDir } = require('../../src/adapters/copy-tree.ts');
const { backupSetFromPlan } = require('../../src/install/backup-set.ts');
const { tempDir } = require('../helper/tmp');

const ASSET = 'runtime.lib';
const NATIVE_DIR = '../.doflow/runtime/src';
const HARNESSES = ['alpha', 'beta'];

const registry = {
  harnesses: HARNESSES.map((id) => ({
    id, displayName: id, adapter: id, scopes: ['project', 'user'], nativeTargets: {},
    capabilities: { scripts: { status: 'supported' } },
  })),
  assets: [{
    id: ASSET, kind: 'script', source: 'src', appliesTo: HARNESSES, ownership: 'managed-tree',
    projection: Object.fromEntries(HARNESSES.map((id) => [id, { renderer: 'copy-tree', capability: 'scripts' }])),
    nativeDir: Object.fromEntries(HARNESSES.map((id) => [id, NATIVE_DIR])),
  }],
  mcp: [], lifecycle: [],
};

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A harness projecting the runtime tree the way every real adapter does: planTree with its own
 * rows and its siblings' fingerprints, keepModified on apply, removeTree on any non-retained
 * copy-tree removal, and a verifier that reports what is on disk. */
function runtimeAdapter(id) {
  const tree = ({ scopeRoot, context }) => ({ sourceDir: path.join(context.repoRoot, 'src'), destDir: sharedTreeDestDir(scopeRoot, NATIVE_DIR) });
  return {
    discover() { return {}; },
    render() { return 'native'; },
    plan({ ledger, scopeRoot, context = {} }) {
      const removing = context.operation === 'remove';
      const result = planTree({ ...tree({ scopeRoot, context }), previousResources: ledgerFileResources(ledger.resources, id, ASSET),
        siblingFingerprints: ledgerSiblingFingerprints(ledger.resources, id), operation: removing ? 'remove' : 'apply', keepModified: !removing });
      return {
        conflicts: result.conflicts,
        notices: result.kept.map((item) => `kept hand-edited ${path.relative(scopeRoot, item.target)}; DoFlow no longer manages it`),
        changes: result.changes.map((change) => ({
          assetId: ASSET, target: change.target, source: change.source, operation: change.operation,
          ownershipIdentity: `doflow:${id}:copy-tree:${ASSET}:${change.relPath}`, kind: 'copy-tree-file', identity: change.relPath,
          fingerprint: change.fingerprint, sourceVersion: 'test', projection: { renderer: 'copy-tree' },
          ...(change.kept ? { retained: true, retainedFor: [] } : {}),
        })),
      };
    },
    apply({ changes }) {
      applyTree({ changes: changes.filter((change) => change.operation !== 'remove').map((change) => ({ ...change, relPath: change.identity })) });
      removeTree({ changes: changes.filter((change) => change.kind === 'copy-tree-file' && change.operation === 'remove')
        .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint })) });
    },
    remove(input) { this.apply(input); },
    verify({ scopeRoot, context = {} }) {
      const result = verifyTree({ ...tree({ scopeRoot, context }), plannedWrites: context.plannedWrites });
      return { ok: result.ok, conflicts: result.conflicts, statuses: [], resources: result.resources.map((resource) => ({
        assetId: ASSET, target: resource.target, identity: resource.relPath, kind: 'copy-tree-file',
        ownershipIdentity: `doflow:${id}:copy-tree:${ASSET}:${resource.relPath}`, fingerprint: resource.fingerprint,
        sourceVersion: 'test', projection: { renderer: 'copy-tree' },
      })) };
    },
  };
}

/** A project whose runtime source can be rewritten between runs, with alpha and beta installed. */
function project(t, files) {
  const root = tempDir(t, 'doflow-runtime-prune-');
  const repoRoot = path.join(root, 'repo');
  const scopeRoot = path.join(root, 'proj');
  const stateRoot = path.join(scopeRoot, '.doflow', 'state');
  const dest = path.join(scopeRoot, '.doflow', 'runtime', 'src');
  const adapters = createAdapterRegistry(Object.fromEntries(HARNESSES.map((id) => [id, runtimeAdapter(id)])));
  let ledger = defaultLedger({ scope: 'project', scopeRoot });
  const ship = (next) => {
    fs.rmSync(path.join(repoRoot, 'src'), { recursive: true, force: true });
    for (const [rel, content] of Object.entries(next)) {
      fs.mkdirSync(path.dirname(path.join(repoRoot, 'src', rel)), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src', rel), content);
    }
  };
  const plan = (targets, operation) => planLifecycle({ registry, adapters, scope: 'project', scopeRoot, targets, ledger,
    context: { repoRoot, ...(operation ? { operation } : {}) } });
  const apply = (planned) => {
    assert.deepEqual(planned.conflicts, []);
    ledger = applyLifecycle({ plan: planned, registry, adapters, stateRoot, ledger }).ledger;
    return planned;
  };
  ship(files);
  apply(plan(HARNESSES));
  return {
    scopeRoot, dest, ship, plan, apply,
    get ledger() { return ledger; },
    set ledger(next) { ledger = next; },
    rowsAt: (rel) => ledger.resources.filter((row) => row.target === path.join(dest, rel)),
    remove: (targets) => { ledger = removeLifecycle({ registry, adapters, scope: 'project', scopeRoot, targets, ledger, stateRoot, context: { repoRoot } }).ledger; },
  };
}

const noticesOf = (planned) => planned.notices.map((item) => `${item.harness}: ${item.notice}`);
const changesAt = (planned, file) => planned.changes.filter((change) => change.target === file);

test('an update of one harness prunes a runtime file the source stopped shipping and releases the other harness\'s row with it', (t) => {
  const p = project(t, { 'helper/git.js': 'v1 js\n', 'keep.js': 'keep\n' });
  assert.equal(p.rowsAt('helper/git.js').length, 2, 'fixture: both harnesses hold a row on the file');
  p.ship({ 'helper/git.ts': 'v2 ts\n', 'keep.js': 'keep\n' });

  const planned = p.plan(['alpha']);
  const [removal] = changesAt(planned, path.join(p.dest, 'helper', 'git.js'));
  assert.equal(removal.harness, 'alpha');
  assert.equal(removal.retained, undefined, 'the removal beta\'s row used to retain is executed');
  const betaRow = p.rowsAt('helper/git.js').find((row) => row.harness === 'beta');
  assert.deepEqual(removal.supersedes, [ownershipKey(betaRow)]);
  assert.deepEqual(noticesOf(planned), ['alpha: prune .doflow/runtime/src/helper/git.js: no longer shipped, unchanged since DoFlow wrote it']);
  assert.deepEqual(planned.retained, []);
  const backup = backupSetFromPlan({ plan: planned, scope: 'project', scopeRoot: p.scopeRoot });
  assert.ok(backup.entries.some((entry) => entry.path === path.join(p.dest, 'helper', 'git.js')), 'the pruned file is backed up, so rollback can restore it');

  p.apply(planned);
  assert.equal(fs.existsSync(path.join(p.dest, 'helper', 'git.js')), false);
  assert.equal(fs.readFileSync(path.join(p.dest, 'helper', 'git.ts'), 'utf8'), 'v2 ts\n');
  assert.deepEqual(p.rowsAt('helper/git.js'), [], 'no row outlives its file, beta\'s included');
  assert.deepEqual(p.plan(['beta']).notices, [], 'beta\'s later update finds nothing left to prune');
});

test('a harness with no row on the orphan prunes it through a synthetic removal every adapter accepts', (t) => {
  const p = project(t, { 'helper/git.js': 'v1 js\n' });
  // The v1.14.2 Pi shape: the shared runtime was recorded by a sibling only.
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row) => row.harness !== 'alpha') };
  p.ship({ 'helper/git.ts': 'v2 ts\n' });

  const planned = p.plan(['alpha']);
  const file = path.join(p.dest, 'helper', 'git.js');
  const [removal] = changesAt(planned, file);
  assert.equal(removal.harness, 'alpha');
  assert.equal(removal.kind, 'copy-tree-file', 'claude, pi, kiro and opencode filter removals on kind');
  assert.equal(removal.projection.renderer, 'copy-tree', 'codex, gemini and copilot filter removals on the renderer');
  assert.equal(removal.fingerprint, sha('v1 js\n'), 'removeTree re-checks these bytes before deleting');
  assert.deepEqual(removal.supersedes, p.rowsAt('helper/git.js').map((row) => ownershipKey(row)));

  p.apply(planned);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(p.rowsAt('helper/git.js'), []);
});

test('an orphan a sibling rewrote last is pruned on the sibling\'s record, not kept under a false hand-edited label', (t) => {
  const p = project(t, { 'a.js': 'v1\n' });
  p.ship({ 'a.js': 'v1.1\n' });
  p.apply(p.plan(['beta']));   // beta's row now says v1.1, alpha's still says v1, the disk holds v1.1
  p.ship({ 'a.ts': 'v2\n' });

  const planned = p.plan(['alpha']);
  assert.deepEqual(noticesOf(planned), ['alpha: prune .doflow/runtime/src/a.js: no longer shipped, unchanged since DoFlow wrote it']);
  p.apply(planned);
  assert.equal(fs.existsSync(path.join(p.dest, 'a.js')), false);
  assert.deepEqual(p.rowsAt('a.js'), []);
});

test('negative control: an orphan edited after DoFlow wrote it is kept and named, and its rows are not released by the prune', (t) => {
  const p = project(t, { 'a.js': 'v1\n', 'b.js': 'v1 b\n' });
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row) => !(row.harness === 'alpha' && row.identity === 'b.js')) };
  p.ship({ 'a.ts': 'v2\n' });
  fs.appendFileSync(path.join(p.dest, 'a.js'), '// mine\n');
  fs.appendFileSync(path.join(p.dest, 'b.js'), '// mine\n');

  const planned = p.apply(p.plan(['alpha']));
  assert.ok(changesAt(planned, path.join(p.dest, 'a.js')).every((change) => change.retained), 'alpha\'s own row is released, the file is not deleted');
  assert.deepEqual(noticesOf(planned).sort(), [
    'alpha: kept hand-edited .doflow/runtime/src/a.js; DoFlow no longer manages it',
    'alpha: kept .doflow/runtime/src/b.js: no longer shipped, changed since DoFlow wrote it',
  ].sort(), 'both are named: alpha\'s own row by its adapter, the sibling-only one by the prune');
  assert.match(fs.readFileSync(path.join(p.dest, 'a.js'), 'utf8'), /mine/);
  assert.match(fs.readFileSync(path.join(p.dest, 'b.js'), 'utf8'), /mine/);
  assert.equal(p.rowsAt('b.js').length, 1, 'beta\'s row on the edited file stays: the prune releases only what it deletes');
});

test('negative control: a file no row records is kept and named, and nothing plans to touch it', (t) => {
  const p = project(t, { 'a.js': 'v1\n' });
  fs.writeFileSync(path.join(p.dest, 'my-notes.js'), 'user file\n');
  const planned = p.plan(['alpha']);   // nothing else changed, so the plan is only this notice
  assert.deepEqual(changesAt(planned, path.join(p.dest, 'my-notes.js')), []);
  assert.deepEqual(noticesOf(planned), ['alpha: kept .doflow/runtime/src/my-notes.js: not shipped by this version and not recorded as DoFlow\'s']);
  assert.equal(fs.readFileSync(path.join(p.dest, 'my-notes.js'), 'utf8'), 'user file\n');
});

test('negative control: an orphan whose real path leaves the tree through a symlinked directory is kept, for every harness', (t) => {
  const p = project(t, { 'lib/old.js': 'v1\n', 'keep.js': 'keep\n' });
  const outside = path.join(path.dirname(p.scopeRoot), 'outside-lib');
  fs.renameSync(path.join(p.dest, 'lib'), outside);
  fs.symlinkSync(outside, path.join(p.dest, 'lib'), 'dir');
  p.ship({ 'keep.js': 'keep\n' });

  const first = p.apply(p.plan(['alpha']));
  assert.ok(changesAt(first, path.join(p.dest, 'lib', 'old.js')).every((change) => change.retained), 'nothing deletes through the link');
  assert.deepEqual(noticesOf(first), ['alpha: kept .doflow/runtime/src/lib/old.js: no longer shipped, but it resolves outside .doflow/runtime/src']);
  const last = p.apply(p.plan(['beta']));   // the last claimant: no sibling row retains it any more
  assert.ok(changesAt(last, path.join(p.dest, 'lib', 'old.js')).every((change) => change.retained));
  assert.equal(fs.readFileSync(path.join(outside, 'old.js'), 'utf8'), 'v1\n', 'the file outside the tree is untouched');
});

test('a row whose file is already gone is released when the source no longer ships it, and kept while it still does', (t) => {
  const p = project(t, { 'gone.js': 'v1\n', 'shipped.js': 'still\n' });
  fs.rmSync(path.join(p.dest, 'gone.js'));
  fs.rmSync(path.join(p.dest, 'shipped.js'));
  p.ship({ 'shipped.js': 'still\n' });
  // An update with nothing else to do still releases the dangling rows; shipped.js is rewritten.
  p.apply(p.plan(['alpha']));
  assert.deepEqual(p.rowsAt('gone.js'), [], 'both harnesses\' rows on a file nothing ships and nothing holds are gone');
  assert.equal(fs.readFileSync(path.join(p.dest, 'shipped.js'), 'utf8'), 'still\n');
  assert.equal(p.rowsAt('shipped.js').length, 2);
});

test('removal is untouched: a harness removed while another stays still only releases its claim on the runtime', (t) => {
  const p = project(t, { 'a.js': 'v1\n' });
  p.remove(['alpha']);
  assert.equal(fs.readFileSync(path.join(p.dest, 'a.js'), 'utf8'), 'v1\n', 'NFR-007: beta still needs it');
  assert.deepEqual(p.rowsAt('a.js').map((row) => row.harness), ['beta']);
});
