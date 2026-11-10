'use strict';

// Live hub (feature 149, IC-010 and IC-012; DEC-024, DEC-028): the latest `SectionResult` of every
// section of every core channel the events supervisor follows, and one composed state per browser
// channel, fanned out to every subscriber. A composition runs the GET composers of routes.ts (`runs`,
// `sessionsView`, `runDetail`, `tasks`) and `project` over a runner answered from that cache by the
// IC-010 table; only `workflow`, `version` and `capabilities` go to the real verb runner, whose own
// cache serves them (NFR-008: compositions use `workflow` only). So a member equals the GET reply
// built from the same section results by construction.
//
// A read of a core channel that is not followed yet, or whose snapshot is not complete, records the
// channel as a dependency and aborts the composition as pending: the read's promise never settles
// (a fresh promise per read, so nothing keeps it alive), the hub stops waiting for the composer, and
// the supervisor's set is recomputed from the dependencies of every browser channel. The arrival of
// that channel's snapshot recomposes. A core frame on a dependency marks a browser channel; it is
// recomposed 25 ms after its first mark, diffed into `set` and `unset` pointers (depth 4 or less),
// and sent as one frame per channel. Frames over LIVE_FRAME_BUDGET become `reset` `frame-cap`.
//
// Log channels (150 IC-013), `worker:<runId>:out` and `:err`, are not composed. Each holds one log
// window of at most HUB_WINDOW_BYTES, every piece masked again by `maskLite`, fed by the core's
// `snapshot`, `append`, `reset`, `error` and `gone` frames and forwarded as IC-007 frames with the
// hub's own counter and clock in the id. One log support value per hub gates them: the first log
// subscribe runs one `worker-log` tail read through the pool, and no log channel joins the need set
// (so no `sub` line reaches the events child) before it answers `supported`. No verb runs per append
// or on a timer (NFR-008).
//
// API, for the /api/live route (B.5):
//
//   createLiveHub({ runner, supervisor, clock? }) -> {
//     readonly epoch: string;                  // 8 lowercase hex, minted here
//     subscribe(channel, listener): () => void; // IC-003/IC-006 channel (throws TypeError otherwise); returns unsubscribe
//     current(channel): { n, state, error, gone } | { n, window, error, gone } | null;  // the second form on a log channel
//     readonly unsupported: boolean;          // supervisor.state === 'unsupported'
//     onUnsupported(listener): void;
//     stop(): void;                           // ends timers and calls supervisor.stop()
//   }
//   listener(frame: { ch, n, type, at, data, id? })  // type: snapshot | patch | append | reset | error | gone;
//                                                    // `id`, on a log channel only, is IC-007's `<ino>:<offset>:<n>:<ms>`
//
// `subscribe` on a new channel creates it and schedules its first composition; it never calls a
// listener synchronously. On an existing channel it sends nothing: the caller decides from
// `current`, whose `state` is null while the hub owes the channel a snapshot (not composed yet, or
// after a reset), `error` is the code of the channel's last error frame while it lasts, and `gone`
// says the channel's own core channel was pruned (the hub sends nothing more on it). `n` is the
// counter of the channel's last frame (0 before any); a channel dropped on its last unsubscribe and
// created again continues from its last `n`, so within an epoch an `n` names one state of the channel
// (IC-013 resume). `envelopeText(epoch, frame)` is the IC-002
// envelope the frame cap is measured on.
//
// On a log channel `current` gives `window`, `{log, ino, from, to, pieces, phase, end}` (a copy),
// null while the hub waits for log support or the first core snapshot, and after a reset or gone;
// `error` is the code of its last error frame until the next snapshot or append. A channel whose log
// support is `unsupported` has `error` `core-lacks-verb` and gets nothing else.

const crypto = require('node:crypto');
const { project } = require('./project.ts');
const { PARAM_PATTERN, fleetError } = require('./verb-runner.ts');
const { maskLite } = require('./mask-lite.ts');

// routes.ts is read when a composition runs, not at load: the /api/live route that routes.ts gains
// depends on this module, and a load-time destructure would see routes.ts's exports before they exist.
const routes = () => require('./routes.ts');

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}
type SectionResult = { exit: number; json: unknown };
type RunnerResult = { ok: true; json: any; exit: number } | { ok: false; code: string; exit: number | null; reason?: string; errorId?: string };
interface Runner {
  run(shapeId: string, params?: Record<string, string>): Promise<any>;
}
/** IC-002 core envelope, as the supervisor hands it on. */
type CoreEnvelope = { v: 1; ch: string; id: string; type: string; at: string; data: Record<string, any> };
interface Supervisor {
  need(channels: ReadonlySet<string>): void;
  readonly state: 'stopped' | 'running' | 'down' | 'unsupported';
  onFrame(listener: (envelope: CoreEnvelope) => void): void;
  onDown(listener: (code: 'events-down' | 'live-unavailable') => void): void;
  stop(): void;
}
type Channel =
  | { kind: 'now'; name: string }
  | { kind: 'run'; name: string; slug: string; taskId: string }
  | { kind: 'tasks'; name: string; slug: string }
  | { kind: 'worker'; name: string; runId: string };
/** 150 IC-006: a worker run's stdout or stderr. */
type LogChannel = { kind: 'log'; name: string; runId: string; stream: 'out' | 'err' };
type Member = { status: number; body: unknown };
type State = Record<string, Member>;
type FrameType = 'snapshot' | 'patch' | 'append' | 'reset' | 'error' | 'gone';
/** `id` is set on a log channel's frames only (IC-007); every other frame's id is `<epoch>-<n>`. */
type Frame = { ch: string; n: number; type: FrameType; at: string; data: Record<string, unknown>; id?: string };
/** IC-001 piece, masked again; a piece too big for any frame is `{at, text: '', withheld: true}`. */
type LogPiece = { at: number; text: string; cut?: true; withheld?: true };
type LogEnd = { capped: boolean | null } | null;
/** 150 IC-013 LogWindow: the newest bytes of a log channel, at most HUB_WINDOW_BYTES. */
type LogWindow = { log: 'waiting' | 'open' | 'none'; ino: string | null; from: number; to: number; pieces: LogPiece[]; phase: string | null; end: LogEnd };
type LogSupport = 'unknown' | 'supported' | 'unsupported';
type LogLane = {
  channel: LogChannel;
  subscribers: Set<{ listener: Listener }>;
  n: number;
  window: LogWindow | null;
  error: string | null;
  gone: boolean;
  /** The inode and `to` of the lane's last snapshot or append, for the ids of reset, error and gone (IC-007). */
  ino: string;
  to: number;
  /** The deferred first notice of a channel made while support is `unsupported` or the child is down. */
  startTimer: any;
};
type Listener = (frame: Frame) => void;
type Patch = { set: Record<string, unknown>; unset: string[] };
/** One core channel: its sections, whether a whole snapshot has arrived, and the error that holds it. */
type CoreEntry = { sections: Map<string, SectionResult>; snapshotSeen: boolean; complete: boolean; error: string | null };
type Outcome =
  | { kind: 'done'; state: State; reads: Set<string> }
  | { kind: 'pending' | 'blocked' | 'failed'; reads: Set<string> };
