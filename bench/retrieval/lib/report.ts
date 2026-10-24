'use strict';

/**
 * Report assembly (074 IC-015, IC-016): class results with confidence intervals, the baseline file,
 * and the holdout result and comparison files. Objects are built in schema key order so
 * `JSON.stringify` writes them the way the schema lists them. The holdout writers refuse to emit
 * anything per task: DEC-004 keeps task detail out of every committed result.
 */

const os = require('node:os');
const stats = require('./stats.ts');
const metricsLib = require('./metrics.ts');
const { canonicalJson, sha256Hex, toFileText } = require('./seal.ts');

/** Metrics that live in `context`, not in the per-class metric table. */
const CONTEXT_METRICS = new Set(['payloadBytes', 'tokensEst', 'compressedBytes']);
const FORBIDDEN_KEYS = ['perTask', 'query', 'qrels', 'tasks'];
const TASK_ID_RE = /\b[DH][CG]-\d{3}\b/;

/** First 12 hex of SHA-256 of `hostname|cpu model|cpu count|total memory` (IC-015). */
function machineId({
  hostname = os.hostname(), cpus = os.cpus(), totalmem = os.totalmem(),
} = {}) {
  const model = cpus.length > 0 ? cpus[0].model : '';
  return sha256Hex(`${hostname}|${model}|${cpus.length}|${totalmem}`).slice(0, 12);
}

function percentileOrNull(values: any, q: any) {
  return values.length === 0 ? null : stats.percentile(values, q);
}

/**
 * One ClassResult. `tasks` is `[{scored, result, cause?}]` where `scored` is `metrics.scoreTask()`
 * output and `result` the adapter's result; `latencyMs` are the measured invocations.
 */
function classResult({ corpus, config, cls, seed, tasks, latencyMs = [], minN, unreachedCount }: any) {
  const n = tasks.length;
  const unreached = n > 0 && tasks.every((t: any) => t.result === 'UNREACHED');
  const count = unreachedCount !== undefined
    ? unreachedCount
    : (tasks.some((t: any) => t.result === 'UNREACHED') ? tasks.filter((t: any) => t.result === 'UNREACHED').length : undefined);
  const out: any = {
    applicable: true,
    n,
    underpowered: stats.underpowered(n, metricsLib.kindOf(cls), minN),
    state: unreached ? 'unreached' : 'measured',
  };
  if (count !== undefined) out.unreachedCount = count;
  if (unreached) out.cause = tasks.map((t: any) => t.cause).find(Boolean) || 'every provider was unreached';

  const table = (records: any) => {
    const agg = metricsLib.aggregate(records.map((r: any) => r || {}));
    const entries: any = {};
    for (const name of Object.keys(agg).sort()) {
      if (CONTEXT_METRICS.has(name)) continue;
      const a = agg[name];
      if (name === 'falseAbsence') {
        entries[name] = { value: a.rate, ci95: null, n: a.n, count: a.count };
        continue;
      }
      const defined = records.map((r: any) => (r ? r[name] : null)).filter((v: any) => v != null);
      const entry: any = { value: a.value, ci95: defined.length ? stats.bootstrapCI(defined, stats.streamSeed(seed, corpus, config, cls, name)) : null, n: a.n };
      if (a.na) entry.na = true;
      entries[name] = entry;
    }
    return entries;
  };

  out.metrics = unreached ? {} : table(tasks.map((t: any) => t.scored.metrics));
  const graph = tasks.map((t: any) => t.scored.graphMetrics).filter(Boolean);
  if (graph.length > 0 && !unreached) out.graphMetrics = table(graph);

  out.latency = {
    runs: latencyMs.length,
    p50Ms: percentileOrNull(latencyMs, 0.5),
    p95Ms: percentileOrNull(latencyMs, 0.95),
    maxMs: latencyMs.length ? Math.max(...latencyMs) : null,
  };
  const payloads = tasks.map((t: any) => t.scored.metrics.payloadBytes).filter((v: any) => v != null);
  const tokens = tasks.map((t: any) => t.scored.metrics.tokensEst).filter((v: any) => v != null);
  const compressed = tasks.map((t: any) => t.scored.metrics.compressedBytes).filter((v: any) => v != null);
  out.context = {
    payloadBytesP50: percentileOrNull(payloads, 0.5),
    payloadBytesP95: percentileOrNull(payloads, 0.95),
    tokensEstP50: percentileOrNull(tokens, 0.5),
    tokensBasis: metricsLib.TOKENS_BASIS,
  };
  if (compressed.length > 0) out.context.compressedBytesP50 = percentileOrNull(compressed, 0.5);
  return out;
}

