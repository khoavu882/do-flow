'use strict';
// runtime-orchestrate.test.js — CLI-level coverage for `doflow orchestrate`, added alongside the
// feature-023 remediation review. `handleOrchestrateCommand` had zero test coverage before this —
// not even indirectly, since test/runtime/workflow-orchestrator.test.js only exercises the
// WorkflowOrchestrator class in-process with an injected readinessEvaluate, never the real
// EvidenceLedger/ClaimsManager/ReadinessEngine wiring or the CLI's own stateRoot/task-class
// handling. That gap is exactly how three defects shipped unnoticed:
//   - `--task-class` omitted on a gated complete-stage surfaced as an opaque readiness exception
//     rather than a clear argument error naming the actual problem (M5).
//   - `stateRoot` defaulted to `process.cwd()` regardless of `--global`, so `orchestrate --global`
//     wrote its journal to $PWD while a `--global` evidence/readiness call on the same task read
//     and wrote $HOME (M3).
//   - the `--verification-plan`/`--scope` cascade inputs that make a gated stage completion
//     reachable at all had no test proving they actually reach the readiness profile (M6). Those
//     inputs now belong to `doflow readiness`, whose record a gated stage reads; the cases below
//     prove the stage is refused without a READY record and ignores the inputs given here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

/** A git-backed scratch project, same shape as runtime-evidence-write.test.js's own helper; removed
 * when `t` ends, when one is given. */
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-orchestrate-'));
  const real = fs.realpathSync(dir);
  if (t) t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return real;
}

function run(cwd, args, { home } = {}) {
  const res = spawnSync('node', [DOFLOW, ...args], {
    cwd,
    env: { ...process.env, HOME: home ?? cwd },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json(cwd, args, opts = {}) {
  const res = run(cwd, [...args, '--json'], opts);
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

// ─────────────────────────────────────────────────────────────────────── M5: clear --task-class error

test('M5: complete-stage on a gated stage without --task-class fails with an argument error, not an opaque readiness exception', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't1', '--task-class', 'trivial-edit']);
  const res = run(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't1', '--stage', 'implementation']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--task-class is required/);
  assert.match(res.stderr, /pass the same class this run was started/);
});

// ─────────────────────────────── the readiness record, not the handoff's own inputs, decides the stage

const NOTE = 'orchestrate: note: --verification-plan, --scope and --invariants are inputs to doflow-run readiness; this complete-stage did not read them.';
const runFileOf = (cwd, taskId) => path.join(cwd, '.doflow', 'state', 'orchestration', `${taskId}.json`);

test('complete-stage of a gated stage with no readiness record is refused, names the command, and changes nothing', (t) => {
  const cwd = project(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't2', '--task-class', 'trivial-edit']);
  const before = fs.readFileSync(runFileOf(cwd, 't2'));
  // The stated inputs no longer satisfy anything here: 1.21.0 graded them on this call.
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't2', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'x', '--verification-plan', 'y',
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[ERROR\] orchestrate: doflow gate readiness-before-implementation: task 't2' has no readiness record for the 'trivial-edit' template\. Next: doflow-run readiness --task-class trivial-edit --task-id t2, then gather what it lists until it reports READY\. Nothing was changed\. Edit-time check: /);
  assert.ok(res.stderr.includes(NOTE), res.stderr);
  assert.deepEqual(fs.readFileSync(runFileOf(cwd, 't2')), before, 'the run file is untouched');
});

test('complete-stage passes once readiness recorded READY in the same state root', (t) => {
  const cwd = project(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't3', '--task-class', 'trivial-edit']);
  json(cwd, ['evidence', '--task-id', 't3', '--action', 'add', '--kind', 'exact-search',
    '--provenance', 'extracted', '--provider', 'grep', '--capability', 'code.exact-search',
    '--locator', 'a.js:1', '--content', 'module.exports = { x: 1 }', '--establishes', 'target_identified']);
  const readiness = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 't3', '--scope', 'a.js']);
  assert.equal(readiness.data.state, 'READY', readiness.stdout);
  const done = json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't3', '--stage', 'implementation', '--task-class', 'trivial-edit']);
  assert.equal(done.status, 0, done.stderr);
  assert.notEqual(done.data.current?.id, 'implementation', 'completion advanced past the gated stage');
  assert.doesNotMatch(done.stderr, /note:/, 'no stated inputs, no note');
});

