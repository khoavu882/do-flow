'use strict';

/**
 * Review-miss scorer (feature 095b, IC-009): grades the findings a reviewer wrote for each corpus
 * case, deterministically, and reads those grades back as the 096 repeat shape `bench/noise.js`
 * takes. Offline: reads files only; no model, no subprocess.
 *
 * A case is `found` when some converged finding sits on the expected path, overlaps the expected
 * span widened by `config.tolerance` lines each way, and is at least as severe as the expected one.
 * A case with no usable record is excluded (null, never 0): an infra class from `run_status.json`,
 * or `malformed` for a missing or invalid `findings.json`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateFindings, SEVERITIES } = require('../../src/runtime/review/findings.ts');
const { RUN_STATUSES, EXCLUSION_MARKS } = require('../noise.js');
const { UsageError, caseKey, parseLocator } = require('./corpus.js');

const FILES = Object.freeze({ iteration: 'iteration.json', findings: 'findings.json', status: 'run_status.json', grade: 'grade.json' });
/** Same rule as agentic's iteration names: one path segment, never a traversal. */
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A case id is a run directory name; `corpus` builds it from lowercase alphanumerics and dashes. */
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SPLITS = Object.freeze(['train', 'heldout']);
/** Higher is more severe: blocker 3, should-fix 2, note 1. */
const rank = (severity) => SEVERITIES.length - SEVERITIES.indexOf(severity);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `a,b,c` -> distinct, safe iteration names (exit 2 otherwise). */
function parseIterations(list, flag = '--iterations') {
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
function checkCorpus(corpus) {
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
function readIteration(dir) {
  const file = path.join(dir, FILES.iteration);
  const meta = readJson(file);
  if (!isObject(meta)) throw new UsageError(`iteration record is missing or unreadable: ${file}`);
  if (typeof meta.model !== 'string' || typeof meta.sourceAt !== 'string' || !meta.model || !meta.sourceAt) {
    throw new UsageError(`${file} must record model and sourceAt`);
  }
  return meta;
}

/** null when `run_status.json` is absent; the status string; `malformed` when unreadable or not a string status. */
function readRunStatus(caseDir) {
  const file = path.join(caseDir, FILES.status);
  if (!fs.existsSync(file)) return null;
  const v = readJson(file);
  return isObject(v) && typeof v.status === 'string' ? v.status : 'malformed';
}

/** True when a converged finding of `record` names the expected span at the expected severity or higher. */
function isFound(record, expected, tolerance) {
  const from = expected.startLine - tolerance;
  const to = expected.endLine + tolerance;
  return record.converged.some((f) => {
    const at = parseLocator(f.locator);
    return at !== null && at.path === expected.path && at.startLine <= to && at.endLine >= from
      && rank(f.severity) >= rank(expected.severity);
  });
}

/** `{ passRate, excluded }` of one case directory (the order of IC-009 steps 1 to 3). */
function gradeCase({ caseDir, expected, tolerance }) {
  const status = readRunStatus(caseDir);
  if (status !== null && status !== 'completed') {
    return { passRate: null, excluded: RUN_STATUSES.includes(status) ? status : 'malformed' };
  }
  const record = readJson(path.join(caseDir, FILES.findings));
  if (record === null || !validateFindings(record).ok) return { passRate: null, excluded: 'malformed' };
  return { passRate: isFound(record, expected, tolerance) ? 1 : 0, excluded: null };
}

/**
 * IC-009: grades every case of `corpus` in `<iterationDir>`; returns the `grade.json` object (the
 * caller writes it). A directory in the iteration that is no corpus case is refused, so a stale
 * iteration cannot mix truths.
 */
function gradeIteration({ iterationDir, name, corpus, config }) {
  const meta = readIteration(iterationDir);
  const ids = new Set(corpus.cases.map((c) => c.id));
  const stray = fs.readdirSync(iterationDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !ids.has(e.name)).map((e) => e.name).sort();
  if (stray.length) throw new UsageError(`${name}: case director${stray.length === 1 ? 'y' : 'ies'} outside the corpus: ${stray.join(', ')}`);
  const runs = {};
  for (const c of [...corpus.cases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    runs[c.key] = { kind: 'review-miss', split: c.split, ...gradeCase({ caseDir: path.join(iterationDir, c.id), expected: c.expected, tolerance: config.tolerance }) };
  }
  return { schema: 1, iteration: name, model: meta.model, commit: meta.sourceAt, runs };
}

/** One iteration's `grade.json` as a 096 repeat `{ iteration, model, commit, runs }`; refused when missing or not a grade. */
function readRepeat(runRoot, name, verb) {
  const dir = path.join(runRoot, name);
  if (!fs.existsSync(dir)) throw new UsageError(`${verb}: no iteration at ${dir}`);
  const g = readJson(path.join(dir, FILES.grade));
  if (g === null) throw new UsageError(`${verb}: ${name} has no readable ${FILES.grade}; run \`review-miss grade --iteration ${name}\` first`);
  const ok = isObject(g) && g.schema === 1 && typeof g.model === 'string' && typeof g.commit === 'string' && isObject(g.runs)
    && Object.values(g.runs).every((r) => isObject(r) && typeof r.kind === 'string' && SPLITS.includes(r.split)
      && (r.passRate === null || Number.isFinite(r.passRate)) && (r.excluded === null || EXCLUSION_MARKS.includes(r.excluded)));
  if (!ok) throw new UsageError(`${verb}: ${name}/${FILES.grade} is not a review-miss grade (schema 1, model, commit, runs)`);
  return { iteration: name, model: g.model, commit: g.commit, runs: g.runs };
}

module.exports = { FILES, parseIterations, checkCorpus, readIteration, gradeCase, gradeIteration, readRepeat, isFound };
