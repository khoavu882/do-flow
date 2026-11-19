'use strict';

// 141 IC-008 (common figures): the report over a fixture window, old-format lines, the one-project footer, read-only.
// No model is called; records are written through record.ts or as raw lines.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, appendMiss, appendOutcome } = require('../../src/runtime/advice/record.ts');
const { buildReport, renderText, FOOTER, GLOBAL_FOOTER } = require('../../src/runtime/advice/report.ts');

const REPO = path.resolve(__dirname, '../..');
const BIN = path.join(REPO, 'bin/doflow.js');
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');
const KINDS = ['tier', 'task-class'];
const SENTINEL = 'SENTINEL-Q7Z-do-not-print';

function fixture(t: any) {
  const home = tempDir(t, 'doflow-report-home-');
  const project = tempDir(t, 'doflow-report-project-');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  return { roots, project, env };
}

function pick(roots: any, minutes: number, overrides: any = {}) {
  const answer = { name: 'tier', type: 'choice', pick: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7, strength: { word: 'clear', between: null } };
  const question = { name: 'tier', type: 'choice', options: { light: 'l', standard: 's', frontier: 'f' } };
  return appendPick({
    roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000), kind: 'tier', answer, question,
    state: 'private state text', caller: 'advise', ...overrides,
  });
}

function rawLine(roots: any, date: string, value: any) {
  const file = path.join(roots['project-state'], 'advice', 'picks', `${date}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).size}`); } };
  walk(dir);
  return out.sort();
}

test('counts, agreement, modes, misses by reason and nearest-rank durations carry their n', (t) => {
  const { roots } = fixture(t);
  const ids: string[] = [];
  const specs: any[] = [
    { staticAnswer: 'standard', durationMs: 100, mode: 'shadow' },
    { staticAnswer: 'light', durationMs: 200, mode: 'shadow' },
    { staticAnswer: null, durationMs: 300, mode: 'act', elevated: true },
    { staticAnswer: 'standard', durationMs: 400 },
    { staticAnswer: 'standard', durationMs: 500, mode: 'show' },
  ];
  specs.forEach((spec, i) => ids.push(pick(roots, i, spec).pickId));
  appendOutcome({ roots, now: NOW, pickId: ids[0], actual: 'standard', source: 'caller', store: 'project-state' });
  appendOutcome({ roots, now: NOW, pickId: ids[1], actual: 'light', source: 'caller', store: 'project-state' });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 50 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 70 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable', durationMs: 5 });

  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  const tier = report.kinds.tier;
  assert.deepEqual(tier.n, { picks: 5, misses: 3 });
  assert.deepEqual(tier.missesByReason, { timeout: 2, unreachable: 1 });
  assert.deepEqual(tier.agreeStatic, { n: 4, agree: 3 });
  assert.deepEqual(tier.agreeOutcome, { n: 2, agree: 1 });
  assert.equal(tier.elevated, 1);
  assert.deepEqual(tier.modes, { shadow: 2, show: 1, act: 1, unrecorded: 1 }, 'a show pick is a recorded mode');
  assert.deepEqual(tier.durationMs, { n: 5, p50: 300, p90: 500, p95: 500 });
  assert.deepEqual(tier.missDurationMs, { n: 3, p50: 50, p90: 70, p95: 70 });
  assert.deepEqual(report.window, { from: '2026-03-12', to: '2026-06-10', maxAgeDays: 90 });
  assert.equal(report.scope, 'this project only');
});

test('a kind with no records reads no data in text and null figures in JSON', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0);
  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.deepEqual(report.kinds['task-class'].n, { picks: 0, misses: 0 });
  assert.equal(report.kinds['task-class'].agreeStatic, null);
  assert.equal(report.kinds['task-class'].durationMs, null);
  assert.match(renderText(report), /task-class\n {2}no data/);
});

test('lines in the old record format stay readable and unreadable lines are counted', (t) => {
  const { roots } = fixture(t);
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-aaaaaa', at: '2026-06-09T01:00:00.000Z', kind: 'tier', question: 'tier', qtype: 'choice', options: ['light', 'standard'], pick: 'light', static: 'light', durationMs: 900 });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'miss', at: '2026-06-09T02:00:00.000Z', kind: 'tier', caller: 'advise', reason: 'timeout' });
  rawLine(roots, '2026-06-09', 'not json');
  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.equal(report.unreadable, 1);
  assert.deepEqual(report.kinds.tier.n, { picks: 1, misses: 1 });
  assert.deepEqual(report.kinds.tier.modes, { shadow: 0, show: 0, act: 0, unrecorded: 1 });
  assert.equal(report.kinds.tier.elevated, 0);
  assert.deepEqual(report.kinds.tier.durationMs, { n: 1, p50: 900, p90: 900, p95: 900 });
  assert.deepEqual(report.kinds.tier.missDurationMs, { n: 0, p50: null, p90: null, p95: null });
});

