'use strict';

/**
 * Review-miss corpus (feature 095b, IC-008): turns the converged `fixed` findings of the repo's own
 * review records into cases a reviewer can be scored on, and lints a corpus file.
 *
 * A case asks "given the code as it stood before the fix, does a review find the span the fix
 * changed". The reviewer-facing part is `rev` (the parent of the fix) and `scope` only; the answer
 * (`expected`) and the key digest are for the scorer. A case never carries the fix commit, the
 * finding text, its evidence or its seats.
 *
 * Pure of clocks and randomness, and sorted everywhere, so two runs over the same records are
 * byte-identical. The only outside reads are the records (files) and git (`rev-parse`, `cat-file`).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateFindings, HEX_HEAD } = require('../../src/runtime/review/findings.ts');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const KEY_PREFIX = 'review-miss/';
const SKIP_REASONS = Object.freeze(['not-fixed', 'severity', 'locator', 'no-parent', 'path-absent']);
const CASE_KEYS = Object.freeze(['id', 'key', 'split', 'source', 'rev', 'scope', 'expected']);
const SOURCE_KEYS = Object.freeze(['row', 'slug', 'finding']);
const EXPECTED_KEYS = Object.freeze(['path', 'startLine', 'endLine', 'severity']);
const CORPUS_KEYS = Object.freeze(['schema', 'kind', 'records', 'skipped', 'cases']);
const SPLITS = Object.freeze(['train', 'heldout']);
/** Below this many cases a corpus may hold no heldout case (IC-008). */
const HELDOUT_REQUIRED_AT = 5;

/** A refusal the CLI maps to exit 2 (usage, unreadable input). */
class UsageError extends Error {
  usage: boolean;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = true;
  }
}

