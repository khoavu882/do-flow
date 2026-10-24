'use strict';

type Bindings = {
  state: 'unset' | 'set' | 'invalid';
  map: Record<string, Record<string, string>> | null;
  reason: string | null;
};

type Binding = {
  model: string | null;
  source: 'binding' | 'harness-default' | 'invalid';
  flag: 'supported' | 'unevidenced' | 'n/a';
};

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

/** IC-012: resolve one worker and task tier without choosing a vendor model. */
function resolveBinding({ worker, tier, bindings, descriptor }: any): Binding {
  if (bindings?.state === 'invalid') return { model: null, source: 'invalid', flag: 'n/a' };
  const map = bindings?.state === 'set' ? bindings.map : null;
  if (!map || !Object.hasOwn(map, worker) || !Object.hasOwn(map[worker], tier)) {
    return { model: null, source: 'harness-default', flag: 'n/a' };
  }
  const supported = descriptor?.model?.status === 'supported' && Array.isArray(descriptor.model.argv);
  return { model: map[worker][tier], source: 'binding', flag: supported ? 'supported' : 'unevidenced' };
}

/** IC-012: a binding denial narrows this task's ladder, rather than becoming a launch failure. */
function bindingGap(result: Binding) {
  if (result.source === 'invalid') return { requirement: 'binding', result: 'failed', reason: 'binding:invalid' };
  if (result.source === 'binding' && result.flag === 'unevidenced') {
    return { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' };
  }
  return null;
}

/** IC-014: describe every registry tier without changing worker eligibility. */
function bindingsOf({ worker, descriptor, bindings, tiers }: any) {
  return Object.fromEntries(tiers.map((tier: string) => {
    const { model, flag } = resolveBinding({ worker, tier, bindings, descriptor });
    return [tier, { model, flag }];
  }));
}

module.exports = { resolveTier, readBindings, resolveBinding, bindingGap, bindingsOf };
