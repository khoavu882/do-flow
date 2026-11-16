'use strict';

const { resolveShadowConfig } = require('./shadow-config.ts');
const { applyElevationInvariant } = require('./elevation.ts');
const { evaluateBenchBar } = require('./bench-gate.ts');
const { appendPick, appendMiss, newPickId } = require('./record.ts');
const { createAdviceClient } = require('./client.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { profileAdvisorCap, capMode } = require('./mode.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** The detached shadow call's entry point (row 174 O-2). */
const RUNNER = path.join(__dirname, 'shadow-runner.ts');

/** The advice registry's kinds (core/registry/advice.json). */
type AdviceKind = 'tier' | 'task-class' | 'verify-risk' | 'review-depth' | 'mcp-need' | 'claim-support';
type AdviceMode = 'off' | 'shadow' | 'act';
type Env = Record<string, string | undefined>;
type StoreRoots = Record<string, string | null>;

interface QuestionSet {
  state: string;
  questions: Array<{ name: string; type: string; [field: string]: unknown }>;
}

interface AdviceAnswer {
  name?: string;
  type?: string;
  pick?: unknown;
  [field: string]: unknown;
}

/** The advice client's reply (client.ts ask). */
interface AdviceResult {
  status?: string;
  reason?: string | null;
  provider?: string | null;
  model?: string | null;
  answers?: AdviceAnswer[];
}

interface AskOptions {
  questionSet?: QuestionSet;
  kind: AdviceKind;
  staticAnswer: string | null;
  caller: string;
  taskId: string | null;
  record: false;
  model?: string;
  /** Aborted when the dispatcher's budget ends (client.ts ask). */
  signal?: { readonly aborted: boolean };
}

interface AdviceClient {
  ask(options: AskOptions): Promise<AdviceResult>;
}

interface KindShadowConfig {
  kind: string;
  mode: AdviceMode;
  model: string | null;
}

interface BenchBarResult {
  passed: boolean;
  reason?: string;
}

type BenchGate = (kind: AdviceKind, model: string) => BenchBarResult | Promise<BenchBarResult>;

interface DispatcherServices {
  /** The client of an act call. A shadow call never uses it: it runs in the detached child, which builds its own. */
  adviceClient?: AdviceClient;
  /** The resolved per-kind config; resolved from the settings layers when absent. */
  shadowConfig?: KindShadowConfig;
  fsImpl?: any;
  benchGate?: BenchGate;
  roots?: StoreRoots;
  /** Starts the detached shadow child; node:child_process spawn when absent. */
  spawn?: typeof spawn;
}

type RegistryKind = { id?: string; maxMode?: string; criteriaFrom?: string; budgetMs?: number; params?: Record<string, unknown> };

interface DecisionPointContext {
  kind: AdviceKind;
  caller: string;
  state: string;
  staticPick: string;
  taskId?: string | null;
  projectRoot?: string;
  env?: Env;
  /** The client question set (IC-001 of the advice client) and its registry; without them the advisor answers unavailable. */
  questionSet?: QuestionSet;
  adviceRegistry?: { timeoutMs?: number; kinds?: RegistryKind[]; [field: string]: unknown };
  staticAnswer?: string | null;
  /** false keeps the decision write-free: no pick or miss is recorded. */
  record?: boolean;
  /** A lower budget for this call in ms; the kind's registry budgetMs bounds it either way (row 174 O-3). */
  budgetMs?: number;
  /**
   * Data for the pick line's extra payload, rebuilt by kind once the call is answered (DESCRIBERS): a callback cannot
   * cross into the detached shadow child, so a call site hands data, never a function. record.ts keeps only its
   * allowlisted fields.
   */
  lineExtra?: Record<string, unknown>;
}

interface DecisionPointResolution {
  kind: AdviceKind;
  effectiveDecision: string;
  mode: AdviceMode;
  staticPick: string;
  advisorPick: string | null;
  advisorAnswer?: (AdviceAnswer & { model: string | null }) | null;
  pickId: string | null;
  elevated: boolean;
  agreed: boolean | null;
  warning?: string;
}

/** One advisor call: the pick, or the reason there is none. `off` means the advice setting is off: nothing is recorded. */
interface AdvisorCall {
  status: 'answered' | 'miss' | 'off';
  pick: string | null;
  answer: (AdviceAnswer & { model: string | null }) | null;
  /** Every answer of the reply, in question order; `answer` and `pick` are the first one's. */
  answers: Array<AdviceAnswer & { model: string | null }>;
  reason: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The budget of one advisor call (row 174 O-3): the kind's registry budgetMs, lowered by the context's own `budgetMs`
 * when that is smaller; the registry's timeoutMs only for a kind the registry does not list; 0 (no call) when unknown.
 */
function budgetMs(context: DecisionPointContext): number {
  let own = registryKind(context)?.budgetMs;
  if (!positive(own)) own = context.adviceRegistry?.timeoutMs;
  if (!positive(own)) {
    try {
      const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
      own = loaded.ok ? loaded.registry.timeoutMs : 0;
    } catch {
      own = 0;
    }
  }
  const ceiling = positive(own) ? own : 0;
  const given = context.budgetMs;
  return positive(given) && (ceiling === 0 || given < ceiling) ? given : ceiling;
}

const MODE_RANK: Record<string, number> = { off: 0, shadow: 1, act: 2 };

/** The kind's registry entry: from the context's registry when it lists kinds, else the shipped one; null when unknown. */
function registryKind(context: DecisionPointContext): RegistryKind | null {
  try {
    let kinds = context.adviceRegistry?.kinds;
    if (!Array.isArray(kinds)) {
      const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
      kinds = loaded.ok ? loaded.registry.kinds : [];
    }
    return (kinds ?? []).find((entry) => entry?.id === context.kind) ?? null;
  } catch {
    return null;
  }
}

/** The static answer the client checks and the pick line records; an empty one (`advise --kind` without --static) is none. */
function staticAnswerOf(context: Pick<DecisionPointContext, 'staticAnswer' | 'staticPick'>): string | null {
  return context.staticAnswer || context.staticPick || null;
}

/**
 * Asks the advisor with `model` (the one effective model; the client's own setting when null), bounded by `budget`.
 * When the budget ends the call's signal is aborted, so the client drops its request, socket and timer. The client is
 * asked not to record: the caller records the call itself (recordCall). An act call runs it in the command's process;
 * a shadow call runs it in the detached child (shadow-runner.ts), so it never holds the command open.
 */
async function askAdvisor(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number): Promise<AdvisorCall> {
  const startedAt = Date.now();
  const call = (status: AdvisorCall['status'], reason: string | null, res?: AdviceResult | null): AdvisorCall => ({
    status, pick: null, answer: null, answers: [], reason, provider: res?.provider ?? null, model: res?.model ?? model, durationMs: Date.now() - startedAt,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const client: AdviceClient = services.adviceClient || createAdviceClient({
      adviceRegistry: context.adviceRegistry,
      roots: services.roots,
      fsImpl: services.fsImpl,
    });
    const callBuilt = (context.questionSet?.questions?.length ?? 0) > 1 || registryKind(context)?.criteriaFrom === 'call';
    const options: AskOptions = {
      questionSet: context.questionSet,
      kind: context.kind,
      // The client checks a static answer against the first question, which is wrong for a multi-question set (a label is
      // not a level of a score question) and meaningless for a call-built kind; the dispatcher still records staticPick.
      staticAnswer: callBuilt ? null : staticAnswerOf(context),
      caller: context.caller,
      taskId: context.taskId ?? null,
      record: false,
      signal: controller.signal,
    };
    if (model) options.model = model;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, budget);
      timer.unref?.();
    });
    const res = await Promise.race([client.ask(options), timeout]);
    if (res === 'timeout') return call('miss', 'timeout');
    if (res?.status === 'off') return call('off', res.reason ?? null, res);
    if (res?.status !== 'answered') return call('miss', typeof res?.reason === 'string' && res.reason ? res.reason : 'unavailable', res);
    const first = res.answers?.[0];
    if (typeof first?.pick !== 'string' || !first.pick) return call('miss', 'malformed-reply', res);
    const asked = call('answered', null, res);
    // The answer carries the model that was asked, so a caller can report it.
    const answers = (res.answers ?? []).map((answer) => ({ ...answer, model: asked.model }));
    return { ...asked, pick: first.pick, answer: { ...first, model: asked.model }, answers };
  } catch {
    return call('miss', 'config-invalid');
  } finally {
    clearTimeout(timer);
  }
}

