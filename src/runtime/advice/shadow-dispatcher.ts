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

/** The advice registry's kinds (core/registry/advice.json). */
type AdviceKind = 'tier' | 'task-class' | 'verify-risk' | 'review-depth' | 'mcp-need' | 'followup-triage';
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
  adviceClient?: AdviceClient;
  /** The resolved per-kind config; resolved from the settings layers when absent. */
  shadowConfig?: KindShadowConfig;
  fsImpl?: any;
  benchGate?: BenchGate;
  roots?: StoreRoots;
}

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
  adviceRegistry?: { timeoutMs?: number; [field: string]: unknown };
  staticAnswer?: string | null;
  /** false keeps the decision write-free: no pick or miss is recorded. */
  record?: boolean;
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
  reason: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number;
}

/** The budget of one advisor call: the registry's timeoutMs (core/registry/advice.json), 0 (no call) when unknown. */
function budgetMs(context: DecisionPointContext): number {
  const own = context.adviceRegistry?.timeoutMs;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own;
  try {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    const shipped = loaded.ok ? loaded.registry.timeoutMs : null;
    return typeof shipped === 'number' && Number.isFinite(shipped) && shipped > 0 ? shipped : 0;
  } catch {
    return 0;
  }
}

/**
 * Asks the advisor with `model` (the one effective model; the client's own setting when null), bounded by `budget`.
 * When the budget ends the call's signal is aborted, so the client drops its request, socket and timer; the bound's own
 * timer is unref'd, so neither it nor a client that ignores the signal holds the process open. The client is asked
 * not to record: the dispatcher records the call itself.
 */
async function askAdvisor(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number): Promise<AdvisorCall> {
  const startedAt = Date.now();
  const call = (status: AdvisorCall['status'], reason: string | null, res?: AdviceResult | null): AdvisorCall => ({
    status, pick: null, answer: null, reason, provider: res?.provider ?? null, model: res?.model ?? model, durationMs: Date.now() - startedAt,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const client: AdviceClient = services.adviceClient || createAdviceClient({
      adviceRegistry: context.adviceRegistry,
      roots: services.roots,
      fsImpl: services.fsImpl,
    });
    const options: AskOptions = {
      questionSet: context.questionSet,
      kind: context.kind,
      staticAnswer: context.staticAnswer ?? context.staticPick,
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
    return { ...asked, pick: first.pick, answer: { ...first, model: asked.model } };
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

/** Records one advisor call through record.ts: a pick line when there is a pick, a miss line with its reason otherwise. */
function recordCall(context: DecisionPointContext, services: DispatcherServices, mode: 'shadow' | 'act', asked: AdvisorCall, pickId: string, elevated: boolean): void {
  if (context.record === false || asked.status === 'off') return;
  const roots = storeRoots(context, services);
  if (!roots) return;
  const common = { roots, fsImpl: services.fsImpl, kind: context.kind, caller: context.caller, model: asked.model, durationMs: asked.durationMs, mode };
  if (asked.status === 'answered') {
    appendPick({
      ...common,
      pickId,
      elevated,
      answer: asked.answer,
      question: context.questionSet?.questions?.[0],
      staticAnswer: context.staticAnswer ?? context.staticPick,
      provider: asked.provider,
      state: context.questionSet?.state ?? context.state,
      taskId: context.taskId ?? null,
    });
  } else {
    appendMiss({ ...common, reason: asked.reason });
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
  const mode: AdviceMode = capMode(profileAdvisorCap({ projectRoot: context.projectRoot, env: context.env, fsImpl: services.fsImpl }), config.mode);
  const staticPick = context.staticPick;
  const unchanged = { kind: context.kind, effectiveDecision: staticPick, staticPick, advisorPick: null, elevated: false, agreed: null };

  // Off: no model call, no record.
  if (mode !== 'act' && mode !== 'shadow') return { ...unchanged, mode: 'off', pickId: null };

  // The one effective model: the bar is checked for it, the client is asked with it, and the record names it.
  const model = config.model;
  const budget = budgetMs(context);
  const pickId = newPickId();

  // Shadow: return the static pick now; the detached call records its pick or miss. With record:false nothing could be
  // kept, so no call is made.
  const shadow = (warning?: string): DecisionPointResolution => {
    if (context.record !== false) {
      askAdvisor(context, services, model, budget)
        .then((asked) => recordCall(context, services, 'shadow', asked, pickId, false))
        .catch(() => {});
    }
    return { ...unchanged, mode: 'shadow', pickId, ...(warning ? { warning } : {}) };
  };
  if (mode === 'shadow') return shadow();

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
};
