'use strict';

// Followup FU-t622ad (IC-008 as amended): the project root a grants file must not lie in is the detected project
// (the nearest directory holding `.git` or a `.doflow/` directory, the account home and its ancestors skipped), never
// the working directory. Run from a scratch HOME that is in no project, the person's grants file counts; the same file
// inside a detected project still grants nothing. The CLI cases run `bin/doflow.js` with HOME, XDG_CONFIG_HOME and the
// child's TMPDIR all scratch: TMPDIR is a sibling of the scratch HOME, so the grants file is not in the child's temp dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { detectedProjectRoot } = require('../../src/runtime/packages/grants.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const NEXT_MAJOR = Number(VERSION.split('.')[0]) + 1;

/** A skill package (instruction tier, so it needs a trust line) at `dir`. */
function writePackage(dir: any) {
  fs.mkdirSync(path.join(dir, 'skills', 'acme-triage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'acme-triage', 'SKILL.md'), '---\nname: acme-triage\ndescription: Triage incoming reports for the acme team\n---\n\n# Triage\n\nSort the reports by severity.\n');
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), `${JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'acme triage skill', doflow: `>=${VERSION} <${NEXT_MAJOR}.0.0`,
    contributions: [{ point: 'skill', version: 1, id: 'triage', dir: 'skills/acme-triage' }],
  }, null, 2)}\n`);
  return dir;
}

/** The person's machine: `home`, `xdg` (the config home), `cwd`, and a scratch TMPDIR for the child; `pkg` runs one verb. */
function machine(root: any, options: { home: string; xdg: string; cwd: string }) {
  const { home, xdg, cwd } = options;
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, xdg, cwd, tmp]) fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_') || key === 'PI_CODING_AGENT_DIR') delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, TMPDIR: tmp, DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  });
  const pkg = (...args: any[]) => spawnSync(process.execPath, [CLI, 'package', '--action', ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  const json = (result: any) => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  /** add (plan, apply), the person appends the printed trust line, enable; returns `list --json` (`status`, `view`). */
  const addTrustEnable = (source: any) => {
    const { plan } = json(pkg('add', '--source', source, '--json'));
    const applied = pkg('add', '--plan', plan.planId);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const grants = path.join(xdg, 'doflow', 'packages', 'grants.jsonl');
    fs.mkdirSync(path.dirname(grants), { recursive: true });
    fs.appendFileSync(grants, `${plan.grantLines.trust}\n`);
    const enabled = pkg('enable', '--id', 'acme');
    assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
    const listed = pkg('list', '--json');
    return { status: listed.status, view: JSON.parse(listed.stdout) };
  };
  return { addTrustEnable };
}

test('from a scratch HOME in no project, the person\'s grants file counts: the trusted skill package is active', (t) => {
  const root = tempDir(t, 'doflow-trustroot-');
  const home = path.join(root, 'home');
  const m = machine(root, { home, xdg: path.join(home, '.config'), cwd: home });
  const { status, view } = m.addTrustEnable(writePackage(path.join(root, 'acme')));
  assert.ok(fs.statSync(path.join(home, '.doflow')).isDirectory(), 'the home holds .doflow/, which is the global scope, not a project');
  const acme = view.packages.find((p: any) => p.id === 'acme');
  assert.deepEqual([acme.state, acme.reasons], ['active', []], JSON.stringify(acme));
  assert.equal(view.findings.some((f: any) => f.reason === 'grants-file-location'), false, JSON.stringify(view.findings));
  assert.equal(status, 0, 'every package is healthy and no finding is an error');
});

test('the same grants file inside a detected project grants nothing: grants-file-location, the package is not active', (t) => {
  const root = tempDir(t, 'doflow-trustroot-proj-');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const m = machine(root, { home: path.join(root, 'home'), xdg: path.join(project, '.config'), cwd: project });
  const { status, view } = m.addTrustEnable(writePackage(path.join(root, 'acme')));
  assert.equal(status, 1, 'a package that needs trust is unhealthy');
  const acme = view.packages.find((p: any) => p.id === 'acme');
  assert.deepEqual([acme.state, acme.reasons], ['needs-trust', ['grant-missing']], JSON.stringify(acme));
  assert.ok(view.findings.some((f: any) => f.code === 'grant-invalid' && f.reason === 'grants-file-location'), JSON.stringify(view.findings));
});

test('detectedProjectRoot: .git dir, .git file, .doflow/ dir, a nested subdir, the account home and an unmarked dir', (t) => {
  const root = tempDir(t, 'doflow-trustroot-detect-');
  const home = path.join(root, 'home');
  const dir = (...parts: any[]) => { const p = path.join(root, ...parts); fs.mkdirSync(p, { recursive: true }); return p; };
  dir('repo', '.git');
  const gitDir = path.join(root, 'repo');
  const worktree = dir('linked');
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
  dir('dofl', '.doflow');
  const doflow = path.join(root, 'dofl');
  const nested = dir('repo', 'a', 'b', 'c');
  dir('home', '.doflow');
  dir('home', 'work', 'plain');
  const notADir = dir('file-marker');
  fs.writeFileSync(path.join(notADir, '.doflow'), 'not a directory\n');
  const detect = (cwd: any) => detectedProjectRoot({ cwd, homeDir: home, fsImpl: fs });
  assert.equal(detect(gitDir), gitDir, '.git directory');
  assert.equal(detect(worktree), worktree, '.git file (a linked worktree)');
  assert.equal(detect(doflow), doflow, '.doflow/ directory');
  assert.equal(detect(nested), gitDir, 'a nested subdirectory finds the ancestor');
  assert.equal(detect(home), null, 'the account home, holding .doflow/, is the global scope and no project');
  assert.equal(detect(path.join(home, 'work', 'plain')), null, 'an unmarked directory under the home has no project');
  assert.equal(detect(notADir), null, 'a .doflow file is no project marker');
  assert.equal(detect(root), null, 'an ancestor of the home is no project');
});
