'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const SLUG = '063-advice-handoff';
const FEATURE = path.join('agent-docs', 'doflow', SLUG);
const PICK_AT = new Date().toISOString();
const PICK = `adv-${Date.parse(PICK_AT)}-a1b2c3`;
const UNKNOWN_PICK = `adv-${Date.parse(PICK_AT) + 1}-a1b2c3`;
const TIERS: any = ['light', 'standard', 'frontier'];

function project(t: any) {
  const scratch = createScratch('doflow-advice-handoff-');
  t.after(() => scratch.remove());
  const dir = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(dir, FEATURE, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(dir, FEATURE, 'requirement.md'), '# Requirement\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, scratch };
}

function run(p: any, args: any) {
  const result = spawnSync(process.execPath, [DOFLOW, 'orchestrate', ...args], {
    cwd: p.dir, env: p.scratch.env(), encoding: 'utf8', timeout: 10000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const taskArgs: any = ['--task-id', SLUG, '--task-class', 'feature'];
function start(p: any) {
  const result = run(p, ['--action', 'start', ...taskArgs]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function handoff(p: any) {
  return run(p, ['--action', 'handoff', ...taskArgs, '--calling-skill', 'do-brainstorm', '--note', 'recorded', '--json']);
}
function writeBrief(p: any, { advice = { kind: 'tier', status: 'answered', pickId: PICK }, stage = 'discovery', tier = 'standard', runTaskId = SLUG }: any = {}) {
  fs.writeFileSync(path.join(p.dir, FEATURE, 'exec', 'task-A.1-brief.json'), JSON.stringify({
    schema: 1, feature: SLUG, runTaskId, stage, stageSkill: 'do-brainstorm', owner: 'core-implementer',
    tier, tierSource: 'owner', harness: null, tasks: [], expected: [], optional: [], tools: [], missing: [],
    ...(advice === null ? {} : { advice }),
  }));
}
function seedPick(root: any, { pickId = PICK, kind = 'tier', options = TIERS }: any = {}) {
  const directory = path.join(root, '.doflow', 'state', 'advice', 'picks');
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, `${PICK_AT.slice(0, 10)}.jsonl`), `${JSON.stringify({
    schema: 1, type: 'pick', pickId, at: PICK_AT, kind, question: 'tier', qtype: 'choice', options,
    pick: 'frontier', strength: 'clear', between: null, probabilities: { light: 0.1, standard: 0.2, frontier: 0.7 },
  })}\n`);
}
function outcomes(root: any) {
  const directory = path.join(root, '.doflow', 'state', 'advice', 'picks');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap((file: any) => fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n'))
    .filter(Boolean).map((line: any) => JSON.parse(line)).filter((line: any) => line.type === 'outcome');
}

test('IC-012: matched answered tier advice writes one outcome and repeated handoff is idempotent', (t) => {
  const p = project(t);
  start(p);
  seedPick(p.dir);
  writeBrief(p);
  const first = handoff(p);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.stderr, '');
  assert.deepEqual(outcomes(p.dir).map(({ pickId, actual, source }: any) => ({ pickId, actual, source })), [
    { pickId: PICK, actual: 'standard', source: 'brief-record' },
  ]);
  const second = handoff(p);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(outcomes(p.dir).map((line: any) => line.pickId), [PICK]);
});

test('IC-012: missing, unavailable, mismatched, non-tier, or invalid advice writes no outcome', (t) => {
  const cases: any = [
    { label: 'missing advice', options: { advice: null }, seed: false },
    { label: 'unavailable', options: { advice: { kind: 'tier', status: 'unavailable', pickId: PICK, reason: 'timeout' } } },
    { label: 'null stage', options: { stage: null } },
    { label: 'wrong run', options: { runTaskId: 'other-task' } },
    { label: 'wrong advice kind', options: { advice: { kind: 'task-class', status: 'answered', pickId: PICK } } },
    { label: 'not answered', options: { advice: { kind: 'tier', status: 'off', pickId: PICK } } },
    { label: 'missing status', options: { advice: { kind: 'tier', pickId: PICK } } },
    { label: 'unknown pick', options: { advice: { kind: 'tier', status: 'answered', pickId: UNKNOWN_PICK } } },
    { label: 'invalid actual tier', options: { tier: 'unknown-tier' } },
    { label: 'stored pick is not a tier', options: {}, pickKind: 'task-class' },
    { label: 'stored pick has no tier options', options: {}, pickOptions: [] },
  ];
  for (const item of cases) {
    const p = project(t);
    start(p);
    if (item.seed !== false) seedPick(p.dir, { kind: item.pickKind || 'tier', options: item.pickOptions || TIERS });
    writeBrief(p, item.options);
    const result = handoff(p);
    assert.equal(result.status, 0, `${item.label}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(outcomes(p.dir), [], item.label);
  }
});

test('IC-012: outcome recording uses the brief repository root when it differs from the run root', (t) => {
  const feature = project(t);
  const runRoot = path.join(feature.scratch.dir, 'linked-checkout');
  fs.mkdirSync(runRoot);
  seedPick(feature.dir);
  const orchestrator: any = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: runRoot });
  orchestrator.recordBriefTierAdvice({
    briefRecords: [{ runTaskId: SLUG, stage: 'discovery', tier: 'standard', advice: { kind: 'tier', status: 'answered', pickId: PICK } }],
    taskId: SLUG, stageId: 'discovery', repoRoot: feature.dir,
  });
  assert.deepEqual(outcomes(feature.dir).map(({ pickId, actual }: any) => ({ pickId, actual })), [
    { pickId: PICK, actual: 'standard' },
  ]);
  assert.deepEqual(outcomes(runRoot), []);
});

test('IC-012: advice outcome leaves handoff output and stored consultations unchanged', (t) => {
  const withoutAdvice = project(t);
  const withAdvice = project(t);
  start(withoutAdvice);
  start(withAdvice);
  writeBrief(withoutAdvice, { advice: null });
  seedPick(withAdvice.dir);
  writeBrief(withAdvice);
  const baseline = handoff(withoutAdvice);
  const advised = handoff(withAdvice);
  assert.equal(advised.status, baseline.status);
  const normalize = (p: any, text: any) => text.replace(fs.realpathSync(p.dir), '<project>');
  assert.equal(normalize(withAdvice, advised.stdout), normalize(withoutAdvice, baseline.stdout));
  assert.equal(advised.stderr, baseline.stderr);
  const baselineData = JSON.parse(baseline.stdout);
  const advisedData = JSON.parse(advised.stdout);
  assert.deepEqual(advisedData.consultations, baselineData.consultations);
  assert.equal(outcomes(withAdvice.dir).length, 1);
  assert.deepEqual(outcomes(withoutAdvice.dir), []);
});

test('IC-012: a refused outcome write is fail-open and creates no partial outcome', (t) => {
  const p = project(t);
  seedPick(p.dir);
  const record: any = { runTaskId: SLUG, stage: 'discovery', tier: 'standard', advice: { kind: 'tier', status: 'answered', pickId: PICK } };
  const failingFs = Object.create(fs);
  failingFs.appendFileSync = (file: any, ...args: any[]) => {
    if (String(file).includes(path.join('.doflow', 'state', 'advice', 'picks'))) throw new Error('write refused');
    return fs.appendFileSync(file, ...args);
  };
  const orchestrator: any = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: p.dir, fsImpl: failingFs });
  assert.doesNotThrow(() => orchestrator.recordBriefTierAdvice({
    briefRecords: [record], taskId: SLUG, stageId: 'discovery', repoRoot: p.dir,
  }));
  assert.deepEqual(outcomes(p.dir), []);
});

test('IC-012: a symlinked advice store is refused without changing handoff output or target data', (t) => {
  const baselineProject = project(t);
  const linkedProject = project(t);
  start(baselineProject);
  start(linkedProject);
  writeBrief(baselineProject, { advice: null });
  seedPick(linkedProject.dir);
  writeBrief(linkedProject);

  const adviceDirectory = path.join(linkedProject.dir, '.doflow', 'state', 'advice');
  const targetDirectory = path.join(linkedProject.scratch.dir, 'external-advice');
  fs.renameSync(adviceDirectory, targetDirectory);
  fs.symlinkSync(targetDirectory, adviceDirectory, 'dir');

  const baseline = handoff(baselineProject);
  const linked = handoff(linkedProject);
  assert.equal(linked.status, baseline.status);
  const normalize = (p: any, text: any) => text.replace(fs.realpathSync(p.dir), '<project>');
  assert.equal(normalize(linkedProject, linked.stdout), normalize(baselineProject, baseline.stdout));
  assert.equal(linked.stderr, baseline.stderr);
  assert.deepEqual(outcomes(targetDirectory), []);
});
