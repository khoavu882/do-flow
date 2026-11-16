'use strict';

// 172 T5: the readers of the `harness-login` store (design 4.5, 4.6, IC-002, IC-004, D12). A supervised fake run
// records its login outcome; `worker --action login-state`, `describe` and `start-options` then read the same
// answer. Every process is the fake harness CLI linked into a scratch bin/ under a scratch HOME and config home;
// the descriptors are scratch copies, so no real harness is run and the shipped `unknown` entries do not matter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
const { linkBin, writeScenario } = require('../../helper/fake-harness-cli.ts');
const FIXTURE = require('../../fixtures/worker/descriptors.json');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src', 'runtime');
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const { workerCatalogue } = require(path.join(SRC, 'worker', 'catalogue.ts'));
const { executeWorkerCommand, handleWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const { superviseRun } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const { storeFileFor, newRunId, insertRun } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));
const { cwdHash } = require(path.join(SRC, 'context', 'identity.ts'));

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const SIGN = 'OAuth refresh failed for {provider}';
const FAILED = { type: 'result', status: 'failure', summary: 'Error: OAuth refresh failed for anthropic. Run the login again.' };
const SUCCESS = { type: 'result', status: 'success', summary: 'all done' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

/** A supported scratch recipe that cannot see expiry, with one expiry sign. */
const RECIPE = {
  status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-11-16',
  argv: ['probe', 'login'], output: 'none',
  answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }],
  expiry: 'not-seen', expirySigns: { signs: [SIGN], basis: 'source', evidence: ['test'] }, hint: 'fake-claude login',
};

/** The registry's claude block on the fake binary with the scratch recipe: the readers' descriptor. */
function readerClaude() {
  const reg = loadRegistry({ repoRoot: REPO });
  const worker = structuredClone(workerCatalogue({ registry: reg }).find((entry: any) => entry.id === 'claude').worker);
  worker.cli = { ...worker.cli, binary: 'fake-claude' };
  worker.loginProbe = structuredClone(RECIPE);
  return worker;
}

function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const env: any = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.doflow/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // IC-015: the worker's own DoFlow state is outside the read-only check.
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n');
}

/** A scratch HOME and config home, a git project, the fake `fake-claude`, and the reader and supervisor helpers. */
function rig() {
  const scratch = createScratch('doflow-login-readers-');
  const dir = scratch.dir;
  const bin = path.join(dir, 'bin');
  const childPath = linkBin(bin, ['fake-claude']);
  fs.symlinkSync(GIT, path.join(bin, 'git'));
  const root = path.join(dir, 'project');
  gitInit(root);
  const scenarioFile = writeScenario(dir, {});
  const env = childEnv(scratch, {
    PATH: childPath, FAKE_HARNESS_SCENARIO: scenarioFile,
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: root,
    DOFLOW_ATTEMPT: null,
  });
  const reader = readerClaude();
  const descriptors = { claude: reader };
  const projectKey = cwdHash(root);
  const projects = () => ({ ok: true, body: { projects: [{ projectKey, label: 'project' }] } });
  let runs = 0;

  /** One supervised run of a fresh slug and attempt, its fake running `steps`; resolves the ended run. */
  async function supervised(steps: any[]) {
    runs += 1;
    const slug = `feat-${runs}`;
    writeScenario(dir, { run: steps });
    const planFile = path.join(root, 'agent-docs', 'doflow', slug, 'plan.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, PLAN);
    const execWorktree = path.join(dir, `wt-${runs}`);
    gitInit(execWorktree);
    const key = runKeyFor(env, root);
    const ledger = attempts.storeFile(root, slug);
    const common: any = { file: ledger, fsImpl: fs, roots: [root], slug, env, cwd: root };
    assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
    const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
    assert.equal(claimed.disposition, 'claimed');
    const descriptor = structuredClone(FIXTURE.claude);
    descriptor.loginProbe = structuredClone(RECIPE);
    const runId = newRunId();
    const { identity } = launchEnv({ env, runKey: key.runKey, token: claimed.token, execWorktree, runId });
    const prompt = 'do the task';
    const promptFile = path.join(dir, `prompt-${runId}.md`);
    fs.writeFileSync(promptFile, prompt);
    const store = storeFileFor(root, slug);
    assert.equal(insertRun(store, {
      runId, task: 'A.1', token: claimed.token, harness: 'claude', phase: 'starting', execWorktree,
      createdAt: new Date().toISOString(), timeoutSeconds: 60,
      caller: { cwd: root, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
      ...launchRecord(descriptor, identity, prompt),
      descriptor,
      prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) },
      needs: [],
    }).applied, true);
    return superviseRun({ file: store, runId, env, cwd: root });
  }

  const base = { env, cwd: root, descriptors };
  return {
    dir, root, env, reader,
    scenario: (value: any) => writeScenario(dir, value),
    supervised,
    loginState: (extra: any = {}) => executeWorkerCommand({ action: 'login-state', ...base, ...extra }),
    describe: () => executeWorkerCommand({ action: 'describe', harness: 'claude', ...base }),
    probe: () => executeWorkerCommand({ action: 'probe', harness: 'claude', ...base }),
    startOptions: () => executeWorkerCommand({ action: 'start-options', projectKey, projects, ...base }),
  };
}

