'use strict';

// Feature 095b B.2 (IC-009, IC-010): the review-miss `grade`, `noise` and `report` verbs. A fake
// reviewer writes findings.json files into a scratch iteration directory; nothing runs a model.
// Must stub child_process before the first require of the bench modules (pattern:
// test/bench/bench-noise-nospawn.test.js): any spawn other than a read-only git turns the test red.

const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const recordedSpawns: any = [];
const READ_ONLY_GIT: any = ['show', 'rev-parse', 'status', 'cat-file'];
const origExecFileSync = cp.execFileSync;
const origSpawnSync = cp.spawnSync;
const origExecSync = cp.execSync;
const origSpawn = cp.spawn;

function checkSpawn(cmd: any, args: any) {
  const argsList = Array.isArray(args) ? args : [];
  recordedSpawns.push({ cmd, args: argsList });
  if (cmd !== 'git') throw new Error(`Forbidden spawn: expected git, got ${cmd}`);
  const sub = argsList[0] || null;
  if (!READ_ONLY_GIT.includes(sub)) throw new Error(`Forbidden git subcommand: expected ${READ_ONLY_GIT.join(', ')}, got ${sub}`);
}

cp.execFileSync = function execFileSync(file: any, args: any, options: any) {
  checkSpawn(file, args);
  return origExecFileSync.call(this, file, args, options);
};
cp.spawnSync = function spawnSync(file: any, args: any, options: any) {
  checkSpawn(file, args);
  return origSpawnSync.call(this, file, args, options);
};
cp.spawn = function spawn(file: any, args: any, options: any) {
  checkSpawn(file, args);
  return origSpawn.call(this, file, args, options);
};
cp.execSync = function execSync(cmd: any, options: any) {
  const parts = typeof cmd === 'string' ? cmd.trim().split(/\s+/) : [];
  checkSpawn(parts[0], parts.slice(1));
  return origExecSync.call(this, cmd, options);
};

// Required AFTER stubbing child_process
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { caseKey, splitOf, loadConfig } = require('../../bench/review-miss/corpus.ts');
const runner = require('../../bench/review-miss/runner.ts');
const benchRunner = require('../../bench/runner.ts');
const { NOISE_VERDICTS } = require('../../bench/noise.ts');

const CONFIG = loadConfig();
const HEAD = 'a'.repeat(40);
const REV = 'b'.repeat(40);
const STAMP: any = { model: 'claude-fixture', sourceAt: 'c'.repeat(40) };

const mkCase = (id: any, expected: any) => {
  const scope: any = [expected.path];
  return {
    id,
    key: caseKey({ id, rev: REV, scope, expected }),
    split: splitOf(id, CONFIG),
    source: { row: id.slice(0, 3), slug: `${id.slice(0, 3)}-fixture`, finding: 'F-1' },
    rev: REV,
    scope,
    expected,
  };
};

/** Expected truth: a.js 10-20 blocker; the other cases give the noise tests distinct keys. */
const CASES: any = [
  mkCase('001-b-1', { path: 'src/a.js', startLine: 10, endLine: 20, severity: 'blocker' }),
  mkCase('002-s-1', { path: 'src/b.js', startLine: 5, endLine: 5, severity: 'should-fix' }),
  mkCase('003-b-1', { path: 'src/c.js', startLine: 1, endLine: 2, severity: 'blocker' }),
  mkCase('004-b-1', { path: 'src/d.js', startLine: 7, endLine: 9, severity: 'blocker' }),
];

function setup(t: any, cases: any = CASES) {
  const root = tempDir(t, 'doflow-review-miss-grade-');
  const runRoot = path.join(root, 'runs');
  fs.mkdirSync(runRoot, { recursive: true });
  const corpusFile = path.join(root, 'corpus.json');
  const corpus: any = { schema: 1, kind: 'review-miss', records: 1, skipped: { 'record-invalid': [], 'not-fixed': 0, severity: 0, locator: 0, 'no-parent': 0, 'path-absent': 0 }, cases };
  fs.writeFileSync(corpusFile, `${JSON.stringify(corpus, null, 2)}\n`);
  return { root, runRoot, corpusFile, corpus };
}

