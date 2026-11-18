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
// A started main session (165 D1, `kind: 'main-session'`) takes one branch at each step: no 080
// attempt re-check, the prompt read from the `session-prompts` store and checked against the record's
// sha256, no before or after snapshot (it may change its checkout: that is its work), the launch
// through `launchMainSession` (D9: no identity, no context emission), and `mainSession.parser`, which
// may be null: the end state then comes from the exit code alone (design R2).
//
// A started session whose harness declares a supported control channel (170 §5.2, `recipe.promptVia: 'channel'`) is
// launched through `launchChannelSession` with stdin kept open, and this process is that pipe's only writer: it writes
// the stored prompt as the first framed follow-up, takes later messages from the session's spool (`channel-spool.ts`),
// re-checks each (kind, R-4 command prefix, FR-013 turn rule, D6 limits, caps) and frames it through `channel.ts`, and
// tracks the turn from the harness's own events into `channel` (IC-002, coalesced, D9). When this process dies the
// kernel closes the pipe and the harness reads EOF (design 5.3, R-9): no orphan is left that the descriptor can end.
//
// This is the one module under `src/runtime/worker/` that holds a direct fs write call: the output
// sink's `mkdirSync` and `createWriteStream` (IC-018, IC-027, RK3). Every record write goes through
// the run store's `transition`; the run's login outcome (172 design 4.5) goes through `login-store.ts`;
// the spool through `channel-spool.ts`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readRuns, transition, RUN_ID } = require('./run-store.ts');
const { readTaskState } = require('../task-state.ts');
const attempts = require('../task-attempts.ts');
const { launchWorker, launchMainSession, launchChannelSession } = require('./launch.ts');
const { compileChannel, frameMessage, idOf, TurnTracker, admit, tally, createTurnCoalescer } = require('./channel.ts');
const { createSpool, spoolDir, takeMessages, removeSpool } = require('./channel-spool.ts');
const { choiceOf } = require('./model-choice.ts');
const { readPrompt: readStoredPrompt, requestOfPrompt } = require('./session-prompt.ts');
const { parserOf, parserIdOf } = require('./parsers.ts');
const worktreeCheck = require('./worktree-check.ts');
const processTree = require('./process-tree.ts');
const { cancelRun, mergeCleanup } = require('./cancel.ts');
const { bindingObserved } = require('./readiness.ts');
const { maskBody } = require('../mask.ts');
const { quotaOf } = require('./quota.ts');
const { loginExpiredOf } = require('./login.ts');
const { recordRunOutcome } = require('./login-store.ts');

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
/** 165 D1: the run kind of a started main session. */
const MAIN_SESSION = 'main-session';
/** 082 IC-014: the bound on each attempt-worktree git read, and the variables it drops (081 REPO_ENV). */
const EDIT_GIT_TIMEOUT_MS = 10000;
const REPO_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);
/** 170 §5.2 step 5: a turn waiting this long with no message closes stdin (`unused-timeout`). */
const CHANNEL_IDLE_MS = 30 * 60 * 1000;
/** 170 D3: the spool poll beside its watch. */
const SPOOL_POLL_MS = 100;
/** 170 §5.2 step 4: the longest wait for one record to reach the pipe (else `failed`, `stdin-stalled`). */
const STDIN_DRAIN_MS = 10000;
/** IC-002: the ledger keeps its newest entries. */
const LEDGER_MAX = 128;
/** Who may send (165 `--via` labels, `manual` for a terminal) and 165's request id. */
const ACTOR = /^(?:manual|console|device\.d-[0-9a-f]{12})$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/;
/** A channel write reaches the record in any phase: a canceller may have ended the run before the harness exits. */
const CHANNEL_PHASES = Object.freeze(['starting', 'running', 'cancelling', 'ended']);

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

