'use strict';

// Row 176 T7 (design §9 IC-007, §12; owner rulings O-2 (a), O-3 (a)): `doflow review --action similar`, the synthesizer's
// advisory list of possible duplicates among the seat findings. The seats come from the feature's `review/seats.json` or
// `--seats`, held to the findings record's seat rules; the rule stage's candidate pairs go to checkPairs, and a list is
// written to `--out` only when every batch is shown. The verb runs in process against a fake decision server, with HOME
// and XDG_CONFIG_HOME in temp folders and a local result planted in the temp result store; one test runs it through the
// dispatcher. No test reaches a model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo } = require('../helper/lifecycle-git-fixtures.ts');
const { startFakeServer, answering, digestOf } = require('../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { buildBatch } = require('../../src/runtime/advice/batch.ts');
const { itemText, pairState, candidatePairs } = require('../../src/runtime/advice/same-issue/rule.ts');
const { effectiveBars } = require('../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../src/runtime/advice/replay/results.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('../../src/runtime/advice/replay/trust.ts');
const { handleReviewCommand } = require('../../src/runtime/review/command.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const KIND = 'same-issue';
const PARAMS = ADVICE.kinds.find((kind: any) => kind.id === KIND).params;
const SLUG = '176-similar-fixture';

/** Two seats' findings: id -> [locator, summary]. A-4 shares words with nothing, so no pair of it is a candidate. */
const FINDINGS: Record<string, [string, string]> = {
  'A-1': ['src/upload.ts:40', 'Upload client retry loop ignores the server timeout header'],
  'A-2': ['src/config.ts:12', 'Config parser drops the trailing comment of a settings file'],
  'A-3': ['src/ledger.ts:88', 'Ledger lock is never released after a crash'],
  'A-4': ['docs/guide.md:3', 'Guide page has a broken link to the install section'],
  'B-1': ['src/upload.ts:42', 'The upload client retry loop ignores a timeout header from the server'],
  'B-2': ['src/settings.ts:5', 'Settings reader loses comment lines at the end of the parser input'],
  'B-3': ['src/ledger.ts:90', 'Ledger lock file stays after the worker exits'],
  'B-4': ['src/ledger.ts:12', 'Ledger lock is not released when the worker crashes'],
};
const finding = (id: string) => ({ id, severity: 'should-fix', locator: FINDINGS[id][0], summary: FINDINGS[id][1] });
const SEATS = {
  schema: 1,
  seats: [
    { id: 'seat-a', findings: ['A-1', 'A-2', 'A-3', 'A-4'].map(finding) },
    { id: 'seat-b', findings: ['B-1', 'B-2', 'B-3', 'B-4'].map(finding) },
  ],
};

/** The candidate pairs, as the case source builds the items, in the order the batch asks them. */
function candidates() {
  const items = Object.keys(FINDINGS).map((id) => ({ id, text: itemText(`${FINDINGS[id][0]} — ${FINDINGS[id][1]}`, PARAMS.itemBytes), locator: FINDINGS[id][0] }));
  return { items, pairs: candidatePairs(items, PARAMS) };
}

/** The yes probability per block: a clear yes, a split, two clear noes, a clear yes. */
const YES: Record<string, number> = { [`${KIND}-a`]: 0.92, [`${KIND}-b`]: 0.5, [`${KIND}-c`]: 0.08, [`${KIND}-d`]: 0.08, [`${KIND}-e`]: 0.92 };

const SHOW_ONLY = {
  n: 120, valid: 120, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
  accuracy: { model: 0.95, rule: 0.8 }, kappa: { model: 0.8, rule: 0.5, lower: 0.6, gain: 0.3, gainLower: -0.05 },
  worse: 1, better: 19, worseShare: 1 / 120, minority: 48, latencyMs: { first: 600, p50: 400, p95: 700, max: 900 },
};
const BELOW_SHOW = { ...SHOW_ONLY, kappa: { ...SHOW_ONLY.kappa, lower: -0.1 } };

const DOCUMENT = [
  'Possible duplicates among the seat findings (advisory). A pair here may be one issue; merge only what you judge the same.',
  'Nothing was merged, dropped or reordered. Checked 5 candidate pairs of 8 findings; 3 listed.',
  '- A-1 and B-1 · score 1.15 · model: same issue',
  '- A-3 and B-4 · score 0.59 · rule (the model gave no answer)',
  '- A-2 and B-2 · score 0.31 · model: same issue',
].join('\n') + '\n';

/** A project (real path) with the feature's seats file, a user home, the storage roots and the retained lines. */
function project(t: any, dir: string = fs.realpathSync(tempDir(t, 'doflow-review-similar-')), root: string = path.join(dir, 'proj')) {
  fs.mkdirSync(root, { recursive: true });
  const feature = path.join(dir, 'features', SLUG);
  fs.mkdirSync(path.join(feature, 'review'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'review', 'seats.json'), JSON.stringify(SEATS));
  const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: root, env });
  return { dir, root, feature, env, roots, lines: () => readWindow({ roots }).records.map((entry: any) => entry.record) };
}

/** Advice on in the user settings against a fake server answering by block; `kindMode` sets advice.kinds.same-issue. */
async function advised(t: any, p: any, kindMode: string | null = null) {
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering((name: string) => YES[name]) } });
  t.after(() => server.close());
  const setting: any = { schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' };
  if (kindMode) setting[`advice.kinds.${KIND}`] = kindMode;
  const file = path.join(p.roots['config-home'], 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(setting));
  return { server, asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
}

/** A local result for `root` and the shipped kind, with the given figures. */
function plantResult(roots: any, root: string, metrics: any) {
  const kind = ADVICE.kinds.find((entry: any) => entry.id === KIND);
  const bars = effectiveBars({ registry: ADVICE, kind: KIND, roots });
  assert.equal(bars.ok, true);
  writeResult({ roots, entry: {
    kind: KIND, provider: 'ollama', model: 'clef-flash', modelDigest: `sha256:${digestOf('clef-flash:latest')}`,
    questionDigest: questionDigest(materializeKind(KIND, { adviceRegistry: ADVICE }).question),
    builderDigest: builderDigest(getSource('review-findings'), kind),
    barsDigest: barsDigest(bars.bars, kind.budgetMs),
    caseSet: { source: 'review-findings', origin: 'project', projectKey: projectKey(root), digest: caseSetDigest([]), eligible: 120, replayed: 120 },
    metrics, runAt: '2026-11-19T08:00:00.000Z', doflowVersion: '2.4.0',
  } });
}

/** Runs the verb in process; the feature resolves to the fixture's folder unless `resolve` is given. */
async function similar(p: any, options: any = {}) {
  const lines: string[] = [];
  const status = await handleReviewCommand({
    action: 'similar', cwd: p.root, env: p.env, resolve: () => ({ featureFolder: p.feature }), out: (line: string) => lines.push(line), ...options,
  });
  process.exitCode = 0;
  return { status, lines, json: options.json ? JSON.parse(lines[0]) : null };
}

async function waitFor(check: () => any, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/** Waits for `count` lines, then a little longer, so a line written past the count would be seen. */
async function settledLines(p: any, count: number) {
  await waitFor(() => p.lines().length >= count);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return p.lines();
}

/** Asserts the server got one call asking exactly the candidate pairs, in order, and nothing of a finding no candidate holds. */
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
  assert.equal(asks[0].body.state.includes(FINDINGS['A-4'][1]), false, 'A-4 is in no candidate pair');
}

test('the fixture: five candidate pairs of eight findings, four the rule says yes to, best score first', () => {
  assert.deepEqual(candidates().pairs.map((pair: any) => `${pair.a} ${pair.b} ${pair.rule}`), ['A-1 B-1 yes', 'A-3 B-4 yes', 'B-3 B-4 yes', 'A-3 B-3 yes', 'A-2 B-2 no']);
});

test('(a) the kind unset: exit 0, counts and the reason, nothing shown, no --out file; one shadow line per pair', async (t) => {
  const p = project(t);
  const a = await advised(t, p);
  const out = path.join(p.dir, 'possible-duplicates.md');
  const r = await similar(p, { outFile: out });
  assert.equal(r.status, 0);
  assert.deepEqual(r.lines, ['review similar: not shown (shadow); nothing is listed. Checked 5 candidate pairs of 8 findings in 1 batch.']);
  assert.equal(fs.existsSync(out), false);
  const lines = await settledLines(p, 5);
  assert.equal(lines.length, 5, 'one line per pair');
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'shadow' && line.kind === KIND && line.caller === 'review'));
  assert.deepEqual(lines.map((line: any) => line.static).sort(), ['no', 'yes', 'yes', 'yes', 'yes']);
  assertAskedCandidates(await waitFor(() => a.asks().length && a.asks()));
});

