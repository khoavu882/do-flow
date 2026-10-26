'use strict';

const crypto = require('node:crypto');
const { resolveShadowConfig } = require('./shadow-config.ts');
const { applyElevationInvariant } = require('./elevation.ts');
const { evaluateBenchBar } = require('./bench-gate.ts');
const { recordPick } = require('./consequence-recorder.ts');
const { createAdviceClient } = require('./client.ts');
const { resolveRolloutProfile } = require('../profiles/resolve.ts');

interface DecisionPointContext {
  kind: 'tier' | 'task-class' | 'verify-risk' | 'review-depth' | 'mcp-need' | 'followup-triage' | 'autopilot' | string;
  caller: string;
  state: string;
  staticPick: string;
  taskId?: string | null;
  server?: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  options?: Record<string, any>;
  /** The client question set (IC-001 of the advice client) and its registry; without them the advisor answers unavailable. */
  questionSet?: any;
  adviceRegistry?: any;
  staticAnswer?: string | null;
  /** false keeps the decision write-free: no pick is recorded. */
  record?: boolean;
}

/**
 * The advisor's pick for this decision, or null when it is unavailable. The dispatcher records the pick
 * itself (IC-003), so the client is asked not to record a second one.
 */
async function askAdvisor(context: DecisionPointContext, services?: { adviceClient?: any; fsImpl?: any; roots?: any }): Promise<{ pick: string | null; answer: any }> {
  try {
    const client = services?.adviceClient || createAdviceClient({
      adviceRegistry: context.adviceRegistry,
      roots: services?.roots,
      fsImpl: services?.fsImpl,
    });
    const res = await client.ask({
      questionSet: context.questionSet,
      kind: context.kind,
      staticAnswer: context.staticAnswer ?? context.staticPick,
      caller: context.caller,
      taskId: context.taskId ?? null,
      record: false,
    });
    const first = res?.status === 'answered' ? res.answers?.[0] : null;
    // The answer carries the model the client asked, so a caller can report it.
    const answer = first ? { ...first, model: res.model ?? null } : null;
    const pick = answer?.pick;
    return typeof pick === 'string' && pick ? { pick, answer } : { pick: null, answer: null };
  } catch {
    return { pick: null, answer: null };
  }
}

interface DecisionPointResolution {
  kind: string;
  effectiveDecision: string;
  mode: 'off' | 'shadow' | 'act';
  staticPick: string;
  advisorPick: string | null;
  advisorAnswer?: any;
  pickId: string | null;
  elevated: boolean;
  agreed: boolean | null;
  warning?: string;
}

/**
 * The rollout profile's advisor capability, or null when no profile was chosen. It caps advice only when a
 * profile was chosen (env or settings), a rollback is active or the value is invalid; a project that sets no
 * profile (origin registry-default) keeps advice as configured.
 */
function profileAdvisorCap({ projectRoot, env, fsImpl }: { projectRoot?: string; env?: Record<string, string | undefined>; fsImpl?: any } = {}): string | null {
  const readable = typeof fsImpl?.readFileSync === 'function' ? fsImpl : undefined;
  const profile = resolveRolloutProfile({ projectRoot, env, fsImpl: readable });
  if (profile.origin.source === 'default' && profile.origin.detail === 'registry-default') return null;
  return profile.capabilities.advisor;
}

