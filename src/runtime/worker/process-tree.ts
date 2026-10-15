'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Process identity, liveness, bounded group spawn and kill escalation (feature 081, IC-022 and
 * IC-021 step 3; DEC-023, DEC-043, DEC-050).
 *
 * A managed process is recorded as `{ pid, pgid, start }`, `start` the `ps` `lstart` text. A pid
 * alone is not an identity: it is reused once the process is reaped, so liveness also compares the
 * start time. Every `ps` call runs under `LC_ALL=C` and `TZ=UTC`, so the start a supervisor records
 * and the one a status or cancel from another shell reads are the same text whatever each
 * process's own time zone or locale (DEC-043).
 *
 * Zombies are reported apart from survivors: they have exited and only await their parent.
 * On win32 there is no `ps` and no process group, so liveness and cleanup are `unknown` (DEC-008).
 */

const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');

/** Grace between SIGTERM and SIGKILL (DEC-023). */
const KILL_GRACE_MS = 3000;
/** How long survivors of SIGKILL are polled for before they are listed. */
const KILL_FINAL_MS = 1000;
/** Grace waits are polled, never slept in one block (RK7). */
const POLL_MS = 100;
/** Bound on every `ps` call. */
const PS_TIMEOUT_MS = 2000;

const SNAPSHOT_FIELDS = ['pid', 'ppid', 'pgid', 'stat'];
const GROUP_FIELDS = ['pid', 'pgid', 'stat'];
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** `ps` by absolute path where one exists, so a worker's or a test's `PATH` never decides which
 * binary reports process identity. */
const PS_BIN = ['/bin/ps', '/usr/bin/ps'].find((candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}) || 'ps';

