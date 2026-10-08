'use strict';
// readiness-enforcement.e2e.test.js — a handoff or complete-stage of a gated stage needs a READY
// readiness record, `verify` is held to the same record, and a run started before the record
// existed is warned instead of refused. Every case runs the real bin/doflow.js against real
// scratch git repositories in a scratch HOME; nothing outside the scratch root is read or written.
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

const PLAN_TEXT = '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n';
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const CASE_TIMEOUT_MS = 240_000;
const GATE = 'doflow gate readiness-before-implementation';
const HOOKLESS_NOTE = 'opencode, pi, copilot have no hook layer';

const scratch = createScratch('doflow-readiness-enforcement-');
after(() => scratch.remove());

function spawnEnv() {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  if (IS_WIN) env.USERPROFILE = scratch.home;
  return env;
}

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: spawnEnv(), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function doflow(cwd, args) {
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env: spawnEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function json(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout is JSON: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const folderRel = (slug) => `agent-docs/doflow/${slug}/`;

/** The feature folder `slug`: requirement, design, a register and a plan. */
function writeFeatureFolder(checkout, slug) {
  const folder = path.join(checkout, folderRel(slug));
  write(path.join(folder, 'intention', 'requirement.md'), '# requirement\n');
  write(path.join(folder, 'design', 'design.md'), '# design\n');
  write(path.join(folder, 'decisions', 'register.json'), `${JSON.stringify({ version: 1, slug, nextId: 1, decisions: [] })}\n`);
  write(path.join(folder, 'plan.md'), PLAN_TEXT);
}

let rootCounter = 0;
/** A repository `m` on branch `feat/900-demo` with committed src/a.js, `agent-docs/` and `.doflow/`
 * ignored, and an uncommitted feature folder for each of `slugs`. Returns its real path and root. */
function makeMain(slugs = ['900-demo']) {
  const root = path.join(scratch.dir, `case-${rootCounter += 1}`);
  const main = path.join(root, 'm');
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'src', 'a.js'), 'a\n');
  // Every check passes, so the readiness record is the only thing that can hold a report back.
  const pass = 'node -e 0';
  write(path.join(main, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { build: pass, lint: pass, typecheck: pass, test: pass } })}\n`);
  write(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'checkout', '-q', '-b', 'feat/900-demo');
  for (const slug of slugs) writeFeatureFolder(main, slug);
  return { root, main: fs.realpathSync(main) };
}

/** Starts a run for `taskId` as `cls` and approves gates until the current stage is `stage`. */
function walkTo(cwd, taskId, cls, stage) {
  let result = doflow(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', taskId, '--task-class', cls, '--stage', stage, '--json']);
  for (let step = 0; step < 6; step += 1) {
    assert.strictEqual(result.status, 0, result.stderr);
    const snapshot = json(result);
    if (snapshot.current && snapshot.current.id === stage) return snapshot;
    assert.ok(snapshot.awaitingGate, `walk stopped at ${JSON.stringify(snapshot.current)} with no gate to decide`);
    const decided = doflow(cwd, ['orchestrate', '--action', 'decide-gate', '--task-id', taskId, '--gate', snapshot.awaitingGate.gateId, '--decision', 'approve', '--note', 'e2e', '--json']);
    assert.strictEqual(decided.status, 0, decided.stderr);
    result = doflow(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', taskId, '--task-class', cls, '--stage', stage, '--json']);
  }
  throw new Error(`never reached stage ${stage}`);
}

const runFile = (main, taskId) => path.join(main, '.doflow', 'state', 'orchestration', `${taskId}.json`);

/** `path:sha256` for every file under the run and readiness state of `main`, sorted. */
function stateHashes(main) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(main, full)}:${sha(full)}`);
    }
  };
  walk(path.join(main, '.doflow', 'state', 'orchestration'));
  walk(path.join(main, '.doflow', 'state', 'readiness'));
  return out.sort();
}

function handoff(cwd, taskId, extra = []) {
  return doflow(cwd, ['orchestrate', '--action', 'handoff', '--task-id', taskId, '--calling-skill', 'do-execute-plan', '--note', 'n', ...extra]);
}

/** A refused call: exit 1, the gate text on stderr, and nothing under the state roots changed. */
function assertRefused(main, run, wanted) {
  const before = stateHashes(main);
  const result = run();
  assert.strictEqual(result.status, 1, `${result.stdout}\n${result.stderr}`);
  for (const text of wanted) assert.ok(result.stderr.includes(text), `stderr lacks ${JSON.stringify(text)}:\n${result.stderr}`);
  assert.deepStrictEqual(stateHashes(main), before, 'a refused call changes no state file');
  return result;
}

