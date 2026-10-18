'use strict';

// 088 G.4, IC-017: synchronous, local-host coordination, never a completed-result cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultIsAlive } = require('../../state/run-lock.ts');

const TOKEN = /^[0-9a-f]{32}$/;
const KEY = /^[0-9a-f]{16}$/;
const RESULT_TTL_MS = 2 * 60 * 1000;
const SCRATCH_TTL_MS = 10 * 60 * 1000;
const MAX_STREAM_CHARS = 2000;
const wait = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function validLock(lock: any): boolean {
  return lock?.v === 1 && TOKEN.test(lock.token) && Number.isSafeInteger(lock.pid) && lock.pid > 0
    && Number.isSafeInteger(lock.startedAt) && Number.isSafeInteger(lock.deadlineAt)
    && lock.deadlineAt >= lock.startedAt;
}

/** Only the execution fields the runner consumes cross the process boundary, never pid/argv. */
function execution(result: any): any {
  if (!result || !(result.status === null || (Number.isInteger(result.status) && result.status >= 0))
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || !(result.signal == null || typeof result.signal === 'string')
    || (result.error && typeof result.error.message !== 'string')) throw new Error('Invalid execution result');
  return {
    status: result.status,
    stdout: result.bounded === true ? result.stdout : result.stdout.slice(0, MAX_STREAM_CHARS),
    stderr: result.bounded === true ? result.stderr : result.stderr.slice(0, MAX_STREAM_CHARS),
    truncated: result.truncated === true || result.stdout.length > MAX_STREAM_CHARS || result.stderr.length > MAX_STREAM_CHARS,
    signal: result.signal ?? null,
    ...(result.error ? { error: { message: result.error.message, code: result.error.code ?? null } } : {}),
    ...(result.bounded === true ? {
      bounded: true,
      tests: result.tests,
      testsFailed: result.testsFailed,
      ...(result.failedTests ? { failedTests: result.failedTests } : {}),
      ...(result.failedFiles ? { failedFiles: result.failedFiles } : {}),
      ...(Object.hasOwn(result, 'logPath') ? { logPath: result.logPath } : {}),
    } : {}),
  };
}

/** All removers use a per-instance claim, including the leader. Without this, a sweeper that
 * inspected an old lock could unlink a new leader between its token read and unlink. Claims
 * are never waited for or taken over; an orphan costs sharing, never correctness. */
function removeLock(io: any, file: string, token: string, expired: boolean, now: () => number): void {
  const claim = `${file}.${token}.claim`;
  io.writeFileSync(claim, '', { flag: 'wx', mode: 0o600 });
  try {
    const current = JSON.parse(io.readFileSync(file, 'utf8'));
    if (validLock(current) && current.token === token && (!expired || now() > current.deadlineAt)) {
      io.unlinkSync(file);
    }
  } finally {
    io.unlinkSync(claim);
  }
}

function sweepInflight(dir: string, { fsImpl = fs, now = Date.now }: any = {}): void {
  for (const name of fsImpl.readdirSync(dir)) {
    const result = /^inflight-[0-9a-f]{16}\.[0-9a-f]{32}\.result\.json$/.test(name);
    const lock = /^inflight-[0-9a-f]{16}\.lock$/.test(name);
    const scratch = /^inflight-[0-9a-f]{16}(?:\.[0-9a-f]{32}\.tmp|\.lock\.[0-9a-f]{32}\.claim)$/.test(name);
    if (!result && !lock && !scratch) continue;
    const file = path.join(dir, name);
    try {
      if (scratch) {
        if (now() - fsImpl.statSync(file).mtimeMs > SCRATCH_TTL_MS) fsImpl.unlinkSync(file);
        continue;
      }
      const raw = fsImpl.readFileSync(file, 'utf8');
      let record: any;
      try {
        record = JSON.parse(raw);
        if (result ? record?.v !== 1 || !Number.isSafeInteger(record.finishedAt) : !validLock(record)) {
          throw new Error('Invalid inflight record');
        }
      } catch {
        // Fresh empty locks still get the follower's bounded retry. Only malformed
        // records use mtime: valid locks always require the token-bound removal claim.
        if (now() - fsImpl.statSync(file).mtimeMs > RESULT_TTL_MS) fsImpl.unlinkSync(file);
        continue;
      }
      if (result) {
        if (now() - record.finishedAt > RESULT_TTL_MS) fsImpl.unlinkSync(file);
      } else {
        if (now() > record.deadlineAt) removeLock(fsImpl, file, record.token, true, now);
      }
    } catch {
      // A raced, inaccessible or claimed entry never disables unrelated sharing.
    }
  }
}

/** Returns spawnSync's execution plus out-of-report telemetry. A coordination fault executes
 * locally; exceptions from execute itself are left to the runner's ordinary FAIL handling. */
