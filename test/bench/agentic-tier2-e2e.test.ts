'use strict';

// Tier-2 executor (A bare, B DoFlow installed, C DoFlow installed + "/do-flow " prefix) end to end, offline. The Claude
// binary is test/fixtures/agentic/fake-worker-tier2.js behind a wrapper named `claude` first on PATH; DoFlow's install
// is fake-worker.js `--fake-install`. No model, network, credential or real DoFlow install is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const execute = require('../../bench/agentic/execute.ts');
const { loadAbTaskSet, buildAbPrompt } = require('../../bench/agentic/tasks.ts');
const tier2Extract = require('../../bench/agentic/ab/tier2-extract.ts');

const SKIP_WIN = process.platform === 'win32' && 'the executor finds tools by bare name and spawns shebang scripts directly';
const REPO = path.join(__dirname, '..', '..');
const FAKE_WORKER = path.join(REPO, 'test', 'fixtures', 'agentic', 'fake-worker.js');
const FAKE_TIER2 = path.join(REPO, 'test', 'fixtures', 'agentic', 'fake-worker-tier2.js');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'agentic', 'tier2');
const REAL_CONFIG = path.join(REPO, 'bench', 'agentic', 'ab', 'config-tier2.json');
const REAL_TASKS = path.join(REPO, 'bench', 'agentic', 'ab', 'tasks-tier2.json');
const REAL_STREAM = path.join(REPO, 'test', 'fixtures', 'claude-headless', 'real-arm-b.stream.jsonl');
const TMP = suiteTempDir('doflow-agentic-tier2-e2e-');
const REPLY = 'Proceed. No further input is available; decide anything else with your best judgement and finish the task as stated.';
const CAP = '50000000';

const git = (cwd: string, ...args: string[]) => {
  const r = childProcess.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// ---- the measured checkout: DoFlow skills and agents to project --------------------------------------------
const CHECKOUT = path.join(TMP, 'checkout');
for (const [file, text] of Object.entries({
  'core/shared/skills/do/SKILL.md': '# do\n', 'core/shared/skills/do-implement/SKILL.md': '# do-implement\n',
  'core/shared/agent-specs/reviewer.md': '# reviewer\n', 'bin/doflow.js': '// fake\n',
})) {
  fs.mkdirSync(path.dirname(path.join(CHECKOUT, file)), { recursive: true });
  fs.writeFileSync(path.join(CHECKOUT, file), text);
}
git(CHECKOUT, 'init', '-q');
git(CHECKOUT, 'add', '-A');
git(CHECKOUT, 'commit', '-q', '-m', 'init');

// ---- scenario: one spec per task and arm ---------------------------------------------------------------------
const W = (files: Record<string, string>) => ({ write: files });
const SCENARIO = {
  cumulative: true,
  tasks: {
    'seed-single': {
      match: 'TASK-seed-single:',
      A: { askSegments: 2 },
      B: { askSegments: 2, denies: [{ event: 'PreToolUse', matcher: 'Bash', stderr: '[pre-bash-guard] Blocked: git reset --hard', exitCode: 2 }] },
      C: {
        askSegments: 2, skills: ['do'], classify: 'feature', opus: { tokens: 700, costUsd: 0.05 },
        denies: [{ event: 'Stop', stderr: 'unfinished-work marker found', exitCode: 2 }, { event: 'PreToolUse', matcher: 'Write', stderr: '[pre-implementation-gate] missing requirement.md', exitCode: 2 }],
      },
    },
    'seed-cont': {
      match: 'TASK-seed-cont:',
      A: { sessions: [{ steps: [W({ 'lib/duration.js': 'module.exports = 1;\n' })] }, { steps: [W({ 'lib/long.js': 'module.exports = 2;\n' })] }] },
      B: { sessions: [{ steps: [W({ 'lib/duration.js': 'module.exports = 1;\n' })] }, { steps: [W({ 'lib/long.js': 'module.exports = 2;\n' })] }] },
      C: {
        sessions: [
          { skills: ['do'], steps: [W({ 'lib/duration.js': 'module.exports = 1;\n' }), { sleepMs: 300 }, W({ 'lib/long.js': 'module.exports = 2;\n' })], hang: true },
          { skills: ['do'], steps: [W({ 'bin/report.js': '// r\n', 'README.md': '# done\n' })] },
        ],
      },
    },
  },
};
const SCENARIO_FILE = path.join(TMP, 'scenario.json');
fs.writeFileSync(SCENARIO_FILE, JSON.stringify(SCENARIO));
const withScenario = (name: string, mutate: (s: any) => void) => {
  const s = JSON.parse(JSON.stringify(SCENARIO));
  mutate(s);
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(s));
  return file;
};

