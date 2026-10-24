'use strict';

// Feature 122 B.7 (IC-012 `remove`, IC-009, FR-012, PN-1): `remove --id` disables, deletes the store entry and the lock
// row, records a revocation and a `removed` tombstone, and prints what still names the package (the read-only scan of
// the settings layers and the findings records, plus the person's now-dangling grant lines). Packages are staged
// through the real B.4 `add` + `add --plan`; the person's grant lines are appended by the test (DoFlow never writes
// `grants.jsonl`). Every case runs against a scratch HOME and a scratch XDG_CONFIG_HOME and a scratch project.

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
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { readState } = require('../../src/runtime/packages/state.ts');
const { readLock, lockPackages, lockPath } = require('../../src/state/lockfile.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const NO_TMP = '/nonexistent-doflow-tmp';
const AT = '2026-10-24T09:12:03Z';
const DIGEST = 'a'.repeat(64);

const strictPreset = () => {
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  preset.rounds = { default: 2, min: 1 };
  return preset;
};
const manifestOf = (overrides = {}) => ({
  manifest: 1, id: 'acme', version: '1.2.0', summary: 'Stricter review presets', doflow: '>=2.0.0-beta.1 <3.0.0',
  contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  ...overrides,
});

function makePackage(t) {
  const dir = path.join(tempDir(t, 'doflow-premove-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifestOf(), null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(strictPreset(), null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
  return dir;
}

/** A scratch runtime root whose `review-preset` point is also referenced by `review.extraLenses` (a string-list key). */
function listKeyRoot(t) {
  const root = tempDir(t, 'doflow-premove-root-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version: HOST }));
  const file = path.join(root, 'core', 'registry', 'contribution-points.json');
  const points = JSON.parse(fs.readFileSync(file, 'utf8'));
  points.points.find((p) => p.id === 'review-preset').referencedBy.push('review.extraLenses');
  fs.writeFileSync(file, JSON.stringify(points, null, 2));
  return root;
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');
/** Every directory and file under `root` with the file hashes: a tree that differs in any entry hashes differently. */
function treeHash(...roots) {
  const lines = [];
  const walk = (dir, base) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(base, full);
      if (stat.isDirectory()) { lines.push(`d ${rel}`); walk(full, base); } else lines.push(`f ${rel} ${sha(full)}`);
    }
  };
  for (const root of roots) walk(root, root);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function world(t, { repoRoot = REPO_ROOT, prune = 'off' } = {}) {
  const scratch = createScratch('doflow-premove-', { prune });
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  const events = [];
  const w = {
    scratch, project, repoRoot, home: scratch.home, events,
    env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg },
    grantsFile: path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl'),
    lockFile: lockPath({ scope: 'global', homeDir: scratch.home }),
    stateFile: path.join(scratch.home, '.doflow', 'packages', 'state.json'),
    userSettings: path.join(scratch.xdg, 'doflow', 'settings.json'),
    projectSettings: path.join(project, '.doflow', 'settings.json'),
    localSettings: path.join(project, '.doflow', 'settings.local.json'),
  };
  w.run = (args, extra = {}) => {
    const lines = [];
    const saved = process.exitCode;
    try {
      const code = handlePackageCommand({
        homeDir: w.home, env: w.env, repoRoot: w.repoRoot, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {},
        writer: { write: (records) => events.push(...records) }, json: false, out: (l) => lines.push(l), now: Date.parse(AT) + 5000, ...args, ...extra,
      });
      return { code, lines, text: lines.join('\n') };
    } finally { process.exitCode = saved; }
  };
  w.stage = (dir) => {
    const planned = planPackage({ action: 'add', source: dir, homeDir: w.home, repoRoot: w.repoRoot, now: Date.parse(AT) });
    assert.equal(planned.ok, true, JSON.stringify(planned.findings));
    const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: w.home, repoRoot: w.repoRoot, env: scratch.env() });
    assert.equal(applied.ok, true, JSON.stringify(applied.findings));
    return { plan: planned.plan, storeDir: applied.storeDir };
  };
  w.person = (...lines) => {
    fs.mkdirSync(path.dirname(w.grantsFile), { recursive: true });
    fs.appendFileSync(w.grantsFile, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  };
  w.write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  w.rows = () => lockPackages(readLock({ scope: 'global', homeDir: w.home }));
  w.view = (id = 'acme') => {
    resetPackageView();
    return packageView({ repoRoot: w.repoRoot, homeDir: w.home, env: w.env, projectRoot: w.project, tmpDir: NO_TMP, settingsView: {} }).packages.find((p) => p.id === id);
  };
  return w;
}

const findings = (id) => ({ schema: 1, row: 122, slug: 'x', protocol: { id, digest: DIGEST } });

// ── the removal ─────────────────────────────────────────────────────────────────────────────────────

test('remove reports the dangling setting and record, lists the dangling grant line, and rewrites none of them', (t) => {
  const w = world(t);
  const { plan, storeDir } = w.stage(makePackage(t));
  assert.equal(w.run({ action: 'enable', id: 'acme' }).code, 0);
  assert.equal(w.view().state, 'active');

  const trust = w.run({ action: 'trust', id: 'acme' }).lines.find((l) => l.startsWith('{'));
  w.person(trust);
  w.write(w.projectSettings, { schema: 1, 'review.preset': 'acme.strict' });
  w.write(w.localSettings, { schema: 1, 'debate.preset': 'debate-2', 'review.preset': 'review-deep' });
  const hit = path.join(w.project, '.doflow', 'specs', 'f1', 'review', 'findings.json');
  const miss = path.join(w.project, '.doflow', 'specs', 'f2', 'review', 'findings.json');
  const broken = path.join(w.project, '.doflow', 'specs', 'f3', 'review', 'findings.json');
  w.write(hit, findings('acme.strict'));
  w.write(miss, findings('review-deep'));
  w.write(broken, '{ not json');
  const before = Object.fromEntries([w.projectSettings, w.localSettings, hit, miss, broken, w.grantsFile].map((f) => [f, fs.readFileSync(f, 'utf8')]));

  const result = w.run({ action: 'remove', id: 'acme' });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /removed acme 1\.2\.0/);
  assert.match(result.text, /dangling setting project review\.preset = "acme\.strict"/);
  assert.doesNotMatch(result.text, /review-deep/, 'a layer value naming another preset is not dangling');
  assert.ok(result.text.includes(`dangling record ${hit} protocol.id = "acme.strict"`), result.text);
  assert.ok(!result.text.includes(miss) && !result.text.includes(broken));
  assert.match(result.text, /grant line 1 \(trust 1\.2\.0\)/);
  assert.match(result.text, /may delete/, 'it says the person may delete the line');
  for (const [file, text] of Object.entries(before)) assert.equal(fs.readFileSync(file, 'utf8'), text, `${file} stays byte-identical`);

  const read = readState({ homeDir: w.home });
  assert.equal(read.unreadable, false);
  assert.deepEqual(read.state.revoked.map((r) => [r.package, r.contentDigest]), [['acme', plan.contentDigest]], 'the recorded content digest is revoked');
  assert.deepEqual(read.state.removed.map((r) => [r.package, r.qualifiedIds]), [['acme', ['acme.strict']]], 'the tombstone names the qualified ids');
  assert.deepEqual(read.state.audit.filter((a) => a.verb === 'remove').map((a) => [a.package, a.result]), [['acme', 'removed']]);
  assert.equal(fs.existsSync(storeDir), false, 'the store entry is gone');
  assert.equal(fs.existsSync(`${storeDir}.installed-from.json`), false, 'and its marker');
  assert.equal(fs.existsSync(path.dirname(storeDir)), false, 'and the empty id directory');
  assert.deepEqual(w.rows(), [], 'the lock row is gone');
  assert.equal(fs.existsSync(w.lockFile), false, 'a lock left with no package and no target is removed (B.1)');
  assert.equal(w.view(), undefined);
  assert.deepEqual(w.events.map((e) => [e.kind, e.action, e.result]).slice(-1), [['package.verb', 'remove', 'ok']]);
});

test('--json carries the rows, the grant lines and the tombstone ids', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  const trust = w.run({ action: 'trust', id: 'acme' }).lines.find((l) => l.startsWith('{'));
  w.person(trust);
  w.write(w.userSettings, { schema: 1, 'review.preset': 'acme.strict' });
  w.write(w.projectSettings, { schema: 1, 'review.preset': 'acme.strict' });
  w.write(w.localSettings, { schema: 1, 'review.preset': 'acme.strict' });
  const result = w.run({ action: 'remove', id: 'acme', json: true });
  assert.equal(result.code, 0);
  const out = JSON.parse(result.lines.join('\n'));
  assert.equal(out.ok, true);
  assert.equal(out.action, 'remove');
  assert.equal(out.id, 'acme');
  assert.deepEqual(out.qualifiedIds, ['acme.strict']);
  assert.deepEqual(out.dangling, ['user', 'project', 'local'].map((layer) => ({ kind: 'setting', layer, key: 'review.preset', value: 'acme.strict' })));
  assert.deepEqual(out.grants.map((g) => [g.line, g.kind, g.version]), [[1, 'trust', '1.2.0']]);
  assert.equal(out.grantFile, w.grantsFile);
});

