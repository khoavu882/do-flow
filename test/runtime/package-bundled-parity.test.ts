'use strict';

// Feature 122 A.6 (IC-013, IC-014, IC-015, FR-010, NFR-001): moving `debate-3` out of core/registry/protocols.json
// into the bundled first-party package `doflow` changes nothing a user can see.
//
// `test/fixtures/packages/parity-070ad2c5.json` holds, from before the move: the output of `doflow protocol
// --action list|resolve` for every kind, task class, risk level and preset id, captured from develop 070ad2c5
// (`runs`), and the protocols.json of the commit the move starts from, 0d089f70 (`protocolsBeforeMove`; A.2 had
// added `synthesizerStrength` since 070ad2c5). The merged view must deep-equal that file, and every recorded run
// must print the same bytes now. A scratch copy of the bundled package with one field changed turns the parity red (the
// revert control), and the installed layout (bin/, src/ and core/registry/ only, as ~/.doflow/runtime) must pass too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadProtocols, loadCoreProtocols, presetIds, contributedPresetIds } = require('../../src/runtime/review/protocols.ts');
const { contributionsFor, firstPartyPresets } = require('../../src/runtime/packages/contributions.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'packages', 'parity-070ad2c5.json'), 'utf8'));
const REGISTRY = path.join(REPO_ROOT, 'core', 'registry');
const BUNDLED = path.join(REGISTRY, 'packages', 'doflow');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

/** A scratch runtime root: a copy of core/registry (the bundled package included) and package.json. */
function scratchRoot(t: any, { packageJson = true }: any = {}): string {
  const root = tempDir(t, 'doflow-parity-');
  fs.cpSync(REGISTRY, path.join(root, 'core', 'registry'), { recursive: true });
  if (packageJson) fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  return root;
}
const edit = (file: string, mutate: (data: any) => void) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** Run one recorded argv against the runtime at `root` in a scratch HOME and project; the result as the fixture stores it. */
function runner(t: any, root: string) {
  const dir = tempDir(t, 'doflow-parity-run-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  const cli = path.join(root, 'bin', 'doflow.js');
  const env: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: cli, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  return (argv: string) => {
    const res = spawnSync(process.execPath, [cli, 'protocol', ...argv.split(' ')], { cwd, env, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout };
  };
}
const diffs = (run: (key: string) => any, keys: string[]) => keys.filter((key: string) => JSON.stringify(run(key)) !== JSON.stringify(FIXTURE.runs[key]));

test('the fixture covers every kind, task class, risk level and preset of the pre-move registry', () => {
  assert.deepEqual(FIXTURE.kinds, ['review', 'debate']);
  assert.equal(FIXTURE.classes.length, 9);
  assert.deepEqual(FIXTURE.risks, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  assert.deepEqual(FIXTURE.presets, Object.keys(FIXTURE.protocolsBeforeMove.presets));
  for (const kind of FIXTURE.kinds) {
    for (const cls of [null, ...FIXTURE.classes]) {
      for (const risk of [null, ...FIXTURE.risks]) {
        if (!cls && !risk) continue;
        const key = `--action resolve --kind ${kind}${cls ? ` --task-class ${cls}` : ''}${risk ? ` --risk ${risk}` : ''} --json`;
        assert.ok(Object.hasOwn(FIXTURE.runs, key), key);
      }
    }
  }
  assert.ok(Object.hasOwn(FIXTURE.runs, '--action list --json'));
});

test('core protocols.json no longer holds debate-3 and still lists it first in order.debate', () => {
  const core = JSON.parse(fs.readFileSync(path.join(REGISTRY, 'protocols.json'), 'utf8'));
  assert.equal(Object.hasOwn(core.presets, 'debate-3'), false);
  assert.deepEqual(core.order.debate, ['debate-3', 'debate-2']);
  assert.deepEqual(core.order, FIXTURE.protocolsBeforeMove.order, 'order is unchanged');
  assert.deepEqual(loadCoreProtocols().errors, [], 'the core-only file is not an error on its own');
});

test('the merged view equals the pre-move protocols.json: presets, order, lenses, invariants', () => {
  const loaded = loadProtocols();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.registry, FIXTURE.protocolsBeforeMove);
  assert.deepEqual(loaded.notices, []);
  assert.deepEqual(loaded.provenance, { 'debate-3': { package: 'doflow', contentDigest: JSON.parse(fs.readFileSync(path.join(REGISTRY, 'contribution-points.json'), 'utf8')).bundled[0].contentDigest } });
});

test('presetIds stays the core order; first-party ids the order names are core, not contributed', () => {
  const { registry } = loadProtocols();
  assert.deepEqual(presetIds(registry, 'debate'), ['debate-3', 'debate-2']);
  assert.deepEqual(contributedPresetIds(registry, 'debate'), []);
  assert.deepEqual(contributedPresetIds(registry, 'review'), []);
});

test('`doflow protocol --action list|resolve` prints what the pre-move base printed, for every recorded run', (t: any) => {
  const keys = Object.keys(FIXTURE.runs);
  assert.equal(keys.length, 118);
  assert.deepEqual(diffs(runner(t, REPO_ROOT), keys), []);
});

test('revert control: one changed field in the bundled debate-3 turns the merged view and the output red', (t: any) => {
  const root = scratchRoot(t);
  assert.deepEqual(loadProtocols({ repoRoot: root }).registry, FIXTURE.protocolsBeforeMove, 'the unedited copy is at parity');
  edit(path.join(root, 'core', 'registry', 'packages', 'doflow', 'presets', 'debate-3.json'), (p) => { p.rounds.min = 2; });
  assert.notDeepEqual(loadProtocols({ repoRoot: root }).registry, FIXTURE.protocolsBeforeMove);
});

test('installed layout: bin/, src/ and core/registry/ only, no package.json and no core/shared; debate-3 stays active and `protocol list` equals the fixture', (t: any) => {
  const root = tempDir(t, 'doflow-installed-');
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(root, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(REGISTRY, path.join(root, 'core', 'registry'), { recursive: true });
  assert.deepEqual(fs.readdirSync(root).sort(), ['bin', 'core', 'src']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'core')), ['registry']);

  resetPackageView();
  const [pkg]: any[] = packageView({ repoRoot: root }).packages;
  assert.equal(pkg.id, 'doflow');
  assert.equal(pkg.state, 'active', JSON.stringify(pkg.reasons));
  assert.deepEqual(pkg.reasons, []);
  assert.deepEqual(loadProtocols({ repoRoot: root }).registry, FIXTURE.protocolsBeforeMove);

  const lists = Object.keys(FIXTURE.runs).filter((key) => key.startsWith('--action list'));
  assert.equal(lists.length, 6);
  assert.deepEqual(diffs(runner(t, root), lists), []);

  // `resolve` reads the seat agents' specs from core/shared/agent-specs (review/start.ts loadEnforcementInputs), which the
  // projected runtime does not ship; that was so before 122 and is not this task's. With the specs beside it, every run matches.
  fs.cpSync(path.join(REPO_ROOT, 'core', 'shared', 'agent-specs'), path.join(root, 'core', 'shared', 'agent-specs'), { recursive: true });
  assert.deepEqual(diffs(runner(t, root), Object.keys(FIXTURE.runs)), [], 'every recorded run');
});

test('a readable package.json that differs from the bundled manifest still makes the package host-incompatible', (t: any) => {
  const root = scratchRoot(t);
  edit(path.join(root, 'package.json'), (p) => { p.version = '9.9.9'; });
  resetPackageView();
  const [pkg]: any[] = packageView({ repoRoot: root }).packages;
  assert.equal(pkg.state, 'incompatible');
  assert.deepEqual(pkg.reasons, ['host-incompatible']);
});

// ── IC-013 contributionsFor ────────────────────────────────────────────────────────────────────────

test('contributionsFor returns the active bundled presets: bare id, data, provenance, no dir', () => {
  const list = contributionsFor('debate-preset', 1);
  assert.equal(list.length, 1);
  const [item] = list;
  assert.deepEqual(Object.keys(item).sort(), ['data', 'dir', 'firstParty', 'localId', 'packageId', 'provenance', 'qualifiedId']);
  assert.equal(item.qualifiedId, 'debate-3');
  assert.equal(item.localId, 'debate-3');
  assert.equal(item.packageId, 'doflow');
  assert.equal(item.firstParty, true);
  assert.equal(item.dir, null);
  assert.deepEqual(item.data, FIXTURE.protocolsBeforeMove.presets['debate-3']);
  assert.deepEqual(item.provenance, { contentDigest: packageView().packages[0].contentDigest, source: { type: 'bundled' } });
  assert.deepEqual(contributionsFor('review-preset', 1), [], 'a point with no contribution is empty');
});

test('contributionsFor throws a programming error for a reserved point, an undeclared point and an unsupported version', () => {
  assert.throws(() => contributionsFor('capability-provider', 1), /reserved/);
  assert.throws(() => contributionsFor('no-such-point', 1), /not declared/);
  assert.throws(() => contributionsFor('debate-preset', 2), /no version 2/);
});

test('contributionsFor lists entries in ascending qualified id order and leaves out an inactive package or an invalid entry, naming it', (t: any) => {
  const root = scratchRoot(t);
  const dir = path.join(root, 'core', 'registry', 'packages', 'doflow');
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'presets', 'debate-3.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'presets', 'a-wide.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'presets', 'broken.json'), JSON.stringify({ ...base, rounds: { default: 9, min: 9 } }));
  edit(path.join(dir, 'doflow-package.json'), (m: any) => {
    m.contributions.push({ point: 'debate-preset', version: 1, id: 'a-wide', file: 'presets/a-wide.json' },
      { point: 'debate-preset', version: 1, id: 'broken', file: 'presets/broken.json' },
      { point: 'debate-preset', version: 1, id: 'gone', file: 'presets/gone.json' });
  });
  resetPackageView();
  const problems: string[] = [];
  const list = contributionsFor('debate-preset', 1, { repoRoot: root, problems });
  assert.deepEqual(list.map((c: any) => c.qualifiedId), ['a-wide', 'debate-3']);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems.join('\n'), /'broken' is left out: .*hardRoundCap/);
  assert.match(problems.join('\n'), /'gone' is left out: presets\/gone\.json cannot be read/);

  edit(path.join(root, 'package.json'), (p: any) => { p.version = '9.9.9'; });
  resetPackageView();
  assert.deepEqual(contributionsFor('debate-preset', 1, { repoRoot: root }), [], 'an incompatible package contributes nothing');
});

