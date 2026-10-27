'use strict';

// Feature 122 B.5 (IC-010, IC-013): the full package view over third-party packages. Packages are staged through the
// real B.4 `planPackage` + `applyPlan`; the person's trust and exempt lines are appended to `grants.jsonl` by the test
// (DoFlow never writes it); the lock bit is flipped the way the later `enable` verb will (read, change, write).
// Every case runs against a scratch HOME and a scratch XDG_CONFIG_HOME. The scratch config home lies under the system
// temp directory, where IC-008 ignores a grants file, so the view is given the `tmpDir` seam (a path nothing lies under);
// one case leaves the seam out and shows the grants file is ignored.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env.ts');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { contributionsFor } = require('../../src/runtime/packages/contributions.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { recordRevocation } = require('../../src/runtime/packages/state.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');

const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const NO_TMP = '/nonexistent-doflow-tmp';
const AT = '2026-10-24T09:12:03Z';

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

/** A package directory (fresh each call). */
function makePackage(t: any, manifest = manifestOf()) {
  const dir = path.join(tempDir(t, 'doflow-pstates-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(strictPreset(), null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
  return dir;
}

/** A scratch runtime root: a copy of core/registry and a package.json, with edits to the point registry. */
function fixtureRoot(t: any, { version = HOST, points = (p: any) => p } = {}) {
  const root = tempDir(t, 'doflow-pstates-root-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version }));
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  fs.writeFileSync(file, JSON.stringify(points(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
  return root;
}
/** The review-preset point moves to the instruction tier, so a package that contributes to it needs a trust line. */
const instructionTier = (p: any) => { p.points.find((x: any) => x.id === 'review-preset').tier = 'instruction'; return p; };
const rewritePoints = (root: any, change: any) => {
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
};

function world(t: any): any {
  const scratch = createScratch('doflow-pstates-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const w: any = {
    scratch, project, home: scratch.home, env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg },
    grantsFile: path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl'),
    storeRoot: path.join(scratch.home, '.doflow', 'packages', 'store'),
  };
  /** Stage a package through the B.4 plan and apply; the lock row is written `enabled: false` by the apply. */
  w.stage = (dir: any, repoRoot = REPO_ROOT) => {
    const planned = planPackage({ action: 'add', source: dir, homeDir: w.home, repoRoot, now: Date.parse(AT) });
    assert.equal(planned.ok, true, JSON.stringify(planned.findings));
    const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: w.home, repoRoot, env: scratch.env() });
    assert.equal(applied.ok, true, JSON.stringify(applied.findings));
    return { plan: planned.plan, storeDir: applied.storeDir };
  };
  /** Flip the lock bit, as the later `enable` / `disable` verbs will. */
  w.setEnabled = (id: any, enabled: any) => {
    const options = { scope: 'global', homeDir: w.home };
    const lock = readLock(options);
    writeLock(options, { ...lock, packages: lockPackages(lock).map((r: any) => (r.id === id ? { ...r, enabled } : r)) });
  };
  /** Append lines to grants.jsonl as the person would. */
  w.person = (...lines: any[]) => {
    fs.mkdirSync(path.dirname(w.grantsFile), { recursive: true });
    fs.appendFileSync(w.grantsFile, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  };
  w.view = (repoRoot = REPO_ROOT, extra = {}) => {
    resetPackageView();
    return packageView({ repoRoot, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {}, ...extra });
  };
  w.pkg = (id: any, repoRoot: any, extra: any) => w.view(repoRoot, extra).packages.find((p: any) => p.id === id);
  return w;
}

function readyWorld(t: any, { repoRoot = REPO_ROOT, manifest, enable = true }: any = {}): any {
  const w = world(t);
  const staged = w.stage(makePackage(t, manifest), repoRoot);
  if (enable) w.setEnabled('acme', true);
  return { w, ...staged };
}

const trustLine = (plan: any, extra = {}) => ({ ...JSON.parse(plan.grantLines.trust), ...extra });

// ── nothing third-party: nothing is hashed ────────────────────────────────────────────────────────────

function spy(log: any) {
  return new Proxy(fs, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { if (typeof args[0] === 'string') log.push([name, args[0]]); return value.apply(target, args); };
    },
  });
}

test('negative control: with no third-party package nothing is hashed and neither the store, the grants nor state.json is read', (t) => {
  const w = world(t);
  const log: any = [];
  resetPackageView();
  const view = packageView({ repoRoot: REPO_ROOT, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {}, fsImpl: spy(log) });
  assert.deepEqual(view.packages.map((p: any) => [p.id, p.state]), [['doflow', 'active']]);
  assert.deepEqual(log.filter(([name]: any[]) => name === 'readdirSync'), [], 'no tree was walked');
  assert.deepEqual(log.filter(([, file]: any[]) => /[\\/]packages[\\/]store|grants\.jsonl|state\.json/.test(file)), []);
});

test('a disabled entry is read no further than its manifest; an enabled entry is walked and re-hashed', (t) => {
  const { w, storeDir } = readyWorld(t, { enable: false });
  const log: any = [];
  resetPackageView();
  const off = packageView({ repoRoot: REPO_ROOT, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {}, fsImpl: spy(log) });
  assert.equal(off.packages.find((p: any) => p.id === 'acme').state, 'disabled');
  const under = log.filter(([, file]: any[]) => file.startsWith(storeDir));
  assert.deepEqual([...new Set(under.map(([name, file]: any[]) => `${name} ${path.relative(storeDir, file)}`))], ['readFileSync doflow-package.json']);

  w.setEnabled('acme', true);
  const walked: any = [];
  resetPackageView();
  packageView({ repoRoot: REPO_ROOT, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {}, fsImpl: spy(walked) });
  assert.ok(walked.some(([name, file]: any[]) => name === 'readdirSync' && file.startsWith(storeDir)), 'the control: the spy does see a walk');
  assert.ok(walked.some(([name, file]: any[]) => name === 'readFileSync' && file.endsWith('README.md')), 'every file is hashed, including one no contribution names');
});

// ── the five states ───────────────────────────────────────────────────────────────────────────────────

test('active: an enabled inert package, with the IC-010 fields', (t) => {
  const { w, storeDir, plan } = readyWorld(t);
  const view = w.view();
  assert.deepEqual(view.packages.map((p: any) => p.id), ['doflow', 'acme'], 'bundled first, then third-party by id');
  const pkg = view.packages[1];
  assert.deepEqual(Object.keys(pkg).sort(), ['capabilityDigest', 'contentDigest', 'contributions', 'enabled', 'firstParty', 'grant', 'id', 'reasons', 'source', 'state', 'storeDir', 'tierMax', 'version']);
  assert.equal(pkg.state, 'active');
  assert.deepEqual(pkg.reasons, []);
  assert.equal(pkg.firstParty, false);
  assert.equal(pkg.enabled, true);
  assert.equal(pkg.version, '1.2.0');
  assert.equal(pkg.tierMax, 'inert');
  assert.deepEqual(pkg.grant, { trust: false, exempt: false });
  assert.equal(pkg.contentDigest, plan.contentDigest);
  assert.equal(pkg.capabilityDigest, plan.capabilityDigest);
  assert.equal(pkg.storeDir, storeDir);
  assert.equal(storeDir, path.join(w.storeRoot, 'acme', plan.contentDigest.slice(0, 16)));
  assert.deepEqual(pkg.source, { type: 'local', path: plan.source.path });
  assert.deepEqual(pkg.contributions, [{ point: 'review-preset', version: 1, qualifiedId: 'acme.strict', tier: 'inert', active: true }]);
  assert.deepEqual(view.findings, []);
});

test('disabled by the lock bit, and by packages.disabled naming the layer', (t) => {
  const { w } = readyWorld(t, { enable: false });
  const byBit = w.pkg('acme');
  assert.equal(byBit.state, 'disabled');
  assert.equal(byBit.enabled, false);
  assert.deepEqual(byBit.reasons, ['disabled-by-lock']);
  assert.deepEqual(byBit.contributions.map((c: any) => c.active), [false]);

  w.setEnabled('acme', true);
  assert.equal(w.pkg('acme').state, 'active');
  const bySetting = w.pkg('acme', REPO_ROOT, { settingsView: { 'packages.disabled': { value: ['acme'], layer: 'project' } } });
  assert.equal(bySetting.state, 'disabled');
  assert.deepEqual(bySetting.reasons, ['disabled-by-project']);
  const invalid = w.pkg('acme', REPO_ROOT, { settingsView: { 'packages.disabled': { value: null, layer: 'project', state: 'invalid' } } });
  assert.deepEqual([invalid.state, invalid.reasons], ['disabled', ['settings-invalid']]);
  assert.equal(w.pkg('doflow', REPO_ROOT, { settingsView: { 'packages.disabled': { value: null, layer: 'project', state: 'invalid' } } }).state, 'active', 'the bundled package stays');
});

test('a lock row for the bundled package with enabled false disables it', (t) => {
  const w = world(t);
  const options = { scope: 'global', homeDir: w.home };
  writeLock(options, { version: 1, scope: 'global', scopeRoot: w.home, generatedAt: null, sourceVersion: null, targets: [], assets: [], mcpSelections: {},
    packages: [{ id: 'doflow', version: HOST, source: { type: 'bundled' }, contentDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64), enabled: false, addedAt: AT }] });
  const doflow = w.pkg('doflow');
  assert.deepEqual([doflow.state, doflow.reasons], ['disabled', ['disabled-by-lock']]);
  assert.equal(w.view().packages.length, 1, 'the bundled row makes no second package');
});

test('suspended content-changed: a flipped store byte, even in a file no contribution names; and a missing store entry', (t) => {
  const { w, storeDir } = readyWorld(t);
  assert.equal(w.pkg('acme').state, 'active');
  fs.appendFileSync(path.join(storeDir, 'README.md'), 'x');
  const flipped = w.pkg('acme');
  assert.deepEqual([flipped.state, flipped.reasons], ['suspended', ['content-changed']]);
  assert.deepEqual(flipped.contributions.map((c: any) => c.active), [false]);

  fs.rmSync(storeDir, { recursive: true });
  const missing = w.pkg('acme');
  assert.deepEqual([missing.state, missing.reasons], ['suspended', ['content-changed']]);
  assert.equal(missing.contentDigest.length, 64);
});

test('a disabled entry whose store entry is missing is suspended, not disabled', (t) => {
  const { w, storeDir } = readyWorld(t, { enable: false });
  fs.rmSync(storeDir, { recursive: true });
  assert.deepEqual([w.pkg('acme').state, w.pkg('acme').reasons], ['suspended', ['content-changed']]);
});

test('incompatible: host-incompatible without an exempt line, and the store is not consulted for the digest', (t) => {
  const { w } = readyWorld(t);
  const future = fixtureRoot(t, { version: '3.1.0' });
  const pkg = w.pkg('acme', future);
  assert.deepEqual([pkg.state, pkg.reasons], ['incompatible', ['host-incompatible']]);
  assert.equal(pkg.grant.exempt, false);
  assert.deepEqual(pkg.contributions.map((c: any) => c.active), [false]);
  assert.ok(w.view(future).findings.some((f: any) => f.package === 'acme' && f.code === 'host-incompatible' && f.severity === 'error'));
});

test('incompatible: an exempt line for exactly this package, version, content digest and host makes it active with a warning', (t) => {
  const { w, plan } = readyWorld(t);
  const future = fixtureRoot(t, { version: '3.1.0' });
  const exempt = (extra = {}) => ({ grant: 'exempt', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, host: '3.1.0', acceptRisk: true, at: AT, ...extra });

  w.person(exempt({ host: '3.2.0' }));
  const other = w.pkg('acme', future);
  assert.deepEqual([other.state, other.reasons, other.grant.exempt], ['incompatible', ['host-incompatible'], false], 'an exempt line for another host does not count');

  fs.rmSync(w.grantsFile);
  w.person(exempt({ contentDigest: 'c'.repeat(64) }));
  assert.equal(w.pkg('acme', future).state, 'incompatible', 'another content digest does not count');

  fs.rmSync(w.grantsFile);
  w.person(exempt({ version: '1.2.1' }));
  assert.equal(w.pkg('acme', future).state, 'incompatible', 'another version does not count');

  fs.rmSync(w.grantsFile);
  w.person(exempt());
  const view = w.view(future);
  const pkg = view.packages.find((p: any) => p.id === 'acme');
  assert.deepEqual([pkg.state, pkg.reasons, pkg.grant], ['active', [], { trust: false, exempt: true }]);
  assert.deepEqual(view.findings.filter((f: any) => f.package === 'acme').map((f: any) => [f.code, f.severity]), [['host-incompatible', 'warning']]);

  // On the host the range allows, the same line is not used.
  assert.deepEqual(w.pkg('acme').grant, { trust: false, exempt: false });
});

test('an exempt line is void when the person revoked the package after it, or when state.json is unreadable', (t) => {
  const { w, plan } = readyWorld(t);
  const future = fixtureRoot(t, { version: '3.1.0' });
  w.person({ grant: 'exempt', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, host: '3.1.0', acceptRisk: true, at: AT });
  assert.equal(w.pkg('acme', future).state, 'active');
  recordRevocation({ homeDir: w.home }, { packageId: 'acme', contentDigest: plan.contentDigest, at: '2026-10-24T10:00:00.000Z' });
  assert.equal(w.pkg('acme', future).state, 'incompatible');
  fs.writeFileSync(path.join(w.home, '.doflow', 'packages', 'state.json'), '{ not json');
  assert.equal(w.pkg('acme', future).state, 'incompatible');
});

test('incompatible: a manifest or contribution that fails the checker, and the IC-005 caps', (t) => {
  const { w, storeDir } = readyWorld(t);
  const capped = fixtureRoot(t, { points: (p) => { p.limits.files = 1; return p; } });
  const pkg = w.pkg('acme', capped);
  assert.equal(pkg.state, 'incompatible');
  assert.ok(pkg.reasons.includes('too-many-files'), pkg.reasons.join());

  // A point the current core no longer supports (the version list shrinks to none a contribution names).
  const dropped = fixtureRoot(t, { points: (p) => { p.points.find((x: any) => x.id === 'review-preset').versions = [2]; return p; } });
  assert.deepEqual([w.pkg('acme', dropped).state, w.pkg('acme', dropped).reasons], ['incompatible', ['unsupported-point-version']]);

  // A symlink added to the store entry breaks the tree rules.
  fs.symlinkSync('/etc/hosts', path.join(storeDir, 'link'));
  const linked = w.pkg('acme');
  assert.deepEqual([linked.state, linked.reasons], ['incompatible', ['symlink']]);
});

test('the order is incompatible > suspended > disabled > needs-trust > active', (t) => {
  const { w, storeDir } = readyWorld(t, { enable: false });
  const future = fixtureRoot(t, { version: '3.1.0' });
  assert.equal(w.pkg('acme', future).state, 'incompatible', 'incompatible outranks disabled');
  fs.rmSync(storeDir, { recursive: true });
  assert.equal(w.pkg('acme').state, 'suspended', 'suspended outranks disabled');
  assert.equal(w.pkg('acme', future).state, 'suspended', 'a store entry with no manifest cannot be judged against the host, so it stays suspended');
});

// ── needs-trust ───────────────────────────────────────────────────────────────────────────────────────

test('needs-trust grant-missing, then active with a valid trust line (the line DoFlow printed)', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  assert.ok(plan.grantLines.trust, 'the plan prints a trust line for an instruction-tier package');
  const before = w.pkg('acme', root);
  assert.deepEqual([before.state, before.reasons, before.tierMax, before.grant.trust], ['needs-trust', ['grant-missing'], 'instruction', false]);
  assert.deepEqual(before.contributions.map((c: any) => c.active), [false]);

  w.person(plan.grantLines.trust);
  const after = w.pkg('acme', root);
  assert.deepEqual([after.state, after.reasons, after.grant], ['active', [], { trust: true, exempt: false }]);
  assert.deepEqual(after.contributions.map((c: any) => c.active), [true]);
});

