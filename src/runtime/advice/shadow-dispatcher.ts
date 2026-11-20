'use strict';

const { resolveShadowConfig } = require('./shadow-config.ts');
const { applyElevationInvariant } = require('./elevation.ts');
const { appendPick, appendMiss, newPickId } = require('./record.ts');
const { createAdviceClient } = require('./client.ts');
const { materializeKind } = require('./kinds.ts');
const { resolveSetting } = require('./config.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('../storage/roots.ts');
const { profileAdvisorCap, capMode } = require('./mode.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { takeSlot, adoptSlot, writeHandoff, releaseSlot, fullRegistry, SLOT_STORE } = require('./shadow-runner.ts');

/**
 * The detached shadow call's entry point (row 174 O-2), with this file's own extension: `.ts` in the checkout, `.js` in
 * the published package, where every source is converted (src/release/build-package.ts).
 */
const RUNNER = path.join(__dirname, `shadow-runner${path.extname(__filename)}`);

/** The advice registry's kinds (core/registry/advice.json). */
type AdviceKind = 'tier' | 'task-class' | 'verify-risk' | 'review-depth' | 'mcp-need' | 'claim-support' | 'instructs-reader' | 'same-issue';
type AdviceMode = 'off' | 'shadow' | 'show' | 'act';
type Env = Record<string, string | undefined>;
type StoreRoots = Record<string, string | null>;
/** One decision's abort controller (node's global AbortController). */
type Controller = InstanceType<typeof AbortController>;

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
  /** What is left of the decision's budget on the waited path; it bounds the client call in place of the kind's budgetMs. */
  timeoutMs?: number;
}

interface AdviceClient {
  ask(options: AskOptions): Promise<AdviceResult>;
  /** The model build's digest from the provider listing (client.ts); a client without it reads no digest. */
  modelDigest?(options: Record<string, unknown>): Promise<{ digest: string | null; reason: string | null }>;
}

interface KindShadowConfig {
  kind: string;
  mode: AdviceMode;
  model: string | null;
  /** Which settings layer set the mode; a null `mode` is a kind no layer sets (shadow-config.ts). */
  decidedBy?: { mode: string | null; model?: string | null };
}

/** The standing of the kind's local result (replay/trust.ts evaluateTrust), with its one-line reason. */
interface TrustAnswer {
  standing: string;
  reason: string;
  [field: string]: unknown;
}

/** What the trust evaluator is asked: evaluateTrust's options (replay/trust.ts). */
interface TrustRequest {
  kind: AdviceKind;
  model: string;
  provider?: string;
  endpoint?: string;
  question: unknown;
  registry: unknown;
  roots: StoreRoots | null;
  client: AdviceClient;
  projectRoot: string;
  timeoutMs: number;
  signal: Controller['signal'];
}

type Trust = (request: TrustRequest) => TrustAnswer | Promise<TrustAnswer>;

interface DispatcherServices {
  /** The client of an act call. A shadow call never uses it: it runs in the detached child, which builds its own. */
  adviceClient?: AdviceClient;
  /** The resolved per-kind config; resolved from the settings layers when absent. */
  shadowConfig?: KindShadowConfig;
  fsImpl?: any;
  /** The trust evaluator of a show or act decision; replay/trust.ts evaluateTrust when absent. */
  trust?: Trust;
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
  /**
   * 176 IC-004: the static answer of each question, aligned with `questionSet.questions`. A set with one static answer
   * per question, one question included, is a batch, recorded one line per question (`staticPick` is then
   * `staticPicks[0]`); any other decision records its one line (isBatch).
   */
  staticPicks?: string[];
  taskId?: string | null;
  projectRoot?: string;
  /** The checkout whose settings layer applies when it is not projectRoot's (`advise` in a linked worktree); projectRoot otherwise. */
  settingsRoot?: string;
  env?: Env;
  /** The client question set (IC-001 of the advice client) and its registry; without them the advisor answers unavailable. */
  questionSet?: QuestionSet;
  adviceRegistry?: { timeoutMs?: number; kinds?: RegistryKind[]; [field: string]: unknown };
  staticAnswer?: string | null;
  /** false keeps the decision write-free: no pick or miss is recorded. */
  record?: boolean;
  /**
   * Data for the pick line's extra payload, rebuilt by kind once the call is answered (DESCRIBERS): a callback cannot
   * cross into the detached shadow child, so a call site hands data, never a function. record.ts keeps only its
   * allowlisted fields.
   */
  lineExtra?: Record<string, unknown>;
  /**
   * `show` when the caller displays the model's answer (175 D11). Without it a kind set to `show` runs as shadow, and one
   * set to `act` acts only at standing act: no awaited call is made for an answer nobody displays.
   */
  surface?: 'show';
}

interface DecisionPointResolution {
  kind: AdviceKind;
  effectiveDecision: string;
  mode: AdviceMode;
  staticPick: string;
  advisorPick: string | null;
  advisorAnswer?: (AdviceAnswer & { model: string | null }) | null;
  /**
   * Per recorded line of a shown or act decision (176 IC-004): the model's pick and strength word, or null. A batch has
   * one entry per question; any other decision the one entry of its first answer. Empty on off and shadow.
   */
  advisorAnswers: Array<{ pick: string; strength: string | null } | null>;
  pickId: string | null;
  /** Per recorded line of a shown or act decision: its pick id, the first being `pickId` (one entry unless a batch). */
  pickIds: string[];
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
 * The budget of one advisor call (row 174 O-3): the kind's registry budgetMs; the registry's timeoutMs only for a kind
 * the registry does not list; 0 (no call) when unknown.
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
  return positive(own) ? own : 0;
}

const MODE_RANK: Record<string, number> = { off: 0, shadow: 1, show: 2, act: 3 };

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
 * asked not to record: the caller records the call itself (recordCall). A show or act call runs it in the command's
 * process, after the trust call: `shared` is that decision's one abort controller and `budget` what is left of its
 * budgetMs, which the client is also given as its own bound. A shadow call runs it in the detached child
 * (shadow-runner.ts), so it never holds the command open.
 */
async function askAdvisor(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number, shared?: Controller): Promise<AdvisorCall> {
  const startedAt = Date.now();
  const call = (status: AdvisorCall['status'], reason: string | null, res?: AdviceResult | null): AdvisorCall => ({
    status, pick: null, answer: null, answers: [], reason, provider: res?.provider ?? null, model: res?.model ?? model, durationMs: Date.now() - startedAt,
  });
  if (shared && (budget <= 0 || shared.signal.aborted)) return call('miss', 'timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = shared || new AbortController();
  try {
    const client: AdviceClient = services.adviceClient || createAdviceClient({
      adviceRegistry: context.adviceRegistry,
      roots: services.roots,
      fsImpl: services.fsImpl,
    });
    const callBuilt = isBatch(context) || (context.questionSet?.questions?.length ?? 0) > 1 || registryKind(context)?.criteriaFrom === 'call';
    const options: AskOptions = {
      questionSet: context.questionSet,
      kind: context.kind,
      // The client checks a static answer against the first question, which is wrong for a multi-question set (a label is
      // not a level of a score question) and meaningless for a batch or a call-built kind; the dispatcher still records it.
      staticAnswer: callBuilt ? null : staticAnswerOf(context),
      caller: context.caller,
      taskId: context.taskId ?? null,
      record: false,
      signal: controller.signal,
    };
    if (model) options.model = model;
    if (shared) options.timeoutMs = Math.max(1, Math.ceil(budget));
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
  // 177: the same readable-answer rule; the passage never crosses, only ids, counts and flags (record.ts cleanInstructsReader).
  'instructs-reader': (call, context) => {
    const yes = call.answer?.probabilities && (call.answer.probabilities as Record<string, unknown>).yes;
    if (call.answer?.type !== 'yesno' || typeof yes !== 'number' || !Number.isFinite(yes)) return null;
    return { extra: { instructsReader: context.lineExtra?.instructsReader } };
  },
};

/**
 * A declared batch (176 IC-004): `staticPicks` holds one static answer per question, of one question or more, so a
 * one-case batch is judged against the kind's question like any other batch. Only a batch records a line per question;
 * any other decision, a caller's own multi-question set included (the ad hoc `advise` path), records its one line as
 * before. shadow-runner.ts's spawn-failed fallback repeats this test.
 */
function isBatch(context: Pick<DecisionPointContext, 'staticPicks' | 'questionSet'>): boolean {
  const count = context.questionSet?.questions?.length ?? 0;
  return count >= 1 && Array.isArray(context.staticPicks) && context.staticPicks.length === count;
}

/** How many lines the decision records: one per question for a batch, one otherwise. */
function lineCount(context: DecisionPointContext): number {
  return isBatch(context) ? context.staticPicks?.length ?? 1 : 1;
}

/** The static answer recorded for line `index`: a batch takes it from `staticPicks`, any other decision keeps its one. */
function staticAnswerAt(context: DecisionPointContext, index: number): string | null {
  if (!isBatch(context)) return staticAnswerOf(context);
  const given = context.staticPicks?.[index];
  return typeof given === 'string' && given ? given : null;
}

/**
 * Records one advisor call through record.ts, one line per question (176 IC-004, O-1 (a)): a pick line for each answer,
 * a miss line with the call's reason for each question otherwise. Every line carries the call's model and duration; the
 * first question's pick line takes `pickId`, each other one a new id. Returns the pick id of every question.
 */
function recordCall(context: DecisionPointContext, services: DispatcherServices, mode: 'shadow' | 'show' | 'act', asked: AdvisorCall, pickId: string, elevated: boolean): string[] {
  const count = lineCount(context);
  const pickIds = [pickId, ...Array.from({ length: count - 1 }, () => newPickId())];
  if (context.record === false || asked.status === 'off') return pickIds;
  const roots = storeRoots(context, services);
  if (!roots) return pickIds;
  const common = { roots, fsImpl: services.fsImpl, kind: context.kind, caller: context.caller, model: asked.model, durationMs: asked.durationMs, mode };
  for (let index = 0; index < count; index += 1) {
    if (asked.status !== 'answered') {
      appendMiss({ ...common, reason: asked.reason });
      continue;
    }
    // The first answer is the call's own; another question's answer stands for the call in its describer.
    const answer = index === 0 ? asked.answer : asked.answers[index] ?? null;
    const own: AdvisorCall = index === 0 ? asked : { ...asked, answer, pick: typeof answer?.pick === 'string' ? answer.pick : null };
    if (index > 0 && !own.pick) {
      appendMiss({ ...common, reason: 'malformed-reply' });
      continue;
    }
    let extra: Record<string, unknown> | undefined;
    const describe = Object.hasOwn(DESCRIBERS, context.kind) ? DESCRIBERS[context.kind] : null;
    if (describe) {
      let described: ReturnType<typeof describe> = null;
      try { described = describe(own, context); } catch { described = null; }
      if (!described || typeof described !== 'object') {
        appendMiss({ ...common, reason: 'malformed-reply' });
        continue;
      }
      extra = described.extra;
    }
    appendPick({
      ...common,
      pickId: pickIds[index],
      // Only the first answer can raise the decision (applyElevationInvariant), so only its line can be elevated.
      elevated: index === 0 ? elevated : false,
      answer,
      extra,
      question: context.questionSet?.questions?.[index],
      staticAnswer: staticAnswerAt(context, index),
      provider: asked.provider,
      state: context.questionSet?.state ?? context.state,
      taskId: context.taskId ?? null,
    });
  }
  return pickIds;
}

/** A call that was never made, for a miss recorded without asking (spawn-failed, busy). */
function missCall(reason: string, model: string | null): AdvisorCall {
  return { status: 'miss', pick: null, answer: null, answers: [], reason, provider: null, model, durationMs: 0 };
}

/**
 * What the detached child reads from its handoff file (row 174 R-02): written by this process, readable by this user
 * only, in the slot store; the child reads and removes it first. Never in argv or env (O-5).
 */
interface ShadowPayload {
  v: 1;
  context: Pick<DecisionPointContext, 'kind' | 'caller' | 'state' | 'staticPick' | 'staticPicks' | 'staticAnswer' | 'taskId' | 'questionSet' | 'adviceRegistry' | 'lineExtra'>;
  model: string | null;
  budgetMs: number;
  pickId: string;
  roots: StoreRoots;
  /** The slot this process took for the child (shadow-runner.ts takeSlot); the child frees it. */
  slot: { file: string; token: string; startedAt: number };
}

/**
 * The full advice registry (shadowSlots, limits, providers, kinds and bars): the context's when it is a full one, else the
 * shipped one.
 */
function fullAdviceRegistry(context: DecisionPointContext): Record<string, any> | null {
  if (fullRegistry(context.adviceRegistry)) return context.adviceRegistry as Record<string, any>;
  try {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    return loaded.ok ? loaded.registry : null;
  } catch {
    return null;
  }
}

/**
 * Takes one of the user's shadow slots for a child about to start (row 174 R-04): admission happens here, before any
 * process exists, so at most `shadowSlots` shadow children are alive per user at any time. Null when none is free.
 */
function admit(context: DecisionPointContext, roots: StoreRoots, budget: number): { file: string; token: string; startedAt: number } | null {
  try {
    const limit = fullAdviceRegistry(context)?.shadowSlots;
    const dir = resolveStorePath({ store: SLOT_STORE, roots });
    return dir && Number.isInteger(limit) && (limit as number) > 0 ? takeSlot(dir, limit, budget) : null;
  } catch {
    return null;
  }
}

/** Whether `registry` is the shipped core/registry/advice.json, which the detached child loads itself. */
function shippedRegistry(registry: unknown): boolean {
  try {
    return JSON.stringify(registry) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8')));
  } catch {
    return false;
  }
}

/** Whether the call's state is over the kind's input cap (limits.maxStateBytes, the cap client.ts and cli.ts apply). */
function overLimit(context: DecisionPointContext): boolean {
  const cap = fullAdviceRegistry(context)?.limits?.maxStateBytes;
  if (!positive(cap)) return false;
  const bytes = (text: unknown) => (typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0);
  return Math.max(bytes(context.state), bytes(context.questionSet?.state)) > cap;
}

/**
 * Takes a shadow slot (none free: a `busy` miss, no child) and hands the call to a detached child (shadow-runner.ts),
 * which asks, records its pick or miss, frees the slot and exits; the command never waits for the model. The handoff
 * never blocks the command (row 174 R-02): a state over limits.maxStateBytes is an `over-limit` miss before anything
 * is taken or written, and the payload, bounded by that cap, is one local write to the slot's handoff file; the child
 * gets the file's path as its one argument and no stdio at all (no pipe that a child that never reads could fill), its
 * handle is unref'd, and the file is there before this returns, so it survives the command calling process.exit right
 * after. A runner file that is missing, a handoff that cannot be written, or a spawn that fails frees the slot and
 * records a `spawn-failed` miss; a child that starts but cannot load the modules it asks with records that miss itself
 * (shadow-runner.ts). The one silent case left: a child that cannot load record.ts, which writes every record.
 * Never throws.
 */
function spawnShadow(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number, pickId: string): void {
  const roots = storeRoots(context, services);
  if (!roots) return;
  const miss = (reason: string) => recordCall(context, services, 'shadow', missCall(reason, model), pickId, false);
  if (overLimit(context)) { miss('over-limit'); return; }
  if (!fs.existsSync(RUNNER)) { miss('spawn-failed'); return; }
  const slot = admit(context, roots, budget);
  if (!slot) { miss('busy'); return; }
  let settled = false;
  const failed = () => {
    if (settled) return;
    settled = true;
    releaseSlot(slot);
    miss('spawn-failed');
  };
  try {
    const registry = context.adviceRegistry;
    // The state usually is the question set's state too: it crosses once, and the child puts it back (shadow-runner.ts).
    const questionSet = context.questionSet && context.questionSet.state === context.state
      ? { ...context.questionSet, state: undefined } : context.questionSet;
    const payload: ShadowPayload = {
      v: 1,
      context: {
        kind: context.kind, caller: context.caller, state: context.state, staticPick: context.staticPick,
        staticPicks: context.staticPicks, staticAnswer: context.staticAnswer, taskId: context.taskId ?? null, questionSet: questionSet as QuestionSet | undefined,
        // An injected full registry crosses as data; the shipped one and a partial one (no kinds) leave the child on the
        // shipped registry.
        adviceRegistry: Array.isArray(registry?.kinds) && !shippedRegistry(registry) ? registry : undefined,
        lineExtra: context.lineExtra,
      },
      model, budgetMs: budget, pickId, roots, slot,
    };
    const handoff = writeHandoff(slot, JSON.stringify(payload));
    const child = (services.spawn || spawn)(process.execPath, [RUNNER, handoff], {
      detached: true, stdio: 'ignore', env: context.env || process.env, windowsHide: true,
    });
    child.once('error', failed);
    adoptSlot(slot, child.pid);
    child.unref();
  } catch {
    failed();
  }
}

/**
 * The question the kind's local result was measured on: the decision's first one, or for a batch, whose questions are
 * lettered blocks, the kind's materialised question (replay/run.ts digests that one).
 */
function trustQuestion(context: DecisionPointContext, registry: unknown): unknown {
  if (!isBatch(context)) return context.questionSet?.questions?.[0] ?? null;
  const built = materializeKind(context.kind, { adviceRegistry: registry });
  return built?.ok ? built.question : null;
}

/**
 * The standing of the kind's local result for `model` (175 IC-009): the trust evaluator (replay/trust.ts evaluateTrust, or
 * the injected one) inside the decision's budget. It gets the whole budget as `timeoutMs` and the decision's one abort
 * signal, which the ask then shares; the client caps its listing at probeTimeoutMs. The budget ending aborts that signal
 * and answers unknown. The evaluator is loaded here, so a shadow decision never loads it. Never throws.
 */
async function judgeTrust(context: DecisionPointContext, services: DispatcherServices, model: string | null, budget: number, controller: Controller): Promise<TrustAnswer> {
  if (!model) return { standing: 'unknown', reason: `no model is named for kind '${context.kind}'` };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TrustAnswer>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ standing: 'unknown', reason: 'model digest unknown: timeout' }); }, budget);
    timer.unref?.();
  });
  try {
    const registry = fullAdviceRegistry(context);
    const roots = storeRoots(context, services);
    const setting = resolveSetting({ adviceRegistry: registry, roots, env: context.env, fsImpl: services.fsImpl });
    const client: AdviceClient = typeof services.adviceClient?.modelDigest === 'function'
      ? services.adviceClient : createAdviceClient({ adviceRegistry: registry, roots, fsImpl: services.fsImpl });
    const evaluate: Trust = services.trust || require('./replay/trust.ts').evaluateTrust;
    const request: TrustRequest = {
      kind: context.kind, model, provider: setting?.provider ?? undefined, endpoint: setting?.endpoint ?? undefined,
      question: trustQuestion(context, registry), registry, roots, client,
      projectRoot: context.projectRoot || process.cwd(), timeoutMs: budget, signal: controller.signal,
    };
    const answer = await Promise.race([Promise.resolve().then(() => evaluate(request)), timeout]);
    return answer && typeof answer.standing === 'string' ? answer : { standing: 'unknown', reason: 'the trust evaluator gave no standing' };
  } catch (error: any) {
    return { standing: 'unknown', reason: `local result could not be judged: ${error?.message || 'unknown error'}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One decision (175 IC-009). The configured mode is capped by the rollout profile, an unset kind runs in shadow, and a
 * registry `maxMode` holds the kind (MODE_RANK off < shadow < show < act). Shadow returns the static pick at once and the
 * detached child records the model's pick. Show and act wait for the trust evaluator, judged again on every decision:
 * act acts (the elevation invariant, raise only) only at standing act; a caller with a show surface is shown the answer
 * at standing show or act, with the static pick kept as the decision; every other case runs as shadow with the warning
 * `LOCAL_RESULT_UNMET: <standing>: <reason>`. `show` without a show surface is shadow, with no trust call.
 */
async function interceptDecisionPoint(context: DecisionPointContext, services: DispatcherServices = {}): Promise<DecisionPointResolution> {
  const settingsRoot = context.settingsRoot || context.projectRoot;
  const config: KindShadowConfig = services.shadowConfig || resolveShadowConfig(context.kind, {
    projectRoot: settingsRoot,
    env: context.env,
    fsImpl: services.fsImpl,
    roots: services.roots,
  });

  // A chosen rollout profile caps the configured mode (mode.ts; `shadow` and `staged` cap show and act to shadow).
  let mode: AdviceMode = capMode(profileAdvisorCap({ projectRoot: settingsRoot, env: context.env, fsImpl: services.fsImpl }), config.mode);
  // A kind no settings layer sets runs in shadow whatever its local result holds (row 174 O-1).
  if (config.decidedBy && config.decidedBy.mode === null && MODE_RANK[mode] > MODE_RANK.shadow) mode = 'shadow';
  const staticPick = context.staticPick;
  const unchanged = { kind: context.kind, effectiveDecision: staticPick, staticPick, advisorPick: null, advisorAnswers: [], pickIds: [], elevated: false, agreed: null };

  // Off: no model call, no record.
  if (mode === 'off') return { ...unchanged, mode: 'off', pickId: null };

  // A kind with a registry `maxMode` is held at it, whatever is configured (141 IC-010): a higher mode is lowered to the
  // limit with a warning, so a kind held at shadow never reaches the trust evaluator, and one held at show never acts.
  const maxMode = registryKind(context)?.maxMode;
  const heldWarning = typeof maxMode === 'string' && Object.hasOwn(MODE_RANK, maxMode) && MODE_RANK[mode] > MODE_RANK[maxMode]
    ? `ACT_NOT_SUPPORTED: kind '${context.kind}' is limited to ${maxMode}` : undefined;
  if (heldWarning) {
    mode = maxMode as AdviceMode;
    if (mode === 'off') return { ...unchanged, mode: 'off', pickId: null, warning: heldWarning };
  }

  // The one effective model: its local result is judged, the client is asked with it, and the record names it.
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
  // Show needs a caller that displays the answer (D11): without one no awaited call is made for it.
  if (mode === 'show' && context.surface !== 'show') return shadow(heldWarning);

  // Show and act: the trust call and the ask share one budgetMs deadline and one abort signal (NFR-003).
  const startedAt = Date.now();
  const controller = new AbortController();
  const trust = await judgeTrust(context, services, model, budget, controller);
  const shownStanding = trust.standing === 'show' || trust.standing === 'act';
  const passed: 'show' | 'act' | null = mode === 'act' && trust.standing === 'act' ? 'act'
    : context.surface === 'show' && shownStanding ? 'show' : null;
  if (!passed) {
    const unmet = `LOCAL_RESULT_UNMET: ${trust.standing}: ${trust.reason}`;
    return shadow(heldWarning ? `${heldWarning}; ${unmet}` : unmet);
  }

  const asked = await askAdvisor(context, services, model, budget - (Date.now() - startedAt), controller);
  // A shown answer never changes the decision; only act raises it, through the elevation invariant.
  const { effectiveDecision, elevated } = passed === 'act'
    ? applyElevationInvariant(context.kind, staticPick, asked.pick) : { effectiveDecision: staticPick, elevated: false };
  const pickIds = recordCall(context, services, passed, asked, pickId, elevated);
  const advisorAnswers = pickIds.map((_id, index) => {
    const answer = asked.status === 'answered' ? asked.answers[index] : null;
    return typeof answer?.pick === 'string' && answer.pick
      ? { pick: answer.pick, strength: (answer.strength as { word?: string } | undefined)?.word ?? null } : null;
  });

  return {
    kind: context.kind,
    effectiveDecision,
    mode: passed,
    staticPick,
    advisorPick: asked.pick,
    advisorAnswer: asked.answer,
    advisorAnswers,
    pickId,
    pickIds,
    elevated,
    agreed: asked.pick !== null ? asked.pick === staticPick : null,
    ...(heldWarning ? { warning: heldWarning } : {}),
  };
}

module.exports = {
  interceptDecisionPoint,
  // For the detached child (shadow-runner.ts) only.
  askAdvisor, recordCall, missCall,
};
