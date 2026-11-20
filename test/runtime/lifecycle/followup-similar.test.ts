'use strict';

// Row 176 T6 (design §10, IC-008, AC-4): `followup --action list --similar`. Each listed item carries its rule matches
// among the open and taken follow-ups; the rule stage's candidate pairs among the listed items go to the same-issue
// decision with a show surface, and a model column appears only when the user set the kind to `show` and the local
// result passes the show bar. Runs the verb through the dispatcher against a fake decision server in a scratch HOME,
// with a local result planted in the scratch result store.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { bashPath } = require('../../helper/bash-locator.ts');
const { createScratch } = require('../../helper/scratch-env.ts');
const { makeRepo } = require('../../helper/lifecycle-git-fixtures.ts');
const { startFakeServer, answering, digestOf } = require('../../helper/fake-decision-server.ts');
const { keepPathsOf, resolvesPath } = require('../../helper/view-subset.ts');
const { loadStorageRegistry } = require('../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../../src/runtime/advice/kinds.ts');
const { buildBatch } = require('../../../src/runtime/advice/batch.ts');
const { itemText, pairState, candidatePairs } = require('../../../src/runtime/advice/same-issue/rule.ts');
const { effectiveBars } = require('../../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../../src/runtime/advice/replay/results.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('../../../src/runtime/advice/replay/trust.ts');
const { addFollowups } = require('../../../src/runtime/lifecycle/followup.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const CLI = path.join(REPO_ROOT, 'src/runtime/lifecycle/cli.ts');
const KIND = 'same-issue';
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const PARAMS = ADVICE.kinds.find((kind: any) => kind.id === KIND).params;
const FOOTER = 'Possible duplicates by shared words; nothing is merged or closed.';
const BASIS = 'The model check rests on a result measured on review findings, not on follow-ups.';

/** A and B are near duplicates (rule yes); C-D and E-F share some words (candidates the rule says no to). */
const STATEMENTS: Record<string, string> = {
  A: 'Upload client retry loop ignores the server timeout header',
  B: 'The upload client retry loop ignores a timeout header from the server',
  C: 'Config parser drops the trailing comment of a settings file',
  D: 'Settings reader loses comment lines at the end of the parser input',
  E: 'Ledger lock is never released after a crash',
  F: 'Ledger lock file stays after the worker exits',
};

const SHOW_ONLY = {
  n: 120, valid: 120, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
  accuracy: { model: 0.95, rule: 0.8 }, kappa: { model: 0.8, rule: 0.5, lower: 0.6, gain: 0.3, gainLower: -0.05 },
  worse: 1, better: 19, worseShare: 1 / 120, minority: 48, latencyMs: { first: 600, p50: 400, p95: 700, max: 900 },
};
const BELOW_SHOW = { ...SHOW_ONLY, kappa: { ...SHOW_ONLY.kappa, lower: -0.1 } };

const scratch = createScratch('doflow-followup-similar-');
before(() => scratch.apply());
after(() => { scratch.restore(); scratch.remove(); });

let fixture: any = null;
/** One repository holding the six items, added in order A..F; `id.A` is A's follow-up id. */
function seeded() {
  if (fixture) return fixture;
  const repo = makeRepo(scratch, 'followup-similar');
  const dir = fs.realpathSync(repo.dir);
  const letters = Object.keys(STATEMENTS);
  const added = addFollowups({ root: dir, cwd: dir, items: letters.map((letter) => ({ statement: STATEMENTS[letter] })), defaults: { source: 'manual', batch: true } });
  assert.equal(added.ok, true);
  const id: Record<string, string> = Object.fromEntries(letters.map((letter, index) => [letter, added.created[index].id]));
  const letterOf = Object.fromEntries(Object.entries(id).map(([letter, value]) => [value, letter]));
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: dir, env: scratch.env() });
  fixture = { dir, id, letterOf, roots };
  return fixture;
}

