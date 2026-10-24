'use strict';

// Followup FU-gjgp06 (IC-008 duplicate key): a `trust` or `exempt` line's duplicate key is
// (grant, package, version, contentDigest, capabilityDigest), so after an edit at the same package version the person
// appends the freshly printed trust line next to the old one and the package is trusted again; only the line whose
// digests equal the record grants. An exact duplicate line, and two `fetch` lines for one source, still void the file.
// Packages are staged through the real plan and apply and the handler runs in process; the test appends the grant
// lines as the person (DoFlow never writes grants.jsonl). The scratch config home lies under the system temp
// directory, where IC-008 ignores a grants file, so the reader and the handler get the `tmpDir` seam.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { readGrants } = require('../../src/runtime/packages/grants.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { readLock, lockPackages } = require('../../src/state/lockfile.ts');

const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const NO_TMP = '/nonexistent-doflow-tmp';
const AT = '2026-10-24T09:12:03Z';

const preset = (rounds) => {
  const p = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete p.depth;
  p.rounds = { default: rounds, min: 1 };
  return p;
};

/** An instruction-tier package at version 1.2.0 (the review-preset point is moved to that tier in a scratch runtime root). */
function makePackage(t) {
  const dir = path.join(tempDir(t, 'doflow-retrust-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.2.0', summary: 'Stricter review presets', doflow: '>=2.0.0-beta.1 <3.0.0',
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset(2), null, 2));
  return dir;
}

function instructionRoot(t) {
  const root = tempDir(t, 'doflow-retrust-root-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version: HOST }));
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  const points = JSON.parse(fs.readFileSync(file, 'utf8'));
  points.points.find((x) => x.id === 'review-preset').tier = 'instruction';
  fs.writeFileSync(file, JSON.stringify(points, null, 2));
  return root;
}

function world(t) {
  const scratch = createScratch('doflow-retrust-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const repoRoot = instructionRoot(t);
  const w = { home: scratch.home, env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg }, grantsFile: path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl') };
  /** The handler in process; `process.exitCode` is put back after the call. */
  w.run = (args) => {
    const lines = [];
    const saved = process.exitCode;
    try {
      const code = handlePackageCommand({
        homeDir: w.home, env: w.env, repoRoot, projectRoot: project, tmpDir: NO_TMP, settingsView: {},
        writer: { write: () => {} }, json: false, out: (l) => lines.push(l), ...args,
      });
      return { code, lines, text: lines.join('\n') };
    } finally { process.exitCode = saved; }
  };
  /** The person's grants file, written whole (lines in order) or appended to. */
  w.write = (...lines) => {
    fs.mkdirSync(path.dirname(w.grantsFile), { recursive: true });
    fs.writeFileSync(w.grantsFile, lines.map((l) => `${l}\n`).join(''));
  };
  w.append = (line) => fs.appendFileSync(w.grantsFile, `${line}\n`);
  w.read = () => readGrants({ env: w.env, projectRoot: project, tmpDir: NO_TMP });
  w.pkg = () => {
    resetPackageView();
    return packageView({ repoRoot, homeDir: w.home, env: w.env, projectRoot: project, tmpDir: NO_TMP, settingsView: {} }).packages.find((p) => p.id === 'acme');
  };
  w.row = () => lockPackages(readLock({ scope: 'global', homeDir: w.home })).find((r) => r.id === 'acme');
  return { w, repoRoot, scratch };
}

/** The one printed line that parses as a grant of `kind`. */
const printed = (lines, kind = 'trust') => {
  const found = lines.find((l) => { try { return JSON.parse(l).grant === kind; } catch { return false; } });
  assert.ok(found, `no ${kind} line in:\n${lines.join('\n')}`);
  return found;
};

/**
 * Stage acme 1.2.0, enable it and print its trust line D1, then edit it at the same version and apply the update, which
 * prints the trust line D2. The grants file is left empty; `d1` and `d2` are the printed lines.
 */
function editedAtSameVersion(t) {
  const { w, repoRoot, scratch } = world(t);
  const dir = makePackage(t);
  const planned = planPackage({ action: 'add', source: dir, homeDir: w.home, repoRoot, now: Date.parse(AT) });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  assert.equal(applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: w.home, repoRoot, env: scratch.env() }).ok, true);
  const d1 = printed(w.run({ action: 'enable', id: 'acme' }).lines);
  w.write(d1);
  assert.equal(w.pkg().state, 'active');

  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset(3), null, 2));
  const plan = w.run({ action: 'update', id: 'acme', json: true });
  assert.equal(plan.code, 0, plan.text);
  const applied = w.run({ action: 'update', plan: JSON.parse(plan.text).plan.planId });
  assert.equal(applied.code, 0, applied.text);
  const d2 = printed(applied.lines);
  const [one, two] = [JSON.parse(d1), JSON.parse(d2)];
  assert.deepEqual([one.package, one.version, two.package, two.version], ['acme', '1.2.0', 'acme', '1.2.0'], 'the same package version');
  assert.notEqual(one.contentDigest, two.contentDigest);
  assert.equal(two.contentDigest, w.row().contentDigest);
  assert.equal(two.capabilityDigest, w.row().capabilityDigest);
  return { w, d1, d2 };
}