test('needs-trust: a disabled instruction package is disabled, not needs-trust', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w } = readyWorld(t, { repoRoot: root, enable: false });
  assert.equal(w.pkg('acme', root).state, 'disabled');
});

test('needs-trust reasons: content-changed, capabilities-changed, policy-changed', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  const reasonOf = (...lines: any[]) => {
    fs.rmSync(w.grantsFile, { force: true });
    w.person(...lines);
    const pkg = w.pkg('acme', root);
    assert.equal(pkg.state, 'needs-trust');
    return pkg.reasons;
  };
  assert.deepEqual(reasonOf(trustLine(plan, { contentDigest: 'c'.repeat(64) })), ['content-changed']);
  assert.deepEqual(reasonOf(trustLine(plan, { capabilityDigest: 'd'.repeat(64) })), ['capabilities-changed']);
  assert.deepEqual(reasonOf(trustLine(plan, { version: '1.1.0' })), ['grant-missing'], 'a line for another version is no line for this one');

  fs.rmSync(w.grantsFile, { force: true });
  w.person(trustLine(plan));
  assert.equal(w.pkg('acme', root).state, 'active');
  rewritePoints(root, (p: any) => { p.trustPolicyVersion = 2; return p; });
  const raised = w.pkg('acme', root);
  assert.deepEqual([raised.state, raised.reasons], ['needs-trust', ['policy-changed']]);
});

