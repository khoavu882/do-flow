'use strict';

// Feature 081 D.3 (requirement §6, IC-004 to IC-021; DEC-036, DEC-042, DEC-050, DEC-053, DEC-055):
// the requirement scenarios end to end.
//
// Every scenario goes through `handleWorkerCommand` in process with fake worker descriptors injected
// (DEC-036); a run spawns the real detached supervisor, which launches the fake harness CLI. The
// project is a real git repository with a linked execution worktree made by `git worktree add`, and
// the claim follows RK13: 080 `start`, then `claim --mode subagent --epoch 1 --exec-worktree
// <linked worktree>`, whose top is not the caller's own (DEC-042).
//
// No real harness runs (NFR-002): every descriptor names a `fake-<id>` binary, the child PATH is a
// scratch bin/ holding only the fake CLI links and a link to git (DEC-055) plus the node directory,
// and the caller env sets every DOFLOW_* identity variable explicitly. Process cases skip on win32
// (DEC-008, DEC-050). The credentials scenario is D.4's (test/runtime/worker-secrets.test.js), and
// the forwarding scenario's real-launcher reruns are B.4's (test/runtime/worker-launcher.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { linkBin, writeScenario, readLog, kindOf } = require('../helper/fake-harness-cli.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
const ORCHESTRATION_AT_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'src');
const { handleWorkerCommand } = require(path.join(SRC, 'runtime', 'worker', 'command.ts'));
const { storeFileFor, readRuns } = require(path.join(SRC, 'runtime', 'worker', 'run-store.ts'));
const { OUTPUT_MAX_BYTES } = require(path.join(SRC, 'runtime', 'worker', 'supervisor.ts'));
const readiness = require(path.join(SRC, 'runtime', 'worker', 'readiness.ts'));
const tree = require(path.join(SRC, 'runtime', 'worker', 'process-tree.ts'));
const attempts = require(path.join(SRC, 'runtime', 'task-attempts.ts'));
const { loadRegistry, WORKER_CAPABILITIES } = require(path.join(SRC, 'registry', 'index.ts'));

const SLUG = 'feat-e2e';
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const SUCCESS: any = { type: 'result', status: 'success', summary: 'all done' };
const GATE = 'blocking-hook:pre-implementation-gate';
/** A coverage whose only claude row for the gate is an observation-class pre-tool hook. */
const OBSERVATION_COVERAGE = Object.freeze({
  profiles: { any: { description: 'test profile' } },
  rows: [
    { harness: 'claude', policy: 'pre-implementation-gate', event: 'PreToolUse', profile: 'any', timing: 'pre-tool', class: 'observation', wired: true, verification: 'verified' },
    { harness: 'claude', policy: '*', event: 'SessionStart', profile: 'any', timing: 'session', class: 'observation', wired: true, verification: 'verified' },
  ],
});
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

const clone = (id: any) => structuredClone(DESCRIPTORS[id]);
const unknownEntry = (reason: any) => ({ status: 'unknown', evidence: [], verification: 'Not declared by this test descriptor.', verifiedOn: '2026-10-15', reason });
const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

/** The claude fake descriptor under another binary name. */
function claudeAs(binary: any) {
  const worker = clone('claude');
  worker.cli.binary = binary;
  return worker;
}

function gitEnv() {
  const env: any = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

function git(cwd: any, ...args: any[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: gitEnv(), stdio: 'ignore' });
}

/**
 * A git repository `repo` with plan.md and a linked execution worktree `exec`, a scratch bin/ with
 * the fake CLI under `names` and git, and a main-session caller env. `claim` is the claim's mode, or
 * null for a started run with no claim yet.
 */
