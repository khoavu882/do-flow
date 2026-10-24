'use strict';

// 096 C.2: report decision block per scope and split from the noise artifact, with
// --noise, --decision-out, comma iterations, overfit flag, preconditions and negative controls.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../../bench/runner.ts');
const noise = require('../../bench/noise.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'bench-noise');

function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const out = [];
  const warn = [];
  const err = [];
  console.log = (...args) => out.push(args.join(' '));
  console.warn = (...args) => warn.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const status = fn();
    return { status, out: out.join('\n'), warn: warn.join('\n'), err: err.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

let f;
let sharedNoiseFile;

const baseIters = ['banded-base-r1', 'banded-base-r2', 'banded-base-r3'];
const candIters = ['banded-cand-r1', 'banded-cand-r2', 'banded-cand-r3'];
const allIters = [
  ...baseIters,
  ...candIters,
  'candidate-differ-r1',
  'candidate-differ-r2',
  'candidate-missing',
  'candidate-infra',
];

const commitForIter = {
  'candidate-differ-r1': 'c0ffee1111111111111111111111111111111111',
  'candidate-differ-r2': 'deadbeef22222222222222222222222222222222',
};

before(() => {
  const root = suiteTempDir('doflow-bench-report-');
  const runsRoot = path.join(root, 'runs');
  const baselineDir = path.join(root, 'baseline');
  const baselineFile = path.join(baselineDir, 'baseline.json');
  const reportsDir = path.join(root, 'reports');
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));

  const cfg = {
    ...runner.loadConfig(),
    benchRoot: 'test/fixtures/bench-noise/corpus',
    skillsRoot: 'test/fixtures/bench-noise/skills',
    baselineDir: path.relative(REPO_ROOT, baselineDir),
    reportsDir: path.relative(REPO_ROOT, reportsDir),
    model: 'claude-noise-fixture',
  };

  const evalsByKey = new Map();
  for (const skill of ['alpha', 'beta']) {
    for (const evaluation of runner.loadCases(cfg, skill).evals) {
      evalsByKey.set(`${skill}/${evaluation.id}`, { skill, evaluation });
    }
  }

  for (const iterName of allIters) {
    const iterRoot = path.join(runsRoot, iterName);
    fs.mkdirSync(iterRoot, { recursive: true });

    const stamp = {
      model: cfg.model,
      sourceAt: commitForIter[iterName] || 'a4d64234567890abcdef1234567890abcdef12',
    };
    fs.writeFileSync(path.join(iterRoot, 'iteration.json'), `${JSON.stringify(stamp, null, 2)}\n`);

    const scenarios = scenarioSets[iterName] || {};
    for (const [key, scenario] of Object.entries(scenarios)) {
      const match = evalsByKey.get(key);
      if (!match) continue;
      const { skill, evaluation } = match;
      const runDir = path.join(iterRoot, skill, `eval-${evaluation.id}-${evaluation.name}`);
      fs.mkdirSync(runDir, { recursive: true });
      if (!scenario.noOutput && Array.isArray(scenario.transcriptTokens)) {
        fs.writeFileSync(path.join(runDir, 'transcript.txt'), `${scenario.transcriptTokens.join(' ')}\n`);
      }
      if (scenario.routing !== undefined) {
        fs.writeFileSync(path.join(runDir, 'routing.json'), `${JSON.stringify(scenario.routing)}\n`);
      }
      if (scenario.run_status !== undefined) {
        const contents = typeof scenario.run_status === 'string'
          ? scenario.run_status
          : `${JSON.stringify(scenario.run_status)}\n`;
        fs.writeFileSync(path.join(runDir, 'run_status.json'), contents);
      }
      if (scenario.skill_source !== undefined) {
        fs.writeFileSync(path.join(runDir, 'skill_source.json'), JSON.stringify(scenario.skill_source));
      } else {
        const skillSha = runner.skillSourceSha256(cfg, skill);
        fs.writeFileSync(path.join(runDir, 'skill_source.json'), JSON.stringify({
          skill,
          path: `/abs/.doflow/worktrees/000/.claude/skills/${skill}/SKILL.md`,
          sha256: skillSha,
        }));
      }
    }
    quiet(() => runner.cmdGrade(cfg, { iteration: iterName, runsRoot }));
  }

  quiet(() => runner.cmdBaseline(cfg, { from: 'banded-base-r1', runsRoot, baselineFile }));

  sharedNoiseFile = path.join(root, 'shared-noise.json');
  quiet(() => runner.cmdNoise(cfg, {
    iterations: baseIters.join(','),
    runsRoot,
    out: sharedNoiseFile,
  }));

  f = { cfg, runsRoot, baselineFile, baselineDir, reportsDir, root };
});

