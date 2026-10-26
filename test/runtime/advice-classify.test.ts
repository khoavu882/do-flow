'use strict';

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
    userFile: path.join(scratch.xdg, 'doflow', 'decision-model.json'),
    env: scratch.env({ DOFLOW_CLI: BIN }),
    run: (args: any) => spawnSync('/bin/bash', [RUN, 'classify', ...args], {
      cwd: project, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8',
    }),
    startServer: async () => {
      const server = await spawnFakeServer({ dir: scratch.dir });
      servers.push(server);
      return server;
    },
    enable: (endpoint: any) => {
      fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'decision-model.json'), JSON.stringify({
        schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash',
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
  const server = await f.startServer();
  f.enable(server.origin);

  const agree = f.run(['--task-class', 'feature', '--calling-skill', 'do', '--request', 'Build a new capability.']);
  assert.equal(agree.status, 0, agree.stderr);
  assert.match(agree.stdout, /Fit: NOT_APPLICABLE \(caller-is-a-router\)\nSecond opinion: agrees with 'feature' \(clear\)\./);
  const agreeLine = agree.stdout.split('\n').find((line: any) => line.startsWith('Second opinion:'));
  assert.doesNotMatch(agreeLine, /\d|%/);

  const differ = f.run(['--task-class', 'bug', '--calling-skill', 'do', '--request', 'Fix a broken behavior.']);
  assert.equal(differ.status, 0, differ.stderr);
  assert.match(differ.stdout, /Fit: NOT_APPLICABLE \(caller-is-a-router\)\nSecond opinion: 'feature' \(clear\), differs from the proposed 'bug'\. Validation alone decides the class\./);
  const differLine = differ.stdout.split('\n').find((line: any) => line.startsWith('Second opinion:'));
  assert.doesNotMatch(differLine, /\d|%/);
});

test('IC-010 preserves the accepted classifier verdict and records only an ACCEPTED outcome', async (t) => {
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
  assert.equal(afterJson.secondOpinion.status, 'answered');
  assert.equal(afterJson.secondOpinion.proposed, 'bug');
  assert.equal(afterJson.secondOpinion.pick, 'feature');
  assert.equal(afterJson.secondOpinion.agrees, false);
  const file = path.join(f.project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line));
  const pick = records.find((record: any) => record.type === 'pick' && record.pickId === afterJson.secondOpinion.pickId);
  assert.ok(pick);
  const outcomes = records.filter((record: any) => record.type === 'outcome' && record.pickId === pick.pickId);
  assert.deepEqual(outcomes.map(({ actual, source }: any) => ({ actual, source })), [{ actual: 'bug', source: 'classify-verdict' }]);

  const rejected = f.run(['--task-class', 'research', '--calling-skill', 'do-diagnose', '--request', 'Research the topic.', '--json']);
  assert.equal(rejected.status, 1);
  const rejectedJson = JSON.parse(rejected.stdout);
  assert.equal(rejectedJson.outcome, 'REJECTED');
  const afterRejected = fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line));
  const rejectedPick = afterRejected.find((record: any) => record.type === 'pick' && record.pickId === rejectedJson.secondOpinion.pickId);
  assert.ok(rejectedPick);
  assert.equal(afterRejected.some((record: any) => record.type === 'outcome' && record.pickId === rejectedPick.pickId), false);
});

// ---- 084 H2: advice.kinds.task-class routes classify through the dispatcher only when it is set ----

function setKinds(f: any, kinds: any) {
  fs.mkdirSync(path.join(f.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify({ advice: { kinds } }));
}
function passBench(f: any, kind: any) {
  fs.mkdirSync(path.join(f.project, 'bench', 'advice'), { recursive: true });
  fs.writeFileSync(path.join(f.project, 'bench', 'advice', `${kind}.json`), JSON.stringify({
    kind, models: { 'clef-flash': { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 10 } },
  }));
}
function pickRecords(f: any) {
  const file = path.join(f.project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line)) : [];
}
const ACCEPTED_ARGS = ['--task-class', 'bug', '--calling-skill', 'do', '--request', 'A broken behavior needs a repair.', '--json'];

