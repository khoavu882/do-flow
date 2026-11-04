'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Named machine-wide slots (feature 115, IC-008 to IC-010): at most one `runSlot` holder per name,
 * waiters served in arrival order. State is one file per slot under the user-state root
 * (`~/.doflow/state/slots/<name>.json`), and EVERY change to it, the whole grant decision included,
 * runs inside one `updateTaskState` critical section, so two waiters can never both be granted.
 *
 * A holder or waiter counts as dead only when `alive()` says `false`; `unknown` counts as alive.
 * A holder is alive while the `slot run` process or its recorded child is. Liveness is probed before
 * the lock, from an unlocked read (`probeSlot`), never under it; dead entries are dropped under the
 * lock on every critical section that looks at the queue. Nothing here ever signals a process other
 * than the caller's own child, and `releaseSlot` never signals at all.
 *
 * Library only: it returns exit codes and never calls process.exit; the CLI maps them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { updateTaskState, readTaskState, acquireLock, LOCK_STALE_MS, LOCK_WAIT_MS } = require('./task-state.ts');
const { alive: processAlive, procStart: processStart } = require('./worker/process-tree.ts');
const { loadStorageRegistry } = require('./storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('./storage/roots.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLOT_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const POLL_MS = 1000;
const LABEL_MAX = 80;
const BUSY_EXIT = 75;
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SLOT_LOCK_BUDGET_MS = 30_000;
const SLOT_LOST_RETRIES = 2;

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function checkName(name: any): string {
  if (typeof name !== 'string' || !SLOT_NAME.test(name)) {
    throw fail('usage', `Slot name '${name}' is invalid: use 1 to 64 characters of a-z, 0-9 and '-', starting with a letter or digit.`);
  }
  return name;
}

/** The slots directory's path under the user-state root, not created; never falls back to a real home. */
function slotsPath(env: any, fsImpl: any): string {
  const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry, env });
  if (!roots['user-state']) throw fail('no-home', 'HOME is not set to an absolute path, so the slot state directory cannot be resolved.');
  const dir = resolveStorePath({ store: { root: 'user-state', path: 'slots' }, roots, fsImpl });
  if (!dir) throw fail('slots-unsafe', `Refusing to use '${roots['user-state']}/slots': a DoFlow-owned path component is a link.`);
  return dir;
}

/** The slots directory under the user-state root, created when absent. */
function slotsDir(env: any, fsImpl: any): string {
  const dir = slotsPath(env, fsImpl);
  fsImpl.mkdirSync(dir, { recursive: true });
  return dir;
}

type Deps = {
  fsImpl?: any;
  spawn?: any;
  alive?: (proc: any) => boolean | 'unknown';
  kill?: any;
  run?: any;
  procStart?: (pid: number) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
  pid?: number;
  pollMs?: number;
  platform?: string;
  proc?: any;
  quietMs?: number; // tests only: the quiet hold after a reclaim (default LOCK_STALE_MS)
  lockBudgetMs?: number; // tests only: how long a slot lock is waited for (default 30 s)
};

/**
 * How long a process judged alive is taken as alive without asking again. A look at the queue probes
 * every entry, and the default check starts a `ps` per entry: with N waiters that is N `ps` runs per
 * look per waiter. Only `true` is remembered, only for this runSlot call: a death is noticed within the window.
 */
const ALIVE_CACHE_MS = 2000;

function cachedAlive(check: (proc: any) => boolean | 'unknown', clock: () => number = () => performance.now()): (proc: any) => boolean | 'unknown' {
  const seen = new Map<string, number>();
  return (proc: any) => {
    const key = `${proc?.pid}\0${proc?.start ?? ''}`;
    // A monotonic clock, and a non-positive or odd age counts as expired: a wall-clock step back must not keep a dead process alive.
    const now = clock();
    const at = seen.get(key);
    const age = at === undefined ? NaN : now - at;
    if (age >= 0 && age < ALIVE_CACHE_MS) return true;
    const state = check(proc);
    if (state === true) seen.set(key, now); else seen.delete(key);
    return state;
  };
}