test('re-trust after an edit at the same version is an append: both lines valid, the package active', (t) => {
  const { w, d1, d2 } = editedAtSameVersion(t);
  w.append(d2); // the file now holds d1 then d2, the old line kept
  const read = w.read();
  assert.deepEqual(read.findings, []);
  assert.deepEqual(read.entries.map((e) => [e.line, e.state]), [[1, 'valid'], [2, 'valid']]);
  assert.deepEqual(read.grants.map((g) => g.raw), [d1, d2]);
  const acme = w.pkg();
  assert.deepEqual([acme.state, acme.reasons], ['active', []], JSON.stringify(acme));
  // the order of the lines does not matter
  w.write(d2, d1);
  assert.deepEqual([w.pkg().state, w.read().findings], ['active', []]);
});

test('an exact duplicate trust line still voids the whole file, naming the line number', (t) => {
  const { w, d1, d2 } = editedAtSameVersion(t);
  w.write(d1, d2, d2);
  const read = w.read();
  assert.deepEqual(read.grants, []);
  assert.deepEqual(read.entries.map((e) => e.state), ['void', 'void']);
  assert.equal(read.findings.length, 1);
  assert.equal(read.findings[0].code, 'state-unreadable');
  assert.match(read.findings[0].message, /line 3 /);
  assert.equal(read.findings[0].message.includes(JSON.parse(d2).contentDigest), false, 'the finding never quotes the line');
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['state-unreadable']]);
  // only `at` differs: still the same key, still void
  w.write(d2, JSON.stringify({ ...JSON.parse(d2), at: '2026-10-25T00:00:00Z' }));
  assert.equal(w.read().findings[0]?.code, 'state-unreadable');
});

test('a stale-digest line grants nothing on its own; next to the current line the current one grants and is the one printed', (t) => {
  const { w, d1, d2 } = editedAtSameVersion(t);
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['content-changed']], 'only the D1 line');
  w.append(d2);
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['active', []]);
  const shown = w.run({ action: 'show', id: 'acme' });
  assert.equal(shown.code, 0, shown.text);
  const at = shown.lines.findIndex((l) => l.startsWith('matched trust grant'));
  assert.equal(shown.lines[at], 'matched trust grant (line 2 of the grants file):', shown.text);
  assert.equal(shown.lines[at + 1], d2);
  assert.equal(shown.lines.includes(d1), false, 'the stale line is not printed as matched');
  assert.equal(shown.lines.filter((l) => l.startsWith('matched ')).length, 1, shown.text);
});

test('fetch lines keep the source key: two lines for one source void the file, other sources coexist', (t) => {
  const { w } = world(t);
  const fetchLine = (ref) => JSON.stringify({ grant: 'fetch', source: { type: 'git', url: 'https://example.org/acme.git', ref }, at: AT });
  w.write(fetchLine('v1.2.0'), fetchLine('v1.3.0'));
  assert.deepEqual([w.read().findings, w.read().grants.length], [[], 2]);
  w.write(fetchLine('v1.2.0'), fetchLine('v1.3.0'), JSON.stringify({ ...JSON.parse(fetchLine('v1.2.0')), at: '2026-10-25T00:00:00Z' }));
  const read = w.read();
  assert.deepEqual(read.grants, []);
  assert.equal(read.findings[0]?.code, 'state-unreadable');
  assert.match(read.findings[0].message, /line 3 /);
});

test('exempt lines key on the content digest they carry: other digests coexist, the same digest twice voids', (t) => {
  const { w } = world(t);
  const exempt = (digest, host = '9.9.9') => JSON.stringify({ grant: 'exempt', package: 'acme', version: '1.2.0', contentDigest: digest, host, acceptRisk: true, at: AT });
  w.write(exempt('a'.repeat(64)), exempt('b'.repeat(64)));
  assert.deepEqual([w.read().findings, w.read().grants.length], [[], 2]);
  w.write(exempt('a'.repeat(64)), exempt('a'.repeat(64), '9.9.8'));
  assert.equal(w.read().findings[0]?.code, 'state-unreadable');
});