function addFeatureEvidence(cwd, slug) {
  const added = doflow(cwd, ['evidence', '--task-id', slug, `--slug=${slug}`, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graph', '--capability', 'code.structural', '--locator', `${folderRel(slug)}plan.md`, '--content', 'plan lists src/a.js', '--establishes', 'affected_components', '--json']);
  assert.strictEqual(added.status, 0, `${added.stdout}\n${added.stderr}`);
}

function readyFeatureRecord(cwd, slug) {
  addFeatureEvidence(cwd, slug);
  const ready = doflow(cwd, ['readiness', '--task-class', 'feature', '--task-id', slug, `--slug=${slug}`, '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.strictEqual(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.ok(ready.stdout.includes('READY'), ready.stdout);
  assert.ok(ready.stdout.includes('Recorded:'), ready.stdout);
  return ready;
}

const recordFile = (main, slug) => path.join(main, '.doflow', 'state', 'readiness', `${slug}.json`);

/** The record of `taskId` wherever the namespace put it under `main`. */
function findRecord(main, taskId) {
  const store = path.join(main, '.doflow', 'state', 'readiness');
  const found = fs.readdirSync(store, { recursive: true }).filter((rel) => path.basename(rel) === `${taskId}.json`);
  assert.strictEqual(found.length, 1, `one record for ${taskId} under ${store}`);
  return path.join(store, found[0]);
}
const missingText = (taskId, template) => `${GATE}: task '${taskId}' has no readiness record for the '${template}' template.`;

test('a fresh run is refused at handoff and at complete-stage without a READY record, and nothing is written', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '900-demo', 'feature', 'implementation');
  const runHash = sha(runFile(main, '900-demo'));

  assertRefused(main, () => handoff(main, '900-demo', ['--verification-plan', 'x', '--scope', 'y']), [
    missingText('900-demo', 'feature'),
    'Next: doflow-run readiness --task-class feature --task-id 900-demo',
    'Nothing was changed.',
    HOOKLESS_NOTE,
    'did not read them',
  ]);
  assert.strictEqual(sha(runFile(main, '900-demo')), runHash, 'the run file is byte for byte unchanged');

  assertRefused(main, () => doflow(main, ['orchestrate', '--action', 'complete-stage', '--task-id', '900-demo', '--stage', 'implementation', '--task-class', 'feature']), [
    missingText('900-demo', 'feature'),
    'Nothing was changed.',
  ]);
  assert.strictEqual(sha(runFile(main, '900-demo')), runHash);
});

test('a READY record lets the handoff through, with 1.21.0\'s output and no readiness line', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '900-demo', 'feature', 'implementation');
  readyFeatureRecord(main, '900-demo');

  const done = handoff(main, '900-demo');
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
  const lines = done.stdout.split('\n').filter(Boolean);
  assert.ok(lines[0].startsWith('Workflow 900-demo [feature] — RUNNING'), done.stdout);
  assert.ok(lines.includes('Handoff: completed'), done.stdout);
  assert.ok(lines.some((l) => l.startsWith('Progress: ')), done.stdout);
  assert.ok(lines.some((l) => l.startsWith('Next: ')), done.stdout);
  for (const line of lines) assert.ok(!/readiness/i.test(line), `no readiness wording in: ${line}`);
  assert.strictEqual(done.stderr, '', 'nothing on stderr for a READY record');
});

test('a fresh handoff for a gated class is refused before any run file exists', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  const result = assertRefused(main, () => doflow(main, ['orchestrate', '--action', 'handoff', '--task-id', '901-bug', '--task-class', 'bug', '--calling-skill', 'do-implement', '--note', 'n']), [
    missingText('901-bug', 'bug'),
  ]);
  assert.ok(result.stderr.includes("'bug' template"), result.stderr);
  assert.ok(!fs.existsSync(runFile(main, '901-bug')), 'no run was started');
});

test('a handoff with no run and no class is standalone and says no readiness was required', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  const result = doflow(main, ['orchestrate', '--action', 'handoff', '--task-id', '902-solo', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('no readiness was required'), result.stdout);
  assert.ok(!fs.existsSync(runFile(main, '902-solo')));
});

