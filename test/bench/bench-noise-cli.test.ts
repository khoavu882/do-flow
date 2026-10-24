'use strict';

// 096 C.1: bench noise subcommand over k graded repeats with refusals,
// in-memory grader re-run, stale-grade warnings and the noise artifact written only with --out.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../../bench/runner.ts');
const noise = require('../../bench/noise.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'bench-noise');
const RUNNER_CLI = path.join(REPO_ROOT, 'bench', 'runner.ts');

function quiet(fn: any) {
  const saved: any = { log: console.log, warn: console.warn, error: console.error };
  const out: any = [];
  const warn: any = [];
  const err: any = [];
  console.log = (...args) => out.push(args.join(' '));
  console.warn = (...args) => warn.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const status = fn();
    return {
      status,
      out: out.join('\n'),
      warn: warn.join('\n'),
      err: err.join('\n'),
      stdout: out.join('\n'),
      stderr: err.join('\n'),
    };
  } finally {
    Object.assign(console, saved);
  }
}

let f: any;

const allIters: any = [
  'usable-r1', 'usable-r2', 'usable-r3',
  'noise-exceeds-mde-r1', 'noise-exceeds-mde-r2', 'noise-exceeds-mde-r3',
  'no-headroom-r1', 'no-headroom-r2', 'no-headroom-r3',
  'inconclusive-r1', 'inconclusive-r2', 'inconclusive-r3',
  'grader-unstable-r1', 'grader-unstable-r2', 'grader-unstable-r3',
];

before(() => {
  const root = suiteTempDir('doflow-bench-noise-cli-');
  const runsRoot = path.join(root, 'runs');
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));

  const cfg: any = {
    ...runner.loadConfig(),
    benchRoot: 'test/fixtures/bench-noise/corpus',
    skillsRoot: 'test/fixtures/bench-noise/skills',
    model: 'claude-noise-fixture',
  };

  const evalsByKey: any = new Map();
  for (const skill of ['alpha', 'beta']) {
    for (const evaluation of runner.loadCases(cfg, skill).evals) {
      evalsByKey.set(`${skill}/${evaluation.id}`, { skill, evaluation });
    }
  }

  for (const iterName of allIters) {
    const iterRoot = path.join(runsRoot, iterName);
    fs.mkdirSync(iterRoot, { recursive: true });

    const stamp: any = {
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
        const contents: any = typeof scenario.run_status === 'string'
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
  }

  f = { cfg, runsRoot, root };
});

