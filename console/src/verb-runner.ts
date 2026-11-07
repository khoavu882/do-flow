'use strict';

// Console verb runner (feature 093, IC-003 over 092 IC-009; FR-002): the only path from the Console
// to the core. A frozen allow-list of complete argv shapes, parameters checked before they reach
// argv, the core spawned as `process.execPath <core> ...argv --json` with `shell: false`, cwd the
// project, and an environment with every DOFLOW_* and identity variable removed. Pool of 2, 10 s
// timeout, single-flight per argv, per-shape cache, 30 s backoff after an `[ERROR]` exit 1, 4 MiB
// stdout cap. The child's stderr is read only for the `[ERROR]` marker: never returned or logged.
//
// Follow path (feature 149, IC-008): one long-lived `events --follow --control stdin --json` child at
// a time, outside the pool, with the same launch options plus piped stdin, no timeout or output cap,
// a 256 KiB line cap, and stderr read only for the `[ERROR]` and unknown-verb markers. stop() ends it.
//
// V8 Fleet shapes (IC-024): `tree`, `transcript` and `traffic` run in another project's root. The
// runner keeps a `projectKey -> root` map filled from the raw output of its last `projects` read, so a
// caller (and so the browser) holds only the key; an unknown key is `project-not-found` before any
// spawn. The single-flight, cache and backoff key is `(projectKey, argv)`. `transcript` is never cached
// and may use a third slot that no other shape can take.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** `pattern` names an entry of PATTERNS (default `id`); `flag` makes the parameter its own `--flag value` pair, omitted when `optional` and absent. */
type Param = { param: string; pattern?: keyof typeof PATTERNS; flag?: string; optional?: true };
interface Shape {
  readonly argv: readonly (string | Param)[];
  /** Cache lifetime in ms; Infinity is the process lifetime; 0 is never cached. */
  readonly ttl: number;
  /** IC-024: runs with `cwd` = the root of the project named by the `projectKey` parameter, which is not part of argv. */
  readonly scoped?: true;
  /** IC-024: may use the slot reserved beyond the pool of POOL_SIZE. */
  readonly reserved?: true;
  /** `projects`: its raw output fills the key-to-root map. */
  readonly listsProjects?: true;
  /** `workflow`: the cache entry is keyed by the core version as well. */
  readonly byCoreVersion?: true;
  /** `version`: the core prints a plain line, not JSON. */
  readonly text?: true;
}
/** `errorId`: the core's own JSON `error` id from a failed call's stdout (see errorIdOf); nothing else of that stdout. */
type Failure = { ok: false; code: 'usage' | 'core-error' | 'core-unreachable' | 'project-not-found'; exit: number | null; reason?: string; errorId?: string };
type Result = { ok: true; json: any; exit: number } | Failure;
interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}
interface RunnerOptions {
  corePath: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  spawnImpl?: (command: string, args: string[], options: any) => any;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const TASK_ID: Param = { param: 'taskId' };
const SLUG: Param = { param: 'slug' };
const TASK_CLASS: Param = { param: 'taskClass' };
const TASK: Param = { param: 'task' };
const TOKEN: Param = { param: 'token' };
const PROJECT: Param = { param: 'projectKey', pattern: 'key16' };
const AGENT: Param = { param: 'agent', pattern: 'key16' };
const CURSOR: Param = { param: 'cursor', pattern: 'cursor', flag: '--cursor', optional: true };
const LIMIT: Param = { param: 'limit', pattern: 'limit' };

/** IC-003, the whole allow-list. `--json` is appended to every shape. */
const SHAPES: Readonly<Record<string, Shape>> = deepFreeze({
  list: { argv: ['orchestrate', '--action', 'list'], ttl: 2_000 },
  status: { argv: ['orchestrate', '--action', 'status', '--task-id', TASK_ID, '--slug', SLUG], ttl: 2_000 },
  timeline: { argv: ['orchestrate', '--action', 'timeline', '--task-id', TASK_ID, '--slug', SLUG], ttl: 2_000 },
  attempts: { argv: ['task-attempt', '--action', 'inspect', '--slug', SLUG], ttl: 2_000 },
  workflow: { argv: ['workflow', '--task-class', TASK_CLASS], ttl: Infinity, byCoreVersion: true },
  capabilities: { argv: ['capabilities'], ttl: 30_000 },
  version: { argv: ['--version'], ttl: Infinity, text: true },
  // IC-018: the Sessions reads. `slot --action list`, `slot --action release` and `worker --action cancel` are not shapes.
  observed: { argv: ['primary', '--action', 'observed'], ttl: 5_000 },
  slots: { argv: ['slot', '--action', 'peek'], ttl: 5_000 },
  'worker-status': { argv: ['worker', '--action', 'status', '--slug', SLUG, '--task', TASK, '--token', TOKEN], ttl: 5_000 },
  roadmap: { argv: ['roadmap', '--action', 'status'], ttl: 10_000 },
  // IC-024: the Fleet reads. `tree` and `traffic` take only the project; `transcript` is never cached and has the reserved slot.
  projects: { argv: ['fleet', '--action', 'projects'], ttl: 10_000, listsProjects: true },
  tree: { argv: ['fleet', '--action', 'tree'], ttl: 5_000, scoped: true },
  transcript: { argv: ['transcript', '--action', 'read', '--agent', AGENT, CURSOR, '--limit', LIMIT], ttl: 0, scoped: true, reserved: true },
  traffic: { argv: ['transcript', '--action', 'stats', '--window', '10'], ttl: 5_000, scoped: true },
});
const SHAPE_IDS: readonly string[] = Object.freeze(Object.keys(SHAPES));

/**
 * IC-008: the one long-lived child, outside the pool (DEC-022). `--json` is appended. Sub and unsub
 * reach it as IC-005 lines on stdin, and stdin EOF ends it (DEC-021).
 */
interface FollowShape {
  readonly argv: readonly string[];
}
const FOLLOW_SHAPES: Readonly<Record<string, FollowShape>> = deepFreeze({
  events: { argv: ['events', '--follow', '--control', 'stdin'] },
});
const FOLLOW_SHAPE_IDS: readonly string[] = Object.freeze(Object.keys(FOLLOW_SHAPES));
/** A follow stdout line longer than this before its newline kills the child; the partial-line buffer never holds more. */
const FOLLOW_LINE_CAP_BYTES = 262_144;
/** The partial stderr line kept for the marker scan of a follow child. */
const FOLLOW_STDERR_LINE_BYTES = 4_096;
/** DEC-054: an old core's reply to `events --follow` names an unknown flag, command or verb on stderr. */
const UNKNOWN_MARKER = /\bunknown (flag|command|verb)\b/;

type FollowExit = {
  code: number | null;
  signal: string | null;
  lines: number;
  sawError: boolean;
  sawUnknown: boolean;
  reason: 'exit' | 'line-cap' | 'stopped' | 'spawn-failed';
};
interface FollowHandle {
  /** One IC-005 line; false once stdin is closed or for a message that is not `{op: 'sub' | 'unsub', ch: <string>}`. */
  send(message: { op: 'sub' | 'unsub'; ch: string }): boolean;
  /** One complete stdout line, newline removed. */
  onLine(listener: (line: string) => void): void;
  readonly exited: Promise<FollowExit>;
  /** stdin end, SIGTERM, SIGKILL after KILL_GRACE_MS (DEC-023). */
  end(): void;
}

/** The core's ID_PATTERN without its length bound (IC-003): no leading `-`, `.`, no `/`. */
const PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** IC-024: a project or agent key, a transcript cursor, and `--limit` (1..500, IC-022). */
const PATTERNS = Object.freeze({
  id: PARAM_PATTERN,
  key16: /^[0-9a-f]{16}$/,
  cursor: /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/,
  limit: /^[1-9][0-9]{0,2}$/,
});
const LIMIT_MAX = 500;
const acceptable = (pattern: keyof typeof PATTERNS, value: string): boolean =>
  PATTERNS[pattern].test(value) && (pattern !== 'limit' || Number(value) <= LIMIT_MAX);

/**
 * Every variable src/runtime/context/identity.ts reads. All are DOFLOW_* today, so the prefix rule
 * already strips them; the list stays explicit so a non-prefixed name identity.ts gains is caught by
 * verb-runner.test.ts and stripped here.
 */
const IDENTITY_VARIABLES: readonly string[] = Object.freeze([
  'DOFLOW_RUN_ID',
  'DOFLOW_ATTEMPT',
  'DOFLOW_LINEAGE_ID',
  'DOFLOW_SESSION_ROLE',
  'DOFLOW_WORKTREE',
]);
const PASS_THROUGH: readonly string[] = Object.freeze(['DOFLOW_CONFIG_DIR', 'DOFLOW_TELEMETRY', 'DOFLOW_FAILURE_CAPTURE', 'DOFLOW_RETENTION_HOURS']);

const POOL_SIZE = 2;
/** IC-024: slots beyond the pool that only `transcript` may take. */
const RESERVED_SLOTS = 1;
const TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const BACKOFF_MS = 30_000;
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const ERROR_MARKER = '[ERROR]';

const usage = (): Failure => ({ ok: false, code: 'usage', exit: null });
const unreachable = (): Failure => ({ ok: false, code: 'core-unreachable', exit: null });

/**
 * The argv of a shape with its parameters filled, and the project key of a scoped shape, or null when
 * the call is not on the allow-list.
 */
function buildArgv(shapeId: unknown, params: unknown): { argv: string[]; projectKey: string | null } | null {
  if (typeof shapeId !== 'string' || !Object.hasOwn(SHAPES, shapeId)) return null;
  const given = params ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) return null;
  const shape = SHAPES[shapeId];
  const declared = shape.argv.filter((part): part is Param => typeof part !== 'string');
  if (shape.scoped) declared.push(PROJECT);
  const keys = Object.keys(given);
  if (!keys.every((key) => declared.some((part) => part.param === key))) return null;
  if (!declared.every((part) => part.optional || keys.includes(part.param))) return null;
  const argv: string[] = [];
  for (const part of shape.argv) {
    if (typeof part === 'string') {
      argv.push(part);
      continue;
    }
    const value = (given as Record<string, unknown>)[part.param];
    if (value === undefined && part.optional) continue;
    if (typeof value !== 'string' || !acceptable(part.pattern ?? 'id', value)) return null;
    if (part.flag) argv.push(part.flag);
    argv.push(value);
  }
  argv.push('--json');
  const projectKey = (given as Record<string, unknown>).projectKey;
  if (shape.scoped) {
    if (typeof projectKey !== 'string' || !acceptable(PROJECT.pattern!, projectKey)) return null;
    return { argv, projectKey };
  }
  return { argv, projectKey: null };
}

