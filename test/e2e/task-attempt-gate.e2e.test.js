'use strict';
// task-attempt-gate.e2e.test.js — FR-006 through the real CLI: `orchestrate` refuses to complete the
// do-execute-plan implementation stage while the feature's task-attempt ledger is incomplete, and
// records the stage as `unverified` when the feature has no ledger. Real bin/doflow.js, real scratch
// git repository, scratch HOME.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const SLUG = '910-gate';
const PLAN = '# Plan\n\n## Tasks\n\n- [ ] A.1 one; owner: core-implementer; files: src/a.js\n- [ ] A.2 two; owner: core-implementer; files: src/b.js\n';
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const CASE_TIMEOUT_MS = 240_000;

const scratch = createScratch('doflow-task-attempt-gate-');
after(() => scratch.remove());

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' }), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function doflow(cwd, args) {
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env: scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let counter = 0;
/** A repository on branch `feat/910-gate` with an uncommitted feature folder, parked on its implementation stage. */
function repoAtImplementation() {
  const main = path.join(scratch.dir, `case-${counter += 1}`, 'm');
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'src', 'a.js'), 'a\n');
  const pass = 'node -e 0';
  write(path.join(main, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { build: pass, lint: pass, typecheck: pass, test: pass } })}\n`);
  write(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'checkout', '-q', '-b', `feat/${SLUG}`);
  const folder = path.join(main, 'agent-docs', 'doflow', SLUG);
  write(path.join(folder, 'intention', 'requirement.md'), '# requirement\n');
  write(path.join(folder, 'design', 'design.md'), '# design\n');
  write(path.join(folder, 'plan.md'), PLAN);
  const real = fs.realpathSync(main);

  const catchUp = () => doflow(real, ['orchestrate', '--action', 'catch-up', '--task-id', SLUG, '--task-class', 'feature', '--stage', 'implementation', '--json']);
  let result = catchUp();
  for (let step = 0; step < 6; step += 1) {
    assert.strictEqual(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    if (snapshot.current && snapshot.current.id === 'implementation') break;
    assert.ok(snapshot.awaitingGate, 'the walk stopped with no gate to decide');
    const decided = doflow(real, ['orchestrate', '--action', 'decide-gate', '--task-id', SLUG, '--gate', snapshot.awaitingGate.gateId, '--decision', 'approve', '--note', 'e2e', '--json']);
    assert.strictEqual(decided.status, 0, decided.stderr);
    result = catchUp();
  }

  const evidence = doflow(real, ['evidence', '--task-id', SLUG, `--slug=${SLUG}`, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graph', '--capability', 'code.structural', '--locator', `agent-docs/doflow/${SLUG}/plan.md`, '--content', 'plan lists src/a.js', '--establishes', 'affected_components', '--json']);
  assert.strictEqual(evidence.status, 0, `${evidence.stdout}\n${evidence.stderr}`);
  const ready = doflow(real, ['readiness', '--task-class', 'feature', '--task-id', SLUG, `--slug=${SLUG}`, '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.strictEqual(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
  return real;
}

const attempt = (main, args) => doflow(main, ['task-attempt', '--slug', SLUG, '--json', ...args]);
const runFile = (main) => path.join(main, '.doflow', 'state', 'orchestration', `${SLUG}.json`);
const implementation = (main) => JSON.parse(fs.readFileSync(runFile(main), 'utf8')).program.find((n) => n.id === 'implementation');
const handoff = (main) => doflow(main, ['orchestrate', '--action', 'handoff', '--task-id', SLUG, '--calling-skill', 'do-execute-plan', '--note', 'built', '--result', 'passed']);

function finishTask(main, task) {
  const claimed = JSON.parse(attempt(main, ['--action', 'claim', '--task', task, '--owner', 'core-implementer', '--mode', 'sequential']).stdout);
  assert.strictEqual(claimed.disposition, 'claimed');
  const added = doflow(main, ['evidence', '--task-id', task, `--slug=${SLUG}`, '--action', 'add', '--kind', 'test-result', '--provenance', 'extracted',
    '--provider', 'shell', '--capability', 'test', '--locator', 'src/a.js', '--observed-command', 'node -e 0', '--observed-exit', '0', '--content', 'passed', '--json']);
  assert.strictEqual(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const evidenceId = JSON.parse(added.stdout).evidence[0].id;
  assert.ok(evidenceId, added.stdout);
  const done = attempt(main, ['--action', 'finish', '--task', task, '--token', String(claimed.token), '--result', 'COMPLETED', '--evidence-id', evidenceId]);
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
}

test('handoff of the implementation stage is refused while the ledger is incomplete, then accepted once complete', { timeout: CASE_TIMEOUT_MS }, () => {
  const main = repoAtImplementation();
  finishTask(main, 'A.1');
  const before = fs.readFileSync(runFile(main));

  const refused = handoff(main);
  assert.strictEqual(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
  assert.ok(refused.stderr.includes('no COMPLETED attempt for A.2'), refused.stderr);
  assert.deepStrictEqual(fs.readFileSync(runFile(main)), before, 'a refused handoff changes no state file');

  finishTask(main, 'A.2');
  const accepted = handoff(main);
  assert.strictEqual(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.strictEqual(implementation(main).status, 'completed');
  assert.strictEqual(implementation(main).outcome, 'passed');
});

test('handoff of the implementation stage with no ledger records unverified', { timeout: CASE_TIMEOUT_MS }, () => {
  const main = repoAtImplementation();
  const accepted = handoff(main);
  assert.strictEqual(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.strictEqual(implementation(main).status, 'completed');
  assert.strictEqual(implementation(main).outcome, 'unverified');
  const history = JSON.parse(fs.readFileSync(runFile(main), 'utf8')).history.find((h) => h.node === 'implementation');
  assert.ok(history.note.includes('No task-attempt ledger exists'), history.note);
});