const DUMP = path.join(TMP, 'dump.jsonl');
const BIN_DIR = path.join(TMP, 'bin');
fs.mkdirSync(BIN_DIR);
const wrapper = (scenarioFile: string) => ['#!/bin/sh', `T2_FAKE_SCENARIO='${scenarioFile}'`, `T2_FAKE_DUMP='${DUMP}'`, 'export T2_FAKE_SCENARIO T2_FAKE_DUMP', `exec '${process.execPath}' '${FAKE_TIER2}' "$@"`, ''].join('\n');
fs.writeFileSync(path.join(BIN_DIR, 'claude'), wrapper(SCENARIO_FILE), { mode: 0o755 });
const useScenario = (file: string) => fs.writeFileSync(path.join(BIN_DIR, 'claude'), wrapper(file), { mode: 0o755 });

const installArgv = ['node', FAKE_WORKER, '--fake-install', '<export>', 'install', '-g', '-f', '-t', 'claude', '--mcp', 'none'];
function tasksFile(name: string, mutate: (t: any) => void = () => {}) {
  const t = JSON.parse(fs.readFileSync(REAL_TASKS, 'utf8'));
  t.tasks = [
    { id: 'seed-single', name: 'single', kind: 'single', maxBudgetUsd: 1, maxTokensPerRun: 200000, timeoutSec: 60 },
    { id: 'seed-cont', name: 'continuity', kind: 'continuity', maxBudgetUsd: 3.5, sessionBudgetUsd: 2, maxTokensPerRun: 300000, timeoutSec: 60 },
  ];
  mutate(t);
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(t));
  return file;
}
function makeConfig(mutate: (c: any) => void = () => {}) {
  const cfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
  cfg.path = ['node', 'git'];
  cfg.tier2Root = FIXTURES;
  for (const arm of ['B', 'C']) cfg.arms[arm].homeSetup = { argv: installArgv };
  mutate(cfg);
  const file = path.join(TMP, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return execute.loadConfig(file);
}
const CONFIG = makeConfig();
const TASKS = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks') });
const ENV = { PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), CLAUDE_CODE_OAUTH_TOKEN: 'sekret-token-do-not-log' };
const RUN_ROOT = path.join(TMP, 'runs');
const RUN_TMP = path.join(TMP, 'tmp');
fs.mkdirSync(RUN_TMP);

const run = (iteration: string, arm: string, tasks: string[], extra: any = {}) => execute.executeIteration({
  repoRoot: CHECKOUT, config: CONFIG, taskSet: TASKS, runRoot: RUN_ROOT, env: ENV, tmpDir: RUN_TMP, iteration, arm, tasks: tasks.join(','), cap: CAP, cutPollMs: 100, ...extra,
});
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const recordOf = (it: string, task: string, file: string) => readJson(path.join(RUN_ROOT, it, task, file));
const dumps = (): any[] => (fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []);
const dumpsOf = (task: string, arm: string) => dumps().filter((d) => d.taskId === task && d.arm === arm);
const gitIn = (dir: string, ...args: string[]) => childProcess.spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.replace(/\n+$/, '');

// ---------------------------------------------------------------------------------------------------------
// Seeding, arm C prefix, resume reply, caps

