'use strict';

/**
 * `retrieval rerun` (074 IC-005, FR-019): verify, rerun the dev split for A and B on both corpora and
 * compare every aggregate against `baseline.json` under `thresholds.json` `rerun.tolerances`. A metric
 * with no tolerance entry must match exactly; an `unreached` row matches only `unreached` with the
 * same cause; latency is compared only on the machine that captured the baseline.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.js');
const snapshotLib = require('../snapshot.js');
const report = require('../report.js');
const runVerb = require('./run.js');
const verifyVerb = require('./verify.js');

const flags = {};
const LATENCY_METRICS = ['p50Ms', 'p95Ms', 'maxMs'];
const EPS = 1e-12;

class Refusal extends sealLib.SealError {}

function toleranceOf(tolerances, config, metric) {
  const entry = tolerances.find((t) => t.config === config && t.metric === metric);
  return entry ? entry.abs : null;
}

function withinTolerance(baseline, current, tol) {
  if (baseline === null || current === null) return baseline === current;
  return Math.abs(current - baseline) <= tol + EPS;
}

/** Diffs of one corpus and configuration, class by class. */
function compareConfig({ corpus, config, base, now, tolerances }) {
  const diffs = [];
  const classes = new Set([...Object.keys(base.classes), ...Object.keys(now.classes)]);
  for (const cls of classes) {
    const a = base.classes[cls];
    const b = now.classes[cls];
    const row = { corpus, config, class: cls };
    if (!a || !b || a.applicable !== b.applicable) {
      diffs.push({ ...row, metric: 'class', baseline: null, current: null, tolerance: 0, ok: false, note: 'class present in only one file or applicability changed' });
      continue;
    }
    if (a.applicable === false) continue;
    if (a.state === 'unreached' || b.state === 'unreached') {
      const ok = a.state === b.state && a.cause === b.cause;
      diffs.push({ ...row, metric: 'state', baseline: null, current: null, tolerance: 0, ok, note: `baseline ${a.state}${a.cause ? ` (${a.cause})` : ''}, current ${b.state}${b.cause ? ` (${b.cause})` : ''}` });
      continue;
    }
    for (const metric of [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort()) {
      const tol = toleranceOf(tolerances, config, metric) ?? 0;
      const baseline = a.metrics[metric] ? a.metrics[metric].value : null;
      const current = b.metrics[metric] ? b.metrics[metric].value : null;
      diffs.push({ ...row, metric, baseline, current, tolerance: tol, ok: withinTolerance(baseline, current, tol) });
    }
  }
  return diffs;
}

function compareLatency({ baseline, current, tolerances, machine }) {
  if (baseline.capture.machineId !== machine) {
    return { compared: false, reason: `machineId differs: baseline ${baseline.capture.machineId}, this machine ${machine}` };
  }
  const diffs = [];
  for (const corpus of Object.keys(baseline.corpora)) {
    for (const config of Object.keys(baseline.corpora[corpus].configs)) {
      const a = baseline.corpora[corpus].configs[config].classes;
      const b = current.corpora[corpus].configs[config] && current.corpora[corpus].configs[config].classes;
      for (const cls of Object.keys(a)) {
        if (!a[cls].applicable || !b || !b[cls] || !b[cls].applicable) continue;
        for (const metric of LATENCY_METRICS) {
          const tol = toleranceOf(tolerances, config, metric);
          const was = a[cls].latency[metric];
          const now = b[cls].latency[metric];
          diffs.push({ corpus, config, class: cls, metric, baseline: was, current: now, tolerance: tol, ok: tol === null ? true : withinTolerance(was, now, tol) });
        }
      }
    }
  }
  return { compared: true, diffs };
}

function rerun({ snapshotPath, repoRoot, tmp, keepTmp, env, home, deps, machine = report.machineId() }) {
  const snapshot = snapshotLib.loadSnapshot(snapshotPath);
  const baselineFile = path.join(repoRoot, 'bench', 'retrieval', 'baseline.json');
  if (!fs.existsSync(baselineFile)) throw new Refusal('bench/retrieval/baseline.json does not exist; run capture first');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));

  const verifier = (deps && deps.verifySnapshot) || verifyVerb.verifySnapshot;
  const verified = verifier({ snapshotPath, repoRoot });
  if (verified.exitCode !== 0) {
    return { exitCode: verified.exitCode, codes: verified.codes, verify: verified.result, message: verified.message, diffs: [], latency: { compared: false, reason: 'verify failed' } };
  }

  const devFile = path.join(repoRoot, snapshot.taskFiles.dev.path);
  const currentSha = sealLib.sha256Hex(fs.existsSync(devFile) ? fs.readFileSync(devFile) : '');
  if (baseline.snapshotId !== snapshot.snapshotId || baseline.tasksSha256 !== currentSha) {
    throw new Refusal('baseline.json was captured on a different snapshot or dev task file; run capture');
  }

  const thresholdsFile = path.join(repoRoot, 'bench', 'retrieval', 'thresholds.json');
  const tolerances = fs.existsSync(thresholdsFile) ? (JSON.parse(fs.readFileSync(thresholdsFile, 'utf8')).rerun || {}).tolerances || [] : [];

  const out = runVerb.execute({
    args: { config: 'A,B', corpus: 'all', split: 'dev' }, snapshotPath, repoRoot, tmp, keepTmp, env, home,
    deps: { ...(deps || {}), verifySnapshot: () => verified },
  });
  if (out.exitCode !== 0) return { exitCode: out.exitCode, codes: out.codes, verify: verified.result, message: (out.lines || []).join('; '), diffs: [], latency: { compared: false, reason: 'the dev run did not complete' } };

  const diffs = [];
  for (const corpus of Object.keys(baseline.corpora)) {
    for (const config of ['A', 'B']) {
      const base = baseline.corpora[corpus].configs[config];
      const now = out.report.corpora[corpus] && out.report.corpora[corpus].configs[config];
      if (!now) { diffs.push({ corpus, config, class: '*', metric: 'config', baseline: null, current: null, tolerance: 0, ok: false, note: 'missing from the rerun' }); continue; }
      diffs.push(...compareConfig({ corpus, config, base, now, tolerances }));
    }
  }
  const latency = compareLatency({ baseline, current: out.report, tolerances, machine });
  const failed = diffs.some((d) => !d.ok) || (latency.compared && latency.diffs.some((d) => !d.ok));
  return { exitCode: failed ? 1 : 0, verify: verified.result, diffs, latency };
}

function run(ctx) {
  const out = rerun({ snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot, tmp: ctx.tmp, keepTmp: ctx.keepTmp });
  const bad = out.diffs.filter((d) => !d.ok);
  const lines = [];
  if (out.message) lines.push(`rerun: ${out.message}`);
  for (const d of bad) lines.push(`DIFF ${d.corpus} ${d.config} ${d.class} ${d.metric}: baseline ${d.baseline}, current ${d.current}, tolerance ${d.tolerance}${d.note ? ` (${d.note})` : ''}`);
  lines.push(`${out.diffs.length - bad.length} of ${out.diffs.length} aggregates within tolerance`);
  lines.push(out.latency.compared ? 'latency compared (same machine)' : `latency not compared: ${out.latency.reason}`);
  return { exitCode: out.exitCode, codes: out.codes || [], lines, verify: out.verify, diffs: out.diffs, latency: out.latency, ...(out.message && out.exitCode ? { error: out.message } : {}) };
}

module.exports = { flags, toleranceOf, withinTolerance, compareConfig, compareLatency, rerun, run };
