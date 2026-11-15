'use strict';

// The Console's action log (feature 162, D10, IC-008): `<config home>/doflow/console/actions.ndjson`, one older
// generation `actions.1.ndjson`, and `actions.lock` (present only during a rotation). Machine-wide, bounded at
// two generations of 1 MiB, declared as the store `console-action-log` in core/registry/storage.json. This
// module is its only writer. A line is closed fields built with `JSON.stringify` only: every value is an enum,
// a number, or a short token of `[A-Za-z0-9._:-]` (an address of hex digits, dots and colons), anything else
// becomes null, so a client's text can never shape a line; no free text is ever logged.
//
// API (everything async, one in-process queue keeps lines in call order; an append failure rejects with
// `ActionLogError`, `code` always `action-log-unwritable`, `reason` says why; the route replies
// `503 action-log-unwritable` for `begin`, and says a failed `end` once a minute on stderr):
//   openActionLog(env)            -> the log over `<config home>/doflow/console` by the core's rule (null when
//                                    there is no config home); `createActionLog({ dir, now?, pid?, lockWaitMs? })`
//                                    takes the folder directly (tests, scratch config homes)
//   log.begin(fields)             -> phase `begin`, written before the spawn; resolves `{ pid, seq }`
//   log.end(fields)               -> phase `end`, after the core's exit
//   log.refused(fields)           -> phase `refused`, an attempt refused before any spawn
//   log.append(phase, fields)     -> any of the three above
//   log.summary(code, key, base)  -> counts one `unauthenticated` (key = the address) or `rate-limited` (key =
//                                    the actor) attempt; the minute's bucket is written as one `summary` line
//                                    with `count` once the minute has passed (on a later `summary` or `flush`);
//                                    `base` ({ actor, address, transport }) is taken from the bucket's first call
//   log.flush(all?)               -> writes the buckets of minutes that have passed (all of them when `all`, for
//                                    shutdown); a bucket whose write fails is dropped and the error thrown
//   log.writeLine(text)           -> the low-level write: one line of at most 2048 bytes, rotation included
//   log.pid                       -> this process's id, also on every line next to the per-process `seq`
// `fields` (all optional): id, actor { kind, deviceId, scope, transport }, address, action, project,
// target { slug, taskId, gateId, runId }, expect { revision }, input { decision, textChars }, outcome, code,
// current { state, revision }, exit, ms. An enum field with a value outside its set is a programming error and
// rejects with reason `invalid-field`.
//
// The file is opened `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW` (plus `O_NONBLOCK`, so a FIFO planted under the
// name fails instead of blocking), mode 0600, and must be a regular file; the folder is this user's and is set
// to 0700. Each line is one `write`. Rotation happens before an append when the file is at least
// ACTION_LOG_BYTES: take `actions.lock` (created exclusively, waited on up to 2 s, one older than 10 s is
// removed), look again, rename `actions.ndjson` over `actions.1.ndjson`, release; the bound is two generations.
//
// Ceiling: whole-line appends from two Console processes rest on local-file-system `O_APPEND` behaviour for
// lines of at most 2 KiB (R6); the lock is advisory (two waiters that both judge a lock stale can both take it,
// the second look at the size keeps that to at most one extra rotation); a lock still held after the wait
// rejects the append (`lock-busy`) rather than writing past the bound. src/ is not importable here.

const fs = require('node:fs');
const path = require('node:path');
const { consoleDir } = require('./lan-cli.ts');

const ACTION_LOG_BYTES = 1048576;
const LINE_MAX_BYTES = 2048;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10_000;
const MAX_BUCKETS = 512;
const MINUTE_MS = 60_000;
const LOG_FILE = 'actions.ndjson';
const OLDER_FILE = 'actions.1.ndjson';
const LOCK_FILE = 'actions.lock';

const PHASES = ['begin', 'end', 'refused', 'summary'] as const;
const KINDS = ['local', 'device', 'unknown'] as const;
const SCOPES = ['local', 'view', 'control'] as const;
const TRANSPORTS = ['loopback', 'native', 'browser'] as const;
const OUTCOMES = ['applied', 'refused', 'failed', 'unknown', 'replayed'] as const;