/** The candidate pairs as letter pairs, in the order the batch asks them. */
function candidates() {
  const { id, letterOf } = seeded();
  const items = Object.keys(STATEMENTS).map((letter) => ({ id: id[letter], text: itemText(STATEMENTS[letter], PARAMS.itemBytes) }));
  const pairs = candidatePairs(items, PARAMS, { among: new Set(Object.values(id)) });
  return { items, pairs, letters: pairs.map((pair: any) => [letterOf[pair.a], letterOf[pair.b]].sort().join('')) };
}

/** Advice on against a fake server answering `yesFor(letter pair)`; `kindMode` sets advice.kinds.same-issue. */
async function advised(t: any, yesFor: (pair: string) => number, kindMode: string | null) {
  const { roots } = seeded();
  const { letters } = candidates();
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering((name: string) => yesFor(letters[name.charCodeAt(name.length - 1) - 97])) } });
  t.after(() => server.close());
  const file = path.join(roots['config-home'], 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const advice: any = { 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' };
  if (kindMode) advice[`advice.kinds.${KIND}`] = kindMode;
  fs.writeFileSync(file, JSON.stringify({ ...settings, ...advice }));
  t.after(() => fs.writeFileSync(file, JSON.stringify(settings)));
  return { server, asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
}

/** A local result for this project and the shipped kind, with the given figures. */
function plantResult(metrics: any) {
  const { dir, roots } = seeded();
  const kind = ADVICE.kinds.find((entry: any) => entry.id === KIND);
  const bars = effectiveBars({ registry: ADVICE, kind: KIND, roots });
  assert.equal(bars.ok, true);
  const entry = {
    kind: KIND, provider: 'ollama', model: 'clef-flash', modelDigest: `sha256:${digestOf('clef-flash:latest')}`,
    questionDigest: questionDigest(materializeKind(KIND, { adviceRegistry: ADVICE }).question),
    builderDigest: builderDigest(getSource('review-findings'), kind),
    barsDigest: barsDigest(bars.bars, kind.budgetMs),
    caseSet: { source: 'review-findings', origin: 'project', projectKey: projectKey(dir), digest: caseSetDigest([]), eligible: 120, replayed: 120 },
    metrics, runAt: '2026-11-19T08:00:00.000Z', doflowVersion: '2.4.0',
  };
  writeResult({ roots, entry });
}

/** Runs the verb through the dispatcher without blocking this process, so the fake server here can answer. */
function list(args: string[] = ['--json']): Promise<{ status: number; stdout: string; stderr: string; json: any }> {
  const { dir } = seeded();
  return new Promise((resolve) => {
    execFile(bashPath(), [RUN, 'followup', '--action', 'list', '--similar', ...args], { cwd: dir, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' }, (error: any, stdout: string, stderr: string) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* text output */ }
      resolve({ status: error ? error.code : 0, stdout, stderr, json });
    });
  });
}

/** The answer's matches as `letter -> ["B 1 same-issue", ...]`, for every listed item. */
function matchesByLetter(answer: any) {
  const { letterOf } = seeded();
  return Object.fromEntries(answer.similar.map((entry: any) => [letterOf[entry.id], entry.matches.map((match: any) => [letterOf[match.id], match.score, match.model].filter((part) => part !== undefined).join(' '))]));
}

async function waitFor(check: () => any, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** Asserts the server got one call asking exactly the candidate pairs, in order, as one batch. */
function assertAskedCandidates(asks: any[]) {
  const { items, pairs } = candidates();
  const byId = new Map(items.map((item: any) => [item.id, item]));
  const expected = buildBatch({
    question: materializeKind(KIND, { adviceRegistry: ADVICE }).question,
    states: pairs.map((pair: any) => pairState(byId.get(pair.a), byId.get(pair.b))),
    questionsPerCall: PARAMS.questionsPerCall,
  });
  assert.equal(asks.length, 1);
  assert.deepEqual({ state: asks[0].body.state, names: Object.keys(asks[0].body.questions) }, { state: expected.state, names: expected.questions.map((q: any) => q.name) });
}

const RULE_ONLY = { A: ['B 1'], B: ['A 1'], C: [], D: [], E: [], F: [] };

test('the fixture: A-B is a rule match; E-F and C-D are candidates the rule says no to', () => {
  assert.deepEqual(candidates().letters, ['AB', 'EF', 'CD']);
  assert.deepEqual(candidates().pairs.map((pair: any) => pair.rule), ['yes', 'no', 'no']);
});

test('(f) the kind unset: rule matches, no model field, modelCheck not shown with its reason; the server got the candidate pairs (shadow)', async (t) => {
  const a = await advised(t, () => 0.92, null);
  const r = await list();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(matchesByLetter(r.json), RULE_ONLY);
  assert.deepEqual(r.json.modelCheck, { shown: false, reason: 'shadow' });
  assertAskedCandidates(await waitFor(() => a.asks().length && a.asks()));
});

test('(g) the kind at show with a passing local result: matches carry the model, a rule miss appears only on a model yes', async (t) => {
  const a = await advised(t, (pair) => ({ AB: 0.92, EF: 0.08, CD: 0.92 } as any)[pair], 'show');
  plantResult(SHOW_ONLY);
  const r = await list();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.view, 'brief');
  assert.deepEqual(matchesByLetter(r.json), {
    A: ['B 1 same-issue'], B: ['A 1 same-issue'], C: ['D 0.25 same-issue'], D: ['C 0.25 same-issue'], E: [], F: [],
  });
  assert.deepEqual(r.json.modelCheck, { shown: true, reason: null });
  assertAskedCandidates(a.asks());

  const text = await list([]);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trim().split('\n');
  const { id } = seeded();
  const at = lines.findIndex((line) => line.startsWith(`${id.C}  open`));
  assert.equal(lines[at + 1], `  ~ ${id.D} 0.25  model: same issue`);
  assert.deepEqual(lines.slice(-2), [FOOTER, BASIS]);
});

test('(h) the kind at show with a failing local result: as (f), the reason naming the unmet standing', async (t) => {
  const a = await advised(t, () => 0.92, 'show');
  plantResult(BELOW_SHOW);
  const r = await list();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(matchesByLetter(r.json), RULE_ONLY);
  assert.equal(r.json.modelCheck.shown, false);
  assert.match(r.json.modelCheck.reason, /^LOCAL_RESULT_UNMET: below-show: /);
  assertAskedCandidates(await waitFor(() => a.asks().length && a.asks()));

  const text = await list([]);
  const lines = text.stdout.trim().split('\n');
  const { id } = seeded();
  assert.equal(lines[lines.findIndex((line) => line.startsWith(`${id.A}  open`)) + 1], `  ~ ${id.B} 1.00`);
  assert.equal(lines.at(-1), FOOTER);
});

test('(i) the brief view keeps the design §10 keys, and a brief answer resolves them', async () => {
  const keep = keepPathsOf(CLI, 'FOLLOWUP_LIST_BRIEF');
  const design = ['$.similar[].id', '$.similar[].matches[].id', '$.similar[].matches[].score', '$.similar[].matches[].model', '$.modelCheck.shown'];
  assert.deepEqual(design.filter((key) => !keep.includes(key)), []);
  const r = await list();
  assert.deepEqual(design.filter((key) => key !== '$.similar[].matches[].model' && !resolvesPath(r.json, key)), []);
  const paged = await list(['--limit', '2', '--json']);
  assert.match(paged.json.next.find((line: string) => line.startsWith('Next page:')), / --similar /, 'the next page keeps --similar');
});

test('(j) --similar with any other action is a usage error (exit 2)', () => {
  const { dir } = seeded();
  for (const action of ['add', 'take', 'settle', 'promote', 'report']) {
    const r = spawnSync(bashPath(), [RUN, 'followup', '--action', action, '--similar', '--statement', 'x', '--json'], { cwd: dir, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' });
    assert.equal(r.status, 2, `${action}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /--similar applies to --action list only/);
  }
});
