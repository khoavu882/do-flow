'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { spawnFakeServer, startFakeServer } = require('../helper/fake-decision-server.ts');
const { TaskClassifier } = require('../../src/runtime/task-classifier.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');

function fixture(t: any) {
  const scratch = createScratch('doflow-advice-classify-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const servers: any = [];
  t.after(async (): Promise<any> => {
    for (const server of servers) await server.close();
    scratch.remove();
  });
  return {
    scratch,
    project,
    userFile: path.join(scratch.xdg, 'doflow', 'settings.json'),
    env: scratch.env({ DOFLOW_CLI: BIN }),
    run: (args: any) => spawnSync(bashPath(), [RUN, 'classify', ...args], {
      cwd: project, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8',
    }),
    startServer: async () => {
      const server = await spawnFakeServer({ dir: scratch.dir });
      servers.push(server);
      return server;
    },
    enable: (endpoint: any) => {
      fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
        schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': endpoint, 'advice.model': 'clef-flash',
      }, null, 2));
    },
  };
}

const BASELINE_TEXT: any = [
  {
    args: ['--task-class', 'feature', '--calling-skill', 'do'], exit: 0,
    text: `
DoFlow Task Classification [ACCEPTED]:
══════════════════════════════════════════════════════════════════════════════
Task class 'feature' selects the Feature Delivery workflow: discovery → design → planning → implementation → verification → review. Fit is not applicable: 'do' is declared a router, so it occupies no stage. The skill this work is handed to must classify under its own identity.
Fit: NOT_APPLICABLE (caller-is-a-router)
──────────────────────────────────────────────────────────────────────────────
Workflow: Feature Delivery (6 stage(s))
Stages:   discovery → design → planning → implementation → verification → review
Implementation stages: implementation
══════════════════════════════════════════════════════════════════════════════
`,
  },
  {
    args: ['--task-class', 'research', '--calling-skill', 'do-diagnose'], exit: 1,
    text: `
DoFlow Task Classification [REJECTED]:
══════════════════════════════════════════════════════════════════════════════
Task class 'research' is declared, but its workflow has no stage for 'do-diagnose': research runs scoping → synthesis (skills: do, do-document). Classes with a stage for 'do-diagnose': bug (root-cause), refactor (architecture-mapping), dependency-change (usage-impact). Propose one of those, or hand this work to the skill 'research' names for the stage you meant.
Fit: NOT_HOSTED (caller-not-a-stage)
Classes that host do-diagnose: bug (root-cause), refactor (architecture-mapping), dependency-change (usage-impact)
Valid classes: feature, bug, refactor, review, research, documentation, dependency-change, operations, trivial-edit
══════════════════════════════════════════════════════════════════════════════
`,
  },
  {
    args: ['--calling-skill', 'do'], exit: 2,
    text: `
DoFlow Task Classification [REJECTED]:
══════════════════════════════════════════════════════════════════════════════
No task class was proposed, so no workflow can be selected. Propose one of: feature, bug, refactor, review, research, documentation, dependency-change, operations, trivial-edit.
Fit: NOT_EVALUATED (class-not-resolved)
Valid classes: feature, bug, refactor, review, research, documentation, dependency-change, operations, trivial-edit
══════════════════════════════════════════════════════════════════════════════
`,
  },
];

test('IC-010 without a request preserves the three text verdicts and exit codes', (t) => {
  const f = fixture(t);
  for (const baseline of BASELINE_TEXT) {
    const result = f.run(baseline.args);
    assert.equal(result.status, baseline.exit, result.stderr);
    assert.equal(result.stdout, `${baseline.text}\n`);
    assert.equal(result.stderr, '');
  }
});