/** The parent environment minus every DOFLOW_* and identity variable, plus the pass-throughs and DOFLOW_UPKEEP=off. */
function childEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || name.toUpperCase().startsWith('DOFLOW_') || IDENTITY_VARIABLES.includes(name)) continue;
    env[name] = value;
  }
  for (const name of PASS_THROUGH) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env.DOFLOW_UPKEEP = 'off';
  return env;
}

/**
 * The `error` field of a failed call's stdout when that stdout is one JSON object and the field is an
 * id matching PARAM_PATTERN (`plan-unreadable`, `cannot-list-checkouts`, ...), else null. Messages,
 * problems and every other field are never read, so no path or free text leaves the child.
 */
function errorIdOf(chunks: Buffer[]): string | null {
  let value: any;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  const id = value && typeof value === 'object' && !Array.isArray(value) ? value.error : undefined;
  return typeof id === 'string' && PARAM_PATTERN.test(id) ? id : null;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function createVerbRunner(options: RunnerOptions) {
  const { corePath, projectRoot, env = process.env, clock = realClock, spawnImpl = childProcess.spawn } = options;
  const cache = new Map<string, { result: Result; expires: number }>();
  const backoff = new Map<string, { result: Failure; until: number }>();
  const inFlight = new Map<string, Promise<Result>>();
  const queue: Array<{ reserved: boolean; grant: (slot: 'pool' | 'reserved' | null) => void }> = [];
  const running = new Set<any>();
  /** IC-024: projectKey -> root, from the last `projects` read. Never leaves the server. */
  const roots = new Map<string, string>();
  let active = 0;
  let reservedActive = 0;
  let stopped = false;

  /** One spawn of the core. Resolves when the child has closed; never rejects. */
  function spawnCore(shape: Shape, argv: string[], cwd: string, flightKey: string): Promise<Result> {
    return new Promise((resolve) => {
      let child: any;
      try {
        if (!fs.statSync(corePath).isFile()) return resolve(unreachable());
        child = spawnImpl(process.execPath, [corePath, ...argv], {
          cwd,
          env: childEnv(env),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        return resolve(unreachable());
      }
      running.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: string | null = null;
      let spawnFailed = false;
      let errorTail = '';
      let sawError = false;
      let killTimer: any = null;
      const timer = clock.setTimeout(() => {
        failure ??= 'timeout';
        child.kill('SIGTERM');
        killTimer = clock.setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      }, TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        if (failure !== null) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_CAP_BYTES) {
          failure = 'output-cap';
          chunks.length = 0;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      // Only the marker is looked for; a short tail covers a marker split across chunks.
      child.stderr.on('data', (chunk: Buffer) => {
        if (sawError) return;
        const text = errorTail + chunk.toString('latin1');
        sawError = text.includes(ERROR_MARKER);
        errorTail = text.slice(-(ERROR_MARKER.length - 1));
      });
      child.on('error', () => {
        spawnFailed = true;
        // A child that never started may not emit 'close'; one that did start still will.
        if (child.pid === undefined) {
          clock.clearTimeout(timer);
          running.delete(child);
          resolve(unreachable());
        }
      });
      child.on('close', (code: number | null) => {
        clock.clearTimeout(timer);
        if (killTimer !== null) clock.clearTimeout(killTimer);
        running.delete(child);
        if (spawnFailed || failure === 'stopped') return resolve(unreachable());
        if (failure !== null) return resolve({ ok: false, code: 'core-error', exit: null, reason: failure });
        if (code !== 0) {
          const result: Failure = { ok: false, code: 'core-error', exit: code };
          const errorId = errorIdOf(chunks);
          if (errorId !== null) result.errorId = errorId;
          if (code === 1 && sawError) backoff.set(flightKey, { result: { ...result, reason: 'backoff' }, until: clock.now() + BACKOFF_MS });
          return resolve(result);
        }
        const stdout = Buffer.concat(chunks).toString('utf8');
        if (shape.text) {
          const line = stdout.trim();
          return resolve(line === '' || line.includes('\n') ? { ok: false, code: 'core-error', exit: 0, reason: 'not-json' } : { ok: true, json: line, exit: 0 });
        }
        try {
          resolve({ ok: true, json: JSON.parse(stdout), exit: 0 });
        } catch {
          resolve({ ok: false, code: 'core-error', exit: 0, reason: 'not-json' });
        }
      });
      child.markStopped = () => {
        failure = 'stopped';
        child.kill('SIGKILL');
      };
    });
  }

  /**
   * A slot for one spawn: one of the POOL_SIZE pool slots, or, for a `reserved` shape (transcript) when
   * the pool is full, one of the RESERVED_SLOTS that no other shape can take. Null when the runner stopped.
   */
  function take(reserved: boolean): 'pool' | 'reserved' | null {
    if (active < POOL_SIZE) {
      active += 1;
      return 'pool';
    }
    if (reserved && reservedActive < RESERVED_SLOTS) {
      reservedActive += 1;
      return 'reserved';
    }
    return null;
  }

  function acquire(reserved: boolean): Promise<'pool' | 'reserved' | null> {
    if (stopped) return Promise.resolve(null);
    const slot = take(reserved);
    if (slot !== null) return Promise.resolve(slot);
    return new Promise((resolve) => queue.push({ reserved, grant: resolve }));
  }

  function release(slot: 'pool' | 'reserved') {
    if (slot === 'pool') active -= 1;
    else reservedActive -= 1;
    // Waiters in arrival order; one that cannot take a slot yet stays queued without blocking a later one that can.
    for (let i = 0; i < queue.length; ) {
      const granted = stopped ? null : take(queue[i].reserved);
      if (granted === null && !stopped) {
        i += 1;
        continue;
      }
      queue.splice(i, 1)[0].grant(granted);
    }
  }

  async function spawnPooled(shape: Shape, argv: string[], cwd: string, flightKey: string): Promise<Result> {
    const slot = await acquire(shape.reserved === true);
    if (slot === null) return unreachable();
    try {
      return await spawnCore(shape, argv, cwd, flightKey);
    } finally {
      release(slot);
    }
  }

  /** Fills the key-to-root map from the raw output of a `projects` read (IC-024); a body that is not a list leaves it as it was. */
  function rememberProjects(json: any) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.projects)) return;
    roots.clear();
    for (const entry of json.projects) {
      if (entry && typeof entry.projectKey === 'string' && PATTERNS.key16.test(entry.projectKey) && typeof entry.root === 'string' && path.isAbsolute(entry.root)) {
        roots.set(entry.projectKey, entry.root);
      }
    }
  }

  async function run(shapeId: string, params?: Record<string, unknown> | null): Promise<Result> {
    const built = buildArgv(shapeId, params);
    if (built === null) return usage();
    if (stopped) return unreachable();
    const shape = SHAPES[shapeId];
    const { argv, projectKey } = built;
    let cwd = projectRoot;
    if (projectKey !== null) {
      const root = roots.get(projectKey);
      if (root === undefined) return { ok: false, code: 'project-not-found', exit: null };
      cwd = root;
    }
    // IC-024: the key of the cache, the single flight and the backoff is (projectKey, argv).
    const argvKey = projectKey === null ? argv.join('\0') : `${projectKey}\0${argv.join('\0')}`;

    let cacheKey: string | null = argvKey;
    if (shape.byCoreVersion) {
      const version = await run('version', {});
      cacheKey = version.ok ? `${version.json}\0${argvKey}` : null;
    }
    const now = clock.now();
    const cached = cacheKey === null ? undefined : cache.get(cacheKey);
    if (cached && now < cached.expires) return cached.result;
    const held = backoff.get(argvKey);
    if (held && now < held.until) return held.result;

    let flight = inFlight.get(argvKey);
    if (!flight) {
      flight = spawnPooled(shape, argv, cwd, argvKey)
        .then((spawned) => {
          if (spawned.ok && shape.listsProjects) rememberProjects(spawned.json);
          return spawned;
        })
        .finally(() => inFlight.delete(argvKey));
      inFlight.set(argvKey, flight);
    }
    const result = await flight;
    if (result.ok && cacheKey !== null && shape.ttl > 0) cache.set(cacheKey, { result, expires: clock.now() + shape.ttl });
    return result;
  }

  /** The follow child alive now, or null: at most one (DEC-022). */
  let followLive: { stop(): void } | null = null;

  function failedFollow(): FollowHandle {
    const exited = Promise.resolve<FollowExit>({ code: null, signal: null, lines: 0, sawError: false, sawUnknown: false, reason: 'spawn-failed' });
    return { send: () => false, onLine: () => {}, exited, end: () => {} };
  }

  /**
   * IC-008: start the long-lived child of a FOLLOW_SHAPES entry, with the launch options of spawnCore
   * and stdin piped. It takes no pool or reserved slot and has no timeout, output cap, cache, single
   * flight or backoff entry. Null for an unknown shape, a stopped runner or a follow child still alive.
   */
  function follow(shapeId: string): FollowHandle | null {
    if (typeof shapeId !== 'string' || !Object.hasOwn(FOLLOW_SHAPES, shapeId) || stopped || followLive !== null) return null;
    let child: any;
    try {
      if (!fs.statSync(corePath).isFile()) return failedFollow();
      child = spawnImpl(process.execPath, [corePath, ...FOLLOW_SHAPES[shapeId].argv, '--json'], {
        cwd: projectRoot,
        env: childEnv(env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return failedFollow();
    }
    const listeners: Array<(line: string) => void> = [];
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let lines = 0;
    let errorLine = '';
    let sawError = false;
    let sawUnknown = false;
    let forced: 'line-cap' | 'stopped' | null = null;
    let stdinOpen = true;
    let ending = false;
    let settled = false;
    let killTimer: any = null;
    let settle: (exit: FollowExit) => void = () => {};
    const exited = new Promise<FollowExit>((resolve) => {
      settle = resolve;
    });
    const live = { stop: () => force('stopped') };
    followLive = live;

    function finish(code: number | null, signal: string | null, reason: FollowExit['reason']) {
      if (settled) return;
      settled = true;
      stdinOpen = false;
      if (killTimer !== null) clock.clearTimeout(killTimer);
      if (followLive === live) followLive = null;
      settle({ code, signal, lines, sawError, sawUnknown, reason });
    }
    function closeStdin() {
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin.end();
    }
    function force(reason: 'line-cap' | 'stopped') {
      if (settled || forced !== null) return;
      forced = reason;
      pending = [];
      pendingBytes = 0;
      closeStdin();
      child.kill('SIGKILL');
    }

    // A dead child's stdin fails its writes with EPIPE; that is the child's exit, never a Console crash.
    child.stdin.on('error', () => {
      stdinOpen = false;
    });
    // Flowing mode, split on newlines. The partial line never holds more than FOLLOW_LINE_CAP_BYTES.
    child.stdout.on('data', (chunk: Buffer) => {
      let start = 0;
      while (forced === null) {
        const newline = chunk.indexOf(10, start);
        const stop = newline === -1 ? chunk.length : newline;
        if (pendingBytes + stop - start > FOLLOW_LINE_CAP_BYTES) return force('line-cap');
        if (newline === -1) {
          if (stop > start) {
            pending.push(chunk.subarray(start));
            pendingBytes += stop - start;
          }
          return;
        }
        const line = pending.length === 0 ? chunk.toString('utf8', start, newline) : Buffer.concat([...pending, chunk.subarray(start, newline)]).toString('utf8');
        pending = [];
        pendingBytes = 0;
        lines += 1;
        start = newline + 1;
        for (const listener of listeners) listener(line);
      }
    });
    // DEC-054: stderr is scanned line by line for the two markers only, keeping at most the current
    // partial line (FOLLOW_STDERR_LINE_BYTES); its text is never returned, stored or logged.
    const scan = (text: string) => {
      if (text.includes(ERROR_MARKER)) sawError = true;
      if (UNKNOWN_MARKER.test(text)) sawUnknown = true;
    };
    child.stderr.on('data', (chunk: Buffer) => {
      if (sawError && sawUnknown) return;
      const parts = (errorLine + chunk.toString('latin1')).split('\n');
      errorLine = parts.pop() ?? '';
      for (const part of parts) scan(part);
      scan(errorLine);
      if (errorLine.length > FOLLOW_STDERR_LINE_BYTES) errorLine = errorLine.slice(-FOLLOW_STDERR_LINE_BYTES);
    });
    child.on('error', () => {
      // A child that never started may not emit 'close'; one that did start still will.
      if (child.pid === undefined) finish(null, null, 'spawn-failed');
    });
    child.on('close', (code: number | null, signal: string | null) => finish(code, signal, forced ?? 'exit'));

    return {
      send(message) {
        if (!stdinOpen || !child.stdin.writable) return false;
        if (!message || (message.op !== 'sub' && message.op !== 'unsub') || typeof message.ch !== 'string') return false;
        child.stdin.write(`${JSON.stringify({ op: message.op, ch: message.ch })}\n`);
        return true;
      },
      onLine(listener) {
        listeners.push(listener);
      },
      exited,
      end() {
        if (settled || ending || forced !== null) return;
        ending = true;
        closeStdin();
        child.kill('SIGTERM');
        killTimer = clock.setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      },
    };
  }

  /** Shutdown: SIGKILL every running child, the follow child too, and answer queued and later calls as core-unreachable. */
  function stop() {
    stopped = true;
    for (const child of running) child.markStopped();
    for (const waiter of queue.splice(0)) waiter.grant(null);
    followLive?.stop();
  }

  return { run, follow, stop };
}

/**
 * IC-005 / IC-024: the error codes of the Fleet shapes and their HTTP status. `project-not-found` is a
 * runner failure (no spawn); the others are the id of a core `error` on an exit 1 (`errorId`). `stream-limit`
 * belongs to the stream route (V.8) and `live-unavailable` to `/api/live` (149 IC-011); both are listed here
 * so the status table is in one place.
 */
const FLEET_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'cannot-list-projects': 502,
  'project-not-found': 404,
  'agent-not-in-project': 404,
  'session-not-in-project': 404,
  'stream-limit': 429,
  'live-unavailable': 503,
});
/** The error ids a core exit 1 may carry, by Fleet shape. */
const FLEET_CORE_ERRORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  projects: Object.freeze(['cannot-list-projects']),
  transcript: Object.freeze(['agent-not-in-project', 'session-not-in-project']),
});

