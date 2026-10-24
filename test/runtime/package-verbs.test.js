'use strict';

// Feature 122 B.6 (IC-012, IC-008, IC-009, IC-024; FR-004, FR-005, FR-006, FR-021): the verb actions enable, disable,
// trust, exempt, revoke, verify, a digest-changing update, and the `package.verb` event. Packages are staged through
// the real B.4 `add` + `add --plan`; the person's trust and exempt lines are appended to `grants.jsonl` by the test
// (DoFlow never writes it). Every case runs against a scratch HOME and a scratch XDG_CONFIG_HOME.
//
// Grants file location: the scratch config home lies under the system temp directory, where IC-008 ignores a grants
// file. In process the handler is given the `tmpDir` seam (a path nothing lies under) and `projectRoot`; the spawned
// CLI cases cannot use a valid grant and assert only exits and timing. The instruction-tier fixture is a scratch copy
// of the runtime root (`repoRoot`) in which the open `review-preset` point has tier `instruction`: no instruction-tier
// point is open in Phase B and no shipped test hook is used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { contributionsFor } = require('../../src/runtime/packages/contributions.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { readState } = require('../../src/runtime/packages/state.ts');
const { TelemetryWriter } = require('../../src/runtime/trace/telemetry.ts');
const { readLock, writeLock, lockPackages, lockPath } = require('../../src/state/lockfile.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const NO_TMP = '/nonexistent-doflow-tmp';
const AT = '2026-10-24T09:12:03Z';
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');

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
function makePackage(t, manifest = manifestOf(), preset = strictPreset()) {
  const dir = path.join(tempDir(t, 'doflow-pverbs-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
  return dir;
}

/** A scratch runtime root (a copy of core/registry and a package.json) whose point registry `change` edits. */
function fixtureRoot(t, { version = HOST, change = (p) => p } = {}) {
  const root = tempDir(t, 'doflow-pverbs-root-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version }));
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
  return root;
}
/** The review-preset point moves to the instruction tier, so a package that contributes to it needs a trust line. */
const instructionTier = (p) => { p.points.find((x) => x.id === 'review-preset').tier = 'instruction'; return p; };

function world(t, { repoRoot = REPO_ROOT } = {}) {
  const scratch = createScratch('doflow-pverbs-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const events = [];
  const w = {
    scratch, project, repoRoot, home: scratch.home, events,
    env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg },
    grantsFile: path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl'),
    lockFile: lockPath({ scope: 'global', homeDir: scratch.home }),
    stateFile: path.join(scratch.home, '.doflow', 'packages', 'state.json'),
  };
  /** Run the handler in process; `process.exitCode` is put back after the call. */
  w.run = (args, extra = {}) => {
    const lines = [];
    const saved = process.exitCode;
    try {
      const code = handlePackageCommand({
        homeDir: w.home, env: w.env, repoRoot: w.repoRoot, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {},
        writer: { write: (records) => events.push(...records) }, json: false, out: (l) => lines.push(l), ...args, ...extra,
      });
      return { code, lines, text: lines.join('\n') };
    } finally { process.exitCode = saved; }
  };
  /** Stage a package through the real plan and apply; it lands `disabled`. */
  w.stage = (dir) => {
    const planned = planPackage({ action: 'add', source: dir, homeDir: w.home, repoRoot: w.repoRoot, now: Date.parse(AT) });
    assert.equal(planned.ok, true, JSON.stringify(planned.findings));
    const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: w.home, repoRoot: w.repoRoot, env: scratch.env() });
    assert.equal(applied.ok, true, JSON.stringify(applied.findings));
    return { plan: planned.plan, storeDir: applied.storeDir };
  };
  /** Append lines to grants.jsonl as the person would. */
  w.person = (...lines) => {
    fs.mkdirSync(path.dirname(w.grantsFile), { recursive: true });
    fs.appendFileSync(w.grantsFile, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  };
  w.pkg = (id = 'acme', repoRoot = w.repoRoot) => {
    resetPackageView();
    return packageView({ repoRoot, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {} }).packages.find((p) => p.id === id);
  };
  w.row = (id = 'acme') => lockPackages(readLock({ scope: 'global', homeDir: w.home })).find((r) => r.id === id);
  w.audit = () => readState({ homeDir: w.home }).state.audit;
  w.contributed = () => {
    resetPackageView();
    return contributionsFor('review-preset', 1, { repoRoot: w.repoRoot, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP }).map((c) => c.qualifiedId);
  };
  return w;
}

/** The trust line a command printed: the one text line that parses as a `trust` grant. */
const printedLine = (lines, kind = 'trust') => {
  const found = lines.find((l) => { try { return JSON.parse(l).grant === kind; } catch { return false; } });
  assert.ok(found, `no ${kind} line in:\n${lines.join('\n')}`);
  return found;
};

// ── enable ─────────────────────────────────────────────────────────────────────────────────────────

test('an inert package goes enable -> active, and its preset then resolves by name', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  assert.equal(w.pkg().state, 'disabled', 'added is not enabled');
  assert.deepEqual(w.contributed(), []);

  const result = w.run({ action: 'enable', id: 'acme' });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /acme.*active/);
  assert.equal(w.row().enabled, true);
  assert.equal(w.pkg().state, 'active');
  assert.deepEqual(w.contributed(), ['acme.strict'], 'the preset resolves by its qualified name');
  assert.deepEqual(w.audit().map((a) => [a.verb, a.package, a.result]), [['enable', 'acme', 'active']]);
});

test('an instruction-tier package goes enable -> needs-trust with the exact line, then the person appends it -> active', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  const { plan } = w.stage(makePackage(t));
  const result = w.run({ action: 'enable', id: 'acme' });
  assert.equal(result.code, 0, 'needs-trust is not an error');
  assert.equal(w.pkg().state, 'needs-trust');
  assert.deepEqual(w.pkg().reasons, ['grant-missing']);
  assert.equal(w.row().enabled, true, 'the bit is set');
  assert.deepEqual(w.contributed(), [], 'nothing acts without the grant');

  const line = printedLine(result.lines);
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), ['grant', 'package', 'version', 'contentDigest', 'capabilityDigest', 'policy', 'at']);
  assert.deepEqual({ ...parsed, at: null }, { grant: 'trust', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, capabilityDigest: plan.capabilityDigest, policy: 1, at: null });
  assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'whole seconds, as the plan prints it');
  assert.ok(result.text.includes(w.grantsFile), 'it names the grants file');
  assert.match(result.text, /a person appends/);
  assert.equal(fs.existsSync(w.grantsFile), false, 'DoFlow wrote no grants file');

  w.person(line); // the test stands in for the person
  assert.equal(w.pkg().state, 'active');
  assert.deepEqual(w.contributed(), ['acme.strict']);
});