test('IC-010 JSON without a request adds only secondOpinion:null', (t) => {
  const f = fixture(t);
  const classifier: any = new TaskClassifier({ repoRoot: REPO_ROOT });
  for (const taskClass of ['feature', 'research', null]) {
    const args: any = ['--calling-skill', taskClass === 'research' ? 'do-diagnose' : 'do', '--json'];
    if (taskClass) args.unshift('--task-class', taskClass);
    const result = f.run(args);
    const exit = taskClass === 'feature' || taskClass === 'research' ? (taskClass === 'feature' ? 0 : 1) : 2;
    assert.equal(result.status, exit, result.stderr);
    const expected = classifier.classify({ taskClass, callingSkill: taskClass === 'research' ? 'do-diagnose' : 'do' });
    const actual = JSON.parse(result.stdout);
    assert.equal(typeof actual.decidedAt, 'string');
    delete actual.decidedAt;
    delete expected.decidedAt;
    assert.deepEqual(actual, { ...expected, secondOpinion: null });
  }
});

test('IC-010 rejects simultaneous request inputs as a usage error before advice work', (t) => {
  const f = fixture(t);
  const result = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--request', 'inline', '--request-file', 'request.txt', '--json']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'USAGE');
  assert.equal(output.exitCode, 2);
  assert.match(output.summary, /mutually exclusive/);
});

test('IC-010 classify help documents the mutually exclusive request flags', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--request <text>.*--request-file <file>/s);
  assert.match(result.stdout, /mutually exclusive/);
});

test('IC-010 feature-off request and malformed request-file fail open without changing the verdict', async (t) => {
  const f = fixture(t);
  const off = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--request', 'A small user-facing change.', '--json']);
  assert.equal(off.status, 0, off.stderr);
  const offJson = JSON.parse(off.stdout);
  assert.equal(offJson.outcome, 'ACCEPTED');
  assert.equal(offJson.secondOpinion.status, 'off');

  const server = await f.startServer();
  f.enable(server.origin);
  const missing = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--request-file', path.join(f.scratch.dir, 'missing.txt'), '--json']);
  assert.equal(missing.status, 0, missing.stderr);
  const missingJson = JSON.parse(missing.stdout);
  assert.equal(missingJson.outcome, 'ACCEPTED');
  assert.equal(missingJson.secondOpinion.status, 'unavailable');
  assert.equal(missingJson.secondOpinion.reason, 'config-invalid');

  const invalidUtf8 = path.join(f.scratch.dir, 'invalid-utf8.txt');
  fs.writeFileSync(invalidUtf8, Buffer.from([0x66, 0x80, 0x6f]));
  const baseline = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--json']);
  const invalid = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--request-file', invalidUtf8, '--json']);
  assert.equal(invalid.status, baseline.status);
  const baselineJson = JSON.parse(baseline.stdout);
  const invalidJson = JSON.parse(invalid.stdout);
  for (const field of ['outcome', 'taskClass', 'workflow', 'fit', 'message', 'validClasses', 'suggestions']) {
    assert.deepEqual(invalidJson[field], baselineJson[field], `${field} must remain authoritative`);
  }
  assert.equal(invalidJson.secondOpinion.status, 'unavailable');
  assert.equal(invalidJson.secondOpinion.reason, 'config-invalid');
});

test('IC-010 agreeing and differing picks print only the advisory line after Fit', async (t) => {
  const f = fixture(t);
  const agree = await classifyStubbed(t, f, { mode: 'act', staticPick: 'feature', advisorPick: 'feature', effectiveDecision: 'feature' }, { taskClass: 'feature', json: false });
  assert.match(agree.printed, /Fit: NOT_APPLICABLE \(caller-is-a-router\)\nSecond opinion: agrees with 'feature' \(clear\)\./);
  const agreeLine = agree.printed.split('\n').find((line: any) => line.startsWith('Second opinion:'));
  assert.doesNotMatch(agreeLine, /\d|%/);

  const differ = await classifyStubbed(t, f, { mode: 'act', staticPick: 'bug', advisorPick: 'feature', effectiveDecision: 'feature' }, { taskClass: 'bug', json: false });
  assert.match(differ.printed, /Fit: NOT_APPLICABLE \(caller-is-a-router\)\nSecond opinion: 'feature' \(clear\), differs from the proposed 'bug'\. Validation alone decides the class\./);
  const differLine = differ.printed.split('\n').find((line: any) => line.startsWith('Second opinion:'));
  assert.doesNotMatch(differLine, /\d|%/);
});

