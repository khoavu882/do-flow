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
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const ASSET = 'runtime.lib';
const NATIVE_DIR = '../.doflow/runtime/src';
const HARNESSES = ['alpha', 'beta'];

/** The registry for one shared tree: each harness projects it through `assetOf[harness]` (the
 * guidance tree is two assets, guidance.context-layer and Kiro's kiro.guidance-tree). */
function treeRegistry(assetOf: any, nativeDir: any) {
  return {
    harnesses: HARNESSES.map((id) => ({
      id, displayName: id, adapter: id, scopes: ['project', 'user'], nativeTargets: {},
      capabilities: { scripts: { status: 'supported' } },
    })),
    assets: [...new Set(Object.values(assetOf))].map((assetId: any) => {
      const owners = HARNESSES.filter((id) => assetOf[id] === assetId);
      return {
        id: assetId, kind: 'script', source: 'src', appliesTo: owners, ownership: 'managed-tree',
        projection: Object.fromEntries(owners.map((id) => [id, { renderer: 'copy-tree', capability: 'scripts' }])),
        nativeDir: Object.fromEntries(owners.map((id) => [id, nativeDir])),
      };
    }),
    mcp: [], lifecycle: [],
  };
}

const RUNTIME_TREE = { assetOf: { alpha: ASSET, beta: ASSET }, nativeDir: NATIVE_DIR };
const GUIDANCE_TREE = { assetOf: { alpha: 'guidance.context-layer', beta: 'kiro.guidance-tree' }, nativeDir: '../.doflow/guidance' };

const sha = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A harness projecting the runtime tree the way every real adapter does: planTree with its own
 * rows and its siblings' fingerprints, keepModified on apply, removeTree on any non-retained
 * copy-tree removal, and a verifier that reports what is on disk. */
