'use strict';

// Feature 088 C.2 (IC-011; FR-005, NFR-006, NFR-010; DD-5): `trace spans` projects spans offline
// from the records that already exist: the run ledger, telemetry lines, the 080 task-run records,
// orchestration records and worker runs. A trace is one (runKey, epoch segment) of an 080 run. An
// identity-bearing record joins exactly one trace or is a gap named by its locator; the projection
// reads files only and its output is the same bytes on every run.
//
// In-process against seeded stores in temp projects with an empty environment, so the parent's
// DOFLOW_* never reaches the resolver; the CLI cases spawn `bin/doflow.js` with HOME in the temp dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { projectSpans, handleTraceSpans } = require('../../src/runtime/trace/spans.ts');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const SPANS_FILE = path.join(REPO, 'src', 'runtime', 'trace', 'spans.ts');

const ID1 = '11111111111111111111111111111111';
const ID2 = '22222222222222222222222222222222';
const ID3 = '33333333333333333333333333333333';
const KEY = 'aaaa1111/r1/l1';
const DAY = '2026-09-01';
const at = (hms) => `${DAY}T${hms}.000Z`;
const VERIFY_ID = '0123456789abcdef';
const LEDGER = `runs/${DAY}.jsonl`;
const TELEMETRY = `runs/telemetry/${DAY}.jsonl`;

/** One 080 run: started 10:00 (ID1), paused 10:30, resumed 11:00 (ID2 linked to ID1). */
function run080(runKey = KEY, { start = ID1, resume = ID2 } = {}) {
  const [, run, lineage] = runKey.split('/');
  const history = [
    { at: at('10:00:00'), action: 'start', by: 'orchestrator', reason: null, epoch: 1, ...(start ? { traceId: start } : {}) },
    { at: at('10:30:00'), action: 'pause', by: 'orchestrator', reason: 'a free-text reason' },
  ];
  if (resume !== null) {
    history.push({ at: at('11:00:00'), action: 'resume', by: 'orchestrator', reason: null, digest: 'sha256:00', epoch: 2, cleared: [],
      ...(resume ? { traceId: resume, traceLink: start || null } : {}) });
  }
  return { runKey, worktreeKey: runKey.split('/')[0], run, lineage, worktree: '/w', createdAt: at('10:00:00'),
    control: 'running', epoch: resume === null ? 1 : 2, ...(resume || start ? { traceId: resume || start } : {}), history };
}

function attempts(runKey = KEY) {
  return {
    'A.1': { nextToken: 3, attempts: [
      { token: 1, owner: 'core-implementer', mode: 'manual', startedAt: at('10:05:00'), finishedAt: at('10:20:00'), state: 'finished', result: 'COMPLETED', runKey, epoch: 1 },
      { token: 2, owner: 'core-implementer', mode: 'manual', startedAt: at('11:05:00'), state: 'active', result: null, runKey, epoch: 2 },
    ] },
  };
}

const LEDGER_LINES = [
  { timestamp: at('10:10:00'), verb: 'verify', outcome: 'ok', duration_ms: 500, run: 'r1', lineage: 'l1', attempt: '1' }, // 1: trace 1, attempt 1
  { timestamp: at('11:00:00'), verb: 'route', run: 'r1', lineage: 'l1' }, // 2: exactly on the resume edge -> trace 2
  { timestamp: '2026-09-01T10:59:59.999Z', verb: 'route', run: 'r1', lineage: 'l1' }, // 3: just before the edge -> trace 1
  '{"timestamp":"2026-09-01T10:00:00Z","verb":', // 4: torn line
  { timestamp: at('10:15:00'), verb: 'route', run: 'zz', lineage: 'l1' }, // 5: no such run
  { timestamp: at('10:16:00'), verb: 'stats', session: 's1' }, // 6: no identity, a session
  { timestamp: '2026-08-31T23:00:00Z', verb: 'stats' }, // 7: no identity, no session
  { timestamp: at('09:00:00'), verb: 'route', run: 'r1', lineage: 'l1' }, // 8: before the run started
];

