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
// API, for the /api/live route (B.5):
//
//   createLiveHub({ runner, supervisor, clock? }) -> {
//     readonly epoch: string;                  // 8 lowercase hex, minted here
//     subscribe(channel, listener): () => void; // IC-003 channel (throws TypeError otherwise); returns unsubscribe
//     current(channel): { n, state, error, gone } | null;
//     readonly unsupported: boolean;          // supervisor.state === 'unsupported'
//     onUnsupported(listener): void;
//     stop(): void;                           // ends timers and calls supervisor.stop()
//   }
//   listener(frame: { ch, n, type, at, data })  // type: snapshot | patch | reset | error | gone
//
// `subscribe` on a new channel creates it and schedules its first composition; it never calls a
// listener synchronously. On an existing channel it sends nothing: the caller decides from
// `current`, whose `state` is null while the hub owes the channel a snapshot (not composed yet, or
// after a reset), `error` is the code of the channel's last error frame while it lasts, and `gone`
// says the channel's own core channel was pruned (the hub sends nothing more on it). `n` is the
// counter of the channel's last frame (0 before any). `envelopeText(epoch, frame)` is the IC-002
// envelope the frame cap is measured on.

const crypto = require('node:crypto');
const { project } = require('./project.ts');
const { PARAM_PATTERN } = require('./verb-runner.ts');

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
type Member = { status: number; body: unknown };
type State = Record<string, Member>;
type FrameType = 'snapshot' | 'patch' | 'reset' | 'error' | 'gone';
type Frame = { ch: string; n: number; type: FrameType; at: string; data: Record<string, unknown> };
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

/** IC-003: the core's ID_PATTERN (src/runtime/context/identity.ts, at most 56 characters) with the dot the Console's PARAM_PATTERN allows. */
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
/** src/runtime/worker/run-store.ts RUN_ID. */
const RUN_ID = /^w-[0-9a-f]{12}$/;

