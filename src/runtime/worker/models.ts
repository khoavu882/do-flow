'use strict';

type Bindings = {
  state: 'unset' | 'set' | 'invalid';
  map: Record<string, Record<string, string>> | null;
  reason: string | null;
};

type BindingResolution = {
  model: string | null;
  source: 'binding' | 'main-session' | 'frontier-binding' | 'harness-default' | 'invalid';
  flag: 'supported' | 'unevidenced' | 'n/a';
  catalogueStatus?: 'synced' | 'unsynced';
  enabledStatus?: 'enabled' | 'disabled';
};

type Binding = BindingResolution;

/** The owner that runs the orchestrator role, and the fourth key of `workers.models.<harness>`: a role,
 * not a dispatch tier, so `dispatchTiers.tiers` stays three. */
const ORCHESTRATOR_OWNER = 'delivery-lead';
const ORCHESTRATOR_KEY = 'orchestrator';

/** Tier for a dispatch: the task line's tier when valid, else the owner's, else the default (IC-004).
 * A registry without `dispatchTiers` (the key is optional) gives `standard` with a note. */
function resolveTier({ dispatchTiers, owner, tier, missing }: any) {
  if (!dispatchTiers) {
    missing.push('models.json has no dispatchTiers; tier standard assumed');
    return { tier: 'standard', source: 'default', note: 'models.json has no dispatchTiers' };
  }
  if (tier !== undefined && tier !== null && tier !== '') {
    if (dispatchTiers.tiers.includes(tier)) return { tier, source: 'task' };
    missing.push(`tier '${tier}' is not in dispatchTiers.tiers; ignored`);
  }
  if (Object.hasOwn(dispatchTiers.byOwner, owner)) return { tier: dispatchTiers.byOwner[owner], source: 'owner' };
  missing.push(`owner '${owner}' has no tier in models.json dispatchTiers`);
  return { tier: dispatchTiers.default, source: 'default' };
}

/** IC-012: read global bindings afresh; errors report resolver reasons, never setting values. */
function readBindings({ env = process.env, projectRoot = null }: any = {}): Bindings {
  try {
    const { loadSettings } = require('../settings/resolve.ts');
    const res = loadSettings({ projectRoot, env: { ...env } }).get('workers.models', 'global');
    const invalid = res.state === 'invalid' || res.origin?.via === 'no-config-home'
      || res.value?.state === 'invalid';
    if (invalid) {
      const candidate = res.candidates.find((item: any) => item.status === 'invalid');
      return {
        state: 'invalid', map: null,
        reason: candidate?.reason || (res.origin?.via === 'no-config-home' ? 'no-config-home' : 'invalid'),
      };
    }
    if (res.value === null) return { state: 'unset', map: null, reason: null };
    return { state: 'set', map: structuredClone(res.value), reason: null };
  } catch {
    return { state: 'invalid', map: null, reason: 'unreadable' };
  }
}

/** IC-002: read project-effective models.enabled setting afresh. */
function readAllowedModels({ env = process.env, projectRoot = null }: any = {}): string[] | null {
  try {
    const { loadSettings } = require('../settings/resolve.ts');
    const res = loadSettings({ projectRoot, env: { ...env } }).get('models.enabled', 'project');
    if (res.state === 'invalid' || res.origin?.via === 'no-config-home') return [];
    return Array.isArray(res.value) ? res.value : [];
  } catch {
    return [];
  }
}

/** IC-012, IC-003: resolve one worker and task tier, checking catalogue sync and models.enabled allow-list. */
function resolveBinding({ worker, tier, bindings, descriptor, catalogue, allowedModels }: any): BindingResolution {
  if (bindings?.state === 'invalid') {
    const res: BindingResolution = { model: null, source: 'invalid', flag: 'n/a' };
    if (catalogue !== undefined) res.catalogueStatus = 'unsynced';
    if (allowedModels !== undefined) res.enabledStatus = 'disabled';
    return res;
  }
  const map = bindings?.state === 'set' ? bindings.map : null;
  if (!map || !Object.hasOwn(map, worker) || !Object.hasOwn(map[worker], tier)) {
    const res: BindingResolution = { model: null, source: 'harness-default', flag: 'n/a' };
    if (catalogue !== undefined) res.catalogueStatus = 'synced';
    if (allowedModels !== undefined) res.enabledStatus = 'enabled';
    return res;
  }
  const boundModel = map[worker][tier];
  const supported = descriptor?.model?.status === 'supported' && Array.isArray(descriptor.model.argv);

  const res: BindingResolution = {
    model: boundModel,
    source: 'binding',
    flag: supported ? 'supported' : 'unevidenced',
  };

  if (catalogue !== undefined) {
    if (catalogue && catalogue.harnesses && Object.hasOwn(catalogue.harnesses, worker)) {
      const offered = catalogue.harnesses[worker]?.offeredModels || [];
      res.catalogueStatus = offered.some((m: any) => m.id === boundModel) ? 'synced' : 'unsynced';
    } else {
      res.catalogueStatus = 'unsynced';
    }
  }

  if (allowedModels !== undefined) {
    if (Array.isArray(allowedModels)) {
      res.enabledStatus = allowedModels.includes(boundModel) ? 'enabled' : 'disabled';
    } else {
      res.enabledStatus = 'disabled';
    }
  }

  return res;
}

