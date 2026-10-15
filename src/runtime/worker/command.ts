'use strict';

// Feature 081 C.3 (IC-011, IC-017 view, IC-019, IC-025; DEC-005, DEC-025, DEC-032, DEC-036,
// DEC-038, DEC-042, DEC-054): the `worker` verb's handler.
//
// `handleWorkerCommand` validates IC-025's flags per action (a flag on an action that does not take
// it is exit 2 `usage`), runs the action and maps its disposition to the exit contract: 0 for
// `discovered`, `probed`, `described`, `selected`, `started`, `cancelled` and `status`; 1 with the
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
// This module makes no fs write call: the run store is written through `insertRun` and
// `transition`, the probe record by readiness, the ledger only by 080's cancel (G26 (b), IC-027).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readiness = require('./readiness.ts');
const { storeFileFor, newRunId, insertRun, transition, readRuns, RUN_ID } = require('./run-store.ts');
const { launchEnv, launchRecord, PROMPT_LIMITS } = require('./launch.ts');
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

const ACTIONS = Object.freeze(['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel']);
/** IC-025: the dispositions that exit 0; `refused` and `none-eligible` exit 1. */
const EXIT_ZERO = Object.freeze(['discovered', 'probed', 'described', 'selected', 'started', 'cancelled', 'status']);
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