test('IC-010 preserves the accepted classifier verdict and records no outcome for it (174 O-6)', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  f.enable(server.origin);
  const before = f.run(['--task-class', 'bug', '--calling-skill', 'do', '--json']);
  const beforeJson = JSON.parse(before.stdout);
  const after = f.run(['--task-class', 'bug', '--calling-skill', 'do', '--request', 'A broken behavior needs a repair.', '--task-id', 'classify-accepted', '--json']);
  assert.equal(after.status, before.status);
  const afterJson = JSON.parse(after.stdout);
  for (const field of ['outcome', 'taskClass', 'workflow', 'fit', 'message', 'validClasses', 'suggestions']) {
    assert.deepEqual(afterJson[field], beforeJson[field], `${field} must remain authoritative from validation`);
  }
  assert.equal(afterJson.secondOpinion.status, 'shadow', 'an unset kind with a model is a shadow call: no opinion is shown');
  assert.equal(afterJson.secondOpinion.pick, null);
  const records = await settledPickRecords(f);
  assert.deepEqual(records.map(({ type, mode, caller, static: s, pick }: any) => ({ type, mode, caller, static: s, pick })),
    [{ type: 'pick', mode: 'shadow', caller: 'classify', static: 'bug', pick: 'feature' }]);
  assert.deepEqual(outcomeRecords(f), []);

  const rejected = f.run(['--task-class', 'research', '--calling-skill', 'do-diagnose', '--request', 'Research the topic.', '--json']);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).outcome, 'REJECTED');
});

// ---- 084 H2: advice.kinds.task-class routes classify through the dispatcher only when it is set ----

function setKinds(f: any, kinds: any) {
  fs.mkdirSync(path.join(f.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify({ advice: { kinds } }));
}
/** A passing-looking bench file in the project: the gate never reads it (D3), so it never unlocks act. */
function projectBench(f: any, kind: any) {
  fs.mkdirSync(path.join(f.project, 'bench', 'advice'), { recursive: true });
  fs.writeFileSync(path.join(f.project, 'bench', 'advice', `${kind}.json`), JSON.stringify({
    kind, models: { 'clef-flash': { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 10 } },
  }));
}
function pickRecords(f: any) {
  const file = path.join(f.project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line)) : [];
}
/** The pick records once the detached shadow call (row 174 O-2) has written one, or after 5 s. */
async function settledPickRecords(f: any) {
  const until = Date.now() + 5000;
  while (Date.now() < until && pickRecords(f).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  return pickRecords(f);
}
/** Records an outcome line? Every line of the day's pick file that is an outcome, whatever its source. */
const outcomeRecords = (f: any) => pickRecords(f).filter((record: any) => record.type === 'outcome');

const ACCEPTED_ARGS = ['--task-class', 'bug', '--calling-skill', 'do', '--request', 'A broken behavior needs a repair.', '--json'];

/**
 * Runs classify against an in-process fake server, so the model calls can be counted: `asks` is the number of
 * decision requests the verb made. The child runs asynchronously, which leaves the server free to answer.
 */
async function runCounted(t: any, f: any, args: any, { settings, env }: any = {}) {
  const server: any = await startFakeServer();
  t.after(() => server.close());
  f.enable(server.origin);
  fs.mkdirSync(path.join(f.project, '.doflow', 'state'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify(settings));
  const child = spawn(bashPath(), [RUN, 'classify', ...args], { cwd: f.project, env: f.scratch.env({ DOFLOW_CLI: BIN, ...(env || {}) }) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: any) => { stdout += chunk; });
  child.stderr.on('data', (chunk: any) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  // Read when asserted: a shadow call runs in a detached child (row 174 O-2) that may ask after the verb has exited.
  return { status, stdout, stderr, get asks() { return server.requests.filter((r: any) => r.method === 'POST' && r.pathname === '/v1/systemone').length; } };
}

test('174 O-1: with advice.kinds.task-class unset and a model configured classify takes the dispatcher path in shadow', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const opinion = JSON.parse(result.stdout).secondOpinion;
  assert.equal(opinion.status, 'shadow');
  assert.equal(opinion.pick, null, 'nothing is shown');
  const records = await settledPickRecords(f);
  assert.equal(result.asks, 1);
  assert.deepEqual(records.map(({ type, mode, caller, question, pick, model }: any) => ({ type, mode, caller, question, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'classify', question: 'task-class', pick: 'feature', model: 'clef-flash' }]);
});

test('174 O-1: with advice.kinds.task-class unset and no model configured classify asks nothing', async (t) => {
  const f = fixture(t);
  const server: any = await startFakeServer();
  t.after(() => server.close());
  fs.writeFileSync(path.join(f.scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': null,
  }));
  const child = spawn(bashPath(), [RUN, 'classify', ...ACCEPTED_ARGS], { cwd: f.project, env: f.env });
  let stdout = '';
  child.stdout.on('data', (chunk: any) => { stdout += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(JSON.parse(stdout).secondOpinion.status, 'off');
  assert.equal(server.requests.filter((r: any) => r.method === 'POST').length, 0);
  assert.deepEqual(pickRecords(f), []);
});

test('084 H2: advice.kinds.task-class off asks nothing and records nothing', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'off' } } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.secondOpinion.status, 'off');
  assert.equal(result.asks, 0, 'off makes no model call');
  assert.deepEqual(pickRecords(f), []);
});