test('single task: the workspace is seeded from commits and dirty overlays, .git stays in the record, the task dir is recorded', { skip: SKIP_WIN }, async () => {
  const r = await run('t-A', 'A', ['seed-single']);
  assert.equal(r.exit, 0, JSON.stringify(r));
  const ws = path.join(RUN_ROOT, 't-A', 'seed-single', execute.WORKSPACE_DIR);
  assert.equal(gitIn(ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(gitIn(ws, 'log', '--format=%an <%ae>|%s'), 'Bob Mate <bob@example.test>|wip(b): second commit\nAda Dev <ada@example.test>|init library');
  assert.equal(gitIn(ws, 'status', '--porcelain', '-uall'), ' M lib/a.js\n?? notes/plan.md');
  assert.equal(fs.readFileSync(path.join(ws, 'lib', 'a.js'), 'utf8'), 'module.exports = function a() { return 99; };\n');
  const launch = recordOf('t-A', 'seed-single', 'launch.json');
  assert.equal(launch.taskDir, path.relative(REPO, path.join(FIXTURES, 'seed-single')).split(path.sep).join('/'));
  assert.equal(launch.kind, 'single');
  const t2 = recordOf('t-A', 'seed-single', execute.TIER2_FILE);
  assert.equal(t2.taskJson, `${launch.taskDir}/task.json`);
  assert.equal(t2.sessions.length, 1);
  assert.equal(fs.existsSync(path.join(ws, '..', '..', '..', 'seed-single', 'hidden')), false, 'no hidden tests in the run record');
});

test('arm C types "/do-flow " before the prompt, A and B do not; the resume reply is identical in every arm; caps are the task caps', { skip: SKIP_WIN }, async () => {
  assert.equal((await run('t-B', 'B', ['seed-single'])).exit, 0);
  assert.equal((await run('t-C', 'C', ['seed-single'])).exit, 0);
  const prompts: Record<string, string[]> = {};
  const budgets: Record<string, any[]> = {};
  for (const arm of ['A', 'B', 'C']) {
    const calls = dumpsOf('seed-single', arm);
    assert.equal(calls.length, 3, `${arm}: first prompt plus two resumes`);
    assert.deepEqual(calls.map((c) => c.resumed), [false, true, true]);
    assert.deepEqual(calls.slice(1).map((c) => c.prompt), [REPLY, REPLY], `${arm}: the same reply, no task content`);
    prompts[arm] = [calls[0].prompt];
    budgets[arm] = calls.map((c) => c.budget);
  }
  assert.equal(prompts.A[0].startsWith('/do-flow '), false);
  assert.equal(prompts.B[0], prompts.A[0]);
  assert.equal(prompts.C[0], `/do-flow ${prompts.A[0]}`);
  assert.equal(prompts.A[0], buildAbPrompt(TASKS.tasks[0], CONFIG.arms.A.paragraph));
  for (const arm of ['A', 'B', 'C']) assert.deepEqual(budgets[arm], ['1', '1', '1'], 'the task maxBudgetUsd goes to every segment of every arm');
  // launch: the prompt hash differs by the prefix only; the body hash is the same
  const la = recordOf('t-A', 'seed-single', 'launch.json');
  const lc = recordOf('t-C', 'seed-single', 'launch.json');
  assert.notEqual(la.promptSha256, lc.promptSha256);
  assert.equal(la.promptBodySha256, lc.promptBodySha256);
  assert.equal(lc.entryPrefix, '/do-flow ');
  assert.equal(lc.maxTokensPerRun, 200000);
  assert.equal(lc.maxBudgetUsd, 1);
  const seg = recordOf('t-C', 'seed-single', execute.SEGMENTS_FILE);
  assert.deepEqual([seg.pauses, seg.resumes], [2, 2]);
  // equal caps and equal capture in every arm
  const meta = ['A', 'B', 'C'].map((a) => readJson(path.join(RUN_ROOT, `t-${a}`, execute.RUN_FILES.iteration)));
  assert.deepEqual(meta.map((m) => m.taskCaps), [meta[0].taskCaps, meta[0].taskCaps, meta[0].taskCaps]);
  assert.equal(meta[0].taskCaps['seed-cont'].sessionBudgetUsd, 2);
  assert.equal(new Set(meta.map((m) => m.captureSha256)).size, 1);
  // extending an iteration under different per-task caps is refused (nothing runs)
  const other = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks-bigger', (t) => { t.tasks[0].maxBudgetUsd = 2; }) });
  const before = dumps().length;
  const refused = await run('t-A', 'A', ['seed-cont'], { taskSet: other });
  assert.equal(refused.exit, 2);
  assert.equal(refused.reason, 'iteration-mismatch');
  assert.equal(dumps().length, before);
});

test('process evidence: hook denies by hook id, skills, class and tokens by model are recorded as process.json', { skip: SKIP_WIN }, () => {
  const a = recordOf('t-A', 'seed-single', execute.PROCESS_FILE);
  assert.deepEqual(a.hookDenies, { 'pre-implementation-gate': 0, 'pre-bash-guard': 0, 'stop-check': 0 });
  assert.deepEqual(a.skills, []);
  assert.equal(a.class, null);
  const b = recordOf('t-B', 'seed-single', execute.PROCESS_FILE);
  assert.deepEqual(b.hookDenies, { 'pre-implementation-gate': 0, 'pre-bash-guard': 3, 'stop-check': 0 }, 'one deny per segment');
  assert.equal(b.hookDenyEvents[0].inferred, false);
  const c = recordOf('t-C', 'seed-single', execute.PROCESS_FILE);
  assert.deepEqual(c.hookDenies, { 'pre-implementation-gate': 3, 'pre-bash-guard': 0, 'stop-check': 3 });
  assert.equal(c.hookDenyEvents.find((d: any) => d.id === 'stop-check').inferred, true, 'a Stop deny without a hook-id prefix is inferred from its event');
  assert.deepEqual(c.skills, ['do']);
  assert.equal(c.class, 'feature');
  assert.deepEqual(Object.keys(c.byModel).sort(), ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.equal(c.byModel['claude-opus-5'].totalTokens, 2100, 'running totals: the last segment holds the whole session (700 x 3)');
  assert.ok(Math.abs(c.byModel['claude-opus-5'].costUSD - 0.15) < 1e-9);
});

test('process extraction on the real arm B stream: hooks are not denies, the Skill/model split is read, no class', () => {
  const p = tier2Extract.extractProcess([[fs.readFileSync(REAL_STREAM, 'utf8')]]);
  assert.deepEqual(p.hookDenies, { 'pre-implementation-gate': 0, 'pre-bash-guard': 0, 'stop-check': 0 });
  assert.equal(p.class, null);
  assert.ok(Object.keys(p.byModel).length >= 1);
  assert.ok(p.totalTokens > 0);
  assert.ok(p.totalCostUsd > 0);
  const synthetic = [
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'x', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: '', stdout: '', stderr: '[pre-bash-guard] no', exit_code: 2, outcome: 'error' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'y', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: '', stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}', stderr: '', exit_code: 0, outcome: 'success' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'z', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' }),
    JSON.stringify({ type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'doflow-run classify --task-class bug --request "x"' } }] } }),
  ].join('\n');
  const q = tier2Extract.extractProcess([[synthetic]]);
  assert.deepEqual(q.hookDenies, { 'pre-implementation-gate': 0, 'pre-bash-guard': 2, 'stop-check': 0 });
  assert.equal(q.class, 'bug');
});

