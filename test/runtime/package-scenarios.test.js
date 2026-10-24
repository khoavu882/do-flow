'use strict';

// Feature 122 B.8 (requirement §6; FR-001, FR-003, FR-004, FR-007, FR-008, FR-009, FR-012, NFR-001, NFR-004, IC-007):
// the Phase B scenarios end to end, through the real CLI (`bin/doflow.js`) in a scratch HOME, a scratch
// XDG_CONFIG_HOME and a scratch project, as a person would run them. Scenarios: check before effect, added is not
// enabled, weakening refused, faulty package isolated, removal, and the offline proof (a PATH stub for `git` and
// `npm` that records any spawn). The later phases' scenarios (trust, executables, remote sources) belong to them.
//
// Reading of the plan for "does not offer the package preset": `protocol --action list` shows the registry `order`
// only (a contributed preset is selectable by name, never ranked), and `protocol --action resolve --preset` accepts
// no dotted id. A contributed preset is therefore observed (a) through `package --action show` (the contribution's
// `active` flag) and (b) through a probe process that runs the shipped `loadProtocols` in the scratch HOME and project,
// the read every review site uses. The by-name path through a `review.preset` setting is its own case at the end.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const SLUG = '122-scenarios';

/** Versions around the running host: `next` is the first one above it, `ahead` a later one, `major` the next major. */
function hostNeighbours(host) {
  const pre = /^(\d+\.\d+\.\d+-[A-Za-z]+\.)(\d+)$/.exec(host);
  const major = `${Number(host.split('.')[0]) + 1}.0.0`;
  if (pre) return { next: `${pre[1]}${Number(pre[2]) + 1}`, ahead: `${pre[1]}${Number(pre[2]) + 50}`, major };
  const [a, b, c] = host.split('.').map(Number);
  return { next: `${a}.${b}.${c + 1}`, ahead: `${a}.${b}.${c + 2}`, major };
}
const NEIGHBOURS = hostNeighbours(HOST);
const PROBE = `
const { loadProtocols } = require(${JSON.stringify(path.join(REPO_ROOT, 'src', 'runtime', 'review', 'protocols.ts'))});
const loaded = loadProtocols({});
process.stdout.write(JSON.stringify({ ok: loaded.ok, presets: loaded.ok ? Object.keys(loaded.registry.presets) : [] }));
`;

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

const presetOf = (rounds = 2) => {
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  preset.rounds = { default: rounds, min: 1 };
  return preset;
};

