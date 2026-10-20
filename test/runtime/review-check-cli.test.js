'use strict';

// Feature 095 B.1 (IC-003): the `review --action check` verb through `bin/doflow.js` and the
// doflow-run dispatcher, in a scratch HOME and a scratch working directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'roadmap', 'findings', 'schema-1.json');

function scratch(t, { telemetry = false } = {}) {
  const dir = tempDir(t, 'doflow-review-check-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  if (telemetry) delete env.DOFLOW_TELEMETRY;
  const write = (name, record) => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), typeof record === 'string' ? record : JSON.stringify(record));
    return name;
  };
  const cli = (args) => spawnSync(process.execPath, [CLI, 'review', ...args], { cwd, env, encoding: 'utf8' });
  const dispatcher = (args) => spawnSync('/bin/bash', [RUN, 'review', ...args], { cwd, env, encoding: 'utf8' });
  const git = (args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { cwd, env, write, cli, dispatcher, git };
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

test('a preExistingAt that is not an ancestor of reviewedHead exits 1 in a real repository', (t) => {
  const s = scratch(t);
  const commit = (text) => {
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
  const res = s.cli(['--action', 'check', '--path', 'findings.json', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const dir = path.join(s.cwd, '.doflow', 'state', 'runs', 'telemetry');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.kind), ['review.run']);
  assert.equal(lines[0].errors, 0);
  assert.equal(fs.existsSync(path.join(s.cwd, '.gitignore')), false, 'review runs no upkeep');
});
