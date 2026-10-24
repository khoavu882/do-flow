'use strict';

// Feature 081 C.3 (IC-011, IC-017 view, IC-019, IC-025; DEC-005, DEC-025, DEC-032, DEC-036,
// DEC-038, DEC-042, DEC-054): the `worker` verb's handler.
//
// `handleWorkerCommand` validates IC-025's flags per action (a flag on an action that does not take
// it is exit 2 `usage`), runs the action and maps its disposition to the exit contract: 0 for
// `discovered`, `probed`, `described`, `selected`, `started`, `cancelled`, `status` and `recorded`; 1 with the
// JSON for `refused` and `none-eligible`; 2 with `{ ok: false, error }` for `usage`,
// `store-unreadable` and `registry-invalid`.
//
// Run is IC-011: steps 0 to 11 read without a lock, step 12 inserts the run inside the run store's
// lock, then the detached supervisor is spawned with the caller's own environment and cwd, and its
// pid and start are written by compare-and-set. The record carries the full worker block as
// `descriptor` (DEC-054), so the supervisor launches with no registry and tests inject descriptors
// in process (DEC-036). The 080 ledger is only read: run never claims, finishes, releases or reports
// usage (DEC-005). Status is IC-019 and writes nothing (DEC-025); cancel is C.1's `cancelRun` with
// this process's own `env` and `cwd` (DEC-038).
//
// 082 amends run in two ways. `--edit` (IC-014, DEC-020, DEC-021, DEC-048): after step 8 the
// execution worktree must be a dispatch attempt worktree on its `doflow-attempt/<slug>/<d-id>`
// branch whose `.doflow-worktree-base` is an ancestor of its HEAD; step 11 uses the edit baseline;
// the record gains `edit: { base, branch, callerTop }`; the supervisor launches the edit recipe and
// records `isolation`. `--child-of <w-id>` (IC-015, DEC-028, DEC-041, DEC-062): a read-only child
// of a live granter run on the same `(task, token)`, in its own `<granter d-id>.c<n>` worktree,
// always run-scoped, unique on `(task, token, childOf, request)`; `--request` must be the child
// worktree's basename and, under a dispatch run, a `requested` spawn request of the granter's
// dispatch (read through dispatch/store.ts's `readDispatch`); status and cancel by
// `--task --token` keep naming the granter, and cancelling a child never cancels the 080 attempt.
//
// This module makes no fs write call: the run store is written through `insertRun` and
// `transition`, the probe record by readiness, the ledger only by 080's cancel (G26 (b), IC-027).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const readiness = require('./readiness.ts');
const { activeWorkers, workerGate } = require('./active.ts');
const { readBindings } = require('./models.ts');
const { workerCatalogue } = require('./catalogue.ts');
const { storeFileFor, newRunId, insertRun, transition, readRuns, RUN_ID } = require('./run-store.ts');
const evidence = require('./evidence.ts');
const { launchEnv, launchRecord, PROMPT_LIMITS } = require('./launch.ts');
const { BASE_FILE } = require('../worktree.ts');
const { SUPERVISOR_FILE, resultOfRun } = require('./supervisor.ts');
const { cancelRun } = require('./cancel.ts');
const processTree = require('./process-tree.ts');
const attempts = require('../task-attempts.ts');
const { runKeyFor, identityRefusal } = require('../task-run.ts');
const { readTaskState } = require('../task-state.ts');
const { findWorkTreeTop } = require('../source-version.ts');
const { projectRoot: lifecycleProjectRoot } = require('../lifecycle/root.ts');
const { isSafeSlug } = require('../task-scope.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { readDispatch, storeFileFor: dispatchStoreFileFor } = require('../dispatch/store.ts');

const ACTIONS = Object.freeze(['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel', 'evidence']);
/** IC-025: the dispositions that exit 0; `refused` and `none-eligible` exit 1. */
const EXIT_ZERO = Object.freeze(['discovered', 'probed', 'described', 'selected', 'started', 'cancelled', 'status', 'recorded']);
const ERROR_CODES = Object.freeze(['usage', 'store-unreadable', 'registry-invalid']);
const TASK_ID = /^[A-Za-z]+\.\d+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const DIGITS = /^[0-9]+$/;
/** 078 `ATTEMPT_PATTERN`'s ceiling (IC-011 step 6). */
const TOKEN_MAX = 9999;
const TIMEOUT_DEFAULT_SECONDS = 1800;
const TIMEOUT_MAX_SECONDS = 14400;
/** IC-011: how long run waits for the record to leave `starting`, and the poll intervals. */
const START_WAIT_MS = 10000;
const START_POLL_MS = 100;
const WAIT_POLL_MS = 500;
const WAIT_GRACE_MS = 10000;
/** 082 IC-014 / IC-015: where dispatch worktrees live, an attempt's name and a spawn request id. */
const DISPATCH_WORKTREES = path.join('.doflow', 'state', 'dispatch-worktrees');
const ATTEMPT_NAME = /^d-[0-9a-f]{12}$/;
const CHILD_NAME = /^(d-[0-9a-f]{12})\.c([1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40,64}$/;
const GIT_READ_TIMEOUT_MS = 10000;
const REPO_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);

/** IC-025: the actions each flag may be given to; any other action is exit 2 `usage`. */
const FLAG_ACTIONS: Record<string, { flag: string; actions: string[] }> = Object.freeze({
  slug: { flag: '--slug', actions: ['run', 'status', 'cancel', 'evidence'] },
  harness: { flag: '--harness', actions: ['probe', 'describe', 'select', 'run', 'evidence'] },
  edit: { flag: '--edit', actions: ['describe', 'select', 'run'] },
  childOf: { flag: '--child-of', actions: ['run'] },
  request: { flag: '--request', actions: ['run'] },
  execWorktree: { flag: '--exec-worktree', actions: ['run'] },
  need: { flag: '--need', actions: ['probe', 'describe', 'select', 'run'] },
  modelCheck: { flag: '--model-check', actions: ['probe'] },
  budgetTokens: { flag: '--budget-tokens', actions: ['probe'] },
  task: { flag: '--task', actions: ['run', 'status', 'cancel'] },
  token: { flag: '--token', actions: ['run', 'status', 'cancel'] },
  promptFile: { flag: '--prompt-file', actions: ['run'] },
  timeoutSeconds: { flag: '--timeout-seconds', actions: ['run'] },
  wait: { flag: '--wait', actions: ['run'] },
  workerRun: { flag: '--worker-run', actions: ['status', 'cancel', 'evidence'] },
  checks: { flag: '--checks', actions: ['evidence'] },
  out: { flag: '--out', actions: ['evidence'] },
  by: { flag: '--by', actions: ['cancel'] },
  reason: { flag: '--reason', actions: ['cancel'] },
});

/** DEC-063: the execArgv entries the supervisor spawn forwards; every other entry is dropped. */
const EXEC_ARGV_ALLOWED = new Set(['--experimental-strip-types', '--experimental-transform-types', '--no-experimental-strip-types', '--no-warnings']);
const DISABLE_WARNING = /^--disable-warning=.+$/;

/**
 * The type-stripping and warning flags of `execArgv`, element by element. A caller's `-e`, `-p`,
 * `--inspect`, `--watch` or `--test` would otherwise strand the detached supervisor (DEC-063); a
 * two-element `--disable-warning <x>` is dropped whole, so its value is never read as the script.
 */
function allowedExecArgv(execArgv: string[]): string[] {
  return execArgv.filter((arg) => EXEC_ARGV_ALLOWED.has(arg) || DISABLE_WARNING.test(arg));
}

/** A caller or environment failure: exit 2 with `{ ok: false, error }`. */
class WorkerCommandError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerCommandError';
    this.code = code;
  }
}