function promptUnchanged(run: any, root: string): Buffer | null {
  try {
    // 165 IC-005: a started session's prompt is in the session-prompts store, named by its run id.
    const bytes = run.kind === MAIN_SESSION ? Buffer.from(readStoredPrompt(root, run.runId), 'utf8') : fs.readFileSync(run.prompt.path);
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

/** What masking did to a retained final message, in the run record beside the stdout and stderr pointers. */
const ALTERED_WARNING = 'masking altered this final message: it is not suitable for byte-exact patch application; apply the worker\'s changes from its isolated worktree, not from this text';

/**
 * Reads only the bounded Codex output-last-message prefix; absent or unreadable files are optional.
 * Returns the pointer the run record keeps (`path` relative to `stateRoot`, the masked `bytes`,
 * whether masking `altered` the text and, when it did, the `warning`), or null when no file was read.
 */
function readLastMessage(parser: any, file: string, stateRoot: string): any {
  if (typeof parser.lastMessage !== 'function') return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(65536);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const raw = bytes.subarray(0, length).toString('utf8');
    const masked = maskBody(raw).text;
    parser.lastMessage(masked);
    // NFR-004: the retained copy holds only the masked, bounded text, never the raw worker output.
    fs.closeSync(fd);
    fd = undefined;
    try { fs.writeFileSync(file, masked, 'utf8'); } catch { fs.rmSync(file, { force: true }); return null; }
    const altered = masked !== raw;
    return { path: path.relative(stateRoot, file).split(path.sep).join('/'), bytes: Buffer.byteLength(masked), altered, ...(altered ? { warning: ALTERED_WARNING } : {}) };
  } catch {
    // Codex may not have produced this optional file; that does not change the run outcome.
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* unreadable/closed files are ignored */ }
    }
  }
}

/** IC-002's `channel` as the supervisor first writes it, before the launch (170 §5.2 step 1). */
function openingChannel() {
  return {
    v: 1, state: 'opening', closedReason: null, turn: { observed: false, reason: 'no-event-yet', since: null },
    sent: { count: 0, bytes: 0, lastAt: null }, ledger: [] as any[],
  };
}

/**
 * 170 §5.2 steps 2 to 6 for one session: `open(prompt)` after `running`, `line(text)` for each stdout line, `exited(run)`
 * when the harness exits, `finish()` once its streams are drained. Every record write goes through `transition` and
 * never throws out (the harness keeps its supervisor); turn writes are coalesced (D9). A ledger entry holds the byte
 * count of the person's text (0 for a stop), never the text. `options`: `now` (the idle clock, ms), `idleMs`, `pollMs`,
 * `drainMs`, for tests.
 */
