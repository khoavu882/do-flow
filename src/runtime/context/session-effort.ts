'use strict';

// 178 design §4 (IC-002) and §7.2: the effort of the harness session DoFlow runs inside, read from the environment
// the caller passes and from the descriptor data (`sessionEffort`), never from a file (O-8 (b)). Pure: no fs, no
// process, no settings module. A source is read only inside a proved session (its harness's marker, D3); the login
// mode is injected (`loginModeOf`, §4.3), so this module reads no login store. A value that fails the level check is
// never returned: the answer names the variable (`origin`), not the value.

const { EFFORT_RE } = require('../../registry/model-parts.ts');

type LoginMode = 'subscription' | 'api-key';
type SessionReason = 'worker-role' | 'no-session-harness' | 'several-markers' | 'contradicted' | 'no-source'
  | 'mode-unknown' | 'mode-not-evidenced' | 'not-set' | 'level-not-declared';
type SessionEffort =
  | { state: 'known'; harness: string; level: string; origin: string; mode: LoginMode | null }
  | { state: 'unknown'; harness: string | null; reason: SessionReason; origin: string | null; mode: LoginMode | null };
type Env = Record<string, string | undefined>;

/** Design §4.1's closed list; the wording fixture and guard G86 read it. */
const SESSION_REASONS: readonly SessionReason[] = Object.freeze([
  'worker-role', 'no-session-harness', 'several-markers', 'contradicted', 'no-source',
  'mode-unknown', 'mode-not-evidenced', 'not-set', 'level-not-declared',
] as SessionReason[]);

const supported = (harness: any): boolean => harness?.sessionEffort?.status === 'supported';
const unknownOf = (harness: string | null, reason: SessionReason, origin: string | null = null, mode: LoginMode | null = null): SessionEffort =>
  ({ state: 'unknown', harness, reason, origin, mode });

/** Design §4.2 steps 1-6. */
function readSessionEffort({ registry, env, declaredHarness = null, loginModeOf }: {
  registry: any; env: Env; declaredHarness?: string | null; loginModeOf: (harness: string) => LoginMode | null;
}): SessionEffort {
  const harnesses: any[] = registry?.harnesses ?? [];
  const role = (env.DOFLOW_SESSION_ROLE || '').toLowerCase();
  if (role !== '' && role !== 'main') return unknownOf(null, 'worker-role');

  const marked = harnesses.filter((h) => supported(h) && env[h.sessionEffort.marker.env] === h.sessionEffort.marker.equals);
  if (marked.length > 1) return unknownOf(null, 'several-markers');
  const declared = declaredHarness === null ? undefined : harnesses.find((h) => h.id === declaredHarness);
  if (marked.length === 0) {
    return declared && !supported(declared) ? unknownOf(declared.id, 'no-source') : unknownOf(declaredHarness, 'no-session-harness');
  }

  const harness = marked[0];
  if (declared && declared.id !== harness.id) return unknownOf(harness.id, 'contradicted');

  const mode = loginModeOf(harness.id) ?? null;
  let skipped: { reason: SessionReason; origin: string } | null = null;
  for (const source of harness.sessionEffort.sources) {
    if (source.modes.length < 2 && source.modes[0] !== mode) {
      skipped ??= { reason: mode === null ? 'mode-unknown' : 'mode-not-evidenced', origin: source.name };
      continue;
    }
    const value = env[source.name];
    if (value === undefined || value === '') continue;
    const levels = harness.worker?.effort?.levels;
    const declaredLevel = EFFORT_RE.test(value) && (levels === 'per-model' || (Array.isArray(levels) && levels.includes(value)));
    return declaredLevel
      ? { state: 'known', harness: harness.id, level: value, origin: source.name, mode }
      : unknownOf(harness.id, 'level-not-declared', source.name, mode);
  }
  return skipped
    ? unknownOf(harness.id, skipped.reason, skipped.origin, mode)
    : unknownOf(harness.id, 'not-set', harness.sessionEffort.sources[0].name, mode);
}

/** Design §7.2: every marker variable and every source variable of the registry, once each, sorted. */
function sessionVariables(registry: any): string[] {
  const names = new Set<string>();
  for (const harness of registry?.harnesses ?? []) {
    if (!supported(harness)) continue;
    names.add(harness.sessionEffort.marker.env);
    for (const source of harness.sessionEffort.sources) names.add(source.name);
  }
  return [...names].sort();
}

module.exports = { readSessionEffort, sessionVariables, SESSION_REASONS };

export type { SessionEffort, SessionReason, LoginMode };