test('records older than 90 days are outside the window', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(buildReport({ roots, kinds: KINDS, now: NOW }).kinds.tier.n, { picks: 0, misses: 0 });
});

test('text output states every n, ends with the one-project footer, and carries no state text', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0, { staticAnswer: 'standard', durationMs: 120, mode: 'shadow' });
  const text = renderText(buildReport({ roots, kinds: KINDS, now: NOW }));
  assert.ok(text.endsWith(FOOTER));
  assert.equal(FOOTER, 'Records are from this project only; every figure shows its n.');
  assert.match(text, /agrees with the static answer: 1 of 1 \(100%\), n=1/);
  assert.match(text, /agrees with the recorded outcome: no data \(n=0\)/);
  assert.match(text, /pick duration ms \(n=1\)/);
  assert.equal(text.includes('private state text'), false);
});

test('141 N1: -g labels the report as the user-level store; the default keeps the one-project label', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0, { staticAnswer: 'standard', durationMs: 120, mode: 'shadow' });
  const global = buildReport({ roots, kinds: KINDS, now: NOW, global: true });
  assert.equal(global.scope, 'user-level store');
  const text = renderText(global);
  assert.ok(text.startsWith('Advice report (user-level store)'));
  assert.ok(text.endsWith(GLOBAL_FOOTER));
  assert.equal(GLOBAL_FOOTER, 'Records are from the user-level store only; every figure shows its n.');
  assert.equal(text.includes('this project'), false);
  const project = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.equal(project.scope, 'this project only');
  assert.ok(renderText(project).endsWith(FOOTER));
});

// 175 T8 (IC-010, FR-018): the followed counts, "agreement with what you did", and "Local results".

function labelled(roots: any, minutes: number, kind: string, spec: any) {
  const yesno = kind === 'mcp-need';
  const answer = yesno
    ? { name: kind, type: 'yesno', pick: spec.pick, probabilities: {}, confidence: 0.6, strength: { word: 'clear', between: null } }
    : { name: kind, type: 'choice', pick: spec.pick, probabilities: {}, confidence: 0.6, strength: { word: 'clear', between: null } };
  const question = yesno ? { name: kind, type: 'yesno' } : { name: kind, type: 'choice', options: { light: 'l', standard: 's', frontier: 'f' } };
  const id = appendPick({
    roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000), kind, answer, question,
    state: 'private state text', caller: 'advise', staticAnswer: spec.static === undefined ? 'standard' : spec.static, durationMs: 10,
    ...(spec.mode ? { mode: spec.mode } : {}),
  }).pickId;
  if (spec.actual !== undefined || spec.followed !== undefined) {
    appendOutcome({ roots, now: NOW, pickId: id, actual: spec.actual, followed: spec.followed, source: 'caller', store: 'project-state' });
  }
  return id;
}

/** tier (choice) and mcp-need (yes/no) picks with every way a label is known, derived, or only counted. */
function labelledWindow(roots: any) {
  labelled(roots, 0, 'tier', { mode: 'show', pick: 'frontier', actual: 'frontier' });                          // label frontier: better
  labelled(roots, 1, 'tier', { mode: 'act', pick: 'frontier', followed: 'followed' });                         // derived frontier: better
  labelled(roots, 2, 'tier', { mode: 'show', pick: 'light', followed: 'overruled' });                          // choice, no actual: counted
  labelled(roots, 3, 'tier', { mode: 'show', pick: 'light', followed: 'partly' });                             // counted
  labelled(roots, 4, 'tier', { mode: 'shadow', pick: 'light', actual: 'standard' });                           // label standard: worse
  labelled(roots, 5, 'tier', { mode: 'shadow', pick: 'light', followed: 'followed' });                         // never shown: ignored
  labelled(roots, 6, 'tier', { mode: 'show', pick: 'frontier', followed: 'overruled', actual: 'standard' });   // actual wins: worse
  labelled(roots, 7, 'tier', { mode: 'show', pick: 'frontier', followed: 'followed', static: null });          // no rule answer: counted
  labelled(roots, 8, 'mcp-need', { mode: 'show', pick: 'yes', static: 'no', followed: 'overruled' });         // derived no: worse
  labelled(roots, 9, 'mcp-need', { mode: 'act', pick: 'no', static: 'no', followed: 'followed' });            // derived no: both right
  labelled(roots, 10, 'mcp-need', { mode: 'show', pick: 'yes', static: 'yes', followed: 'partly' });          // counted
}

