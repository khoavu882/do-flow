'use strict';
// readiness-record.test.js — every readiness evaluation is recorded where it ran, under the
// namespace evidence uses, and read back from this checkout or exactly one other.
//
// Repositories and worktrees are built under one scratch directory removed when the file finishes;
// the scratch environment is applied to this process, so the resolver and git spawned in-process
// never read the developer's HOME or global git config.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createScratch } = require('../helper/scratch-env');
const { writeReadinessRecord, readReadinessRecord } = require('../../src/runtime/readiness-record');
const { checkReadiness } = require('../../src/runtime/implementation-gate');
const { clearCheckoutCache } = require('../../src/runtime/checkouts');
const { clearTaskScopeCache } = require('../../src/runtime/task-scope');

const SLUG = '900-demo';
const NOW = new Date('2026-10-08T12:00:00.000Z');

let scratch;
before(() => {
  scratch = createScratch('doflow-readiness-record-');
  scratch.apply();
});
after(() => {
  scratch.restore();
  scratch.remove();
});

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

let n = 0;
function dir(name) {
  n += 1;
  const d = path.join(scratch.dir, `${n}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A repository on `feat/900-demo` whose feature folder has a decision register. */
function featureRepo(name, { register = true } = {}) {
  const root = dir(name);
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', `feat/${SLUG}`);
  const folder = path.join(root, 'agent-docs', 'doflow', SLUG);
  fs.mkdirSync(path.join(folder, 'decisions'), { recursive: true });
  if (register) fs.writeFileSync(path.join(folder, 'decisions', 'register.json'), '{"version":1,"slug":"900-demo","nextId":1,"decisions":[]}\n');
  return root;
}

function report(state = 'READY', taskClass = 'bug') {
  return {
    taskId: 'ignored', taskClass, templateName: 'Bug Fix', state,
    stageEntry: { decision: state === 'READY' ? 'ENTER' : 'GATHER_FIRST', reason: 'r' },
    requirements: [
      { id: 'reproduction', required: true, satisfied: state === 'READY' },
      { id: 'notes', required: false, satisfied: false },
    ],
    evidenceCount: 3,
  };
}

function write(stateRoot, taskId, fields = {}) {
  clearTaskScopeCache();
  return writeReadinessRecord({
    stateRoot, taskId, report: report(), inputs: {}, mode: 'workflow', now: NOW, ...fields,
  });
}

function rawRecord(stateRoot, rel, value) {
  const file = path.join(stateRoot, '.doflow', 'state', 'readiness', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('a written record holds every field and only the inputs the caller stated', () => {
  const root = dir('plain');
  const { file, record } = write(root, 'T-1', { inputs: { verificationPlan: 'npm test', scope: 'src/a.js' }, declaredScope: ['src/a.js'], mode: 'standalone' });
  assert.equal(file, path.join(root, '.doflow', 'state', 'readiness', 'T-1.json'));
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), [
    'declaredScope', 'evaluatedAt', 'evidenceCount', 'executionMode', 'inputs', 'revision', 'slug', 'stageEntry',
    'state', 'taskClass', 'taskId', 'templateName', 'unmet', 'version',
  ]);
  assert.deepEqual({ ...disk, revision: undefined }, { ...record, revision: undefined });
  assert.equal(disk.version, 1);
  assert.equal(disk.taskId, 'T-1');
  assert.equal(disk.slug, null);
  assert.equal(disk.taskClass, 'bug');
  assert.equal(disk.templateName, 'Bug Fix');
  assert.equal(disk.state, 'READY');
  assert.equal(disk.stageEntry, 'ENTER');
  assert.equal(disk.executionMode, 'standalone');
  assert.deepEqual(disk.inputs, { verificationPlan: 'npm test', scope: 'src/a.js' });
  assert.deepEqual(disk.declaredScope, ['src/a.js']);
  assert.deepEqual(disk.unmet, []);
  assert.equal(disk.evidenceCount, 3);
  assert.equal(disk.evaluatedAt, NOW.toISOString());

  const unmet = write(root, 'T-2', { report: report('NEEDS_EVIDENCE'), inputs: {} }).record;
  assert.deepEqual(unmet.unmet, ['reproduction'], 'only required, unsatisfied requirements');
  assert.deepEqual(unmet.inputs, {});
  assert.equal(unmet.declaredScope, null);
});

test('a feature with a register namespaces a task id that differs from its slug', () => {
  const root = featureRepo('ns');
  assert.equal(write(root, 'A.1').file, path.join(root, '.doflow', 'state', 'readiness', SLUG, 'A.1.json'));
  assert.equal(write(root, 'A.1').record.slug, SLUG);
  assert.equal(write(root, SLUG).file, path.join(root, '.doflow', 'state', 'readiness', `${SLUG}.json`), 'the feature-level id stays flat');
  const flat = featureRepo('no-register', { register: false });
  assert.equal(write(flat, 'A.1').file, path.join(flat, '.doflow', 'state', 'readiness', 'A.1.json'), 'no register, no namespace');
});

test('a second evaluation replaces the first', () => {
  const root = dir('replace');
  write(root, 'T-1', { report: report('NEEDS_EVIDENCE') });
  write(root, 'T-1', { report: report('READY'), now: new Date(NOW.getTime() + 1000) });
  const read = readReadinessRecord({ stateRoot: root, taskId: 'T-1' });
  assert.equal(read.status, 'found');
  assert.equal(read.origin, 'current');
  assert.equal(read.record.state, 'READY');
  assert.equal(read.record.evaluatedAt, new Date(NOW.getTime() + 1000).toISOString());
  assert.equal(read.record.revision, 2);
});

test('a record in another checkout is found from a linked worktree, flat and namespaced', () => {
  const m = featureRepo('cross');
  const wt = path.join(path.dirname(m), `${path.basename(m)}-wt`);
  git(m, 'worktree', 'add', '-q', '-b', 'feat/other', wt);
  clearCheckoutCache();
  write(m, SLUG);
  write(m, 'A.1');

  const flat = readReadinessRecord({ stateRoot: wt, taskId: SLUG });
  assert.equal(flat.status, 'found');
  assert.equal(flat.origin, 'other');
  assert.equal(flat.file, path.join(m, '.doflow', 'state', 'readiness', `${SLUG}.json`));

  const namespaced = readReadinessRecord({ stateRoot: wt, taskId: 'A.1', slug: SLUG });
  assert.equal(namespaced.status, 'found');
  assert.equal(namespaced.file, path.join(m, '.doflow', 'state', 'readiness', SLUG, 'A.1.json'));
  assert.equal(readReadinessRecord({ stateRoot: wt, taskId: 'A.1' }).status, 'missing', 'without the slug the flat path is read');

  const check = checkReadiness({ stateRoot: wt, taskId: SLUG, template: 'bug', now: NOW });
  assert.equal(check.ok, true);
  assert.equal(check.code, 'ready');
  assert.equal(check.origin, 'other');
});

test('records in two other checkouts are ambiguous, and neither is picked', () => {
  const m = featureRepo('ambiguous');
  const wt1 = `${m}-wt1`;
  const wt2 = `${m}-wt2`;
  git(m, 'worktree', 'add', '-q', '-b', 'feat/one', wt1);
  git(m, 'worktree', 'add', '-q', '-b', 'feat/two', wt2);
  clearCheckoutCache();
  write(wt1, 'T-3');
  write(wt2, 'T-3');
  const read = readReadinessRecord({ stateRoot: m, taskId: 'T-3' });
  assert.equal(read.status, 'ambiguous');
  assert.equal(read.record, null);
  assert.deepEqual(read.candidates, [path.join(wt1, '.doflow', 'state', 'readiness', 'T-3.json'), path.join(wt2, '.doflow', 'state', 'readiness', 'T-3.json')]);
  const check = checkReadiness({ stateRoot: m, taskId: 'T-3', template: 'bug', now: NOW });
  assert.equal(check.ok, false);
  assert.equal(check.code, 'ambiguous');
});

test('a record from a future version, bad JSON, a missing state or a time after now is unusable, never READY', () => {
  const root = dir('unusable');
  const good = { version: 1, taskId: 'U', taskClass: 'bug', state: 'READY', evaluatedAt: NOW.toISOString() };
  const cases = [
    ['version 2', { ...good, version: 2 }, /version 2/],
    ['bad JSON', '{"version":1,', /unparsable JSON/],
    ['no state', { ...good, state: undefined }, /no state/],
    ['no taskClass', { ...good, taskClass: undefined }, /no taskClass/],
    ['after now', { ...good, evaluatedAt: new Date(NOW.getTime() + 60000).toISOString() }, /after this check/],
  ];
  for (const [label, value, detail] of cases) {
    rawRecord(root, 'U.json', value);
    const check = checkReadiness({ stateRoot: root, taskId: 'U', template: 'bug', now: NOW });
    assert.equal(check.code, 'unusable', label);
    assert.equal(check.ok, false, label);
    assert.match(check.detail, detail, label);
    assert.match(check.message, /has a readiness record that cannot be used/, label);
  }
  rawRecord(root, 'U.json', good);
  assert.equal(checkReadiness({ stateRoot: root, taskId: 'U', template: 'bug', now: NOW }).code, 'ready', 'a record made at the check time counts');
  rawRecord(root, 'U.json', { ...good, state: 'NEEDS_EVIDENCE' });
  assert.equal(checkReadiness({ stateRoot: root, taskId: 'U', template: 'bug', now: NOW }).code, 'not-ready');
  rawRecord(root, 'U.json', good);
  assert.equal(checkReadiness({ stateRoot: root, taskId: 'U', template: 'feature', now: NOW }).code, 'wrong-template');
  assert.equal(checkReadiness({ stateRoot: root, taskId: 'none', template: 'bug', now: NOW }).code, 'missing');
});