/**
 * Runs classify against an in-process fake server, so the model calls can be counted: `asks` is the number of
 * decision requests the verb made. The child runs asynchronously, which leaves the server free to answer.
 */
async function runCounted(t: any, f: any, args: any, { settings, sentinel, env }: any = {}) {
  const server: any = await startFakeServer();
  t.after(() => server.close());
  f.enable(server.origin);
  fs.mkdirSync(path.join(f.project, '.doflow', 'state'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify(settings));
  if (sentinel) fs.writeFileSync(path.join(f.project, '.doflow', 'state', 'rollback.json'), JSON.stringify(sentinel));
  const child = spawn('/bin/bash', [RUN, 'classify', ...args], { cwd: f.project, env: f.scratch.env({ DOFLOW_CLI: BIN, ...(env || {}) }) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: any) => { stdout += chunk; });
  child.stderr.on('data', (chunk: any) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  const asks = server.requests.filter((r: any) => r.method === 'POST' && r.pathname === '/v1/systemone').length;
  return { status, stdout, stderr, asks };
}

test('084 H2: with advice.kinds.task-class unset the client records the pick, as before the dispatcher', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  f.enable(server.origin);
  const result = f.run(ACCEPTED_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const opinion = JSON.parse(result.stdout).secondOpinion;
  assert.equal(opinion.status, 'answered');
  assert.equal(opinion.model, 'clef-flash');
  const pick = pickRecords(f).find((record: any) => record.type === 'pick' && record.pickId === opinion.pickId);
  assert.equal(pick.question, 'task-class', 'the client pick record, not the dispatcher one');
  assert.equal(Object.hasOwn(pick, 'mode'), false);
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
  assert.equal(result.asks, 1);
  const records = pickRecords(f);
  assert.deepEqual(records.map(({ type, mode, caller, static: s, pick, model }: any) => ({ type, mode, caller, static: s, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'classify', static: 'bug', pick: 'feature', model: 'clef-flash' }]);
});

test('084 H2: advice.kinds.task-class act answers through the dispatcher and the ACCEPTED outcome finds its pick', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  f.enable(server.origin);
  setKinds(f, { 'task-class': 'act' });
  passBench(f, 'task-class');
  const result = f.run(ACCEPTED_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.taskClass, 'bug', 'validation alone decides the class');
  assert.equal(json.secondOpinion.status, 'answered');
  assert.equal(json.secondOpinion.pick, 'feature');
  assert.equal(json.secondOpinion.model, 'clef-flash');
  const records = pickRecords(f);
  const pick = records.find((record: any) => record.type === 'pick' && record.pickId === json.secondOpinion.pickId);
  assert.equal(pick.mode, 'act', 'the dispatcher recorded the pick classify reports');
  assert.equal(records.filter((record: any) => record.type === 'pick').length, 1, 'one pick, not one per recorder');
  const outcomes = records.filter((record: any) => record.type === 'outcome' && record.pickId === pick.pickId);
  assert.deepEqual(outcomes.map(({ actual, source }: any) => ({ actual, source })), [{ actual: 'bug', source: 'classify-verdict' }]);
});

test('084 H2: advice.kinds.task-class act without a passed bench bar falls back to shadow', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS, { settings: { advice: { kinds: { 'task-class': 'act' } } } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.taskClass, 'bug');
  assert.equal(json.secondOpinion.status, 'shadow');
  assert.equal(json.secondOpinion.pick, null);
  assert.match(json.secondOpinion.reason, /^BENCH_BAR_UNMET: /);
  assert.equal(result.asks, 1, 'the degraded shadow query runs');
  assert.deepEqual(pickRecords(f).map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'feature', model: 'clef-flash' }]);
});