test('(b) the followed, partly and overruled counts per kind carry n, the shown picks', (t) => {
  const { roots } = fixture(t);
  labelledWindow(roots);
  const report = buildReport({ roots, kinds: ['tier', 'mcp-need', 'task-class'], now: NOW });
  assert.deepEqual(report.kinds.tier.followed, { n: 6, followed: 2, partly: 1, overruled: 2 });
  assert.deepEqual(report.kinds['mcp-need'].followed, { n: 3, followed: 1, partly: 1, overruled: 1 });
  assert.equal(report.kinds['task-class'].followed, null);
  assert.deepEqual(report.kinds.tier.agreeOutcome, { n: 3, agree: 1 }, 'a followed-only line is not an actual');
  const text = renderText(report);
  assert.match(text, /tier\n(?: {2}.*\n)*? {2}followed \(n=6 shown picks\): followed 2, partly 1, overruled 2/);
  assert.match(text, /mcp-need\n(?: {2}.*\n)*? {2}followed \(n=3 shown picks\): followed 1, partly 1, overruled 1/);
});

test('(c) agreement with what you did scores the known and derived labels and counts the rest', (t) => {
  const { roots } = fixture(t);
  labelledWindow(roots);
  const report = buildReport({ roots, kinds: ['tier', 'mcp-need'], now: NOW });
  const tier = report.kinds.tier.agreement;
  assert.equal(tier.n, 4);
  assert.deepEqual(tier.counted, { partly: 1, overruledWithoutActual: 1, noStaticAnswer: 1 });
  assert.deepEqual(tier.figures.accuracy, { model: 0.5, rule: 0.5 });
  assert.equal(tier.figures.worse, 2);
  assert.equal(tier.figures.better, 2);
  assert.equal('worseIds' in tier.figures, false, 'no pick id is listed');
  assert.equal('standing' in tier, false, 'figures only, never a standing');
  const yesno = report.kinds['mcp-need'].agreement;
  assert.equal(yesno.n, 2);
  assert.deepEqual(yesno.counted, { partly: 1, overruledWithoutActual: 0, noStaticAnswer: 0 });
  assert.deepEqual(yesno.figures.accuracy, { model: 0.5, rule: 1 });
  assert.equal(yesno.figures.worse, 1);
  // The bootstrap uses the fixed statistics of the effective bars, so the same window gives the same lower bound.
  assert.deepEqual(buildReport({ roots, kinds: ['tier', 'mcp-need'], now: NOW }).kinds.tier.agreement, tier);
  const text = renderText(report);
  assert.match(text, /agreement with what you did \(n=4\): model 0\.50, rule 0\.50 accuracy; kappa model .*; worse 2, better 2/);
  assert.match(text, /counted, not scored: partly 1, overruled without --actual 1, no static answer 1/);
  assert.doesNotMatch(text, /certif/i);
  assert.equal(buildReport({ roots, kinds: ['task-class'], now: NOW }).kinds['task-class'].agreement, null);
});

// "Local results": stored replay entries re-judged against the current question, builder and bars, with no network call.