function channelSide({ file, runId, root, run, compiled, child, clock, options = {} }: any) {
  const idleMs: number = options.idleMs ?? CHANNEL_IDLE_MS;
  const pollMs: number = options.pollMs ?? SPOOL_POLL_MS;
  const drainMs: number = options.drainMs ?? STDIN_DRAIN_MS;
  const idleNow: () => number = options.now ?? (() => clock().getTime());
  const ledger: any[] = [];
  let counted: any = {};
  const tracker = new TurnTracker(compiled, () => clock().getTime());
  let seq = 0;
  let inflight: number | null = null;
  /**
   * Review A-02: every request id this supervisor has taken, is writing or has recorded. A file whose id is among them is
   * a retry that passed the verb's replay check while its first was in flight: it is taken and skipped, never written
   * again, and the first message's ledger entry is its answer. Known ceiling: the set grows with the ids taken over the
   * session's life (one hour, the started-session timeout), a 22-character string each.
   */
  const seen = new Set<string>();
  /** True when `requestId` was seen already; else it is marked seen now. A message without an id is never a retry. */
  const repeated = (requestId: string | null): boolean => {
    if (requestId === null) return false;
    if (seen.has(requestId)) return true;
    seen.add(requestId);
    return false;
  };
  let early: { seq: number; answer: string } | null = null;
  let closing: string | null = null;
  let quietFrom = idleNow();
  let pumping = false;
  let again = false;
  let watcher: any = null;
  let poll: any = null;

  const update = (apply: (channel: any) => void) => {
    try {
      transition(file, runId, CHANNEL_PHASES, (r: any) => { if (r.channel) apply(r.channel); });
    } catch {
      // an unreadable store: the next write carries the state again
    }
  };
  const coalescer = createTurnCoalescer((turn: any) => update((c) => { c.turn = turn; }));

  function append(entry: any) {
    if (early && early.seq === entry.seq) {
      if (entry.outcome === 'written') entry.answer = early.answer;
      early = null;
    }
    ledger.push(entry);
    if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
    // D6 counts from the stamps, never from the capped ledger (review A-01); the record carries them for the verb.
    counted = tally(counted, entry);
    const stamps = counted;
    update((c) => {
      c.ledger = [...(Array.isArray(c.ledger) ? c.ledger : []), entry].slice(-LEDGER_MAX);
      c.stamps = stamps;
      if (entry.outcome === 'written') c.sent = { count: (c.sent?.count ?? 0) + 1, bytes: (c.sent?.bytes ?? 0) + entry.bytes, lastAt: entry.at };
    });
  }

  function answered(found: { seq: number; answer: string }) {
    const entry = ledger.find((e) => e.seq === found.seq);
    if (!entry) {
      // The harness may answer before the write's callback ran: kept for the entry in flight only.
      if (found.seq === inflight) early = found;
      return;
    }
    if (entry.outcome !== 'written' || entry.answer !== null) return;
    entry.answer = found.answer;
    update((c) => {
      const stored = Array.isArray(c.ledger) ? c.ledger.find((e: any) => e?.seq === found.seq) : null;
      if (stored) stored.answer = found.answer;
    });
  }

  function stopWatching() {
    if (watcher) {
      try { watcher.close(); } catch { /* closed */ }
      watcher = null;
    }
    if (poll) clearInterval(poll);
    poll = null;
  }

  /** Closes the channel once: no message is taken after this, and stdin ends (destroyed after a write error). */
  function close(reason: string) {
    if (closing !== null) return;
    closing = reason;
    stopWatching();
    coalescer.flush();
    update((c) => { c.state = 'closed'; c.closedReason = reason; });
    const stdin = child.stdin;
    if (!stdin) return;
    if (reason === 'write-failed') stdin.destroy();
    else stdin.end();
  }

  /** `null` once the record reached the pipe, else the failure reason. */
  function writeStdin(bytes: Buffer): Promise<string | null> {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return Promise.resolve('channel-closed');
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      // Known ceiling: a stalled record stays in the stream's buffer and may still reach the harness after the entry
      // says failed; the entry records that it was not seen to arrive within the bound.
      const timer = setTimeout(() => finish('stdin-stalled'), drainMs);
      try {
        stdin.write(bytes, (error: any) => finish(error ? 'write-failed' : null));
      } catch {
        finish('write-failed');
      }
    });
  }

  /** One message, re-checked here whatever the verb checked: the turn rule (FR-013), D6, then the caps and R-4 in framing. */
  async function deliver(kind: string, by: string, requestId: string | null, text: string | undefined, waiting: number): Promise<boolean> {
    seq += 1;
    const n = seq;
    const base = { seq: n, kind, by, requestId, at: iso(clock), bytes: typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0, answer: null };
    const fail = (outcome: string, reason: string) => {
      append({ ...base, outcome, reason });
      return false;
    };
    if (closing !== null) return fail('failed', 'channel-closed');
    if (kind !== 'first') {
      const turn = tracker.turn;
      if (kind !== 'follow-up' && turn.observed && turn.state === 'waiting') return fail('refused', 'not-working');
      const admitted = admit(counted, by, kind as any, clock().getTime(), waiting);
      if (!admitted.ok) return fail('refused', admitted.code);
    }
    // The stored first prompt is a frame when the entry is `do`; R-4 is about the person's text inside it.
    const person = kind === 'first' && run.entry === 'do' ? requestOfPrompt(text) : undefined;
    const framed = frameMessage(compiled, kind as any, { text, person, id: idOf(n) });
    if (!framed.ok) return fail('refused', framed.code);
    inflight = n;
    const outcome = await writeStdin(framed.record);
    inflight = null;
    if (outcome !== null) {
      fail('failed', outcome);
      if (outcome === 'write-failed') close('write-failed');
      return false;
    }
    append({ ...base, outcome: 'written', reason: null });
    quietFrom = idleNow();
    return true;
  }

  /** Takes what the spool holds, oldest first, one record at a time. A file the spool refused is already deleted. */
  async function pump() {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        if (closing !== null) return;
        let taken: any[] = [];
        try { taken = takeMessages(root, runId); } catch { taken = []; }
        for (const item of taken) {
          if (!item.ok) continue;
          const m = item.message;
          if (!ACTOR.test(m.by) || (m.requestId !== null && !REQUEST_ID.test(m.requestId))) continue;
          if (repeated(m.requestId)) continue;
          // `waiting` counts the messages queued ahead of this one and not yet written (review B-03). Each one ahead was
          // written, refused or failed before this await returned, so none is still waiting: a batch taken together is
          // never refused for its own size. The verb's count is the spool files ahead of its drop.
          await deliver(m.kind, m.by, m.requestId, m.text, 0);
        }
      } while (again);
    } finally {
      pumping = false;
    }
  }

  function tick() {
    const turn = tracker.turn;
    if (closing === null && turn.observed && turn.state === 'waiting' && idleNow() - quietFrom >= idleMs) close('unused-timeout');
    else void pump();
  }

  return {
    close,
    /** Step 2: the stored prompt as the first framed message (seq 1, `by` the starter), then `open` and the spool. */
    async open(prompt: string) {
      child.stdin?.on('error', () => close('write-failed'));
      const written = await deliver('first', typeof run.startedBy === 'string' ? run.startedBy : 'manual', typeof run.request === 'string' ? run.request : null, prompt, 0);
      if (!written) {
        close(ledger[ledger.length - 1]?.outcome === 'refused' ? 'first-refused' : 'write-failed');
        return;
      }
      if (closing !== null) return;
      update((c) => { if (c.state === 'opening') c.state = 'open'; });
      try {
        watcher = fs.watch(spoolDir(root, runId), () => { void pump(); });
        watcher.on('error', () => {});
      } catch {
        watcher = null; // the poll alone
      }
      poll = setInterval(tick, pollMs);
      void pump();
    },
    /** Step 3: a stdout line; a `working` or `settled` event moves the turn, an answer marks its ledger entry. */
    line(text: string) {
      if (text.trimStart()[0] !== '{') return;
      let event: any;
      try { event = JSON.parse(text); } catch { return; }
      const { changed, answer } = tracker.feed(event);
      if (changed) {
        const turn = tracker.turn;
        if (turn.observed && turn.state === 'waiting') quietFrom = idleNow();
        coalescer.push(turn);
      }
      if (answer) answered(answer);
    },
    /** Step 6, at the harness's exit: closed with the reason a canceller left, else `harness-exited`. */
    exited(record: any) {
      close(record?.cancel?.source === 'timeout' ? 'timeout' : record?.cancel ? 'cancelled' : 'harness-exited');
    },
    /** Step 6, once the streams are done: the last turn written, every message left logged failed, the spool removed. */
    finish() {
      close('harness-exited');
      coalescer.flush();
      let left: any[] = [];
      try { left = takeMessages(root, runId); } catch { left = []; }
      for (const item of left) {
        if (!item.ok || !ACTOR.test(item.message.by)) continue;
        const m = item.message;
        if (m.requestId !== null && REQUEST_ID.test(m.requestId) && repeated(m.requestId)) continue;
        seq += 1;
        append({
          seq, kind: m.kind, by: m.by, requestId: m.requestId !== null && REQUEST_ID.test(m.requestId) ? m.requestId : null, at: iso(clock),
          bytes: typeof m.text === 'string' ? Buffer.byteLength(m.text, 'utf8') : 0, outcome: 'failed', reason: 'channel-closed', answer: null,
        });
      }
      try { removeSpool(root, runId); } catch { /* upkeep removes it */ }
    },
  };
}

