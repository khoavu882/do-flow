'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

// HOME and XDG_CONFIG_HOME point at a scratch directory of their own, never at the worktree under
// test: the user-scope upkeep pass records its run ledger under HOME/.doflow by design
// (src/runtime/storage/upkeep.ts, the "runs-user" ledger), so a HOME equal to the worktree makes
// that legitimate user-level write look like task state landing in the worktree. An inherited
// XDG_CONFIG_HOME must not be allowed to point the pass at the developer's or runner's real one.
function run(cwd, args, home) {
  const result = spawnSync(process.execPath, [DOFLOW, ...args], {
    cwd,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// What the worktree's `.doflow` holds, for an assertion message: the entries beat a bare `false`.
function listed(root) {
  try { return fs.readdirSync(root, { recursive: true }).sort().join('\n') || '(empty)'; }
  catch { return '(absent)'; }
}

function runJson(cwd, args, home) {
  const result = run(cwd, [...args, '--json'], home);
  try { return { ...result, data: JSON.parse(result.stdout) }; }
  catch { throw new Error(`expected JSON from ${args.join(' ')}:\n${result.stdout}\n${result.stderr}`); }
}

test('linked worktree routes retrieval state to main and measures absence freshness in the worktree', (t) => {
  const main = tempDir(t, 'doflow-worktree-evidence-');
  const home = tempDir(t, 'doflow-worktree-home-');
  fs.writeFileSync(path.join(main, 'a.js'), 'module.exports = { x: 1 };\n');
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'user.name', 'Test');
  git(main, 'add', 'a.js');
  git(main, 'commit', '-qm', 'init');

  const slug = '930-wt';
  const feature = path.join(main, 'agent-docs', 'doflow', slug);
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'plan.md'), '# Feature plan\n');
  const worktree = path.join(main, '..', `${path.basename(main)}-wt`);
  git(main, 'worktree', 'add', '-q', '-b', `feat/${slug}`, worktree);
  t.after(() => { try { git(main, 'worktree', 'remove', '--force', worktree); } catch {} });

  const taskId = slug;
  const declared = runJson(worktree, ['retrieval-plan', '--task-id', taskId, '--slug', slug,
    '--action', 'declare', '--need', 'locate-known-symbol'], home);
  assert.equal(declared.status, 0, `${declared.stdout}\n${declared.stderr}`);
  assert.ok(fs.existsSync(path.join(main, '.doflow', 'state', 'retrieval', `${taskId}.json`)), 'retrieval plan is stored with task state in main');
  assert.ok(!fs.existsSync(path.join(worktree, '.doflow')),
    `the worktree receives no task state; found in ${path.join(worktree, '.doflow')}:\n${listed(path.join(worktree, '.doflow'))}\nstderr:\n${declared.stderr}`);

  const added = runJson(worktree, ['evidence', '--task-id', taskId, '--slug', slug, '--action', 'add',
    '--kind', 'structural', '--provenance', 'extracted', '--provider', declared.data.needs[0].provider,
    '--capability', declared.data.needs[0].capability,
    '--absence', '--need', 'locate-known-symbol', '--establishes', 'architecture_mapped', '--content', 'no result'], home);
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  assert.equal(added.data.evidence[0].result, 'EMPTY');
  assert.equal(added.data.evidence[0].freshness.status, 'FRESH');

  const report = runJson(worktree, ['retrieval-plan', '--task-id', taskId, '--slug', slug, '--action', 'report'], home);
  assert.equal(report.status, 0, `${report.stdout}\n${report.stderr}`);
  assert.ok(report.data.needs[0].attempts.some((attempt) => attempt.evidenceIds.includes(added.data.evidence[0].id)),
    'the report binds the absence in its derived attempt');

  const baseline = runJson(worktree, ['readiness', '--task-id', taskId, '--slug', slug, '--task-class', 'refactor'], home);
  assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
  assert.ok(!baseline.data.staleAbsence.some((item) => item.evidenceId === added.data.evidence[0].id),
    'the absence is fresh before the worktree changes');

  fs.writeFileSync(path.join(worktree, 'a.js'), 'module.exports = { x: 2 };\n');
  const readiness = runJson(worktree, ['readiness', '--task-id', taskId, '--slug', slug, '--task-class', 'refactor'], home);
  assert.equal(readiness.status, 0, `${readiness.stdout}\n${readiness.stderr}`);
  assert.ok(readiness.data.staleAbsence.some((item) => item.evidenceId === added.data.evidence[0].id),
    'editing the worktree marks its recorded absence stale');
  assert.ok(!fs.existsSync(path.join(worktree, '.doflow')), 'all records remain outside the worktree');
});