test('084 H2: advice.kinds.task-class shadow keeps the verdict, shows no opinion and records a shadow pick', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'shadow' } } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.taskClass, 'bug');
  assert.equal(json.secondOpinion.status, 'shadow');
  assert.equal(json.secondOpinion.reason, null);
  assert.equal(json.secondOpinion.pick, null);
  const records = await settledPickRecords(f);
  assert.equal(result.asks, 1);
  assert.deepEqual(records.map(({ type, mode, caller, static: s, pick, model }: any) => ({ type, mode, caller, static: s, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'classify', static: 'bug', pick: 'feature', model: 'clef-flash' }]);
});

test('084 D3: advice.kinds.task-class act with a passing bench file in the project still falls back to shadow', async (t) => {
  const f = fixture(t);
  projectBench(f, 'task-class');
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'act' } } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.taskClass, 'bug', 'validation alone decides the class');
  assert.equal(json.secondOpinion.status, 'shadow');
  assert.equal(json.secondOpinion.pick, null);
  assert.match(json.secondOpinion.reason, /^LOCAL_RESULT_UNMET: none: /);
  const records = await settledPickRecords(f);
  assert.equal(result.asks, 1, 'the degraded shadow query runs');
  assert.deepEqual(records.map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'feature', model: 'clef-flash' }]);
  assert.equal(records.some((record: any) => record.type === 'outcome'), false, 'no pick was shown, so no outcome is joined');
});

test('084 H2: advice.kinds.task-class act without a local result (LOCAL_RESULT_UNMET) falls back to shadow', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'act' } } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.taskClass, 'bug');
  assert.equal(json.secondOpinion.status, 'shadow');
  assert.equal(json.secondOpinion.pick, null);
  assert.match(json.secondOpinion.reason, /^LOCAL_RESULT_UNMET: none: /);
  const records = await settledPickRecords(f);
  assert.equal(result.asks, 1, 'the degraded shadow query runs');
  assert.deepEqual(records.map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'feature', model: 'clef-flash' }]);
});

test('085 H1: an explicit rollout.profile baseline turns a configured act off for classify', async (t) => {
  const f = fixture(t);
  projectBench(f, 'task-class');
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'act' } }, rollout: { profile: 'baseline' } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.secondOpinion.status, 'off');
  assert.equal(result.asks, 0);
  assert.deepEqual(pickRecords(f), []);
});

