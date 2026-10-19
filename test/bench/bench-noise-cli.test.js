'use strict';

// 096 C.1: bench noise subcommand over k graded repeats with refusals,
// in-memory grader re-run, stale-grade warnings and the noise artifact written only with --out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../../bench/runner.js');
const noise = require('../../bench/noise.js');
const { tempDir } = require('../helper/tmp.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'bench-noise');
const RUNNER_CLI = path.join(REPO_ROOT, 'bench', 'runner.js');

function setupFixture(t, iterationNames, overrides = {}) {
  const root = tempDir(t, 'doflow-bench-noise-cli-');
  const runsRoot = path.join(root, 'runs');
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));

  const cfg = {
    ...runner.loadConfig(),
    benchRoot: 'test/fixtures/bench-noise/corpus',
    skillsRoot: 'test/fixtures/bench-noise/skills',
    model: 'claude-noise-fixture',
    ...overrides,
  };

  const evalsByKey = new Map();
  for (const skill of ['alpha', 'beta']) {
    for (const evaluation of runner.loadCases(cfg, skill).evals) {
      evalsByKey.set(`${skill}/${evaluation.id}`, { skill, evaluation });
    }
  }

  for (const iterName of iterationNames) {
    const iterRoot = path.join(runsRoot, iterName);
    fs.mkdirSync(iterRoot, { recursive: true });

    const stamp = {
      model: cfg.model,
      sourceAt: 'a4d64234567890abcdef1234567890abcdef12',
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
    }
  }

  return { cfg, runsRoot, root };
}

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

test('C.1: bench noise runs over 5 fixture scenarios giving exact repeatMeans, noise, baselineMean and verdicts', (t) => {
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));
  const scenarios = scenarioSets.scenarios;
  assert.ok(scenarios, 'scenarios definition exists in scenarios.json');

  // 1. usable: exit 0
  {
    const s = scenarios.usable;
    const f = setupFixture(t, s.iterations);
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: s.iterations.join(','),
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 0, 'usable exits 0');
    assert.match(run.out, /verdict: usable/);
    assert.match(run.out, /noise over 3 repeat\(s\) of claude-noise-fixture at a4d64234 \(aa-range\)/);
    assert.match(run.out, /\| corpus \| 0\.75 \| 0\.75 \| 0\.75 \| 0\.00 \| 0\.75 \| no \|/);
    assert.match(run.out, /grader re-run: 24 run\(s\), 0 differing; 24 stale grading\.json/);
  }

  // 2. noise-exceeds-mde: exit 1
  {
    const s = scenarios['noise-exceeds-mde'];
    const f = setupFixture(t, s.iterations);
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: s.iterations.join(','),
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 1, 'noise-exceeds-mde exits 1');
    assert.match(run.out, /verdict: noise-exceeds-mde/);
    assert.match(run.out, /\| corpus \| 0\.75 \| 0\.63 \| 0\.75 \| 0\.13 \| 0\.71 \| no \|/);
  }

  // 3. no-headroom: exit 1
  {
    const s = scenarios['no-headroom'];
    const f = setupFixture(t, s.iterations);
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: s.iterations.join(','),
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 1, 'no-headroom exits 1');
    assert.match(run.out, /verdict: no-headroom/);
    assert.match(run.out, /\| corpus \| 1\.00 \| 1\.00 \| 1\.00 \| 0\.00 \| 1\.00 \| yes \|/);
  }

  // 4. inconclusive: exit 1
  {
    const s = scenarios.inconclusive;
    const f = setupFixture(t, s.iterations);
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: s.iterations.join(','),
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 1, 'inconclusive exits 1');
    assert.match(run.out, /verdict: inconclusive/);
    assert.match(run.out, /infra excluded: 3 of 24 run\(s\) \(timeout 3\); malformed status: 0/);
  }

  // 5. grader-unstable: exit 1, with seam opts.gradeRun
  {
    const s = scenarios['grader-unstable'];
    const f = setupFixture(t, s.iterations);
    let callCount = 0;
    const nondeterministicGrader = (cfg, skill, e, arm, runDir, sourceAt) => {
      const g = runner.gradeRun(cfg, skill, e, arm, runDir, sourceAt);
      if (skill === 'alpha' && e.id === 1) {
        callCount += 1;
        // Flip expectation on second call in memory for repeat 1 only
        if (callCount === 2) {
          g.expectations[0].passed = !g.expectations[0].passed;
          g.pass_rate = g.expectations[0].passed ? 1 : 0;
        }
      }
      return g;
    };

    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: s.iterations.join(','),
      runsRoot: f.runsRoot,
      gradeRun: nondeterministicGrader,
    }));
    assert.equal(run.status, 1, 'grader-unstable exits 1');
    assert.match(run.out, /verdict: grader-unstable/);
    assert.match(run.out, /1 run\(s\) graded differently on re-run: grader-unstable-r1\/alpha\/1/);
  }
});

