'use strict';

// Feature 150 A.3 (IC-002, IC-003, IC-004; FR-002, FR-004, FR-009, FR-011, FR-013, FR-014, FR-018,
// NFR-007): the three read-only worker verbs.
//
//   doflow worker-log    --worker-run <runId> --stream out|err [--slug <slug>] [--cursor <c> | --before <c>] [--json]
//   doflow worker-result --worker-run <runId> [--slug <slug>] [--json]
//   doflow worker-runs   [--slug <slug>] [--json]
//
// Each `*Body` function returns `{exit, json}` and prints nothing; each `handle*Command` prints it.
// The run store is `worker-runs/<slug>.json` under the lifecycle project root (`storeFileFor`), or,
// without `--slug`, the store that holds the run, found as the `worker:<runId>` channel finds it.
// A log file is formed only by `logFile` (IC-001), from the state root that holds the store, so
// `<runId>.last.log` cannot be formed and no path is ever taken from the run record. Bodies are
// built field by field, never by spreading the record, and every string leaf goes through
// `maskJson`. Read-only: no file is created, written, renamed or deleted, no lock is taken and no
// process is probed or signalled.

const fs = require('node:fs');
const path = require('node:path');
const { storeFileFor, readRuns, RUN_ID } = require('./run-store.ts');
const { LOG_STREAMS, logFile, readLogPage } = require('./log-read.ts');
const { resultOfRun } = require('./supervisor.ts');
const { maskJson } = require('../events/envelope.ts');
const { isSafeSlug } = require('../task-scope.ts');
const { printSafe } = require('../mask.ts');
const { finishRuntime } = require('../cli-result.ts');
const { projectRoot: lifecycleProjectRoot } = require('../lifecycle/root.ts');

/** IC-004: the most runs one `worker-runs` body lists; the rest are counted in `limits.notShown`. */
const WORKER_RUNS_LIMIT = 100;

/** The flags each verb takes, each at most once; all but `--json` take a value. */
const VERB_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  'worker-log': new Set(['--worker-run', '--stream', '--slug', '--cursor', '--before', '--json']),
  'worker-result': new Set(['--worker-run', '--slug', '--json']),
  'worker-runs': new Set(['--slug', '--json']),
});

/** IC-002: `<ino>:<offset>:<seq>:<ms>`, four decimal parts; seq and ms are accepted and ignored. */
const CURSOR = /^([0-9]{1,20}):([0-9]{1,16}):[0-9]{1,16}:[0-9]{1,16}$/;
/** Longest part of untrusted text echoed back in a stderr line. */
const ECHO_CHARS = 80;

type Env = Record<string, string | undefined>;
type Verb = 'worker-log' | 'worker-result' | 'worker-runs';
interface Writable { write(text: string): any }

/** What every read takes. `flags` is every flag as typed (`flagsGiven`), for the unknown and
 * repeated flag checks; an in-process caller may leave it empty. `env` is accepted for the
 * dispatch form; no read takes anything from it. */
interface ReadOptions {
  slug?: string | null;
  json?: boolean;
  flags?: readonly string[];
  positional?: readonly string[];
  env?: Env;
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
}
interface LogOptions extends ReadOptions {
  workerRun?: string;
  stream?: string;
  cursor?: string;
  before?: string;
  /** The clock of the cursors' informative `ms` part, epoch milliseconds. */
  now?: () => number;
  /** The fs the log page is read through (IC-001 `readLogPage`), for tests. */
  fsImpl?: any;
}
interface ResultOptions extends ReadOptions { workerRun?: string }
interface RunsOptions extends ReadOptions {
  /** The feature of the current branch when `--slug` is not given (`featureOf`, worker/command.ts). */
  resolveSlug?: ((cwd: string) => string | null) | null;
}

/** A read's answer: the exit code, the body, and the one stderr line that explains a failure. */
type Answer = { exit: number; json: any; message: string | null };

const given = (value: any) => value !== undefined && value !== null && value !== false;
const failure = (exit: number, error: string, message: string): Answer => ({ exit, json: { v: 1, ok: false, error }, message });
const usage = (message: string): Answer => failure(2, 'usage', message);
const ok = (json: any): Answer => ({ exit: 0, json: maskJson(json), message: null });

/** One line of untrusted text made safe to print: no control characters, bounded. */
function shown(text: unknown): string {
  const safe = String(printSafe(String(text))).replace(/[\r\n]+/g, ' ');
  return safe.length > ECHO_CHARS ? `${safe.slice(0, ECHO_CHARS)}...` : safe;
}

