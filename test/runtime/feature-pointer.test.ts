'use strict';

// Row 135 item 4: the runtime-written feature pointer (.doflow/state/feature.json), set by a feature
// start, replaced by a switch, dropped on finish, and read back by `lifecycle --action status`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures.ts');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const scratch = createScratch('doflow-fptr-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

const A = '046-alpha';
const B = '047-beta';
let counter = 0;

/** A repository on feat/<A> with the feature folders for A and B present. */
function newRepo() {
  const repo = makeRepo(scratch, `fptr-${(counter += 1)}`);
  repo.dir = fs.realpathSync(repo.dir);
  featureBranch(repo, A, 1);
  for (const slug of [A, B]) fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true });
  return repo;
}

function run(cwd: any, args: any) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const file = (repo: any) => path.join(repo.dir, '.doflow', 'state', 'feature.json');
const entries = (repo: any) => JSON.parse(fs.readFileSync(file(repo), 'utf8')).checkouts;
const init = (repo: any, slug: any) => run(repo.dir, ['lifecycle', '--action', 'init', '--slug', slug, '--json']);
const start = (repo: any, slug: any) => run(repo.dir, ['orchestrate', '--action', 'start', '--task-class', 'feature', '--task-id', slug, '--json']);
const status = (repo: any) => run(repo.dir, ['lifecycle', '--action', 'status', '--json']);

test('none: a checkout with no entry answers exit 0 and says so', () => {
  const repo = newRepo();
  const r = status(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.active.state, 'none');
  assert.equal(r.json.active.slug, null);
  assert.deepEqual(r.json.active.current, { branch: `feat/${A}`, slug: A });
  assert.equal(fs.existsSync(file(repo)), false, 'a read writes nothing');
});

test('start: lifecycle init writes the calling checkout entry and status agrees with the branch', () => {
  const repo = newRepo();
  assert.equal(init(repo, A).status, 0);
  const entry = entries(repo)[repo.dir];
  assert.deepEqual([entry.slug, entry.artifactDir, entry.branch, entry.taskId], [A, `agent-docs/doflow/${A}`, `feat/${A}`, null]);
  assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)));
  const r = status(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.active.state, r.json.active.slug, r.json.active.artifactDir, r.json.active.branch], ['agree', A, `agent-docs/doflow/${A}`, `feat/${A}`]);
  assert.equal(r.json.status, 'in-progress', 'a tracked feature also carries its derived status');
});

test('start: orchestrate start for a feature run writes the entry with the task id; other classes do not', () => {
  const repo = newRepo();
  const other = run(repo.dir, ['orchestrate', '--action', 'start', '--task-class', 'bug', '--task-id', 'fix-1', '--json']);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(fs.existsSync(file(repo)), false);
  const r = start(repo, A);
  assert.equal(r.status, 0, r.stderr);
  const entry = entries(repo)[repo.dir];
  assert.deepEqual([entry.slug, entry.taskId, entry.branch], [A, A, `feat/${A}`]);
});

test('switch: a later start of another slug overwrites the checkout entry', () => {
  const repo = newRepo();
  init(repo, A);
  assert.equal(init(repo, B).status, 0);
  const all = entries(repo);
  assert.deepEqual(Object.keys(all), [repo.dir]);
  assert.equal(all[repo.dir].slug, B);
});

test('finish: lifecycle merged clears the entry and the file goes when no entry is left', () => {
  const repo = newRepo();
  init(repo, A);
  assert.ok(fs.existsSync(file(repo)), 'recorded first');
  const merged = run(repo.dir, ['lifecycle', '--action', 'merged', '--slug', A, '--reason', 'merged by hand', '--json']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(fs.existsSync(file(repo)), false);
});

test('finish: a confirmed release clears every entry naming a shipped slug', () => {
  const repo = newRepo();
  init(repo, A);
  assert.ok(fs.existsSync(file(repo)), 'recorded first');
  repo.mergeNoFf(`feat/${A}`);
  repo.tag('v1.0.0');
  const released = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--feature', A, '--confirm', '--json']);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.equal(released.json.recorded, true);
  assert.deepEqual(released.json.added, [A]);
  assert.equal(fs.existsSync(file(repo)), false);
});

test('finish: a feature run that becomes COMPLETED clears its own entry only', () => {
  const repo = newRepo();
  start(repo, A);
  const runFile = path.join(repo.dir, '.doflow', 'state', 'orchestration', `${A}.json`);
  const journal = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  journal.program = [{ type: 'stage', id: 'last', status: 'pending' }];
  journal.cursor = 0;
  fs.writeFileSync(runFile, JSON.stringify(journal));
  // An entry for another checkout stays when this one completes.
  const pointer = JSON.parse(fs.readFileSync(file(repo), 'utf8'));
  pointer.checkouts['/elsewhere/other-checkout'] = { slug: B, artifactDir: null, branch: 'x', taskId: null, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file(repo), JSON.stringify(pointer));
  const done = run(repo.dir, ['orchestrate', '--action', 'complete-stage', '--task-id', A, '--stage', 'last', '--json']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.state, 'COMPLETED');
  assert.deepEqual(Object.keys(entries(repo)), ['/elsewhere/other-checkout']);
});

test('mismatch: a pointer recorded on another branch is reported with both sides, slug null, exit 1', () => {
  const repo = newRepo();
  init(repo, A);
  repo.checkout('develop');
  const r = status(repo);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.finding, 'feature-mismatch');
  assert.equal(r.json.active.state, 'mismatch');
  assert.equal(r.json.active.slug, null);
  assert.equal(r.json.active.pointer.slug, A);
  assert.equal(r.json.active.pointer.branch, `feat/${A}`);
  assert.equal(r.json.active.current.branch, 'develop');
  const text = run(repo.dir, ['lifecycle', '--action', 'status']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, new RegExp(`${A}.*feat/${A}.*develop`));
});

test('unreadable: corrupt JSON is exit 1 with the reason, and a record replaces it', () => {
  const repo = newRepo();
  fs.mkdirSync(path.dirname(file(repo)), { recursive: true });
  fs.writeFileSync(file(repo), '{not json');
  const r = status(repo);
  assert.equal(r.status, 1);
  assert.equal(r.json.finding, 'feature-pointer-unreadable');
  assert.equal(r.json.active.state, 'unreadable');
  assert.match(r.json.message, /not valid JSON/);
  assert.equal(init(repo, A).status, 0);
  assert.equal(entries(repo)[repo.dir].slug, A);
});

test('--slug keeps the per-feature status and ignores the pointer', () => {
  const repo = newRepo();
  init(repo, A);
  repo.checkout('develop');
  const r = run(repo.dir, ['lifecycle', '--action', 'status', '--slug', A, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slug, A);
  assert.equal(r.json.active, undefined);
});

test('a pointer write that fails never fails the verb', () => {
  const repo = newRepo();
  fs.mkdirSync(file(repo), { recursive: true }); // a directory where the file belongs: rename fails
  const r = init(repo, A);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /feature pointer not written/);
});