test('a trivial edit is refused without a record and accepted once READY', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  const args = ['orchestrate', '--action', 'handoff', '--task-id', '903-trivial', '--task-class', 'trivial-edit', '--calling-skill', 'do-implement', '--note', 'n'];
  assertRefused(main, () => doflow(main, args), [missingText('903-trivial', 'trivial-edit')]);
  assert.ok(!fs.existsSync(runFile(main, '903-trivial')), 'no run file after the refusal');

  const added = doflow(main, ['evidence', '--task-id', '903-trivial', '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted',
    '--provider', 'grep', '--capability', 'code.exact-search', '--locator', 'src/a.js:1', '--content', 'a', '--establishes', 'target_identified', '--json']);
  assert.strictEqual(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const ready = doflow(main, ['readiness', '--task-class', 'trivial-edit', '--task-id', '903-trivial', '--scope', 'src/a.js', '--json']);
  assert.strictEqual(ready.status, 0, ready.stderr);
  assert.strictEqual(json(ready).state, 'READY');

  const done = doflow(main, args);
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
  assert.ok(done.stdout.includes('Handoff: completed'), done.stdout);
});

test('a READY record of another template is refused by name', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '908-demo', 'feature', 'implementation');
  const added = doflow(main, ['evidence', '--task-id', '908-demo', '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted',
    '--provider', 'grep', '--capability', 'code.exact-search', '--locator', 'src/a.js:1', '--content', 'a', '--establishes', 'target_identified', '--json']);
  assert.strictEqual(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const ready = doflow(main, ['readiness', '--task-class', 'trivial-edit', '--task-id', '908-demo', '--scope', 'src/a.js', '--json']);
  assert.strictEqual(json(ready).state, 'READY');

  assertRefused(main, () => handoff(main, '908-demo'), [
    `${GATE}: task '908-demo' has a READY record for the 'trivial-edit' template, and this stage needs 'feature'.`,
    'Next: doflow-run readiness --task-class feature --task-id 908-demo',
  ]);
});

test('a record that is not READY is refused with its state and time', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '909-demo', 'feature', 'implementation');
  const evaluated = doflow(main, ['readiness', '--task-class', 'feature', '--task-id', '909-demo', '--json']);
  assert.strictEqual(evaluated.status, 0, evaluated.stderr);
  const written = JSON.parse(fs.readFileSync(findRecord(main, '909-demo'), 'utf8'));
  assert.strictEqual(written.state, json(evaluated).state);
  assert.notStrictEqual(written.state, 'READY');

  assertRefused(main, () => handoff(main, '909-demo'), [
    `${GATE}: task '909-demo' was last evaluated ${written.state} at ${written.evaluatedAt} against the 'feature' template, not READY.`,
  ]);
});

test('final verify with no record is INCONCLUSIVE and exits 1; the contract action is unaffected', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain(['900-demo', '904-demo']);
  walkTo(main, '904-demo', 'feature', 'implementation');

  const verify = doflow(main, ['verify', '--task-id', '904-demo', '--slug=904-demo', '--json']);
  assert.strictEqual(verify.status, 1, `${verify.stdout}\n${verify.stderr}`);
  const report = json(verify);
  assert.strictEqual(report.readiness.applies, true);
  assert.strictEqual(report.readiness.ok, false);
  assert.strictEqual(report.status, 'INCONCLUSIVE');
  assert.ok(report.reason.startsWith(GATE), report.reason);
  assert.ok(!('grace' in report.readiness), 'a fresh run is not in grace');

  const contract = doflow(main, ['verify', '--task-id', '904-demo', '--slug=904-demo', '--action', 'contract']);
  assert.strictEqual(contract.status, 0, `${contract.stdout}\n${contract.stderr}`);
});

test('from a linked worktree the run and the READY record are found in the main checkout', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeMain(['900-demo', '905-demo']);
  walkTo(main, '905-demo', 'feature', 'implementation');
  readyFeatureRecord(main, '905-demo');
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/905-demo', wt);
  const linked = fs.realpathSync(wt);
  assert.ok(!fs.existsSync(path.join(linked, '.doflow')), 'the linked checkout holds no state');
  const before = stateHashes(main);

  const status = doflow(linked, ['orchestrate', '--action', 'status', '--task-id', '905-demo']);
  assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.ok(status.stdout.includes('Workflow 905-demo [feature]'), status.stdout);

  const verify = doflow(linked, ['verify', '--task-id', '905-demo', '--slug=905-demo', '--json']);
  const report = json(verify);
  assert.strictEqual(report.readiness.applies, true);
  assert.strictEqual(report.readiness.ok, true, JSON.stringify(report.readiness));
  assert.strictEqual(report.status, 'PASS', report.reason);
  assert.strictEqual(verify.status, 0, verify.stdout);
  assert.strictEqual(report.readiness.record.origin, 'other');
  assert.deepStrictEqual(stateHashes(main), before, 'reading from the linked checkout changes nothing');
  assert.ok(!fs.existsSync(path.join(linked, '.doflow', 'state')), 'nothing was written in the linked checkout');

  const done = handoff(linked, '905-demo');
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
  assert.ok(done.stdout.includes('Handoff: completed'), done.stdout);
  assert.ok(!fs.existsSync(path.join(linked, '.doflow', 'state', 'orchestration')), 'the run was updated where it lives');
});