const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { effectiveBars } = require('../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../src/runtime/advice/replay/results.ts');
const { score } = require('../../src/runtime/advice/replay/score.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('../../src/runtime/advice/replay/trust.ts');

const REGISTRY = loadAdviceRegistry({ repoRoot: REPO }).registry;
const CS = 'claim-support';
const digest = (c: string) => `sha256:${c.repeat(64)}`;

function writeClaims(project: string, count: number) {
  const dir = path.join(project, '.doflow', 'state', 'evidence', 'feature-r');
  const at = '2026-06-01T10:00:00.000Z';
  const ids = Array.from({ length: count }, (_v, i) => i);
  const claims = ids.map((i) => ({ id: `claim_${i}`, taskId: 'T1', statement: `${SENTINEL} claim ${i}`, role: null, status: 'supported',
    supportingEvidence: [`ev_${i}`], contradictingEvidence: [], createdAt: at, updatedAt: at }));
  const evidence = ids.map((i) => ({ id: `ev_${i}`, taskId: 'T1', kind: 'generated-analysis',
    source: { provider: 'general-task-execution', capability: 'coverage-reverify' }, locator: {}, provenance: 'inferred',
    content: `${SENTINEL} passage ${i}`, freshness: { gitCommit: null, fileHash: null, observedAt: at, status: 'FRESH' },
    establishes: [], observation: null, supports: [`claim_${i}`], contradicts: [], status: 'active', supersededBy: null }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'T1_claims.json'), JSON.stringify({ taskId: 'T1', updatedAt: at, claimsCount: count, claims, version: 1, revision: 1 }));
  fs.writeFileSync(path.join(dir, 'T1.json'), JSON.stringify({ taskId: 'T1', updatedAt: at, evidenceCount: count, evidence, version: 1, revision: 1 }));
}

/** Four stored entries for claim-support: fresh, question moved, builder and bars moved, and another project's. */
function localResults(t: any) {
  const f = fixture(t);
  writeClaims(f.project, 3);
  const registryKind = REGISTRY.kinds.find((kind: any) => kind.id === CS);
  const source = getSource(registryKind.replay.source);
  const bars = effectiveBars({ registry: REGISTRY, kind: CS, roots: f.roots }).bars;
  const cases = source.build({ projectRoot: f.project, roots: f.roots, kind: registryKind }).cases;
  assert.equal(cases.length, 3);
  const { worseIds, perClass, labelCounts, ...metrics } = score(cases.map((c: any) => ({ ...c, model: c.label, latencyMs: 20 })), { options: ['yes', 'no'], bars, budgetMs: registryKind.budgetMs });
  const base = {
    kind: CS, provider: 'ollama', model: 'clef-flash',
    questionDigest: questionDigest(materializeKind(CS, { adviceRegistry: REGISTRY }).question),
    builderDigest: builderDigest(source, registryKind), barsDigest: barsDigest(bars, registryKind.budgetMs),
    caseSet: { source: source.id, origin: source.origin, projectKey: projectKey(f.project), digest: caseSetDigest(cases), eligible: 3, replayed: 3 },
    metrics, runAt: '2026-06-09T10:00:00.000Z', doflowVersion: '2.6.0',
  };
  writeResult({ roots: f.roots, entry: { ...base, modelDigest: digest('a') } });
  writeResult({ roots: f.roots, entry: { ...base, modelDigest: digest('b'), questionDigest: digest('0') } });
  writeResult({ roots: f.roots, entry: { ...base, modelDigest: digest('c'), builderDigest: digest('1'), barsDigest: digest('2') } });
  writeResult({ roots: f.roots, entry: { ...base, modelDigest: digest('d'), caseSet: { ...base.caseSet, projectKey: digest('e') } } });
  return f;
}

test('(d) Local results: standing re-judged, each moved digest named, the case set compared in this project only', (t) => {
  const f = localResults(t);
  const report = buildReport({ roots: f.roots, kinds: ['tier', CS], now: NOW, projectRoot: f.project });
  assert.equal('verdicts' in report, false);
  const rows = report.localResults.map((row: any) => [row.modelDigest.slice(7, 8), row.standing, row.stale, row.caseSet]);
  assert.deepEqual(rows, [
    ['a', 'measure-only', [], 'same'],
    ['b', 'stale', ['question'], 'same'],
    ['c', 'stale', ['builder', 'bars'], 'same'],
    ['d', 'measure-only', [], 'other-project'],
  ]);
  let text = renderText(report);
  assert.doesNotMatch(text, /Bench verdicts/);
  assert.match(text, /\nLocal results\n {2}The model build is not checked here/);
  assert.match(text, /claim-support clef-flash \(provider ollama, digest sha256:aaaaaaaa…\), run 2026-06-09: measure-only: .*; case set same/);
  assert.match(text, /sha256:bbbbbbbb…\), run 2026-06-09: stale: the question changed since the replay; replay again; case set same/);
  assert.match(text, /sha256:cccccccc…\), run 2026-06-09: stale: the builder and bars changed since the replay; replay again/);
  assert.match(text, /sha256:dddddddd…\), run 2026-06-09: measure-only: .*; measured in another project/);
  assert.ok(text.trimEnd().endsWith(FOOTER), 'the footer stays last');

  writeClaims(f.project, 4);
  const grown = buildReport({ roots: f.roots, kinds: ['tier', CS], now: NOW, projectRoot: f.project });
  assert.deepEqual(grown.localResults.map((row: any) => row.caseSet), ['changed', 'changed', 'changed', 'other-project']);
  text = renderText(grown);
  assert.match(text, /sha256:aaaaaaaa…\), run 2026-06-09: measure-only: .*; case set changed: replay again/);
  assert.equal(JSON.stringify(grown).includes(SENTINEL) || text.includes(SENTINEL), false, 'no claim or passage text');

  assert.deepEqual(buildReport({ roots: f.roots, kinds: ['tier'], kind: 'tier', now: NOW, projectRoot: f.project }).localResults, [], 'narrowed to the kind shown');
  const none = renderText(buildReport({ roots: fixture(t).roots, kinds: ['tier'], now: NOW }));
  assert.match(none, /\nLocal results\n {2}The model build is not checked here.*\n {2}none stored for the kinds shown/);
});