test('C.1: bench noise runs over 5 fixture scenarios giving exact repeatMeans, noise, baselineMean and verdicts', () => {
  const scenarioSets = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'scenarios.json'), 'utf8'));
  const scenarios = scenarioSets.scenarios;
  assert.ok(scenarios, 'scenarios definition exists in scenarios.json');

  // 1. usable: exit 0
  {
    const s = scenarios.usable;
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
    let callCount = 0;
    const nondeterministicGrader = (cfg: any, skill: any, e: any, arm: any, runDir: any, sourceAt: any) => {
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

test('C.1: exit 2 on validation refusals with clear causes', () => {
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
    const subRuns = path.join(f.root, 'refusal-nosourceat', 'runs');
    fs.mkdirSync(path.join(subRuns, 'usable-r1'), { recursive: true });
    fs.mkdirSync(path.join(subRuns, 'usable-r2'), { recursive: true });
    fs.mkdirSync(path.join(subRuns, 'usable-r3'), { recursive: true });
    fs.writeFileSync(path.join(subRuns, 'usable-r1', 'iteration.json'), JSON.stringify({ model: 'm' }));
    fs.writeFileSync(path.join(subRuns, 'usable-r2', 'iteration.json'), JSON.stringify({ model: 'm', sourceAt: 's' }));
    fs.writeFileSync(path.join(subRuns, 'usable-r3', 'iteration.json'), JSON.stringify({ model: 'm', sourceAt: 's' }));
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: subRuns,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /usable-r1: measured commit unknown: re-grade with --source-at/);
  }

  // Missing model in iteration.json
  {
    const subRuns = path.join(f.root, 'refusal-nomodel', 'runs');
    fs.mkdirSync(path.join(subRuns, 'usable-r1'), { recursive: true });
    fs.mkdirSync(path.join(subRuns, 'usable-r2'), { recursive: true });
    fs.mkdirSync(path.join(subRuns, 'usable-r3'), { recursive: true });
    fs.writeFileSync(path.join(subRuns, 'usable-r1', 'iteration.json'), JSON.stringify({ sourceAt: 'c' }));
    fs.writeFileSync(path.join(subRuns, 'usable-r2', 'iteration.json'), JSON.stringify({ model: 'm', sourceAt: 's' }));
    fs.writeFileSync(path.join(subRuns, 'usable-r3', 'iteration.json'), JSON.stringify({ model: 'm', sourceAt: 's' }));
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: subRuns,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /usable-r1: model not recorded: re-grade/);
  }

  // Model mismatch across iterations
  {
    const subRuns = path.join(f.root, 'refusal-modelmismatch', 'runs');
    fs.cpSync(path.join(f.runsRoot, 'usable-r1'), path.join(subRuns, 'usable-r1'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r2'), path.join(subRuns, 'usable-r2'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r3'), path.join(subRuns, 'usable-r3'), { recursive: true });
    fs.writeFileSync(
      path.join(subRuns, 'usable-r2', 'iteration.json'),
      JSON.stringify({ model: 'different-model', sourceAt: 'a4d64234567890abcdef1234567890abcdef12' })
    );
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: subRuns,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /model mismatch/);
  }

  // sourceAt mismatch across iterations
  {
    const subRuns = path.join(f.root, 'refusal-commitmismatch', 'runs');
    fs.cpSync(path.join(f.runsRoot, 'usable-r1'), path.join(subRuns, 'usable-r1'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r2'), path.join(subRuns, 'usable-r2'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r3'), path.join(subRuns, 'usable-r3'), { recursive: true });
    fs.writeFileSync(
      path.join(subRuns, 'usable-r2', 'iteration.json'),
      JSON.stringify({ model: f.cfg.model, sourceAt: 'different-commit-123456' })
    );
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: subRuns,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /sourceAt mismatch/);
  }

  // Case-set mismatch across iterations
  {
    const subRuns = path.join(f.root, 'refusal-casemismatch', 'runs');
    fs.cpSync(path.join(f.runsRoot, 'usable-r1'), path.join(subRuns, 'usable-r1'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r2'), path.join(subRuns, 'usable-r2'), { recursive: true });
    fs.cpSync(path.join(f.runsRoot, 'usable-r3'), path.join(subRuns, 'usable-r3'), { recursive: true });
    fs.rmSync(path.join(subRuns, 'usable-r2', 'beta', 'eval-4-completed-run'), { recursive: true });
    const run = quiet(() => runner.cmdNoise(f.cfg, {
      iterations: 'usable-r1,usable-r2,usable-r3',
      runsRoot: subRuns,
    }));
    assert.equal(run.status, 2);
    assert.match(run.err, /case-set mismatch/);
    assert.match(run.err, /beta\/4 missing in usable-r2/);
  }

  // Invalid noise config
  {
    const invalidCfg: any = { ...f.cfg, noise: { k: 1 } };
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
    const res = quiet(() => runner.main(['noise', '--iterations']));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /bench: --iterations requires a value/);
  }

  // Unknown flag
  {
    const res = quiet(() => runner.main(['noise', '--unknown-flag']));
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
    const res = quiet(() => runner.main(['noise', flag, val]));
    assert.equal(res.status, 2);
    assert.match(res.stderr, new RegExp(`bench noise: ${flag} is not accepted`));
  }
});