function project(t: any, { scenario = {}, descriptors = { claude: DESCRIPTORS.claude }, names, claim = 'subagent' }: any = {}) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-e2e-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'init');
  const planFile = path.join(repo, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const execWorktree = path.join(dir, 'exec');
  git(repo, 'worktree', 'add', '-q', '-b', 'exec-wt', execWorktree);

  const bin = path.join(dir, 'bin');
  const childPath = linkBin(bin, names ?? Object.values(descriptors).map((worker: any) => worker.cli.binary));
  fs.symlinkSync(GIT, path.join(bin, 'git'));
  fs.mkdirSync(path.join(dir, 'home'));
  const log = path.join(dir, 'fake.log');
  const env: any = {
    PATH: childPath,
    HOME: path.join(dir, 'home'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_HARNESS_SCENARIO: writeScenario(dir, scenario),
    FAKE_HARNESS_LOG: log,
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: repo,
  };
  delete env.DOFLOW_ATTEMPT;
  const ledger = attempts.storeFile(repo, SLUG);
  const common: any = { file: ledger, fsImpl: fs, roots: [repo], slug: SLUG, env, cwd: repo };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const doClaim = (mode: any) => {
    const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode, epoch: 1, ...(mode === 'subagent' ? { execWorktree } : {}) });
    assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
    return claimed.token;
  };
  const p: any = { dir, repo, execWorktree, env, log, ledger, common, store: storeFileFor(repo, SLUG), descriptors, token: null };
  if (claim) p.token = doClaim(claim);
  p.claim = (mode: any) => { p.token = doClaim(mode); return p.token; };
  p.promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(p.promptFile, 'do the task');
  p.setScenario = (next: any) => writeScenario(dir, next);

  /** `doflow-run worker` in process: `{ exit, body }` from the printed JSON. */
  p.worker = async (options: any) => {
    const lines: any = [];
    const saved: any = { log: console.log, error: console.error, exitCode: process.exitCode };
    console.log = (line) => lines.push(line);
    console.error = (line) => lines.push(line);
    let exit;
    try {
      exit = await handleWorkerCommand({ descriptors: p.descriptors, env: p.env, cwd: repo, json: true, ...options });
    } finally {
      console.log = saved.log;
      console.error = saved.error;
      process.exitCode = saved.exitCode;
    }
    assert.equal(lines.length, 1, lines.join('\n'));
    return { exit, body: JSON.parse(lines[0]) };
  };
  p.probe = async (options: any = {}) => {
    const { exit, body } = await p.worker({ action: 'probe', ...options });
    assert.equal(exit, 0, JSON.stringify(body));
    assert.equal(body.disposition, 'probed');
    return body;
  };
  p.run = (options: any = {}) => p.worker({ action: 'run', slug: SLUG, harness: 'claude', task: 'A.1', token: p.token, promptFile: p.promptFile, timeoutSeconds: 60, ...options });
  p.status = (options: any) => p.worker({ action: 'status', slug: SLUG, ...options });
  p.kinds = () => readLog(log).map((line: any) => kindOf(line.argv));
  p.attempt = (token: any = p.token) => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks['A.1'].attempts.find((a: any) => a.token === token);
  p.taskState = () => attempts.status({ file: ledger, fsImpl: fs, roots: [repo], slug: SLUG }).tasks.find((row: any) => row.id === 'A.1').state;
  p.record = (runId: any) => readRuns(p.store)[runId];
  p.outFile = (runId: any) => path.join(repo, '.doflow', 'state', 'worker-output', `${runId}.out.log`);
  return p;
}

async function waitFor(check: any, ms: any = 15000, label: any = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function pidAlive(pid: any) {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}

/** Kills every process of a run's worker and supervisor, for teardown. */
function killRun(record: any) {
  for (const proc of [record?.worker, record?.supervisor]) {
    if (!proc?.pid) continue;
    try { process.kill(-proc.pgid, 'SIGKILL'); } catch { /* ended */ }
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ended */ }
  }
}

/** The RUNNING assertion of the three-outcomes scenario. */
function assertRunning(p: any) {
  assert.equal(p.taskState(), 'RUNNING');
  const attempt = p.attempt();
  assert.equal(attempt.state, 'active');
  assert.equal(attempt.result ?? null, null);
}

// ── Scenario: Worker capabilities declared honestly (US1, FR-001) ────────────────────────────

test('worker capabilities declared honestly: every value supported, unsupported or unknown with evidence and a date; orchestration unchanged', () => {
  const reg = loadRegistry({ repoRoot: REPO });
  assert.equal(reg.harnesses.length, 7);
  for (const harness of reg.harnesses) {
    assert.ok(harness.worker, `${harness.id} carries a worker block`);
    for (const key of Object.keys(WORKER_CAPABILITIES)) {
      const entry = harness.worker[key];
      const where = `${harness.id} worker.${key}`;
      assert.ok(['supported', 'unsupported', 'unknown'].includes(entry.status), where);
      assert.ok(Array.isArray(entry.evidence), where);
      if (entry.status === 'supported') assert.ok(entry.evidence.length > 0, `${where} names its evidence`);
      else assert.ok(typeof entry.reason === 'string' && entry.reason, `${where} gives its reason`);
      assert.match(entry.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, where);
    }
    // 118 IC-004 adds `nest` after be752d8; the copy covers the five operations that existed then.
    const { nest: _nest, ...atBe752d8 } = harness.orchestration;
    assert.deepEqual(atBe752d8, ORCHESTRATION_AT_BE752D8[harness.id], `${harness.id} orchestration`);
  }
});