test('085 H1: an explicit rollout.profile baseline turns a configured act off for classify', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  f.enable(server.origin);
  fs.mkdirSync(path.join(f.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify({
    advice: { kinds: { 'task-class': 'act' } }, rollout: { profile: 'baseline' },
  }));
  passBench(f, 'task-class');
  const result = f.run(ACCEPTED_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, 'ACCEPTED');
  assert.equal(json.secondOpinion.status, 'off');
  assert.deepEqual(pickRecords(f), []);
});

// 085 H1 on the unset-kinds path: a chosen profile whose advisor is off skips the client call.
const CHOSEN_OFF: any = {
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } } },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } },
  'an active rollback sentinel': { sentinel: { active: true, reason: 'manual' } },
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

// 084 C-6: on the unset-kinds path a shadow cap (canary, or staged per D2) records the opinion and shows none.
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
    assert.equal(result.asks, 1, 'the same single call the legacy path makes');
    const records = pickRecords(f);
    const picks = records.filter((record: any) => record.type === 'pick');
    assert.deepEqual(picks.map(({ question, pick, static: s, model, caller }: any) => ({ question, pick, static: s, model, caller })),
      [{ question: 'task-class', pick: 'feature', static: 'bug', model: 'clef-flash', caller: 'classify' }]);
    assert.deepEqual(records.filter((record: any) => record.type === 'outcome').map(({ pickId, actual, source }: any) => ({ pickId, actual, source })),
      [{ pickId: picks[0].pickId, actual: 'bug', source: 'classify-verdict' }]);
  });
}

test('084 C-6: the same request with no profile chosen still shows the legacy answer', async (t) => {
  const f = fixture(t);
  const result = await runCounted(t, f, ACCEPTED_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const opinion = JSON.parse(result.stdout).secondOpinion;
  assert.equal(opinion.status, 'answered');
  assert.equal(opinion.pick, 'feature');
  assert.equal(result.asks, 1);
});

// 084 C-10: a set kind consumes the dispatcher's mode and effectiveDecision, never advisorPick alone.
async function classifyWithDispatcher(t: any, f: any, resolution: any) {
  const dispatcher = require('../../src/runtime/advice/shadow-dispatcher.ts');
  const saved = dispatcher.interceptDecisionPoint;
  t.after(() => { dispatcher.interceptDecisionPoint = saved; });
  dispatcher.interceptDecisionPoint = async () => ({
    kind: 'task-class', staticPick: 'bug', pickId: 'adv-0000000000000-000000', elevated: false, agreed: null,
    advisorAnswer: { name: 'task-class', pick: resolution.advisorPick, strength: { word: 'clear', between: null }, probabilities: null, confidence: null, model: 'clef-flash' },
    ...resolution,
  });
  setKinds(f, { 'task-class': 'act' });
  const { handleClassifyCommand } = require('../../src/runtime/task-classifier.ts');
  let printed = '';
  const oldLog = console.log;
  const savedExit = process.exitCode;
  console.log = (text: any) => { printed += `${text}\n`; };
  try {
    await handleClassifyCommand({ taskClass: 'bug', callingSkill: 'do', request: 'A broken behavior needs a repair.', projectRoot: f.project, env: f.scratch.env(), json: true });
  } finally { console.log = oldLog; process.exitCode = savedExit; }
  return JSON.parse(printed).secondOpinion;
}

test('084 C-10: a shadow result shows no pick even when it carries one', async (t) => {
  const f = fixture(t);
  const opinion = await classifyWithDispatcher(t, f, { mode: 'shadow', advisorPick: 'feature', effectiveDecision: 'bug', warning: 'BENCH_BAR_UNMET: x' });
  assert.equal(opinion.status, 'shadow');
  assert.equal(opinion.pick, null);
  assert.equal(opinion.reason, 'BENCH_BAR_UNMET: x');
});

test('084 C-10: an act result shows the effective decision, not the raw advisor pick', async (t) => {
  const f = fixture(t);
  const opinion = await classifyWithDispatcher(t, f, { mode: 'act', advisorPick: 'trivial-edit', effectiveDecision: 'bug' });
  assert.equal(opinion.status, 'answered');
  assert.equal(opinion.pick, 'bug');
  assert.equal(opinion.agrees, true);
});
