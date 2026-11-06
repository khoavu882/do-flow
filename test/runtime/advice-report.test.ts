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
const { buildReport, renderText, FOOTER } = require('../../src/runtime/advice/report.ts');

const REPO = path.resolve(__dirname, '../..');
const BIN = path.join(REPO, 'bin/doflow.js');
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');
const KINDS = ['tier', 'task-class'];

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
  ];
  specs.forEach((spec, i) => ids.push(pick(roots, i, spec).pickId));
  appendOutcome({ roots, now: NOW, pickId: ids[0], actual: 'standard', source: 'caller', store: 'project-state' });
  appendOutcome({ roots, now: NOW, pickId: ids[1], actual: 'light', source: 'caller', store: 'project-state' });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 50 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 70 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable', durationMs: 5 });

  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  const tier = report.kinds.tier;
  assert.deepEqual(tier.n, { picks: 4, misses: 3 });
  assert.deepEqual(tier.missesByReason, { timeout: 2, unreachable: 1 });
  assert.deepEqual(tier.agreeStatic, { n: 3, agree: 2 });
  assert.deepEqual(tier.agreeOutcome, { n: 2, agree: 1 });
  assert.equal(tier.elevated, 1);
  assert.deepEqual(tier.modes, { shadow: 2, act: 1, unrecorded: 1 });
  assert.deepEqual(tier.durationMs, { n: 4, p50: 200, p90: 400, p95: 400 });
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
  assert.deepEqual(report.kinds.tier.modes, { shadow: 0, act: 0, unrecorded: 1 });
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

test('verdict rows come from the verdict file with the evaluator reason; the shipped empty file gives none', (t) => {
  const { roots } = fixture(t);
  assert.deepEqual(buildReport({ roots, kinds: KINDS, now: NOW }).verdicts, []);
  const repoRoot = tempDir(t, 'doflow-report-verdicts-');
  fs.mkdirSync(path.join(repoRoot, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core/registry/advice-verdicts.json'), JSON.stringify({
    schemaVersion: 1, corpora: {}, verdicts: [
      { kind: 'tier', model: 'm1', result: 'pass' }, { kind: 'tier', model: 'm2', result: 'pass' }, { kind: 'other', model: 'm3', result: 'pass' },
    ],
  }));
  const evaluate = (kind: string, model: string) => (model === 'm1'
    ? { passed: true, reason: 'passes' } : { passed: false, reason: 'verdict stale: corpus changed' });
  const rows = buildReport({ roots, kinds: KINDS, now: NOW, repoRoot, evaluate }).verdicts;
  assert.deepEqual(rows, [
    { kind: 'tier', model: 'm1', arm: null, result: 'pass', stale: false, reason: null },
    { kind: 'tier', model: 'm2', arm: null, result: 'pass', stale: true, reason: 'verdict stale: corpus changed' },
  ]);
  assert.match(renderText({ ...buildReport({ roots, kinds: KINDS, now: NOW, repoRoot, evaluate }) }), /tier m2: pass, stale: verdict stale: corpus changed/);
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
