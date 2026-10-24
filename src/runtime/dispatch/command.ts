'use strict';

// Feature 082 C.5 (IC-001, IC-002; DEC-002, DEC-017, DEC-024, DEC-029, DEC-034, DEC-035, DEC-037,
// DEC-039, DEC-044, DEC-051): the `dispatch` verb's handler.
//
// `executeDispatchCommand(options)` prints nothing and resolves `{ exit, body }`, so tests and the
// loop's own callers use it in process (the pattern of 081's `executeWorkerCommand`).
// `handleDispatchCommand(options)` wraps it, prints the JSON with `json` or one summary line per
// action (inspect: IC-029's lines), and sets the process exit code. No text line carries envelope,
// output or verification argv content.
//
// Order for every action: `--action`, then IC-001's flag rules (a flag on an action that does not
// take it is exit 2 `usage`) and every value, before any read; then the slug; then, for every
// action but `spawn`, IC-001's identity checks before any read for writing, git call, spawn or
// signal (DEC-044): `identity-solo` and `worker-session` for all of them, and for every action but
// `start` the dispatch run's existence and its stored `runKey` (`no-dispatch-run`, `foreign-run`).
// The module each action calls repeats the check under its own lock, so it cannot be raced.
//
// `start` is IC-002's steps 0 to 8: steps 1 to 6 hold no lock, the integration worktree is made
// outside every lock, and steps 7 and 8 (the store check again and the in-process 080 `start`) run
// inside one dispatch-store write (lock order dispatch then ledger, IC-006). A refusal at step 7 or
// 8 removes the integration worktree by `removeVerified` and carries its `cleanup`.
//
// Exits (IC-001): 0 for the applied and read dispositions; 1 with the JSON for `refused`, `stale`
// and `ack-required`; 2 with `{ ok: false, error, message }` for `usage`, `store-unreadable`,
// `plan-unreadable`, `plan-malformed` and `registry-invalid`; `run` interrupted by SIGINT or SIGTERM
// exits 130 or 143 as the loop reports. `step` and `run` exit 0 whenever the pass ran, whatever its
// outcome.
//
// This module makes no fs write call: the store is written through `store.ts`, the ledger by 080's
// `start`, the worktree by `integrate.ts`.
//
// Feature 106 A.2 (IC-005): `start` takes `--fallback off|ask|auto` and `--ladder <id[,id...]>`
// (registry harness ids, each once, at most 8, never with `--harness`) and stores `run.fallback`;
// without `--fallback` the `dispatch.fallback` setting applies (fail-safe `off`). `resume` takes
// `--fallback`: once resumed, `off` or `ask` sets the run's mode in one write, and `auto` accepts the
// pending proposals once (review C-14): it clears the `quota` holds and records each task in
// `run.fallback.accepted`, the run's mode unchanged; run-wide `auto` comes only from `start`.
// Feature 120 C.4 (IC-010): start gates enabled rungs and stores the ladder and in-session permission.