const claudeOf = (body: any) => body.harnesses.find((entry: any) => entry.harness === 'claude');

test('a supervised fake run whose failure summary holds `OAuth refresh failed for anthropic` sets report.loginExpired {sign, provider: anthropic}, and login-state, describe and start-options then say expired', POSIX_ONLY, async () => {
  const r = rig();
  const run = await r.supervised([{ emit: FAILED }, { exit: 1 }]);
  assert.equal(run.report.status, 'failure');
  assert.deepEqual(run.report.loginExpired, { sign: SIGN, provider: 'anthropic' });

  const state = await r.loginState();
  assert.equal(state.exit, 0, JSON.stringify(state.body));
  const answer = claudeOf(state.body);
  assert.deepEqual([answer.state, answer.source, answer.provider, answer.hint], ['expired', 'last-run', 'anthropic', 'fake-claude login']);

  const described = await r.describe();
  assert.equal(described.exit, 0, JSON.stringify(described.body));
  assert.deepEqual([described.body.probe.login.state, described.body.probe.login.reason], ['no', 'login-expired anthropic']);

  const options = await r.startOptions();
  assert.equal(options.exit, 0, JSON.stringify(options.body));
  const claude = claudeOf(options.body);
  assert.deepEqual([claude.startable, claude.reason, claude.login.state, claude.login.provider], [true, null, 'expired', 'anthropic']);
  assert.ok(claude.warnings.includes('login-expired'), JSON.stringify(claude.warnings));
  assert.equal(claude.warnings.includes('login-not-checked'), false);
});

test('a later successful fake run clears the expiry: login-state reads logged-in from the run', POSIX_ONLY, async () => {
  const r = rig();
  await r.supervised([{ emit: FAILED }, { exit: 1 }]);
  const run = await r.supervised([{ emit: SUCCESS }]);
  assert.equal(run.report.status, 'success');
  assert.equal(Object.hasOwn(run.report, 'loginExpired'), false);
  const answer = claudeOf((await r.loginState()).body);
  assert.deepEqual([answer.state, answer.source, answer.reason, answer.provider], ['logged-in', 'last-run', null, null]);
  const described = await r.describe();
  assert.deepEqual([described.body.probe.login.state, described.body.probe.login.reason], ['yes', 'logged-in']);
  const claude = claudeOf((await r.startOptions()).body);
  assert.equal(claude.warnings.some((w: string) => w.startsWith('login-')), false, JSON.stringify(claude.warnings));
});

test('a later not-seen recipe answer of logged-in does not clear the expiry (O-3)', POSIX_ONLY, async () => {
  const r = rig();
  await r.supervised([{ emit: FAILED }, { exit: 1 }]);
  r.scenario({ login: [{ exit: 0 }] });
  const probed = await r.probe();
  assert.equal(probed.exit, 0, JSON.stringify(probed.body));
  // The probe record keeps what the recipe found; the effective answer keeps the run's expiry.
  const facts = probed.body.harnesses[0].facts;
  assert.deepEqual([facts.login.state, facts.login.reason], ['yes', 'logged-in']);
  const answer = claudeOf((await r.loginState({ harness: 'claude' })).body);
  assert.deepEqual([answer.state, answer.source, answer.provider], ['expired', 'last-run', 'anthropic']);
  const described = await r.describe();
  assert.deepEqual([described.body.probe.login.state, described.body.probe.login.reason], ['no', 'login-expired anthropic']);
});

