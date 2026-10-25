'use strict';

const crypto = require('node:crypto');
const { resolveShadowConfig } = require('./shadow-config.ts');
const { applyElevationInvariant } = require('./elevation.ts');
const { evaluateBenchBar } = require('./bench-gate.ts');
const { recordPick } = require('./consequence-recorder.ts');
const { createAdviceClient } = require('./client.ts');

interface DecisionPointContext {
  kind: 'tier' | 'task-class' | 'verify-risk' | 'review-depth' | 'mcp-need' | 'followup-triage' | 'autopilot' | string;
  caller: string;
  state: string;
  staticPick: string;
  taskId?: string | null;
  server?: string;
  projectRoot?: string;
  options?: Record<string, any>;
}

interface DecisionPointResolution {
  kind: string;
  effectiveDecision: string;
  mode: 'off' | 'shadow' | 'act';
  staticPick: string;
  advisorPick: string | null;
  pickId: string | null;
  elevated: boolean;
  agreed: boolean | null;
  warning?: string;
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
      fsImpl: services?.fsImpl,
      roots: services?.roots,
    });

  const mode = config.mode;
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
      let advisorPick: string | null = null;
      try {
        const client =
          services?.adviceClient ||
          createAdviceClient({
            projectRoot: context.projectRoot,
            fsImpl: services?.fsImpl,
            roots: services?.roots,
          });
        const res = await client.ask(context.kind, context.state, { model: config.model });
        advisorPick = res?.answer?.pick || res?.pick || null;
      } catch {
        advisorPick = null;
      }
      const durationMs = Date.now() - startQuery;

      recordPick(
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
      let advisorPick: string | null = null;
      try {
        const client =
          services?.adviceClient ||
          createAdviceClient({
            projectRoot: context.projectRoot,
            fsImpl: services?.fsImpl,
            roots: services?.roots,
          });
        const res = await client.ask(context.kind, context.state, { model: config.model });
        advisorPick = res?.answer?.pick || res?.pick || null;
      } catch {
        advisorPick = null;
      }
      const durationMs = Date.now() - startQuery;

      recordPick(
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
  let advisorPick: string | null = null;
  try {
    const client =
      services?.adviceClient ||
      createAdviceClient({
        projectRoot: context.projectRoot,
        fsImpl: services?.fsImpl,
        roots: services?.roots,
      });
    const res = await client.ask(context.kind, context.state, { model: config.model });
    advisorPick = res?.answer?.pick || res?.pick || null;
  } catch {
    advisorPick = null;
  }
  const durationMs = Date.now() - startQuery;

  const { effectiveDecision, elevated } = applyElevationInvariant(
    context.kind,
    staticPick,
    advisorPick
  );

  recordPick(
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
    pickId,
    elevated,
    agreed: advisorPick !== null ? advisorPick === staticPick : null,
  };
}

module.exports = {
  interceptDecisionPoint,
};