const fs = require('node:fs');
const path = require('node:path');
const attempts = require('../task-attempts.ts');
const { isGraphPlan } = require('../task-graph.ts');
const { runKeyFor, identityRefusal } = require('../task-run.ts');
const { isSafeSlug } = require('../task-scope.ts');
const { projectRoot } = require('../lifecycle/root.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { knownWorkerIds, LADDER_MAX } = require('../../registry/worker-ids.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const readiness = require('../worker/readiness.ts');
const { activeWorkers, workerGate, inSessionGate } = require('../worker/active.ts');
const { storeFileFor, newDispatchRunId, readDispatch, mutateDispatch, fallbackOf, DispatchStoreError, DISPATCH_ID } = require('./store.ts');
const { concurrencyOf } = require('./admission.ts');
const { validateGrant, requestSpawn, spawnStatus } = require('./grants.ts');
const { createIntegrationWorktree, managerFor } = require('./integrate.ts');
const { argvDigest } = require('./verify-run.ts');
const loop = require('./loop.ts');
const controls = require('./controls.ts');

const ACTIONS = Object.freeze(['start', 'step', 'run', 'submit', 'spawn', 'pause', 'inspect', 'cancel', 'takeover', 'resume']);
/** IC-001: the dispositions that exit 0; every other disposition exits 1 with the JSON. */
const EXIT_ZERO = Object.freeze([
  'started', 'stepped', 'ran', 'submitted', 'spawn-requested', 'spawn-status', 'paused', 'inspected', 'cancelled', 'taken-over', 'resumed',
]);
const ERROR_CODES = Object.freeze(['usage', 'store-unreadable', 'plan-unreadable', 'plan-malformed', 'registry-invalid']);
const MODES = Object.freeze(['auto', 'sequential', 'manual']);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const TASK_ID = /^[A-Za-z]+\.\d+$/;
const ACK = /^sha256:[0-9a-f]{64}$/;
const DIGITS = /^[0-9]+$/;
/** IC-001's `--request-id`: a child of one dispatch, `c1` to `c4` (DEC-051). */
const REQUEST_ID_FLAG = /^d-[0-9a-f]{12}\.c[1-4]$/;
const VERIFY_ARGV_MAX = 64;
const VERIFY_ARG_CHARS = 4096;
const VERIFY_SECONDS_DEFAULT = 600;
const VERIFY_SECONDS_MAX = 14400;
/** DEC-035: 081's backstop of `n + 120` stays within 081's 14400. */
const ATTEMPT_SECONDS_MAX = 14400 - loop.BACKSTOP_SECONDS;
const RUN_MAX_SECONDS_MAX = 14400;
/** IC-005's submit bounds, the same values `loop.submit` checks. */
const SUMMARY_BYTES = 8192;
const BLOCKERS_MAX = 20;
const BLOCKER_CHARS = 200;
const TOKEN_BASES = Object.freeze(['measured', 'estimated']);

/** IC-001: the actions each flag may be given to; any other action is exit 2 `usage`. */
const FLAG_ACTIONS: Record<string, { flag: string; actions: string[] }> = Object.freeze({
  by: { flag: '--by', actions: ['start', 'step', 'run', 'pause', 'cancel', 'takeover', 'resume'] },
  reason: { flag: '--reason', actions: ['pause', 'cancel', 'takeover', 'resume'] },
  concurrency: { flag: '--concurrency', actions: ['start'] },
  mode: { flag: '--mode', actions: ['start'] },
  billingCap: { flag: '--billing-cap', actions: ['start'] },
  verifyArgv: { flag: '--verify-argv', actions: ['start'] },
  verifySeconds: { flag: '--verify-seconds', actions: ['start'] },
  attemptSeconds: { flag: '--attempt-seconds', actions: ['start'] },
  reserveTokens: { flag: '--reserve-tokens', actions: ['start', 'spawn'] },
  budgetAttempts: { flag: '--budget-attempts', actions: ['start'] },
  budgetTokens: { flag: '--budget-tokens', actions: ['start'] },
  spawnGrant: { flag: '--spawn-grant', actions: ['start'] },
  harness: { flag: '--harness', actions: ['start'] },
  need: { flag: '--need', actions: ['start'] },
  maxSeconds: { flag: '--max-seconds', actions: ['run'] },
  dispatch: { flag: '--dispatch', actions: ['submit'] },
  status: { flag: '--status', actions: ['submit'] },
  summary: { flag: '--summary', actions: ['submit'] },
  blocker: { flag: '--blocker', actions: ['submit'] },
  tokens: { flag: '--tokens', actions: ['submit'] },
  tokensBasis: { flag: '--tokens-basis', actions: ['submit'] },
  promptFile: { flag: '--prompt-file', actions: ['spawn'] },
  requestId: { flag: '--request-id', actions: ['spawn'] },
  task: { flag: '--task', actions: ['takeover'] },
  ack: { flag: '--ack', actions: ['resume'] },
  fallback: { flag: '--fallback', actions: ['start', 'resume'] },
  ladder: { flag: '--ladder', actions: ['start'] },
});

type Env = Record<string, string | undefined>;

const usage = (message: string) => new DispatchStoreError('usage', message);
const given = (value: any) => value !== undefined && value !== null && value !== false;
const iso = (at: Date) => at.toISOString();

function refused(reason: string, extra: any = {}) {
  return { disposition: 'refused', reason, ...extra };
}

/** A whole number from digits only (or an integer), within `[min, max]`; undefined when not given. */
function digits(value: any, flag: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!given(value)) return undefined;
  const text = String(value);
  if (!DIGITS.test(text) || Number(text) < min || Number(text) > max) throw usage(`${flag} expects a whole number from ${min} to ${max}, got '${value}'`);
  return Number(text);
}

function requireBy(by: any, action: string): string {
  if (!given(by) || !SAFE_NAME.test(String(by))) throw usage(`--by is required for --action ${action}: the name of the agent or person acting`);
  return String(by);
}

function requireReason(reason: any, action: string): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw usage(`--reason is required for --action ${action}`);
  return text;
}

function refuseMisplacedFlags(action: string, flags: any) {
  for (const [key, { flag, actions }] of Object.entries(FLAG_ACTIONS)) {
    if (given(flags[key]) && !actions.includes(action)) throw usage(`${flag} does not apply to --action ${action}`);
  }
}

function needList(need: any): string[] {
  if (!given(need)) return [];
  const items = Array.isArray(need) ? need : [need];
  return [...new Set(items.flatMap((item: any) => String(item).split(',')).map((item: string) => item.trim()).filter(Boolean))];
}