/** The first problem with the flags and positionals as typed, or null. */
function flagProblem(verb: Verb, flags: readonly string[], positional: readonly string[]): string | null {
  const allowed = VERB_FLAGS[verb];
  const seen = new Set<string>();
  for (const raw of flags) {
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    if (!allowed.has(name)) return `unknown flag '${shown(raw)}'; only ${[...allowed].join(', ')} apply`;
    if (eq !== -1 && name === '--json') return '--json takes no value';
    if (seen.has(name)) return `${name} is given more than once`;
    seen.add(name);
  }
  if (positional.length > 0) return `takes no positional argument, got '${shown(positional[0])}'; run it in the project`;
  return null;
}

/** `--slug` when given: a safe feature slug, or a usage problem. */
function slugProblem(slug: any): string | null {
  if (!given(slug)) return null;
  return typeof slug === 'string' && isSafeSlug(slug) ? null : `'${shown(slug)}' is not a valid feature slug`;
}

function runIdProblem(workerRun: any): string | null {
  if (!given(workerRun)) return '--worker-run is required';
  return typeof workerRun === 'string' && RUN_ID.test(workerRun) ? null : `--worker-run expects 'w-' plus 12 lowercase hex characters, got '${shown(workerRun)}'`;
}

/** The store's runs, or the `store-unreadable` answer; any other fault is thrown. */
function runsOf(file: string): { runs: Record<string, any> } | { answer: Answer } {
  try {
    return { runs: readRuns(file) };
  } catch (error: any) {
    if (error?.code === 'store-unreadable') return { answer: failure(2, 'store-unreadable', 'the worker run store cannot be read: it is torn or not version 1') };
    throw error;
  }
}

/** The run `runId` and the file holding it: from `--slug`'s store, else the store that holds it. */
function lookupRun(slug: any, runId: string, cwd: string): { run: any; file: string } | { answer: Answer } {
  const root = lifecycleProjectRoot(cwd);
  let file: string;
  if (given(slug)) {
    file = storeFileFor(root, String(slug));
  } else {
    // Required here, not at the top: sections.ts requires this module for its `runs` and `result`
    // sections, so a top-level require either way would hand one side a partial module.
    const { findWorkerRun } = require('../events/sections.ts');
    const found = findWorkerRun({ lifecycleRoot: root }, runId);
    if (!found) return { answer: failure(1, 'unknown-run', `no worker run store holds run ${runId}`) };
    file = found.file;
  }
  const read = runsOf(file);
  if ('answer' in read) return read;
  if (!Object.prototype.hasOwnProperty.call(read.runs, runId)) return { answer: failure(1, 'unknown-run', `the worker run store holds no run ${runId}`) };
  return { run: read.runs[runId], file };
}

/** The record's output pointer for the stream: `output.stdout` for `out`, `output.stderr` for `err`. */
function pointerOf(run: any, stream: 'out' | 'err'): any {
  const pointer = run?.output?.[stream === 'out' ? 'stdout' : 'stderr'];
  return pointer && typeof pointer === 'object' ? pointer : null;
}

const str = (value: any): string | null => (typeof value === 'string' ? value : null);
const ended = (run: any) => run?.phase === 'ended';

