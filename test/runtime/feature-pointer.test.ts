'use strict';

// Row 135 item 4: the runtime-written feature pointer (.doflow/state/feature/<id>.json, one file per checkout), set by a feature
// start, replaced by a switch, dropped on finish, and read back by `lifecycle --action status`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures.ts');
const pointer = require('../../src/runtime/feature-pointer.ts');

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
const file = (repo: any) => pointer.pointerFile(repo.dir, repo.dir);
const entry = (repo: any) => JSON.parse(fs.readFileSync(file(repo), 'utf8'));
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
  const e = entry(repo);
  assert.deepEqual([e.schema, e.checkout, e.slug, e.artifactDir, e.branch, e.taskId], [1, repo.dir, A, `agent-docs/doflow/${A}`, `feat/${A}`, null]);
  assert.ok(!Number.isNaN(Date.parse(e.updatedAt)));
  assert.match(path.basename(file(repo)), /^[0-9a-f]{16}\.json$/);
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
  const e = entry(repo);
  assert.deepEqual([e.slug, e.taskId, e.branch], [A, A, `feat/${A}`]);
});

test('switch: a later start of another slug overwrites the checkout entry', () => {
  const repo = newRepo();
  init(repo, A);
  assert.equal(init(repo, B).status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file(repo))), [path.basename(file(repo))]);
  assert.equal(entry(repo).slug, B);
});

test('finish: lifecycle merged removes the checkout file', () => {
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
  const other = pointer.pointerFile(repo.dir, '/elsewhere/other-checkout');
  fs.writeFileSync(other, JSON.stringify({ schema: 1, checkout: '/elsewhere/other-checkout', slug: B, artifactDir: null, branch: 'x', taskId: null, updatedAt: new Date().toISOString() }));
  const done = run(repo.dir, ['orchestrate', '--action', 'complete-stage', '--task-id', A, '--stage', 'last', '--json']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.state, 'COMPLETED');
  assert.deepEqual(fs.readdirSync(path.dirname(file(repo))), [path.basename(other)]);
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
  assert.equal(entry(repo).slug, A);
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

test('race: two checkouts recording interleaved both keep their entry', () => {
  const a = newRepo();
  const b = makeRepo(scratch, 'fptr-b');
  b.dir = fs.realpathSync(b.dir);
  featureBranch(b, B, 1);
  const real = fs.writeFileSync;
  let nested = false;
  // Checkout A has read the pointer state and is about to write it; checkout B records in that window.
  fs.writeFileSync = (...args: any[]) => {
    if (!nested) {
      nested = true;
      fs.writeFileSync = real;
      pointer.recordFeature({ storeRoot: a.dir, cwd: b.dir, slug: B });
    }
    return real(...args);
  };
  try { pointer.recordFeature({ storeRoot: a.dir, cwd: a.dir, slug: A }); } finally { fs.writeFileSync = real; }
  assert.equal(nested, true, 'the interleaving happened');
  assert.deepEqual(pointer.describeActive({ storeRoot: a.dir, cwd: a.dir }).slug, A);
  assert.deepEqual(pointer.describeActive({ storeRoot: a.dir, cwd: b.dir }).slug, B);
});

test('clear: a clear by slug removes every checkout naming it and leaves the others', () => {
  const a = newRepo();
  const b = makeRepo(scratch, 'fptr-c');
  b.dir = fs.realpathSync(b.dir);
  featureBranch(b, B, 1);
  pointer.recordFeature({ storeRoot: a.dir, cwd: a.dir, slug: A });
  pointer.recordFeature({ storeRoot: a.dir, cwd: b.dir, slug: B });
  pointer.clearSlug({ storeRoot: a.dir, slug: A });
  assert.equal(pointer.describeActive({ storeRoot: a.dir, cwd: a.dir }).state, 'none');
  assert.equal(pointer.describeActive({ storeRoot: a.dir, cwd: b.dir }).slug, B);
});

test('unreadable: another checkout\'s corrupt file does not disturb this checkout', () => {
  const repo = newRepo();
  init(repo, A);
  fs.writeFileSync(pointer.pointerFile(repo.dir, '/elsewhere/broken'), '{not json');
  const r = status(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.active.state, 'agree');
  assert.equal(init(repo, B).status, 0);
});

test('start: catch-up that begins a feature run records the pointer', () => {
  const repo = newRepo();
  const r = run(repo.dir, ['orchestrate', '--action', 'catch-up', '--task-class', 'feature', '--task-id', A, '--stage', 'discovery', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const e = entry(repo);
  assert.deepEqual([e.slug, e.taskId, e.branch], [A, A, `feat/${A}`]);
  // Catching up an existing run records nothing new: the entry is left as it is.
  fs.rmSync(file(repo));
  const again = run(repo.dir, ['orchestrate', '--action', 'catch-up', '--task-class', 'feature', '--task-id', A, '--stage', 'discovery', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.existsSync(file(repo)), false);
});
test('status: an agreeing pointer for a feature with no lifecycle tracking names it, never prints undefined', () => {
  const repo = newRepo();
  assert.equal(start(repo, A).status, 0);
  const json = status(repo);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.json.slug, A);
  assert.match(json.json.message, /tracked by its run only.*lifecycle --action init/);
  const text = run(repo.dir, ['lifecycle', '--action', 'status']);
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /undefined/);
  assert.match(text.stdout, new RegExp(`${A}.*tracked by its run only`));
});