// 085 H1 on the unset-kinds path: a chosen profile whose advisor is off skips the client call.
const CHOSEN_OFF: any = {
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } } },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } },
  'an invalid profile value': { settings: { rollout: { profile: 'bogus' } } },
};
for (const [name, c] of Object.entries(CHOSEN_OFF) as any) {
  test(`085 H1: with advice.kinds unset, ${name} makes classify ask nothing`, async (t) => {
    const f = fixture(t);
    const result = await runCounted(t, f, ACCEPTED_ARGS, c);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.outcome, 'ACCEPTED');
    assert.equal(json.secondOpinion.status, 'off');
    assert.equal(json.secondOpinion.reason, null);
    assert.equal(result.asks, 0, 'a capped-off advisor makes no model call');
    assert.deepEqual(pickRecords(f), []);
  });
}

// 084 C-6: with advice.kinds unset a shadow cap (canary, or staged per D2) is the same shadow call: it shows no pick.
const CHOSEN_SHADOW: any = {
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } } },
  'env DOFLOW_ROLLOUT_PROFILE=canary': { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } } },
};
for (const [name, c] of Object.entries(CHOSEN_SHADOW) as any) {
  test(`084 C-6: with advice.kinds unset, ${name} records the classify opinion and shows no pick`, async (t) => {
    const f = fixture(t);
    const result = await runCounted(t, f, ACCEPTED_ARGS, c);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.outcome, 'ACCEPTED');
    assert.equal(json.taskClass, 'bug', 'validation alone decides the class');
    assert.deepEqual(json.secondOpinion, {
      status: 'shadow', reason: null, pick: null, strength: null, between: null, agrees: null, proposed: null,
      pickId: null, probabilities: null, confidence: null, model: null,
    });
    const records = await settledPickRecords(f);
    assert.equal(result.asks, 1, 'one call, made by the detached child');
    const picks = records.filter((record: any) => record.type === 'pick');
    assert.deepEqual(picks.map(({ question, pick, static: s, model, caller, mode }: any) => ({ question, pick, static: s, model, caller, mode })),
      [{ question: 'task-class', pick: 'feature', static: 'bug', model: 'clef-flash', caller: 'classify', mode: 'shadow' }]);
    assert.deepEqual(outcomeRecords(f), [], 'the verdict is not an observation of the pick');
  });
}

// The settings layers come from the `env` the caller passes, never from this process's environment.
async function classifyInProcess(f: any, env: any, { taskClass = 'bug', json = true }: any = {}) {
  const { handleClassifyCommand } = require('../../src/runtime/task-classifier.ts');
  let printed = '';
  const oldLog = console.log;
  const savedExit = process.exitCode;
  console.log = (text: any) => { printed += `${text}\n`; };
  try {
    await handleClassifyCommand({ taskClass, callingSkill: 'do', request: 'A broken behavior needs a repair.', projectRoot: f.project, env, json });
  } finally { console.log = oldLog; process.exitCode = savedExit; }
  return json ? JSON.parse(printed).secondOpinion : printed;
}

test('084: the passed env decides the user settings layer for classify, not the process environment', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  f.enable(server.origin);
  const other = path.join(f.scratch.dir, 'other-xdg');
  fs.mkdirSync(path.join(other, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(other, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'advice.kinds.task-class': 'off', 'advice.enabled': true, 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  }));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = other;
  t.after(() => { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; });
  const opinion = await classifyInProcess(f, f.scratch.env());
  assert.equal(opinion.status, 'shadow', 'advice.kinds.task-class is unset in the passed env, so the kind is shadow');
  // control: the same file in the passed env's config home turns the kind off
  const control = await classifyInProcess(f, f.scratch.env({ XDG_CONFIG_HOME: other }));
  assert.equal(control.status, 'off');
});