test('C.2: with no artifact, fixture baseline prints three no-noise-band lines and do-not-merge (S-3 on fixtures), exit 0', () => {
  quiet(() => runner.cmdBaseline(f.cfg, { from: 'banded-base-r1', runsRoot: f.runsRoot, baselineFile: f.baselineFile }));

  // Run report without noise artifact
  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
  }));

  assert.equal(run.status, 0, 'exits 0');
  assert.match(run.out, /decision corpus: inconclusive \(no-noise-band\) -> do-not-merge/);
  assert.match(run.out, /decision train: inconclusive \(no-noise-band\) -> do-not-merge/);
  assert.match(run.out, /decision heldout: inconclusive \(no-noise-band\) -> do-not-merge/);
  assert.match(run.out, /overfitSuspected: false/);

  // Check generated report JSON
  const reportPath = path.join(f.reportsDir, 'banded-cand-r1-vs-baseline.json');
  assert.ok(fs.existsSync(reportPath), 'report file exists');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.ok(report.decision, 'report.decision exists');
  assert.equal(report.decision.corpus.verdict, 'inconclusive');
  assert.equal(report.decision.corpus.reason, 'no-noise-band');
  assert.equal(report.decision.corpus.recommendation, 'do-not-merge');
  assert.deepEqual(noise.validateDecision(report.decision), []);
});

test('C.2: an explicit --noise that is missing exits 2', () => {
  const missingNoise = path.join(f.root, 'missing-noise.json');
  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: missingNoise,
  }));

  assert.equal(run.status, 2, 'exits 2 on missing explicit noise');
  assert.match(run.err, new RegExp(`bench report: no noise artifact at ${missingNoise.replace(/\\/g, '\\\\')}`));
});