test('(d) advise --action report passes this project to the local results, so the case set is compared here', (t) => {
  const f = localResults(t);
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', '--action', 'report', ...args], { cwd: f.project, env: { ...process.env, ...f.env }, encoding: 'utf8' });
  const json = run('--kind', CS, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).localResults.map((row: any) => row.caseSet), ['same', 'same', 'same', 'other-project']);
  const text = run('--kind', CS);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\nLocal results\n/);
  assert.match(text.stdout, /measured in another project/);
});

test('(e) the report makes no network call and writes nothing, with stored results and labelled picks', (t) => {
  const f = localResults(t);
  labelledWindow(f.roots);
  const net = require('node:net');
  const http = require('node:http');
  const https = require('node:https');
  const saved = { connect: net.connect, createConnection: net.createConnection, socket: net.Socket.prototype.connect, request: http.request, get: http.get, srequest: https.request, sget: https.get };
  let calls = 0;
  const refuse = () => { calls += 1; throw new Error('network call from the report'); };
  net.connect = refuse; net.createConnection = refuse; net.Socket.prototype.connect = refuse;
  http.request = refuse; http.get = refuse; https.request = refuse; https.get = refuse;
  const home = path.dirname(f.env.XDG_CONFIG_HOME);
  const before = [snapshot(f.project), snapshot(home)];
  let report: any;
  try {
    report = buildReport({ roots: f.roots, kinds: ['tier', 'mcp-need', CS], now: NOW, projectRoot: f.project });
    renderText(report);
  } finally {
    net.connect = saved.connect; net.createConnection = saved.createConnection; net.Socket.prototype.connect = saved.socket;
    http.request = saved.request; http.get = saved.get; https.request = saved.srequest; https.get = saved.sget;
  }
  assert.equal(typeof report.then, 'undefined', 'built synchronously: nothing is awaited');
  assert.equal(calls, 0);
  assert.equal(report.localResults.length, 4);
  assert.deepEqual([snapshot(f.project), snapshot(home)], before);
});

test('the report writes nothing', (t) => {
  const { roots, project } = fixture(t);
  pick(roots, 0);
  const before = snapshot(project);
  buildReport({ roots, kinds: KINDS, now: NOW });
  assert.deepEqual(snapshot(project), before);
});

test('advise --action report: JSON, text, --kind narrowing, unknown kind exits 2', (t) => {
  const { roots, project, env } = fixture(t);
  appendPick({
    roots, kind: 'tier', state: 'secret', caller: 'advise', durationMs: 42, staticAnswer: 'standard', mode: 'shadow',
    answer: { name: 'tier', type: 'choice', pick: 'standard', probabilities: {}, confidence: 0.5, strength: { word: 'clear', between: null } },
    question: { name: 'tier', type: 'choice', options: { light: 'l', standard: 's' } },
  });
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', ...args], { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8' });
  // The CLI shell keeps its own run log beside the advice records; the report must leave the advice directory untouched.
  const advice = path.join(roots['project-state'], 'advice');
  const before = snapshot(advice);

  const json = run('--action', 'report', '--json');
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.scope, 'this project only');
  assert.deepEqual(parsed.kinds.tier.n, { picks: 1, misses: 0 });
  assert.deepEqual(parsed.kinds.tier.durationMs, { n: 1, p50: 42, p90: 42, p95: 42 });
  assert.ok(Object.hasOwn(parsed.kinds, 'review-depth'));

  const text = run('--action', 'report', '--kind', 'tier');
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.trimEnd().endsWith(FOOTER));
  assert.equal(text.stdout.includes('secret'), false);
  assert.equal(text.stdout.includes('task-class'), false);

  const bad = run('--action', 'report', '--kind', 'nope');
  assert.equal(bad.status, 2);
  assert.deepEqual(snapshot(advice), before);
});