test('needs-trust revoked only when the revocation is later than the grant', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  w.person(plan.grantLines.trust); // at 2026-10-24T09:12:03Z
  recordRevocation({ homeDir: w.home }, { packageId: 'acme', contentDigest: plan.contentDigest, at: '2026-10-24T09:00:00.000Z' });
  assert.equal(w.pkg('acme', root).state, 'active', 'a revocation before the grant does not void it');
  recordRevocation({ homeDir: w.home }, { packageId: 'acme', contentDigest: plan.contentDigest, at: '2026-10-24T09:12:03.000Z' });
  assert.equal(w.pkg('acme', root).state, 'needs-trust', 'at the same instant the grant is not later, so it is void');
  recordRevocation({ homeDir: w.home }, { packageId: 'acme', contentDigest: plan.contentDigest, at: '2026-10-24T11:00:00.000Z' });
  const revoked = w.pkg('acme', root);
  assert.deepEqual([revoked.state, revoked.reasons], ['needs-trust', ['revoked']]);
  // A fresh line printed after the revocation counts again.
  fs.rmSync(w.grantsFile);
  w.person(trustLine(plan, { at: '2026-10-24T12:00:00Z' }));
  assert.equal(w.pkg('acme', root).state, 'active');
});

test('needs-trust state-unreadable: a malformed grants file, or a malformed state.json; an inert package is untouched', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  w.person(plan.grantLines.trust, '{ not json');
  const voidGrants = w.view(root);
  const pkg = voidGrants.packages.find((p: any) => p.id === 'acme');
  assert.deepEqual([pkg.state, pkg.reasons], ['needs-trust', ['state-unreadable']]);
  const finding = voidGrants.findings.find((f: any) => f.code === 'state-unreadable');
  assert.ok(finding, 'the grants fault is a finding');
  assert.doesNotMatch(JSON.stringify(finding), /not json/, 'a finding never quotes the line');

  fs.rmSync(w.grantsFile);
  w.person(plan.grantLines.trust);
  assert.equal(w.pkg('acme', root).state, 'active');
  fs.writeFileSync(path.join(w.home, '.doflow', 'packages', 'state.json'), '[1]');
  const bad = w.view(root);
  assert.deepEqual([bad.packages[1].state, bad.packages[1].reasons], ['needs-trust', ['state-unreadable']]);
  assert.ok(bad.findings.some((f: any) => f.code === 'state-unreadable' && f.field === 'state.json'));
  assert.equal(w.pkg('doflow', root).state, 'active', 'the bundled package keeps working');

  // An inert package needs no grant, so neither fault touches it.
  assert.equal(w.pkg('acme').state, 'active');
});

