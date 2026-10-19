'use strict';

// 096 C.2: no-spawn test for bench noise and bench report (NFR-003, A-8).
// Must stub child_process before the first require of runner.js.

const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const recordedSpawns = [];
const origExecFileSync = cp.execFileSync;
const origSpawnSync = cp.spawnSync;
const origExecSync = cp.execSync;

function checkSpawn(cmd, args) {
  const argsList = Array.isArray(args) ? args : [];
  recordedSpawns.push({ cmd, args: argsList });
  if (cmd !== 'git') {
    throw new Error(`Forbidden spawn: expected git, got ${cmd}`);
  }
  const sub = argsList[0] || null;
  if (!['show', 'rev-parse', 'status'].includes(sub)) {
    throw new Error(`Forbidden git subcommand: expected show, rev-parse, or status, got ${sub}`);
  }
}

cp.execFileSync = function(file, args, options) {
  checkSpawn(file, args);
  return origExecFileSync.call(this, file, args, options);
};

cp.spawnSync = function(file, args, options) {
  checkSpawn(file, args);
  return origSpawnSync.call(this, file, args, options);
};

cp.execSync = function(cmd, options) {
  const parts = typeof cmd === 'string' ? cmd.trim().split(/\s+/) : [];
  checkSpawn(parts[0], parts.slice(1));
  return origExecSync.call(this, cmd, options);
};

// Required AFTER stubbing child_process
const runner = require('../../bench/runner.js');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');

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

function setupFixture(t, iterationNames) {
  const root = tempDir(t, 'doflow-bench-nospawn-');
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
    quiet(() => runner.cmdGrade(cfg, { iteration: iterName, runsRoot }));
  }

  return { cfg, runsRoot, baselineFile, baselineDir, reportsDir, root };
}

test('C.2: nospawn test: every spawn during noise and report is git with show, rev-parse or status (A-8)', (t) => {
  const baseIters = ['banded-base-r1', 'banded-base-r2', 'banded-base-r3'];
  const f = setupFixture(t, [...baseIters, 'banded-cand-r1']);
  quiet(() => runner.cmdBaseline(f.cfg, { from: 'banded-base-r1', runsRoot: f.runsRoot, baselineFile: f.baselineFile }));

  const noiseFile = path.join(f.baselineDir, 'noise.json');

  // Reset recorded spawns
  recordedSpawns.length = 0;

  // 1. Run bench noise
  const noiseRun = quiet(() => runner.cmdNoise(f.cfg, {
    iterations: baseIters.join(','),
    runsRoot: f.runsRoot,
    out: noiseFile,
  }));
  assert.equal(noiseRun.status, 0);

  // 2. Run bench report
  const reportRun = quiet(() => runner.cmdReport(f.cfg, {
    iteration: 'banded-cand-r1',
    runsRoot: f.runsRoot,
    baselineFile: f.baselineFile,
    noise: noiseFile,
  }));
  assert.equal(reportRun.status, 0);

  // Verify spawns
  assert.ok(recordedSpawns.length > 0, 'recorded git spawns during noise and report');
  for (const s of recordedSpawns) {
    assert.equal(s.cmd, 'git', `spawn must be git, got ${s.cmd}`);
    assert.ok(
      ['show', 'rev-parse', 'status'].includes(s.args[0]),
      `git subcommand must be show, rev-parse or status, got ${s.args[0]}`,
    );
  }
});

test('C.2 negative control: a spawn of node inside the stubbed run turns the nospawn test red', () => {
  assert.throws(() => {
    cp.spawnSync('node', ['--version']);
  }, /Forbidden spawn: expected git, got node/);

  assert.throws(() => {
    cp.execFileSync('node', ['-e', 'console.log(1)']);
  }, /Forbidden spawn: expected git, got node/);

  assert.throws(() => {
    cp.spawnSync('git', ['push', 'origin', 'main']);
  }, /Forbidden git subcommand: expected show, rev-parse, or status, got push/);
});
