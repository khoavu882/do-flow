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
//     reachable at all had no test proving they actually reach the readiness profile (M6).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

/** A git-backed scratch project, same shape as runtime-evidence-write.test.js's own helper. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-orchestrate-'));
  const real = fs.realpathSync(dir);
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

// ────────────────────────────────────────────────────────────────── M6: --scope reaches the profile

test('M6: --scope reaches the readiness profile and clears a caller-assertable requirement', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't2', '--task-class', 'trivial-edit']);

  // trivial-edit's implementation stage requires target_identified (needs real evidence) and
  // scope_verified (satisfiable by taskProfile.scopeClear, which --scope is supposed to fill).
  // Without evidence for target_identified, completion must still be refused for THAT reason —
  // proving --scope alone doesn't fake full readiness, only its own requirement.
  const scopeOnly = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't2', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'single file, a.js only',
  ]);
  assert.notEqual(scopeOnly.status, 0);
  assert.match(scopeOnly.stderr, /target_identified|NEEDS_EVIDENCE/);

  json(cwd, ['evidence', '--task-id', 't2', '--action', 'add', '--kind', 'exact-search',
    '--provenance', 'extracted', '--provider', 'grep', '--capability', 'code.exact-search',
    '--locator', 'a.js:1', '--content', 'module.exports = { x: 1 }',
    '--establishes', 'target_identified']);

  const ready = json(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't2', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'single file, a.js only',
  ]);
  assert.equal(ready.status, 0, `expected READY once evidence + --scope both land: ${ready.stderr}`);
  const impl = ready.data.current ?? {};
  // Completion actually advanced past `implementation` — the concrete proof --scope closed the gate.
  assert.notEqual(impl.id, 'implementation');
});

test('M6: omitting --scope on the same stage stays NEEDS_EVIDENCE even with target evidence recorded', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't3', '--task-class', 'trivial-edit']);
  json(cwd, ['evidence', '--task-id', 't3', '--action', 'add', '--kind', 'exact-search',
    '--provenance', 'extracted', '--provider', 'grep', '--capability', 'code.exact-search',
    '--locator', 'a.js:1', '--content', 'module.exports = { x: 1 }']);
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't3', '--stage', 'implementation',
    '--task-class', 'trivial-edit',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /scope_verified|NEEDS_EVIDENCE/);
});

test('F-3: complete-stage refuses a --task-class that does not match the run\'s own class', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-mismatch', '--task-class', 'bug']);
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'reproduction']);
  json(cwd, ['orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'root-cause']);
  // bug's implementation stage carries a 5-requirement readiness template; trivial-edit's carries
  // only 2. Grading a bug run's gated stage against the wrong (looser) contract must be refused,
  // not silently evaluated — the same mismatch catchUp already refuses for the same reason.
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't-mismatch', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'x', '--verification-plan', 'npm test',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--task-class 'trivial-edit' does not match run 't-mismatch''s own class 'bug'/);
});

test('F-3: complete-stage with the matching --task-class evaluates readiness normally', () => {
  const cwd = project();
  json(cwd, ['orchestrate', '--action', 'start', '--task-id', 't-match', '--task-class', 'trivial-edit']);
  const res = run(cwd, [
    'orchestrate', '--action', 'complete-stage', '--task-id', 't-match', '--stage', 'implementation',
    '--task-class', 'trivial-edit', '--scope', 'x',
  ]);
  // Refused for NEEDS_EVIDENCE (no target_identified evidence recorded), not for a class mismatch —
  // proves the matching-class path still reaches the readiness engine rather than being blocked by
  // the new check itself.
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stderr, /does not match run/);
  assert.match(res.stderr, /target_identified|NEEDS_EVIDENCE/);
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