function computeLog(o: LogOptions): Answer {
  const problem = flagProblem('worker-log', o.flags ?? [], o.positional ?? [])
    ?? runIdProblem(o.workerRun)
    ?? (!given(o.stream) ? '--stream is required: out or err'
      : typeof o.stream !== 'string' || !Object.hasOwn(LOG_STREAMS, o.stream) ? `--stream must be out or err, got '${shown(o.stream)}'` : null)
    ?? (given(o.cursor) && given(o.before) ? 'give at most one of --cursor and --before' : null)
    ?? slugProblem(o.slug);
  if (problem) return usage(problem);
  const positionFlag = given(o.cursor) ? '--cursor' : given(o.before) ? '--before' : null;
  let position: { ino: string; offset: number } | null = null;
  if (positionFlag) {
    const text = positionFlag === '--cursor' ? o.cursor : o.before;
    const match = typeof text === 'string' ? CURSOR.exec(text) : null;
    if (!match || !Number.isSafeInteger(Number(match[2]))) return usage(`${positionFlag} must be the cursor of an earlier read, <ino>:<offset>:<seq>:<ms>`);
    position = { ino: match[1], offset: Number(match[2]) };
  }
  const runId = o.workerRun as string;
  const stream = o.stream as 'out' | 'err';
  const found = lookupRun(o.slug, runId, path.resolve(o.cwd ?? process.cwd()));
  if ('answer' in found) return found.answer;
  const { run, file } = found;
  const pointer = pointerOf(run, stream);
  const final = ended(run) && pointer !== null;
  // The sink writes under the state root that holds the store: `<root>/.doflow/state`.
  const stateRoot = path.dirname(path.dirname(file));
  let page: any;
  try {
    page = readLogPage({
      file: logFile(stateRoot, runId, stream),
      mode: positionFlag === '--cursor' ? 'forward' : positionFlag === '--before' ? 'backward' : 'tail',
      ...(position ? { offset: position.offset, ino: position.ino } : {}),
      final,
      ...(o.fsImpl ? { fsImpl: o.fsImpl } : {}),
    });
  } catch {
    return failure(1, 'log-unreadable', `the ${stream} log of run ${runId} cannot be read`);
  }
  const log = page.file === 'present' ? 'open' : !ended(run) ? 'waiting' : pointer ? 'gone' : 'none';
  const ms = (o.now ?? Date.now)();
  return ok({
    v: 1,
    runId,
    stream,
    phase: run.phase,
    log,
    ino: page.ino,
    size: page.size,
    from: page.from,
    to: page.to,
    pieces: page.pieces.map((p: any) => (p.cut ? { at: p.at, text: p.text, cut: true } : { at: p.at, text: p.text })),
    eof: page.eof,
    reset: page.reset,
    capped: final ? pointer.truncated === true : null,
    cursor: page.ino === null ? null : `${page.ino}:${page.to}:0:${ms}`,
    before: page.ino === null || page.from === 0 ? null : `${page.ino}:${page.from}:0:${ms}`,
  });
}

function computeResult(o: ResultOptions): Answer {
  const problem = flagProblem('worker-result', o.flags ?? [], o.positional ?? []) ?? runIdProblem(o.workerRun) ?? slugProblem(o.slug);
  if (problem) return usage(problem);
  const found = lookupRun(o.slug, o.workerRun as string, path.resolve(o.cwd ?? process.cwd()));
  if ('answer' in found) return found.answer;
  const { run } = found;
  const isEdit = Boolean(run.edit);
  const done = ended(run);
  const { resultOffered, withheld } = resultOfRun(run);
  const quota = run.report?.quota && typeof run.report.quota === 'object' ? run.report.quota : null;
  return ok({
    v: 1,
    runId: run.runId,
    task: run.task,
    token: run.token,
    harness: str(run.harness),
    phase: run.phase,
    endState: done ? str(run.end?.state) : null,
    endedAt: done ? str(run.end?.at) : null,
    reportStatus: str(run.report?.status),
    readOnly: isEdit ? null : str(run.readOnly?.status),
    isolation: isEdit && run.isolation && typeof run.isolation === 'object'
      ? { status: str(run.isolation.status), reason: str(run.isolation.reason) } : null,
    resultOffered,
    withheld: [...withheld],
    quota: quota ? { signal: str(quota.signal), basis: str(quota.basis) } : null,
  });
}

/** `createdAt` as epoch ms; a run without a readable one sorts as oldest. */
const createdMs = (run: any): number => {
  const ms = typeof run?.createdAt === 'string' ? Date.parse(run.createdAt) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};

