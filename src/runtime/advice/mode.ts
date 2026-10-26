'use strict';

// How a chosen rollout profile caps advice. One table for the dispatcher (set kinds) and the callers' unset-kind path.

const { resolveRolloutProfile } = require('../profiles/resolve.ts');

type AdvisorCap = 'off' | 'shadow' | 'staged' | 'act';
type AdviceMode = 'off' | 'shadow' | 'act';

/**
 * The rollout profile's advisor capability, or null when no profile was chosen. It caps advice only when a
 * profile was chosen (env or settings), a rollback is active or the value is invalid; a project that sets no
 * profile (origin registry-default) keeps advice as configured.
 */
function profileAdvisorCap({ projectRoot, env, fsImpl }: { projectRoot?: string; env?: Record<string, string | undefined>; fsImpl?: any } = {}): AdvisorCap | null {
  const readable = typeof fsImpl?.readFileSync === 'function' ? fsImpl : undefined;
  const profile = resolveRolloutProfile({ projectRoot, env, fsImpl: readable });
  if (profile.origin.source === 'default' && profile.origin.detail === 'registry-default') return null;
  return profile.capabilities.advisor;
}

/** The mode a set kind runs in under a cap. `staged` means shadow until a contract defines it (D2); anything unknown is off. */
function capMode(cap: unknown, configuredMode: unknown): AdviceMode {
  if (configuredMode !== 'off' && configuredMode !== 'shadow' && configuredMode !== 'act') return 'off';
  if (cap === null || cap === 'act') return configuredMode;
  if (cap === 'shadow' || cap === 'staged') return configuredMode === 'act' ? 'shadow' : configuredMode;
  return 'off';
}

/** What the unset-kind path does under a cap: the legacy ask (no cap, or act), shadow (record, never show or apply) or off. */
function unsetKindPath(cap: unknown): 'legacy' | 'shadow' | 'off' {
  if (cap === null || cap === 'act') return 'legacy';
  if (cap === 'shadow' || cap === 'staged') return 'shadow';
  return 'off';
}

module.exports = { profileAdvisorCap, capMode, unsetKindPath };