test('with no config home the output says no grant can exist', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  w.stage(makePackage(t));
  const result = w.run({ action: 'enable', id: 'acme' }, { env: {} });
  assert.equal(result.code, 0);
  assert.match(result.text, /no config home/);
  assert.match(result.text, /no grant can exist/);
});

test('list and enable print the matched grant line, the file path and its mtime for an active trusted package', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  w.stage(makePackage(t));
  const line = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person('# a note the person keeps', line);
  const mtimeMs = fs.statSync(w.grantsFile).mtimeMs;
  for (const action of ['enable', 'list', 'show']) {
    const result = w.run({ action, id: 'acme' });
    assert.equal(result.code, 0, result.text);
    assert.ok(result.lines.includes(line), `${action} prints the matched grant line`);
    assert.ok(result.text.includes(w.grantsFile), `${action} prints the file path`);
    const printed = /modified (\S+)$/m.exec(result.text);
    assert.ok(printed && Math.abs(Date.parse(printed[1]) - mtimeMs) <= 1, `${action} prints the file mtime`);
  }
  const json = w.run({ action: 'list', json: true });
  assert.deepEqual(Object.keys(JSON.parse(json.text)), ['points', 'packages', 'findings', 'lockVersion'], 'the list --json contract is unchanged');
});

test('enable of an incompatible package is exit 1 and changes nothing', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  const future = fixtureRoot(t, { version: '3.1.0' });
  const before = sha(w.lockFile);
  const refused = w.run({ action: 'enable', id: 'acme' }, { repoRoot: future });
  assert.equal(refused.code, 1, refused.text);
  assert.match(refused.text, /host-incompatible/);
  assert.equal(sha(w.lockFile), before);
});

