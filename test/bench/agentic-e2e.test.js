'use strict';

// Feature 097 C.1: the agentic baseline end to end through the CLI (`bench agentic plan|execute|grade|
// noise|report`, IC-004 to IC-009), offline. The harness binary is the fake worker
// (test/fixtures/agentic/fake-worker.js) behind a wrapper script placed first on PATH under a made-up
// binary name; the wrapper bakes in the scenario, so the CLI path never needs the executor's test-only
// `extraEnv`. No model, network or credential is touched; every run root and results directory is a
// temp copy.
//
// Scenarios (test/fixtures/agentic/scenarios/e2e-*.json): every task has one distinct qrel file, so a
// run scores 1 or 0. The six-task subset has three train and three heldout tasks; arm N finds none and
// one task reports unknown usage (with three cases per split, a mixed arm N would leave the split CI
// across zero, so the gain must be uniform for the split verdicts to be reached). Arm D finds every task (gain), exactly arm N's tasks (same), or every
// train task but only arm N's heldout tasks (train only). A separate one-task control checks leak handling.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const agentic = require('../../bench/agentic/runner.ts');
const execute = require('../../bench/agentic/execute.ts');
const { loadTaskSet } = require('../../bench/agentic/tasks.ts');
const noise = require('../../bench/noise.ts');
// G60's own checker (recomputation of every scope, the overfit flag and the source-none rules).
const { checkEvalNoise } = require('../guards/eval-noise.test.js');

const REPO = path.join(__dirname, '..', '..');
const FAKE_WORKER = path.join(REPO, 'test', 'fixtures', 'agentic', 'fake-worker.js');
const SCENARIOS = path.join(REPO, 'test', 'fixtures', 'agentic', 'scenarios');
const TMP = suiteTempDir('doflow-agentic-e2e-');
const TASK_IDS = new Set(['DC-014', 'DC-015', 'DC-016', 'HC-903', 'HC-904', 'HC-907']);
const LOADED_TASK_SET = loadTaskSet();
const TASK_SET = {
  ...LOADED_TASK_SET,
  tasks: LOADED_TASK_SET.tasks.filter((t) => TASK_IDS.has(t.id)),
  train: LOADED_TASK_SET.train.filter((t) => TASK_IDS.has(t.id)),
  heldout: LOADED_TASK_SET.heldout.filter((t) => TASK_IDS.has(t.id)),
};
const KEY = Object.fromEntries(TASK_SET.tasks.map((t) => [t.id, t.key]));
const LEAKED = 'DC-014';
const UNKNOWN_USAGE = 'DC-016';
const BINARY = 'fakeharness-e2e';
const CAP = '2000000';
assert.equal(TASK_SET.train.length, 3);
assert.equal(TASK_SET.heldout.length, 3);

const LEAK_TASK = TASK_SET.train.find((t) => t.id === LEAKED);
const LEAK_TASK_SET = { ...TASK_SET, tasks: [LEAK_TASK], train: [LEAK_TASK], heldout: [] };
const LEAK_ITERS = ['leak-r1', 'leak-r2', 'leak-r3'];

