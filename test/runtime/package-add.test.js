'use strict';

// Feature 122 B.4 (IC-006, IC-012 `add` and `update` for a local source, IC-024 storage): the add plan, the
// store and the apply. Every test runs against a scratch HOME and a scratch XDG_CONFIG_HOME; nothing here
// touches `grants.jsonl` or the real `~/.doflow`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { applyPlan, planPackage, planIdFor } = require('../../src/runtime/packages/store.ts');
const { readLock, lockPackages, lockPath, defaultLock, writeLock } = require('../../src/state/lockfile.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { runPass } = require('../../src/runtime/storage/engine.ts');
const { checkPackage } = require('../../src/runtime/packages/manifest.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const CORE = require('../../src/runtime/review/protocols.ts').loadProtocols().registry;
const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const HOUR = 3600000;

const strictPreset = (rounds = 2) => {
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  preset.rounds = { default: rounds, min: 1 };
  return preset;
};
const manifestOf = (overrides = {}) => ({
  manifest: 1, id: 'acme', version: '1.2.0', summary: 'Stricter review presets', doflow: '>=2.0.0-beta.1 <3.0.0',
  contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  ...overrides,
});

/** A package directory (fresh each call) whose preset takes `rounds`; edit it with `fs` to change the source. */
function makePackage(t, manifest = manifestOf(), preset = strictPreset()) {
  const dir = path.join(tempDir(t, 'doflow-padd-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
  return dir;
}

const scratchOf = (t, options = { prune: 'on' }) => {
  const scratch = createScratch('doflow-padd-', options);
  t.after(() => scratch.remove());
  return scratch;
};

/** Run the handler in process against the scratch home; `process.exitCode` is put back after the call. */
function run(scratch, args, extra = {}) {
  const lines = [];
  const saved = process.exitCode;
  try {
    const code = handlePackageCommand({ homeDir: scratch.home, json: false, out: (l) => lines.push(l), ...args, ...extra });
    return { code, lines, text: lines.join('\n') };
  } finally { process.exitCode = saved; }
}

const packagesDir = (scratch) => path.join(scratch.home, '.doflow', 'packages');
const planFiles = (scratch) => {
  try { return fs.readdirSync(path.join(packagesDir(scratch), 'plans')).sort(); } catch { return []; }
};
const readPlan = (scratch, id) => JSON.parse(fs.readFileSync(path.join(packagesDir(scratch), 'plans', `${id}.json`), 'utf8'));
/** The one plan file that is not in `before` (a set of plan file names). */
const planIdOf = (scratch, before = new Set()) => {
  const files = planFiles(scratch).filter((f) => f.endsWith('.json') && !before.has(f));
  assert.equal(files.length, 1, `exactly one new plan file, got ${files}`);
  return files[0].slice(0, -5);
};
const lockRows = (scratch) => lockPackages(readLock({ scope: 'global', homeDir: scratch.home }));

/** Every path under `root`, relative, with directories marked, for a before/after listing. */
function tree(root, base = root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    out.push(path.relative(base, full) + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory()) tree(full, base, out);
  }
  return out.sort();
}

function addAndPlan(t, scratch, dir) {
  const before = new Set(planFiles(scratch));
  const planned = run(scratch, { action: 'add', source: dir });
  assert.equal(planned.code, 0, planned.text);
  return planIdOf(scratch, before);
}

test('add --source writes the plan file and nothing else (negative control: no store, no lock, no state)', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const before = tree(scratch.home);
  const planned = run(scratch, { action: 'add', source: dir });
  assert.equal(planned.code, 0, planned.text);
  const added = tree(scratch.home).filter((p) => !before.includes(p));
  const id = planIdOf(scratch);
  assert.deepEqual(added, ['.doflow/', '.doflow/packages/', '.doflow/packages/plans/', `.doflow/packages/plans/${id}.json`]);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: scratch.home })), false);
  assert.match(planned.text, new RegExp(`plan ${id}`));
  assert.match(planned.text, new RegExp(`package --action add --plan ${id}`), 'it says how to apply');
  assert.match(planned.text, /review-preset acme\.strict inert/, 'it prints the inventory');
});

