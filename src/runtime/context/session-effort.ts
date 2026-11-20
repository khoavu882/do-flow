'use strict';

// 178 design §4 (IC-002) and §7.2: the effort of the harness session DoFlow runs inside, read from the environment
// the caller passes and from the descriptor data (`sessionEffort`), never from a file (O-8 (b)). Pure: no fs, no
// process, no settings module. A source is read only inside a proved session (its harness's marker, D3); the login
// mode is injected (`loginModeOf`, §4.3), so this module reads no login store. A value that fails the level check is
// never returned: the answer names the variable (`origin`), not the value.
// 180 IC-180-E3: a `hook-state` source is the level a hook stored for this session, read through the injected
// `readStored` (the file reader is effort-store.ts) by the session key, the first 16 hex of the sha256 of the id the
// source's `sessionIdEnv` holds; the id itself never leaves this module. Its origin is `hook-state`.

const crypto = require('node:crypto');
const { EFFORT_RE } = require('../../registry/model-parts.ts');

type LoginMode = 'subscription' | 'api-key';
type SessionReason = 'worker-role' | 'no-session-harness' | 'several-markers' | 'contradicted' | 'no-source'
  | 'mode-unknown' | 'mode-not-evidenced' | 'not-set' | 'level-not-declared';
type SessionEffort =
  | { state: 'known'; harness: string; level: string; origin: string; mode: LoginMode | null }
  | { state: 'unknown'; harness: string | null; reason: SessionReason; origin: string | null; mode: LoginMode | null };
type Env = Record<string, string | undefined>;
type StoredEffort = { level: string; observedAt: string };
type ReadStored = (query: { harness: string; sessionKey: string }) => StoredEffort | null;

/** Design §4.1's closed list; the wording fixture and guard G86 read it. */
const SESSION_REASONS: readonly SessionReason[] = Object.freeze([
  'worker-role', 'no-session-harness', 'several-markers', 'contradicted', 'no-source',
  'mode-unknown', 'mode-not-evidenced', 'not-set', 'level-not-declared',
] as SessionReason[]);

const supported = (harness: any): boolean => harness?.sessionEffort?.status === 'supported';
const unknownOf = (harness: string | null, reason: SessionReason, origin: string | null = null, mode: LoginMode | null = null): SessionEffort =>
  ({ state: 'unknown', harness, reason, origin, mode });

const HOOK_STATE = 'hook-state';
/** The name an answer gives a source: an env source's variable, or `hook-state`. */
const originOf = (source: any): string => (source.kind === HOOK_STATE ? HOOK_STATE : source.name);

/** A source's value: the variable, or the stored level of the session `sessionIdEnv` names (absent or empty id: not set). */
function valueOf(source: any, harness: string, env: Env, readStored: ReadStored | null): string | undefined {
  if (source.kind !== HOOK_STATE) return env[source.name];
  const id = env[source.sessionIdEnv];
  if (id === undefined || id === '' || readStored === null) return undefined;
  const sessionKey = crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
  const level = readStored({ harness, sessionKey })?.level;
  return typeof level === 'string' ? level : undefined;
}

/** Design §4.2 steps 1-6; 180 IC-180-E3 for a hook-state source. */
function readSessionEffort({ registry, env, declaredHarness = null, loginModeOf, readStored = null }: {
  registry: any; env: Env; declaredHarness?: string | null; loginModeOf: (harness: string) => LoginMode | null;
  readStored?: ReadStored | null;
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
      skipped ??= { reason: mode === null ? 'mode-unknown' : 'mode-not-evidenced', origin: originOf(source) };
      continue;
    }
    const value = valueOf(source, harness.id, env, readStored);
    if (value === undefined || value === '') continue;
    const levels = harness.worker?.effort?.levels;
    const declaredLevel = EFFORT_RE.test(value) && (levels === 'per-model' || (Array.isArray(levels) && levels.includes(value)));
    return declaredLevel
      ? { state: 'known', harness: harness.id, level: value, origin: originOf(source), mode }
      : unknownOf(harness.id, 'level-not-declared', originOf(source), mode);
  }
  // not-set names the first variable a person can set; a harness with only a hook-state source names that.
  const sources: any[] = harness.sessionEffort.sources;
  return skipped
    ? unknownOf(harness.id, skipped.reason, skipped.origin, mode)
    : unknownOf(harness.id, 'not-set', originOf(sources.find((source) => source.kind !== HOOK_STATE) ?? sources[0]), mode);
}

/** Design §7.2: every marker variable and every source variable of the registry (a hook-state source's session id
 * variable included, 180 FR-E5), once each, sorted. */
function sessionVariables(registry: any): string[] {
  const names = new Set<string>();
  for (const harness of registry?.harnesses ?? []) {
    if (!supported(harness)) continue;
    names.add(harness.sessionEffort.marker.env);
    for (const source of harness.sessionEffort.sources) names.add(source.kind === HOOK_STATE ? source.sessionIdEnv : source.name);
  }
  return [...names].sort();
}

module.exports = { readSessionEffort, sessionVariables, SESSION_REASONS };

export type { SessionEffort, SessionReason, LoginMode, ReadStored, StoredEffort };