// ---------------------------------------------------------------------------------------------------------
// Continuity

test('continuity: the cut fires on the second changed target; session 2 is a new session on the same HOME and workspace; usage is summed', { skip: SKIP_WIN }, async () => {
  const r = await run('c-C', 'C', ['seed-cont']);
  assert.equal(r.exit, 0, JSON.stringify(r));
  const calls = dumpsOf('seed-cont', 'C');
  assert.deepEqual(calls.map((c) => [c.session, c.resumed]), [[1, false], [2, false]], 'session 2 is a new session, not --resume');
  assert.equal(calls[0].HOME, calls[1].HOME);
  assert.equal(calls[0].cwd, calls[1].cwd);
  const t = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'agentic', 'tier2', 'seed-cont', 'task.json'), 'utf8'));
  assert.ok(calls[0].prompt.startsWith('/do-flow ') && calls[0].prompt.includes(t.prompt));
  assert.ok(calls[1].prompt.startsWith('/do-flow ') && calls[1].prompt.includes(t.prompt2));
  assert.equal(calls[1].prompt.includes(t.prompt), false, 'the session-2 prompt does not repeat the spec');
  assert.deepEqual(calls.map((c) => c.budget), ['2', '1.5'], 'session cap 2.00; the task cap 3.50 leaves 1.50 once the cut session counts at its cap');
  const rec = recordOf('c-C', 'seed-cont', execute.TIER2_FILE);
  assert.equal(rec.cut.fired, true);
  assert.deepEqual(rec.cut.changedAtCut, ['lib/duration.js', 'lib/long.js']);
  assert.deepEqual(rec.cut.untouchedAtCut, ['bin/report.js', 'README.md']);
  assert.ok(Number.isFinite(rec.cut.cutMs) && rec.cut.cutMs >= 300);
  assert.deepEqual(rec.sessions.map((s: any) => s.source), ['stream', 'result']);
  assert.equal(rec.sessions[0].costUsd, null);
  const timing = recordOf('c-C', 'seed-cont', 'timing.json');
  assert.equal(timing.total_tokens, rec.sessions[0].tokens + rec.sessions[1].tokens);
  assert.ok(rec.sessions[0].tokens > 0 && rec.sessions[1].tokens > 0);
  assert.equal(timing.cost_usd, rec.sessions[1].costUsd);
  assert.equal(timing.cost_usd_lower_bound, true);
  const seg = recordOf('c-C', 'seed-cont', execute.SEGMENTS_FILE);
  assert.deepEqual(seg.segments.map((s: any) => s.session), [1, 2]);
  assert.ok(seg.segments[0].signal, 'session 1 ended by the kill');
  const ws = path.join(RUN_ROOT, 'c-C', 'seed-cont', execute.WORKSPACE_DIR);
  assert.equal(fs.readFileSync(path.join(ws, 'README.md'), 'utf8'), '# done\n', 'session 2 finished the work in the same workspace');
  assert.ok(fs.existsSync(path.join(ws, '.git')));
  const status = recordOf('c-C', 'seed-cont', 'run_status.json');
  assert.equal(status.status, 'completed');
  assert.equal(status.deliveryFailed, false);
  const proc = recordOf('c-C', 'seed-cont', execute.PROCESS_FILE);
  assert.equal(proc.sessions.length, 2);
  assert.deepEqual(proc.skills, ['do']);
});

