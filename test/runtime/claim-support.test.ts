'use strict';

// 141 D.3 (IC-007, IC-009, IC-010): the claim-support builders and the shadow hook of `claim --action link`. The advice
// client is a fake. The hook runs detached after the output is printed, so every case compares what the command printed,
// its exit status and the claim and evidence files with the kind-off run, and reads the advice store only for what the
// detached call wrote.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { buildClaimSupportState, claimSupportPayload } = require('../../src/runtime/advice/claim-support.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { handleClaimCommand } = require('../../src/runtime/claims.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const SENTINEL_CLAIM = 'sentinelclaim5521';
const SENTINEL_PASSAGE = 'sentinelpassage8830';
const SHADOW = { kind: 'claim-support', mode: 'shadow', model: 'm' };
const TASK = 'task_001';
const PARAMS = { claimBytes: 1024, passageBytes: 2048 };

function registryWith({ budgetMs = 5000 }: any = {}) {
  const registry = JSON.parse(JSON.stringify(ADVICE));
  registry.kinds.find((entry: any) => entry.id === 'claim-support').budgetMs = budgetMs;
  return registry;
}

function answeringClient(yes = 0.8) {
  const calls: any[] = [];
  return {
    calls,
    ask: async (options: any) => {
      calls.push(options);
      return {
        status: 'answered', reason: null, model: 'm',
        answers: [{ name: 'claim-support', type: 'yesno', pick: yes >= 0.5 ? 'yes' : 'no', strength: { word: 'clear', between: null }, probabilities: { no: 1 - yes, yes }, confidence: yes }],
      };
    },
  };
}

function rejectingClient() {
  const calls: any[] = [];
  return { calls, ask: async (options: any) => { calls.push(options); throw new Error('client exploded'); } };
}

function hangingClient() {
  const calls: any[] = [];
  return { calls, ask: (options: any) => { calls.push({ ...options, at: Date.now() }); return new Promise(() => {}); } };
}

