'use strict';

// 141 B.7: nDCG@5 for both corpora, the two rerank arms over configuration A's candidate lists, and the
// `advice-gate --kind rerank` branch. A fake client only: no model call, no network, no tool, no write to the shipped
// verdict file (the tests that use --write point at a temp registry directory).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { resolveRerankCriteria } = require('../../src/runtime/advice/criteria.ts');
const { adviceGate } = require('../../bench/advice-gate.ts');
const metrics = require('../../bench/retrieval/lib/metrics.ts');
const rerankLib = require('../../bench/retrieval/lib/adapters-rerank.ts');
const snapshotLib = require('../../bench/retrieval/lib/snapshot.ts');

const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT });
assert.equal(ADVICE.ok, true);
const REGISTRY = ADVICE.registry;
const RERANK = REGISTRY.kinds.find((kind: any) => kind.id === 'rerank');
const EMPTY = { schemaVersion: 1, corpora: {}, verdicts: [] };
const SETTING = { state: 'on', model: 'fake-model', endpoint: 'http://127.0.0.1:1', provider: 'ollama', decidedBy: {} };
const REAL_VERDICT_FILE = path.join(REPO_ROOT, 'core/registry/advice-verdicts.json');
const SHA = 'ab'.repeat(32);

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ---------------------------------------------------------------- nDCG@5

function codeTask(qrels: any[]) { return { corpus: 'code', class: 'conceptual-discovery', qrels, expect: { result: ['RETRIEVED'] } }; }
function guidanceTask(qrels: any[]) { return { corpus: 'guidance', class: 'conceptual-discovery', qrels, expect: { result: ['RETRIEVED'] } }; }
function answer(candidates: any[]) { return { result: 'RETRIEVED', candidates, providers: [], payloadBytes: 0 }; }
const pathInfo = () => ({ lineCount: 1000 });

test('ndcgAt5 is a metric for the code corpus and the guidance corpus, and the existing metrics are still there', () => {
  const code = metrics.scoreTask({
    task: codeTask([{ id: 'q1', path: 'a.ts', startLine: 10, endLine: 12, rel: 2 }]),
    answer: answer([
      { path: 'z.ts', startLine: 1, endLine: 2, rank: 1 },
      { path: 'a.ts', startLine: 11, endLine: 11, rank: 2 },
    ]),
    pathInfo,
  });
  assert.ok(Math.abs(code.metrics.ndcgAt5 - 1 / Math.log2(3)) < 1e-12, 'a hit at rank 2 with the ideal at rank 1');
  for (const name of ['recallAt1', 'recallAt5', 'recallAt10', 'mrrAt10', 'ndcgAt10', 'fileRecallAt5']) {
    assert.ok(name in code.metrics, `${name} is kept`);
  }

  const guidance = metrics.scoreTask({
    task: guidanceTask([{ id: 'q1', path: 'g.md', heading: 'Intro', rel: 1 }]),
    answer: answer([{ path: 'g.md', heading: 'Intro', rank: 1 }, { path: 'h.md', heading: 'Other', rank: 2 }]),
    pathInfo,
  });
  assert.equal(guidance.metrics.ndcgAt5, 1);
  assert.equal('ndcgAt10' in guidance.metrics, false, 'ndcgAt10 stays a code metric');
});

test('ndcgAt5Of is null without a judged positive, cuts at 5 and orders by rank', () => {
  const qrel = { id: 'q1', path: 'g.md', heading: 'Six', rel: 1 };
  const six = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((heading, i) => ({ path: 'g.md', heading, rank: i + 1 }));
  assert.equal(metrics.ndcgAt5Of('guidance', six, [qrel]), 0, 'a hit at rank 6 is outside the cut');
  assert.equal(metrics.ndcgAt5Of('guidance', [...six].reverse(), [qrel]), 0, 'candidates are read in rank order, not array order');
  assert.equal(metrics.ndcgAt5Of('guidance', six.map((c, i) => ({ ...c, rank: 6 - i })), [qrel]), 1, 'renumbered ranks move the hit to the top');
  assert.equal(metrics.ndcgAt5Of('guidance', six, []), null);
  assert.equal(metrics.ndcgAt5Of('guidance', six, [{ ...qrel, rel: 0 }]), null);
  assert.throws(() => metrics.ndcgAt5Of('prose', six, [qrel]), /unknown corpus/);
});

// ---------------------------------------------------------------- synthetic first-stage lists and a fake client

const LABELS = 'ABCDEFGHIJKLMNOP';