/** DEC-024: `--verify-argv` as 1 to 64 strings, each 1 to 4096 characters without NUL; null when absent. */
function verifyArgvOf(value: any): string[] | null {
  if (!given(value)) return null;
  let argv = value;
  if (typeof value === 'string') {
    try { argv = JSON.parse(value); } catch { throw usage('--verify-argv is not valid JSON: it expects a JSON array of strings'); }
  }
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > VERIFY_ARGV_MAX) throw usage(`--verify-argv expects a JSON array of 1 to ${VERIFY_ARGV_MAX} strings`);
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length < 1 || Array.from(arg).length > VERIFY_ARG_CHARS || arg.includes('\u0000')) {
      throw usage(`--verify-argv elements are strings of 1 to ${VERIFY_ARG_CHARS} characters without NUL`);
    }
  }
  return [...argv];
}

/** The registry, loaded once; a validation failure is `registry-invalid`. */
function registryOf(registry: any) {
  if (registry) return registry;
  try {
    return loadRegistry({ repoRoot: REPO_ROOT });
  } catch (error: any) {
    throw new DispatchStoreError('registry-invalid', error?.message || String(error));
  }
}

/** 106 IC-005: `--fallback` as a mode, or null when absent. */
function fallbackFlag(value: any): string | null {
  if (!given(value)) return null;
  if (!loop.FALLBACK_MODES.includes(String(value))) throw usage(`--fallback expects ${loop.FALLBACK_MODES.join(', ')}, got '${value}'`);
  return String(value);
}

/** 106 IC-005: `--ladder` as 1 to 8 distinct registry harness ids in order, or null when absent. */
function ladderOf(o: any): string[] | null {
  if (!given(o.ladder)) return null;
  if (given(o.harness)) throw usage('--ladder does not go with --harness: a --harness run is a one-rung ladder');
  const ids = String(o.ladder).split(',').map((id: string) => id.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > LADDER_MAX) throw usage(`--ladder expects 1 to ${LADDER_MAX} comma-separated harness ids, got ${ids.length}`);
  const known = knownWorkerIds({ registry: registryOf(o.registry) }).ids;
  const unknown = ids.find((id: string) => !known.includes(id));
  if (unknown !== undefined) throw usage(`--ladder names unknown harness '${unknown}'; known: ${known.join(', ')}`);
  if (new Set(ids).size !== ids.length) throw usage('--ladder names a harness more than once');
  return ids;
}

/**
 * 106 IC-005: the `dispatch.fallback` setting for the project at `root`, read the way `verify.reuse`
 * is (089 IC-005). Only a valid resolved `off` or `ask` applies; an invalid value, a load error or any
 * fault is the key's fail-safe `off`.
 */
function fallbackSetting(root: string, env: Env): string {
  try {
    const { loadSettings } = require('../settings/resolve.ts');
    const resolution = loadSettings({ projectRoot: root, env: { ...env } }).get('dispatch.fallback', 'project');
    return resolution?.state === 'ok' && ['off', 'ask'].includes(resolution.value) ? resolution.value : 'off';
  } catch {
    return 'off';
  }
}

/** IC-010: gate start flags and resolve the run's enabled ladder and in-session permission. */
function enabledStart(o: any, s: any, root: string, env: Env) {
  const active = activeWorkers({ registry: registryOf(o.registry), env, projectRoot: root });
  if (s.harness !== null) {
    const gate = workerGate(active, s.harness);
    if (gate) return { refusal: refused(gate.reason, { harness: gate.harness, enabled: gate.enabled, origin: gate.origin }) };
  }
  if (s.ladder !== null) {
    for (const id of s.ladder) {
      const gate = workerGate(active, id);
      if (gate) return { refusal: refused(gate.reason, { harness: gate.harness, enabled: gate.enabled, origin: gate.origin }) };
    }
  }
  if (s.mode === 'sequential') {
    const gate = inSessionGate(active);
    if (gate) return { refusal: refused(gate.reason, { text: gate.text, enabled: [...active.workers], origin: active.origin }) };
  }
  const stored = active.state !== 'unset';
  let ladder: string[] | null = s.ladder;
  if (ladder === null) {
    if (s.harness !== null) ladder = stored ? [s.harness] : null;
    else ladder = stored ? [...active.workers] : null;
  }
  return { ladder, inSession: active.inSession, stored };
}

