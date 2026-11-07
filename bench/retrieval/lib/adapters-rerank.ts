'use strict';

/**
 * Rerank arms over configuration A's candidate lists (141 DEC-030, IC-006): for each dev-split task the shortlist is
 * built by the shipped builders (src/runtime/advice/rerank.ts), the decision model is asked through an injected client,
 * and nDCG@5 of the model order is set against nDCG@5 of the first-stage order. An invalid reply counts as the
 * first-stage order, so a failure stays in the denominator.
 *
 * The sealed holdout is never read here: the only task file this module opens is the one `snapshot.taskFiles.dev`
 * names, and any path that mentions the holdout directory is refused before it is touched.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildRerankQuestionSet, interpretRerankAnswers } = require('../../../src/runtime/advice/rerank.ts');
const { summarizeCases } = require('../../../src/runtime/advice/gate-score.ts');
const { ndcgAt5Of, hits } = require('./metrics.ts');

const RERANK_KIND = 'rerank';
const ARMS = ['choice', 'ladder'];
/** Incremented by hand when the dev task set or the way first-stage lists are cut changes (IC-004 `corpusVersion`). */
const RERANK_CORPUS_VERSION = 1;
const HOLDOUT_PATH = /(^|[\\/])holdout([\\/]|$)|\.seal(ed)?\.json$/i;

/** Throws when `file` names the holdout directory or a seal file; every read in this module goes through it. */
function assertNotHoldout(file: string): string {
  if (HOLDOUT_PATH.test(String(file))) throw new Error(`refusing to read a holdout path (${path.basename(String(file))}): the rerank gate scores the dev split only`);
  return file;
}

/** A first-stage candidate as the builder takes it: a locator, a title and the snippet text. */
function toBuilderCandidate(c: any) {
  const lines = Number.isInteger(c.startLine) ? `:${c.startLine}${Number.isInteger(c.endLine) && c.endLine !== c.startLine ? `-${c.endLine}` : ''}` : '';
  return { ref: `${c.path}${lines}`, title: typeof c.heading === 'string' ? c.heading : '', text: typeof c.snippet === 'string' ? c.snippet : '' };
}

/** `candidates` (first-stage order) reordered by `order` (labels A..), ranks renumbered, unlabelled extras kept after. */
function reorder(candidates: any[], labels: string[], order: string[]) {
  const picked = order.map((label) => candidates[labels.indexOf(label)]);
  const rest = candidates.slice(labels.length);
  return [...picked, ...rest].map((c, i) => ({ ...c, rank: i + 1 }));
}

function isRelevant(corpus: string, candidate: any, qrels: any[]): boolean {
  return qrels.some((q: any) => q.rel >= 1 && hits(corpus, candidate, q));
}

/**
 * Scores one arm over `items` (`[{ id, corpus, class, query, qrels, candidates }]`, candidates in first-stage order).
 * `ask(request)` is the advice client's `ask`. Returns `{ cases, outcomes, skipped, ladderRows }`:
 * `cases` feed `summarizeCases(…, 'rerank')`; a task with fewer than `params.minCandidates` candidates gets no call
 * (the runtime sends none either) and is listed in `skipped` instead of being counted for or against the model.
 */
async function scoreArm({ arm, items, ask, model, criteria, kindEntry, limits }: any) {
  const cases: any[] = [];
  const outcomes: any[] = [];
  const skipped: any[] = [];
  const ladderRows: any[] = [];
  for (const item of items) {
    const staticNdcg = ndcgAt5Of(item.corpus, item.candidates, item.qrels);
    const built = buildRerankQuestionSet({
      query: item.query, candidates: item.candidates.map(toBuilderCandidate), params: kindEntry.params, arm,
      criteria, scoreLadder: kindEntry.scoreLadder, limits,
    });
    if (!built.ok && built.reason === 'too-few-candidates') {
      skipped.push({ id: item.id, reason: built.reason });
      outcomes.push({ id: item.id, status: 'skipped', valid: null, reason: built.reason, ndcgStatic: staticNdcg, ndcgModel: null, latencyMs: 0 });
      continue;
    }
    let valid = false;
    let status = built.ok ? 'unavailable' : `build-failed:${built.reason}`;
    let latencyMs = 0;
    let order: string[] | null = null;
    let read: any = null;
    if (built.ok) {
      const started = Date.now();
      const result = await ask({
        questionSet: built.questionSet, kind: RERANK_KIND, staticAnswer: arm === 'choice' ? 'A' : undefined,
        caller: 'bench', record: false, model,
      });
      latencyMs = Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? result.durationMs : Date.now() - started;
      status = result?.status ?? 'unavailable';
      if (result?.status === 'answered') {
        read = interpretRerankAnswers(result.answers, built.labels, arm);
        valid = read.valid === true;
        if (valid) order = read.order;
        else status = 'invalid-reply';
      }
    }
    const effective = valid && order ? reorder(item.candidates, built.labels, order) : item.candidates;
    const modelNdcg = valid ? ndcgAt5Of(item.corpus, effective, item.qrels) : staticNdcg;
    cases.push({ valid, ndcgModel: modelNdcg, ndcgStatic: staticNdcg, latencyMs });
    outcomes.push({
      id: item.id, status, valid, order, ndcgStatic: staticNdcg, ndcgModel: modelNdcg, excluded: staticNdcg === null, latencyMs,
    });
    if (arm === 'ladder' && valid) {
      built.labels.forEach((_label: string, i: number) => {
        ladderRows.push({ id: item.id, expected: read.expected[i], confidence: read.confidence[i], relevant: isRelevant(item.corpus, item.candidates[i], item.qrels) });
      });
    }
  }
  return { cases, outcomes, skipped, ladderRows };
}