test('the plan file is the IC-006 shape with the checker digests, a placeholder projection and no trust line for an inert package', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  const plan = readPlan(scratch, id);
  const checked = checkPackage(dir, { hostVersion: HOST, bundled: [] });
  assert.deepEqual(Object.keys(plan).sort(), ['action', 'capabilityDigest', 'contentDigest', 'createdAt', 'findings', 'grantLines', 'inventory', 'package', 'plan', 'planId', 'programs', 'projection', 'source', 'trustPolicyVersion']);
  assert.equal(plan.plan, 1);
  assert.equal(plan.planId, id);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(plan.action, 'add');
  assert.deepEqual(plan.source, { type: 'local', path: fs.realpathSync(dir) === dir ? dir : path.resolve(dir) });
  assert.deepEqual(plan.package, { id: 'acme', version: '1.2.0', doflow: '>=2.0.0-beta.1 <3.0.0' });
  assert.equal(plan.contentDigest, checked.contentDigest);
  assert.equal(plan.capabilityDigest, checked.capabilityDigest);
  assert.equal(plan.trustPolicyVersion, 1);
  assert.deepEqual(plan.inventory, [{ point: 'review-preset', qualifiedId: 'acme.strict', tier: 'inert' }]);
  assert.deepEqual(plan.programs, []);
  assert.deepEqual(plan.projection, {}, 'the projection stays a placeholder until Phase C');
  assert.deepEqual(plan.findings, []);
  assert.deepEqual(plan.grantLines, {}, 'an inert package needs no grant');
  const expected = crypto.createHash('sha256')
    .update(`${plan.contentDigest}\0${plan.capabilityDigest}\0${JSON.stringify({ path: plan.source.path, type: 'local' })}`).digest('hex').slice(0, 16);
  assert.equal(id, expected, 'plan id = first 16 hex of sha256(content NUL capability NUL canonical source)');
  assert.match(plan.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('a package above the inert tier gets the exact trust line for the planned digests and the print time', (t) => {
  const scratch = scratchOf(t);
  const root = tempDir(t, 'doflow-padd-root-');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'core', 'shared'), path.join(root, 'core', 'shared'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version: HOST }));
  const pointsFile = path.join(root, 'core', 'registry', 'contribution-points.json');
  const points = JSON.parse(fs.readFileSync(pointsFile, 'utf8'));
  points.trustPolicyVersion = 3;
  points.points.find((p) => p.id === 'review-preset').tier = 'instruction';
  fs.writeFileSync(pointsFile, JSON.stringify(points, null, 2));
  const dir = makePackage(t);
  const before = Date.now();
  const planned = run(scratch, { action: 'add', source: dir, repoRoot: root });
  assert.equal(planned.code, 0, planned.text);
  const plan = readPlan(scratch, planIdOf(scratch));
  const line = JSON.parse(plan.grantLines.trust);
  assert.deepEqual(Object.keys(line), ['grant', 'package', 'version', 'contentDigest', 'capabilityDigest', 'policy', 'at']);
  assert.deepEqual({ ...line, at: null }, { grant: 'trust', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, capabilityDigest: plan.capabilityDigest, policy: 3, at: null });
  assert.match(line.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(line.at) >= Math.floor(before / 1000) * 1000 - 1000 && Date.parse(line.at) <= Date.now() + 1000);
  assert.equal(plan.trustPolicyVersion, 3);
  assert.ok(planned.text.includes(plan.grantLines.trust), 'the printed text carries the line a person would add');
  assert.equal(fs.existsSync(path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl')), false, 'DoFlow never writes the grants file');
});

test('a checker error refuses with its findings and writes no plan', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifestOf({ doflow: '^2.0.0' })));
  const refused = run(scratch, { action: 'add', source: dir, json: true });
  assert.equal(refused.code, 1);
  const body = JSON.parse(refused.lines.join(''));
  assert.equal(body.ok, false);
  assert.ok(body.findings.some((f) => f.severity === 'error'));
  assert.deepEqual(planFiles(scratch), []);
});