test('enable and disable without --id are usage errors (exit 2)', (t) => {
  const w = world(t);
  for (const action of ['enable', 'disable', 'trust', 'exempt', 'revoke']) assert.equal(w.run({ action }).code, 2, action);
});

// ── disable, revoke ──────────────────────────────────────────────────────────────────────────────────

test('disable clears the bit, keeps the grant, and says unprojection has nothing to do yet', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  w.stage(makePackage(t));
  const line = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person(line);
  assert.equal(w.pkg().state, 'active');
  const grantsBefore = sha(w.grantsFile);

  const off = w.run({ action: 'disable', id: 'acme' });
  assert.equal(off.code, 0, off.text);
  assert.equal(w.row().enabled, false);
  assert.equal(w.pkg().state, 'disabled');
  assert.match(off.text, /nothing is projected into a harness yet/);
  assert.equal(sha(w.grantsFile), grantsBefore, 'the grant is kept');

  w.run({ action: 'enable', id: 'acme' });
  assert.equal(w.pkg().state, 'active', 'enabling again needs no new line: disable kept the grant');
});

test('revoke writes a revocation to state.json: active -> needs-trust (revoked); only a later line counts', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  const { plan } = w.stage(makePackage(t));
  const line = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person(line);
  assert.equal(w.pkg().state, 'active');
  const grantsBefore = sha(w.grantsFile);

  const result = w.run({ action: 'revoke', id: 'acme' });
  assert.equal(result.code, 0, result.text);
  assert.equal(w.pkg().state, 'needs-trust');
  assert.deepEqual(w.pkg().reasons, ['revoked']);
  const { revoked } = readState({ homeDir: w.home }).state;
  assert.deepEqual(revoked.map((r) => [r.package, r.contentDigest]), [['acme', plan.contentDigest]]);
  assert.equal(sha(w.grantsFile), grantsBefore, 'the person file is never touched');
  assert.equal(fs.statSync(w.stateFile).mode & 0o777, 0o600);

  // a line printed after the revocation counts; the old one stays void
  const later = JSON.stringify({ ...JSON.parse(line), version: '1.2.0', at: new Date(Date.now() + 5000).toISOString().replace(/\.\d+Z$/, 'Z') });
  fs.writeFileSync(w.grantsFile, `${later}\n`);
  assert.equal(w.pkg().state, 'active');
});

// ── trust, exempt ────────────────────────────────────────────────────────────────────────────────────

test('trust prints the line for the recorded digests, exits 0 and leaves grants.jsonl byte-identical', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  const { plan } = w.stage(makePackage(t));
  const absent = w.run({ action: 'trust', id: 'acme' });
  assert.equal(absent.code, 0, absent.text);
  assert.equal(fs.existsSync(w.grantsFile), false, 'no grants file is created');
  const parsed = JSON.parse(printedLine(absent.lines));
  assert.deepEqual({ ...parsed, at: null }, { grant: 'trust', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, capabilityDigest: plan.capabilityDigest, policy: 1, at: null });
  assert.ok(absent.text.includes(w.grantsFile));

  w.person('# kept', JSON.stringify({ ...parsed, package: 'other' }));
  const before = sha(w.grantsFile);
  const lockBefore = sha(w.lockFile);
  const again = w.run({ action: 'trust', id: 'acme' });
  assert.equal(again.code, 0);
  assert.equal(sha(w.grantsFile), before, 'grants.jsonl is byte-identical');
  assert.equal(sha(w.lockFile), lockBefore, 'trust writes no lock');
  assert.equal(w.run({ action: 'trust', id: 'acme', json: true }).code, 0);
});

