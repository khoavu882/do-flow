'use strict';

// Feature 082 D.4 (IC-040 leak scan, NFR-006; FR-006, FR-007; DEC-005, DEC-024, DEC-027, DEC-058):
// planted secrets never reach a dispatch record, envelope, step record, ledger line, evidence item,
// commit message or summary text.
//
// Two secrets sit in every caller environment: KNOWN (`sk-` plus 24 alphanumerics, a shape the mask
// knows) and UNSHAPED (no known shape). KNOWN is also planted in the prompt (a plan task's text,
// which becomes the handoff's `task.text`), in worker output and the worker's result summary and
// own commit message, in a test performer's submit summary, and in the verification argv, whose
// script also prints the environment's KNOWN. Two runs go through `executeDispatchCommand` in
// process: a sequential run (perform, submit, integrate, verify, then cancel with the second task
// awaiting its submit) and a subagent run on the claude fake (launch, collect, integrate, verify,
// then cancel with the second worker printing and sleeping). An inspect through the `doflow-run`
// dispatcher writes a run ledger line and prints the text summary.
//
// Obligations: no file under dispatch/, dispatch-envelopes/, worker-runs/, task-attempts/,
// evidence/ or runs/, no integration commit message and no summary text holds either secret, except
// that the dispatch run alone stores the verification argv (DEC-024, data-model `run.verify`);
// worker-output/ holds KNOWN only as `<masked>`. An fs write spy (081's worker-secrets.test.js
// approach; `srcFrame` reads file:// frames too) checks every in-process write from src/ as it
// happens, so a secret written and later removed is caught as well.
//
// No real harness runs (NFR-002): every child PATH is the scratch bin/ from
// test/helper/dispatch-sandbox.js (fake CLI links, node, git, and dirname and date for the
// dispatcher), never dirname(process.execPath) (DEC-056). The five DOFLOW_* identity variables are
// set, DOFLOW_ATTEMPT deleted where a worker is launched. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const REPO = path.join(__dirname, '..', '..');
const SRC_ROOT = `${path.join(REPO, 'src')}${path.sep}`;
const SRC = path.join(REPO, 'src', 'runtime');
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { executeDispatchCommand, summaryLines } = require(path.join(SRC, 'dispatch', 'command.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));

const CLI = path.join(REPO, 'bin', 'doflow.js');
const RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLUG = '082-dispatch-secrets';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
/** `sk-` plus 24 alphanumerics: a shape the mask knows (081 IC-030). */
const KNOWN = `sk-${crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'Q').slice(0, 24)}`;
/** A value of no known shape: lowercase words around a short number, nothing a mask rule reaches. */
const UNSHAPED = `plum-velvet-${crypto.randomInt(1000, 9999)}-orchard`;
const SECRETS = Object.freeze([KNOWN, UNSHAPED]);
/** The verification script: prints the environment's KNOWN, and its argv carries KNOWN too. */
const VERIFY = `console.log('verify ' + process.env.FAKE_API_KEY); process.exitCode = 0 // ${KNOWN}`;
/** disjoint.md with KNOWN planted in A.1's text, the prompt a handoff carries. */
const PLAN = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'dispatch', 'plans', 'disjoint.md'), 'utf8')
  .replace('Write module a —', `Write module a with key ${KNOWN} —`);