/** The IC-003 channel `text` names, or null for every other form. */
function parseChannel(text: unknown): Channel | null {
  if (typeof text !== 'string') return null;
  const parts = text.split(':');
  if (text === 'now') return { kind: 'now', name: text };
  if (parts[0] === 'run' && parts.length === 3 && CHANNEL_ID.test(parts[1]) && CHANNEL_ID.test(parts[2])) return { kind: 'run', name: text, slug: parts[1], taskId: parts[2] };
  if (parts[0] === 'tasks' && parts.length === 2 && CHANNEL_ID.test(parts[1])) return { kind: 'tasks', name: text, slug: parts[1] };
  if (parts[0] === 'worker' && parts.length === 2 && RUN_ID.test(parts[1])) return { kind: 'worker', name: text, runId: parts[1] };
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

/** The IC-002 envelope of a browser frame, as sent; the frame cap is measured on its UTF-8 bytes. */
function envelopeText(epoch: string, frame: Frame): string {
  return JSON.stringify({ v: 1, ch: frame.ch, id: `${epoch}-${frame.n}`, type: frame.type, at: frame.at, data: frame.data });
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

/** IC-010: the core channel and section a shape is answered from, 'runner' for the real runner, or null (usage). */
function targetOf(shapeId: string, params: Record<string, any>): { channel: string; section: string } | 'runner' | null {
  if (RUNNER_SHAPES.includes(shapeId)) return 'runner';
  if (NOW_SHAPES.includes(shapeId)) return hasParams(params, []) ? { channel: 'now', section: shapeId } : null;
  if (shapeId === 'status' || shapeId === 'timeline') {
    return hasParams(params, ['slug', 'taskId']) && isChannel(`run:${params.slug}:${params.taskId}`) ? { channel: `run:${params.slug}:${params.taskId}`, section: shapeId } : null;
  }
  if (shapeId === 'attempts') return hasParams(params, ['slug']) && isChannel(`tasks:${params.slug}`) ? { channel: `tasks:${params.slug}`, section: 'attempts' } : null;
  if (shapeId === 'worker-status') {
    const fits = hasParams(params, ['slug', 'task', 'token']) && isChannel(`tasks:${params.slug}`) && PARAM_PATTERN.test(params.task) && PARAM_PATTERN.test(params.token);
    return fits ? { channel: `tasks:${params.slug}`, section: `worker:${params.task}:${params.token}` } : null;
  }
  return null;
}

/** One composition's reads: every core channel touched, and whether one was missing (pending) or in error (blocked). */
type Composition = { reads: Set<string>; missing: boolean; blocked: boolean; closed: boolean; abort: () => void };

/** IC-012: the members of a browser channel, from the route composers over `runner`. */
async function composeState(channel: Channel, runner: Runner, readSection: (core: string, name: string) => Promise<SectionResult>): Promise<State> {
  const r = routes();
  if (channel.kind === 'now') {
    const [list, sessions] = await Promise.all([r.runs(runner), r.sessionsView(runner)]);
    return { runs: memberOf(list), sessions: memberOf(sessions) };
  }
  if (channel.kind === 'run') return { run: memberOf(await r.runDetail(runner, channel.slug, channel.taskId)) };
  if (channel.kind === 'tasks') {
    const graph = await r.tasks(runner, channel.slug);
    if (!graph.ok) return { tasks: memberOf(graph.reply) };
    // As runDetail puts `tasks()` into the run body.
    const body: Record<string, unknown> = { tasks: graph.tasks };
    if (graph.tasks === null) body.tasksReason = graph.reason;
    return { tasks: { status: 200, body } };
  }
  const result = resultOf(await readSection(channel.name, 'status'));
  // failureReply of routes.ts for the only code a section maps to (`core-error`): 502 with the exit.
  if (!result.ok) return { worker: memberOf(r.errorReply(502, 'core-error', 'worker-status', result.exit)) };
  const projected = project('worker-status', result.json);
  if (!projected.ok) return { worker: memberOf(r.errorReply(502, 'core-contract-mismatch', 'worker-status', 0)) };
  return { worker: { status: 200, body: projected.body } };
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
  const unsupportedListeners: Array<() => void> = [];
  let needed = new Set<string>();
  let stopped = false;

  const alive = (ch: Browser): boolean => !stopped && !ch.gone && channels.get(ch.channel.name) === ch;
  const freshEntry = (): CoreEntry => ({ sections: new Map(), snapshotSeen: false, complete: false, error: null });

  /** The union of every live browser channel's dependencies, sent to the supervisor when it changed; core entries follow it. */
  function recomputeNeed() {
    const next = new Set<string>();
    for (const ch of channels.values()) if (!ch.gone) for (const dep of ch.deps) next.add(dep);
    for (const name of [...core.keys()]) if (!next.has(name)) core.delete(name);
    for (const name of next) if (!core.has(name)) core.set(name, freshEntry());
    if (next.size === needed.size && [...next].every((name) => needed.has(name))) return;
    needed = next;
    if (!stopped) supervisor.need(new Set(next));
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
    for (const subscriber of [...ch.subscribers]) {
      try {
        subscriber.listener(frame);
      } catch {
        // A listener's fault is its own; the hub and the other subscribers carry on.
      }
    }
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
    const readSection = (name: string, section: string): Promise<SectionResult> => {
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
        ctx.missing = true;
        ctx.abort();
        // A fresh promise that never settles: the composer waits on it and is then dropped with it.
        return new Promise(() => {});
      }
      return Promise.resolve(found);
    };
    const hubRunner: Runner = {
      run(shapeId: string, params?: Record<string, string>) {
        const target = targetOf(shapeId, params ?? {});
        if (target === 'runner') return runner.run(shapeId, params);
        if (target === null) return Promise.resolve({ ok: false, code: 'usage', exit: null });
        return readSection(target.channel, target.section).then(resultOf);
      },
    };
    const done = composeState(ch.channel, hubRunner, readSection).then(
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

  function onCoreFrame(envelope: CoreEnvelope) {
    if (stopped) return;
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
    // `append` is reserved for P2 log channels (IC-002) and never reaches a P1 channel.
  }

  function onDown(code: 'events-down' | 'live-unavailable') {
    if (stopped) return;
    // The restarted child sends every channel a fresh snapshot; until then nothing is composed from the old ones.
    for (const name of core.keys()) core.set(name, freshEntry());
    for (const ch of channels.values()) if (alive(ch) && ch.error !== code) emitError(ch, code);
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
    channels.delete(ch.channel.name);
    recomputeNeed();
  }

  function subscribe(name: string, listener: Listener): () => void {
    const channel = parseChannel(name);
    if (channel === null) throw new TypeError(`'${String(name).slice(0, 80)}' is not a live channel`);
    if (typeof listener !== 'function') throw new TypeError('a live subscriber needs a listener');
    let ch = channels.get(name);
    if (ch === undefined) {
      ch = {
        channel, subscribers: new Set(), n: 0, state: null, error: null, owesSnapshot: true, cappedText: null, gone: false,
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

  function current(name: string): { n: number; state: State | null; error: string | null; gone: boolean } | null {
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
    channels.clear();
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
