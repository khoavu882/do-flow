'use strict';

// global-instructions.test.ts — row 127 IC-007: antigravity's marker-managed DoFlow section in the
// global ~/.gemini/GEMINI.md. A global install appends it to the person's file (or creates the file),
// verify reports it under its own row, and removal hands the person's bytes back exactly. While
// another live harness declares the same file (gemini, until it is retired), antigravity leaves it
// alone, so two adapters never write one marker pair.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, selectAssets } = require('../../../src/registry/index.ts');
const { projectAdapterInput } = require('../../../src/adapters/index.ts');
const { renderGuidancePointer } = require('../../../src/adapters/guidance-pointer.ts');
const { MARKER_START, MARKER_END } = require('../../../src/helper/marker-merge.ts');
const { buildAdapterRegistry } = require('../../../src/cli/shared.ts');
const { stateRoot, readLedger } = require('../../../src/state/index.ts');
const { planLifecycle, applyLifecycle } = require('../../../src/lifecycle/index.ts');
const adapter = require('../../../src/adapters/antigravity/index.ts');
const { tempDir } = require('../../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..', '..');
const USER = '# My global notes\n\nKeep this.\n';

function section(home: string): string {
  const body = fs.readFileSync(path.join(REPO, 'core', 'shared', 'guidance', 'pointers', 'codex.md'), 'utf8').trimEnd();
  return `${MARKER_START}\n${renderGuidancePointer(body, { scope: 'global', scopeRoot: home }).trimEnd()}\n${MARKER_END}\n`;
}

/** One run the way the lifecycle drives the adapter: discover, plan, apply or remove, verify. */
function run(home: string, { registry, operation = 'apply' }: any = {}) {
  const shipped = loadRegistry({ repoRoot: REPO });
  const harness = shipped.harnesses.find((item: any) => item.id === 'antigravity');
  const assets = selectAssets(shipped, { harness: 'antigravity' });
  const input = { ...projectAdapterInput({ registry: shipped, harness, scope: 'global', scopeRoot: home, assets, policies: [], context: {} }),
    ...(registry ? { registry } : {}), ledger: { resources: [] }, context: { repoRoot: REPO, homeDir: home, operation } };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  assert.deepEqual(planned.conflicts, []);
  adapter[operation === 'remove' ? 'remove' : 'apply']({ ...input, changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation });
  return { planned, verified };
}

const target = (home: string) => path.join(home, '.gemini', 'GEMINI.md');
const sectionChanges = (planned: any, home: string) => planned.changes.filter((change: any) => change.target === target(home));

test('IC-007: a global install appends the section to the person\'s GEMINI.md, verifies it under its own row, and re-plans to nothing', (t) => {
  const home = tempDir(t, 'doflow-agy-global-');
  fs.mkdirSync(path.dirname(target(home)), { recursive: true });
  fs.writeFileSync(target(home), USER);
  const { planned, verified } = run(home);
  const [change] = sectionChanges(planned, home);
  assert.equal(change.operation, 'update');
  assert.equal(change.assetId, 'guidance.codex-pointer');
  assert.equal(change.kind, 'instructions-section');
  assert.equal(change.identity, 'GEMINI.md');
  assert.equal(change.ownershipIdentity, 'doflow:antigravity:instructions:managed-section');
  assert.equal(change.projection.renderer, 'antigravity-instructions');
  assert.equal(fs.readFileSync(target(home), 'utf8'), `${USER}\n${section(home)}`);
  assert.ok(section(home).includes(path.join(home, '.doflow', 'guidance')), 'the pointer names the absolute global guidance tree');
  const resource = verified.resources.find((item: any) => item.target === target(home));
  assert.equal(resource.ownershipIdentity, 'doflow:antigravity:instructions:managed-section');
  assert.equal(resource.identity, 'GEMINI.md');
  assert.ok(verified.statuses.some((status: any) => status.target === target(home) && status.status === 'managed'));
  assert.deepEqual(sectionChanges(run(home).planned, home), [], 'idempotent');
});

test('control (f): a fresh global install with no history and `remove -g -t antigravity` hand the person\'s GEMINI.md back byte-identical', (t) => {
  for (const original of [USER, '', null]) {
    const home = tempDir(t, 'doflow-agy-global-');
    if (original !== null) {
      fs.mkdirSync(path.dirname(target(home)), { recursive: true });
      fs.writeFileSync(target(home), original);
    }
    run(home);
    assert.ok(fs.readFileSync(target(home), 'utf8').endsWith(section(home)));
    const { planned, verified } = run(home, { operation: 'remove' });
    assert.equal(sectionChanges(planned, home)[0].operation, 'remove');
    if (original === null) assert.ok(!fs.existsSync(target(home)), 'a file DoFlow created is removed with its section');
    else assert.equal(fs.readFileSync(target(home), 'utf8'), original, `byte-identical: ${JSON.stringify(original)}`);
    assert.ok(!verified.resources.some((item: any) => item.target === target(home)));
  }
});

test('the global section is planned only when the pointer asset is selected', (t) => {
  const home = tempDir(t, 'doflow-agy-global-');
  const input = { scope: 'global', scopeRoot: home, assets: [], mcp: [], ledger: { resources: [] }, context: { repoRoot: REPO, homeDir: home, operation: 'apply' } };
  assert.deepEqual(sectionChanges(adapter.plan(input), home), []);
});

test('while another live harness declares the same GEMINI.md, antigravity plans, verifies and removes nothing there', (t) => {
  const home = tempDir(t, 'doflow-agy-global-');
  fs.mkdirSync(path.dirname(target(home)), { recursive: true });
  fs.writeFileSync(target(home), USER);
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(registry.harnesses.some((harness: any) => harness.id === 'gemini'), 'precondition: gemini is live in the shipped registry');
  const { planned, verified } = run(home, { registry });
  assert.deepEqual(sectionChanges(planned, home), []);
  assert.ok(!verified.statuses.some((status: any) => status.target === target(home)));
  assert.equal(fs.readFileSync(target(home), 'utf8'), USER);
  assert.deepEqual(sectionChanges(run(home, { registry, operation: 'remove' }).planned, home), []);
});

test('proof: a global install of gemini and antigravity together converges on one DoFlow section in GEMINI.md', (t) => {
  const home = tempDir(t, 'doflow-agy-global-');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  const registry = loadRegistry({ repoRoot: REPO });
  const adapters = buildAdapterRegistry();
  const state = stateRoot({ scope: 'global', homeDir: home });
  const plan = () => planLifecycle({ registry, adapters, scope: 'global', scopeRoot: home, targets: ['gemini', 'antigravity'], ledger: readLedger(state) ?? undefined,
    context: { repoRoot: REPO, projectRoot: home, homeDir: home, sourceVersion: 'test', operation: 'install' } });
  for (let round = 0; round < 2; round += 1) {
    const p = plan();
    assert.deepEqual(p.conflicts, [], `round ${round}`);
    if (p.changes.length) applyLifecycle({ plan: p, registry, adapters, stateRoot: state, hasBashCapableShellFn: () => true });
  }
  const third = plan();
  assert.deepEqual(third.conflicts, []);
  assert.deepEqual(third.changes.filter((change: any) => change.target === target(home)), [], 'converged: nobody rewrites GEMINI.md');
  const text = fs.readFileSync(target(home), 'utf8');
  assert.equal(text.split('doflow:start').length - 1, 1, 'exactly one DoFlow section');
  const owners = readLedger(state).resources.filter((row: any) => row.target === target(home)).map((row: any) => row.harness);
  assert.deepEqual(owners, ['gemini'], 'one owner');
});
