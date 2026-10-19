'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Named machine-wide slots (feature 115, IC-008 to IC-010): at most one `runSlot` holder per name,
 * waiters served in arrival order. State is one file per slot under the user-state root
 * (`~/.doflow/state/slots/<name>.json`), and EVERY change to it, the whole grant decision included,
 * runs inside one `updateTaskState` critical section, so two waiters can never both be granted.
 *
 * A holder or waiter counts as dead only when `alive()` says `false`; `unknown` counts as alive.
 * A holder is alive while the `slot run` process or its recorded child is. Dead entries are dropped
 * under the lock on every read. Nothing here ever signals a process other than the caller's own
 * child, and `releaseSlot` never signals at all.
 *
 * Library only: it returns exit codes and never calls process.exit; the CLI maps them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const { updateTaskState, readTaskState } = require('./task-state.ts');
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
const SLOT_LOCK_STALE_MS = 10_000;
const SLOT_LOCK_WAIT_MS = 20;
const SLOT_LOCK_RETRIES = 1500;

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function checkName(name: any): string {
  if (typeof name !== 'string' || !SLOT_NAME.test(name)) {
    throw fail('usage', `Slot name '${name}' is invalid: use 1 to 64 characters of a-z, 0-9 and '-', starting with a letter or digit.`);
  }
  return name;
}

/** The slots directory under the user-state root; never falls back to a real home. */
function slotsDir(env: any, fsImpl: any): string {
  const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry, env });
  if (!roots['user-state']) throw fail('no-home', 'HOME is not set to an absolute path, so the slot state directory cannot be resolved.');
  const dir = resolveStorePath({ store: { root: 'user-state', path: 'slots' }, roots, fsImpl });
  if (!dir) throw fail('slots-unsafe', `Refusing to use '${roots['user-state']}/slots': a DoFlow-owned path component is a link.`);
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
};

