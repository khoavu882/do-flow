'use strict';

// F.2 / IC-025: all writes stay in scratch homes and projects. No network and no real account state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { scaffoldPackage } = require('../../src/runtime/packages/scaffold.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const { checkPackage } = require('../../src/runtime/packages/manifest.ts');
const { hostVersion } = require('../../src/runtime/packages/view.ts');
const { satisfiesHostRange } = require('../../src/helper/semver.ts');
const { GRANTS_FILE } = require('../../src/runtime/packages/grants.ts');
const { upkeepAfterVerb } = require('../../src/runtime/storage/upkeep.ts');
const { readLock, defaultLock, writeLock } = require('../../src/state/lockfile.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const HOST = hostVersion(REPO_ROOT);
const POINTS = loadPoints({ repoRoot: REPO_ROOT }).registry;
const OPEN = POINTS.points.filter((p: any) => p.status === 'open');
const DAY = 24 * 3600000;

function machine(t: any): any {
  const root = tempDir(t, 'doflow-package-new-');
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'config');
  const project = path.join(root, 'project');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, xdg, project, tmp, path.join(project, '.doflow', 'package'), path.join(project, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const env: any = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_') || key === 'PI_CODING_AGENT_DIR') delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, TMPDIR: tmp,
    DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', DOFLOW_FAILURE_CAPTURE: 'off',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = spawnSync('git', ['init', '-q'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stdout + git.stderr);
  return { root, home, xdg, project, tmp, env, events: [] };
}

function run(w: any, args: any, extra: any = {}): any {
  const lines: string[] = [];
  const saved = process.exitCode;
  const options = {
    homeDir: w.home, env: w.env, cwd: w.project, projectRoot: w.project, tmpDir: w.tmp,
    json: true, writer: { write: (rows: any) => w.events.push(...rows) },
    ...args, ...extra, out: (line: any) => lines.push(line),
  };
  try {
    const code = handlePackageCommand(options);
    const text = lines.join('\n');
    return { code, text, lines, body: options.json ? JSON.parse(text) : null };
  } finally { process.exitCode = saved; }
}

function cli(w: any, args: any, extra: any = {}): any {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: w.project, env: w.env, encoding: 'utf8', input: '', timeout: 60000, ...extra,
  });
}

function created(result: any): any {
  assert.equal(result.code, 0, result.text);
  assert.equal(result.body.ok, true, result.text);
  return result.body;
}

function treeHash(root: string, exclude: string[] = []) {
  const hash = crypto.createHash('sha256');
  function walk(dir: string, rel = '') {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = rel ? `${rel}/${name}` : name;
      if (exclude.some((p: any) => relative === p || relative.startsWith(`${p}/`))) continue;
      const file = path.join(dir, name);
      const info = fs.lstatSync(file);
      hash.update(`${relative}\0${info.mode}\0`);
      if (info.isDirectory()) walk(file, relative);
      else if (info.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  }
  walk(root);
  return hash.digest('hex');
}

function scratchRegistry(w: any) {
  const root = path.join(w.root, 'runtime');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'shared'), path.join(root, 'core', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: HOST }));
  return root;
}

