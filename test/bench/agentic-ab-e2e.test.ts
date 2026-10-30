'use strict';

// With/without-DoFlow A/B (WP-2) end to end through the CLI, offline. The Claude binary is the fake worker
// (test/fixtures/agentic/fake-worker.js, Claude mode) behind a wrapper named `claude` first on PATH, and
// arm B's DoFlow install is the fake worker's `--fake-install` (homeSetup), so no model, network, credential
// or real DoFlow install is touched. The checkout is a temp git repo; every run root is a temp dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const agentic = require('../../bench/agentic/runner.ts');
const execute = require('../../bench/agentic/execute.ts');
const { loadAbTaskSet } = require('../../bench/agentic/tasks.ts');
const noise = require('../../bench/noise.ts');
const reviewCorpus = require('../../bench/review-miss/corpus.ts');

const SKIP_WIN = process.platform === 'win32' && 'the executor finds tools by bare name and spawns shebang scripts directly';
const REPO = path.join(__dirname, '..', '..');
const FAKE_WORKER = path.join(REPO, 'test', 'fixtures', 'agentic', 'fake-worker.js');
const REAL_CONFIG = path.join(REPO, 'bench', 'agentic', 'ab', 'config.json');
const TMP = suiteTempDir('doflow-agentic-ab-e2e-');
const SECRET = 'sekret-token-do-not-log';
const CAP = '5000000';
const PER_RUN = '100000';
const REPLY = 'No further input is available. If the task as stated is complete, stop. Otherwise continue with the task as stated and change nothing outside it.';

const git = (cwd: string, ...args: string[]) => {
  const r = childProcess.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// ---- the measured checkout: DoFlow skills and agents to prove, and a file to review --------------------
const CHECKOUT = path.join(TMP, 'checkout');
const REVIEWED = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
for (const [file, text] of Object.entries({
  'core/shared/skills/do/SKILL.md': '# do\n',
  'core/shared/skills/do-implement/SKILL.md': '# do-implement\n',
  'core/shared/agent-specs/reviewer.md': '# reviewer\n',
  'bin/doflow.js': '// fake\n',
  'src/a.ts': REVIEWED,
})) {
  fs.mkdirSync(path.dirname(path.join(CHECKOUT, file)), { recursive: true });
  fs.writeFileSync(path.join(CHECKOUT, file), text);
}
git(CHECKOUT, 'init', '-q');
git(CHECKOUT, 'add', '-A');
git(CHECKOUT, 'commit', '-q', '-m', 'init');
const REV = git(CHECKOUT, 'rev-parse', 'HEAD');

// ---- tasks: edit tasks whose checks pass when a.js exports 2; one review task over five cases -------------
const EDIT_IDS = ['fix-a', 'fix-b', 'fix-c', 'fix-d', 'fix-e', 'fix-pause', 'fix-unanswered', 'fix-leak', 'fix-cap', 'fix-over', 'fix-initleak', 'fix-nolist', 'fix-nohook', 'fix-timeout', 'fix-offer', 'fix-env', 'fix-budget', 'fix-oldver', 'fix-nover'];
const natives = EDIT_IDS.map((id) => ({
  id, purpose: id, messages: [`TASK-${id}: make a.js export 2.`], files: { 'a.js': 'module.exports = 1;\n' },
  checks: "if (require('./a.js') !== 2) process.exit(1);", expectedSkills: ['do-implement'], maxQuestions: 0,
}));
const NATIVE_FILE = path.join(TMP, 'native.json');
fs.writeFileSync(NATIVE_FILE, JSON.stringify({ version: 1, cases: natives }));
const CASES = [2, 8, 14, 20, 26].map((line, i) => {
  const c: any = { id: `x-${i + 1}`, rev: REV, scope: ['src/a.ts'], expected: { path: 'src/a.ts', startLine: line, endLine: line, severity: 'should-fix' }, split: 'train', source: {} };
  c.key = reviewCorpus.caseKey(c);
  return c;
});
const CORPUS = { kind: 'review-miss', schema: 1, cases: CASES };
const REVIEW_CONFIG = { tolerance: 3, maxSpan: 60 };
const TASKS_FILE = path.join(TMP, 'tasks.json');
fs.writeFileSync(TASKS_FILE, JSON.stringify({
  schemaVersion: 1,
  tasks: [
    ...EDIT_IDS.map((id) => ({ id, name: id, kind: 'edit', nativeCase: id })),
    { id: 'review-x', name: 'review', kind: 'review', expectedSkills: [], review: { rev: REV, scope: ['src/a.ts'], focus: ['src/a.ts'], caseIds: CASES.map((c: any) => c.id) } },
    { id: 'review-bad-rev', name: 'review', kind: 'review', review: { rev: 'f'.repeat(40), scope: ['src/a.ts'], focus: ['src/a.ts'], caseIds: ['x-1'] } },
  ],
}));

// ---- scenarios -------------------------------------------------------------------------------------------
const PASS = { 'a.js': 'module.exports = 2;\n' };
const finding = (line: number) => ({ path: 'src/a.ts', startLine: line, endLine: line, severity: 'should-fix', title: `defect at ${line}` });
const both = (spec: any) => ({ A: spec, B: spec });
const SCENARIO_TASKS: Record<string, any> = {
  'fix-a': { A: { files: PASS, commands: ['node a.js'], usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 4000 }, costUsd: 0.1 },
    B: { files: PASS, commands: ['node a.js'], skills: ['do-implement'], subagents: [{ type: 'reviewer', model: 'claude-haiku-4-5', tokens: 500 }], usage: { input: 10, output: 150, cacheCreation: 2000, cacheRead: 8000 }, costUsd: 0.2 } },
  'fix-b': { A: { files: { 'a.js': 'module.exports = 1;\n' }, usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 4000 } }, B: { files: PASS, skills: ['do-implement'], usage: { input: 10, output: 150, cacheCreation: 2000, cacheRead: 8000 } } },
  'fix-c': { A: { files: { 'a.js': 'module.exports = 1;\n' }, usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 4000 } }, B: { files: PASS, skills: ['do-implement'], usage: { input: 10, output: 150, cacheCreation: 2000, cacheRead: 8000 } } },
  'fix-d': { A: { files: { 'a.js': 'module.exports = 1;\n' }, usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 4000 } }, B: { files: PASS, skills: ['do-implement'], usage: { input: 10, output: 150, cacheCreation: 2000, cacheRead: 8000 } } },
  'fix-e': { A: { files: { 'a.js': 'module.exports = 1;\n' }, usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 4000 } }, B: { files: PASS, skills: ['do-implement'], usage: { input: 10, output: 150, cacheCreation: 2000, cacheRead: 8000 } } },
  'fix-pause': both({ files: PASS, askSegments: 2 }),
  'fix-unanswered': both({ files: PASS, askSegments: 3 }),
  'fix-offer': both({ files: PASS, finalOffer: true }),
  'fix-env': both({ files: PASS, printEnv: true }),
  'fix-budget': both({ behaviour: 'budget' }),
  'fix-oldver': both({ files: PASS, askSegments: 1, claudeCodeVersion: '2.1.276' }),
  'fix-nover': both({ files: PASS, askSegments: 1, claudeCodeVersion: null }),
  'fix-leak': both({ files: PASS, commands: ['curl http://example.test/payload'] }),
  'fix-cap': both({ behaviour: 'hang-after-usage', stream: { messages: 4, perMessage: 60000 } }),
  'fix-over': both({ files: PASS, usage: { input: 10, output: 100, cacheCreation: 1000, cacheRead: 200000 } }),
  'fix-initleak': { A: { files: PASS, initOverride: { addSkills: ['do'] } }, B: { files: PASS } },
  'fix-nolist': { A: { files: PASS }, B: { files: PASS, initOverride: { dropSkills: ['do-implement'] } } },
  'fix-nohook': { A: { files: PASS }, B: { files: PASS, initOverride: { noHooks: true } } },
  'fix-timeout': both({ behaviour: 'timeout' }),
  'review-x': { A: { reviewJson: [finding(2)] }, B: { reviewJson: [2, 8, 14, 20, 26, 40].map(finding) } },
  'review-bad-rev': both({ reviewJson: [] }),
};
const SCENARIO_FILE = path.join(TMP, 'scenario.json');
fs.writeFileSync(SCENARIO_FILE, JSON.stringify({
  cumulative: true,
  tasks: Object.fromEntries(Object.entries(SCENARIO_TASKS).map(([id, spec]) => [id, { match: `TASK-${id}:`, ...spec }])),
}));
// review prompts carry no TASK marker: match them by their opening words
const scenario = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
for (const id of ['review-x', 'review-bad-rev']) scenario.tasks[id].match = 'Review src/a.ts';
fs.writeFileSync(SCENARIO_FILE, JSON.stringify(scenario));

