'use strict';

// Console verb runner (feature 093, IC-003 over 092 IC-009; FR-002): the only path from the Console
// to the core. A frozen allow-list of complete argv shapes, parameters checked before they reach
// argv, the core spawned as `process.execPath <core> ...argv --json` with `shell: false`, cwd the
// project, and an environment with every DOFLOW_* and identity variable removed. Pool of 2, 10 s
// timeout, single-flight per argv, per-shape cache, 30 s backoff after an `[ERROR]` exit 1, 4 MiB
// stdout cap. The child's stderr is read only for the `[ERROR]` marker: never returned or logged.

const childProcess = require('node:child_process');
const fs = require('node:fs');

type Param = { param: string };
interface Shape {
  readonly argv: readonly (string | Param)[];
  /** Cache lifetime in ms; Infinity is the process lifetime. */
  readonly ttl: number;
  /** `workflow`: the cache entry is keyed by the core version as well. */
  readonly byCoreVersion?: true;
  /** `version`: the core prints a plain line, not JSON. */
  readonly text?: true;
}
type Failure = { ok: false; code: 'usage' | 'core-error' | 'core-unreachable'; exit: number | null; reason?: string };
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

/** IC-003, the whole allow-list. `--json` is appended to every shape. */
const SHAPES: Readonly<Record<string, Shape>> = deepFreeze({
  list: { argv: ['orchestrate', '--action', 'list'], ttl: 2_000 },
  status: { argv: ['orchestrate', '--action', 'status', '--task-id', TASK_ID, '--slug', SLUG], ttl: 2_000 },
  timeline: { argv: ['orchestrate', '--action', 'timeline', '--task-id', TASK_ID, '--slug', SLUG], ttl: 2_000 },
  attempts: { argv: ['task-attempt', '--action', 'inspect', '--slug', SLUG], ttl: 2_000 },
  workflow: { argv: ['workflow', '--task-class', TASK_CLASS], ttl: Infinity, byCoreVersion: true },
  capabilities: { argv: ['capabilities'], ttl: 30_000 },
  version: { argv: ['--version'], ttl: Infinity, text: true },
});
const SHAPE_IDS: readonly string[] = Object.freeze(Object.keys(SHAPES));

/** The core's ID_PATTERN without its length bound (IC-003): no leading `-`, `.`, no `/`. */
const PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
const TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const BACKOFF_MS = 30_000;
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const ERROR_MARKER = '[ERROR]';

const usage = (): Failure => ({ ok: false, code: 'usage', exit: null });
const unreachable = (): Failure => ({ ok: false, code: 'core-unreachable', exit: null });

/** The argv of a shape with its parameters filled, or null when the call is not on the allow-list. */
function buildArgv(shapeId: unknown, params: unknown): string[] | null {
  if (typeof shapeId !== 'string' || !Object.hasOwn(SHAPES, shapeId)) return null;
  const given = params ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) return null;
  const shape = SHAPES[shapeId];
  const wanted = shape.argv.filter((part): part is Param => typeof part !== 'string').map((part) => part.param);
  const keys = Object.keys(given);
  if (keys.length !== wanted.length || !keys.every((key) => wanted.includes(key))) return null;
  const argv: string[] = [];
  for (const part of shape.argv) {
    if (typeof part === 'string') {
      argv.push(part);
      continue;
    }
    const value = (given as Record<string, unknown>)[part.param];
    if (typeof value !== 'string' || !PARAM_PATTERN.test(value)) return null;
    argv.push(value);
  }
  argv.push('--json');
  return argv;
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
  const queue: Array<() => void> = [];
  const running = new Set<any>();
  let active = 0;
  let stopped = false;

  /** One spawn of the core. Resolves when the child has closed; never rejects. */
  function spawnCore(shape: Shape, argv: string[]): Promise<Result> {
    return new Promise((resolve) => {
      let child: any;
      try {
        if (!fs.statSync(corePath).isFile()) return resolve(unreachable());
        child = spawnImpl(process.execPath, [corePath, ...argv], {
          cwd: projectRoot,
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
          if (code === 1 && sawError) backoff.set(argv.join('\0'), { result: { ...result, reason: 'backoff' }, until: clock.now() + BACKOFF_MS });
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

  /** Wait for one of the POOL_SIZE slots; false when the runner stopped while waiting. */
  function acquire(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (active < POOL_SIZE) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => queue.push(() => resolve(!stopped)));
  }

  function release() {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  }

  async function spawnPooled(shape: Shape, argv: string[]): Promise<Result> {
    if (!(await acquire())) return unreachable();
    try {
      return await spawnCore(shape, argv);
    } finally {
      release();
    }
  }

  async function run(shapeId: string, params?: Record<string, unknown> | null): Promise<Result> {
    const argv = buildArgv(shapeId, params);
    if (argv === null) return usage();
    if (stopped) return unreachable();
    const shape = SHAPES[shapeId];
    const argvKey = argv.join('\0');

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
      flight = spawnPooled(shape, argv).finally(() => inFlight.delete(argvKey));
      inFlight.set(argvKey, flight);
    }
    const result = await flight;
    if (result.ok && cacheKey !== null) cache.set(cacheKey, { result, expires: clock.now() + shape.ttl });
    return result;
  }

  /** Shutdown: SIGKILL every running child and answer queued and later calls as core-unreachable. */
  function stop() {
    stopped = true;
    for (const child of running) child.markStopped();
    for (const next of queue.splice(0)) next();
  }

  return { run, stop };
}

module.exports = {
  BACKOFF_MS,
  IDENTITY_VARIABLES,
  KILL_GRACE_MS,
  OUTPUT_CAP_BYTES,
  PARAM_PATTERN,
  PASS_THROUGH,
  POOL_SIZE,
  SHAPES,
  SHAPE_IDS,
  TIMEOUT_MS,
  createVerbRunner,
};