test('C.2: preconditions derived in design §4 order on their own fixtures', () => {
  assert.ok(fs.existsSync(sharedNoiseFile));
  const validNoise = JSON.parse(fs.readFileSync(sharedNoiseFile, 'utf8'));

  // 1. noise-artifact-invalid
  {
    const invalidNoiseFile = path.join(f.root, 'invalid-noise.json');
    fs.writeFileSync(invalidNoiseFile, '{"kind": "not-bench-noise"}\n');
    const run = quiet(() => runner.cmdReport(f.cfg, {
      iteration: 'banded-cand-r1',
      runsRoot: f.runsRoot,
      baselineFile: f.baselineFile,
      noise: invalidNoiseFile,
    }));
    assert.equal(run.status, 0);
    assert.match(run.out, /decision corpus: inconclusive \(noise-artifact-invalid\) -> do-not-merge/);
  }

  // 2. noise-model-mismatch
  {
    const mismatchModelFile = path.join(f.root, 'model-mismatch-noise.json');
    const modelMismatch = { ...validNoise, model: 'other-model' };
    fs.writeFileSync(mismatchModelFile, `${JSON.stringify(modelMismatch, null, 2)}\n`);
    const run = quiet(() => runner.cmdReport(f.cfg, {
      iteration: 'banded-cand-r1',
      runsRoot: f.runsRoot,
      baselineFile: f.baselineFile,
      noise: mismatchModelFile,
    }));
    assert.equal(run.status, 0);
    assert.match(run.out, /decision corpus: inconclusive \(noise-model-mismatch\) -> do-not-merge/);
  }

  // 3. noise-case-set-mismatch
  {
    const mismatchCasesFile = path.join(f.root, 'case-mismatch-noise.json');
    const cases = { ...validNoise.cases };
    delete cases['beta/4'];
    const caseMismatch = {
      ...validNoise,
      caseKeys: Object.keys(cases).sort(),
      cases,
    };
    fs.writeFileSync(mismatchCasesFile, `${JSON.stringify(caseMismatch, null, 2)}\n`);
    const run = quiet(() => runner.cmdReport(f.cfg, {
      iteration: 'banded-cand-r1',
      runsRoot: f.runsRoot,
      baselineFile: f.baselineFile,
      noise: mismatchCasesFile,
    }));
    assert.equal(run.status, 0);
    assert.match(run.out, /decision corpus: inconclusive \(noise-case-set-mismatch\) -> do-not-merge/);
  }

  // 4. noise-unusable
  {
    const unusableFile = path.join(f.root, 'unusable-noise.json');
    const unusable = { ...validNoise, verdict: 'grader-unstable', graderRerun: { differing: ['alpha/1'] } };
    fs.writeFileSync(unusableFile, `${JSON.stringify(unusable, null, 2)}\n`);
    const run = quiet(() => runner.cmdReport(f.cfg, {
      iteration: 'banded-cand-r1',
      runsRoot: f.runsRoot,
      baselineFile: f.baselineFile,
      noise: unusableFile,
    }));
    assert.equal(run.status, 0);
    assert.match(run.out, /decision corpus: inconclusive \(noise-unusable\) -> do-not-merge/);
  }

  // 5. candidate-repeats-differ
  {
    const run = quiet(() => runner.cmdReport(f.cfg, {
      iteration: 'candidate-differ-r1,candidate-differ-r2',
      runsRoot: f.runsRoot,
      baselineFile: f.baselineFile,
      noise: sharedNoiseFile,
    }));
    assert.equal(run.status, 0);
    assert.match(run.out, /decision corpus: inconclusive \(candidate-repeats-differ\) -> do-not-merge/);
  }
});

test('C.2: banded fixture gives expected corpus, train and heldout verdicts, overfitSuspected and heldout headroomLimited', () => {
  const decisionOutFile = path.join(f.root, 'standalone-decision.json');
  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: candIters.join(','),
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': decisionOutFile,
  }));

  assert.equal(run.status, 0);
  assert.match(run.out, /decision corpus: gain-above-noise \(above-band\) -> merge-candidate; gain \+0\.500 over n 8, ci95 \[0\.125, 0\.875\]/);
  assert.match(run.out, /decision train: gain-above-noise \(above-band\) -> merge-candidate; gain \+1\.000 over n 4, ci95 \[1\.000, 1\.000\]/);
  assert.match(run.out, /decision heldout: within-noise \(inside-band\) -> do-not-merge; gain \+0\.000 over n 4, ci95 \[0\.000, 0\.000\]\s+\[heldout at headroom: no gain is visible here\]/);
  assert.match(run.out, /overfitSuspected: true/);

  // Validate standalone decision output
  assert.ok(fs.existsSync(decisionOutFile));
  const dec = JSON.parse(fs.readFileSync(decisionOutFile, 'utf8'));
  assert.equal(dec.verdict, 'gain-above-noise');
  assert.equal(dec.recommendation, 'merge-candidate');
  assert.equal(dec.corpus.verdict, 'gain-above-noise');
  assert.equal(dec.splits.train.verdict, 'gain-above-noise');
  assert.equal(dec.splits.train.headroomLimited, false);
  assert.equal(dec.splits.heldout.verdict, 'within-noise');
  assert.equal(dec.splits.heldout.headroomLimited, true);
  assert.equal(dec.overfitSuspected, true);
  assert.deepEqual(noise.validateDecision(dec), []);
});