// ---- the harness binary and the config ------------------------------------------------------------------
const DUMP = path.join(TMP, 'dump.jsonl');
const BIN_DIR = path.join(TMP, 'bin');
fs.mkdirSync(BIN_DIR);
fs.writeFileSync(path.join(BIN_DIR, 'claude'), [
  '#!/bin/sh',
  `AB_FAKE_SCENARIO='${SCENARIO_FILE}'`,
  `AB_FAKE_DUMP='${DUMP}'`,
  'AB_FAKE_SEEN=CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY',
  'export AB_FAKE_SCENARIO AB_FAKE_DUMP AB_FAKE_SEEN',
  `exec '${process.execPath}' '${FAKE_WORKER}' "$@"`,
  '',
].join('\n'), { mode: 0o755 });

const installArgv = (extra: string[] = []) => ['node', FAKE_WORKER, '--fake-install', '<export>', '--dump', DUMP, '--seen', 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY', ...extra, 'install', '-g', '-f', '-t', 'claude', '--mcp', 'none'];
function configFile(name: string, mutate: (c: any) => void = () => {}) {
  const cfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
  cfg.path = ['node', 'git'];
  cfg.timeoutSeconds = 20;
  cfg.maxBudgetUsd = 5;
  cfg.arms.B.homeSetup = { argv: installArgv() };
  mutate(cfg);
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}
const CONFIG = execute.loadConfig(configFile('config'));
const ENV = { PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), CLAUDE_CODE_OAUTH_TOKEN: SECRET };
const FULL = loadAbTaskSet({ repoRoot: REPO, config: CONFIG, tasksPath: TASKS_FILE, nativePath: NATIVE_FILE });
const subset = (ids: string[]) => ({ ...FULL, tasks: FULL.tasks.filter((t: any) => ids.includes(t.id)), train: FULL.tasks.filter((t: any) => ids.includes(t.id)) });
const REPORT_IDS = ['fix-a', 'fix-b', 'fix-c', 'fix-d', 'fix-e', 'review-x'];
const NOISE = noise.loadNoiseConfig({ noise: { k: 2, mde: 0.05, headroom: 0.95, maxInfraShare: 0.10, seed: 96 } });
const RUN_ROOT = path.join(TMP, 'runs');
const REVIEW_ROOT = path.join(TMP, 'review-miss');
const RESULTS = path.join(TMP, 'results');
const RUN_TMP = path.join(TMP, 'tmp');
fs.mkdirSync(RUN_TMP);

