'use strict';
// pre-implementation-gate-readiness.test.js — the edit hook holds a task to a READY readiness
// record: on a feature branch whose folder has a register and all three artifacts, and on any
// branch whose run has its gated stage pending. It reads the main checkout's folder, records and
// runs from a linked worktree, prints the runtime's refusal texts byte for byte, treats a run
// started before the record existed as no run, and allows whenever it cannot decide.
//
// The policy is copied into a scratch install layout (<x>/shared/hooks/policies/ beside
// <x>/runtime/core/registry/workflows.json) and run with bash in scratch git repositories under a
// scratch HOME; runs are written by the real bin/doflow.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const POLICY = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'pre-implementation-gate.sh');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');
const RESOLVER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-paths.sh');
const { refusalText } = require('../../src/runtime/implementation-gate');
const { createScratch } = require('../helper/scratch-env');

const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // GUARD: needs bash + jq
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const CASE_TIMEOUT_MS = 240_000;
const ARTIFACT_MESSAGE = '[pre-implementation-gate] doflow gate: feature agent-docs/doflow/900-demo is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Edits under agent-docs/ are always allowed; skip the flow by removing the feature dir.)\n';
const EVALUATED_AT = '2026-01-01T00:00:00.000Z';

const scratch = createScratch('doflow-gate-readiness-');
after(() => scratch.remove());

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A copy of the policy at `<dir>/shared/hooks/policies/` beside `<dir>/runtime/core/registry/`. */
function installLayout(dir, registryText) {
  const policy = path.join(dir, 'shared', 'hooks', 'policies', 'pre-implementation-gate.sh');
  write(policy, fs.readFileSync(POLICY, 'utf8'));
  write(path.join(dir, 'runtime', 'core', 'registry', 'workflows.json'), registryText);
  return policy;
}

const LAYOUT_POLICY = installLayout(path.join(scratch.dir, 'layout'), fs.readFileSync(REGISTRY, 'utf8'));

/** The shipped registry with every readiness template removed. */
const NO_TEMPLATE_POLICY = (() => {
  const doc = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  for (const cls of Object.values(doc.classes)) for (const stage of cls.stages) stage.readinessTemplate = null;
  return installLayout(path.join(scratch.dir, 'layout-no-template'), JSON.stringify(doc));
})();

/** The policy alone, deep enough that no registry candidate exists beside it. */
const ALONE_POLICY = (() => {
  const policy = path.join(scratch.dir, 'alone', 'a', 'b', 'c', 'pre-implementation-gate.sh');
  write(policy, fs.readFileSync(POLICY, 'utf8'));
  return policy;
})();

// Two HOMEs: an empty one (no resolver installed: the policy's branch fallback) and one with
// do-paths.sh installed where the policy looks first. Every hook case runs under both.
const RESOLVER_HOME = path.join(scratch.dir, 'home-resolver');
write(path.join(RESOLVER_HOME, '.doflow', 'scripts', 'doflow', 'bash', 'do-paths.sh'), fs.readFileSync(RESOLVER, 'utf8'));
fs.chmodSync(path.join(RESOLVER_HOME, '.doflow', 'scripts', 'doflow', 'bash', 'do-paths.sh'), 0o755);

function spawnEnv(extra = {}) {
  // Harness variables naming the developer's own config folders would let a real resolver in.
  return scratch.env({
    GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', GEMINI_CONFIG_DIR: '', DOFLOW_PROJECT_DIR: '', ...extra,
  });
}

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: spawnEnv(), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function doflow(cwd, args) {
  const result = spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env: spawnEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `doflow ${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
  return result;
}

/** Every file under `root` but .git, with its bytes, so a hook call can be shown to write nothing. */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${fs.readFileSync(full, 'base64')}`);
    }
  };
  walk(root);
  return out.sort();
}

const editEvent = (file) => ({ tool_name: 'Edit', tool_input: { file_path: file } });
const envelopeEvent = (root, file, taskId) => ({ doflow_event: { operation: 'edit', paths: [file], projectRoot: root, taskId } });

/**
 * Runs the policy on `event` from `cwd`, once without a resolver and once with one, and asserts
 * both give `code` and, when given, exactly `stderr`. Nothing under `caseRoot` may change.
 */