function resolveDeps(deps: Deps = {}) {
  const kill = deps.kill;
  const run = deps.run;
  return {
    fsImpl: deps.fsImpl || fs,
    spawn: deps.spawn || spawnChild,
    alive: deps.alive || ((proc: any) => processAlive(proc, { kill, run })),
    procStart: deps.procStart || ((pid: number) => processStart(pid, run ? { run } : {})),
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    stderr: deps.stderr || ((line: string) => { process.stderr.write(`${line}\n`); }),
    pid: deps.pid ?? process.pid,
    pollMs: deps.pollMs ?? POLL_MS,
    platform: deps.platform ?? process.platform,
    proc: deps.proc || process,
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

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerFile(lockDir: string): string {
  return path.join(lockDir, 'owner.json');
}

function readLockOwner(fsImpl: any, lockDir: string): any | null {
  const file = ownerFile(lockDir);
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const owner = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    return { pid: owner.pid, start: owner.start ?? null };
  } catch {
    return null;
  }
}

/**
 * Slot writes need a stronger lock than task-state's age-only default: a slow live critical section
 * must not be mistaken for a crashed writer. The owner token is written only after mkdir succeeds;
 * stale directories are renamed aside before removal so competing reclaimers cannot delete a new
 * owner's directory.
 */
function acquireSlotLock(fsImpl: any, file: string, deps: any): () => void {
  const lockDir = `${file}.lock`;
  const token = { pid: deps.pid, start: deps.procStart(deps.pid) };
  const tokenFile = ownerFile(lockDir);
  const sameOwner = (owner: any) => owner && owner.pid === token.pid && owner.start === token.start;

  for (let attempt = 0; attempt < SLOT_LOCK_RETRIES; attempt += 1) {
    try {
      fsImpl.mkdirSync(lockDir);
      try {
        fsImpl.writeFileSync(tokenFile, JSON.stringify(token), 'utf8');
      } catch (error) {
        try { fsImpl.rmdirSync(lockDir); } catch { /* the failed writer still owns the empty directory */ }
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!sameOwner(readLockOwner(fsImpl, lockDir))) return;
        try { fsImpl.unlinkSync(tokenFile); } catch (error: any) { if (error.code !== 'ENOENT') return; }
        try { fsImpl.rmdirSync(lockDir); } catch { /* another process already removed or replaced it */ }
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }

    let stat: any;
    try { stat = fsImpl.statSync(lockDir); } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      blockingSleep(SLOT_LOCK_WAIT_MS);
      continue;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const owner = readLockOwner(fsImpl, lockDir);
    let ownerAlive: any = 'unknown';
    if (owner) {
      try { ownerAlive = deps.alive({ pid: owner.pid, start: owner.start }); } catch { ownerAlive = 'unknown'; }
    }
    const stale = owner
      ? ownerAlive === false || (ownerAlive === 'unknown' && ageMs > SLOT_LOCK_STALE_MS)
      : ageMs > SLOT_LOCK_STALE_MS;
    if (stale) {
      const abandoned = `${lockDir}.stale-${deps.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        fsImpl.renameSync(lockDir, abandoned);
        try { fsImpl.unlinkSync(ownerFile(abandoned)); } catch { /* a token may never have been written */ }
        try { fsImpl.rmdirSync(abandoned); } catch { /* leave unexpected contents for inspection */ }
        continue;
      } catch (error: any) {
        if (error.code === 'ENOENT' || error.code === 'EEXIST') continue;
      }
    }
    if (attempt + 1 < SLOT_LOCK_RETRIES) blockingSleep(SLOT_LOCK_WAIT_MS);
  }
  throw new Error(`Could not lock '${file}' after ${(SLOT_LOCK_RETRIES * SLOT_LOCK_WAIT_MS) / 1000}s — another writer holds '${lockDir}'.`);
}

/** Holder liveness for a run: dead only when the runner and its recorded child are both `false`. */
function holderState(holder: any, alive: (proc: any) => boolean | 'unknown'): boolean | 'unknown' {
  const self = alive({ pid: holder.pid, start: holder.start ?? null });
  const child = Number.isInteger(holder.childPid) ? alive({ pid: holder.childPid, start: holder.childStart ?? null }) : false;
  if (self === true || child === true) return true;
  if (self === false && child === false) return false;
  return 'unknown';
}

/** Drops dead waiters and a dead holder. Called only inside the lock. */
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
  updateTaskState({
    fsImpl: deps.fsImpl,
    file,
    acquire: (fsImpl: any, target: string) => acquireSlotLock(fsImpl, target, deps),
    build: (disk: any) => {
      const next = change(shape(disk, name));
      if (next === false) return null;
      if (!next.holder && next.waiters.length === 0) {
        try { deps.fsImpl.unlinkSync(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        return null;
      }
      return next;
    },
  });
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
    locked(file, name, deps, (state) => {
      sweep(state, deps.alive);
      if (state.holder && state.holder.pid === self.pid) state.holder = null;
      state.waiters = state.waiters.filter((waiter: any) => !(waiter.pid === self.pid && waiter.since === self.since));
      return state;
    });
  };
  const signalExit = (signal: string | null) => 128 + ((signal && (os.constants.signals as any)[signal]) || 0);

  try {
    let outcome: any;
    for (;;) {
      locked(file, name, deps, (state) => {
        const clean = sweep(state, deps.alive);
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
    locked(file, name, deps, (state) => {
      const before = JSON.stringify([state.holder, state.waiters]);
      sweep(state, deps.alive);
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
  locked(file, name, deps, (state) => {
    state.waiters = state.waiters.filter((waiter: any) => deps.alive({ pid: waiter.pid, start: waiter.start ?? null }) !== false);
    const holder = state.holder;
    if (!holder) return state;
    const live = deps.alive({ pid: holder.pid, start: holder.start ?? null }) === true
      || (Number.isInteger(holder.childPid) && deps.alive({ pid: holder.childPid, start: holder.childStart ?? null }) === true);
    if (live) { result = { ok: false, disposition: 'holder-alive', holder }; return false; }
    state.holder = null;
    state.lastRelease = { by, reason, at: iso(deps.now()), holder };
    result = { ok: true, disposition: 'released', holder };
    return state;
  });
  return result;
}

module.exports = { runSlot, listSlots, releaseSlot, SLOT_NAME, POLL_MS };
