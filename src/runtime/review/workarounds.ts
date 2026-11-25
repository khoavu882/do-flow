'use strict';

/**
 * 181 C8 (IC-012, IC-013): workaround marks and their scan over a diff. A project marks a code pattern as a
 * workaround in `.doflow/workarounds.json`, with the reason and the preferred alternative; `scanWorkarounds`
 * matches each mark against the lines a diff adds, in the files its globs select. DoFlow never writes the file.
 * A mark with a finding is skipped and the others still apply; an absent or empty file gives no finding.
 *
 * Patterns are user input, so the scan is bounded (design R6): a pattern is at most 200 characters, a line over
 * 2,000 characters is skipped and counted, and the scan stops after 5,000 tested added lines with `truncated`.
 * A pattern that does not compile is a finding, never a throw.
 *
 * What bounds run time is the pattern, not a clock: `RegExp.test` cannot be interrupted, so a time budget would
 * not help. `riskyPattern` rejects, as a finding, any quantified group that contains a quantifier or an
 * alternation (`(a+)+`, `(a|aa)*`, `(\w+\s?)*`) and any backreference (`\1`, `\k<name>`); the check is
 * syntactic and conservative, so a safe pattern may be refused but a nested quantifier is not missed. Ceiling
 * accepted: adjacent quantifiers (`.*.*x`) stay polynomial in the line length, which the 2,000-character line
 * limit bounds.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LINE_MAX = 200;
const PATTERN_MAX = 200;
const MAX_MARKS = 100;
const ADDED_LINE_MAX = 2000;
const ADDED_LINES_MAX = 5000;
const MARK_KEYS = ['id', 'pattern', 'paths', 'reason', 'alternative', 'since'];
const FILE_KEYS = ['version', 'marks'];
const GIT_BUFFER = 256 * 1024 * 1024;

type Mark = { id: string; pattern: string; paths: string[]; reason: string; alternative: string; since: string };
type Match = { mark: string; path: string; line: number; text: string; reason: string; alternative: string };
type Scan = { file: 'present' | 'absent' | 'invalid'; matches: Match[]; truncated: boolean; findings: string[] };
type Ready = { mark: Mark; regex: RegExp; globs: RegExp[] };

const isObject = (value: any): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A repository-relative glob as an anchored expression: `**` crosses directories, `*` and `?` stay inside one. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function lineProblem(value: any): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  if (/[\r\n]/.test(value)) return 'must be one line';
  if (value.length > LINE_MAX) return `must be at most ${LINE_MAX} characters`;
  return null;
}

function validDate(value: any): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const RANGE_QUANTIFIER = /^\{\d+(,\d*)?\}/;

/** Why a pattern could run super-linearly (design R6), or null: a quantified group holding a quantifier or an alternation, or a backreference. */
function riskyPattern(pattern: string): string | null {
  const groups: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const top = groups[groups.length - 1];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if ((next >= '1' && next <= '9') || (next === 'k' && pattern[i + 2] === '<')) return 'pattern must not use a backreference';
      i += 1;
    } else if (ch === '[') {
      for (i += 1; i < pattern.length && pattern[i] !== ']'; i += 1) if (pattern[i] === '\\') i += 1;
    } else if (ch === '(') {
      groups.push({ quant: false, alt: false });
      if (pattern[i + 1] === '?') i += 1;
    } else if (ch === '|') top.alt = true;
    else if (ch === '*' || ch === '+' || ch === '?' || (ch === '{' && RANGE_QUANTIFIER.test(pattern.slice(i)))) top.quant = true;
    else if (ch === ')' && groups.length > 1) {
      const group = groups.pop() as { quant: boolean; alt: boolean };
      const next = pattern[i + 1];
      if ((next === '*' || next === '+' || (next === '{' && RANGE_QUANTIFIER.test(pattern.slice(i + 1)))) && (group.quant || group.alt)) {
        return 'pattern must not repeat a group that holds a quantifier or an alternation (nested quantifiers can run for ever)';
      }
      if (group.quant) groups[groups.length - 1].quant = true;
    }
  }
  return null;
}

/** The reasons one mark is invalid; empty when it is usable. */
function markProblems(mark: any): string[] {
  if (!isObject(mark)) return ['must be an object'];
  const problems = Object.keys(mark).filter((key) => !MARK_KEYS.includes(key)).map((key) => `has unknown key '${key}'`);
  if (typeof mark.pattern !== 'string' || mark.pattern === '') problems.push('pattern must be a non-empty string');
  else if (mark.pattern.length > PATTERN_MAX) problems.push(`pattern must be at most ${PATTERN_MAX} characters`);
  else {
    try {
      new RegExp(mark.pattern);
      const risk = riskyPattern(mark.pattern);
      if (risk) problems.push(risk);
    } catch (error: any) { problems.push(`pattern does not compile (${error?.message ?? error})`); }
  }
  if (!Array.isArray(mark.paths) || mark.paths.length === 0 || mark.paths.some((glob: any) => typeof glob !== 'string'
    || glob === '' || glob.startsWith('/') || glob.split('/').includes('..'))) {
    problems.push('paths must be a non-empty array of repository-relative globs');
  }
  for (const key of ['reason', 'alternative']) {
    const problem = lineProblem(mark[key]);
    if (problem) problems.push(`${key} ${problem}`);
  }
  if (!validDate(mark.since)) problems.push('since must be an ISO date (YYYY-MM-DD)');
  return problems;
}