/** IC-002 step 0: every start flag, validated and normalized. */
function startSettings(o: any) {
  const by = requireBy(o.by, 'start');
  const concurrency = concurrencyOf(given(o.concurrency) ? (typeof o.concurrency === 'number' ? o.concurrency : String(o.concurrency)) : null);
  const mode = given(o.mode) ? String(o.mode) : 'auto';
  if (!MODES.includes(mode)) throw usage(`--mode expects ${MODES.join(', ')}, got '${o.mode}'`);
  const billingCap = given(o.billingCap) ? String(o.billingCap) : null;
  if (billingCap !== null && billingCap !== 'free') throw usage(`--billing-cap expects free, got '${billingCap}'`);
  const argv = verifyArgvOf(o.verifyArgv);
  const verifySeconds = digits(o.verifySeconds, '--verify-seconds', 1, VERIFY_SECONDS_MAX) ?? VERIFY_SECONDS_DEFAULT;
  const attemptSeconds = digits(o.attemptSeconds, '--attempt-seconds', 1, ATTEMPT_SECONDS_MAX) ?? loop.ATTEMPT_SECONDS_DEFAULT;
  const reserveTokens = digits(o.reserveTokens, '--reserve-tokens', 0) ?? null;
  const budgetAttempts = digits(o.budgetAttempts, '--budget-attempts', 1);
  const budgetTokens = digits(o.budgetTokens, '--budget-tokens', 1);
  if (budgetTokens !== undefined && (reserveTokens === null || reserveTokens < 1)) {
    throw usage('--budget-tokens needs --reserve-tokens of at least 1: every claim reserves tokens against the budget');
  }
  const spawnGrant = given(o.spawnGrant) ? validateGrant(o.spawnGrant, reserveTokens) : null;
  const needs = needList(o.need);
  let harness: string | null = null;
  if (given(o.harness) || needs.length) {
    const reg = registryOf(o.registry);
    if (given(o.harness)) {
      harness = String(o.harness);
      const ids = knownWorkerIds({ registry: reg }).ids;
      if (!ids.includes(harness)) throw usage(`unknown harness '${harness}'; known: ${ids.join(', ')}`);
    }
    if (needs.length) readiness.validateNeeds(needs, o.coverage === undefined ? reg.coverage : o.coverage);
  }
  const fallback = fallbackFlag(o.fallback);
  const ladder = ladderOf(o);
  return { by, concurrency, mode, billingCap, argv, verifySeconds, attemptSeconds, reserveTokens, budgetAttempts, budgetTokens, spawnGrant, needs, harness, fallback, ladder };
}

/**
 * IC-005 step 0's `--summary`, `--blocker` and `--tokens`/`--tokens-basis` values, checked here so
 * a malformed submit is `usage` before any store read (IC-001). `loop.submit` repeats them for
 * in-process callers.
 */
function submitValues(o: any) {
  const summary = o.summary;
  if (typeof summary !== 'string' || !summary.length || Buffer.byteLength(summary, 'utf8') > SUMMARY_BYTES) throw usage(`--summary expects 1 to ${SUMMARY_BYTES} bytes`);
  const blockers = given(o.blocker) ? [].concat(o.blocker).map(String) : [];
  if (blockers.length > BLOCKERS_MAX || blockers.some((b) => !b.length || Array.from(b).length > BLOCKER_CHARS)) throw usage(`--blocker is repeatable up to ${BLOCKERS_MAX}, each 1 to ${BLOCKER_CHARS} characters`);
  if (given(o.tokens) !== given(o.tokensBasis)) throw usage('--tokens and --tokens-basis go together or not at all');
  if (given(o.tokens) && (!DIGITS.test(String(o.tokens)) || !TOKEN_BASES.includes(String(o.tokensBasis)))) throw usage('--tokens expects a whole number and --tokens-basis measured or estimated');
}

/** IC-001 step 0 for every action but start: required flags and their values. */
function actionFlags(action: string, o: any) {
  switch (action) {
    case 'step': if (given(o.by)) requireBy(o.by, action); break;
    case 'run':
      if (given(o.by)) requireBy(o.by, action);
      digits(o.maxSeconds, '--max-seconds', 1, RUN_MAX_SECONDS_MAX);
      break;
    case 'submit':
      if (!given(o.dispatch) || !DISPATCH_ID.test(String(o.dispatch))) throw usage(`--dispatch expects 'd-' plus 12 hex characters, got '${o.dispatch ?? ''}'`);
      if (o.status !== 'success' && o.status !== 'failure') throw usage('--status expects success or failure');
      submitValues(o);
      break;
    case 'spawn': {
      const request = given(o.promptFile) || given(o.reserveTokens);
      if (request && given(o.requestId)) throw usage('--request-id reads one request; it does not go with --prompt-file or --reserve-tokens');
      if (given(o.requestId)) {
        if (!REQUEST_ID_FLAG.test(String(o.requestId))) throw usage(`--request-id expects '<d-id>.c<n>', got '${o.requestId}'`);
      } else {
        if (!given(o.promptFile)) throw usage('--action spawn needs --prompt-file and --reserve-tokens, or --request-id');
        if (digits(o.reserveTokens, '--reserve-tokens', 0) === undefined) throw usage('--action spawn needs --reserve-tokens with --prompt-file');
      }
      break;
    }
    case 'pause': case 'cancel':
      requireBy(o.by, action);
      requireReason(o.reason, action);
      break;
    case 'takeover':
      requireBy(o.by, action);
      requireReason(o.reason, action);
      if (!given(o.task) || !TASK_ID.test(String(o.task))) throw usage(`--task expects a plan task id such as A.1, got '${o.task ?? ''}'`);
      break;
    case 'resume':
      if (given(o.ack) && !ACK.test(String(o.ack))) throw usage(`--ack expects sha256:<64 hex>, got '${o.ack}'`);
      if (given(o.ack)) requireBy(o.by, action);
      else if (given(o.by)) requireBy(o.by, action);
      if (given(o.reason)) requireReason(o.reason, action);
      fallbackFlag(o.fallback);
      break;
    default: break;
  }
}