const sha256Hex = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function loadConfig(file = CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** IC-008 key: digests the revision and the truth, so a changed truth invalidates a noise artifact (pattern: bench/agentic/tasks.js caseKey). */
function caseKey({ id, rev, scope, expected }: { id: string; rev: string; scope: any; expected: any }) {
  const { path: p, startLine, endLine, severity } = expected;
  const body = { rev, scope, expected: { path: p, startLine, endLine, severity } };
  return `${KEY_PREFIX}${id}@${sha256Hex(JSON.stringify(body)).slice(0, 8)}`;
}

/** `heldout` when the first hex digit of sha256(id) is below `config.heldoutBelow`, else `train`. */
function splitOf(id: string, config: any) {
  return parseInt(sha256Hex(id)[0], 16) < parseInt(config.heldoutBelow, 16) ? 'heldout' : 'train';
}

/**
 * `<path>:<n>`, `<path>:<n>-<m>` or `<path>:<n>,<m>[,...]` -> `{ path, startLine, endLine }`, else null.
 * A comma list spans its lowest to its highest line. Anything else (a `;` list, a reversed range,
 * line 0, a path with whitespace) is not parseable.
 */
function parseLocator(locator: string) {
  const m = /^([^\s:;,]+):([1-9][0-9]*)(?:-([1-9][0-9]*)|((?:,[1-9][0-9]*)+))?$/.exec(locator);
  if (!m || m[1].startsWith('/') || m[1].split('/').includes('..')) return null;
  const lines = [Number(m[2])];
  if (m[3] !== undefined) lines.push(Number(m[3]));
  if (m[4] !== undefined) lines.push(...m[4].slice(1).split(',').map(Number));
  if (m[3] !== undefined && lines[1] < lines[0]) return null;
  return { path: m[1], startLine: Math.min(...lines), endLine: Math.max(...lines) };
}

/** Runs git in `cwd`; stdout (trimmed) on success, null on a non-zero exit. */
function gitOut(cwd: string, args: string[]) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Every `findings.json` under `<root>/<slug>/review/`, as `{ label, file }`, sorted by label. `label` is the slug, plus the nested folders below `review/`. */
function findRecords(root: string) {
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch (e: any) {
    throw new UsageError(`records root is unreadable: ${root} (${e.message})`);
  }
  const found: { label: string; file: string }[] = [];
  const walk = (dir: string, label: string) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${label}/${e.name}`);
      else if (e.isFile() && e.name === 'findings.json') found.push({ label, file: path.join(dir, e.name) });
    }
  };
  for (const s of slugs) if (s.isDirectory()) walk(path.join(root, s.name, 'review'), s.name);
  return found.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

const idPart = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * IC-008 generator. `git(args)` runs git in the checkout the fixes live in.
 * @returns {{ corpus: object }} the corpus object (not yet written)
 */
function buildCorpus({ recordsRoot, repoRoot, config = loadConfig(), git = (args: string[]) => gitOut(repoRoot, args) }: { recordsRoot: string; repoRoot: string; config?: any; git?: (args: string[]) => string | null }) {
  const skipped: Record<string, any> = { 'record-invalid': [] as string[], ...Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) };
  const cases: any[] = [];
  const parents = new Map();
  const parentOf = (fixedIn: string) => {
    if (!parents.has(fixedIn)) {
      const out = git(['rev-parse', '--verify', '--quiet', `${fixedIn}^`]);
      parents.set(fixedIn, out && HEX_HEAD.test(out) ? out : null);
    }
    return parents.get(fixedIn);
  };
  const present = new Map();
  /** True when `<rev>:<file>` exists. A scope path absent at rev is a feature record or a file the fix added: it leaks the answer, so it is not handed out. */
  const presentAt = (rev: string, file: string) => {
    const k = `${rev}:${file}`;
    if (!present.has(k)) present.set(k, git(['cat-file', '-e', k]) !== null);
    return present.get(k);
  };
  const records = findRecords(recordsRoot);
  let valid = 0;
  for (const { label, file } of records) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { json = null; }
    if (json === null || !validateFindings(json).ok) {
      skipped['record-invalid'].push(label);
      continue;
    }
    valid += 1;
    const recordScope = [...new Set(json.converged.map((f: any) => parseLocator(f.locator)?.path).filter(Boolean))].sort();
    const nested = label.split('/').slice(1);
    for (const f of json.converged) {
      if (f.status !== 'fixed') { skipped['not-fixed'] += 1; continue; }
      if (!config.severities.includes(f.severity)) { skipped.severity += 1; continue; }
      const at = parseLocator(f.locator);
      if (!at) { skipped.locator += 1; continue; }
      const rev = parentOf(f.fixedIn);
      if (!rev) { skipped['no-parent'] += 1; continue; }
      if (!presentAt(rev, at.path)) { skipped['path-absent'] += 1; continue; }
      const scope = recordScope.filter((p: any) => presentAt(rev, p));
      const id = [json.row, ...nested, f.id].map(idPart).join('-');
      const expected = { path: at.path, startLine: at.startLine, endLine: at.endLine, severity: f.severity };
      cases.push({
        id,
        key: caseKey({ id, rev, scope, expected }),
        split: splitOf(id, config),
        source: { row: json.row, slug: json.slug, finding: f.id },
        rev,
        scope,
        expected,
      });
    }
  }
  skipped['record-invalid'].sort();
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dup = cases.find((c, i) => i > 0 && c.id === cases[i - 1].id);
  if (dup) throw new UsageError(`two findings map to the case id ${dup.id}; rename a converged finding id or its row`);
  return { schema: 1, kind: 'review-miss', records: valid, skipped, cases };
}

const sameKeys = (obj: any, keys: readonly string[]) => obj !== null && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).length === keys.length && keys.every((k: string) => Object.hasOwn(obj, k));

/**
 * IC-008 lint. Returns one string per problem (empty: clean). `git(args)` runs git in the checkout
 * `rev` must resolve in. Never throws on a malformed case: that is a problem line.
 */
function lintCorpus({ corpus, config = loadConfig(), repoRoot, git = (args: string[]) => gitOut(repoRoot, args) }: { corpus: any; config?: any; repoRoot: string; git?: (args: string[]) => string | null }) {
  const problems: string[] = [];
  if (!sameKeys(corpus, CORPUS_KEYS) || corpus.schema !== 1 || corpus.kind !== 'review-miss' || !Array.isArray(corpus.cases)) {
    return [`corpus: not a review-miss corpus (keys ${CORPUS_KEYS.join(', ')}, schema 1, kind review-miss)`];
  }
  const seen = new Set();
  let heldout = 0;
  corpus.cases.forEach((c: any, i: number) => {
    const name = c && typeof c.id === 'string' ? c.id : `#${i}`;
    const bad = (msg: string) => problems.push(`${name}: ${msg}`);
    if (!sameKeys(c, CASE_KEYS)) return bad(`key outside the case shape (${CASE_KEYS.join(', ')})`);
    if (!sameKeys(c.source, SOURCE_KEYS)) bad(`key outside the source shape (${SOURCE_KEYS.join(', ')})`);
    if (!sameKeys(c.expected, EXPECTED_KEYS)) return bad(`key outside the expected shape (${EXPECTED_KEYS.join(', ')})`);
    if (typeof c.id !== 'string' || c.id === '') return bad('id is not a non-empty string');
    if (seen.has(c.id)) bad('duplicate id');
    seen.add(c.id);
    if (!SPLITS.includes(c.split)) bad(`split ${JSON.stringify(c.split)} is not train or heldout`);
    if (c.split === 'heldout') heldout += 1;
    if (!Array.isArray(c.scope) || !c.scope.every((p: any) => typeof p === 'string')) return bad('scope is not a list of paths');
    if (typeof c.rev !== 'string' || !HEX_HEAD.test(c.rev)) bad('rev is not 40-hex');
    else if (git(['rev-parse', '--verify', '--quiet', `${c.rev}^{commit}`]) === null) bad('rev does not resolve to a commit');
    else for (const p of c.scope) if (git(['cat-file', '-e', `${c.rev}:${p}`]) === null) bad(`scope path ${p} is absent at rev`);
    if (!c.scope.includes(c.expected.path)) bad(`expected.path ${c.expected.path} is outside scope`);
    const { startLine, endLine, severity } = c.expected;
    if (!Number.isInteger(startLine) || startLine < 1) bad('expected.startLine is below 1');
    else if (!Number.isInteger(endLine) || endLine < startLine) bad('expected.endLine is below expected.startLine');
    if (!config.severities.includes(severity)) bad(`expected.severity ${JSON.stringify(severity)} is outside the config severities`);
    if (c.key !== caseKey(c)) bad('key does not match its digest');
  });
  if (corpus.cases.length >= HELDOUT_REQUIRED_AT && heldout === 0) {
    problems.push(`corpus: no heldout case among ${corpus.cases.length} cases (at least one is required from ${HELDOUT_REQUIRED_AT})`);
  }
  return problems;
}

module.exports = {
  UsageError, CONFIG_PATH, KEY_PREFIX, SKIP_REASONS, CASE_KEYS, loadConfig, caseKey, splitOf, parseLocator, findRecords, buildCorpus, lintCorpus,
};
