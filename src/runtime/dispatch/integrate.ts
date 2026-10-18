'use strict';

// Feature 082 B.4 (IC-016, IC-017, IC-018, IC-020, IC-021; DEC-004, DEC-014, DEC-022, DEC-023,
// DEC-036, DEC-049, DEC-050): integration.
//
// Worktrees. Every dispatch worktree lives under `<root>/.doflow/state/dispatch-worktrees/<id>`,
// made through `WorktreeManager` with a branch prefix per kind, a 120 s bound and an env without
// the repository variables (IC-016). The integration worktree (`p-` id, branch
// `doflow/<slug>/<p-id>`) is never removed here; it is handed to the user (DEC-004).
//
// Attempt commit (IC-017). The changed paths of an attempt worktree, filtered of the base pointer
// and of DoFlow's declared state stores, are staged into a temporary index on the attempt base and
// written as one commit `C` with parent `b` by `commit-tree`. The worktree's own index, branch and
// files are never touched. Identity is set in the child env only; git's settings are never read for
// it or changed, and no hook-skipping flag exists here (DEC-036).
//
// Integration (IC-018). One dispatch per call, under the store's lease: `cherry-pick --no-commit`
// of `C` on the integration HEAD, `write-tree`, `commit-tree` on the pre-integration head, then
// `update-ref` naming that head as the expected old value, so a concurrent move of the branch fails
// the update instead of being overwritten (DEC-050). Verification follows on the integrated HEAD
// (IC-019), then B.3's end rule finishes or releases the 080 attempt inside the dispatch lock.
// Undo is `reset --hard` to the pre-integration head, run only while the integration branch is
// checked out there and points at a head this integration made (IC-020).
//
// Locks. Each locked step is one `mutateDispatch`; its decide callback makes only the in-process
// 080 calls of `attempt-end.ts`. Git, the verification spawn and worktree removal all run between
// lock sections (IC-006). The 080 ledger is read before a section that checks staleness.
//
// This module runs git only inside DoFlow-owned worktrees and on refs under the two DoFlow branch
// prefixes; the worktree list of `root` is changed only through `WorktreeManager`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorktreeManager, BASE_FILE } = require('../worktree.ts');
const { storeRules, withoutDeclaredStores } = require('../worker/worktree-check.ts');
const { procStart } = require('../worker/process-tree.ts');
const { readTaskState } = require('../task-state.ts');
const { storeFileFor, mutateDispatch, readDispatch, transitionDispatch, setRunState, DispatchStoreError } = require('./store.ts');
const { REPO_ENV, runVerification } = require('./verify-run.ts');
const { endAttempt, completeAttempt, releaseAttempt, usageFor } = require('./attempt-end.ts');

const WORKTREES_DIR = path.join('.doflow', 'state', 'dispatch-worktrees');
/** Bound on a git call that writes (IC-016). */
const WRITE_TIMEOUT_MS = 120000;
/** Bound on a read-only git call (IC-016). */
const READ_TIMEOUT_MS = 10000;
/** The identity every commit this module makes carries, set in the child env only (DEC-036). */
const DISPATCH_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'DoFlow dispatch',
  GIT_AUTHOR_EMAIL: 'dispatch@doflow.invalid',
  GIT_COMMITTER_NAME: 'DoFlow dispatch',
  GIT_COMMITTER_EMAIL: 'dispatch@doflow.invalid',
});
const TEMP_INDEX = 'index.doflow-dispatch';
const SHA = /^[0-9a-f]{40,64}$/;
/** Dispositions whose worktree is removed once its worker cleanup is verified, or it had no worker (IC-021). */
const RELEASED_ENDS = Object.freeze(['cancelled', 'taken-over', 'stale', 'interrupted', 'released']);
/** Run states after which a failed attempt's kept worktree is removed (IC-021). */
const RUN_ENDS = Object.freeze(['completed', 'cancelled']);

type Env = Record<string, string | undefined>;