// ── IC-014 loadProtocols: provenance, notices, effective order ─────────────────────────────────────

test('a contributed id the order does not name is selectable by name only: in presets and contributedPresetIds, never in order', (t: any) => {
  const root = scratchRoot(t);
  const dir = path.join(root, 'core', 'registry', 'packages', 'doflow');
  fs.writeFileSync(path.join(dir, 'presets', 'debate-4.json'), JSON.stringify({ ...FIXTURE.protocolsBeforeMove.presets['debate-3'], rounds: { default: 3, min: 3 } }));
  edit(path.join(dir, 'doflow-package.json'), (m: any) => { m.contributions.push({ point: 'debate-preset', version: 1, id: 'debate-4', file: 'presets/debate-4.json' }); });
  resetPackageView();
  const loaded = loadProtocols({ repoRoot: root });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(presetIds(loaded.registry, 'debate'), ['debate-3', 'debate-2']);
  assert.deepEqual(contributedPresetIds(loaded.registry, 'debate'), ['debate-4']);
  assert.equal(loaded.registry.presets['debate-4'].kind, 'debate');
  assert.deepEqual(Object.keys(loaded.provenance).sort(), ['debate-3', 'debate-4']);
});

test('an order id whose bundled package is not active is skipped from the effective order and noticed, not refused', (t: any) => {
  const root = scratchRoot(t);
  edit(path.join(root, 'package.json'), (p: any) => { p.version = '9.9.9'; });
  resetPackageView();
  const loaded = loadProtocols({ repoRoot: root });
  assert.equal(loaded.ok, true, loaded.errors.join('; '));
  assert.deepEqual(presetIds(loaded.registry, 'debate'), ['debate-2']);
  assert.equal(Object.hasOwn(loaded.registry.presets, 'debate-3'), false);
  assert.deepEqual(loaded.notices, ["order.debate names 'debate-3', which no active package provides; it is skipped from the effective order"]);
  assert.deepEqual(loaded.provenance, {});
});

