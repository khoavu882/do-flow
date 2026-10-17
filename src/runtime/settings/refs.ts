'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The three named references a settings key may point at (086 IC-001, DD-1): the one place the
 * settings registry reaches into another registry for a value it must not copy. `valuesRef` names a
 * list of allowed values, `defaultRef` names a default. There is no other per-key code here; a key
 * that needs a fourth reference adds a function below and a row to `REF_META`.
 *
 *   advice.providerIds                    core/registry/advice.json  providers[].id
 *   advice.providerDefaultEndpoint        core/registry/advice.json  providers[id = advice.provider].defaultEndpoint
 *   storage.lifecycleEventsDefaultHours   core/registry/storage.json stores[lifecycle-events].bound.defaultHours
 *
 * Sources are read on first use and cached for the life of the returned resolver. A failure throws an
 * Error that names the file and the field and never carries file text.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type RefKind = 'values' | 'default';
interface RefMeta { kind: RefKind; dependsOn: string[] }
/** Values of the keys a ref depends on (`dependsOn`), by key name. */
type Deps = Record<string, unknown>;
type Source = (name: string) => any;

const ADVICE_FILE = 'core/registry/advice.json';
const STORAGE_FILE = 'core/registry/storage.json';

/** What each ref is and which keys' values it needs, so the loader can detect a cycle without resolving. */
const REF_META: Readonly<Record<string, RefMeta>> = Object.freeze({
  'advice.providerIds': { kind: 'values', dependsOn: [] },
  'advice.providerDefaultEndpoint': { kind: 'default', dependsOn: ['advice.provider'] },
  'storage.lifecycleEventsDefaultHours': { kind: 'default', dependsOn: [] },
});

function providers(source: Source): any[] {
  const list = source(ADVICE_FILE)?.providers;
  if (!Array.isArray(list)) throw new Error(`${ADVICE_FILE} providers must be an array`);
  return list;
}

function adviceProviderIds(source: Source): string[] {
  const ids = providers(source).map((p: any) => p?.id);
  if (ids.length === 0 || ids.some((id: unknown) => typeof id !== 'string' || !id)) {
    throw new Error(`${ADVICE_FILE} providers[].id must be non-empty strings`);
  }
  return ids;
}

function adviceProviderDefaultEndpoint(source: Source, deps: Deps): string {
  const id = deps['advice.provider'];
  const endpoint = providers(source).find((p: any) => p?.id === id)?.defaultEndpoint;
  if (typeof endpoint !== 'string' || !endpoint) throw new Error(`${ADVICE_FILE} has no defaultEndpoint for the provider`);
  return endpoint;
}

function storageLifecycleEventsDefaultHours(source: Source): number {
  const stores = source(STORAGE_FILE)?.stores;
  const hours = (Array.isArray(stores) ? stores : []).find((s: any) => s?.id === 'lifecycle-events')?.bound?.defaultHours;
  if (!Number.isSafeInteger(hours) || hours < 1) throw new Error(`${STORAGE_FILE} lifecycle-events bound.defaultHours must be a positive integer`);
  return hours;
}

const RESOLVERS: Readonly<Record<string, (source: Source, deps: Deps) => unknown>> = Object.freeze({
  'advice.providerIds': adviceProviderIds,
  'advice.providerDefaultEndpoint': adviceProviderDefaultEndpoint,
  'storage.lifecycleEventsDefaultHours': storageLifecycleEventsDefaultHours,
});

interface Refs {
  /** The value of a named ref; throws on an unknown name or a source that cannot be read. */
  resolve(name: string, deps?: Deps): unknown;
}

function createRefs({ repoRoot = REPO_ROOT, fsImpl = nodeFs }: { repoRoot?: string; fsImpl?: any } = {}): Refs {
  const cache = new Map<string, any>();
  const source: Source = (file) => {
    if (!cache.has(file)) {
      let parsed: any;
      try { parsed = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, file), 'utf8')); }
      catch { throw new Error(`${file} could not be read as JSON`); }
      cache.set(file, parsed);
    }
    return cache.get(file);
  };
  return {
    resolve(name, deps = {}) {
      if (!Object.hasOwn(RESOLVERS, name)) throw new Error(`unknown settings ref '${name}'`);
      return RESOLVERS[name](source, deps);
    },
  };
}

module.exports = { REF_META, createRefs };