function featureOf(slug: any, resolveSlug: any, cwd: string): string {
  const feature = given(slug) ? String(slug) : (resolveSlug ? resolveSlug(cwd) : null);
  if (!feature) throw usage('--slug is required: no feature could be resolved from the current branch');
  if (!isSafeSlug(feature)) throw usage(`'${feature}' is not a valid feature slug`);
  return feature;
}

/** One bounded git call through the integration manager's helper; `{ ok, stdout, code }`. */
function gitAt(root: string, slug: string, env: Env, cwd: string, args: string[]) {
  return managerFor(root, slug, 'integration', env).git(args, cwd, { allowFailure: true });
}

/** IC-002: steps 1 to 8. `s` is startSettings' result. */
function start(o: any, s: any) {
  const { env, cwd, slug, clock } = o;
  // Step 1.
  const key = runKeyFor(env, cwd);
  const who = identityRefusal(key.identity);
  if (who) return refused(who.reason, { runKey: key.runKey });
  const root = projectRoot(cwd);
  const enabled = enabledStart(o, s, root, env);
  if (enabled.refusal) return enabled.refusal;
  // Step 2.
  const roots = [...new Set([cwd, root])];
  const plan = attempts.loadPlan({ roots, slug, fsImpl: fs });
  // Step 3 (DEC-034).
  if (!isGraphPlan(plan.graph)) return refused('not-graph-plan', { slug });
  // Step 4.
  const top = key.top;
  const inside = fs.existsSync(top) ? gitAt(root, slug, env, top, ['rev-parse', '--is-inside-work-tree']) : { ok: false, stdout: '' };
  if (!inside.ok || inside.stdout.trim() !== 'true') return refused('not-a-git-worktree', { top });
  const head = gitAt(root, slug, env, top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head.ok || !head.stdout.trim()) return refused('no-head', { top });
  const base = head.stdout.trim();
  const status = gitAt(root, slug, env, top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const baseDirty = !status.ok || status.stdout.length > 0;
  // Step 5.
  const file = storeFileFor(root, slug);
  const seen = readDispatch(file);
  if (seen.run) return refused('dispatch-run-exists', { dispatchRunId: seen.run.dispatchRunId, state: seen.run.state });
  // The cap names the user's billing record it judges by, so the owner sees what counts as free.
  const billingRecord = s.billingCap ? billingRecordOf(env, registryOf(o.registry)) : null;
  // Step 6: outside every lock.
  const dispatchRunId = newDispatchRunId();
  let integration: any;
  try {
    integration = createIntegrationWorktree({ root, slug, dispatchRunId, base, env });
  } catch (error: any) {
    const code = String(error?.exitCode ?? error?.status ?? error?.signal ?? error?.code ?? 'unknown');
    return refused('integration-worktree-failed', { code });
  }
  const verify = s.argv
    ? { argv: s.argv, argvSha256: argvDigest(s.argv), argvCount: s.argv.length, timeoutSeconds: s.verifySeconds }
    : { argv: null, argvSha256: null, argvCount: 0, timeoutSeconds: s.verifySeconds };
  const remove = () => managerFor(root, slug, 'integration', env).removeVerified(dispatchRunId);
  // 106 IC-005: `--fallback` wins for the run, else the setting.
  const { ladder, inSession, stored } = enabled;
  const fallback = { mode: s.fallback ?? fallbackSetting(root, env), ladder, ...(stored ? { inSession } : {}), exhausted: [], holds: {}, events: [], eventsDropped: 0 };
  // Steps 7 and 8: one dispatch-store write, the 080 start inside it.
  let outcome: any;
  try {
    outcome = mutateDispatch(file, (store: any) => {
      if (store.run) return { write: false, result: refused('dispatch-run-exists', { dispatchRunId: store.run.dispatchRunId, state: store.run.state }) };
      const now = clock();
      const res = attempts.start({
        file: attempts.storeFile(root, slug), fsImpl: fs, roots, slug, by: s.by,
        budgetAttempts: s.budgetAttempts, budgetTokens: s.budgetTokens, env, cwd, now,
      });
      if (res.disposition !== 'started') return { write: false, result: res };
      store.run = {
        dispatchRunId, slug, state: 'running', runKey: key.runKey,
        run: key.identity.run, lineage: key.identity.lineage, lineageKind: key.identity.lineageKind,
        epoch: res.epoch, by: s.by, concurrency: s.concurrency, mode: s.mode,
        ...(s.billingCap ? { billingCap: s.billingCap } : {}),
        reserveTokens: s.reserveTokens, attemptSeconds: s.attemptSeconds, harness: s.harness, needs: s.needs,
        spawnGrant: s.spawnGrant, baseDirty, createdAt: iso(now), endedAt: null,
        integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
        verify, fallback,
      };
      return { write: true, result: { started: true, epoch: res.epoch, runKey: res.runKey } };
    });
  } catch (error) {
    remove();
    throw error;
  }
  if (!outcome.started) return { ...outcome, cleanup: remove() };
  return {
    disposition: 'started', dispatchRunId, slug, runKey: key.runKey, epoch: outcome.epoch,
    integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base },
    baseDirty, concurrency: s.concurrency, mode: s.mode,
    verification: { declared: verify.argv !== null, argc: verify.argvCount, sha256: verify.argvSha256, seconds: verify.timeoutSeconds },
    reserveTokens: s.reserveTokens, attemptSeconds: s.attemptSeconds, workerTimeoutSeconds: s.attemptSeconds + loop.BACKSTOP_SECONDS,
    spawnGrant: s.spawnGrant,
    ...(billingRecord ? { billingRecord } : {}),
  };
}