const supported = (extra) => ({ status: 'supported', ...extra });
const REGISTRY = {
  version: 1,
  harnesses: [{
    id: 'e2e',
    worker: {
      cli: supported({ binary: BINARY, versionArgv: ['--version'] }),
      oneShot: supported({ argv: ['--ephemeral', '-'], promptVia: 'stdin' }),
      structuredOutput: supported({ argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1' }),
      readOnly: supported({ argv: ['exec', '-s', 'read-only'] }),
      spawnDenial: supported({ argv: ['--disable', 'multi_agent'] }),
    },
  }],
};

const clone = (v) => JSON.parse(JSON.stringify(v));
function configWith(label = 'fake:e2e-model') {
  const c = execute.loadConfig();
  c.model = { label, argv: ['-m', 'fake-e2e'] };
  c.home = { env: 'FAKE_HOME', source: '~/.fakehome', copy: ['auth.json'] };
  c.path = ['node', 'git'];
  c.timeoutSeconds = 30;
  c.maxTokensPerRun = 50000;
  return c;
}
const CONFIG = configWith();

function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A clean one-commit git repo stands for the measured checkout (execute refuses a dirty tree). */
const REPO_ROOT = path.join(TMP, 'checkout');
fs.mkdirSync(REPO_ROOT);
git(REPO_ROOT, 'init', '-q');
fs.writeFileSync(path.join(REPO_ROOT, 'a.txt'), 'x\n');
git(REPO_ROOT, 'add', '-A');
git(REPO_ROOT, 'commit', '-q', '-m', 'init');

const SOURCE_HOME = path.join(TMP, 'srchome');
fs.mkdirSync(path.join(SOURCE_HOME, '.fakehome'), { recursive: true });
fs.writeFileSync(path.join(SOURCE_HOME, '.fakehome', 'auth.json'), '{"token":"not-a-credential"}');
const RUN_TMP = path.join(TMP, 'tmp');
fs.mkdirSync(RUN_TMP);

const TRUTH = path.join(TMP, 'truth.json');
fs.writeFileSync(TRUTH, JSON.stringify(Object.fromEntries(TASK_SET.tasks.map((t) => [t.id, { query: t.query, qrels: t.qrels }]))));

/** A bin directory whose harness binary runs the fake worker on one scenario. */
function binFor(scenario) {
  const scenarioFile = path.isAbsolute(scenario) ? scenario : path.join(SCENARIOS, `${scenario}.json`);
  const binName = path.isAbsolute(scenario) ? path.basename(scenario, '.json') : scenario;
  const dir = path.join(TMP, `bin-${binName}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, BINARY);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `AGENTIC_FAKE_SCENARIO='${scenarioFile}'`,
    `AGENTIC_FAKE_TRUTH='${TRUTH}'`,
    'export AGENTIC_FAKE_SCENARIO AGENTIC_FAKE_TRUTH',
    `exec '${process.execPath}' '${FAKE_WORKER}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

function fakeMaterialise(commit, dir) {
  const treeRoot = path.join(dir, 'tree');
  fs.mkdirSync(treeRoot, { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'README.md'), `snapshot ${commit}\n`);
  return { treeRoot, cleanup() {} };
}

const RUN_ROOT = path.join(TMP, 'runs');
const RESULTS = path.join(TMP, 'results');
const NOISE_FILE = path.join(TMP, 'noise.json');
const LEAK_RUN_ROOT = path.join(TMP, 'runs-leak');
const LEAK_NOISE_FILE = path.join(TMP, 'noise-leak.json');

/** CLI options: everything injectable, never `extraEnv`. Output is captured. */
function optsFor({ bin = null, config = CONFIG, taskSet = TASK_SET, runRoot = RUN_ROOT, resultsDir = RESULTS } = {}) {
  const out = [];
  const err = [];
  return {
    out, err,
    opts: {
      repoRoot: REPO_ROOT, config, registry: REGISTRY, taskSet, runRoot, resultsDir,
      env: { PATH: `${bin ? `${bin}${path.delimiter}` : ''}${process.env.PATH}`, TMPDIR: RUN_TMP, LANG: 'C' },
      sourceHome: SOURCE_HOME, tmpDir: RUN_TMP, materialise: fakeMaterialise,
      out: (line) => out.push(line), err: (line) => err.push(line),
    },
  };
}

async function cli(argv, options = {}) {
  const { out, err, opts } = optsFor(options);
  const code = await agentic.main(argv, opts);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Runs `fn` with every child_process entry point replaced by a recorder that refuses to spawn. */
async function noSpawn(fn) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const saved = Object.fromEntries(names.map((n) => [n, childProcess[n]]));
  const calls = [];
  for (const n of names) childProcess[n] = (...args) => { calls.push([n, args[0]]); throw new Error(`spawn forbidden: ${n} ${args[0]}`); };
  try {
    return { result: await fn(), calls };
  } finally {
    Object.assign(childProcess, saved);
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const realReadme = () => fs.readFileSync(path.join(REPO, 'bench', 'README.md'), 'utf8');
const N_ITERS = ['n-r1', 'n-r2', 'n-r3'];
const N_RUN_COUNT = TASK_SET.tasks.length * N_ITERS.length;
const N_UNKNOWN_COUNT = TASK_SET.tasks.filter((t) => t.id === UNKNOWN_USAGE).length * N_ITERS.length;
const N_RECORDED_COUNT = N_RUN_COUNT - N_UNKNOWN_COUNT;
// The gain set is the full k = 3 of the paid protocol; same and train-only need one candidate repeat to
// show their verdicts, which keeps the file's runtime down (NFR-007).
const D_SETS = { gain: ['d-r1', 'd-r2', 'd-r3'], same: ['s-r1'], trainOnly: ['t-r1'] };

let pipeline = null;
/** Executes and grades every iteration once (arm N on the gain scenario, three arm D sets), then `noise --out`. */
function setup() {
  pipeline ??= (async () => {
    const bins = { gain: binFor('e2e-gain'), same: binFor('e2e-same'), trainOnly: binFor('e2e-train-only') };
    const runs = [...N_ITERS.map((it) => [it, 'N', bins.gain]), ...Object.entries(D_SETS).flatMap(([set, its]) => its.map((it) => [it, 'D', bins[set]]))];
    // Iterations are independent (own directories, mkdtemp scratch), so they run side by side.
    const executed = await Promise.all(runs.map(([iteration, arm, bin]) => cli(['execute', '--iteration', iteration, '--arm', arm, '--cap', CAP], { bin })));
    executed.forEach((r, i) => assert.equal(r.code, 0, `${runs[i][0]}: ${r.err}`));
    for (const [iteration] of runs) {
      const r = await cli(['grade', '--iteration', iteration]);
      assert.equal(r.code, 0, `${iteration}: ${r.err}`);
    }
    const n = await cli(['noise', '--iterations', N_ITERS.join(','), '--out', NOISE_FILE]);

    // Keep the leak accounting proof without spending three repeats across the six decision tasks.
    const leakScenario = path.join(TMP, 'e2e-leak.json');
    fs.writeFileSync(leakScenario, JSON.stringify({ tasks: { [LEAKED]: { N: {
      truthFiles: 1, decoys: 2, commands: ['/bin/zsh -lc "doflow retrieve --scope code --query x --root ."'], tokens: 40000,
    } } } }));
    const leakBin = binFor(leakScenario);
    const leakRuns = LEAK_ITERS.map((iteration) => [iteration, leakBin]);
    const leakExecuted = await Promise.all(leakRuns.map(([iteration, bin]) => cli(
      ['execute', '--iteration', iteration, '--arm', 'N', '--cap', CAP],
      { bin, taskSet: LEAK_TASK_SET, runRoot: LEAK_RUN_ROOT },
    )));
    leakExecuted.forEach((r, i) => assert.equal(r.code, 0, `${leakRuns[i][0]}: ${r.err}`));
    for (const [iteration] of leakRuns) {
      const r = await cli(['grade', '--iteration', iteration], { taskSet: LEAK_TASK_SET, runRoot: LEAK_RUN_ROOT });
      assert.equal(r.code, 0, `${iteration}: ${r.err}`);
    }
    const leakNoise = await cli(['noise', '--iterations', LEAK_ITERS.join(','), '--out', LEAK_NOISE_FILE], {
      taskSet: LEAK_TASK_SET, runRoot: LEAK_RUN_ROOT,
    });
    return { noise: n, leakNoise };
  })();
  return pipeline;
}

async function decisionOf(iterations, extra = [], options = {}, file = path.join(TMP, `decision-${Math.random().toString(36).slice(2)}.json`)) {
  const r = await cli(['report', '--iterations', iterations.join(','), ...extra, '--decision-out', file], options);
  assert.equal(r.code, 0, r.err);
  return { ...r, decision: readJson(file), file };
}

/** The G60 checks over one decision file, exactly as the guard runs them on committed results. */
function g60Findings(decision) {
  return checkEvalNoise({
    root: REPO, jsonFiles: new Map([['bench/agentic/results/decision.json', JSON.stringify(decision)]]), jsFiles: new Map(), readme: realReadme(),
  });
}

// --- the band ----------------------------------------------------------------------------------

test('noise: three arm N iterations give a valid, usable 096 artifact over the six-task key list', async () => {
  const { noise: n } = await setup();
  assert.equal(n.code, 0, n.err);
  const artifact = readJson(NOISE_FILE);
  assert.deepEqual(noise.validateNoiseArtifact(artifact), []);
  assert.equal(artifact.verdict, 'usable');
  assert.deepEqual(artifact.iterations, N_ITERS);
  assert.equal(artifact.model, 'fake:e2e-model');
  assert.equal(artifact.commit, git(REPO_ROOT, 'rev-parse', 'HEAD'));
  assert.deepEqual(artifact.caseKeys, TASK_SET.tasks.map((t) => t.key).sort());
  assert.deepEqual(artifact.graderRerun, { runs: N_RUN_COUNT, differing: [], stale: [] });
  assert.match(n.out, /verdict: usable/);
});

test('noise: a leaked arm N run is excluded as source-unverified and counted, never scored', async () => {
  const { leakNoise } = await setup();
  assert.equal(leakNoise.code, 1, leakNoise.err);
  const artifact = readJson(LEAK_NOISE_FILE);
  const leaked = artifact.cases[KEY[LEAKED]];
  assert.deepEqual(leaked.scores, [null, null, null]);
  assert.deepEqual(leaked.excluded, ['source-unverified', 'source-unverified', 'source-unverified']);
  assert.equal(artifact.infra['source-unverified'], 3);
  assert.equal(artifact.infra.excluded, 3);
  // The fake answer contains the truth path, but isolation keeps every score null.
  const transcript = fs.readFileSync(path.join(LEAK_RUN_ROOT, LEAK_ITERS[0], LEAKED, 'transcript.jsonl'), 'utf8');
  assert.ok(transcript.includes(LEAK_TASK.qrels[0].path));
  assert.deepEqual(artifact.scopes.corpus.repeatMeans, [null, null, null]);
  assert.equal(artifact.graderRerun.runs, LEAK_TASK_SET.tasks.length * LEAK_ITERS.length);
  const grading = readJson(path.join(LEAK_RUN_ROOT, LEAK_ITERS[0], LEAKED, 'grading.json'));
  assert.equal(grading.isolation, 'leaked');
  assert.equal(grading.pass_rate, null);
  assert.match(grading.isolationEvidence[0], /doflow retrieve/);
});

// --- the decision ------------------------------------------------------------------------------

test('report: arm D that finds more gives gain-above-noise on corpus; the decision passes validateDecision and G60', async () => {
  await setup();
  const { decision, out } = await decisionOf(D_SETS.gain, ['--noise', NOISE_FILE]);
  assert.deepEqual(noise.validateDecision(decision), []);
  assert.equal(decision.precondition, null);
  assert.equal(decision.verdict, 'gain-above-noise');
  assert.equal(decision.corpus.reason, 'above-band');
  assert.equal(decision.splits.train.verdict, 'gain-above-noise');
  assert.equal(decision.splits.heldout.verdict, 'gain-above-noise');
  assert.equal(decision.overfitSuspected, false);
  assert.equal(decision.corpus.n, TASK_SET.tasks.length);
  assert.equal(decision.splits.train.n, TASK_SET.train.length);
  assert.equal(decision.splits.heldout.n, TASK_SET.heldout.length);
  assert.equal(decision.corpus.cases.some((c) => c.key === KEY[LEAKED]), true);
  assert.equal(decision.corpus.gain, 1);
  assert.equal(decision.infra.baseline['source-unverified'], 0);
  assert.equal(decision.infra.candidate.missing, 0);
  assert.deepEqual(decision.inputs.baseline.iterations, N_ITERS);
  assert.deepEqual(decision.inputs.candidate.iterations, D_SETS.gain);
  const g60 = g60Findings(decision);
  assert.deepEqual(g60.findings, []);
  assert.equal(g60.decisions, 1);
  assert.match(out, /decision corpus: gain-above-noise \(above-band\)/);
  assert.match(out, /band 0\.050/);
  assert.match(out, /ci95 \[/);
});

test('report: arm D that finds the same gives within-noise', async () => {
  await setup();
  const { decision } = await decisionOf(D_SETS.same, ['--noise', NOISE_FILE]);
  assert.deepEqual(noise.validateDecision(decision), []);
  assert.equal(decision.verdict, 'within-noise');
  assert.equal(decision.corpus.reason, 'inside-band');
  assert.equal(decision.corpus.gain, 0);
  assert.deepEqual(g60Findings(decision).findings, []);
});

test('report: a gain on train only sets overfitSuspected', async () => {
  await setup();
  const { decision } = await decisionOf(D_SETS.trainOnly, ['--noise', NOISE_FILE]);
  assert.deepEqual(noise.validateDecision(decision), []);
  assert.equal(decision.splits.train.verdict, 'gain-above-noise');
  assert.equal(decision.splits.heldout.verdict, 'within-noise');
  assert.equal(decision.overfitSuspected, true);
  assert.deepEqual(g60Findings(decision).findings, []);
});

test('report: without a noise file the decision is inconclusive with no-noise-band; the default results path is read when present', async () => {
  await setup();
  const empty = path.join(TMP, 'results-empty');
  const none = await decisionOf(D_SETS.gain, [], { resultsDir: empty });
  assert.equal(none.decision.verdict, 'inconclusive');
  for (const scope of [none.decision.corpus, none.decision.splits.train, none.decision.splits.heldout]) assert.equal(scope.reason, 'no-noise-band');
  assert.equal(none.decision.inputs.baseline.source, 'none');
  assert.deepEqual(noise.validateDecision(none.decision), []);
  assert.deepEqual(g60Findings(none.decision).findings, []);

  const withDefault = path.join(TMP, 'results-default');
  fs.mkdirSync(withDefault);
  fs.copyFileSync(NOISE_FILE, path.join(withDefault, 'noise.json'));
  const found = await decisionOf(D_SETS.gain, [], { resultsDir: withDefault });
  assert.equal(found.decision.verdict, 'gain-above-noise');
  assert.match(found.decision.inputs.noiseArtifact.sha256, /^[0-9a-f]{64}$/);
  assert.ok(found.decision.inputs.noiseArtifact.path.endsWith('results-default/noise.json'));

  const missing = await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', path.join(TMP, 'no-such-noise.json')]);
  assert.equal(missing.code, 2, 'an explicit --noise that does not exist is refused');
});

test('report: an edited task (new key) gives noise-case-set-mismatch', async () => {
  await setup();
  const held = readJson(path.join(REPO, 'bench', 'agentic', 'tasks-heldout.json'));
  held.tasks[0].query = `${held.tasks[0].query} (edited)`;
  const heldoutPath = path.join(TMP, 'tasks-heldout-edited.json');
  fs.writeFileSync(heldoutPath, JSON.stringify(held));
  const edited = loadTaskSet({ heldoutPath });
  const originalKey = LOADED_TASK_SET.tasks.find((t) => t.id === held.tasks[0].id).key;
  assert.notEqual(edited.tasks.find((t) => t.id === held.tasks[0].id).key, originalKey);
  const { decision } = await decisionOf(D_SETS.gain, ['--noise', NOISE_FILE], { taskSet: edited });
  assert.equal(decision.precondition, 'noise-case-set-mismatch');
  assert.equal(decision.verdict, 'inconclusive');
  assert.deepEqual(noise.validateDecision(decision), []);
});

test('report: a different model label gives noise-model-mismatch', async () => {
  await setup();
  const { decision } = await decisionOf(D_SETS.gain, ['--noise', NOISE_FILE], { config: configWith('fake:e2e-model:high') });
  assert.equal(decision.precondition, 'noise-model-mismatch');
  assert.equal(decision.verdict, 'inconclusive');
  assert.deepEqual(noise.validateDecision(decision), []);
  assert.deepEqual(g60Findings(decision).findings, []);
});

// --- the token report --------------------------------------------------------------------------

test('report: the descriptive token report leaves an unknown-usage run out of the totals and counts it', async () => {
  await setup();
  const r = await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', NOISE_FILE, '--json']);
  assert.equal(r.code, 0, r.err);
  const { tokens, decision } = JSON.parse(r.out);
  assert.equal(decision.kind, 'bench-decision');
  assert.equal(tokens.label, 'descriptive');
  assert.deepEqual(tokens.N, {
    iterations: N_ITERS, runs: N_RUN_COUNT, recorded: N_RECORDED_COUNT, unknown: N_UNKNOWN_COUNT, totalTokens: N_RECORDED_COUNT * 40000, medianTokensPerTask: 40000, repeatMeans: [40000, 40000, 40000],
  });
  assert.deepEqual(tokens.D, {
    iterations: D_SETS.gain, runs: N_RUN_COUNT, recorded: N_RUN_COUNT, unknown: 0, totalTokens: N_RUN_COUNT * 30000, medianTokensPerTask: 30000, repeatMeans: [30000, 30000, 30000],
  });
  assert.equal(tokens.ratioDtoN, 0.75);
  assert.equal(tokens.nTokenRange, 0);
  assert.equal('total_tokens' in readJson(path.join(RUN_ROOT, 'n-r2', UNKNOWN_USAGE, 'timing.json')), false, 'the fixture run really has unknown usage');

  const text = await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', NOISE_FILE]);
  assert.match(text.out, /tokens \(descriptive/);
  assert.match(text.out, /ratioDtoN 0\.75/);

  const withoutBand = await cli(['report', '--iterations', D_SETS.gain.join(','), '--json'], { resultsDir: path.join(TMP, 'results-empty') });
  const t = JSON.parse(withoutBand.out).tokens;
  assert.equal(t.N.runs, 0, 'arm N figures come only from the iterations a noise artifact names');
  assert.equal(t.ratioDtoN, null);
  assert.equal(t.nTokenRange, null);
});

test('report: two runs are byte-equal (stdout and decision file)', async () => {
  await setup();
  const file = path.join(TMP, 'decision-twice.json');
  const a = await decisionOf(D_SETS.gain, ['--noise', NOISE_FILE], {}, file);
  const firstBytes = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  const b = await decisionOf(D_SETS.gain, ['--noise', NOISE_FILE], {}, file);
  assert.equal(fs.readFileSync(file, 'utf8'), firstBytes);
  assert.equal(a.out, b.out);
  const ja = await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', NOISE_FILE, '--json']);
  const jb = await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', NOISE_FILE, '--json']);
  assert.equal(ja.out, jb.out);
});

// --- refusals and the offline verbs ------------------------------------------------------------

test('noise refuses arm D iterations, a mixed model or source, a missing task and a missing grading.json (exit 2)', async () => {
  await setup();
  const armD = await cli(['noise', '--iterations', D_SETS.gain.join(',')]);
  assert.equal(armD.code, 2);
  assert.match(armD.err, /d-r1.*arm D/);

  const report = await cli(['report', '--iterations', N_ITERS.join(','), '--noise', NOISE_FILE]);
  assert.equal(report.code, 2, 'report reads arm D iterations only');
  assert.match(report.err, /n-r1.*arm N/);

  const root = path.join(TMP, 'runs-broken');
  fs.cpSync(RUN_ROOT, root, { recursive: true });
  const missingTask = TASK_SET.tasks[1].id;
  const iter = path.join(root, 'n-r3', 'iteration.json');
  const meta = readJson(iter);
  fs.writeFileSync(iter, JSON.stringify({ ...meta, model: 'other:model' }));
  const mixed = await cli(['noise', '--iterations', N_ITERS.join(',')], { runRoot: root });
  assert.equal(mixed.code, 2);
  assert.match(mixed.err, /model/);
  fs.writeFileSync(iter, JSON.stringify({ ...meta, sourceAt: '0'.repeat(40) }));
  assert.equal((await cli(['noise', '--iterations', N_ITERS.join(',')], { runRoot: root })).code, 2);
  fs.writeFileSync(iter, JSON.stringify(meta));

  fs.rmSync(path.join(root, 'n-r2', missingTask, 'grading.json'));
  const ungraded = await cli(['noise', '--iterations', N_ITERS.join(',')], { runRoot: root });
  assert.equal(ungraded.code, 2);
  assert.match(ungraded.err, new RegExp(`n-r2/${missingTask}.*grading\\.json`));

  fs.rmSync(path.join(root, 'n-r2', missingTask), { recursive: true });
  const short = await cli(['noise', '--iterations', N_ITERS.join(',')], { runRoot: root });
  assert.equal(short.code, 2);
  assert.match(short.err, new RegExp(`n-r2/${missingTask}`));

  assert.equal((await cli(['noise', '--iterations', 'n-r1,n-r2'])).code, 2, 'fewer than k repeats');
  assert.equal((await cli(['noise', '--iterations', 'n-r1,n-r1,n-r2'])).code, 2, 'a repeated iteration');
  assert.equal((await cli(['noise', '--iterations', 'n-r1,../x,n-r2'])).code, 2, 'an unsafe iteration name');
});

test('plan, grade, noise and report spawn nothing', async () => {
  await setup();
  const { result, calls } = await noSpawn(async () => [
    await cli(['plan', '--iteration', 'dry', '--arm', 'N']),
    await cli(['grade', '--iteration', 'n-r1']),
    await cli(['noise', '--iterations', N_ITERS.join(',')]),
    await cli(['report', '--iterations', D_SETS.gain.join(','), '--noise', NOISE_FILE]),
  ]);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.map((r) => r.code), [0, 0, 0, 0], result.map((r) => r.err).join('\n'));
});

test('the CLI refuses an unknown verb or flag, a missing required flag, and execute without --cap, spawning nothing', async () => {
  const bin = binFor('basic-refusal');
  const { result, calls } = await noSpawn(async () => ({
    noVerb: await cli([]),
    verb: await cli(['frobnicate']),
    flag: await cli(['plan', '--iteration', 'dry', '--arm', 'N', '--frob']),
    misplaced: await cli(['grade', '--iteration', 'n-r1', '--cap', '5']),
    positional: await cli(['noise', 'extra', '--iterations', 'a,b,c']),
    noIteration: await cli(['plan', '--arm', 'N']),
    noCap: await cli(['execute', '--iteration', 'nocap', '--arm', 'N'], { bin }),
    badCap: await cli(['execute', '--iteration', 'nocap', '--arm', 'N', '--cap', '1e6'], { bin }),
  }));
  assert.deepEqual(calls, [], 'nothing was spawned, not even git or --version');
  for (const [name, r] of Object.entries(result)) assert.equal(r.code, 2, `${name}: ${r.err}`);
  assert.match(result.verb.err, /unknown verb/);
  assert.match(result.flag.err, /--frob/);
  assert.match(result.noCap.err, /cap/);
  assert.equal(fs.existsSync(path.join(RUN_ROOT, 'nocap')), false);
});

test('plan prints the projection and the paid stages as text only; --json carries them under stages', async () => {
  const text = await cli(['plan', '--iteration', 'dry', '--arm', 'N']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /harness e2e/);
  assert.match(text.out, /model fake:e2e-model/);
  assert.match(text.out, new RegExp(`snapshot ${TASK_SET.snapshot.commit}`));
  assert.match(text.out, /<prompt sha256:[0-9a-f]{64} bytes:\d+>/);
  const projectedCap = TASK_SET.tasks.length * CONFIG.maxTokensPerRun;
  assert.match(text.out, new RegExp(`ceilingTokens ${projectedCap}`));
  const first = TASK_SET.train[0].id;
  for (const line of [
    `npm run bench -- agentic execute --iteration rehearsal-N --arm N --tasks ${first} --cap ${CONFIG.maxTokensPerRun}`,
    `npm run bench -- agentic execute --iteration rehearsal-D --arm D --tasks ${first} --cap ${CONFIG.maxTokensPerRun}`,
    `npm run bench -- agentic execute --iteration n-r1 --arm N --cap ${projectedCap}`,
    `npm run bench -- agentic execute --iteration d-r3 --arm D --cap ${projectedCap}`,
    'npm run bench -- agentic grade --iteration n-r2',
    'npm run bench -- agentic noise --iterations n-r1,n-r2,n-r3 --out bench/agentic/results/noise.json',
    'npm run bench -- agentic report --iterations d-r1,d-r2,d-r3 --decision-out bench/agentic/results/decision.json',
  ]) assert.ok(text.out.includes(line), `missing: ${line}`);
  assert.match(text.out, /paid/);
  assert.match(text.out, /O-1, O-2, O-5/);
  assert.match(text.out, /stage figures: --cap applies per execute command/);

  const json = await cli(['plan', '--iteration', 'dry', '--arm', 'D', '--tasks', first, '--json']);
  assert.equal(json.code, 0, json.err);
  const plan = JSON.parse(json.out);
  assert.equal(plan.projection.runs, 1);
  assert.deepEqual(Object.keys(plan.stages), ['R', 'N', 'D', 'note', 'capScope']);
  assert.match(plan.stages.capScope, new RegExp(`stage N: 3 x ${projectedCap} = ${3 * projectedCap} tokens plus up to 3 one-run overshoots`), 'R-8: the per-command cap scope');
  assert.ok(plan.stages.N.includes(`npm run bench -- agentic execute --iteration n-r1 --arm N --cap ${projectedCap}`), 'stage caps use the selected task set');
  assert.equal(fs.existsSync(path.join(RUN_ROOT, 'dry')), false, 'plan writes nothing');
});

test('bench/runner.ts forwards `agentic` to the agentic runner', async () => {
  const runner = require('../../bench/runner.ts');
  const saved = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const savedWrite = process.stderr.write;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try {
    assert.equal(await runner.main(['agentic', 'frobnicate']), 2);
  } finally {
    console.error = saved;
    process.stderr.write = savedWrite;
  }
  assert.ok(errors.join('').includes('unknown verb'), errors.join(''));
});
