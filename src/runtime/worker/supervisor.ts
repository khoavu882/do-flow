'use strict';

// Feature 081 C.2 (IC-014, IC-017 recorded half, IC-018, IC-020 timer; DEC-010, DEC-022, DEC-028,
// DEC-033, DEC-037, DEC-040): the detached supervisor of one worker run.
//
// The run command spawns this file detached as
// `[...process.execArgv, SUPERVISOR_FILE, storeFile, runId]` with the caller's environment and cwd,
// so on the timeout path the supervisor hands 080's cancel its own inherited `env` and `cwd` and
// rebuilds no identity (DEC-038). It runs IC-014 steps 1 to 7: re-check the attempt and the prompt,
// take the before snapshot, mark `launchingAt`, launch, mark `running` with one timer armed, pipe
// both streams to masked, bounded output files and stdout to the parser, then record the process,
// read-only check, report and `launchObserved` and, while still `running`, the end. It never calls
// 080 finish (DEC-010): a `success` report changes no task state.
//
// The run record carries the full worker block as `descriptor`, beside data-model §1's reduced
// `recipe`: a detached process cannot receive the in-process descriptors tests inject (DEC-036), and
// the reduced recipe's `argvShape` has the prompt replaced, so it cannot be launched from.
//
// An edit run (082 IC-014, DEC-021, DEC-046, DEC-048) takes the edit check in place of the
// read-only check of steps 2 and 6: before the launch a snapshot of the caller checkout
// (`edit.callerTop`) and the attempt worktree's HEAD; after the exit `isolation` from the caller
// comparison, the attempt branch and `merge-base --is-ancestor <edit.base> HEAD`, with `readOnly`
// left null. The attempt worktree's files are not compared: they are the change.
//
// This is the one module under `src/runtime/worker/` that holds a direct fs write call: the output
// sink's `mkdirSync` and `createWriteStream` (IC-018, IC-027, RK3). Every record write goes through
// the run store's `transition`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readRuns, transition, RUN_ID } = require('./run-store.ts');
const { readTaskState } = require('../task-state.ts');
const attempts = require('../task-attempts.ts');
const { launchWorker } = require('./launch.ts');
const { parserFor } = require('./parsers.ts');
const worktreeCheck = require('./worktree-check.ts');
const processTree = require('./process-tree.ts');
const { cancelRun, mergeCleanup } = require('./cancel.ts');
const { bindingObserved } = require('./readiness.ts');
const { maskBody } = require('../mask.ts');
const { quotaOf } = require('./quota.ts');

/** This module's own file, which the run command spawns (G16). */
const SUPERVISOR_FILE = __filename;
/** IC-018: the most bytes one stream's output file holds, and the most one buffered line holds. */
const OUTPUT_MAX_BYTES = 4194304;
/** The former split point; since DEC-057 no longer a parse or mask boundary. */
const LINE_MAX_BYTES = 65536;
/**
 * IC-018 (DEC-057): bytes dropped from the masked prefix of an oversize line, so a token cut at the
 * buffer edge is never written unmasked. `mask.ts` exports no longest-match length (its token shapes
 * are open-ended), so this is a constant above the bounded shapes: a key name of at most about 130
 * characters plus its value, a 40-character key, a JWT or a `gh*_` token of ordinary length.
 * Known ceiling: a single token longer than this that straddles the 4 MiB cut leaves its head.
 */
const MASK_TAIL = 4096;
/** IC-011 step 0's default, for a record that carries none. */
const DEFAULT_TIMEOUT_SECONDS = 1800;
/** How long the streams may stay open after the worker's exit (a grandchild may hold them). */
const DRAIN_MS = 500;
const STREAMS = Object.freeze({ stdout: 'out', stderr: 'err' });
/** 082 IC-014: the bound on each attempt-worktree git read, and the variables it drops (081 REPO_ENV). */
const EDIT_GIT_TIMEOUT_MS = 10000;
const REPO_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);

const iso = (clock: () => Date) => clock().toISOString();