function notApplicable(cls: any, corpus: any) {
  const a = metricsLib.applicability(cls, corpus);
  return a.applicable ? null : { applicable: false, reason: a.reason };
}

/** Every class for a corpus: a ClassResult for applicable ones, `{applicable:false, reason}` for the rest, in class order. */
function classesBlock({ corpus, results }: any) {
  const out: any = {};
  for (const cls of metricsLib.CLASSES) out[cls] = notApplicable(cls, corpus) || results[cls];
  return out;
}

/** ConfigResult in IC-015 key order. */
function configResult({ sameAs, components, index, classes }: any) {
  const out: any = {};
  if (sameAs) out.sameAs = sameAs;
  out.components = components;
  if (index) out.index = index;
  out.classes = classes;
  return out;
}

function corpusResult({ A, B, comparisons }: any) {
  return { configs: { A, B }, comparisons };
}

/** The baseline file (IC-015) in schema key order. */
function buildBaseline({ snapshot, tasksSha256, capture, corpora, perTask }: any) {
  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    split: 'dev',
    tasksSha256,
    capture: {
      capturedAt: capture.capturedAt, machineId: capture.machineId, runnerBlob: capture.runnerBlob,
      seed: snapshot.seed, node: capture.node, os: capture.os, arch: capture.arch,
    },
    corpora: { code: corpora.code, guidance: corpora.guidance },
    perTask,
  };
}

/** Throws when a value carries per-task detail: a forbidden key anywhere, or a task id in any string. */
function assertNoTaskDetail(value: any, where = 'holdout result') {
  const walk = (v: any, trail: any) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${trail}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.includes(k)) throw new Error(`${where} may not carry "${k}" (at ${trail || '.'})`);
        walk(x, `${trail}.${k}`);
      }
    } else if (typeof v === 'string' && TASK_ID_RE.test(v)) {
      throw new Error(`${where} may not carry a task id (at ${trail})`);
    }
  };
  walk(value, '');
}

/** One holdout result file (IC-016) for a corpus and configuration; never per task. */
function buildHoldoutResult({
  snapshotId, generation, corpus, config, sealPlaintextSha256, thresholdsCommit, runAt, runIndex, machineId: machine, classes,
}: any) {
  const out = {
    schemaVersion: 1, snapshotId, generation, corpus, config, sealPlaintextSha256, thresholdsCommit,
    runAt, runIndex, machineId: machine, classes,
  };
  assertNoTaskDetail(out);
  return out;
}

function buildComparisonFile({ snapshotId, generation, corpus, comparisons }: any) {
  const out = { schemaVersion: 1, snapshotId, generation, corpus, comparisons };
  assertNoTaskDetail(out, 'comparison file');
  return out;
}

function holdoutResultName(snapshotId: any, generation: any, corpus: any, config: any) {
  return `holdout-${snapshotId}-g${generation}-${corpus}-${config}.json`;
}

function comparisonName(snapshotId: any, generation: any, corpus: any) {
  return `holdout-${snapshotId}-g${generation}-${corpus}-A-vs-B.json`;
}

module.exports = {
  canonicalJson, sha256Hex, toFileText,
  machineId, classResult, classesBlock, configResult, corpusResult, buildBaseline,
  assertNoTaskDetail, buildHoldoutResult, buildComparisonFile, holdoutResultName, comparisonName,
};
