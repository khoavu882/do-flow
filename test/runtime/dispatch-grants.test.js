'use strict';

// Feature 082 C.2 (IC-033 declaration, request and status; DEC-008, DEC-028, DEC-041, DEC-051,
// DEC-062): spawn grants and the `spawn` action, over hand-seeded dispatch stores and 080 ledgers.
// No process is spawned and no git call is made: `root` is passed in, so projectRoot is not read.
// Every caller's five DOFLOW_* identity variables are set or deleted explicitly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');
const { storeFileFor, readDispatch } = require('../../src/runtime/dispatch/store.ts');
const { ENVELOPE_DIR } = require('../../src/runtime/dispatch/envelope.ts');
const {
  MAX_CHILDREN, validateGrant, copyGrant, requestSpawn, spawnStatus,
} = require('../../src/runtime/dispatch/grants.ts');

const SLUG = 'feat-grants';
const RUN_KEY = 'abc123/r0/main';
const D1 = 'd-111111111111';
const D2 = 'd-222222222222';
const IDENTITY = { run: 'r1', lineage: 'L1', attempt: '1' };

/** A project root with a dispatch run, one or more launched dispatches and a running 080 run. */
function project(t, { grant = { depth: 1, children: 2, tokens: 1000 }, control = 'running', dispatches = null, runState = 'running' } = {}) {
  const root = fs.realpathSync(tempDir(t, 'doflow-grants-'));
  const state = path.join(root, '.doflow', 'state');
  const wt = (id) => {
    const dir = path.join(state, 'dispatch-worktrees', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const dispatch = (id, extra = {}) => ({
    dispatchId: id, dispatchRunId: 'p-000000000000', task: 'A.1', token: 1, epoch: 1, phase: 'launched', mode: 'subagent',
    seq: 2, workerRunId: 'w-aaaaaaaaaaaa', workerIdentity: { ...IDENTITY, runSource: 'launched' },
    attempt: { worktree: wt(id), branch: `doflow-attempt/${SLUG}/${id}`, base: 'b'.repeat(40) },
    grant: copyGrant(grant, 'subagent'), ...extra,
  });
  const seeded = dispatches ? dispatches(dispatch) : [dispatch(D1)];
  const store = {
    version: 1, revision: 1, slug: SLUG,
    run: { dispatchRunId: 'p-000000000000', runKey: RUN_KEY, state: runState, spawnGrant: grant },
    dispatches: Object.fromEntries(seeded.map((d) => [d.dispatchId, d])),
    drivers: [], lease: null, spawnRequests: {}, steps: [],
  };
  const file = storeFileFor(root, SLUG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store));
  const ledger = path.join(state, 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks: {}, runs: { [RUN_KEY]: { control, epoch: 1 } } }));
  // An envelope already present, so "unchanged" covers a directory that holds files.
  const envDir = path.join(state, ENVELOPE_DIR);
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, `${D1}.handoff.json`), '{}');

  const worktree = seeded[0].attempt.worktree;
  const prompt = path.join(worktree, 'child-prompt.txt');
  fs.writeFileSync(prompt, 'look at a.js\n');
  const env = (extra = {}) => {
    const e = {
      DOFLOW_RUN_ID: IDENTITY.run, DOFLOW_LINEAGE_ID: IDENTITY.lineage, DOFLOW_ATTEMPT: IDENTITY.attempt,
      DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: worktree, HOME: root, ...extra,
    };
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    return e;
  };
  const spawn = (args = {}) => requestSpawn({ slug: SLUG, root, promptFile: prompt, reserveTokens: '100', env: env(), cwd: worktree, ...args });
  const read = () => readDispatch(file);
  const patch = (fn) => {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    fn(s);
    fs.writeFileSync(file, JSON.stringify(s));
  };
  /** The store's bytes and every envelope-directory file with its bytes. */
  const snapshot = () => ({
    store: fs.readFileSync(file).toString('base64'),
    envelopes: fs.readdirSync(envDir).sort().map((n) => [n, fs.readFileSync(path.join(envDir, n)).toString('base64')]),
  });
  /** Asserts the refusal reason and that nothing was written. */
  const refuses = (reason, args = {}) => {
    const before = snapshot();
    const r = spawn(args);
    assert.equal(r.disposition, 'refused', JSON.stringify(r));
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.deepEqual(snapshot(), before, `${reason}: store and envelope directory unchanged`);
    return r;
  };
  return { root, state, file, envDir, wt, worktree, prompt, env, spawn, read, patch, refuses, snapshot, dispatch };
}