/** A schema-valid findings record whose converged list is `findings` ([{ severity, locator }]). */
function findingsRecord(findings: any) {
  const converged = findings.map((f: any, i: any) => {
    const status = f.status ?? 'open';
    return {
      id: `C-${i + 1}`, from: [`s-${i + 1}`], severity: f.severity, status, locator: f.locator,
      ...(status === 'refuted' ? { evidence: 'src/evidence.js:1' } : {}),
      ...(status === 'fixed' ? { fixedIn: HEAD } : {}),
      ...(status === 'user-accepted' ? { decision: 'DEC-001' } : {}),
    };
  });
  return {
    schema: 1,
    row: '001',
    slug: '001-fixture',
    reviewedHead: HEAD,
    seats: [{ id: 'seat', findings: findings.map((f: any, i: any) => ({ id: `s-${i + 1}`, severity: f.severity, locator: f.locator, summary: 'fake reviewer' })) }],
    converged,
  };
}

/** The fake reviewer: writes one case's findings.json (and optionally run_status.json). */
function review(f: any, iteration: any, caseId: any, findings: any, status?: any) {
  const dir = path.join(f.runRoot, iteration, caseId);
  fs.mkdirSync(dir, { recursive: true });
  if (findings !== null) fs.writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(Array.isArray(findings) ? findingsRecord(findings) : findings)}\n`);
  if (status !== undefined) fs.writeFileSync(path.join(dir, 'run_status.json'), typeof status === 'string' ? status : `${JSON.stringify(status)}\n`);
}

function stamp(f: any, iteration: any, meta: any = STAMP) {
  const dir = path.join(f.runRoot, iteration);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'iteration.json'), `${JSON.stringify(meta)}\n`);
}

function run(f: any, argv: any) {
  const out: any = [];
  const err: any = [];
  const code = runner.main(argv, { repoRoot: f.root, runRoot: f.runRoot, out: (m: any) => out.push(m), err: (m: any) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const grade = (f: any, iteration: any, extra: any = []) => run(f, ['grade', '--iteration', iteration, '--corpus', f.corpusFile, ...extra]);
const gradeOf = (f: any, iteration: any) => JSON.parse(fs.readFileSync(path.join(f.runRoot, iteration, 'grade.json'), 'utf8'));
const runOf = (f: any, iteration: any, caseId: any) => gradeOf(f, iteration).runs[CASES.find((c: any) => c.id === caseId).key];

/** Grades one case (001-b-1: a.js 10-20 blocker) against one fake finding and returns its run entry. */
let seq = 0;
function gradeSingle(t: any, finding: any, status?: any) {
  const f = setup(t);
  const it = `it-${++seq}`;
  stamp(f, it);
  review(f, it, '001-b-1', [finding], status);
  const r = grade(f, it);
  assert.equal(r.code, 0, r.err);
  return runOf(f, it, '001-b-1');
}

test('IC-009: a finding that names the expected span is found (passRate 1); grade.json is the repeat shape', (t) => {
  const f = setup(t);
  stamp(f, 'r1');
  review(f, 'r1', '001-b-1', [{ severity: 'blocker', locator: 'src/a.js:12-14' }]);
  const r = grade(f, 'r1');
  assert.equal(r.code, 0, r.err);
  const g = gradeOf(f, 'r1');
  assert.deepEqual(Object.keys(g), ['schema', 'iteration', 'model', 'commit', 'runs']);
  assert.equal(g.schema, 1);
  assert.equal(g.iteration, 'r1');
  assert.equal(g.model, STAMP.model);
  assert.equal(g.commit, STAMP.sourceAt);
  assert.deepEqual(Object.keys(g.runs).sort(), CASES.map((c: any) => c.key).sort(), 'every corpus case has a run entry');
  const a = CASES[0];
  assert.deepEqual(g.runs[a.key], { kind: 'review-miss', split: a.split, passRate: 1, excluded: null });
  assert.match(r.out, /graded 4 case/);
});

test('IC-009: tolerance is 3 lines either side; one line further is not found', (t) => {
  // expected 10-20, tolerance 3: window [7, 23]
  for (const [locator, want] of [['src/a.js:6-7', 1], ['src/a.js:5-6', 0], ['src/a.js:23', 1], ['src/a.js:24', 0], ['src/a.js:3,12', 1], ['src/a.js:3,30', 0]]) {
    assert.equal(gradeSingle(t, { severity: 'blocker', locator }).passRate, want, locator);
  }
});

/** C-6: one case, expected src/a.ts:50-52 blocker; returns the run entry for a single fake finding. */
function gradeA(t: any, finding: any) {
  const c = mkCase('005-b-1', { path: 'src/a.ts', startLine: 50, endLine: 52, severity: 'blocker' });
  const f = setup(t, [c]);
  const it = `it-${++seq}`;
  stamp(f, it);
  review(f, it, c.id, [finding]);
  const r = grade(f, it);
  assert.equal(r.code, 0, r.err);
  return gradeOf(f, it).runs[c.key];
}

test('C-6: a refuted converged finding does not count; open, fixed and user-accepted do', (t) => {
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:51', status: 'refuted' }).passRate, 0, 'refuted is a miss');
  for (const status of ['open', 'fixed', 'user-accepted']) {
    assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:51', status }).passRate, 1, status);
  }
});

test('C-6: a whole-file range is a miss; a range up to maxSpan lines is a span', (t) => {
  const { maxSpan } = CONFIG;
  assert.equal(maxSpan, 60);
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:1-99999' }).passRate, 0);
  assert.equal(gradeA(t, { severity: 'blocker', locator: `src/a.ts:1-${maxSpan + 1}` }).passRate, 0, 'maxSpan + 1 lines is too wide');
  assert.equal(gradeA(t, { severity: 'blocker', locator: `src/a.ts:1-${maxSpan}` }).passRate, 1, 'maxSpan lines still counts');
});

test('C-6: a comma list is separate points, a hit when any one point is inside the window', (t) => {
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:1,9999' }).passRate, 0, 'no point inside');
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:50,59' }).passRate, 1, 'one point inside');
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:1,56' }).passRate, 0, 'points 1 and 56: window is 47..55, the gap between them is not a span');
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:1,55' }).passRate, 1, 'tolerance still applies to a point');
});

/** N-4/N-5: one synthetic case of the given expected span; returns the run entry for a single fake finding. */
function gradeWide(t: any, expected: any, finding: any) {
  const c = mkCase('006-b-1', { path: 'src/w.ts', severity: 'blocker', ...expected });
  const f = setup(t, [c]);
  const it = `it-${++seq}`;
  stamp(f, it);
  review(f, it, c.id, [finding]);
  const r = grade(f, it);
  assert.equal(r.code, 0, r.err);
  return gradeOf(f, it).runs[c.key];
}

test('N-4: an exact re-report of an expected span wider than maxSpan is a hit (82 and 344 lines)', (t) => {
  for (const [startLine, endLine] of [[446, 527], [100, 443]]) {
    const locator = `src/w.ts:${startLine}-${endLine}`;
    assert.ok(endLine - startLine + 1 > CONFIG.maxSpan);
    assert.equal(gradeWide(t, { startLine, endLine }, { severity: 'blocker', locator }).passRate, 1, locator);
    assert.equal(gradeWide(t, { startLine, endLine }, { severity: 'blocker', locator: `src/w.ts:${startLine + 5}-${endLine - 5}` }).passRate, 1, 'a span inside it');
    assert.equal(gradeWide(t, { startLine, endLine }, { severity: 'blocker', locator: `src/w.ts:${startLine + 5}` }).passRate, 1, 'a point inside it');
  }
});

test('N-4: on a wide case a span is bounded by expected width + 2 * tolerance, not by maxSpan', (t) => {
  // expected 100-199 (100 lines), tolerance 3: allowedWidth 106, window [97, 202]
  const expected: any = { startLine: 100, endLine: 199 };
  const w = (locator: any) => gradeWide(t, expected, { severity: 'blocker', locator }).passRate;
  assert.equal(w('src/w.ts:97-202'), 1, '106 lines is within allowedWidth although wider than maxSpan');
  assert.equal(w('src/w.ts:96-202'), 0, '107 lines is wider than allowedWidth');
  assert.equal(w('src/w.ts:1-9999'), 0, 'a whole-file range is still a miss');
});

test('N-5: a comma list is bounded by its extent; a 200-point list is a miss', (t) => {
  const points = Array.from({ length: 200 }, (_, i) => 1 + i * 7);
  assert.ok(points.includes(50) && points[199] === 1394);
  assert.equal(gradeA2(t, `src/a.ts:${points.join(',')}`), 0, '200 points over 1..1394 hold a point in the window and are still a miss');
  assert.equal(gradeA2(t, 'src/a.ts:50,9999'), 0, 'extent 9950 is wider than allowedWidth');
  assert.equal(gradeA2(t, 'src/a.ts:50,100'), 1, 'extent 51 is within it');
  assert.equal(gradeA2(t, 'src/a.ts:50,110'), 0, 'extent 61 is not');
});

/** N-5 helper: the 50-52 case, one locator, returns passRate. */
const gradeA2 = (t: any, locator: any) => gradeA(t, { severity: 'blocker', locator }).passRate;

test('C-6 controls: another path and a distant line stay a miss', (t) => {
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/other.ts:51' }).passRate, 0);
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:200' }).passRate, 0);
  assert.equal(gradeA(t, { severity: 'blocker', locator: 'src/a.ts:51' }).passRate, 1);
});

test('IC-009: a lower severity than expected is not found, an equal or higher one is', (t) => {
  assert.equal(gradeSingle(t, { severity: 'should-fix', locator: 'src/a.js:12' }).passRate, 0);
  assert.equal(gradeSingle(t, { severity: 'note', locator: 'src/a.js:12' }).passRate, 0);
  assert.equal(gradeSingle(t, { severity: 'blocker', locator: 'src/a.js:12' }).passRate, 1);
  const f = setup(t);
  stamp(f, 'sev');
  review(f, 'sev', '002-s-1', [{ severity: 'blocker', locator: 'src/b.js:5' }]);
  assert.equal(grade(f, 'sev').code, 0);
  assert.equal(runOf(f, 'sev', '002-s-1').passRate, 1, 'a blocker satisfies an expected should-fix');
});

test('IC-009: a finding on another path or an unparseable locator is not found', (t) => {
  assert.equal(gradeSingle(t, { severity: 'blocker', locator: 'src/other.js:12' }).passRate, 0);
  assert.equal(gradeSingle(t, { severity: 'blocker', locator: 'src/a.js' }).passRate, 0);
});

test('IC-009: no findings.json, or one that fails validateFindings, is malformed with a null passRate', (t) => {
  const f = setup(t);
  stamp(f, 'm');
  review(f, 'm', '001-b-1', null);
  review(f, 'm', '002-s-1', { schema: 2, row: '002' });
  fs.mkdirSync(path.join(f.runRoot, 'm', '003-b-1'));
  assert.equal(grade(f, 'm').code, 0);
  for (const id of ['001-b-1', '002-s-1', '003-b-1', '004-b-1']) {
    const entry = runOf(f, 'm', id);
    assert.equal(entry.passRate, null, id);
    assert.equal(entry.excluded, 'malformed', id);
  }
});

test('IC-009: a run_status.json infra class excludes the case even when findings were written', (t) => {
  const timed = gradeSingle(t, { severity: 'blocker', locator: 'src/a.js:12' }, { status: 'timeout' });
  assert.deepEqual([timed.passRate, timed.excluded], [null, 'timeout']);
  const api = gradeSingle(t, { severity: 'blocker', locator: 'src/a.js:12' }, { status: 'api-error' });
  assert.deepEqual([api.passRate, api.excluded], [null, 'api-error']);
  const done = gradeSingle(t, { severity: 'blocker', locator: 'src/a.js:12' }, { status: 'completed' });
  assert.deepEqual([done.passRate, done.excluded], [1, null], 'completed is graded');
  const junk = gradeSingle(t, { severity: 'blocker', locator: 'src/a.js:12' }, '{not json');
  assert.deepEqual([junk.passRate, junk.excluded], [null, 'malformed'], 'an unreadable status is never scored');
});

test('IC-009: refusals exit 2 and write no grade.json (case dir outside the corpus, no stamp, bad corpus, stale key)', (t) => {
  const f = setup(t);
  stamp(f, 'x');
  review(f, 'x', '001-b-1', [{ severity: 'blocker', locator: 'src/a.js:12' }]);
  fs.mkdirSync(path.join(f.runRoot, 'x', '999-stale'));
  let r = grade(f, 'x');
  assert.equal(r.code, 2);
  assert.match(r.err, /999-stale/);
  assert.equal(fs.existsSync(path.join(f.runRoot, 'x', 'grade.json')), false);

  fs.mkdirSync(path.join(f.runRoot, 'nostamp'));
  r = grade(f, 'nostamp');
  assert.equal(r.code, 2);
  assert.match(r.err, /iteration\.json/);

  r = run(f, ['grade', '--iteration', 'x', '--corpus', path.join(f.root, 'absent.json')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /corpus/);

  const notJson = path.join(f.root, 'bad.json');
  fs.writeFileSync(notJson, '{');
  assert.equal(run(f, ['grade', '--iteration', 'x', '--corpus', notJson]).code, 2);

  // A corpus whose truth changed after its key was made would mix truths: refused.
  const moved = JSON.parse(fs.readFileSync(f.corpusFile, 'utf8'));
  moved.cases[0].expected.endLine = 99;
  const movedFile = path.join(f.root, 'moved.json');
  fs.writeFileSync(movedFile, JSON.stringify(moved));
  fs.rmSync(path.join(f.runRoot, 'x', '999-stale'), { recursive: true });
  r = run(f, ['grade', '--iteration', 'x', '--corpus', movedFile]);
  assert.equal(r.code, 2);
  assert.match(r.err, /001-b-1/);

  assert.equal(run(f, ['grade', '--iteration', '../escape', '--corpus', f.corpusFile]).code, 2, 'an iteration name is one path segment');
  assert.equal(run(f, ['grade']).code, 2, '--iteration is required');
  assert.equal(run(f, ['grade', '--iteration', 'x', '--bogus']).code, 2, 'an unknown flag is refused');
});

/** Writes iteration `name` where `hits` of the four cases are found; the rest are not. */
function iterate(f: any, name: any, hits: any, meta: any = STAMP) {
  stamp(f, name, meta);
  const hit: any = { '001-b-1': 'src/a.js:12', '002-s-1': 'src/b.js:5', '003-b-1': 'src/c.js:1', '004-b-1': 'src/d.js:8' };
  for (const id of Object.keys(hit)) {
    review(f, name, id, [{ severity: 'blocker', locator: hits.includes(id) ? hit[id] : 'src/nowhere.js:1' }]);
  }
  const r = grade(f, name);
  assert.equal(r.code, 0, r.err);
}

const TWO: any = ['001-b-1', '002-s-1'];

test('IC-010: three equal grade repeats go through noise (computeNoise verdict usable, exit 0) and write the 096 artifact', (t) => {
  const f = setup(t);
  for (const n of ['n-r1', 'n-r2', 'n-r3']) iterate(f, n, TWO);
  const outFile = path.join(f.root, 'noise.json');
  const r = run(f, ['noise', '--iterations', 'n-r1,n-r2,n-r3', '--out', outFile]);
  assert.equal(r.code, 0, r.err);
  const noise = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(noise.kind, 'bench-noise');
  assert.equal(noise.verdict, 'usable');
  assert.ok(NOISE_VERDICTS.includes(noise.verdict));
  assert.equal(noise.k, 3);
  assert.equal(noise.model, STAMP.model);
  assert.equal(noise.commit, STAMP.sourceAt);
  assert.deepEqual(noise.caseKeys, CASES.map((c: any) => c.key).sort());
  assert.match(r.out, /verdict: usable/);
  const json = run(f, ['noise', '--iterations', 'n-r1,n-r2,n-r3', '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out).verdict, 'usable');
});

test('IC-010: repeats that differ by more than the mde give another verdict and exit 1', (t) => {
  const f = setup(t);
  iterate(f, 'v-r1', TWO);
  iterate(f, 'v-r2', ['001-b-1']);
  iterate(f, 'v-r3', TWO);
  const r = run(f, ['noise', '--iterations', 'v-r1,v-r2,v-r3']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /verdict: noise-exceeds-mde/);
});

test('IC-010: noise refuses (exit 2) differing model or commit or key sets, too few repeats, an ungraded or unknown iteration', (t) => {
  const f = setup(t);
  iterate(f, 'a-r1', TWO);
  iterate(f, 'a-r2', TWO);
  iterate(f, 'a-r3', TWO);
  iterate(f, 'other-model', TWO, { ...STAMP, model: 'claude-other' });
  iterate(f, 'other-commit', TWO, { ...STAMP, sourceAt: 'd'.repeat(40) });
  let r = run(f, ['noise', '--iterations', 'a-r1,a-r2,other-model']);
  assert.equal(r.code, 2);
  assert.match(r.err, /model/);
  r = run(f, ['noise', '--iterations', 'a-r1,a-r2,other-commit']);
  assert.equal(r.code, 2);
  assert.match(r.err, /commit/);

  // A repeat graded against another corpus has other keys.
  const smaller = setup(t, CASES.slice(0, 3));
  const fewer: any = { ...smaller, runRoot: f.runRoot };
  stamp(f, 'keys');
  for (const c of CASES.slice(0, 3)) review(f, 'keys', c.id, [{ severity: 'blocker', locator: 'src/x.js:1' }]);
  assert.equal(run(fewer, ['grade', '--iteration', 'keys', '--corpus', smaller.corpusFile]).code, 0);
  r = run(f, ['noise', '--iterations', 'a-r1,a-r2,keys']);
  assert.equal(r.code, 2);
  assert.match(r.err, /case/);

  assert.equal(run(f, ['noise', '--iterations', 'a-r1,a-r2']).code, 2, 'fewer than k repeats');
  assert.equal(run(f, ['noise', '--iterations', 'a-r1,a-r1,a-r2']).code, 2, 'a repeated iteration');
  assert.equal(run(f, ['noise', '--iterations', 'a-r1,a-r2,absent']).code, 2, 'an unknown iteration');
  stamp(f, 'ungraded');
  assert.equal(run(f, ['noise', '--iterations', 'a-r1,a-r2,ungraded']).code, 2, 'an iteration without grade.json');
  assert.equal(run(f, ['noise']).code, 2, '--iterations is required');
});

test('IC-010: report without a noise band is inconclusive with no-noise-band and exits 0', (t) => {
  const f = setup(t);
  iterate(f, 'c-r1', TWO);
  const decisionFile = path.join(f.root, 'decision.json');
  const r = run(f, ['report', '--iterations', 'c-r1', '--decision-out', decisionFile]);
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  assert.equal(d.kind, 'bench-decision');
  assert.equal(d.verdict, 'inconclusive');
  assert.equal(d.corpus.reason, 'no-noise-band');
  assert.match(r.out, /inconclusive/);
  assert.match(r.out, /no-noise-band/);
  assert.match(r.out, /review-miss noise/, 'the output names the command that makes the band');
  const json = run(f, ['report', '--iterations', 'c-r1', '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out).decision.corpus.reason, 'no-noise-band');
});

test('IC-010: report against a usable band reads it (precondition none) and refuses a missing noise file', (t) => {
  const f = setup(t);
  for (const n of ['b-r1', 'b-r2', 'b-r3']) iterate(f, n, TWO);
  iterate(f, 'cand-r1', ['001-b-1', '002-s-1', '003-b-1']);
  const noiseFile = path.join(f.root, 'noise.json');
  assert.equal(run(f, ['noise', '--iterations', 'b-r1,b-r2,b-r3', '--out', noiseFile]).code, 0);
  const r = run(f, ['report', '--iterations', 'cand-r1', '--noise', noiseFile, '--json']);
  assert.equal(r.code, 0, r.err);
  const { decision } = JSON.parse(r.out);
  assert.equal(decision.precondition, null);
  assert.equal(decision.inputs.noiseArtifact.verdict, 'usable');
  assert.notEqual(decision.corpus.reason, 'no-noise-band');

  assert.equal(run(f, ['report', '--iterations', 'cand-r1', '--noise', path.join(f.root, 'absent.json')]).code, 2);
  // A band measured on another model is a precondition, not a score.
  iterate(f, 'foreign-r1', TWO, { ...STAMP, model: 'claude-other' });
  const mismatch = run(f, ['report', '--iterations', 'foreign-r1', '--noise', noiseFile, '--json']);
  assert.equal(mismatch.code, 0);
  assert.equal(JSON.parse(mismatch.out).decision.precondition, 'noise-model-mismatch');
  assert.equal(run(f, ['report']).code, 2, '--iterations is required');
});

test('IC-009/IC-010: an unknown verb or flag is exit 2', (t) => {
  const f = setup(t);
  assert.equal(run(f, []).code, 2);
  assert.equal(run(f, ['score']).code, 2);
  assert.equal(run(f, ['report', '--iterations', 'x', '--bogus']).code, 2);
});

test('NFR-002 / IC-010: bench/runner.ts forwards review-miss grade to the suite', (t) => {
  const f = setup(t);
  const origErr = process.stderr.write;
  const seen: any = [];
  process.stderr.write = (m) => { seen.push(String(m)); return true; };
  let code;
  try {
    // No such iteration under the checkout's own runs: the forward reaches the grade verb and refuses it.
    code = benchRunner.main(['review-miss', 'grade', '--iteration', 'no-such-iteration-095b', '--corpus', f.corpusFile]);
  } finally {
    process.stderr.write = origErr;
  }
  assert.equal(code, 2);
  assert.match(seen.join(''), /review-miss grade: no iteration at .*no-such-iteration-095b/);
});

test('NFR-002: every verb ran under the child_process stub and spawned nothing but read-only git', () => {
  for (const s of recordedSpawns) {
    assert.equal(s.cmd, 'git', `spawn must be git, got ${s.cmd}`);
    assert.ok(READ_ONLY_GIT.includes(s.args[0]), `git subcommand must be read-only, got ${s.args[0]}`);
  }
  assert.deepEqual(recordedSpawns, [], 'grade, noise and report need no subprocess at all');
});

test('NFR-002 negative control: the stub turns a spawn of node or a git write red', () => {
  const before = recordedSpawns.length;
  assert.throws(() => cp.spawnSync('node', ['--version']), /Forbidden spawn: expected git, got node/);
  assert.throws(() => cp.execFileSync('node', ['-e', '1']), /Forbidden spawn: expected git, got node/);
  assert.throws(() => cp.spawnSync('git', ['push', 'origin', 'main']), /Forbidden git subcommand/);
  recordedSpawns.length = before;
});