test('C.2: an expected key with no candidate grading counts as excluded missing', () => {
  const decisionFile = path.join(f.root, 'missing-decision.json');
  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'candidate-missing',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': decisionFile,
  }));

  assert.equal(run.status, 0);
  const dec = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  assert.equal(dec.infra.candidate.missing, 1, 'candidate has 1 missing case');
  assert.equal(dec.corpus.unpaired.baselineOnly, 1);
});

test('C.2: infra runs are excluded and counted', () => {
  const decisionFile = path.join(f.root, 'infra-decision.json');
  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'candidate-infra',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': decisionFile,
  }));

  assert.equal(run.status, 0);
  const dec = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  assert.equal(dec.infra.candidate.timeout, 1, 'candidate timeout counted');
  assert.equal(dec.corpus.infraShare.candidate, 1 / 8);
  // Alpha 1 was timeout, so not paired
  assert.equal(dec.corpus.cases.some((c) => c.key === 'alpha/1'), false);
});

test('C.2: buildReport omits decision and checks 6 fields on existing fixtures', () => {
  const baseline = {
    commit: 'a4d642',
    model: 'claude-noise-fixture',
    results: [
      { key: 'alpha/1', kind: 'triggering', split: 'train', passRate: 1.0, sourceStatus: 'verified' },
      { key: 'alpha/2', kind: 'behavioral', split: 'train', passRate: 0.5, sourceStatus: 'verified' },
    ],
  };
  const withResults = [
    {
      key: 'alpha/1',
      kind: 'triggering',
      split: 'train',
      passRate: 1.0,
      sourceStatus: 'verified',
      expectations: [{ text: 'e1', passed: true }],
      usage: { total_tokens: 100, duration_ms: 10 },
    },
    {
      key: 'alpha/2',
      kind: 'behavioral',
      split: 'train',
      passRate: 1.0,
      sourceStatus: 'verified',
      expectations: [{ text: 'e2', passed: true }],
      usage: { total_tokens: 200, duration_ms: 20 },
    },
  ];
  const cfg = { ...runner.loadConfig(), model: 'claude-noise-fixture' };

  const report = runner.buildReport({
    baseline,
    withResults,
    withoutResults: [],
    cfg,
    iteration: 'test-iter',
    commit: 'c0ffee',
  });

  // Verify buildReport does NOT contain decision key (decision is additive in cmdReport)
  assert.equal('decision' in report, false, 'buildReport does not add decision property');
  assert.equal(report.currentIteration, 'test-iter');
  assert.equal(report.currentCommit, 'c0ffee');
  assert.equal(report.rows.length, 2);
  assert.equal(report.summary.improved, 1);
  assert.equal(report.summary.unchanged, 1);
});

test('C.2: report file naming: one iteration keeps <it>-vs-baseline.json; several give a+b+c-vs-baseline.json', () => {
  // Single iteration
  quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
  }));
  assert.ok(fs.existsSync(path.join(f.reportsDir, 'banded-cand-r1-vs-baseline.json')));

  // Multiple iterations
  quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1,banded-cand-r2,banded-cand-r3',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
  }));
  assert.ok(fs.existsSync(path.join(f.reportsDir, 'banded-cand-r1+banded-cand-r2+banded-cand-r3-vs-baseline.json')));
});

test('C.2: report and decision JSON are byte-equal across two runs', () => {
  const dec1 = path.join(f.root, 'dec1.json');
  const dec2 = path.join(f.root, 'dec2.json');

  quiet(() => runner.cmdReport(f.cfg, {
    iteration: candIters.join(','),
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': dec1,
  }));
  const repFile = path.join(f.reportsDir, `${candIters.join('+')}-vs-baseline.json`);
  const repContent1 = fs.readFileSync(repFile, 'utf8');
  const decContent1 = fs.readFileSync(dec1, 'utf8');

  quiet(() => runner.cmdReport(f.cfg, {
    iteration: candIters.join(','),
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': dec2,
  }));
  const repContent2 = fs.readFileSync(repFile, 'utf8');
  const decContent2 = fs.readFileSync(dec2, 'utf8');

  assert.equal(repContent1, repContent2, 'report JSON byte-equal');
  assert.equal(decContent1, decContent2, 'decision JSON byte-equal');
});