test('--source takes only an existing local directory: anything else is usage and writes nothing', (t) => {
  const scratch = scratchOf(t);
  for (const source of [path.join(scratch.dir, 'no-such-dir'), path.join(makePackage(t), 'doflow-package.json')]) {
    const refused = run(scratch, { action: 'add', source });
    assert.equal(refused.code, 2, source);
    assert.match(refused.text, /local package directory/);
  }
  assert.equal(run(scratch, { action: 'add' }).code, 2, 'neither --source nor --plan');
  assert.equal(run(scratch, { action: 'add', source: makePackage(t), plan: 'aaaaaaaaaaaaaaaa' }).code, 2, 'both');
  assert.equal(run(scratch, { action: 'add', plan: 'not-a-plan-id' }).code, 2, 'a plan id is 16 hex');
  assert.deepEqual(tree(scratch.home), []);
});

test('add then apply lands disabled with a lock row, a store entry, a marker beside the tree and no staging left', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  const plan = readPlan(scratch, id);
  const applied = run(scratch, { action: 'add', plan: id });
  assert.equal(applied.code, 0, applied.text);
  const rows = lockRows(scratch);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], addedAt: null }, {
    id: 'acme', version: '1.2.0', source: plan.source, contentDigest: plan.contentDigest, capabilityDigest: plan.capabilityDigest, enabled: false, addedAt: null,
  });
  assert.match(rows[0].addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const lock = readLock({ scope: 'global', homeDir: scratch.home });
  assert.equal(lock.version, 2);
  assert.deepEqual(lock.targets, []);
  const entry = path.join(packagesDir(scratch), 'store', 'acme', plan.contentDigest.slice(0, 16));
  assert.equal(fs.readFileSync(path.join(entry, 'presets', 'strict.json'), 'utf8'), fs.readFileSync(path.join(dir, 'presets', 'strict.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(entry, '.installed-from.json')), false, 'the marker is never inside the tree');
  const marker = JSON.parse(fs.readFileSync(`${entry}.installed-from.json`, 'utf8'));
  assert.deepEqual({ planId: marker.planId, source: marker.source, contentDigest: marker.contentDigest }, { planId: id, source: plan.source, contentDigest: plan.contentDigest });
  assert.deepEqual(fs.readdirSync(path.join(packagesDir(scratch), 'store')).filter((n) => n.startsWith('.staging-')), []);
  assert.equal(fs.existsSync(path.join(scratch.home, '.doflow', 'state', 'run.lock')), false, 'the run lock is released');
  assert.match(applied.text, /acme 1\.2\.0/);
  assert.match(applied.text, /disabled/);
});

test('editing the source between plan and apply gives digest-mismatch with no store entry and no lock change', (t) => {
  const scratch = scratchOf(t);
  // an existing lock row from another package, so "no lock change" is a byte comparison
  run(scratch, { action: 'add', plan: addAndPlan(t, scratch, makePackage(t, manifestOf({ id: 'other' }))) });
  const lockBytes = fs.readFileSync(lockPath({ scope: 'global', homeDir: scratch.home }));
  const storeBefore = tree(path.join(packagesDir(scratch), 'store'));

  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  fs.appendFileSync(path.join(dir, 'README.md'), 'edited after the plan\n');
  const refused = run(scratch, { action: 'add', plan: id, json: true });
  assert.equal(refused.code, 1);
  const body = JSON.parse(refused.lines.join(''));
  assert.equal(body.ok, false);
  assert.ok(body.findings.some((f) => f.code === 'digest-mismatch' && f.severity === 'error'), refused.text);
  assert.deepEqual(tree(path.join(packagesDir(scratch), 'store')), storeBefore, 'no store entry and no staging');
  assert.deepEqual(fs.readFileSync(lockPath({ scope: 'global', homeDir: scratch.home })), lockBytes, 'the lock is byte-identical');
});

test('a capability change alone (same bytes, other trust policy) is also digest-mismatch', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  const planFile = path.join(packagesDir(scratch), 'plans', `${id}.json`);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.capabilityDigest = 'f'.repeat(64);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const refused = run(scratch, { action: 'add', plan: id });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /digest-mismatch/);
  assert.equal(fs.existsSync(path.join(packagesDir(scratch), 'store', 'acme')), false);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: scratch.home })), false);
});