test('a grants file inside the system temp directory is ignored: the trust line does not count and the finding says why', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  w.person(plan.grantLines.trust);
  resetPackageView();
  const view = packageView({ repoRoot: root, homeDir: w.home, env: w.env, projectRoot: w.project, settingsView: {} });
  const pkg = view.packages.find((p: any) => p.id === 'acme');
  assert.deepEqual([pkg.state, pkg.reasons], ['needs-trust', ['grant-missing']]);
  assert.ok(view.findings.some((f: any) => f.code === 'grant-invalid' && f.reason === 'grants-file-location'));
});

// ── isolation and the seam ────────────────────────────────────────────────────────────────────────────

test('a fault in package X leaves package Y active and contributing', (t) => {
  const w = world(t);
  const x = w.stage(makePackage(t));
  const y = w.stage(makePackage(t, manifestOf({ id: 'beta' })));
  w.setEnabled('acme', true);
  w.setEnabled('beta', true);
  fs.appendFileSync(path.join(x.storeDir, 'README.md'), 'x');
  const view = w.view();
  assert.deepEqual(view.packages.map((p: any) => [p.id, p.state]), [['doflow', 'active'], ['acme', 'suspended'], ['beta', 'active']]);
  const list = contributionsFor('review-preset', 1, { view });
  assert.deepEqual(list.map((c: any) => c.qualifiedId), ['beta.strict']);
  assert.equal(y.plan.package.id, 'beta');
});

