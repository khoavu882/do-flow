'use strict';

// 096 B.2: grading excludes known infrastructure failures without losing the expectations,
// and malformed run records never turn into a scored model failure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../../bench/runner.js');
const { tempDir } = require('../helper/tmp.js');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'bench-noise');
const EXPECTED_KEYS = [
  'skill', 'eval_id', 'eval_name', 'arm', 'split', 'skill_source', 'expectations', 'pass_rate', 'usage',
  'run_status', 'infra',
];

function fixture(t, iteration = 'classes') {
  const root = tempDir(t, 'doflow-bench-noise-');
  const runsRoot = path.join(root, 'runs');
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));
  const scenarios = scenarioSets[iteration];
  assert.ok(scenarios, `fixture scenario ${iteration} exists`);

  const cfg = {
    ...runner.loadConfig(),
    benchRoot: 'test/fixtures/bench-noise/corpus',
    skillsRoot: 'test/fixtures/bench-noise/skills',
    model: 'claude-noise-fixture',
  };
  const evalsByKey = new Map();
  for (const skill of ['alpha', 'beta']) {
    for (const evaluation of runner.loadCases(cfg, skill).evals) {
      evalsByKey.set(`${skill}/${evaluation.id}`, { skill, evaluation });
    }
  }

  for (const [key, scenario] of Object.entries(scenarios)) {
    const { skill, evaluation } = evalsByKey.get(key);
    const runDir = path.join(runsRoot, iteration, skill, `eval-${evaluation.id}-${evaluation.name}`);
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
  }

  const runDir = (key) => {
    const { skill, evaluation } = evalsByKey.get(key);
    return path.join(runsRoot, iteration, skill, `eval-${evaluation.id}-${evaluation.name}`);
  };
  return { cfg, runsRoot, iteration, runDir };
}

function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const out = [];
  const err = [];
  console.log = (...args) => out.push(args.join(' '));
  console.warn = (...args) => err.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const status = fn();
    return { status, out: out.join('\n'), err: err.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

function gradeOne(f, key) {
  const [skill, id] = key.split('/');
  const evaluation = runner.loadCases(f.cfg, skill).evals.find((item) => item.id === Number(id));
  return runner.gradeRun(f.cfg, skill, evaluation, 'with-skill', f.runDir(key), null);
}

test('B.2: gradeRun appends run classification and excludes each infra class while grading expectations', (t) => {
  const f = fixture(t);
  const cases = [
    ['alpha/1', 'timeout'],
    ['alpha/2', 'api-error'],
    ['beta/1', 'truncated'],
    ['beta/2', 'no-output'],
  ];

  for (const [key, infra] of cases) {
    const grading = gradeOne(f, key);
    assert.deepEqual(Object.keys(grading), EXPECTED_KEYS);
    assert.equal(grading.infra, infra, key);
    assert.equal(grading.pass_rate, null, key);
    assert.equal(grading.expectations.length, 1, key);
    assert.equal(typeof grading.expectations[0].passed, 'boolean', key);
  }

  assert.equal(gradeOne(f, 'alpha/1').expectations[0].passed, true,
    'a timeout does not suppress the expectation result');
});

test('B.2: malformed status records are excluded with evidence and never mapped to an infra class', (t) => {
  const f = fixture(t, 'malformed');
  const examples = [
    ['alpha/1', /status "oom" is not one of/],
    ['alpha/2', /not valid JSON/],
    ['beta/1', /not an object/],
  ];

  for (const [key, evidence] of examples) {
    const grading = gradeOne(f, key);
    assert.equal(grading.run_status.status, 'malformed', key);
    assert.match(grading.run_status.evidence, evidence, key);
    assert.equal(grading.infra, null, key);
    assert.equal(grading.pass_rate, null, key);
    assert.equal(grading.expectations.length, 1, key);
  }
});

test('B.2: routing.json alone is model output, and completed transcript runs keep their pass rate', (t) => {
  const f = fixture(t);
  const routed = gradeOne(f, 'alpha/3');
  assert.equal(routed.run_status.status, 'absent');
  assert.equal(routed.infra, null);
  assert.equal(routed.pass_rate, 0);
  assert.equal(routed.expectations[0].passed, false);

  const completed = gradeOne(f, 'alpha/4');
  assert.equal(completed.run_status.status, 'absent');
  assert.equal(completed.infra, null);
  assert.equal(completed.pass_rate, 1);
  assert.equal(completed.expectations[0].passed, true);
});

test('B.2: grade writes status fields, stamps the model once, and summarizes only exclusions', (t) => {
  const f = fixture(t);
  const iterRoot = path.join(f.runsRoot, f.iteration);
  const stampFile = path.join(iterRoot, 'iteration.json');
  fs.writeFileSync(stampFile, JSON.stringify({ sourceAt: null, retained: 'yes' }));

  const run = quiet(() => runner.cmdGrade(f.cfg, { iteration: f.iteration, runsRoot: f.runsRoot }));
  assert.equal(run.status, 0);
  assert.match(run.out, /infra excluded: 4 \(timeout 1, api-error 1, truncated 1, no-output 1\); malformed status: 0/);
  for (const key of ['alpha/1', 'alpha/2', 'beta/1', 'beta/2']) {
    const grading = JSON.parse(fs.readFileSync(path.join(f.runDir(key), 'grading.json'), 'utf8'));
    assert.deepEqual(Object.keys(grading), EXPECTED_KEYS);
  }

  const firstStamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  assert.equal(firstStamp.model, f.cfg.model);
  assert.equal(firstStamp.sourceAt, null);
  assert.equal(firstStamp.retained, 'yes');

  f.cfg.model = 'changed-model';
  quiet(() => runner.cmdGrade(f.cfg, { iteration: f.iteration, runsRoot: f.runsRoot }));
  assert.equal(JSON.parse(fs.readFileSync(stampFile, 'utf8')).model, 'claude-noise-fixture');
});

test('B.2: grade reports malformed-only summaries and omits the infra line when no counts are nonzero', (t) => {
  const malformed = fixture(t, 'malformed');
  const malformedRun = quiet(() => runner.cmdGrade(malformed.cfg, {
    iteration: malformed.iteration, runsRoot: malformed.runsRoot,
  }));
  assert.match(malformedRun.out, /infra excluded: 0 \(timeout 0, api-error 0, truncated 0, no-output 0\); malformed status: 3/);

  const clean = fixture(t, 'clean');
  const cleanRun = quiet(() => runner.cmdGrade(clean.cfg, { iteration: clean.iteration, runsRoot: clean.runsRoot }));
  assert.doesNotMatch(cleanRun.out, /infra excluded:/);
});