/** A package directory (fresh each call) with one review preset `<local>`; `manifest` overrides fields, `preset` the file. */
function makePackage(t, { id = 'acme', local = 'strict', range = '>=2.0.0-beta.1 <3.0.0', manifest = {}, preset = presetOf() } = {}) {
  const dir = path.join(tempDir(t, 'doflow-pscen-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id, version: '1.2.0', summary: 'Stricter review presets', doflow: range,
    contributions: [{ point: 'review-preset', version: 1, id: local, file: `presets/${local}.json` }],
    ...manifest,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', `${local}.json`), JSON.stringify(preset, null, 2));
  return dir;
}

/** Every file under `root` (relative path -> sha256) and every directory, `.git` left out: the tree a verb may not change. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); }
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');

function run(cmd, args, options) { return spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...options }); }

/** One person's machine: scratch HOME and config home, and a git project with a verified change, as `review start` needs. */
function world(t) {
  const scratch = createScratch('doflow-pscen-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const gitEnv = scratch.env();
  const git = (...args) => {
    const res = run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, env: gitEnv });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text); };
  git('init', '-q', '-b', 'main');
  put('.git/info/exclude', '.doflow/\n');
  put('README.md', 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  put('src/a.ts', 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  put(`.doflow/state/orchestration/${SLUG}.json`, JSON.stringify({ taskId: SLUG, taskClass: 'feature', state: 'ACTIVE', program: [], history: [] }));
  put(`.doflow/state/verification/runs/${SLUG}.jsonl`, `${JSON.stringify({ schema: 1, taskId: SLUG, head, clean: true, verdict: 'PASS', at: '2026-10-23T00:00:00.000Z', reportSha256: 'x' })}\n`);
  // The review project leaves `.doflow/` excluded from git; its files above are state, not a change to the tree under test.
  const w = {
    scratch, project, base, home: scratch.home,
    lockFile: path.join(scratch.home, '.doflow', 'doflow.lock'),
    storeDir: (id) => path.join(scratch.home, '.doflow', 'packages', 'store', id),
    settingsFile: path.join(project, '.doflow', 'settings.json'),
    env: (extra = {}) => scratch.env({ DOFLOW_CLI: CLI, ...extra }),
  };
  /** Run `doflow <args>` in the project; `runtime` is a bin/doflow.js path (default: this checkout); `extra` env entries. */
  w.cli = (args, { runtime = CLI, extra = {} } = {}) => run(process.execPath, [runtime, ...args], { cwd: project, env: w.env(extra) });
  w.pkg = (...args) => w.cli(['package', '--action', ...args]);
  w.json = (result) => { assert.doesNotThrow(() => JSON.parse(result.stdout), `not JSON: ${result.stdout}${result.stderr}`); return JSON.parse(result.stdout); };
  /** add --source then add --plan: the package lands recorded and disabled. */
  w.add = (dir, { runtime = CLI } = {}) => {
    const planned = w.cli(['package', '--action', 'add', '--source', dir, '--json'], { runtime });
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    const applied = w.cli(['package', '--action', 'add', '--plan', w.json(planned).plan.planId], { runtime });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  };
  w.show = (id, opts) => w.json(w.cli(['package', '--action', 'show', '--id', id, '--json'], opts));
  /** The preset ids the shipped loader offers in this HOME and project (the read every review site uses). */
  w.offered = () => {
    const res = run(process.execPath, ['-e', PROBE], { cwd: project, env: w.env() });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    return parsed.presets;
  };
  w.review = (opts) => w.cli(['review', '--action', 'start', '--slug', SLUG, '--base', base, '--json'], opts);
  return w;
}

// ── check before effect (FR-001, FR-003) ──────────────────────────────────────────────────────────

test('check before effect: one bad preset field and one undeclared point give exactly two per-field errors, and nothing on disk changes', (t) => {
  const w = world(t);
  const bad = presetOf();
  bad.seats[0].model.tier = 'ultra';
  const dir = makePackage(t, {
    preset: bad,
    manifest: { contributions: [
      { point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' },
      { point: 'mystery-point', version: 1, id: 'other', file: 'presets/strict.json' },
    ] },
  });
  const homeBefore = snapshot(w.home);
  const projectBefore = snapshot(w.project);

  const checked = w.pkg('check', '--path', dir, '--json');
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  const body = w.json(checked);
  assert.equal(body.ok, false);
  assert.equal(body.findings.length, 2, JSON.stringify(body.findings));
  const [invalid, undeclared] = body.findings;
  assert.deepEqual([invalid.code, invalid.field], ['contribution-invalid', 'acme.strict.seats[0].model.tier']);
  assert.deepEqual(invalid.allowed, ['light', 'standard', 'frontier']);
  assert.deepEqual([undeclared.code, undeclared.field], ['undeclared-point', 'contributions[1].point']);
  assert.deepEqual(undeclared.allowed, ['review-preset', 'debate-preset'], 'the open points are listed');

  const plain = w.pkg('check', '--path', dir);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /error contribution-invalid acme\.strict\.seats\[0\]\.model\.tier:/);
  assert.match(plain.stdout, /error undeclared-point contributions\[1\]\.point:/);
  assert.match(plain.stdout, /package refused/);

  const refused = w.pkg('add', '--source', dir);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /undeclared-point/);

  assert.deepEqual(snapshot(w.home), homeBefore, 'HOME is byte-identical');
  assert.deepEqual(snapshot(w.project), projectBefore, 'the project is byte-identical');
  assert.equal(fs.existsSync(w.lockFile), false, 'no lock appears from a refused package');
});

// ── added is not enabled (FR-004) ─────────────────────────────────────────────────────────────────

test('added is not enabled: add and add --plan record the package disabled and offer no preset; enable offers it', (t) => {
  const w = world(t);
  const dir = makePackage(t);
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), []);

  const planned = w.pkg('add', '--source', dir, '--json');
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(fs.existsSync(w.lockFile), false, 'a plan records nothing');
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), []);

  const applied = w.pkg('add', '--plan', w.json(planned).plan.planId);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /added acme 1\.2\.0 disabled/);
  const shown = w.show('acme');
  assert.equal(shown.enabled, false);
  assert.equal(shown.state, 'disabled');
  assert.deepEqual(shown.contributions.map((c) => [c.qualifiedId, c.active]), [['acme.strict', false]]);
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), [], 'an added package contributes nothing');

  // A setting that names the added package's preset does not select it: the settings value is refused as unavailable.
  fs.mkdirSync(path.dirname(w.settingsFile), { recursive: true });
  fs.writeFileSync(w.settingsFile, `${JSON.stringify({ 'review.preset': 'acme.strict' })}\n`);
  const named = w.cli(['protocol', '--action', 'resolve', '--kind', 'review', '--json']);
  assert.equal(named.status, 1, named.stdout + named.stderr);
  assert.equal(w.json(named).error, 'settings-unavailable');
  assert.match(w.json(named).message, /review\.preset/);
  fs.rmSync(w.settingsFile);

  const enabled = w.pkg('enable', '--id', 'acme');
  assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
  assert.match(enabled.stdout, /acme 1\.2\.0 active/);
  assert.equal(w.show('acme').state, 'active');
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), ['acme.strict']);
  assert.equal(w.show('acme').contributions[0].active, true);

  const disabled = w.pkg('disable', '--id', 'acme');
  assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), [], 'disable takes it away again');
});