test('a staged copy that differs from the plan is digest-mismatch and leaves no staging and no entry', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  const refused = run(scratch, { action: 'add', plan: id }, {
    hooks: { afterCopy: (staging) => fs.appendFileSync(path.join(staging, 'README.md'), 'changed while copying\n') },
  });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /digest-mismatch/);
  assert.deepEqual(tree(path.join(packagesDir(scratch), 'store')), []);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: scratch.home })), false);
});

test('an injected failure after the rename removes the entry and leaves no lock row', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  const seen = {};
  assert.throws(() => applyPlan({
    planId: id, homeDir: scratch.home,
    hooks: { afterRename: (entry) => { seen.entry = entry; assert.equal(fs.existsSync(entry), true, 'the entry exists when the seam runs'); throw new Error('injected'); } },
  }), /injected/);
  assert.equal(fs.existsSync(seen.entry), false, 'the entry is gone');
  assert.deepEqual(tree(path.join(packagesDir(scratch), 'store')), []);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: scratch.home })), false, 'no lock was written');
  assert.equal(fs.existsSync(path.join(scratch.home, '.doflow', 'state', 'run.lock')), false, 'the run lock is released on failure');
  // the same plan still applies afterwards
  assert.equal(run(scratch, { action: 'add', plan: id }).code, 0);
  assert.equal(lockRows(scratch).length, 1);
});

test('a failure after the rename keeps an earlier lock row and the other package intact', (t) => {
  const scratch = scratchOf(t);
  const first = addAndPlan(t, scratch, makePackage(t, manifestOf({ id: 'first' })));
  assert.equal(run(scratch, { action: 'add', plan: first }).code, 0);
  const lockBytes = fs.readFileSync(lockPath({ scope: 'global', homeDir: scratch.home }));
  const second = addAndPlan(t, scratch, makePackage(t));
  assert.throws(() => applyPlan({ planId: second, homeDir: scratch.home, hooks: { afterRename: () => { throw new Error('boom'); } } }), /boom/);
  assert.deepEqual(fs.readFileSync(lockPath({ scope: 'global', homeDir: scratch.home })), lockBytes);
  assert.deepEqual(fs.readdirSync(path.join(packagesDir(scratch), 'store')), ['first']);
});

test('adding an id that is already recorded is collision-package at plan time and at apply time', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  assert.equal(run(scratch, { action: 'add', plan: id }).code, 0);
  const again = run(scratch, { action: 'add', source: dir });
  assert.equal(again.code, 1);
  assert.match(again.text, /collision-package/);
  const reapplied = run(scratch, { action: 'add', plan: id });
  assert.equal(reapplied.code, 1);
  assert.match(reapplied.text, /collision-package/);
  assert.equal(lockRows(scratch).length, 1);
});

test('apply refuses an unknown or missing plan without writing', (t) => {
  const scratch = scratchOf(t);
  const refused = run(scratch, { action: 'add', plan: '0123456789abcdef' });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /file-missing/);
  assert.deepEqual(tree(scratch.home).filter((p) => !p.startsWith('.doflow/state')), []);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: scratch.home })), false);
});

test('update plans from the recorded source and applies by replacing the row, then removing the old entry', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const id = addAndPlan(t, scratch, dir);
  assert.equal(run(scratch, { action: 'add', plan: id }).code, 0);
  const [first] = lockRows(scratch);
  // the person enables it, then the author ships 1.3.0
  writeLock({ scope: 'global', homeDir: scratch.home }, { ...readLock({ scope: 'global', homeDir: scratch.home }), packages: [{ ...first, enabled: true }] });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifestOf({ version: '1.3.0' }), null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(strictPreset(3), null, 2));

  const before = new Set(planFiles(scratch));
  const planned = run(scratch, { action: 'update', id: 'acme' });
  assert.equal(planned.code, 0, planned.text);
  const updateId = planIdOf(scratch, before);
  const plan = readPlan(scratch, updateId);
  assert.equal(plan.action, 'update');
  assert.equal(plan.package.version, '1.3.0');
  assert.deepEqual(plan.source, first.source);
  assert.notEqual(plan.contentDigest, first.contentDigest);
  assert.deepEqual(lockRows(scratch), [{ ...first, enabled: true }], 'planning changes no record');

  const applied = run(scratch, { action: 'update', plan: updateId });
  assert.equal(applied.code, 0, applied.text);
  const [next] = lockRows(scratch);
  assert.equal(next.version, '1.3.0');
  assert.equal(next.contentDigest, plan.contentDigest);
  assert.equal(next.capabilityDigest, plan.capabilityDigest);
  assert.equal(next.enabled, true, 'the enable bit is the person’s and stays; a trust grant naming the old digest no longer matches');
  assert.equal(next.addedAt, first.addedAt);
  const store = path.join(packagesDir(scratch), 'store', 'acme');
  assert.deepEqual(fs.readdirSync(store).sort(), [plan.contentDigest.slice(0, 16), `${plan.contentDigest.slice(0, 16)}.installed-from.json`].sort(), 'the old tree and its marker are gone');
});