/** A git failure in this module's contract: `reason` a fixed token, `exitCode` git's exit status. */
class IntegrationError extends Error {
  declare code: string;
  declare reason: string;
  declare exitCode: string | null;
  constructor(reason: string, exitCode: string | null = null) {
    super(`integration-error: ${reason}${exitCode === null ? '' : ` (git exit ${exitCode})`}`);
    this.name = 'IntegrationError';
    this.code = 'integration-error';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

/** `env` without the variables that would point git at another repository (081 `REPO_ENV`). */
function gitEnv(env: Env = process.env, extra: Env = {}): Env {
  const out: Env = { ...env };
  for (const key of REPO_ENV) delete out[key];
  return { ...out, ...extra };
}

function readEnv(env: Env): Env {
  return gitEnv(env, { GIT_OPTIONAL_LOCKS: '0' });
}

/** One bounded `git -C <cwd>` call. Never throws: `{ ok, status, stdout }`, `status` the exit code
 * as a string, else the signal or spawn error code. */
function runGit(cwd: string, args: string[], { env, timeout, input }: { env: Env; timeout: number; input?: string }) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    env, timeout, encoding: 'utf8', input: input ?? '', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const status = r.status ?? r.signal ?? (r.error as any)?.code ?? 'unknown';
  return { ok: r.status === 0 && !r.error, status: String(status), stdout: r.stdout || '' };
}

const readGit = (cwd: string, args: string[], env: Env) => runGit(cwd, args, { env: readEnv(env), timeout: READ_TIMEOUT_MS });

/** stdout of a git call that must succeed, trimmed, else an IntegrationError naming `reason`. */
function must(res: { ok: boolean; status: string; stdout: string }, reason: string): string {
  if (!res.ok) throw new IntegrationError(reason, res.status);
  return res.stdout.trim();
}

function sha(res: { ok: boolean; status: string; stdout: string }, reason: string): string {
  const out = must(res, reason);
  if (!SHA.test(out)) throw new IntegrationError(reason, res.status);
  return out;
}

// ── worktrees (IC-016) ───────────────────────────────────────────────────────────────────────────

function worktreesDir(root: string): string {
  return path.join(root, WORKTREES_DIR);
}

/** The manager for one worktree kind: `doflow/<slug>/` for integration, `doflow-attempt/<slug>/` for
 * attempt and child worktrees. */
function managerFor(root: string, slug: string, kind: 'integration' | 'attempt', env: Env = process.env) {
  const prefix = kind === 'integration' ? `doflow/${slug}/` : `doflow-attempt/${slug}/`;
  return new WorktreeManager(root, worktreesDir(root), { branchPrefix: prefix, timeoutMs: WRITE_TIMEOUT_MS, env: gitEnv(env) });
}

function created(manager: any, id: string, base: string) {
  if (typeof base !== 'string' || !SHA.test(base)) throw new DispatchStoreError('usage', `worktree base '${base}' is not a commit id`);
  const worktree = manager.create(id, base);
  return { worktree, branch: manager.branchFor(id), base };
}

/** IC-016: the run's integration worktree `p-<id>` on `doflow/<slug>/<p-id>`, cut from `base`
 * (the caller's HEAD at start; read from `root` when omitted). `head` starts at the base. */
function createIntegrationWorktree({ root, slug, dispatchRunId, base = null, env = process.env }: any) {
  const from = base ?? sha(readGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], env), 'head-unreadable');
  const made = created(managerFor(root, slug, 'integration', env), dispatchRunId, from);
  return { ...made, head: from };
}

/** IC-016: the attempt worktree `d-<id>` on `doflow-attempt/<slug>/<d-id>`, cut from `base` (the
 * integration HEAD recorded in the admitted slot). */
function createAttemptWorktree({ root, slug, dispatchId, base, env = process.env }: any) {
  return created(managerFor(root, slug, 'attempt', env), dispatchId, base);
}

/** IC-016: the child worktree `<d-id>.c<n>`, cut from the granter's attempt base. */
function createChildWorktree({ root, slug, dispatchId, n, base, env = process.env }: any) {
  if (!Number.isInteger(n) || n < 1) throw new DispatchStoreError('usage', `child number '${n}' is not a positive whole number`);
  return created(managerFor(root, slug, 'attempt', env), `${dispatchId}.c${n}`, base);
}

// ── change lists ─────────────────────────────────────────────────────────────────────────────────

/** IC-011: `git diff --name-status -z -M a b` in `cwd` as `[{ path, change, from }]`, `change` the
 * status letter without its score. */
function diffNameStatus(a: string, b: string, { cwd, env = process.env }: { cwd: string; env?: Env }) {
  const out = must(readGit(cwd, ['diff', '--name-status', '-z', '-M', a, b], env), 'diff-failed');
  const fields = out.split('\0').filter((f) => f !== '');
  const changes: { path: string; change: string; from: string | null }[] = [];
  let i = 0;
  while (i < fields.length) {
    const change = fields[i][0];
    const renamed = change === 'R' || change === 'C';
    changes.splice(changes.length, 0, renamed
      ? { path: fields[i + 2], change, from: fields[i + 1] }
      : { path: fields[i + 1], change, from: null });
    i += renamed ? 3 : 2;
  }
  return changes;
}

