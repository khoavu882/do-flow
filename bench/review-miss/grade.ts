'use strict';

/**
 * Review-miss scorer (feature 095b, IC-009): grades the findings a reviewer wrote for each corpus
 * case, deterministically, and reads those grades back as the 096 repeat shape `bench/noise.js`
 * takes. Offline: reads files only; no model, no subprocess.
 *
 * A case is `found` when some converged finding that was not refuted sits on the expected path, has a
 * locator span overlapping the expected span widened by `config.tolerance` lines each way, and is at
 * least as severe as the expected one. The locator (a range, or the extent of a comma list of points)
 * may be at most `allowedWidth` lines wide: `max(config.maxSpan, expected width + 2 * tolerance)`.
 * A case with no usable record is excluded (null, never 0): an infra class from `run_status.json`,
 * or `malformed` for a missing or invalid `findings.json`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateFindings, SEVERITIES } = require('../../src/runtime/review/findings.ts');
const { RUN_STATUSES, EXCLUSION_MARKS } = require('../noise.ts');
const { UsageError, caseKey, parseLocator } = require('./corpus.ts');

const FILES = Object.freeze({ iteration: 'iteration.json', findings: 'findings.json', status: 'run_status.json', grade: 'grade.json' });
/** Same rule as agentic's iteration names: one path segment, never a traversal. */
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A case id is a run directory name; `corpus` builds it from lowercase alphanumerics and dashes. */
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SPLITS = Object.freeze(['train', 'heldout']);
/** Higher is more severe: blocker 3, should-fix 2, note 1. */
const rank = (severity: any) => SEVERITIES.length - SEVERITIES.indexOf(severity);

const isObject = (x: any): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `a,b,c` -> distinct, safe iteration names (exit 2 otherwise). */
function parseIterations(list: any, flag = '--iterations'): string[] {
  const names = String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new UsageError(`${flag} must list at least one iteration`);
  for (const name of names) {
    if (!ITERATION_NAME.test(name)) throw new UsageError(`${flag}: iteration name must match ${ITERATION_NAME}: ${JSON.stringify(name)}`);
  }
  const dup = names.find((name, i) => names.indexOf(name) !== i);
  if (dup) throw new UsageError(`${flag}: iteration "${dup}" is listed twice`);
  return names;
}

/**
 * Refuses a corpus file the scorer cannot trust: wrong shape, an unsafe or repeated id, or a key that
 * no longer matches its digest (the truth changed after the key was made, so grades would mix truths).
 * `bench review-miss lint` is the full check; this is the part grading depends on.
 */
function checkCorpus(corpus: any) {
  if (!isObject(corpus) || corpus.kind !== 'review-miss' || corpus.schema !== 1 || !Array.isArray(corpus.cases)) {
    throw new UsageError('corpus is not a review-miss corpus (schema 1, kind review-miss, cases list)');
  }
  const seen = new Set();
  for (const c of corpus.cases) {
    const id = isObject(c) && typeof c.id === 'string' ? c.id : null;
    if (id === null || !CASE_ID.test(id)) throw new UsageError(`corpus: case id ${JSON.stringify(id)} is not a lowercase alphanumeric-and-dash name`);
    if (seen.has(id)) throw new UsageError(`corpus: duplicate case id ${id}`);
    seen.add(id);
    const e = c.expected;
    if (!SPLITS.includes(c.split) || !isObject(e) || typeof e.path !== 'string' || !Array.isArray(c.scope)
      || !Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || rank(e.severity) > SEVERITIES.length) {
      throw new UsageError(`corpus: case ${id} is malformed; run \`review-miss lint\``);
    }
    if (c.key !== caseKey(c)) throw new UsageError(`corpus: case ${id} key does not match its digest; regenerate the corpus with \`review-miss corpus\``);
  }
  return corpus;
}

/** The parsed `iteration.json` (`{ model, sourceAt }`) of an iteration directory; refused when missing or incomplete. */
function readIteration(dir: string) {
  const file = path.join(dir, FILES.iteration);
  const meta = readJson(file);
  if (!isObject(meta)) throw new UsageError(`iteration record is missing or unreadable: ${file}`);
  if (typeof meta.model !== 'string' || typeof meta.sourceAt !== 'string' || !meta.model || !meta.sourceAt) {
    throw new UsageError(`${file} must record model and sourceAt`);
  }
  return meta;
}

/** null when `run_status.json` is absent; the status string; `malformed` when unreadable or not a string status. */
function readRunStatus(caseDir: string) {
  const file = path.join(caseDir, FILES.status);
  if (!fs.existsSync(file)) return null;
  const v = readJson(file);
  return isObject(v) && typeof v.status === 'string' ? v.status : 'malformed';
}

/** Converged statuses that count as a finding the reviewer made; `refuted` was withdrawn by the review itself. */
const COUNTED_STATUSES = Object.freeze(['open', 'fixed', 'user-accepted']);

/**
 * The line spans one locator claims, as `{ path, spans: [[from, to], ...] }`, or null when it does not
 * parse. A range is one span; a single line is one; a comma list is one single-line span per line
 * (separate points, never min..max, so `1,9999` does not cover the lines between).
 */