test('update refuses an unknown id, and an add plan cannot be applied as an update', (t) => {
  const scratch = scratchOf(t);
  const unknown = run(scratch, { action: 'update', id: 'ghost' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /no package with id 'ghost'/);
  assert.equal(run(scratch, { action: 'update' }).code, 2, 'neither --id nor --plan');
  const id = addAndPlan(t, scratch, makePackage(t));
  const wrong = run(scratch, { action: 'update', plan: id });
  assert.equal(wrong.code, 1, 'an add plan is not an update plan');
  assert.deepEqual(lockRows(scratch).length, 0);
});

test('a plan older than 24 hours and a stale staging directory are pruned by the next apply; fresh ones and store entries stay', (t) => {
  const scratch = scratchOf(t);
  const plans = path.join(packagesDir(scratch), 'plans');
  const store = path.join(packagesDir(scratch), 'store');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(path.join(store, '.staging-0000000000000001'), { recursive: true });
  fs.writeFileSync(path.join(store, '.staging-0000000000000001', 'x'), 'x');
  fs.mkdirSync(path.join(store, '.staging-0000000000000002'), { recursive: true });
  fs.mkdirSync(path.join(store, 'keeper', 'aaaaaaaaaaaaaaaa'), { recursive: true });
  fs.writeFileSync(path.join(plans, 'ffffffffffffffff.json'), '{}');
  fs.writeFileSync(path.join(plans, 'eeeeeeeeeeeeeeee.json'), '{}');
  const old = new Date(Date.now() - 25 * HOUR);
  for (const p of [path.join(plans, 'ffffffffffffffff.json'), path.join(store, '.staging-0000000000000001', 'x'), path.join(store, '.staging-0000000000000001'), path.join(store, 'keeper', 'aaaaaaaaaaaaaaaa'), path.join(store, 'keeper')]) fs.utimesSync(p, old, old);
  const id = addAndPlan(t, scratch, makePackage(t));
  assert.equal(run(scratch, { action: 'add', plan: id }).code, 0);
  assert.deepEqual(planFiles(scratch).sort(), ['eeeeeeeeeeeeeeee.json', `${id}.json`].sort());
  assert.deepEqual(fs.readdirSync(store).sort(), ['.staging-0000000000000002', 'acme', 'keeper']);
  assert.equal(fs.existsSync(path.join(store, 'keeper', 'aaaaaaaaaaaaaaaa')), true, 'a store entry is kept until remove');
});

test('the storage engine prunes plans and staging at 24 hours and never a store entry, through a scratch HOME', (t) => {
  const scratch = scratchOf(t);
  const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry, global: true, env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg } });
  const plans = path.join(packagesDir(scratch), 'plans');
  const store = path.join(packagesDir(scratch), 'store');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(path.join(store, '.staging-aaaaaaaaaaaaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(store, 'acme', '0123456789abcdef'), { recursive: true });
  fs.writeFileSync(path.join(plans, 'aaaaaaaaaaaaaaaa.json'), '{}');
  fs.writeFileSync(path.join(plans, 'bbbbbbbbbbbbbbbb.json'), '{}');
  const stale = (when) => new Date(Date.now() - when * HOUR);
  fs.utimesSync(path.join(plans, 'aaaaaaaaaaaaaaaa.json'), stale(23), stale(23));
  fs.utimesSync(path.join(plans, 'bbbbbbbbbbbbbbbb.json'), stale(25), stale(25));
  fs.utimesSync(path.join(store, '.staging-aaaaaaaaaaaaaaaa'), stale(25), stale(25));
  fs.utimesSync(path.join(store, 'acme'), stale(900), stale(900));
  const stores = ['packages-store', 'packages-plans', 'packages-staging', 'packages-state'];
  const report = runPass({ registry, roots, stores, mode: 'report', setting: { 'user-doflow': 'on' } });
  assert.deepEqual(report.stores.map((s) => s.id).sort(), ['packages-plans', 'packages-staging'], 'only the two bounded stores are removable');
  const pruned = runPass({ registry, roots, stores, mode: 'prune', setting: { 'user-doflow': 'on' } });
  assert.equal(pruned.stores.reduce((n, s) => n + s.removed, 0), 2);
  assert.deepEqual(fs.readdirSync(plans), ['aaaaaaaaaaaaaaaa.json']);
  assert.deepEqual(fs.readdirSync(store).sort(), ['acme']);
});