const TELEMETRY_LINES = [
  { timestamp: at('11:10:00'), kind: 'hook', run: 'r1', lineage: 'l1', attempt: 2, harness: 'claude', event: 'PreToolUse', policy: 'pre-bash-guard', verdict: 'allow', duration_ms: null, session: 's1', tool: 'Bash', tool_call_id: 'tc1' }, // 1
  { timestamp: at('11:20:00'), kind: 'verify.run', run: 'r1', lineage: 'l1', attempt: 2, verify_id: VERIFY_ID, source: 'verb', task: 'A.1', risk: 'LOW', status: 'FAIL' }, // 2
  { timestamp: at('11:20:01'), kind: 'verify.check', run: 'r1', lineage: 'l1', attempt: 2, verify_id: VERIFY_ID, tier: 'targeted-tests', status: 'FAIL' }, // 3
  { kind: 'bogus', timestamp: at('11:21:00') }, // 4: not a telemetry kind
  { timestamp: at('11:12:00'), kind: 'hook', run: 'r1', lineage: 'l1', attempt: 2, harness: 'claude', event: 'PostToolUse', policy: 'post-shell-observe', verdict: 'observe', duration_ms: null, session: 's1', tool: 'Bash', tool_call_id: 'tc1' }, // 5: pairs with 1
];