async function interceptDecisionPoint(
  context: DecisionPointContext,
  services?: { adviceClient?: any; shadowConfig?: any; fsImpl?: any; benchGate?: any; roots?: any }
): Promise<DecisionPointResolution> {
  const config =
    (services?.shadowConfig && typeof services.shadowConfig.resolve === 'function'
      ? services.shadowConfig.resolve()
      : services?.shadowConfig) ||
    resolveShadowConfig(context.kind, {
      projectRoot: context.projectRoot,
      env: context.env as Record<string, string> | undefined,
      fsImpl: services?.fsImpl,
      roots: services?.roots,
    });

  const cap = profileAdvisorCap({ projectRoot: context.projectRoot, env: context.env, fsImpl: services?.fsImpl });
  let mode = config.mode;
  if (cap === 'off') mode = 'off';
  else if (cap === 'shadow' && mode === 'act') mode = 'shadow';
  const staticPick = context.staticPick;

  // 1. Mode 'off': zero model invocation, return static pick immediately
  if (mode !== 'act' && mode !== 'shadow') {
    return {
      kind: context.kind,
      effectiveDecision: staticPick,
      mode: 'off',
      staticPick,
      advisorPick: null,
      pickId: null,
      elevated: false,
      agreed: null,
    };
  }

  const epoch = Date.now();
  const hex = crypto.randomBytes(3).toString('hex');
  const pickId = `adv-${String(epoch).padStart(13, '0')}-${hex}`;
  const stateDigest = crypto
    .createHash('sha256')
    .update(context.state || '')
    .digest('hex')
    .slice(0, 16);

  // 2. Mode 'shadow': non-blocking detached query, return static pick immediately
  if (mode === 'shadow') {
    const runShadowQuery = async () => {
      const startQuery = Date.now();
      const { pick: advisorPick } = await askAdvisor(context, services);
      const durationMs = Date.now() - startQuery;

      if (context.record !== false) recordPick(
        {
          pickId,
          at: new Date(epoch).toISOString(),
          kind: context.kind,
          caller: context.caller,
          taskId: context.taskId ?? null,
          mode: 'shadow',
          static: staticPick,
          pick: advisorPick || staticPick,
          elevated: false,
          model: config.model,
          durationMs,
          stateDigest,
        },
        {
          roots: services?.roots || (context.projectRoot ? { projectRoot: context.projectRoot } : undefined),
          fsImpl: services?.fsImpl,
        }
      );
    };

    runShadowQuery().catch(() => {});

    return {
      kind: context.kind,
      effectiveDecision: staticPick,
      mode: 'shadow',
      staticPick,
      advisorPick: null,
      pickId,
      elevated: false,
      agreed: null,
    };
  }

  // 3. Mode 'act': evaluate bench bar gate before active intervention
  let barPassed = config.benchBarPassed !== false;
  let barReason = '';

  if (config.benchBarPassed === undefined) {
    const benchGate = services?.benchGate || evaluateBenchBar;
    const barResult = await benchGate(context.kind, config.model || 'default', {
      repoRoot: context.projectRoot,
      fsImpl: services?.fsImpl,
    });
    barPassed = barResult.passed;
    barReason = barResult.reason || 'Accuracy failed static baseline';
  }

  if (!barPassed) {
    const runDegradedShadow = async () => {
      const startQuery = Date.now();
      const { pick: advisorPick } = await askAdvisor(context, services);
      const durationMs = Date.now() - startQuery;

      if (context.record !== false) recordPick(
        {
          pickId,
          at: new Date(epoch).toISOString(),
          kind: context.kind,
          caller: context.caller,
          taskId: context.taskId ?? null,
          mode: 'shadow',
          static: staticPick,
          pick: advisorPick || staticPick,
          elevated: false,
          model: config.model,
          durationMs,
          stateDigest,
        },
        {
          roots: services?.roots || (context.projectRoot ? { projectRoot: context.projectRoot } : undefined),
          fsImpl: services?.fsImpl,
        }
      );
    };

    runDegradedShadow().catch(() => {});

    return {
      kind: context.kind,
      effectiveDecision: staticPick,
      mode: 'shadow',
      staticPick,
      advisorPick: null,
      pickId,
      elevated: false,
      agreed: null,
      warning: `BENCH_BAR_UNMET: ${barReason || 'Accuracy failed static baseline'}`,
    };
  }

  // Bench bar passed: synchronously query advisor and apply Elevation Invariant
  const startQuery = Date.now();
  const { pick: advisorPick, answer: advisorAnswer } = await askAdvisor(context, services);
  const durationMs = Date.now() - startQuery;

  const { effectiveDecision, elevated } = applyElevationInvariant(
    context.kind,
    staticPick,
    advisorPick
  );

  if (context.record !== false) recordPick(
    {
      pickId,
      at: new Date(epoch).toISOString(),
      kind: context.kind,
      caller: context.caller,
      taskId: context.taskId ?? null,
      mode: 'act',
      static: staticPick,
      pick: advisorPick || staticPick,
      elevated,
      model: config.model,
      durationMs,
      stateDigest,
    },
    {
      roots: services?.roots || (context.projectRoot ? { projectRoot: context.projectRoot } : undefined),
      fsImpl: services?.fsImpl,
    }
  );

  return {
    kind: context.kind,
    effectiveDecision,
    mode: 'act',
    staticPick,
    advisorPick,
    advisorAnswer,
    pickId,
    elevated,
    agreed: advisorPick !== null ? advisorPick === staticPick : null,
  };
}

module.exports = {
  interceptDecisionPoint,
  profileAdvisorCap,
};
