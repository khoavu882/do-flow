'use strict';

/**
 * Retrieval metrics (074 IC-009): the match rule, per-task scoring, class applicability, minimum n
 * and macro aggregation. Pure functions over an adapter answer (IC-008) and a task (IC-013); the
 * caller supplies `pathInfo` so this module never touches git or the file system.
 */

const { MIN_N } = require('./stats.js');

const RANKING_CLASSES = ['exact-lookup', 'conceptual-discovery', 'impact-refactor'];
const OUTCOME_CLASSES = ['stale-index', 'dirty-tree', 'unavailable-provider', 'oversized-context', 'verification-failure'];
const CLASSES = [...RANKING_CLASSES, ...OUTCOME_CLASSES];

/** Classes that do not apply to the guidance corpus, with the reason the report prints. */
const GUIDANCE_NA = {
  'impact-refactor': 'ADR 3.2: guidance import graphs do not replace code dependency graphs',
  'unavailable-provider': 'Guidance BM25 is in-process with no external provider',
  'verification-failure': 'No command runs against the guidance corpus',
};

const K = { code: [1, 5, 10], guidance: [1, 3, 5] };
const K_MAX = { code: 10, guidance: 5 };
const TOKENS_BASIS = 'estimated:bytes/4';

function kindOf(cls) {
  if (RANKING_CLASSES.includes(cls)) return 'ranking';
  if (OUTCOME_CLASSES.includes(cls)) return 'outcome';
  throw new Error(`unknown query class "${cls}"`);
}

/** `{applicable: true}` or `{applicable: false, reason}` for a class on a corpus. */
function applicability(cls, corpus) {
  kindOf(cls);
  if (corpus !== 'code' && corpus !== 'guidance') throw new Error(`unknown corpus "${corpus}"`);
  if (corpus === 'guidance' && GUIDANCE_NA[cls]) return { applicable: false, reason: GUIDANCE_NA[cls] };
  return { applicable: true };
}

function classesFor(corpus) {
  return CLASSES.filter((cls) => applicability(cls, corpus).applicable);
}

/** Minimum tasks per split and applicable corpus for a class. */
function minNFor(cls, minN = MIN_N) {
  return minN[kindOf(cls)];
}