test('exempt prints the line for the current host and exits 1 while the host is inside the range', (t) => {
  const w = world(t);
  const { plan } = w.stage(makePackage(t));
  w.run({ action: 'enable', id: 'acme' });
  const inside = w.run({ action: 'exempt', id: 'acme' });
  assert.equal(inside.code, 1, inside.text);
  assert.match(inside.text, /inside the range/);
  assert.equal(inside.lines.some((l) => l.startsWith('{')), false, 'no line to add');

  const future = fixtureRoot(t, { version: '3.1.0' });
  assert.equal(w.pkg('acme', future).state, 'incompatible');
  const outside = w.run({ action: 'exempt', id: 'acme' }, { repoRoot: future });
  assert.equal(outside.code, 0, outside.text);
  const parsed = JSON.parse(printedLine(outside.lines, 'exempt'));
  assert.deepEqual({ ...parsed, at: null }, { grant: 'exempt', package: 'acme', version: '1.2.0', contentDigest: plan.contentDigest, host: '3.1.0', acceptRisk: true, at: null });
  assert.equal(fs.existsSync(w.grantsFile), false);
  w.person(JSON.stringify(parsed));
  assert.equal(w.pkg('acme', future).state, 'active', 'the person adds it and the package runs outside its range');
});

// ── verify ───────────────────────────────────────────────────────────────────────────────────────────

test('verify re-hashes enabled entries: intact is exit 0; a flipped byte records a suspension (exit 1) and a restore clears it', (t) => {
  const w = world(t);
  const { storeDir } = w.stage(makePackage(t));
  w.run({ action: 'enable', id: 'acme' });
  assert.equal(w.run({ action: 'verify' }).code, 0);
  assert.deepEqual(readState({ homeDir: w.home }).state.suspended, []);

  const target = path.join(storeDir, 'README.md');
  const original = fs.readFileSync(target);
  fs.writeFileSync(target, 'tampered\n');
  const found = w.run({ action: 'verify' });
  assert.equal(found.code, 1, found.text);
  assert.match(found.text, /acme.*content-changed/);
  const [suspension] = readState({ homeDir: w.home }).state.suspended;
  assert.deepEqual([suspension.package, suspension.reason, suspension.projected], ['acme', 'content-changed', false]);
  assert.equal(w.pkg().state, 'suspended');

  fs.writeFileSync(target, original);
  assert.equal(w.run({ action: 'verify' }).code, 0);
  assert.deepEqual(readState({ homeDir: w.home }).state.suspended, [], 'intact again: the suspension is cleared');
  assert.deepEqual(w.audit().map((a) => a.verb), ['enable', 'verify', 'verify', 'verify']);
});

test('verify --repair rewrites an unreadable state.json with one revocation per grant line and never widens', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  const { plan } = w.stage(makePackage(t));
  const line = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person(line);
  assert.equal(w.pkg().state, 'active');

  fs.writeFileSync(w.stateFile, '{ not json');
  assert.deepEqual(w.pkg().reasons, ['state-unreadable']);
  const stuck = w.run({ action: 'verify' });
  assert.equal(stuck.code, 1, 'an unreadable state is a finding');
  assert.match(stuck.text, /verify --repair/);
  assert.equal(fs.readFileSync(w.stateFile, 'utf8'), '{ not json', 'plain verify does not rewrite it');

  const repaired = w.run({ action: 'verify', repair: true });
  assert.equal(repaired.code, 0, repaired.text);
  const read = readState({ homeDir: w.home });
  assert.equal(read.unreadable, false);
  assert.deepEqual(read.state.revoked.map((r) => [r.package, r.contentDigest]), [['acme', plan.contentDigest]]);
  assert.deepEqual(w.pkg().reasons, ['revoked'], 'the old grant stays void');
  assert.equal(w.pkg().state, 'needs-trust');

  const again = w.run({ action: 'verify', repair: true });
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /readable/);
  assert.equal(readState({ homeDir: w.home }).state.revoked.length, 1, 'a readable state is not rewritten by --repair');
});

// ── update with a changed digest ─────────────────────────────────────────────────────────────────────