/** `count` code tasks, 6 candidates each; the one relevant candidate sits at index `3` (rank 4) except for special ids. */
function syntheticItems(count: number, { noPositive = [] as number[], single = [] as number[] } = {}) {
  return Array.from({ length: count }, (_value, i) => {
    const relevantAt = 3;
    const candidates = Array.from({ length: single.includes(i) ? 1 : 6 }, (_c, j) => ({
      path: `src/t${i}/f${j}.ts`, startLine: 1, endLine: 10, heading: null, rank: j + 1, snippet: `snippet ${i} ${j}`,
    }));
    const qrels = noPositive.includes(i)
      ? [{ id: 'q1', path: `src/t${i}/f${relevantAt}.ts`, startLine: 1, endLine: 10, rel: 0 }]
      : [{ id: 'q1', path: `src/t${i}/f${relevantAt}.ts`, startLine: 1, endLine: 10, rel: 2 }];
    return { id: `T-${String(i).padStart(3, '0')}`, corpus: 'code', class: 'conceptual-discovery', query: `query number ${i}`, qrels, candidates };
  });
}

/** A fake decision client. `fail` ids get an unavailable call; `garbage` ids an answered call that cannot be read. */
function fakeClient({ items, fail = [] as string[], garbage = [] as string[], calls = [] as any[], delayMs = 5 }: any) {
  const byQuery = new Map<string, any>(items.map((item: any) => [item.query, item]));
  return {
    calls,
    async inspect() { return { endpoint: { state: 'reached' }, model: { installed: true, decisionCapable: true } }; },
    async ask(request: any) {
      calls.push(request);
      const query = /^query: (.*)$/m.exec(request.questionSet.state)?.[1];
      const item = byQuery.get(query as string);
      if (fail.includes(item.id)) return { status: 'unavailable', answers: [], durationMs: delayMs };
      const questions = request.questionSet.questions;
      // The relevant candidate is the one whose label sits at the qrel's index: promote it to the top.
      const relevant = Number(/f(\d+)\.ts/.exec(item.qrels[0].path)?.[1]);
      if (questions.length === 1) {
        if (garbage.includes(item.id)) return { status: 'answered', answers: [{ name: 'rerank', type: 'choice', pick: 'A', probabilities: { A: 'x' } }], durationMs: delayMs };
        const labels = Object.keys(questions[0].options);
        const probabilities = Object.fromEntries(labels.map((label, i) => [label, i === relevant ? 0.9 : 0.1 - i * 0.01]));
        return { status: 'answered', answers: [{ name: 'rerank', type: 'choice', pick: LABELS[relevant], probabilities }], durationMs: delayMs };
      }
      if (garbage.includes(item.id)) return { status: 'answered', answers: questions.map((q: any) => ({ name: q.name, type: 'score', score: 9, confidence: 2 })), durationMs: delayMs };
      return {
        status: 'answered', durationMs: delayMs,
        answers: questions.map((q: any, i: number) => ({ name: q.name, type: 'score', score: i === relevant ? 3.5 : 0.5, confidence: i === relevant ? 0.9 : 0.3 })),
      };
    },
  };
}

function registryDir(t: any, verdicts: any = EMPTY) {
  const dir = tempDir(t, 'doflow-rerank-gate-');
  fs.writeFileSync(path.join(dir, 'advice-verdicts.json'), JSON.stringify(verdicts));
  return { dir, file: path.join(dir, 'advice-verdicts.json') };
}

function run(t: any, { items, client, arm, write = false, verdicts = EMPTY, extra = {} }: any) {
  const reg = registryDir(t, verdicts);
  const out: string[] = [];
  const err: string[] = [];
  const clientUsed = client ?? fakeClient({ items });
  return adviceGate({
    kind: 'rerank', arm, write, adviceRegistry: REGISTRY, setting: SETTING, client: clientUsed, registryDir: reg.dir,
    criteriaValue: null, firstStage: () => ({ items, snapshotId: 1, tasksSha256: SHA }),
    now: () => new Date('2026-11-06T00:00:00.000Z'), log: (s: string) => out.push(s), error: (s: string) => err.push(s),
    ...extra,
  }).then((result: any) => ({ ...result, out, err, reg, client: clientUsed }));
}

// ---------------------------------------------------------------- the gate branch