// ── Scenario: Discover starts no model (US1, FR-002, NFR-005) ─────────────────────────────────

test('discover starts no model: two fake CLIs present with versions, five absent, no run invocation', POSIX, async (t) => {
  const ids = loadRegistry({ repoRoot: REPO }).harnesses.map((h: any) => h.id);
  const descriptors = Object.fromEntries(ids.map((id: any) => [id, claudeAs(`fake-${id}`)]));
  const p: any = project(t, {
    descriptors, names: ['fake-claude', 'fake-codex'], claim: null,
    scenario: { byBinary: { 'fake-claude': { version: [{ print: 'fake-claude 1.2.3' }] }, 'fake-codex': { version: [{ print: 'fake-codex 4.5.6' }] } } },
  });
  const { exit, body } = await p.worker({ action: 'discover' });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.disposition, 'discovered');
  assert.equal(body.harnesses.length, 7);
  const byId = Object.fromEntries(body.harnesses.map((entry: any) => [entry.harness, entry]));
  assert.deepEqual([byId.claude.present, byId.claude.version], [true, 'fake-claude 1.2.3']);
  assert.deepEqual([byId.codex.present, byId.codex.version], [true, 'fake-codex 4.5.6']);
  for (const id of ids.filter((id: any) => id !== 'claude' && id !== 'codex')) {
    assert.deepEqual([byId[id].present, byId[id].reason], [false, 'not-on-path'], id);
  }
  assert.deepEqual(p.kinds(), ['version', 'version'], 'no fake CLI saw a model-run invocation');
});

// ── Scenario: Readiness facts kept apart (US1, FR-003) ────────────────────────────────────────

test('readiness facts kept apart: installed and runnable yes, quota and login unknown, a hanging probe unknown timeout', POSIX, async (t) => {
  const quiet = clone('claude');
  quiet.loginProbe = unknownEntry('this fake prints nothing about login');
  const hanging = claudeAs('fake-codex');
  hanging.loginProbe = unknownEntry('this fake prints nothing about login');
  const p: any = project(t, {
    descriptors: { claude: quiet, codex: hanging }, claim: null,
    scenario: { version: [{ print: 'fake 1.0' }], runnable: [{ exit: 0 }], byBinary: { 'fake-codex': { runnable: [{ sleep: 20000 }] } } },
  });
  const started = Date.now();
  const body = await p.probe({ need: 'login' });
  t.diagnostic(`probe with one hanging runnable probe took ${Date.now() - started} ms`);
  const facts = Object.fromEntries(body.harnesses.map((entry: any) => [entry.harness, entry.facts]));
  assert.deepEqual([facts.claude.installed.state, facts.claude.installed.reason], ['yes', 'version-answered']);
  assert.deepEqual([facts.claude.runnable.state, facts.claude.runnable.reason], ['yes', 'exit 0']);
  for (const name of ['installed', 'runnable', 'quota', 'login']) assert.match(facts.claude[name].at, ISO, name);
  assert.equal(facts.claude.quota.state, 'unknown');
  assert.equal(facts.claude.login.state, 'unknown');
  assert.deepEqual([facts.codex.runnable.state, facts.codex.runnable.reason], ['unknown', 'timeout']);
  assert.equal(facts.codex.installed.state, 'yes', 'a hanging runnable probe leaves installed apart');
  assert.equal(p.kinds().includes('run'), false);
  // FR-003 / IC-005: task-eligible is the third fact, against the baseline and --need.
  const eligible = Object.fromEntries(body.harnesses.map((entry: any) => [entry.harness, entry.taskEligible]));
  assert.deepEqual(eligible.claude, { eligible: false, gaps: [{ requirement: 'login', result: 'unknown', reason: 'no-free-probe-declared' }] },
    'the baseline is met; the --need the fake cannot meet is the one gap');
  assert.equal(eligible.codex.eligible, false);
  assert.deepEqual(eligible.codex.gaps.map((gap: any) => gap.requirement), ['runnable', 'login']);
});

// ── IC-005 probe records live under the lifecycle project root (CF-3) ─────────────────────────

