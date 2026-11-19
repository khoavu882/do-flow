'use strict';

// How a chosen rollout profile caps advice. One table for the dispatcher, for every kind.

const { resolveRolloutProfile } = require('../profiles/resolve.ts');

type AdvisorCap = 'off' | 'shadow' | 'staged' | 'act';
type AdviceMode = 'off' | 'shadow' | 'show' | 'act';

/**
 * The rollout profile's advisor capability, or null when no profile was chosen. It caps advice only when a
 * profile was chosen (env or settings) or the value is invalid; a project that sets no
 * profile (origin registry-default) keeps advice as configured.
 */
function profileAdvisorCap({ projectRoot, env, fsImpl }: { projectRoot?: string; env?: Record<string, string | undefined>; fsImpl?: any } = {}): AdvisorCap | null {
  const readable = typeof fsImpl?.readFileSync === 'function' ? fsImpl : undefined;
  const profile = resolveRolloutProfile({ projectRoot, env, fsImpl: readable });
  if (profile.origin.source === 'default' && profile.origin.detail === 'registry-default') return null;
  return profile.capabilities.advisor;
}

/**
 * The mode a set kind runs in under a cap. `shadow` and `staged` (shadow until a contract defines it, D2) lower `show` and
 * `act` to shadow (175 FR-014); anything unknown is off.
 */
function capMode(cap: unknown, configuredMode: unknown): AdviceMode {
  if (configuredMode !== 'off' && configuredMode !== 'shadow' && configuredMode !== 'show' && configuredMode !== 'act') return 'off';
  if (cap === null || cap === 'act') return configuredMode;
  if (cap === 'shadow' || cap === 'staged') return configuredMode === 'off' ? 'off' : 'shadow';
  return 'off';
}

module.exports = { profileAdvisorCap, capMode };