test('a string-list key naming the package is dangling too, and a list that does not hold it is not', (t) => {
  const w = world(t, { repoRoot: listKeyRoot(t) });
  w.stage(makePackage(t));
  w.write(w.projectSettings, { schema: 1, 'review.extraLenses': ['security', 'acme.strict'] });
  w.write(w.localSettings, { schema: 1, 'review.extraLenses': ['security'] });
  const result = w.run({ action: 'remove', id: 'acme', json: true });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(JSON.parse(result.text).dangling, [{ kind: 'setting', layer: 'project', key: 'review.extraLenses', value: ['security', 'acme.strict'] }]);
});

test('an enabled package is disabled first and removed; the other packages keep their rows', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  assert.equal(w.run({ action: 'enable', id: 'acme' }).code, 0);
  const result = w.run({ action: 'remove', id: 'acme' });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(w.rows(), []);
  assert.match(result.text, /no dangling references/);
});

test('removing the bundled package is refused with a pointer to disable; only the audit row is written', (t) => {
  const w = world(t);
  w.stage(makePackage(t));
  const lockBefore = sha(w.lockFile);
  const result = w.run({ action: 'remove', id: 'doflow' });
  assert.equal(result.code, 1);
  assert.match(result.text, /bundled/);
  assert.match(result.text, /package --action disable --id doflow/);
  assert.equal(sha(w.lockFile), lockBefore, 'the lock is byte-identical');
  assert.deepEqual(readState({ homeDir: w.home }).state.audit.map((a) => [a.verb, a.package, a.result]), [['remove', 'doflow', 'bundled']]);
  assert.equal(readState({ homeDir: w.home }).state.removed.length, 0, 'no tombstone');
  assert.equal(readState({ homeDir: w.home }).state.revoked.length, 0, 'no revocation');
  assert.equal(w.rows().length, 1, 'the lock keeps its row');
  assert.equal(w.view('doflow').state, 'active');
});