function storeRoots(context: DecisionPointContext, services: DispatcherServices): StoreRoots | null {
  if (services.roots) return services.roots;
  try {
    return resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: context.projectRoot, env: context.env });
  } catch {
    return null;
  }
}

/**
 * The pick line's extra payload per kind, rebuilt from the context's `lineExtra` data and the answered call; `null`
 * records the call as a `malformed-reply` miss. A kind without an entry
 * writes no extra payload. Each entry is code the detached child requires, so no callback crosses a process.
 */
const DESCRIBERS: Record<string, (call: AdvisorCall, context: DecisionPointContext) => { extra?: Record<string, unknown> } | null> = {
  // The model's answer is on the pick line (`probabilities.yes`); a reply that is not a readable yes/no answer is a miss.
  'claim-support': (call, context) => {
    const yes = call.answer?.probabilities && (call.answer.probabilities as Record<string, unknown>).yes;
    if (call.answer?.type !== 'yesno' || typeof yes !== 'number' || !Number.isFinite(yes)) return null;
    return { extra: { claimSupport: context.lineExtra?.claimSupport } };
  },
};

/** Records one advisor call through record.ts: a pick line when there is a pick, a miss line with its reason otherwise. */
function recordCall(context: DecisionPointContext, services: DispatcherServices, mode: 'shadow' | 'act', asked: AdvisorCall, pickId: string, elevated: boolean): void {
  if (context.record === false || asked.status === 'off') return;
  const roots = storeRoots(context, services);
  if (!roots) return;
  const common = { roots, fsImpl: services.fsImpl, kind: context.kind, caller: context.caller, model: asked.model, durationMs: asked.durationMs, mode };
  if (asked.status === 'answered') {
    const answer = asked.answer;
    let extra: Record<string, unknown> | undefined;
    const describe = Object.hasOwn(DESCRIBERS, context.kind) ? DESCRIBERS[context.kind] : null;
    if (describe) {
      let described: ReturnType<typeof describe> = null;
      try { described = describe(asked, context); } catch { described = null; }
      if (!described || typeof described !== 'object') {
        appendMiss({ ...common, reason: 'malformed-reply' });
        return;
      }
      extra = described.extra;
    }
    appendPick({
      ...common,
      pickId,
      elevated,
      answer,
      extra,
      question: context.questionSet?.questions?.[0],
      staticAnswer: staticAnswerOf(context),
      provider: asked.provider,
      state: context.questionSet?.state ?? context.state,
      taskId: context.taskId ?? null,
    });
  } else {
    appendMiss({ ...common, reason: asked.reason });
  }
}