function seed(t, { extraStores = {}, ledger = LEDGER_LINES, telemetry = TELEMETRY_LINES, workers = true, orchestration = true } = {}) {
  const dir = tempDir(t, 'doflow-trace-spans-');
  const state = path.join(dir, '.doflow', 'state');
  const write = (rel, body) => {
    const file = path.join(state, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const lines = (list) => `${list.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`;
  write(LEDGER, lines(ledger));
  write(TELEMETRY, lines(telemetry));
  write('task-attempts/feat.json', JSON.stringify({ version: 1, revision: 4, runs: { [KEY]: run080() }, tasks: attempts() }, null, 2));
  for (const [rel, body] of Object.entries(extraStores)) write(rel, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (workers) {
    write('worker-runs/feat.json', JSON.stringify({ version: 1, revision: 2, slug: 'feat', runs: {
      'w-0123456789ab': { runId: 'w-0123456789ab', task: 'A.1', token: 2, harness: 'codex', phase: 'ended', seq: 3,
        createdAt: at('11:06:00'), startedAt: at('11:06:01'), end: { state: 'exited', at: at('11:30:00') },
        caller: { cwd: '/w', runKey: KEY, run: 'r1', lineage: 'l1', attempt: null, role: 'main', lineageKind: 'session' },
        identity: { run: 'r1', lineage: 'l1', attempt: '2', runSource: 'claim' } },
      'w-ffffffffffff': { runId: 'w-ffffffffffff', task: 'B.1', token: 1, harness: 'codex', phase: 'ended', seq: 1,
        createdAt: at('11:06:00'), caller: { runKey: 'cccc/r9/l9', run: 'r9', lineage: 'l9' } },
    } }, null, 2));
  }
  if (orchestration) {
    write('orchestration/F-1.json', JSON.stringify({ version: 1, revision: 3, taskId: 'F-1', taskClass: 'feature', runKey: KEY, startedAt: at('10:01:00'),
      history: [
        { at: at('10:01:00'), action: 'start', detail: 'task-class=feature' },
        { at: at('10:40:00'), action: 'complete-stage', node: 'design', note: 'a free-text note', outcome: 'verified' },
        { at: at('11:15:00'), action: 'complete-stage', node: 'plan', note: null, outcome: 'verified' },
      ] }, null, 2));
  }
  return { dir, state };
}

const view = (dir, opts = {}) => projectSpans({ projectRoot: dir, env: {}, ...opts });
const traceOf = (v, traceId) => v.traces.find((tr) => tr.traceId === traceId);
const allSpans = (v) => [...v.traces.flatMap((tr) => tr.spans), ...v.ungrouped.flatMap((g) => g.spans)];
const where = (v, locator) => {
  const places = [];
  for (const tr of v.traces) for (const s of tr.spans) if (s.locator === locator) places.push(`trace:${tr.traceId}`);
  for (const g of v.ungrouped) for (const s of g.spans) if (s.locator === locator) places.push(`ungrouped:${g.group}`);
  for (const gap of v.gaps) if (gap.locator === locator) places.push(`gap:${gap.reason}`);
  return places;
};

/** stdout of the handler, captured in process. */
function captured(fn) {
  const out = [];
  const real = console.log;
  const code = process.exitCode;
  console.log = (...args) => { out.push(args.join(' ')); };
  try { return { code: fn(), stdout: out.join('\n') }; } finally { console.log = real; process.exitCode = code; }
}

// ── traces, joins and gaps ──────────────────────────────────────────────────────────────────────

test('two epochs make two traces; the resume trace links the start trace; windows are half-open', (t) => {
  const v = view(seed(t).dir);
  assert.equal(v.v, 1);
  assert.deepEqual(v.traces.map((tr) => tr.traceId), [ID1, ID2]);
  const [first, second] = v.traces;
  assert.deepEqual({ ...first, spans: undefined }, { traceId: ID1, traceLink: null, runKey: KEY, epoch: 1, window: { from: at('10:00:00'), to: at('11:00:00') }, spans: undefined });
  assert.deepEqual({ ...second, spans: undefined }, { traceId: ID2, traceLink: ID1, runKey: KEY, epoch: 2, window: { from: at('11:00:00'), to: null }, spans: undefined });
});

test('every identity-bearing record joins exactly one trace or is one located gap', (t) => {
  const v = view(seed(t).dir);
  const expected = {
    [`${LEDGER}:1`]: `trace:${ID1}`,
    [`${LEDGER}:2`]: `trace:${ID2}`,
    [`${LEDGER}:3`]: `trace:${ID1}`,
    [`${LEDGER}:5`]: 'gap:unmatched',
    [`${LEDGER}:8`]: 'gap:unmatched',
    [`${TELEMETRY}:1`]: `trace:${ID2}`,
    [`${TELEMETRY}:2`]: `trace:${ID2}`,
    [`${TELEMETRY}:3`]: `trace:${ID2}`,
    [`${TELEMETRY}:5`]: `trace:${ID2}`,
    [`task-attempts/feat.json#${KEY}/A.1/1`]: `trace:${ID1}`,
    [`task-attempts/feat.json#${KEY}/A.1/2`]: `trace:${ID2}`,
    [`task-attempts/feat.json#${KEY}/0`]: `trace:${ID1}`,
    [`task-attempts/feat.json#${KEY}/1`]: `trace:${ID1}`,
    [`task-attempts/feat.json#${KEY}/2`]: `trace:${ID2}`,
    'worker-runs/feat.json#w-0123456789ab': `trace:${ID2}`,
    'worker-runs/feat.json#w-ffffffffffff': 'gap:unmatched',
    [`orchestration/F-1.json#${KEY}/0`]: `trace:${ID1}`,
    [`orchestration/F-1.json#${KEY}/1`]: `trace:${ID1}`,
    [`orchestration/F-1.json#${KEY}/2`]: `trace:${ID2}`,
  };
  for (const [locator, place] of Object.entries(expected)) assert.deepEqual(where(v, locator), [place], locator);
  // Nothing is joined that the table does not name, and nothing is listed twice.
  const located = [...allSpans(v).map((s) => s.locator), ...v.gaps.map((g) => g.locator)];
  assert.equal(new Set(located).size, located.length, 'a record is projected once');
});

test('a line exactly at a resume boundary falls in the new segment, one just before it in the old', (t) => {
  const v = view(seed(t).dir);
  assert.deepEqual(where(v, `${LEDGER}:2`), [`trace:${ID2}`]);
  assert.deepEqual(where(v, `${LEDGER}:3`), [`trace:${ID1}`]);
});

test('attempt as a telemetry number and as a ledger string both parent to the attempt span', (t) => {
  const v = view(seed(t).dir);
  const span = (tr, locator) => traceOf(v, tr).spans.find((s) => s.locator === locator);
  const attempt1 = span(ID1, `task-attempts/feat.json#${KEY}/A.1/1`);
  const attempt2 = span(ID2, `task-attempts/feat.json#${KEY}/A.1/2`);
  assert.equal(span(ID1, `${LEDGER}:1`).parentSpanId, attempt1.spanId, 'ledger attempt "1" (string)');
  assert.equal(span(ID2, `${TELEMETRY}:1`).parentSpanId, attempt2.spanId, 'telemetry attempt 2 (number)');
  assert.equal(span(ID2, 'worker-runs/feat.json#w-0123456789ab').parentSpanId, attempt2.spanId, 'worker run by task and token');
  // Negative control: a number that is not a token of this trace parents to the root, not an attempt.
  const root = traceOf(v, ID1).spans.find((s) => s.kind === 'run');
  assert.equal(span(ID1, `${LEDGER}:3`).parentSpanId, root.spanId);
});

test('verify tiers and checks parent to their verify run; pre and post hook lines pair into a test span', (t) => {
  const v = view(seed(t).dir);
  const spans = traceOf(v, ID2).spans;
  const run = spans.find((s) => s.locator === `${TELEMETRY}:2`);
  const check = spans.find((s) => s.locator === `${TELEMETRY}:3`);
  assert.equal(run.kind, 'verify.run');
  assert.equal(check.parentSpanId, run.spanId);
  const test1 = spans.find((s) => s.locator === `${TELEMETRY}:5`);
  assert.equal(test1.kind, 'test');
  assert.equal(test1.start, at('11:10:00'));
  assert.equal(test1.end, at('11:12:00'));
  assert.equal(test1.durationMs, 120000);
  assert.equal(test1.basis, 'derived');
});

test('stage spans start at the previous complete-stage (or the run start) and are labelled derived', (t) => {
  const v = view(seed(t).dir);
  const design = traceOf(v, ID1).spans.find((s) => s.locator === `orchestration/F-1.json#${KEY}/1`);
  const plan = traceOf(v, ID2).spans.find((s) => s.locator === `orchestration/F-1.json#${KEY}/2`);
  assert.deepEqual([design.kind, design.name, design.start, design.end, design.basis], ['stage', 'design', at('10:01:00'), at('10:40:00'), 'derived']);
  assert.deepEqual([plan.start, plan.end, plan.durationMs], [at('10:40:00'), at('11:15:00'), 35 * 60000]);
});

test('negative control: a line whose (run, lineage) matches two runs is ambiguous, never joined', (t) => {
  // Two worktrees, one session identity: the same (run, lineage) under two run keys.
  const other = 'bbbb2222/r1/l1';
  const { dir } = seed(t, { extraStores: { 'task-attempts/other.json': { runs: { [other]: run080(other, { start: ID3, resume: null }) }, tasks: {} } } });
  const v = view(dir);
  for (const n of [1, 3]) assert.deepEqual(where(v, `${LEDGER}:${n}`), ['gap:ambiguous'], `line ${n} overlaps both runs`);
  // The other run's segment is still open at 11:00, so the edge line is ambiguous too.
  assert.deepEqual(where(v, `${LEDGER}:2`), ['gap:ambiguous']);
  const gap = v.gaps.find((g) => g.locator === `${LEDGER}:1`);
  assert.deepEqual(gap, { locator: `${LEDGER}:1`, reason: 'ambiguous', kind: 'ledger' });
});

test('a malformed line or store file is an unparseable gap, counted and located', (t) => {
  const { dir } = seed(t, { extraStores: { 'task-attempts/broken.json': '{"runs": {', 'orchestration/bad.json': '[1,' } });
  const v = view(dir);
  const unparseable = v.gaps.filter((g) => g.reason === 'unparseable').map((g) => g.locator).sort();
  assert.deepEqual(unparseable, ['orchestration/bad.json', `${LEDGER}:4`, `${TELEMETRY}:4`, 'task-attempts/broken.json']);
});

test('records with no identity are grouped by session, else by UTC day, labelled ungrouped', (t) => {
  const v = view(seed(t).dir);
  assert.deepEqual(where(v, `${LEDGER}:6`), ['ungrouped:session:s1']);
  assert.deepEqual(where(v, `${LEDGER}:7`), ['ungrouped:day:2026-08-31']);
  for (const g of v.ungrouped) assert.equal(g.label, 'ungrouped');
});

test('a pre-088 run (no trace id) yields an ungrouped group, not a gap or an error', (t) => {
  const old = 'dddd4444/r5/l5';
  const { dir } = seed(t, {
    ledger: [{ timestamp: at('10:10:00'), verb: 'route', run: 'r5', lineage: 'l5', session: 's5' }],
    telemetry: [],
    workers: false,
    orchestration: false,
    extraStores: { 'task-attempts/old.json': { runs: { [old]: run080(old, { start: null, resume: null }) }, tasks: {} } },
  });
  const v = view(dir);
  assert.deepEqual(where(v, `${LEDGER}:1`), ['ungrouped:session:s5']);
  assert.equal(v.gaps.filter((g) => g.locator.startsWith(LEDGER)).length, 0);
});

test('span ids are the first 16 hex of sha256(traceId + locator)', (t) => {
  const v = view(seed(t).dir);
  const span = traceOf(v, ID1).spans.find((s) => s.locator === `${LEDGER}:1`);
  assert.equal(span.spanId, crypto.createHash('sha256').update(ID1 + `${LEDGER}:1`).digest('hex').slice(0, 16));
  const loose = v.ungrouped.find((g) => g.group === 'session:s1').spans[0];
  assert.equal(loose.spanId, crypto.createHash('sha256').update('session:s1' + loose.locator).digest('hex').slice(0, 16));
});

test('attrs carry allowlisted identifiers only: no free text, no paths', (t) => {
  const { dir } = seed(t, { ledger: [{ timestamp: at('10:10:00'), verb: 'route', run: 'r1', lineage: 'l1', outcome: 'has a space /etc/x' }] });
  const text = JSON.stringify(view(dir));
  for (const leak of ['a free-text reason', 'a free-text note', '/etc/x', '"/w"', 'core-implementer']) assert.equal(text.includes(leak), false, leak);
});

test('--run keeps the traces of that run key, else of that run id', (t) => {
  const { dir } = seed(t);
  assert.deepEqual(view(dir, { run: KEY }).traces.map((tr) => tr.traceId), [ID1, ID2]);
  assert.deepEqual(view(dir, { run: 'r1' }).traces.map((tr) => tr.traceId), [ID1, ID2]);
  const none = view(dir, { run: 'nope' });
  assert.deepEqual(none.traces, []);
  assert.deepEqual(none.ungrouped, []);
  // The run's own unmatched lines stay listed; another run's do not.
  const kept = view(dir, { run: 'r1' }).gaps.map((g) => g.locator);
  assert.ok(kept.includes(`${LEDGER}:8`));
  assert.equal(kept.includes(`${LEDGER}:5`), false);
});

test('real 080 start and resume records project to two linked traces', (t) => {
  const { start, resume } = require('../../src/runtime/task-attempts.ts');
  const { runKeyFor } = require('../../src/runtime/task-run.ts');
  const dir = tempDir(t, 'doflow-trace-spans-real-');
  fs.mkdirSync(path.join(dir, '.git'));
  const plan = path.join(dir, 'agent-docs', 'doflow', 'feat-s', 'plan.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# Plan\n\n**Task graph:** v1\n\n## Tasks\n\n### Phase A\n\n- [ ] A.1 first; owner: core-implementer; files: a.js\n');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  const env = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: dir, HOME: dir };
  const common = (now) => ({ file: path.join(dir, '.doflow', 'state', 'task-attempts', 'feat-s.json'), fsImpl: fs, roots: [dir], slug: 'feat-s', now, env, cwd: dir });
  const git = (args) => (args[0] === 'symbolic-ref' ? 'feat/088\n' : null);
  assert.equal(start({ ...common(new Date(at('10:00:00'))), by: 'orchestrator' }).disposition, 'started');
  const asked = resume({ ...common(new Date(at('11:00:00'))), gitRunner: git });
  assert.equal(resume({ ...common(new Date(at('11:00:00'))), ack: asked.digest, by: 'orchestrator', gitRunner: git }).disposition, 'resumed');
  fs.mkdirSync(path.join(dir, '.doflow', 'state', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', LEDGER), `${JSON.stringify({ timestamp: at('11:30:00'), verb: 'route', run: 'r1', lineage: 'main' })}\n`);
  const v = view(dir);
  assert.equal(v.traces.length, 2);
  assert.equal(v.traces[1].traceLink, v.traces[0].traceId);
  assert.equal(v.traces[0].runKey, runKeyFor(env, dir).runKey);
  assert.deepEqual(where(v, `${LEDGER}:1`), [`trace:${v.traces[1].traceId}`]);
  assert.deepEqual(v.gaps, []);
});

// ── determinism, read-only, CLI ─────────────────────────────────────────────────────────────────

test('output is byte-identical on two runs, keys sorted, with no wall-clock field', (t) => {
  const { dir } = seed(t);
  const one = captured(() => handleTraceSpans({ positional: [dir], json: true, env: {} }));
  const two = captured(() => handleTraceSpans({ positional: [dir], json: true, env: {} }));
  assert.equal(one.code, 0);
  assert.equal(one.stdout, two.stdout);
  const sortedKeys = (value) => (Array.isArray(value) ? value.map(sortedKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortedKeys(value[k])])) : value);
  assert.equal(one.stdout, JSON.stringify(sortedKeys(JSON.parse(one.stdout)), null, 2));
  assert.equal(one.stdout.includes(new Date().toISOString().slice(0, 10)), false, 'no field carries today');
  const text = captured(() => handleTraceSpans({ positional: [dir], env: {} }));
  assert.equal(text.code, 0);
  assert.match(text.stdout, new RegExp(`^trace ${ID1} `, 'm'));
  assert.match(text.stdout, /^gaps: 5 \(unmatched 3, ambiguous 0, unparseable 2\)$/m);
});

test('the verb never writes: no fs write call and no file or mtime change', (t) => {
  const { dir } = seed(t);
  const snapshot = () => {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const st = fs.statSync(full);
        out.push(`${path.relative(dir, full)} ${st.mtimeMs} ${st.size}`);
        if (e.isDirectory()) walk(full);
      }
    }(dir));
    return out.sort();
  };
  const WRITES = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'openSync', 'writeSync', 'copyFileSync', 'symlinkSync', 'linkSync', 'chmodSync', 'utimesSync', 'truncateSync', 'rmdirSync', 'mkdtempSync'];
  const calls = [];
  const spy = new Proxy(fs, { get(target, name) {
    if (name === 'openSync') {
      // A read-only open (spans opens store files O_RDONLY) is a read; any other flag is a write.
      return (...args) => { if (typeof args[1] !== 'number' || (args[1] & fs.constants.O_ACCMODE) !== fs.constants.O_RDONLY) calls.push(name); return target.openSync(...args); };
    }
    if (WRITES.includes(name)) return (...args) => { calls.push(name); return target[name](...args); };
    return target[name];
  } });
  // Self-test of the spy: a write through it is seen.
  spy.utimesSync(dir, new Date(), new Date());
  assert.deepEqual(calls.splice(0), ['utimesSync']);
  const before = snapshot();
  captured(() => handleTraceSpans({ positional: [dir], json: true, env: {}, fsImpl: spy }));
  captured(() => handleTraceSpans({ positional: [dir], env: {}, fsImpl: spy }));
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(), before);
});

