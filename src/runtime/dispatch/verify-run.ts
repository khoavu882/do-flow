'use strict';

// Feature 082 A.6 (IC-019, IC-032 endVerification; DEC-006, DEC-024, DEC-047): the verification
// runner.
//
// The run's declared `verify.argv` is spawned with no shell in the integration worktree, as its own
// process group off win32, with the caller's environment less the variables that would point git at
// another repository. `onSpawn` receives `{ pid, pgid, start }` right after the spawn so the caller
// records it as the run's `verifying` by a locked write (IC-019). Output goes through 081's masked,
// bounded `createOutputSink` under a fresh `w-` output id; at the bound the group is ended by 081's
// `escalate` against the recorded leader start. One `test-result` evidence item is saved through
// `EvidenceLedger`; it names the argv by its sha256 and count only, never an element (R14).
//
// This is the one module under `src/runtime/dispatch/` that calls `escalate` (DEC-047, G42.5), and
// it signals nothing directly: the group it spawned is the only one dispatch code ends. Writes go
// through `createOutputSink` and `EvidenceLedger` only.

const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createOutputSink } = require('../worker/supervisor.ts');
const { newRunId } = require('../worker/run-store.ts');
const processTree = require('../worker/process-tree.ts');
const { EvidenceLedger } = require('../evidence-ledger.ts');
const { emitVerifyTelemetry } = require('../verification/telemetry-emit.ts');

/** The same names as 081's `REPO_ENV` (`src/runtime/worker/worktree-check.ts:30`), which that
 * module does not export: inherited variables that would point git at another repository. */
const REPO_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);
/** How long the streams may stay open after the leader's exit (a grandchild may hold them). */
const DRAIN_MS = 500;
/** Bound on the `git rev-parse HEAD` read of the verified head. */
const GIT_TIMEOUT_MS = 2000;
const SOURCE = Object.freeze({ provider: 'doflow-dispatch', capability: 'verify' });

interface Cleanup { status: 'verified' | 'survivors' | 'unknown'; reason: string | null }

interface VerificationRun {
  outputId: string; argvSha256: string; head: string | null;
  exitCode: number | null; timedOut: boolean; error: string | null;
  durationMs: number; evidenceId: string;
  cleanup: Cleanup | null;
}

/** sha256 hex over the canonical JSON of an argv (an array of strings has one JSON form). */
function argvDigest(argv: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

/** `env` without `REPO_ENV`'s names. */
function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of REPO_ENV) delete out[key];
  return out;
}

