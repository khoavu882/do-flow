'use strict';

// Events supervisor (feature 149, IC-009 as amended by DEC-054): the one `events --follow --control
// stdin` child of the Console, started through the verb runner's follow path (IC-008) only while the
// hub needs at least one core channel (DEC-017). `need` sends IC-005 `sub` and `unsub` lines for the
// difference; an empty set ends the child at once (DEC-023). An old core, whose reply names an unknown
// flag, command or verb on stderr before any stdout line and without an `[ERROR]` line, makes the
// supervisor `unsupported` for its lifetime (`live-unavailable`, never restarted; DEC-054, DEC-013).
// Any other exit while channels are needed is `down` (`events-down` at once) and restarts after 1 s,
// 2 s, 5 s, then every 30 s; the step returns to 1 s once a child has run for 60 s (DEC-023). A stdout
// line that is not an IC-002 envelope ends the child, and that exit takes the restart path.
//
// Memory: each line is handled synchronously in the runner's line callback and handed to the frame
// listeners; nothing here pauses, queues or buffers stdout. The line itself is bounded by the
// runner's 256 KiB line cap.

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}
/** The exit record of a follow child (console/src/verb-runner.ts FollowExit). */
type FollowExit = {
  code: number | null;
  signal: string | null;
  lines: number;
  sawError: boolean;
  sawUnknown: boolean;
  reason: 'exit' | 'line-cap' | 'stopped' | 'spawn-failed';
};
/** The follow handle of console/src/verb-runner.ts (IC-008). */
interface FollowHandle {
  send(message: { op: 'sub' | 'unsub'; ch: string }): boolean;
  onLine(listener: (line: string) => void): void;
  readonly exited: Promise<FollowExit>;
  end(): void;
}
interface FollowRunner {
  follow(shapeId: string): FollowHandle | null;
}
type FrameType = 'snapshot' | 'patch' | 'append' | 'reset' | 'error' | 'gone';
/** IC-002: one core NDJSON envelope. */
type CoreEnvelope = { v: 1; ch: string; id: string; type: FrameType; at: string; data: Record<string, unknown> };
type State = 'stopped' | 'running' | 'down' | 'unsupported';
type DownCode = 'events-down' | 'live-unavailable';
/** One started child: its handle, the channels it was sent a `sub` for, when it started, and whether a protocol fault ended it. */
type Child = { handle: FollowHandle; subscribed: Set<string>; startedAt: number; faulted: boolean };

/** DEC-023: the delay before each restart; the last one repeats. */
const RESTART_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000, 30_000]);
/** DEC-023: a child that ran this long puts the step back to the first delay. */
const STEP_RESET_MS = 60_000;

const ENVELOPE_KEYS: readonly string[] = Object.freeze(['at', 'ch', 'data', 'id', 'type', 'v']);
const ENVELOPE_ID = /^[0-9a-f]{8}-[1-9][0-9]{0,15}$/;
/** 150 IC-007: a log frame's id, `<ino>:<offset>:<n>:<ms>` (src/runtime/events/envelope.ts LOG_ID). */
const LOG_ID = /^[0-9]{1,20}:[0-9]{1,16}:[1-9][0-9]{0,15}:[0-9]{1,16}$/;
/** 150 IC-006: a log channel, `worker:<runId>:out` or `:err`. */
const LOG_CHANNEL = /^worker:w-[0-9a-f]{12}:(?:out|err)$/;
const FRAME_TYPES: readonly string[] = Object.freeze(['snapshot', 'patch', 'append', 'reset', 'error', 'gone']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/**
 * IC-002: exactly the six fields, `v` 1, a non-empty `ch`, an `<epoch>-<n>` id (an IC-007
 * `<ino>:<offset>:<n>:<ms>` id on a log channel, and only there), a known type, a string `at` and an
 * object `data`.
 */
function isCoreEnvelope(value: unknown): value is CoreEnvelope {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== ENVELOPE_KEYS.length || !keys.every((key, i) => key === ENVELOPE_KEYS[i])) return false;
  return (
    value.v === 1 &&
    typeof value.ch === 'string' &&
    value.ch !== '' &&
    typeof value.id === 'string' &&
    (LOG_CHANNEL.test(value.ch) ? LOG_ID : ENVELOPE_ID).test(value.id) &&
    typeof value.type === 'string' &&
    FRAME_TYPES.includes(value.type) &&
    typeof value.at === 'string' &&
    isPlainObject(value.data)
  );
}