/** IC-025: the actions each flag may be given to; any other action is exit 2 `usage`. */
const FLAG_ACTIONS: Record<string, { flag: string; actions: string[] }> = Object.freeze({
  slug: { flag: '--slug', actions: ['run', 'status', 'cancel'] },
  harness: { flag: '--harness', actions: ['probe', 'describe', 'select', 'run'] },
  need: { flag: '--need', actions: ['probe', 'describe', 'select', 'run'] },
  modelCheck: { flag: '--model-check', actions: ['probe'] },
  budgetTokens: { flag: '--budget-tokens', actions: ['probe'] },
  task: { flag: '--task', actions: ['run', 'status', 'cancel'] },
  token: { flag: '--token', actions: ['run', 'status', 'cancel'] },
  promptFile: { flag: '--prompt-file', actions: ['run'] },
  timeoutSeconds: { flag: '--timeout-seconds', actions: ['run'] },
  wait: { flag: '--wait', actions: ['run'] },
  workerRun: { flag: '--worker-run', actions: ['status', 'cancel'] },
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
  const ids = reg.harnesses.map((h: any) => h.id);
  if (!ids.includes(harness)) throw usage(`unknown harness '${harness}'; known: ${ids.join(', ')}`);
  if (descriptors) {
    if (!Object.hasOwn(descriptors, harness)) throw usage(`no worker descriptor was given for harness '${harness}'`);
    return descriptors[harness];
  }
  return reg.harnesses.find((h: any) => h.id === harness).worker;
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

/** IC-011 step 11: discover for the harness, then IC-008 on its effective facts. Writes nothing. */
function evaluate({ reg, worker, harness, needs, coverage, env, cwd, nowMs, platform }: any) {
  const found = readiness.discover({ descriptors: { [harness]: worker }, registry: reg, env, cwd, now: nowMs, platform }).harnesses[0];
  const facts = readiness.effectiveFacts(
    readiness.readProbeRecord(cwd, harness),
    { ...found, descriptorDigest: readiness.descriptorDigest(worker) },
    nowMs,
  );
  const requirements = readiness.requirementsFor({ harness, worker }, facts, needs, coverage);
  return { requirements, ...readiness.eligibility(requirements) };
}

/** IC-011 steps 0 to 12, then the supervisor spawn and the start poll. */
async function runAction(o: any) {
  const { env, cwd, platform, clock, sleep, slug, harness, task, token, needs, timeoutSeconds, prompt, worker, reg, coverage } = o;
  const nowMs = () => clock().getTime();

  // Step 1: the caller's identity, so a run is never started whose 080 cancel would be refused.
  const key = runKeyFor(env, cwd);
  const who = identityRefusal(key.identity);
  if (who) return refused(who.reason, { runKey: key.runKey });

  // Steps 2 to 7: the 080 ledger, read only.
  const root = lifecycleProjectRoot(cwd);
  const ledger = ledgerOf(root, slug);
  const active = Array.isArray(ledger?.tasks?.[task]?.attempts) ? ledger.tasks[task].attempts.find((a: any) => a.state === 'active') : null;
  if (!active) return refused('no-active-attempt', { task });
  if (active.token !== token) return refused('token-mismatch', { task, token, activeToken: active.token });
  if (active.runKey !== key.runKey) return refused('foreign-run', { task, token, runKey: active.runKey ?? null });
  if (token > TOKEN_MAX) return refused('token-out-of-range', { task, token });
  if (active.mode !== 'subagent') return refused('mode-mismatch', { task, token, mode: active.mode ?? null });

  // Step 8: the execution worktree exists.
  const execWorktree = active.execWorktree;
  let isDir = false;
  try { isDir = typeof execWorktree === 'string' && fs.statSync(execWorktree).isDirectory(); } catch { isDir = false; }
  if (!isDir) return refused('exec-worktree-missing', { task, token, execWorktree: execWorktree ?? null });

  // Step 9: the caller is not the unit this worker will be.
  if (key.identity.lineageKind === 'launched' && key.identity.attempt === String(token)) {
    return refused('identity-collision', { task, token });
  }

  // Step 10: a git work tree of its own, never the caller's (DEC-042).
  const top = findWorkTreeTop(execWorktree).top;
  if (!top) return refused('exec-worktree-unverifiable', { task, token, execWorktree });
  if (real(top) === real(key.top)) return refused('exec-worktree-shared', { task, token, execWorktree });

  // Step 11: the harness is eligible on effective facts.
  const evaluated = evaluate({ reg, worker, harness, needs, coverage, env, cwd, nowMs, platform });
  if (!evaluated.eligible) return refused('harness-ineligible', { task, token, harness, gaps: evaluated.gaps });

  // Step 12: insert inside the run store's lock; one run per (task, token).
  const file = storeFileFor(root, slug);
  const runId = newRunId();
  const { identity } = launchEnv({ env, runKey: active.runKey, token, execWorktree, runId });
  const record = {
    runId, task, token, harness, phase: 'starting', execWorktree, createdAt: clock().toISOString(), timeoutSeconds,
    caller: {
      cwd: path.resolve(cwd), runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage,
      attempt: key.identity.attempt || null, role: key.identity.role, lineageKind: key.identity.lineageKind,
    },
    ...launchRecord(worker, identity, prompt.bytes.toString('utf8')),
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
    verified, attemptActive, resultOffered, withheld,
    cleanup: run.cleanup ?? null, supervisorCleanup: run.supervisorCleanup ?? null, attemptCancel: run.attemptCancel ?? null,
    output: run.output ?? null, launchObserved: run.launchObserved ?? null,
  };
}

/** The run named by `--worker-run`, or the one on `(task, token)`, or null. */
function findRun(file: string, { workerRun, task, token }: any) {
  const runs = readRuns(file);
  if (workerRun) return runs[workerRun] ?? null;
  return (Object.values(runs) as any[]).find((run) => run.task === task && run.token === token) ?? null;
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
  workerRun, by, reason,
  env = process.env, cwd = process.cwd(), resolveSlug = null, platform = process.platform, now = () => new Date(),
  descriptors, registry, coverage, sleep = defaultSleep,
}: any = {}): Promise<{ exit: number; body: any }> {
  try {
    if (!given(action)) throw usage(`--action is required; valid: ${ACTIONS.join(' | ')}`);
    if (!ACTIONS.includes(action)) throw usage(`unknown action '${action}'; valid: ${ACTIONS.join(' | ')}`);
    refuseMisplacedFlags(action, { slug, harness, need, modelCheck, budgetTokens, task, token, promptFile, timeoutSeconds, wait, workerRun, by, reason });
    if (given(task) && !TASK_ID.test(String(task))) throw usage(`--task expects a plan task id such as A.1, got '${task}'`);
    if (given(token)) digits(token, '--token', 1);
    if (given(budgetTokens) && !given(modelCheck)) throw usage('--budget-tokens applies only with --model-check');
    const clock = typeof now === 'function' ? () => { const at = now(); return at instanceof Date ? at : new Date(at); } : () => new Date(now);
    const nowMs = () => clock().getTime();
    const needs = needList(need);
    const reg = registryOf(registry);
    const cov = coverage === undefined ? reg.coverage : coverage;
    if (needs.length) readiness.validateNeeds(needs, cov);
    const common = { descriptors, registry: reg, env, cwd, now: nowMs, platform };

    let body: any;
    switch (action) {
      case 'discover': body = readiness.discover(common); break;
      case 'probe': body = await readiness.probe({ ...common, harness: given(harness) ? String(harness) : undefined, modelCheck: given(modelCheck) ? String(modelCheck) : undefined, budgetTokens: digits(budgetTokens, '--budget-tokens', 1) }); break;
      case 'describe':
        if (!given(harness)) throw usage('--action describe needs --harness');
        body = readiness.describe({ ...common, coverage: cov, harness: String(harness), needs });
        break;
      case 'select': body = readiness.select({ ...common, coverage: cov, harness: given(harness) ? String(harness) : undefined, needs }); break;
      case 'run': {
        const feature = featureOf(slug, resolveSlug, cwd);
        if (!given(harness)) throw usage('--action run needs --harness');
        if (!given(task) || !given(token)) throw usage('--action run needs --task and --token');
        if (!given(promptFile)) throw usage('--action run needs --prompt-file');
        const worker = workerBlock(reg, descriptors, String(harness));
        const seconds = digits(timeoutSeconds, '--timeout-seconds', 1, TIMEOUT_MAX_SECONDS) ?? TIMEOUT_DEFAULT_SECONDS;
        const prompt = readPrompt(promptFile, cwd, worker);
        body = await runAction({
          env, cwd, platform, clock, sleep, slug: feature, harness: String(harness), task: String(task), token: Number(token),
          needs, timeoutSeconds: seconds, prompt, worker, reg, coverage: cov, wait: Boolean(wait),
        });
        break;
      }
      case 'status': {
        const feature = featureOf(slug, resolveSlug, cwd);
        const selector = runSelector(workerRun, task, token, 'status');
        const root = lifecycleProjectRoot(cwd);
        const run = findRun(storeFileFor(root, feature), selector);
        if (run) body = statusView(run, ledgerOf(root, feature), { platform, nowMs: nowMs() });
        else if (selector.workerRun) body = refused('unknown-run', { runId: selector.workerRun });
        else body = { disposition: 'status', run: null, task: selector.task, token: selector.token };
        break;
      }
      default: {
        const feature = featureOf(slug, resolveSlug, cwd);
        const selector = runSelector(workerRun, task, token, 'cancel');
        if (!given(by) || !SAFE_NAME.test(String(by))) throw usage('--by is required: the name of the agent or person cancelling the run');
        if (typeof reason !== 'string' || !reason.trim()) throw usage('--reason is required: why the run is being cancelled');
        const file = storeFileFor(lifecycleProjectRoot(cwd), feature);
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
 * read dispositions, 1 for `refused` and `none-eligible`, 2 for `usage`, `store-unreadable` and
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

module.exports = { handleWorkerCommand, executeWorkerCommand, statusView, allowedExecArgv, ACTIONS, FLAG_ACTIONS, WorkerCommandError };
