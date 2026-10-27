'use strict';
const { bashPath } = require('../helper/bash-locator.ts');
// register-followups.shared.js — scratch repositories, the dispatcher runner and the v1.12.0 comparison helpers the
// register-followups e2e files share (feature 045). Not a test file. HOME is redirected to a scratch directory and
// DOFLOW_CONFIG_DIR points into each scratch repo; the shared temp helper removes the scratch at process exit.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { IS_WIN } = require('../helper-platform.ts');
const { suiteTempDir } = require('../helper/tmp.ts');


const REPO = path.resolve(__dirname, '../..');
const DOFLOW_RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

const SCRATCH = suiteTempDir('doflow-register-followups-e2e-');
const HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME, { recursive: true });
// TMPDIR is SCRATCH, and the CLI's compile cache (bin/doflow.js, 073 D5) defaults to <TMPDIR>/node-compile-cache.
// Keep it in a sibling temp dir so SCRATCH listings ("nothing written beside the repo") stay exact; the cache stays on.
const COMPILE_CACHE = suiteTempDir('doflow-register-followups-cc-');

const SKIP = IS_WIN ? 'doflow-run is a bash script' : false;
let repoCounter = 0;

/** A minimal, explicit environment: no inherited DOFLOW_CLI, GIT_* or provider keys. */
function baseEnv() {
  return {
    PATH: process.env.PATH, HOME, USERPROFILE: HOME, TMPDIR: SCRATCH, NODE_COMPILE_CACHE: COMPILE_CACHE,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function git(cwd: any, ...args: any[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A scratch repo on `base` with `.doflow/` ignored (the runtime journals there) and one commit,
 * then branch `branch` checked out. Files in `seed` are committed on the base. */
function makeRepo({ base = 'main', branch = null, seed = {} } = {}) {
  const repo = path.join(SCRATCH, `repo-${repoCounter++}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', base);
  writeFiles(repo, { '.gitignore': '.doflow/\n', ...seed });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  if (branch) git(repo, 'checkout', '-q', '-b', branch);
  return repo;
}

/** Runs doflow-run with cwd = the scratch repo. Parses stdout as JSON when it is. */
function run(repo: any, args: any, { input }: any = {}) {
  const r = spawnSync(bashPath(), [DOFLOW_RUN, ...args], {
    cwd: repo, env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') },
    input: input ?? '', encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const decision = (repo: any, args: any, opts?: any) => run(repo, ['decision', ...args, '--json'], opts);

function writeFiles(dir: any, files: any) {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

const read = (file: any) => fs.readFileSync(file, 'utf8');
const featureDir = (repo: any, slug: any) => path.join(repo, 'agent-docs', 'doflow', slug);

function initRegister(repo: any, slug: any) {
  const res = run(repo, ['decision', '--action', 'init', '--slug', slug, '--json']);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  return res;
}

/** Adds decisions through one batch file; returns the CLI result. */
function addBatch(repo: any, name: any, items: any) {
  const file = path.join(SCRATCH, `${name}-${repoCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify(items.map((i: any) => ({
    channel: 'question', stage: 'design', rationale: `because ${i.topic}`, supersedes: [], refs: [],
    source: `intention/q.md#${i.topic}`, ...i,
  }))));
  return decision(repo, ['--action', 'add', '--batch', file]);
}

/** Whether this clone has the v1.12.0 tag to compare against. */
function hasTag(tag: any) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: REPO }).status === 0;
}

/**
 * Gate for a comparison against a tagged release. With the tag it returns true. Without it, CI fails
 * (the workflow fetches full history, so a missing tag there means the comparison silently stopped
 * running), and a local run marks the test skipped with the reason instead of passing quietly.
 */
function haveTagOrSkip(t: any, tag: any) {
  if (hasTag(tag)) return true;
  const reason = `the ${tag} tag is absent from this clone, so the comparison against it did not run (git fetch --tags)`;
  if (process.env.CI) assert.fail(reason);
  t.skip(reason);
  return false;
}

function gitShow(rev: any, file: any) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

const squash = (text: any) => text.replace(/\s+/g, ' ');

const HISTORY = '## 9. History\n\n- 2026-10-01 a\n- 2026-10-02 b\n';

/** Output of v1.12.0's validator on the repo's active feature: its script, beside the current resolver. */
function v1120Validate(repo: any) {
  const dir = path.join(SCRATCH, `v1120-${repoCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const bash = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');
  fs.writeFileSync(path.join(dir, 'validate-artifacts.sh'),
    gitShow('v1.12.0', 'core/shared/scripts/doflow/bash/validate-artifacts.sh'));
  fs.copyFileSync(path.join(bash, 'do-paths.sh'), path.join(dir, 'do-paths.sh'));
  const r = spawnSync(bashPath(), [path.join(dir, 'validate-artifacts.sh'), '--json'], {
    cwd: repo, env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') }, encoding: 'utf8',
  });
  return r.stdout;
}

module.exports = {
  REPO, DOFLOW_RUN, SCRATCH, HOME, SKIP, IS_WIN, baseEnv, git, makeRepo, run, decision, writeFiles, read, featureDir, initRegister, addBatch, hasTag, haveTagOrSkip, gitShow, squash, HISTORY, v1120Validate,
};