test('(b) the kind at show with a passing result: --out holds the list, model yes or no answer with rule yes, best score first', async (t) => {
  const p = project(t);
  await advised(t, p, 'show');
  plantResult(p.roots, p.root, SHOW_ONLY);
  const out = path.join(p.dir, 'possible-duplicates.md');
  const r = await similar(p, { outFile: out });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), DOCUMENT);
  assert.deepEqual(r.lines, [`review similar: 3 possible duplicate pairs written to ${out}. Checked 5 candidate pairs of 8 findings in 1 batch.`]);
  const lines = p.lines();
  assert.equal(lines.length, 5);
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'show' && line.caller === 'review'));

  // Without --out the list is the text answer: at most maxPairs lines plus the header.
  const text = await similar(p);
  assert.equal(text.status, 0);
  assert.equal(`${text.lines.join('\n')}\n`, DOCUMENT);
  assert.ok(text.lines.length <= PARAMS.maxPairs + 3);
});

test('(c) the kind at show with a failing result: as (a), the reason naming the unmet standing', async (t) => {
  const p = project(t);
  const a = await advised(t, p, 'show');
  plantResult(p.roots, p.root, BELOW_SHOW);
  const out = path.join(p.dir, 'possible-duplicates.md');
  const r = await similar(p, { outFile: out, json: true });
  assert.equal(r.status, 0);
  assert.deepEqual([r.json.shown, r.json.mode, r.json.candidates, r.json.out, Object.hasOwn(r.json, 'pairs')], [false, 'shadow', 5, null, false]);
  assert.match(r.json.reason, /^LOCAL_RESULT_UNMET: below-show: /);
  assert.equal(fs.existsSync(out), false);
  const lines = await settledLines(p, 5);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'shadow'));
  assertAskedCandidates(await waitFor(() => a.asks().length && a.asks()));
});