// Row 174: the rerank block and the rerank hook are gone, and so is the followup-triage kind. Picks of both that an
// earlier version wrote stay in a user's store; the report neither crashes on them nor prints a rerank block.
test('174: old pick and miss lines of the removed kinds (followup-triage, rerank) do not crash the report, and no rerank block is built', (t) => {
  const { roots, project, env } = fixture(t);
  pick(roots, 0);
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-aaaaaa', at: '2026-06-09T01:00:00.000Z', kind: 'followup-triage', question: 'followup-triage', qtype: 'choice', pick: 'file', static: 'file', caller: 'do', durationMs: 90, mode: 'shadow' });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000001-bbbbbb', at: '2026-06-09T02:00:00.000Z', kind: 'rerank', question: 'rerank', qtype: 'choice', pick: 'B', static: 'A', caller: 'retrieve', durationMs: 900, mode: 'shadow', rerank: { arm: 'ladder', n: 2, refs: ['a', 'b'], order: ['B', 'A'], expected: [1, 2], confidence: [0.5, 0.5], criteriaDigest: '3f9a1c0b27de' } });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'outcome', pickId: 'adv-1780000000000-aaaaaa', at: '2026-06-09T03:00:00.000Z', actual: 'file', source: 'caller' });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'miss', at: '2026-06-09T04:00:00.000Z', kind: 'rerank', caller: 'retrieve', reason: 'timeout', durationMs: 5000 });
  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.equal('rerank' in report, false);
  assert.deepEqual(report.kinds.tier.n, { picks: 1, misses: 0 });
  assert.equal(report.kinds['followup-triage'].n.picks, 1, 'a pick of a removed kind still shows, as the kind it was written under');
  assert.doesNotMatch(renderText(report), /would-drop|criteria in force/);
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', ...args], { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8' });
  for (const args of [['--action', 'report', '--json'], ['--action', 'report']]) {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout.includes('would-drop'), false);
  }
  for (const kind of ['rerank', 'followup-triage']) {
    const narrowed = run('--action', 'report', '--kind', kind);
    assert.equal(narrowed.status, 2, 'a removed kind is an unknown --kind, a usage error and not a crash');
    assert.match(narrowed.stderr, /unknown --kind/);
  }
  assert.equal('rerank' in JSON.parse(run('--action', 'report', '--json').stdout), false);
});

// 141 D.4 (IC-008): the claim-support figures by recorded relation, with the assertion-not-accuracy line.

const CS_KINDS = ['tier', 'claim-support'];
const CS_NOTE = 'A recorded link is an assertion, not ground truth; agreement here is not accuracy.';

function claimPick(roots: any, minutes: number, relation: string, yes: number, extra: any = {}) {
  return appendPick({
    roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000), kind: 'claim-support', caller: 'claim',
    staticAnswer: relation === 'supports' ? 'yes' : 'no', mode: 'shadow', elevated: false, durationMs: 100 * (minutes + 1),
    state: `claim: ${SENTINEL}\npassage: ${SENTINEL}`,
    question: { name: 'claim-support', type: 'yesno' },
    answer: { name: 'claim-support', type: 'yesno', pick: yes >= 0.5 ? 'yes' : 'no', probabilities: { yes, no: 1 - yes }, confidence: 0.8, strength: { word: 'clear', between: null } },
    extra: { claimSupport: { claimId: `c-${minutes}`, evidenceId: `e-${minutes}`, relation, claimStatus: 'supported', claimBytes: 12, passageBytes: 30, truncated: false, ...extra } },
  });
}