function normHeading(heading) {
  return String(heading == null ? '' : heading).trim().replace(/^[#\s]+/, '');
}

/** Does `candidate` hit `qrel`? `fileLevel` requires only path equality. */
function hits(corpus, candidate, qrel, fileLevel = false) {
  if (candidate.path !== qrel.path) return false;
  if (fileLevel) return true;
  if (corpus === 'guidance') {
    return candidate.heading != null && normHeading(candidate.heading) === normHeading(qrel.heading);
  }
  if (candidate.startLine == null || candidate.endLine == null) return false;
  return candidate.startLine <= qrel.endLine && qrel.startLine <= candidate.endLine;
}

function ordered(candidates) {
  return candidates
    .map((c, i) => [c, i])
    .sort((x, y) => (x[0].rank - y[0].rank) || (x[1] - y[1]))
    .map((x) => x[0]);
}

/** Best (lowest) 1-based rank at which each qrel is hit within `k`; null when never hit. */
function bestRanks(corpus, cands, qrels, k, fileLevel) {
  return qrels.map((q) => {
    for (let i = 0; i < Math.min(k, cands.length); i++) {
      if (hits(corpus, cands[i], q, fileLevel)) return i + 1;
    }
    return null;
  });
}

function recall(corpus, cands, relevant, k, fileLevel) {
  if (relevant.length === 0) return null;
  const found = bestRanks(corpus, cands, relevant, k, fileLevel).filter((r) => r != null).length;
  return found / relevant.length;
}

function mrr(corpus, cands, relevant, k) {
  if (relevant.length === 0) return null;
  for (let i = 0; i < Math.min(k, cands.length); i++) {
    if (relevant.some((q) => hits(corpus, cands[i], q))) return 1 / (i + 1);
  }
  return 0;
}

function ndcg(corpus, cands, qrels, k) {
  const ranks = bestRanks(corpus, cands, qrels, k, false);
  const gainAtRank = new Map();
  ranks.forEach((r, i) => {
    if (r != null) gainAtRank.set(r, Math.max(gainAtRank.get(r) || 0, qrels[i].rel));
  });
  let dcg = 0;
  for (const [r, rel] of gainAtRank) dcg += (2 ** rel - 1) / Math.log2(r + 1);
  const ideal = qrels.map((q) => q.rel).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((rel, i) => { idcg += (2 ** rel - 1) / Math.log2(i + 2); });
  return idcg === 0 ? null : dcg / idcg;
}

function locatorValidity(cands, pathInfo, kMax) {
  const top = cands.slice(0, kMax);
  if (top.length === 0) return null;
  let valid = 0;
  for (const c of top) {
    const info = pathInfo(c.path);
    if (!info) continue;
    if (c.startLine == null || c.endLine == null) { valid++; continue; }
    if (c.startLine >= 1 && c.startLine <= c.endLine && c.endLine <= info.lineCount) valid++;
  }
  return valid / top.length;
}

/** Pack snippets in rank order until `budgetBytes`; a snippet that does not fit whole ends the pack. */
function pack(cands, budgetBytes) {
  const packed = [];
  let used = 0;
  for (const c of cands) {
    if (used + c.snippetBytes > budgetBytes) break;
    used += c.snippetBytes;
    packed.push(c);
  }
  return packed;
}

/**
 * Scores one task. `answer` is an IC-008 AdapterAnswer (plus `output` and `exitCode` for
 * verification-failure). `pathInfo(path)` returns `{lineCount}` or null for a path outside the manifest.
 * Returns `{metrics, na, graphMetrics?}`; a metric that is undefined for the task is null.
 */
function scoreTask({ task, answer, pathInfo }) {
  const corpus = task.corpus;
  const kMax = K_MAX[corpus];
  const cands = ordered(answer.candidates || []).slice(0, kMax);
  const relevant = task.qrels.filter((q) => q.rel >= 1);
  const metrics = {};
  const na = {};

  for (const k of K[corpus]) {
    metrics[`recallAt${k}`] = recall(corpus, cands, relevant, k, false);
    metrics[`fileRecallAt${k}`] = recall(corpus, cands, relevant, k, true);
  }
  metrics[`mrrAt${kMax}`] = mrr(corpus, cands, relevant, kMax);
  if (task.class === 'exact-lookup') {
    metrics.successAt1 = relevant.length === 0 ? null
      : (cands.length > 0 && task.qrels.some((q) => q.rel === 2 && hits(corpus, cands[0], q)) ? 1 : 0);
  }
  if (corpus === 'code') metrics.ndcgAt10 = ndcg(corpus, cands, task.qrels, 10);

  metrics.locatorValidity = locatorValidity(cands, pathInfo, kMax);
  if (metrics.locatorValidity === null) na.locatorValidity = true;

  if (task.class === 'impact-refactor') {
    const deps = task.dependencies || [];
    const found = bestRanks(corpus, cands, deps, 10, false).filter((r) => r != null).length;
    metrics.missedDependencies = deps.length === 0 ? null : 1 - found / deps.length;
    metrics.allDependenciesFound = deps.length === 0 ? null : (found === deps.length ? 1 : 0);
  }

  metrics.falseAbsence = relevant.length > 0 && answer.result === 'EMPTY' ? 1 : 0;
  metrics.statusMatch = (task.expect.result || []).includes(answer.result) ? 1 : 0;

  if (task.class === 'oversized-context') {
    const packed = pack(cands, task.expect.budgetBytes);
    const byId = new Map(task.qrels.map((q) => [q.id, q]));
    metrics.mustIncludeMet = (task.expect.mustInclude || []).every((id) => {
      const q = byId.get(id);
      return q !== undefined && packed.some((c) => hits(corpus, c, q));
    }) ? 1 : 0;
  }
  if (task.class === 'verification-failure') {
    const must = task.expect.mustSurvive;
    const out = String(answer.output == null ? '' : answer.output);
    metrics.mustSurviveMet = must.lines.every((line) => out.includes(line)) && answer.exitCode === must.exitCode ? 1 : 0;
  }

  const payloadBytes = answer.payloadBytes || 0;
  metrics.payloadBytes = payloadBytes;
  metrics.tokensEst = Math.ceil(payloadBytes / 4);
  if (answer.compressedBytes != null) metrics.compressedBytes = answer.compressedBytes;

  const out = { metrics, na };
  if (answer.graphCandidates && corpus === 'guidance') {
    const graph = ordered(answer.graphCandidates).slice(0, kMax);
    const gm = {};
    for (const k of K.guidance) gm[`recallAt${k}`] = recall(corpus, graph, relevant, k, false);
    gm[`mrrAt${kMax}`] = mrr(corpus, graph, relevant, kMax);
    out.graphMetrics = gm;
  }
  return out;
}

/** Macro mean over the tasks where the value is defined, with `n` beside it. */
function macro(values) {
  const defined = values.filter((v) => v != null);
  if (defined.length === 0) return { value: null, n: 0, na: true };
  return { value: defined.reduce((s, v) => s + v, 0) / defined.length, n: defined.length };
}

/** Per-metric macro aggregation of `scoreTask().metrics` records; `falseAbsence` reads `count` and `rate`. */
function aggregate(metricRecords) {
  const names = new Set();
  for (const m of metricRecords) for (const name of Object.keys(m)) names.add(name);
  const out = {};
  for (const name of names) {
    const values = metricRecords.map((m) => (name in m ? m[name] : null));
    if (name === 'falseAbsence') {
      const count = values.reduce((s, v) => s + (v || 0), 0);
      out[name] = { count, rate: values.length === 0 ? null : count / values.length, n: values.length };
    } else {
      out[name] = macro(values);
    }
  }
  return out;
}

module.exports = {
  CLASSES, RANKING_CLASSES, OUTCOME_CLASSES, K, K_MAX, TOKENS_BASIS,
  kindOf, applicability, classesFor, minNFor,
  hits, scoreTask, macro, aggregate,
};
