'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    cwd, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t) {
  const root = tempDir(t, 'doflow-verify-report-project-');
  const plan = path.join(root, 'plan.md');
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  const override = {
    parse: null,
    build: 'node -e 0',
    typecheck: null,
    lint: 'node -e 0',
    test: 'node -e 0',
    testTargeted: 'node -e 0 {pattern}',
  };
  fs.writeFileSync(plan, '# Plan\n\n```doflow-verification\n' + JSON.stringify(override) + '\n```\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, plan };
}

function fixedClock(t) {
  const dir = tempDir(t, 'doflow-verify-report-clock-');
  const file = path.join(dir, 'fixed-clock.js');
  fs.writeFileSync(file, 'Date.now = () => 1792000000000;\n');
  return file;
}

function runVerifyCli(p, scratch, { reuse = false, json = false, preloads = [] } = {}) {
  const args = preloads.flatMap((file) => ['--require', file]);
  args.push(DOFLOW, 'verify', '--action', 'report', '--task-id', 'T-1', '--risk', 'LOW', '--plan-path', p.plan,
    '--scope', 'src/a.js');
  if (json) args.push('--json');
  return spawnSync(process.execPath, args, {
    cwd: p.root,
    encoding: 'utf8',
    env: scratch.env({
      DOFLOW_TELEMETRY: 'off',
      DOFLOW_RUN_ID: undefined,
      DOFLOW_LINEAGE_ID: undefined,
      DOFLOW_ATTEMPT: undefined,
      DOFLOW_CONFIG_DIR: undefined,
      ...(reuse ? { DOFLOW_VERIFY_REUSE: undefined } : { DOFLOW_VERIFY_REUSE: 'off' }),
    }),
  });
}

test('C-6: with reuse on, second run reports counts.checksReused in JSON and label in text; with reuse off bytes are unchanged', (t) => {
  const scratchOn = createScratch('doflow-verify-report-reuse-on-');
  t.after(() => scratchOn.remove());
  fs.writeFileSync(path.join(scratchOn.xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'verify.reuse': 'on' }));

  const pOn = project(t);
  const clock = fixedClock(t);

  // Run 1 (reuse ON, first execution):
  const run1Json = runVerifyCli(pOn, scratchOn, { reuse: true, json: true, preloads: [clock] });
  assert.equal(run1Json.status, 0, run1Json.stderr);
  const parsed1 = JSON.parse(run1Json.stdout);
  assert.equal(parsed1.counts.checksReused, 0, 'first run has checksReused === 0 when reuse is on');

  // Run 2 (reuse ON, reuse hit):
  const run2Json = runVerifyCli(pOn, scratchOn, { reuse: true, json: true, preloads: [clock] });
  assert.equal(run2Json.status, 0, run2Json.stderr);
  const parsed2 = JSON.parse(run2Json.stdout);
  assert.ok(parsed2.counts.checksReused > 0, 'second run has checksReused > 0');
  assert.equal(parsed2.counts.checksRun, parsed1.counts.checksRun, 'checksRun keeps its meaning (evaluated)');

  // Run 2 text report:
  const run2Text = runVerifyCli(pOn, scratchOn, { reuse: true, json: false, preloads: [clock] });
  assert.equal(run2Text.status, 0, run2Text.stderr);
  const textOut = run2Text.stdout;

  // Assert line "Checks: P/N passed (R reused, not executed)"
  const checksLineRegex = new RegExp(`Checks: ${parsed2.counts.checksPassed}/${parsed2.counts.checksRun} passed \\(${parsed2.counts.checksReused} reused, not executed\\)`);
  assert.match(textOut, checksLineRegex, 'summary line must state reused count');

  // Assert per-check reused line under tier: 6 spaces indentation, reused <ISO> ref <ref>
  assert.match(textOut, /^ {6}reused \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ref [0-9a-f]{32}$/m, 'reused check prints indented reused line');

  // Reuse OFF:
  const scratchOff = createScratch('doflow-verify-report-reuse-off-');
  t.after(() => scratchOff.remove());
  const pOff = project(t);

  const off1Json = runVerifyCli(pOff, scratchOff, { reuse: false, json: true, preloads: [clock] });
  const off2Json = runVerifyCli(pOff, scratchOff, { reuse: false, json: true, preloads: [clock] });
  assert.equal(off1Json.status, 0);
  assert.equal(off2Json.status, 0);
  assert.equal(JSON.parse(off1Json.stdout).counts.checksReused, undefined, 'checksReused key omitted when reuse is off');
  assert.equal(off2Json.stdout, off1Json.stdout, 'JSON bytes identical with reuse off');

  const off1Text = runVerifyCli(pOff, scratchOff, { reuse: false, json: false, preloads: [clock] });
  const off2Text = runVerifyCli(pOff, scratchOff, { reuse: false, json: false, preloads: [clock] });
  assert.equal(off1Text.status, 0);
  assert.equal(off2Text.status, 0);
  assert.match(off1Text.stdout, new RegExp(`Checks: ${parsed1.counts.checksPassed}/${parsed1.counts.checksRun} passed\n`));
  assert.doesNotMatch(off1Text.stdout, /reused, not executed/);
  assert.equal(off2Text.stdout, off1Text.stdout, 'text bytes identical with reuse off');
});

test('C-6: VerificationEngine in-memory driver emits checksReused and prints reused line', () => {
  let now = 1792000000000;
  const logs = [];
  const originalLog = console.log;

  const fakeRunner = {
    metrics: new Map(),
    beginContract() {},
    runCheck(name, cmd) {
      return {
        name,
        command: cmd,
        status: 'PASS',
        exitCode: 0,
        reused: { ref: 'reuse-0123456789abcdef', recordedAt: '2026-10-20T12:00:00.000Z' },
      };
    },
  };

  const engine = new VerificationEngine({
    cwd: '/tmp',
    configDir: '/tmp/.doflow',
    reuse: true,
    v0: false,
    clock: () => now,
  });
  engine.runner = fakeRunner;

  const contract = {
    version: 1,
    taskId: 'T-INMEM',
    riskLevel: 'LOW',
    tiers: [{
      id: 'unit-tests',
      name: 'Unit Tests',
      kind: 'behavioral',
      required: true,
      resolution: 'RESOLVED',
      checks: [{ name: 'unit', command: 'node test.js', timeoutMs: 1000 }],
    }],
  };

  const report = engine.runContract(contract);
  assert.equal(report.counts.checksReused, 1, 'engine runContract adds counts.checksReused with reuse: true');
  assert.equal(report.counts.checksRun, 1, 'checksRun is 1');
});