test('IC-033 declaration: validateGrant bounds depth, children and tokens; copyGrant zeroes used', () => {
  assert.deepEqual(validateGrant('{"depth":1,"children":2,"tokens":500}', '500'), { depth: 1, children: 2, tokens: 500 });
  assert.deepEqual(validateGrant({ depth: 0, children: 0, tokens: 0 }, null), { depth: 0, children: 0, tokens: 0 });
  assert.deepEqual(validateGrant({ depth: 1, children: MAX_CHILDREN, tokens: 1 }, 1).children, 4);
  const bad = [
    ['{', 100], [[], 100], [{ depth: 2, children: 1, tokens: 1 }, 100], [{ depth: -1, children: 1, tokens: 1 }, 100],
    [{ depth: 1, children: 5, tokens: 1 }, 100], [{ depth: 1, children: 1.5, tokens: 1 }, 100],
    [{ depth: 1, children: 1, tokens: 101 }, 100], [{ depth: 1, children: 1, tokens: -1 }, 100],
    [{ depth: 1, children: 1, tokens: 1 }, null], [{ depth: 1, children: 1, tokens: 1, extra: 1 }, 100],
    [{ depth: 1, children: 1 }, 100], [{ depth: 1, children: 1, tokens: 1 }, 'x'],
  ];
  for (const [grant, reserve] of bad) {
    assert.throws(() => validateGrant(grant, reserve), (e) => e.code === 'usage', JSON.stringify([grant, reserve]));
  }
  const g = { depth: 1, children: 2, tokens: 10 };
  assert.deepEqual(copyGrant(g, 'subagent'), { depth: 1, children: 2, tokens: 10, used: { children: 0, tokens: 0 } });
  assert.equal(copyGrant(g, 'sequential'), null, 'a main-session dispatch has no grant (DEC-051)');
  assert.equal(copyGrant(null, 'subagent'), null);
});

test('IC-033 request: children 2 holds two concurrent requests, refuses a third, admits one after a child ends (DEC-062)', (t) => {
  const p = project(t);
  const a = p.spawn();
  assert.deepEqual(a, { disposition: 'spawn-requested', requestId: `${D1}.c1`, state: 'requested' });
  const b = p.spawn({ reserveTokens: 200 });
  assert.equal(b.requestId, `${D1}.c2`);
  const s = p.read();
  assert.deepEqual(s.dispatches[D1].grant.used, { children: 2, tokens: 300 });
  assert.deepEqual([s.spawnRequests[`${D1}.c1`].state, s.spawnRequests[`${D1}.c1`].granterDispatchId, s.spawnRequests[`${D1}.c2`].reserveTokens], ['requested', D1, 200]);
  const third = p.refuses('concurrency-exceeded');
  assert.equal(third.limit, 2);
  // The loop records the first child's end (C.3); the slot frees and the next id is c3.
  p.patch((st) => { st.spawnRequests[`${D1}.c1`].state = 'launched'; st.spawnRequests[`${D1}.c1`].endState = 'succeeded'; });
  assert.equal(p.spawn().requestId, `${D1}.c3`);
  // A refused launch also frees its slot.
  p.patch((st) => { st.spawnRequests[`${D1}.c2`].state = 'refused'; });
  assert.equal(p.spawn().requestId, `${D1}.c4`);
});

test('IC-033 request: children 1 refuses a second request with its limit', (t) => {
  const p = project(t, { grant: { depth: 1, children: 1, tokens: 1000 } });
  assert.equal(p.spawn().disposition, 'spawn-requested');
  assert.equal(p.refuses('concurrency-exceeded').limit, 1);
});

test('IC-033 request: tokens over the remainder are budget-exceeded with remaining', (t) => {
  const p = project(t, { grant: { depth: 1, children: 4, tokens: 250 } });
  assert.equal(p.spawn({ reserveTokens: 200 }).disposition, 'spawn-requested');
  assert.equal(p.refuses('budget-exceeded', { reserveTokens: 51 }).remaining, 50);
  assert.equal(p.spawn({ reserveTokens: 50 }).disposition, 'spawn-requested', 'exactly the remainder fits');
  assert.equal(p.refuses('budget-exceeded', { reserveTokens: 1 }).remaining, 0);
});

