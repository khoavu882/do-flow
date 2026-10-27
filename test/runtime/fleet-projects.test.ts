'use strict';

// Row 093 V.3 (IC-019): `doflow fleet --action projects` lists the projects this machine knows,
// from the user-state `upkeep-roots` and the hook project directories, with no write. Scratch HOME,
// config home and git repositories. The module tests inject the temp roots (the fixtures live under
// the real temp folder, which the verb filters), the process tests read that filter as it ships.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { listProjects } = require('../../src/runtime/fleet/projects.ts');
const { handleFleetCommand } = require('../../src/runtime/fleet/command.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE = fs.readFileSync(path.join(REPO, 'src/cli/runtime-commands.ts'), 'utf8');
const PLANTED = 'planted-marker-FLEET-77';

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repo(dir: string, doflow = true) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  if (doflow) fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
}

function treeSnapshot(root: string) {
  const entries: any = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const base = { mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
      const rel = path.relative(root, file);
      if (info.isDirectory()) { entries[rel] = { type: 'dir', ...base }; visit(file); }
      else if (info.isFile()) entries[rel] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...base };
      else entries[rel] = { type: 'other', ...base };
    }
  };
  visit(root);
  return entries;
}

// Windows: PATH is already the runner's (node and Git for Windows are on it) and uses ';', os.homedir() reads USERPROFILE,
// the temp folder comes from TEMP/TMP rather than TMPDIR, and a spawn with a stripped environment still needs SystemRoot.
const WIN = process.platform === 'win32';
const winEnv = (home: string, tmp?: string): any => (WIN ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot, windir: process.env.windir, ...(tmp ? { TEMP: tmp, TMP: tmp } : {}) } : {});

function env(f: any): any {
  return {
    HOME: f.home, XDG_CONFIG_HOME: f.config, TMPDIR: process.env.TMPDIR, ...winEnv(f.home, process.env.TMPDIR), PATH: WIN ? (process.env.PATH ?? '') : `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off',
  };
}

function metaDir(f: any, name: string, meta: any, raw?: string) {
  const dir = path.join(f.config, 'doflow', 'session-env', 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), raw ?? JSON.stringify(meta));
}

function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-fleet-projects-'));
  const f: any = {
    root, home: path.join(root, 'home'), config: path.join(root, 'config'),
    main: path.join(root, 'proj'), linked: path.join(root, 'proj-linked'), plain: path.join(root, 'plain'),
    zone: path.join(root, 'tmpzone'), gone: path.join(root, 'gone'),
  };
  fs.mkdirSync(path.join(f.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  repo(f.main);
  git(f.main, 'worktree', 'add', '-q', '-b', 'feat-x', f.linked);
  fs.mkdirSync(path.join(f.linked, '.doflow', 'state'), { recursive: true });
  repo(f.plain, false);
  repo(path.join(f.zone, 'scratch-proj'));
  fs.writeFileSync(path.join(f.main, '.doflow', 'state', 'upkeep-due'), '1\n');
  fs.utimesSync(path.join(f.main, '.doflow', 'state', 'upkeep-due'), new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), [
    f.main, f.linked, f.gone, path.join(f.zone, 'scratch-proj'), 'relative/torn-line', '', f.main,
  ].join('\n') + '\n');
  // Hook directories: a session in a subdirectory of the main checkout, one in a non-DoFlow repo
  // (the planted path), and one in a linked worktree.
  metaDir(f, 'aaaaaaaaaaaaaaaa', { cwd: path.join(f.main, 'sub'), last_agent: PLANTED, last_active: '2026-05-01T00:00:00Z', branch: PLANTED });
  metaDir(f, 'bbbbbbbbbbbbbbbb', { cwd: f.plain, last_agent: PLANTED, last_active: '2026-06-01T00:00:00Z', branch: PLANTED });
  fs.mkdirSync(path.join(f.main, 'sub'));
  return f;
}

const opts = (f: any, extra: any = {}) => ({ env: env(f), cwd: f.main, tempRoots: [f.zone], ...extra });

test('projects: field set, grouping by common git dir, filters and counts (IC-019)', (t) => {
  const f = fixture(t);
  clearCheckoutCache();
  const r = listProjects(opts(f, { cwd: f.linked }));
  assert.equal(r.ok, true);
  const body = r.body;
  assert.deepEqual(Object.keys(body).sort(), ['excluded', 'projects', 'store', 'truncated', 'v']);
  assert.equal(body.v, 1);
  assert.equal(body.store, 'present');
  assert.equal(body.truncated, false);
  assert.equal(body.projects.length, 1, 'main and linked worktree are one project');
  const [p] = body.projects;
  assert.deepEqual(Object.keys(p).sort(), ['checkouts', 'current', 'label', 'lastRecordAt', 'projectKey', 'root', 'sources'].sort());
  assert.equal(p.projectKey, cwdHash(f.main));
  assert.match(p.projectKey, /^[0-9a-f]{16}$/);
  assert.equal(p.root, f.main);
  assert.equal(p.label, 'proj');
  assert.equal(p.current, true, 'cwd in the linked worktree is the same project');
  assert.equal(p.checkouts, 2);
  assert.deepEqual([...p.sources].sort(), ['hook-dirs', 'upkeep-roots']);
  assert.equal(p.lastRecordAt, '2026-05-01T00:00:00.000Z', 'newest of the meta last_active values and the upkeep-due mtime');
  // missing: gone; temp: the zone; notDoflow: the plain repo from a meta cwd; unreadable: the torn line.
  assert.deepEqual(body.excluded, { missing: 1, temp: 1, notDoflow: 1, unreadable: 1 });
  const text = JSON.stringify(body);
  assert.ok(!text.includes(PLANTED), 'no last_agent or branch');
  assert.ok(!text.includes(f.plain) && !text.includes(f.zone) && !text.includes(f.gone) && !text.includes(f.linked), 'no path but the main root');
  assert.ok(!text.includes('"cwd"'));
});

test('projects: current is false from another directory and sorts first when true (IC-019)', (t) => {
  const f = fixture(t);
  const other = path.join(f.root, 'other');
  repo(other);
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${other}\n`);
  fs.writeFileSync(path.join(other, '.doflow', 'state', 'upkeep-due'), '1\n');
  fs.utimesSync(path.join(other, '.doflow', 'state', 'upkeep-due'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
  clearCheckoutCache();
  const away = listProjects(opts(f, { cwd: f.plain })).body;
  assert.deepEqual(away.projects.map((p: any) => [p.label, p.current]), [['other', false], ['proj', false]], 'newest first when none is current');
  clearCheckoutCache();
  const here = listProjects(opts(f, { cwd: f.main })).body;
  assert.deepEqual(here.projects.map((p: any) => [p.label, p.current]), [['proj', true], ['other', false]]);
  assert.equal(here.projects[1].lastRecordAt, '2026-09-01T00:00:00.000Z');
});

test('projects: a label that fails the label rule is (withheld) (IC-019)', (t) => {
  const f = fixture(t);
  const odd = path.join(f.root, 'odd name #1');
  repo(odd);
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${odd}\n`);
  clearCheckoutCache();
  const labels = listProjects(opts(f)).body.projects.map((p: any) => p.label).sort();
  assert.deepEqual(labels, ['(withheld)', 'proj']);
});

test('projects: a torn meta.json is counted, a symlinked root is missing (IC-019)', (t) => {
  const f = fixture(t);
  metaDir(f, 'cccccccccccccccc', null, '{not json');
  fs.symlinkSync(f.main, path.join(f.root, 'link-to-proj'));
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${path.join(f.root, 'link-to-proj')}\n`);
  clearCheckoutCache();
  const { excluded, projects } = listProjects(opts(f)).body;
  assert.equal(projects.length, 1);
  assert.deepEqual(excluded, { missing: 2, temp: 1, notDoflow: 1, unreadable: 2 });
});

