'use strict';

/**
 * Offline fixture tests for bench/runner.js behaviour: parity classification and report rows.
 *
 * Every input is data built in this file. Nothing here dispatches a run, calls a model, or writes
 * under the checkout's bench/baseline, bench/runs or bench/reports; the runner functions under test
 * take the baseline and the results as arguments for exactly that reason.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createScratch } = require('../helper/scratch-env');

const scratch = createScratch('doflow-bench-runner-');
// The runner reads git state in-process; node --test gives each file its own process, so applying
// the scratch environment here keeps every call off the developer's HOME and git config.
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});

const runner = require('../../bench/runner.js');

const entry = (key, name, kind, split) => {
  const [skill, id] = key.split('/');
  return { key, skill, evalId: Number(id), name, kind, split };
};
const corpusOf = (...entries) => new Map(entries.map((e) => [e.key, e]));
const result = (key, name, kind, split, extra = {}) => {
  const [skill, id] = key.split('/');
  return { key, skill, evalId: Number(id), evalName: name, kind, passRate: 1, sourceStatus: 'verified', ...(split ? { split } : {}), ...extra };
};

const CEILING = { unit: 'total_tokens', maxTokensPerRun: 1000 };

const ONE = entry('s/1', 'one', 'triggering', 'train');
const TWO = entry('s/2', 'two', 'behavioral', 'train');
const baseline = (results, caseCount = results.length) => ({ caseCount, results });
const BASE = baseline([result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train')]);

test('F2: parity is ok when corpus and baseline are identical', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), BASE);
  assert.equal(p.ok, true);
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.missingFromCorpus, []);
  assert.deepEqual(p.changed, []);
  assert.equal(p.countMismatch, null);
});

test('F2: an added case is pending and never affects ok', () => {
  const added = entry('s/3', 'three', 'triggering', 'heldout');
  const p = runner.compareParity(corpusOf(ONE, TWO, added), BASE);
  assert.equal(p.ok, true);
  assert.deepEqual(p.pending, [added]);
});

test('F2: a removed case fails and is named', () => {
  const p = runner.compareParity(corpusOf(ONE), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.missingFromCorpus.map((c) => c.key), ['s/2']);
  assert.deepEqual(p.pending, []);
});

test('F2: a renamed case is one change, not a removal plus a pending case', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, name: 'renamed' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
  assert.deepEqual(p.missingFromCorpus, []);
  assert.deepEqual(p.pending, []);
  assert.equal(p.changed[0].corpus.name, 'renamed');
  assert.equal(p.changed[0].baseline.name, 'two');
});

test('F2: a kind change fails', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, kind: 'triggering' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
});

test('F2: a split change fails when the baseline recorded a split', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, split: 'heldout' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
  assert.equal(p.changed[0].corpus.split, 'heldout');
  assert.equal(p.changed[0].baseline.split, 'train');
});

test('F2: a baseline without split is never compared on split', () => {
  const old = baseline([result('s/1', 'one', 'triggering'), result('s/2', 'two', 'behavioral')]);
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, split: 'heldout' }), old);
  assert.equal(p.ok, true);
  assert.deepEqual(p.changed, []);
});

test('F2: a caseCount that disagrees with the entries fails', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), baseline(BASE.results, 3));
  assert.equal(p.ok, false);
  assert.deepEqual(p.countMismatch, { baselineCaseCount: 3, baselineEntries: 2 });
});

test('F2: a missing baseline fails with a note and lists every case as pending', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), null, 'bench/baseline/baseline.json');
  assert.equal(p.ok, false);
  assert.equal(p.countMismatch.note, 'no baseline at bench/baseline/baseline.json');
  assert.equal(p.pending.length, 2);
});

test('F2: parity text names each pending case and exits through ok', () => {
  const added = entry('s/3', 'three', 'triggering', 'heldout');
  const lines = runner.parityLines(runner.compareParity(corpusOf(ONE, TWO, added), BASE));
  assert.deepEqual(lines, [
    'PENDING s/3 (triggering, heldout: three) awaits a paid baseline capture and has no baseline result',
    'ok  the committed baseline describes the committed corpus; 1 case(s) pending',
  ]);
  assert.deepEqual(runner.parityLines(runner.compareParity(corpusOf(ONE, TWO), BASE)),
    ['ok  the committed baseline describes the committed corpus']);
});

test('F2: parity text keeps the GAP lines for a removed case and repeats identically', () => {
  const p = runner.compareParity(corpusOf(ONE), BASE);
  const lines = runner.parityLines(p);
  assert.match(lines[0], /^GAP s\/2 is in the baseline but not in the corpus \(behavioral: two\)$/);
  assert.match(lines[lines.length - 1], /re-capture the baseline/);
  assert.deepEqual(runner.parityLines(runner.compareParity(corpusOf(ONE), BASE)), lines);
});

test('F6: a case with no baseline result is a pending row, and the note counts them', () => {
  const cfg = { model: 'm', costCeiling: CEILING };
  const report = runner.buildReport({
    baseline: { commit: 'abc', model: 'm', results: [result('s/1', 'one', 'triggering', 'train')] },
    withResults: [result('s/1', 'one', 'triggering', 'train'), result('s/3', 'three', 'triggering', 'heldout')],
    cfg, iteration: 'it', commit: 'def',
  });
  assert.deepEqual(report.rows.map((r) => [r.key, r.status]), [['s/1', 'unchanged'], ['s/3', 'pending']]);
  assert.equal(report.summary.pending, 1);
  assert.equal('new' in report.summary, false);
  assert.equal(report.pendingNote, '1 case(s) are pending: they await a paid baseline capture and carry no baseline result');
  assert.equal(report.rows[1].baseline, null);
  assert.equal(report.rows[1].delta, null);
  assert.equal(report.rows[1].sourceComparable, false);
});

test('F6: pendingNote is null when no row is pending, and repeated calls are equal', () => {
  const input = {
    baseline: { commit: 'abc', model: 'm', results: [result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train', { passRate: 0.5 })] },
    withResults: [result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train', { passRate: 1 })],
    cfg: { model: 'm', costCeiling: CEILING }, iteration: 'it', commit: 'def',
  };
  const report = runner.buildReport(input);
  assert.equal(report.pendingNote, null);
  assert.equal(report.summary.pending, 0);
  assert.equal(report.summary.improved, 1);
  assert.deepEqual(runner.buildReport(input), report);
});

// --- skill_not_routed (F1, with-skill rows) ---------------------------------------------------

function routingRun(name, routingText) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.txt'), 'ran');
  if (routingText !== null) fs.writeFileSync(path.join(dir, runner.RUN_ROUTING_FILE), routingText);
  return runner.loadRunContext(dir);
}
const NOT_ROUTED = { text: 'x is not used', type: 'skill_not_routed', skill: 'x' };

test('F1: routing.json {routed:false} for the skill passes', () => {
  const g = runner.gradeAssertion(NOT_ROUTED, routingRun('false', '{"skill":"x","routed":false,"reason":"belongs to y"}'));
  assert.equal(g.passed, true);
  assert.equal(g.evidence, 'routing.json: x not routed');
});

test('F1: routing.json {routed:true} fails with the routed evidence', () => {
  const g = runner.gradeAssertion(NOT_ROUTED, routingRun('true', '{"skill":"x","routed":true}'));
  assert.equal(g.passed, false);
  assert.equal(g.evidence, 'routing.json: x routed, the request should not route here');
});

test('F1: an absent routing.json fails and never passes vacuously', () => {
  const ctx = routingRun('absent', null);
  assert.equal(ctx.routing, null);
  const g = runner.gradeAssertion(NOT_ROUTED, ctx);
  assert.equal(g.passed, false);
  assert.match(g.evidence, /no routing\.json saved/);
});

test('F1: a malformed, non-boolean or wrong-skill routing.json fails with its own fault', () => {
  const malformed = routingRun('malformed', '{not json');
  assert.deepEqual(malformed.routing, { malformed: true });
  const cases = [
    [malformed, /not a JSON object/],
    [routingRun('array', '[]'), /not a JSON object/],
    [routingRun('nonbool', '{"skill":"x","routed":"false"}'), /no boolean routed/],
    [routingRun('wrong', '{"skill":"y","routed":false}'), /records skill "y", not x/],
  ];
  for (const [ctx, fault] of cases) {
    const g = runner.gradeAssertion(NOT_ROUTED, ctx);
    assert.equal(g.passed, false);
    assert.match(g.evidence, fault);
  }
});

test('F1: skill_not_routed is a known assertion type', () => {
  assert.ok(runner.ASSERTION_TYPES.includes('skill_not_routed'));
  assert.deepEqual(runner.SPLITS, ['train', 'heldout']);
});

test('F1: a triggering plan run asks for routing.json and saves it; a behavioral run does not', () => {
  const plan = runner.buildPlan(runner.loadConfig(), { iteration: 'fixture' });
  const triggering = plan.runs.filter((r) => r.kind === 'triggering');
  const behavioral = plan.runs.filter((r) => r.kind === 'behavioral');
  assert.ok(triggering.length > 0 && behavioral.length > 0);
  for (const r of triggering) {
    assert.ok(r.saveOutputs.includes('routing.json'), `${r.skill}/${r.evalId} does not save routing.json`);
    assert.ok(r.skills.instruction.includes(`Write the decision to routing.json as {"skill": "${r.skill}", "routed": true or false}.`));
    assert.match(r.skills.instruction, /Do NOT invoke/);
  }
  for (const r of behavioral) {
    assert.equal(r.saveOutputs.includes('routing.json'), false);
    assert.equal(r.skills.instruction.includes('routing.json'), false);
  }
});

// --- split on plan and list (F4, split part) --------------------------------------------------

const RUNNER = path.resolve(__dirname, '../../bench/runner.js');
function runCli(...args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: scratch.env() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function corpusCases() {
  const cfg = runner.loadConfig();
  return runner.discoverSkills(cfg).flatMap((skill) => (runner.loadCases(cfg, skill) || { evals: [] }).evals.map((e) => ({ skill, ...e })));
}

test('F4: every corpus case carries a valid side', () => {
  for (const c of corpusCases()) assert.ok(runner.SPLITS.includes(c.split), `${c.skill}/${c.id}: split ${c.split}`);
});

test('F4: plan --split heldout holds only held-out cases; a bare plan holds both sides', () => {
  const cfg = runner.loadConfig();
  const cases = corpusCases();
  const heldout = cases.filter((c) => c.split === 'heldout');
  const train = cases.filter((c) => c.split === 'train');
  assert.ok(heldout.length > 0 && train.length > 0);

  const bare = runner.buildPlan(cfg, { iteration: 'fixture' });
  assert.equal(bare.runCount, cases.length);
  assert.deepEqual([...new Set(bare.runs.map((r) => r.split))].sort(), ['heldout', 'train']);

  const held = runner.buildPlan(cfg, { iteration: 'fixture', split: 'heldout' });
  assert.equal(held.runCount, heldout.length);
  assert.ok(held.runs.every((r) => r.split === 'heldout'));
  assert.deepEqual(held.runs.map((r) => `${r.skill}/${r.evalId}`), heldout.map((c) => `${c.skill}/${c.id}`));

  const trained = runner.buildPlan(cfg, { iteration: 'fixture', split: 'train' });
  assert.equal(trained.runCount, train.length);
  assert.ok(trained.runs.every((r) => r.split === 'train'));
});

test('F4: list rows carry the side, in both forms, and --split filters them', () => {
  const heldout = corpusCases().filter((c) => c.split === 'heldout');
  const json = runCli('list', '--split', 'heldout', '--json');
  assert.equal(json.status, 0);
  const rows = JSON.parse(json.stdout);
  assert.deepEqual(rows.map((r) => `${r.skill}/${r.id}`), heldout.map((c) => `${c.skill}/${c.id}`));
  assert.ok(rows.every((r) => r.split === 'heldout'));

  const text = runCli('list', '--skill', 'do-git');
  assert.equal(text.status, 0);
  const first = corpusCases().find((c) => c.skill === 'do-git');
  assert.ok(text.stdout.split('\n').includes(`do-git/${first.id} [${first.kind}, ${first.split}] ${first.name}`));
});

test('F4: an invalid --split value, or --split on another command, exits 2 with the stated message', () => {
  const bad = runCli('plan', '--iteration', 'x', '--split', 'validation');
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr.trim(), 'bench: --split must be train or heldout');
  assert.equal(bad.stdout, '');

  const missing = runCli('plan', '--iteration', 'x', '--split');
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr.trim(), 'bench: --split must be train or heldout');

  for (const cmd of ['coverage', 'grade', 'report', 'baseline', 'parity']) {
    const other = runCli(cmd, '--split', 'heldout');
    assert.equal(other.status, 2, cmd);
    assert.equal(other.stderr.trim(), `bench ${cmd}: --split is not accepted`);
  }
});

// --- usage capture (F3, F6 usage part, F7 with-skill part) -------------------------------------

function timingRun(name, timingText) {
  const dir = path.join(scratch.dir, `timing-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  if (timingText !== null) fs.writeFileSync(path.join(dir, runner.RUN_TIMING_FILE), timingText);
  return runner.readUsage(dir);
}

test('F3: a timing.json with both fields valid is recorded', () => {
  const u = timingRun('recorded', '{"total_tokens": 1200, "duration_ms": 3400.5, "extra": true}');
  assert.deepEqual(u, { total_tokens: 1200, duration_ms: 3400.5, status: 'recorded', evidence: 'timing.json: 1200 total_tokens, 3400.5 ms' });
});

test('F3: one valid field is partial and the other is null, never 0', () => {
  const noDuration = timingRun('partial-a', '{"total_tokens": 50}');
  assert.equal(noDuration.status, 'partial');
  assert.equal(noDuration.total_tokens, 50);
  assert.equal(noDuration.duration_ms, null);
  const noTokens = timingRun('partial-b', '{"total_tokens": -1, "duration_ms": 10}');
  assert.equal(noTokens.status, 'partial');
  assert.equal(noTokens.total_tokens, null);
  assert.equal(noTokens.duration_ms, 10);
  assert.equal(timingRun('partial-c', '{"total_tokens": 1.5, "duration_ms": "9"}').status, 'invalid');
});

test('F3: a file in another tool\'s shape is invalid, and malformed or absent files are unknown', () => {
  const foreign = timingRun('foreign', '{"total_duration_seconds": 12.3, "executor_start": "2026-10-06"}');
  assert.equal(foreign.status, 'invalid');
  assert.equal(foreign.total_tokens, null);
  assert.equal(foreign.duration_ms, null);
  for (const [name, text] of [['array', '[1,2]'], ['null', 'null'], ['number', '7']]) {
    assert.equal(timingRun(name, text).status, 'invalid', name);
  }
  const malformed = timingRun('malformed', '{not json');
  assert.deepEqual([malformed.status, malformed.total_tokens, malformed.duration_ms], ['malformed', null, null]);
  const absent = timingRun('absent', null);
  assert.deepEqual([absent.status, absent.total_tokens, absent.duration_ms], ['unrecorded', null, null]);
  assert.match(absent.evidence, /no timing\.json saved/);
});

test('F3: summarizeUsage sums known values, counts unknowns and is repeatable', () => {
  const usages = [
    { total_tokens: 100, duration_ms: 10 },
    { total_tokens: null, duration_ms: 20 },
    { total_tokens: 0, duration_ms: null },
    { total_tokens: null, duration_ms: null },
  ];
  const summary = runner.summarizeUsage(usages);
  assert.deepEqual(summary, { knownTokens: 100, knownTokenRuns: 2, unknownTokenRuns: 2, knownDurationMs: 30, knownDurationRuns: 2, unknownDurationRuns: 2 });
  assert.deepEqual(runner.summarizeUsage(usages), summary);
  assert.deepEqual(runner.summarizeUsage([]), { knownTokens: 0, knownTokenRuns: 0, unknownTokenRuns: 0, knownDurationMs: 0, knownDurationRuns: 0, unknownDurationRuns: 0 });
});

test('F3: every planned run is told to save timing.json', () => {
  const plan = runner.buildPlan(runner.loadConfig(), { iteration: 'fixture' });
  for (const r of plan.runs) assert.ok(r.saveOutputs.includes('timing.json'), `${r.skill}/${r.evalId}`);
});

test('F6: report rows and totals carry usage, and an unknown run stays unknown', () => {
  const withUsage = (key, name, total_tokens, duration_ms) =>
    result(key, name, 'triggering', 'train', { usage: { total_tokens, duration_ms } });
  const input = {
    baseline: { commit: 'abc', model: 'm', results: [result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'triggering', 'train')] },
    withResults: [withUsage('s/1', 'one', 900, 40), withUsage('s/2', 'two', null, null), result('s/3', 'three', 'triggering', 'heldout')],
    cfg: { model: 'm', costCeiling: CEILING }, iteration: 'it', commit: 'def',
  };
  const report = runner.buildReport(input);
  assert.deepEqual(report.rows.map((r) => r.usage), [
    { total_tokens: 900, duration_ms: 40 },
    { total_tokens: null, duration_ms: null },
    { total_tokens: null, duration_ms: null },
  ]);
  assert.deepEqual(report.rows.map((r) => r.split), ['train', 'train', 'heldout']);
  assert.deepEqual(report.usage.withSkill, { knownTokens: 900, knownTokenRuns: 1, unknownTokenRuns: 2, knownDurationMs: 40, knownDurationRuns: 1, unknownDurationRuns: 2 });
  assert.deepEqual(report.usage.withoutSkill, runner.summarizeUsage([]));
  assert.deepEqual(runner.buildReport(input), report);
});

// A graded fixture iteration lives under a temporary runs root, and the baseline, the report and the
// reports directory are redirected there too, so nothing is written beside the checkout's bench/.
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const out = [];
  const err = [];
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => err.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const status = fn();
    return { status, out: out.join('\n'), err: err.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

function gradedFixture(name) {
  const cfg = { ...runner.loadConfig(), reportsDir: path.join(scratch.dir, name, 'reports') };
  const runsRoot = path.join(scratch.dir, name, 'runs');
  const baselineFile = path.join(scratch.dir, name, 'baseline', 'baseline.json');
  const [first, second] = runner.loadCases(cfg, 'do-git').evals;
  const runDir = (e) => path.join(runsRoot, 'it', 'do-git', `eval-${e.id}-${e.name}`);
  for (const e of [first, second]) {
    fs.mkdirSync(runDir(e), { recursive: true });
    fs.writeFileSync(path.join(runDir(e), 'transcript.txt'), 'ran');
  }
  fs.writeFileSync(path.join(runDir(first), 'timing.json'), '{"total_tokens": 1500, "duration_ms": 90}');
  return { cfg, runsRoot, baselineFile, first, second, runDir, opts: { iteration: 'it', runsRoot, baselineFile } };
}

test('F7: grade records split and usage, and the summary counts the unknown runs', () => {
  const f = gradedFixture('f7-grade');
  const run = quiet(() => runner.cmdGrade(f.cfg, f.opts));
  assert.equal(run.status, 0);
  assert.match(run.out, /graded 2 run\(s\); \d+ assertion\(s\) left for the grader subagent; usage unknown for 1 run\(s\)/);
  const g1 = JSON.parse(fs.readFileSync(path.join(f.runDir(f.first), 'grading.json'), 'utf8'));
  const g2 = JSON.parse(fs.readFileSync(path.join(f.runDir(f.second), 'grading.json'), 'utf8'));
  assert.equal(g1.split, f.first.split);
  assert.deepEqual(g1.usage, { total_tokens: 1500, duration_ms: 90, status: 'recorded', evidence: 'timing.json: 1500 total_tokens, 90 ms' });
  assert.equal(g2.usage.status, 'unrecorded');
  assert.equal(g2.usage.total_tokens, null);
});

test('F7: baseline writes split, usage and usageSummary, and report prints the tokens column', () => {
  const f = gradedFixture('f7-baseline');
  quiet(() => runner.cmdGrade(f.cfg, f.opts));
  const base = quiet(() => runner.cmdBaseline(f.cfg, { from: 'it', runsRoot: f.runsRoot, baselineFile: f.baselineFile }));
  assert.equal(base.status, 0);
  const written = JSON.parse(fs.readFileSync(f.baselineFile, 'utf8'));
  assert.equal(written.caseCount, 2);
  assert.deepEqual(written.results.map((r) => [r.key, r.split, r.usage]), [
    [`do-git/${f.first.id}`, f.first.split, { total_tokens: 1500, duration_ms: 90 }],
    [`do-git/${f.second.id}`, f.second.split, { total_tokens: null, duration_ms: null }],
  ]);
  assert.equal(written.usageSummary.withSkill.knownTokens, 1500);
  assert.equal(written.usageSummary.withSkill.unknownTokenRuns, 1);

  const rep = quiet(() => runner.cmdReport(f.cfg, f.opts));
  assert.equal(rep.status, 0);
  assert.match(rep.out, /\| case \| kind \| split \| baseline \| current \| delta \| status \| source \| tokens \|/);
  assert.match(rep.out, new RegExp(`\\| do-git/${f.first.id} \\|.*\\| 1500 \\|`));
  assert.match(rep.out, new RegExp(`\\| do-git/${f.second.id} \\|.*\\| unknown \\|`));
  assert.match(rep.out, /usage: 1500 total_tokens over 1 run\(s\); unknown for 1 run\(s\)/);
  assert.ok(fs.existsSync(path.join(f.cfg.reportsDir, 'it-vs-baseline.json')));
});

test('F7: the committed baseline, which predates split and usage, still reads as ok', () => {
  const parity = runner.baselineParity(runner.loadConfig());
  assert.equal(parity.ok, true);
});

// --- token ceiling (F5, F6 ceiling part) -------------------------------------------------------

function ceilingFixture(name, usageByCase) {
  const base = runner.loadConfig();
  const ids = runner.loadCases(base, 'do-git').evals.map((e) => e.id);
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const results = ids.flatMap((id, i) => (usageByCase[i] === undefined ? [] : [{ key: `do-git/${id}`, usage: { total_tokens: usageByCase[i], duration_ms: null } }]));
  const baselineFile = path.join(dir, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify({ results }));
  const planOf = (maxTokensPerRun, file = baselineFile) => runner.buildPlan(
    { ...base, costCeiling: { unit: 'total_tokens', maxTokensPerRun } },
    { iteration: 'it', skill: 'do-git', baselineFile: file },
  );
  return { base, ids, baselineFile, planOf };
}

test('F5: a known projection within the budget is not breached', () => {
  const f = ceilingFixture('f5-within', [100, 200, 300]);
  const c = f.planOf(1000).costCeiling;
  assert.deepEqual([c.budget, c.projectedKnownTokens, c.projectedUnknownRuns, c.breached], [3000, 600, 0, false]);
  assert.equal(c.unit, 'total_tokens');
  assert.equal(c.maxTokensPerRun, 1000);
  assert.match(c.enforcement, /stops dispatching once the recorded total_tokens of this iteration reach budget/);
});

test('F5: a known projection over the budget is breached, even with unknown runs', () => {
  assert.equal(ceilingFixture('f5-over', [100, 200, 300]).planOf(100).costCeiling.breached, true);
  const partial = ceilingFixture('f5-over-partial', [500]).planOf(100).costCeiling;
  assert.deepEqual([partial.projectedKnownTokens, partial.projectedUnknownRuns, partial.breached], [500, 2, true]);
});

test('F5: unknown runs that leave the known total within the budget make the result null', () => {
  const f = ceilingFixture('f5-unknown', [50]);
  const c = f.planOf(100).costCeiling;
  assert.deepEqual([c.projectedKnownTokens, c.projectedUnknownRuns, c.breached], [50, 2, null]);
  const missing = f.planOf(100, path.join(scratch.dir, 'no-such-baseline.json')).costCeiling;
  assert.deepEqual([missing.projectedKnownTokens, missing.projectedUnknownRuns, missing.breached], [0, 3, null]);
});

test('F5: a projection is repeatable and the plan names its filters', () => {
  const f = ceilingFixture('f5-repeat', [100, 200, 300]);
  assert.deepEqual(f.planOf(1000), f.planOf(1000));
  assert.deepEqual(f.planOf(1000).filters, { skill: 'do-git', split: null, arm: null });
});

test('F5: plan exits 2 with no stdout on a known breach, and warns but emits the plan when unknown', () => {
  const f = ceilingFixture('f5-cmd', [100, 200, 300]);
  const opts = { iteration: 'it', skill: 'do-git', baselineFile: f.baselineFile };
  const withMax = (maxTokensPerRun) => ({ ...f.base, costCeiling: { unit: 'total_tokens', maxTokensPerRun } });

  const breach = quiet(() => runner.cmdPlan(withMax(100), opts));
  assert.equal(breach.status, 2);
  assert.equal(breach.out, '');
  assert.equal(breach.err, 'bench plan: projected usage 600 total_tokens from 3 run(s) with known usage exceeds the budget 300 (100 x 3 runs, bench/config.json costCeiling); 0 run(s) unknown');

  const within = quiet(() => runner.cmdPlan(withMax(1000), opts));
  assert.equal(within.status, 0);
  assert.equal(within.err, '');
  assert.equal(JSON.parse(within.out).costCeiling.breached, false);

  const unknown = quiet(() => runner.cmdPlan(withMax(1000), { ...opts, baselineFile: path.join(scratch.dir, 'no-such-baseline.json') }));
  assert.equal(unknown.status, 0);
  assert.equal(unknown.err, 'warning: cost projection unknown for 3 of 3 run(s); the orchestrating agent enforces the budget at dispatch');
  assert.equal(JSON.parse(unknown.out).runCount, 3);
});

test('F5: an invalid costCeiling is refused by plan and by report', () => {
  const base = runner.loadConfig();
  const bad = [
    [{ ...base, costCeiling: undefined }, /the block is missing/],
    [{ ...base, costCeiling: { unit: 'usd', maxTokensPerRun: 10 } }, /unit must be total_tokens/],
    [{ ...base, costCeiling: { unit: 'total_tokens', maxTokensPerRun: 0 } }, /positive integer/],
    [{ ...base, costCeiling: { unit: 'total_tokens', maxTokensPerRun: 1.5 } }, /positive integer/],
    [{ ...base, costCeiling: { unit: 'total_tokens', maxTokensPerRun: '10' } }, /positive integer/],
  ];
  for (const [cfg, reason] of bad) {
    assert.throws(() => runner.loadCeiling(cfg), reason);
    for (const run of [() => runner.cmdPlan(cfg, { iteration: 'it' }), () => runner.cmdReport(cfg, { iteration: 'it' })]) {
      const r = quiet(run);
      assert.equal(r.status, 2);
      assert.equal(r.out, '');
      assert.match(r.err, /^bench: bench\/config\.json costCeiling is invalid: /);
    }
  }
  assert.deepEqual(runner.loadCeiling(base), { unit: 'total_tokens', maxTokensPerRun: base.costCeiling.maxTokensPerRun });
});

test('F6: the report carries the ceiling over both arms, and a breach only warns', () => {
  const withUsage = (key, total_tokens) => result(key, key, 'triggering', 'train', { usage: { total_tokens, duration_ms: null } });
  const input = (maxTokensPerRun, withResults) => ({
    baseline: { commit: 'abc', model: 'm', results: [] },
    withResults, cfg: { model: 'm', costCeiling: { unit: 'total_tokens', maxTokensPerRun } }, iteration: 'it', commit: 'def',
  });
  assert.deepEqual(runner.buildReport(input(100, [withUsage('s/1', 150), withUsage('s/2', 40)])).ceiling,
    { unit: 'total_tokens', maxTokensPerRun: 100, budget: 200, knownTokens: 190, unknownRuns: 0, breached: false });
  assert.equal(runner.buildReport(input(100, [withUsage('s/1', 250)])).ceiling.breached, true);
  assert.equal(runner.buildReport(input(100, [withUsage('s/1', 50), withUsage('s/2', null)])).ceiling.breached, null);

  const f = gradedFixture('f6-ceiling');
  quiet(() => runner.cmdGrade(f.cfg, f.opts));
  quiet(() => runner.cmdBaseline(f.cfg, { from: 'it', runsRoot: f.runsRoot, baselineFile: f.baselineFile }));
  const over = quiet(() => runner.cmdReport({ ...f.cfg, costCeiling: { unit: 'total_tokens', maxTokensPerRun: 100 } }, f.opts));
  assert.equal(over.status, 0);
  assert.match(over.err, /warning: ceiling exceeded: 1500 total_tokens over 1 run\(s\) with known usage against the budget 200 \(100 x 2 runs\)/);
  const unknown = quiet(() => runner.cmdReport(f.cfg, f.opts));
  assert.equal(unknown.status, 0);
  assert.match(unknown.out, /ceiling: not exceeded by the 1 run\(s\) with known usage; 1 run\(s\) unknown/);
});