function nulList(text: string): string[] {
  return text.split('\0').filter((f) => f !== '');
}

/** IC-017 step 1: changed and untracked paths of `worktree` against `base`, less the base pointer
 * and every path under a declared DoFlow state store. */
function attemptPaths(worktree: string, base: string, env: Env): string[] {
  const tracked = nulList(must(readGit(worktree, ['diff', '--name-only', '-z', '--no-renames', base], env), 'diff-failed'));
  const untracked = nulList(must(readGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], env), 'ls-files-failed'));
  const rules = storeRules();
  if (rules === null) throw new IntegrationError('storage-registry-unreadable');
  const entries: Record<string, string> = {};
  for (const rel of [...tracked, ...untracked]) if (rel !== BASE_FILE) entries[rel] = '';
  return Object.keys(withoutDeclaredStores(entries, rules)).sort();
}

/**
 * IC-017: one commit `C` with the single parent `base` holding the attempt's changes, or
 * `commit: null` for an empty change (DEC-049). `changes` is `diffNameStatus(base, C)`. Throws an
 * IntegrationError for a git failure.
 */
function attemptCommit({ worktree, base, dispatchId, task, token, env = process.env }: any) {
  if (typeof base !== 'string' || !SHA.test(base)) throw new DispatchStoreError('usage', `attempt base '${base}' is not a commit id`);
  const paths = attemptPaths(worktree, base, env);
  if (paths.length === 0) return { base, commit: null, changes: [] };

  const indexPath = path.resolve(worktree, must(readGit(worktree, ['rev-parse', '--git-path', TEMP_INDEX], env), 'git-path-failed'));
  const writeEnv = gitEnv(env, { ...DISPATCH_IDENTITY, GIT_INDEX_FILE: indexPath, GIT_LITERAL_PATHSPECS: '1' });
  const write = (args: string[], reason: string, input?: string) => must(runGit(worktree, args, { env: writeEnv, timeout: WRITE_TIMEOUT_MS, input }), reason);
  let commit: string | null = null;
  try {
    fs.rmSync(indexPath, { force: true });
    write(['read-tree', base], 'read-tree-failed');
    write(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], 'add-failed', `${paths.join('\0')}\0`);
    const tree = write(['write-tree'], 'write-tree-failed');
    const baseTree = sha(readGit(worktree, ['rev-parse', `${base}^{tree}`], env), 'rev-parse-failed');
    if (tree !== baseTree) {
      commit = write(['commit-tree', tree, '-p', base, '-m', `dispatch ${dispatchId} task ${task} token ${token}`], 'commit-tree-failed');
      if (!SHA.test(commit)) throw new IntegrationError('commit-tree-failed');
    }
  } finally {
    fs.rmSync(indexPath, { force: true });
  }
  if (commit === null) return { base, commit: null, changes: [] };
  return { base, commit, changes: diffNameStatus(base, commit, { cwd: worktree, env }) };
}

// ── integration worktree checks and undo (IC-018 step 2, IC-020) ─────────────────────────────────

/** IC-018 step 2: the integration worktree is on its branch at `preHead` and lists nothing but the
 * base pointer. `{ clean, reason, paths }`. */
function integrationClean({ worktree, branch, preHead, env = process.env }: any) {
  const ref = readGit(worktree, ['symbolic-ref', '-q', 'HEAD'], env);
  if (!ref.ok || ref.stdout.trim() !== `refs/heads/${branch}`) return { clean: false, reason: 'not-integration-branch', paths: 0 };
  const head = readGit(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], env);
  if (!head.ok || head.stdout.trim() !== preHead) return { clean: false, reason: 'head-moved', paths: 0 };
  const status = readGit(worktree, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], env);
  if (!status.ok) return { clean: false, reason: 'status-failed', paths: 0 };
  const listed = nulList(status.stdout).filter((f) => f.length > 3 && f.slice(3) !== BASE_FILE);
  return listed.length ? { clean: false, reason: 'dirty', paths: listed.length } : { clean: true, reason: null, paths: 0 };
}

/**
 * IC-020: resets the integration worktree to `preHead`. Nothing runs unless HEAD is the run's
 * integration branch (`not-integration-branch`) and points at `preHead` or at `pickedHead`, the
 * commit this integration made (`head-moved`: another writer moved it, and resetting would
 * overwrite that move). After the reset, HEAD must equal `preHead` and status list nothing but the
 * base pointer, else `undo-failed`. `{ ok, ran, reason, exitCode }`.
 */