test('a bundled package that is missing is skipped and noticed too; an order id nobody can supply stays a validation error', (t: any) => {
  const root = scratchRoot(t);
  fs.rmSync(path.join(root, 'core', 'registry', 'packages'), { recursive: true });
  resetPackageView();
  const missing = loadProtocols({ repoRoot: root });
  assert.equal(missing.ok, true, missing.errors.join('; '));
  assert.deepEqual(presetIds(missing.registry, 'debate'), ['debate-2']);
  assert.equal(missing.notices.length, 1);

  const healthy = scratchRoot(t);
  edit(path.join(healthy, 'core', 'registry', 'protocols.json'), (p: any) => { p.order.debate.unshift('debate-9'); });
  resetPackageView();
  const typo = loadProtocols({ repoRoot: healthy });
  assert.equal(typo.ok, false);
  assert.match(typo.errors.join('\n'), /order\.debate lists 'debate-9', which is not a debate preset/);
});

test('firstPartyPresets names the bundled ids from the manifests, and is opaque only when a manifest names none', (t: any) => {
  assert.deepEqual(firstPartyPresets(), { review: [], debate: ['debate-3'], opaque: false });
  const root = scratchRoot(t);
  fs.rmSync(path.join(root, 'core', 'registry', 'packages', 'doflow', 'doflow-package.json'));
  resetPackageView();
  assert.deepEqual(firstPartyPresets({ repoRoot: root }), { review: [], debate: [], opaque: true });
});