// Open defect (reported with this task, not fixed here): while an enabled package exists, loading the settings that
// name its preset re-enters the settings loader (`packages.disabled` -> `packages.ids` -> contributed ids ->
// `loadProtocols` -> package view -> `packages.disabled`), the nested read throws "depends on itself", the package
// view treats that as an invalid `packages.disabled` and fails closed (every third-party package `settings-invalid`),
// so the preset is missing from the `review.preset` values and the value is refused. The case states the intended
// behaviour and runs as a `todo`: its failure is reported, not hidden, and it turns into a normal test with the fix.
test('an enabled package preset named by a review.preset setting resolves by name', { todo: 'defect: settings load re-enters packages.disabled and drops contributed ids (see B.8 report)' }, (t) => {
  const w = world(t);
  w.add(makePackage(t));
  assert.equal(w.pkg('enable', '--id', 'acme').status, 0);
  fs.mkdirSync(path.dirname(w.settingsFile), { recursive: true });
  fs.writeFileSync(w.settingsFile, `${JSON.stringify({ 'review.preset': 'acme.strict' })}\n`);
  const resolved = w.cli(['protocol', '--action', 'resolve', '--kind', 'review', '--json']);
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  const protocol = w.json(resolved).protocol;
  assert.equal(protocol.id, 'acme.strict');
  assert.equal(protocol.origins.id, 'project');
});

// ── weakening refused (FR-007, FR-008) ────────────────────────────────────────────────────────────

test('weakening refused: a built-in preset id and a settings key, order or enabled field are each refused with the collision or the field named', (t) => {
  const w = world(t);
  const homeBefore = snapshot(w.home);

  const reuse = makePackage(t, { local: 'review-deep' });
  const reused = w.pkg('check', '--path', reuse, '--json');
  assert.equal(reused.status, 1, reused.stdout + reused.stderr);
  assert.deepEqual(w.json(reused).findings.map((f) => [f.field, f.code]), [['contributions[0].id', 'reserved-id']]);
  assert.match(w.json(reused).findings[0].message, /review-deep/);

  const reservedPackage = makePackage(t, { id: 'doflow' });
  const reservedId = w.json(w.pkg('check', '--path', reservedPackage, '--json'));
  assert.deepEqual(reservedId.findings.map((f) => [f.field, f.code]), [['id', 'reserved-id']]);

  for (const [field, value] of [['settings', { 'review.preset': 'review-single' }], ['order', { review: ['acme.strict'] }], ['enabled', true]]) {
    const dir = makePackage(t, { manifest: { [field]: value } });
    const checked = w.pkg('check', '--path', dir, '--json');
    assert.equal(checked.status, 1, `${field}: ${checked.stdout}${checked.stderr}`);
    assert.deepEqual(w.json(checked).findings.map((f) => [f.field, f.code]), [[field, 'forbidden-field']], field);
    const added = w.pkg('add', '--source', dir);
    assert.equal(added.status, 1, `${field}: ${added.stdout}${added.stderr}`);
    assert.match(added.stdout, new RegExp(`forbidden-field ${field}:`));
  }

  assert.deepEqual(snapshot(w.home), homeBefore, 'no refused package left a file behind');
});

// ── faulty package isolated (FR-009) ──────────────────────────────────────────────────────────────

/**
 * A scratch copy of the runtime a person installs (bin, src, core/registry, package.json) that reports another host
 * version. The same HOME, lock and store are read by both runtimes, so a package added under the real host is
 * recorded under one version and run under the other.
 */