/** The worktree's HEAD commit, or null when git could not read it. */
function headOf(worktree: string, env: Record<string, string | undefined>): string | null {
  try {
    const out = execFileSync('git', ['-C', worktree, 'rev-parse', '--verify', '-q', 'HEAD'], {
      encoding: 'utf8', env, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

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

/**
 * IC-019: runs `argv` in `worktree` and records one `test-result` evidence item for `taskId` (the
 * task for a per-integration run, the slug for the final run) under `root`'s evidence store for
 * `slug`. `seconds` is the bound. `escalate` and `procStart` default to 081's and exist for tests.
 * Resolves a `VerificationRun`; a pass is `exitCode === 0 && !timedOut`.
 */
async function runVerification({
  root, slug, taskId, worktree, argv, argvSha256 = null, seconds, env = process.env, platform = process.platform,
  onSpawn = null, escalate = processTree.escalate, procStart = processTree.procStart, dispatchRunId = null,
}: any): Promise<VerificationRun> {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part: any) => typeof part === 'string' && part.length > 0)) {
    throw new TypeError('runVerification: argv must be a non-empty array of non-empty strings');
  }
  if (!Number.isInteger(seconds) || seconds <= 0) throw new TypeError(`runVerification: seconds must be a positive whole number: ${seconds}`);
  const digest = typeof argvSha256 === 'string' && argvSha256 ? argvSha256 : argvDigest(argv);
  const stateRoot = path.join(root, '.doflow', 'state');
  const outputId = newRunId();
  const envForChild = childEnv(env);
  const head = headOf(worktree, envForChild);
  const out = createOutputSink({ stateRoot, runId: outputId, stream: 'stdout' });
  const err = createOutputSink({ stateRoot, runId: outputId, stream: 'stderr' });
  const startedAt = Date.now();

  let exitCode: number | null = null;
  let error: string | null = null;
  let timedOut = false;
  let cleanup: Cleanup | null = null;

  let child: any = null;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: worktree, env: envForChild, detached: platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnError: any) {
    error = typeof spawnError?.code === 'string' && spawnError.code ? spawnError.code : 'spawn-failed';
  }

  if (child) {
    const settled: Promise<{ code: number | null; spawnError: string | null }> = new Promise((resolve) => {
      child.once('error', (e: any) => resolve({ code: null, spawnError: typeof e?.code === 'string' && e.code ? e.code : 'spawn-failed' }));
      child.once('exit', (code: number | null) => resolve({ code, spawnError: null }));
    });
    child.stdout.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.write(chunk));
    const streamsDone = Promise.all([drained(child.stdout), drained(child.stderr)]);

    let ending: Promise<void> = Promise.resolve();
    let timer: any = null;
    if (Number.isInteger(child.pid) && child.pid > 0) {
      const proc = { pid: child.pid, pgid: child.pid, start: platform === 'win32' ? null : procStart(child.pid) };
      timer = setTimeout(() => {
        timedOut = true;
        ending = Promise.resolve(escalate({ proc, platform })).then(
          (outcome: any) => { cleanup = { status: outcome?.status ?? 'unknown', reason: outcome?.reason ?? null }; },
          () => { cleanup = { status: 'unknown', reason: 'escalate-failed' }; },
        );
      }, seconds * 1000);
      if (onSpawn) {
        try {
          onSpawn({ ...proc });
        } catch (recordError) {
          // An unrecorded group could never be found by resume: end it now, then report the failure.
          clearTimeout(timer);
          child.stdout.resume();
          child.stderr.resume();
          await escalate({ proc, platform });
          await settled;
          child.stdout.destroy();
          child.stderr.destroy();
          await out.end();
          await err.end();
          throw recordError;
        }
      }
    }
    const result = await settled;
    clearTimeout(timer);
    await ending;
    if (result.spawnError) error = result.spawnError;
    else exitCode = result.code;
    await boundedWait(streamsDone, DRAIN_MS);
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const stdout = await out.end();
  await err.end();
  const durationMs = Date.now() - startedAt;
  // 088 C.1 (IC-006): one verify.run line, `source: dispatch`; it never throws and changes nothing here.
  emitVerifyTelemetry({
    report: { status: exitCode === 0 && !timedOut ? 'PASS' : 'FAIL', startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(startedAt + durationMs).toISOString(), tiers: [] },
    ctx: { source: 'dispatch', taskId, risk: null, exitCode, dispatchRun: dispatchRunId }, env, start: root,
  });

  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  const evidenceId = ledger.addEvidence({
    kind: 'test-result',
    provenance: 'extracted',
    source: { ...SOURCE },
    locator: { path: stdout.path },
    taskId,
    observation: { command: `verify sha256:${digest} argc:${argv.length}`, exitCode },
    establishes: [],
    freshness: { gitCommit: head },
  });
  ledger.save(taskId);

  return { outputId, argvSha256: digest, head, exitCode, timedOut, error, durationMs, evidenceId, cleanup };
}

/**
 * IC-032 lease rule: ends a recorded verification group `{ pid, pgid, start }` through 081's
 * `escalate`, with the recorded leader start, so a null start or a failed `ps` signals no group
 * (081 IC-021 step 3). Resolves `escalate`'s `{ status, reason, survivors, zombies }`.
 */
function endVerification(proc: any, { platform = process.platform, escalate = processTree.escalate }: any = {}) {
  return escalate({ proc: { pid: proc?.pid, pgid: proc?.pgid, start: proc?.start ?? null }, platform });
}

module.exports = { REPO_ENV, argvDigest, runVerification, endVerification };