test('every open point alone, and all together, scaffold clean packages with the exact host range and JSON shape', (t: any) => {
  const w = machine(t);
  for (const points of [...OPEN.map((p: any) => p.id), OPEN.map((p: any) => p.id).join(',')]) {
    const id = `acme-${w.events.length}`;
    const result = created(run(w, { action: 'new', id, points }));
    assert.deepEqual(Object.keys(result), [
      'ok', 'id', 'dir', 'files', 'contributions', 'tierMax', 'contentDigest',
      'capabilityDigest', 'ignoredByGit', 'findings', 'next',
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'doflow-package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest), ['manifest', 'id', 'version', 'doflow', ...(result.tierMax === 'executable' ? ['programs'] : []), 'contributions']);
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.doflow, `>=${HOST} <${Number(HOST.split('.')[0]) + 1}.0.0`);
    assert.equal(satisfiesHostRange(HOST, manifest.doflow), true);
    assert.equal(satisfiesHostRange(`${Number(HOST.split('.')[0]) + 1}.0.0`, manifest.doflow), false);
    assert.deepEqual(manifest.contributions.map((c: any) => c.point), points.split(','));
    for (const c of manifest.contributions) {
      const point = OPEN.find((p: any) => p.id === c.point);
      assert.equal(c.version, Math.max(...point.versions));
      assert.equal(c.id, c.point);
    }
    const checked = checkPackage(result.dir, { repoRoot: REPO_ROOT, pointsRegistry: POINTS, hostVersion: HOST, bundled: [] });
    assert.equal(checked.ok, true, JSON.stringify(checked.findings));
    assert.equal(checked.contentDigest, result.contentDigest);
    assert.equal(checked.capabilityDigest, result.capabilityDigest);
    assert.equal(run(w, { action: 'check', path: result.dir }).code, 0);
    assert.ok(result.files.includes('README.md'));
    for (const file of result.files) assert.equal(fs.readFileSync(path.join(result.dir, file), 'utf8').includes('{{'), false, file);
  }
});

test('default uses the detected project root; explicit relative and outside targets work; no project requires --dir', (t: any) => {
  const w = machine(t);
  const nested = path.join(w.project, 'nested', 'child');
  fs.mkdirSync(nested, { recursive: true });
  const normal = created(run(w, { action: 'new', id: 'acme', points: 'skill:triage' }, { cwd: nested }));
  assert.equal(normal.dir, path.join(w.project, '.doflow', 'package', 'acme'));
  assert.deepEqual(normal.contributions, [{ point: 'skill', version: Math.max(...OPEN.find((p: any) => p.id === 'skill').versions), qualifiedId: 'acme.triage', tier: 'instruction', dir: 'skills/acme-triage' }]);
  const relative = created(run(w, { action: 'new', id: 'relative', points: 'review-preset', dir: 'relative' }, { cwd: nested }));
  assert.equal(relative.dir, path.join(nested, 'relative'));
  const outside = path.join(w.root, 'outside');
  fs.mkdirSync(outside);
  assert.equal(created(run(w, { action: 'new', id: 'outside', points: 'agent', dir: outside })).dir, outside);
  const refused = run(w, { action: 'new', id: 'no-root', points: 'skill' }, { cwd: w.home });
  assert.equal(refused.code, 2);
  assert.match(refused.text, /--dir/);
  assert.match(refused.text, /review-preset.*debate-preset.*skill.*agent/);
  for (const args of [{ id: 'acme' }, { points: 'skill' }]) assert.equal(run(w, { action: 'new', ...args }).code, 2);
});

test('new changes only its target; points, check and list remain byte-identical and no package is installed', (t: any) => {
  const w = machine(t);
  const seed = created(run(w, { action: 'new', id: 'seed', points: 'review-preset', dir: path.join(w.root, 'seed') }));
  const controls = [{ action: 'points' }, { action: 'check', path: seed.dir }, { action: 'list' }];
  const beforeOutput = controls.map((args: any) => run(w, args).text);
  const target = '.doflow/package/acme';
  const before = [
    treeHash(w.home), treeHash(w.xdg), treeHash(path.join(w.project, '.doflow', 'state')),
    treeHash(w.project, [target]),
  ];
  created(run(w, { action: 'new', id: 'acme', points: 'skill' }));
  assert.deepEqual([
    treeHash(w.home), treeHash(w.xdg), treeHash(path.join(w.project, '.doflow', 'state')),
    treeHash(w.project, [target]),
  ], before);
  assert.deepEqual(controls.map((args: any) => run(w, args).text), beforeOutput);
  assert.deepEqual(run(w, { action: 'list' }).body.packages.map((p: any) => p.id), ['doflow']);
  assert.equal(readLock({ scope: 'global', homeDir: w.home }), null);
});

test('non-empty targets and invalid ids or points refuse without changing existing bytes', (t: any) => {
  const w = machine(t);
  const dir = path.join(w.root, 'occupied');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep'), 'person-owned bytes\n');
  const before = treeHash(dir);
  const refused = run(w, { action: 'new', id: 'acme', points: 'skill', dir });
  assert.equal(refused.code, 1);
  assert.equal(refused.body.error, 'target-not-empty');
  assert.equal(treeHash(dir), before);
  const invalidCases: Array<[Record<string, any>, string]> = [
    [{ id: 'doflow', points: 'skill' }, 'reserved-id'],
    [{ id: 'do-x', points: 'skill' }, 'reserved-id'],
    [{ id: 'Bad', points: 'skill' }, 'bad-id'],
    [{ id: 'acme', points: 'capability-provider' }, 'point-reserved'],
    [{ id: 'acme', points: 'lens' }, 'undeclared-point'],
    [{ id: 'acme', points: 'skill:bad_id' }, 'bad-id'],
    [{ id: 'acme', points: 'skill:triage,skill:triage' }, 'bad-id'],
  ];
  for (const [args, code] of invalidCases) {
    const result = run(w, { action: 'new', ...args });
    assert.equal(result.code, 1, result.text);
    assert.equal(result.body.error, code);
  }
  const many = run(w, { action: 'new', id: 'acme', points: Array(65).fill('skill').join(',') });
  assert.equal(many.code, 1);
  assert.equal(many.body.error, 'bad-type');
  assert.equal(many.body.findings[0].field, 'points');
  assert.match(many.text, /64/);
  assert.deepEqual(fs.readdirSync(path.join(w.project, '.doflow', 'package')), []);
});

test('protected real targets, including symlinked ancestors, refuse before creating parents', (t: any) => {
  const w = machine(t);
  const protectedDirs = [
    path.join(w.home, '.doflow', 'packages'),
    path.join(w.project, '.doflow', 'state'),
    path.join(w.xdg, 'doflow'),
    REPO_ROOT,
  ];
  for (const base of protectedDirs) {
    const dir = path.join(base, 'authored', 'acme');
    const result = run(w, { action: 'new', id: 'acme', points: 'skill', dir });
    assert.equal(result.code, 1, result.text);
    assert.equal(result.body.error, 'target-forbidden');
    assert.equal(fs.existsSync(dir), false);
  }
  if (process.platform !== 'win32') {
    const alias = path.join(w.root, 'alias');
    fs.symlinkSync(path.join(w.project, '.doflow', 'state'), alias, 'dir');
    const result = run(w, { action: 'new', id: 'acme', points: 'skill', dir: path.join(alias, 'absent', 'acme') });
    assert.equal(result.body.error, 'target-forbidden');
    assert.equal(fs.existsSync(path.join(alias, 'absent')), false);
  }
});

test('a broken staged stub or unknown placeholder refuses template-invalid and removes staging; missing keys name template-missing', (t: any) => {
  const w = machine(t);
  const root = scratchRegistry(w);
  const files = path.join(root, 'core', 'registry', 'package-templates', 'review-preset', 'files');
  const stub = path.join(files, fs.readdirSync(files)[0]);
  const target = path.join(w.root, 'broken');
  fs.writeFileSync(stub, 'not a preset JSON document\n');
  let result = run(w, { action: 'new', id: 'acme', points: 'review-preset', dir: target, repoRoot: root });
  assert.equal(result.code, 1);
  assert.equal(result.body.error, 'template-invalid');
  assert.ok(result.body.findings.length > 1, 'the checker findings are carried under template-invalid');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(w.root).some((name: any) => name.startsWith('.staging-')), false);
  fs.writeFileSync(stub, '{{unknown}}\n');
  result = run(w, { action: 'new', id: 'acme', points: 'review-preset', dir: target, repoRoot: root });
  assert.equal(result.body.error, 'template-invalid');
  const registryFile = path.join(root, 'core', 'registry', 'contribution-points.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  delete registry.points.find((p: any) => p.id === 'review-preset').template;
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  result = run(w, { action: 'new', id: 'acme', points: 'review-preset', dir: target, repoRoot: root });
  assert.equal(result.body.error, 'template-missing');
});

test('stale staging for any id is removed, fresh staging is kept, and publication refuses a newly occupied target', (t: any) => {
  const w = machine(t);
  const parent = path.join(w.project, '.doflow', 'package');
  const now = Date.now();
  const stale = path.join(parent, '.staging-other-01234567');
  const fresh = path.join(parent, '.staging-fresh-89abcdef');
  for (const dir of [stale, fresh]) fs.mkdirSync(dir);
  fs.utimesSync(stale, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  created(run(w, { action: 'new', id: 'acme', points: 'review-preset', now }));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);

  const target = path.join(parent, 'racing');
  let occupied = false;
  const fsImpl = {
    ...fs,
    readFileSync(file: any, ...args: any[]) {
      const value = fs.readFileSync(file, ...args);
      if (!occupied && String(file).includes('.staging-racing-') && path.basename(String(file)) === 'doflow-package.json') {
        occupied = true;
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'keep'), 'won the race\n');
      }
      return value;
    },
  };
  const result = run(w, { action: 'new', id: 'racing', points: 'review-preset', fsImpl });
  assert.equal(result.body.error, 'target-not-empty');
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'won the race\n');
  assert.equal(fs.readdirSync(parent).some((name: any) => name.startsWith('.staging-racing-')), false);
});