test('update --plan with a new content digest voids trust and prints the new line and one sentence (FR-021)', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  const dir = makePackage(t);
  w.stage(dir);
  const first = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person(first);
  assert.equal(w.pkg().state, 'active');
  const grantsBefore = sha(w.grantsFile);

  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(strictPreset(3), null, 2));
  const planned = w.run({ action: 'update', id: 'acme', json: true });
  assert.equal(planned.code, 0, planned.text);
  const planId = JSON.parse(planned.text).plan.planId;
  const applied = w.run({ action: 'update', plan: planId });
  assert.equal(applied.code, 0, applied.text);

  const row = w.row();
  const line = JSON.parse(printedLine(applied.lines));
  assert.equal(line.contentDigest, row.contentDigest);
  assert.equal(line.capabilityDigest, row.capabilityDigest);
  assert.notEqual(line.contentDigest, JSON.parse(first).contentDigest);
  assert.match(applied.text, /acts again only after a person adds it/);
  assert.ok(applied.text.includes(w.grantsFile));
  assert.equal(sha(w.grantsFile), grantsBefore, 'DoFlow wrote no grant');
  assert.equal(w.pkg().state, 'needs-trust');
  assert.deepEqual(w.pkg().reasons, ['content-changed'], 'voided by construction: the grant names the old digest');
  assert.deepEqual(w.contributed(), []);

  fs.writeFileSync(w.grantsFile, `${JSON.stringify(line)}\n`); // the person replaces the old line: one (grant, package, version) per file
  assert.equal(w.pkg().state, 'active');
});

test('update --plan of an inert package or with an unchanged digest prints no trust line', (t) => {
  const w = world(t);
  const dir = makePackage(t);
  w.stage(dir);
  w.run({ action: 'enable', id: 'acme' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'changed notes\n');
  const planId = JSON.parse(w.run({ action: 'update', id: 'acme', json: true }).text).plan.planId;
  const applied = w.run({ action: 'update', plan: planId });
  assert.equal(applied.code, 0, applied.text);
  assert.equal(applied.lines.some((l) => l.startsWith('{"grant"')), false);
  assert.doesNotMatch(applied.text, /acts again only after/);
  assert.equal(w.pkg().state, 'active');
});

// ── the bundled package (FR-004) ─────────────────────────────────────────────────────────────────────

test('the bundled package can always be disabled and enabled, with or without any recorded package', (t) => {
  const w = world(t);
  assert.equal(w.pkg('doflow').state, 'active');
  const off = w.run({ action: 'disable', id: 'doflow' });
  assert.equal(off.code, 0, off.text);
  assert.deepEqual(w.row('doflow') && [w.row('doflow').source, w.row('doflow').enabled], [{ type: 'bundled' }, false], 'a closed-shape lock row');
  assert.equal(w.pkg('doflow').state, 'disabled');
  assert.deepEqual(w.pkg('doflow').reasons, ['disabled-by-lock']);

  const on = w.run({ action: 'enable', id: 'doflow' });
  assert.equal(on.code, 0, on.text);
  assert.equal(w.pkg('doflow').state, 'active');
  assert.equal(w.row('doflow'), undefined, 'the row is dropped: the bundled package is on by default');
  assert.equal(readLock({ scope: 'global', homeDir: w.home }).version, 1, 'a lock holding no package is the version 1 bytes again');
  assert.equal(w.run({ action: 'trust', id: 'doflow' }).code, 0);
  assert.equal(w.run({ action: 'exempt', id: 'doflow' }).code, 1);
});

// ── telemetry ────────────────────────────────────────────────────────────────────────────────────────

test('every verb action emits one package.verb event with only action, result and tier_max', (t) => {
  const w = world(t, { repoRoot: fixtureRoot(t, { change: instructionTier }) });
  w.stage(makePackage(t));
  const line = printedLine(w.run({ action: 'enable', id: 'acme' }).lines);
  w.person(line);
  w.events.length = 0;
  for (const args of [{ action: 'trust', id: 'acme' }, { action: 'exempt', id: 'acme' }, { action: 'revoke', id: 'acme' }, { action: 'verify' }, { action: 'disable', id: 'acme' }, { action: 'enable', id: 'nope' }]) w.run(args);
  assert.deepEqual(w.events.map((e) => [e.kind, e.action, e.result, e.tier_max]), [
    ['package.verb', 'trust', 'ok', 'instruction'],
    ['package.verb', 'exempt', 'refused', 'instruction'],
    ['package.verb', 'revoke', 'ok', 'instruction'],
    ['package.verb', 'verify', 'ok', 'instruction'],
    ['package.verb', 'disable', 'ok', 'instruction'],
    ['package.verb', 'enable', 'refused', null],
  ]);
  for (const event of w.events) assert.deepEqual(Object.keys(event).sort(), ['action', 'kind', 'result', 'tier_max'], 'no package id, no path');
});

test('the real writer records package.verb in the project ledger, with no package id or path', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  fs.mkdirSync(path.join(w.project, '.doflow', 'state', 'runs'), { recursive: true });
  const writer = new TelemetryWriter({ env: {}, start: w.project, now: () => new Date('2026-10-24T10:00:00.000Z') });
  assert.equal(w.run({ action: 'enable', id: 'acme' }, { writer }).code, 0);
  const dir = path.join(w.project, '.doflow', 'state', 'runs', 'telemetry');
  const written = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], { timestamp: '2026-10-24T10:00:00.000Z', kind: 'package.verb', run: null, lineage: null, attempt: null, action: 'enable', result: 'ok', tier_max: 'inert' });
  assert.doesNotMatch(JSON.stringify(written), /acme|pverbs/);
});