/** DEC-054: an old core's reply (exit 1 from the core's parser, exit 2 from the projected dispatcher), told apart from an internal fault by the stderr markers. */
const isOldCore = (exit: FollowExit): boolean =>
  exit.reason === 'exit' && (exit.code === 1 || exit.code === 2) && exit.lines === 0 && !exit.sawError && exit.sawUnknown;

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function createLiveChild(options: { runner: FollowRunner; clock?: Clock }) {
  const { runner, clock = realClock } = options;
  const frameListeners: Array<(envelope: CoreEnvelope) => void> = [];
  const downListeners: Array<(code: DownCode) => void> = [];
  let state: State = 'stopped';
  let wanted = new Set<string>();
  /** The child serving `wanted`, or null while none is (stopped, down, or a start waiting on `retiring`). */
  let current: Child | null = null;
  /** A child ended because the set became empty, until it has exited: the runner allows one follow child at a time. */
  let retiring: Child | null = null;
  /** `running` was entered while `retiring` was still alive; the start happens when it exits. */
  let startWaiting = false;
  let restartTimer: any = null;
  let step = 0;
  let shutdown = false;

  function emitDown(code: DownCode) {
    for (const listener of downListeners) {
      try {
        listener(code);
      } catch {
        // A listener's fault is its own; the supervisor and the other listeners carry on.
      }
    }
  }

  function emitFrame(envelope: CoreEnvelope) {
    for (const listener of frameListeners) {
      try {
        listener(envelope);
      } catch {
        // As in emitDown.
      }
    }
  }

  function subscribe(child: Child, channel: string) {
    if (child.handle.send({ op: 'sub', ch: channel })) child.subscribed.add(channel);
  }

  /** `down`, `events-down` now, and a restart after the current step's delay. */
  function goDown() {
    state = 'down';
    const delay = RESTART_DELAYS_MS[Math.min(step, RESTART_DELAYS_MS.length - 1)];
    step += 1;
    restartTimer = clock.setTimeout(() => {
      restartTimer = null;
      if (state === 'down' && !shutdown) start();
    }, delay);
    emitDown('events-down');
  }

  function start() {
    state = 'running';
    if (retiring !== null) {
      startWaiting = true;
      return;
    }
    const handle = runner.follow('events');
    if (handle === null) {
      current = null;
      goDown();
      return;
    }
    const child: Child = { handle, subscribed: new Set(), startedAt: clock.now(), faulted: false };
    current = child;
    handle.onLine((line) => onLine(child, line));
    handle.exited.then((exit) => onExit(child, exit));
    for (const channel of wanted) subscribe(child, channel);
  }

  function onLine(child: Child, line: string) {
    if (child !== current || child.faulted || shutdown) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (isCoreEnvelope(value)) {
      emitFrame(value);
      return;
    }
    child.faulted = true;
    child.handle.end();
  }

  function onExit(child: Child, exit: FollowExit) {
    if (child === retiring) {
      retiring = null;
      if (startWaiting && !shutdown) {
        startWaiting = false;
        start();
      }
      return;
    }
    if (child !== current || shutdown) return;
    current = null;
    if (isOldCore(exit)) {
      state = 'unsupported';
      emitDown('live-unavailable');
      return;
    }
    if (clock.now() - child.startedAt >= STEP_RESET_MS) step = 0;
    goDown();
  }

  function need(channels: ReadonlySet<string>) {
    if (shutdown || state === 'unsupported') return;
    const next = new Set<string>();
    for (const channel of channels) if (typeof channel === 'string' && channel !== '') next.add(channel);
    wanted = next;
    if (next.size === 0) {
      if (restartTimer !== null) clock.clearTimeout(restartTimer);
      restartTimer = null;
      startWaiting = false;
      if (current !== null) {
        retiring = current;
        current = null;
        retiring.handle.end();
      }
      state = 'stopped';
      return;
    }
    if (state === 'stopped') return start();
    if (state !== 'running' || current === null) return;
    const child = current;
    for (const channel of [...child.subscribed]) {
      if (!next.has(channel) && child.handle.send({ op: 'unsub', ch: channel })) child.subscribed.delete(channel);
    }
    for (const channel of next) if (!child.subscribed.has(channel)) subscribe(child, channel);
  }

  function stop() {
    shutdown = true;
    if (restartTimer !== null) clock.clearTimeout(restartTimer);
    restartTimer = null;
    startWaiting = false;
    current?.handle.end();
    current = null;
    state = 'stopped';
  }

  return {
    need,
    get state(): State {
      return state;
    },
    onFrame(listener: (envelope: CoreEnvelope) => void) {
      frameListeners.push(listener);
    },
    onDown(listener: (code: DownCode) => void) {
      downListeners.push(listener);
    },
    stop,
  };
}

module.exports = { RESTART_DELAYS_MS, STEP_RESET_MS, createLiveChild, isCoreEnvelope };