test('C.2: default noise path resolves beside baselineFileOf (RK4)', () => {
  const defaultDir = path.join(f.root, 'default-noise-test');
  fs.mkdirSync(defaultDir, { recursive: true });
  const defaultBaseFile = path.join(defaultDir, 'baseline.json');
  fs.copyFileSync(f.baselineFile, defaultBaseFile);
  const defaultNoiseFile = path.join(defaultDir, 'noise.json');
  fs.copyFileSync(sharedNoiseFile, defaultNoiseFile);

  const run = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: defaultBaseFile,
  }));

  assert.equal(run.status, 0);
  assert.match(run.out, /decision corpus: gain-above-noise/);
  const reportPath = path.join(f.reportsDir, 'banded-cand-r1-vs-baseline.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.decision.corpus.verdict, 'gain-above-noise');
  assert.notEqual(report.decision.corpus.reason, 'no-noise-band');
});

test('C.2 negative control: using baseline.json (k = 1) as the baseline side changes the banded verdict (red)', () => {
  const controlDir = path.join(f.root, 'control-test');
  fs.mkdirSync(controlDir, { recursive: true });
  const baseJson = JSON.parse(fs.readFileSync(f.baselineFile, 'utf8'));
  for (const r of baseJson.results) {
    if (r.split === 'train') r.passRate = 1.0;
  }
  const controlBaseFile = path.join(controlDir, 'baseline.json');
  fs.writeFileSync(controlBaseFile, `${JSON.stringify(baseJson, null, 2)}\n`);

  const decFile = path.join(controlDir, 'banded-dec.json');
  quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: controlBaseFile,
    noise: sharedNoiseFile,
    'decision-out': decFile,
  }));
  const dec = JSON.parse(fs.readFileSync(decFile, 'utf8'));
  assert.equal(dec.splits.train.verdict, 'gain-above-noise');

  // Control: if decision was computed using baseline.json (passRate 1.0) instead of noise artifact:
  const baselineResults = baseJson.results;
  const mockBaseRepeats = Object.fromEntries(baselineResults.filter((r) => r.split === 'train').map((r) => [r.key, [r.passRate]]));
  const candScores = Object.fromEntries(baselineResults.filter((r) => r.split === 'train').map((r) => [r.key, [1.0]]));
  const wrongDecision = noise.decide({
    scope: 'train',
    baseline: mockBaseRepeats,
    candidate: candScores,
    excluded: { baseline: { runs: 4, excluded: 0 }, candidate: { runs: 4, excluded: 0 } },
    noise: 0.0,
    mde: 0.05,
    maxInfraShare: 0.1,
    seed: 96,
  });
  // The wrong decision gives 'within-noise' because gain is 0.0, NOT 'gain-above-noise'
  assert.equal(wrongDecision.verdict, 'within-noise');
  assert.notEqual(wrongDecision.verdict, dec.splits.train.verdict);
});