/** The one environment every `ps` call runs under (DEC-043). */
function psEnv() {
  return { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
}

/**
 * Runs `ps` with `args`. Returns its stdout, or null when `ps` could not run or exceeded its bound.
 * A `ps` that ran and exited non-zero (`-p` naming no live pid) returns what it printed.
 */
function runPs(args: string[]): string | null {
  try {
    return execFileSync(PS_BIN, args, {
      encoding: 'utf8',
      env: psEnv(),
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error: any) {
    if (typeof error?.status === 'number' && !error.signal) return String(error.stdout || '');
    return null;
  }
}

/** Collapses the column padding `ps` puts inside and after `lstart`. */
function normaliseStart(text: any): string | null {
  if (typeof text !== 'string') return null;
  const value = text.trim().replace(/\s+/g, ' ');
  return value || null;
}

/** Milliseconds for an `lstart` text read under `LC_ALL=C` and `TZ=UTC`, or null. */
function startMs(text: any): number | null {
  const value = normaliseStart(text);
  const match = value && /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (!match || !(match[1] in MONTHS)) return null;
  return Date.UTC(Number(match[6]), MONTHS[match[1]], Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

/**
 * Parses a `ps -o <fields...>,lstart=` listing. `lstart` is last, so the rest of each line after
 * the leading fields is the start. Lines whose numeric fields do not parse are skipped.
 */
function parseListing(text: any, fields: string[] = SNAPSHOT_FIELDS): any[] {
  const rows: any[] = [];
  for (const line of String(text || '').split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length <= fields.length) continue;
    const row: any = {};
    let valid = true;
    fields.forEach((field, index) => {
      if (field === 'stat') {
        row.stat = tokens[index];
        return;
      }
      const number = Number(tokens[index]);
      if (!Number.isInteger(number)) valid = false;
      row[field] = number;
    });
    if (!valid) continue;
    row.start = normaliseStart(tokens.slice(fields.length).join(' '));
    rows.push(row);
  }
  return rows;
}

const isZombie = (row: any) => typeof row?.stat === 'string' && row.stat.startsWith('Z');

/** `ps -o lstart= -p <pid>`, trimmed, or null when the pid is not listed or `ps` failed. */
function procStart(pid: number, { run = runPs }: any = {}): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = run(['-o', 'lstart=', '-p', String(pid)]);
  return out == null ? null : normaliseStart(out);
}

/**
 * True when the recorded process still runs: the pid answers signal 0, its start equals the
 * recorded one and it is not a zombie. False on `ESRCH`, a different start or a zombie. `unknown`
 * when the start was not recorded, `ps` failed, or on win32 while the pid answers.
 */
function alive(proc: any, { run = runPs, kill = process.kill.bind(process), platform = process.platform }: any = {}): boolean | 'unknown' {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return 'unknown';
  try {
    kill(proc.pid, 0);
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code !== 'EPERM') return 'unknown';
  }
  if (platform === 'win32' || normaliseStart(proc.start) == null) return 'unknown';
  const out = run(['-o', 'stat=,lstart=', '-p', String(proc.pid)]);
  if (out == null) return 'unknown';
  const [row] = parseListing(out, ['stat']);
  if (!row) return false;
  if (isZombie(row)) return false;
  return row.start === normaliseStart(proc.start);
}

/** Members of `rows` in group `pgid` that started at or after the leader, and whether the group id
 * now belongs to a different leader. */
function selectGroup(rows: any[], pgid: number, leaderStart: any) {
  const leader = normaliseStart(leaderStart);
  const leaderMs = startMs(leader);
  const foreignLeader = leader != null && rows.some((row) => row.pid === pgid && row.start !== leader);
  const members = rows.filter((row) => {
    if (row.pgid !== pgid) return false;
    if (leaderMs == null) return true;
    const ms = startMs(row.start);
    return ms == null || ms >= leaderMs;
  });
  return { members, foreignLeader };
}

/**
 * One `ps -A -o pid=,pgid=,stat=,lstart=` listing: the processes carrying `pgid` that started at or
 * after `leaderStart`, split into `live` and `zombies`. Null when `ps` failed.
 */
function groupMembers(pgid: number, leaderStart: any, { run = runPs }: any = {}) {
  const out = run(['-A', '-o', 'pid=,pgid=,stat=,lstart=']);
  if (out == null) return null;
  const { members, foreignLeader } = selectGroup(parseListing(out, GROUP_FIELDS), pgid, leaderStart);
  return {
    live: members.filter((row) => !isZombie(row)),
    zombies: members.filter(isZombie),
    foreignLeader,
  };
}

/**
 * True when the group still has a live member. False when it has none, or when the listing shows
 * a leader with the group's id and another start: POSIX does not reuse a pid while a group with
 * that id exists, so the worker's group has ended. `unknown` when `ps` failed or on win32.
 */
function groupAlive(pgid: number, leaderStart: any, { run = runPs, platform = process.platform }: any = {}): boolean | 'unknown' {
  if (platform === 'win32') return 'unknown';
  const group = groupMembers(pgid, leaderStart, { run });
  if (group == null) return 'unknown';
  if (group.foreignLeader) return false;
  return group.live.length > 0;
}

/** The recorded process, its group and its ppid descendants, from one listing. */
function treeFromRows(rows: any[], proc: any) {
  const { members, foreignLeader } = selectGroup(rows, proc.pgid, proc.start);
  const byPid = new Map<number, any>();
  if (!foreignLeader) for (const row of members) byPid.set(row.pid, row);
  const recorded = normaliseStart(proc.start);
  const root = rows.find((row) => row.pid === proc.pid && (recorded == null || row.start === recorded));
  if (root) {
    const queue = [root];
    byPid.set(root.pid, root);
    while (queue.length) {
      const parent = queue.shift();
      for (const row of rows) {
        if (row.ppid !== parent.pid || byPid.has(row.pid) || row.pid === parent.pid) continue;
        byPid.set(row.pid, row);
        queue.push(row);
      }
    }
  }
  return { members: [...byPid.values()], foreignLeader };
}

/**
 * One `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` snapshot of every process in the recorded group or
 * descended from its pid by ppid, each with its start. Null when `ps` failed.
 */
function snapshotTree(proc: any, { run = runPs }: any = {}) {
  const out = run(['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=']);
  if (out == null) return null;
  return treeFromRows(parseListing(out, SNAPSHOT_FIELDS), proc);
}

/** Which tracked processes (and live members of the group) remain, from one listing. */
function remaining(tracked: any[], proc: any, groupOwned: boolean, run: any) {
  const out = run(['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=']);
  if (out == null) return null;
  const rows = parseListing(out, SNAPSHOT_FIELDS);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const live = new Set<number>();
  const zombies = new Set<number>();
  for (const entry of tracked) {
    const row = byPid.get(entry.pid);
    if (!row || (entry.start != null && row.start !== entry.start)) continue;
    (isZombie(row) ? zombies : live).add(row.pid);
  }
  if (groupOwned) {
    const { members, foreignLeader } = selectGroup(rows, proc.pgid, proc.start);
    if (!foreignLeader) for (const row of members) (isZombie(row) ? zombies : live).add(row.pid);
  }
  for (const pid of live) zombies.delete(pid);
  return { live: [...live].sort((a, b) => a - b), zombies: [...zombies].sort((a, b) => a - b) };
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signal(kill: any, target: number, name: string) {
  try {
    kill(target, name);
  } catch {
    // ESRCH: already gone. EPERM: not ours to end; the final listing reports it if it remains.
  }
}

/**
 * IC-021 step 3: SIGTERM to the group and to each snapshot pid outside it, poll every 100 ms up to
 * `KILL_GRACE_MS`, SIGKILL to the group and every remaining snapshot pid, poll up to
 * `KILL_FINAL_MS`. Returns `{ status, reason, survivors, zombies }`: `verified` with no survivors,
 * `survivors` with them, `unknown` when `ps` failed or on win32. A group id that now names another
 * leader is never signalled.
 *
 * No-snapshot rule (DEC-060): when the first snapshot's `ps` fails, or the recorded leader start is
 * null, no group is signalled. The recorded pid is signalled only while `alive(proc)` is `true`, and
 * the result is `unknown` with reason `ps-failed` or `no-leader-start`; a pid still confirmed alive
 * after SIGKILL is listed in `survivors`.
 */
async function escalate({
  proc,
  platform = process.platform,
  run = runPs,
  kill = process.kill.bind(process),
  sleep = defaultSleep,
  now = Date.now,
  graceMs = KILL_GRACE_MS,
  finalMs = KILL_FINAL_MS,
}: any) {
  if (platform === 'win32') {
    signal(kill, proc.pid, 'SIGTERM');
    return { status: 'unknown', reason: 'win32', survivors: [], zombies: [] };
  }
  const leaderStart = normaliseStart(proc.start);
  const snapshot = leaderStart == null ? null : snapshotTree(proc, { run });
  if (snapshot == null) {
    const isAlive = () => alive(proc, { run, kill, platform }) === true;
    const waitGone = async (budgetMs: number) => {
      const until = now() + budgetMs;
      let live = isAlive();
      while (live && now() < until) {
        await sleep(POLL_MS);
        live = isAlive();
      }
      return live;
    };
    let live = isAlive();
    if (live) {
      signal(kill, proc.pid, 'SIGTERM');
      live = await waitGone(graceMs);
      if (live) {
        signal(kill, proc.pid, 'SIGKILL');
        live = await waitGone(finalMs);
      }
    }
    return { status: 'unknown', reason: leaderStart == null ? 'no-leader-start' : 'ps-failed', survivors: live ? [proc.pid] : [], zombies: [] };
  }
  const groupOwned = !snapshot.foreignLeader;
  const tracked = snapshot.members.map((row: any) => ({ pid: row.pid, start: row.start, pgid: row.pgid }));
  // A snapshot lists the recorded pid only when its start still matches; a pid now naming another
  // process is never signalled.

  const wait = async (budgetMs: number) => {
    const until = now() + budgetMs;
    let state = remaining(tracked, proc, groupOwned, run);
    while ((state == null || state.live.length > 0) && now() < until) {
      await sleep(POLL_MS);
      state = remaining(tracked, proc, groupOwned, run);
    }
    return state;
  };

  if (groupOwned) signal(kill, -proc.pgid, 'SIGTERM');
  for (const entry of tracked) if (!groupOwned || entry.pgid !== proc.pgid) signal(kill, entry.pid, 'SIGTERM');
  let state = await wait(graceMs);

  if (state == null || state.live.length > 0) {
    if (groupOwned) signal(kill, -proc.pgid, 'SIGKILL');
    const left = state == null ? tracked.map((entry: any) => entry.pid) : state.live;
    for (const pid of left) signal(kill, pid, 'SIGKILL');
    state = await wait(finalMs);
  }

  if (state == null) return { status: 'unknown', reason: 'ps-failed', survivors: [], zombies: [] };
  return {
    status: state.live.length ? 'survivors' : 'verified',
    reason: null,
    survivors: state.live,
    zombies: state.zombies,
  };
}

/**
 * Spawns `binary` in its own process group (darwin and linux), reads stdout up to `maxStdout`
 * bytes and ends the whole tree by `escalate` when `timeoutMs` passes. Resolves
 * `{ status, code, signal, error, stdout, truncated, proc, cleanup }`, `status` one of `exited`,
 * `timeout` or `error` (a spawn failure, `error` its code).
 */
function spawnBounded({ binary, argv = [], cwd, env, timeoutMs, maxStdout = 65536, platform = process.platform }: any): Promise<any> {
  return new Promise((resolve) => {
    let child: any;
    try {
      child = spawn(binary, argv, { cwd, env, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error: any) {
      resolve({ status: 'error', code: null, signal: null, error: error?.code || 'spawn-failed', stdout: '', truncated: false, proc: null, cleanup: null });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let cleanup: any = null;
    let cleanupDone: Promise<void> = Promise.resolve();
    const proc = { pid: child.pid, pgid: child.pid, start: platform === 'win32' ? null : procStart(child.pid) };

    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= maxStdout) {
        truncated = true;
        return;
      }
      const room = maxStdout - size;
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      size += kept.length;
    });
    child.stderr.resume();

    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, stdout: Buffer.concat(chunks).toString('utf8'), truncated, proc: child.pid ? proc : null, cleanup });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupDone = escalate({ proc, platform }).then((outcome) => {
        cleanup = outcome;
      });
    }, timeoutMs);

    child.on('error', (error: any) => {
      cleanupDone.then(() => finish({ status: timedOut ? 'timeout' : 'error', code: null, signal: null, error: error?.code || 'spawn-failed' }));
    });
    child.on('exit', (code: any, signalName: any) => {
      clearTimeout(timer);
      // Grandchildren may hold the pipes open; read what is buffered, then settle without waiting
      // for every holder to close them.
      setTimeout(() => cleanupDone.then(() => finish({ status: timedOut ? 'timeout' : 'exited', code, signal: signalName, error: null })), 0);
    });
  });
}

module.exports = {
  KILL_GRACE_MS,
  KILL_FINAL_MS,
  POLL_MS,
  PS_TIMEOUT_MS,
  psEnv,
  procStart,
  alive,
  parseListing,
  startMs,
  groupMembers,
  groupAlive,
  snapshotTree,
  escalate,
  spawnBounded,
};