function resolveDeps(deps: Deps = {}) {
  const kill = deps.kill;
  const run = deps.run;
  return {
    fsImpl: deps.fsImpl || fs,
    spawn: deps.spawn || spawnChild,
    alive: deps.alive || cachedAlive((proc: any) => processAlive(proc, { kill, run })),
    procStart: deps.procStart || ((pid: number) => processStart(pid, run ? { run } : {})),
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    stderr: deps.stderr || ((line: string) => { process.stderr.write(`${line}\n`); }),
    pid: deps.pid ?? process.pid,
    pollMs: deps.pollMs ?? POLL_MS,
    platform: deps.platform ?? process.platform,
    proc: deps.proc || process,
    quietMs: deps.quietMs,
    lockBudgetMs: deps.lockBudgetMs,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** What is on disk, made well-formed. */
function shape(disk: any, name: string) {
  return {
    name,
    holder: disk && disk.holder ? { ...disk.holder } : null,
    waiters: Array.isArray(disk?.waiters) ? disk.waiters.map((waiter: any) => ({ ...waiter })) : [],
    lastRelease: disk && disk.lastRelease ? disk.lastRelease : null,
  };
}

const LEGACY_OWNER = 'owner.json';
// An entry is `owner-<pid>-<hex of the owner's start time, or x>-<12 hex>`: the protocol needs a
// unique name, the slot lock also reads its owner from it.
const ENTRY = /^owner-(\d+)-([0-9a-f]+|x)-[0-9a-f]{12}$/;

/** The text of the 115 slot lock's owner token (`owner.json`, a regular file), or null. */
function readLegacyToken(fsImpl: any, lockDir: string): string | null {
  const file = path.join(lockDir, LEGACY_OWNER);
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return fsImpl.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The owner a 115 token names, or null. */
function legacyOwner(text: string | null): any | null {
  if (text == null) return null;
  try {
    const owner = JSON.parse(text);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    return { pid: owner.pid, start: owner.start ?? null };
  } catch {
    return null;
  }
}

/** The owner an entry name records, or null for a name this lock does not make. */
function entryOwner(name: string): any | null {
  const match = ENTRY.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, start: match[2] === 'x' ? null : Buffer.from(match[2], 'hex').toString('utf8') };
}

const refuse = (why: string) => Object.assign(new Error(why), { code: 'EBUSY' });

/**
 * The slot lock (FU-31dyvs) is the task-state lock (`src/runtime/task-state.ts`, its protocol and
 * `release.held()`), with the entry naming its owner and a stale rule that keeps 115's C-4: an entry
 * whose owner is alive is never reclaimed, however old (a slow live critical section is not a crash);
 * one whose owner is dead is reclaimable at once; one whose liveness is unknown, an empty lock and a
 * directory name this lock does not make once the lock is 10 s old, as in task-state. An older
 * runtime's lock (its `owner.json` token) is judged the same way. `reclaimed` records that this acquire
 * judged a lock reclaimable, so it holds only after `quiet` (every reclaim quiets; user ruling, 117
 * decisions: amends 115 C-4's "dead owner reclaimed at once").
 */
function slotLock(fsImpl: any, deps: any) {
  const start = deps.procStart(deps.pid);
  const startCode = typeof start === 'string' && start ? Buffer.from(start, 'utf8').toString('hex') : 'x';
  const liveness = (owner: any): boolean | 'unknown' => {
    try { return deps.alive({ pid: owner.pid, start: owner.start }); } catch { return 'unknown'; }
  };
  const lock: any = { reclaimed: false, current: null, judgedToken: null };
  lock.options = {
    entryName: () => (lock.current = `owner-${deps.pid}-${startCode}-${randomBytes(6).toString('hex')}`),
    stale: ({ lockDir, entries, ageMs }: { lockDir: string; entries: string[]; ageMs: number }) => {
      const aged = ageMs > LOCK_STALE_MS;
      const reclaimable = entries.length === 0 ? aged : entries.every((name: string) => {
        let owner: any;
        if (name === LEGACY_OWNER) {
          lock.judgedToken = readLegacyToken(fsImpl, lockDir);
          owner = legacyOwner(lock.judgedToken);
        } else owner = entryOwner(name);
        if (!owner) return aged;
        const state = liveness(owner);
        return state === false || (state !== true && aged);
      });
      // Any reclaim quiets (FU-31dyvs N-1): an older runtime may have judged the lock, or the one before
      // it, stale, and a current process that died in its own quiet hold leaves a young lock with a dead
      // entry, which only a quiet successor keeps safe from that older runtime's pending move.
      if (reclaimable) lock.reclaimed = true;
      return reclaimable;
    },
    removeEntry: (lockFs: any, lockDir: string, name: string) => {
      const entry = path.join(lockDir, name);
      const stat = lockFs.lstatSync(entry);
      if (name !== LEGACY_OWNER || stat.isDirectory()) return lockFs.rmdirSync(entry);
      if (!stat.isFile()) throw refuse('not a token');
      // C-1: unlink only the dead token judged, in the lock that holds this process's entry. An older
      // runtime that moved the lock aside and made a new one in between has its own token there.
      if (!lock.current || !lockFs.existsSync(path.join(lockDir, lock.current))) throw refuse('the lock was replaced');
      if (lockFs.readFileSync(entry, 'utf8') !== lock.judgedToken) throw refuse('the token changed');
      return lockFs.unlinkSync(entry);
    },
  };
  return lock;
}

/**
 * After reclaiming a lock (FU-31dyvs C-2, N-1): an older runtime that judged it (or an earlier lock at
 * the path) stale moves it aside by name, at any later moment, so this process waits LOCK_STALE_MS
 * with its entry in the lock, holding nothing, before it uses the lock. A move that lands meanwhile
 * takes the lock with this process's entry (`held()` turns false and the acquire starts over); one
 * that lands later came from a process paused 10 s or more between its judgement and its move. The
 * lock's time is refreshed meanwhile so that no older runtime judges it stale by its age.
 */
function quiet(fsImpl: any, lockDir: string, release: any, quietMs: number): boolean {
  const until = Date.now() + quietMs;
  let touched = -Infinity;
  for (;;) {
    if (!release.held()) return false;
    const now = Date.now();
    if (now >= until || now - touched >= LOCK_STALE_MS / 4) {
      try { fsImpl.utimesSync(lockDir, now / 1000, now / 1000); } catch { /* held() below decides */ }
      touched = now;
    }
    if (now >= until) return release.held();
    blockingSleep(LOCK_WAIT_MS);
  }
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The slot lock's give-up error; it names a file in the lock, which keeps it locked (C-4). */
function lockFailure(fsImpl: any, file: string, budgetMs: number): Error {
  const lockDir = `${file}.lock`;
  let stray: string[] = [];
  try {
    stray = fsImpl.readdirSync(lockDir, { withFileTypes: true })
      .filter((entry: any) => !entry.isDirectory() && entry.name !== LEGACY_OWNER).map((entry: any) => entry.name);
  } catch { /* no lock left to name anything in */ }
  const named = stray.length === 0 ? ''
    : ` It holds ${stray.map((name) => `'${name}'`).join(', ')}, which no DoFlow runtime makes and which keeps it locked: `
      + `remove ${stray.length > 1 ? 'them' : 'it'} once no DoFlow process is running.`;
  return new Error(`Could not lock '${file}' after ${budgetMs / 1000}s — another writer holds '${lockDir}'.${named}`);
}

/** Takes the slot lock for `file` within SLOT_LOCK_BUDGET_MS; the release function carries `held()`. */
function acquireSlotLock(fsImpl: any, file: string, deps: any): any {
  const lockDir = `${file}.lock`;
  const budgetMs = deps.lockBudgetMs ?? SLOT_LOCK_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const lock = slotLock(fsImpl, deps);
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw lockFailure(fsImpl, file, budgetMs);
    lock.reclaimed = false;
    let release: any;
    try {
      release = acquireLock(fsImpl, file, { ...lock.options, retries: Math.max(1, Math.ceil(left / LOCK_WAIT_MS)) });
    } catch (error: any) {
      if (typeof error?.message !== 'string' || !error.message.startsWith('Could not lock')) throw error;
      throw lockFailure(fsImpl, file, budgetMs);
    }
    if (!lock.reclaimed || quiet(fsImpl, lockDir, release, deps.quietMs ?? LOCK_STALE_MS)) return release;
    release(); // an older runtime moved the lock with our entry in it: nothing of ours is at the path
  }
}

/** Holder liveness for a run: dead only when the runner and its recorded child are both `false`. */
function holderState(holder: any, alive: (proc: any) => boolean | 'unknown'): boolean | 'unknown' {
  const self = alive({ pid: holder.pid, start: holder.start ?? null });
  const child = Number.isInteger(holder.childPid) ? alive({ pid: holder.childPid, start: holder.childStart ?? null }) : false;
  if (self === true || child === true) return true;
  if (self === false && child === false) return false;
  return 'unknown';
}

const identity = (pid: any, start: any): string => `${pid}\0${start ?? ''}`;

/**
 * Probes, BEFORE the slot lock, every process an unlocked read of the slot file names (a read error
 * or a missing file: nothing to probe); under the lock a probe (a `ps`, slow on a loaded host) made
 * every critical section that slow. The death of a (pid, start) identity is permanent, so a `false`
 * found here is still true under the lock; an identity not probed here is `unknown`, which counts as
 * alive, and is judged on the next look. `seen` is that read: a hint for skipping a look, never a decision.
 */
function probeSlot(fsImpl: any, file: string, name: string, alive: (proc: any) => boolean | 'unknown') {
  let seen: any = null;
  try {
    const disk = readTaskState(fsImpl, file);
    seen = disk ? shape(disk, name) : null;
  } catch { /* nothing to probe; the critical section reads the file itself */ }
  const verdicts = new Map<string, boolean | 'unknown'>();
  const ask = (pid: any, start: any) => {
    const key = identity(pid, start);
    if (!verdicts.has(key)) verdicts.set(key, alive({ pid, start: start ?? null }));
  };
  if (seen) {
    for (const waiter of seen.waiters) ask(waiter.pid, waiter.start);
    if (seen.holder) {
      ask(seen.holder.pid, seen.holder.start);
      if (Number.isInteger(seen.holder.childPid)) ask(seen.holder.childPid, seen.holder.childStart);
    }
  }
  return {
    seen,
    judged: (proc: any): boolean | 'unknown' => verdicts.get(identity(proc.pid, proc.start)) ?? 'unknown',
    probed: (proc: any): boolean => verdicts.has(identity(proc.pid, proc.start)),
  };
}

/**
 * True when the unlocked read shows `self` queued and its grant cannot change on this look: a holder
 * not judged dead, or no holder and a waiter ahead of it, and no entry judged dead (a sweep is due).
 * The grant is decided under the lock only; a stale read costs one poll.
 */
function queuedBehindLive(seen: any, judged: (proc: any) => boolean | 'unknown', self: any): boolean {
  if (!seen) return false;
  const at = seen.waiters.findIndex((waiter: any) => waiter.pid === self.pid && waiter.since === self.since);
  if (at < 0 || seen.waiters.some((waiter: any) => judged(waiter) === false)) return false;
  if (seen.holder) return holderState(seen.holder, judged) !== false;
  return at > 0;
}

/** Drops dead waiters and a dead holder. Called only inside the lock, with `alive` from `probeSlot`. */
function sweep(state: any, alive: (proc: any) => boolean | 'unknown') {
  state.waiters = state.waiters.filter((waiter: any) => alive({ pid: waiter.pid, start: waiter.start ?? null }) !== false);
  if (state.holder && holderState(state.holder, alive) === false) state.holder = null;
  return state;
}

/**
 * One critical section on a slot file. `change(state)` receives what is on disk (not yet swept) and
 * returns the state to store, or `false` to leave the file untouched. A state with no holder and
 * no waiters deletes the file inside the lock, so a concurrent waiter either already appended or
 * starts from nothing.
 */
function locked(file: string, name: string, deps: any, change: (state: any) => any): void {
  // A lock reclaimed from this process before its write or delete (`lock-lost`: nothing was written)
  // runs the change again on the fresh file; every `change` here only sets what it returns or reports.
  for (let attempt = 0; ; attempt += 1) {
    let release: any = null;
    try {
      updateTaskState({
        fsImpl: deps.fsImpl,
        file,
        acquire: (fsImpl: any, target: string) => (release = acquireSlotLock(fsImpl, target, deps)),
        build: (disk: any) => {
          const next = change(shape(disk, name));
          if (next === false) return null;
          if (!next.holder && next.waiters.length === 0) {
            // The delete is a write too: check the lock is still ours first, as updateTaskState does.
            if (!release.held()) throw Object.assign(new Error(`Lost the lock on '${file}' to another writer before deleting it. Nothing was changed; run the command again.`), { code: 'lock-lost' });
            try { deps.fsImpl.unlinkSync(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
            return null;
          }
          return next;
        },
      });
      return;
    } catch (error: any) {
      if (error?.code !== 'lock-lost' || attempt >= SLOT_LOST_RETRIES) throw error;
    }
  }
}

/** One look at the queue for `self`: append, and grant when first in line with the holder gone. */
function step(state: any, self: any, noWait: boolean, deps: any, nowMs: number) {
  let mine = state.waiters.find((waiter: any) => waiter.pid === self.pid && waiter.since === self.since);
  if (!mine) {
    const ahead = state.holder || state.waiters[0];
    if (noWait && ahead) return { kind: 'busy', ahead };
    mine = { ...self };
    state.waiters.push(mine);
  }
  if (!state.holder && state.waiters[0] === mine) {
    state.waiters.shift();
    state.holder = { pid: self.pid, start: self.start, childPid: null, childStart: null, label: self.label, since: iso(nowMs), cwd: self.cwd };
    return { kind: 'granted', ahead: null };
  }
  return { kind: 'wait', ahead: state.holder || state.waiters.find((waiter: any) => waiter !== mine) || null };
}

function describeAhead(ahead: any): string {
  return ahead ? `${ahead.pid} (${ahead.label})` : 'another waiter';
}

/**
 * Waits for the slot, runs `command` as its holder, and resolves with the exit code: the child's,
 * 128 + signal when it died by one, 75 when refused or timed out, 127 when it could not start.
 */
async function runSlot({
  name, command, label, timeoutSeconds, noWait = false, cwd = process.cwd(), env = process.env, deps: injected,
}: any = {}): Promise<number> {
  checkName(name);
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string' || !command[0]) {
    throw fail('usage', 'slot run needs a command after --.');
  }
  const deps = resolveDeps(injected);
  const file = path.join(slotsDir(env, deps.fsImpl), `${name}.json`);
  const startedAt = deps.now();
  const self = {
    pid: deps.pid,
    start: deps.procStart(deps.pid),
    label: (label || `${path.basename(command[0])}@${path.basename(cwd)}`).slice(0, LABEL_MAX),
    since: iso(startedAt),
    cwd,
  };

  let received: string | null = null;
  let child: any = null;
  const forward = (signal: string) => () => {
    received = received || signal;
    if (child) { try { child.kill(signal); } catch { /* the child is already gone */ } }
  };
  const handlers = FORWARDED.map((signal) => [signal, forward(signal)] as [string, () => void]);
  for (const [signal, handler] of handlers) deps.proc.on(signal, handler);

  let holding = false;
  const release = () => {
    holding = false;
    const { judged } = probeSlot(deps.fsImpl, file, name, deps.alive);
    locked(file, name, deps, (state) => {
      sweep(state, judged);
      if (state.holder && state.holder.pid === self.pid) state.holder = null;
      state.waiters = state.waiters.filter((waiter: any) => !(waiter.pid === self.pid && waiter.since === self.since));
      return state;
    });
  };
  const signalExit = (signal: string | null) => 128 + ((signal && (os.constants.signals as any)[signal]) || 0);

  try {
    let outcome: any;
    for (;;) {
      const { seen, judged } = probeSlot(deps.fsImpl, file, name, deps.alive);
      // A waiter whose grant cannot change leaves the lock to the holder and the waiter that can.
      const due = timeoutSeconds && deps.now() - startedAt >= timeoutSeconds * 1000;
      if (!received && !due && queuedBehindLive(seen, judged, self)) { await deps.sleep(deps.pollMs); continue; }
      locked(file, name, deps, (state) => {
        const clean = sweep(state, judged);
        const waited = deps.now() - startedAt;
        if (timeoutSeconds && waited >= timeoutSeconds * 1000) {
          outcome = {
            kind: 'timeout',
            ahead: clean.holder || clean.waiters.find((waiter: any) => !(waiter.pid === self.pid && waiter.since === self.since)) || null,
            waited,
          };
          return clean;
        }
        outcome = step(clean, self, noWait, deps, deps.now());
        return clean;
      });
      if (outcome.kind === 'granted') { holding = true; break; }
      if (outcome.kind === 'busy') {
        const since = outcome.ahead.since ? ` since ${outcome.ahead.since}` : '';
        deps.stderr(`doflow slot: ${name} busy; held by ${describeAhead(outcome.ahead)}${since}`);
        return BUSY_EXIT;
      }
      if (outcome.kind === 'timeout') {
        release();
        deps.stderr(`doflow slot: ${name} timed out after ${Math.round(outcome.waited / 1000)} s; held by ${describeAhead(outcome.ahead)}`);
        return BUSY_EXIT;
      }
      if (received) { release(); return signalExit(received); }
      await deps.sleep(deps.pollMs);
    }

    if (received) return signalExit(received);
    deps.stderr(`doflow slot: ${name} granted after ${Math.round((deps.now() - startedAt) / 1000)} s (${self.label})`);

    const gated = deps.platform !== 'win32';
    const spawnCommand = gated ? 'sh' : command[0];
    const spawnArgs = gated
      ? ['-c', 'read _ <&3 || exit 125; exec 3<&-; exec "$@"', 'doflow-slot', ...command]
      : command.slice(1);
    child = deps.spawn(spawnCommand, spawnArgs, {
      stdio: gated ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
      env: { ...env, DOFLOW_SLOT: name },
      cwd,
    });
    const finished = new Promise<{ code: number | null; signal: string | null; error: any }>((resolve) => {
      child.on('error', (error: any) => resolve({ code: null, signal: null, error }));
      child.on('exit', (code: number | null, signal: string | null) => resolve({ code, signal, error: null }));
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code: number | null, signal: string | null) => resolve({ code, signal }));
    });
    const startGate = gated ? child.stdio?.[3] : null;
    try {
      let registered = false;
      if (Number.isInteger(child.pid)) {
        const childStart = deps.procStart(child.pid);
        locked(file, name, deps, (state) => {
          registered = false; // a lock-lost re-run decides again on the fresh file
          if (state.holder && state.holder.pid === self.pid) {
            state.holder = { ...state.holder, childPid: child.pid, childStart };
            registered = true;
          }
          return state;
        });
        if (!registered) throw new Error(`Could not register child ${child.pid} for slot '${name}': this process is no longer the holder.`);
      }
      if (startGate) {
        if (!registered) throw new Error(`Could not register the child for slot '${name}': it has no process id.`);
        if (typeof startGate.end === 'function') startGate.end('go\n');
      }
    } catch (registrationError) {
      if (startGate) {
        try {
          if (typeof startGate.end === 'function') startGate.end();
          else startGate.destroy?.();
        } catch { /* the child still observes a closed pipe when its runner exits */ }
      }
      if (Number.isInteger(child.pid)) await exited;
      else await finished;
      throw registrationError;
    }
    if (received) { try { child.kill(received); } catch { /* already gone */ } }
    const result = await finished;
    if (result.error) {
      deps.stderr(`doflow slot: ${name}: cannot run ${command[0]}: ${result.error.message}`);
      return 127;
    }
    return result.code != null ? result.code : signalExit(result.signal);
  } finally {
    for (const [signal, handler] of handlers) deps.proc.removeListener(signal, handler);
    if (holding) release();
  }
}

/** Reads every slot file under the lock (dead entries dropped) and returns them sorted by name. */
async function listSlots({ env = process.env, json = false, deps: injected }: any = {}): Promise<any> {
  const deps = resolveDeps(injected);
  const dir = slotsDir(env, deps.fsImpl);
  const names = deps.fsImpl.readdirSync(dir).filter((entry: string) => SLOT_FILE.test(entry)).map((entry: string) => entry.slice(0, -5)).sort();
  const slots: any[] = [];
  for (const name of names) {
    const file = path.join(dir, `${name}.json`);
    let view: any = null;
    const { judged } = probeSlot(deps.fsImpl, file, name, deps.alive);
    locked(file, name, deps, (state) => {
      const before = JSON.stringify([state.holder, state.waiters]);
      sweep(state, judged);
      view = state;
      // Only a slot with dead entries is rewritten; an unchanged one is left alone.
      return JSON.stringify([state.holder, state.waiters]) === before ? false : state;
    });
    if (view && (view.holder || view.waiters.length > 0)) slots.push({ name, holder: view.holder, waiters: view.waiters });
  }
  const output = json
    ? JSON.stringify({ ok: true, slots })
    : slots.length === 0 ? 'no slots held'
      : slots.map((slot) => {
        const head = slot.holder ? `held by ${slot.holder.pid} (${slot.holder.label}) since ${slot.holder.since}` : 'free';
        return `${slot.name}  ${head}; ${slot.waiters.length} waiting`;
      }).join('\n');
  return { ok: true, slots, output };
}

/**
 * 093 IC-018 b: every slot file read as it is on disk, with no lock, no sweep and no mkdir; a missing
 * directory is an empty list and a file that cannot be read or parsed is counted in `unreadable`.
 * A holder's `alive` is `holderState` (computed, never written); its `worktreeKey` is the `cwdHash`
 * of the checkout its `cwd` lies in when that is one of the project's checkouts seen from `cwd`,
 * else null. `waiters` counts the waiters not known to be dead. `pid`, `start`, `cwd` and waiter
 * details are never returned.
 */
async function peekSlots({ env = process.env, cwd = process.cwd(), exec, deps: injected }: any = {}): Promise<any> {
  const deps = resolveDeps(injected);
  const dir = slotsPath(env, deps.fsImpl);
  let names: string[];
  try {
    names = deps.fsImpl.readdirSync(dir).filter((entry: string) => SLOT_FILE.test(entry)).map((entry: string) => entry.slice(0, -5)).sort();
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    names = [];
  }
  let entries: any[] | null = null;
  const checkoutKey = (holderCwd: unknown): string | null => {
    const { listCheckouts, checkoutContaining } = require('./checkouts.ts');
    if (entries === null) {
      const listed = listCheckouts({ cwd, ...(exec ? { exec } : {}) });
      entries = listed.ok ? listed.entries : [];
    }
    const at = checkoutContaining(entries as any[], holderCwd, deps.fsImpl);
    if (!at || at.sandbox) return null;
    return require('./context/identity.ts').cwdHash(at.path);
  };
  const slots: any[] = [];
  let unreadable = 0;
  for (const name of names) {
    let state: any;
    try {
      const file = path.join(dir, `${name}.json`);
      if (!deps.fsImpl.lstatSync(file).isFile()) { unreadable += 1; continue; }
      const disk = JSON.parse(deps.fsImpl.readFileSync(file, 'utf8'));
      if (disk === null || typeof disk !== 'object' || Array.isArray(disk)) { unreadable += 1; continue; }
      state = shape(disk, name);
    } catch {
      unreadable += 1;
      continue;
    }
    const waiters = state.waiters.filter((waiter: any) => deps.alive({ pid: waiter.pid, start: waiter.start ?? null }) !== false).length;
    if (!state.holder && waiters === 0) continue;
    const holder = state.holder ? {
      label: typeof state.holder.label === 'string' ? state.holder.label : null,
      since: typeof state.holder.since === 'string' ? state.holder.since : null,
      alive: holderState(state.holder, deps.alive),
      worktreeKey: checkoutKey(state.holder.cwd),
    } : null;
    slots.push({ name, holder, waiters });
  }
  return { v: 1, slots, unreadable };
}

/**
 * Removes the holder of `name` unless it is alive (`true`); never signals anything. Resolves with
 * `{ok, disposition, holder?}` as IC-008 spells it.
 */
async function releaseSlot({ name, by, reason, env = process.env, deps: injected }: any = {}): Promise<any> {
  checkName(name);
  if (typeof by !== 'string' || !by.trim()) throw fail('usage', 'slot release needs --by.');
  if (typeof reason !== 'string' || !reason.trim()) throw fail('usage', 'slot release needs --reason.');
  const deps = resolveDeps(injected);
  const file = path.join(slotsDir(env, deps.fsImpl), `${name}.json`);
  let result: any = { ok: true, disposition: 'free' };
  const { judged, probed } = probeSlot(deps.fsImpl, file, name, deps.alive);
  locked(file, name, deps, (state) => {
    state.waiters = state.waiters.filter((waiter: any) => judged(waiter) !== false);
    const holder = state.holder;
    if (!holder) return state;
    const child = Number.isInteger(holder.childPid) ? { pid: holder.childPid, start: holder.childStart } : null;
    // A holder or child that appeared after the probe was not judged: it is left in place, as a live one is.
    const live = !probed(holder) || (child !== null && !probed(child))
      || judged(holder) === true || (child !== null && judged(child) === true);
    if (live) { result = { ok: false, disposition: 'holder-alive', holder }; return false; }
    state.holder = null;
    state.lastRelease = { by, reason, at: iso(deps.now()), holder };
    result = { ok: true, disposition: 'released', holder };
    return state;
  });
  return result;
}

module.exports = { runSlot, listSlots, peekSlots, releaseSlot, acquireSlotLock, cachedAlive, ALIVE_CACHE_MS, SLOT_NAME, POLL_MS };
