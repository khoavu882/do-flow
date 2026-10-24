'use strict';
// feature-root.test.js — feature 115 (FR-011, IC-004 render-audit half, IC-005): `paths --json` names the
// checkout that holds the feature folder, render-audit writes audit.md there and reads the orchestration
// record from the main checkout, and the `decision` verb resolves its folder through the same key.
// Scratch HOME, throwaway git repos: a main checkout and linked worktrees made with `git worktree add`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const BASH = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');
const PATHS = path.join(BASH, 'do-paths.sh');
const RENDER_AUDIT = path.join(BASH, 'render-audit.sh');
const DOFLOW_RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

const SCRATCH = suiteTempDir('doflow-feature-root-');
const HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME, { recursive: true });
let counter = 0;

function env(extra: any = {}) {
  return {
    PATH: process.env.PATH, HOME, USERPROFILE: HOME, TMPDIR: SCRATCH,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra,
  };
}

function scratchDir(prefix: any) {
  const dir = path.join(SCRATCH, `${prefix}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function git(cwd: any, ...args: any[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A main checkout on `main` plus a linked worktree on feat/<slug>. Returns { main, wt, slug, rel }. */
function makeTree(slug: any = '115-scratch') {
  const main = scratchDir('main');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(SCRATCH, `wt-${counter++}`);
  git(main, 'worktree', 'add', '-q', '-b', `feat/${slug}`, wt);
  return { main, wt: fs.realpathSync(wt), slug, rel: path.join('agent-docs', 'doflow', slug) };
}

function paths(cwd: any, ...args: any[]) {
  const r = spawnSync('bash', [PATHS, '--json', ...args], { cwd, encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function mkFolder(root: any, rel: any, withRequirement: any = false) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (withRequirement) {
    fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# r\n');
  }
  return dir;
}

function runDoflow(cwd: any, args: any) {
  const r = spawnSync('bash', [DOFLOW_RUN, ...args], {
    cwd, encoding: 'utf8', input: '',
    env: env({ DOFLOW_CONFIG_DIR: path.join(cwd, '.doflow') }),
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const JOURNAL = (slug: any) => JSON.stringify({
  version: 1, taskId: slug, taskClass: 'feature', state: 'RUNNING',
  history: [{ at: '2026-10-19T01:00:00.000Z', action: 'start', detail: 'task-class=feature' }],
});

function writeJournal(root: any, slug: any) {
  const dir = path.join(root, '.doflow', 'state', 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JOURNAL(slug));
}

// ── paths --json ───────────────────────────────────────────────────────────────────────────────

test('folder only in main: feature_root is the main checkout and repo_root stays the worktree', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  const out = paths(t.wt);
  assert.equal(out.feature_root, t.main);
  assert.equal(out.repo_root, t.wt);
  assert.equal(out.feature_dir, t.rel);
});

test('folder in both: feature_root is the worktree', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  mkFolder(t.wt, t.rel);
  assert.equal(paths(t.wt).feature_root, t.wt);
});

test('folder in neither (a new feature): feature_root is the worktree', () => {
  const t = makeTree();
  assert.equal(paths(t.wt).feature_root, t.wt);
});

test('the main checkout itself, a slug that names no feature, no slug and a non-git dir give repo_root', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  assert.equal(paths(t.main, `--slug=${t.slug}`).feature_root, t.main);
  assert.equal(paths(t.wt, '--slug=999-nothing').feature_root, t.wt);
  const trunk = paths(t.main);
  assert.equal(trunk.feature_slug, null);
  assert.equal(trunk.feature_root, t.main);
  const plain = scratchDir('plain');
  const out = paths(plain);
  assert.equal(out.is_git_repo, false);
  assert.equal(out.feature_root, plain);
});

test('a DoFlow sandbox (.doflow-worktree-base at its root) never reads the main checkout', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  fs.writeFileSync(path.join(t.wt, '.doflow-worktree-base'), 'x\n');
  assert.equal(paths(t.wt).feature_root, t.wt);
});

test('every other key is unchanged: only feature_root and the artifact flags that follow it differ', () => {
  const t = makeTree();
  const neither = paths(t.wt);
  mkFolder(t.main, t.rel); // an empty folder in main: no artifact for any flag to follow
  const emptyInMain = paths(t.wt);
  const { feature_root: a, ...restNeither } = neither;
  const { feature_root: b, ...restEmpty } = emptyInMain;
  assert.equal(a, t.wt);
  assert.equal(b, t.main);
  assert.deepEqual(restEmpty, restNeither);
  assert.ok(Object.keys(neither).includes('feature_root'));
});

test('layout, has_* flags and question-round counters follow feature_root; path strings stay repo-relative', () => {
  const t = makeTree();
  const before = paths(t.wt);
  assert.equal(before.has_requirement, false);
  assert.equal(before.layout, 'legacy');
  const dir = mkFolder(t.main, t.rel, true);
  fs.writeFileSync(path.join(dir, 'intention', 'brainstorm-1-question.md'), 'q\n');
  fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{}\n');
  const after = paths(t.wt);
  assert.equal(after.feature_root, t.main);
  assert.equal(after.layout, 'structured');
  assert.equal(after.has_requirement, true);
  assert.equal(after.has_decisions, true);
  assert.equal(after.intention_next_round, 2);
  assert.equal(after.requirement, `${t.rel}/intention/requirement.md`);
  assert.equal(after.decisions_register, `${t.rel}/decisions/register.json`);
  assert.equal(after.repo_root, t.wt);
});

// ── decision verb ──────────────────────────────────────────────────────────────────────────────

test('decision --action init from a worktree whose folder exists only in main writes under main and creates no folder in the worktree', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  const res = runDoflow(t.wt, ['decision', '--action', 'init', '--json']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.ok(fs.existsSync(path.join(t.main, t.rel, 'decisions', 'register.json')), 'register under main');
  assert.equal(fs.existsSync(path.join(t.wt, 'agent-docs')), false, 'no agent-docs created in the worktree');
});

test('decision --action init in a worktree that has its own folder still writes there', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  mkFolder(t.wt, t.rel);
  const res = runDoflow(t.wt, ['decision', '--action', 'init', '--json']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.ok(fs.existsSync(path.join(t.wt, t.rel, 'decisions', 'register.json')));
  assert.equal(fs.existsSync(path.join(t.main, t.rel, 'decisions', 'register.json')), false);
});

// ── render-audit ───────────────────────────────────────────────────────────────────────────────

function renderAudit(cwd: any, slug: any) {
  const r = spawnSync('bash', [RENDER_AUDIT, '--json', `--slug=${slug}`], { cwd, encoding: 'utf8', env: env() });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted by the caller */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('render-audit from a worktree reads main\'s orchestration record and writes audit.md in main\'s folder', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  writeJournal(t.main, t.slug);
  const res = renderAudit(t.wt, t.slug);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(res.json.written, true, res.stdout);
  const audit = path.join(t.main, t.rel, 'audit.md');
  assert.ok(fs.existsSync(audit), 'audit.md in main');
  assert.match(fs.readFileSync(audit, 'utf8'), /task-class=feature/);
  assert.equal(fs.existsSync(path.join(t.wt, 'agent-docs')), false, 'nothing written in the worktree');
});

test('negative control: a worktree with its own folder still gets its own audit.md, from its own record when main has none', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  mkFolder(t.wt, t.rel);
  writeJournal(t.wt, t.slug);
  const res = renderAudit(t.wt, t.slug);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(res.json.written, true, res.stdout);
  assert.ok(fs.existsSync(path.join(t.wt, t.rel, 'audit.md')), 'audit.md in the worktree');
  assert.equal(fs.existsSync(path.join(t.main, t.rel, 'audit.md')), false, 'main untouched');
});

test('render-audit in a plain checkout is unchanged: its own record, its own folder', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  writeJournal(t.main, t.slug);
  const res = renderAudit(t.main, t.slug);
  assert.equal(res.json.written, true, res.stdout);
  assert.ok(fs.existsSync(path.join(t.main, t.rel, 'audit.md')));
});

test('render-audit reports no run when neither checkout holds a record', () => {
  const t = makeTree();
  mkFolder(t.main, t.rel);
  const res = renderAudit(t.wt, t.slug);
  assert.equal(res.status, 0);
  assert.equal(res.json.written, false);
  assert.equal(fs.existsSync(path.join(t.main, t.rel, 'audit.md')), false);
});