/** `<root>/.doflow/state/worker-runs/<slug>.json` gives the lifecycle root, the state root and the slug. */
function rootsFor(file: string) {
  const stateRoot = path.resolve(path.dirname(file), '..');
  const root = path.resolve(stateRoot, '..', '..');
  const slug = path.basename(file, '.json');
  return { root, stateRoot, slug, ledger: attempts.storeFile(root, slug) };
}

/**
 * Splits a byte stream into logical lines, each buffered whole up to `OUTPUT_MAX_BYTES` (DEC-057).
 * A line over that is handed to `onOversize` once with its first `OUTPUT_MAX_BYTES` bytes; the rest
 * of it is dropped up to its newline, which `onOversizeEnd` reports.
 */
function lineSplitter({ onLine, onOversize, onOversizeEnd }: {
  onLine: (line: Buffer, newline: boolean) => void; onOversize: (prefix: Buffer) => void; onOversizeEnd: (newline: boolean) => void;
}) {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  const take = () => {
    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    parts = [];
    size = 0;
    return line;
  };
  return {
    push(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(0x0a, start);
        const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl);
        if (!skipping && size + piece.length > OUTPUT_MAX_BYTES) {
          parts.push(piece.subarray(0, OUTPUT_MAX_BYTES - size));
          size = OUTPUT_MAX_BYTES;
          onOversize(take());
          skipping = true;
        } else if (!skipping && piece.length) {
          parts.push(piece);
          size += piece.length;
        }
        if (nl === -1) break;
        if (skipping) onOversizeEnd(true);
        else onLine(take(), true);
        skipping = false;
        start = nl + 1;
      }
    },
    end() {
      if (skipping) onOversizeEnd(false);
      else if (size) onLine(take(), false);
      parts = [];
      size = 0;
      skipping = false;
    },
  };
}

/**
 * IC-018: the masked, bounded output file of one stream, `worker-output/<runId>.<out|err>.log` under
 * `stateRoot` (the project's `.doflow/state`). Each whole line is masked with `maskBody` and written
 * until the file reaches `OUTPUT_MAX_BYTES`, the cut made after masking; later bytes are counted and
 * dropped. `onLine`, when given, receives every line's unmasked text, those past the cap included,
 * for the parser; a line over `OUTPUT_MAX_BYTES` goes to `onOversize(looksJson)` instead, and its
 * masked prefix is written less its last `MASK_TAIL` bytes (DEC-057). A write stream `'error'` marks
 * the sink `{ truncated: true, failed: <code> }` and stops writing; lines still reach `onLine`
 * (DEC-065). `end()` resolves `{ path, bytes, written, truncated, failed? }`, `path` relative to
 * `stateRoot`.
 */
