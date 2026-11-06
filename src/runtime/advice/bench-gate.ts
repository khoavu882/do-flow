'use strict';

// The bench bar that act mode requires (141 IC-005, superseding the 084 ruling of 2026-10-26 for the evaluator only).
// The bar is met only by a verdict in the shipped core/registry/advice-verdicts.json whose key, bar digest and corpus
// digest match the shipped registry and whose stored numbers still judge to pass under the current bar. The stored
// `result` is never trusted on its own: it is recomputed with gate-score.ts. No path under the caller's project is read,
// so a file written there can never certify anything. The shipped file stays empty until a maintainer runs the gate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { judge } = require('./gate-score.ts');

const ADVICE_FILE = 'core/registry/advice.json';
const VERDICTS_FILE = 'core/registry/advice-verdicts.json';
const RERANK_KIND = 'rerank';

interface BenchBarResult {
  kind: string;
  model: string;
  passed: boolean;
  reason: string;
}

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth and no whitespace. */
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the canonical JSON of the registry `gate` block without `illustrative` (IC-004). */
function gateDigest(gate: any): string {
  const { illustrative, ...bars } = gate;
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(bars), 'utf8').digest('hex')}`;
}

/**
 * Builds an evaluator over one package root. The exported `evaluateBenchBar` is bound to this checkout's own root; the
 * factory exists so a test can point it at fixture files in a temp directory. Nothing in production passes a root.
 */
function createBenchBar({ registryRoot = REPO_ROOT }: { registryRoot?: string } = {}) {
  return function evaluate(kind: string, model: string, extra?: any): BenchBarResult {
    const result = (passed: boolean, reason: string): BenchBarResult => ({ kind, model, passed, reason });
    const unreadable = () => result(false, 'bench verdicts unreadable');

    // Only these two plain strings are read from the caller's argument; every other property is ignored.
    const given = isObject(extra) ? extra : {};
    const arm = kind === RERANK_KIND && typeof given.arm === 'string' ? given.arm : null;
    const criteriaDigest = typeof given.criteriaDigest === 'string' ? given.criteriaDigest : null;

    let advice: any;
    let file: any;
    try {
      advice = JSON.parse(fs.readFileSync(path.join(registryRoot, ADVICE_FILE), 'utf8'));
      file = JSON.parse(fs.readFileSync(path.join(registryRoot, VERDICTS_FILE), 'utf8'));
    } catch {
      return unreadable();
    }
    if (!isObject(advice) || !isObject(file) || file.schemaVersion !== 1 || !isObject(file.corpora) || !Array.isArray(file.verdicts)) {
      return unreadable();
    }

    const matches = file.verdicts.filter((v: any) => isObject(v) && v.kind === kind && v.model === model && (v.arm ?? null) === arm);
    if (matches.length === 0) return result(false, `no trusted bench scores ship for kind '${kind}' and model '${model}'`);
    if (matches.length > 1) return unreadable();
    const verdict = matches[0];

    const gate = advice.gate;
    if (!isObject(gate)) return result(false, 'verdict stale: pass bars changed');
    let currentDigest: string;
    try { currentDigest = gateDigest(gate); } catch { return unreadable(); }
    if (verdict.gateVersion !== gate.version || verdict.gateDigest !== currentDigest) {
      return result(false, 'verdict stale: pass bars changed');
    }

    const corpus = Object.hasOwn(file.corpora, kind) ? file.corpora[kind] : null;
    if (!isObject(corpus) || verdict.corpusVersion !== corpus.corpusVersion || verdict.corpusDigest !== corpus.digest) {
      return result(false, 'verdict stale: corpus changed');
    }
    // Fails closed: a rerank verdict, or any verdict that stores a criteria digest, is only valid for the criteria text
    // the caller supplies the digest of. A caller that supplies none cannot show the criteria still match.
    const storedDigest = verdict.criteriaDigest ?? null;
    if (storedDigest !== null || kind === RERANK_KIND) {
      if (criteriaDigest === null) return result(false, 'verdict stale: criteria digest not supplied');
      if (storedDigest !== criteriaDigest) return result(false, 'verdict stale: criteria changed');
    }

    let judged: { result: string; failedChecks: string[] };
    try { judged = judge(verdict, gate, kind); } catch { return unreadable(); }
    if (judged.result !== verdict.result) return result(false, 'verdict inconsistent: stored result differs from its numbers');
    if (judged.result === 'insufficient-data') {
      const n = typeof verdict.n === 'number' ? verdict.n : 0;
      return result(false, `insufficient data: ${n} of ${gate.minCases} cases`);
    }
    if (judged.result === 'fail') return result(false, `verdict failed: ${judged.failedChecks.join(', ')}`);
    return result(true, `shipped bench verdict for kind '${kind}' and model '${model}' passes the current bar`);
  };
}

const evaluateBenchBar = createBenchBar();

module.exports = {
  evaluateBenchBar,
  createBenchBar,
  gateDigest,
  canonicalJson,
};