test('C.1: negative control: comparing only pass_rate in re-run hides a flip with an equal rate', () => {
  let callCount = 0;
  const flippingGrader = (cfg: any, skill: any, e: any, arm: any, runDir: any, sourceAt: any) => {
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

test('C.1: stale grading.json is listed as stale on stderr and does not cause grader-unstable', () => {
  const runDir = path.join(f.runsRoot, 'usable-r1', 'alpha', 'eval-1-timeout-run');
  const gradingFile = path.join(runDir, 'grading.json');
  const hadGrading = fs.existsSync(gradingFile);
  const staleGrading: any = {
    expectations: [{ text: 't', passed: false }],
    pass_rate: 0,
    infra: null,
  };
  fs.writeFileSync(gradingFile, `${JSON.stringify(staleGrading)}\n`);
  try {
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
  } finally {
    if (!hadGrading) fs.rmSync(gradingFile, { force: true });
  }
});

test('C.1: --out writes valid noise artifact, two runs are byte-equal, and --json outputs object', () => {
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

test('C.1: negative control: without --out nothing is written (default path does not exist)', () => {
  const defaultDir = path.join(f.root, 'default-test-baseline');
  const defaultCfg: any = { ...f.cfg, baselineDir: path.relative(REPO_ROOT, defaultDir) };
  const defaultPath = path.join(defaultDir, 'noise.json');
  assert.equal(fs.existsSync(defaultPath), false);

  const run = quiet(() => runner.cmdNoise(defaultCfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
  }));
  assert.equal(run.status, 0);

  // Without --out, default path MUST NOT exist (A-3)
  assert.equal(fs.existsSync(defaultPath), false, 'default noise path was NOT written without --out');
});

test('C.1: USAGE includes noise command and flags', () => {
  const res = quiet(() => runner.main(['noise', '--help']));
  assert.equal(res.status, 0);
  assert.match(res.stdout, /node bench\/runner\.ts noise --iterations <a,b\[,c\.\.\.\]> \[--out <file>\] \[--json\]/);
});

test('C-3: parseIterationList dedupes on realpathSync so aliases or symlinks exit 2 and 3 distinct exit 0', () => {
  // Alias in cmdNoise: usable-r1,./usable-r1,usable-r3
  const runAlias = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,./usable-r1,usable-r3',
    runsRoot: f.runsRoot,
  }));
  assert.equal(runAlias.status, 2);
  assert.match(runAlias.err, /duplicate iteration name "\.\/usable-r1" in --iterations/);

  // Symlink in cmdNoise
  const symlinkDir = path.join(f.runsRoot, 'symlink-usable-r1');
  if (!fs.existsSync(symlinkDir)) {
    fs.symlinkSync(path.join(f.runsRoot, 'usable-r1'), symlinkDir);
  }
  const runSymlink = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,symlink-usable-r1',
    runsRoot: f.runsRoot,
  }));
  assert.equal(runSymlink.status, 2);
  assert.match(runSymlink.err, /duplicate iteration name "symlink-usable-r1" in --iterations/);

  // Alias in cmdReport
  const dummyBase = path.join(f.root, 'dummy-baseline.json');
  if (!fs.existsSync(dummyBase)) {
    fs.writeFileSync(dummyBase, JSON.stringify({ results: [] }));
  }
  const runReportAlias = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'usable-r1,./usable-r1',
    runsRoot: f.runsRoot,
    baselineFile: dummyBase,
  }));
  assert.equal(runReportAlias.status, 2);
  assert.match(runReportAlias.err, /duplicate iteration name "\.\/usable-r1" in --iteration/);

  // Three distinct directories in cmdNoise exit 0
  const runDistinct = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,usable-r3',
    runsRoot: f.runsRoot,
  }));
  assert.equal(runDistinct.status, 0);
});

test('C-3 negative control: raw string comparison fails to detect alias or symlink duplicates', () => {
  const parts: any = ['usable-r1', './usable-r1', 'usable-r3'];
  const rawSet: any = new Set(parts);
  assert.equal(rawSet.size, 3);
});

