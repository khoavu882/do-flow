'use strict';

// Feature 106 IC-002: quota matching and worker report recognition.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchQuota, quotaOf, QUOTA_SCAN_BYTES } = require('../../src/runtime/worker/quota.ts');
const { validateWorker, loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const { resultOfRun } = require('../../src/runtime/worker/supervisor.ts');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const { readLog } = require('../helper/fake-harness-cli.ts');
const attempts = require('../../src/runtime/task-attempts.ts');
const dispatchStore = require('../../src/runtime/dispatch/store.ts');
const { createAttemptWorktree } = require('../../src/runtime/dispatch/integrate.ts');
const { runKeyFor } = require('../../src/runtime/task-run.ts');
const { storeFileFor, newRunId, insertRun } = require('../../src/runtime/worker/run-store.ts');
const { launchEnv, launchRecord } = require('../../src/runtime/worker/launch.ts');
const { superviseRun } = require('../../src/runtime/worker/supervisor.ts');

/** The codex entry's registry signals, read, not copied (106 review C-6). */
const SIGNALS = loadRegistry({ repoRoot: path.resolve(__dirname, '../..') }).harnesses.find((h: any) => h.id === 'codex').worker.structuredOutput.quotaSignals.signals;
test('quota matcher finds declared codex signals case-insensitively and in declaration order', () => {
  for (const [summary, signal] of [['Rate Limit reached', 'rate limit'], ['USAGE LIMIT', 'usage limit'], ['Quota exceeded for project', 'quota exceeded'], ['429 Too Many Requests', 'too many requests'], ['RESOURCE_EXHAUSTED', 'resource_exhausted']]) {
    assert.equal(matchQuota(summary, SIGNALS), signal);
  }
  assert.equal(matchQuota('quota exceeded then rate limit', SIGNALS), 'rate limit');
});

test('106 C-6: the codex signals match quota phrases and never ordinary failure prose', () => {
  assert.deepEqual(SIGNALS, ['rate limit', 'usage limit', 'quota exceeded', 'too many requests', 'resource_exhausted']);
  for (const summary of ['You have hit your usage limit', 'Rate limit reached', '429 Too Many Requests', 'Quota exceeded for project', 'RESOURCE_EXHAUSTED']) {
    assert.notEqual(matchQuota(summary, SIGNALS), null, summary);
  }
  for (const summary of ['expected 4290 got 0', 'the quota module test still fails', 'error in src/quota.ts line 12', 'HTTP 429']) {
    assert.equal(matchQuota(summary, SIGNALS), null, summary);
    assert.equal(quotaOf({ status: 'failure', summary }, { structuredOutput: { quotaSignals: { signals: SIGNALS, basis: 'unverified', evidence: [] } } }), null, summary);
  }
});
test('quota matcher ignores other failures and scans only a UTF-8 safe 2,000 byte prefix', () => {
  for (const summary of ['400 Bad Request: invalid model', '401 Unauthorized', '502 Bad Gateway', '', null, undefined]) assert.equal(matchQuota(summary, SIGNALS), null);
  assert.equal(QUOTA_SCAN_BYTES, 2000);
  assert.equal(matchQuota(`${'x'.repeat(2000)}rate limit`, SIGNALS), null);
  assert.doesNotThrow(() => matchQuota(`${'x'.repeat(1999)}💩rate limit`, SIGNALS));
  assert.equal(matchQuota('quota', []), null);
  assert.equal(matchQuota('quota', 'quota'), null);
});

function validateQuota(quotaSignals: any, status: any = 'supported'): any {
  const errors: any = [];
  const worker = structuredClone(loadRegistry({ repoRoot: path.resolve(__dirname, '../..') }).harnesses.find((h: any) => h.id === 'codex').worker);
  worker.structuredOutput = { ...worker.structuredOutput, status, quotaSignals };
  validateWorker(worker, "harness 'codex'", errors);
  return errors;
}
test('quotaSignals validation rejects unsupported, malformed, and unknown fields with harness context', () => {
  const good: any = { signals: ['quota'], basis: 'unverified', evidence: [] };
  const cases: any = [
    [good, 'unknown', /quotaSignals.*supported/],
    [{ ...good, signals: [] }, 'supported', /1 to 16/],
    [{ ...good, signals: Array(17).fill('quota') }, 'supported', /1 to 16/],
    [{ ...good, signals: ['ab'] }, 'supported', /3 to 64/],
    [{ ...good, signals: ['bad\u0001signal'] }, 'supported', /control/],
    [{ signals: ['quota'], basis: 'transcript', evidence: [] }, 'supported', /transcript.*evidence/],
    [{ signals: ['quota'], basis: 'unverified', evidence: ['core/worker-evidence/codex/x.json'] }, 'supported', /unverified.*evidence/],
    [{ ...good, other: true }, 'supported', /unknown field 'other'/],
  ];
  for (const [quota, status, expected] of cases) {
    const errors: any = validateQuota(quota, status);
    assert.ok(errors.some((line: any) => line.includes("harness 'codex' worker 'structuredOutput'") && expected.test(line)), JSON.stringify(errors));
  }
  const repoRoot = path.resolve(__dirname, '../..');
  assert.equal(loadRegistry({ repoRoot }).validation.ok, true);
  const registry = structuredClone(loadRegistry({ repoRoot }));
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  codex.worker.structuredOutput.quotaSignals = { signals: ['quota'], basis: 'transcript', evidence: ['core/worker-evidence/codex/missing.json'] };
  const loaded = validateRegistry(registry, { repoRoot });
  assert.ok(loaded.errors.some((line: any) => line.includes("harness 'codex' worker 'structuredOutput'") && line.includes('does not exist')));
});

test('quota-marked failure uses report-quota while ordinary failure preserves report-failure', () => {
  const run: any = { end: { state: 'exited' }, process: { kind: 'exited' }, readOnly: { status: 'clean' }, report: { status: 'failure', quota: { signal: 'usage limit', basis: 'unverified' } } };
  assert.ok(resultOfRun(run).withheld.includes('report-quota'));
  assert.ok(!resultOfRun(run).withheld.includes('report-failure'));
  delete run.report.quota;
  assert.ok(resultOfRun(run).withheld.includes('report-failure'));
});

test('quotaOf marks only failure reports, from the descriptor signals, never success, denied or unparsed', () => {
  const descriptor: any = { structuredOutput: { quotaSignals: { signals: SIGNALS, basis: 'unverified', evidence: [] } } };
  const summary = 'You have hit your usage limit';
  assert.deepEqual(quotaOf({ status: 'failure', summary }, descriptor), { signal: 'usage limit', basis: 'unverified' });
  for (const status of ['success', 'denied', 'unparsed']) assert.equal(quotaOf({ status, summary }, descriptor), null, status);
  assert.equal(quotaOf({ status: 'failure', summary: '401 Unauthorized: invalid api key' }, descriptor), null);
  assert.equal(quotaOf({ status: 'failure', summary }, { structuredOutput: {} }), null);
  assert.equal(quotaOf({ status: 'failure', summary: null }, descriptor), null);
});

test('resultOfRun never reads quota on a report that is not a failure', () => {
  const run: any = { end: { state: 'exited' }, process: { kind: 'exited' }, readOnly: { status: 'clean' }, report: { status: 'unparsed', quota: { signal: 'quota', basis: 'unverified' } } };
  assert.deepEqual(resultOfRun(run).withheld, ['report-unparsed']);
});

function fakeCodexProject(t: any, jsonl: any, quota: any = true) {
  const slug = '106-worker-quota';
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug, scenario: { codex: { jsonl } }, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root, env } = sb;
  const descriptor: any = {
    cli: { status: 'supported', binary: 'fake-codex', versionArgv: ['--version'] },
    readOnly: { status: 'supported', argv: ['exec', '-s', 'read-only'] },
    spawnDenial: { status: 'supported', argv: [] },
    structuredOutput: { status: 'supported', argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1', ...(quota ? { quotaSignals: { signals: SIGNALS, basis: 'unverified', evidence: [] } } : {}) },
    oneShot: { status: 'supported', argv: ['--ephemeral', '-'], promptVia: 'stdin' },
  };
  const base = require('node:child_process').spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).stdout.trim();
  const ledger = attempts.storeFile(root, slug);
  const common: any = { file: ledger, fsImpl: fs, roots: [root], slug, env, cwd: root };
  attempts.start({ ...common, by: 'main' });
  const attempt = createAttemptWorktree({ root, slug, dispatchId: dispatchStore.newDispatchId(), base, env });
  const claim = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree: attempt.worktree });
  const key = runKeyFor(env, root);
  const store = storeFileFor(root, slug);
  const runId = newRunId();
  const promptFile = path.join(sb.dir, `${runId}.prompt.md`);
  fs.writeFileSync(promptFile, 'quota test');
  const { identity } = launchEnv({ env, runKey: key.runKey, token: claim.token, execWorktree: attempt.worktree, runId });
  const prompt = 'quota test';
  insertRun(store, {
    runId, task: 'A.1', token: claim.token, harness: 'codex', phase: 'starting', execWorktree: attempt.worktree,
    createdAt: new Date().toISOString(), timeoutSeconds: 60,
    caller: { cwd: root, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
    ...launchRecord(descriptor, identity, prompt, false), descriptor,
    prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) }, needs: [],
  });
  return { root, env, store, runId, log: sb.log };
}

