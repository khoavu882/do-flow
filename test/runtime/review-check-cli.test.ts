'use strict';

// Feature 095 B.1 (IC-003): the `review --action check` verb through `bin/doflow.js` and the
// doflow-run dispatcher, in a scratch HOME and a scratch working directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'roadmap', 'findings', 'schema-1.json');

function scratch(t: any, { telemetry = false }: any = {}) {
  const dir = tempDir(t, 'doflow-review-check-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  if (telemetry) delete env.DOFLOW_TELEMETRY;
  const write = (name: any, record: any) => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), typeof record === 'string' ? record : JSON.stringify(record));
    return name;
  };
  const cli = (args: any) => spawnSync(process.execPath, [CLI, 'review', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dispatcher = (args: any) => spawnSync('/bin/bash', [RUN, 'review', ...args], { cwd, env, encoding: 'utf8' });
  const git = (args: any) => spawnSync('git', args, { cwd, env: gitEnv(env), encoding: 'utf8' });
  return { root: dir, cwd, env, write, cli, dispatcher, git };
}

// The test's own git calls never follow a GIT_DIR a test plants in the CLI env.
function gitEnv(env: any) {
  const copy: any = { ...env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE']) delete copy[key];
  return copy;
}

/** Every regular file under `root`, as relative path -> content. */
function snapshot(root: any, base: any = root, out: any = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) snapshot(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

function treeDiff(before: any, after: any) {
  return {
    added: Object.keys(after).filter((rel) => !(rel in before)).sort(),
    changed: Object.keys(after).filter((rel) => rel in before && before[rel] !== after[rel]).sort(),
    removed: Object.keys(before).filter((rel) => !(rel in after)).sort(),
  };
}

const record = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('a valid record by --path exits 0; --json parses with valid true and counts', (t) => {
  const s = scratch(t);
  s.write('review/findings.json', record());
  const res = s.cli(['--action', 'check', '--path', 'review/findings.json', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.counts.converged, 3);
  const text = s.cli(['--action', 'check', '--path', 'review/findings.json']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^review check: valid \(0 errors, \d+ advisories\)/);
});

test('the doflow-run dispatcher reaches the same verb', (t) => {
  const s = scratch(t);
  s.write('findings.json', record());
  const res = s.dispatcher(['--action', 'check', '--path', 'findings.json', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).valid, true);
});

test('an invalid record exits 1 with its errors and null counts', (t) => {
  const s = scratch(t);
  s.write('findings.json', { ...record(), schema: 2 });
  const res = s.cli(['--action', 'check', '--path', 'findings.json', '--json']);
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.valid, false);
  assert.ok(out.errors.includes('schema'), out.errors.join(', '));
  assert.equal(out.counts, null);
});

test('a missing record exits 1 with error missing', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'check', '--path', 'absent.json', '--json']);
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).errors, ['missing']);
});

test('usage exits 2: unknown action, both --slug and --path', (t) => {
  const s = scratch(t);
  s.write('findings.json', record());
  const unknown = s.cli(['--action', 'lint', '--path', 'findings.json', '--json']);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).error, 'usage');
  const both = s.cli(['--action', 'check', '--slug', '113-goal-order', '--path', 'findings.json', '--json']);
  assert.equal(both.status, 2, both.stderr);
  assert.equal(JSON.parse(both.stdout).error, 'usage');
});

test('095b IC-001: start refuses --path, check refuses --base, and the help names start (all exit 2 or 0, no prompt)', (t) => {
  const s = scratch(t);
  s.write('findings.json', record());
  const startPath = s.cli(['--action', 'start', '--path', 'findings.json', '--json']);
  assert.equal(startPath.status, 2, startPath.stderr);
  assert.equal(JSON.parse(startPath.stdout).error, 'usage');
  const checkBase = s.cli(['--action', 'check', '--path', 'findings.json', '--base', 'main', '--json']);
  assert.equal(checkBase.status, 2, checkBase.stderr);
  assert.equal(JSON.parse(checkBase.stdout).error, 'usage');
  const help = spawnSync(process.execPath, [CLI, '--help'], { cwd: s.cwd, env: s.env, encoding: 'utf8' });
  assert.match(help.stdout, /review --action start \[--slug <name>\] \[--base <ref>\] \[--json\]/);
});