function byCreated(a: any, b: any): number {
  const d = createdMs(a) - createdMs(b);
  if (d !== 0 && !Number.isNaN(d)) return d < 0 ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

function computeRuns(o: RunsOptions): Answer {
  const problem = flagProblem('worker-runs', o.flags ?? [], o.positional ?? []) ?? slugProblem(o.slug);
  if (problem) return usage(problem);
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const resolveSlug = o.resolveSlug === undefined
    ? (dir: string) => require('../implementation-gate.ts').featureSlugFor({ projectRoot: dir })
    : o.resolveSlug;
  const feature = given(o.slug) ? String(o.slug) : (resolveSlug ? resolveSlug(cwd) : null);
  if (!feature) return usage('--slug is required: no feature could be resolved from the current branch');
  if (!isSafeSlug(feature)) return usage(`'${shown(feature)}' is not a valid feature slug`);
  const file = storeFileFor(lifecycleProjectRoot(cwd), feature);
  const present = fs.existsSync(file);
  const read = runsOf(file);
  if ('answer' in read) return read.answer;
  const all = Object.keys(read.runs).map((runId) => ({ runId, run: read.runs[runId] }))
    .sort((a, b) => byCreated({ runId: a.runId, createdAt: a.run?.createdAt }, { runId: b.runId, createdAt: b.run?.createdAt }));
  const shownRuns = all.slice(Math.max(0, all.length - WORKER_RUNS_LIMIT));
  return ok({
    v: 1,
    slug: feature,
    store: present ? 'present' : 'absent',
    runs: shownRuns.map(({ runId, run }) => ({
      runId,
      task: run.task,
      token: run.token,
      harness: str(run.harness),
      childOf: str(run.childOf),
      phase: run.phase,
      endState: ended(run) ? str(run.end?.state) : null,
      createdAt: str(run.createdAt),
      startedAt: str(run.startedAt),
      endedAt: ended(run) ? str(run.end?.at) : null,
      edit: run.edit !== undefined && run.edit !== null,
    })),
    limits: { shown: shownRuns.length, notShown: all.length - shownRuns.length },
  });
}

/** A store slug that `storeFileFor` refuses is a usage answer, as a flag problem would be. */
function guarded(compute: () => Answer): Answer {
  try {
    return compute();
  } catch (error: any) {
    if (error?.name === 'RunStoreError' && error.code === 'usage') return usage('the feature slug is not valid');
    throw error;
  }
}

const strip = ({ exit, json }: Answer) => ({ exit, json });

/** IC-002: one masked page of a run's `out` or `err` log, by byte cursor. Prints nothing. */
function workerLogBody(options: LogOptions = {}): { exit: number; json: any } { return strip(guarded(() => computeLog(options))); }
/** IC-003: exactly the requirement's result fields of one run. Prints nothing. */
function workerResultBody(options: ResultOptions = {}): { exit: number; json: any } { return strip(guarded(() => computeResult(options))); }
/** IC-004: the bounded run list of one feature, ended and child runs included. Prints nothing. */
function workerRunsBody(options: RunsOptions = {}): { exit: number; json: any } { return strip(guarded(() => computeRuns(options))); }

function writer(o: ReadOptions) {
  const stdout: Writable = o.stdout ?? process.stdout;
  const stderr: Writable = o.stderr ?? process.stderr;
  const safe = (w: Writable, text: string) => { try { w.write(text); } catch { /* the stream is gone: the exit code still says it */ } };
  return { out: (text: string) => safe(stdout, text), err: (text: string) => safe(stderr, text) };
}

/** Prints a body as one compact JSON line, and a failure's reason as one stderr line. */
function printJson(verb: Verb, o: ReadOptions, answer: Answer): number {
  const w = writer(o);
  w.out(`${JSON.stringify(answer.json)}\n`);
  if (answer.message) w.err(`doflow ${verb}: ${answer.message}\n`);
  return finishRuntime(answer.exit);
}

/**
 * `doflow worker-log` (IC-002). With `--json`, one compact JSON line on stdout. Without it, each
 * piece's text as one line (a cut piece with no line end), then
 * `<runId> <stream> <log> bytes <from> to <to> of <size>` on stderr. A failure is one
 * `doflow worker-log: ...` line on stderr (with `--json`, after its JSON body). Returns and sets the
 * exit code: 0, 1 `unknown-run` or `log-unreadable`, 2 `usage` or `store-unreadable`.
 */
function handleWorkerLogCommand(options: LogOptions = {}): number {
  const answer = guarded(() => computeLog(options));
  if (options.json) return printJson('worker-log', options, answer);
  const w = writer(options);
  if (answer.exit !== 0) {
    w.err(`doflow worker-log: ${answer.message}\n`);
    return finishRuntime(answer.exit);
  }
  const b = answer.json;
  w.out(b.pieces.map((p: any) => (p.cut ? p.text : `${p.text}\n`)).join(''));
  w.err(`${b.runId} ${b.stream} ${b.log} bytes ${b.from} to ${b.to} of ${b.size}\n`);
  return finishRuntime(0);
}

/** `doflow worker-result` (IC-003): one compact JSON line, with or without `--json`; exit 0, 1 `unknown-run`, 2 `usage` or `store-unreadable`. */
function handleWorkerResultCommand(options: ResultOptions = {}): number {
  return printJson('worker-result', options, guarded(() => computeResult(options)));
}

/** `doflow worker-runs` (IC-004): one compact JSON line, with or without `--json`; exit 0, 2 `usage` or `store-unreadable`. */
function handleWorkerRunsCommand(options: RunsOptions = {}): number {
  return printJson('worker-runs', options, guarded(() => computeRuns(options)));
}

module.exports = {
  handleWorkerLogCommand, handleWorkerResultCommand, handleWorkerRunsCommand,
  workerLogBody, workerResultBody, workerRunsBody,
  WORKER_RUNS_LIMIT, VERB_FLAGS,
};