function claimWindow(roots: any) {
  claimPick(roots, 0, 'supports', 0.9);
  claimPick(roots, 1, 'supports', 0.7);
  claimPick(roots, 2, 'supports', 0.2);
  claimPick(roots, 3, 'contradicts', 0.6);
  claimPick(roots, 4, 'contradicts', 0.1);
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'timeout', durationMs: 5000 });
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'timeout', durationMs: 5001 });
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'unreachable', durationMs: 20 });
  // an old line: a claim-support pick written without the payload.
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-dddddd', at: '2026-06-09T01:00:00.000Z', kind: 'claim-support', question: 'claim-support', qtype: 'yesno', options: ['no', 'yes'], pick: 'yes', static: 'yes', durationMs: 50 });
}

test('claim-support figures by recorded relation carry n, model yes, agreement and misses by reason', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  const c = buildReport({ roots, kinds: CS_KINDS, now: NOW }).claimSupport;
  assert.deepEqual(c.n, { picks: 6, misses: 3 });
  assert.deepEqual(c.missesByReason, { timeout: 2, unreachable: 1 });
  assert.equal(c.withoutPayload, 1);
  assert.deepEqual(c.byRelation.supports, { n: 3, modelYes: 2, agree: 2 });
  assert.deepEqual(c.byRelation.contradicts, { n: 2, modelYes: 1, agree: 1 });
  assert.equal(c.durationMs.n, 6);
  const text = renderText(buildReport({ roots, kinds: CS_KINDS, now: NOW }));
  assert.match(text, /claim-support\n {2}picks: 6; misses: 3 \(timeout 2, unreachable 1\)/);
  assert.match(text, /picks without a claim-support payload: 1 of 6/);
  assert.match(text, /supports: picks 3; model said yes at p>=0\.5: 2 of 3; .*: 2 of 3 \(67%\), n=3/);
  assert.match(text, /contradicts: picks 2; model said yes at p>=0\.5: 1 of 2; .*: 1 of 2 \(50%\), n=2/);
  assert.ok(text.includes(CS_NOTE));
  assert.ok(text.trimEnd().endsWith(FOOTER), 'the footer stays last');
});

test('a relation with no records prints no data, and a kind with no records prints no data', (t) => {
  const { roots } = fixture(t);
  assert.match(renderText(buildReport({ roots, kinds: CS_KINDS, now: NOW })), /claim-support\n {2}no data/);
  claimPick(roots, 0, 'supports', 0.9);
  const report = buildReport({ roots, kinds: CS_KINDS, now: NOW });
  assert.deepEqual(report.claimSupport.byRelation.contradicts, { n: 0, modelYes: 0, agree: 0 });
  assert.match(renderText(report), /contradicts: no data \(n=0\)/);
});

test('a pick with a malformed payload relation or no probability stays readable', (t) => {
  const { roots } = fixture(t);
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000002-eeeeee', at: '2026-06-09T02:00:00.000Z', kind: 'claim-support', pick: 'yes', static: 'yes', durationMs: 5, claimSupport: { relation: 'weird' } });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000003-ffffff', at: '2026-06-09T02:30:00.000Z', kind: 'claim-support', pick: 'no', static: 'no', durationMs: 5, claimSupport: { relation: 'contradicts' } });
  const c = buildReport({ roots, kinds: CS_KINDS, now: NOW }).claimSupport;
  assert.equal(c.withoutPayload, 1);
  assert.deepEqual(c.byRelation.contradicts, { n: 1, modelYes: 0, agree: 1 });
});

test('claim-support figures are absent when another kind is selected', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  assert.equal('claimSupport' in buildReport({ roots, kinds: CS_KINDS, kind: 'tier', now: NOW }), false);
  assert.equal(buildReport({ roots, kinds: CS_KINDS, kind: 'claim-support', now: NOW }).claimSupport.n.picks, 6);
});

test('no claim, passage or hand-written text reaches the claim-support text or JSON', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  claimPick(roots, 9, 'supports', 0.9, { claim: SENTINEL, passage: SENTINEL, text: SENTINEL });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000004-aaaaaa', at: '2026-06-09T03:00:00.000Z', kind: 'claim-support', pick: 'yes', static: 'yes', durationMs: 5, state: SENTINEL, claimSupport: { relation: 'supports', claimId: SENTINEL, evidenceId: SENTINEL, claim: SENTINEL, passage: SENTINEL, claimStatus: SENTINEL } });
  const report = buildReport({ roots, kinds: CS_KINDS, now: NOW });
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
  assert.equal(renderText(report).includes(SENTINEL), false);
  assert.equal(report.claimSupport.n.picks, 8, 'the hand-written line is counted');
});