function expectHook({ cwd, caseRoot, event, code, stderr, policy = LAYOUT_POLICY, resolver = true }) {
  const homes = resolver ? [scratch.home, RESOLVER_HOME] : [scratch.home];
  for (const home of homes) {
    const before = snapshot(caseRoot);
    const result = spawnSync('bash', [policy], { cwd, input: JSON.stringify(event), env: spawnEnv({ HOME: home }), encoding: 'utf8' });
    const label = home === RESOLVER_HOME ? 'with resolver' : 'no resolver';
    assert.strictEqual(result.status, code, `${label}: exit ${result.status}, stderr: ${result.stderr}`);
    if (stderr !== undefined) assert.strictEqual(result.stderr, stderr, label);
    assert.deepStrictEqual(snapshot(caseRoot), before, `${label}: the hook writes nothing`);
  }
}

let rootCounter = 0;
/** A repository `m` with committed src/a.js, `agent-docs/` and `.doflow/` ignored, on `branch`. */
function makeRepo(branch) {
  const root = path.join(scratch.dir, `case-${rootCounter += 1}`);
  const main = path.join(root, 'm');
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'src', 'a.js'), 'a\n');
  write(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  if (branch) git(main, 'checkout', '-q', '-b', branch);
  return { root, main: fs.realpathSync(main) };
}

/** The feature folder `slug` under `checkout`: the three artifacts and, unless told not to, a register. */
function writeFeature(checkout, slug, { register = true, design = true } = {}) {
  const folder = path.join(checkout, 'agent-docs', 'doflow', slug);
  write(path.join(folder, 'intention', 'requirement.md'), '# requirement\n');
  if (design) write(path.join(folder, 'design', 'design.md'), '# design\n');
  write(path.join(folder, 'plan.md'), '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n');
  if (register) write(path.join(folder, 'decisions', 'register.json'), `${JSON.stringify({ version: 1, slug, nextId: 1, decisions: [] })}\n`);
}

const recordPath = (checkout, rel) => path.join(checkout, '.doflow', 'state', 'readiness', rel);

/** A readiness record as the runtime writes it, at `.doflow/state/readiness/<rel>`. */
function writeRecord(checkout, rel, { taskId, taskClass, state }) {
  write(recordPath(checkout, rel), `${JSON.stringify({
    version: 1, taskId, slug: null, taskClass, templateName: taskClass, state, stageEntry: 'ENTER', executionMode: 'workflow',
    inputs: {}, declaredScope: null, unmet: [], evidenceCount: 1, evaluatedAt: EVALUATED_AT,
  }, null, 2)}\n`);
}

const runFile = (checkout, taskId) => path.join(checkout, '.doflow', 'state', 'orchestration', `${taskId}.json`);