test('projects: no home gives store absent, no projects (IC-019)', (t) => {
  const f = fixture(t);
  const r = listProjects({ env: { PATH: process.env.PATH, HOME: 'relative-home' }, cwd: f.main, tempRoots: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { v: 1, store: 'absent', projects: [], excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false });
});

test('projects: git missing is cannot-list-projects, exit 1 (IC-019)', (t) => {
  const f = fixture(t);
  const exec = () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), status: null });
  clearCheckoutCache();
  assert.deepEqual(listProjects(opts(f, { exec })), { ok: false, error: 'cannot-list-projects' });
  const lines: string[] = [];
  const before = process.exitCode;
  const code = handleFleetCommand({ action: 'projects', json: true, flags: ['--action', '--json'], ...opts(f, { exec }), out: (l: string) => lines.push(l) });
  process.exitCode = before;
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, error: 'cannot-list-projects' });
});

test('projects: more than 2000 hook directories are cut and truncated is set (IC-019)', (t) => {
  const f = fixture(t);
  const base = path.join(f.config, 'doflow', 'session-env', 'projects');
  for (let i = 0; i < 2001; i += 1) fs.mkdirSync(path.join(base, `d${String(i).padStart(15, '0')}`));
  clearCheckoutCache();
  const { body } = listProjects(opts(f));
  assert.equal(body.truncated, true);
});

test('CLI: usage errors exit 2 and unknown flags are refused (IC-019)', (t) => {
  const f = fixture(t);
  for (const argv of [['fleet'], ['fleet', '--action', 'bogus'], ['fleet', '--action', 'projects', '--kind', 'review'], ['fleet', '--action', 'projects', '--bogus'], ['fleet', '--action']]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: f.main, env: env(f), encoding: 'utf8' });
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}${r.stdout}`);
  }
});

test('CLI: the shipped temp filter drops scratch roots and the text form shows no path (IC-019)', (t) => {
  const f = fixture(t);
  const json = spawnSync(process.execPath, [CLI, 'fleet', '--action', 'projects', '--json'], { cwd: f.main, env: env(f), encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.deepEqual(body.projects, [], 'every fixture lives under the temp folder');
  assert.deepEqual(body.excluded, { missing: 1, temp: 5, notDoflow: 0, unreadable: 1 }, 'main, its subdirectory, linked, scratch and plain candidates');
  const text = spawnSync(process.execPath, [CLI, 'fleet', '--action', 'projects'], { cwd: f.main, env: env(f), encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(!text.stdout.includes(f.root));
});

test('NO_UPKEEP holds fleet (IC-019, NFR-003)', () => {
  const set = SOURCE.match(/const NO_UPKEEP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'NO_UPKEEP is declared as a literal set');
  assert.ok(set[1].split(',').map((v: string) => v.trim().replace(/'/g, '')).includes('fleet'));
});

test('a read with upkeep due leaves project, user state and config home byte-identical (IC-019, NFR-003)', (t) => {
  const f = fixture(t);
  // Due: back-dated markers in the project and the user state, and a dead root upkeep would drop.
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  const before = treeSnapshot(f.root);
  for (const argv of [['--action', 'projects', '--json'], ['--action', 'projects']]) {
    const r = spawnSync(process.execPath, [CLI, 'fleet', ...argv], { cwd: f.main, env: env(f), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(treeSnapshot(f.root), before);
});