test('C.2 negative control: dropping the model precondition turns the mismatch case red', () => {
  const validNoise = JSON.parse(fs.readFileSync(sharedNoiseFile, 'utf8'));
  const mismatchModelFile = path.join(f.root, 'mismatch-noise.json');
  const modelMismatch = { ...validNoise, model: 'other-model' };
  fs.writeFileSync(mismatchModelFile, `${JSON.stringify(modelMismatch, null, 2)}\n`);

  const decFile = path.join(f.root, 'mismatch-dec.json');
  quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: mismatchModelFile,
    'decision-out': decFile,
  }));

  const dec = JSON.parse(fs.readFileSync(decFile, 'utf8'));
  assert.equal(dec.precondition, 'noise-model-mismatch');
  assert.equal(dec.corpus.verdict, 'inconclusive');

  // Control: if model precondition was dropped, verdict would evaluate to gain-above-noise (RED)
  const candidateRepeats = [runner.readRepeat(f.cfg, path.join(f.runsRoot, 'banded-cand-r1'), { rerun: false })];
  const droppedPreconditionDecision = noise.buildDecision({
    noise: { ...modelMismatch, model: f.cfg.model }, // simulate dropping model check
    noiseFile: { path: 'mismatch-noise.json', sha256: 'abc' },
    baselineFile: JSON.parse(fs.readFileSync(f.baselineFile, 'utf8')),
    model: f.cfg.model,
    candidate: candidateRepeats,
    thresholds: noise.loadNoiseConfig(f.cfg),
  });
  assert.equal(droppedPreconditionDecision.precondition, null);
  assert.equal(droppedPreconditionDecision.corpus.verdict, 'gain-above-noise');
  assert.notEqual(droppedPreconditionDecision.corpus.verdict, dec.corpus.verdict);
});

test('C-1: cmdReport exits 2 when candidate stamp has no model or no sourceAt, or is missing', () => {
  const candDir = path.join(f.root, 'c1-cand-stamp', 'runs');
  fs.mkdirSync(path.join(candDir, 'cand-no-model'), { recursive: true });
  fs.mkdirSync(path.join(candDir, 'cand-no-sourceat'), { recursive: true });
  fs.mkdirSync(path.join(candDir, 'cand-no-stamp'), { recursive: true });

  fs.writeFileSync(path.join(candDir, 'cand-no-model', 'iteration.json'), JSON.stringify({ sourceAt: 'abc1234', model: null }));
  fs.writeFileSync(path.join(candDir, 'cand-no-sourceat', 'iteration.json'), JSON.stringify({ sourceAt: null, model: f.cfg.model }));

  // Candidate with no model
  const runNoModel = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'cand-no-model',
    runsRoot: candDir,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
  }));
  assert.equal(runNoModel.status, 2);
  assert.match(runNoModel.err, /cand-no-model: model not recorded: re-grade/);

  // Candidate with no sourceAt
  const runNoSourceAt = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'cand-no-sourceat',
    runsRoot: candDir,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
  }));
  assert.equal(runNoSourceAt.status, 2);
  assert.match(runNoSourceAt.err, /cand-no-sourceat: measured commit unknown: re-grade with --source-at/);

  // Candidate with missing iteration.json
  const runNoStamp = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'cand-no-stamp',
    runsRoot: candDir,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
  }));
  assert.equal(runNoStamp.status, 2);
  assert.match(runNoStamp.err, /cand-no-stamp: measured commit unknown: re-grade with --source-at/);
});

test('C-1 negative control: valid model and sourceAt candidate stamp passes stamp checks', () => {
  const candDir = path.join(f.root, 'c1-cand-valid', 'runs');
  fs.mkdirSync(path.join(candDir, 'cand-valid'), { recursive: true });
  fs.writeFileSync(path.join(candDir, 'cand-valid', 'iteration.json'), JSON.stringify({ sourceAt: 'abc1234', model: f.cfg.model }));

  const runValid = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'cand-valid',
    runsRoot: candDir,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
  }));
  assert.notEqual(runValid.status, 2);
});