test('an unreadable state.json refuses the removal before anything is changed', (t) => {
  const w = world(t);
  const { storeDir } = w.stage(makePackage(t));
  w.write(w.stateFile, '{ not json');
  const lockBefore = sha(w.lockFile);
  const result = w.run({ action: 'remove', id: 'acme' });
  assert.equal(result.code, 1);
  assert.match(result.text, /verify --repair/);
  assert.equal(sha(w.lockFile), lockBefore);
  assert.equal(fs.existsSync(storeDir), true, 'the store entry is still there');
});

// ── negative control ────────────────────────────────────────────────────────────────────────────────

test('negative control: removing an unknown id exits 1 and writes nothing (no lock, store, state or audit change)', (t) => {
  const w = world(t);
  w.write(w.projectSettings, { schema: 1, 'review.preset': 'acme.strict' });
  const empty = treeHash(w.home, w.project);
  const first = w.run({ action: 'remove', id: 'ghost' });
  assert.equal(first.code, 1, first.text);
  assert.match(first.text, /no package with id 'ghost'/);
  assert.equal(treeHash(w.home, w.project), empty, 'an empty HOME gains no directory, lock, state or audit');

  w.stage(makePackage(t));
  w.person(w.run({ action: 'trust', id: 'acme' }).lines.find((l) => l.startsWith('{')));
  const trustAudit = readState({ homeDir: w.home }).state.audit.length;
  const before = treeHash(w.home, w.project, w.scratch.xdg);
  const stateBefore = sha(w.stateFile);
  const result = w.run({ action: 'remove', id: 'ghost', json: true });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.text).error, 'unknown-package');
  assert.equal(treeHash(w.home, w.project, w.scratch.xdg), before);
  assert.equal(sha(w.stateFile), stateBefore, 'state.json is byte-identical');
  assert.equal(readState({ homeDir: w.home }).state.audit.length, trustAudit, 'no audit row');
});

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────────

function cli(scratch, cwd, args) {
  const result = spawnSync(process.execPath, [CLI, 'package', ...args], { env: scratch.env(), encoding: 'utf8', cwd });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('the CLI removes a package, runs storage upkeep like other writers, and refuses a missing --id as usage', (t) => {
  const w = world(t, { prune: 'on' });
  const dir = makePackage(t);
  const planned = cli(w.scratch, w.project, ['--action', 'add', '--source', dir, '--json']);
  assert.equal(planned.code, 0, planned.err);
  const applied = cli(w.scratch, w.project, ['--action', 'add', '--plan', JSON.parse(planned.out).plan.planId]);
  assert.equal(applied.code, 0, applied.err);
  // upkeep visits a state directory that exists; a first-ever run lock makes one and removes it again
  fs.mkdirSync(path.join(w.home, '.doflow', 'state'), { recursive: true });

  assert.equal(cli(w.scratch, w.project, ['--action', 'remove']).code, 2);
  const removed = cli(w.scratch, w.project, ['--action', 'remove', '--id', 'acme']);
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.out, /removed acme 1\.2\.0/);
  assert.deepEqual(w.rows(), []);
  assert.equal(fs.existsSync(path.join(w.home, '.doflow', 'state', 'upkeep-due')), true, 'remove runs upkeep like other writers');
  assert.equal(cli(w.scratch, w.project, ['--action', 'remove', '--id', 'acme']).code, 1, 'a second remove is an unknown id');
});
