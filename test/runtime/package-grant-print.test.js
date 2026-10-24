'use strict';

// Followup FU-92eftv (IC-008): `policy` joins the trust duplicate key, and before DoFlow prints a trust or exempt line it
// reads grants.jsonl: a valid, unrevoked line with the same key is "already granted by line N" and no line is printed; a
// revoked line with the same key is named and the printed line replaces it, because a second line with that key voids
// the file. Each case follows the printed text to the letter (`follow`), as the person would: append, replace line N, or
// nothing. Packages are staged through the real plan and apply and the handler runs in process. The scratch config home
// lies under the system temp directory, where IC-008 ignores a grants file, so the reader and the handler get the
// `tmpDir` seam.

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

const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const NO_TMP = '/nonexistent-doflow-tmp';
const T0 = Date.parse('2026-10-24T09:12:03Z');
const T1 = T0 + 3600 * 1000; // the revocation or the repair
const T2 = T1 + 60 * 1000; // the re-trust, printed after it

/** An instruction-tier package (the review-preset point is moved to that tier in a scratch runtime root). */
function makePackage(t) {
  const dir = path.join(tempDir(t, 'doflow-grantprint-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.2.0', summary: 'Stricter review presets', doflow: '>=2.0.0-beta.1 <3.0.0',
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  }, null, 2));
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  preset.rounds = { default: 2, min: 1 };
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset, null, 2));
  return dir;
}

function scratchRoot(t) {
  const root = tempDir(t, 'doflow-grantprint-root-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version: HOST }));
  rewritePoints(root, (points) => { points.points.find((x) => x.id === 'review-preset').tier = 'instruction'; });
  return root;
}

function rewritePoints(root, change) {
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  const points = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(points);
  fs.writeFileSync(file, JSON.stringify(points, null, 2));
}

/** The one printed line that parses as a grant of `kind`, or undefined. */
const grantLineIn = (lines, kind = 'trust') => lines.find((l) => { try { return JSON.parse(l).grant === kind; } catch { return false; } });

/**
 * acme 1.2.0 staged, enabled at T0 and trusted by the line `enable` printed, which the person appended (after a comment
 * line when `comment`). Returns the world and that line.
 */
function trusted(t, { comment = false } = {}) {
  const scratch = createScratch('doflow-grantprint-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const repoRoot = scratchRoot(t);
  const w = { repoRoot, home: scratch.home, env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg }, grantsFile: path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl') };
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
  w.lines = () => fs.readFileSync(w.grantsFile, 'utf8').split('\n').filter((l, i, all) => l !== '' || i < all.length - 1);
  w.write = (...lines) => {
    fs.mkdirSync(path.dirname(w.grantsFile), { recursive: true });
    fs.writeFileSync(w.grantsFile, lines.map((l) => `${l}\n`).join(''));
  };
  w.read = () => readGrants({ env: w.env, projectRoot: project, tmpDir: NO_TMP });
  w.pkg = () => {
    resetPackageView();
    return packageView({ repoRoot, homeDir: w.home, env: w.env, projectRoot: project, tmpDir: NO_TMP, settingsView: {} }).packages.find((p) => p.id === 'acme');
  };
  /**
   * Do what the printed text says to the grants file, to the letter, as the person would: "already granted by line N"
   * changes nothing, "replace line N of <file> with this line" puts the printed line in place of line N, and "appends
   * this line to <file>" appends it. Returns what was done.
   */
  w.follow = (lines) => {
    const text = lines.join('\n');
    const line = grantLineIn(lines);
    const granted = text.match(/already granted by line (\d+) of (\S+)/);
    if (granted) { assert.equal(granted[2], w.grantsFile); assert.equal(line, undefined, 'no line is printed for a line already granted'); return 'nothing'; }
    assert.ok(line, `no trust line in:\n${text}`);
    const replace = text.match(/replace line (\d+) of (\S+) with this line/);
    if (replace) {
      assert.equal(replace[2], w.grantsFile);
      const all = w.lines();
      all[Number(replace[1]) - 1] = line;
      w.write(...all);
      return `replace ${replace[1]}`;
    }
    assert.ok(text.includes(`appends this line to ${w.grantsFile}`), `no instruction in:\n${text}`);
    fs.appendFileSync(w.grantsFile, `${line}\n`);
    return 'append';
  };

  const planned = planPackage({ action: 'add', source: makePackage(t), homeDir: w.home, repoRoot, now: T0 });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  assert.equal(applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: w.home, repoRoot, env: scratch.env() }).ok, true);
  const enabled = w.run({ action: 'enable', id: 'acme', now: T0 });
  assert.equal(enabled.code, 0, enabled.text);
  const d1 = grantLineIn(enabled.lines);
  assert.ok(d1, enabled.text);
  if (comment) w.write('# acme, trusted after reading its presets', d1);
  else w.write(d1);
  assert.deepEqual([w.pkg().state, w.read().findings], ['active', []]);
  return { w, d1 };
}