test('--arm both scores both arms over the same tasks, prints two verdicts and the paired difference', async (t) => {
  const items = syntheticItems(40);
  const result = await run(t, { items, arm: 'both' });
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.deepEqual(result.verdicts.map((v: any) => v.arm), ['choice', 'ladder']);
  assert.equal(result.client.calls.length, 80, 'the choice arm asks once per task and the ladder arm once per task');
  assert.equal(result.client.calls.filter((c: any) => c.questionSet.questions.length === 6).length, 40, 'one score question per candidate');
  assert.equal(result.client.calls.every((c: any) => c.record === false && c.kind === 'rerank' && c.caller === 'bench'), true);

  const [choice, ladder] = result.verdicts;
  for (const verdict of result.verdicts) {
    assert.equal(verdict.kind, 'rerank');
    assert.equal(verdict.model, 'fake-model');
    assert.equal(verdict.n, 40);
    assert.equal(verdict.valid, 40);
    assert.equal(verdict.quality.metric, 'ndcg@5');
    assert.ok(verdict.quality.model > verdict.quality.static, 'promoting the relevant candidate raises nDCG@5');
    assert.equal(verdict.corpusVersion, rerankLib.RERANK_CORPUS_VERSION);
    assert.equal(verdict.corpusDigest, `sha256:${SHA}`);
    assert.match(verdict.criteriaDigest, /^[0-9a-f]{12}$/);
  }
  assert.equal(choice.armDelta, null);
  assert.equal(ladder.armDelta.versus, 'choice');
  assert.equal(ladder.armDelta.delta, 0, 'both fake arms promote the same candidate');
  assert.equal(result.out.length, 1);
  const text = result.out[0];
  assert.match(text, /advice-gate rerank arm choice \(fake-model\)/);
  assert.match(text, /advice-gate rerank arm ladder \(fake-model\)/);
  assert.match(text, /paired nDCG@5, ladder minus choice: 0\.000, ci \[0\.000, 0\.000\], n 40/);
  assert.match(text, /would drop \(ladder, confidence < 0\.5\): 200 of 240 candidates, 0 of 40 judged-relevant/);
  assert.match(text, /would drop \(ladder, expected < 2\): 200 of 240 candidates, 0 of 40 judged-relevant/);
  assert.match(text, /not written \(pass --write/);
  assert.deepEqual(readJson(result.reg.file), EMPTY, 'nothing is written without --write');
});

test('an arm can be asked on its own, and --arm defaults to both', async (t) => {
  const items = syntheticItems(30);
  const ladder = await run(t, { items, arm: 'ladder' });
  assert.deepEqual(ladder.verdicts.map((v: any) => v.arm), ['ladder']);
  assert.equal(ladder.verdict.armDelta, null, 'the difference needs both arms');
  assert.equal(ladder.client.calls.length, 30);

  const choice = await run(t, { items, arm: 'choice' });
  assert.deepEqual(choice.verdicts.map((v: any) => v.arm), ['choice']);
  assert.equal(choice.client.calls.every((c: any) => c.staticAnswer === 'A' && c.questionSet.questions.length === 1), true);

  const dflt = await run(t, { items });
  assert.deepEqual(dflt.verdicts.map((v: any) => v.arm), ['choice', 'ladder']);
});

test('invalid and unavailable replies count as the first-stage order and stay in the denominator', async (t) => {
  const items = syntheticItems(40);
  const failed = items.slice(0, 2).map((item) => item.id);
  const garbage = items.slice(2, 4).map((item) => item.id);
  const client = fakeClient({ items, fail: failed, garbage });
  const { verdicts, err } = await run(t, { items, client, arm: 'both' });
  assert.deepEqual(err, []);
  for (const verdict of verdicts) {
    assert.equal(verdict.n, 40);
    assert.equal(verdict.valid, 36);
    assert.equal(verdict.validShare, 36 / 40);
    assert.equal(verdict.result, 'fail');
    assert.ok(verdict.failedChecks.includes('valid-share'));
    // 36 tasks reach nDCG 1 (the relevant candidate on top); the 4 invalid ones keep the first-stage score 1/log2(5).
    const first = 1 / Math.log2(5);
    assert.ok(Math.abs(verdict.quality.model - (36 + 4 * first) / 40) < 1e-12);
    assert.ok(Math.abs(verdict.quality.static - first) < 1e-12);
  }
});

test('a task with no judged positive is excluded from quality and listed; a task with one candidate is skipped and listed', async (t) => {
  const items = syntheticItems(34, { noPositive: [0, 1], single: [2] });
  const result = await run(t, { items, arm: 'both', extra: { json: true } });
  assert.equal(result.code, 0, result.err.join('\n'));
  const printed = JSON.parse(result.out[0]);
  assert.deepEqual(printed.excluded, ['T-000', 'T-001']);
  assert.deepEqual(printed.skipped, ['T-002']);
  for (const verdict of result.verdicts) {
    assert.equal(verdict.n, 33, 'the skipped task got no call and is not counted for or against the model');
    assert.equal(verdict.quality.excluded, 2);
    assert.equal(verdict.valid, 33, 'the excluded tasks were still asked and answered');
  }
  assert.equal(printed.armDelta.n, 31);
  assert.equal(printed.cases.choice.length, 34);
  assert.equal(printed.cases.choice.find((o: any) => o.id === 'T-002').status, 'skipped');
  assert.equal(result.client.calls.length, 66);
});

test('the verdict is bound to the criteria in force: the digest comes from resolveRerankCriteria', async (t) => {
  const items = syntheticItems(30);
  const registryCriteria = resolveRerankCriteria({ value: null, kind: RERANK });
  const base = await run(t, { items, arm: 'both' });
  assert.equal(base.verdicts.every((v: any) => v.criteriaDigest === registryCriteria.digest), true);

  const custom = [
    'Not related.', 'Same topic only.', 'Part of the answer.', 'Nearly all of the answer.', 'The whole answer.', 'Pick the best passage.',
  ].join('\n');
  const overridden = await run(t, { items, arm: 'both', extra: { criteriaValue: custom } });
  const expected = resolveRerankCriteria({ value: custom, kind: RERANK });
  assert.equal(expected.source, 'settings');
  assert.notEqual(expected.digest, registryCriteria.digest);
  assert.equal(overridden.verdicts.every((v: any) => v.criteriaDigest === expected.digest), true);
  // The texts in force reach the questions: the choice instruction on the choice arm, the ladder on the ladder arm.
  const choiceCall = overridden.client.calls.find((c: any) => c.questionSet.questions.length === 1);
  assert.equal(choiceCall.questionSet.questions[0].instructions, 'Pick the best passage.');
  const ladderCall = overridden.client.calls.find((c: any) => c.questionSet.questions.length > 1);
  assert.deepEqual(ladderCall.questionSet.questions[0].criteria.slice(0, 2), ['Not related.', 'Same topic only.']);

  const invalid = await run(t, { items, arm: 'ladder', extra: { criteriaValue: 'one line only' } });
  assert.equal(invalid.verdicts[0].criteriaDigest, registryCriteria.digest, 'an invalid override leaves the registry text and its digest in force');
  assert.match(invalid.out[0], /criteria: advice\.criteria\.rerank has 1 lines/);
});

test('--write stores one verdict per (kind, model, arm) in a temp registry, replacing only its own entries', async (t) => {
  const items = syntheticItems(30);
  const other = { kind: 'tier', model: 'fake-model', arm: null, criteriaDigest: null, n: 30 };
  const stale = { kind: 'rerank', model: 'fake-model', arm: 'choice', criteriaDigest: 'ffffffffffff', n: 1 };
  const otherModel = { kind: 'rerank', model: 'other-model', arm: 'ladder', criteriaDigest: 'ffffffffffff', n: 1 };
  const seeded = { schemaVersion: 1, corpora: { tier: { corpusVersion: 1, digest: 'sha256:x', heldoutCases: 30 } }, verdicts: [other, stale, otherModel] };
  const result = await run(t, { items, arm: 'both', write: true, verdicts: seeded });
  assert.equal(result.code, 0, result.err.join('\n'));
  const stored = readJson(result.reg.file);
  assert.equal(stored.verdicts.length, 4);
  assert.deepEqual(stored.verdicts[0], other);
  assert.equal(stored.verdicts[1].arm, 'choice', 'the stale choice entry is replaced in place');
  assert.equal(stored.verdicts[1].n, 30);
  assert.deepEqual(stored.verdicts[2], otherModel);
  assert.equal(stored.verdicts[3].arm, 'ladder');
  assert.deepEqual(stored.corpora.rerank, { corpusVersion: 1, digest: `sha256:${SHA}`, heldoutCases: 30, snapshotId: 1 });
  assert.deepEqual(stored.corpora.tier, seeded.corpora.tier);
  assert.match(result.out[0], /verdict written/);
  // The file holds aggregates only.
  const text = fs.readFileSync(result.reg.file, 'utf8');
  assert.equal(/query number|snippet \d|src\/t\d/.test(text), false);

  const again = await run(t, { items, arm: 'both', write: true, verdicts: stored });
  assert.equal(readJson(again.reg.file).verdicts.length, 4, 'a second run replaces, never appends');

  assert.deepEqual(readJson(REAL_VERDICT_FILE), EMPTY, 'the shipped verdict file is still empty');
});

test('--write refuses a changed dev task set whose corpusVersion did not increase', async (t) => {
  const items = syntheticItems(30);
  const seeded = { schemaVersion: 1, corpora: { rerank: { corpusVersion: 1, digest: 'sha256:other', heldoutCases: 30, snapshotId: 1 } }, verdicts: [] };
  const result = await run(t, { items, arm: 'both', write: true, verdicts: seeded });
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /--write refused: kind 'rerank': the dev tasks changed but corpusVersion is still 1/);
  assert.deepEqual(readJson(result.reg.file), seeded);
});

