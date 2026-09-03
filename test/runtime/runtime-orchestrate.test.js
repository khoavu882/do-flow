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
    '--locator', 'a.js:1', '--content', 'module.exports = { x: 1 }']);

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