test('(d) the server saw only the candidate pairs, in one call', async (t) => {
  const p = project(t);
  const a = await advised(t, p, 'show');
  plantResult(p.roots, p.root, SHOW_ONLY);
  const r = await similar(p, { json: true });
  assert.equal(r.json.shown, true);
  assertAskedCandidates(a.asks());
});

test('(e) from a linked worktree the decision\'s project is the main checkout', async (t) => {
  const scratch = createScratch('doflow-review-similar-root-');
  t.after(() => scratch.remove());
  const repo = makeRepo(scratch, 'main');
  const main = fs.realpathSync(repo.dir);
  const linked = path.join(scratch.dir, 'linked');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', linked);
  const p = project(t, scratch.dir, linked);
  const mainRoots = resolveRoots({ registry: STORAGE, projectRoot: main, env: p.env });
  await advised(t, p, 'show');
  // The result is keyed by the project's real path: it is found only when the decision's project is the main checkout.
  plantResult(mainRoots, main, SHOW_ONLY);
  const r = await similar(p, { json: true });
  assert.equal(r.status, 0);
  assert.equal(r.json.shown, true, r.json.reason);
  assert.equal(readWindow({ roots: mainRoots }).records.length, 5);
  assert.equal(p.lines().length, 0, 'nothing is recorded under the linked worktree');
});