function runInflight({ dir, key, timeoutMs, execute, summarize, fsImpl = fs, now = Date.now,
  isAlive = defaultIsAlive, sleep = wait, monotonic = () => process.hrtime.bigint(), mintToken = () => crypto.randomBytes(16).toString('hex') }: any): any {
  const unshared = () => ({ result: execute(), shared: 'none', sharedRef: null });
  if (typeof key !== 'string' || !KEY.test(key) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) return unshared();
  let token: string;
  let lockFile: string;
  let temp: string | undefined;
  let tempOwned = false;
  let owner = false;
  let follower: any = null;
  let arrival = 0;
  let arrivalNs: bigint | undefined;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    sweepInflight(dir, { fsImpl, now });
    token = mintToken();
    if (!TOKEN.test(token)) throw new Error('Invalid token');
    lockFile = path.join(dir, `inflight-${key}.lock`);
    temp = path.join(dir, `inflight-${key}.${token}.tmp`);
    const startedAt = now();
    const record = { v: 1, token, pid: process.pid, startedAt, deadlineAt: startedAt + timeoutMs + 30000 };
    if (!validLock(record)) throw new Error('Invalid clock');
    fsImpl.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    tempOwned = true;
    try {
      fsImpl.linkSync(temp, lockFile);
      owner = true;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      arrival = now();
      if (!Number.isSafeInteger(arrival)) throw new Error('Invalid arrival clock');
      arrivalNs = monotonic();
    }
    fsImpl.unlinkSync(temp);
    tempOwned = false;
    temp = undefined;
    if (!owner) {
      // Bound retries by count as well as clock: a stalled wall clock must not hang verification.
      for (let attempt = 0; attempt <= 4; attempt++) {
        let raw = '';
        try { raw = fsImpl.readFileSync(lockFile, 'utf8'); } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (raw) { follower = JSON.parse(raw); break; }
        if (attempt === 4 || now() - arrival >= 1000) break;
        sleep(250);
      }
      if (!validLock(follower)) throw new Error('Invalid follower lock');
    }
  } catch {
    if (tempOwned && temp) { try { fsImpl.unlinkSync(temp); } catch { /* local temp only */ } }
    if (owner) { try { removeLock(fsImpl, lockFile!, token!, false, now); } catch { /* never remove an unknown owner */ } }
    return unshared();
  }

  if (!owner) {
    try {
      const resultFile = path.join(dir, `inflight-${key}.${follower.token}.result.json`);
      const maxPolls = Math.ceil((timeoutMs + 30000) / 250) + 1;
      for (let attempt = 0; attempt < maxPolls; attempt++) {
        let raw: string | null = null;
        try { raw = fsImpl.readFileSync(resultFile, 'utf8'); } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (raw !== null) {
          const record = JSON.parse(raw);
          if (record?.v !== 1 || record.token !== follower.token || !Number.isSafeInteger(record.finishedAt)
            || arrival > record.finishedAt || record.finishedAt < follower.startedAt) throw new Error('Unrelated result');
          return { result: execution(record.result), shared: 'follower', sharedRef: follower.token, durationMs: Math.max(0, Number(monotonic() - arrivalNs!) / 1e6) };
        }
        const current = JSON.parse(fsImpl.readFileSync(lockFile!, 'utf8'));
        if (!validLock(current) || current.token !== follower.token || !isAlive(follower.pid)
          || now() > follower.deadlineAt) break;
        sleep(250);
      }
    } catch { /* any result, lock, liveness or wait fault runs locally */ }
    return unshared();
  }

  let result: any;
  let shared = 'leader';
  try {
    result = execute();
    if (summarize) result = summarize(result);
    const persisted = execution(result);
    const finishedAt = now();
    if (!Number.isSafeInteger(finishedAt)) throw new Error('Invalid result clock');
    const resultFile = path.join(dir, `inflight-${key}.${token!}.result.json`);
    temp = path.join(dir, `inflight-${key}.${token!}.tmp`);
    fsImpl.writeFileSync(temp, JSON.stringify({ v: 1, token: token!, finishedAt, result: persisted }), { flag: 'wx', mode: 0o600 });
    tempOwned = true;
    fsImpl.renameSync(temp, resultFile);
    tempOwned = false;
    temp = undefined;
  } catch (error) {
    // Execution already happened locally. Publication faults do not replace its verdict.
    shared = 'none';
    if (result === undefined) throw error;
  } finally {
    if (tempOwned && temp) { try { fsImpl.unlinkSync(temp); } catch { /* local temp only */ } }
    try { removeLock(fsImpl, lockFile!, token!, false, now); } catch { shared = 'none'; }
  }
  return { result, shared, sharedRef: shared === 'leader' ? token! : null };
}

module.exports = { runInflight, sweepInflight };
