'use strict';

// Feature 122 A.5 (IC-010, IC-012 `list` and `show`): the package view over the bundled packages, and the
// read-only `doflow package --action list|show`. A bundled package is a directory of a scratch runtime root
// listed in that root's `contribution-points.json`; nothing here installs anything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const COMMAND = path.join(REPO_ROOT, 'src', 'runtime', 'packages', 'command.ts');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const POINTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'contribution-points.json'), 'utf8'));
const PROTOCOLS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const DIGEST = 'ab'.repeat(32);

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

/** A bundled package directory under `root`: a valid manifest and one debate preset. */
function bundledPackage(root, rel, id = 'doflow', manifestPatch = {}) {
  const preset = JSON.parse(JSON.stringify(PROTOCOLS.presets['debate-3']));
  write(path.join(root, rel, 'presets', 'debate-3.json'), preset);
  write(path.join(root, rel, 'doflow-package.json'), {
    manifest: 1, id, version: VERSION, summary: 'DoFlow first-party presets', doflow: `=${VERSION}`,
    contributions: [{ point: 'debate-preset', version: 1, id: 'debate-3', file: 'presets/debate-3.json' }],
    ...manifestPatch,
  });
}

/** A scratch runtime root: the registries a view reads, and the given `bundled` list. */
function scratchRoot(t, bundled) {
  const root = tempDir(t, 'doflow-pkgview-');
  write(path.join(root, 'package.json'), { name: 'doflow-scratch', version: VERSION });
  write(path.join(root, 'core', 'registry', 'protocols.json'), PROTOCOLS);
  write(path.join(root, 'core', 'registry', 'contribution-points.json'), { ...POINTS, bundled });
  fs.symlinkSync(path.join(REPO_ROOT, 'core', 'shared'), path.join(root, 'core', 'shared'));
  return root;
}
const entry = (id, dir) => ({ id, dir, contentDigest: DIGEST });
const view = (root, extra = {}) => { resetPackageView(); return packageView({ repoRoot: root, ...extra }); };

/** Run `package --action <args>` in-process in a child whose PATH holds a node symlink and nothing else. */
function runList(t, root, args = {}) {
  const bin = path.join(tempDir(t, 'doflow-pkgbin-'), 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const home = tempDir(t, 'doflow-pkghome-');
  const script = `const { handlePackageCommand } = require(${JSON.stringify(COMMAND)});
    const lines = [];
    const code = handlePackageCommand({ ...${JSON.stringify(args)}, repoRoot: ${JSON.stringify(root)}, out: (l) => lines.push(l) });
    process.stdout.write(JSON.stringify({ code, lines }));`;
  const result = spawnSync(path.join(bin, 'node'), ['-e', script], {
    cwd: home, encoding: 'utf8', env: { PATH: bin, HOME: home, DOFLOW_TELEMETRY: 'off' },
  });
  const parsed = JSON.parse(result.stdout || 'null') ?? assert.fail(result.stderr);
  assert.equal(result.status, parsed.code, 'the handler code is the process exit code');
  return { home, code: parsed.code, lines: parsed.lines };
}

function snapshot(root, base = root, out = {}) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    const rel = path.relative(base, full);
    if (e.isSymbolicLink()) out[rel] = fs.readlinkSync(full);
    else if (e.isDirectory()) { out[`${rel}/`] = null; snapshot(full, base, out); } else out[rel] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('a valid bundled package is active, first-party and enabled, with the registry digest', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  const result = view(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.packages.length, 1);
  const [pkg] = result.packages;
  assert.equal(pkg.id, 'doflow');
  assert.equal(pkg.version, VERSION);
  assert.deepEqual(pkg.source, { type: 'bundled' });
  assert.equal(pkg.firstParty, true);
  assert.equal(pkg.enabled, true);
  assert.equal(pkg.state, 'active');
  assert.deepEqual(pkg.reasons, []);
  assert.equal(pkg.tierMax, 'inert');
  assert.equal(pkg.contentDigest, DIGEST, 'the registry value, never re-hashed');
  assert.deepEqual(pkg.contributions, [{ point: 'debate-preset', version: 1, qualifiedId: 'doflow.debate-3', tier: 'inert', active: true }]);
  assert.deepEqual(result.points.map((p) => p.id), POINTS.points.map((p) => p.id));
});