function undo({ worktree, branch, preHead, pickedHead = null, env = process.env }: any) {
  const ref = readGit(worktree, ['symbolic-ref', '-q', 'HEAD'], env);
  if (!ref.ok || ref.stdout.trim() !== `refs/heads/${branch}`) return { ok: false, ran: false, reason: 'not-integration-branch', exitCode: null };
  const head = readGit(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], env).stdout.trim();
  if (head !== preHead && (pickedHead === null || head !== pickedHead)) return { ok: false, ran: false, reason: 'head-moved', exitCode: null };
  const reset = runGit(worktree, ['reset', '-q', '--hard', preHead], { env: gitEnv(env), timeout: WRITE_TIMEOUT_MS });
  const after = integrationClean({ worktree, branch, preHead, env });
  if (!reset.ok || !after.clean) return { ok: false, ran: true, reason: 'undo-failed', exitCode: reset.ok ? null : reset.status };
  return { ok: true, ran: true, reason: null, exitCode: null };
}

// ── staleness (IC-023, read before the lock) ─────────────────────────────────────────────────────

/** IC-023's stale reason for `dispatch` against an 080 ledger read just before, or null. */
function staleReason(dispatch: any, ledger: any, runKey: string | null): string | null {
  const entry = ledger && ledger.tasks ? ledger.tasks[dispatch.task] : null;
  const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
  const attempt = attempts.find((a) => a.token === dispatch.token);
  if (!attempt) return 'token-mismatch';
  if (attempt.state === 'cancelled') return 'attempt-cancelled';
  if (attempt.state !== 'active') return 'attempt-ended';
  const run = ledger.runs && runKey && Object.hasOwn(ledger.runs, runKey) ? ledger.runs[runKey] : null;
  if (run && Number.isInteger(dispatch.epoch) && run.epoch !== dispatch.epoch) return 'epoch';
  return null;
}

function readLedger(ctx: any): any {
  return readTaskState(ctx.fsImpl || fs, ctx.ledgerFile) || { tasks: {}, runs: {} };
}

/** Whether `ledger` holds `(task, token)`'s 080 attempt `active`. */
function activeAttempt(ledger: any, task: string, token: number): boolean {
  const entry = ledger && ledger.tasks ? ledger.tasks[task] : null;
  return Boolean(entry && Array.isArray(entry.attempts) && entry.attempts.some((a: any) => a.token === token && a.state === 'active'));
}

// ── IC-018 ───────────────────────────────────────────────────────────────────────────────────────

const INTEGRABLE_RUN_STATES = Object.freeze(['running', 'blocked']);
/** IC-030 step 3: the run states a cancel has marked. */
const CANCEL_MARKED = Object.freeze(['cancelling', 'cancelled']);

function oldestCollected(store: any): any {
  const ready = (Object.values(store.dispatches) as any[]).filter((d) => d.phase === 'collected' && d.outcome === 'offered');
  ready.sort((a, b) => String(a.collectedAt ?? '').localeCompare(String(b.collectedAt ?? ''))
    || String(a.admittedAt ?? '').localeCompare(String(b.admittedAt ?? '')) || a.dispatchId.localeCompare(b.dispatchId));
  return ready[0] ?? null;
}

/** Records an integration gap and blocks the run, unless the run holds a state another writer owns
 * (a cancel's, a lost driver's `resume-required`, IC-009): the gap is still recorded, the state is not moved. */
function blockRun(store: any, gap: any): void {
  setRunState(store, 'blocked');
  store.run.integrationGap = { cause: 'no-progress', blocks: [], ...gap };
}

/** Ends a stale dispatch in the decide callback: release while its attempt is active (the epoch
 * case), else end it with no 080 call, the attempt having ended outside the loop. */
function endStale(store: any, dispatch: any, reason: string, ctx: any, now: Date) {
  const usage = usageFor(dispatch, null, []);
  if (reason === 'epoch') {
    return releaseAttempt({ store, dispatchId: dispatch.dispatchId, reason: `stale:${reason}`, disposition: 'stale', usage, ctx });
  }
  Object.assign(dispatch, { phase: 'ended', disposition: 'stale', staleReason: reason, endedAt: now.toISOString(), usage });
  return { write: true, result: { ended: true, dispatchId: dispatch.dispatchId, disposition: 'stale' } };
}