test('a probe from a subdirectory records under the project root; select from the root reads it probed', POSIX, async (t) => {
  const p: any = project(t, { claim: null, scenario: { version: [{ print: 'fake 1.0' }] } });
  const sub = path.join(p.repo, 'sub', 'dir');
  fs.mkdirSync(sub, { recursive: true });
  await p.probe({ cwd: sub });
  assert.equal(fs.existsSync(path.join(sub, '.doflow')), false, 'no store under the caller subdirectory');
  assert.ok(readiness.readProbeRecord(p.repo, 'claude'), 'the record is under the project root');
  const { exit, body } = await p.worker({ action: 'select' });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual([body.disposition, body.harness], ['selected', 'claude']);
});

// ── Scenario: Model check needs a request and a budget (US2, FR-005) ──────────────────────────

test('model check needs a request and a budget: not run unrequested, refused without a budget, run once with both', POSIX, async (t) => {
  const p: any = project(t, {
    descriptors: { opencode: DESCRIPTORS.opencode }, claim: null,
    scenario: { 'model-check:hooks-roundtrip': [{ print: 'checked' }] },
  });
  await p.probe({ harness: 'opencode' });
  assert.equal(p.kinds().some((kind: any) => kind.startsWith('model-check:')), false, 'probe without a request runs no model check');

  const before = p.kinds().length;
  const noBudget = await p.worker({ action: 'probe', harness: 'opencode', modelCheck: 'hooks-roundtrip' });
  assert.deepEqual([noBudget.exit, noBudget.body.disposition, noBudget.body.reason], [1, 'refused', 'budget-required']);
  assert.equal(p.kinds().length, before, 'a refused request starts no process');

  await p.probe({ harness: 'opencode', modelCheck: 'hooks-roundtrip', budgetTokens: 1000 });
  assert.equal(p.kinds().filter((kind: any) => kind === 'model-check:hooks-roundtrip').length, 1);
  const check = readiness.readProbeRecord(p.repo, 'opencode').modelChecks['hooks-roundtrip'];
  assert.deepEqual(check.usage, { tokens: 500, basis: 'estimated', budget: 1000 });
});

// ── Scenario: Describe against a task (US1, FR-006) ───────────────────────────────────────────

test('describe against a task: read-only met, the blocking hook failed as observation-only, probe times shown', POSIX, async (t) => {
  const worker = clone('claude');
  worker.profile = 'any';
  const p: any = project(t, { descriptors: { claude: worker }, claim: null, scenario: { version: [{ print: 'fake 1.0' }] } });
  await p.probe();
  const { exit, body } = await p.worker({ action: 'describe', harness: 'claude', need: GATE, coverage: OBSERVATION_COVERAGE });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.disposition, 'described');
  const byId = Object.fromEntries(body.requirements.map((r: any) => [r.requirement, r]));
  assert.equal(byId['read-only'].result, 'met');
  assert.equal(byId[GATE].result, 'failed');
  assert.match(byId[GATE].reason, /^observation/);
  assert.match(byId.installed.at, ISO);
  for (const name of readiness.FACTS) assert.match(body.probe[name].at, ISO, name);
  assert.equal(body.eligible, false);
});

// ── Scenario: Unsupported enforcement excludes the task (US1, US5, FR-007) ────────────────────

test('unsupported enforcement excludes the task: forwarding unknown makes the harness ineligible naming identity forwarding', POSIX, async (t) => {
  const p: any = project(t, { claim: null, scenario: { version: [{ print: 'fake 1.0' }] } });
  const probed = await p.probe();
  assert.equal(probed.harnesses[0].facts.identityForwarded.state, 'unknown');
  const described = await p.worker({ action: 'describe', harness: 'claude', need: 'identity-forwarding' });
  assert.equal(described.body.eligible, false);
  const selected = await p.worker({ action: 'select', need: 'identity-forwarding' });
  assert.deepEqual([selected.exit, selected.body.disposition], [1, 'none-eligible']);
  assert.deepEqual(selected.body.candidates[0].gaps, [{ requirement: 'identity-forwarding', result: 'unknown', reason: 'hooks-not-loaded' }]);
});

// ── Scenario: Bare mode not assumed (US5, FR-008) ─────────────────────────────────────────────