test('the view is memoised per process and reset on demand', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  resetPackageView();
  const first = packageView({ repoRoot: root });
  assert.equal(packageView({ repoRoot: root }), first);
  resetPackageView();
  assert.notEqual(packageView({ repoRoot: root }), first);
});

test('the bundled digest is not re-hashed: an edited tree stays active with the registry digest', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  write(path.join(root, 'core/registry/packages/doflow/README.md'), 'a file the digest in the registry never covered');
  const [pkg] = view(root).packages;
  assert.equal(pkg.state, 'active');
  assert.equal(pkg.contentDigest, DIGEST);
});

test('a bundled entry whose directory is missing is incompatible with file-missing', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  const result = view(root);
  const [pkg] = result.packages;
  assert.equal(pkg.state, 'incompatible');
  assert.deepEqual(pkg.reasons, ['file-missing']);
  assert.equal(pkg.firstParty, true);
  assert.deepEqual(result.findings.map((f) => [f.package, f.code, f.severity]), [['doflow', 'file-missing', 'error']]);
});

test('a manifest the checker refuses makes the package incompatible with the checker codes', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow', 'doflow', { colour: 'red', doflow: '>=1.0.0 <1.5.0' });
  const [pkg] = view(root).packages;
  assert.equal(pkg.state, 'incompatible');
  assert.deepEqual([...pkg.reasons].sort(), ['host-incompatible', 'unknown-key']);
  assert.deepEqual(pkg.contributions.map((c) => c.active), [false]);
});

test('a manifest id that differs from the bundled id is incompatible', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow', 'other');
  const [pkg] = view(root).packages;
  assert.equal(pkg.state, 'incompatible');
  assert.ok(pkg.reasons.includes('bad-id'), JSON.stringify(pkg.reasons));
});

test('a dir that leaves the runtime root is incompatible with path-escapes-root, however it is written', (t) => {
  const outside = tempDir(t, 'doflow-pkgout-');
  bundledPackage(outside, '.');
  const root = scratchRoot(t, [entry('doflow', '../escape'), entry('doflow2', outside)]);
  const result = view(root);
  assert.deepEqual(result.packages.map((p) => [p.id, p.state, p.reasons]), [
    ['doflow', 'incompatible', ['path-escapes-root']],
    ['doflow2', 'incompatible', ['path-escapes-root']],
  ]);
});

test('each package is judged alone: a broken one never changes another', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow'), entry('acme', 'core/registry/packages/acme')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  write(path.join(root, 'core/registry/packages/acme/doflow-package.json'), '{ not json');
  const result = view(root);
  assert.deepEqual(result.packages.map((p) => [p.id, p.state]), [['doflow', 'active'], ['acme', 'incompatible']]);
  assert.ok(result.findings.every((f) => f.package === 'acme'));
});

test('a corrupt contribution-points.json yields no packages and one state-unreadable finding', (t) => {
  const root = scratchRoot(t, []);
  write(path.join(root, 'core/registry/contribution-points.json'), '{ nope');
  const result = view(root);
  assert.deepEqual(result.packages, []);
  assert.deepEqual(result.points, []);
  assert.deepEqual(result.findings.map((f) => [f.package, f.field, f.code, f.severity]), [[null, 'points', 'state-unreadable', 'error']]);
});

test('list --json with no harness on PATH shows one bundled package, active and first-party; nothing is written', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  const before = snapshot(root);
  const run = runList(t, root, { action: 'list', json: true });
  assert.equal(run.code, 0);
  const out = JSON.parse(run.lines.join('\n'));
  assert.deepEqual(Object.keys(out).sort(), ['findings', 'lockVersion', 'packages', 'points']);
  assert.equal(out.packages.length, 1);
  assert.equal(out.packages[0].state, 'active');
  assert.equal(out.packages[0].firstParty, true);
  assert.equal(out.lockVersion, 1);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(snapshot(root), before, 'the runtime root is untouched');
  assert.deepEqual(snapshot(run.home), {}, 'the scratch HOME the child ran in stays empty');
});