function createOutputSink({ stateRoot, runId, stream, onLine, onOversize }: {
  stateRoot: string; runId: string; stream: 'stdout' | 'stderr'; onLine?: (text: string) => void; onOversize?: (looksJson: boolean) => void;
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError(`createOutputSink: run id '${runId}' is not 'w-' plus 12 hex characters`);
  if (!Object.hasOwn(STREAMS, stream)) throw new TypeError(`createOutputSink: stream must be stdout or stderr: ${stream}`);
  const rel = `worker-output/${runId}.${STREAMS[stream]}.log`;
  const abs = path.join(stateRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const file = fs.createWriteStream(abs, { flags: 'w' });
  let bytes = 0;
  let written = 0;
  let truncated = false;
  let full = false;
  let failed: string | null = null;
  let closed = false;
  file.on('error', (error: any) => {
    failed = typeof error?.code === 'string' && error.code ? error.code : 'write-failed';
    truncated = true;
  });
  file.on('close', () => { closed = true; });
  /** Writes `out` up to the file cap. */
  const emit = (out: Buffer) => {
    if (failed || full || !out.length) return;
    const room = OUTPUT_MAX_BYTES - written;
    if (out.length >= room) {
      if (out.length > room) truncated = true;
      full = true;
      out = out.subarray(0, room);
    }
    if (out.length) {
      file.write(out);
      written += out.length;
    }
  };
  const splitter = lineSplitter({
    onLine(line, newline) {
      const text = line.toString('utf8');
      if (onLine) onLine(text);
      if (full) {
        truncated = true;
        return;
      }
      emit(Buffer.from(maskBody(text).text + (newline ? '\n' : ''), 'utf8'));
    },
    onOversize(prefix) {
      if (onOversize) onOversize(prefix[0] === 0x7b);
      truncated = true;
      const masked = Buffer.from(maskBody(prefix.toString('utf8')).text, 'utf8');
      emit(masked.subarray(0, Math.max(0, masked.length - MASK_TAIL)));
    },
    onOversizeEnd(newline) {
      if (newline) emit(Buffer.from('\n'));
    },
  });
  const summary = () => ({ path: rel, bytes, written, truncated, ...(failed ? { failed } : {}) });
  let ended: Promise<any> | null = null;
  return {
    path: rel,
    write(chunk: Buffer | string) {
      const data: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += data.length;
      splitter.push(data);
    },
    end(): Promise<{ path: string; bytes: number; written: number; truncated: boolean; failed?: string }> {
      if (!ended) {
        splitter.end();
        ended = new Promise((resolve) => {
          if (closed) {
            resolve(summary());
            return;
          }
          file.once('close', () => resolve(summary()));
          if (!failed) file.end();
        });
      }
      return ended;
    },
  };
}

/** One bounded, read-only git call in `cwd`: `{ status, stdout }`, `status` null when it did not exit. */
function gitRead(cwd: string, args: string[], env: any): { status: number | null; stdout: string } {
  const clean: any = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of REPO_ENV) delete clean[key];
  const r = spawnSync('git', ['-C', cwd, ...args], { env: clean, timeout: EDIT_GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.error ? null : r.status, stdout: r.stdout || '' };
}

/** The attempt worktree's HEAD ref (`''` when detached) and object, or null when git failed. */
function attemptHead(worktree: string, env: any): { ref: string; object: string } | null {
  const ref = gitRead(worktree, ['symbolic-ref', '-q', 'HEAD'], env);
  if (ref.status !== 0 && ref.status !== 1) return null;
  const object = gitRead(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], env);
  if (object.status !== 0) return null;
  return { ref: ref.status === 0 ? ref.stdout.trim() : '', object: object.stdout.trim() };
}

/**
 * 082 IC-014's after-exit reading of an edit run: `violated` `outside-write` when the caller
 * checkout changed, `violated` `branch-moved` when the attempt branch moved off `edit.branch` or
 * off a descendant of `edit.base`, `unverifiable` `isolation-unverifiable` when a snapshot was
 * incomplete or a git call failed, else `clean`. `refsChanged` stays advisory (DEC-046).
 */
function isolationOf(run: any, before: any, attemptBefore: any, env: any) {
  let caller: any;
  try {
    caller = worktreeCheck.compare(before, worktreeCheck.snapshot(run.edit.callerTop));
  } catch {
    caller = { status: 'unverifiable', changes: [], head: { before: before.head, after: null }, refsChanged: null };
  }
  const after = attemptHead(run.execWorktree, env);
  const ancestor = after ? gitRead(run.execWorktree, ['merge-base', '--is-ancestor', run.edit.base, 'HEAD'], env).status : null;
  let status: string;
  let reason: string | null;
  if (caller.status === 'violated') [status, reason] = ['violated', 'outside-write'];
  else if ((after && after.ref !== run.edit.branch) || ancestor === 1) [status, reason] = ['violated', 'branch-moved'];
  else if (caller.status !== 'clean' || !after || ancestor !== 0) [status, reason] = ['unverifiable', 'isolation-unverifiable'];
  else [status, reason] = ['clean', null];
  return {
    status, reason, changes: caller.changes, callerHead: caller.head,
    attemptHead: { before: attemptBefore, after }, refsChanged: caller.refsChanged,
  };
}

/**
 * IC-017, computed from a record, never stored: `resultOffered` is true only for a run that ended
 * `exited` with `process.kind: 'exited'`, a `clean` read-only check and a `success` report, and
 * whose group left no survivors after the exit (`group-survived`, DEC-058). For an edit run
 * (082 IC-014) `isolation.status` stands in for `readOnly.status`, and a withheld one names
 * `outside-write`, `branch-moved` or `isolation-unverifiable`.
 */
function resultOfRun(run: any): { resultOffered: boolean; withheld: string[] } {
  const withheld: string[] = [];
  if (run?.end?.state !== 'exited' || run?.process?.kind !== 'exited') withheld.push('not-exited');
  if (run?.edit) {
    const isolation = run?.isolation;
    if (isolation?.status === 'violated') withheld.push(isolation.reason === 'branch-moved' ? 'branch-moved' : 'outside-write');
    else if (isolation?.status !== 'clean') withheld.push('isolation-unverifiable');
  } else {
    const readOnly = run?.readOnly?.status;
    if (readOnly === 'violated') withheld.push('read-only-violation');
    else if (readOnly !== 'clean') withheld.push('read-only-unverifiable');
  }
  const report = run?.report?.status;
  if (report === 'denied') withheld.push('report-denied');
  else if (report === 'failure') withheld.push(run?.report?.quota ? 'report-quota' : 'report-failure');
  else if (report !== 'success') withheld.push('report-unparsed');
  if (run?.process?.leftover?.status === 'survivors') withheld.push('group-survived');
  return { resultOffered: withheld.length === 0, withheld };
}

/** The 080 attempt holding the run's token is still active. */
function attemptActive(ledger: string, run: any): boolean {
  try {
    const data = readTaskState(fs, ledger);
    const entry = data?.tasks?.[run.task];
    return Array.isArray(entry?.attempts) && entry.attempts.some((a: any) => a.token === run.token && a.state === 'active');
  } catch {
    return false;
  }
}

function promptUnchanged(run: any): Buffer | null {
  try {
    const bytes = fs.readFileSync(run.prompt.path);
    return crypto.createHash('sha256').update(bytes).digest('hex') === run.prompt.sha256 ? bytes : null;
  } catch {
    return null;
  }
}

/** Resolves once `stream` has ended or closed. */
function drained(stream: any): Promise<void> {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
  });
}