test('bare mode not assumed: a worker mode that skips the hooks reads hooks-loaded no and a task needing hooks is ineligible', POSIX, async (t) => {
  const p: any = project(t, { descriptors: { codex: DESCRIPTORS.codex }, claim: null, scenario: {} });
  p.setScenario({ hooks: [{ frontDoors: { mirror: path.join(p.dir, 'no-mirror'), harness: 'codex' } }] });
  const probed = await p.probe();
  assert.equal(probed.harnesses[0].facts.hooksLoaded.state, 'no');
  const hooksLine = readLog(p.log).find((line: any) => kindOf(line.argv) === 'hooks');
  assert.ok(hooksLine.argv.includes('--skip-front-doors'), 'the probe ran the mode that skips the front doors');
  const described = await p.worker({ action: 'describe', harness: 'codex', need: 'hooks-loaded' });
  assert.equal(described.body.eligible, false);
  const gap = described.body.requirements.find((r: any) => r.requirement === 'hooks-loaded');
  assert.notEqual(gap.result, 'met');
});

// ── Scenario: Identity reaches hook processes (US5, FR-009), the probe half ────────────────────

test('identity reaches hook processes: a binding is forwarding observed, a session start alone is not; identity rows stay limitation', POSIX, async (t) => {
  const p: any = project(t, { descriptors: { claude: DESCRIPTORS.claude, codex: claudeAs('fake-codex') }, claim: null });
  const fixed: any = { run: 'probe0000cccc', lineage: 'p0000cccc' };
  const future = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  p.setScenario({
    byBinary: {
      'fake-claude': { hooks: [{ write: { path: `xdg/doflow/session-env/sessions/L.${fixed.run}.${fixed.lineage}.1/bound`, content: 'fake-session\n' } }] },
      'fake-codex': { hooks: [{ write: { path: 'xdg/doflow/sessions.log', content: `${future} START s-1 ${p.repo}\n` } }] },
    },
  });
  const env: any = { ...p.env, XDG_CONFIG_HOME: path.join(p.repo, 'xdg') };
  // One probe identity per harness, so one fake's binding cannot answer for the other.
  const other: any = { run: 'probe0000dddd', lineage: 'p0000dddd' };
  const facts: any = {};
  for (const [harness, identity] of [['claude', fixed], ['codex', other]]) {
    const probed = await readiness.probe({ descriptors: p.descriptors, harness, env, cwd: p.repo, probeIdentity: () => identity });
    facts[harness] = probed.harnesses[0].facts;
  }
  assert.deepEqual([facts.claude.identityForwarded.state, facts.claude.identityForwarded.reason], ['yes', 'unit-binding-observed']);
  assert.deepEqual([facts.codex.hooksLoaded.state, facts.codex.identityForwarded.state], ['yes', 'no']);
  const lifecycle = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'lifecycle.json'), 'utf8'));
  const rows: any = [];
  const walk = (value: any) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (value.behaviour === 'identity') rows.push(value);
      else Object.values(value).forEach(walk);
    }
  };
  walk(lifecycle);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.status, 'limitation', row.harness);
});

// ── Scenario: Run needs the main session's claim (US3, FR-010) ────────────────────────────────

test('run needs the main session\'s claim: runs in the execution worktree with worker identity; a stale token is refused; the attempt stays active', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ emit: SUCCESS }] } });
  await p.probe();
  const stale = p.token;
  assert.equal(attempts.release({ ...p.common, task: 'A.1', token: stale, reason: 'make the first token stale' }).disposition, 'released');
  const token = p.claim('subagent');
  assert.notEqual(token, stale);

  const refused = await p.run({ token: stale });
  assert.deepEqual([refused.exit, refused.body.reason, refused.body.activeToken], [1, 'token-mismatch', token]);
  assert.equal(fs.existsSync(p.store), false, 'a refused run writes no run store');

  const { exit, body } = await p.run({ wait: true });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual([body.disposition, body.state], ['started', 'exited']);
  const ran = readLog(p.log).filter((line: any) => kindOf(line.argv) === 'run');
  assert.equal(ran.length, 1);
  assert.equal(fs.realpathSync(ran[0].cwd), p.execWorktree, 'the worker runs in the claim\'s execution worktree');
  assert.deepEqual(ran[0].doflowEnv, {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: String(token), DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: p.execWorktree,
  });
  assert.equal(body.identity.attempt, String(token));
  assert.equal(body.attemptActive, true);
  assertRunning(p);
  assert.equal(p.attempt(token).finishedAt ?? null, null, 'the run finishes nothing');
});

// ── Scenario: Read-only violation caught (US3, FR-011) ────────────────────────────────────────

