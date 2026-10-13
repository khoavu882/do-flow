'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { spawnFakeServer } = require('../helper/fake-decision-server');
const { TaskClassifier } = require('../../src/runtime/task-classifier.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');

function fixture(t) {
  const scratch = createScratch('doflow-advice-classify-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    scratch.remove();
  });
  return {
    scratch,
    project,
    userFile: path.join(scratch.xdg, 'doflow', 'decision-model.json'),
    env: scratch.env({ DOFLOW_CLI: BIN }),
    run: (args) => spawnSync('/bin/bash', [RUN, 'classify', ...args], {
      cwd: project, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8',
    }),
    startServer: async () => {
      const server = await spawnFakeServer({ dir: scratch.dir });
      servers.push(server);
      return server;
    },
    enable: (endpoint) => {
      fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'decision-model.json'), JSON.stringify({
        schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash',
      }, null, 2));
    },
  };
}

const BASELINE_TEXT = [
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
  const classifier = new TaskClassifier({ repoRoot: REPO_ROOT });
  for (const taskClass of ['feature', 'research', null]) {
    const args = ['--calling-skill', taskClass === 'research' ? 'do-diagnose' : 'do', '--json'];
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
  const agreeLine = agree.stdout.split('\n').find((line) => line.startsWith('Second opinion:'));
  assert.doesNotMatch(agreeLine, /\d|%/);

  const differ = f.run(['--task-class', 'bug', '--calling-skill', 'do', '--request', 'Fix a broken behavior.']);
  assert.equal(differ.status, 0, differ.stderr);
  assert.match(differ.stdout, /Fit: NOT_APPLICABLE \(caller-is-a-router\)\nSecond opinion: 'feature' \(clear\), differs from the proposed 'bug'\. Validation alone decides the class\./);
  const differLine = differ.stdout.split('\n').find((line) => line.startsWith('Second opinion:'));
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
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const pick = records.find((record) => record.type === 'pick' && record.pickId === afterJson.secondOpinion.pickId);
  assert.ok(pick);
  const outcomes = records.filter((record) => record.type === 'outcome' && record.pickId === pick.pickId);
  assert.deepEqual(outcomes.map(({ actual, source }) => ({ actual, source })), [{ actual: 'bug', source: 'classify-verdict' }]);

  const rejected = f.run(['--task-class', 'research', '--calling-skill', 'do-diagnose', '--request', 'Research the topic.', '--json']);
  assert.equal(rejected.status, 1);
  const rejectedJson = JSON.parse(rejected.stdout);
  assert.equal(rejectedJson.outcome, 'REJECTED');
  const afterRejected = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const rejectedPick = afterRejected.find((record) => record.type === 'pick' && record.pickId === rejectedJson.secondOpinion.pickId);
  assert.ok(rejectedPick);
  assert.equal(afterRejected.some((record) => record.type === 'outcome' && record.pickId === rejectedPick.pickId), false);
});