test('IC-033 request: the prompt is copied byte for byte with its sha256', (t) => {
  const p = project(t);
  const bytes = Buffer.concat([Buffer.from('line one\r\n\u00e9\t'), Buffer.from([0x00, 0xff, 0xfe, 0x80]), Buffer.from('\nno trailing')]);
  fs.writeFileSync(p.prompt, bytes);
  const r = p.spawn();
  fs.rmSync(p.prompt); // the worker may delete its own file
  const copy = fs.readFileSync(path.join(p.envDir, `${r.requestId}.prompt.txt`));
  assert.ok(copy.equals(bytes));
  const req = p.read().spawnRequests[r.requestId];
  assert.equal(req.promptSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(req.prompt, `${ENVELOPE_DIR}/${r.requestId}.prompt.txt`);
  assert.deepEqual(fs.readdirSync(p.envDir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
});

// RT-16: the prompt copy exists before the request record does, so the launch never reads a
// `requested` record whose prompt is missing; a copy that fails records nothing and spends nothing.
// The fs seam observes the envelope directory at the store's own rename, and then fails the copy.
test('RT-16: the prompt copy lands before the request record, and a failed copy spends no tokens', (t) => {
  const p = project(t);
  const copyAt = [];
  let failCopy = false;
  const fsImpl = {
    ...fs,
    renameSync: (from, to) => {
      if (to === p.file) copyAt.push(fs.readdirSync(p.envDir).filter((n) => n.endsWith('.prompt.txt')).sort());
      if (failCopy && to.endsWith('.prompt.txt')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return fs.renameSync(from, to);
    },
  };
  assert.equal(p.spawn({ fsImpl }).requestId, `${D1}.c1`);
  failCopy = true;
  assert.throws(() => p.spawn({ fsImpl }), { code: 'EIO' });
  const s = p.read();
  assert.deepEqual([copyAt[0], Object.keys(s.spawnRequests), s.dispatches[D1].grant.used.tokens, fs.readdirSync(p.envDir).filter((n) => n.endsWith('.tmp'))],
    [[`${D1}.c1.prompt.txt`], [`${D1}.c1`], 100, []]);
});

test('IC-033 request: an ungranted dispatch and a depth-0 grant are spawning-denied', (t) => {
  const p = project(t, { grant: null });
  assert.equal(p.read().dispatches[D1].grant, null);
  p.refuses('spawning-denied');
  const q = project(t, { grant: { depth: 0, children: 2, tokens: 100 } });
  q.refuses('spawning-denied');
});

test('IC-033 request: a child caller is depth-exceeded', (t) => {
  const p = project(t);
  const { requestId } = p.spawn();
  const childWt = p.wt(requestId);
  p.patch((st) => Object.assign(st.spawnRequests[requestId], {
    state: 'launched', childRunId: 'w-cccccccccccc', identity: { run: 'cccccccccccc', lineage: 'L1', attempt: '1' },
  }));
  fs.writeFileSync(path.join(childWt, 'p.txt'), 'grandchild');
  const r = p.refuses('depth-exceeded', {
    env: p.env({ DOFLOW_RUN_ID: 'cccccccccccc', DOFLOW_WORKTREE: childWt }), cwd: childWt, promptFile: path.join(childWt, 'p.txt'),
  });
  assert.deepEqual([r.limit, r.requestId], [1, requestId]);
});

test('IC-033 request: identity refusals — main session, incomplete identity, no run, no match, not launched', (t) => {
  const p = project(t);
  p.refuses('not-worker-session', { env: p.env({ DOFLOW_SESSION_ROLE: 'main' }) });
  p.refuses('not-worker-session', { env: p.env({ DOFLOW_SESSION_ROLE: undefined }) });
  p.refuses('identity-incomplete', { env: p.env({ DOFLOW_WORKTREE: undefined }) });
  p.refuses('identity-incomplete', { env: p.env({ DOFLOW_ATTEMPT: undefined }) });
  p.refuses('identity-incomplete', { env: p.env({ DOFLOW_RUN_ID: undefined }) });
  p.refuses('no-matching-dispatch', { env: p.env({ DOFLOW_LINEAGE_ID: 'L2' }) });
  p.refuses('no-matching-dispatch', { env: p.env({ DOFLOW_WORKTREE: p.root }) });
  p.patch((st) => { st.dispatches[D1].phase = 'collected'; });
  assert.equal(p.refuses('granter-not-running').phase, 'collected');
  p.patch((st) => { st.dispatches[D1].phase = 'ended'; });
  p.refuses('no-matching-dispatch');
  p.patch((st) => { st.run = null; });
  p.refuses('no-dispatch-run');
});

test('IC-033 request: two dispatches sharing run, lineage and attempt resolve by worktree; an unresolvable pair is identity-ambiguous', (t) => {
  const p = project(t, { dispatches: (d) => [d(D1), d(D2, { task: 'A.2' })] });
  const second = p.read().dispatches[D2].attempt.worktree;
  const promptFile = path.join(second, 'p.txt');
  fs.writeFileSync(promptFile, 'second');
  const r = p.spawn({ env: p.env({ DOFLOW_WORKTREE: second }), cwd: second, promptFile });
  assert.deepEqual(r, { disposition: 'spawn-requested', requestId: `${D2}.c1`, state: 'requested' }, 'matched by worktree');
  assert.deepEqual(p.read().dispatches[D1].grant.used, { children: 0, tokens: 0 });
  assert.equal(p.spawn().requestId, `${D1}.c1`);
  // Both record the same worktree: no way to tell them apart.
  const q = project(t, { dispatches: (d) => { const a = d(D1); return [a, d(D2, { task: 'A.2', attempt: { ...a.attempt } })]; } });
  assert.deepEqual(q.refuses('identity-ambiguous').dispatchIds, [D1, D2]);
});

test('IC-033 request: a paused 080 run is run-paused; a cancelled or cancelling run is run-cancelled', (t) => {
  project(t, { control: 'paused' }).refuses('run-paused');
  project(t, { control: 'cancelled' }).refuses('run-cancelled');
  project(t, { runState: 'cancelling' }).refuses('run-cancelled');
});

test('IC-033 request: bad flags and an unreadable prompt are usage, nothing written', (t) => {
  const p = project(t);
  const before = p.snapshot();
  for (const args of [{ reserveTokens: '-1' }, { reserveTokens: 'x' }, { promptFile: '' }, { promptFile: path.join(p.worktree, 'missing.txt') }, { slug: '../x' }]) {
    assert.throws(() => p.spawn(args), (e) => e.code === 'usage', JSON.stringify(args));
  }
  assert.deepEqual(p.snapshot(), before);
});

test('IC-033 status: reports the caller\'s own request; another dispatch\'s request is unknown-request', (t) => {
  const p = project(t, { dispatches: (d) => [d(D1), d(D2, { task: 'A.2' })] });
  const second = p.read().dispatches[D2].attempt.worktree;
  const promptFile = path.join(second, 'p.txt');
  fs.writeFileSync(promptFile, 'second');
  const theirs = p.spawn({ env: p.env({ DOFLOW_WORKTREE: second }), cwd: second, promptFile }).requestId;
  const mine = p.spawn().requestId;
  const status = (requestId, env = p.env()) => spawnStatus({ slug: SLUG, root: p.root, requestId, env, cwd: p.worktree });
  assert.deepEqual(status(mine), { disposition: 'spawn-status', requestId: mine, state: 'requested', childRunId: null, endState: null, report: null });
  p.patch((st) => Object.assign(st.spawnRequests[mine], { state: 'launched', childRunId: 'w-dddddddddddd', endState: 'succeeded', report: { status: 'success' } }));
  assert.deepEqual(status(mine), { disposition: 'spawn-status', requestId: mine, state: 'launched', childRunId: 'w-dddddddddddd', endState: 'succeeded', report: { status: 'success' } });
  assert.deepEqual(status(theirs), { disposition: 'refused', reason: 'unknown-request', requestId: theirs });
  assert.equal(status(`${D1}.c9`).reason, 'unknown-request');
  assert.equal(status(mine, p.env({ DOFLOW_SESSION_ROLE: 'main' })).reason, 'not-worker-session');
  assert.throws(() => status('nope'), (e) => e.code === 'usage');
});