// --- the CLI: flag forwarding and the upkeep exception (IC-012) ----------------------------------------------------

function cli(scratch, args) {
  const result = spawnSync(process.execPath, [CLI, 'package', ...args], {
    env: scratch.env(), encoding: 'utf8', cwd: scratch.dir,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('the CLI forwards --source and --plan; only the apply runs storage upkeep', (t) => {
  const scratch = scratchOf(t);
  const dir = makePackage(t);
  const planned = cli(scratch, ['--action', 'add', '--source', dir, '--json']);
  assert.equal(planned.code, 0, planned.err);
  const id = JSON.parse(planned.out).plan.planId;
  assert.deepEqual(tree(scratch.home), ['.doflow/', '.doflow/packages/', '.doflow/packages/plans/', `.doflow/packages/plans/${id}.json`], 'add without --plan writes only the plan, and runs no upkeep');
  // upkeep visits a state directory that exists; a first-ever run lock would have made one and removed it again
  fs.mkdirSync(path.join(scratch.home, '.doflow', 'state'), { recursive: true });
  const applied = cli(scratch, ['--action', 'add', '--plan', id]);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(lockRows(scratch).length, 1);
  assert.equal(fs.existsSync(path.join(scratch.home, '.doflow', 'state', 'upkeep-due')), true, 'add --plan runs upkeep like other writers');
  const updatePlanned = cli(scratch, ['--action', 'update', '--id', 'acme', '--json']);
  assert.equal(updatePlanned.code, 0, updatePlanned.err);
  assert.equal(JSON.parse(updatePlanned.out).plan.action, 'update');
  const usage = cli(scratch, ['--action', 'add']);
  assert.equal(usage.code, 2);
});

test('a plan id never starts with 13 decimal digits: an all-digit candidate is rerolled to 16 hex and the plan survives its own apply', (t) => {
  // the seam hands back an all-digit candidate first, then the real hash of the rerolled text
  const texts = [];
  const hash = (text) => { texts.push(text); return texts.length === 1 ? '1234567890123456'.repeat(4) : crypto.createHash('sha256').update(text).digest('hex'); };
  const id = planIdFor('x', hash);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(id, /^[0-9]{13}/);
  assert.deepEqual(texts, ['x', 'x\u00001']);
  assert.equal(planIdFor('x'), crypto.createHash('sha256').update('x').digest('hex').slice(0, 16), 'without a collision the id is the plain IC-006 derivation');

  const scratch = scratchOf(t);
  const planned = planPackage({ action: 'add', source: makePackage(t), homeDir: scratch.home, hash: (() => { let n = 0; return (text) => (n++ === 0 ? '9'.repeat(64) : crypto.createHash('sha256').update(text).digest('hex')); })() });
  assert.equal(planned.ok, true);
  const planId = planned.plan.planId;
  assert.doesNotMatch(planId, /^[0-9]{13}/);
  assert.deepEqual(planFiles(scratch), [`${planId}.json`]);
  const applied = run(scratch, { action: 'add', plan: planId });
  assert.equal(applied.code, 0, applied.text);
  assert.deepEqual(planFiles(scratch), [`${planId}.json`], 'the apply-time prune keeps the fresh plan');
});