// ── headless ─────────────────────────────────────────────────────────────────────────────────────────

test('a headless run (no TTY, stdin closed, no autopilot switch) never waits: every action exits within 5 seconds', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  const cases = [
    [['enable', '--id', 'acme'], 0], [['trust', '--id', 'acme'], 0], [['exempt', '--id', 'acme'], 1], [['revoke', '--id', 'acme'], 0],
    [['verify'], 0], [['verify', '--repair'], 0], [['disable', '--id', 'acme'], 0],
    [['enable', '--id', 'nope'], 1], [['trust', '--id', 'nope'], 1], [['enable'], 2],
  ];
  for (const [args, expected] of cases) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [CLI, 'package', '--action', ...args], {
      env: w.scratch.env(), encoding: 'utf8', cwd: w.project, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    assert.equal(result.error, undefined, `${args.join(' ')} timed out: ${result.error}`);
    assert.equal(result.status, expected, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.ok(Date.now() - started < 5000);
  }
  assert.equal(w.row().enabled, false, 'the CLI ran the actions in order and ended on disable');
});

test('the CLI forwards --repair and --json to the verbs', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  fs.mkdirSync(path.dirname(w.stateFile), { recursive: true });
  fs.writeFileSync(w.stateFile, 'garbage');
  const run = (args) => spawnSync(process.execPath, [CLI, 'package', '--action', ...args], { env: w.scratch.env(), encoding: 'utf8', cwd: w.project, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  assert.equal(run(['verify']).status, 1);
  const repaired = run(['verify', '--repair', '--json']);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).repaired, true);
  assert.equal(readState({ homeDir: w.home }).unreadable, false);
});

// ── negative control ─────────────────────────────────────────────────────────────────────────────────

test('negative control: every action on an unknown id leaves the lock byte-identical', (t) => {
  const w = world(t);
  const empty = ['enable', 'disable', 'trust', 'exempt', 'revoke'].map((action) => w.run({ action, id: 'ghost' }));
  assert.deepEqual(empty.map((r) => r.code), [1, 1, 1, 1, 1]);
  assert.equal(fs.existsSync(w.lockFile), false, 'no lock appears from nothing');

  assert.equal(fs.existsSync(w.stateFile), false, 'an unknown id appends no audit row, so no state.json appears from nothing');

  w.stage(makePackage(t));
  assert.equal(w.run({ action: 'enable', id: 'acme' }).code, 0);
  const before = sha(w.lockFile);
  const stateBefore = sha(w.stateFile);
  assert.notEqual(before, 'absent');
  assert.notEqual(stateBefore, 'absent');
  for (const action of ['enable', 'disable', 'trust', 'exempt', 'revoke']) {
    const result = w.run({ action, id: 'ghost' });
    assert.equal(result.code, 1, `${action}: ${result.text}`);
    assert.match(result.text, /no package with id 'ghost'/);
    assert.equal(sha(w.lockFile), before, `${action} left the lock byte-identical`);
    assert.equal(sha(w.stateFile), stateBefore, `${action} left state.json byte-identical (no audit row)`);
  }
  assert.deepEqual(w.audit().map((a) => a.verb), ['enable'], 'the unknown id appended no audit row');
  assert.equal(fs.existsSync(w.grantsFile), false);
  assert.deepEqual(readState({ homeDir: w.home }).state.revoked, []);
});