test('continuity: when the cut never fires, session 2 still runs and cutFired is false', { skip: SKIP_WIN }, async () => {
  const r = await run('c-A', 'A', ['seed-cont']);
  assert.equal(r.exit, 0, JSON.stringify(r));
  const calls = dumpsOf('seed-cont', 'A');
  assert.deepEqual(calls.map((c) => c.session), [1, 2]);
  assert.equal(calls[1].prompt.startsWith('/do-flow '), false);
  assert.deepEqual(calls.map((c) => c.budget), ['2', '2'], 'session 1 cost 0.10 is known, so session 2 keeps its full 2.00');
  const rec = recordOf('c-A', 'seed-cont', execute.TIER2_FILE);
  assert.equal(rec.cut.fired, false);
  assert.deepEqual(rec.cut.changedAtEnd, ['lib/duration.js']);
  assert.equal(rec.sessions[0].source, 'result');
  assert.equal(recordOf('c-A', 'seed-cont', 'timing.json').cost_usd_lower_bound, undefined);
});

// ---------------------------------------------------------------------------------------------------------
// Dollar ledger, cap and timeout, refusals

test('ledger: the command stops before the next run once its cost reached --ledger-usd', { skip: SKIP_WIN }, async () => {
  const r = await run('led-A', 'A', ['seed-single', 'seed-cont'], { ledgerUsd: '0.25' });
  assert.equal(r.exit, 3);
  assert.deepEqual(r.ran, ['seed-single']);
  assert.deepEqual(r.undone, ['seed-cont']);
  assert.equal(r.ledgerStopped.before, 'seed-cont');
  assert.equal(r.ledgerStopped.ledgerUsd, 0.25);
  assert.ok(r.ledgerSpentUsd >= 0.25);
  assert.equal(fs.existsSync(path.join(RUN_ROOT, 'led-A', 'seed-cont')), false);
  const bad = await run('led-bad', 'A', ['seed-single'], { ledgerUsd: 'nope' });
  assert.equal(bad.reason, 'ledger-invalid');
  const roomy = await run('led-B', 'B', ['seed-single', 'seed-cont'], { ledgerUsd: 50 });
  assert.equal(roomy.exit, 0);
  assert.equal(roomy.ledgerStopped, undefined);
});

test('a run killed at its token cap or its timeout is censored with deliveryFailed', { skip: SKIP_WIN }, async () => {
  useScenario(withScenario('hang', (s) => {
    s.tasks['seed-single'].A = { burn: 5000, hang: true };
    s.tasks['seed-single'].B = { hang: true };
  }));
  try {
    const capTasks = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks-tiny-cap', (t) => { t.tasks[0].maxTokensPerRun = 1000; }) });
    const capped = await run('cap-A', 'A', ['seed-single'], { taskSet: capTasks });
    assert.equal(capped.exit, 0, JSON.stringify(capped));
    assert.deepEqual(capped.capHits, ['seed-single']);
    assert.equal(capped.detail[0].deliveryFailed, true);
    const st = recordOf('cap-A', 'seed-single', 'run_status.json');
    assert.deepEqual([st.status, st.cap, st.deliveryFailed], ['truncated', true, true]);
    assert.equal(recordOf('cap-A', 'seed-single', 'launch.json').maxTokensPerRun, 1000);
    const timeoutTasks = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks-short', (t) => { t.tasks[0].timeoutSec = 2; }) });
    const timed = await run('to-B', 'B', ['seed-single'], { taskSet: timeoutTasks });
    assert.equal(timed.exit, 0, JSON.stringify(timed));
    const st2 = recordOf('to-B', 'seed-single', 'run_status.json');
    assert.deepEqual([st2.status, st2.deliveryFailed], ['timeout', true]);
  } finally {
    useScenario(SCENARIO_FILE);
  }
});

