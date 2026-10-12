'use strict';
// lifecycle-loop.shared.js — the dispatcher runner, scratch repositories and fault preload the
// lifecycle-loop e2e test files share (feature 046). Not a test file. Every spawn runs under a scratch
// HOME and XDG_CONFIG_HOME with no global git config (DEC-041); each test file removes its own scratch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { suiteTempDir, tempDir } = require('../helper/tmp');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures');
const { IS_WIN } = require('../helper-platform');


const REPO = path.resolve(__dirname, '..', '..');
const RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SKIP = IS_WIN ? 'doflow-run is a bash script' : false;

const scratch = createScratch('doflow-loop-e2e-');


const CONFIG = path.join(scratch.dir, 'config');
const PRELOAD = path.join(scratch.dir, 'fault-preload.js');
let counter = 0;
const unique = (name) => `${name}-${(counter += 1)}`;

// The fault is injected into the real Node CLI by a preload in NODE_OPTIONS, which the dispatcher's
// own `node` child inherits: the same approach test/e2e/failure-capture-cli.test.js takes with
// `--require`. It replaces one function a verb calls, so the verb dies of an internal TypeError.
fs.writeFileSync(PRELOAD, `'use strict';
const path = require('node:path');
const spec = JSON.parse(process.env.DOFLOW_FAULT || 'null');
if (spec) {
  const mod = require(path.join(${JSON.stringify(REPO)}, spec.module));
  const fail = function injected() { throw new TypeError('injected "secret value" at attempt 42'); };
  if (spec.cls) mod[spec.cls].prototype[spec.method] = fail; else mod[spec.method] = fail;
}
`);
const FAULT_READINESS = { module: 'src/runtime/readiness.js', method: 'evaluateTaskReadiness' };
const FAULT_WORKFLOW = { module: 'src/runtime/workflow-engine.ts', cls: 'WorkflowEngine', method: 'resolveWorkflow' };
const READINESS_ARGS = ['readiness', '--task-class', 'feature', '--task-id', 't1', '--json'];
const WORKFLOW_ARGS = ['workflow', '--task-class', 'feature', '--json'];

/** Runs the dispatcher in `cwd`. `xdg` gives a run its own machine-wide failure home. */
function rt(cwd, args, { env = {}, xdg = scratch.xdg, input = '' } = {}) {
  const result = spawnSync('bash', [RUN, ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: scratch.env({
      XDG_CONFIG_HOME: xdg, DOFLOW_CONFIG_DIR: CONFIG,
      DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '', DOFLOW_FAULT: '', NODE_OPTIONS: '',
      ...env,
    }),
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* human output */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/** `rt` that requires exit 0 and a JSON answer. */
function ok(cwd, args, options) {
  const r = rt(cwd, [...args, '--json'], options);
  assert.equal(r.status, 0, `${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.json, `${args.join(' ')} printed no JSON: ${r.stdout}`);
  return r.json;
}

function eventsOf(repo) {
  const dir = path.join(repo.dir, '.doflow', 'state', 'lifecycle', 'events');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).sort().map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
    : [];
}

function newProject(name) {
  const repo = makeRepo(scratch, unique(name));
  repo.dir = fs.realpathSync(repo.dir);
  return repo;
}

function folder(repo, slug) { fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true }); }

/** Creates the feature folder and tracks it through the verb; returns the tracking event's instant. */
function track(repo, slug, extra = []) {
  folder(repo, slug);
  const out = ok(repo.dir, ['lifecycle', '--action', 'init', '--slug', slug, ...extra]);
  assert.equal(out.tracked, 'new');
  return eventsOf(repo).find((e) => e.type === 'feature.tracked' && e.data.slug === slug).at;
}

/** Moves the fixture clock ten minutes past the newest instant given, so later commits count as after tracking. */
function after10(repo, ...instants) {
  repo.at(new Date(Math.max(...instants.map((i) => Date.parse(i))) + 10 * 60000).toISOString());
}

/** A feature branch with one commit, merged into develop with a merge commit; develop is left checked out. */
function mergeFeature(repo, slug) {
  const branch = featureBranch(repo, slug, 1);
  repo.mergeNoFf(branch);
  return branch;
}

function addFollowups(repo, slug, statements, stage = 'review') {
  const file = path.join(scratch.dir, `${unique('batch')}.json`);
  fs.writeFileSync(file, JSON.stringify(statements.map((statement) => ({ statement, stage, source: 'stage' }))));
  return ok(repo.dir, ['followup', '--action', 'add', '--slug', slug, '--stage', stage, '--batch', file]).created;
}

const listFollowups = (repo, state = 'open') => ok(repo.dir, ['followup', '--action', 'list', '--state', state]).items;

/** What git and the working tree held before a verb, so a later check can prove nothing was committed, staged or ignored. */
function gitSnapshot(repo) {
  const exclude = path.join(repo.dir, '.git', 'info', 'exclude');
  return {
    head: repo.git('rev-parse', 'HEAD'),
    refs: repo.git('for-each-ref'),
    exclude: fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null,
    ignoreFiles: ['.gitignore', '.gitattributes'].filter((f) => fs.existsSync(path.join(repo.dir, f))),
  };
}

function assertGitUntouched(repo, before) {
  const now = gitSnapshot(repo);
  assert.equal(now.head, before.head, 'no commit was made');
  assert.equal(now.refs, before.refs, 'no branch or tag was created or moved');
  assert.equal(repo.git('diff', '--cached', '--name-only'), '', 'nothing is staged');
  assert.equal(now.exclude, before.exclude, '.git/info/exclude is untouched');
  assert.deepEqual(now.ignoreFiles, before.ignoreFiles, 'no .gitignore or .gitattributes was written');
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !f.startsWith('.git')).sort();

module.exports = {
  REPO, RUN, SKIP, IS_WIN, scratch, CONFIG, PRELOAD, unique, FAULT_READINESS, FAULT_WORKFLOW, READINESS_ARGS, WORKFLOW_ARGS, rt, ok, eventsOf, newProject, folder, track, after10, mergeFeature, addFollowups, listFollowups, gitSnapshot, assertGitUntouched, tree, makeRepo, featureBranch, suiteTempDir, tempDir,
};
