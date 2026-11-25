'use strict';

// 181 IC-024 (FR-013): `verify --action inner-loop` reads the latest verify run record and the git
// state and answers READY or REFUSED; it runs nothing and exits 0, 1 or 2.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../helper/tmp.ts');
const { createScratch } = require('../../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '../../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-inner-loop-');
after(() => scratch.remove());

const GREEN: any = { parse: null, build: 'node -e 0', typecheck: null, lint: 'node -e 0', test: 'node -e 0', testTargeted: 'node -e 0 {pattern}' };

function git(cwd: any, ...args: any[]) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: scratch.env() });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t: any, override: any = GREEN) {
  const root = tempDir(t, 'doflow-inner-loop-project-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  writePlan({ root, plan: path.join(root, 'plan.md') }, override);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, plan: path.join(root, 'plan.md') };
}

function writePlan(p: any, override: any) {
  fs.writeFileSync(p.plan, '# Plan\n\n```doflow-verification\n' + JSON.stringify(override) + '\n```\n');
}

const env = () => scratch.env({ DOFLOW_TELEMETRY: 'off', DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_CONFIG_DIR: undefined });

function doflow(p: any, args: string[]) {
  return spawnSync(process.execPath, [DOFLOW, 'verify', ...args], { cwd: p.root, encoding: 'utf8', env: env() });
}

const report = (p: any) => doflow(p, ['--action', 'report', '--task-id', 'T-1', '--risk', 'LOW', '--plan-path', p.plan, '--scope', 'src/a.js', '--json']);
const innerLoop = (p: any, taskId = 'T-1') => doflow(p, ['--action', 'inner-loop', '--task-id', taskId, '--json']);

const recordFile = (p: any) => path.join(p.root, '.doflow', 'state', 'verification', 'runs', 'T-1.jsonl');
const records = (p: any) => fs.readFileSync(recordFile(p), 'utf8').split('\n').filter(Boolean).map((l: any) => JSON.parse(l));

test('READY when the latest run is on this head, clean, and its inner-loop tiers passed', (t) => {
  const p = project(t);
  assert.equal(report(p).status, 0);
  const answer: any = innerLoop(p);
  assert.equal(answer.status, 0, answer.stderr);
  const json = JSON.parse(answer.stdout);
  assert.deepEqual({ ok: json.ok, action: json.action, verdict: json.verdict, reasons: json.reasons }, { ok: true, action: 'inner-loop', verdict: 'READY', reasons: [] });
  assert.equal(json.head, git(p.root, 'rev-parse', 'HEAD'));
});

test('READY when a tier is declared absent or has no command of its own (NOT_APPLICABLE)', (t) => {
  const p = project(t, { ...GREEN, build: null });
  assert.equal(report(p).status, 0);
  assert.ok(records(p)[0].checks.some((c: any) => c.tier === 'build' && c.status === 'NOT_APPLICABLE' && c.command === null && c.exitCode === null), 'the build tier is recorded with its own status');
  assert.equal(JSON.parse(innerLoop(p).stdout).verdict, 'READY');
});

test('REFUSED failing names the failing command and exits 1', (t) => {
  const p = project(t, { ...GREEN, test: 'node -e "process.exit(3)"' });
  assert.notEqual(report(p).status, 0);
  const answer: any = innerLoop(p);
  assert.equal(answer.status, 1);
  const json = JSON.parse(answer.stdout);
  assert.equal(json.verdict, 'REFUSED');
  assert.equal(json.ok, false);
  const failing = json.reasons.find((r: any) => r.code === 'failing');
  assert.deepEqual(failing.tiers, ['targeted-tests']);
  assert.ok(failing.commands.some((c: any) => c.includes('process.exit(3)')), `the failing command is named: ${failing.commands}`);
});

test('REFUSED missing names the tiers and command roles no detected command covers', (t) => {
  const { lint, typecheck, ...noStatic } = GREEN;
  const p = project(t, noStatic);
  report(p);
  const answer: any = innerLoop(p);
  assert.equal(answer.status, 1);
  const missing = JSON.parse(answer.stdout).reasons.find((r: any) => r.code === 'missing');
  assert.deepEqual(missing.tiers, ['static-analysis']);
  assert.deepEqual(missing.commands, ['typecheck', 'lint']);
  assert.match(answer.stdout, /"missing"/);
  const text: any = doflow(p, ['--action', 'inner-loop', '--task-id', 'T-1']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /inner-loop: REFUSED[\s\S]*missing: no command for static-analysis \(roles: typecheck, lint\)/);
});

test('REFUSED not-run: no record, a record on an older head, a dirty tree, or a schema 1 record', (t) => {
  const p = project(t);
  const none: any = innerLoop(p);
  assert.equal(none.status, 1);
  const reason = JSON.parse(none.stdout).reasons[0];
  assert.deepEqual(reason, { code: 'not-run', tiers: [], commands: ['doflow-run verify --task-id T-1 --action report'] });

  report(p);
  assert.equal(JSON.parse(innerLoop(p).stdout).verdict, 'READY');

  fs.writeFileSync(path.join(p.root, 'src', 'b.js'), 'module.exports = 2;\n');
  assert.equal(JSON.parse(innerLoop(p).stdout).reasons[0].code, 'not-run', 'a dirty tree');
  git(p.root, 'add', 'src/b.js');
  git(p.root, 'commit', '-q', '-m', 'next');
  assert.equal(JSON.parse(innerLoop(p).stdout).reasons[0].code, 'not-run', 'a record of an older head');

  const old = records(p)[0];
  fs.writeFileSync(recordFile(p), JSON.stringify({ ...old, schema: 1, head: git(p.root, 'rev-parse', 'HEAD'), checks: undefined }) + '\n');
  const schema1 = JSON.parse(innerLoop(p).stdout).reasons[0];
  assert.deepEqual([schema1.code, schema1.tiers], ['not-run', ['build', 'static-analysis', 'targeted-tests']], 'a schema 1 line reads as no checks');
});

// A command that would leave a marker file runs only if the verdict ran it; the state tree must not change either.
test('it runs nothing and writes nothing: no marker, no new state file, the record untouched', (t) => {
  const p = project(t, GREEN);
  report(p);
  writePlan(p, { ...GREEN, build: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"' });
  git(p.root, 'add', 'plan.md');
  git(p.root, 'commit', '-q', '-m', 'plan');
  report(p); // the marker is written by this run; remove it, then ask for the verdict
  fs.rmSync(path.join(p.root, 'ran.txt'));
  const tree = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  const before = { record: fs.readFileSync(recordFile(p), 'utf8'), files: tree(path.join(p.root, '.doflow')) };
  innerLoop(p);
  assert.equal(fs.existsSync(path.join(p.root, 'ran.txt')), false, 'the build command was not run');
  assert.equal(fs.readFileSync(recordFile(p), 'utf8'), before.record);
  assert.deepEqual(tree(path.join(p.root, '.doflow')), before.files);
});

test('a task id that names a path is a usage error, exit 2', (t) => {
  const p = project(t);
  const answer: any = innerLoop(p, '../x');
  assert.equal(answer.status, 2);
});