/**
 * Paired nDCG@5 difference ladder minus choice over the tasks both arms scored (IC-004 `armDelta`): the same seeded
 * bootstrap as the gate, run over per-task effective scores. Returns `{ versus, delta, ci, n }`; `n` is printed, not stored.
 */
function armDifference(choiceCases: any[], ladderCases: any[], gate: any) {
  const effective = (c: any) => (c.valid ? c.ndcgModel : c.ndcgStatic);
  const paired = choiceCases.map((c, i) => ({ valid: true, ndcgModel: c.ndcgStatic === null ? null : effective(ladderCases[i]), ndcgStatic: c.ndcgStatic === null ? null : effective(c), latencyMs: 0 }));
  const summary = summarizeCases(paired, gate, RERANK_KIND);
  return { versus: 'choice', delta: summary.quality.delta, ci: summary.quality.ci, n: paired.length - summary.quality.excluded };
}

/**
 * For each registry threshold value, how many ladder-scored candidates would fall below it and how many of those are
 * judged relevant (DEC-029). Counts only; nothing is dropped and the numbers feed no check.
 */
function wouldDrop(rows: any[], thresholds: any) {
  const relevantTotal = rows.filter((r) => r.relevant).length;
  const out: any[] = [];
  for (const [field, key] of [['confidence', 'confidenceBelow'], ['expected', 'expectedBelow']] as const) {
    for (const below of Array.isArray(thresholds?.[key]) ? thresholds[key] : []) {
      const dropped = rows.filter((r) => r[field] < below);
      out.push({ field, below, candidates: rows.length, dropped: dropped.length, relevantDropped: dropped.filter((r) => r.relevant).length, relevantTotal });
    }
  }
  return out;
}

/**
 * Configuration A's candidate lists for the dev split, read the way `retrieval run` reads them (verify, export the
 * pinned commit, validate the dev task file, run the adapters). Guidance configuration A is configuration B.
 * `deps` replaces any collaborator so a test needs no tool, export or index. Returns `{ items, snapshotId, tasksSha256 }`.
 */
function collectFirstStage({ repoRoot, snapshotPath, tmp, deps = {} }: any) {
  const snapshotLib = require('./snapshot.ts');
  const tasksLib = require('./tasks.ts');
  const adapters = require('./adapters.ts');
  const adaptersA = require('./adapters-a.ts');
  const environment = require('./environment.ts');
  const sealLib = require('./seal.ts');
  const verifyVerb = require('./verbs/verify.ts');
  const d = {
    verifySnapshot: verifyVerb.verifySnapshot, materialiseExport: environment.materialiseExport,
    buildIndexes: adaptersA.buildIndexes, runConfig: adapters.runConfig, ...deps,
  };
  const snapshotFile = snapshotPath || path.join(snapshotLib.RETRIEVAL_DIR, snapshotLib.SNAPSHOT_FILE);
  const verified = d.verifySnapshot({ snapshotPath: snapshotFile, repoRoot });
  if (verified.exitCode !== 0) throw new Error(`first-stage lists unavailable: ${verified.message}`);
  const snapshot = verified.snapshot;
  const manifest = snapshotLib.loadManifest(path.resolve(repoRoot, snapshot.manifestPath));
  const taskFile = path.resolve(repoRoot, assertNotHoldout(snapshot.taskFiles.dev.path));
  const text = fs.readFileSync(assertNotHoldout(taskFile));
  const tasksSha256 = sealLib.sha256Hex(text);
  const tasks = JSON.parse(text.toString('utf8'));
  const findings = tasksLib.validateTaskFile(tasks, { split: 'dev', snapshot, manifest, repoRoot });
  if (findings.length > 0) throw new Error(`dev task file has ${findings.length} finding(s): ${findings.slice(0, 3).map((f: any) => `${f.code} ${f.taskId || '-'}`).join(', ')}`);

  const exported = d.materialiseExport(snapshot.commit, path.join(tmp, 'export'), snapshot, { repoRoot });
  try {
    const semble = { env: require('../runner.ts').childEnv({ SEMBLE_CACHE_DIR: path.join(tmp, 'semble-cache') }) };
    const manifestPaths = manifest.entries.filter((e: any) => e.corpus === 'code').map((e: any) => e.path);
    const codeTasks = tasks.tasks.filter((t: any) => t.corpus === 'code');
    if (codeTasks.length > 0) {
      const probe = manifest.entries.find((e: any) => e.corpus === 'code' && /^src\/.*\.(ts|js)$/.test(e.path));
      d.buildIndexes({ exportRoot: exported.treeRoot, semble, patchFile: probe ? path.join(exported.treeRoot, probe.path) : undefined });
    }
    const items = tasks.tasks.map((task: any) => {
      const answer = d.runConfig({
        config: task.corpus === 'guidance' ? 'B' : 'A', corpus: task.corpus, task, exportRoot: exported.treeRoot, snapshot,
        workDir: path.join(tmp, 'copies'), semble, scratchDir: path.join(tmp, 'scratch'), repoRoot,
        admittedPaths: task.corpus === 'code' ? manifestPaths : undefined,
      });
      const candidates = (answer.candidates || []).map((c: any, i: number) => ({ ...c, rank: Number.isInteger(c.rank) ? c.rank : i + 1 }));
      return { id: task.id, corpus: task.corpus, class: task.class, query: task.query, qrels: task.qrels, candidates };
    });
    return { items, snapshotId: snapshot.snapshotId, tasksSha256 };
  } finally {
    exported.cleanup();
  }
}

module.exports = {
  RERANK_KIND, ARMS, RERANK_CORPUS_VERSION,
  assertNotHoldout, toBuilderCandidate, reorder, scoreArm, armDifference, wouldDrop, collectFirstStage,
};