test('list exits 1 when a package is incompatible and 1 for a corrupt registry, and prints the findings', (t) => {
  const missing = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  const broken = runList(t, missing, { action: 'list', json: true });
  assert.equal(broken.code, 1);
  const out = JSON.parse(broken.lines.join('\n'));
  assert.equal(out.packages[0].state, 'incompatible');
  assert.equal(out.findings[0].code, 'file-missing');

  const corrupt = scratchRoot(t, []);
  write(path.join(corrupt, 'core/registry/contribution-points.json'), '{ nope');
  const run = runList(t, corrupt, { action: 'list', json: true });
  assert.equal(run.code, 1);
  assert.equal(JSON.parse(run.lines.join('\n')).findings[0].code, 'state-unreadable');
});

test('a faulty bundled package never stops `protocol --action list`', (t) => {
  const env = { ...process.env, HOME: tempDir(t, 'doflow-pkghome-'), DOFLOW_TELEMETRY: 'off' };
  const run = spawnSync(process.execPath, [CLI, 'protocol', '--action', 'list', '--json'], { cwd: tempDir(t, 'doflow-pkgwork-'), env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  assert.equal(view(root).packages[0].state, 'incompatible');
});

test('list --id keeps one package; show prints one PackageState', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow'), entry('acme', 'core/registry/packages/acme')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  bundledPackage(root, 'core/registry/packages/acme', 'acme');
  const list = runList(t, root, { action: 'list', id: 'acme', json: true });
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.lines.join('\n')).packages.map((p) => p.id), ['acme']);
  const show = runList(t, root, { action: 'show', id: 'doflow', json: true });
  assert.equal(show.code, 0);
  assert.equal(JSON.parse(show.lines.join('\n')).id, 'doflow');
  const text = runList(t, root, { action: 'show', id: 'doflow' });
  assert.equal(text.code, 0);
  assert.match(text.lines.join('\n'), /doflow .*active/);
});

test('show of an unknown id exits 1; show without --id exits 2; list of an unknown id exits 1', (t) => {
  const root = scratchRoot(t, [entry('doflow', 'core/registry/packages/doflow')]);
  bundledPackage(root, 'core/registry/packages/doflow');
  assert.equal(runList(t, root, { action: 'show', id: 'nope', json: true }).code, 1);
  assert.equal(runList(t, root, { action: 'show', json: true }).code, 2);
  assert.equal(runList(t, root, { action: 'list', id: 'nope', json: true }).code, 1);
});

test('through bin/doflow.js: --id is forwarded, the shipped registry lists no package, and nothing is written', (t) => {
  const home = tempDir(t, 'doflow-pkghome-');
  const cwd = tempDir(t, 'doflow-pkgwork-');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), DOFLOW_TELEMETRY: 'off', DOFLOW_CLI: CLI };
  delete env.DOFLOW_CONFIG_DIR;
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'package', ...args], { cwd, env, encoding: 'utf8' });
  const before = snapshot(home);
  const list = cli('--action', 'list', '--json');
  assert.equal(list.status, 0, list.stderr);
  const out = JSON.parse(list.stdout);
  assert.deepEqual(out.packages.map((p) => p.id), POINTS.bundled.map((b) => b.id));
  assert.deepEqual(out.points.map((p) => p.id), POINTS.points.map((p) => p.id));
  assert.equal(cli('--action', 'show').status, 2);
  const unknown = cli('--action', 'show', '--id', 'no-such-package');
  assert.equal(unknown.status, 1, unknown.stderr + unknown.stdout);
  assert.equal(cli('--action', 'list', '--id', 'no-such-package').status, 1);
  assert.deepEqual(snapshot(home), before, 'no file appears under the scratch HOME');
});