/** The `start` body's `billingRecord`: the record's state and reason, and one row per recorded worker. */
function billingRecordOf(env: Env, reg: any) {
  const { readWorkerBilling } = require('../settings/worker-billing.ts'); // lazy: see loop.ts evaluateHarnesses
  const record = readWorkerBilling(env, { workerIds: knownWorkerIds({ registry: reg }).ids });
  return {
    state: record.state, reason: record.reason,
    workers: Object.entries(record.workers).map(([harness, w]: [string, any]) => ({
      harness, billing: w.billing, asserted: w.asserted, ...(w.basis !== undefined ? { basis: w.basis } : {}),
    })),
  };
}

/** The loop's and controls' shared options: identity inputs, clock and the in-process test seams. */
function passOptions(o: any) {
  const out: any = { slug: o.slug, env: o.env, cwd: o.cwd, now: o.clock };
  for (const seam of ['platform', 'descriptors', 'registry', 'coverage', 'evaluateImpl', 'verify', 'sleep', 'fallbackDefault']) {
    if (o[seam] !== undefined) out[seam] = o[seam];
  }
  return out;
}

/**
 * 106 IC-005: after an applied resume with `--fallback`, one locked write (creating `run.fallback`
 * for a run started before 106, with the setting's mode). `off` or `ask` sets `run.fallback.mode`
 * and clears `run.fallback.accepted` (review R-2).
 * `auto` accepts once (review C-14): every hold whose reason is `quota` is deleted and its task
 * recorded in `run.fallback.accepted` with its proposal; the mode is unchanged, and the task's next
 * selection steps once. `frontier-no-step` and `ladder-exhausted` holds stay. Returns
 * `{ mode, cleared }`, `mode` the run's mode after the write.
 */
function setFallbackMode(o: any, mode: string) {
  const initial = mode === 'auto' ? fallbackSetting(projectRoot(o.cwd), o.env) : mode;
  return mutateDispatch(storeFileFor(projectRoot(o.cwd), o.slug), (s: any) => {
    if (!s.run) return { write: false, result: { mode: initial, cleared: [] } };
    const f = fallbackOf(s.run, initial);
    const cleared: string[] = [];
    if (mode !== 'auto') {
      f.mode = mode;
      // Review R-2: `off` or `ask` revokes every pending acceptance.
      if (f.accepted && typeof f.accepted === 'object') f.accepted = {};
    }
    else if (f.holds && typeof f.holds === 'object') {
      if (!f.accepted || typeof f.accepted !== 'object') f.accepted = {};
      for (const [task, hold] of Object.entries(f.holds) as [string, any][]) {
        if (!hold || hold.reason !== 'quota') continue;
        f.accepted[task] = hold.proposed ?? null;
        delete f.holds[task];
        cleared.push(task);
      }
    }
    return { write: true, result: { mode: f.mode, cleared } };
  });
}

