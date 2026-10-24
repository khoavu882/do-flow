'use strict';

// Feature 111 Task 3 (design.md §5 E1, C1): end-to-end test of worker state routing through the real launch.
//
// A worker running `worker --action run --edit` on an attempt worktree inside a scratch project, with
// DOFLOW_CONFIG_DIR unset and HOME/XDG pinned to a scratch dir, routes its hook line and verify.run line
// to the project store <P>/.doflow/state/runs/telemetry rather than dropping them or creating a shadow store
// in the worktree <W>. The worktree's <W>/.doflow/state holds only delivery/ (no runs/, no ledger).
// Under DOFLOW_TELEMETRY=off (C1 variant), no telemetry file is created in either store.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { makeDispatchSandbox, resolveTool } = require('../helper/dispatch-sandbox.ts');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { executeWorkerCommand } = require('../../src/runtime/worker/command.ts');
const { createAttemptWorktree } = require('../../src/runtime/dispatch/integrate.ts');
const attempts = require('../../src/runtime/task-attempts.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const store = require('../../src/runtime/dispatch/store.ts');

const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (NFR-005)' };
const SLUG = '111-e1-routing';

const SYSTEM_TOOLS = [
  'bash', 'sh', 'awk', 'basename', 'cat', 'cp', 'cut', 'date', 'dirname', 'env',
  'grep', 'head', 'jq', 'ln', 'ls', 'mkdir', 'mktemp', 'mv', 'printf', 'rm',
  'sed', 'sleep', 'sort', 'stat', 'tail', 'touch', 'tr', 'uname', 'wc',
];
const LINKABLE_TOOLS = SYSTEM_TOOLS.filter((t) => resolveTool(t) !== null);

const VERIFY_OVERRIDE = {
  parse: null,
  build: 'node -e 0',
  typecheck: null,
  lint: 'node -e 0',
  test: 'node -e 0',
  testTargeted: 'node -e 0',
};

const PLAN_TEXT = [
  '# Plan',
  '',
  '```doflow-verification',
  JSON.stringify(VERIFY_OVERRIDE),
  '```',
  '',
  '## Tasks',
  '',
  '### Phase A',
  '',
  '- [ ] A.1 write module — owner: core-implementer; files: src/a.js',
  '',
].join('\n');

let mirror;
before(() => {
  mirror = buildInstallMirror(path.join(suiteTempDir('doflow-worker-state-mirror-'), 'mirror'));
});

function makeHarnessDescriptors(baseDescriptors) {
  const descriptors = structuredClone(baseDescriptors);
  descriptors.codex.isolatedEdit = {
    status: 'supported',
    evidence: ['test/fixtures/worker/descriptors.json'],
    verification: 'Run the fake CLI under test/helper/fake-harness-cli.js with a scenario for run.',
    verifiedOn: '2026-10-18',
    argv: ['exec', '-s', 'workspace-write'],
  };
  return descriptors;
}

async function setupWorkerRun(t, { telemetry = 'on' } = {}) {
  const sb = makeDispatchSandbox(t, {
    plan: PLAN_TEXT,
    slug: SLUG,
    identity: { DOFLOW_ATTEMPT: undefined },
    systemTools: LINKABLE_TOOLS,
  });
  const { root } = sb;

  // The project store has state/runs/
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });

  const planFile = path.join(root, 'agent-docs', 'doflow', SLUG, 'plan.md');
  const scenario = {
    run: [
      { frontDoors: { mirror, harness: 'codex' } },
      { doflow: { args: ['verify', '--task-id', 'A.1', '--risk', 'LOW', '--plan-path', planFile, '--scope', 'src/a.js', '--json'] } },
      { emit: { type: 'result', status: 'success', summary: 'edited' } },
    ],
  };
  sb.setScenario(scenario);

  const env = {
    ...sb.env,
    DOFLOW_TELEMETRY: telemetry,
    FAKE_DOFLOW_CLI: path.join(__dirname, '..', '..', 'bin', 'doflow.js'),
  };
  delete env.DOFLOW_CONFIG_DIR;

  const descriptors = makeHarnessDescriptors(sb.descriptors);
  const ledger = attempts.storeFile(root, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  attempts.start({ ...common, by: 'main' });
  await readiness.probe({ descriptors, env, cwd: root, harness: 'codex' });

  const promptFile = path.join(sb.dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'edit the module');
  const base = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).stdout.trim();

  const wt = createAttemptWorktree({ root, slug: SLUG, dispatchId: store.newDispatchId(), base, env });
  const claim = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree: wt.worktree });
  assert.equal(claim.disposition, 'claimed');

  const res = await executeWorkerCommand({
    descriptors, env, cwd: root, slug: SLUG, action: 'run', harness: 'codex', task: 'A.1', token: claim.token,
    promptFile, timeoutSeconds: 60, edit: true, wait: true,
  });
  assert.equal(res.exit, 0);
  assert.equal(res.body.state, 'exited');

  return { root, wt, runId: res.body.runId };
}