const SUCCESS = { type: 'result', status: 'success', summary: `edited with ${KNOWN}` };
const QUICK = { run: [{ print: `using key ${KNOWN}` }, { write: { path: 'src/a.js', content: '// a edited\n' } }, { commit: { message: `wip ${KNOWN}` } }, { emit: { type: 'usage', tokens: 7 } }, { emit: SUCCESS }] };
const SLEEPER = { run: [{ print: `waiting with ${KNOWN}` }, { sleep: 30000 }] };
const SCANNED = ['dispatch', 'dispatch-envelopes', 'worker-runs', 'task-attempts', 'evidence', 'runs'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ── The fs write spy (081 worker-secrets.test.js's frame reading) ────────────────────────────────

/** The innermost frame of this repository's `src/` in the current stack, as a repo-relative file. */
function srcFrame() {
  for (const line of new Error().stack.split('\n').slice(1)) {
    const match = /\(?(file:\/\/[^()]*?|(?:\/|[A-Za-z]:\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
    if (file.startsWith(SRC_ROOT)) return path.relative(REPO, file);
  }
  return null;
}

function textOf(data) {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

/** `text` with the dispatch run's stored verification argv removed, when `text` is a dispatch store. */
function withoutStoredArgv(text) {
  let value;
  try { value = JSON.parse(text); } catch { return text; }
  if (value && value.run && value.run.verify && Array.isArray(value.run.verify.argv)) value.run.verify.argv = '<stored argv>';
  return JSON.stringify(value);
}

const WRITES = ['writeFileSync', 'appendFileSync', 'writeSync', 'write', 'writeFile', 'appendFile'];
const PROMISE_WRITES = ['writeFile', 'appendFile'];

/** Wraps every write call of `node:fs` and `node:fs/promises`; records each one from src/ whose data holds a secret. */
function spyWrites() {
  const hits = [];
  let writes = 0;
  const undo = [];
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const wrap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const wrapped = function spied(...args) {
      const text = textOf(args[1]);
      const from = text === null ? null : srcFrame();
      if (from) {
        writes += 1;
        const checked = withoutStoredArgv(text);
        for (const secret of SECRETS) if (checked.includes(secret)) hits.push({ op: label, target: typeof args[0] === 'number' ? `fd ${args[0]}` : String(args[0]), from, secret: secret === KNOWN ? 'KNOWN' : 'UNSHAPED' });
      }
      return original.apply(this, args);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    owner[name] = wrapped;
    undo.push(() => { owner[name] = original; });
  };
  for (const name of WRITES) wrap(fs, name, name);
  for (const name of PROMISE_WRITES) wrap(fs.promises, name, `promises.${name}`);
  return {
    hits,
    writes: () => writes,
    restore() {
      for (const step of undo.reverse()) step();
      Error.stackTraceLimit = limit;
    },
  };
}

// ── Sandboxes and scans ───────────────────────────────────────────────────────────────────────────

/** Every regular file under `dir`, recursively; [] when it does not exist. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A sandbox with both secrets in its environment and a dispatch run started through the command. */
async function project(t, { mode, scenario = {}, identity = {}, probe = false }) {
  // Registered before the sandbox, so it runs before the sandbox is removed: every 081 run still
  // alive is ended through 081.
  const live = {};
  t.after(async () => {
    if (!live.runStore || !fs.existsSync(live.runStore)) return;
    for (const run of Object.values(readRuns(live.runStore))) {
      if (run.phase === 'ended') continue;
      try { await cancelRun({ file: live.runStore, runId: run.runId, by: 'test', reason: 'test cleanup', env: live.env, cwd: live.root }); } catch { /* reported by the run */ }
    }
  });
  const sb = makeDispatchSandbox(t, { plan: PLAN, slug: SLUG, scenario, identity, verify: VERIFY, systemTools: ['dirname', 'date'] });
  const env = { ...sb.env, FAKE_API_KEY: KNOWN, UNSHAPED_SECRET: UNSHAPED };
  Object.assign(live, { runStore: runStoreFileFor(sb.root, SLUG), env, root: sb.root });
  assert.ok(sb.verifyArgv.join(' ').includes(KNOWN), 'the verification argv carries KNOWN');
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: sb.root })).disposition, 'probed');
  const bodies = [];
  const command = async (extra) => {
    const { exit, body } = await executeDispatchCommand({ slug: SLUG, env, cwd: sb.root, descriptors: sb.descriptors, ...extra });
    bodies.push(body);
    return { exit, body };
  };
  const config = path.join(sb.dir, 'config');
  /** The command through the `doflow-run` dispatcher, which appends a run ledger line. */
  const dispatcher = (...args) => spawnSync('/bin/bash', [RUN, 'dispatch', ...args], {
    cwd: sb.root, env: { ...env, DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: config }, encoding: 'utf8',
  });
  const started = await command({
    action: 'start', by: 'main', mode, concurrency: '1', verifyArgv: JSON.stringify(sb.verifyArgv),
  });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  return {
    sb, env, command, dispatcher, bodies, config,
    state: path.join(sb.root, '.doflow', 'state'),
    read: () => store.readDispatch(store.storeFileFor(sb.root, SLUG)),
    step: () => command({ action: 'step', by: 'main' }),
    cancel: () => command({ action: 'cancel', by: 'main', reason: 'stop the run' }),
    runs: () => readRuns(runStoreFileFor(sb.root, SLUG)),
  };
}

/** Sequential: A.1 performed and submitted with KNOWN in its summary, integrated and verified; cancel with A.2 awaiting. */
async function sequentialFlow(t) {
  const p = await project(t, { mode: 'sequential' });
  const first = await p.step();
  assert.equal(first.body.outcome, 'perform', JSON.stringify(first.body));
  const y = first.body.perform;
  assert.equal(y.task, 'A.1');
  fs.writeFileSync(path.join(y.worktree, 'src', 'a.js'), '// a done\n');
  const submitted = await p.command({ action: 'submit', dispatch: y.dispatchId, status: 'success', summary: `finished with ${KNOWN} as asked` });
  assert.equal(submitted.body.disposition, 'submitted', JSON.stringify(submitted.body));
  const second = await p.step();
  assert.ok(second.body.actions.some((a) => a.action === 'integrate' && a.reason === 'completed'), JSON.stringify(second.body.actions));
  assert.ok(second.body.actions.some((a) => a.action === 'verify' && /^passed/.test(a.reason)), JSON.stringify(second.body.actions));
  assert.equal(second.body.perform.task, 'A.2', JSON.stringify(second.body));
  const cancelled = await p.cancel();
  assert.equal(cancelled.body.disposition, 'cancelled', JSON.stringify(cancelled.body));
  return { p, resultEnvelope: submitted.body.result.path };
}

/** Subagent: A.1's fake prints, commits and reports KNOWN; it is collected, integrated and verified; A.2's fake prints and sleeps; cancel. */
async function subagentFlow(t) {
  const p = await project(t, { mode: 'auto', scenario: QUICK, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  assert.equal(Object.hasOwn(p.env, 'DOFLOW_ATTEMPT'), false);
  const first = await p.step();
  const a1 = Object.values(p.read().dispatches).find((d) => d.task === 'A.1');
  assert.deepEqual([a1 && a1.mode, a1 && a1.phase], ['subagent', 'launched'], JSON.stringify(first.body.actions));
  await until(() => { const r = p.runs()[a1.workerRunId]; return r && r.phase === 'ended'; }, 'A.1 worker run to end');
  // A.2 is admitted by the pass that integrates A.1, so its worker gets the sleeper.
  p.sb.setScenario(SLEEPER);
  let integrated = null;
  await until(async () => {
    const r = await p.step();
    integrated = r.body;
    const d = p.read().dispatches[a1.dispatchId];
    return d.disposition === 'completed';
  }, 'A.1 to integrate');
  assert.ok(integrated.actions.some((a) => a.action === 'verify' && /^passed/.test(a.reason)), JSON.stringify(integrated.actions));
  const a2 = await until(() => Object.values(p.read().dispatches).find((d) => d.task === 'A.2' && d.phase === 'launched'), 'A.2 to launch');
  const out = path.join(p.state, 'worker-output', `${a2.workerRunId}.out.log`);
  await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('waiting with'), 'A.2 worker to print');
  const cancelled = await p.cancel();
  assert.equal(cancelled.body.disposition, 'cancelled', JSON.stringify(cancelled.body));
  assert.equal(p.runs()[a2.workerRunId].phase, 'ended');
  return { p, a1, a2 };
}

/** Every leak obligation over one run's files, commits and texts; `dispatched` is the dispatcher's
 * output. A sequential run launches no worker, so it writes no worker-runs/ file. */
function assertNoLeak(p, dispatched, { workers }) {
  const scanned = Object.fromEntries(SCANNED.map((dir) => [dir, [
    ...filesUnder(path.join(p.state, dir)),
    ...filesUnder(path.join(p.config, 'state', dir)),
  ]]));
  for (const dir of SCANNED) assert.equal(scanned[dir].length > 0, dir !== 'worker-runs' || workers, `${dir}/ written (positive control)`);
  for (const [dir, files] of Object.entries(scanned)) {
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const text = dir === 'dispatch' ? withoutStoredArgv(raw) : raw;
      for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${file} holds ${secret === KNOWN ? 'KNOWN' : 'UNSHAPED'}`);
    }
  }
  // The dispatch run stores the argv, and nothing else in its store holds KNOWN (DEC-024).
  const storeText = fs.readFileSync(store.storeFileFor(p.sb.root, SLUG), 'utf8');
  assert.ok(storeText.includes(KNOWN), 'the dispatch run stores its verification argv (positive control)');
  assert.deepEqual(p.read().run.verify.argv, p.sb.verifyArgv);

  const output = filesUnder(path.join(p.state, 'worker-output'));
  assert.ok(output.length > 0, 'worker-output/ was written');
  for (const file of output) {
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${file} holds ${secret === KNOWN ? 'KNOWN' : 'UNSHAPED'}`);
  }
  assert.ok(output.some((file) => /verify <masked>/.test(fs.readFileSync(file, 'utf8'))), 'the verification printed KNOWN, masked');

  const s = p.read();
  const messages = git(s.run.integration.worktree, p.env, ['log', '--format=%B', s.run.integration.branch]);
  assert.match(messages, /dispatch d-[0-9a-f]{12}/, 'an integration commit was made');
  for (const secret of SECRETS) assert.equal(messages.includes(secret), false, 'an integration commit message holds a secret');

  const texts = [...p.bodies.flatMap((body) => summaryLines(body)), dispatched.text.stdout, dispatched.text.stderr, dispatched.json.stdout, dispatched.json.stderr];
  for (const text of texts) for (const secret of SECRETS) assert.equal(text.includes(secret), false, `summary text holds a secret: ${text}`);
  assert.match(dispatched.json.stdout, /<masked>/, 'inspect masks the argv element holding KNOWN');
}

/** Inspect through the dispatcher, in text and JSON. */
function inspectBoth(p) {
  const text = p.dispatcher('--action', 'inspect', '--slug', SLUG);
  const json = p.dispatcher('--action', 'inspect', '--slug', SLUG, '--json');
  assert.equal(text.status, 0, text.stderr);
  assert.equal(json.status, 0, json.stderr);
  return { text, json };
}

test('IC-040: planted secrets reach no record, envelope, ledger line, evidence item, commit message or summary; worker output holds KNOWN only masked', POSIX, async (t) => {
  const started = Date.now();
  const spy = spyWrites();
  let seq;
  let sub;
  try {
    seq = await sequentialFlow(t);
    sub = await subagentFlow(t);
  } finally {
    spy.restore();
  }
  const dispatched = { seq: inspectBoth(seq.p), sub: inspectBoth(sub.p) };
  t.diagnostic(`leak scan flows completed in ${Date.now() - started} ms`);

  await t.test('no in-process write from src/ carries a secret', () => {
    assert.ok(spy.writes() > 0, 'the spy saw writes from src/ (positive control)');
    assert.deepEqual(spy.hits, []);
  });

  await t.test('the sequential run: handoff and result envelopes masked, nothing else holds a secret', () => {
    const { p, resultEnvelope } = seq;
    const result = JSON.parse(fs.readFileSync(resultEnvelope, 'utf8'));
    assert.equal(result.summary, 'finished with <masked> as asked');
    const a1 = Object.values(p.read().dispatches).find((d) => d.task === 'A.1');
    const handoff = JSON.parse(fs.readFileSync(path.join(p.state, a1.envelopes.handoff), 'utf8'));
    assert.match(handoff.task.text, /with key <masked>/);
    assertNoLeak(p, dispatched.seq, { workers: false });
  });

  await t.test('the subagent run: worker output, result summary and commit squashed, nothing holds a secret', () => {
    const { p, a1, a2 } = sub;
    const d1 = p.read().dispatches[a1.dispatchId];
    const result = JSON.parse(fs.readFileSync(path.join(p.state, d1.envelopes.result), 'utf8'));
    assert.match(result.summary, /edited with <masked>/);
    for (const id of [a1.workerRunId, a2.workerRunId]) {
      const out = fs.readFileSync(path.join(p.state, 'worker-output', `${id}.out.log`), 'utf8');
      assert.match(out, /(using key|waiting with) <masked>/, id);
    }
    assertNoLeak(p, dispatched.sub, { workers: true });
  });
});
