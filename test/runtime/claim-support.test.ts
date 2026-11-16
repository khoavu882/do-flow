'use strict';

// 141 D.3 (IC-007, IC-009, IC-010): the claim-support builders and the shadow hook of `claim --action link`. The model is
// a fake server; the shadow call runs in a detached child (row 174 O-2) that builds its own client from the user
// settings. Every case compares what the command printed, its exit status and the claim and evidence files with the
// kind-off run, and reads the advice store only for what the detached call wrote.

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
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
const { recordCall } = require('../../src/runtime/advice/shadow-dispatcher.ts');

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

/**
 * Advice on in the user settings against an in-process fake server answering `route` (yes probability 0.8 by default).
 * `asks()` is every decision request the detached call made, with its body (the state and the question set).
 */
async function advised(s: any, route: any = answering(() => 0.8)) {
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': route } });
  s.t.after(() => server.close());
  const file = path.join(s.roots['config-home'], 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' }));
  return { server, asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
}

/** A spawn seam that counts the detached children the hook would start, and starts none. */
function countingSpawn() {
  const spawn: any = () => { spawn.count += 1; throw new Error('no child in this case'); };
  spawn.count = 0;
  return spawn;
}

async function waitFor(check: () => any, ms = 5000) {
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
      const a = await advised(s);
      const offSpawn = countingSpawn();
      const off = await link(s, { relation, services: { adviceRegistry: registry, spawn: offSpawn, shadowConfig: { ...SHADOW, mode: 'off' } } });
      assert.equal(offSpawn.count, 0, 'kind off: no call');
      assert.deepEqual(s.lines(), [], 'kind off: no file');

      const on = await link(s, { relation, services: { adviceRegistry: registry, shadowConfig: SHADOW } });
      const line = await waitFor(() => s.lines()[0]);
      assert.equal(on.exit, 0);
      assert.deepEqual(on.out, off.out, 'printed text is byte-identical with the kind on');
      assert.deepEqual(on.err, off.err);
      assert.equal(on.exit, off.exit);
      assert.deepEqual(on.files, off.files, 'the claims and evidence files are identical with the kind on');
      const printedClaim = JSON.parse(on.out.join('\n'));
      assert.equal(printedClaim.status, relation === 'supports' ? 'supported' : 'rejected');

      assert.equal(a.asks().length, 1);
      const asked = a.asks()[0].body;
      assert.deepEqual(Object.keys(asked.questions), ['claim-support']);
      assert.equal(asked.questions['claim-support'].type, 'noul', 'a yes/no question');
      assert.equal(asked.model, 'm');
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
    await advised(s);
    const off = await link(s, { json: false, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const on = await link(s, { json: false, services: { adviceRegistry: registry, shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.deepEqual(on.files, off.files);
    assert.equal(on.exit, off.exit);
    await waitFor(() => s.lines()[0]);
  });

  test('a failing model leaves the output, exit status and files unchanged and records a miss', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const a = await advised(s, { status: 500, body: { error: 'down' } });
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const on = await link(s, { services: { adviceRegistry: registry, shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.equal(on.exit, off.exit);
    assert.deepEqual(on.files, off.files);
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(a.asks().length, 1);
    assert.equal(line.type, 'miss');
    assert.equal(line.kind, 'claim-support');
    assert.equal(line.reason, 'server-error');
    assert.equal(s.storeText().includes(SENTINEL_CLAIM), false);
  });

  test('a spawn that throws, or a registry that cannot be read, is swallowed; the failed spawn is a miss with no call', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const spawn = countingSpawn();
    for (const services of [{ adviceRegistry: registry, spawn, shadowConfig: SHADOW }, { adviceRegistry: { kinds: 'broken' }, shadowConfig: SHADOW }, { adviceRegistry: { kinds: [{ id: 'claim-support', params: null }] }, shadowConfig: SHADOW }]) {
      const on = await link(s, { services });
      assert.deepEqual(on.out, off.out);
      assert.equal(on.exit, off.exit);
      assert.deepEqual(on.files, off.files);
    }
    assert.equal(spawn.count, 1);
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.kind, line.reason, line.mode]), [['miss', 'claim-support', 'spawn-failed', 'shadow']]);
  });

  test('a stalled model: the handler returns first, the call is dropped at budgetMs and recorded as a timeout', async (t) => {
    const s = setup(t);
    const registry = registryWith({ budgetMs: 120 });
    const a = await advised(s, { stall: true });
    const startedAt = Date.now();
    const on = await link(s, { services: { adviceRegistry: registry, shadowConfig: SHADOW } });
    const returnedAt = Date.now();
    assert.equal(on.exit, 0);
    assert.ok(returnedAt - startedAt < 120, `the handler did not wait for the call (${returnedAt - startedAt} ms)`);
    assert.equal(a.asks().length, 0, 'the call has not even started when the handler returns');
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(a.asks().length, 1, 'the detached call reached the stalled model');
    assert.equal(line.type, 'miss');
    assert.equal(line.reason, 'timeout');
    assert.ok(line.durationMs >= 100 && line.durationMs < 1000, `the call ran ${line.durationMs}ms against a 120 ms budget`);
  });

  test('an unreadable reply is recorded as a malformed-reply miss', async (t) => {
    const s = setup(t);
    await advised(s, { status: 200, body: { answers: { 'claim-support': { choice: 'yes' } } } });
    await link(s, { services: { adviceRegistry: registryWith(), shadowConfig: SHADOW } });
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.type, 'miss');
    assert.equal(line.reason, 'malformed-reply');
  });

  test('an answered call that is not a yes/no answer is recorded as a malformed-reply miss, never a pick', (t) => {
    const s = setup(t);
    const answer = { name: 'claim-support', type: 'choice', pick: 'yes', probabilities: {}, model: 'm' };
    const call = { status: 'answered', pick: 'yes', answer, answers: [answer], reason: null, provider: 'ollama', model: 'm', durationMs: 5 };
    const context = { kind: 'claim-support', caller: 'claim', state: 'claim: c\npassage: p', staticPick: 'yes', lineExtra: { claimSupport: { claimId: 'c1' } } };
    recordCall(context, { roots: s.roots }, 'shadow', call, 'adv-1700000000000-abcdef', false);
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason]), [['miss', 'malformed-reply']]);
  });

  test('act is held at shadow: the bench gate is never consulted and the line says shadow', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    await advised(s);
    const off = await link(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    let gateCalls = 0;
    const benchGate = () => { gateCalls += 1; return { passed: true }; };
    const on = await link(s, { services: { adviceRegistry: registry, benchGate, shadowConfig: { ...SHADOW, mode: 'act' } } });
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
    const a = await advised(s);
    await link(s, { services: { adviceRegistry: registryWith(), shadowConfig: SHADOW } });
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.claimSupport.truncated, true);
    assert.equal(line.claimSupport.passageBytes, 2048);
    assert.equal(a.asks()[0].body.state.includes(SENTINEL_PASSAGE), false, 'the cut passage no longer reaches the sentinel at its end');
  });

  describe('skipped: no call and no file', () => {
    test('relation refutes (the link itself is refused) and any other action', async (t) => {
      const s = setup(t);
      const spawn = countingSpawn();
      const services = { adviceRegistry: registryWith(), spawn, shadowConfig: SHADOW };
      const refuted = await link(s, { relation: 'refutes', services });
      assert.notEqual(refuted.exit, 0, 'an unknown relation is refused as before');
      await link(s, { action: 'list', services });
      assert.equal(spawn.count, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('the hook function skips a relation other than supports or contradicts', async (t) => {
      const s = setup(t);
      const spawn = countingSpawn();
      const { fireShadowClaimSupport } = require('../../src/runtime/claims.ts');
      fireShadowClaimSupport({
        taskId: TASK, claimId: 'c1', evidenceId: 'e1', relation: 'refutes', claimStatus: 'supported', claim: 'c', passage: 'p',
        projectRoot: s.projectRoot, env: s.env, services: { roots: s.roots, adviceRegistry: registryWith(), spawn, shadowConfig: SHADOW },
      });
      await tick();
      assert.equal(spawn.count, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('an evidence item with no text', async (t) => {
      const s = setup(t);
      const spawn = countingSpawn();
      const registry = registryWith();
      const off = await link(s, { evidence: s.noText, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
      const on = await link(s, { evidence: s.noText, services: { adviceRegistry: registry, spawn, shadowConfig: SHADOW } });
      await tick();
      assert.equal(spawn.count, 0);
      assert.deepEqual(s.lines(), []);
      assert.deepEqual(on.out, off.out);
      assert.deepEqual(on.files, off.files);
    });

    test('no project root given (every existing caller)', async (t) => {
      const s = setup(t);
      const spawn = countingSpawn();
      const run = await link(s, { projectRoot: null, services: { adviceRegistry: registryWith(), spawn, shadowConfig: SHADOW } });
      await tick();
      assert.equal(run.exit, 0);
      assert.equal(spawn.count, 0);
      assert.deepEqual(s.lines(), []);
    });

    test('advice off in the project settings (no injected config): no call and no file', async (t) => {
      const s = setup(t);
      const spawn = countingSpawn();
      const run = await link(s, { services: { adviceRegistry: registryWith(), spawn } });
      await tick();
      assert.equal(run.exit, 0);
      assert.equal(spawn.count, 0);
      assert.deepEqual(s.lines(), []);
    });
  });
});