type Browser = {
  channel: Channel;
  subscribers: Set<{ listener: Listener }>;
  n: number;
  /** The last composed state. */
  state: State | null;
  /** The code of the last error frame, until the next snapshot. */
  error: string | null;
  /** The next frame must be a snapshot: none sent yet, or a reset or an error since. */
  owesSnapshot: boolean;
  /** The JSON text of a state whose snapshot or patch was over the budget, so an unchanged recompose sends nothing. */
  cappedText: string | null;
  gone: boolean;
  /** Core channels the last composition read (a pending one adds to the set instead of replacing it). */
  deps: Set<string>;
  markTimer: any;
  composing: boolean;
  again: boolean;
  /** Raised by every error, reset and down: a composition that started before is discarded. */
  interrupts: number;
  pending: boolean;
  pendingTimer: any;
  pendingReported: boolean;
};

/** IC-014, DEC-018: the largest envelope sent. 4 KiB under 262144 leaves room for B.5's SSE `id:` vector (at most 2048 characters) and framing. */
const LIVE_FRAME_BUDGET = 262_144 - 4_096;
/** IC-010: a marked browser channel is recomposed this long after its first mark. */
const DEBOUNCE_MS = 25;
/** IC-010: a composition pending this long while the child runs is `error` `pending-timeout`. */
const PENDING_TIMEOUT_MS = 5_000;
/** IC-012: the most segments of a patch pointer. */
const MAX_POINTER_DEPTH = 4;
/** IC-002: the core error codes passed through; any other code is `core-contract-mismatch`. */
const CORE_ERROR_CODES: readonly string[] = Object.freeze(['unsupported-version', 'store-unreadable', 'producer-failed', 'too-many-channels']);
/** 150 IC-013 (proposed): the most bytes (`to - from`) a log window covers. */
const HUB_WINDOW_BYTES = 131_072;
/** 150 IC-010: the pooled runner's result for a core without the verb, which a missing `runs` or `result` section stands for. */
const OLD_CORE: Readonly<RunnerResult> = Object.freeze({ ok: false, code: 'core-error', exit: 1, reason: 'old-core' });
/** 150 IC-009: the sections an older core does not make, by core channel kind. */
const NEWER_SECTIONS: Readonly<Record<string, string>> = Object.freeze({ tasks: 'runs', worker: 'result' });
const LOG_STATES: readonly string[] = Object.freeze(['waiting', 'open', 'none']);
const RESET_REASONS: readonly string[] = Object.freeze(['replaced', 'frame-cap']);

/** IC-003: the core's ID_PATTERN (src/runtime/context/identity.ts, at most 56 characters) with the dot the Console's PARAM_PATTERN allows. */
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
/** src/runtime/worker/run-store.ts RUN_ID. */
const RUN_ID = /^w-[0-9a-f]{12}$/;

/** The IC-003 channel `text` names (with 150 IC-006's `worker:<runId>:out` and `:err`), or null for every other form. */
function parseChannel(text: unknown): Channel | LogChannel | null {
  if (typeof text !== 'string') return null;
  const parts = text.split(':');
  if (text === 'now') return { kind: 'now', name: text };
  if (parts[0] === 'run' && parts.length === 3 && CHANNEL_ID.test(parts[1]) && CHANNEL_ID.test(parts[2])) return { kind: 'run', name: text, slug: parts[1], taskId: parts[2] };
  if (parts[0] === 'tasks' && parts.length === 2 && CHANNEL_ID.test(parts[1])) return { kind: 'tasks', name: text, slug: parts[1] };
  if (parts[0] === 'worker' && parts.length === 2 && RUN_ID.test(parts[1])) return { kind: 'worker', name: text, runId: parts[1] };
  // Only out and err are worker output channels: `last` and every other stream are refused (FR-012).
  if (parts[0] === 'worker' && parts.length === 3 && RUN_ID.test(parts[1]) && (parts[2] === 'out' || parts[2] === 'err')) return { kind: 'log', name: text, runId: parts[1], stream: parts[2] };
  return null;
}

const isChannel = (text: unknown): boolean => parseChannel(text) !== null;

const isPlainObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/**
 * A section as the runner result `spawnCore` makes of a child (verb-runner.ts `close` handler): exit 0
 * with JSON is ok; exit 0 without JSON is `not-json`; any other exit is `core-error` with the JSON
 * `error` id by the rule of `errorIdOf` (one object, an `error` string matching PARAM_PATTERN).
 */
function resultOf(section: SectionResult): RunnerResult {
  if (section.exit === 0) return section.json === null ? { ok: false, code: 'core-error', exit: 0, reason: 'not-json' } : { ok: true, json: section.json, exit: 0 };
  const result: RunnerResult = { ok: false, code: 'core-error', exit: section.exit };
  const json: any = section.json;
  const id = isPlainObject(json) ? json.error : undefined;
  if (typeof id === 'string' && PARAM_PATTERN.test(id)) result.errorId = id;
  return result;
}

const isSectionResult = (value: unknown): value is SectionResult =>
  isPlainObject(value) && Number.isInteger(value.exit) && value.exit >= 0 && value.exit <= 255 && Object.hasOwn(value, 'json');

