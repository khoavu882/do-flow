'use strict';

// Feature 091 B.1 (IC-002, IC-003, IC-004, IC-005, IC-011; FR-001..FR-008, NFR-002, NFR-006,
// NFR-008; rider R1): `trace analyze` reads the spans view and runs three detectors per scope
// (latency hotspots, redundant verification, retry loops), gives each a state, derives the verdict
// the way `trace discover` does, and prints evidence and proposal batches for the existing verbs.
// It writes nothing.
//
// In-process against seeded stores in temp projects with an empty environment (the trace-spans
// `seed` pattern); the verdict table and the rider R1 `context` section use in-memory views.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { projectSpans } = require('../../src/runtime/trace/spans.ts');
const { percentile } = require('../../src/runtime/trace/views.ts');
const analyze = require('../../src/runtime/trace/analyze.ts');
const { validateEvidenceItem } = require('../../src/runtime/candidate.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { maskLine } = require('../../src/runtime/mask.ts');
const { oneLine, STATEMENT_MAX } = require('../../src/runtime/lifecycle/followup.ts');
const { EVIDENCE_SCORE_FIELDS } = require('../../src/runtime/evidence-fields.ts');

const { buildAnalysis, buildEvidenceBatch, buildProposalBatch, handleTraceAnalyze } = analyze;

const REPO = path.resolve(__dirname, '..', '..');
const ANALYZE_FILE = path.join(REPO, 'src', 'runtime', 'trace', 'analyze.ts');
const THRESHOLDS = { minSamples: 5, tailRatio: 4, minTailMs: 1000, retryRun: 2 };
const DAY = '2026-09-01';
const DAY_SCOPE = `day:${DAY}`;
const at = (hms) => `${DAY}T${hms}.000Z`;
const sec = (n) => at(`10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`);
const ID1 = '11111111111111111111111111111111';
const KEY = 'aaaa1111/r1/l1';
const CK = 'c0ffee00c0ffee00';
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/;

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────

/** A temp project with the given telemetry lines (and an optional 080 run record). */
function seed(t, telemetry, { run080 = null } = {}) {
  const dir = tempDir(t, 'doflow-trace-analyze-');
  const state = path.join(dir, '.doflow', 'state');
  const write = (rel, body) => {
    const file = path.join(state, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write(`runs/telemetry/${DAY}.jsonl`, `${telemetry.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (run080) write('task-attempts/feat.json', JSON.stringify({ version: 1, revision: 1, runs: { [KEY]: run080 }, tasks: {} }, null, 2));
  return dir;
}

const view = (dir, opts = {}) => projectSpans({ projectRoot: dir, env: {}, ...opts });
const analyzeDir = (dir, thresholds = THRESHOLDS) => buildAnalysis(view(dir), thresholds);
const detector = (a, id) => a.detectors.find((d) => d.id === id);

let n = 0;
/** A verify.check line; each call gets its own verify id and a later second. */
function check({ key = CK, status = 'PASS', shared, tier = 'targeted-tests', dur = null, verifyId, t } = {}) {
  n += 1;
  return { timestamp: t ?? sec(n), kind: 'verify.check', verify_id: verifyId ?? crypto.createHash('sha256').update(`c${n}`).digest('hex').slice(0, 16),
    tier, status, duration_ms: dur, ...(key === null ? {} : { check_key: key }), ...(shared === undefined ? {} : { shared }) };
}
/** A verify.run line and its tier lines: `failing` names the tiers that failed, `passing` the rest. */
function verifyRun({ task = 'A.1', status = 'FAIL', failing = [], passing = [], exit = 1, t } = {}) {
  n += 1;
  const verifyId = crypto.createHash('sha256').update(`r${n}`).digest('hex').slice(0, 16);
  const start = t ?? sec(n);
  return [
    { timestamp: start, kind: 'verify.run', verify_id: verifyId, source: 'verb', ...(task === null ? {} : { task }), status, exit_code: exit },
    ...failing.map((tier) => ({ timestamp: start, kind: 'verify.tier', verify_id: verifyId, tier, status: 'FAIL' })),
    ...passing.map((tier) => ({ timestamp: start, kind: 'verify.tier', verify_id: verifyId, tier, status: 'PASS' })),
  ];
}
const durations = (list, tier = 'targeted-tests') => list.map((dur) => check({ key: null, tier, dur }));

/** stdout (and stderr) of the handler, captured in process. */
function captured(fn) {
  const out = [];
  const err = [];
  const real = { log: console.log, error: console.error };
  const code = process.exitCode;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  try { return { code: fn(), stdout: out.join('\n'), stderr: err.join('\n') }; } finally { Object.assign(console, real); process.exitCode = code; }
}

/** Every file under `root` with its size and mtime. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      if (st.isDirectory()) walk(file);
      else out[path.relative(root, file)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

/** Every object key in a value, at any depth. */
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}

// ── percentile export ───────────────────────────────────────────────────────────────────────────

test('views.ts exports the nearest-rank percentile, unchanged', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([500, 500, 500, 500, 2000], 0.5), 500);
  assert.equal(percentile([500, 500, 500, 500, 2000], 0.95), 2000);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
});

// ── latency hotspots (IC-003) ───────────────────────────────────────────────────────────────────

test('hotspots: p95 = 4x p50 with a 1500 ms tail is one FINDING; its spans are those above p50', (t) => {
  const a = analyzeDir(seed(t, durations([500, 500, 500, 500, 2000])));
  const d = detector(a, 'latency-hotspots');
  assert.equal(d.status, 'FINDING');
  assert.equal(d.findings.length, 1);
  const [f] = d.findings;
  assert.equal(f.scope, DAY_SCOPE);
  assert.equal(f.scopeKind, 'day');
  assert.deepEqual(f.measures, { count: 5, kind: 'verify.check', name: 'targeted-tests', p50Ms: 500, p95Ms: 2000, totalMs: 4000 });
  assert.equal(f.spans.length, 1);
  assert.match(f.spans[0].locator, /^runs\/telemetry\/2026-09-01\.jsonl:5$/);
  assert.equal(a.verdict, 'findings');
  assert.deepEqual(a.latency, [{ count: 5, kind: 'verify.check', name: 'targeted-tests', p50Ms: 500, p95Ms: 2000, scope: DAY_SCOPE, totalMs: 4000 }]);
});

test('hotspots: a tail of exactly minTailMs is a FINDING; 999 ms is not', (t) => {
  assert.equal(detector(analyzeDir(seed(t, durations([250, 250, 250, 250, 1250]))), 'latency-hotspots').status, 'FINDING');
  assert.equal(detector(analyzeDir(seed(t, durations([250, 250, 250, 250, 1249]))), 'latency-hotspots').status, 'CLEAR');
});

test('hotspots: 3.99x p50 is not a finding (CLEAR)', (t) => {
  const d = detector(analyzeDir(seed(t, durations([1000, 1000, 1000, 1000, 3990]))), 'latency-hotspots');
  assert.equal(d.status, 'CLEAR');
  assert.deepEqual(d.findings, []);
});

test('hotspots: 4 samples is NOT_DETERMINED; steady durations are CLEAR', (t) => {
  const few = analyzeDir(seed(t, durations([500, 500, 500, 2000])));
  assert.equal(detector(few, 'latency-hotspots').status, 'NOT_DETERMINED');
  assert.deepEqual(few.latency, []);
  const steady = analyzeDir(seed(t, durations([900, 1000, 1000, 1100, 1000, 950])));
  assert.equal(detector(steady, 'latency-hotspots').status, 'CLEAR');
  assert.equal(steady.latency.length, 1);
});

test('hotspots: hook lines without a post-shell observation carry no duration, so NOT_DETERMINED (NFR-008)', (t) => {
  const hooks = [1, 2, 3, 4, 5, 6].map((i) => ({ timestamp: sec(i), kind: 'hook', harness: 'claude', event: 'PreToolUse', policy: 'pre-bash-guard',
    verdict: 'allow', duration_ms: null, tool: 'Bash', tool_call_id: `tc${i}` }));
  const a = analyzeDir(seed(t, hooks));
  assert.equal(detector(a, 'latency-hotspots').status, 'NOT_DETERMINED');
  assert.equal(a.verdict, 'insufficient-data');
});

test('hotspots C-10: verify.tier latency finding carries derivedFrom when verify.check exists, producing one proposal', (t) => {
  const durs = [100, 100, 100, 100, 5000];
  const telemetry = durs.flatMap((dur, i) => {
    const vId = crypto.createHash('sha256').update(`v${i + 1}`).digest('hex').slice(0, 16);
    const ts = sec(i + 1);
    return [
      { timestamp: ts, kind: 'verify.check', verify_id: vId, tier: 'targeted-tests', status: 'PASS', duration_ms: dur, check_key: `ck-${i}` },
      { timestamp: ts, kind: 'verify.tier', verify_id: vId, tier: 'targeted-tests', status: 'PASS', duration_ms: dur },
    ];
  });
  const dir = seed(t, telemetry);
  const a = analyzeDir(dir);
  const d = detector(a, 'latency-hotspots');
  assert.equal(d.status, 'FINDING');
  assert.equal(d.findings.length, 2);
  const checkFinding = d.findings.find((f) => f.measures.kind === 'verify.check');
  const tierFinding = d.findings.find((f) => f.measures.kind === 'verify.tier');
  assert.ok(checkFinding, 'verify.check finding exists');
  assert.ok(tierFinding, 'verify.tier finding exists');
  assert.equal(tierFinding.derivedFrom, 'verify.check');
  assert.equal(checkFinding.derivedFrom, undefined);

  // Finding ID does not include derivedFrom
  const spans = view(dir).ungrouped[0].spans;
  const tierSpans = spans.filter((s) => s.kind === 'verify.tier' && s.durationMs > 100);
  const expectedTierId = crypto.createHash('sha256').update(`latency-hotspots\n${DAY_SCOPE}\n${tierSpans.map((s) => s.spanId).sort().join(',')}`).digest('hex').slice(0, 16);
  assert.equal(tierFinding.id, expectedTierId);

  // Proposal batch skips finding with derivedFrom: exactly 1 proposal
  const proposals = buildProposalBatch(a, null);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].statement, /verify\.check\/targeted-tests/);

  // Text output carries ` derivedFrom verify.check` suffix
  const r = captured(() => handleTraceAnalyze({ positional: [dir], env: {} }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`^latency-hotspots ${tierFinding.id} day p95_ms:verify\\.tier/targeted-tests=5000 derivedFrom verify\\.check$`, 'm'));
  assert.match(r.stdout, new RegExp(`^latency-hotspots ${checkFinding.id} day p95_ms:verify\\.check/targeted-tests=5000$`, 'm'));

  // JSON output keeps derivedFrom
  const j = captured(() => handleTraceAnalyze({ positional: [dir], json: true, env: {} }));
  assert.equal(j.code, 1);
  const parsed = JSON.parse(j.stdout);
  const jTier = parsed.detectors.find((x) => x.id === 'latency-hotspots').findings.find((f) => f.measures.kind === 'verify.tier');
  assert.equal(jTier.derivedFrom, 'verify.check');
});

test('hotspots S-1: reused and follower checks (089) carry lookup time, so they never enter a latency group', (t) => {
  const reused = [2, 3, 2, 3].map((dur, i) => check({ key: null, dur, shared: i % 2 ? 'follower' : 'reused' }));
  const a = analyzeDir(seed(t, [...reused, check({ key: null, dur: 4000, shared: 'none' })]));
  const d = detector(a, 'latency-hotspots');
  assert.deepEqual(d.findings, []);
  assert.equal(d.status, 'NOT_DETERMINED');
  assert.deepEqual(a.latency, []);
  assert.deepEqual(buildProposalBatch(a, null), []);
  // executed shapes (none, leader, absent) still count
  const real = analyzeDir(seed(t, [check({ key: null, dur: 500, shared: 'leader' }), check({ key: null, dur: 500, shared: 'none' }),
    ...durations([500, 500, 2000])]));
  assert.equal(detector(real, 'latency-hotspots').status, 'FINDING');
});

// ── redundant verification (IC-003, IC-011) ─────────────────────────────────────────────────────

test('redundant: two executed PASS checks on one key are one finding', (t) => {
  const a = analyzeDir(seed(t, [check(), check({ shared: 'leader' })]));
  const d = detector(a, 'redundant-verification');
  assert.equal(d.status, 'FINDING');
  assert.equal(d.findings.length, 1);
  assert.deepEqual(d.findings[0].measures, { checkKey: CK, passes: 2, tier: 'targeted-tests' });
  assert.equal(d.findings[0].spans.length, 2);
});

test('redundant: shared none and null both count as executed', (t) => {
  const d = detector(analyzeDir(seed(t, [check({ shared: 'none' }), check()])), 'redundant-verification');
  assert.equal(d.findings.length, 1);
});

for (const shared of ['follower', 'in-run', 'reused', 'some-later-marker']) {
  test(`redundant: a second PASS with shared ${shared} is not executed, so no finding (row ${shared})`, (t) => {
    const d = detector(analyzeDir(seed(t, [check(), check({ shared })])), 'redundant-verification');
    assert.equal(d.status, 'CLEAR');
    assert.deepEqual(d.findings, []);
  });
}

test('redundant: a NOT_RUN check on the same key does not count', (t) => {
  const d = detector(analyzeDir(seed(t, [check(), check({ status: 'NOT_RUN' })])), 'redundant-verification');
  assert.deepEqual(d.findings, []);
});

test('redundant: PASS, FAIL, PASS on one key is not a finding (row PASS-between)', (t) => {
  const d = detector(analyzeDir(seed(t, [check(), check({ status: 'FAIL' }), check()])), 'redundant-verification');
  assert.equal(d.status, 'CLEAR');
  assert.deepEqual(d.findings, []);
});

test('redundant: no keyed executed check is NOT_DETERMINED', (t) => {
  const d = detector(analyzeDir(seed(t, [check({ key: null }), check({ key: null })])), 'redundant-verification');
  assert.equal(d.status, 'NOT_DETERMINED');
});

// ── retry loops (IC-003) ────────────────────────────────────────────────────────────────────────

test('retry: two FAIL runs of one task with the same failing tiers are one finding', (t) => {
  const a = analyzeDir(seed(t, [...verifyRun({ failing: ['targeted-tests', 'lint'], passing: ['build'] }), ...verifyRun({ failing: ['lint', 'targeted-tests'] })]));
  const d = detector(a, 'retry-loops');
  assert.equal(d.status, 'FINDING');
  assert.equal(d.findings.length, 1);
  assert.deepEqual(d.findings[0].measures, { failureClass: 'lint,targeted-tests', grouping: 'task', runs: 2, task: 'A.1' });
});

test('retry: a changed tier set is not a finding', (t) => {
  const d = detector(analyzeDir(seed(t, [...verifyRun({ failing: ['lint'] }), ...verifyRun({ failing: ['targeted-tests'] })])), 'retry-loops');
  assert.equal(d.status, 'CLEAR');
  assert.deepEqual(d.findings, []);
});

test('retry: a PASS between two FAIL runs breaks the sequence', (t) => {
  const d = detector(analyzeDir(seed(t, [...verifyRun({ failing: ['lint'] }), ...verifyRun({ status: 'PASS', exit: 0 }), ...verifyRun({ failing: ['lint'] })])), 'retry-loops');
  assert.deepEqual(d.findings, []);
});

test('retry: a single FAIL run is not a finding; runs of different tasks do not chain', (t) => {
  assert.deepEqual(detector(analyzeDir(seed(t, verifyRun({ failing: ['lint'] }))), 'retry-loops').findings, []);
  const d = detector(analyzeDir(seed(t, [...verifyRun({ failing: ['lint'] }), ...verifyRun({ task: 'B.2', failing: ['lint'] })])), 'retry-loops');
  assert.deepEqual(d.findings, []);
});

test('retry: a null task groups by scope; a run with no tiers uses exit:<code>', (t) => {
  const d = detector(analyzeDir(seed(t, [...verifyRun({ task: null, exit: 3 }), ...verifyRun({ task: null, exit: 3 })])), 'retry-loops');
  assert.equal(d.findings.length, 1);
  assert.deepEqual(d.findings[0].measures, { failureClass: 'exit:3', grouping: 'scope', runs: 2, task: null });
  const other = detector(analyzeDir(seed(t, [...verifyRun({ task: null, exit: 3 }), ...verifyRun({ task: null, exit: 4 })])), 'retry-loops');
  assert.deepEqual(other.findings, []);
});

test('retry: three FAIL runs of one class are one maximal finding of three runs', (t) => {
  const d = detector(analyzeDir(seed(t, [...verifyRun({ failing: ['lint'] }), ...verifyRun({ failing: ['lint'] }), ...verifyRun({ failing: ['lint'] })])), 'retry-loops');
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].measures.runs, 3);
});

test('retry: no verify.run with a status is NOT_DETERMINED', (t) => {
  assert.equal(detector(analyzeDir(seed(t, durations([1, 2]))), 'retry-loops').status, 'NOT_DETERMINED');
});

test('089 reuse: a second PASS whose shared is reused makes no finding', (t) => {
  const a = analyzeDir(seed(t, [check(), check({ shared: 'reused' }), check({ shared: 'reused' })]));
  assert.deepEqual(detector(a, 'redundant-verification').findings, []);
});

// ── scopes, states and verdict (IC-002) ─────────────────────────────────────────────────────────

test('a trace is a scope of kind trace; its id is the trace id', (t) => {
  const run080 = { runKey: KEY, run: 'r1', lineage: 'l1', createdAt: at('10:00:00'), control: 'running', epoch: 1, traceId: ID1,
    history: [{ at: at('10:00:00'), action: 'start', epoch: 1, traceId: ID1 }] };
  const ident = { run: 'r1', lineage: 'l1' };
  const a = analyzeDir(seed(t, [{ ...check(), ...ident }, { ...check(), ...ident }], { run080 }));
  const [f] = detector(a, 'redundant-verification').findings;
  assert.equal(f.scope, ID1);
  assert.equal(f.scopeKind, 'trace');
  assert.equal(a.scopes, 1);
});

/** An in-memory view: one ungrouped group with the given spans. */
function memView(spans, group = DAY_SCOPE) {
  return { v: 1, traces: [], ungrouped: [{ group, label: 'ungrouped', spans }], gaps: [] };
}
let sid = 0;
function span(kind, name, { start, durationMs = null, attrs = {} } = {}) {
  sid += 1;
  start = start ?? sec(sid);
  const spanId = crypto.createHash('sha256').update(`s${sid}${kind}${start}`).digest('hex').slice(0, 16);
  return { spanId, parentSpanId: null, kind, name, start, end: start, durationMs, basis: 'recorded', locator: `x:${sid}`, attrs };
}

test('verdict follows trace discover: findings, insufficient-data, partial, no-findings', () => {
  const status = (a) => a.detectors.map((d) => d.status);
  const none = buildAnalysis(memView([]), THRESHOLDS);
  assert.deepEqual(status(none), ['NOT_DETERMINED', 'NOT_DETERMINED', 'NOT_DETERMINED']);
  assert.equal(none.verdict, 'insufficient-data');
  const steady = [1, 2, 3, 4, 5].map(() => span('ledger', 'route', { durationMs: 100 }));
  const partial = buildAnalysis(memView(steady), THRESHOLDS);
  assert.deepEqual(status(partial), ['CLEAR', 'NOT_DETERMINED', 'NOT_DETERMINED']);
  assert.equal(partial.verdict, 'no-findings-in-the-analyses-that-could-run');
  const keyed = span('verify.check', 'targeted-tests', { attrs: { status: 'PASS', check_key: CK } });
  const ran = span('verify.run', 'verify.run', { attrs: { status: 'PASS', task: 'A.1' } });
  const clear = buildAnalysis(memView([...steady, keyed, ran]), THRESHOLDS);
  assert.deepEqual(status(clear), ['CLEAR', 'CLEAR', 'CLEAR']);
  assert.equal(clear.verdict, 'no-findings');
  const twice = span('verify.check', 'targeted-tests', { attrs: { status: 'PASS', check_key: CK } });
  const found = buildAnalysis(memView([...steady, keyed, twice, ran]), THRESHOLDS);
  assert.equal(found.verdict, 'findings');
  assert.deepEqual(found.thresholds, THRESHOLDS);
  assert.equal(found.v, 1);
  assert.equal(found.view, 'analyze');
});

// ── finding ids, caps, bytes ────────────────────────────────────────────────────────────────────

test('finding id is sha256(detector, scope, sorted span ids); spans sort by start and cap at 20 with spanCount', (t) => {
  const lines = Array.from({ length: 25 }, () => check());
  const a = analyzeDir(seed(t, lines));
  const [f] = detector(a, 'redundant-verification').findings;
  const all = view(seed(t, lines)).ungrouped[0].spans.map((s) => s.spanId);
  const expected = crypto.createHash('sha256').update(`redundant-verification\n${DAY_SCOPE}\n${[...all].sort().join(',')}`).digest('hex').slice(0, 16);
  assert.equal(f.id, expected);
  assert.equal(f.spans.length, 20);
  assert.equal(f.measures.passes, 25);
  assert.equal(f.measures.spanCount, 25);
  assert.deepEqual(f.spans.map((s) => s.spanId), all.slice(0, 20));
});

test('the same stores give byte-identical JSON twice; no score, rank or confidence field anywhere', (t) => {
  const dir = seed(t, [...durations([500, 500, 500, 500, 2000]), check(), check(), ...verifyRun({ failing: ['lint'] }), ...verifyRun({ failing: ['lint'] })]);
  const first = captured(() => handleTraceAnalyze({ positional: [dir], json: true, env: {} }));
  const second = captured(() => handleTraceAnalyze({ positional: [dir], json: true, env: {} }));
  assert.equal(first.code, 1);
  assert.equal(first.stdout, second.stdout);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.detectors.filter((d) => d.status === 'FINDING').length, 3);
  const ev = buildEvidenceBatch(analyzeDir(dir), {});
  const props = buildProposalBatch(analyzeDir(dir), null);
  for (const value of [parsed, ev, props]) {
    for (const key of keysOf(value)) assert.ok(!EVIDENCE_SCORE_FIELDS.has(key), `score-shaped field ${key}`);
  }
  // Keys are sorted at every level of the printed view.
  const order = (value) => {
    if (Array.isArray(value)) return value.every(order);
    if (!value || typeof value !== 'object') return true;
    const keys = Object.keys(value);
    return keys.join('\n') === [...keys].sort().join('\n') && keys.every((k) => order(value[k]));
  };
  assert.ok(order(parsed));
  assert.ok(!/"(at|now|generatedAt|timestamp)"/.test(first.stdout));
});

// ── batches (IC-004, IC-005) ────────────────────────────────────────────────────────────────────

function threeFindings(t) {
  return seed(t, [...durations([500, 500, 500, 500, 2000]), check(), check(), ...verifyRun({ failing: ['lint'] }), ...verifyRun({ failing: ['lint'] })]);
}

test('evidence batch: each item passes validateEvidenceItem in process and names its finding once', (t) => {
  const dir = threeFindings(t);
  const a = analyzeDir(dir);
  const items = buildEvidenceBatch(a, { run: KEY, global: false });
  const ids = a.detectors.flatMap((d) => d.findings.map((f) => f.id));
  assert.equal(items.length, 3);
  items.forEach((item, i) => {
    assert.doesNotThrow(() => validateEvidenceItem(item, 'T-1', dir, null, dir));
    assert.equal(item.kind, 'runtime-observation');
    assert.equal(item.provenance, 'extracted');
    assert.deepEqual(item.source, { capability: 'trace.analyze', provider: 'doflow' });
    assert.deepEqual(item.observation, { command: `doflow trace analyze --json --run ${KEY}`, exitCode: 1 });
    assert.equal(item.content.split(`finding ${ids[i]}`).length, 2, item.content);
    assert.match(item.content, /^trace-analyze finding [0-9a-f]{16} detector=[a-z-]+ scope=day:2026-09-01 spans=[0-9a-f]{16}(,[0-9a-f]{16})*( [A-Za-z0-9]+=\S+)+$/);
    assert.ok(!item.content.includes(dir));
  });
  assert.deepEqual(buildEvidenceBatch(a, { global: true })[0].observation.command, 'doflow trace analyze --json -g');
});

test('proposal batch: grammar, at most 280 characters, no 32-character run, unchanged by maskLine; cites evidence or unrecorded', (t) => {
  const a = analyzeDir(threeFindings(t));
  const [hot, red, retry] = a.detectors.map((d) => d.findings[0]);
  const ledger = [
    { id: 'ev_old0000_aaaaaaaa_1', content: `trace-analyze finding ${red.id} detector=x`, freshness: { observedAt: '2026-09-01T10:00:00.000Z' } },
    { id: 'ev_new0000_bbbbbbbb_1', content: `trace-analyze finding ${red.id} detector=x`, freshness: { observedAt: '2026-09-02T10:00:00.000Z' } },
    { id: 'ev_mid0000_cccccccc_1', content: `trace-analyze finding ${red.id} detector=x`, freshness: { observedAt: '2026-09-01T12:00:00.000Z' } },
    { id: 'ev_other00_dddddddd_1', content: 'unrelated finding 0000000000000000', freshness: { observedAt: '2026-09-03T10:00:00.000Z' } },
  ];
  const props = buildProposalBatch(a, ledger);
  assert.equal(props.length, 3);
  for (const p of props) {
    assert.deepEqual(Object.keys(p).sort(), ['source', 'stage', 'statement']);
    assert.equal(p.stage, 'maintain');
    assert.deepEqual(p.source, { kind: 'manual' });
    assert.ok(p.statement.length <= STATEMENT_MAX);
    assert.ok(!LONG_RUN.test(p.statement), p.statement);
    assert.equal(maskLine(p.statement).text, p.statement);
    assert.equal(oneLine(p.statement, 'statement', []), p.statement);
  }
  assert.equal(props[0].statement, `trace-analyze latency-hotspots ${hot.id}: metric p95_ms:verify.check/targeted-tests=2000; baseline span set finding ${hot.id}; evidence unrecorded; verify: re-run trace analyze on a later window and compare p95_ms:verify.check/targeted-tests`);
  assert.equal(props[1].statement, `trace-analyze redundant-verification ${red.id}: metric passes:targeted-tests=2; baseline span set finding ${red.id}; evidence ev_new0000_bbbbbbbb_1,ev_mid0000_cccccccc_1; verify: re-run trace analyze on a later window and compare passes:targeted-tests`);
  assert.equal(props[2].statement, `trace-analyze retry-loops ${retry.id}: metric failed_runs:A.1=2; baseline span set finding ${retry.id}; evidence unrecorded; verify: re-run trace analyze on a later window and compare failed_runs:A.1`);
  assert.match(buildProposalBatch(a, null)[1].statement, /; evidence unrecorded; /);
});

test('proposal batch: the longest real case drops the second evidence id, then truncates the name', () => {
  const name = `a${'b-c'.repeat(21)}`; // 64 characters, the SAFE_TOKEN maximum
  const spans = [1000, 1000, 1000, 1000, 9000].map((d) => span('verify.check', name, { durationMs: d }));
  const a = buildAnalysis(memView(spans), THRESHOLDS);
  const [f] = detector(a, 'latency-hotspots').findings;
  const ledger = [
    { id: 'ev_mgz1abcd_0a1b2c3d_11', content: `finding ${f.id}`, freshness: { observedAt: '2026-09-02T00:00:00.000Z' } },
    { id: 'ev_mgz1abce_0a1b2c3e_12', content: `finding ${f.id}`, freshness: { observedAt: '2026-09-01T00:00:00.000Z' } },
  ];
  const [p] = buildProposalBatch(a, ledger);
  assert.ok(p.statement.length <= STATEMENT_MAX, `${p.statement.length}`);
  assert.ok(!LONG_RUN.test(p.statement), p.statement);
  assert.equal(maskLine(p.statement).text, p.statement);
  assert.match(p.statement, /; evidence ev_mgz1abcd_0a1b2c3d_11; /);
  assert.ok(!p.statement.includes(name));
  assert.match(p.statement, /metric p95_ms:verify\.check\/ab-c[a-z-]*=9000; /);
});

test('proposal batch: a name the masker would change is replaced by its digest', () => {
  const spans = [1000, 1000, 1000, 1000, 9000].map((d) => span('ledger', 'api-token-refresh', { durationMs: d }));
  const [p] = buildProposalBatch(buildAnalysis(memView(spans), THRESHOLDS), null);
  assert.equal(maskLine(p.statement).text, p.statement);
  assert.match(p.statement, /metric p95_ms:ledger\/h[0-9a-f]{8}=9000; /);
});

// ── the handler (IC-001) ────────────────────────────────────────────────────────────────────────

test('handler: exit 0 with no finding, 1 with findings; text prints detector and finding lines', (t) => {
  const clean = captured(() => handleTraceAnalyze({ positional: [seed(t, durations([100, 100, 100, 100, 100]))], env: {} }));
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /^latency-hotspots CLEAR findings 0$/m);
  const dirty = captured(() => handleTraceAnalyze({ positional: [threeFindings(t)], env: {} }));
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /^verdict findings scopes 1$/m);
  assert.match(dirty.stdout, /^redundant-verification [0-9a-f]{16} day passes:targeted-tests=2$/m);
  assert.match(dirty.stdout, /^context NOT_DETERMINED/m);
});

test('handler: usage errors exit 2 (bad --emit, --task-id without --emit followups, extra positional, bad --run, bad threshold)', (t) => {
  const dir = threeFindings(t);
  const usage = (opts) => captured(() => handleTraceAnalyze({ positional: [dir], env: {}, ...opts }));
  assert.equal(usage({ emit: 'bogus' }).code, 2);
  assert.equal(usage({ taskId: 'T-1' }).code, 2);
  assert.equal(usage({ taskId: 'T-1', emit: 'evidence' }).code, 2);
  assert.equal(usage({ positional: [dir, 'extra'] }).code, 2);
  assert.equal(usage({ run: 'has space' }).code, 2);
  assert.equal(usage({ emit: 'followups', taskId: '../x' }).code, 2);
  for (const [key, value] of [['minSamples', 0], ['tailRatio', 1.5], ['minTailMs', '1000'], ['retryRun', -2]]) {
    const r = usage({ analysis: { ...THRESHOLDS, [key]: value }, json: true });
    assert.equal(r.code, 2, key);
    assert.match(r.stdout, new RegExp(`analysis\\.${key}`));
  }
  const { retryRun, ...missing } = THRESHOLDS;
  assert.match(usage({ analysis: missing }).stderr, /analysis\.retryRun/);
  assert.equal(usage({ analysis: null }).code, 2);
});

test('handler: the registry analysis block is read and valid', () => {
  assert.deepEqual(analyze.readThresholds(), { thresholds: THRESHOLDS });
});

test('handler: --emit evidence prints only the batch (exit 1); --emit followups --task-id cites the ledger; nothing is written', (t) => {
  const dir = threeFindings(t);
  const ev = captured(() => handleTraceAnalyze({ positional: [dir], emit: 'evidence', env: {} }));
  assert.equal(ev.code, 1);
  const items = JSON.parse(ev.stdout);
  assert.equal(items.length, 3);
  // Record the first item through the ledger itself (as `evidence --action add` would), then snapshot.
  const ledger = new EvidenceLedger({ repoRoot: dir });
  const evId = ledger.addEvidence({ ...items[0], taskId: 'T-1' });
  ledger.save('T-1');
  const before = snapshot(path.join(dir, '.doflow'));
  const fu = captured(() => handleTraceAnalyze({ positional: [dir], emit: 'followups', taskId: 'T-1', env: {}, stateRoot: dir }));
  assert.equal(fu.code, 1);
  const props = JSON.parse(fu.stdout);
  assert.equal(props.length, 3);
  assert.match(props[0].statement, new RegExp(`; evidence ${evId}; `));
  assert.match(props[1].statement, /; evidence unrecorded; /);
  captured(() => handleTraceAnalyze({ positional: [dir], json: true, env: {} }));
  captured(() => handleTraceAnalyze({ positional: [dir], env: {} }));
  assert.deepEqual(snapshot(path.join(dir, '.doflow')), before);
  const empty = captured(() => handleTraceAnalyze({ positional: [seed(t, [])], emit: 'evidence', env: {} }));
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), []);
});

test('the analyzer loads no network module and no otlp module', () => {
  const code = `const a = require(${JSON.stringify(ANALYZE_FILE)});
a.buildAnalysis({ v: 1, traces: [], ungrouped: [], gaps: [] }, ${JSON.stringify(THRESHOLDS)});
const mods = process.moduleLoadList.filter((m) => /^NativeModule (https?|http2|net|tls|dgram|undici|internal\\/deps\\/undici)/.test(m));
const otlp = Object.keys(require.cache).filter((f) => /otlp-/.test(f));
process.stdout.write(JSON.stringify({ mods, otlp }));`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { mods: [], otlp: [] });
});

// ── rider R1: the context section ───────────────────────────────────────────────────────────────

function hook(session, reason, bytes, digest, start) {
  const attrs = { harness: 'claude', event: 'UserPromptSubmit', policy: 'user-prompt-submit', ...(session === null ? {} : { session }) };
  if (reason !== undefined) Object.assign(attrs, { emit_reason: reason, emit_bytes: bytes, emit_digest: digest });
  return span('hook', 'user-prompt-submit', { start, attrs });
}

test('context: per session hook calls, emissions, bytes, duplicates by digest, reasons; no effect on verdict or exit', () => {
  const spans = [
    hook('s2', 'emit', 300, 'aaaaaaaa', at('10:00:01')),
    hook('s1', 'emit', 1000, 'deadbeef', at('10:00:02')),
    hook('s1', 'silent:already-bootstrapped', 0, null, at('10:00:03')),
    hook('s1', 'refused:mandatory-over-budget', 200, 'deadbeef', at('10:00:04')),
    hook('s1', 'emit', 1000, 'deadbeef', at('10:00:05')),
    hook('s1', 'emit', 50, '01234567', at('10:00:06')),
    hook('s1', undefined, null, null, at('10:00:07')), // a pre-bash-guard-like line without the fields
    hook('s2', 'emit', 300, 'deadbeef', at('10:00:08')), // same digest, other session: not a duplicate
    hook(null, 'emit', 999, 'deadbeef', at('10:00:09')), // no session: not counted
    span('verify.run', 'verify.run', { attrs: { status: 'PASS' } }),
  ];
  const a = buildAnalysis(memView(spans), THRESHOLDS);
  assert.deepEqual(a.context, { status: 'MEASURED', sessions: [
    { duplicateBytes: 1200, duplicates: 2, emissions: 4, emittedBytes: 2250, hookCalls: 6,
      reasons: { emit: 3, 'refused:mandatory-over-budget': 1, 'silent:already-bootstrapped': 1 }, session: 's1' },
    { duplicateBytes: 0, duplicates: 0, emissions: 2, emittedBytes: 600, hookCalls: 2, reasons: { emit: 2 }, session: 's2' },
  ] });
  const without = buildAnalysis(memView(spans.filter((s) => s.kind !== 'hook')), THRESHOLDS);
  assert.equal(a.verdict, without.verdict);
  assert.deepEqual(a.detectors, without.detectors);
});

test('context: NOT_DETERMINED with an empty list when no hook span carries emit_reason', () => {
  const a = buildAnalysis(memView([hook('s1', undefined, null, null, at('10:00:01'))]), THRESHOLDS);
  assert.deepEqual(a.context, { sessions: [], status: 'NOT_DETERMINED' });
});

test('context: the text view prints one totals line', (t) => {
  const r = captured(() => analyze.printAnalysis(buildAnalysis(memView([
    hook('s1', 'emit', 1000, 'deadbeef', at('10:00:01')), hook('s1', 'emit', 1000, 'deadbeef', at('10:00:02'))]), THRESHOLDS)));
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('context'));
  assert.deepEqual(lines, ['context MEASURED sessions 1 hook-calls 2 emissions 2 emitted-bytes 2000 duplicates 1 duplicate-bytes 1000']);
});