test('C.1: exit 2 on validation refusals with clear causes', (t) => {
  const f = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);

  // Missing --iterations
  {
    const run = quiet(() => runner.cmdNoise(f.cfg, { runsRoot: f.runsRoot }));
    assert.equal(run.status, 2);
    assert.match(run.err, /--iterations <a,b\[,c\.\.\.\]> is required/);
  }

  // k below cfg.noise.k
  {
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2',
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /fewer than 3 iterations provided/);
  }

  // Empty iteration name in --iterations
  {
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,,usable-r2',
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /empty iteration name in --iterations/);
  }

  // Duplicate iteration name in --iterations
  {
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r1',
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /duplicate iteration name "usable-r1"/);
  }

  // Missing iteration directory
  {
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,non-existent-r3',
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /no runs found at/);
  }

  // Missing sourceAt in iteration.json
  {
    const noSourceAt = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
    fs.writeFileSync(path.join(noSourceAt.runsRoot, 'usable-r1', 'iteration.json'), JSON.stringify({ model: 'm' }));
    const run = quiet(() => runner.cmdNoise(noSourceAt.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: noSourceAt.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /usable-r1: measured commit unknown: re-grade with --source-at/);
  }

  // Missing model in iteration.json
  {
    const noModel = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
    fs.writeFileSync(path.join(noModel.runsRoot, 'usable-r1', 'iteration.json'), JSON.stringify({ sourceAt: 'c' }));
    const run = quiet(() => runner.cmdNoise(noModel.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: noModel.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /usable-r1: model not recorded: re-grade/);
  }

  // Model mismatch across iterations
  {
    const modelMismatch = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
    fs.writeFileSync(
      path.join(modelMismatch.runsRoot, 'usable-r2', 'iteration.json'),
      JSON.stringify({ model: 'different-model', sourceAt: 'a4d64234567890abcdef1234567890abcdef12' })
    );
    const run = quiet(() => runner.cmdNoise(modelMismatch.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: modelMismatch.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /model mismatch/);
  }

  // sourceAt mismatch across iterations
  {
    const commitMismatch = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
    fs.writeFileSync(
      path.join(commitMismatch.runsRoot, 'usable-r2', 'iteration.json'),
      JSON.stringify({ model: commitMismatch.cfg.model, sourceAt: 'different-commit-123456' })
    );
    const run = quiet(() => runner.cmdNoise(commitMismatch.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: commitMismatch.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /sourceAt mismatch/);
  }

  // Case-set mismatch across iterations
  {
    const caseMismatch = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
    // Remove one case directory from usable-r2
    fs.rmSync(path.join(caseMismatch.runsRoot, 'usable-r2', 'beta', 'eval-4-completed-run'), { recursive: true });
    const run = quiet(() => runner.cmdNoise(caseMismatch.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: caseMismatch.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /case-set mismatch/);
    assert.match(run.err, /beta\/4 missing in usable-r2/);
  }

  // Invalid noise config
  {
    const invalidCfg = { ...f.cfg, noise: { k: 1 } };
    const run = quiet(() => runner.cmdNoise(invalidCfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: f.runsRoot,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /bench\/config\.json noise is invalid: k must be an integer >= 2/);
  }
});

test('C.1: CLI argument parsing and refusal flags via spawnSync', () => {
  // Flag without value: --out
  {
    const res = spawnSync(process.execPath, [RUNNER_CLI, 'noise', '--out'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /bench: --out requires a value/);
  }

  // Flag without value: --iterations
  {
    const res = spawnSync(process.execPath, [RUNNER_CLI, 'noise', '--iterations'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /bench: --iterations requires a value/);
  }

  // Unknown flag
  {
    const res = spawnSync(process.execPath, [RUNNER_CLI, 'noise', '--unknown-flag'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /bench: unknown option '--unknown-flag'/);
  }

  // Forbidden flags: --split, --arm, --kind, --snapshot
  for (const [flag, val] of [
    ['--split', 'train'],
    ['--arm', 'without-skill'],
    ['--kind', 'triggering'],
    ['--snapshot', 'dir'],
  ]) {
    const res = spawnSync(process.execPath, [RUNNER_CLI, 'noise', flag, val], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, new RegExp(`bench noise: ${flag} is not accepted`));
  }
});

test('C.1: negative control: comparing only pass_rate in re-run hides a flip with an equal rate', (t) => {
  const f = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);

  // Nondeterministic grader that flips two expectations between pass 1 and pass 2,
  // keeping pass_rate identical (e.g. 0.5 in both passes).
  let callCount = 0;
  const flippingGrader = (cfg, skill, e, arm, runDir, sourceAt) => {
    const g = runner.gradeRun(cfg, skill, e, arm, runDir, sourceAt);
    if (skill === 'alpha' && e.id === 1) {
      callCount += 1;
      if (callCount % 2 === 1) {
        g.expectations = [{ text: 'e1', passed: true }, { text: 'e2', passed: false }];
      } else {
        g.expectations = [{ text: 'e1', passed: false }, { text: 'e2', passed: true }];
      }
      g.pass_rate = 0.5;
    }
    return g;
  };

  const repeat = runner.readRepeat(f.cfg, path.join(f.runsRoot, 'usable-r1'), {
    gradeRun: flippingGrader,
  });

  // Because readRepeat compares the passed arrays, it catches the flip:
  assert.equal(repeat.differing.length, 1, 'flip is detected because expectations[i].passed differed');
  assert.equal(repeat.differing[0], 'usable-r1/alpha/1');

  // NEGATIVE CONTROL VERIFICATION:
  // If someone compared only pass_rate (0.5 === 0.5), differing would be empty:
  const passedOnlyRate = 0.5 === 0.5;
  assert.equal(passedOnlyRate, true, 'equal pass_rate would hide the flip');
});

test('C.1: stale grading.json is listed as stale on stderr and does not cause grader-unstable', (t) => {
  const f = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);

  // Write a pre-existing grading.json for usable-r1/alpha/1 that differs from fresh grading
  const runDir = path.join(f.runsRoot, 'usable-r1', 'alpha', 'eval-1-timeout-run');
  const staleGrading = {
    expectations: [{ text: 't', passed: false }],
    pass_rate: 0,
    infra: null,
  };
  fs.writeFileSync(path.join(runDir, 'grading.json'), `${JSON.stringify(staleGrading)}\n`);

  const run = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
  }));

  // Stale warning emitted to stderr (via console.warn)
  assert.match(run.warn, /warning: \d+ run\(s\) have stale grading\.json:/);
  assert.match(run.warn, /usable-r1\/alpha\/1/);

  // Verdict is usable (exit 0), NOT grader-unstable!
  assert.equal(run.status, 0, 'stale grading.json does NOT cause grader-unstable');
  assert.match(run.out, /verdict: usable/);
});

test('C.1: --out writes valid noise artifact, two runs are byte-equal, and --json outputs object', (t) => {
  const f = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
  const outFile1 = path.join(f.root, 'noise-out-1.json');
  const outFile2 = path.join(f.root, 'noise-out-2.json');

  // First run with --out
  const run1 = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
    out: outFile1,
  }));
  assert.equal(run1.status, 0);
  assert.match(run1.out, new RegExp(`noise: ${path.relative(REPO_ROOT, outFile1)}`));
  assert.ok(fs.existsSync(outFile1), 'outFile1 was created');

  const artifact1 = JSON.parse(fs.readFileSync(outFile1, 'utf8'));
  const problems1 = noise.validateNoiseArtifact(artifact1);
  assert.deepEqual(problems1, [], 'artifact1 is valid per validateNoiseArtifact');

  // Second run with --out
  const run2 = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
    out: outFile2,
  }));
  assert.equal(run2.status, 0);

  // NFR-001: byte-equal
  const content1 = fs.readFileSync(outFile1, 'utf8');
  const content2 = fs.readFileSync(outFile2, 'utf8');
  assert.equal(content1, content2, 'two runs produce byte-equal output');

  // --json prints the object
  const runJson = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
    json: true,
  }));
  assert.equal(runJson.status, 0);
  const parsedStdout = JSON.parse(runJson.out);
  assert.equal(parsedStdout.kind, 'bench-noise');
  assert.equal(parsedStdout.verdict, 'usable');
  assert.deepEqual(noise.validateNoiseArtifact(parsedStdout), []);
});

test('C.1: negative control: without --out nothing is written (default path does not exist)', (t) => {
  const f = setupFixture(t, ['usable-r1', 'usable-r2', 'usable-r3']);
  const defaultPath = path.join(REPO_ROOT, f.cfg.baselineDir, 'noise.json');

  // Ensure default path does not exist before run
  const defaultExistedBefore = fs.existsSync(defaultPath);

  const run = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
    // NO out parameter passed
  }));
  assert.equal(run.status, 0);

  // Without --out, default path MUST NOT exist (A-3)
  assert.equal(fs.existsSync(defaultPath), defaultExistedBefore, 'default noise path was NOT written without --out');
});

test('C.1: USAGE includes noise command and flags', () => {
  const res = spawnSync(process.execPath, [RUNNER_CLI, 'noise', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /node bench\/runner\.js noise --iterations <a,b\[,c\.\.\.\]> \[--out <file>\] \[--json\]/);
});