test('usage and setup errors', async (t) => {
  const items = syntheticItems(30);
  const badArm = await run(t, { items, arm: 'third' });
  assert.equal(badArm.code, 2);
  assert.match(badArm.err.join('\n'), /--arm must be choice, ladder or both/);

  const armOnTier = await adviceGate({ kind: 'tier', arm: 'choice', adviceRegistry: REGISTRY, error: () => {}, log: () => {} });
  assert.equal(armOnTier.code, 2);

  const off = await run(t, { items, arm: 'both', extra: { setting: { state: 'off', reason: 'disabled' } } });
  assert.equal(off.code, 1);
  assert.match(off.err.join('\n'), /advice is off/);

  const broken = await run(t, { items, arm: 'both', extra: { firstStage: () => { throw new Error('tool missing'); } } });
  assert.equal(broken.code, 1);
  assert.match(broken.err.join('\n'), /cannot build the first-stage candidate lists \(tool missing\)/);
});

// ---------------------------------------------------------------- the dev split only

test('holdout paths are refused by the module and never read when first-stage lists are collected', (t) => {
  assert.throws(() => rerankLib.assertNotHoldout('bench/retrieval/holdout/code.g1.sealed.json'), /holdout/);
  assert.throws(() => rerankLib.assertNotHoldout('/x/guidance.g2.seal.json'), /holdout/);
  assert.equal(rerankLib.assertNotHoldout('bench/retrieval/tasks/dev.json'), 'bench/retrieval/tasks/dev.json');

  const touched: string[] = [];
  const names = ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'readSync', 'createReadStream', 'readFile', 'cpSync'];
  const originals: Record<string, any> = {};
  for (const name of names) {
    originals[name] = (fs as any)[name];
    (fs as any)[name] = function spied(...args: any[]) {
      if (typeof args[0] === 'string' || Buffer.isBuffer(args[0])) touched.push(String(args[0]));
      return originals[name].apply(this, args);
    };
  }
  const tmp = tempDir(t, 'doflow-rerank-collect-');
  let collected: any;
  try {
    const snapshotPath = path.join(snapshotLib.RETRIEVAL_DIR, snapshotLib.SNAPSHOT_FILE);
    collected = rerankLib.collectFirstStage({
      repoRoot: REPO_ROOT, snapshotPath, tmp,
      deps: {
        verifySnapshot: () => ({ exitCode: 0, snapshot: snapshotLib.loadSnapshot(snapshotPath) }),
        materialiseExport: () => ({ treeRoot: path.join(tmp, 'tree'), cleanup() {} }),
        buildIndexes: () => ({}),
        runConfig: ({ task }: any) => ({
          result: 'RETRIEVED',
          candidates: task.qrels.map((q: any, i: number) => ({ path: q.path, startLine: q.startLine ?? null, endLine: q.endLine ?? null, heading: q.heading ?? null, rank: i + 1, snippet: 'x' })),
        }),
      },
    });
  } finally {
    for (const name of names) (fs as any)[name] = originals[name];
  }
  assert.equal(collected.items.length, 74);
  assert.equal(collected.items.filter((item: any) => item.corpus === 'guidance').length, 29);
  assert.equal(collected.items.filter((item: any) => item.corpus === 'code').length, 45);
  assert.equal(collected.snapshotId, snapshotLib.loadSnapshot(path.join(snapshotLib.RETRIEVAL_DIR, snapshotLib.SNAPSHOT_FILE)).snapshotId);
  assert.ok(touched.some((file) => file.endsWith(path.join('bench', 'retrieval', 'tasks', 'dev.json'))), 'the dev task file was read');
  const holdout = touched.filter((file) => /holdout|\.seal(ed)?\.json/i.test(file));
  assert.deepEqual(holdout, [], 'no holdout or seal path was touched');
});