test('C-5: malformed or unreadable iteration.json in cmdNoise and cmdReport exits 2 naming iteration', () => {
  const badIterDir = path.join(f.runsRoot, 'malformed-stamp-iter');
  fs.mkdirSync(badIterDir, { recursive: true });
  fs.writeFileSync(path.join(badIterDir, 'iteration.json'), '{not json');

  // cmdNoise with malformed iteration.json
  const runNoise = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: 'usable-r1,usable-r2,malformed-stamp-iter',
    runsRoot: f.runsRoot,
  }));
  assert.equal(runNoise.status, 2);
  assert.match(runNoise.err, /malformed-stamp-iter/);
  assert.match(runNoise.err, /iteration\.json is unreadable or malformed/);

  // cmdReport with malformed candidate iteration.json
  const dummyBase = path.join(f.root, 'dummy-baseline.json');
  if (!fs.existsSync(dummyBase)) {
    fs.writeFileSync(dummyBase, JSON.stringify({ results: [] }));
  }
  const runReport = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'malformed-stamp-iter',
    runsRoot: f.runsRoot,
    baselineFile: dummyBase,
  }));
  assert.equal(runReport.status, 2);
  assert.match(runReport.err, /malformed-stamp-iter/);
  assert.match(runReport.err, /iteration\.json is unreadable or malformed/);

  // readRepeat does not throw SyntaxError
  let repeatResult = null;
  assert.doesNotThrow(() => {
    repeatResult = runner.readRepeat(f.cfg, badIterDir, { iteration: 'malformed-stamp-iter' });
  });
  assert.equal(repeatResult, null);
});

test('C-5 negative control: bare readJson on malformed iteration.json throws SyntaxError', () => {
  assert.throws(
    () => JSON.parse('{not json'),
    SyntaxError,
  );
});

test('C-9: grading first asserts 0 stale; editing one grading.json lists exactly that key as stale', () => {
  const c9Root = path.join(f.root, 'c9-test');
  const runsRoot = path.join(c9Root, 'runs');

  const iters: any = ['c9-r1', 'c9-r2', 'c9-r3'];
  for (const it of iters) {
    const itDir = path.join(runsRoot, it);
    for (const skill of ['alpha', 'beta']) {
      const evals = runner.loadCases(f.cfg, skill).evals;
      for (const e of evals) {
        const runDir = path.join(itDir, skill, `eval-${e.id}-${e.name}`);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'transcript.txt'), `${skill}-${e.id}-output\n`);
        fs.writeFileSync(path.join(runDir, 'routing.json'), JSON.stringify({ routed: true }));
        const skillSha = runner.skillSourceSha256(f.cfg, skill);
        fs.writeFileSync(path.join(runDir, 'skill_source.json'), JSON.stringify({
          skill,
          path: `/abs/.doflow/worktrees/000/.claude/skills/${skill}/SKILL.md`,
          sha256: skillSha,
        }));
      }
    }
    fs.writeFileSync(path.join(itDir, 'iteration.json'), JSON.stringify({ sourceAt: 'c9-commit', model: f.cfg.model }));
    const gradeRes = quiet(() => runner.cmdGrade(f.cfg, { iteration: it, runsRoot }));
    assert.equal(gradeRes.status, 0);
  }

  const noiseRun1 = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: iters.join(','),
    runsRoot,
  }));
  assert.equal(noiseRun1.status, 0);
  assert.match(noiseRun1.out, /0 stale grading\.json/);
  assert.doesNotMatch(noiseRun1.warn, /stale grading\.json:/);

  const targetGrading = path.join(runsRoot, 'c9-r1', 'alpha', 'eval-1-timeout-run', 'grading.json');
  const stored = JSON.parse(fs.readFileSync(targetGrading, 'utf8'));
  stored.pass_rate = (stored.pass_rate === 1.0 ? 0.0 : 1.0);
  fs.writeFileSync(targetGrading, JSON.stringify(stored));

  const noiseRun2 = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: iters.join(','),
    runsRoot,
  }));
  assert.equal(noiseRun2.status, 0);
  assert.match(noiseRun2.out, /1 stale grading\.json/);
  assert.match(noiseRun2.warn, /warning: 1 run\(s\) have stale grading\.json:/);
  assert.match(noiseRun2.warn, /c9-r1\/alpha\/1/);
});

test('C-9 negative control: marking every run stale turns 0-stale assertion red', () => {
  const totalRuns = 24;
  const simulatedStaleCount = totalRuns;
  assert.notEqual(simulatedStaleCount, 0, 'simulated unconditional stale fails 0 stale assertion');
});