/** The IC-005 `{status, code}` of a failed Fleet read, or null when it is none of the Fleet codes (the caller then maps it as any runner failure). */
function fleetError(shapeId: string, failure: { code: string; exit: number | null; errorId?: string }): { status: number; code: string } | null {
  if (failure.code === 'project-not-found') return { status: 404, code: 'project-not-found' };
  if (failure.code !== 'core-error' || failure.exit !== 1 || failure.errorId === undefined) return null;
  const allowed = Object.hasOwn(FLEET_CORE_ERRORS, shapeId) ? FLEET_CORE_ERRORS[shapeId] : [];
  return allowed.includes(failure.errorId) ? { status: FLEET_ERROR_STATUS[failure.errorId], code: failure.errorId } : null;
}

module.exports = {
  BACKOFF_MS,
  FLEET_ERROR_STATUS,
  FOLLOW_LINE_CAP_BYTES,
  FOLLOW_SHAPES,
  FOLLOW_SHAPE_IDS,
  FOLLOW_STDERR_LINE_BYTES,
  IDENTITY_VARIABLES,
  KILL_GRACE_MS,
  OUTPUT_CAP_BYTES,
  PARAM_PATTERN,
  PASS_THROUGH,
  POOL_SIZE,
  RESERVED_SLOTS,
  SHAPES,
  SHAPE_IDS,
  TIMEOUT_MS,
  createVerbRunner,
  fleetError,
};