test('read-only violation caught: the change is named and the report is not offered', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ write: { path: 'notes.txt', content: 'written by the worker\n' } }, { emit: SUCCESS }] } });
  await p.probe();
  const { exit, body } = await p.run({ wait: true });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.readOnly.status, 'violated');
  assert.ok(body.readOnly.changes.some((change: any) => JSON.stringify(change).includes('notes.txt')), JSON.stringify(body.readOnly.changes));
  assert.equal(body.report.status, 'success');
  assert.equal(body.resultOffered, false);
  assert.ok(body.withheld.includes('read-only-violation'));
});

// ── Scenario: Three outcomes stay apart (US3, FR-012) ─────────────────────────────────────────

test('three outcomes stay apart: exit 0, report success, no verified outcome, task still RUNNING', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ emit: SUCCESS }, { exit: 0 }] } });
  await p.probe();
  const { exit, body } = await p.run({ wait: true });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual([body.process.kind, body.process.code], ['exited', 0]);
  assert.equal(body.report.status, 'success');
  assert.equal(body.verified, null);
  assert.equal(body.resultOffered, true);
  assertRunning(p);
});

test('control: calling 080 finish from the fake worker\'s report fails the RUNNING assertion', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ emit: SUCCESS }] } });
  await p.probe();
  const { body } = await p.run({ wait: true });
  assert.equal(body.report.status, 'success');
  assertRunning(p);
  const finished = attempts.finish({ ...p.common, task: 'A.1', token: p.token, result: 'BLOCKED', reason: body.report.summary });
  assert.equal(finished.disposition, 'applied', JSON.stringify(finished));
  assert.throws(() => assertRunning(p), assert.AssertionError);
});

// ── Scenario: Soft denial with exit 0 (US3, FR-013) ───────────────────────────────────────────

test('soft denial with exit 0: the run is reported denied with the action named, not success', POSIX, async (t) => {
  const denial: any = { type: 'permission-denied', action: 'write-file', detail: 'writing a.js was denied' };
  const p: any = project(t, { scenario: { run: [{ emit: [denial, SUCCESS] }, { exit: 0 }] } });
  await p.probe();
  const { body } = await p.run({ wait: true });
  assert.equal(body.process.code, 0);
  assert.equal(body.report.status, 'denied');
  assert.equal(body.report.denials[0].action, 'write-file');
  assert.equal(body.resultOffered, false);
  assert.ok(body.withheld.includes('report-denied'));
});

// ── Scenario: Status of a lost process (US4, FR-014) ──────────────────────────────────────────

test('status of a lost process: a run whose supervisor and worker are gone with no end reads unknown, not exited', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ sleep: 30000 }] } });
  await p.probe();
  const { exit, body } = await p.run();
  assert.equal(exit, 0, JSON.stringify(body));
  const record = p.record(body.runId);
  t.after(() => killRun(record));
  assert.equal(record.phase, 'running');
  process.kill(record.supervisor.pid, 'SIGKILL');
  process.kill(-record.worker.pgid, 'SIGKILL');
  await waitFor(() => tree.alive(record.supervisor) === false && tree.alive(record.worker) === false, 10000, 'both processes gone');
  const status = await p.status({ workerRun: body.runId });
  assert.equal(status.exit, 0);
  assert.deepEqual([status.body.state, status.body.reason], ['unknown', 'process-lost']);
  assert.equal(p.record(body.runId).end ?? null, null, 'status records no end');
});

// ── Scenario: Timeout ends the run (US4, FR-015) ──────────────────────────────────────────────

test('timeout ends the run: past a 1-second bound the tree is ended and the run is timed-out', POSIX, async (t) => {
  const pidFile = (dir: any) => path.join(dir, 'grandchild.pid');
  const p: any = project(t, {});
  p.setScenario({ run: [{ spawnChild: { pidFile: pidFile(p.dir) } }, { sleep: 30000 }] });
  await p.probe();
  const started = Date.now();
  const { exit, body } = await p.run({ timeoutSeconds: 1, wait: true });
  t.diagnostic(`timed-out run ended in ${Date.now() - started} ms`);
  t.after(() => killRun(p.record(body.runId)));
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.state, 'timed-out');
  assert.equal(body.cleanup.status, 'verified', JSON.stringify(body.cleanup));
  const grandchild = Number(fs.readFileSync(pidFile(p.dir), 'utf8'));
  assert.equal(await waitFor(() => !pidAlive(grandchild), 3000, 'grandchild gone'), true);
  assert.equal(tree.groupAlive(p.record(body.runId).worker.pgid, p.record(body.runId).worker.start), false);
  assert.equal(body.resultOffered, false);
});