test('contributionsFor returns the active third-party preset with its qualified id, data and provenance', (t) => {
  const { w, plan } = readyWorld(t);
  const view = w.view();
  const list = contributionsFor('review-preset', 1, { view });
  assert.equal(list.length, 1);
  const [item] = list;
  assert.deepEqual(
    { qualifiedId: item.qualifiedId, localId: item.localId, packageId: item.packageId, firstParty: item.firstParty, dir: item.dir },
    { qualifiedId: 'acme.strict', localId: 'strict', packageId: 'acme', firstParty: false, dir: null },
  );
  assert.deepEqual(item.data, strictPreset());
  assert.deepEqual(item.provenance, { contentDigest: plan.contentDigest, source: { type: 'local', path: plan.source.path } });
  assert.deepEqual(contributionsFor('debate-preset', 1, { view }).map((c: any) => c.qualifiedId), ['debate-3'], 'the bundled preset is still there and the other point does not see acme');
});

test('contributionsFor: nothing before the trust line, acme.strict with provenance after the test appends it', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  assert.deepEqual(contributionsFor('review-preset', 1, { view: w.view(root), repoRoot: root }), []);
  w.person(plan.grantLines.trust);
  const list = contributionsFor('review-preset', 1, { view: w.view(root), repoRoot: root });
  assert.deepEqual(list.map((c: any) => [c.qualifiedId, c.firstParty, c.provenance.contentDigest]), [['acme.strict', false, plan.contentDigest]]);
});

