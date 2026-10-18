'use strict';

// IC-004: launch substitution and supervised Codex fake runs, with no real harness in PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const { readLog } = require('../helper/fake-harness-cli.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { assembleArgv, argvShape } = require(path.join(SRC, 'worker', 'launch.ts'));
const { storeFileFor, newRunId, insertRun } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const { superviseRun, resultOfRun } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const dispatchStore = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createAttemptWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));

const SLUG = '109-codex-worker-fixture';
const TASK = 'A.1';
const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };

function supported(argv, extra = {}) {
  return {
    status: 'supported', evidence: ['test/runtime/worker-codex-fake.test.js'],
    verification: 'fake Codex worker run', verifiedOn: '2026-10-18', argv, ...extra,
  };
}

function codexDescriptor() {
  return {
    profile: null,
    cli: { status: 'supported', binary: 'fake-codex', versionArgv: ['--version'] },
    readOnly: supported(['exec', '-s', 'read-only']),
    isolatedEdit: supported(['exec', '-s', 'workspace-write']),
    spawnDenial: supported(['--disable', 'multi_agent', '--disable', 'multi_agent_v2']),
    structuredOutput: supported(['--json', '-o', '{lastMessageFile}'], { parser: 'codex-exec-json-v1' }),
    oneShot: supported(['--ephemeral', '-'], { promptVia: 'stdin' }),
  };
}

function git(cwd, env, args) {
  const result = require('node:child_process').spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t, codexScenario) {
  const sb = makeDispatchSandbox(t, {
    plan: 'disjoint', slug: SLUG, scenario: { codex: codexScenario },
    identity: { DOFLOW_ATTEMPT: undefined },
  });
  const { root, env } = sb;
  const descriptor = codexDescriptor();
  const base = git(root, env, ['rev-parse', 'HEAD']);
  const ledger = attempts.storeFile(root, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const attempt = createAttemptWorktree({ root, slug: SLUG, dispatchId: dispatchStore.newDispatchId(), base, env });
  const claim = attempts.claim({
    ...common, task: TASK, owner: 'core-implementer', mode: 'subagent', epoch: 1,
    execWorktree: attempt.worktree,
  });
  assert.equal(claim.disposition, 'claimed', JSON.stringify(claim));
  const key = runKeyFor(env, root);
  const store = storeFileFor(root, SLUG);

  function seed({ edit = false } = {}) {
    const runId = newRunId();
    const prompt = 'complete the codex task';
    const promptFile = path.join(sb.dir, `${runId}.prompt.md`);
    fs.writeFileSync(promptFile, prompt);
    const { identity } = launchEnv({ env, runKey: key.runKey, token: claim.token, execWorktree: attempt.worktree, runId });
    const record = {
      runId, task: TASK, token: claim.token, harness: 'codex', phase: 'starting', execWorktree: attempt.worktree,
      createdAt: new Date().toISOString(), timeoutSeconds: 60,
      caller: {
        cwd: root, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage,
        attempt: null, role: 'main', lineageKind: key.identity.lineageKind,
      },
      ...launchRecord(descriptor, identity, prompt, edit),
      descriptor,
      prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) },
      needs: [],
      ...(edit ? { edit: { base, branch: `refs/heads/${attempt.branch}`, callerTop: root } } : {}),
    };
    assert.equal(insertRun(store, record).applied, true);
    return { runId, record };
  }

  return {
    sb, root, env, base, attempt, descriptor, store,
    seed,
    supervise: (runId) => superviseRun({ file: store, runId, env, cwd: root }),
    lastFile: (runId) => path.join(path.dirname(store), '..', 'worker-output', `${runId}.last.log`),
  };
}

test('IC-004 substitutes the final-message file in argv and records only its placeholder', () => {
  const recipe = codexDescriptor();
  const output = '/tmp/codex-last-message.log';
  assert.deepEqual(assembleArgv(recipe, 'prompt', false, output), [
    'exec', '-s', 'read-only', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--json', '-o', output, '--ephemeral', '-',
  ]);
  assert.deepEqual(argvShape(recipe, 'prompt'), [
    'exec', '-s', 'read-only', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--json', '-o', '<last-message-file>', '--ephemeral', '-',
  ]);
  assert.throws(
    () => assembleArgv(recipe, 'prompt'),
    (error) => error?.name === 'LaunchUsageError' && error?.code === 'last-message-file-missing',
  );
});