function cli(t, args, cwd) {
  const home = tempDir(t, 'doflow-trace-spans-home-');
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8',
    env: { HOME: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', FORCE_COLOR: '0' } });
}

test('CLI: `trace spans --run <key> --json <project>` answers with the in-process view; usage exits 2', (t) => {
  const { dir } = seed(t);
  const r = cli(t, ['trace', 'spans', '--run', KEY, '--json', dir], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), view(dir, { run: KEY }));
  assert.equal(cli(t, ['trace', 'spans', dir, 'extra'], dir).status, 2);
  assert.equal(cli(t, ['trace', 'spans', '--run', 'has space', dir], dir).status, 2);
});

test('CLI: other `trace` calls and `stats` are unchanged and never load the spans module', (t) => {
  const { dir } = seed(t);
  const probe = path.join(tempDir(t, 'doflow-trace-spans-probe-'), 'probe.js');
  fs.writeFileSync(probe, `process.on('exit', () => { process.stderr.write('SPANS_LOADED=' + Object.keys(require.cache).includes(${JSON.stringify(SPANS_FILE)}) + '\\n'); });\n`);
  for (const args of [['trace', '--json', dir], ['stats', '--json', dir], ['trace', dir]]) {
    const r = spawnSync(process.execPath, ['-r', probe, BIN, ...args], { cwd: dir, encoding: 'utf8',
      env: { HOME: dir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', FORCE_COLOR: '0' } });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /SPANS_LOADED=false/, args.join(' '));
    if (args.includes('--json')) assert.equal(JSON.parse(r.stdout).view, args[0] === 'trace' ? 'trace' : 'stats');
  }
  // Negative control: the spans view itself loads it, so the probe can see a load.
  const r = spawnSync(process.execPath, ['-r', probe, BIN, 'trace', 'spans', dir], { cwd: dir, encoding: 'utf8',
    env: { HOME: dir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', FORCE_COLOR: '0' } });
  assert.match(r.stderr, /SPANS_LOADED=true/);
});

// ── C.2d: a non-regular store file never blocks, throws or is followed ───────────────────────────

const POSIX = process.platform !== 'win32';
/** sha256 of the JSON view over `seed(t)`, taken with the reader as it was before C.2d. */
const GOLDEN_SHA = 'a338b303f7f02546f72bc9fc2ea6b266012b7f75a6b4a966c740bdc02d9138ef';

/** Runs the projection in a child that is killed after 3 s: a hang is a failure, not a stall. */
function viewInChild(dir) {
  const code = `const { projectSpans } = require(${JSON.stringify(SPANS_FILE)});
process.stdout.write(JSON.stringify(projectSpans({ projectRoot: process.argv[1], env: {} })));`;
  const result = spawnSync(process.execPath, ['-e', code, dir], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.error, undefined, `the child did not exit by itself: ${result.error && result.error.code}`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function mkfifo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const made = spawnSync('mkfifo', [file]);
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr}`);
}

/** The view with one extra non-regular entry: same spans as the plain view, one more located gap. */
function assertOnlyGap(t, withEntry, locator, kind) {
  const plain = view(seed(t).dir);
  assert.deepEqual(withEntry.traces, plain.traces);
  assert.deepEqual(withEntry.ungrouped, plain.ungrouped);
  const extra = withEntry.gaps.filter((gap) => !plain.gaps.some((known) => known.locator === gap.locator && known.reason === gap.reason));
  assert.deepEqual(extra, [{ locator, reason: 'unparseable', kind }]);
}

test('C.2d: the golden output over normal stores is unchanged', (t) => {
  const { dir } = seed(t);
  const sha = crypto.createHash('sha256').update(JSON.stringify(view(dir))).digest('hex');
  assert.equal(sha, GOLDEN_SHA);
});

for (const [name, rel, kind] of [
  ['telemetry partition', 'runs/telemetry/2026-09-02.jsonl', 'telemetry'],
  ['ledger partition', 'runs/2026-09-02.jsonl', 'ledger'],
  ['task-run store', 'task-attempts/fifo.json', 'task-run'],
  ['worker store', 'worker-runs/fifo.json', 'worker'],
  ['orchestration store', 'orchestration/fifo.json', 'orchestration'],
]) {
  test(`C.2d: a FIFO with no reader as a ${name} returns promptly and is one located gap`, { skip: !POSIX }, (t) => {
    const { dir, state } = seed(t);
    mkfifo(path.join(state, rel));
    assertOnlyGap(t, viewInChild(dir), rel, kind);
  });

  test(`C.2d: a directory named like a ${name} is one located gap`, (t) => {
    const { dir, state } = seed(t);
    fs.mkdirSync(path.join(state, rel), { recursive: true });
    assertOnlyGap(t, view(dir), rel, kind);
  });

  test(`C.2d: a symlink to a regular file as a ${name} is not followed and is one located gap`, { skip: !POSIX }, (t) => {
    const { dir, state } = seed(t);
    const outside = path.join(tempDir(t, 'doflow-trace-spans-out-'), 'outside');
    const body = rel.endsWith('.jsonl')
      ? `${JSON.stringify({ timestamp: at('12:00:00'), kind: 'verify.tier', run: 'r1', lineage: 'l1', status: 'PASS' })}\n`
      : JSON.stringify({ version: 1, runs: {} });
    fs.writeFileSync(outside, body);
    fs.mkdirSync(path.dirname(path.join(state, rel)), { recursive: true });
    fs.symlinkSync(outside, path.join(state, rel));
    assertOnlyGap(t, view(dir), rel, kind);
  });
}

test('C.2d: a store file over the size bound is one located gap, not a read', (t) => {
  const { dir, state } = seed(t);
  const big = path.join(state, 'runs', '2026-09-02.jsonl');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 65 * 1024 * 1024); // sparse: no disk used
  assertOnlyGap(t, view(dir), 'runs/2026-09-02.jsonl', 'ledger');
});