/**
 * IC-018, steps 1 to 6 (`integrateNext` without the cleanup), for the oldest offered `collected` dispatch of `slug`'s store under `root`.
 * `ctx` is B.3's 080 context (`ledgerFile`, `roots`, `slug`, `env`, `cwd`, `fsImpl`, `now`); `env`
 * is the environment git and the verification inherit, less the repository variables. `holder` is
 * the lease holder `{ pid, start }` (this process by default). `beforeUpdateRef` is a test seam
 * called between `commit-tree` and `update-ref`, and `afterLease` one called between steps 1 and 2;
 * the loop passes neither.
 *
 * Resolves `{ outcome, dispatchId, task, token, ... }`, `outcome` one of `none`, `not-running`,
 * `lease-held`, `stale`, `integration-dirty`, `conflict`, `integration-error`, `verification`,
 * `finish-refused`, `completed`, or `lastError` when an 080 call threw or refused.
 */
async function integrateOnce({
  root, slug, ctx, env = process.env, holder = null, now = () => new Date(), beforeUpdateRef = null, afterLease = null,
  storeFile = null, verify = runVerification, dispatchRunId = null,
}: any) {
  const file = storeFile ?? storeFileFor(root, slug);
  const lockCtx = () => ({ ...ctx, now: now() });

  // Step 1, in the lock, on the 080 ledger read just before.
  const ledger = readLedger(ctx);
  const lessee = holder ?? { pid: process.pid, start: procStart(process.pid) };
  const taken = mutateDispatch(file, (store: any) => {
    const run = store.run;
    if (!run || !run.integration || !INTEGRABLE_RUN_STATES.includes(run.state)) return { write: false, result: { outcome: 'not-running', state: run ? run.state : null } };
    if (store.lease) return { write: false, result: { outcome: 'lease-held', dispatchId: store.lease.dispatchId } };
    const dispatch = oldestCollected(store);
    if (!dispatch) return { write: false, result: { outcome: 'none' } };
    const reason = staleReason(dispatch, ledger, dispatch.parentRunKey ?? run.runKey ?? null);
    if (reason) {
      const ended = endStale(store, dispatch, reason, lockCtx(), now());
      return { write: ended.write, result: { outcome: ended.result.ended ? 'stale' : 'lastError', staleReason: reason, dispatchId: dispatch.dispatchId, end: ended.result } };
    }
    store.lease = { holder: { pid: lessee.pid, start: lessee.start ?? null }, dispatchId: dispatch.dispatchId, preHead: run.integration.head, takenAt: now().toISOString() };
    dispatch.phase = 'integrating';
    return {
      write: true,
      result: {
        outcome: 'taken', dispatch: structuredClone(dispatch), integration: structuredClone(run.integration),
        verify: run.verify ? structuredClone(run.verify) : null,
        dispatchRunId: run.dispatchRunId ?? null,
      },
    };
  });
  if (taken.outcome !== 'taken') return taken;

  const { dispatch, integration, verify: declared } = taken;
  const { dispatchId, task, token } = dispatch;
  const preHead: string = integration.head;
  const where = { worktree: integration.worktree, branch: integration.branch, env };
  const base = { dispatchId, task, token };

  /** One locked write that clears the lease after `apply(store, dispatch)`, only while the lease is
   * still this dispatch's and the dispatch still `integrating` (RT-11). Otherwise a cancel or resume
   * settled this integration meanwhile: only `evidence(store)` (the verification record) is written,
   * so another lease is never cleared and an ended dispatch never edited. */
  const settle = (apply: (store: any, d: any) => any, evidence: ((store: any) => void) | null = null) => mutateDispatch(file, (store: any) => {
    const d = store.dispatches[dispatchId];
    if (!store.lease || store.lease.dispatchId !== dispatchId || !d || d.phase !== 'integrating') {
      const lost = { ...base, outcome: 'lease-lost', lease: store.lease ? store.lease.dispatchId : null, phase: d ? d.phase : null };
      if (!evidence) return { write: false, result: lost };
      evidence(store);
      return { write: true, result: lost };
    }
    const result = apply(store, d);
    store.lease = null;
    return { write: true, result };
  });
  /** IC-020 undo, then one locked write releasing the attempt, ending it `released` and blocking the
   * run `integration-error`. */
  const releaseWithError = (reason: string, exitCode: string | null, pickedHead: string | null) => {
    const undone = undo({ ...where, preHead, pickedHead });
    return settle((store, d) => {
      const end = releaseAttempt({ store, dispatchId, reason: 'integration-error', usage: usageFor(d, null, []), ctx: lockCtx() });
      // A release 080 threw or refused on a still-active attempt keeps `lastError` and the dispatch
      // live, back at `collected` with the lease cleared (IC-024, RT-9); one refused because the
      // attempt already ended outside the loop still ends the dispatch.
      if (!end.result.ended && d.phase === 'integrating' && activeAttempt(readLedger(ctx), task, token)) d.phase = 'collected';
      else if (d.phase !== 'ended') Object.assign(d, { phase: 'ended', disposition: 'released', endedAt: now().toISOString(), releaseReason: 'integration-error' });
      blockRun(store, { task, kind: 'integration-error', reason, exitCode, ...(undone.ok ? {} : { undo: undone.reason, undoFailed: true }) });
      return { ...base, outcome: 'integration-error', reason, exitCode, undo: undone, end: end.result };
    });
  };
  /** After a failed 080 end (thrown or refused, `lastError` recorded), the dispatch goes back to
   * `collected` so the next pass retries it (IC-024), unless no pass will: its attempt is no longer
   * active (stale, IC-023) or a cancel marked the run (IC-030 step 6). Then the dispatch ends here,
   * `stale` or `released`, so a cancelled run holds no non-ended dispatch. Read in the lock. */
  const retryLater = (store: any, d: any, end: any = null) => {
    if ((end && end.result.ended) || d.phase === 'ended') return;
    const stale = staleReason(d, readLedger(ctx), d.parentRunKey ?? store.run.runKey ?? null);
    if (stale) {
      endStale(store, d, stale, lockCtx(), now());
      if (d.phase === 'ended') return;
    }
    if (CANCEL_MARKED.includes(store.run.state)) {
      const released = releaseAttempt({ store, dispatchId, reason: `cancelled: ${store.run.state}`, usage: usageFor(d, null, []), ctx: lockCtx() });
      if (!released.result.ended && d.phase !== 'ended') Object.assign(d, { phase: 'ended', disposition: 'released', endedAt: now().toISOString(), releaseReason: 'run-cancelled' });
      return;
    }
    d.phase = 'collected';
  };

  // RT-5: a throw from steps 2 to 6 (a git spawn, the verification, a store write) must not strand
  // the lease under a driver that then ends cleanly. The catch undoes this integration and returns
  // the dispatch to `collected` with the lease cleared, when HEAD allows it (IC-020), then rethrows;
  // the pass records the throw and the run becomes `resume-required` (IC-009).
  let pickedHead: string | null = null;
  try {
    // Step 2, outside: the integration worktree is on its branch at preHead and clean.
    if (afterLease) await afterLease({ dispatchId, worktree: integration.worktree, preHead });
    const check = integrationClean({ ...where, preHead });
    if (!check.clean) {
      return settle((store, d) => {
        retryLater(store, d);
        blockRun(store, { task, kind: 'integration-dirty', reason: check.reason, paths: check.paths });
        return { ...base, outcome: 'integration-dirty', reason: check.reason, paths: check.paths };
      });
    }

    // Steps 3 and 4, outside: the pick, unless the change is empty (DEC-049).
    if (dispatch.commit) {
      const pick = runGit(integration.worktree, ['cherry-pick', '--no-commit', dispatch.commit], { env: gitEnv(env, DISPATCH_IDENTITY), timeout: WRITE_TIMEOUT_MS });
      if (!pick.ok) {
        const conflicted = nulList(readGit(integration.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'], env).stdout);
        if (conflicted.length === 0) return releaseWithError('cherry-pick-failed', pick.status, null);
        const undone = undo({ ...where, preHead });
        return settle((store, d) => {
          const end = endAttempt({ store, dispatchId, failureClass: 'conflict', detail: `${conflicted.length} conflicted path(s)`, usage: usageFor(d, null, []), ctx: lockCtx() });
          retryLater(store, d, end);
          if (!undone.ok) blockRun(store, { task, kind: 'integration-error', reason: undone.reason, exitCode: undone.exitCode, undoFailed: true });
          return { ...base, outcome: 'conflict', conflicted: conflicted.length, undo: undone, end: end.result };
        });
      }
      const identityEnv = gitEnv(env, DISPATCH_IDENTITY);
      const tree = runGit(integration.worktree, ['write-tree'], { env: identityEnv, timeout: WRITE_TIMEOUT_MS });
      const preTree = readGit(integration.worktree, ['rev-parse', `${preHead}^{tree}`], env);
      if (!tree.ok || !preTree.ok) return releaseWithError('write-tree-failed', tree.ok ? preTree.status : tree.status, null);
      if (tree.stdout.trim() !== preTree.stdout.trim()) {
        const made = runGit(integration.worktree, ['commit-tree', tree.stdout.trim(), '-p', preHead, '-m', `${task}: dispatch ${dispatchId} token ${token}`], { env: identityEnv, timeout: WRITE_TIMEOUT_MS });
        const commit = made.stdout.trim();
        if (!made.ok || !SHA.test(commit)) return releaseWithError('commit-tree-failed', made.status, null);
        if (beforeUpdateRef) await beforeUpdateRef({ worktree: integration.worktree, branch: integration.branch, preHead, commit });
        const moved = runGit(integration.worktree, ['update-ref', `refs/heads/${integration.branch}`, commit, preHead], { env: identityEnv, timeout: WRITE_TIMEOUT_MS });
        if (!moved.ok) return releaseWithError('update-ref-failed', moved.status, null);
        pickedHead = commit;
        mutateDispatch(file, (store: any) => {
          if (!store.lease || store.lease.dispatchId !== dispatchId) return { write: false, result: null };
          store.lease.pickedHead = commit;
          return { write: true, result: null };
        });
      }
    }

    // Step 5, outside: verification on the integration HEAD.
    if (!declared || !Array.isArray(declared.argv)) return releaseWithError('verification-undeclared', null, pickedHead);
    const verification = await verify({
      root, slug, taskId: task, worktree: integration.worktree, argv: declared.argv, argvSha256: declared.argvSha256 ?? null,
      seconds: declared.timeoutSeconds, env,
      dispatchRunId: dispatchRunId ?? taken.dispatchRunId ?? null,
      onSpawn: (proc: any) => mutateDispatch(file, (store: any) => {
        store.run.verifying = proc;
        return { write: true, result: null };
      }),
    });
    const passed = verification.exitCode === 0 && verification.timedOut === false;
    const record = (store: any) => {
      store.run.verifying = null;
      store.run.verifications = [...(Array.isArray(store.run.verifications) ? store.run.verifications : []), verification];
    };

    // Step 6, in the lock.
    if (!passed) {
      const undone = undo({ ...where, preHead, pickedHead });
      return settle((store, d) => {
        record(store);
        const end = endAttempt({ store, dispatchId, failureClass: 'verification', detail: verification.timedOut ? 'timed out' : `exit ${verification.exitCode ?? verification.error}`, usage: usageFor(d, null, []), evidenceId: verification.evidenceId, ctx: lockCtx() });
        retryLater(store, d, end);
        if (!undone.ok) blockRun(store, { task, kind: 'integration-error', reason: undone.reason, exitCode: undone.exitCode, undoFailed: true });
        return { ...base, outcome: 'verification', verification, undo: undone, end: end.result };
      }, record);
    }

    const after = readLedger(ctx);
    const finished = mutateDispatch(file, (store: any) => {
      const d = store.dispatches[dispatchId];
      record(store);
      const stale = staleReason(d, after, d.parentRunKey ?? store.run.runKey ?? null);
      const end = stale ? null : completeAttempt({ store, dispatchId, evidenceId: verification.evidenceId, usage: usageFor(d, null, []), integratedCommit: pickedHead, ctx: lockCtx() });
      if (end && end.result.ended) {
        store.run.integration.head = pickedHead ?? preHead;
        store.run.integrationGap = null;
        store.lease = null;
        return { write: true, result: { ...base, outcome: 'completed', integratedCommit: pickedHead, head: pickedHead ?? preHead, verification, end: end.result } };
      }
      if (store.lease) store.lease.undoPending = true;
      const why = stale ? `stale:${stale}` : (end.result.reason || end.result.outcome || 'refused');
      return { write: true, result: { outcome: 'refused', why } };
    });
    if (finished.outcome === 'completed') return finished;

    const undone = undo({ ...where, preHead, pickedHead });
    return settle((store, d) => {
      const reason = `finish-refused:${finished.why}`;
      let end: any = null;
      if (after.tasks?.[task]?.attempts?.find((a: any) => a.token === token)?.state === 'active') {
        end = releaseAttempt({ store, dispatchId, reason, usage: usageFor(d, null, []), ctx: lockCtx() }).result;
      }
      if (d.phase !== 'ended') Object.assign(d, { phase: 'ended', disposition: 'released', endedAt: now().toISOString(), releaseReason: reason });
      if (!undone.ok) blockRun(store, { task, kind: 'integration-error', reason: undone.reason, exitCode: undone.exitCode, undoFailed: true });
      return { ...base, outcome: 'finish-refused', reason, verification, undo: undone, end };
    });
  } catch (error) {
    try {
      const held = readDispatch(file).lease;
      // RR-2: an attempt 080 already finished COMPLETED (a store write that threw after the finish
      // applied) keeps its commit; the lease stays for IC-032's lease rule, which adopts it.
      const attempt = readLedger(ctx).tasks?.[task]?.attempts?.find((a: any) => a.token === token);
      const completed = Boolean(attempt && attempt.state === 'finished' && attempt.result === 'COMPLETED');
      if (held && held.dispatchId === dispatchId && !completed) {
        const undone = undo({ ...where, preHead, pickedHead: held.pickedHead ?? pickedHead });
        if (undone.ok) {
          mutateDispatch(file, (store: any) => {
            if (!store.lease || store.lease.dispatchId !== dispatchId) return { write: false, result: null };
            store.lease = null;
            const d = store.dispatches[dispatchId];
            if (d && d.phase === 'integrating') d.phase = 'collected';
            return { write: true, result: null };
          });
        }
      }
    } catch {
      // The lease stays for IC-032's lease rule; the original throw is the one reported.
    }
    throw error;
  }
}

/**
 * IC-018 for one dispatch (`integrateOnce`), then IC-021's cleanup rule for the dispatch it ended:
 * a completed one's attempt worktree is removed, a failed one kept (`removal`).
 */
async function integrateNext(options: any) {
  const result = await integrateOnce(options);
  if (!result || typeof result.dispatchId !== 'string' || !result.outcome || ['lease-held', 'integration-dirty'].includes(result.outcome)) return result;
  const file = options.storeFile ?? storeFileFor(options.root, options.slug);
  const dispatch = readDispatch(file).dispatches[result.dispatchId];
  if (!dispatch || dispatch.phase !== 'ended') return result;
  const removal = await removeDispatchWorktree({ root: options.root, slug: options.slug, dispatchId: result.dispatchId, env: options.env, storeFile: file });
  return { ...result, removal };
}

// ── cleanup (IC-021) ─────────────────────────────────────────────────────────────────────────────

/** IC-021's table: whether `dispatch`'s attempt worktree is removed now, and why it is kept if not. */
function removalDue(dispatch: any, run: any): { due: boolean; reason: string | null } {
  if (dispatch.phase !== 'ended') return { due: false, reason: 'not-ended' };
  if (dispatch.removal && dispatch.removal.verified === true) return { due: false, reason: 'removed' };
  // IC-021's last row covers every disposition: a worker run's worktree waits for verified cleanup (RT-8).
  if (dispatch.workerRunId) {
    const cleanup = dispatch.cleanup ? dispatch.cleanup.cleanup ?? dispatch.cleanup : null;
    if (!cleanup || cleanup.status !== 'verified') return { due: false, reason: 'worker-cleanup-unverified' };
  }
  if (dispatch.disposition === 'completed') return { due: true, reason: null };
  if (RELEASED_ENDS.includes(dispatch.disposition)) return { due: true, reason: null };
  if (dispatch.disposition === 'failed') {
    return run && RUN_ENDS.includes(run.state) ? { due: true, reason: null } : { due: false, reason: 'failed-kept' };
  }
  return { due: false, reason: 'unknown-disposition' };
}

/**
 * IC-021: removes an ended dispatch's attempt worktree when the table says so, then stores the
 * `Removal` add-only on the dispatch (`verified` may only move from false to true). The removal runs
 * outside every lock. Resolves `{ removed, kept, reason, removal }`.
 */
async function removeDispatchWorktree({ root, slug, dispatchId, env = process.env, storeFile = null }: any) {
  const file = storeFile ?? storeFileFor(root, slug);
  const current = readDispatch(file);
  const dispatch = current.dispatches[dispatchId];
  if (!dispatch) return { removed: false, kept: false, reason: 'unknown-dispatch', removal: null };
  const due = removalDue(dispatch, current.run);
  if (!due.due) return { removed: false, kept: due.reason !== 'removed', reason: due.reason, removal: dispatch.removal ?? null };
  const removal = managerFor(root, slug, 'attempt', env).removeVerified(dispatchId);
  const stored = transitionDispatch(file, dispatchId, ['ended'], (d: any) => {
    if (!d.removal || (d.removal.verified === false && removal.verified)) d.removal = removal;
  });
  return { removed: removal.verified, kept: !removal.verified, reason: removal.verified ? null : 'removal-unverified', removal, stored: stored.applied };
}

module.exports = {
  WORKTREES_DIR,
  WRITE_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  DISPATCH_IDENTITY,
  IntegrationError,
  gitEnv,
  managerFor,
  createIntegrationWorktree,
  createAttemptWorktree,
  createChildWorktree,
  diffNameStatus,
  attemptCommit,
  integrationClean,
  integrateNext,
  undo,
  staleReason,
  activeAttempt,
  removalDue,
  removeDispatchWorktree,
};