function runtimeAt(t, version) {
  const root = tempDir(t, 'doflow-pscen-host-');
  for (const rel of ['bin', 'src']) fs.cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doflow-scratch', version }));
  // The first-party package is pinned to its own release (`doflow` range `=<version>`): the copy pins it to the new host.
  const bundled = path.join(root, 'core', 'registry', 'packages', 'doflow', 'doflow-package.json');
  const manifest = JSON.parse(fs.readFileSync(bundled, 'utf8'));
  fs.writeFileSync(bundled, JSON.stringify({ ...manifest, version, doflow: `=${version}` }, null, 2));
  return path.join(root, 'bin', 'doflow.js');
}

test('faulty package isolated: a package whose range excludes the running host is incompatible with the reason; another stays active and the verbs complete', (t) => {
  const w = world(t);
  // Both are added under the real host; the lock row carries no range, the range is read from the stored manifest.
  w.add(makePackage(t, { id: 'old-range', local: 'old', range: `>=2.0.0-beta.1 <${NEIGHBOURS.next}` }));
  w.add(makePackage(t, { id: 'wide-range', local: 'wide', range: `>=2.0.0-beta.1 <${NEIGHBOURS.major}` }));
  assert.equal(w.pkg('enable', '--id', 'old-range').status, 0);
  assert.equal(w.pkg('enable', '--id', 'wide-range').status, 0);
  assert.equal(w.show('old-range').state, 'active');

  const future = runtimeAt(t, NEIGHBOURS.ahead);
  const old = w.show('old-range', { runtime: future });
  assert.equal(old.state, 'incompatible', 'a host above the upper bound of the range makes the package incompatible (the bound held when it was added)');
  assert.deepEqual(old.reasons, ['host-incompatible']);
  assert.equal(old.contributions.every((c) => c.active === false), true);
  const wide = w.show('wide-range', { runtime: future });
  assert.equal(wide.state, 'active');
  assert.deepEqual(wide.reasons, []);

  const listed = w.cli(['package', '--action', 'list', '--json'], { runtime: future });
  assert.equal(listed.status, 1, 'list reports the unhealthy package with exit 1');
  const view = w.json(listed);
  assert.deepEqual(view.packages.map((p) => [p.id, p.state]), [['doflow', 'active'], ['old-range', 'incompatible'], ['wide-range', 'active']]);
  assert.ok(view.findings.some((f) => f.package === 'old-range' && f.code === 'host-incompatible' && f.severity === 'error'));

  assert.equal(w.cli(['protocol', '--action', 'list'], { runtime: future }).status, 0);
  const config = w.cli(['config', 'list'], { runtime: future });
  assert.equal(config.status, 0, config.stdout + config.stderr);
  assert.match(config.stdout, /review\.preset = "auto"/);
  const started = w.review({ runtime: future });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const result = w.json(started);
  assert.equal(result.ok, true);
  assert.equal(result.depth, 'deep');
});

// ── removal (FR-012) ──────────────────────────────────────────────────────────────────────────────

test('removal: the store files go, the project setting that names the preset is reported dangling, and the settings file is byte-identical', (t) => {
  const w = world(t);
  w.add(makePackage(t));
  assert.equal(w.pkg('enable', '--id', 'acme').status, 0);
  fs.mkdirSync(path.dirname(w.settingsFile), { recursive: true });
  fs.writeFileSync(w.settingsFile, `${JSON.stringify({ 'review.preset': 'acme.strict' }, null, 2)}\n`);
  const before = sha(w.settingsFile);
  assert.ok(fs.existsSync(w.storeDir('acme')));

  const removed = w.pkg('remove', '--id', 'acme', '--json');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  const body = w.json(removed);
  assert.equal(body.ok, true);
  assert.deepEqual(body.qualifiedIds, ['acme.strict']);
  assert.deepEqual(body.dangling, [{ kind: 'setting', layer: 'project', key: 'review.preset', value: 'acme.strict' }]);

  assert.equal(fs.existsSync(w.storeDir('acme')), false, 'the store entry is deleted');
  assert.equal(fs.existsSync(path.join(w.home, '.doflow', 'packages', 'store', 'acme')), false);
  assert.equal(fs.existsSync(w.lockFile), false, 'the lock file goes when nothing else remains');
  assert.equal(sha(w.settingsFile), before, 'the person\'s settings file is byte-identical');
  const gone = w.pkg('show', '--id', 'acme');
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /no package with id 'acme'/);
  assert.deepEqual(w.offered().filter((id) => id.startsWith('acme')), []);

  const text = w.pkg('add', '--source', makePackage(t));
  assert.equal(text.status, 0, 'the id can be added again after removal');
});