/**
 * IC-014 steps 1 to 7 for `runId` in the run store `file`. Resolves the run's record as it stands
 * when the supervisor is done. `env`, `cwd` and `platform` default to this process's; `launch`,
 * `escalate`, `cancel` and `now` exist for in-process tests.
 */
async function superviseRun({
  file, runId, env = process.env, cwd = process.cwd(), platform = process.platform, now = () => new Date(),
  launch = launchWorker, launchMain = launchMainSession, launchChannel = launchChannelSession, escalate = processTree.escalate, cancel = cancelRun,
  channel: channelOptions = {},
}: any) {
  const clock = typeof now === 'function' ? now : () => now;
  const { root, stateRoot, ledger } = rootsFor(file);
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
  const main = run.kind === MAIN_SESSION;
  if (!main && !attemptActive(ledger, run)) {
    notStarted('attempt-not-active');
    return current();
  }
  const promptBytes = promptUnchanged(run, root);
  if (!promptBytes) {
    notStarted('prompt-changed');
    return current();
  }
  // 170 §5.2: a session started through its control channel; a record that says so with no channel that compiles does not start.
  const viaChannel = main && run.recipe?.promptVia === 'channel';
  const compiled = viaChannel ? compileChannel(run.descriptor) : null;
  if (viaChannel && !compiled) {
    notStarted('channel-invalid');
    return current();
  }
  const dropSpool = () => {
    try { removeSpool(root, runId); } catch { /* upkeep removes it */ }
  };

  // Step 2: the before snapshot; for an edit run the caller checkout and the attempt HEAD (082 IC-014).
  let before: any = null;
  let attemptBefore: any = null;
  if (!main) {
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
  }

  // Step 3: `launchingAt`, then the launch. A refused transition means a cancel took the run.
  // 170 §5.2 step 1: a channel session's spool (0700) and `channel.state: 'opening'` come first.
  if (compiled) {
    try {
      createSpool(root, runId);
    } catch {
      dropSpool();
      notStarted('spool-unwritable');
      return current();
    }
  }
  const marked = transition(file, runId, ['starting'], (r: any) => {
    r.launchingAt = iso(clock);
    if (compiled) r.channel = openingChannel();
  });
  if (!marked.applied) {
    dropSpool();
    return current();
  }
  const outputArgv = compiled ? run.descriptor.controlChannel.argv : main ? run.descriptor?.mainSession?.argv : run.descriptor?.structuredOutput?.argv;
  const usesLastMessageFile = Array.isArray(outputArgv) && outputArgv.includes('{lastMessageFile}');
  const lastMessageFile = usesLastMessageFile ? path.join(stateRoot, 'worker-output', `${runId}.last.log`) : undefined;
  let launched: any;
  try {
    if (lastMessageFile) {
      fs.mkdirSync(path.dirname(lastMessageFile), { recursive: true });
      fs.rmSync(lastMessageFile, { force: true });
    }
    launched = compiled
      ? await launchChannel({ recipe: run.descriptor, runId, execWorktree: run.execWorktree, env, model: choiceOf(run.binding) })
      : main
      ? await launchMain({
        recipe: run.descriptor, prompt: promptBytes.toString('utf8'), runId, execWorktree: run.execWorktree, env,
        model: choiceOf(run.binding), ...(lastMessageFile ? { lastMessageFile } : {}),
      })
      : await launch({
        recipe: run.descriptor, prompt: promptBytes.toString('utf8'), identity: run.identity, runId,
        execWorktree: run.execWorktree, env, taskId: run.task, ...(run.edit ? { edit: true } : {}),
        ...(lastMessageFile ? { lastMessageFile } : {}),
        ...(run.binding ? { binding: run.binding } : {}),
      });
  } catch (error: any) {
    if (compiled) dropSpool();
    transition(file, runId, ['starting'], (r: any) => {
      if (r.channel) Object.assign(r.channel, { state: 'closed', closedReason: 'not-started' });
    });
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
    if (launched.launched) r.launched = launched.launched;
  });
  if (!running.applied) {
    // A cancel took the run after the spawn: end this supervisor's own worker and record it (DEC-040).
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.destroy();
    const outcome = await escalate({ proc: worker, platform });
    if (compiled) dropSpool();
    transition(file, runId, ['cancelling', 'ended'], (r: any) => {
      if (r.channel) Object.assign(r.channel, { state: 'closed', closedReason: 'cancelled' });
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
  // 171 IC-003: resolved through parserOf; a record whose descriptor names no structured parser (an old record)
  // falls back to the launch record's `recipe.parser`, as before.
  const descriptor = run.descriptor ?? {};
  const source = main || parserIdOf(descriptor.structuredOutput) !== null ? descriptor : { structuredOutput: { parser: run.recipe?.parser ?? null } };
  const parser = parserOf(source, compiled ? 'channel' : main ? 'main' : 'structured').create();
  const side = compiled ? channelSide({ file, runId, root, run, compiled, child, clock, options: channelOptions }) : null;
  const out = createOutputSink({
    stateRoot, runId, stream: 'stdout',
    onLine: (text) => {
      parser.line(text);
      if (side) side.line(text);
    },
    onOversize: (looksJson) => parser.oversize(looksJson),
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
  if (side) side.open(promptBytes.toString('utf8')).catch(() => side.close('write-failed'));

  // Step 6: the exit and the recorded outcomes. These writes also reach a run a timeout or a cancel
  // already ended, where each field is added only when absent and the end is never touched (DEC-056).
  const STEP6 = ['running', 'cancelling', 'ended'];
  const put = (r: any, key: string, value: any) => {
    if (r.phase !== 'ended' || r[key] === undefined) r[key] = value;
  };
  const { code, signal } = await exited;
  clearTimeout(timer);
  if (side) {
    let record: any = null;
    try { record = current(); } catch { record = null; }
    side.exited(record);
  }
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
  if (side) side.finish();
  const output = { stdout: await out.end(), stderr: await err.end() };
  let readOnly: any = null;
  let isolation: any = null;
  if (main) {
    // A started session changes its checkout as its work; there is no read-only check to make.
  } else if (run.edit) {
    isolation = isolationOf(run, before, attemptBefore, env);
  } else {
    try {
      readOnly = worktreeCheck.compare(before, worktreeCheck.snapshot(run.execWorktree));
    } catch {
      readOnly = { status: 'unverifiable', changes: [], head: { before: before.head, after: null }, refsChanged: null };
    }
  }
  const lastMessage = lastMessageFile ? readLastMessage(parser, lastMessageFile, stateRoot) : null;
  if (lastMessage) (output as any).lastMessage = lastMessage;
  const report = parser.end();
  // 106 IC-002: a failure whose masked summary holds a declared quota signal is marked quota.
  const quota = quotaOf(report, run.descriptor);
  if (quota) report.quota = quota;
  // 172 design 4.4: a failure whose masked summary holds a declared expiry sign is marked loginExpired.
  const loginExpired = loginExpiredOf(report, run.descriptor);
  if (loginExpired) report.loginExpired = loginExpired;
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

  // 172 design 4.5: the run's login outcome goes to the user-level `harness-login` store, a run or a started session
  // alike. The store is a cache: a write that fails never changes the run.
  const outcome = loginExpired ? 'expired' : (report.status === 'success' ? 'succeeded' : null);
  if (outcome && typeof run.harness === 'string') {
    try {
      recordRunOutcome(env, run.harness, { outcome, at: iso(clock), runId, provider: loginExpired?.provider ?? null, sign: loginExpired?.sign ?? null }, { now: () => clock().getTime() });
    } catch {
      // the store stays as it was; the next run or login check writes it
    }
  }

  // Step 7: a timeout's cancel finishes before the supervisor exits; the canceller writes that end.
  if (timedOut) await timedOut;
  return current();
}

module.exports = { SUPERVISOR_FILE, OUTPUT_MAX_BYTES, LINE_MAX_BYTES, MASK_TAIL, superviseRun, createOutputSink, resultOfRun };

if (require.main === module) {
  const [file, runId] = process.argv.slice(2);
  superviseRun({ file, runId }).then(() => process.exit(0), () => process.exit(1));
}
