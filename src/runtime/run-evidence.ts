'use strict';

/**
 * 181 C5 (IC-006): what ran on a head commit. `compileRunEvidence` reads the latest verify run record
 * of a task and the evidence ledger's `flow:<id>` items, and answers one `WhatRan` value: the checks
 * of the verify run when it ran on `head` from a clean tree, and one status per feature-map flow
 * (`passed`, `failed`, `unreached`, or `not-run` when no item sits on `head`). It writes nothing; the
 * same records give the same value (NFR-004). The review pack and `review --action input` render it.
 *
 * The feature map is read by `readFeatureMap` of the feature-map module (IC-007), the one parser.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { resolveActiveFeature } = require('./feature-resolve.ts');
const { verificationRunsRoot, verificationRunRecordFile } = require('./verification/engine.ts');
const { readFeatureMap } = require('./verification/feature-map.ts');

const UNREACHED = 'unreached: ';

/** The latest line of the task's verify run records, or `null`; unreadable and unknown-schema lines are problems. */
function latestVerifyRecord({ root, taskId, fsImpl }: any): { record: any; problems: string[] } {
  const file = verificationRunRecordFile(verificationRunsRoot(root), taskId);
  let text: string;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error: any) {
    return { record: null, problems: error && error.code === 'ENOENT' ? [] : [`${path.basename(file)} cannot be read (${error?.message ?? error})`] };
  }
  let record: any = null;
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.schema === 1 || parsed.schema === 2) && parsed.taskId === taskId) record = parsed;
      else skipped += 1;
    } catch { skipped += 1; }
  }
  return { record, problems: skipped ? [`${skipped} verify record line(s) could not be read`] : [] };
}

/** `VerifyPart`: a schema 1 line has `checks: []`; the checks are shown only for a clean run on `head`. */
function verifyPart(record: any, head: string): any {
  const onHead = record.head === head;
  const clean = typeof record.clean === 'boolean' ? record.clean : null;
  const checks = onHead && clean === true && Array.isArray(record.checks) ? record.checks : [];
  return { at: record.at ?? null, verdict: record.verdict ?? null, onHead, clean, checks };
}

function locatorText(locator: any): string | null {
  if (typeof locator === 'string') return locator;
  if (!locator || typeof locator !== 'object') return null;
  const file = locator.file ?? locator.path ?? locator.uri ?? null;
  return typeof file === 'string' ? (Number.isInteger(locator.line) && locator.file ? `${file}:${locator.line}` : file) : null;
}

/** One flow item's outcome, or `null` when it is neither a driven run with an exit code nor an `unreached` assertion. */
function classify(item: any): any {
  if (item.provenance === 'extracted' && Number.isInteger(item.observation?.exitCode)) {
    return { status: item.observation.exitCode === 0 ? 'passed' : 'failed', reason: null };
  }
  if (item.provenance === 'asserted' && typeof item.content === 'string' && item.content.startsWith(UNREACHED)) {
    return { status: 'unreached', reason: item.content.slice(UNREACHED.length) };
  }
  return null;
}

/** The newest classifiable `flow:<id>` item on `head`, by `observedAt` then ledger order. */
function newestFlowItem(items: any[], id: string, head: string): any {
  let best: any = null;
  for (const item of items) {
    if (!head || item.status === 'superseded' || item.freshness?.gitCommit !== head) continue;
    if (!Array.isArray(item.establishes) || !item.establishes.includes(`flow:${id}`)) continue;
    const outcome = classify(item);
    if (!outcome) continue;
    if (!best || String(item.freshness?.observedAt ?? '') >= String(best.item.freshness?.observedAt ?? '')) best = { item, outcome };
  }
  return best;
}

function flowPart(flow: any, found: any): any {
  const base = { id: flow.id, title: flow.title, critical: flow.critical };
  if (!found) return { ...base, status: 'not-run', action: null, observed: null, locator: null, commit: null, reason: null };
  const { item, outcome } = found;
  return {
    ...base,
    status: outcome.status,
    action: item.observation?.command ?? null,
    observed: item.content ?? null,
    locator: locatorText(item.locator),
    commit: item.freshness.gitCommit,
    reason: outcome.reason,
  };
}

/**
 * @param {{root: string, taskId: string, head: string, fsImpl?: Object, featureDir?: string|null}} options
 *   `featureDir` is the feature folder holding `test/feature-map.json`; omitted, it is resolved from
 *   `taskId` as the feature slug, and a task with no feature folder has only the project's map.
 * @returns {{head: string, verify: Object|null, flows: Array<Object>, featureMap: string, problems: Array<string>}}
 */
function compileRunEvidence({ root, taskId, head, fsImpl = nodeFs, featureDir }: any): any {
  const problems: string[] = [];

  const latest = latestVerifyRecord({ root, taskId, fsImpl });
  problems.push(...latest.problems);

  let dir = featureDir;
  if (dir === undefined) {
    const found = resolveActiveFeature({ projectRoot: root, slug: taskId });
    dir = found.error ? null : found.featureDir;
  }
  const map = readFeatureMap({ root, featureDir: dir, fsImpl });
  problems.push(...map.problems);

  let items: any[] = [];
  try {
    const ledger = new EvidenceLedger({ repoRoot: root, slug: taskId, fsImpl });
    ledger.load(taskId);
    items = ledger.getAllEvidence();
  } catch (error: any) {
    problems.push(`the evidence ledger cannot be read (${error?.message ?? error})`);
  }

  return {
    head,
    verify: latest.record ? verifyPart(latest.record, head) : null,
    flows: map.flows.map((flow: any) => flowPart(flow, newestFlowItem(items, flow.id, head))),
    featureMap: map.featureMap,
    problems,
  };
}

module.exports = { compileRunEvidence };