test('supervisor marks only masked failure summaries from a configured descriptor', { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' }, async (t) => {
  const p = fakeCodexProject(t, [{ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }]);
  const run = await superviseRun({ file: p.store, runId: p.runId, env: p.env, cwd: p.root });
  assert.equal(run.report.status, 'failure');
  assert.deepEqual(run.report.quota, { signal: 'usage limit', basis: 'unverified' });
  assert.ok(resultOfRun(run).withheld.includes('report-quota'));
  assert.ok(!resultOfRun(run).withheld.includes('report-failure'));
  assert.ok(readLog(p.log).some((entry: any) => entry.argv.includes('--json')));

  const successProject = fakeCodexProject(t, [
    { type: 'item.completed', item: { type: 'agent_message', text: 'quota reached but this completed' } },
    { type: 'turn.completed' },
  ]);
  const success = await superviseRun({ file: successProject.store, runId: successProject.runId, env: successProject.env, cwd: successProject.root });
  assert.equal(success.report.status, 'success');
  assert.equal(success.report.quota, undefined);

  const noSignals = fakeCodexProject(t, [{ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }], false);
  const ordinary = await superviseRun({ file: noSignals.store, runId: noSignals.runId, env: noSignals.env, cwd: noSignals.root });
  assert.equal(ordinary.report.status, 'failure');
  assert.equal(ordinary.report.quota, undefined);
  assert.ok(resultOfRun(ordinary).withheld.includes('report-failure'));

  const deniedProject = fakeCodexProject(t, [{ type: 'item.completed', item: { type: 'command_execution', status: 'declined', command: 'quota' } }]);
  const denied = await superviseRun({ file: deniedProject.store, runId: deniedProject.runId, env: deniedProject.env, cwd: deniedProject.root });
  assert.equal(denied.report.status, 'denied');
  assert.equal(denied.report.quota, undefined);

  const unparsedProject = fakeCodexProject(t, [{ type: 'turn.completed' }]);
  const unparsed = await superviseRun({ file: unparsedProject.store, runId: unparsedProject.runId, env: unparsedProject.env, cwd: unparsedProject.root });
  assert.equal(unparsed.report.status, 'unparsed');
  assert.equal(unparsed.report.quota, undefined);
});