// ── Scenario: Cancel ends the tree (US4, FR-016, NFR-004) ─────────────────────────────────────

test('cancel ends the tree: a grandchild tree and a worker ignoring SIGTERM end, the attempt is CANCELLED with a reason, neither is success', POSIX, async (t) => {
  const cases: any = [
    ['grandchild', (dir: any) => [{ spawnChild: { pidFile: path.join(dir, 'grandchild.pid') } }, { print: 'ready' }, { sleep: 30000 }]],
    ['ignoreTerm', () => [{ ignoreTerm: true }, { print: 'ready' }, { sleep: 30000 }]],
  ];
  for (const [label, steps] of cases) {
    const p: any = project(t, {});
    p.setScenario({ run: steps(p.dir) });
    await p.probe();
    const { exit, body } = await p.run();
    assert.equal(exit, 0, `${label}: ${JSON.stringify(body)}`);
    const record = p.record(body.runId);
    t.after(() => killRun(record));
    await waitFor(() => fs.existsSync(p.outFile(body.runId)) && fs.readFileSync(p.outFile(body.runId), 'utf8').includes('ready'), 10000, `${label} ready`);
    const started = Date.now();
    const cancelled = await p.worker({ action: 'cancel', slug: SLUG, workerRun: body.runId, by: 'main', reason: `stop the ${label} run` });
    t.diagnostic(`${label} cancel took ${Date.now() - started} ms`);
    assert.equal(cancelled.exit, 0, `${label}: ${JSON.stringify(cancelled.body)}`);
    assert.deepEqual([cancelled.body.disposition, cancelled.body.endState, cancelled.body.attemptCancelled], ['cancelled', 'cancelled', true], label);
    const { cleanup } = cancelled.body;
    // macOS and Linux: no survivor; a survivor would be named in cleanup.survivors.
    assert.deepEqual([cleanup.status, cleanup.survivors ?? []], ['verified', []], `${label}: ${JSON.stringify(cleanup)}`);
    assert.equal(tree.groupAlive(record.worker.pgid, record.worker.start), false, label);
    if (label === 'grandchild') {
      const grandchild = Number(fs.readFileSync(path.join(p.dir, 'grandchild.pid'), 'utf8'));
      assert.equal(await waitFor(() => !pidAlive(grandchild), 3000, 'grandchild gone'), true);
    }
    const attempt = p.attempt();
    assert.equal(attempt.state, 'cancelled', label);
    assert.equal(attempt.cancel?.reason, `stop the ${label} run`, label);
    assert.equal(p.taskState(), 'CANCELLED', label);
    const status = await p.status({ workerRun: body.runId });
    assert.equal(status.body.state, 'cancelled', label);
    assert.equal(status.body.resultOffered, false, label);
  }
});

// ── Scenario: No children by default (US5, FR-017) ────────────────────────────────────────────

test('no children by default: spawn denial unknown is ineligible for any task, naming spawn denial', POSIX, async (t) => {
  const worker = clone('claude');
  worker.spawnDenial = unknownEntry('this fake declares no spawn-denial flag');
  const p: any = project(t, { descriptors: { claude: worker }, scenario: { run: [{ emit: SUCCESS }] } });
  await p.probe();
  const { exit, body } = await p.run();
  assert.deepEqual([exit, body.reason], [1, 'harness-ineligible']);
  assert.ok(body.gaps.some((gap: any) => gap.requirement === 'spawn-denial'), JSON.stringify(body.gaps));
  for (const need of [undefined, 'login']) {
    const selected = await p.worker({ action: 'select', ...(need ? { need } : {}) });
    assert.equal(selected.body.disposition, 'none-eligible');
    assert.ok(selected.body.candidates[0].gaps.some((gap: any) => gap.requirement === 'spawn-denial'));
  }
  assert.equal(p.kinds().includes('run'), false);
  assert.equal(fs.existsSync(p.store), false);
});

// ── Scenario: Pair chosen from probes, fallback honest (US1, FR-018) ──────────────────────────