test('F-3: complete-stage refuses a --task-class that does not match the run\'s own class', (t) => {
  const cwd = project(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-mismatch', '--task-class', 'bug']);
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'reproduction']);
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'root-cause']);
  // bug's implementation stage is graded by the 'bug' template; trivial-edit's is a looser one.
  // Grading a bug run's gated stage against the wrong contract must be refused, not evaluated.
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'x', '--verification-plan', 'npm test',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--task-class 'trivial-edit' does not match run 't-mismatch''s own class 'bug'/);
});

test('F-3: complete-stage with the matching --task-class reaches the readiness check rather than the class check', (t) => {
  const cwd = project(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-match', '--task-class', 'trivial-edit']);
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't-match', '--stage', 'implementation',
    '--task-class', 'trivial-edit',
  ]);
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stderr, /does not match run/);
  assert.match(res.stderr, /doflow gate readiness-before-implementation: task 't-match' has no readiness record/);
});

test('a handoff with no run and no class is standalone, and says no readiness was required', (t) => {
  const cwd = project(t);
  const res = run(cwd, ['orchestrate', '--action', 'handoff', '--task-id', 't-solo', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('Handoff: standalone (no run exists for this task and no --task-class was given, so nothing was recorded and no readiness was required)'), res.stdout);
  assert.equal(fs.existsSync(runFileOf(cwd, 't-solo')), false);
});

test('a run started in the main checkout is read and updated from a linked worktree', (t) => {
  const cwd = project(t);
  const wt = `${cwd}-wt`;
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  execFileSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', 'feat/other', wt], { stdio: 'ignore' });
  // The run names its feature, `other`, which is the worktree's branch feature: only then is it this task's.
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-cross', '--task-class', 'feature', '--slug', 'other']);
  assert.equal(JSON.parse(fs.readFileSync(runFileOf(cwd, 't-cross'), 'utf8')).featureSlug, 'other');
  const status = json(wt, ['orchestrate', '--action', 'status', '--task-id', 't-cross']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.data.taskId, 't-cross');
  const annotated = json(wt, ['orchestrate', '--action', 'annotate', '--task-id', 't-cross', '--node', 'discovery', '--note', 'from the worktree']);
  assert.equal(annotated.status, 0, annotated.stderr);
  const journal = JSON.parse(fs.readFileSync(runFileOf(cwd, 't-cross'), 'utf8'));
  assert.equal(journal.history.at(-1).note, 'from the worktree', 'the main checkout\'s run was updated');
  assert.equal(fs.existsSync(runFileOf(wt, 't-cross')), false, 'no copy was created in the worktree');
});

test('a run started before readiness was recorded warns and proceeds at handoff; a run with the marker is refused', (t) => {
  const cwd = project(t);
  for (const taskId of ['t-old', 't-new']) {
    json(cwd, ['orchestrate', '--action', 'start', '--task-id', taskId, '--task-class', 'trivial-edit']);
  }
  // 1.21.0 never wrote the marker: removing it stands for a run that runtime started.
  const old = JSON.parse(fs.readFileSync(runFileOf(cwd, 't-old'), 'utf8'));
  delete old.readinessFloor;
  fs.writeFileSync(runFileOf(cwd, 't-old'), JSON.stringify(old, null, 2));

  const graced = run(cwd, ['orchestrate', '--action', 'handoff', '--task-id', 't-old', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.equal(graced.status, 0, graced.stderr);
  assert.match(graced.stdout, /^Handoff: completed$/m);
  assert.match(graced.stderr, /doflow gate readiness-before-implementation: warning: task 't-old' has no READY readiness record for the 'trivial-edit' template \(no record\), but its run started at .*, before DoFlow 1\.22\.0 recorded readiness, so this handoff proceeds\. From DoFlow 1\.23\.0 it is refused\./);
  assert.match(graced.stderr, /Edit-time check: /);

  const graceJson = JSON.parse(fs.readFileSync(runFileOf(cwd, 't-old'), 'utf8'));
  assert.equal(graceJson.program.find((n) => n.id === 'implementation').status, 'completed');

  const before = fs.readFileSync(runFileOf(cwd, 't-new'));
  const held = run(cwd, ['orchestrate', '--action', 'handoff', '--task-id', 't-new', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.equal(held.status, 1);
  assert.match(held.stderr, /task 't-new' has no readiness record for the 'trivial-edit' template/);
  assert.deepEqual(fs.readFileSync(runFileOf(cwd, 't-new')), before);
});

test('the JSON result of a handoff in grace carries readinessGrace', (t) => {
  const cwd = project(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-old-json', '--task-class', 'trivial-edit']);
  const old = JSON.parse(fs.readFileSync(runFileOf(cwd, 't-old-json'), 'utf8'));
  delete old.readinessFloor;
  fs.writeFileSync(runFileOf(cwd, 't-old-json'), JSON.stringify(old, null, 2));
  const res = json(cwd, ['orchestrate', '--action', 'handoff', '--task-id', 't-old-json', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.data.disposition, 'completed');
  assert.equal(res.data.readinessGrace.code, 'missing');
  assert.match(res.data.readinessGrace.message, /From DoFlow 1\.23\.0 it is refused/);
  assert.equal('readinessWarning' in res.data, false);
});

// ──────────────────────────────────────────────────────────────── M3: --global scoping is honored

test('M3: orchestrate --global writes the run journal under $HOME, matching evidence\'s own --global scoping', () => {
  const cwd = project();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-orchestrate-home-'));
  const started = json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-global', '--task-class', 'trivial-edit', '--global'], { home });
  assert.equal(started.status, 0);
  assert.ok(
    fs.existsSync(path.join(home, '.doflow', 'state', 'orchestration', 't-global.json')),
    'the run journal must land under $HOME, the same root --global evidence/readiness calls use',
  );
  assert.ok(
    !fs.existsSync(path.join(cwd, '.doflow', 'state', 'orchestration', 't-global.json')),
    'a --global run must not also write under the project root',
  );

  // status --global reads back the same run a second process wrote — proves this is round-trip
  // consistent, not just a write-side accident.
  const status = json(cwd, ['orchestrate', '--action', 'status', '--task-id', 't-global', '--global'], { home });
  assert.equal(status.status, 0);
  assert.equal(status.data.taskId, 't-global');
});

test('M3: without --global, orchestrate still writes under the project root (default unchanged)', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-local', '--task-class', 'trivial-edit']);
  assert.ok(fs.existsSync(path.join(cwd, '.doflow', 'state', 'orchestration', 't-local.json')));
});

// ─────────────────────────────────────────────────────────────── M6/H-1: catch-up through the CLI

test('M6: catch-up starts a fresh task through the CLI and reaches the first candidate stage', () => {
  const cwd = project();
  const s = json(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', 't-cu-1', '--task-class', 'feature', '--stage', 'discovery']);
  assert.equal(s.data.caughtUpTo, 'discovery');
  assert.equal(s.data.reason, 'reached-candidate');
});

test('H-1: catch-up through the CLI refuses an unknown candidate on a fresh task and persists no run at all', () => {
  const cwd = project();
  const res = run(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', 't-cu-typo', '--task-class', 'feature', '--stage', 'implementaton']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /candidate stage id\(s\) not declared by task class 'feature': implementaton/);
  assert.ok(!fs.existsSync(path.join(cwd, '.doflow', 'state', 'orchestration', 't-cu-typo.json')),
    'a failed first catch-up must not leave an orphan run journal on disk');
});

test('M6: catch-up comma-splits --stage into multiple candidates, matching do-test\'s own two-occurrence shape', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-cu-two', '--task-class', 'bug']);
  // 'reproduction' carries no readiness template, so it completes with no evidence needed — enough
  // to prove the comma-split candidate set is read correctly: with only the FIRST of two named
  // candidates done, catch-up must not misreport `already-completed` (which requires ALL of them
  // done) and must instead walk forward and correctly block on the gated stage ahead of the second
  // occurrence — full evidence for `bug`'s 5-requirement template is unit-tested separately and
  // isn't needed to prove this CLI-level plumbing.
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-cu-two', '--stage', 'reproduction']);
  const s = json(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', 't-cu-two', '--task-class', 'bug', '--stage', 'reproduction,regression-verification']);
  assert.equal(s.data.reason, 'blocked-on-mutating-stage:implementation');
  assert.notEqual(s.data.reason, 'already-completed:reproduction,regression-verification');
});

test('M6: annotate through the CLI appends history without touching cursor or state', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-annotate', '--task-class', 'feature']);
  const before = json(cwd, ['orchestrate', '--action', 'status', '--task-id', 't-annotate']);
  const s = json(cwd, ['orchestrate', '--action', 'annotate', '--task-id', 't-annotate', '--node', 'discovery', '--note', 're-reviewed after handoff']);
  assert.equal(s.data.current.id, before.data.current.id);
  assert.equal(s.data.state, before.data.state);
});

test('M6: --forced on decide-gate requires --note, and is refused on an action that does not read it', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-forced', '--task-class', 'feature']);
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-forced', '--stage', 'discovery']);

  const noNote = run(cwd, ['orchestrate', '--action', 'decide-gate', '--task-id', 't-forced', '--gate', 'gate-0', '--decision', 'approve', '--forced']);
  assert.notEqual(noNote.status, 0);
  assert.match(noNote.stderr, /forced gate decision requires a --note reason/);

  const withNote = json(cwd, ['orchestrate', '--action', 'decide-gate', '--task-id', 't-forced', '--gate', 'gate-0', '--decision', 'approve', '--forced', '--note', 'approved despite an open marker']);
  assert.equal(withNote.data.state, 'RUNNING');

  const misusedForced = run(cwd, ['orchestrate', '--action', 'catch-up', '--task-id', 't-forced', '--task-class', 'feature', '--stage', 'design', '--forced', '--note', 'x']);
  assert.notEqual(misusedForced.status, 0);
  assert.match(misusedForced.stderr, /'--forced' has no effect on action 'catch-up'/);
});

// ──────────────────────────────────────────────── 044: compaction after a recorded handoff (IC-013)

const HISTORY_REQUIREMENT = [
  '# Requirement', '', '## 1. Scope', '', 'Body.', '',
  '## 2. History', '', '- **FR-001** was reworded after review.', '',
].join('\n');

/** A scratch project holding feature `slug` (structured layout). With `register`, the feature gets
 * a decision register and a requirement.md whose History section has content to compact. */
function featureProject(slug, { register = true } = {}) {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, 'agent-docs', 'doflow', slug, 'intention'), { recursive: true });
  if (register) {
    const init = json(cwd, ['decision', '--action', 'init', '--slug', slug]);
    assert.equal(init.status, 0, init.stderr);
  }
  fs.writeFileSync(path.join(cwd, 'agent-docs', 'doflow', slug, 'intention', 'requirement.md'), HISTORY_REQUIREMENT);
  return cwd;
}

const handoff = (cwd, taskId, skill, extra = []) => json(cwd, ['orchestrate', '--action', 'handoff', '--task-id', taskId,
  '--calling-skill', skill, '--note', 'recorded', ...extra]);
const requirementOf = (cwd, slug) => fs.readFileSync(path.join(cwd, 'agent-docs', 'doflow', slug, 'intention', 'requirement.md'), 'utf8');

test('044: compaction runs after a completed handoff and again as unchanged after an annotated one', () => {
  const cwd = featureProject('070-x');
  const deferred = handoff(cwd, '070-x', 'do-design', ['--task-class', 'feature']);
  assert.equal(deferred.data.disposition, 'deferred');
  assert.equal('compaction' in deferred.data, false, 'a deferred handoff recorded nothing and must not compact');
  assert.equal(requirementOf(cwd, '070-x'), HISTORY_REQUIREMENT);

  json(cwd, ['orchestrate', '--action', 'decide-gate', '--task-id', '070-x', '--gate', 'gate-0', '--decision', 'approve']);
  const completed = handoff(cwd, '070-x', 'do-design');
  assert.equal(completed.status, 0);
  assert.equal(completed.data.disposition, 'completed');
  assert.equal(completed.data.compaction.status, 'compacted');
  assert.equal(completed.data.compaction.moved.length, 1);
  assert.match(requirementOf(cwd, '070-x'), /^Earlier entries: \[decisions\/history\/requirement\.md\]/m);
  assert.doesNotMatch(requirementOf(cwd, '070-x'), /was reworded after review/);

  const annotated = handoff(cwd, '070-x', 'do-design');
  assert.equal(annotated.data.disposition, 'annotated');
  assert.equal(annotated.data.compaction.status, 'unchanged');
});

test('044: no compaction field after a standalone handoff', () => {
  const cwd = featureProject('071-x');
  const standalone = handoff(cwd, '071-x', 'do-test');
  assert.equal(standalone.data.disposition, 'standalone');
  assert.equal('compaction' in standalone.data, false);
  assert.equal(requirementOf(cwd, '071-x'), HISTORY_REQUIREMENT);
});

test('044: a feature without a register, or a task id that is not a feature, reports skipped and still exits 0', () => {
  const cwd = featureProject('072-x', { register: false });
  const noRegister = handoff(cwd, '072-x', 'do-brainstorm', ['--task-class', 'feature']);
  assert.equal(noRegister.status, 0);
  assert.equal(noRegister.data.disposition, 'completed');
  assert.equal(noRegister.data.compaction.status, 'skipped');
  assert.match(noRegister.data.compaction.reason, /no decisions\/register\.json/);
  assert.equal(requirementOf(cwd, '072-x'), HISTORY_REQUIREMENT);

  const notFeature = handoff(project(), 'T-9', 'do-brainstorm', ['--task-class', 'feature']);
  assert.equal(notFeature.status, 0);
  assert.equal(notFeature.data.disposition, 'completed');
  assert.equal(notFeature.data.compaction.status, 'skipped');
  assert.ok(notFeature.data.compaction.reason);
});

test('044: a plan task id on a feature branch reports a missing feature folder, not a missing register', () => {
  const cwd = featureProject('075-x');
  execFileSync('git', ['-C', cwd, 'checkout', '-q', '-b', 'feat/075-x'], { stdio: 'ignore' });
  const result = handoff(cwd, 'B.1', 'do-brainstorm', ['--task-class', 'feature']);
  assert.equal(result.status, 0);
  assert.equal(result.data.disposition, 'completed');
  assert.deepEqual(result.data.compaction, { status: 'skipped', reason: 'no feature folder for task id "B.1"' });
  assert.equal(requirementOf(cwd, '075-x'), HISTORY_REQUIREMENT);
});

test('044: a compaction that cannot run is reported as failed without changing the disposition or exit code', () => {
  const cwd = featureProject('073-x');
  fs.writeFileSync(path.join(cwd, 'agent-docs', 'doflow', '073-x', 'decisions', 'register.json'), '{ not json');
  const result = handoff(cwd, '073-x', 'do-brainstorm', ['--task-class', 'feature']);
  assert.equal(result.status, 0);
  assert.equal(result.data.disposition, 'completed');
  assert.equal(result.data.compaction.status, 'failed');
  assert.match(result.data.compaction.reason, /not valid JSON/);
  assert.equal(requirementOf(cwd, '073-x'), HISTORY_REQUIREMENT);
});

test('045: a handoff that compacts one artifact and is refused by another reports partial with failed', () => {
  const cwd = featureProject('076-x');
  const featureDir = path.join(cwd, 'agent-docs', 'doflow', '076-x');
  const refused = `${HISTORY_REQUIREMENT}\n<!-- never closed\n`;
  fs.writeFileSync(path.join(featureDir, 'intention', 'requirement.md'), refused);
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# Plan\n\n## 9. History\n\n- one change\n');
  const result = handoff(cwd, '076-x', 'do-brainstorm', ['--task-class', 'feature']);
  assert.equal(result.status, 0, 'housekeeping never changes the exit code');
  assert.equal(result.data.disposition, 'completed');
  assert.equal(result.data.compaction.status, 'partial');
  assert.deepEqual(result.data.compaction.moved.map((m) => m.artifact), ['plan.md']);
  assert.deepEqual(result.data.compaction.failed.map((f) => [f.artifact, f.path]), [['requirement.md', 'intention/requirement.md']]);
  assert.equal(requirementOf(cwd, '076-x'), refused);
  assert.match(fs.readFileSync(path.join(featureDir, 'plan.md'), 'utf8'), /Earlier entries:/);
});

test('044: the human-readable handoff output names the compaction status', () => {
  const cwd = featureProject('074-x');
  const res = run(cwd, ['orchestrate', '--action', 'handoff', '--task-id', '074-x', '--task-class', 'feature', '--calling-skill', 'do-brainstorm', '--note', 'recorded']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Compaction: compacted$/m);
});

// ───────────────────────────── one record lookup, and runs matched to their feature across checkouts

/** A main checkout on `main` holding feature `900-demo` (with a register), plus a linked worktree on
 * `feat/900-demo`, both removed when `t` ends. */
function mainAndWorktree(t) {
  const cwd = project(t);
  execFileSync('git', ['-C', cwd, 'branch', '-M', 'main'], { stdio: 'ignore' });
  const folder = path.join(cwd, 'agent-docs', 'doflow', '900-demo');
  fs.mkdirSync(path.join(folder, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'decisions', 'register.json'), '{"version":1,"slug":"900-demo","nextId":1,"decisions":[]}\n');
  const wt = `${cwd}-wt`;
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  execFileSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', 'feat/900-demo', wt], { stdio: 'ignore' });
  return { cwd, wt };
}

function readyTrivialEdit(cwd, taskId, extra = []) {
  json(cwd, ['evidence', '--task-id', taskId, ...extra, '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted',
    '--provider', 'grep', '--capability', 'code.exact-search', '--locator', 'a.js:1', '--content', 'x', '--establishes', 'target_identified']);
  const ready = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', taskId, '--scope', 'a.js', ...extra]);
  assert.equal(ready.data.state, 'READY', ready.stdout);
  assert.equal(ready.data.record.written, true);
  return ready.data.record.file;
}

test('a flat record written in the main checkout is found by verify and handoff from the linked worktree', (t) => {
  const { cwd, wt } = mainAndWorktree(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 'T1', '--task-class', 'trivial-edit', '--slug', '900-demo']);
  const file = readyTrivialEdit(cwd, 'T1');
  assert.equal(file, path.join(cwd, '.doflow', 'state', 'readiness', 'T1.json'), 'no feature resolves on main, so the record is flat');

  const verify = run(wt, ['verify', '--task-id', 'T1', '--scope', 'a.js', '--json']);
  const readiness = JSON.parse(verify.stdout).readiness;
  assert.equal(readiness.applies, true, verify.stdout);
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.equal(readiness.record.file, file);

  const done = run(wt, ['orchestrate', '--action', 'handoff', '--task-id', 'T1', '--calling-skill', 'do-implement', '--note', 'n']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^Handoff: completed$/m);
});

test('a record written with --slug under the feature namespace is found by orchestrate from either checkout', (t) => {
  const { cwd, wt } = mainAndWorktree(t);
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 'T2', '--task-class', 'trivial-edit', '--slug', '900-demo']);
  const file = readyTrivialEdit(cwd, 'T2', ['--slug', '900-demo']);
  assert.equal(file, path.join(cwd, '.doflow', 'state', 'readiness', '900-demo', 'T2.json'));

  const fromWorktree = json(wt, ['orchestrate', '--action', 'status', '--task-id', 'T2']);
  assert.equal(fromWorktree.data.current.id, 'implementation');
  const verify = JSON.parse(run(wt, ['verify', '--task-id', 'T2', '--scope', 'a.js', '--json']).stdout);
  assert.equal(verify.readiness.ok, true, JSON.stringify(verify.readiness));

  const done = run(cwd, ['orchestrate', '--action', 'handoff', '--task-id', 'T2', '--calling-skill', 'do-implement', '--note', 'n', '--slug', '900-demo']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^Handoff: completed$/m);
});

test('a run with the same id for another feature in another worktree neither blocks start nor is taken over', (t) => {
  const cwd = project(t);
  execFileSync('git', ['-C', cwd, 'branch', '-M', 'main'], { stdio: 'ignore' });
  const w1 = `${cwd}-w1`;
  t.after(() => fs.rmSync(w1, { recursive: true, force: true }));
  execFileSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', 'fix/other', w1], { stdio: 'ignore' });
  json(w1, ['orchestrate', '--action', 'start', '--task-id', 'A.1', '--task-class', 'bug']);
  const theirs = fs.readFileSync(runFileOf(w1, 'A.1'));

  const missing = run(cwd, ['orchestrate', '--action', 'status', '--task-id', 'A.1']);
  assert.equal(missing.status, 1, 'the other feature\'s run is not this checkout\'s task');
  assert.match(missing.stderr, /No workflow run for task 'A\.1'/);

  const started = json(cwd, ['orchestrate', '--action', 'start', '--task-id', 'A.1', '--task-class', 'bug']);
  assert.equal(started.status, 0, started.stderr);
  assert.ok(fs.existsSync(runFileOf(cwd, 'A.1')), 'start is always local');
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 'A.1', '--stage', 'reproduction']);
  assert.deepEqual(fs.readFileSync(runFileOf(w1, 'A.1')), theirs, 'the other worktree\'s run is untouched');
});