async function perform(action: string, o: any) {
  const base = passOptions(o);
  switch (action) {
    case 'step': return loop.step({ ...base, by: given(o.by) ? String(o.by) : undefined });
    case 'run': return loop.run({ ...base, by: given(o.by) ? String(o.by) : undefined, maxSeconds: digits(o.maxSeconds, '--max-seconds', 1, RUN_MAX_SECONDS_MAX) });
    case 'submit': return loop.submit({
      ...base, dispatchId: String(o.dispatch), status: o.status, summary: o.summary,
      blockers: given(o.blocker) ? [].concat(o.blocker) : undefined,
      tokens: given(o.tokens) ? String(o.tokens) : undefined, tokensBasis: given(o.tokensBasis) ? String(o.tokensBasis) : undefined,
    });
    case 'pause': return controls.pause({ ...base, by: o.by, reason: o.reason });
    case 'inspect': {
      const body = controls.inspect(base);
      // 106 IC-005: the run's fallback state, as stored.
      if (body && body.disposition === 'inspected') body.fallback = readDispatch(storeFileFor(projectRoot(o.cwd), o.slug)).run?.fallback ?? null;
      return body;
    }
    case 'cancel': return controls.cancel({ ...base, by: o.by, reason: o.reason });
    case 'takeover': return controls.takeOver({ ...base, by: o.by, reason: o.reason, task: String(o.task) });
    case 'resume': {
      const body = await controls.resume({ ...base, by: given(o.by) ? o.by : undefined, reason: given(o.reason) ? o.reason : undefined, ack: given(o.ack) ? String(o.ack) : undefined });
      const mode = fallbackFlag(o.fallback);
      if (mode !== null && body && body.disposition === 'resumed') body.fallback = setFallbackMode(o, mode);
      return body;
    }
    default: throw usage(`unknown action '${action}'`);
  }
}

/**
 * IC-001: the `dispatch` verb. Options mirror the flags (camelCase: `action`, `slug`, `by`,
 * `reason`, `concurrency`, `mode`, `billingCap`, `verifyArgv`, `verifySeconds`, `attemptSeconds`, `reserveTokens`,
 * `budgetAttempts`, `budgetTokens`, `spawnGrant`, `harness`, `need`, `maxSeconds`, `dispatch`,
 * `status`, `summary`, `blocker`, `tokens`, `tokensBasis`, `promptFile`, `requestId`, `task`,
 * `ack`, `fallback`, `ladder`), plus `env`, `cwd`, `resolveSlug(cwd)`, `now`, and the in-process seams `platform`,
 * `descriptors`, `registry`, `coverage`, `evaluateImpl`, `verify`, `sleep`. Prints nothing.
 */
async function executeDispatchCommand(options: any = {}): Promise<{ exit: number; body: any }> {
  const env: Env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const now = options.now;
  const clock: () => Date = typeof now === 'function'
    ? () => { const at = now(); return at instanceof Date ? at : new Date(at); }
    : (now !== undefined && now !== null ? () => new Date(now) : () => new Date());
  try {
    const { action } = options;
    if (!given(action)) throw usage(`--action is required; valid: ${ACTIONS.join(' | ')}`);
    if (!ACTIONS.includes(action)) throw usage(`unknown action '${action}'; valid: ${ACTIONS.join(' | ')}`);
    refuseMisplacedFlags(action, options);
    const settings = action === 'start' ? startSettings(options) : (actionFlags(action, options), null);
    const slug = featureOf(options.slug, options.resolveSlug, cwd);
    const o = { ...options, env, cwd, slug, clock };

    let body: any;
    if (action === 'start') body = start(o, settings);
    else if (action === 'spawn') {
      body = given(options.requestId)
        ? spawnStatus({ slug, requestId: String(options.requestId), env, cwd })
        : requestSpawn({ slug, promptFile: String(options.promptFile), reserveTokens: String(options.reserveTokens), env, cwd, now: clock() });
    } else {
      // IC-001 identity checks (DEC-044), before anything the action reads for writing, runs or signals.
      const caller = loop.checkCaller({ env, cwd, file: storeFileFor(projectRoot(cwd), slug) });
      // 106 IC-004 (D3): a run started before 106 has no `run.fallback`; the loop reads it with the setting.
      if (!caller.refusal && (action === 'step' || action === 'run') && !caller.store.run.fallback && o.fallbackDefault === undefined) {
        o.fallbackDefault = fallbackSetting(projectRoot(cwd), env);
      }
      body = caller.refusal ? caller.refusal : await perform(action, o);
    }
    if (body && body.disposition === 'ran' && Number.isInteger(body.exit)) return { exit: body.exit, body };
    return { exit: body && EXIT_ZERO.includes(body.disposition) ? 0 : 1, body };
  } catch (error: any) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (code && ERROR_CODES.includes(code)) return { exit: 2, body: { ok: false, error: code, message: error.message } };
    throw error;
  }
}