test('(f) unreadable or invalid seats, or no feature: exit 1 naming the file or field; fewer than 2 findings: exit 0, no call', async (t) => {
  const p = project(t);
  const a = await advised(t, p, 'show');
  const put = (name: string, value: any) => {
    const file = path.join(p.dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };

  const missing = path.join(p.dir, 'absent.json');
  const unreadable = await similar(p, { seats: missing, json: true });
  assert.equal(unreadable.status, 1);
  assert.deepEqual([unreadable.json.ok, unreadable.json.error], [false, 'seats-unreadable']);
  assert.ok(unreadable.json.message.includes(missing));

  const cases: Array<[any, string, string]> = [
    ['{not json', '$', 'json'],
    [[], '$', 'object'],
    [{ seats: SEATS.seats }, 'schema', 'schema'],
    [{ schema: 1, seats: {} }, 'seats', 'seats'],
    [{ schema: 1, seats: [SEATS.seats[0], { id: 'seat-a', findings: [] }] }, 'seats[1].id', 'seat'],
    [{ schema: 1, seats: [{ id: 'seat-a' }] }, 'seats[0].findings', 'seat'],
    [{ schema: 1, seats: [{ id: 'seat-a', findings: [finding('A-1'), { ...finding('A-2'), severity: 'major' }] }] }, 'seats[0].findings[1].severity', 'seat-finding'],
    [{ schema: 1, seats: [{ id: 'seat-a', findings: [finding('A-1'), finding('A-1')] }] }, 'seats[0].findings[1].id', 'seat-finding'],
    [{ schema: 1, seats: [{ id: 'seat-a', findings: [{ ...finding('A-1'), locator: ' ' }] }] }, 'seats[0].findings[0].locator', 'seat-finding'],
    [{ schema: 1, seats: [{ id: 'seat-a', model: '', findings: [] }] }, 'seats[0]', 'seat-identity:seat-a'],
  ];
  for (const [value, field, rule] of cases) {
    const r = await similar(p, { seats: put('bad.json', value), json: true });
    assert.equal(r.status, 1, field);
    assert.deepEqual([r.json.error, r.json.field], ['seats-invalid', field]);
    assert.ok(r.json.message.endsWith(`: ${field} fails the seat rules (${rule})`), r.json.message);
    const text = await similar(p, { seats: put('bad.json', value) });
    assert.deepEqual([text.status, text.lines], [1, [`doflow review: ${r.json.message}`]]);
  }

  const noFeature = await similar(p, { resolve: () => ({ error: 'no-active-feature', message: 'no-active-feature — checkout a feat/<NNN-slug> branch' }), json: true });
  assert.equal(noFeature.status, 1);
  assert.deepEqual(noFeature.json, { ok: false, error: 'no-feature', message: 'no-active-feature — checkout a feat/<NNN-slug> branch' });

  const one = await similar(p, { seats: put('one.json', { schema: 1, seats: [{ id: 'seat-a', findings: [finding('A-1')] }] }), json: true });
  assert.equal(one.status, 0);
  assert.deepEqual([one.json.findings, one.json.candidates, one.json.batches, one.json.shown], [1, 0, 0, false]);
  // A full findings record qualifies as a seats file.
  const record = await similar(p, { seats: path.join(REPO_ROOT, 'test/fixtures/roadmap/findings/schema-1.json'), json: true });
  assert.deepEqual([record.status, record.json.findings], [0, 2]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.asks().length, 0, 'no candidate pair, no call');
});

/** Every regular file under `root` as relative path -> bytes, leaving out the decision record store the dispatcher writes. */
function tree(root: string, base: string = root, out: Record<string, string> = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (rel === path.join('proj', '.doflow', 'state', 'advice') || rel === path.join('home', '.doflow', 'state', 'advice')) continue;
    if (entry.isDirectory()) tree(full, base, out);
    else out[rel] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('(g) the verb writes nothing but --out: no findings record, no converged.md, the seats file untouched', async (t) => {
  const p = project(t);
  await advised(t, p, 'show');
  plantResult(p.roots, p.root, SHOW_ONLY);
  const before = tree(p.dir);
  const out = path.join(p.dir, 'possible-duplicates.md');
  const r = await similar(p, { outFile: out });
  assert.equal(r.status, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = tree(p.dir);
  assert.deepEqual(Object.keys(after).filter((rel) => after[rel] !== before[rel]), ['possible-duplicates.md']);
  assert.deepEqual(Object.keys(before).filter((rel) => !(rel in after)), []);
});

test('(h) --json is pinned, shown and not shown', async (t) => {
  const p = project(t);
  await advised(t, p);
  const unset = await similar(p, { json: true });
  assert.equal(unset.lines.length, 1);
  assert.equal(unset.lines[0], `{"schema":1,"slug":"${SLUG}","findings":8,"candidates":5,"batches":1,"mode":"shadow","reason":"shadow","shown":false,"out":null}`);
  await settledLines(p, 5);

  const shown = project(t);
  await advised(t, shown, 'show');
  plantResult(shown.roots, shown.root, SHOW_ONLY);
  const out = path.join(shown.dir, 'possible-duplicates.md');
  const r = await similar(shown, { outFile: out, json: true });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0], `{"schema":1,"slug":"${SLUG}","findings":8,"candidates":5,"batches":1,"mode":"show","reason":null,"shown":true,"pairs":[`
    + '{"a":"A-1","b":"B-1","score":1.15,"rule":"yes","model":"same-issue"},{"a":"A-3","b":"B-4","score":0.59,"rule":"yes","model":"no-answer"},'
    + `{"a":"A-2","b":"B-2","score":0.31,"rule":"no","model":"same-issue"}],"out":${JSON.stringify(out)}}`);
});

test('through the dispatcher: the feature\'s review/seats.json by --slug, --seats and --out parsed, usage errors exit 2', (t) => {
  const scratch = createScratch('doflow-review-similar-cli-');
  t.after(() => scratch.remove());
  const repo = makeRepo(scratch, 'cli');
  const dir = fs.realpathSync(repo.dir);
  const review = path.join(dir, 'agent-docs', 'doflow', SLUG, 'review');
  fs.mkdirSync(review, { recursive: true });
  fs.writeFileSync(path.join(review, 'seats.json'), JSON.stringify({ schema: 1, seats: [{ id: 'seat-a', findings: [finding('A-1')] }] }));
  const cli = (args: string[]) => spawnSync(bashPath(), [RUN, 'review', '--action', 'similar', ...args], { cwd: dir, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' });

  const r = cli(['--slug', SLUG, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `{"schema":1,"slug":"${SLUG}","findings":1,"candidates":0,"batches":0,"mode":"off","reason":"no candidate pairs","shown":false,"out":null}`);
  const seats = path.join(dir, 'other.json');
  fs.writeFileSync(seats, JSON.stringify({ schema: 1, seats: [] }));
  const other = cli(['--slug', SLUG, '--seats', seats, '--out', path.join(dir, 'list.md'), '--json']);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(JSON.parse(other.stdout).findings, 0);
  assert.equal(fs.existsSync(path.join(dir, 'list.md')), false);

  for (const [args, message] of [
    [['--path', 'x.json'], /--path, --base and --preset are not valid with --action similar/],
    [['--out', ' '], /flag values must not be empty/],
  ] as Array<[string[], RegExp]>) {
    const bad = cli([...args, '--json']);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(JSON.parse(bad.stdout).message, message);
  }
  const check = spawnSync(bashPath(), [RUN, 'review', '--action', 'check', '--seats', seats, '--json'], { cwd: dir, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' });
  assert.equal(check.status, 2);
  assert.match(JSON.parse(check.stdout).message, /--seats and --out are valid only with --action similar/);
});