type Phase = typeof PHASES[number];
type SummaryCode = 'unauthenticated' | 'rate-limited';
type Reason = 'line-too-long' | 'invalid-field' | 'folder' | 'not-regular' | 'lock-busy' | 'io';
type Fields = {
  id?: string | null,
  actor?: { kind?: string, deviceId?: string | null, scope?: string | null, transport?: string | null },
  address?: string | null, action?: string | null, project?: string | null,
  target?: { slug?: string | null, taskId?: string | null, gateId?: string | null, runId?: string | null },
  expect?: { revision?: number | null },
  input?: { decision?: string | null, textChars?: number | null },
  outcome?: string | null, code?: string | null,
  current?: { state?: string | null, revision?: number | null },
  exit?: number | null, ms?: number | null,
};
type Options = { dir: string, now?: () => number, pid?: number, lockWaitMs?: number };
type Bucket = { code: SummaryCode, minute: number, count: number, fields: Fields };

class ActionLogError extends Error {
  code: 'action-log-unwritable';
  reason: Reason;
  constructor(reason: Reason, message: string) {
    super(message);
    this.code = 'action-log-unwritable';
    this.reason = reason;
  }
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;
const token = (value: unknown): string | null => (typeof value === 'string' && TOKEN.test(value) ? value : null);
const address = (value: unknown): string | null => (typeof value === 'string' && ADDRESS.test(value) ? value : null);
const integer = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `value` when it is in `set` (or null), else a programming error. */
function member(name: string, value: unknown, set: readonly string[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && set.includes(value)) return value;
  throw new ActionLogError('invalid-field', `action log field ${name} is not one of ${set.join(', ')}`);
}

// One per process: with `pid` it names a line, whichever log instance wrote it.
let sequence = 0;

/** The line for one record: closed fields, in this order, `JSON.stringify` only. */
function buildLine(phase: Phase, fields: Fields, at: number, pid: number, count: number | null): string {
  const f = fields ?? {};
  const actor = f.actor ?? {};
  const target = f.target ?? {};
  const expect = f.expect ?? {};
  const input = f.input ?? {};
  const current = f.current ?? {};
  sequence += 1;
  return JSON.stringify({
    v: 1,
    at: new Date(at).toISOString(),
    pid,
    seq: sequence,
    phase: member('phase', phase, PHASES),
    id: token(f.id),
    actor: {
      kind: member('actor.kind', actor.kind ?? 'unknown', KINDS),
      deviceId: token(actor.deviceId),
      scope: member('actor.scope', actor.scope, SCOPES),
      transport: member('actor.transport', actor.transport, TRANSPORTS),
    },
    address: address(f.address),
    action: token(f.action),
    project: token(f.project),
    target: { slug: token(target.slug), taskId: token(target.taskId), gateId: token(target.gateId), runId: token(target.runId) },
    expect: { revision: integer(expect.revision) },
    input: { decision: token(input.decision), textChars: integer(input.textChars) },
    outcome: member('outcome', f.outcome, OUTCOMES),
    code: token(f.code),
    current: { state: token(current.state), revision: integer(current.revision) },
    exit: integer(f.exit),
    ms: integer(f.ms),
    count,
  });
}

function createActionLog(options: Options) {
  const dir = options.dir;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const file = path.join(dir, LOG_FILE);
  const older = path.join(dir, OLDER_FILE);
  const lock = path.join(dir, LOCK_FILE);
  const unwritable = (reason: Reason, detail: string) => new ActionLogError(reason, `action log ${file} cannot be written (${detail})`);
  const codeOf = (error: any) => (error && error.code ? error.code : 'error');

  /** Creates the folder 0700 and sets it to 0700; refuses a folder that is not this user's directory. */
  function prepareDir(): void {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let stat = fs.statSync(dir);
      if (!stat.isDirectory()) throw unwritable('folder', 'the folder is not a directory');
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw unwritable('folder', 'the folder is not owned by this user');
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
        fs.chmodSync(dir, 0o700);
        stat = fs.statSync(dir);
        if ((stat.mode & 0o077) !== 0) throw unwritable('folder', 'the folder mode cannot be set to 0700');
      }
    } catch (error: any) {
      if (error instanceof ActionLogError) throw error;
      throw unwritable('folder', `the folder cannot be prepared: ${codeOf(error)}`);
    }
  }

  /** The log's size, 0 when absent; throws when something that is not a regular file holds the name. */
  function sizeOf(): number {
    let stat: any;
    try {
      stat = fs.lstatSync(file);
    } catch (error: any) {
      if (error && error.code === 'ENOENT') return 0;
      throw unwritable('io', `cannot read the log: ${codeOf(error)}`);
    }
    if (!stat.isFile()) throw unwritable('not-regular', `${LOG_FILE} is not a regular file`);
    return stat.size;
  }

  /** Takes `actions.lock`, waits up to `lockWaitMs`, removes one older than 10 s. */
  async function takeLock(): Promise<void> {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx', 0o600));
        return;
      } catch (error: any) {
        if (!error || error.code !== 'EEXIST') throw unwritable('io', `cannot take the rotation lock: ${codeOf(error)}`);
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { /* released since: try again */ }
      if (Date.now() >= deadline) throw unwritable('lock-busy', 'another process holds the rotation lock');
      await sleep(LOCK_POLL_MS);
    }
  }

  async function rotate(): Promise<void> {
    await takeLock();
    try {
      if (sizeOf() >= ACTION_LOG_BYTES) fs.renameSync(file, older);
    } catch (error: any) {
      if (error instanceof ActionLogError) throw error;
      throw unwritable('io', `cannot rotate: ${codeOf(error)}`);
    } finally {
      try { fs.rmSync(lock, { force: true }); } catch { /* the stale rule removes it */ }
    }
  }

  async function write(text: string): Promise<void> {
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    if (bytes.length > LINE_MAX_BYTES) throw unwritable('line-too-long', `a line is ${bytes.length} bytes, at most ${LINE_MAX_BYTES}`);
    prepareDir();
    if (sizeOf() >= ACTION_LOG_BYTES) await rotate();
    let fd: number;
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      fd = fs.openSync(file, flags, 0o600);
    } catch (error: any) {
      if (error && (error.code === 'ELOOP' || error.code === 'ENXIO' || error.code === 'EISDIR')) throw unwritable('not-regular', `${LOG_FILE} is not a regular file`);
      throw unwritable('io', `cannot open the log: ${codeOf(error)}`);
    }
    try {
      if (!fs.fstatSync(fd).isFile()) throw unwritable('not-regular', `${LOG_FILE} is not a regular file`);
      if (fs.writeSync(fd, bytes) !== bytes.length) throw unwritable('io', 'a short write');
    } catch (error: any) {
      if (error instanceof ActionLogError) throw error;
      throw unwritable('io', `cannot write: ${codeOf(error)}`);
    } finally {
      fs.closeSync(fd);
    }
  }

  // One queue: lines reach the file in call order; a failure goes to its caller and the queue goes on.
  let tail: Promise<unknown> = Promise.resolve();
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  };

  const writeLine = (text: string): Promise<void> => queued(() => write(text));
  const append = (phase: Phase, fields: Fields = {}): Promise<{ pid: number, seq: number }> => queued(async () => {
    const line = buildLine(phase, fields, now(), pid, null);
    await write(line);
    return { pid, seq: sequence };
  });

  // ---- the aggregated 401 and 429 lines ----

  const buckets = new Map<string, Bucket>();
  const minuteOf = (at: number) => Math.floor(at / MINUTE_MS) * MINUTE_MS;

  /** Writes the buckets of minutes that have passed (every bucket when `all`). */
  function flush(all = false): Promise<void> {
    const due = [...buckets.entries()].filter(([, bucket]) => all || bucket.minute < minuteOf(now()));
    for (const [key] of due) buckets.delete(key);
    return queued(async () => {
      for (const [, bucket] of due) {
        const fields: Fields = { ...bucket.fields, code: bucket.code, outcome: 'refused' };
        await write(buildLine('summary', fields, bucket.minute, pid, bucket.count));
      }
    });
  }

  function summary(code: SummaryCode, key: string, base: Fields = {}): Promise<void> {
    if (code !== 'unauthenticated' && code !== 'rate-limited') throw new ActionLogError('invalid-field', 'a summary code is unauthenticated or rate-limited');
    const minute = minuteOf(now());
    let id = `${code}\n${minute}\n${String(key)}`;
    if (!buckets.has(id) && buckets.size >= MAX_BUCKETS) id = `${code}\n${minute}\n*overflow*`;
    const bucket = buckets.get(id) ?? { code, minute, count: 0, fields: id.endsWith('*overflow*') ? {} : base };
    bucket.count += 1;
    buckets.set(id, bucket);
    return flush(false);
  }

  return {
    pid,
    append,
    begin: (fields: Fields) => append('begin', fields),
    end: (fields: Fields) => append('end', fields),
    refused: (fields: Fields) => append('refused', fields),
    summary,
    flush,
    writeLine,
  };
}

/** The log over `<config home>/doflow/console` by the core's rule, or null when the environment has no config home. */
function openActionLog(env: Record<string, string | undefined>, extra: Omit<Options, 'dir'> = {}) {
  const dir = consoleDir(env);
  return dir === null ? null : createActionLog({ dir, ...extra });
}

module.exports = {
  createActionLog, openActionLog, ActionLogError,
  ACTION_LOG_BYTES, LINE_MAX_BYTES, LOG_FILE, OLDER_FILE, LOCK_FILE,
};