/** IC-002 `data` of a core snapshot or patch: sections of SectionResults, `more` true when present, `removed` names on a patch. */
function validSections(type: string, data: Record<string, any>): boolean {
  if (!isPlainObject(data.sections) || !Object.values(data.sections).every(isSectionResult)) return false;
  if (Object.hasOwn(data, 'more') && data.more !== true) return false;
  if (type === 'snapshot') return !Object.hasOwn(data, 'removed');
  return !Object.hasOwn(data, 'removed') || (Array.isArray(data.removed) && data.removed.every((name: unknown) => typeof name === 'string'));
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const INO = /^[0-9]{1,20}$/;

/** IC-001 pieces of a core log frame covering [from, to), offsets rising, each text masked again by `maskLite` (FR-018); null when malformed. */
function logPieces(value: unknown, from: number, to: number): LogPiece[] | null {
  if (!Array.isArray(value)) return null;
  const rawPieces: LogPiece[] = [];
  let last = -1;
  for (const piece of value) {
    if (!isPlainObject(piece) || !isCount(piece.at) || typeof piece.text !== 'string' || (Object.hasOwn(piece, 'cut') && piece.cut !== true)) return null;
    if (piece.at <= last || piece.at < from || piece.at >= to) return null;
    last = piece.at;
    rawPieces.push(piece.cut === true ? { at: piece.at, text: piece.text, cut: true } : { at: piece.at, text: piece.text });
  }
  let i = 0;
  while (i < rawPieces.length) {
    let j = i;
    while (j < rawPieces.length && rawPieces[j].cut === true) j++;
    const end = Math.min(rawPieces.length, j + 1);
    const run = rawPieces.slice(i, end);
    if (run.length === 1) {
      run[0].text = maskLite(run[0].text);
    } else {
      const joined = run.map((p) => p.text).join('');
      const masked = maskLite(joined);
      let pos = 0;
      for (let k = 0; k < run.length; k++) {
        const next = k === run.length - 1 ? masked.length : pos + run[k].text.length;
        run[k].text = masked.slice(pos, next);
        pos = next;
      }
    }
    i = end;
  }
  return rawPieces;
}

/** IC-007 `phase` and `end`: null or a string, null or `{capped: null | boolean}`. */
function logRunState(data: Record<string, any>): { phase: string | null; end: LogEnd } | null {
  if (data.phase !== null && typeof data.phase !== 'string') return null;
  if (data.end === null) return { phase: data.phase, end: null };
  if (!isPlainObject(data.end) || !(data.end.capped === null || typeof data.end.capped === 'boolean')) return null;
  return { phase: data.phase, end: { capped: data.end.capped } };
}

/** IC-007 `{from, to, pieces, phase, end}` of a core `append`, rebuilt from those fields; null when malformed. */
function logAppendOf(data: Record<string, any>): { from: number; to: number; pieces: LogPiece[]; phase: string | null; end: LogEnd } | null {
  if (!isCount(data.from) || !isCount(data.to) || data.from > data.to) return null;
  const pieces = logPieces(data.pieces, data.from, data.to);
  const state = logRunState(data);
  return pieces === null || state === null ? null : { from: data.from, to: data.to, pieces, ...state };
}

/** IC-007 `{log, ino, from, to, pieces, phase, end}` of a core `snapshot` as a window; `ino` is a string exactly when `log` is `open`. */
function logSnapshotOf(data: Record<string, any>): LogWindow | null {
  if (!LOG_STATES.includes(data.log)) return null;
  if (data.log === 'open' ? !(typeof data.ino === 'string' && INO.test(data.ino)) : data.ino !== null) return null;
  const rest = logAppendOf(data);
  return rest === null ? null : { log: data.log, ino: data.ino, ...rest };
}

/** A piece of `pieces` (covering up to `to`) starts before `offset` and ends past it: the two reads do not meet at a boundary. */
function straddles(pieces: LogPiece[], offset: number, to: number): boolean {
  for (let k = 0; k < pieces.length; k += 1) {
    const end = k + 1 < pieces.length ? pieces[k + 1].at : to;
    if (pieces[k].at < offset && end > offset) return true;
  }
  return false;
}

/** A route `Reply` as an IC-012 member: its status and parsed body. */
function memberOf(reply: { status: number; body?: string | Uint8Array }): Member {
  if (reply.body === undefined) return { status: reply.status, body: null };
  return { status: reply.status, body: JSON.parse(typeof reply.body === 'string' ? reply.body : Buffer.from(reply.body).toString('utf8')) };
}

/** A member that is the projector-refusal reply: DEC-040 makes it the channel's `error` `core-contract-mismatch`. */
const isMismatch = (member: Member): boolean =>
  member.status === 502 && isPlainObject(member.body) && isPlainObject(member.body.error) && member.body.error.code === 'core-contract-mismatch';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** RFC 6901: `~` is `~0` and `/` is `~1` in a segment. */
const pointer = (path: readonly string[]): string => path.map((segment) => `/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

function walk(before: unknown, after: unknown, path: string[], patch: Patch) {
  if (deepEqual(before, after)) return;
  if (!isPlainObject(before) || !isPlainObject(after) || path.length >= MAX_POINTER_DEPTH) {
    patch.set[pointer(path)] = after;
    return;
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patch.unset.push(pointer([...path, key]));
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) patch.set[pointer([...path, key])] = after[key];
    else walk(before[key], after[key], [...path, key], patch);
  }
}

/**
 * IC-012: `set` and `unset` pointers from the state root, 1 to 4 segments, turning `before` into
 * `after`. Objects are descended to depth 4; arrays, scalars and objects at depth 4 are set whole; a
 * member whose `status` changed is set whole. Null when nothing changed.
 */
function diffState(before: State, after: State): Patch | null {
  const patch: Patch = { set: {}, unset: [] };
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patch.unset.push(pointer([key]));
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) patch.set[pointer([key])] = after[key];
    else if (isPlainObject(before[key]) && isPlainObject(after[key]) && before[key].status !== after[key].status) patch.set[pointer([key])] = after[key];
    else walk(before[key], after[key], [key], patch);
  }
  return Object.keys(patch.set).length === 0 && patch.unset.length === 0 ? null : patch;
}

/** The IC-002 envelope of a browser frame, as sent; the frame cap is measured on its UTF-8 bytes. A log frame carries its IC-007 id. */
function envelopeText(epoch: string, frame: Frame): string {
  return JSON.stringify({ v: 1, ch: frame.ch, id: frame.id ?? `${epoch}-${frame.n}`, type: frame.type, at: frame.at, data: frame.data });
}

/** IC-012: the core channels a browser channel is known to read before its first composition. */
function initialDeps(channel: Channel): string[] {
  if (channel.kind === 'run') return [channel.name, `tasks:${channel.slug}`, 'now'];
  return [channel.name];
}

const NOW_SHAPES: readonly string[] = Object.freeze(['list', 'observed', 'slots', 'roadmap']);
const RUNNER_SHAPES: readonly string[] = Object.freeze(['workflow', 'version', 'capabilities']);

/** `params` has exactly the string keys `names` (sorted). */
function hasParams(params: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(params).sort();
  return keys.length === names.length && names.every((name, i) => keys[i] === name && typeof params[name] === 'string');
}

/**
 * IC-010: the core channel and section a shape is answered from, 'runner' for the real runner, or null (usage).
 * 150 IC-013: `worker-runs` from `tasks:<slug>` `runs`; `worker-result` and `worker-run-status` from
 * `worker:<runId>` `result` and `status`, whose core channel finds the store that holds the run itself.
 */
function targetOf(shapeId: string, params: Record<string, any>): { channel: string; section: string } | 'runner' | null {
  if (RUNNER_SHAPES.includes(shapeId)) return 'runner';
  if (NOW_SHAPES.includes(shapeId)) return hasParams(params, []) ? { channel: 'now', section: shapeId } : null;
  if (shapeId === 'status' || shapeId === 'timeline') {
    return hasParams(params, ['slug', 'taskId']) && isChannel(`run:${params.slug}:${params.taskId}`) ? { channel: `run:${params.slug}:${params.taskId}`, section: shapeId } : null;
  }
  if (shapeId === 'attempts') return hasParams(params, ['slug']) && isChannel(`tasks:${params.slug}`) ? { channel: `tasks:${params.slug}`, section: 'attempts' } : null;
  if (shapeId === 'worker-runs') return hasParams(params, ['slug']) && isChannel(`tasks:${params.slug}`) ? { channel: `tasks:${params.slug}`, section: 'runs' } : null;
  if (shapeId === 'worker-status') {
    const fits = hasParams(params, ['slug', 'task', 'token']) && isChannel(`tasks:${params.slug}`) && PARAM_PATTERN.test(params.task) && PARAM_PATTERN.test(params.token);
    return fits ? { channel: `tasks:${params.slug}`, section: `worker:${params.task}:${params.token}` } : null;
  }
  if (shapeId === 'worker-result' || shapeId === 'worker-run-status') {
    const fits = hasParams(params, ['runId', 'slug']) && PARAM_PATTERN.test(params.slug) && isChannel(`worker:${params.runId}`);
    return fits ? { channel: `worker:${params.runId}`, section: shapeId === 'worker-result' ? 'result' : 'status' } : null;
  }
  return null;
}

/** One composition's reads: every core channel touched, and whether one was missing (pending) or in error (blocked). */
type Composition = { reads: Set<string>; missing: boolean; blocked: boolean; closed: boolean; abort: () => void };
type Read = (core: string, section: string) => Promise<RunnerResult>;

/** routes.ts `failureInfo` for the failures a section maps to: a Fleet code first, then 501 for an older core, else 502 with the exit. */
function failureMember(shapeId: string, failure: RunnerResult & { ok: false }): Member {
  const r = routes();
  const fleet = fleetError(shapeId, failure);
  if (fleet) return memberOf(r.errorReply(fleet.status, fleet.code, shapeId, failure.exit));
  if (failure.reason === 'old-core') return memberOf(r.errorReply(501, 'core-lacks-verb', shapeId, null));
  return memberOf(r.errorReply(502, 'core-error', shapeId, failure.exit));
}

/**
 * 150 IC-012's `.../result` and `.../status` replies (`workerRunRoute`, routes.ts) for one result:
 * the projected body; status exit 1, or a status naming no run, is `404 unknown-run`.
 */
function workerReadMember(shapeId: 'worker-result' | 'worker-run-status', result: RunnerResult): Member {
  const r = routes();
  if (!result.ok) {
    const failed = failureMember(shapeId, result);
    const code = (failed.body as any).error.code;
    return shapeId === 'worker-run-status' && code === 'core-error' && result.exit === 1 ? memberOf(r.errorReply(404, 'unknown-run', shapeId, 1)) : failed;
  }
  const projected = project(shapeId, result.json);
  if (!projected.ok) return memberOf(r.errorReply(502, 'core-contract-mismatch', shapeId, 0));
  if (shapeId === 'worker-run-status' && projected.body === null) return memberOf(r.errorReply(404, 'unknown-run', shapeId, 0));
  return { status: 200, body: projected.body };
}

/** IC-012: the members of a browser channel, from the route composers over `runner`. */
async function composeState(channel: Channel, runner: Runner, read: Read): Promise<State> {
  const r = routes();
  if (channel.kind === 'now') {
    const [list, sessions] = await Promise.all([r.runs(runner), r.sessionsView(runner)]);
    return { runs: memberOf(list), sessions: memberOf(sessions) };
  }
  if (channel.kind === 'run') return { run: memberOf(await r.runDetail(runner, channel.slug, channel.taskId)) };
  if (channel.kind === 'tasks') {
    const [graph, workers] = await Promise.all([r.tasks(runner, channel.slug), r.workerRuns(runner, channel.slug)]);
    if (!graph.ok) return { tasks: memberOf(graph.reply), workers: memberOf(workers) };
    // As runDetail puts `tasks()` into the run body.
    const body: Record<string, unknown> = { tasks: graph.tasks };
    if (graph.tasks === null) body.tasksReason = graph.reason;
    return { tasks: { status: 200, body }, workers: memberOf(workers) };
  }
  // A `worker:<runId>` channel names no slug: its sections come from the store that holds the run,
  // which is the GET reply for that store's slug (IC-013).
  const [status, result] = await Promise.all([read(channel.name, 'status'), read(channel.name, 'result')]);
  return { worker: workerReadMember('worker-run-status', status), result: workerReadMember('worker-result', result) };
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function createLiveHub(options: { runner: Runner; supervisor: Supervisor; clock?: Clock }) {
  const { runner, supervisor, clock = realClock } = options;
  const epoch: string = crypto.randomBytes(4).toString('hex');
  const core = new Map<string, CoreEntry>();
  const channels = new Map<string, Browser>();
  /**
   * The last `n` of each channel the hub dropped, kept for the hub's lifetime so a channel created again
   * continues from it. Ceiling accepted: one number per distinct channel name ever dropped in the epoch.
   */
  const lastN = new Map<string, number>();
  const unsupportedListeners: Array<() => void> = [];
  let needed = new Set<string>();
  let stopped = false;
  /** 150 IC-013: the log channels by name, and the hub's one log support value. */
  const logs = new Map<string, LogLane>();
  let logSupport: LogSupport = 'unknown';
  let probing = false;

  const alive = (ch: Browser): boolean => !stopped && !ch.gone && channels.get(ch.channel.name) === ch;
  const freshEntry = (): CoreEntry => ({ sections: new Map(), snapshotSeen: false, complete: false, error: null });

  /**
   * The union of every live browser channel's dependencies, and of the log channels once log support
   * is `supported`, sent to the supervisor when it changed; core entries follow the dependencies.
   */
  function recomputeNeed() {
    const deps = new Set<string>();
    for (const ch of channels.values()) if (!ch.gone) for (const dep of ch.deps) deps.add(dep);
    for (const name of [...core.keys()]) if (!deps.has(name)) core.delete(name);
    for (const name of deps) if (!core.has(name)) core.set(name, freshEntry());
    const next = new Set(deps);
    if (logSupport === 'supported') for (const lane of logs.values()) if (!lane.gone) next.add(lane.channel.name);
    if (next.size === needed.size && [...next].every((name) => needed.has(name))) return;
    needed = next;
    if (!stopped) supervisor.need(new Set(next));
  }

  /** Every subscriber of a channel gets `frame`; a listener's fault is its own, and the hub and the other subscribers carry on. */
  function deliver(subscribers: Set<{ listener: Listener }>, frame: Frame) {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.listener(frame);
      } catch {
        // As said.
      }
    }
  }

  /** One frame on `ch` with the next n, or `reset` `frame-cap` in its place when its envelope is over the budget. False when replaced. */
  function emit(ch: Browser, type: FrameType, data: Record<string, unknown>): boolean {
    const at = new Date(clock.now()).toISOString();
    let frame: Frame = { ch: ch.channel.name, n: ch.n + 1, type, at, data };
    let fits = Buffer.byteLength(envelopeText(epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET;
    if (!fits) {
      frame = { ch: ch.channel.name, n: ch.n + 1, type: 'reset', at, data: { reason: 'frame-cap' } };
      ch.owesSnapshot = true;
      ch.error = null;
    }
    ch.n = frame.n;
    deliver(ch.subscribers, frame);
    return fits;
  }

  function emitError(ch: Browser, code: string) {
    ch.interrupts += 1;
    ch.error = code;
    ch.owesSnapshot = true;
    ch.cappedText = null;
    emit(ch, 'error', { code });
  }

  function emitReset(ch: Browser, reason: 'core-reset') {
    ch.interrupts += 1;
    ch.error = null;
    ch.owesSnapshot = true;
    ch.cappedText = null;
    emit(ch, 'reset', { reason });
  }

  function mark(ch: Browser) {
    if (ch.markTimer !== null || !alive(ch)) return;
    ch.markTimer = clock.setTimeout(() => {
      ch.markTimer = null;
      void flush(ch);
    }, DEBOUNCE_MS);
  }

  function clearPending(ch: Browser) {
    if (ch.pendingTimer !== null) clock.clearTimeout(ch.pendingTimer);
    ch.pendingTimer = null;
    ch.pending = false;
  }

  /**
   * `pending-timeout` once per pending spell, 5000 ms after it began, if the child is running then;
   * while it is down the wait starts again. Ceiling: a child that came back shortly before the timer
   * fires counts the time it was down.
   */
  function armPending(ch: Browser) {
    if (ch.pendingTimer !== null || ch.pendingReported) return;
    ch.pendingTimer = clock.setTimeout(() => {
      ch.pendingTimer = null;
      if (!alive(ch) || !ch.pending) return;
      if (supervisor.state === 'running') {
        ch.pendingReported = true;
        emitError(ch, 'pending-timeout');
      } else if (supervisor.state === 'down') {
        armPending(ch);
      }
    }, PENDING_TIMEOUT_MS);
  }

  /** Runs the composers once over the cache; a missing or held core channel ends it as pending or blocked. Never rejects. */
  async function compose(ch: Browser): Promise<Outcome> {
    let abort: () => void = () => {};
    const aborted = new Promise<null>((resolve) => {
      abort = () => resolve(null);
    });
    const ctx: Composition = { reads: new Set(), missing: false, blocked: false, closed: false, abort };
    const read: Read = (name: string, section: string): Promise<RunnerResult> => {
      if (ctx.closed) return new Promise(() => {});
      ctx.reads.add(name);
      const entry = core.get(name);
      if (entry !== undefined && entry.error !== null) {
        ctx.blocked = true;
        ctx.abort();
        return new Promise(() => {});
      }
      const found = entry !== undefined && entry.complete ? entry.sections.get(section) : undefined;
      if (found === undefined) {
        // 150 IC-013: a complete snapshot without a section only a newer core makes is the older core's answer.
        if (entry !== undefined && entry.complete && NEWER_SECTIONS[name.split(':')[0]] === section) return Promise.resolve({ ...OLD_CORE });
        ctx.missing = true;
        ctx.abort();
        // A fresh promise that never settles: the composer waits on it and is then dropped with it.
        return new Promise(() => {});
      }
      return Promise.resolve(resultOf(found));
    };
    const hubRunner: Runner = {
      run(shapeId: string, params?: Record<string, string>) {
        const target = targetOf(shapeId, params ?? {});
        if (target === 'runner') return runner.run(shapeId, params);
        if (target === null) return Promise.resolve({ ok: false, code: 'usage', exit: null });
        return read(target.channel, target.section);
      },
    };
    const done = composeState(ch.channel, hubRunner, read).then(
      (state): Outcome => ({ kind: 'done', state, reads: ctx.reads }),
      (): Outcome => ({ kind: 'failed', reads: ctx.reads }),
    );
    const outcome = await Promise.race([done, aborted]);
    ctx.closed = true;
    if (outcome !== null) return outcome;
    return { kind: ctx.blocked ? 'blocked' : 'pending', reads: ctx.reads };
  }

  async function flush(ch: Browser) {
    if (!alive(ch)) return;
    if (ch.composing) {
      ch.again = true;
      return;
    }
    // A channel made while the child is down or unsupported learns so on its first composition.
    if (supervisor.state === 'down' && ch.error === null) emitError(ch, 'events-down');
    if (supervisor.state === 'unsupported' && ch.error === null) emitError(ch, 'live-unavailable');
    ch.composing = true;
    const interrupts = ch.interrupts;
    const outcome = await compose(ch);
    ch.composing = false;
    if (!alive(ch)) return;
    if (interrupts === ch.interrupts) apply(ch, outcome);
    if (ch.again) {
      ch.again = false;
      mark(ch);
    }
  }

  function apply(ch: Browser, outcome: Outcome) {
    if (outcome.kind === 'done') ch.deps = new Set(outcome.reads);
    else for (const name of outcome.reads) ch.deps.add(name);
    recomputeNeed();
    if (outcome.kind === 'pending') {
      ch.pending = true;
      armPending(ch);
      return;
    }
    clearPending(ch);
    if (outcome.kind === 'blocked') return;
    ch.pendingReported = false;
    if (outcome.kind === 'done') {
      publish(ch, outcome.state);
    } else if (ch.error !== 'core-contract-mismatch') {
      // `failed`: a composer threw, so its input broke a contract no projector caught.
      emitError(ch, 'core-contract-mismatch');
    }
  }

  function publish(ch: Browser, next: State) {
    const before = ch.state;
    ch.state = next;
    if (Object.values(next).some(isMismatch)) {
      if (ch.error !== 'core-contract-mismatch') emitError(ch, 'core-contract-mismatch');
      return;
    }
    const text = JSON.stringify(next);
    if (ch.cappedText !== null && ch.cappedText === text) return;
    if (ch.owesSnapshot || before === null) {
      if (emit(ch, 'snapshot', { state: next })) {
        ch.owesSnapshot = false;
        ch.error = null;
        ch.cappedText = null;
      } else {
        ch.cappedText = text;
      }
      return;
    }
    const patch = diffState(before, next);
    if (patch === null) return;
    ch.cappedText = emit(ch, 'patch', patch) ? null : text;
  }

  /** Every live browser channel that read core channel `name`. */
  const dependents = (name: string): Browser[] => [...channels.values()].filter((ch) => alive(ch) && ch.deps.has(name));

  // ---- 150 IC-013: log channels ----

  const laneAlive = (lane: LogLane): boolean => !stopped && !lane.gone && logs.get(lane.channel.name) === lane;

  /**
   * One log emission: `pieces` covering [from, to) as one `type` frame, or, when its envelope is over
   * LIVE_FRAME_BUDGET, split at piece boundaries into that frame and consecutive `append` frames, each
   * `from` the previous `to`. A piece that does not fit a frame of its own is withheld in place (`{at,
   * text: '', withheld: true}`), in the window as well. Ids are IC-007's with the window's inode, the
   * frame's `to`, the hub's counter and the hub's clock.
   */
  function sendLog(lane: LogLane, type: 'snapshot' | 'append', from: number, to: number, pieces: LogPiece[]) {
    const w = lane.window as LogWindow;
    const ms = clock.now();
    const at = new Date(ms).toISOString();
    const ino = w.ino ?? '0';
    const make = (kind: 'snapshot' | 'append', n: number, lo: number, hi: number, list: LogPiece[]): Frame => {
      const data = kind === 'snapshot'
        ? { log: w.log, ino: w.ino, from: lo, to: hi, pieces: list, phase: w.phase, end: w.end }
        : { from: lo, to: hi, pieces: list, phase: w.phase, end: w.end };
      return { ch: lane.channel.name, n, type: kind, at, data, id: `${ino}:${hi}:${n}:${ms}` };
    };
    const count = pieces.length;
    const pieceBytes = (piece: LogPiece): number => Buffer.byteLength(JSON.stringify(piece), 'utf8');
    // prefix[k] is the bytes of pieces [0, k); a frame holding [i, j) adds them and j - i - 1 commas to its empty envelope.
    const prefix = [0];
    for (const piece of pieces) prefix.push(prefix[prefix.length - 1] + pieceBytes(piece));
    const size = (kind: 'snapshot' | 'append', n: number, lo: number, hi: number, i: number, j: number): number =>
      Buffer.byteLength(envelopeText(epoch, make(kind, n, lo, hi, [])), 'utf8') + prefix[j] - prefix[i] + Math.max(0, j - i - 1);
    const frames: Frame[] = [];
    let i = 0;
    let lo = from;
    let kind = type;
    for (;;) {
      const n = lane.n + frames.length + 1;
      if (size(kind, n, lo, to, i, count) <= LIVE_FRAME_BUDGET) {
        frames.push(make(kind, n, lo, to, pieces.slice(i)));
        break;
      }
      // The rest [i, count) did not fit. A head piece that does not fit alone is withheld (a withheld piece fits any frame).
      const headEnd = i + 1 < count ? pieces[i + 1].at : to;
      if (!pieces[i].withheld && size(kind, n, lo, headEnd, i, i + 1) > LIVE_FRAME_BUDGET) {
        const piece = pieces[i];
        piece.text = '';
        piece.withheld = true;
        delete piece.cut;
        const delta = pieceBytes(piece) - (prefix[i + 1] - prefix[i]);
        for (let k = i + 1; k < prefix.length; k += 1) prefix[k] += delta;
        continue;
      }
      if (i + 1 >= count) {
        frames.push(make(kind, n, lo, to, pieces.slice(i)));
        break;
      }
      // Pieces [i, j) end where piece j starts; j stops before count, since the whole rest did not fit.
      let j = i + 1;
      while (j + 1 < count && size(kind, n, lo, pieces[j + 1].at, i, j + 1) <= LIVE_FRAME_BUDGET) j += 1;
      frames.push(make(kind, n, lo, pieces[j].at, pieces.slice(i, j)));
      lo = pieces[j].at;
      i = j;
      kind = 'append';
    }
    lane.ino = ino;
    lane.to = to;
    lane.error = null;
    for (const frame of frames) {
      lane.n = frame.n;
      deliver(lane.subscribers, frame);
    }
  }

  /** A `reset`, `error` or `gone` frame, whose id carries the lane's last inode and `to`. */
  function sendLogSingle(lane: LogLane, type: 'reset' | 'error' | 'gone', data: Record<string, unknown>) {
    const ms = clock.now();
    const n = lane.n + 1;
    lane.n = n;
    deliver(lane.subscribers, { ch: lane.channel.name, n, type, at: new Date(ms).toISOString(), data, id: `${lane.ino}:${lane.to}:${n}:${ms}` });
  }

  function laneError(lane: LogLane, code: string) {
    if (lane.error === code) return;
    lane.error = code;
    sendLogSingle(lane, 'error', { code });
  }

  /** The window from its front to HUB_WINDOW_BYTES, whole pieces at a time. */
  function trimWindow(w: LogWindow) {
    if (w.to - w.from <= HUB_WINDOW_BYTES) return;
    let k = 0;
    while (k < w.pieces.length && w.to - w.pieces[k].at > HUB_WINDOW_BYTES) k += 1;
    w.pieces.splice(0, k);
    w.from = w.pieces.length > 0 ? w.pieces[0].at : w.to;
  }

  /** A window replaced by `next` and sent whole as a `snapshot`. */
  function replaceWindow(lane: LogLane, next: LogWindow) {
    lane.window = next;
    trimWindow(next);
    sendLog(lane, 'snapshot', next.from, next.to, next.pieces);
  }

  /** `added` (every piece at or past the window's `to`) joined to the window and sent as one `append` from the old `to`. */
  function extendWindow(lane: LogLane, added: LogPiece[], to: number, phase: string | null, end: LogEnd) {
    const w = lane.window as LogWindow;
    const from = w.to;
    w.pieces.push(...added);
    w.to = Math.max(w.to, to);
    w.phase = phase;
    w.end = end;
    trimWindow(w);
    sendLog(lane, 'append', from, w.to, added);
  }

  function onLogFrame(lane: LogLane, envelope: CoreEnvelope) {
    if (!laneAlive(lane) || logSupport !== 'supported') return;
    const data = envelope.data;
    if (envelope.type === 'snapshot') {
      const next = logSnapshotOf(data);
      if (next === null) return laneError(lane, 'core-contract-mismatch');
      const w = lane.window;
      // A restarted child's snapshot of the same file reaching the window's end: only the bytes past it are new.
      const merges = w !== null && w.log === 'open' && next.log === 'open' && w.ino === next.ino && next.from <= w.to && next.to >= w.to && !straddles(next.pieces, w.to, next.to);
      if (!merges) return replaceWindow(lane, next);
      return extendWindow(lane, next.pieces.filter((piece) => piece.at >= (w as LogWindow).to), next.to, next.phase, next.end);
    }
    if (envelope.type === 'append') {
      const next = logAppendOf(data);
      const w = lane.window;
      // The window starts from a snapshot: an append with none before it breaks the contract.
      if (next === null || w === null) return laneError(lane, 'core-contract-mismatch');
      if (next.from > w.to || straddles(next.pieces, w.to, next.to)) {
        // Bytes that do not meet the window at a boundary: the window restarts from this frame.
        return replaceWindow(lane, { log: w.log, ino: w.ino, from: next.from, to: next.to, pieces: next.pieces, phase: next.phase, end: next.end });
      }
      const added = next.pieces.filter((piece) => piece.at >= w.to);
      const unchanged = next.to <= w.to && added.length === 0 && next.phase === w.phase && deepEqual(next.end, w.end);
      if (unchanged && lane.error === null) return;
      return extendWindow(lane, added, next.to, next.phase, next.end);
    }
    if (envelope.type === 'reset') {
      if (!RESET_REASONS.includes(data.reason)) return laneError(lane, 'core-contract-mismatch');
      lane.window = null;
      lane.error = null;
      return sendLogSingle(lane, 'reset', { reason: data.reason });
    }
    if (envelope.type === 'error') return laneError(lane, typeof data.code === 'string' && CORE_ERROR_CODES.includes(data.code) ? data.code : 'core-contract-mismatch');
    if (envelope.type === 'gone') {
      sendLogSingle(lane, 'gone', {});
      lane.gone = true;
      lane.window = null;
      if (lane.startTimer !== null) clock.clearTimeout(lane.startTimer);
      lane.startTimer = null;
      return recomputeNeed();
    }
    // `patch` never reaches a log channel (IC-007).
    laneError(lane, 'core-contract-mismatch');
  }

  /**
   * IC-013: while log support is `unknown`, one `worker-log` tail read of `lane`'s run and stream
   * through the pool. A core answer (exit 0, or a JSON error id) is `supported`, and the log channels
   * join the need set; the old-core result is `unsupported`, and every log channel gets `error`
   * `core-lacks-verb`; any other failure leaves `unknown` for the next subscribe to try again.
   */
  function probeLogSupport(lane: LogLane) {
    if (logSupport !== 'unknown' || probing || stopped) return;
    probing = true;
    let call: Promise<any>;
    try {
      call = Promise.resolve(runner.run('worker-log', { runId: lane.channel.runId, stream: lane.channel.stream }));
    } catch {
      call = Promise.resolve(null);
    }
    call.then((answer) => answer, () => null).then((answer: any) => {
      probing = false;
      if (stopped || logSupport !== 'unknown' || !isPlainObject(answer)) return;
      if (answer.ok === true || (answer.ok === false && typeof answer.errorId === 'string')) {
        logSupport = 'supported';
        recomputeNeed();
      } else if (answer.ok === false && answer.reason === 'old-core') {
        logSupport = 'unsupported';
        for (const each of logs.values()) if (laneAlive(each)) laneError(each, 'core-lacks-verb');
      }
    });
  }

  function subscribeLog(channel: LogChannel, listener: Listener): () => void {
    const name = channel.name;
    let lane = logs.get(name);
    if (lane === undefined) {
      const made: LogLane = { channel, subscribers: new Set(), n: lastN.get(name) ?? 0, window: null, error: null, gone: false, ino: '0', to: 0, startTimer: null };
      logs.set(name, made);
      recomputeNeed();
      // As a composed channel's first flush: a channel made while support is `unsupported` or the child is down learns so, never synchronously.
      made.startTimer = clock.setTimeout(() => {
        made.startTimer = null;
        if (!laneAlive(made)) return;
        if (logSupport === 'unsupported') laneError(made, 'core-lacks-verb');
        else if (supervisor.state === 'down') laneError(made, 'events-down');
        else if (supervisor.state === 'unsupported') laneError(made, 'live-unavailable');
      }, 0);
      lane = made;
    }
    probeLogSupport(lane);
    const owner = lane;
    const subscriber = { listener };
    owner.subscribers.add(subscriber);
    return () => {
      if (!owner.subscribers.delete(subscriber) || owner.subscribers.size > 0 || logs.get(name) !== owner) return;
      if (owner.startTimer !== null) clock.clearTimeout(owner.startTimer);
      owner.startTimer = null;
      lastN.set(name, owner.n);
      logs.delete(name);
      recomputeNeed();
    };
  }

  function onCoreFrame(envelope: CoreEnvelope) {
    if (stopped) return;
    const lane = logs.get(envelope.ch);
    if (lane !== undefined) return onLogFrame(lane, envelope);
    const name = envelope.ch;
    const entry = core.get(name);
    if (entry === undefined) return;
    const data = envelope.data;
    if (envelope.type === 'snapshot' || envelope.type === 'patch') {
      if (!validSections(envelope.type, data)) {
        entry.error = 'core-contract-mismatch';
        for (const ch of dependents(name)) if (ch.error !== entry.error) emitError(ch, entry.error);
        return;
      }
      if (envelope.type === 'snapshot') {
        entry.sections = new Map();
        entry.snapshotSeen = true;
        entry.error = null;
      }
      for (const [section, result] of Object.entries(data.sections)) entry.sections.set(section, result as SectionResult);
      if (Array.isArray(data.removed)) for (const section of data.removed) entry.sections.delete(section);
      entry.complete = entry.snapshotSeen && data.more !== true;
      if (entry.complete && entry.error === null) for (const ch of dependents(name)) mark(ch);
      return;
    }
    if (envelope.type === 'reset') {
      core.set(name, freshEntry());
      for (const ch of dependents(name)) emitReset(ch, 'core-reset');
      return;
    }
    if (envelope.type === 'error') {
      const code = typeof data.code === 'string' && CORE_ERROR_CODES.includes(data.code) ? data.code : 'core-contract-mismatch';
      entry.error = code;
      for (const ch of dependents(name)) if (ch.error !== code) emitError(ch, code);
      return;
    }
    if (envelope.type === 'gone') {
      // The core no longer follows `name`. A browser channel resting on it as its own channel is gone;
      // one that read it on the side reads it again, which subscribes it afresh.
      const affected = dependents(name);
      core.delete(name);
      for (const ch of affected) {
        if (ch.channel.name === name) {
          emit(ch, 'gone', {});
          ch.gone = true;
          ch.deps = new Set();
          clearPending(ch);
          if (ch.markTimer !== null) clock.clearTimeout(ch.markTimer);
          ch.markTimer = null;
        } else {
          ch.deps.delete(name);
          mark(ch);
        }
      }
      recomputeNeed();
    }
    // `append` belongs to log channels (150 IC-007), which onLogFrame took above; on a composed channel it is dropped.
  }

  function onDown(code: 'events-down' | 'live-unavailable') {
    if (stopped) return;
    // The restarted child sends every channel a fresh snapshot; until then nothing is composed from the old ones.
    for (const name of core.keys()) core.set(name, freshEntry());
    for (const ch of channels.values()) if (alive(ch) && ch.error !== code) emitError(ch, code);
    // A log channel keeps its window: the restarted child's snapshot merges into it. An unsupported one gets nothing but core-lacks-verb.
    if (logSupport !== 'unsupported') for (const lane of logs.values()) if (laneAlive(lane)) laneError(lane, code);
    if (code === 'live-unavailable') {
      for (const listener of unsupportedListeners) {
        try {
          listener();
        } catch {
          // As in emit.
        }
      }
    }
  }

  supervisor.onFrame(onCoreFrame);
  supervisor.onDown(onDown);

  function drop(ch: Browser) {
    if (ch.markTimer !== null) clock.clearTimeout(ch.markTimer);
    ch.markTimer = null;
    clearPending(ch);
    lastN.set(ch.channel.name, ch.n);
    channels.delete(ch.channel.name);
    recomputeNeed();
  }

  function subscribe(name: string, listener: Listener): () => void {
    const parsed = parseChannel(name);
    if (parsed === null) throw new TypeError(`'${String(name).slice(0, 80)}' is not a live channel`);
    if (typeof listener !== 'function') throw new TypeError('a live subscriber needs a listener');
    if (parsed.kind === 'log') return subscribeLog(parsed, listener);
    const channel: Channel = parsed;
    let ch = channels.get(name);
    if (ch === undefined) {
      ch = {
        channel, subscribers: new Set(), n: lastN.get(name) ?? 0, state: null, error: null, owesSnapshot: true, cappedText: null, gone: false,
        deps: new Set(initialDeps(channel)), markTimer: null, composing: false, again: false, interrupts: 0,
        pending: false, pendingTimer: null, pendingReported: false,
      };
      channels.set(name, ch);
      recomputeNeed();
      mark(ch);
    }
    const owner = ch;
    const subscriber = { listener };
    owner.subscribers.add(subscriber);
    return () => {
      if (!owner.subscribers.delete(subscriber)) return;
      if (owner.subscribers.size === 0 && channels.get(name) === owner) drop(owner);
    };
  }

  function current(name: string): { n: number; state: State | null; error: string | null; gone: boolean } | { n: number; window: LogWindow | null; error: string | null; gone: boolean } | null {
    const lane = logs.get(name);
    if (lane !== undefined) {
      const w = lane.window;
      const window = w === null ? null : { ...w, pieces: w.pieces.map((piece) => ({ ...piece })), end: w.end === null ? null : { ...w.end } };
      return { n: lane.n, window, error: lane.error, gone: lane.gone };
    }
    const ch = channels.get(name);
    if (ch === undefined) return null;
    return { n: ch.n, state: ch.owesSnapshot ? null : ch.state, error: ch.error, gone: ch.gone };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const ch of channels.values()) {
      if (ch.markTimer !== null) clock.clearTimeout(ch.markTimer);
      if (ch.pendingTimer !== null) clock.clearTimeout(ch.pendingTimer);
    }
    for (const lane of logs.values()) if (lane.startTimer !== null) clock.clearTimeout(lane.startTimer);
    channels.clear();
    logs.clear();
    core.clear();
    supervisor.stop();
  }

  return {
    get epoch(): string {
      return epoch;
    },
    subscribe,
    current,
    get unsupported(): boolean {
      return supervisor.state === 'unsupported';
    },
    onUnsupported(listener: () => void) {
      unsupportedListeners.push(listener);
    },
    stop,
  };
}

module.exports = {
  CORE_ERROR_CODES,
  DEBOUNCE_MS,
  HUB_WINDOW_BYTES,
  LIVE_FRAME_BUDGET,
  MAX_POINTER_DEPTH,
  PENDING_TIMEOUT_MS,
  createLiveHub,
  diffState,
  envelopeText,
  isChannel,
  parseChannel,
  resultOf,
};