/** Starts a run for `taskId` as `cls` and approves gates until the current stage is `stage`. */
function walkTo(cwd, taskId, cls, stage) {
  const catchUp = () => doflow(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', taskId, '--task-class', cls, '--stage', stage, '--json']);
  let snapshotJson = JSON.parse(catchUp().stdout);
  for (let step = 0; step < 6; step += 1) {
    if (snapshotJson.current && snapshotJson.current.id === stage) return;
    assert.ok(snapshotJson.awaitingGate, `walk stopped at ${JSON.stringify(snapshotJson.current)} with no gate to decide`);
    doflow(cwd, ['orchestrate', '--action', 'decide-gate', '--task-id', taskId, '--gate', snapshotJson.awaitingGate.gateId, '--decision', 'approve', '--note', 'test', '--json']);
    snapshotJson = JSON.parse(catchUp().stdout);
  }
  throw new Error(`never reached stage ${stage}`);
}

/** Removes the key every run started since readiness was recorded carries, as a 1.21.0 run lacks it. */
function dropFloor(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(run.readinessFloor, 1, 'a run started by this runtime carries readinessFloor');
  delete run.readinessFloor;
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
}

HOOK_TEST('a feature branch with a register and three artifacts needs a READY feature record; the texts are the runtime\'s', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo('feat/900-demo');
  writeFeature(main, '900-demo');
  const edit = editEvent(path.join(main, 'src', 'a.js'));
  const base = { cwd: main, caseRoot: root, event: edit };

  expectHook({ ...base, code: 2, stderr: `${refusalText('missing', { taskId: '900-demo', template: 'feature' })}\n` });
  expectHook({ ...base, event: envelopeEvent(main, path.join(main, 'src', 'a.js'), '900-demo'), code: 2, stderr: `${refusalText('missing', { taskId: '900-demo', template: 'feature' })}\n` });
  expectHook({ ...base, event: editEvent(path.join(main, 'agent-docs', 'doflow', '900-demo', 'plan.md')), code: 0, stderr: '' });

  // An envelope task id other than the slug names a namespaced record and the slug in the command.
  expectHook({
    ...base, event: envelopeEvent(main, path.join(main, 'src', 'a.js'), 'A.1'), code: 2,
    stderr: `${refusalText('missing', { taskId: 'A.1', slug: '900-demo', template: 'feature' })}\n`,
  });
  writeRecord(main, path.join('900-demo', 'A.1.json'), { taskId: 'A.1', taskClass: 'feature', state: 'READY' });
  expectHook({ ...base, event: envelopeEvent(main, path.join(main, 'src', 'a.js'), 'A.1'), code: 0, stderr: '' });

  writeRecord(main, '900-demo.json', { taskId: '900-demo', taskClass: 'feature', state: 'NEEDS_EVIDENCE' });
  expectHook({
    ...base, code: 2,
    stderr: `${refusalText('not-ready', { taskId: '900-demo', template: 'feature', record: { state: 'NEEDS_EVIDENCE', evaluatedAt: EVALUATED_AT } })}\n`,
  });

  writeRecord(main, '900-demo.json', { taskId: '900-demo', taskClass: 'bug', state: 'READY' });
  expectHook({ ...base, code: 2, stderr: `${refusalText('wrong-template', { taskId: '900-demo', template: 'feature', record: { taskClass: 'bug' } })}\n` });

  write(recordPath(main, '900-demo.json'), '{ not json');
  expectHook({ ...base, code: 0, stderr: '' });
  write(recordPath(main, '900-demo.json'), '{"version": 1, "taskClass": "feature"}\n');
  expectHook({ ...base, code: 0, stderr: '' });
  fs.rmSync(recordPath(main, '900-demo.json'));

  // The registry decides which class is held: none held, or none found, allows.
  expectHook({ ...base, policy: NO_TEMPLATE_POLICY, code: 0, stderr: '' });
  expectHook({ ...base, policy: ALONE_POLICY, resolver: false, code: 0, stderr: '' });

  // A READY record written by the runtime itself is where the hook reads it.
  doflow(main, ['evidence', '--task-id', '900-demo', '--slug=900-demo', '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graph', '--capability', 'code.structural', '--locator', 'agent-docs/doflow/900-demo/plan.md', '--content', 'plan lists src/a.js',
    '--establishes', 'affected_components', '--json']);
  const ready = doflow(main, ['readiness', '--task-class', 'feature', '--task-id', '900-demo', '--slug=900-demo', '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.ok(ready.stdout.includes('READY') && ready.stdout.includes('Recorded:'), ready.stdout);
  expectHook({ ...base, code: 0, stderr: '' });
  expectHook({ ...base, event: envelopeEvent(main, path.join(main, 'src', 'a.js'), '900-demo'), code: 0, stderr: '' });
});

HOOK_TEST('a feature folder from before the register is not held to a record', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo('feat/910-old');
  writeFeature(main, '910-old', { register: false });
  expectHook({ cwd: main, caseRoot: root, event: editEvent(path.join(main, 'src', 'a.js')), code: 0, stderr: '' });
});

HOOK_TEST('a feature run is held while its implementation stage is pending, and not once it is completed', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo('feat/900-demo');
  writeFeature(main, '900-demo');
  const base = { cwd: main, caseRoot: root, event: editEvent(path.join(main, 'src', 'a.js')) };
  const missing = `${refusalText('missing', { taskId: '900-demo', template: 'feature' })}\n`;

  walkTo(main, '900-demo', 'feature', 'implementation');
  expectHook({ ...base, code: 2, stderr: missing });

  // A run started before readiness was recorded counts as no run, and the feature branch still holds it.
  const started = fs.readFileSync(runFile(main, '900-demo'));
  dropFloor(runFile(main, '900-demo'));
  expectHook({ ...base, code: 2, stderr: missing });
  fs.writeFileSync(runFile(main, '900-demo'), started);

  // Completing the stage needs a READY record; once past it the run is not held, record or not.
  writeRecord(main, '900-demo.json', { taskId: '900-demo', taskClass: 'feature', state: 'READY' });
  doflow(main, ['orchestrate', '--action', 'complete-stage', '--task-id', '900-demo', '--stage', 'implementation', '--task-class', 'feature', '--note', 'test']);
  fs.rmSync(recordPath(main, '900-demo.json'));
  expectHook({ ...base, code: 0, stderr: '' });
  dropFloor(runFile(main, '900-demo'));
  expectHook({ ...base, code: 0, stderr: '' });
});