/** `{ file, marks, findings }`: the usable marks of `<root>/.doflow/workarounds.json`, compiled. */
function readMarks(root: string, fsImpl: any): { file: Scan['file']; ready: Ready[]; findings: string[] } {
  const label = '.doflow/workarounds.json';
  let text: string;
  try { text = fsImpl.readFileSync(path.join(root, '.doflow', 'workarounds.json'), 'utf8'); } catch (error: any) {
    if (error && error.code === 'ENOENT') return { file: 'absent', ready: [], findings: [] };
    return { file: 'invalid', ready: [], findings: [`${label} cannot be read (${error?.message ?? error})`] };
  }
  if (text.trim() === '') return { file: 'present', ready: [], findings: [] };
  let doc: any;
  try { doc = JSON.parse(text); } catch (error: any) {
    return { file: 'invalid', ready: [], findings: [`${label} is not valid JSON (${error?.message ?? error})`] };
  }
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.marks)) {
    return { file: 'invalid', ready: [], findings: [`${label} must be { "version": 1, "marks": [...] }`] };
  }
  const findings = Object.keys(doc).filter((key) => !FILE_KEYS.includes(key)).map((key) => `${label} has unknown key '${key}'`);
  if (doc.marks.length > MAX_MARKS) findings.push(`${label} lists ${doc.marks.length} marks; only the first ${MAX_MARKS} are read`);
  const ready: Ready[] = [];
  const seen = new Set<string>();
  doc.marks.slice(0, MAX_MARKS).forEach((mark: any, index: number) => {
    const name = isObject(mark) && typeof mark.id === 'string' ? `mark '${mark.id}'` : `mark #${index + 1}`;
    const problems = markProblems(mark);
    if (!isObject(mark) || typeof mark.id !== 'string' || !MARK_ID.test(mark.id)) problems.unshift('id must match ^[a-z0-9][a-z0-9-]{0,47}$');
    else if (seen.has(mark.id)) problems.unshift('id duplicates an earlier mark');
    if (isObject(mark) && typeof mark.id === 'string') seen.add(mark.id);
    if (problems.length) { for (const problem of problems) findings.push(`${name}: ${problem}`); return; }
    ready.push({ mark, regex: new RegExp(mark.pattern), globs: mark.paths.map(globToRegExp) });
  });
  return { file: 'present', ready, findings };
}

/** Each added line of a `--unified=0` diff as `{ path, line, text }`; a deleted file and a binary change add none. */
function* addedLines(diff: string): Generator<{ path: string; line: number; text: string }> {
  let file: string | null = null;
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) file = raw === '+++ /dev/null' ? null : raw.slice('+++ b/'.length).replace(/\t$/, '');
      else if (raw.startsWith('@@ ')) {
        const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) { line = Number(hunk[1]); inHunk = true; }
      }
      continue;
    }
    if (raw.startsWith('@@ ')) {
      const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) line = Number(hunk[1]);
    } else if (raw.startsWith('+') && file !== null) {
      yield { path: file, line, text: raw.slice(1).replace(/\r$/, '') };
      line += 1;
    }
  }
}

function scanWorkarounds({ root, base, head, fsImpl = nodeFs }: { root: string; base: string; head: string; fsImpl?: any }): Scan {
  const { file, ready, findings } = readMarks(root, fsImpl);
  const result: Scan = { file, matches: [], truncated: false, findings };
  if (ready.length === 0) return result;

  const env = { ...process.env };
  for (const key of require('../dispatch/verify-run.ts').REPO_ENV) delete env[key];
  const res = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`], { cwd: root, env, encoding: 'utf8', maxBuffer: GIT_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  const overflow = (res.error as any)?.code === 'ENOBUFS';
  if (res.status !== 0 && !overflow) {
    findings.push(`git diff ${base}...${head} failed (${String(res.stderr || res.error?.message || `exit ${res.status}`).trim().split('\n')[0]})`);
    return result;
  }
  if (overflow) { result.truncated = true; findings.push('the diff is larger than the scan buffer; only its first part was scanned'); }

  let tested = 0;
  let tooLong = 0;
  for (const added of addedLines(String(res.stdout ?? ''))) {
    const marks = ready.filter((r) => r.globs.some((glob) => glob.test(added.path)));
    if (marks.length === 0) continue;
    if (added.text.length > ADDED_LINE_MAX) { tooLong += 1; continue; }
    if (tested === ADDED_LINES_MAX) { result.truncated = true; break; }
    tested += 1;
    for (const { mark, regex } of marks) {
      if (!regex.test(added.text)) continue;
      result.matches.push({ mark: mark.id, path: added.path, line: added.line, text: added.text.slice(0, LINE_MAX), reason: mark.reason, alternative: mark.alternative });
    }
  }
  if (tooLong) findings.push(`${tooLong} added line${tooLong === 1 ? '' : 's'} longer than ${ADDED_LINE_MAX} characters skipped`);
  if (tested === ADDED_LINES_MAX && result.truncated) findings.push(`the scan stopped after ${ADDED_LINES_MAX} added lines`);
  return result;
}

module.exports = { scanWorkarounds };