/** The grants file reads clean and acme is active. */
function activeAndClean(w) {
  assert.deepEqual(w.read().findings, [], 'the grants file is not voided');
  const acme = w.pkg();
  assert.deepEqual([acme.state, acme.reasons], ['active', []], JSON.stringify(acme));
}

test('(a) after a trust-policy bump the printed trust line is appended and the package is active again', (t) => {
  const { w, d1 } = trusted(t);
  rewritePoints(w.repoRoot, (points) => { points.trustPolicyVersion = 2; });
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['policy-changed']]);
  const trust = w.run({ action: 'trust', id: 'acme', now: T2 });
  assert.equal(trust.code, 0, trust.text);
  assert.equal(JSON.parse(grantLineIn(trust.lines)).policy, 2);
  assert.equal(w.follow(trust.lines), 'append');
  assert.deepEqual(w.lines(), [d1, grantLineIn(trust.lines)], 'the old line stays');
  activeAndClean(w);
});

test('(b) revoke names its undo; following it to the letter (run trust, replace the named line) makes the package active again', (t) => {
  const { w, d1 } = trusted(t);
  const revoked = w.run({ action: 'revoke', id: 'acme', now: T1 });
  assert.equal(revoked.code, 0, revoked.text);
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['revoked']]);
  assert.deepEqual(w.lines(), [d1], 'revoke never touches the grants file');
  const json = JSON.parse(w.run({ action: 'trust', id: 'acme', now: T2, json: true }).lines[0]);
  const trust = w.run({ action: 'trust', id: 'acme', now: T2 });
  assert.equal(trust.code, 0, trust.text);
  const did = w.follow(trust.lines);
  activeAndClean(w);
  assert.equal(did, 'replace 1');
  assert.deepEqual(w.lines(), [grantLineIn(trust.lines)]);
  assert.ok(trust.text.includes(`replace line 1 of ${w.grantsFile} with this line (a second line with the same key voids the file):`), trust.text);
  assert.equal(revoked.lines.at(-1), `to undo: run doflow package --action trust --id acme and put its line in place of line 1 of ${w.grantsFile}`, revoked.text);
  assert.deepEqual([json.replaceLine, json.grantLines.trust], [1, grantLineIn(trust.lines)]);
});

test('(c) an exact duplicate line still voids the file; the same digests under another policy coexist', (t) => {
  const { w, d1 } = trusted(t);
  w.write(d1, d1);
  const read = w.read();
  assert.deepEqual(read.grants, []);
  assert.equal(read.findings[0]?.code, 'state-unreadable');
  assert.match(read.findings[0].message, /line 2 /);
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['state-unreadable']]);
  w.write(d1, JSON.stringify({ ...JSON.parse(d1), at: '2026-10-25T00:00:00Z' }));
  assert.equal(w.read().findings[0]?.code, 'state-unreadable', 'only `at` differs: the same key');
  w.write(d1, JSON.stringify({ ...JSON.parse(d1), policy: 2 }));
  assert.deepEqual([w.read().findings, w.read().grants.length], [[], 2], 'policy is part of the key');
});

test('(d) trust on a package already trusted by line N prints "already granted by line N" and no line', (t) => {
  const { w, d1 } = trusted(t, { comment: true });
  const trust = w.run({ action: 'trust', id: 'acme', now: T2 });
  assert.equal(trust.code, 0, trust.text);
  assert.ok(trust.text.includes(`already granted by line 2 of ${w.grantsFile}`), trust.text);
  assert.equal(grantLineIn(trust.lines), undefined, trust.text);
  const json = JSON.parse(w.run({ action: 'trust', id: 'acme', now: T2, json: true }).lines[0]);
  assert.equal(json.alreadyGranted, 2);
  assert.equal(Object.hasOwn(json, 'grantLines'), false);
  assert.equal(w.follow(trust.lines), 'nothing');
  assert.deepEqual(w.lines(), ['# acme, trusted after reading its presets', d1]);
  activeAndClean(w);
});

test('(e) verify --repair revokes every present line and names the undo; following it makes the package active again', (t) => {
  const { w } = trusted(t);
  fs.writeFileSync(path.join(w.home, '.doflow', 'packages', 'state.json'), '[1]');
  const repaired = w.run({ action: 'verify', repair: true, now: T1 });
  assert.match(repaired.text, /every trust and exempt line present now is revoked/);
  assert.match(repaired.text, /to undo one, run doflow package --action trust --id <id> \(or exempt\) and put its line in place of the line it names/);
  assert.deepEqual([w.pkg().state, w.pkg().reasons], ['needs-trust', ['revoked']]);
  const trust = w.run({ action: 'trust', id: 'acme', now: T2 });
  assert.equal(trust.code, 0, trust.text);
  const did = w.follow(trust.lines);
  activeAndClean(w);
  assert.equal(did, 'replace 1');
});