async function waitFor(check: () => any, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` with console output and the exit status captured; the status is restored to what it was. */
async function capture(fn: () => any) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log; const error = console.error;
  const priorExit = process.exitCode;
  console.log = (...args: any[]) => { out.push(args.join(' ')); };
  console.error = (...args: any[]) => { err.push(args.join(' ')); };
  process.exitCode = undefined;
  try {
    const returned = await fn();
    return { out, err, exit: process.exitCode ?? 0, returned };
  } finally {
    console.log = log; console.error = error; process.exitCode = priorExit;
  }
}

const blank = (text: string) => text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');

/** Every file under `dir` as { relative path: text }, with ISO timestamps (written by each run) blanked. */
function snapshot(dir: string) {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = blank(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

/**
 * A project with a settings fixture and a record store, plus `fixture()`: a fresh state root holding one claim and one
 * evidence item, with the claim and evidence ids. Two calls give two equal-but-separate roots (same ids).
 */
function setup(t: any, { passage = `the cache TTL is 300 seconds ${SENTINEL_PASSAGE}` }: any = {}) {
  const f = createSettingsEnv(t, { prefix: 'doflow-claim-support-' });
  const env = f.env();
  const roots = resolveRoots({ registry: STORAGE, projectRoot: f.project, env });
  const template = tempDir(t, 'doflow-claim-state-');
  const ledger = new EvidenceLedger({ repoRoot: template });
  const evidenceId = ledger.addEvidence({ taskId: TASK, kind: 'exact-search', content: passage, id: 'ev_fixed_1' });
  ledger.save(TASK);
  const noText = ledger.addEvidence({ taskId: TASK, kind: 'exact-search', id: 'ev_fixed_2' });
  ledger.save(TASK);
  const printed = capture(() => handleClaimCommand({ taskId: TASK, action: 'add', statement: `The cache TTL is 300 seconds ${SENTINEL_CLAIM}`, stateRoot: template, json: true }));
  const lines = () => readWindow({ roots }).records.map((entry: any) => entry.record);
  const storeText = () => {
    const dir = path.join(roots['project-state'], 'advice');
    return fs.existsSync(dir) ? Object.values(snapshot(dir)).join('') : '';
  };
  return { f, env, roots, projectRoot: f.project, template, evidenceId, noText, printed, lines, storeText, t };
}

/** A copy of the template state root, so each run starts from the same files. */
function copyState(s: any) {
  const dir = tempDir(s.t, 'doflow-claim-run-');
  fs.cpSync(s.template, dir, { recursive: true });
  return dir;
}

async function claimId(s: any) {
  const added = await s.printed;
  return JSON.parse(added.out.join('\n')).claim.id;
}

/** Runs `claim --action link` on a fresh copy of the template; returns what it printed, its status and the state files. */
async function link(s: any, { relation = 'supports', evidence = s.evidenceId, json = true, services = {}, projectRoot = s.projectRoot, action = 'link' }: any = {}) {
  const stateRoot = copyState(s);
  const id = await claimId(s);
  const result = await capture(() => handleClaimCommand({
    taskId: TASK, action, claimId: id, evidenceId: evidence, relation, json, stateRoot, projectRoot, env: s.env, adviceServices: { roots: s.roots, ...services },
  }));
  // The handler stamps `updatedAt` from the clock on every run, so the clock readings are blanked on both sides.
  return { ...result, out: result.out.map(blank), files: snapshot(stateRoot) };
}

describe('claim-support builders', () => {
  test('state is two named lines, whitespace collapsed, cut at each byte cap on a code-point boundary', () => {
    const built = buildClaimSupportState({ claim: '  The   cache\nTTL ', passage: 'a\tb  c', params: PARAMS });
    assert.deepEqual(built, { ok: true, state: 'claim: The cache TTL\npassage: a b c', claimBytes: 13, passageBytes: 5, truncated: false });
    const cut = buildClaimSupportState({ claim: 'é'.repeat(2000), passage: 'p'.repeat(5000), params: PARAMS });
    assert.equal(cut.ok, true);
    assert.equal(cut.claimBytes, 1024);
    assert.equal(cut.passageBytes, 2048);
    assert.equal(cut.truncated, true);
    const [claimLine, passageLine] = cut.state.split('\n');
    assert.equal(Buffer.byteLength(claimLine.slice('claim: '.length), 'utf8'), 1024);
    assert.equal(passageLine.length, 'passage: '.length + 2048);
    const odd = buildClaimSupportState({ claim: '€€€', passage: 'x', params: { claimBytes: 7, passageBytes: 10 } });
    assert.equal(odd.state.split('\n')[0], 'claim: €€', 'a 3-byte character that does not fit is dropped whole');
    assert.equal(odd.claimBytes, 6);
  });

  test('a blank claim, a blank or non-string passage and unusable caps build nothing', () => {
    assert.deepEqual(buildClaimSupportState({ claim: '  ', passage: 'p', params: PARAMS }), { ok: false, reason: 'empty-claim' });
    assert.deepEqual(buildClaimSupportState({ claim: 'c', passage: ' \n', params: PARAMS }), { ok: false, reason: 'empty-passage' });
    assert.deepEqual(buildClaimSupportState({ claim: 'c', passage: { text: 'p' }, params: PARAMS }), { ok: false, reason: 'empty-passage' });
    assert.deepEqual(buildClaimSupportState({ claim: 'c', passage: 'p', params: { claimBytes: 0, passageBytes: 5 } }), { ok: false, reason: 'bad-params' });
    assert.deepEqual(buildClaimSupportState({ claim: 'c', passage: 'p' }), { ok: false, reason: 'bad-params' });
  });

  test('the payload holds ids, the relation and status words and numbers only, and refuses any other relation', () => {
    const payload = claimSupportPayload({ claimId: 'c1', evidenceId: 'e1', relation: 'supports', claimStatus: 'supported', claimBytes: 12, passageBytes: 30, truncated: true, claim: SENTINEL_CLAIM, passage: SENTINEL_PASSAGE });
    assert.deepEqual(payload, { claimId: 'c1', evidenceId: 'e1', relation: 'supports', claimStatus: 'supported', claimBytes: 12, passageBytes: 30, truncated: true });
    assert.equal(JSON.stringify(payload).includes('sentinel'), false);
    assert.equal(claimSupportPayload({ claimId: 'c1', evidenceId: 'e1', relation: 'refutes', claimStatus: 'supported' }), null);
    assert.equal(claimSupportPayload({ claimId: '', evidenceId: 'e1', relation: 'supports', claimStatus: 'supported' }), null);
    assert.equal(claimSupportPayload({ claimId: 'c1', evidenceId: 'e1', relation: 'contradicts', claimStatus: 'conflicted', claimBytes: -1 }).claimBytes, 0);
  });
});

describe('claim link: the shadow hook', () => {
  for (const [relation, staticPick] of [['supports', 'yes'], ['contradicts', 'no']]) {
    test(`${relation}: output and files equal the kind-off run; one claim-support pick is written with no claim or passage text`, async (t) => {
      const s = setup(t);
      const registry = registryWith();
      const offClient = answeringClient();
      const off = await link(s, { relation, services: { adviceRegistry: registry, adviceClient: offClient, shadowConfig: { ...SHADOW, mode: 'off' } } });
      await tick();
      assert.equal(offClient.calls.length, 0, 'kind off: no client call');
      assert.deepEqual(s.lines(), [], 'kind off: no file');

      const client = answeringClient(0.8);
      const on = await link(s, { relation, services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
      const line = await waitFor(() => s.lines()[0]);
      assert.equal(on.exit, 0);
      assert.deepEqual(on.out, off.out, 'printed text is byte-identical with the kind on');
      assert.deepEqual(on.err, off.err);
      assert.equal(on.exit, off.exit);
      assert.deepEqual(on.files, off.files, 'the claims and evidence files are identical with the kind on');
      const printedClaim = JSON.parse(on.out.join('\n'));
      assert.equal(printedClaim.status, relation === 'supports' ? 'supported' : 'rejected');

      assert.equal(client.calls.length, 1);
      assert.equal(client.calls[0].kind, 'claim-support');
      assert.equal(client.calls[0].caller, 'claim');
      assert.equal(client.calls[0].record, false);
      assert.equal(client.calls[0].staticAnswer, staticPick);
      assert.equal(client.calls[0].taskId, TASK);
      const asked = client.calls[0].questionSet;
      assert.equal(asked.questions.length, 1);
      assert.equal(asked.questions[0].type, 'yesno');
      assert.match(asked.state, new RegExp(`^claim: The cache TTL is 300 seconds ${SENTINEL_CLAIM}\\npassage: the cache TTL is 300 seconds ${SENTINEL_PASSAGE}$`), 'the model is asked with both texts');

      assert.equal(line.type, 'pick');
      assert.equal(line.kind, 'claim-support');
      assert.equal(line.caller, 'claim');
      assert.equal(line.qtype, 'yesno');
      assert.equal(line.mode, 'shadow');
      assert.equal(line.static, staticPick);
      assert.equal(line.pick, 'yes');
      assert.equal(line.probabilities.yes, 0.8);
      assert.equal(line.taskId, TASK);
      assert.equal(line.claimSupport.relation, relation);
      assert.equal(line.claimSupport.claimId, printedClaim.claim.id);
      assert.equal(line.claimSupport.evidenceId, s.evidenceId);
      assert.equal(line.claimSupport.claimStatus, printedClaim.status);
      assert.equal(line.claimSupport.truncated, false);
      assert.equal(line.claimSupport.claimBytes, Buffer.byteLength(`The cache TTL is 300 seconds ${SENTINEL_CLAIM}`, 'utf8'));
      assert.equal(line.claimSupport.passageBytes, Buffer.byteLength(`the cache TTL is 300 seconds ${SENTINEL_PASSAGE}`, 'utf8'));
      assert.equal(line.stateBytes, Buffer.byteLength(asked.state, 'utf8'));
      const stored = s.storeText();
      assert.ok(stored.length > 0);
      for (const sentinel of [SENTINEL_CLAIM, SENTINEL_PASSAGE, 'cache TTL']) assert.equal(stored.includes(sentinel), false, `${sentinel} is not stored`);
      assert.equal(JSON.stringify(line).includes('sentinel'), false);
    });
  }

  test('the text output of the link command is also identical with the kind on and off', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const off = await link(s, { json: false, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const on = await link(s, { json: false, services: { adviceRegistry: registry, adviceClient: answeringClient(), shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.deepEqual(on.files, off.files);
    assert.equal(on.exit, off.exit);
    await waitFor(() => s.lines()[0]);
  });

  test('a rejecting client leaves the output, exit status and files unchanged and records a miss', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = rejectingClient();
    const on = await link(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.equal(on.exit, off.exit);
    assert.deepEqual(on.files, off.files);
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(client.calls.length, 1);
    assert.equal(line.type, 'miss');
    assert.equal(line.kind, 'claim-support');
    assert.equal(s.storeText().includes(SENTINEL_CLAIM), false);
  });

  test('a client that throws synchronously, or a registry that cannot be read, is swallowed', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const throwing = { ask: () => { throw new Error('sync boom'); } };
    for (const services of [{ adviceRegistry: registry, adviceClient: throwing, shadowConfig: SHADOW }, { adviceRegistry: { kinds: 'broken' }, shadowConfig: SHADOW }, { adviceRegistry: { kinds: [{ id: 'claim-support', params: null }] }, shadowConfig: SHADOW }]) {
      const on = await link(s, { services });
      assert.deepEqual(on.out, off.out);
      assert.equal(on.exit, off.exit);
      assert.deepEqual(on.files, off.files);
    }
  });

  test('a hanging client: the handler returns first, the call is aborted at budgetMs and recorded as a timeout', async (t) => {
    const s = setup(t);
    const registry = registryWith({ budgetMs: 120 });
    const client = hangingClient();
    const startedAt = Date.now();
    const on = await link(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    const returnedAt = Date.now();
    assert.equal(on.exit, 0);
    assert.ok(returnedAt - startedAt < 120, `the handler did not wait for the call (${returnedAt - startedAt} ms)`);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].signal.aborted, false, 'the call is still running when the handler returns');
    await waitFor(() => client.calls[0].signal.aborted, 1500);
    assert.equal(client.calls[0].signal.aborted, true);
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.type, 'miss');
    assert.equal(line.reason, 'timeout');
  });

  test('an unreadable reply (not a yes/no answer) is recorded as a malformed-reply miss', async (t) => {
    const s = setup(t);
    const client = { calls: [] as any[], ask: async () => ({ status: 'answered', model: 'm', answers: [{ name: 'claim-support', type: 'choice', pick: 'yes', probabilities: {} }] }) };
    await link(s, { services: { adviceRegistry: registryWith(), adviceClient: client, shadowConfig: SHADOW } });
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.type, 'miss');
    assert.equal(line.reason, 'malformed-reply');
  });

  test('act is held at shadow: the bench gate is never consulted and the line says shadow', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = answeringClient();
    let gateCalls = 0;
    const benchGate = () => { gateCalls += 1; return { passed: true }; };
    const on = await link(s, { services: { adviceRegistry: registry, adviceClient: client, benchGate, shadowConfig: { ...SHADOW, mode: 'act' } } });
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(gateCalls, 0);
    assert.equal(line.mode, 'shadow');
    assert.equal(line.elevated, false);
    assert.equal(line.kind, 'claim-support');
    assert.deepEqual(on.out, off.out, 'act prints nothing the shadow run does not');
    assert.deepEqual(on.files, off.files);
    assert.equal(on.exit, off.exit);
  });

  test('a long passage is cut to its byte cap and the line says truncated', async (t) => {
    const s = setup(t, { passage: `${'wide '.repeat(1000)}${SENTINEL_PASSAGE}` });
    const client = answeringClient();
    await link(s, { services: { adviceRegistry: registryWith(), adviceClient: client, shadowConfig: SHADOW } });
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.claimSupport.truncated, true);
    assert.equal(line.claimSupport.passageBytes, 2048);
    assert.equal(client.calls[0].questionSet.state.includes(SENTINEL_PASSAGE), false, 'the cut passage no longer reaches the sentinel at its end');
  });

  describe('skipped: no call and no file', () => {
    test('relation refutes (the link itself is refused) and any other action', async (t) => {
      const s = setup(t);
      const client = answeringClient();
      const services = { adviceRegistry: registryWith(), adviceClient: client, shadowConfig: SHADOW };
      const refuted = await link(s, { relation: 'refutes', services });
      assert.notEqual(refuted.exit, 0, 'an unknown relation is refused as before');
      await link(s, { action: 'list', services });
      await tick();
      assert.equal(client.calls.length, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('the hook function skips a relation other than supports or contradicts', async (t) => {
      const s = setup(t);
      const client = answeringClient();
      const { fireShadowClaimSupport } = require('../../src/runtime/claims.ts');
      fireShadowClaimSupport({
        taskId: TASK, claimId: 'c1', evidenceId: 'e1', relation: 'refutes', claimStatus: 'supported', claim: 'c', passage: 'p',
        projectRoot: s.projectRoot, env: s.env, services: { roots: s.roots, adviceRegistry: registryWith(), adviceClient: client, shadowConfig: SHADOW },
      });
      await tick();
      assert.equal(client.calls.length, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('an evidence item with no text', async (t) => {
      const s = setup(t);
      const client = answeringClient();
      const registry = registryWith();
      const off = await link(s, { evidence: s.noText, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
      const on = await link(s, { evidence: s.noText, services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
      await tick();
      assert.equal(client.calls.length, 0);
      assert.deepEqual(s.lines(), []);
      assert.deepEqual(on.out, off.out);
      assert.deepEqual(on.files, off.files);
    });

    test('no project root given (every existing caller)', async (t) => {
      const s = setup(t);
      const client = answeringClient();
      const run = await link(s, { projectRoot: null, services: { adviceRegistry: registryWith(), adviceClient: client, shadowConfig: SHADOW } });
      await tick();
      assert.equal(run.exit, 0);
      assert.equal(client.calls.length, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('advice off in the project settings (no injected config): no call and no file', async (t) => {
      const s = setup(t);
      const client = answeringClient();
      const run = await link(s, { services: { adviceRegistry: registryWith(), adviceClient: client } });
      await tick();
      assert.equal(run.exit, 0);
      assert.equal(client.calls.length, 0);
      assert.deepEqual(s.lines(), []);
    });
  });
});