/** Runs the CLI with everything injected; returns { code, out, err }. */
async function cli(argv: string[], { config = CONFIG, taskSet = FULL, env = ENV, runRoot = RUN_ROOT }: any = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await agentic.main(argv, {
    repoRoot: CHECKOUT, config, taskSet, runRoot, reviewRoot: REVIEW_ROOT, resultsDir: RESULTS, env, tmpDir: RUN_TMP, noiseConfig: NOISE,
    corpus: CORPUS, reviewConfig: REVIEW_CONFIG, out: (m: string) => out.push(m), err: (m: string) => err.push(m),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const exec = (iteration: string, arm: string, tasks: string[], extra: string[] = []) => cli(
  ['execute', '--iteration', iteration, '--arm', arm, '--tasks', tasks.join(','), '--cap', CAP, '--max-tokens-per-run', PER_RUN, ...extra], { taskSet: subset(tasks) },
);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const runFile = (it: string, task: string, file: string, root = RUN_ROOT) => path.join(root, it, task, file);
const dumps = (): any[] => (fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []);
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
async function gradeOf(iteration: string, ids: string[], root = RUN_ROOT) {
  const r = await cli(['grade', '--iteration', iteration, '--json'], { taskSet: subset(ids), runRoot: root });
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  return Object.fromEntries((Array.isArray(parsed) ? parsed : parsed.gradings).map((g: any) => [g.id, g]));
}

// ---------------------------------------------------------------------------------------------------------
// Refusals: nothing spawns

test('plan prints the projection and the paid stages and spawns nothing, with the cap unset', { skip: SKIP_WIN }, async () => {
  const before = dumps().length;
  const r = await cli(['plan', '--iteration', 'dry', '--arm', 'A']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /A\/B arm A/);
  assert.match(r.out, /maxTokensPerRun unset/);
  assert.match(r.out, /stage R \(rehearsal\).*--tasks fix-a/);
  assert.equal(dumps().length, before, 'plan spawned nothing');
  assert.equal(fs.existsSync(path.join(RUN_ROOT, 'dry')), false);
});

test('execute refuses without a per-run cap, without a credential variable, over the command cap, and for a missing review revision', { skip: SKIP_WIN }, async () => {
  const before = dumps().length;
  let r = await cli(['execute', '--iteration', 'refuse-1', '--arm', 'A', '--tasks', 'fix-a', '--cap', CAP], { taskSet: subset(['fix-a']) });
  assert.equal(r.code, 2);
  assert.match(r.err, /max-tokens-missing/);
  r = await cli(['execute', '--iteration', 'refuse-2', '--arm', 'A', '--tasks', 'fix-a', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { taskSet: subset(['fix-a']), env: { PATH: ENV.PATH } });
  assert.equal(r.code, 2);
  assert.match(r.err, /credential-missing/);
  r = await cli(['execute', '--iteration', 'refuse-3', '--arm', 'A', '--tasks', 'fix-a,fix-b', '--cap', '150000', '--max-tokens-per-run', PER_RUN], { taskSet: subset(['fix-a', 'fix-b']) });
  assert.equal(r.code, 2);
  assert.match(r.err, /over-cap/);
  r = await exec('refuse-4', 'A', ['review-bad-rev']);
  assert.equal(r.code, 2);
  assert.match(r.err, /review-rev-missing/);
  r = await exec('refuse-5', 'A', ['fix-a'], ['--max-tokens-per-run', '0']);
  assert.equal(r.code, 2);
  assert.equal(dumps().length, before, 'no refusal started the harness or the installer');
  for (const n of [1, 2, 3, 4, 5]) assert.equal(fs.existsSync(path.join(RUN_ROOT, `refuse-${n}`)), false, 'nothing was written for a refusal');
});

test('execute refuses a task that would put project guidance into the workspace', { skip: SKIP_WIN }, async () => {
  const contaminated = { ...FULL.tasks.find((t: any) => t.id === 'fix-a'), id: 'tainted', files: { 'CLAUDE.md': 'x' } };
  const r = await cli(['execute', '--iteration', 'refuse-6', '--arm', 'A', '--tasks', 'tainted', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { taskSet: { ...FULL, tasks: [contaminated] } });
  assert.equal(r.code, 2);
  assert.match(r.err, /workspace-contaminated/);
});

// ---------------------------------------------------------------------------------------------------------
// Both arms, edit and review kinds

test('arm A: a bare run is executed, its workspace and review.json are kept, and it grades clean and proven absent', { skip: SKIP_WIN }, async () => {
  const r = await exec('a-solo', 'A', ['fix-a', 'review-x']);
  assert.equal(r.code, 0, r.err);
  for (const f of ['launch.json', 'transcript.jsonl', 'last-message.txt', 'run_status.json', 'timing.json', 'segments.json']) assert.ok(fs.existsSync(runFile('a-solo', 'fix-a', f)), f);
  assert.equal(fs.readFileSync(runFile('a-solo', 'fix-a', 'workspace/a.js'), 'utf8'), PASS['a.js']);
  assert.equal(fs.existsSync(runFile('a-solo', 'fix-a', 'home-setup.json')), false, 'arm A runs no install step');
  assert.ok(fs.existsSync(runFile('a-solo', 'review-x', 'review.json')));
  const iteration = readJson(path.join(RUN_ROOT, 'a-solo', 'iteration.json'));
  assert.equal(iteration.mode, 'ab');
  assert.equal(iteration.arm, 'A');
  assert.equal(iteration.maxTokensPerRun, Number(PER_RUN));
  const g = await gradeOf('a-solo', ['fix-a', 'review-x']);
  assert.equal(g['fix-a'].isolation, 'clean', JSON.stringify(g['fix-a'].isolationEvidence));
  assert.equal(g['fix-a'].proof.absent, true);
  assert.equal(g['fix-a'].pass_rate, 1);
  assert.equal(g['fix-a'].metrics.tokens.total, 10 + 100 + 1000 + 4000);
  assert.equal(g['review-x'].review.ok, true);
  assert.equal(g['review-x'].pass_rate, null, 'review recall comes from the review-miss scorer');
  const reviewGrade = readJson(path.join(REVIEW_ROOT, 'ab-a-solo', 'grade.json'));
  assert.equal(reviewGrade.runs[CASES[0].key].passRate, 1);
  assert.equal(reviewGrade.runs[CASES[1].key].passRate, 0);
});

test('arm B: the install step runs in the scratch HOME without a credential; DoFlow is proven loaded; routing and subagents are metered', { skip: SKIP_WIN }, async () => {
  const r = await exec('b-solo', 'B', ['fix-a', 'review-x']);
  assert.equal(r.code, 0, r.err);
  const setup = readJson(runFile('b-solo', 'fix-a', 'home-setup.json'));
  assert.equal(setup.ok, true);
  const launch = readJson(runFile('b-solo', 'fix-a', 'launch.json'));
  assert.deepEqual(launch.proofExpected, { skills: ['do', 'do-implement'], agents: ['reviewer'] });
  assert.deepEqual(launch.credentialEnvPresent, ['CLAUDE_CODE_OAUTH_TOKEN'], 'only the variable name is recorded');
  const g = await gradeOf('b-solo', ['fix-a', 'review-x']);
  assert.equal(g['fix-a'].isolation, 'clean', JSON.stringify(g['fix-a'].isolationEvidence));
  assert.equal(g['fix-a'].proof.loaded, true);
  assert.equal(g['fix-a'].proof.p1, true);
  assert.equal(g['fix-a'].routing.routed, true);
  assert.equal(g['fix-a'].metrics.subagentCalls, 1);
  assert.equal(g['fix-a'].metrics.subagentTokens, 500);
  assert.deepEqual(Object.keys(g['fix-a'].metrics.byModel).sort(), ['claude-haiku-4-5', 'claude-sonnet-5-5']);
  assert.equal(g['fix-a'].pass_rate, 1);
  const reviewGrade = readJson(path.join(REVIEW_ROOT, 'ab-b-solo', 'grade.json'));
  assert.deepEqual(Object.values(reviewGrade.runs).map((x: any) => x.passRate), [1, 1, 1, 1, 1]);
});

test('the credential reaches the worker only by environment variable and is written nowhere', { skip: SKIP_WIN }, async () => {
  const calls = dumps();
  const runs = calls.filter((c: any) => c.kind === 'run');
  const installs = calls.filter((c: any) => c.kind === 'install');
  assert.ok(runs.length > 0 && installs.length > 0);
  for (const c of runs) assert.equal(c.credentialsSeen.CLAUDE_CODE_OAUTH_TOKEN, true, 'the worker sees it');
  for (const c of installs) assert.equal(c.credentialsSeen.CLAUDE_CODE_OAUTH_TOKEN, false, 'the install step never sees it');
  for (const root of [RUN_ROOT, REVIEW_ROOT]) {
    for (const file of walk(root)) assert.equal(fs.readFileSync(file, 'utf8').includes(SECRET), false, `${file} holds the credential`);
  }
  assert.equal(fs.readdirSync(RUN_TMP).length, 0, 'scratch profiles and workspaces are removed');
});

// ---------------------------------------------------------------------------------------------------------
// Pauses, resume (D3), cap, leak and proof failures

test('D3: a run that stops to ask is resumed with the fixed reply up to twice, and every pause is counted', { skip: SKIP_WIN }, async () => {
  const r = await exec('pause-a', 'A', ['fix-pause', 'fix-unanswered']);
  assert.equal(r.code, 0, r.err);
  const paused = readJson(runFile('pause-a', 'fix-pause', 'segments.json'));
  assert.equal(paused.segments.length, 3);
  assert.equal(paused.pauses, 2);
  assert.equal(paused.resumes, 2);
  assert.equal(paused.unansweredPause, false);
  assert.deepEqual(paused.segments.map((s: any) => [s.asked, s.replied]), [[true, true], [true, true], [false, false]]);
  assert.ok(fs.existsSync(runFile('pause-a', 'fix-pause', 'transcript.3.jsonl')));
  const resumed = dumps().filter((c: any) => c.kind === 'run' && c.resumed && c.prompt === REPLY);
  assert.ok(resumed.length >= 4, 'each resume sent the reply on stdin with --resume');
  assert.ok(resumed[0].argv.includes('--resume'));
  assert.equal(paused.offers, 0);
  const unanswered = readJson(runFile('pause-a', 'fix-unanswered', 'segments.json'));
  assert.equal(unanswered.pauses, 3);
  assert.equal(unanswered.resumes, 2, 'never more than maxResumes');
  assert.equal(unanswered.unansweredPause, true);
  const g = await gradeOf('pause-a', ['fix-pause', 'fix-unanswered']);
  assert.equal(g['fix-pause'].metrics.questions.pauses, 2);
  assert.equal(g['fix-pause'].metrics.questions.resumes, 2);
  assert.equal(g['fix-pause'].metrics.tokens.total, 3 * (10 + 100 + 1000 + 5000), 'running totals: the last segment holds the whole run');
  assert.ok(Math.abs(g['fix-pause'].metrics.costUsd - 0.3) < 1e-9);
  assert.equal(g['fix-unanswered'].metrics.questions.unanswered, true);
});

test('the per-run cap stops a run in flight and one whose reported total passes it; both are excluded with the cap recorded', { skip: SKIP_WIN }, async () => {
  const r = await exec('cap-a', 'A', ['fix-cap', 'fix-over']);
  assert.equal(r.code, 0, r.err);
  const inFlight = readJson(runFile('cap-a', 'fix-cap', 'run_status.json'));
  assert.equal(inFlight.status, 'truncated');
  assert.equal(inFlight.cap, true);
  const reported = readJson(runFile('cap-a', 'fix-over', 'run_status.json'));
  assert.equal(reported.status, 'truncated');
  assert.equal(reported.cap, true);
  const g = await gradeOf('cap-a', ['fix-cap', 'fix-over']);
  for (const id of ['fix-cap', 'fix-over']) {
    assert.equal(g[id].capped, true);
    assert.equal(g[id].infra, 'truncated');
    assert.equal(g[id].pass_rate, null, 'excluded, never scored 0');
  }
});

test('fix 12: a per-run cap hit exits 0 and the summary carries an unmissable CAP HIT line; only the command cap exits 3', { skip: SKIP_WIN }, async () => {
  const r = await exec('cap-hit-a', 'A', ['fix-cap', 'fix-over']);
  assert.equal(r.code, 0, 'a per-run cap hit is not exit 3');
  assert.match(r.out, /^!!! CAP HIT: 2 of 2 run\(s\) stopped at the per-run cap \(fix-cap, fix-over\).*lower bounds.*exits 0 !!!$/m);
  assert.equal(r.out.split('\n').filter((l: string) => l.includes('CAP HIT: stopped at the per-run cap')).length, 2, 'one CAP HIT mark on each capped run line');
  const json = JSON.parse((await exec('cap-hit-j', 'A', ['fix-cap'], ['--json'])).out);
  assert.deepEqual(json.capHits, ['fix-cap']);
  const clean = await exec('cap-hit-ok', 'A', ['fix-b']);
  assert.doesNotMatch(clean.out, /CAP HIT/);
  const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'agentic', 'execute.ts'), 'utf8');
  assert.match(docs, /A run that hit its own per-run cap \(token or\s+\* dollar\) is recorded as truncated and censored and the command still exits 0/);
});

test('fix 13: a resumed run from a Claude Code version below 2.1.277, or an unknown one, has its cost marked cumulative-unverified', { skip: SKIP_WIN }, async () => {
  const ids = ['fix-pause', 'fix-oldver', 'fix-nover', 'fix-a'];
  assert.equal((await exec('ver-a', 'A', ids)).code, 0);
  const g = await gradeOf('ver-a', ids);
  assert.equal(g['fix-pause'].metrics.claudeCodeVersion, '2.1.308');
  assert.equal(g['fix-pause'].metrics.costBasis, 'verified');
  assert.equal(g['fix-oldver'].metrics.claudeCodeVersion, '2.1.276');
  assert.equal(g['fix-oldver'].metrics.costBasis, 'cumulative-unverified');
  assert.equal(g['fix-oldver'].metrics.questions.resumes, 1);
  assert.equal(g['fix-nover'].metrics.claudeCodeVersion, null);
  assert.equal(g['fix-nover'].metrics.costBasis, 'cumulative-unverified');
  assert.equal(g['fix-a'].metrics.costBasis, 'verified');
});

test('a timed-out run is recorded as timeout and excluded', { skip: SKIP_WIN }, async () => {
  const config = execute.loadConfig(configFile('config-short', (c: any) => { c.timeoutSeconds = 2; }));
  const out: string[] = [];
  const code = await agentic.main(['execute', '--iteration', 'timeout-a', '--arm', 'A', '--tasks', 'fix-timeout', '--cap', CAP, '--max-tokens-per-run', PER_RUN], {
    repoRoot: CHECKOUT, config, taskSet: subset(['fix-timeout']), runRoot: RUN_ROOT, reviewRoot: REVIEW_ROOT, resultsDir: RESULTS, env: ENV, tmpDir: RUN_TMP,
    noiseConfig: NOISE, corpus: CORPUS, reviewConfig: REVIEW_CONFIG, out: (m: string) => out.push(m), err: (m: string) => out.push(m),
  });
  assert.equal(code, 0, out.join('\n'));
  assert.equal(readJson(runFile('timeout-a', 'fix-timeout', 'run_status.json')).status, 'timeout');
  const g = await gradeOf('timeout-a', ['fix-timeout']);
  assert.equal(g['fix-timeout'].infra, 'timeout');
  assert.equal(g['fix-timeout'].pass_rate, null);
});

test('leak and proof failures are excluded with their reason, never scored: network command, DoFlow in arm A, skills missing, no hook, failed install', { skip: SKIP_WIN }, async () => {
  assert.equal((await exec('leak-a', 'A', ['fix-leak', 'fix-initleak'])).code, 0);
  assert.equal((await exec('leak-b', 'B', ['fix-leak', 'fix-nolist', 'fix-nohook'])).code, 0);
  const a = await gradeOf('leak-a', ['fix-leak', 'fix-initleak']);
  const b = await gradeOf('leak-b', ['fix-leak', 'fix-nolist', 'fix-nohook']);
  assert.equal(a['fix-leak'].isolation, 'leaked');
  assert.match(a['fix-leak'].isolationEvidence.join('|'), /curl/);
  assert.equal(a['fix-initleak'].isolation, 'leaked', 'DoFlow visible in the bare arm init');
  assert.equal(b['fix-leak'].isolation, 'leaked');
  assert.equal(b['fix-nolist'].isolation, 'not-loaded', 'P2: a DoFlow skill is missing from init');
  assert.equal(b['fix-nohook'].isolation, 'not-loaded', 'P3: SessionStart did not fire');
  for (const g of [a['fix-leak'], a['fix-initleak'], b['fix-leak'], b['fix-nolist'], b['fix-nohook']]) {
    assert.equal(g.pass_rate, null, `${g.id} is not scored`);
    assert.equal(report().abExcludedOf(g), 'source-unverified');
  }

  // P1: the install step fails, so the worker is not started at all
  const before = dumps().filter((c: any) => c.kind === 'run').length;
  const failing = execute.loadConfig(configFile('config-failing-install', (c: any) => { c.arms.B.homeSetup = { argv: installArgv(['--fail']) }; }));
  const r = await cli(['execute', '--iteration', 'p1-b', '--arm', 'B', '--tasks', 'fix-a', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { config: failing, taskSet: subset(['fix-a']) });
  assert.equal(r.code, 0, r.err);
  assert.equal(dumps().filter((c: any) => c.kind === 'run').length, before, 'the worker never started');
  assert.equal(readJson(runFile('p1-b', 'fix-a', 'home-setup.json')).ok, false);
  const p1 = await gradeOf('p1-b', ['fix-a']);
  assert.equal(p1['fix-a'].isolation, 'not-loaded');
  assert.equal(p1['fix-a'].exclusionReason, 'not-loaded');
  assert.match(p1['fix-a'].isolationEvidence.join('|'), /P1 failed/);
});

const report = () => require('../../bench/agentic/report.ts');

// ---------------------------------------------------------------------------------------------------------
// Noise, report, and the guards around them

test('noise and report: arms are interleaved per repeat, the report prints the four parts with verdict words, and a stale grading is flagged', { skip: SKIP_WIN }, async () => {
  const taskSet = subset(REPORT_IDS);
  for (const n of [1, 2]) {
    assert.equal((await cli(['execute', '--iteration', `a-r${n}`, '--arm', 'A', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { taskSet })).code, 0);
    assert.equal((await cli(['execute', '--iteration', `b-r${n}`, '--arm', 'B', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { taskSet })).code, 0);
  }
  for (const it of ['a-r1', 'a-r2', 'b-r1', 'b-r2']) assert.equal((await cli(['grade', '--iteration', it], { taskSet })).code, 0);

  const noiseOut = path.join(TMP, 'ab-noise.json');
  const noiseRun = await cli(['noise', '--iterations', 'a-r1,a-r2', '--out', noiseOut], { taskSet });
  assert.equal(noiseRun.code, 0, noiseRun.err + noiseRun.out);
  const band = readJson(noiseOut);
  assert.equal(band.kind, 'bench-ab-noise');
  assert.equal(band.metrics.success.verdict, 'usable');
  assert.equal(band.metrics.review.verdict, 'usable');
  assert.equal(band.metrics.success.scopes.corpus.baselineMean, 0.2);
  assert.equal(band.metrics.review.scopes.corpus.baselineMean, 0.2);
  assert.equal(band.cost.totalTokens, 0, 'identical repeats have a zero relative range');

  const fixedCost = path.join(TMP, 'fixed-cost.json');
  fs.writeFileSync(fixedCost, JSON.stringify({ rows: [{ item: 'Installed files in HOME', value: 561, source: 'dry-run' }], hookLatencyMsP50: 40 }));
  const decisionOut = path.join(TMP, 'ab-decision.json');
  const rep = await cli(['report', '--iterations', 'b-r1,b-r2', '--noise', noiseOut, '--fixed-cost', fixedCost, '--decision-out', decisionOut], { taskSet });
  assert.equal(rep.code, 0, rep.err + rep.out);
  for (const part of ['Part 1 - quality', 'Part 2 - cost and behaviour', 'Part 3 - fixed cost', 'Part 4 - validity']) assert.ok(rep.out.includes(part), part);
  const decisions = readJson(decisionOut);
  assert.equal(decisions.success.corpus.verdict, 'gain-above-noise', rep.out);
  assert.equal(decisions.review.corpus.verdict, 'gain-above-noise', rep.out);
  assert.match(rep.out, /review findings .*arm A 2 produced, 0 matched no known key over 2 run\(s\); arm B 12 produced, 2 matched no known key over 2 run\(s\)/);
  assert.match(rep.out, /Success \(edit tasks, pass rate\) \| 5 \|/);
  assert.match(rep.out, /Review recall \(review-miss keys\) \| 5 \|/);
  assert.match(rep.out, /\| total tokens \| 6 \| -0\.840 \|/);
  assert.match(rep.out, /Installed files in HOME \| 561 \| dry-run/);
  assert.match(rep.out, /hook overhead per run/);
  assert.match(rep.out, /routing \(P4, reported not required\): arm B used the expected skill in 12 of 12 eligible/);
  assert.match(rep.out, /censored \(stopped by the cap or the timeout.*arm A 0 of 12.*arm B 0 of 12/);
  assert.match(rep.out, /cost basis: verified/);
  assert.match(rep.out, /prompts equal across arms: true/);
  assert.match(rep.out, /P5: deferred/);

  // a stored grading edited after `grade` is flagged and the fresh grading is the score
  const stale = runFile('b-r1', 'fix-b', 'grading.json');
  fs.writeFileSync(stale, fs.readFileSync(stale, 'utf8').replace('"pass_rate": 1', '"pass_rate": 0'));
  const again = await cli(['report', '--iterations', 'b-r1,b-r2', '--noise', noiseOut, '--json'], { taskSet });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(JSON.parse(again.out).graderRerun.stale, ['b-r1/fix-b']);
  assert.equal(JSON.parse(again.out).decisions.success.corpus.verdict, 'gain-above-noise');
});

test('report without a noise band says so and decides nothing; an arm A iteration is refused as the candidate', { skip: SKIP_WIN }, async () => {
  const taskSet = subset(REPORT_IDS);
  const rep = await cli(['report', '--iterations', 'b-r1,b-r2', '--noise', path.join(TMP, 'does-not-exist.json')], { taskSet });
  assert.equal(rep.code, 2);
  assert.match(rep.err, /noise-missing|no noise artifact/);
  const none = await cli(['report', '--iterations', 'b-r1,b-r2'], { taskSet });
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /no noise band/);
  assert.match(none.out, /inconclusive/);
  const wrongArm = await cli(['report', '--iterations', 'a-r1,a-r2'], { taskSet });
  assert.equal(wrongArm.code, 2);
  assert.match(wrongArm.err, /arm A|arm-mismatch/);
});

test('fix 11: noise and report default their output to the untracked bench/runs/agentic/ab, never the tracked results dir', { skip: SKIP_WIN }, async () => {
  const taskSet = subset(REPORT_IDS);
  const abDir = path.join(CHECKOUT, 'bench', 'runs', 'agentic', 'ab');
  try {
    const noise = await cli(['noise', '--iterations', 'a-r1,a-r2'], { taskSet });
    assert.equal(noise.code, 0, noise.err + noise.out);
    assert.ok(fs.existsSync(path.join(abDir, 'ab-noise.json')), 'the band lands under bench/runs/agentic/ab');
    assert.match(noise.out, /noise: bench\/runs\/agentic\/ab\/ab-noise\.json/);
    const rep = await cli(['report', '--iterations', 'b-r1,b-r2'], { taskSet });
    assert.equal(rep.code, 0, rep.err + rep.out);
    assert.doesNotMatch(rep.out, /no noise band/, 'the report finds the default band');
    assert.ok(fs.existsSync(path.join(abDir, 'ab-decision.json')), 'the decisions land under bench/runs/agentic/ab');
    assert.match(rep.out, /decision: bench\/runs\/agentic\/ab\/ab-decision\.json/);
    assert.equal(fs.existsSync(path.join(CHECKOUT, 'bench', 'agentic', 'results')), false, 'the tracked results dir is untouched');
    assert.equal(fs.existsSync(RESULTS) && fs.readdirSync(RESULTS).some((f: string) => f.startsWith('ab-')), false);
    assert.match(JSON.stringify(agentic.abPaidStages({ taskSet: FULL, config: CONFIG, k: 2 })), /bench\/runs\/agentic\/ab\/ab-noise\.json/);
    assert.doesNotMatch(JSON.stringify(agentic.abPaidStages({ taskSet: FULL, config: CONFIG, k: 2 })), /agentic\/results/);
  } finally {
    fs.rmSync(path.join(CHECKOUT, 'bench', 'runs'), { recursive: true, force: true }); // keep the measured checkout clean for the next test
  }
});

test('noise refuses a candidate-arm iteration and too few repeats', { skip: SKIP_WIN }, async () => {
  const taskSet = subset(REPORT_IDS);
  assert.equal((await cli(['noise', '--iterations', 'b-r1,b-r2'], { taskSet })).code, 2);
  const few = await cli(['noise', '--iterations', 'a-r1'], { taskSet });
  assert.equal(few.code, 2);
  assert.match(few.err, /needs k = 2/);
});

test('fix 6: a closing offer is counted apart from a blocking question and never resumes the run; the reply is neutral', { skip: SKIP_WIN }, async () => {
  assert.equal(CONFIG.resume.reply, REPLY);
  const before = dumps().filter((c: any) => c.kind === 'run' && c.resumed).length;
  const r = await exec('offer-a', 'A', ['fix-offer', 'fix-pause']);
  assert.equal(r.code, 0, r.err);
  const offered = readJson(runFile('offer-a', 'fix-offer', 'segments.json'));
  assert.equal(offered.segments.length, 1, 'no resume for an offer');
  assert.equal(offered.pauses, 0);
  assert.equal(offered.offers, 1);
  assert.equal(offered.resumes, 0);
  assert.equal(offered.unansweredPause, false);
  assert.equal(dumps().filter((c: any) => c.kind === 'run' && c.resumed).length - before, 2, 'only the blocking task (fix-pause) was resumed, twice');
  const g = await gradeOf('offer-a', ['fix-offer', 'fix-pause']);
  assert.deepEqual([g['fix-offer'].metrics.questions.pauses, g['fix-offer'].metrics.questions.offers], [0, 1]);
  assert.deepEqual([g['fix-pause'].metrics.questions.pauses, g['fix-pause'].metrics.questions.offers], [2, 0]);
});

test('fix 3: the scrub variable is set in both arms, and a worker that prints its environment leaves no credential bytes under the run directory', { skip: SKIP_WIN }, async () => {
  const SHAPE = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
  const before = dumps().length;
  for (const [it, arm] of [['env-a', 'A'], ['env-b', 'B']]) {
    const r = await exec(it, arm, ['fix-env']);
    assert.equal(r.code, 0, r.err);
  }
  const runs = dumps().slice(before).filter((c: any) => c.kind === 'run');
  assert.equal(runs.length, 2);
  for (const c of runs) assert.equal(c.scrub, '1', `arm ${c.arm} worker environment`);
  assert.ok(dumps().slice(before).filter((c: any) => c.kind === 'install').every((c: any) => c.scrub === '1'), 'the install step too');
  for (const it of ['env-a', 'env-b']) {
    const files = walk(path.join(RUN_ROOT, it));
    assert.ok(files.some((f) => f.endsWith('env-dump.txt')), 'the workspace copy holds the file the worker wrote');
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(SECRET), false, `${file} holds the credential`);
      assert.equal(text.includes(SHAPE), false, `${file} holds a key-shaped token`);
    }
    assert.match(fs.readFileSync(runFile(it, 'fix-env', 'transcript.jsonl'), 'utf8'), /CLAUDE_CODE_OAUTH_TOKEN=\[redacted\]/);
    assert.match(fs.readFileSync(runFile(it, 'fix-env', 'last-message.txt'), 'utf8'), /token \[redacted\]/);
  }
  const g = await gradeOf('env-b', ['fix-env']);
  assert.equal(g['fix-env'].isolation, 'clean', 'a redacted transcript still parses and grades');
  assert.equal(g['fix-env'].pass_rate, 1);
});

test('fix 8: execute refuses without a dollar budget; every run gets --max-budget-usd; a budget stop is a censored cap', { skip: SKIP_WIN }, async () => {
  const before = dumps().length;
  const none = execute.loadConfig(configFile('config-no-budget', (c) => { c.maxBudgetUsd = null; }));
  const refused = await cli(['execute', '--iteration', 'budget-0', '--arm', 'A', '--tasks', 'fix-a', '--cap', CAP, '--max-tokens-per-run', PER_RUN], { config: none, taskSet: subset(['fix-a']) });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /max-budget-missing/);
  assert.equal(dumps().length, before, 'nothing was spawned');
  assert.equal(fs.existsSync(path.join(RUN_ROOT, 'budget-0')), false);
  const plan = await cli(['plan', '--iteration', 'budget-plan', '--arm', 'A'], { config: none });
  assert.match(plan.out, /maxBudgetUsd unset \(execute refuses until the user sets it\)/);
  assert.match(plan.out, /--max-budget-usd <usd>/);

  for (const [it, arm] of [['budget-a', 'A'], ['budget-b', 'B']]) {
    assert.equal((await exec(it, arm, ['fix-budget'], ['--max-budget-usd', '2.5'])).code, 0);
  }
  const runs = dumps().slice(before).filter((c: any) => c.kind === 'run');
  assert.equal(runs.length, 2);
  for (const c of runs) {
    const at = c.argv.indexOf('--max-budget-usd');
    assert.ok(at > 0, `arm ${c.arm} argv`);
    assert.equal(c.argv[at + 1], '2.5', 'the option beats the config value (5)');
  }
  assert.equal(readJson(runFile('budget-a', 'fix-budget', 'launch.json')).maxBudgetUsd, 2.5);
  const status = readJson(runFile('budget-a', 'fix-budget', 'run_status.json'));
  assert.equal(status.status, 'truncated');
  assert.equal(status.cap, true);
  assert.equal(status.budget, true);
  const g = await gradeOf('budget-b', ['fix-budget']);
  assert.equal(g['fix-budget'].censored, 'cap');
  assert.equal(g['fix-budget'].metrics.capTokens, null, 'the token cap was not what stopped it');
  assert.equal(g['fix-budget'].metrics.costUsd, 1.5);
});