const usage = (message: string) => new WorkerCommandError('usage', message);
const given = (value: any) => value !== undefined && value !== null && value !== false;
const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refused(reason: string, extra: any = {}) {
  return { disposition: 'refused', reason, ...extra };
}

function real(target: string): string {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/** A whole number from digits only, within `[min, max]`, or undefined when not given. */
function digits(value: any, flag: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!given(value)) return undefined;
  const text = String(value);
  if (!DIGITS.test(text) || Number(text) < min || Number(text) > max) {
    throw usage(`${flag} expects a whole number from ${min} to ${max}, got '${value}'`);
  }
  return Number(text);
}

/** `--need` repeatable or comma-separated. */
function needList(need: any): string[] {
  if (!given(need)) return [];
  const items = Array.isArray(need) ? need : [need];
  return items.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
}

function refuseMisplacedFlags(action: string, flags: any) {
  for (const [key, { flag, actions }] of Object.entries(FLAG_ACTIONS)) {
    if (given(flags[key]) && !actions.includes(action)) throw usage(`${flag} does not apply to --action ${action}`);
  }
}

/** The registry, loaded once; a validation failure is `registry-invalid`. */
function registryOf(registry: any) {
  if (registry) return registry;
  try {
    return loadRegistry({ repoRoot: REPO_ROOT });
  } catch (error: any) {
    throw new WorkerCommandError('registry-invalid', error?.message || String(error));
  }
}

/** The worker block for `harness`: the injected descriptor, or the registry's. */
function workerBlock(reg: any, descriptors: any, harness: string) {
  const entries = workerCatalogue({ registry: reg });
  const ids = entries.map((entry: any) => entry.id);
  if (!ids.includes(harness)) throw usage(`unknown harness '${harness}'; known: ${ids.join(', ')}`);
  if (descriptors) {
    if (!Object.hasOwn(descriptors, harness)) throw usage(`no worker descriptor was given for harness '${harness}'`);
    return descriptors[harness];
  }
  return entries.find((entry: any) => entry.id === harness).worker;
}