test('fake codex final-message output is masked and a read-only and edit run are offered', POSIX, async (t) => {
  for (const edit of [false, true]) {
    const p = project(t, {
      jsonl: [
        ...(!edit ? [] : [{ type: 'item.completed', item: { type: 'agent_message', text: 'stream text wins' } }]),
        { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 8 } },
      ],
      lastMessage: 'Authorization: Bearer fake-secret-token-value',
    });
    const { runId } = p.seed({ edit });
    const run = await p.supervise(runId);
    assert.equal(run.phase, 'ended');
    assert.equal(run.report.parser, 'codex-exec-json-v1');
    assert.equal(run.report.status, 'success');
    assert.equal(run.report.summary, edit ? 'stream text wins' : 'Authorization: <masked>');
    assert.deepEqual(resultOfRun(run), { resultOffered: true, withheld: [] });
    assert.equal(run.recipe.argvShape.includes('<last-message-file>'), true);
    if (edit) {
      assert.equal(run.readOnly, null);
      assert.equal(run.isolation.status, 'clean');
    } else {
      assert.equal(run.readOnly.status, 'clean');
      assert.equal(run.isolation, undefined);
    }
    assert.equal(fs.existsSync(p.lastFile(runId)), true, 'last message file remains for retention');
    const retained = fs.readFileSync(p.lastFile(runId), 'utf8');
    assert.equal(retained.includes('fake-secret-token-value'), false, 'the retained final-message file holds no raw secret');
    assert.equal(retained, 'Authorization: <masked>');
    const invocation = readLog(p.sb.log).find((entry) => entry.argv.includes('--json'));
    const output = invocation.argv[invocation.argv.indexOf('-o') + 1];
    assert.equal(output, p.lastFile(runId));
    assert.ok(path.isAbsolute(output));
    assert.ok(invocation.argv.includes(edit ? 'workspace-write' : 'read-only'));
  }
});

test('negative control: a spawned agent is withheld despite the declared spawn-denial argv', POSIX, async (t) => {
  const p = project(t, {
    jsonl: [
      { type: 'item.started', item: { type: 'collab_tool_call', tool: 'spawn_agent' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed' },
    ],
    lastMessage: 'done',
  });
  const { runId, record } = p.seed();
  const run = await p.supervise(runId);
  assert.equal(record.descriptor.spawnDenial.status, 'supported');
  assert.equal(run.report.reason, 'spawn-observed');
  assert.equal(run.report.status, 'failure');
  assert.deepEqual(resultOfRun(run), { resultOffered: false, withheld: ['report-failure'] });
  const invocation = readLog(p.sb.log).find((entry) => entry.argv.includes('--json'));
  assert.deepEqual(invocation.argv.slice(3, 7), ['--disable', 'multi_agent', '--disable', 'multi_agent_v2']);
});

test('negative control: stale final-message content is removed before launch', POSIX, async (t) => {
  const p = project(t, { jsonl: [{ type: 'turn.completed' }], omitOutput: true });
  const { runId } = p.seed();
  fs.mkdirSync(path.dirname(p.lastFile(runId)), { recursive: true });
  fs.writeFileSync(p.lastFile(runId), 'stale secret summary');
  const run = await p.supervise(runId);
  assert.deepEqual([run.report.status, run.report.reason, run.report.summary], ['unparsed', 'no-final-message', null]);
  assert.equal(fs.existsSync(p.lastFile(runId)), false);
  assert.equal(resultOfRun(run).resultOffered, false);
});

test('negative control: the supervisor reads only the first 65536 final-message bytes', POSIX, async (t) => {
  const p = project(t, { jsonl: [{ type: 'turn.completed' }], lastMessage: `${' '.repeat(65536)}tail` });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  // The retained masked copy is bounded to what was read, so the 4 tail bytes are not kept.
  assert.equal(fs.statSync(p.lastFile(runId)).size, 65536);
  assert.deepEqual([run.report.status, run.report.reason, run.report.summary], ['unparsed', 'no-final-message', null]);
  assert.equal(resultOfRun(run).resultOffered, false);
});