// 084 C-10: a set kind consumes the dispatcher's mode and effectiveDecision, never advisorPick alone.
let REAL_INTERCEPT: any = null;
async function classifyStubbed(t: any, f: any, resolution: any, { taskClass = 'bug', json = true }: any = {}) {
  const dispatcher = require('../../src/runtime/advice/shadow-dispatcher.ts');
  // The real function, kept once: a test that stubs twice must not restore the first stub.
  REAL_INTERCEPT ??= dispatcher.interceptDecisionPoint;
  t.after(() => { dispatcher.interceptDecisionPoint = REAL_INTERCEPT; });
  dispatcher.interceptDecisionPoint = async () => ({
    kind: 'task-class', staticPick: 'bug', pickId: 'adv-0000000000000-000000', elevated: false, agreed: null,
    advisorAnswer: { name: 'task-class', pick: resolution.advisorPick, strength: { word: 'clear', between: null }, probabilities: null, confidence: null, model: 'clef-flash' },
    ...resolution,
  });
  const server = await f.startServer();
  f.enable(server.origin);
  const result = await classifyInProcess(f, f.scratch.env(), { taskClass, json });
  return json ? { opinion: result, printed: '' } : { opinion: null, printed: result };
}
async function classifyWithDispatcher(t: any, f: any, resolution: any) {
  return (await classifyStubbed(t, f, resolution)).opinion;
}

test('084 C-10: a shadow result shows no pick even when it carries one', async (t) => {
  const f = fixture(t);
  const opinion = await classifyWithDispatcher(t, f, { mode: 'shadow', advisorPick: 'feature', effectiveDecision: 'bug', warning: 'LOCAL_RESULT_UNMET: none: x' });
  assert.equal(opinion.status, 'shadow');
  assert.equal(opinion.pick, null);
  assert.equal(opinion.reason, 'LOCAL_RESULT_UNMET: none: x');
});

test('084 C-10: an act result shows the effective decision, not the raw advisor pick', async (t) => {
  const f = fixture(t);
  const opinion = await classifyWithDispatcher(t, f, { mode: 'act', advisorPick: 'trivial-edit', effectiveDecision: 'bug' });
  assert.equal(opinion.status, 'answered');
  assert.equal(opinion.pick, 'bug');
  assert.equal(opinion.agrees, true);
});

/** The dispatcher with the trust evaluator answering `standing`: no shipped source certifies, so no real run reaches act. */
function atStanding(t: any, standing: string) {
  const trustPath = require.resolve('../../src/runtime/advice/replay/trust.ts');
  const dispatcherPath = require.resolve('../../src/runtime/advice/shadow-dispatcher.ts');
  const trust = require(trustPath);
  const saved = trust.evaluateTrust;
  trust.evaluateTrust = async () => ({ standing, reason: `injected ${standing}`, failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' });
  delete require.cache[dispatcherPath];
  t.after(() => { trust.evaluateTrust = saved; delete require.cache[dispatcherPath]; });
}

test('174 O-6: an act answer at standing act is shown, recorded as a pick, and gets no outcome line', async (t) => {
  const f = fixture(t);
  const server: any = await startFakeServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { 'task-class': 'act' });
  atStanding(t, 'act');
  const opinion = await classifyInProcess(f, f.scratch.env());
  assert.equal(opinion.status, 'answered');
  assert.equal(opinion.pick, 'feature');
  const records = pickRecords(f);
  assert.deepEqual(records.filter((record: any) => record.type === 'pick').map(({ mode, caller, static: s }: any) => ({ mode, caller, static: s })),
    [{ mode: 'act', caller: 'classify', static: 'bug' }]);
  assert.deepEqual(outcomeRecords(f), []);
  assert.equal(records.some((record: any) => record.source === 'classify-verdict'), false);
});

test('175 T7: classify has no show surface, so task-class act at standing show runs as shadow and shows no pick', async (t) => {
  const f = fixture(t);
  const server: any = await startFakeServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { 'task-class': 'act' });
  atStanding(t, 'show');
  const opinion = await classifyInProcess(f, f.scratch.env());
  assert.equal(opinion.status, 'shadow');
  assert.equal(opinion.pick, null);
  assert.equal(opinion.reason, 'LOCAL_RESULT_UNMET: show: injected show');
  const until = Date.now() + 5000;
  while (Date.now() < until && pickRecords(f).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pickRecords(f).filter((record: any) => record.type === 'pick').map(({ mode }: any) => mode), ['shadow']);
});