/** The model for the orchestrator role on `harness`, first match wins: the bound `orchestrator` id
 * (`binding`); the primary's own model when `harness` is the primary's harness and that model is known
 * (`main-session`); the bound `frontier` id (`frontier-binding`); else the harness default. An unreadable
 * binding is `invalid`, as for a tier. `primary` is a `resolvePrimary` result or null. */
function resolveOrchestratorModel({ harness, bindings, primary, descriptor, catalogue, allowedModels }: any): BindingResolution {
  const own = resolveBinding({ worker: harness, tier: ORCHESTRATOR_KEY, bindings, descriptor, catalogue, allowedModels });
  if (own.source !== 'harness-default') return own;
  const known = primary && !['unknown', 'refused', 'not-primary'].includes(primary.state)
    && primary.harness === harness && typeof primary.model === 'string' && primary.model !== '';
  if (known) {
    const supported = descriptor?.model?.status === 'supported' && Array.isArray(descriptor.model.argv);
    return { model: primary.model, source: 'main-session', flag: supported ? 'supported' : 'unevidenced' };
  }
  const frontier = resolveBinding({ worker: harness, tier: 'frontier', bindings, descriptor, catalogue, allowedModels });
  return frontier.source === 'binding' ? { ...frontier, source: 'frontier-binding' } : own;
}

/** True when a dispatch takes the orchestrator's model: the owner is the orchestrator and the tier came
 * from the owner, not from the task line (an explicit task tier still wins, as before). */
function usesOrchestratorModel(owner: unknown, resolvedTier: { source?: string } | null | undefined): boolean {
  return typeof owner === 'string' && owner.trim().toLowerCase() === ORCHESTRATOR_OWNER && resolvedTier?.source === 'owner';
}

/** One resolver for every dispatch: the orchestrator rule for its owner, else the tier binding. */
function resolveTaskModel({ worker, owner, resolvedTier, bindings, descriptor, primary = null, catalogue, allowedModels }: any): BindingResolution {
  return usesOrchestratorModel(owner, resolvedTier)
    ? resolveOrchestratorModel({ harness: worker, bindings, primary, descriptor, catalogue, allowedModels })
    : resolveBinding({ worker, tier: resolvedTier.tier, bindings, descriptor, catalogue, allowedModels });
}

/** IC-012, IC-003: a binding denial narrows this task's ladder, rather than becoming a launch failure. */
function bindingGap(result: BindingResolution) {
  if (result.source === 'invalid') return { requirement: 'binding', result: 'failed', reason: 'binding:invalid' };
  if (result.source === 'binding' || result.source === 'frontier-binding') {
    if (result.flag === 'unevidenced') {
      return { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' };
    }
    if (result.catalogueStatus === 'unsynced') {
      return { requirement: 'binding', result: 'failed', reason: 'model-unsynced' };
    }
    if (result.enabledStatus === 'disabled') {
      return { requirement: 'binding', result: 'failed', reason: 'model-disabled' };
    }
  }
  return null;
}

/** IC-014: describe every registry tier without changing worker eligibility. */
function bindingsOf({ worker, descriptor, bindings, tiers, catalogue, allowedModels }: any) {
  return Object.fromEntries(tiers.map((tier: string) => {
    const { model, flag, catalogueStatus, enabledStatus } = resolveBinding({ worker, tier, bindings, descriptor, catalogue, allowedModels });
    return [tier, { model, flag, ...(catalogueStatus ? { catalogueStatus } : {}), ...(enabledStatus ? { enabledStatus } : {}) }];
  }));
}

module.exports = {
  ORCHESTRATOR_OWNER, ORCHESTRATOR_KEY, resolveTier, readBindings, readAllowedModels, resolveBinding, resolveOrchestratorModel,
  usesOrchestratorModel, resolveTaskModel, bindingGap, bindingsOf,
};