/** 106 IC-004 / FR-005: one `fallback <kind> <task> <from> -> <to|none> (...)` line per fallback StepAction. */
function fallbackLines(actions: any): string[] {
  return (Array.isArray(actions) ? actions : []).filter((a: any) => a && a.action === 'fallback')
    .map((a: any) => `fallback ${String(a.reason).replace(/^([a-z]+):/, '$1 ')}`);
}

/** One summary line per result (plus one line per fallback event for step and run); inspect uses
 * IC-029's lines. No envelope, output or argv content. */
function summaryLines(body: any): string[] {
  const d = body.disposition;
  switch (d) {
    case 'started': {
      const v = body.verification;
      const record = body.billingRecord;
      const recorded = !record ? [] : record.state === 'invalid'
        ? [`billing: user record invalid (${record.reason}): no worker counts as free`]
        : record.workers.map((w: any) => `billing: ${w.harness} ${w.billing} (user record, asserted ${w.asserted})`);
      return [`started ${body.dispatchRunId} slug ${body.slug} branch ${body.integration.branch} base ${body.integration.base}${body.baseDirty ? ' (caller checkout dirty)' : ''} concurrency ${body.concurrency} mode ${body.mode} verification ${v.declared ? `argc ${v.argc} sha256 ${v.sha256}` : 'undeclared'}`, ...recorded];
    }
    case 'stepped': {
      const extra = body.perform ? ` perform ${body.perform.dispatchId} ${body.perform.task} token ${body.perform.token}` : '';
      return [`stepped ${body.dispatchRunId} step ${body.step ?? '-'} outcome ${body.outcome} actions ${body.actions.length}${extra}`, ...fallbackLines(body.actions)];
    }
    case 'ran': return [`ran ${body.dispatchRunId} steps ${body.steps} outcome ${body.outcome}${body.timeUp ? ' time-up' : ''}${body.signal ? ` signal ${body.signal}` : ''}`, ...fallbackLines(body.fallback)];
    case 'submitted': return [`submitted ${body.dispatchId} task ${body.task} token ${body.token} phase ${body.phase} changes ${body.changes.length}`];
    case 'spawn-requested': return [`spawn-requested ${body.requestId} ${body.state}`];
    case 'spawn-status': return [`spawn-status ${body.requestId} ${body.state}${body.childRunId ? ` child ${body.childRunId}` : ''}`];
    case 'paused': return [`paused ${body.dispatchRunId} active ${Array.isArray(body.active) ? body.active.length : body.active ?? 0}`];
    case 'inspected': {
      // Review C-10: one line per fallback hold after IC-029's lines.
      const holds = body.fallback && body.fallback.holds && typeof body.fallback.holds === 'object' ? body.fallback.holds : {};
      return [...controls.inspectLines(body), ...Object.entries(holds).map(([task, h]: [string, any]) => `hold ${task} ${h.reason} from ${h.from} proposed ${h.proposed ?? 'none'}`)];
    }
    case 'cancelled': return [`cancelled ${body.dispatchRunId} cleanupVerified ${body.cleanupVerified}`];
    case 'taken-over': return [`taken-over ${body.task} token ${body.token} dispatch ${body.dispatchId}`];
    case 'resumed': return [`resumed epoch ${body.epoch} settled ${body.settled.length} orphans ${body.orphans.length}${body.fallback ? ` fallback ${body.fallback.mode} cleared ${body.fallback.cleared.length}` : ''}`];
    case 'ack-required': return [`ack-required ${body.digest} settled ${Array.isArray(body.settled) ? body.settled.length : 0}`];
    default: return [`${d ?? 'refused'} ${body.reason ?? ''}`.trim()];
  }
}

/**
 * `doflow-run dispatch --action <action> ...` (IC-001). Takes `executeDispatchCommand`'s options
 * plus `json`. Prints the JSON with `json`, else one summary line (inspect: one per dispatch, then
 * the run lines); a usage or environment error goes to stderr. Sets `process.exitCode` and resolves
 * the exit code.
 */
async function handleDispatchCommand(options: any = {}): Promise<number> {
  const { finishRuntime } = require('../cli-result.ts');
  const { exit, body } = await executeDispatchCommand(options);
  if (options.json) console.log(JSON.stringify(body, null, 2));
  else if (exit === 2) console.error(`doflow dispatch: ${body.message}`);
  else for (const line of summaryLines(body)) (exit === 0 ? console.log : console.error)(line);
  return finishRuntime(exit);
}

module.exports = { handleDispatchCommand, executeDispatchCommand, summaryLines, fallbackSetting, ACTIONS, FLAG_ACTIONS, EXIT_ZERO, ERROR_CODES };