test('a logged-out recipe answer makes the harness not startable, naming the hint', POSIX_ONLY, async () => {
  const r = rig();
  r.scenario({ login: [{ exit: 1 }] });
  assert.equal((await r.probe()).exit, 0);
  const claude = claudeOf((await r.startOptions()).body);
  assert.deepEqual([claude.startable, claude.reason, claude.login.state, claude.login.source], [false, 'logged-out', 'logged-out', 'recipe']);
  assert.match(claude.words, /fake-claude login/);
  const answer = claudeOf((await r.loginState()).body);
  assert.deepEqual([answer.state, answer.reason], ['logged-out', 'logged-out']);
});

test('expired and unknown are startable with a warning; never-checked reads unknown', POSIX_ONLY, async () => {
  const r = rig();
  const fresh = claudeOf((await r.startOptions()).body);
  assert.deepEqual([fresh.startable, fresh.login.state, fresh.login.source, fresh.login.reason], [true, 'unknown', 'never-checked', 'never-checked']);
  assert.ok(fresh.warnings.includes('login-unknown'), JSON.stringify(fresh.warnings));
  assert.equal(fresh.warnings.includes('login-expired'), false);
  await r.supervised([{ emit: FAILED }, { exit: 1 }]);
  const expired = claudeOf((await r.startOptions()).body);
  assert.deepEqual([expired.startable, expired.login.state], [true, 'expired']);
  assert.ok(expired.warnings.includes('login-expired'));
  assert.equal(expired.warnings.includes('login-unknown'), false);
});

test('login-state: worker-catalogue order, one --harness, exit 2 for an unknown --harness, a doctor cell per harness, nothing written', POSIX_ONLY, async (t: any) => {
  const r = rig();
  const all = await r.loginState();
  assert.equal(all.exit, 0);
  assert.deepEqual(Object.keys(all.body), ['harnesses']);
  const ids = workerCatalogue({ registry: loadRegistry({ repoRoot: REPO }) }).map((entry: any) => entry.id).slice(0, 32);
  assert.deepEqual(all.body.harnesses.map((entry: any) => entry.harness), ids);
  for (const entry of all.body.harnesses.filter((item: any) => item.harness !== 'claude')) assert.equal(entry.state, 'unknown', entry.harness);
  const one = await r.loginState({ harness: 'claude' });
  assert.deepEqual(one.body.harnesses.map((entry: any) => entry.harness), ['claude']);
  const bad = await r.loginState({ harness: 'no-such-harness' });
  assert.deepEqual([bad.exit, bad.body.error], [2, 'usage']);
  const misplaced = await executeWorkerCommand({ action: 'login-state', need: 'login', env: r.env, cwd: r.root });
  assert.deepEqual([misplaced.exit, misplaced.body.error], [2, 'usage']);
  assert.equal(fs.existsSync(path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'state', 'harness-login.json')), false, 'a read writes no store');

  await r.supervised([{ emit: FAILED }, { exit: 1 }]);
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  const saved = process.exitCode;
  try {
    assert.equal(await handleWorkerCommand({ action: 'login-state', harness: 'claude', env: r.env, cwd: r.root, descriptors: { claude: r.reader } }), 0);
  } finally {
    process.exitCode = saved;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^claude {2}expired \(run, \d{4}-\d{2}-\d{2}T[^)]+\) provider anthropic \(re-login: fake-claude login\)$/);
});

test('design 4.6: a model check that establishes login and exits 0 records a succeeded run, newer than the recipe answer', POSIX_ONLY, async () => {
  const r = rig();
  r.reader.modelChecks = [{ id: 'login-check', argv: ['model-check', 'login-check'], establishes: ['login'], estimateTokens: 10, timeoutSeconds: 5 }];
  r.scenario({ login: [{ exit: 1 }], 'model-check:login-check': [{ exit: 0 }] });
  const probed = await executeWorkerCommand({ action: 'probe', harness: 'claude', modelCheck: 'login-check', budgetTokens: '100', env: r.env, cwd: r.root, descriptors: { claude: r.reader } });
  assert.equal(probed.exit, 0, JSON.stringify(probed.body));
  const answer = claudeOf((await r.loginState()).body);
  assert.deepEqual([answer.state, answer.source], ['logged-in', 'last-run']);
});