test('a run started before the upgrade is warned and proceeds; a fresh run beside it is refused', { timeout: CASE_TIMEOUT_MS * 2 }, () => {
  const { main } = makeMain(['900-demo', '906-demo', '907-demo']);
  walkTo(main, '906-demo', 'feature', 'implementation');
  walkTo(main, '907-demo', 'feature', 'implementation');
  const old = JSON.parse(fs.readFileSync(runFile(main, '906-demo'), 'utf8'));
  assert.strictEqual(old.readinessFloor, 1, 'a run started now carries the marker');
  delete old.readinessFloor;
  fs.writeFileSync(runFile(main, '906-demo'), `${JSON.stringify(old, null, 2)}\n`);
  assert.ok(typeof old.startedAt === 'string');

  const verify = doflow(main, ['verify', '--task-id', '906-demo', '--slug=906-demo', '--json']);
  const report = json(verify);
  assert.strictEqual(report.readiness.applies, true);
  assert.strictEqual(report.readiness.ok, false);
  assert.strictEqual(report.readiness.grace, true);
  assert.strictEqual(report.status, 'PASS', 'the tiers alone decide the status for a run in grace');
  assert.strictEqual(verify.status, 0, verify.stdout);
  assert.ok(!String(report.reason).startsWith(GATE), `the tiers' status is untouched: ${report.reason}`);
  assert.ok(report.readiness.message.includes('From DoFlow 1.23.0 it is refused'), report.readiness.message);

  const human = doflow(main, ['verify', '--task-id', '906-demo', '--slug=906-demo']);
  const line = human.stdout.split('\n').find((l) => l.startsWith('readiness:'));
  assert.ok(line && line.includes('From DoFlow 1.23.0 it is refused'), human.stdout);

  const before = stateHashes(main);
  const done = handoff(main, '906-demo');
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
  assert.ok(done.stdout.split('\n').includes('Handoff: completed'), done.stdout);
  assert.ok(done.stderr.includes("task '906-demo'") && done.stderr.includes('From DoFlow 1.23.0 it is refused'), done.stderr);
  assert.ok(done.stderr.includes(`before DoFlow 1.22.0 recorded readiness, so this handoff proceeds.`), done.stderr);
  assert.notDeepStrictEqual(stateHashes(main), before, 'the proceeding handoff did record the stage');

  assertRefused(main, () => handoff(main, '907-demo'), [missingText('907-demo', 'feature')]);
});

test('an unreadable record is refused, replaced by readiness with its bytes kept once, and then accepted', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '900-demo', 'feature', 'implementation');
  const file = recordFile(main, '900-demo');
  write(file, '{not json');

  assertRefused(main, () => handoff(main, '900-demo'), [`${GATE}: task '900-demo' has a readiness record that cannot be used (unparsable JSON`]);

  addFeatureEvidence(main, '900-demo');
  const ready = doflow(main, ['readiness', '--task-class', 'feature', '--task-id', '900-demo', '--slug=900-demo', '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.strictEqual(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.ok(ready.stdout.includes('Replaced:'), ready.stdout);
  assert.strictEqual(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{not json');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'READY');

  const done = handoff(main, '900-demo');
  assert.strictEqual(done.status, 0, `${done.stdout}\n${done.stderr}`);
});

test('a record a newer DoFlow wrote is refused by handoff, never overwritten by readiness', { timeout: CASE_TIMEOUT_MS }, () => {
  const { main } = makeMain();
  walkTo(main, '900-demo', 'feature', 'implementation');
  const file = recordFile(main, '900-demo');
  const newer = `${JSON.stringify({ version: 2, taskId: '900-demo', state: 'READY', taskClass: 'feature', evaluatedAt: '2026-01-01T00:00:00.000Z' })}\n`;
  write(file, newer);

  assertRefused(main, () => handoff(main, '900-demo'), [
    `${GATE}: task '900-demo' has a readiness record ${file} written by a newer DoFlow (record version 2; this runtime reads 1)`,
    'Nothing was changed.',
  ]);

  const rewritten = doflow(main, ['readiness', '--task-class', 'feature', '--task-id', '900-demo', '--slug=900-demo', '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.strictEqual(rewritten.status, 1, `${rewritten.stdout}\n${rewritten.stderr}`);
  assert.ok(rewritten.stderr.includes('was written by a newer DoFlow'), rewritten.stderr);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), newer, 'the newer record is untouched');
  assert.ok(!fs.existsSync(`${file}.unreadable`), 'it was not set aside');
});
