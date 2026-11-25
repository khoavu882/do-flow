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
 * What bounds run time is a clock. `RegExp.test` cannot be interrupted in this process, so all matching of the
 * file's input, the `paths` globs against the diff's file names and then each pattern against the added lines its
 * globs selected, runs in a child `node` (`spawnSync`, no shell) that is killed with SIGKILL when its window
 * closes: each child gets at most MARK_BUDGET_MS and the scan, both passes together, at most SCAN_BUDGET_MS. Nothing
 * from the file is matched in this process. The child reports each mark as it starts and as it finishes,
 * so a finished mark keeps its matches; a mark still running when its child is stopped, after at least half the
 * window of its own, is a finding and dropped, a mark stopped sooner is retried first in a new child, and a mark
 * the scan budget never reached is a finding. `spawnSync` returns only once the child has exited, so none
 * outlives the scan. `riskyPattern` is a fast syntactic pre-filter in front of the clock: it rejects, as a
 * finding, a repeated group that holds a quantifier or an alternation at any depth (`(a+)+`, `((a|aa))+`,
 * `(\w+\s?)*`), the same item repeated without bound twice in a row (`a*a*`, `.*.*`) and any backreference
 * (`\1`, `\k<name>`). It is conservative, so a safe pattern may be refused, but it cannot see every polynomial
 * blow-up (`[a]*a*[a]*a*b`); those are what the clock stops.
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
// A linear mark over the whole scan ceiling (5,000 lines of 2,000 characters) runs in tens of milliseconds, so 2 s
// per child is a wide margin; 10 s per scan keeps `review --action input` interactive with several bad marks.
const MARK_BUDGET_MS = 2000;
const SCAN_BUDGET_MS = 10000;
const MATCHER_BUFFER = 64 * 1024 * 1024;
// The child: reads { subjects, jobs } on stdin and writes one JSON line as each job starts and as it finishes; a
// job keeps the indexes of the subjects that one of its patterns matches.
const MATCHER = `const fs = require('node:fs');
const { subjects, jobs } = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const { k, patterns, idx } of jobs) {
  fs.writeSync(1, JSON.stringify(['start', k, Date.now()]) + '\\n');
  const regexes = patterns.map((pattern) => new RegExp(pattern));
  fs.writeSync(1, JSON.stringify(['done', k, idx.filter((i) => regexes.some((regex) => regex.test(subjects[i])))]) + '\\n');
}`;

type Mark = { id: string; pattern: string; paths: string[]; reason: string; alternative: string; since: string };
type Match = { mark: string; path: string; line: number; text: string; reason: string; alternative: string };
type Scan = { file: 'present' | 'absent' | 'invalid'; matches: Match[]; truncated: boolean; findings: string[] };
type Ready = { mark: Mark; globs: string[] };

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

const QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/;
const GROUP_PREFIX = /^\(\?(?:[:=!]|<[=!]|<[^>]*>)/;
type Group = { start: number; quant: boolean; alt: boolean };

/**
 * Why a pattern could run super-linearly (design R6), or null: a repeated group holding a quantifier or an
 * alternation at any depth, the same item repeated without bound twice in a row, or a backreference.
 */
function riskyPattern(pattern: string): string | null {
  const groups: Group[] = [{ start: 0, quant: false, alt: false }];
  let item = -1; // where the item a quantifier here would repeat starts; -1 when there is none
  let closed: Group | null = null; // that item, when it is a group
  let unbounded = { text: '', end: -1 }; // the last item repeated without bound, and where its quantifier ends
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const top = groups[groups.length - 1];
    const quantifier = item >= 0 ? QUANTIFIER.exec(pattern.slice(i)) : null;
    if (quantifier) {
      const q = quantifier[0];
      if (q[0] !== '?') {
        if (closed && (closed.quant || closed.alt)) {
          return 'pattern must not repeat a group that holds a quantifier or an alternation (nested quantifiers can run for ever)';
        }
        const text = pattern.slice(item, i);
        if (q[0] === '*' || q[0] === '+' || q.includes(',}')) {
          if (unbounded.end === item && unbounded.text === text) return 'pattern must not repeat the same item without bound twice in a row (such as a*a*)';
          unbounded = { text, end: i + q.length };
        }
      }
      top.quant = true;
      i += q.length - 1;
      item = -1;
      closed = null;
      continue;
    }
    item = i;
    closed = null;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if ((next >= '1' && next <= '9') || (next === 'k' && pattern[i + 2] === '<')) return 'pattern must not use a backreference';
      i += 1;
    } else if (ch === '[') {
      for (i += 1; i < pattern.length && pattern[i] !== ']'; i += 1) if (pattern[i] === '\\') i += 1;
    } else if (ch === '(') {
      groups.push({ start: i, quant: false, alt: false });
      const prefix = GROUP_PREFIX.exec(pattern.slice(i));
      if (prefix) i += prefix[0].length - 1;
      item = -1;
    } else if (ch === '|') {
      top.alt = true;
      item = -1;
    } else if (ch === ')' && groups.length > 1) {
      const group = groups.pop() as Group;
      if (group.quant) groups[groups.length - 1].quant = true;
      if (group.alt) groups[groups.length - 1].alt = true;
      item = group.start;
      closed = group;
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
    ready.push({ mark, globs: mark.paths.map((glob: string) => globToRegExp(glob).source) });
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

type Job = { k: number; patterns: string[]; idx: number[] };
type Clock = { markMs: number; scanMs: number; deadline: number };

/**
 * Each job's matching subject indexes, run in child processes under the clock (design R6): `hits` maps a mark's
 * index in `ready` to the indexes in `subjects` it matched; a mark that did not finish is a finding (`what` names
 * what it was matching) and absent from `hits`.
 */
function matchUnderClock(ready: Ready[], subjects: string[], jobs: Job[], { markMs, scanMs, deadline }: Clock, what: string):
  { hits: Map<number, number[]>; findings: string[] } {
  const hits = new Map<number, number[]>();
  const findings: string[] = [];
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  let pending = jobs;
  let why = `not checked: the scan's ${scanMs} ms budget ran out`;
  while (pending.length > 0 && Date.now() < deadline) {
    const res = spawnSync(process.execPath, ['-e', MATCHER], {
      input: JSON.stringify({ subjects, jobs: pending }), env, encoding: 'utf8', maxBuffer: MATCHER_BUFFER,
      timeout: Math.max(1, Math.min(markMs, deadline - Date.now())), killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stopped = Date.now();
    let running: { k: number; at: number } | null = null;
    for (const raw of String(res.stdout ?? '').split('\n')) {
      let msg: any;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg[0] === 'start') running = { k: msg[1], at: msg[2] };
      else if (msg[0] === 'done') { hits.set(msg[1], msg[2]); running = null; }
    }
    pending = pending.filter((job) => !hits.has(job.k));
    if ((res.error as any)?.code !== 'ETIMEDOUT') {
      if (pending.length > 0) why = `not checked: the matcher failed (${String(res.error?.message || res.stderr || `exit ${res.status}`).trim().split('\n')[0]})`;
      break;
    }
    if (running && stopped - running.at >= markMs / 2) {
      const k = running.k;
      findings.push(`mark '${ready[k].mark.id}': ${what} within ${markMs} ms and was stopped; its matches are not shown`);
      pending = pending.filter((job) => job.k !== k);
    }
  }
  for (const job of pending) findings.push(`mark '${ready[job.k].mark.id}': ${why}`);
  return { hits, findings };
}

function scanWorkarounds({ root, base, head, fsImpl = nodeFs, budget = { markMs: MARK_BUDGET_MS, scanMs: SCAN_BUDGET_MS } }:
  { root: string; base: string; head: string; fsImpl?: any; budget?: { markMs: number; scanMs: number } }): Scan {
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

  // The globs are untrusted too, so the files each mark selects are matched under the same clock as the patterns.
  const clock: Clock = { ...budget, deadline: Date.now() + budget.scanMs };
  const diff = String(res.stdout ?? '');
  const paths = [...new Set(Array.from(addedLines(diff), (added) => added.path))];
  if (paths.length === 0) return result;
  const all = paths.map((_, i) => i);
  const selection = matchUnderClock(ready, paths, ready.map((r, k) => ({ k, patterns: r.globs, idx: all })), clock, 'paths did not finish on the diff\'s file names');
  findings.push(...selection.findings);
  const selects = new Map<string, number[]>(paths.map((p) => [p, []]));
  for (const [k, idx] of selection.hits) for (const i of idx) (selects.get(paths[i]) as number[]).push(k);
  for (const list of selects.values()) list.sort((a, b) => a - b);

  const tested: { path: string; line: number; text: string; marks: number[] }[] = [];
  let tooLong = 0;
  for (const added of addedLines(diff)) {
    const marks = selects.get(added.path) as number[];
    if (marks.length === 0) continue;
    if (added.text.length > ADDED_LINE_MAX) { tooLong += 1; continue; }
    if (tested.length === ADDED_LINES_MAX) { result.truncated = true; break; }
    tested.push({ ...added, marks });
  }
  const jobs: Job[] = ready.map((r, k) => ({ k, patterns: [r.mark.pattern], idx: tested.flatMap((t, i) => (t.marks.includes(k) ? [i] : [])) }))
    .filter((job) => job.idx.length > 0);
  if (jobs.length > 0) {
    const { hits, findings: late } = matchUnderClock(ready, tested.map((t) => t.text), jobs, clock, 'pattern did not finish on the added lines');
    findings.push(...late);
    const matched = new Set<string>();
    for (const [k, idx] of hits) for (const i of idx) matched.add(`${i}:${k}`);
    tested.forEach((added, i) => {
      for (const k of added.marks) {
        if (!matched.has(`${i}:${k}`)) continue;
        const { mark } = ready[k];
        result.matches.push({ mark: mark.id, path: added.path, line: added.line, text: added.text.slice(0, LINE_MAX), reason: mark.reason, alternative: mark.alternative });
      }
    });
  }
  if (tooLong) findings.push(`${tooLong} added line${tooLong === 1 ? '' : 's'} longer than ${ADDED_LINE_MAX} characters skipped`);
  if (tested.length === ADDED_LINES_MAX && result.truncated) findings.push(`the scan stopped after ${ADDED_LINES_MAX} added lines`);
  return result;
}

module.exports = { scanWorkarounds };