function boundedWait(promise: Promise<any>, ms: number): Promise<any> {
  let timer: any;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/** Reads only the bounded Codex output-last-message prefix; absent or unreadable files are optional. */
function readLastMessage(parser: any, file: string): void {
  if (typeof parser.lastMessage !== 'function') return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(65536);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const masked = maskBody(bytes.subarray(0, length).toString('utf8')).text;
    parser.lastMessage(masked);
    // NFR-004: the retained copy holds only the masked, bounded text, never the raw worker output.
    fs.closeSync(fd);
    fd = undefined;
    try { fs.writeFileSync(file, masked, 'utf8'); } catch { fs.rmSync(file, { force: true }); }
  } catch {
    // Codex may not have produced this optional file; that does not change the run outcome.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* unreadable/closed files are ignored */ }
    }
  }
}

/**
 * IC-014 steps 1 to 7 for `runId` in the run store `file`. Resolves the run's record as it stands
 * when the supervisor is done. `env`, `cwd` and `platform` default to this process's; `launch`,
 * `escalate`, `cancel` and `now` exist for in-process tests.
 */
async function superviseRun({
  file, runId, env = process.env, cwd = process.cwd(), platform = process.platform, now = () => new Date(),
  launch = launchWorker, escalate = processTree.escalate, cancel = cancelRun,
}: any) {
  const clock = typeof now === 'function' ? now : () => now;
  const { stateRoot, ledger } = rootsFor(file);
  const current = () => readRuns(file)[runId];
  const notStarted = (reason: string) => transition(file, runId, ['starting'], (run: any) => {
    const at = iso(clock);
    run.process = { kind: 'not-started', reason, at };
    run.end = { state: 'exited', at };
    run.phase = 'ended';
  });

  // Step 1: the run, the attempt and the prompt.
  const run = current();
  if (!run || run.phase !== 'starting') return run ?? null;
  if (!attemptActive(ledger, run)) {
    notStarted('attempt-not-active');
    return current();
  }
  const promptBytes = promptUnchanged(run);
  if (!promptBytes) {
    notStarted('prompt-changed');
    return current();
  }

  // Step 2: the before snapshot; for an edit run the caller checkout and the attempt HEAD (082 IC-014).
  let before: any;
  let attemptBefore: any = null;
  try {
    before = worktreeCheck.snapshot(run.edit ? run.edit.callerTop : run.execWorktree);
    if (run.edit) attemptBefore = attemptHead(run.execWorktree, env);
  } catch {
    before = null;
  }
  if (!before || before.incomplete || (run.edit && !attemptBefore)) {
    notStarted('snapshot-failed');
    return current();
  }

  // Step 3: `launchingAt`, then the launch. A refused transition means a cancel took the run.
  const marked = transition(file, runId, ['starting'], (r: any) => { r.launchingAt = iso(clock); });
  if (!marked.applied) return current();
  const usesLastMessageFile = run.descriptor?.structuredOutput?.argv?.includes('{lastMessageFile}') === true;
  const lastMessageFile = usesLastMessageFile ? path.join(stateRoot, 'worker-output', `${runId}.last.log`) : undefined;
  let launched: any;
  try {
    if (lastMessageFile) {
      fs.mkdirSync(path.dirname(lastMessageFile), { recursive: true });
      fs.rmSync(lastMessageFile, { force: true });
    }
    launched = await launch({
      recipe: run.descriptor, prompt: promptBytes.toString('utf8'), identity: run.identity, runId,
      execWorktree: run.execWorktree, env, taskId: run.task, ...(run.edit ? { edit: true } : {}),
      ...(lastMessageFile ? { lastMessageFile } : {}),
    });
  } catch (error: any) {
    notStarted(typeof error?.code === 'string' && error.code ? error.code : 'launch-failed');
    return current();
  }
  const { child } = launched;
  const exited: Promise<{ code: number | null; signal: string | null }> = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code: number | null, signal: string | null) => resolve({ code, signal }));
  });
  const streamsDone = Promise.all([drained(child.stdout), drained(child.stderr)]);

  // Step 4: `running`, with the worker's identity and the deadline.
  const worker = { pid: child.pid, pgid: child.pid, start: platform === 'win32' ? null : processTree.procStart(child.pid) };
  const timeoutSeconds = Number.isInteger(run.timeoutSeconds) && run.timeoutSeconds > 0 ? run.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  const startedAt = clock();
  const deadline = new Date(startedAt.getTime() + timeoutSeconds * 1000);
  const running = transition(file, runId, ['starting'], (r: any) => {
    r.phase = 'running';
    r.worker = worker;
    r.startedAt = startedAt.toISOString();
    r.deadline = deadline.toISOString();
    r.launched = launched.launched;
  });
  if (!running.applied) {
    // A cancel took the run after the spawn: end this supervisor's own worker and record it (DEC-040).
    child.stdout?.resume();
    child.stderr?.resume();
    const outcome = await escalate({ proc: worker, platform });
    transition(file, runId, ['cancelling', 'ended'], (r: any) => {
      r.supervisorCleanup = {
        at: iso(clock), worker, status: outcome.status ?? 'unknown', reason: outcome.reason ?? null,
        survivors: outcome.survivors ?? [], zombies: outcome.zombies ?? [],
      };
      if (r.cleanup) r.cleanup = mergeCleanup(r.cleanup, r.supervisorCleanup);
    });
    child.stdout?.destroy();
    child.stderr?.destroy();
    return current();
  }

  // Step 5: the parser, the output files and the one timer.
  const parser = parserFor(run.descriptor?.structuredOutput?.parser ?? run.recipe?.parser ?? null).create();
  const out = createOutputSink({
    stateRoot, runId, stream: 'stdout', onLine: (text) => parser.line(text), onOversize: (looksJson) => parser.oversize(looksJson),
  });
  const err = createOutputSink({ stateRoot, runId, stream: 'stderr' });
  child.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.write(chunk));
  let timedOut: Promise<any> | null = null;
  const timer = setTimeout(() => {
    let phase: string | undefined;
    try {
      phase = current()?.phase;
    } catch {
      return;
    }
    if (phase !== 'running') return;
    timedOut = Promise.resolve()
      .then(() => cancel({ file, runId, by: 'doflow-worker', reason: `timeout after ${timeoutSeconds}s`, source: 'timeout', env, cwd, platform }))
      .catch((error: any) => ({ disposition: 'error', reason: error?.code ?? 'cancel-threw' }));
  }, Math.max(0, deadline.getTime() - clock().getTime()));

  // Step 6: the exit and the recorded outcomes. These writes also reach a run a timeout or a cancel
  // already ended, where each field is added only when absent and the end is never touched (DEC-056).
  const STEP6 = ['running', 'cancelling', 'ended'];
  const put = (r: any, key: string, value: any) => {
    if (r.phase !== 'ended' || r[key] === undefined) r[key] = value;
  };
  const { code, signal } = await exited;
  clearTimeout(timer);
  transition(file, runId, STEP6, (r: any) => put(r, 'process', { kind: 'exited', code, signal, at: iso(clock) }));
  // The group may outlive its leader: end what remains before the after snapshot (DEC-058). The
  // reading is recorded as `process.groupAlive` (false, true or 'unknown'; absent on win32, where no
  // group is read), so a reader infers a cleaned-up tree only from an observed `false` (DEC-047).
  const groupAlive = platform === 'win32' ? null : processTree.groupAlive(worker.pgid, worker.start);
  if (groupAlive !== null) {
    transition(file, runId, STEP6, (r: any) => {
      if (r.process?.kind === 'exited' && r.process.groupAlive === undefined) r.process.groupAlive = groupAlive;
    });
  }
  if (groupAlive === true) {
    const outcome = await escalate({ proc: worker, platform });
    const leftover = { status: outcome.status ?? 'unknown', reason: outcome.reason ?? null, survivors: outcome.survivors ?? [], zombies: outcome.zombies ?? [] };
    transition(file, runId, STEP6, (r: any) => {
      if (r.process?.kind === 'exited' && r.process.leftover === undefined) r.process.leftover = leftover;
    });
  }
  await boundedWait(streamsDone, DRAIN_MS);
  child.stdout?.destroy();
  child.stderr?.destroy();
  const output = { stdout: await out.end(), stderr: await err.end() };
  let readOnly: any = null;
  let isolation: any = null;
  if (run.edit) {
    isolation = isolationOf(run, before, attemptBefore, env);
  } else {
    try {
      readOnly = worktreeCheck.compare(before, worktreeCheck.snapshot(run.execWorktree));
    } catch {
      readOnly = { status: 'unverifiable', changes: [], head: { before: before.head, after: null }, refsChanged: null };
    }
  }
  if (lastMessageFile) readLastMessage(parser, lastMessageFile);
  const report = parser.end();
  // 106 IC-002: a failure whose masked summary holds a declared quota signal is marked quota.
  const quota = quotaOf(report, run.descriptor);
  if (quota) report.quota = quota;
  const unit = `L.${run.identity?.run}.${run.identity?.lineage}.${run.token}`;
  const launchObserved = run.identity ? (bindingObserved(launched.env ?? env, unit) ? 'yes' : 'no') : 'unknown';
  transition(file, runId, STEP6, (r: any) => {
    put(r, 'readOnly', readOnly);
    if (run.edit) put(r, 'isolation', isolation);
    put(r, 'report', report);
    put(r, 'launchObserved', launchObserved);
    put(r, 'output', output);
    if (r.phase === 'running') {
      r.end = { state: 'exited', at: iso(clock) };
      r.phase = 'ended';
    }
  });

  // Step 7: a timeout's cancel finishes before the supervisor exits; the canceller writes that end.
  if (timedOut) await timedOut;
  return current();
}

module.exports = { SUPERVISOR_FILE, OUTPUT_MAX_BYTES, LINE_MAX_BYTES, MASK_TAIL, superviseRun, createOutputSink, resultOfRun };

if (require.main === module) {
  const [file, runId] = process.argv.slice(2);
  superviseRun({ file, runId }).then(() => process.exit(0), () => process.exit(1));
}
