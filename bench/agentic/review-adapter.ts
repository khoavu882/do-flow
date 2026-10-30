'use strict';

/**
 * Review adapter for the with/without-DoFlow A/B (`kind: review`). Both arms answer with a fixed,
 * minimal `review.json` (path, startLine, endLine, severity, title); this module turns it into the
 * schema 1 `findings.json` that `bench/review-miss` grades, one per corpus case, and then calls the
 * review-miss scorer unchanged.
 *
 * Malformed output is a miss, not an exclusion. A reviewer that cannot follow the answer format found
 * nothing, and excluding it would turn an arm's format failure into infra share. So a missing,
 * unparsable or non-array `review.json` is written as a valid findings record with no finding, which
 * review-miss scores 0. Entries of a parsable array that fail the shape are dropped and counted.
 * What is excluded is a run that never produced a usable session (timeout, api-error, truncated):
 * the case gets a `run_status.json` of that class and review-miss excludes it. A leaked or
 * not-loaded run is overlaid at report time (review-miss has no `source-unverified` run status).
 *
 * Offline and deterministic: reads files, writes under the review-miss run root, runs no model.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SEVERITIES } = require('../../src/runtime/review/findings.ts');
const { RUN_STATUSES } = require('../noise.ts');
const reviewMiss = require('../review-miss/grade.ts');

const HEAD_FALLBACK = '0'.repeat(40);
/** The synthetic record identity: a row id and slug that satisfy `validateFindings`, naming this bench. */
const ROW = '000';
const SLUG = '000-ab-review';
const SEAT = 'ab-reviewer';

const isObject = (x: any) => x !== null && typeof x === 'object' && !Array.isArray(x);
const posInt = (n: any) => Number.isSafeInteger(n) && n >= 1;

/** Repository-relative POSIX form; an absolute path inside `workspaceRoot` loses that prefix, any other absolute path is kept (and so misses). */
function normalisePath(p: any, workspaceRoot: any) {
  let out = String(p).trim().replace(/\\/g, '/');
  if (typeof workspaceRoot === 'string' && workspaceRoot !== '') {
    const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const prefix of [root, root.replace(/^\/private(?=\/)/, '')]) {
      if (out.startsWith(`${prefix}/`)) { out = out.slice(prefix.length + 1); break; }
    }
  }
  return path.posix.normalize(out).replace(/^(?:\.\/)+/, '');
}

/**
 * Parses the text of a `review.json`. `{ ok: true, findings, dropped }` for a JSON array (entries that
 * fail the shape are counted in `dropped`), `{ ok: false, reason }` for anything else: absent text,
 * invalid JSON, or JSON that is not an array.
 */
function parseReviewJson(text: any, workspaceRoot: any = null) {
  if (typeof text !== 'string') return { ok: false, reason: 'absent', findings: [], dropped: 0 };
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json', findings: [], dropped: 0 };
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'not-an-array', findings: [], dropped: 0 };
  const findings: any[] = [];
  let dropped = 0;
  for (const e of value) {
    const valid = isObject(e) && typeof e.path === 'string' && e.path.trim() !== '' && posInt(e.startLine) && posInt(e.endLine)
      && e.endLine >= e.startLine && SEVERITIES.includes(e.severity) && typeof e.title === 'string' && e.title.trim() !== '';
    if (!valid) { dropped++; continue; }
    findings.push({ path: normalisePath(e.path, workspaceRoot), startLine: e.startLine, endLine: e.endLine, severity: e.severity, title: e.title.trim() });
  }
  return { ok: true, reason: null, findings, dropped };
}

const locatorOf = (f: any) => `${f.path}:${f.startLine === f.endLine ? f.startLine : `${f.startLine}-${f.endLine}`}`;

/** A schema 1 `review/findings.json` with one seat and every finding converged as `open`. */
function findingsRecord(findings: any[], rev: string) {
  return {
    schema: 1,
    row: ROW,
    slug: SLUG,
    reviewedHead: /^[0-9a-f]{40}$/.test(rev) ? rev : HEAD_FALLBACK,
    seats: [{
      id: SEAT,
      findings: findings.map((f: any, i: number) => ({ id: `s-${i + 1}`, severity: f.severity, locator: locatorOf(f), summary: f.title })),
    }],
    converged: findings.map((f: any, i: number) => ({ id: `C-${i + 1}`, from: [`s-${i + 1}`], severity: f.severity, status: 'open', locator: locatorOf(f) })),
  };
}

const writeJson = (file: string, value: any) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Writes one iteration of review-miss records under `iterationDir` and grades it. `entries` holds, per
 * review task, `{ task, runDir | null, infra, workspaceRoot }`; `runDir` null is a task never run (its
 * cases are left out of the grade, so the decision reports them `missing`). `corpus` is the parsed
 * review-miss corpus; only the cases a task lists are graded, and each must match the task's revision
 * and scope or the adapter refuses (`UsageError` from review-miss) rather than grade another truth.
 * @returns {{grade: object, parsed: Record<string, object>}} the grade.json object (also written) and each task's parse result
 */
function adaptIteration({ entries, corpus, config, iterationDir, name, meta, reviewFile }: {
  entries: any[]; corpus: any; config: any; iterationDir: string; name: string; meta: { model: string; sourceAt: string }; reviewFile: string;
}) {
  const { UsageError } = require('../review-miss/corpus.ts');
  fs.rmSync(iterationDir, { recursive: true, force: true });
  fs.mkdirSync(iterationDir, { recursive: true });
  writeJson(path.join(iterationDir, reviewMiss.FILES.iteration), { model: meta.model, sourceAt: meta.sourceAt });

  const cases: any[] = [];
  const parsed: Record<string, any> = {};
  const absent = new Set<string>();
  for (const { task, runDir, infra, workspaceRoot } of entries) {
    const mine = task.review.caseIds.map((id: string) => {
      const c = corpus.cases.find((x: any) => x.id === id);
      if (!c) throw new UsageError(`review task ${task.id} lists case ${id}, which the review-miss corpus does not hold; regenerate it with \`review-miss corpus\``);
      if (c.rev !== task.review.rev) throw new UsageError(`review task ${task.id}: corpus case ${id} is at ${c.rev}, the task at ${task.review.rev}`);
      return c;
    });
    cases.push(...mine);
    if (runDir === null) {
      for (const c of mine) absent.add(c.key);
      continue;
    }
    const text = (() => {
      try { return fs.readFileSync(path.join(runDir, reviewFile), 'utf8'); } catch { return null; }
    })();
    const result = parseReviewJson(text, workspaceRoot);
    parsed[task.id] = { ok: result.ok, reason: result.reason, findings: result.findings.length, dropped: result.dropped };
    for (const c of mine) {
      const dir = path.join(iterationDir, c.id);
      fs.mkdirSync(dir);
      writeJson(path.join(dir, reviewMiss.FILES.findings), findingsRecord(result.findings, task.review.rev));
      if (infra && RUN_STATUSES.includes(infra) && infra !== 'completed') writeJson(path.join(dir, reviewMiss.FILES.status), { status: infra });
    }
  }
  const grade = reviewMiss.gradeIteration({ iterationDir, name, corpus: { ...corpus, cases }, config });
  for (const c of cases) if (absent.has(c.key)) delete grade.runs[c.key];
  writeJson(path.join(iterationDir, reviewMiss.FILES.grade), grade);
  return { grade, parsed };
}

module.exports = { ROW, SLUG, SEAT, normalisePath, parseReviewJson, findingsRecord, adaptIteration };