function locatorSpans(locator: string) {
  const at = parseLocator(locator);
  if (at === null) return null;
  const rest = locator.slice(at.path.length + 1);
  const spans = rest.includes('-')
    ? [[at.startLine, at.endLine]]
    : rest.split(',').map((n: string) => [Number(n), Number(n)]);
  return { path: at.path, spans };
}

/**
 * True when a counted converged finding of `record` names the expected span at the expected severity
 * or higher: its locator, whose extent (max - min + 1 over all its spans) is at most `allowedWidth`
 * lines, has a span overlapping the expected span widened by `tolerance` lines each way.
 * `allowedWidth = max(maxSpan, expected width + 2 * tolerance)`: `maxSpan` bounds only a locator wider
 * than the case itself needs, so an exact re-report of a wide expected span is always a hit.
 */
function isFound(record: any, expected: any, tolerance: number, maxSpan: number) {
  const from = expected.startLine - tolerance;
  const to = expected.endLine + tolerance;
  const allowedWidth = Math.max(maxSpan, expected.endLine - expected.startLine + 1 + 2 * tolerance);
  return record.converged.some((f: any) => {
    if (!COUNTED_STATUSES.includes(f.status) || rank(f.severity) < rank(expected.severity)) return false;
    const at = locatorSpans(f.locator);
    if (at === null || at.path !== expected.path) return false;
    const extent = Math.max(...at.spans.map(([, b]: any) => b)) - Math.min(...at.spans.map(([a]: any) => a)) + 1;
    return extent <= allowedWidth && at.spans.some(([a, b]: any) => a <= to && b >= from);
  });
}

/** `{ passRate, excluded }` of one case directory (the order of IC-009 steps 1 to 3). */
function gradeCase({ caseDir, expected, tolerance, maxSpan }: { caseDir: string; expected: any; tolerance: number; maxSpan: number }) {
  const status = readRunStatus(caseDir);
  if (status !== null && status !== 'completed') {
    return { passRate: null, excluded: RUN_STATUSES.includes(status) ? status : 'malformed' };
  }
  const record = readJson(path.join(caseDir, FILES.findings));
  if (record === null || !validateFindings(record).ok) return { passRate: null, excluded: 'malformed' };
  return { passRate: isFound(record, expected, tolerance, maxSpan) ? 1 : 0, excluded: null };
}

/**
 * IC-009: grades every case of `corpus` in `<iterationDir>`; returns the `grade.json` object (the
 * caller writes it). A directory in the iteration that is no corpus case is refused, so a stale
 * iteration cannot mix truths.
 */
function gradeIteration({ iterationDir, name, corpus, config }: { iterationDir: string; name: string; corpus: any; config: any }) {
  if (!Number.isInteger(config.maxSpan) || config.maxSpan < 1) throw new UsageError('config: maxSpan must be a positive integer (bench/review-miss/config.json)');
  const meta = readIteration(iterationDir);
  const ids = new Set(corpus.cases.map((c: any) => c.id));
  const stray = fs.readdirSync(iterationDir, { withFileTypes: true }).filter((e: any) => e.isDirectory() && !ids.has(e.name)).map((e: any) => e.name).sort();
  if (stray.length) throw new UsageError(`${name}: case director${stray.length === 1 ? 'y' : 'ies'} outside the corpus: ${stray.join(', ')}`);
  const runs: Record<string, any> = {};
  for (const c of [...corpus.cases].sort((a: any, b: any) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    runs[c.key] = { kind: 'review-miss', split: c.split, ...gradeCase({ caseDir: path.join(iterationDir, c.id), expected: c.expected, tolerance: config.tolerance, maxSpan: config.maxSpan }) };
  }
  return { schema: 1, iteration: name, model: meta.model, commit: meta.sourceAt, runs };
}

/** One iteration's `grade.json` as a 096 repeat `{ iteration, model, commit, runs }`; refused when missing or not a grade. */
function readRepeat(runRoot: string, name: string, verb: string) {
  const dir = path.join(runRoot, name);
  if (!fs.existsSync(dir)) throw new UsageError(`${verb}: no iteration at ${dir}`);
  const g = readJson(path.join(dir, FILES.grade));
  if (g === null) throw new UsageError(`${verb}: ${name} has no readable ${FILES.grade}; run \`review-miss grade --iteration ${name}\` first`);
  const ok = isObject(g) && g.schema === 1 && typeof g.model === 'string' && typeof g.commit === 'string' && isObject(g.runs)
    && Object.values(g.runs).every((r: any) => isObject(r) && typeof r.kind === 'string' && SPLITS.includes(r.split)
      && (r.passRate === null || Number.isFinite(r.passRate)) && (r.excluded === null || EXCLUSION_MARKS.includes(r.excluded)));
  if (!ok) throw new UsageError(`${verb}: ${name}/${FILES.grade} is not a review-miss grade (schema 1, model, commit, runs)`);
  return { iteration: name, model: g.model, commit: g.commit, runs: g.runs };
}

module.exports = { FILES, parseIterations, checkCorpus, readIteration, gradeCase, gradeIteration, readRepeat, isFound };