/** A call that was never made, for a miss recorded without asking (spawn-failed, busy). */
function missCall(reason: string, model: string | null): AdvisorCall {
  return { status: 'miss', pick: null, answer: null, answers: [], reason, provider: null, model, durationMs: 0 };
}

/** What the detached child receives on stdin (row 174 O-5): in memory only, never in argv, env or a file. */
interface ShadowPayload {
  v: 1;
  context: Pick<DecisionPointContext, 'kind' | 'caller' | 'state' | 'staticPick' | 'staticAnswer' | 'taskId' | 'questionSet' | 'adviceRegistry' | 'lineExtra'>;
  model: string | null;
  budgetMs: number;
  pickId: string;
  roots: StoreRoots;
}

/** Whether `registry` is the shipped core/registry/advice.json, which the detached child loads itself. */
function shippedRegistry(registry: unknown): boolean {
  try {
    return JSON.stringify(registry) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Hands one shadow call to a detached child (shadow-runner.ts), which takes a slot, asks, records its pick or miss and
 * exits; the command never waits for the model. The child holds neither this process's event loop nor its stdio:
 * its stdout and stderr are ignored and its handle is unref'd. The payload goes through the child's stdin pipe, written
 * in blocking mode, so it is in the pipe or read by the child before this returns and survives the command calling
 * process.exit right after. The shipped registry stays behind (the child loads it), so a state within limits.maxBodyBytes
 * fits the pipe's buffer (64 KiB on Linux and macOS) and costs one write; a larger payload (an injected registry with a
 * near-maximal state) waits for the child to start and read, about its start-up time. The child reads its stdin before
 * anything else. Where the pipe cannot block, the write stays queued and referenced until
 * read, and is dropped once the budget ends. A spawn that fails records a `spawn-failed` miss and makes no call.
 * Never throws.
 * Ceiling accepted: a child that is alive but never reads (stopped by a signal) holds a payload over the buffer, and so
 * the command, on its blocking write.
 */
function spawnShadow(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number, pickId: string): void {
  const roots = storeRoots(context, services);
  if (!roots) return;
  const failed = () => recordCall(context, services, 'shadow', missCall('spawn-failed', model), pickId, false);
  try {
    const registry = context.adviceRegistry;
    // The state usually is the question set's state too: it crosses once, and the child puts it back (shadow-runner.ts).
    const questionSet = context.questionSet && context.questionSet.state === context.state
      ? { ...context.questionSet, state: undefined } : context.questionSet;
    const payload: ShadowPayload = {
      v: 1,
      context: {
        kind: context.kind, caller: context.caller, state: context.state, staticPick: context.staticPick,
        staticAnswer: context.staticAnswer, taskId: context.taskId ?? null, questionSet: questionSet as QuestionSet | undefined,
        // An injected full registry crosses as data; the shipped one and a partial one (no kinds) leave the child on the
        // shipped registry.
        adviceRegistry: Array.isArray(registry?.kinds) && !shippedRegistry(registry) ? registry : undefined,
        lineExtra: context.lineExtra,
      },
      model, budgetMs: budget, pickId, roots,
    };
    const child = (services.spawn || spawn)(process.execPath, [RUNNER], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: context.env || process.env, windowsHide: true,
    });
    child.once('error', failed);
    const stdin = child.stdin;
    if (!stdin) { failed(); return; }
    stdin.on('error', () => {});
    try { (stdin as any)._handle?.setBlocking?.(true); } catch { /* the queued write below still delivers on a normal exit */ }
    const drop = setTimeout(() => stdin.destroy(), budget);
    drop.unref();
    stdin.once('close', () => clearTimeout(drop));
    stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {
    failed();
  }
}

async function interceptDecisionPoint(context: DecisionPointContext, services: DispatcherServices = {}): Promise<DecisionPointResolution> {
  const config: KindShadowConfig = services.shadowConfig || resolveShadowConfig(context.kind, {
    projectRoot: context.projectRoot,
    env: context.env,
    fsImpl: services.fsImpl,
    roots: services.roots,
  });

  // A chosen rollout profile caps the configured mode (mode.ts; `staged` caps act to shadow, D2).
  let mode: AdviceMode = capMode(profileAdvisorCap({ projectRoot: context.projectRoot, env: context.env, fsImpl: services.fsImpl }), config.mode);
  const staticPick = context.staticPick;
  const unchanged = { kind: context.kind, effectiveDecision: staticPick, staticPick, advisorPick: null, elevated: false, agreed: null };

  // Off: no model call, no record.
  if (mode !== 'act' && mode !== 'shadow') return { ...unchanged, mode: 'off', pickId: null };

  // A kind with a registry `maxMode` is held at it, whatever is configured (141 IC-010): act is lowered to shadow with a
  // warning, so such a kind never reaches the bench-bar branch or the elevation invariant.
  const maxMode = registryKind(context)?.maxMode;
  const heldWarning = typeof maxMode === 'string' && Object.hasOwn(MODE_RANK, maxMode) && MODE_RANK[mode] > MODE_RANK[maxMode]
    ? `ACT_NOT_SUPPORTED: kind '${context.kind}' is limited to ${maxMode}` : undefined;
  if (heldWarning) {
    mode = maxMode as AdviceMode;
    if (mode === 'off') return { ...unchanged, mode: 'off', pickId: null, warning: heldWarning };
  }

  // The one effective model: the bar is checked for it, the client is asked with it, and the record names it.
  const model = config.model;
  const budget = budgetMs(context);
  const pickId = newPickId();

  // Shadow: return the static pick now; the detached child records its pick or miss. With record:false nothing could be
  // kept, so no call is made.
  const shadow = (warning?: string): DecisionPointResolution => {
    if (context.record !== false) {
      // No known budget (the registry could not be read) is a call that would time out at once: record that, unasked.
      if (budget > 0) spawnShadow(context, services, model, budget, pickId);
      else recordCall(context, services, 'shadow', missCall('timeout', model), pickId, false);
    }
    return { ...unchanged, mode: 'shadow', pickId, ...(warning ? { warning } : {}) };
  };
  if (mode === 'shadow') return shadow(heldWarning);

  // Act: only past the bench bar for the model that will be asked; otherwise it degrades to shadow.
  let bar: BenchBarResult = { passed: false, reason: `no model is named for kind '${context.kind}'` };
  if (model) {
    try {
      bar = await (services.benchGate || evaluateBenchBar)(context.kind, model);
    } catch (error: any) {
      bar = { passed: false, reason: `bench gate failed: ${error?.message || 'unknown error'}` };
    }
  }
  if (bar?.passed !== true) return shadow(`BENCH_BAR_UNMET: ${bar?.reason || 'Accuracy failed static baseline'}`);

  const asked = await askAdvisor(context, services, model, budget);
  const { effectiveDecision, elevated } = applyElevationInvariant(context.kind, staticPick, asked.pick);
  recordCall(context, services, 'act', asked, pickId, elevated);

  return {
    kind: context.kind,
    effectiveDecision,
    mode: 'act',
    staticPick,
    advisorPick: asked.pick,
    advisorAnswer: asked.answer,
    pickId,
    elevated,
    agreed: asked.pick !== null ? asked.pick === staticPick : null,
  };
}

module.exports = {
  interceptDecisionPoint,
  // For the detached child (shadow-runner.ts) only.
  askAdvisor, recordCall, missCall,
};