test('C-2: readRepeat excludes runs with unverified skill_source status as source-unverified with passRate null', () => {
  const rootDir = path.join(f.root, 'c2-test');
  const runsRoot = path.join(rootDir, 'runs');
  const iterName = 'cand-fallback-r1';
  const iterDir = path.join(runsRoot, iterName);

  for (const skill of ['alpha', 'beta']) {
    const evals = runner.loadCases(f.cfg, skill).evals;
    for (const e of evals) {
      const runDir = path.join(iterDir, skill, `eval-${e.id}-${e.name}`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'grading.json'), JSON.stringify({
        skill,
        eval_id: e.id,
        arm: 'with-skill',
        split: e.split,
        skill_source: { status: 'global-fallback', recordedPath: '/some/fallback/path' },
        expectations: [{ passed: true }],
        pass_rate: 1.0,
        infra: null,
        run_status: { status: 'completed' },
      }));
    }
  }
  fs.writeFileSync(path.join(iterDir, 'iteration.json'), JSON.stringify({ sourceAt: 'abc1234', model: f.cfg.model }));

  // 1. Stored path (rerun: false)
  const storedRepeat = runner.readRepeat(f.cfg, iterDir, { iteration: iterName, rerun: false });
  assert.equal(storedRepeat.runs['alpha/1'].excluded, 'source-unverified');
  assert.equal(storedRepeat.runs['alpha/1'].passRate, null);
  for (const k of Object.keys(storedRepeat.runs)) {
    assert.equal(storedRepeat.runs[k].excluded, 'source-unverified', `stored run ${k} excluded`);
    assert.equal(storedRepeat.runs[k].passRate, null, `stored run ${k} passRate null`);
  }

  // 2. Candidate with 8 global-fallback gradings against banded baseline yields inconclusive (infra-share)
  const decFile = path.join(rootDir, 'fallback-decision.json');
  const runReport = quiet(() => runner.cmdReport(f.cfg, {
    iteration: iterName,
    runsRoot,
    baselineFile: f.baselineFile,
    noise: sharedNoiseFile,
    'decision-out': decFile,
  }));
  assert.equal(runReport.status, 0);
  assert.match(runReport.out, /decision corpus: inconclusive \(infra-share\) -> do-not-merge/);
  const dec = JSON.parse(fs.readFileSync(decFile, 'utf8'));
  assert.equal(dec.corpus.verdict, 'inconclusive');
  assert.equal(dec.corpus.reason, 'infra-share');
  assert.equal(dec.recommendation, 'do-not-merge');
  assert.equal(dec.infra.candidate['source-unverified'], 8);

  // 3. Same runs used as baseline repeats for cmdNoise must not give usable
  for (const r of ['fallback-noise-r1', 'fallback-noise-r2', 'fallback-noise-r3']) {
    const rDir = path.join(runsRoot, r);
    fs.cpSync(iterDir, rDir, { recursive: true });
  }
  const runNoise = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'fallback-noise-r1,fallback-noise-r2,fallback-noise-r3',
    runsRoot,
  }));
  assert.equal(runNoise.status, 1, 'unverified repeats in noise must exit 1 (inconclusive)');
  assert.match(runNoise.out, /verdict: inconclusive/);
  assert.doesNotMatch(runNoise.out, /verdict: usable/);
});

test('C-2 negative control: dropping source-unverified check turns fallback candidate into merge-candidate', () => {
  const fakeCandRuns = {};
  for (const skill of ['alpha', 'beta']) {
    for (let id = 1; id <= 4; id += 1) {
      fakeCandRuns[`${skill}/${id}`] = {
        kind: id % 2 === 1 ? 'triggering' : 'behavioral',
        split: id <= 2 ? 'train' : 'heldout',
        passRate: 1.0,
        excluded: null,
      };
    }
  }
  const fakeRepeat = {
    iteration: 'fake-fallback',
    model: f.cfg.model,
    commit: 'abc1234',
    runs: fakeCandRuns,
    differing: [],
    stale: [],
    runCount: 8,
  };
  const dDropped = noise.buildDecision({
    noise: JSON.parse(fs.readFileSync(sharedNoiseFile, 'utf8')),
    noiseFile: { path: 'noise.json', sha256: null },
    baselineFile: JSON.parse(fs.readFileSync(f.baselineFile, 'utf8')),
    model: f.cfg.model,
    candidate: [fakeRepeat],
    thresholds: noise.loadNoiseConfig(f.cfg),
  });
  assert.equal(dDropped.corpus.verdict, 'gain-above-noise');
  assert.equal(dDropped.recommendation, 'merge-candidate');
});