test('refusals: no per-task or command-wide cap, an entryPrefix arm that differs from the candidate, a task whose fixture holds project guidance', { skip: SKIP_WIN }, async () => {
  const noCaps = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks-nocaps', (t) => { delete t.tasks[0].maxTokensPerRun; }) });
  const before = dumps().length;
  const r = await run('ref-1', 'A', ['seed-single'], { taskSet: noCaps });
  assert.equal(r.exit, 2);
  assert.equal(r.reason, 'max-tokens-missing');
  const r2 = await run('ref-2', 'A', ['seed-single'], { taskSet: noCaps, maxTokensPerRun: '200000' });
  assert.equal(r2.exit, 0, 'a command-wide cap fills the gap');
  const noBudget = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: tasksFile('tasks-nobudget', (t) => { delete t.tasks[0].maxBudgetUsd; }) });
  assert.equal((await run('ref-3', 'A', ['seed-single'], { taskSet: noBudget })).reason, 'max-budget-missing');
  assert.equal((await run('ref-4', 'A', ['seed-single', 'seed-cont'], { cap: '100000' })).reason, 'over-cap');
  assert.ok(dumps().length > before);
  const dirty = path.join(TMP, 'tier2-dirty');
  fs.cpSync(path.join(FIXTURES, 'seed-single'), path.join(dirty, 'seed-single'), { recursive: true });
  fs.writeFileSync(path.join(dirty, 'seed-single', 'commits', '01-init', 'files', 'CLAUDE.md'), 'project guidance\n');
  const dirtyConfig = makeConfig((c) => { c.tier2Root = dirty; });
  const dirtySet = loadAbTaskSet({ repoRoot: REPO, config: dirtyConfig, tasksPath: tasksFile('tasks-dirty', (t) => { t.tasks = t.tasks.slice(0, 1); }) });
  const calls = dumps().length;
  assert.equal((await run('ref-5', 'A', ['seed-single'], { config: dirtyConfig, taskSet: dirtySet })).reason, 'workspace-contaminated');
  assert.equal(dumps().length, calls);
  assert.throws(() => makeConfig((c) => { c.arms.C.pathAdd = []; }), /arms\.C\.pathAdd/);
  assert.throws(() => makeConfig((c) => { c.arms.C.entryPrefix = ''; }), /entryPrefix/);
  assert.throws(() => makeConfig((c) => { c.ledgerUsd = -1; }), /ledgerUsd/);
});

test('the committed tier-2 config and tasks file load: three arms, five tasks, equal caps, one reply', () => {
  const cfg = execute.loadConfig(REAL_CONFIG);
  assert.deepEqual(Object.keys(cfg.arms), ['A', 'B', 'C']);
  assert.equal(cfg.arms.C.entryPrefix, '/do-flow ');
  assert.deepEqual(cfg.resume, { maxResumes: 4, reply: REPLY, cumulative: true });
  assert.equal(cfg.maxTokensPerRun, null);
  assert.equal(cfg.maxBudgetUsd, null);
  assert.equal(cfg.ledgerUsd, null);
  const tasks = JSON.parse(fs.readFileSync(REAL_TASKS, 'utf8')).tasks;
  assert.deepEqual(tasks.map((t: any) => t.id), ['implicit-requirements', 'two-session-continuity', 'destructive-shortcut', 'finish-and-ship', 'red-ci-root-cause']);
  assert.deepEqual(tasks.map((t: any) => [t.maxBudgetUsd, t.maxTokensPerRun]), [[3, 4000000], [3.5, 4000000], [1, 1200000], [2.5, 3000000], [1.5, 2000000]]);
  assert.equal(tasks[1].sessionBudgetUsd, 2);
  assert.ok(tasks.every((t: any) => t.timeoutSec === 2700));
});