// ── IC-007: the downgrade limit ───────────────────────────────────────────────────────────────────

test('list states the lock v2 downgrade limit when the global lock is version 2, and only then', (t) => {
  const w = world(t);
  const empty = w.pkg('list');
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.doesNotMatch(empty.stdout, /older DoFlow/);
  assert.equal(w.json(w.pkg('list', '--json')).lockVersion, 1);

  w.add(makePackage(t));
  assert.equal(JSON.parse(fs.readFileSync(w.lockFile, 'utf8')).version, 2);
  const text = w.pkg('list');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const lines = text.stdout.split('\n').filter((l) => /older DoFlow/.test(l));
  assert.equal(lines.length, 1, text.stdout);
  assert.match(lines[0], /lock/);
  assert.match(lines[0], /cannot read/);

  // --json keeps its key set (the Console contract, pinned by package-verbs.test.js); `lockVersion` is how it states the fact.
  const json = w.json(w.pkg('list', '--json'));
  assert.equal(json.lockVersion, 2);
  assert.deepEqual(Object.keys(json), ['points', 'packages', 'findings', 'lockVersion']);
  assert.doesNotMatch(JSON.stringify(json), /older DoFlow/);

  assert.equal(w.pkg('remove', '--id', 'acme').status, 0);
  assert.doesNotMatch(w.pkg('list').stdout, /older DoFlow/, 'with no lock left there is nothing to state');
});

// ── NFR-004: offline proof ────────────────────────────────────────────────────────────────────────

/** A directory holding stub programs that record any call (a marker line) and exit 1. */
function stubDir(t, names) {
  const dir = tempDir(t, 'doflow-pscen-stubs-');
  const log = path.join(dir, 'calls.log');
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '') };
}

test('NFR-004: check, list, add, add --plan, enable and a review run never spawn git or npm', (t) => {
  const w = world(t);
  const both = stubDir(t, ['git', 'npm']);
  const front = { PATH: `${both.dir}${path.delimiter}${process.env.PATH}` };
  const pkg = makePackage(t);

  // The stubs are on PATH first: prove they would be found, so a silent pass cannot come from a wrong PATH.
  const probe = run('git', ['--version'], { env: { ...process.env, ...front } });
  assert.equal(probe.status, 1);
  assert.match(both.calls(), /^git --version/);
  fs.rmSync(path.join(both.dir, 'calls.log'));

  const steps = [
    ['check', ['package', '--action', 'check', '--path', pkg]],
    ['list', ['package', '--action', 'list']],
    ['add', ['package', '--action', 'add', '--source', pkg, '--json']],
  ];
  let planId = null;
  for (const [name, args] of steps) {
    const res = w.cli(args, { extra: front });
    assert.equal(res.status, 0, `${name}: ${res.stdout}${res.stderr}`);
    if (name === 'add') planId = JSON.parse(res.stdout).plan.planId;
  }
  for (const [name, args] of [
    ['add --plan', ['package', '--action', 'add', '--plan', planId]],
    ['enable', ['package', '--action', 'enable', '--id', 'acme']],
    ['show', ['package', '--action', 'show', '--id', 'acme']],
    ['list (after enable)', ['package', '--action', 'list']],
  ]) {
    const res = w.cli(args, { extra: front });
    assert.equal(res.status, 0, `${name}: ${res.stdout}${res.stderr}`);
  }
  assert.equal(both.calls(), '', `a package verb spawned a stub: ${both.calls()}`);

  // A review run needs git for the diff base: the real git stays reachable under its own name and only `npm` is stubbed.
  // The package is active and its preset is loaded for the run; no package code path may reach npm.
  const realGit = run('sh', ['-c', 'command -v git']).stdout.trim();
  assert.ok(realGit, 'git is installed');
  const gitOnly = tempDir(t, 'doflow-pscen-git-');
  fs.symlinkSync(realGit, path.join(gitOnly, 'git'));
  const npmOnly = stubDir(t, ['npm']);
  const review = w.review({ extra: { PATH: `${npmOnly.dir}${path.delimiter}${gitOnly}${path.delimiter}${process.env.PATH}` } });
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.equal(w.json(review).ok, true);
  assert.equal(npmOnly.calls(), '', `a review run spawned npm: ${npmOnly.calls()}`);
});