test('git ignore is reported without editing rules; missing git and a non-git target return null', (t: any) => {
  const w = machine(t);
  assert.equal(created(run(w, { action: 'new', id: 'visible', points: 'review-preset' })).ignoredByGit, false);
  const ignore = path.join(w.project, '.gitignore');
  fs.writeFileSync(ignore, '.doflow\n');
  const text = run(w, { action: 'new', id: 'hidden', points: 'review-preset', json: false });
  assert.equal(text.code, 0, text.text);
  assert.match(text.text, /!\.doflow\/package\//);
  assert.equal(fs.readFileSync(ignore, 'utf8'), '.doflow\n');
  assert.equal(created(run(w, { action: 'new', id: 'ignored', points: 'review-preset' })).ignoredByGit, true);
  const bin = path.join(w.root, 'empty-bin');
  fs.mkdirSync(bin);
  assert.equal(created(run(w, { action: 'new', id: 'no-git', points: 'review-preset' }, { env: { ...w.env, PATH: bin } })).ignoredByGit, null);
  assert.equal(created(run(w, { action: 'new', id: 'outside', points: 'review-preset', dir: path.join(w.root, 'outside-git') })).ignoredByGit, null);
});

test('next has the closed table order and grants path; telemetry is one enums-only row on every exit', (t: any) => {
  const w = machine(t);
  const inert = created(run(w, { action: 'new', id: 'inert', points: 'review-preset' }));
  assert.deepEqual(inert.next.map((n: any) => n.step), ['edit', 'check', 'add', 'apply', 'enable', 'iterate']);
  const skill = created(run(w, { action: 'new', id: 'acme', points: 'skill' }));
  assert.deepEqual(skill.next.map((n: any) => n.step), ['edit', 'check', 'add', 'apply', 'enable', 'trust', 'iterate']);
  assert.ok(skill.next.find((n: any) => n.step === 'trust').note.includes(path.join(w.xdg, 'doflow', GRANTS_FILE)));
  assert.match(skill.next.find((n: any) => n.step === 'apply').note, /headless run stop here/);
  assert.match(skill.next.at(-1).note, /every applied change of content needs a new trust line/);
  assert.equal(skill.next[0].command, null);
  assert.equal(skill.next.at(-1).command, null);
  run(w, { action: 'new', id: 'doflow', points: 'skill' });
  run(w, { action: 'new', id: 'missing-points' });
  assert.deepEqual(w.events, [
    { kind: 'package.verb', action: 'new', result: 'ok', tier_max: 'inert' },
    { kind: 'package.verb', action: 'new', result: 'ok', tier_max: 'instruction' },
    { kind: 'package.verb', action: 'new', result: 'refused', tier_max: null },
    { kind: 'package.verb', action: 'new', result: 'usage', tier_max: null },
  ]);
  const noHome = scaffoldPackage({
    id: 'no-config', points: 'skill', dir: path.join(w.root, 'no-config'), cwd: w.project,
    homeDir: w.home, env: { ...w.env, HOME: '', XDG_CONFIG_HOME: '' },
  });
  assert.equal(noHome.ok, true);
  assert.match(noHome.next.find((n: any) => n.step === 'trust').note, /no config home/);
});

test('an already recorded id is a warning and leaves the global lock byte-identical', (t: any) => {
  const w = machine(t);
  const first = created(run(w, { action: 'new', id: 'acme', points: 'review-preset' }));
  const planned = run(w, { action: 'add', source: first.dir });
  assert.equal(planned.code, 0, planned.text);
  assert.equal(run(w, { action: 'add', plan: planned.body.plan.planId }).code, 0);
  const before = treeHash(w.home);
  const result = created(run(w, { action: 'new', id: 'acme', points: 'review-preset', dir: path.join(w.root, 'second-source') }));
  assert.ok(result.findings.some((f: any) => f.code === 'collision-package' && f.severity === 'warning'));
  assert.equal(treeHash(w.home), before);
});

test('update --plan prints the re-trust sentence after the line and includes it as JSON note', (t: any) => {
  const w = machine(t);
  const source = created(run(w, { action: 'new', id: 'acme', points: 'skill' })).dir;
  const add = run(w, { action: 'add', source });
  assert.equal(add.code, 0, add.text);
  assert.equal(run(w, { action: 'add', plan: add.body.plan.planId }).code, 0);
  const skill = path.join(source, 'skills', 'acme-skill', 'SKILL.md');
  const sentence = `the package acts again only after a person adds that line to ${path.join(w.xdg, 'doflow', GRANTS_FILE)}`;
  for (const json of [false, true]) {
    fs.appendFileSync(skill, '\nMore authored content.\n');
    const plan = run(w, { action: 'update', id: 'acme' });
    assert.equal(plan.code, 0, plan.text);
    const applied = run(w, { action: 'update', plan: plan.body.plan.planId, json });
    assert.equal(applied.code, 0, applied.text);
    if (json) assert.equal(applied.body.note, sentence);
    else {
      const at = applied.lines.indexOf(sentence);
      assert.ok(at > 0, applied.text);
      assert.equal(JSON.parse(applied.lines[at - 1]).grant, 'trust');
    }
  }
});

test('forced upkeep and removing a project-scope install preserve authored source byte-for-byte', (t: any) => {
  const w = machine(t);
  const source = created(run(w, { action: 'new', id: 'acme', points: 'skill' })).dir;
  const before = treeHash(source);
  const old = new Date(Date.now() - 400 * DAY);
  fs.utimesSync(source, old, old);
  const env: any = { ...w.env };
  delete env.DOFLOW_UPKEEP;
  fs.mkdirSync(path.join(w.xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(w.xdg, 'doflow', 'prune'), 'on\n');
  upkeepAfterVerb({ projectRoot: w.project, env, now: Date.now() });
  assert.equal(treeHash(source), before);
  const pruned = cli(w, ['storage', '--action', 'prune', '--json'], { env });
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.equal(treeHash(source), before);
  const installed = cli(w, ['install', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(fs.existsSync(path.join(w.project, '.doflow', 'doflow.lock')), true);
  const removed = cli(w, ['remove', '-f', '-t', 'claude']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(treeHash(source), before);
});

test('real CLI is headless, wires both value flags and finishes within five seconds', (t: any) => {
  const w = machine(t);
  const dir = path.join(w.root, 'cli-target');
  const start = Date.now();
  const result = cli(w, ['package', '--action', 'new', '--id', 'acme', '--points', 'skill:triage', '--dir', dir, '--json'], { timeout: 5000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - start < 5000);
  const body = JSON.parse(result.stdout);
  assert.equal(body.dir, dir);
  assert.equal(body.contributions[0].qualifiedId, 'acme.triage');
  assert.equal(checkPackage(dir, { repoRoot: REPO_ROOT, pointsRegistry: POINTS, hostVersion: HOST, bundled: [] }).ok, true);
});