test('a preExistingAt that is not an ancestor of reviewedHead exits 1 in a real repository', (t) => {
  const s = scratch(t);
  const commit = (text: any) => {
    fs.writeFileSync(path.join(s.cwd, 'tracked.txt'), text);
    assert.equal(s.git(['add', 'tracked.txt']).status, 0);
    assert.equal(s.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', text]).status, 0);
    return s.git(['rev-parse', 'HEAD']).stdout.trim();
  };
  assert.equal(s.git(['init', '-q']).status, 0);
  const first = commit('first');
  const second = commit('second');
  const data = record();
  data.reviewedHead = first;
  Object.assign(data.converged[0], { origin: 'pre-existing', preExistingAt: second });
  s.write('findings.json', data);
  const res = s.cli(['--action', 'check', '--path', 'findings.json', '--json']);
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).errors, [`preExistingAt-not-ancestor:${data.converged[0].id}`]);
  data.reviewedHead = second;
  data.converged[0].preExistingAt = first;
  s.write('findings.json', data);
  assert.equal(s.cli(['--action', 'check', '--path', 'findings.json', '--json']).status, 0);
});

test('with telemetry on, one review.run line lands in the project runs store', (t) => {
  const s = scratch(t, { telemetry: true });
  fs.mkdirSync(path.join(s.cwd, '.doflow', 'state', 'runs'), { recursive: true }); // telemetry never creates the ledger dir
  s.write('findings.json', record());
  const before = snapshot(s.root);
  const res = s.cli(['--action', 'check', '--path', 'findings.json', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const dir = path.join(s.cwd, '.doflow', 'state', 'runs', 'telemetry');
  const files = fs.readdirSync(dir).filter((name: any) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((line: any) => JSON.parse(line));
  assert.deepEqual(lines.map((line: any) => line.kind), ['review.run']);
  assert.equal(lines[0].errors, 0);
  // C-2: review runs no upkeep (no `.doflow/state/.gitignore`, `upkeep-due` or ledger line); the
  // whole scratch tree (HOME and the project) gains exactly the one telemetry partition.
  assert.deepEqual(treeDiff(before, snapshot(s.root)), {
    added: [path.join('work', '.doflow', 'state', 'runs', 'telemetry', files[0])], changed: [], removed: [],
  });
  // C-10: the persisted count fields equal the printed counts, every key.
  const { counts } = JSON.parse(res.stdout);
  assert.ok(Object.keys(counts).length > 0);
  for (const [key, value] of Object.entries(counts)) assert.deepEqual(lines[0][key], value, `persisted ${key}`);
});

test('C-6: a record with 200000 null seats is reported invalid, not crashed, with one telemetry line', (t) => {
  const s: any = scratch(t, { telemetry: true });
  delete s.env.DOFLOW_FAILURE_CAPTURE;
  fs.mkdirSync(path.join(s.cwd, '.doflow', 'state', 'runs'), { recursive: true });
  s.write('big.json', { ...record(), seats: Array(200000).fill(null) });
  const res = s.cli(['--action', 'check', '--path', 'big.json', '--json']);
  assert.equal(res.status, 1, res.stderr);
  assert.equal(JSON.parse(res.stdout).valid, false);
  const dir = path.join(s.cwd, '.doflow', 'state', 'runs', 'telemetry');
  const lines = fs.readdirSync(dir).flatMap((name: any) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, 'review.run');
  const failures = Object.keys(snapshot(s.root)).filter((rel) => rel.includes(`failures${path.sep}`));
  assert.deepEqual(failures, [], 'no failure capture was written');
});

test('C-8: an inherited GIT_DIR naming another repository does not redirect the ancestry check', (t) => {
  const s = scratch(t);
  const commit = (text: any) => {
    fs.writeFileSync(path.join(s.cwd, 'tracked.txt'), text);
    assert.equal(s.git(['add', 'tracked.txt']).status, 0);
    assert.equal(s.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', text]).status, 0);
    return s.git(['rev-parse', 'HEAD']).stdout.trim();
  };
  assert.equal(s.git(['init', '-q']).status, 0);
  const first = commit('first');
  const second = commit('second');
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  assert.equal(spawnSync('git', ['init', '-q', other], { env: s.env }).status, 0);
  const data = record();
  data.reviewedHead = first;
  Object.assign(data.converged[0], { origin: 'pre-existing', preExistingAt: second });
  s.write('review/findings.json', data);
  Object.assign(s.env, { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other });
  const res = s.cli(['--action', 'check', '--path', 'review/findings.json', '--json']);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).errors, [`preExistingAt-not-ancestor:${data.converged[0].id}`]);
});

test('C-9: --action with no value is a usage error, exit 2', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action']);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /--action requires a value/);
});