test('E1: real worker --action run --edit routes hook line and verify.run to project store, leaving worktree with only delivery', POSIX, async (t) => {
  const { root, wt, runId } = await setupWorkerRun(t, { telemetry: 'on' });

  // (1) The PROJECT store <P>/.doflow/state/runs/telemetry gets a hook line with role "worker" and worker_run equal to the run id
  const telemDirP = path.join(root, '.doflow', 'state', 'runs', 'telemetry');
  assert.ok(fs.existsSync(telemDirP), 'project telemetry directory exists');
  const telemFilesP = fs.readdirSync(telemDirP).filter((f) => f.endsWith('.jsonl'));
  assert.ok(telemFilesP.length > 0, 'project telemetry file exists');
  const allLinesP = telemFilesP.flatMap((f) =>
    fs.readFileSync(path.join(telemDirP, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  );
  const hookLines = allLinesP.filter((l) => l.kind === 'hook');
  assert.equal(hookLines.length, 1, 'project telemetry gets exactly one hook line');
  assert.equal(hookLines[0].role, 'worker', 'hook line has role "worker"');
  assert.equal(hookLines[0].worker_run, runId, 'hook line worker_run equals run id');

  // (2) The PROJECT store gets the worker's verify.run line
  const verifyLines = allLinesP.filter((l) => l.kind === 'verify.run');
  assert.equal(verifyLines.length, 1, 'project telemetry gets verify.run line');
  assert.equal(verifyLines[0].task, 'A.1', 'verify.run line records task A.1');

  // (3) The worker worktree's <W>/.doflow/state holds only delivery/ (no runs/, no ledger)
  const wtStateDir = path.join(wt.worktree, '.doflow', 'state');
  assert.ok(fs.existsSync(wtStateDir), 'worktree state directory exists');
  const wtStateEntries = fs.readdirSync(wtStateDir);
  assert.deepEqual(wtStateEntries, ['delivery'], 'worktree state holds only delivery/');
  assert.equal(fs.existsSync(path.join(wt.worktree, '.doflow', 'state', 'runs')), false, 'no runs/ in worktree store');
});

test('E1 variant (C1): DOFLOW_TELEMETRY=off writes no telemetry file in either store', POSIX, async (t) => {
  const { root, wt } = await setupWorkerRun(t, { telemetry: 'off' });

  // (4) DOFLOW_TELEMETRY=off variant: no telemetry file in either store
  const telemDirP = path.join(root, '.doflow', 'state', 'runs', 'telemetry');
  const telemFilesP = fs.existsSync(telemDirP) ? fs.readdirSync(telemDirP).filter((f) => f.endsWith('.jsonl')) : [];
  assert.deepEqual(telemFilesP, [], 'no telemetry file in project store');

  const telemDirW = path.join(wt.worktree, '.doflow', 'state', 'runs', 'telemetry');
  const telemFilesW = fs.existsSync(telemDirW) ? fs.readdirSync(telemDirW).filter((f) => f.endsWith('.jsonl')) : [];
  assert.deepEqual(telemFilesW, [], 'no telemetry file in worktree store');
});

test('E1 variant: DOFLOW_TELEMETRY=off worktree state holds only delivery', POSIX, async (t) => {
  const { wt } = await setupWorkerRun(t, { telemetry: 'off' });

  const wtStateDir = path.join(wt.worktree, '.doflow', 'state');
  assert.ok(fs.existsSync(wtStateDir), 'worktree state directory exists');
  const wtStateEntries = fs.readdirSync(wtStateDir);
  assert.deepEqual(wtStateEntries, ['delivery'], 'worktree state holds only delivery/');
});

