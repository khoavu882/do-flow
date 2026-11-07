'use strict';

// Feature 149 A.2 (IC-004, FR-010): the `now` channel's `roadmap` section is `roadmapStatusResult`, the function
// the `roadmap --action status` handler prints. Each case runs it in-process and runs the CLI over the same
// scratch repository, then compares the exit code and the parsed stdout; a missing seed stays exit 2 as data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { roadmapStatusResult } = require('../../src/runtime/roadmap/loop.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const write = (file: any, bytes: any) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

const SEED = {
  schema: 1,
  layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' },
  rows: [
    { id: '201', slug: '201-alpha', title: 'Alpha', class: 'feature', needs: [] },
    { id: '202', slug: '202-beta', title: 'Beta', class: 'feature', needs: ['201'] },
  ],
};

/** A scratch main checkout with a `develop` branch, an optional seed and a lease record. */
function fixture(t: any, { seed = true }: any = {}) {
  const dir = tempDir(t, 'doflow-events-roadmap-');
  const root = path.join(dir, 'main');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '', DOFLOW_UPKEEP: 'off',
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test',
    GIT_AUTHOR_DATE: '1792400000 +0000', GIT_COMMITTER_DATE: '1792400000 +0000' };
  const git = (...args: any[]) => cp.execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', '/dev/null');
  write(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('branch', 'develop');
  if (seed) write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify(SEED));
  write(path.join(root, '.doflow/state/roadmap/lease.json'), JSON.stringify({ schema: 1, pid: 4321, start: null, host: 'other.example', runId: 'rl-20261019-abcd', acquiredAt: '2026-10-19T00:00:00Z' }));
  const cli = (...args: any[]) => cp.spawnSync(process.execPath, [CLI, 'roadmap', '--action', 'status', ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, cli };
}

/** The CLI's {exit, json}: json is the parsed stdout when it is one JSON value, else null. */
function cliResult(run: any) {
  let json: any = null;
  try { json = JSON.parse(run.stdout); } catch { json = null; }
  return { exit: run.status, json };
}

/** The bytes the handler prints for a result's lines on one stream. */
function bytesOf(result: any, stream: string) {
  return result.lines.filter((line: any) => line.stream === stream).map((line: any) => `${line.text}\n`).join('');
}

test('roadmap section: --json over a seed equals the CLI (exit 0, deep-equal parsed stdout)', (t) => {
  const f = fixture(t);
  const run = f.cli('--json');
  assert.equal(run.status, 0, run.stderr);
  const result = roadmapStatusResult({ action: 'status', json: true, cwd: f.root });
  assert.deepEqual({ exit: result.exit, json: result.json }, cliResult(run));
  assert.equal(result.json.action, 'status');
  assert.deepEqual(Object.keys(result.json.rowStatus).sort(), ['201', '202']);
  assert.equal(result.json.lease.host, 'other.example');
  assert.equal(bytesOf(result, 'out'), run.stdout, 'the handler prints the same stdout bytes');
});

test('roadmap section: --row --json equals the CLI, including a row that is not found (exit 1)', (t) => {
  const f = fixture(t);
  for (const row of ['201', '999']) {
    const run = f.cli('--row', row, '--json');
    const result = roadmapStatusResult({ action: 'status', json: true, row, cwd: f.root });
    assert.deepEqual({ exit: result.exit, json: result.json }, cliResult(run), `row ${row}`);
    assert.equal(result.exit, row === '201' ? 0 : 1);
  }
});

test('roadmap section: a missing seed is data, exit 2 with the usage body, equal to the CLI', (t) => {
  const f = fixture(t, { seed: false });
  const run = f.cli('--json');
  assert.equal(run.status, 2, run.stderr);
  const result = roadmapStatusResult({ action: 'status', json: true, cwd: f.root });
  assert.deepEqual({ exit: result.exit, json: result.json }, cliResult(run));
  assert.equal(result.exit, 2);
  assert.equal(result.json.error, 'usage');
  assert.match(result.json.detail, /failed to read seed file at /);
});

test('roadmap section: human output has json null and the same stdout bytes as the CLI', (t) => {
  const f = fixture(t);
  const run = f.cli();
  assert.equal(run.status, 0, run.stderr);
  const result = roadmapStatusResult({ action: 'status', cwd: f.root });
  assert.deepEqual({ exit: result.exit, json: result.json }, { exit: 0, json: null });
  assert.equal(bytesOf(result, 'out'), run.stdout);
  assert.match(run.stdout, /^Roadmap status \(2 rows\):\n/);

  const missing = fixture(t, { seed: false });
  const failed = missing.cli();
  const none = roadmapStatusResult({ action: 'status', cwd: missing.root });
  assert.deepEqual({ exit: none.exit, json: none.json }, { exit: failed.status, json: null });
  assert.equal(none.exit, 2);
  assert.equal(failed.stdout, '');
  assert.ok(failed.stderr.includes(bytesOf(none, 'err')), failed.stderr);
});