test('contributionsFor leaves out a disabled or suspended package, and an entry that fails the package-mode validator', (t) => {
  const { w, storeDir } = readyWorld(t, { enable: false });
  assert.deepEqual(contributionsFor('review-preset', 1, { view: w.view() }), []);
  w.setEnabled('acme', true);
  assert.equal(contributionsFor('review-preset', 1, { view: w.view() }).length, 1);
  // The view was built; the file then changes under it. The seam validates again, in package mode, and says so.
  const view = w.view();
  const file = path.join(storeDir, 'presets', 'strict.json');
  const loose = strictPreset();
  loose.rounds = { default: 1, min: 1 };
  loose.seats = [{ id: 'one', agent: 'not-a-core-agent', model: { tier: 'light' } }];
  fs.writeFileSync(file, JSON.stringify(loose));
  const problems: any = [];
  assert.deepEqual(contributionsFor('review-preset', 1, { view, problems }), []);
  assert.match(problems.join('\n'), /acme\.strict.*agent/);
});

test('the memo is keyed on everything the view reads: home, config home, project root; same key, same object', (t) => {
  const { w } = readyWorld(t);
  resetPackageView();
  const options = { repoRoot: REPO_ROOT, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {} };
  const first = packageView(options);
  assert.equal(packageView(options), first);
  assert.notEqual(packageView({ ...options, homeDir: path.join(w.scratch.dir, 'other-home') }), first);
  assert.notEqual(packageView({ ...options, env: { ...w.env, XDG_CONFIG_HOME: path.join(w.scratch.dir, 'other-xdg') } }), first);
  assert.notEqual(packageView({ ...options, projectRoot: path.join(w.scratch.dir, 'other-project') }), first);
  assert.equal(first.packages.find((p: any) => p.id === 'acme').state, 'active');
  assert.equal(packageView({ ...options, homeDir: path.join(w.scratch.dir, 'other-home') }).packages.length, 1, 'another home sees no acme');
  resetPackageView();
  assert.notEqual(packageView(options), first);
});

test('the view writes nothing: the home and config home are byte-identical after a full evaluation', (t) => {
  const root = fixtureRoot(t, { points: instructionTier });
  const { w, plan } = readyWorld(t, { repoRoot: root });
  w.person(plan.grantLines.trust);
  const snapshot = (dir: any, out: Record<string, any> = {}) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) snapshot(full, out); else out[full] = fs.readFileSync(full, 'latin1');
    }
    return out;
  };
  const before = { home: snapshot(w.home), xdg: snapshot(w.scratch.xdg) };
  w.view(root);
  contributionsFor('review-preset', 1, { view: w.view(root), repoRoot: root });
  assert.deepEqual({ home: snapshot(w.home), xdg: snapshot(w.scratch.xdg) }, before);
});

test('an unreadable global lock is a finding and no third-party package, not a throw', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.home, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.doflow', 'doflow.lock'), '{ nope');
  const view = w.view();
  assert.deepEqual(view.packages.map((p: any) => p.id), ['doflow']);
  assert.ok(view.findings.some((f: any) => f.code === 'state-unreadable' && f.field === 'doflow.lock'));
});