function runtimeAdapter(id: any, { ownRequired = false, asset: ASSET = 'runtime.lib', nativeDir = NATIVE_DIR }: any = {}) {
  const tree = ({ scopeRoot, context }: any) => ({ sourceDir: path.join(context.repoRoot, 'src'), destDir: sharedTreeDestDir(scopeRoot, nativeDir) });
  return {
    discover() { return {}; },
    render() { return 'native'; },
    plan({ ledger, scopeRoot, context = {} }: any) {
      const removing = context.operation === 'remove';
      const result = planTree({ ...tree({ scopeRoot, context }), previousResources: ledgerFileResources(ledger.resources, id, ASSET),
        siblingFingerprints: ledgerSiblingFingerprints(ledger.resources, id), operation: removing ? 'remove' : 'apply', keepModified: !removing });
      const changes = result.changes.map((change: any) => ({
        assetId: ASSET, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:${id}:copy-tree:${ASSET}:${change.relPath}`, kind: 'copy-tree-file', identity: change.relPath,
        fingerprint: change.fingerprint, sourceVersion: 'test', projection: { renderer: 'copy-tree' },
        ...(change.kept ? { retained: true, retainedFor: [] } : {}),
      }));
      return {
        // Codex lists its own required resources instead of letting the lifecycle default to its changes.
        ...(ownRequired ? { requiredNativeResources: changes.map((change: any) => ({ harness: id, target: change.target, operation: change.operation })) } : {}),
        conflicts: result.conflicts,
        notices: result.kept.map((item: any) => `kept hand-edited ${path.relative(scopeRoot, item.target)}; DoFlow no longer manages it`),
        changes,
      };
    },
    apply({ changes }: any) {
      applyTree({ changes: changes.filter((change: any) => change.operation !== 'remove').map((change: any) => ({ ...change, relPath: change.identity })) });
      removeTree({ changes: changes.filter((change: any) => change.kind === 'copy-tree-file' && change.operation === 'remove')
        .map((change: any) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint, pruneGuard: change.pruneGuard })) });
    },
    remove(input: any) { this.apply(input); },
    verify({ scopeRoot, context = {} }: any) {
      const result = verifyTree({ ...tree({ scopeRoot, context }), plannedWrites: context.plannedWrites });
      return { ok: result.ok, conflicts: result.conflicts, statuses: [], resources: result.resources.map((resource: any) => ({
        assetId: ASSET, target: resource.target, identity: resource.relPath, kind: 'copy-tree-file',
        ownershipIdentity: `doflow:${id}:copy-tree:${ASSET}:${resource.relPath}`, fingerprint: resource.fingerprint,
        sourceVersion: 'test', projection: { renderer: 'copy-tree' },
      })) };
    },
  };
}

/** A project whose runtime source can be rewritten between runs, with alpha and beta installed. */
function project(t: any, files: any, adapterOptions = {}, { assetOf, nativeDir }: any = RUNTIME_TREE) {
  const root = tempDir(t, 'doflow-runtime-prune-');
  const repoRoot = path.join(root, 'repo');
  const scopeRoot = path.join(root, 'proj');
  const stateRoot = path.join(scopeRoot, '.doflow', 'state');
  const dest = sharedTreeDestDir(scopeRoot, nativeDir);
  const registry = treeRegistry(assetOf, nativeDir);
  const adapters = createAdapterRegistry(Object.fromEntries(HARNESSES.map((id) => [id, runtimeAdapter(id, { ...adapterOptions, asset: assetOf[id], nativeDir })])));
  let ledger = defaultLedger({ scope: 'project', scopeRoot });
  const ship = (next: any) => {
    fs.rmSync(path.join(repoRoot, 'src'), { recursive: true, force: true });
    for (const [rel, content] of Object.entries(next)) {
      fs.mkdirSync(path.dirname(path.join(repoRoot, 'src', rel)), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src', rel), content);
    }
  };
  const plan = (targets: any, operation?: any) => planLifecycle({ registry, adapters, scope: 'project', scopeRoot, targets, ledger,
    context: { repoRoot, ...(operation ? { operation } : {}) } });
  const apply = (planned: any) => {
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
    rowsAt: (rel: any) => ledger.resources.filter((row: any) => row.target === path.join(dest, rel)),
    remove: (targets: any) => { ledger = removeLifecycle({ registry, adapters, scope: 'project', scopeRoot, targets, ledger, stateRoot, context: { repoRoot } }).ledger; },
  };
}

const noticesOf = (planned: any) => planned.notices.map((item: any) => `${item.harness}: ${item.notice}`);
const changesAt = (planned: any, file: any) => planned.changes.filter((change: any) => change.target === file);

test('an update of one harness prunes a runtime file the source stopped shipping and releases the other harness\'s row with it', (t) => {
  const p = project(t, { 'helper/git.js': 'v1 js\n', 'keep.js': 'keep\n' });
  assert.equal(p.rowsAt('helper/git.js').length, 2, 'fixture: both harnesses hold a row on the file');
  p.ship({ 'helper/git.ts': 'v2 ts\n', 'keep.js': 'keep\n' });

  const planned = p.plan(['alpha']);
  const [removal] = changesAt(planned, path.join(p.dest, 'helper', 'git.js'));
  assert.equal(removal.harness, 'alpha');
  assert.equal(removal.retained, undefined, 'the removal beta\'s row used to retain is executed');
  const betaRow = p.rowsAt('helper/git.js').find((row: any) => row.harness === 'beta');
  assert.deepEqual(removal.supersedes, [ownershipKey(betaRow)]);
  assert.deepEqual(noticesOf(planned), ['alpha: prune .doflow/runtime/src/helper/git.js: no longer shipped, unchanged since DoFlow wrote it']);
  assert.deepEqual(planned.retained, []);
  const backup = backupSetFromPlan({ plan: planned, scope: 'project', scopeRoot: p.scopeRoot });
  assert.ok(backup.entries.some((entry: any) => entry.path === path.join(p.dest, 'helper', 'git.js')), 'the pruned file is backed up, so rollback can restore it');

  p.apply(planned);
  assert.equal(fs.existsSync(path.join(p.dest, 'helper', 'git.js')), false);
  assert.equal(fs.readFileSync(path.join(p.dest, 'helper', 'git.ts'), 'utf8'), 'v2 ts\n');
  assert.deepEqual(p.rowsAt('helper/git.js'), [], 'no row outlives its file, beta\'s included');
  assert.deepEqual(p.plan(['beta']).notices, [], 'beta\'s later update finds nothing left to prune');
});

test('a harness with no row on the orphan prunes it through a synthetic removal every adapter accepts', (t) => {
  const p = project(t, { 'helper/git.js': 'v1 js\n' });
  // The v1.14.2 Pi shape: the shared runtime was recorded by a sibling only.
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row: any) => row.harness !== 'alpha') };
  p.ship({ 'helper/git.ts': 'v2 ts\n' });

  const planned = p.plan(['alpha']);
  const file = path.join(p.dest, 'helper', 'git.js');
  const [removal] = changesAt(planned, file);
  assert.equal(removal.harness, 'alpha');
  assert.equal(removal.kind, 'copy-tree-file', 'claude, pi, kiro and opencode filter removals on kind');
  assert.equal(removal.projection.renderer, 'copy-tree', 'codex, antigravity and copilot filter removals on the renderer');
  assert.equal(removal.fingerprint, sha('v1 js\n'), 'removeTree re-checks these bytes before deleting');
  assert.deepEqual(removal.supersedes, p.rowsAt('helper/git.js').map((row: any) => ownershipKey(row)));

  p.apply(planned);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(p.rowsAt('helper/git.js'), []);
});

test('negative control: an orphan whose bytes differ from any claimant\'s latest record is kept and named, even when another claimant\'s matches', (t) => {
  const p = project(t, { 'a.js': 'v1\n' });
  p.ship({ 'a.js': 'v1.1\n' });
  p.apply(p.plan(['beta']));   // beta's row now says v1.1, alpha's still says v1, the disk holds v1.1
  p.ship({ 'a.ts': 'v2\n' });

  const planned = p.apply(p.plan(['alpha']));
  assert.ok(noticesOf(planned).includes('alpha: kept .doflow/runtime/src/a.js: no longer shipped, and its bytes differ from what alpha last recorded'), noticesOf(planned).join('\n'));
  assert.equal(fs.readFileSync(path.join(p.dest, 'a.js'), 'utf8'), 'v1.1\n', 'one stale claimant is enough to keep it');
});

// Sol's reproducers (row 130 review of the guidance prune), for the guidance tree and a runtime
// tree alike: both go through the same prune.
for (const [label, tree, file] of [['guidance', GUIDANCE_TREE, 'FLAGS.md'], ['runtime', RUNTIME_TREE, 'old.js']] as any) {
  test(`negative control (${label}): a user-restored older version is kept when another claimant recorded a newer one`, (t) => {
    const p = project(t, { [file]: 'v1\n', keep: 'keep\n' }, {}, tree);   // alpha and beta record v1
    p.ship({ [file]: 'v2\n', keep: 'keep\n' });
    p.apply(p.plan(['beta']));                                         // beta writes v2 and records it
    fs.writeFileSync(path.join(p.dest, file), 'v1\n');                // the user restores v1
    p.ship({ keep: 'keep\n' });                                       // the next release drops the file

    const planned = p.apply(p.plan(['alpha']));
    assert.equal(fs.readFileSync(path.join(p.dest, file), 'utf8'), 'v1\n', 'a match against alpha\'s older record does not authorize the delete');
    const shown = path.relative(p.scopeRoot, path.join(p.dest, file));
    assert.ok(noticesOf(planned).includes(`alpha: kept ${shown}: no longer shipped, and its bytes differ from what beta last recorded`), noticesOf(planned).join('\n'));
  });

  test(`negative control (${label}): a tree swapped for a link out of the scope between plan and apply is refused at delete time`, (t) => {
    const p = project(t, { [file]: 'v1\n', keep: 'keep\n' }, {}, tree);
    p.ship({ keep: 'keep\n' });
    const planned = p.plan(['alpha']);
    assert.ok(changesAt(planned, path.join(p.dest, file)).some((change: any) => !change.retained), 'fixture: at plan time the orphan is pruned');
    const outside = path.join(path.dirname(p.scopeRoot), 'global-tree');
    fs.renameSync(p.dest, outside);
    fs.symlinkSync(outside, p.dest, 'dir');
    assert.throws(() => p.apply(planned), /resolves outside the scope root/);
    assert.equal(fs.readFileSync(path.join(outside, file), 'utf8'), 'v1\n');
  });

  test(`negative control (${label}): a tree whose directory links outside the scope root is not pruned, and is named once`, (t) => {
    const p = project(t, { [file]: 'v1\n', keep: 'keep\n' }, {}, tree);
    const outside = path.join(path.dirname(p.scopeRoot), 'global-tree');  // e.g. ~/.doflow/guidance
    fs.renameSync(p.dest, outside);
    fs.symlinkSync(outside, p.dest, 'dir');
    p.ship({ keep: 'keep\n' });

    const planned = p.apply(p.plan(['alpha']));
    assert.equal(fs.readFileSync(path.join(outside, file), 'utf8'), 'v1\n', 'the file outside the scope is untouched');
    const shownTree = path.relative(p.scopeRoot, p.dest);
    assert.deepEqual(noticesOf(planned).filter((n: any) => n.includes('outside')), [`alpha: kept ${shownTree}: it resolves outside the scope root, so no file in it is pruned`]);
  });

  test(`negative control (${label}): a parent directory linked outside the scope root keeps the tree too`, (t) => {
    const p = project(t, { [file]: 'v1\n', keep: 'keep\n' }, {}, tree);
    const doflow = path.join(p.scopeRoot, '.doflow');
    const outside = path.join(path.dirname(p.scopeRoot), 'global-doflow');   // e.g. ~/.doflow
    fs.renameSync(doflow, outside);
    fs.symlinkSync(outside, doflow, 'dir');
    p.ship({ keep: 'keep\n' });

    const planned = p.apply(p.plan(['alpha']));
    assert.equal(fs.readFileSync(path.join(outside, path.relative(doflow, p.dest), file), 'utf8'), 'v1\n');
    assert.equal(noticesOf(planned).filter((n: any) => n.includes('resolves outside the scope root')).length, 1);
  });
}

test('negative control: an orphan edited after DoFlow wrote it is kept and named, and its rows are not released by the prune', (t) => {
  const p = project(t, { 'a.js': 'v1\n', 'b.js': 'v1 b\n' });
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row: any) => !(row.harness === 'alpha' && row.identity === 'b.js')) };
  p.ship({ 'a.ts': 'v2\n' });
  fs.appendFileSync(path.join(p.dest, 'a.js'), '// mine\n');
  fs.appendFileSync(path.join(p.dest, 'b.js'), '// mine\n');

  const planned = p.apply(p.plan(['alpha']));
  assert.ok(changesAt(planned, path.join(p.dest, 'a.js')).every((change: any) => change.retained), 'alpha\'s own row is released, the file is not deleted');
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
  assert.ok(changesAt(first, path.join(p.dest, 'lib', 'old.js')).every((change: any) => change.retained), 'nothing deletes through the link');
  assert.deepEqual(noticesOf(first), ['alpha: kept .doflow/runtime/src/lib/old.js: no longer shipped, but it resolves outside .doflow/runtime/src']);
  const last = p.apply(p.plan(['beta']));   // the last claimant: no sibling row retains it any more
  assert.ok(changesAt(last, path.join(p.dest, 'lib', 'old.js')).every((change: any) => change.retained));
  assert.equal(fs.readFileSync(path.join(outside, 'old.js'), 'utf8'), 'v1\n', 'the file outside the tree is untouched');
});

/** Whether `dir` sits on a case-insensitive filesystem (APFS and NTFS by default). */
function caseInsensitive(dir: any) {
  const probe = path.join(dir, `.case-probe-${process.pid}`);
  fs.writeFileSync(probe, '');
  try { return fs.existsSync(path.join(dir, `.CASE-PROBE-${process.pid}`)); }
  finally { fs.rmSync(probe, { force: true }); }
}

test('negative control: an orphan row of a harness outside the run that names a produced file under another case is kept (B3)', (t) => {
  const p = project(t, { 'x/Bar.js': 'same\n' });
  if (!caseInsensitive(p.dest)) { t.skip('needs a case-insensitive filesystem'); return; }
  // Only beta records the old spelling, so no planned removal of alpha's exists and planTree's own
  // same-file guard never sees it: the prune's guard alone keeps the produced file.
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row: any) => row.harness !== 'alpha') };
  p.ship({ 'x/bar.js': 'same\n' });

  const planned = p.plan(['alpha']);
  const old = path.join(p.dest, 'x', 'Bar.js');
  assert.deepEqual(changesAt(planned, old).filter((change: any) => change.operation === 'remove' && !change.retained), [],
    'nothing removes the old spelling: on this filesystem it is the file the source produces');
  p.apply(planned);
  assert.equal(fs.readFileSync(path.join(p.dest, 'x', 'bar.js'), 'utf8'), 'same\n', 'the produced file survives the update');
});

test('negative control: a directory swapped for a symlink between plan and apply is not deleted through; delete time re-checks containment (B6)', (t) => {
  const p = project(t, { 'lib/old.js': 'v1\n', 'keep.js': 'keep\n' });
  p.ship({ 'keep.js': 'keep\n' });
  const planned = p.plan(['alpha']);
  const [removal] = changesAt(planned, path.join(p.dest, 'lib', 'old.js'));
  assert.ok(removal && !removal.retained, 'fixture: at plan time the orphan is inside the tree and pruned');

  // While the confirm prompt waits: the directory becomes a link to an outside one with the same bytes.
  const outside = path.join(path.dirname(p.scopeRoot), 'outside-lib');
  fs.renameSync(path.join(p.dest, 'lib'), outside);
  fs.symlinkSync(outside, path.join(p.dest, 'lib'), 'dir');
  assert.throws(() => p.apply(planned), /Refusing to remove copy-tree resource lib\/old\.js: it resolves outside/);
  assert.equal(fs.readFileSync(path.join(outside, 'old.js'), 'utf8'), 'v1\n', 'the file outside the tree is untouched');
});

test('negative control: an orphan hard-linked to a shipped file between plan and apply is not deleted; delete time re-checks the inode (B6)', (t) => {
  const p = project(t, { 'old.js': 'same\n', 'keep.js': 'keep\n' });
  p.ship({ 'keep.js': 'keep\n' });
  const planned = p.plan(['alpha']);
  assert.ok(changesAt(planned, path.join(p.dest, 'old.js')).some((change: any) => !change.retained), 'fixture: the orphan is pruned at plan time');
  fs.rmSync(path.join(p.dest, 'old.js'));
  fs.writeFileSync(path.join(p.dest, 'keep.js'), 'same\n');
  fs.linkSync(path.join(p.dest, 'keep.js'), path.join(p.dest, 'old.js'));
  assert.throws(() => p.apply(planned), /Refusing to remove copy-tree resource old\.js: it is the same file as .*keep\.js/);
  assert.equal(fs.existsSync(path.join(p.dest, 'old.js')), true);
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

test('a plan holding only the prune\'s own changes applies for an adapter that lists its own required resources', (t) => {
  const p = project(t, { 'gone.js': 'v1\n', 'kept.js': 'k\n' }, { ownRequired: true });
  fs.rmSync(path.join(p.dest, 'gone.js'));
  p.ship({ 'kept.js': 'k\n' });
  const planned = p.plan(['alpha']);
  assert.deepEqual(planned.changes.map((change: any) => [change.harness, path.basename(change.target), change.retained === true]), [['alpha', 'gone.js', true]]);
  p.apply(planned);
  assert.deepEqual(p.rowsAt('gone.js'), []);
});

test('removal is untouched: a harness removed while another stays still only releases its claim on the runtime', (t) => {
  const p = project(t, { 'a.js': 'v1\n' });
  p.remove(['alpha']);
  assert.equal(fs.readFileSync(path.join(p.dest, 'a.js'), 'utf8'), 'v1\n', 'NFR-007: beta still needs it');
  assert.deepEqual(p.rowsAt('a.js').map((row: any) => row.harness), ['beta']);
});

// ------------------------------------------------------------------------------ the real CLI

// Row 130: guidance files retired from the source (FLAGS.md, rules/RULE_0N_*.md) are pruned the same
// way, across the two assets that project the shared guidance tree.
test('guidance: an update of one harness prunes a retired guidance file and releases the other asset\'s row', (t) => {
  const p = project(t, { 'DOFLOW_CORE.md': '@FLAGS.md\n', 'FLAGS.md': 'flags\n' }, {}, GUIDANCE_TREE);
  assert.equal(p.rowsAt('FLAGS.md').length, 2, 'fixture: both assets hold a row on the file');
  p.ship({ 'DOFLOW_CORE.md': '@rules/RULES.md\n', 'rules/RULES.md': 'rules\n' });

  const planned = p.plan(['alpha']);
  assert.deepEqual(noticesOf(planned), ['alpha: prune .doflow/guidance/FLAGS.md: no longer shipped, unchanged since DoFlow wrote it']);
  p.apply(planned);
  assert.equal(fs.existsSync(path.join(p.dest, 'FLAGS.md')), false);
  assert.deepEqual(p.rowsAt('FLAGS.md'), [], 'no row outlives its file, kiro.guidance-tree\'s included');
});

test('guidance negative control: a retired guidance file edited after DoFlow wrote it is kept and named; MCP_INDEX.md is not named', (t) => {
  const p = project(t, { 'DOFLOW_CORE.md': '@FLAGS.md\n', 'FLAGS.md': 'flags\n' }, {}, GUIDANCE_TREE);
  p.ledger = { ...p.ledger, resources: p.ledger.resources.filter((row: any) => !(row.harness === 'alpha' && row.identity === 'FLAGS.md')) };
  fs.appendFileSync(path.join(p.dest, 'FLAGS.md'), 'mine\n');
  fs.writeFileSync(path.join(p.dest, 'MCP_INDEX.md'), '# generated per install, never a ledger row\n');
  p.ship({ 'DOFLOW_CORE.md': '@rules/RULES.md\n' });

  const planned = p.apply(p.plan(['alpha']));
  assert.deepEqual(noticesOf(planned), ['alpha: kept .doflow/guidance/FLAGS.md: no longer shipped, changed since DoFlow wrote it']);
  assert.match(fs.readFileSync(path.join(p.dest, 'FLAGS.md'), 'utf8'), /mine/);
  assert.equal(p.rowsAt('FLAGS.md').length, 1, 'the sibling\'s row on the edited file stays');
  // MCP_INDEX.md is the lifecycle's own write (an empty MCP selection deletes it); the prune only must not name it.
});

test('CLI: update names each pruned file and each retained one, in --dry-run and for real, and --dry-run deletes nothing', { timeout: 180000 }, (t) => {
  const root = tempDir(t, 'doflow-runtime-prune-cli-');
  const proj = path.join(root, 'proj');
  const home = path.join(root, 'home');
  fs.mkdirSync(proj, { recursive: true });
  const env: any = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), DOFLOW_FAILURE_CAPTURE: 'off' };
  delete env.PI_CODING_AGENT_DIR;
  const cli = (args: any, input = '\n') => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'doflow.js'), ...args], { cwd: root, encoding: 'utf8', input, env });
  const installed = cli(['install', proj, '-f', '--no-backup', '-t', 'claude,codex']);
  assert.equal(installed.status, 0, installed.stderr);

  // What an earlier release leaves: a file it shipped, written and recorded by both harnesses, that
  // this source no longer produces. One in the runtime tree (pruned), one in the scripts tree
  // (retained while claude, outside the run, still claims it).
  const ledgerFile = path.join(proj, '.doflow', 'state', 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const retired = { 'runtime.lib': ['runtime', 'src', 'retired.js'], 'scripts.doflow': ['scripts', 'retired.sh'] };
  for (const [assetId, parts] of Object.entries(retired)) {
    const target = path.join(proj, '.doflow', ...parts);
    fs.writeFileSync(target, `${assetId} from an earlier release\n`);
    for (const harness of ['claude', 'codex']) {
      const template = ledger.resources.find((row: any) => row.harness === harness && row.assetId === assetId);
      assert.ok(template, `fixture: ${harness} holds ${assetId} rows`);
      const identity = parts[parts.length - 1];
      ledger.resources.push({ ...template, target, identity, ownershipIdentity: template.ownershipIdentity.replace(template.identity, identity),
        fingerprint: sha(fs.readFileSync(target)) });
    }
  }
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  const runtimeFile = path.join(proj, '.doflow', ...retired['runtime.lib']);
  const scriptsFile = path.join(proj, '.doflow', ...retired['scripts.doflow']);

  const dry = cli(['update', proj, '--dry-run', '-t', 'codex']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\[DRY\] {3}codex: prune \.doflow\/runtime\/src\/retired\.js: no longer shipped, unchanged since DoFlow wrote it$/m);
  assert.match(dry.stdout, /^\[DRY\] {2}codex: retained 1 shared resource\(s\) still claimed by claude$/m);
  assert.ok(fs.existsSync(runtimeFile) && fs.existsSync(scriptsFile), '--dry-run deletes nothing');

  const real = cli(['update', proj, '-t', 'codex'], 'y\n');
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^\[INFO\] codex: prune \.doflow\/runtime\/src\/retired\.js: no longer shipped, unchanged since DoFlow wrote it$/m);
  assert.match(real.stdout, /^\[INFO\] codex: retained 1 shared resource\(s\) still claimed by claude$/m);
  assert.equal(fs.existsSync(runtimeFile), false);
  assert.equal(fs.existsSync(scriptsFile), true, 'outside the runtime trees NFR-007 still keeps what claude claims');
  const after = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).resources;
  assert.deepEqual(after.filter((row: any) => row.target === runtimeFile), [], 'claude\'s row on the pruned file went with it');
  assert.deepEqual(after.filter((row: any) => row.target === scriptsFile).map((row: any) => row.harness), ['claude']);
});