HOOK_TEST('an exempt branch is held only by its run: bug held, bug in grace and trivial-edit not', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo('fix/901-bug');
  const base = { cwd: main, caseRoot: root, event: editEvent(path.join(main, 'src', 'a.js')) };

  expectHook({ ...base, code: 0, stderr: '' });
  walkTo(main, '901-bug', 'bug', 'implementation');
  expectHook({ ...base, code: 2, stderr: `${refusalText('missing', { taskId: '901-bug', template: 'bug' })}\n` });
  dropFloor(runFile(main, '901-bug'));
  expectHook({ ...base, code: 0, stderr: '' });

  git(main, 'checkout', '-q', '-b', 'fix/903-trivial', 'main');
  walkTo(main, '903-trivial', 'trivial-edit', 'implementation');
  expectHook({ ...base, code: 0, stderr: '' });
});

HOOK_TEST('a linked worktree reads the main checkout\'s feature folder, run and records', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo();
  writeFeature(main, '900-demo', { design: false });
  git(main, 'worktree', 'add', '-q', '-b', 'feat/900-demo', path.join(root, 'wt'));
  const wt = fs.realpathSync(path.join(root, 'wt'));
  const base = { cwd: wt, caseRoot: root, event: editEvent(path.join(wt, 'src', 'a.js')) };

  expectHook({ ...base, code: 2, stderr: ARTIFACT_MESSAGE });

  // A run in grace leaves the artifact check as it is.
  walkTo(main, '900-demo', 'feature', 'discovery');
  dropFloor(runFile(main, '900-demo'));
  expectHook({ ...base, code: 2, stderr: ARTIFACT_MESSAGE });
  fs.rmSync(runFile(main, '900-demo'));

  write(path.join(main, 'agent-docs', 'doflow', '900-demo', 'design', 'design.md'), '# design\n');
  expectHook({ ...base, code: 2, stderr: `${refusalText('missing', { taskId: '900-demo', template: 'feature' })}\n` });
  writeRecord(main, '900-demo.json', { taskId: '900-demo', taskClass: 'feature', state: 'READY' });
  expectHook({ ...base, code: 0, stderr: '' });

  // A record in exactly one other checkout decides; in two others the hook cannot tell which is meant.
  writeRecord(main, '900-demo.json', { taskId: '900-demo', taskClass: 'feature', state: 'NEEDS_EVIDENCE' });
  expectHook({
    ...base, code: 2,
    stderr: `${refusalText('not-ready', { taskId: '900-demo', template: 'feature', record: { state: 'NEEDS_EVIDENCE', evaluatedAt: EVALUATED_AT } })}\n`,
  });
  git(main, 'worktree', 'add', '-q', '-b', 'feat/920-other', path.join(root, 'wt2'));
  writeRecord(fs.realpathSync(path.join(root, 'wt2')), '900-demo.json', { taskId: '900-demo', taskClass: 'feature', state: 'NEEDS_EVIDENCE' });
  expectHook({ ...base, code: 0, stderr: '' });

  // A DoFlow sandbox sees no other checkout, so the main checkout's folder does not hold it.
  write(path.join(wt, '.doflow-worktree-base'), 'base\n');
  expectHook({ ...base, code: 0, stderr: '' });
});

HOOK_TEST('the hook reads records where the runtime does, and another feature\'s run with the same id is not this task\'s', { timeout: CASE_TIMEOUT_MS }, () => {
  const { root, main } = makeRepo('feat/900-demo');
  writeFeature(main, '900-demo');
  const envelope = envelopeEvent(main, path.join(main, 'src', 'a.js'), 'A.1');
  // `readiness` on a branch with no feature writes the record flat; the namespaced path is read
  // first and the flat one after, by the runtime and the hook alike.
  writeRecord(main, 'A.1.json', { taskId: 'A.1', taskClass: 'feature', state: 'READY' });
  expectHook({ cwd: main, caseRoot: root, event: envelope, code: 0, stderr: '' });

  const other = makeRepo('fix/901-bug');
  git(other.main, 'worktree', 'add', '-q', '-b', 'fix/other', path.join(other.root, 'w1'));
  const w1 = fs.realpathSync(path.join(other.root, 'w1'));
  walkTo(w1, '901-bug', 'bug', 'implementation');
  assert.strictEqual(JSON.parse(fs.readFileSync(runFile(w1, '901-bug'), 'utf8')).featureSlug, 'other');
  expectHook({ cwd: other.main, caseRoot: other.root, event: editEvent(path.join(other.main, 'src', 'a.js')), code: 0, stderr: '' });
});