test('pair chosen from probes, fallback honest: the eligible one is chosen; with none, each gap is named and the claim records sequential', POSIX, async (t) => {
  const noSpawnDenial = claudeAs('fake-codex');
  noSpawnDenial.spawnDenial = unknownEntry('this fake declares no spawn-denial flag');
  const p: any = project(t, {
    descriptors: { claude: DESCRIPTORS.claude, codex: noSpawnDenial, antigravity: DESCRIPTORS.antigravity }, claim: null,
    scenario: { version: [{ print: 'fake 1.0' }] },
  });
  await p.probe();
  const chosen = await p.worker({ action: 'select' });
  assert.equal(chosen.exit, 0, JSON.stringify(chosen.body));
  assert.deepEqual([chosen.body.disposition, chosen.body.harness], ['selected', 'claude']);
  assert.match(chosen.body.reason, /^first eligible harness in registry order; met: .*; probed at /);
  const gaps = Object.fromEntries(chosen.body.candidates.map((c: any) => [c.harness, c.gaps.map((gap: any) => gap.requirement)]));
  assert.deepEqual(gaps, { claude: [], codex: ['spawn-denial'], antigravity: ['read-only'] });

  const none = await p.worker({ action: 'select', need: 'hooks-loaded' });
  assert.deepEqual([none.exit, none.body.disposition], [1, 'none-eligible']);
  assert.equal(none.body.candidates.length, 3);
  for (const candidate of none.body.candidates) {
    assert.equal(candidate.eligible, false, candidate.harness);
    assert.ok(candidate.gaps.some((gap: any) => gap.requirement === 'hooks-loaded'), candidate.harness);
  }
  assert.deepEqual(none.body.fallback.modes, ['sequential', 'manual']);

  p.claim('sequential');
  assert.equal(p.attempt().mode, 'sequential', 'the claim records sequential, not subagent');
  const run = await p.run();
  assert.deepEqual([run.exit, run.body.reason, run.body.mode], [1, 'mode-mismatch', 'sequential']);
});

// ── Scenario: One run per token (US3, FR-019) ─────────────────────────────────────────────────

test('one run per token: a second run on a token whose run has ended is refused naming the first run', POSIX, async (t) => {
  const p: any = project(t, { scenario: { run: [{ emit: SUCCESS }] } });
  await p.probe();
  const first = await p.run({ wait: true });
  assert.equal(first.body.state, 'exited');
  const second = await p.run();
  assert.deepEqual([second.exit, second.body.reason, second.body.runId, second.body.phase], [1, 'run-exists', first.body.runId, 'ended']);
  assert.equal(readLog(p.log).filter((line: any) => kindOf(line.argv) === 'run').length, 1);
});

// ── Scenario: Output kept as a pointer (US3, FR-020) ──────────────────────────────────────────

test('output kept as a pointer: past the bound the record holds the report and a pointer, and no transcript reaches status', POSIX, async (t) => {
  const line = `TRANSCRIPT-SENTINEL ${'x'.repeat(1000)}`;
  const lines = Math.ceil(OUTPUT_MAX_BYTES / (line.length + 1)) + 100;
  const p: any = project(t, {});
  p.setScenario({ run: [{ print: Array(lines).fill(line).join('\n') }, { emit: SUCCESS }] });
  await p.probe();
  const started = Date.now();
  const { exit, body } = await p.run({ wait: true });
  t.diagnostic(`a ${lines}-line run ended in ${Date.now() - started} ms`);
  assert.equal(exit, 0, JSON.stringify(body).slice(0, 2000));
  assert.equal(body.report.status, 'success', 'the parser read past the bound');
  const { stdout } = body.output;
  assert.equal(stdout.path, `worker-output/${body.runId}.out.log`);
  assert.equal(stdout.truncated, true);
  assert.ok(stdout.bytes > OUTPUT_MAX_BYTES, String(stdout.bytes));
  assert.ok(stdout.written <= OUTPUT_MAX_BYTES, String(stdout.written));
  assert.ok(fs.statSync(path.join(p.repo, '.doflow', 'state', stdout.path)).size <= OUTPUT_MAX_BYTES);
  const status = await p.status({ workerRun: body.runId });
  assert.equal(JSON.stringify(status.body).includes('TRANSCRIPT-SENTINEL'), false, 'no transcript in status');
  assert.equal(JSON.stringify(body).includes('TRANSCRIPT-SENTINEL'), false, 'no transcript in the run answer');
  assert.equal(fs.readFileSync(p.store, 'utf8').includes('TRANSCRIPT-SENTINEL'), false, 'no transcript in the run record');
});