/** `--slug`, or the feature resolved from the branch. */
function featureOf(slug: any, resolveSlug: any, cwd: string): string {
  const feature = slug || (resolveSlug ? resolveSlug(cwd) : null);
  if (!feature) throw usage('--slug is required: no feature could be resolved from the current branch');
  if (!isSafeSlug(feature)) throw usage(`'${feature}' is not a valid feature slug`);
  return feature;
}

/** IC-011 step 0's `--prompt-file`: a readable regular file within IC-003's limit for the recipe. */
function readPrompt(promptFile: any, cwd: string, worker: any) {
  const file = path.resolve(cwd, String(promptFile));
  let bytes: Buffer;
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
    bytes = fs.readFileSync(file);
  } catch (error: any) {
    throw usage(`--prompt-file '${promptFile}' is not a readable regular file: ${error?.code || error?.message}`);
  }
  const mode = worker?.oneShot?.promptVia === 'stdin' ? 'stdin' : 'argv';
  if (bytes.length > PROMPT_LIMITS[mode]) {
    throw usage(`--prompt-file is ${bytes.length} bytes; ${mode} mode allows ${PROMPT_LIMITS[mode]}`);
  }
  return { path: file, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** The 080 ledger of `slug`, read only. */
function ledgerOf(root: string, slug: string) {
  return readTaskState(fs, attempts.storeFile(root, slug));
}

function attemptFor(ledger: any, task: string, token: number) {
  const list = ledger?.tasks?.[task]?.attempts;
  return Array.isArray(list) ? list.find((a: any) => a.token === token) ?? null : null;
}

/** One bounded, read-only git call in `cwd` with the repository variables dropped. */
function gitRead(cwd: string, args: string[], env: any): { status: number | null; stdout: string } {
  const clean: any = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const k of REPO_ENV) delete clean[k];
  const r = spawnSync('git', ['-C', cwd, ...args], { env: clean, timeout: GIT_READ_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.error ? null : r.status, stdout: r.stdout || '' };
}

/**
 * 082 IC-014 after step 8: `execWorktree` is `<root>/.doflow/state/dispatch-worktrees/d-<12 hex>`
 * on `refs/heads/doflow-attempt/<slug>/<d-id>`, and its base file names an ancestor of HEAD.
 * Returns `{ reason }` for a refusal, else `{ base, branch }`.
 */
function attemptWorktree(root: string, slug: string, execWorktree: string, env: any): any {
  const dir = real(execWorktree);
  const id = path.basename(dir);
  if (path.dirname(dir) !== path.join(real(root), DISPATCH_WORKTREES) || !ATTEMPT_NAME.test(id)) return { reason: 'exec-worktree-not-attempt' };
  const branch = `refs/heads/doflow-attempt/${slug}/${id}`;
  const ref = gitRead(dir, ['symbolic-ref', '-q', 'HEAD'], env);
  if (ref.status !== 0 || ref.stdout.trim() !== branch) return { reason: 'exec-worktree-not-attempt' };
  let base = '';
  try { base = fs.readFileSync(path.join(dir, BASE_FILE), 'utf8').trim(); } catch { base = ''; }
  if (!SHA.test(base) || gitRead(dir, ['merge-base', '--is-ancestor', base, 'HEAD'], env).status !== 0) return { reason: 'attempt-base-unreadable' };
  return { base, branch };
}

/** 082 IC-015 step 8: `execWorktree` is `<root>/.doflow/state/dispatch-worktrees/<granter d-id>.c<n>`. */
function childWorktreeOk(root: string, granter: any, execWorktree: string): boolean {
  const home = path.join(real(root), DISPATCH_WORKTREES);
  const dir = real(execWorktree);
  const granterDir = typeof granter.execWorktree === 'string' ? real(granter.execWorktree) : '';
  const match = CHILD_NAME.exec(path.basename(dir));
  return Boolean(match) && path.dirname(dir) === home && path.dirname(granterDir) === home
    && ATTEMPT_NAME.test(path.basename(granterDir)) && match![1] === path.basename(granterDir) && dir !== granterDir;
}

function isDirectory(target: any): boolean {
  try { return typeof target === 'string' && fs.statSync(target).isDirectory(); } catch { return false; }
}

/**
 * 082 IC-015: `--request` names the child worktree (its basename) and, when the slug has a dispatch
 * run, a `requested` spawn request of the dispatch whose worker run is the granter. Returns the
 * refusal reason, or null. Reads the dispatch store without a lock; an unreadable store throws
 * `store-unreadable`. With no dispatch run there is no grant to name, so only the basename rule
 * applies (081-level children, `worker-child-run.test.js`).
 */
function childRequestRefusal(root: string, slug: string, childOf: string, request: string, execWorktree: string): string | null {
  if (path.basename(real(execWorktree)) !== request) return 'request-mismatch';
  const dispatch = readDispatch(dispatchStoreFileFor(root, slug));
  if (!dispatch.run) return null;
  const granter = (Object.values(dispatch.dispatches) as any[]).find((d) => d.workerRunId === childOf && d.phase !== 'ended');
  const r = Object.prototype.hasOwnProperty.call(dispatch.spawnRequests, request) ? dispatch.spawnRequests[request] : null;
  if (!granter || !r || r.state !== 'requested' || r.granterDispatchId !== granter.dispatchId) return 'unknown-request';
  return null;
}

/** IC-011 step 11: discover for the harness, then IC-008 on its effective facts. Writes nothing.
 * `edit` swaps in the edit baseline (082 IC-013). */
function evaluate({ reg, worker, harness, needs, coverage, env, cwd, root, nowMs, platform, edit = false }: any) {
  const found = readiness.discover({ descriptors: { [harness]: worker }, registry: reg, env, cwd, now: nowMs, platform }).harnesses[0];
  const facts = readiness.effectiveFacts(
    readiness.readProbeRecord(root, harness),
    { ...found, descriptorDigest: readiness.descriptorDigest(worker) },
    nowMs,
  );
  const requirements = readiness.requirementsFor({ harness, worker }, facts, needs, coverage, edit);
  return { requirements, version: found.version, ...readiness.eligibility(requirements) };
}

/** IC-011 steps 0 to 12, then the supervisor spawn and the start poll. */
async function runAction(o: any) {
  const { env, cwd, root, platform, clock, sleep, slug, harness, task, token, needs, timeoutSeconds, prompt, worker, reg, coverage } = o;
  const binding = o.binding ?? null;
  const edit = o.edit === true;
  const childOf: string | null = o.childOf ?? null;
  const nowMs = () => clock().getTime();

  // Step 1: the caller's identity, so a run is never started whose 080 cancel would be refused.
  const key = runKeyFor(env, cwd);
  const who = identityRefusal(key.identity);
  if (who) return refused(who.reason, { runKey: key.runKey });

  // Steps 2 to 7: the 080 ledger, read only.
  const ledger = ledgerOf(root, slug);
  const active = Array.isArray(ledger?.tasks?.[task]?.attempts) ? ledger.tasks[task].attempts.find((a: any) => a.state === 'active') : null;
  if (!active) return refused('no-active-attempt', { task });
  if (active.token !== token) return refused('token-mismatch', { task, token, activeToken: active.token });
  if (active.runKey !== key.runKey) return refused('foreign-run', { task, token, runKey: active.runKey ?? null });
  if (token > TOKEN_MAX) return refused('token-out-of-range', { task, token });
  if (active.mode !== 'subagent') return refused('mode-mismatch', { task, token, mode: active.mode ?? null });

  // 082 IC-015 after step 7: a live, top-level granter on the same (task, token).
  const file = storeFileFor(root, slug);
  let granter: any = null;
  if (childOf) {
    granter = readRuns(file)[childOf] ?? null;
    if (granter && (granter.childOf ?? null) !== null) return refused('depth-exceeded', { task, token, childOf });
    if (!granter || granter.phase === 'ended' || granter.end || granter.task !== task || granter.token !== token) {
      return refused('granter-mismatch', { task, token, childOf });
    }
  }

  // Step 8: the execution worktree exists; a child's is `--exec-worktree` (082 IC-015).
  const execWorktree = childOf ? path.resolve(cwd, String(o.execWorktree)) : active.execWorktree;
  if (!isDirectory(execWorktree)) return refused('exec-worktree-missing', { task, token, execWorktree: execWorktree ?? null });
  if (childOf && !childWorktreeOk(root, granter, execWorktree)) return refused('exec-worktree-not-child', { task, token, execWorktree });
  if (childOf) {
    const requestRefusal = childRequestRefusal(root, slug, childOf, String(o.request), execWorktree);
    if (requestRefusal) return refused(requestRefusal, { task, token, childOf, request: o.request });
  }

  // 082 IC-014 after step 8: an edit run's worktree is a dispatch attempt worktree.
  let editRecord: any = null;
  if (edit) {
    const attempt = attemptWorktree(root, slug, execWorktree, env);
    if (attempt.reason) return refused(attempt.reason, { task, token, execWorktree });
    editRecord = { base: attempt.base, branch: attempt.branch, callerTop: key.top };
  }

  // Step 9: the caller is not the unit this worker will be.
  if (key.identity.lineageKind === 'launched' && key.identity.attempt === String(token)) {
    return refused('identity-collision', { task, token });
  }

  // Step 10: a git work tree of its own, never the caller's (DEC-042).
  const top = findWorkTreeTop(execWorktree).top;
  if (!top) return refused('exec-worktree-unverifiable', { task, token, execWorktree });
  if (real(top) === real(key.top)) return refused('exec-worktree-shared', { task, token, execWorktree });

  // Step 11: the harness is eligible on effective facts.
  const evaluated = evaluate({ reg, worker, harness, needs, coverage, env, cwd, root, nowMs, platform, edit });
  if (!evaluated.eligible) return refused('harness-ineligible', { task, token, harness, gaps: evaluated.gaps });

  // Step 12: insert inside the run store's lock; one run per (task, token, childOf, request).
  const runId = newRunId();
  const { identity } = launchEnv({ env, runKey: active.runKey, token, execWorktree, runId, runScoped: Boolean(childOf) });
  const record = {
    runId, task, token, harness, phase: 'starting', execWorktree, createdAt: clock().toISOString(), timeoutSeconds,
    cliVersion: evaluated.version,
    caller: {
      cwd: path.resolve(cwd), runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage,
      attempt: key.identity.attempt || null, role: key.identity.role, lineageKind: key.identity.lineageKind,
    },
    edit: editRecord, childOf, request: childOf ? o.request : null,
    ...launchRecord(worker, identity, prompt.bytes.toString('utf8'), edit, binding),
    ...(binding ? { binding: { model: binding.model, flag: binding.flag } } : {}),
    descriptor: worker,
    prompt: { path: prompt.path, sha256: prompt.sha256, bytes: prompt.bytes.length },
    needs: evaluated.requirements.map((item: any) => ({ requirement: item.requirement, at: item.at ?? null })),
  };
  const inserted = insertRun(file, record);
  if (!inserted.applied) return refused('run-exists', { task, token, runId: inserted.runId, phase: inserted.phase });

  // The supervisor, detached, with the caller's environment and cwd (IC-014, DEC-022, DEC-038).
  const child = spawn(process.execPath, [...allowedExecArgv((process as any).execArgv), SUPERVISOR_FILE, file, runId], {
    detached: true, stdio: 'ignore', cwd, env,
  });
  // A spawn error leaves the run `starting` with no live supervisor, which status reads as lost.
  child.on('error', () => {});
  child.unref();
  if (Number.isInteger(child.pid)) {
    const supervisor = { pid: child.pid, pgid: child.pid, start: platform === 'win32' ? null : processTree.procStart(child.pid) };
    transition(file, runId, ['starting', 'running', 'cancelling'], (run: any) => { run.supervisor = supervisor; });
  }

  // Poll up to 10 s for the record to leave `starting`.
  const startUntil = nowMs() + START_WAIT_MS;
  let run = readRuns(file)[runId];
  while (run && run.phase === 'starting' && nowMs() < startUntil) {
    await sleep(START_POLL_MS);
    run = readRuns(file)[runId];
  }
  const started = { disposition: 'started', runId, phase: run?.phase ?? null, task, token, harness, execWorktree, deadline: run?.deadline ?? null };
  if (!o.wait) return started;

  // --wait: poll until the run has an end, bounded by the deadline plus 10 s.
  const deadlineMs = Date.parse(run?.deadline) || (Date.parse(record.createdAt) + timeoutSeconds * 1000);
  const waitUntil = deadlineMs + WAIT_GRACE_MS;
  while (run && !run.end && nowMs() < waitUntil) {
    await sleep(WAIT_POLL_MS);
    run = readRuns(file)[runId];
  }
  return { ...statusView(run, ledgerOf(root, slug), { platform, nowMs: nowMs() }), disposition: 'started' };
}

/** 082 IC-014 / IC-015's flag rules for run: exit 2 `usage` on a misuse. */
function runFlagRules({ edit, childOf, request, execWorktree }: any) {
  if (given(childOf)) {
    if (!RUN_ID.test(String(childOf))) throw usage(`--child-of expects 'w-' plus 12 lowercase hex characters, got '${childOf}'`);
    if (given(edit)) throw usage('--edit does not apply with --child-of: a child run is read-only');
    if (!given(request)) throw usage('--child-of needs --request <d-id>.c<n>');
    if (!CHILD_NAME.test(String(request))) throw usage(`--request expects '<d-id>.c<n>', got '${request}'`);
    if (!given(execWorktree)) throw usage('--child-of needs --exec-worktree');
  } else {
    if (given(request)) throw usage('--request applies only with --child-of');
    if (given(execWorktree)) throw usage('--exec-worktree applies only with --child-of');
  }
}

/**
 * IC-019 and IC-017's view: the reported state from the record and liveness, and `verified`,
 * `attemptActive`, `resultOffered` and `withheld` computed now from the record and the ledger.
 * Writes nothing.
 */
function statusView(run: any, ledger: any, { platform, nowMs }: any) {
  const isAlive = (proc: any) => (proc ? processTree.alive(proc, { platform }) : false);
  let state: string;
  let reason: string | null = null;
  const extra: any = {};
  if (run.phase === 'ended') {
    state = run.end?.state ?? 'unknown';
  } else if (run.phase === 'starting') {
    const sup = isAlive(run.supervisor);
    if (sup === true) state = 'starting';
    else [state, reason] = ['unknown', sup === false ? 'supervisor-lost' : 'liveness-unknown'];
  } else {
    const sup = isAlive(run.supervisor);
    const wrk = isAlive(run.worker);
    if (sup === true || wrk === true) {
      state = 'running';
      const deadlineMs = Date.parse(run.deadline);
      extra.supervisorLost = sup !== true;
      extra.overdue = Number.isFinite(deadlineMs) && nowMs > deadlineMs;
      extra.cancel = run.phase === 'cancelling' ? run.cancel ?? null : null;
    } else {
      [state, reason] = ['unknown', sup === false && wrk === false ? 'process-lost' : 'liveness-unknown'];
    }
  }
  const attempt = attemptFor(ledger, run.task, run.token);
  const attemptActive = attempt?.state === 'active';
  const verified = attempt && !attemptActive ? { state: attempt.state, result: attempt.result ?? null, evidenceId: attempt.evidenceId ?? null } : null;
  const { resultOffered, withheld } = resultOfRun(run);
  return {
    disposition: 'status',
    runId: run.runId, task: run.task, token: run.token, harness: run.harness ?? null, identity: run.identity ?? null,
    state, reason, ...extra,
    startedAt: run.startedAt ?? null, endedAt: run.end?.at ?? null, deadline: run.deadline ?? null,
    process: run.process ?? null, report: run.report ?? null, readOnly: run.readOnly ?? null,
    edit: run.edit ?? null, isolation: run.isolation ?? null, childOf: run.childOf ?? null, request: run.request ?? null,
    verified, attemptActive, resultOffered, withheld,
    cleanup: run.cleanup ?? null, supervisorCleanup: run.supervisorCleanup ?? null, attemptCancel: run.attemptCancel ?? null,
    output: run.output ?? null, launchObserved: run.launchObserved ?? null,
  };
}

/**
 * `{ run, view }` for run `runId` in the run store `file`, read so a run that ends between the
 * record read and the liveness probe is seen ended, never `unknown`. The supervisor writes the end
 * before it exits, so a record read before a probe that finds every process gone may predate that
 * end; it is read again after the probe, and only a record still not ended then is `unknown`.
 * Writes nothing.
 */
function settledStatus(file: string, runId: string, ledger: any, opts: any, read: (file: string) => any = readRuns) {
  let run = read(file)[runId] ?? null;
  let view = run ? statusView(run, ledger, opts) : null;
  if (run && run.phase !== 'ended' && view && view.state === 'unknown') {
    run = read(file)[runId] ?? null;
    view = run ? statusView(run, ledger, opts) : null;
  }
  return { run, view };
}

/** The run named by `--worker-run`, or the top-level run on `(task, token)` (`childOf` null, 082
 * IC-015, so a granter is named and never one of its children), or null. */
function findRun(file: string, { workerRun, task, token }: any) {
  const runs = readRuns(file);
  if (workerRun) return runs[workerRun] ?? null;
  return (Object.values(runs) as any[]).find((run) => run.task === task && run.token === token && (run.childOf ?? null) === null) ?? null;
}

/** `--worker-run`, or `--task` with `--token`, exactly one of the two. */
function runSelector(workerRun: any, task: any, token: any, action: string) {
  if (given(workerRun)) {
    if (given(task) || given(token)) throw usage(`--action ${action} takes --worker-run or --task with --token, not both`);
    if (!RUN_ID.test(String(workerRun))) throw usage(`--worker-run expects 'w-' plus 12 lowercase hex characters, got '${workerRun}'`);
    return { workerRun: String(workerRun) };
  }
  if (!given(task) || !given(token)) throw usage(`--action ${action} needs --worker-run, or --task with --token`);
  return { task: String(task), token: Number(token) };
}

/** One summary line per harness or run, never output file content (IC-025). */
function summaryLines(body: any): string[] {
  const list = body.harnesses || body.candidates;
  if (Array.isArray(list)) {
    const head = body.disposition === 'selected' ? [`selected ${body.harness}`] : (body.disposition === 'none-eligible' ? ['none-eligible'] : []);
    return [...head, ...list.map((item: any) => {
      if (body.disposition === 'discovered') return `${item.harness}  ${item.present ? `present ${item.path} ${item.version ?? ''}`.trim() : `absent (${item.reason})`}`;
      if (body.disposition === 'probed') return `${item.harness}  probed at ${item.recordedAt}`;
      return `${item.harness}  ${item.eligible ? 'eligible' : `ineligible: ${(item.gaps || []).map((g: any) => g.requirement).join(', ')}`}`;
    })];
  }
  const parts = [body.disposition];
  if (body.harness && body.disposition === 'described') parts.push(body.harness, body.eligible ? 'eligible' : 'ineligible');
  if (body.runId) parts.push(body.runId);
  if (body.path) parts.push(body.path);
  if (Array.isArray(body.establishes) && body.establishes.length) parts.push(`establishes ${body.establishes.join(', ')}`);
  if (body.task) parts.push(`task ${body.task}`);
  if (body.token !== undefined) parts.push(`token ${body.token}`);
  if (body.state) parts.push(body.state);
  if (body.endState) parts.push(body.endState);
  if (body.run === null) parts.push('no run');
  if (body.reason) parts.push(`(${body.reason})`);
  return [parts.join(' ')];
}

/**
 * Runs one `worker` action and returns `{ exit, body }` without printing. Same options as
 * `handleWorkerCommand`.
 */
async function executeWorkerCommand({
  action, slug = null, harness, need, modelCheck, budgetTokens, task, token, promptFile, timeoutSeconds, wait = false,
  workerRun, checks, out, by, reason, edit = false, childOf, request, execWorktree,
  env = process.env, cwd = process.cwd(), resolveSlug = null, platform = process.platform, now = () => new Date(),
  descriptors, registry, coverage, sleep = defaultSleep, binding = null,
}: any = {}): Promise<{ exit: number; body: any }> {
  try {
    if (!given(action)) throw usage(`--action is required; valid: ${ACTIONS.join(' | ')}`);
    if (!ACTIONS.includes(action)) throw usage(`unknown action '${action}'; valid: ${ACTIONS.join(' | ')}`);
    refuseMisplacedFlags(action, { slug, harness, need, modelCheck, budgetTokens, task, token, promptFile, timeoutSeconds, wait, workerRun, checks, out, by, reason, edit, childOf, request, execWorktree });
    if (given(task) && !TASK_ID.test(String(task))) throw usage(`--task expects a plan task id such as A.1, got '${task}'`);
    if (given(token)) digits(token, '--token', 1);
    if (given(budgetTokens) && !given(modelCheck)) throw usage('--budget-tokens applies only with --model-check');
    const clock = typeof now === 'function' ? () => { const at = now(); return at instanceof Date ? at : new Date(at); } : () => new Date(now);
    const nowMs = () => clock().getTime();
    const needs = needList(need);
    const reg = registryOf(registry);
    const cov = coverage === undefined ? reg.coverage : coverage;
    if (needs.length) readiness.validateNeeds(needs, cov);
    // IC-005: one lifecycle project root per invocation; probe records are written and read there.
    const root = lifecycleProjectRoot(cwd);
    const common = { descriptors, registry: reg, env, cwd, now: nowMs, platform };
    const atRoot = { ...common, root };

    let body: any;
    switch (action) {
      case 'discover': body = readiness.discover(common); break;
      case 'probe': body = await readiness.probe({ ...atRoot, coverage: cov, needs, harness: given(harness) ? String(harness) : undefined, modelCheck: given(modelCheck) ? String(modelCheck) : undefined, budgetTokens: digits(budgetTokens, '--budget-tokens', 1) }); break;
      case 'describe': {
        if (!given(harness)) throw usage('--action describe needs --harness');
        let primary: any;
        try {
          const { resolvePrimary } = require('../context/primary.ts');
          primary = resolvePrimary({ env, projectRoot: cwd, registry: reg });
        } catch (error: any) {
          primary = { state: 'unavailable', message: error?.message || String(error) };
        }
        body = readiness.describe({
          ...atRoot, coverage: cov, harness: String(harness), needs, edit: given(edit),
          active: activeWorkers({ registry: reg, env, projectRoot: root }),
          primary,
          bindings: readBindings({ env, projectRoot: root }),
        });
        break;
      }
      case 'select': body = readiness.select({ ...atRoot, coverage: cov, harness: given(harness) ? String(harness) : undefined, needs, edit: given(edit), active: activeWorkers({ registry: reg, env, projectRoot: root }) }); break;
      case 'run': {
        const feature = featureOf(slug, resolveSlug, cwd);
        if (!given(harness)) throw usage('--action run needs --harness');
        if (!given(task) || !given(token)) throw usage('--action run needs --task and --token');
        if (!given(promptFile)) throw usage('--action run needs --prompt-file');
        runFlagRules({ edit, childOf, request, execWorktree });
        const worker = workerBlock(reg, descriptors, String(harness));
        const gate = workerGate(activeWorkers({ registry: reg, env, projectRoot: root }), String(harness));
        if (gate) {
          body = refused(gate.reason, { harness: gate.harness, enabled: gate.enabled, origin: gate.origin });
          break;
        }
        const seconds = digits(timeoutSeconds, '--timeout-seconds', 1, TIMEOUT_MAX_SECONDS) ?? TIMEOUT_DEFAULT_SECONDS;
        const prompt = readPrompt(promptFile, cwd, worker);
        body = await runAction({
          env, cwd, root, platform, clock, sleep, slug: feature, harness: String(harness), task: String(task), token: Number(token),
          needs, timeoutSeconds: seconds, prompt, worker, reg, coverage: cov, wait: Boolean(wait),
          binding,
          edit: given(edit), childOf: given(childOf) ? String(childOf) : null, request: given(request) ? String(request) : null,
          execWorktree: given(execWorktree) ? String(execWorktree) : null,
        });
        break;
      }
      case 'status': {
        const feature = featureOf(slug, resolveSlug, cwd);
        const selector = runSelector(workerRun, task, token, 'status');
        const run = findRun(storeFileFor(root, feature), selector);
        if (run) body = statusView(run, ledgerOf(root, feature), { platform, nowMs: nowMs() });
        else if (selector.workerRun) body = refused('unknown-run', { runId: selector.workerRun });
        else body = { disposition: 'status', run: null, task: selector.task, token: selector.token };
        break;
      }
      case 'evidence': {
        if (!given(harness)) throw usage('--action evidence needs --harness');
        if (!given(out)) throw usage('--action evidence needs --out');
        const hasChecks = given(checks);
        const hasWorkerRun = given(workerRun);
        if (hasChecks === hasWorkerRun) throw usage('--action evidence needs exactly one of --checks or --worker-run');
        const worker = workerBlock(reg, descriptors, String(harness));
        const outFile = path.resolve(cwd, String(out));
        if (hasChecks) {
          body = evidence.recordCliChecks({
            checksFile: path.resolve(cwd, String(checks)), harness: String(harness), worker, out: outFile,
            cwd: root, env, now: clock, platform,
          });
        } else {
          if (!RUN_ID.test(String(workerRun))) throw usage(`--worker-run expects 'w-' plus 12 lowercase hex characters, got '${workerRun}'`);
          const feature = featureOf(slug, resolveSlug, cwd);
          const run = readRuns(storeFileFor(root, feature))[String(workerRun)] ?? null;
          body = evidence.recordLiveRun({ run, harness: String(harness), worker, out: outFile, cwd: root, now: clock });
        }
        break;
      }
      default: {
        const feature = featureOf(slug, resolveSlug, cwd);
        const selector = runSelector(workerRun, task, token, 'cancel');
        if (!given(by) || !SAFE_NAME.test(String(by))) throw usage('--by is required: the name of the agent or person cancelling the run');
        if (typeof reason !== 'string' || !reason.trim()) throw usage('--reason is required: why the run is being cancelled');
        const file = storeFileFor(root, feature);
        const run = findRun(file, selector);
        if (!run) {
          // IC-021 step 1 order: the caller's identity before the run's existence.
          const key = runKeyFor(env, cwd);
          const who = identityRefusal(key.identity);
          body = who ? refused(who.reason, { runKey: key.runKey }) : refused('unknown-run', selector.workerRun ? { runId: selector.workerRun } : { task: selector.task, token: selector.token });
        } else {
          body = await cancelRun({ file, runId: run.runId, by: String(by), reason, source: 'user', env, cwd, platform, now: clock });
        }
      }
    }
    return { exit: EXIT_ZERO.includes(body.disposition) ? 0 : 1, body };
  } catch (error: any) {
    if (error instanceof evidence.WorkerEvidenceError) {
      if (error.code === 'refused') return { exit: 1, body: { disposition: 'refused', reason: error.reason } };
      if (error.code === 'usage') return { exit: 2, body: { ok: false, error: 'usage', reason: error.reason, message: error.message } };
    }
    const code = typeof error?.code === 'string' ? error.code : null;
    if (code && ERROR_CODES.includes(code)) return { exit: 2, body: { ok: false, error: code, message: error.message } };
    // launch.ts's caller errors (run-key-malformed, prompt-too-large, recipe-incomplete) are usage.
    if (error?.name === 'LaunchUsageError') return { exit: 2, body: { ok: false, error: 'usage', reason: code, message: error.message } };
    throw error;
  }
}

/**
 * `doflow-run worker --action <action> ...` (IC-025). Prints the JSON with `json`, else one summary
 * line per harness or run, sets `process.exitCode` and resolves the exit code: 0 for the applied and
 * read dispositions (including `recorded`), 1 for `refused` and `none-eligible`, 2 for `usage`, `store-unreadable` and
 * `registry-invalid`. Callers branch on the JSON, never on the exit code alone.
 */
async function handleWorkerCommand(options: any = {}): Promise<number> {
  const { finishRuntime } = require('../cli-result.ts');
  const { exit, body } = await executeWorkerCommand(options);
  if (options.json) console.log(JSON.stringify(body, null, 2));
  else if (exit === 2) console.error(`doflow worker: ${body.message}`);
  else for (const line of summaryLines(body)) (exit === 0 ? console.log : console.error)(line);
  return finishRuntime(exit);
}

module.exports = { handleWorkerCommand, executeWorkerCommand, statusView, settledStatus, findRun, allowedExecArgv, ACTIONS, FLAG_ACTIONS, WorkerCommandError };
