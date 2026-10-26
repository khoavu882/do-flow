'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The named references a settings key may point at (086 IC-001, DD-1): the one place the settings
 * registry reaches into another registry for a value it must not copy. `valuesRef` names a list of
 * allowed values, `orderRef` names that list ranked narrowest first, `defaultRef` names a default.
 * There is no other per-key code here; a key that needs another reference adds a function below and
 * a row to `REF_META`.
 *
 *   advice.providerIds                    core/registry/advice.json  providers[].id
 *   advice.providerDefaultEndpoint        core/registry/advice.json  providers[id = advice.provider].defaultEndpoint
 *   storage.lifecycleEventsDefaultHours   core/registry/storage.json stores[lifecycle-events].bound.defaultHours
 *   models.tierIds                       core/registry/models.json dispatchTiers.tiers
 *   protocols.reviewPresetIds             core/registry/protocols.json 'auto', then order.review, then the review
 *                                         presets active packages contribute (122 IC-014)
 *   protocols.reviewPresetOrder           core/registry/protocols.json order.review with 'auto' right after the
 *                                         preset of depth 'deep'; never a contributed id
 *   protocols.debatePresetIds             core/registry/protocols.json order.debate, then the contributed debate presets
 *   protocols.lensIds                     core/registry/protocols.json lenses[].id
 *   harnesses.primaryIds                  'unknown', then core/registry/harnesses.json harnesses[].id in order
 *   harnesses.ids                         core/registry/harnesses.json harnesses[].id in order
 *   workers.ids                          known worker ids from core/registry/harnesses.json
 *   workers.defaultRungs                 shipped worker ids from that file, then 'primary'
 *   packages.ids                          'doflow' then the ids the global doflow.lock records under `packages`
 *                                         (122 IC-011); a missing, v1 or unreadable lock adds none
 *
 * Where `auto` ranks: `auto` follows the risk rule, which picks the preset of depth `deep` or the one
 * of depth `single` (resolve-protocol.ts `idOfDepth`), so the deep preset is the strictest it can
 * pick. A preset at or above the deep one in order.review is at least as strict as anything `auto`
 * gives and ranks above it; every preset below the deep one ranks below it. A preset a package adds
 * above review-deep therefore needs no settings edit.
 *
 * A contributed preset (122 IC-014) is a value a person may name, never a rank: it is in the value lists and not in
 * the order, so no strictest-pick path (`auto`, `order[0]`, the floor walk) can reach it, and the narrow-only fold
 * compares it by dominance (resolve.ts). The contributed ids come from the merged view (`loadProtocols`) of the same
 * runtime root, or from `createRefs({ protocols })`, a merged registry a caller passes; an unusable view adds none.
 *
 * `packages.ids` is read from the machine, not from the runtime root: the global lock under `homeDir` (the account
 * home by default). An id a project file names that this machine has not recorded is not an error (a project file
 * travels); the key declares `unknownMembers: warn` and the settings loader reports it.
 *
 * protocols.json is held to `validateProtocols` before any of its refs resolves, so a ref never hands
 * out ids from a registry the review verbs would refuse. Sources are read on first use and cached for
 * the life of the returned resolver. A failure throws an Error that names the file and the field and
 * never carries file text.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { validateProtocols, contributedPresetIds } = require('../review/protocols.ts');
const { readLock } = require('../../state/lockfile.ts');

type RefKind = 'values' | 'order' | 'default';
interface RefMeta { kind: RefKind; dependsOn: string[] }
/** Values of the keys a ref depends on (`dependsOn`), by key name. */
type Deps = Record<string, unknown>;
type Source = (name: string) => any;
/** The merged protocol registry (core plus active packages), or null when it cannot be loaded. */
type Merged = () => any | null;

const ADVICE_FILE = 'core/registry/advice.json';
const STORAGE_FILE = 'core/registry/storage.json';
const PROTOCOLS_FILE = 'core/registry/protocols.json';
const HARNESSES_FILE = 'core/registry/harnesses.json';
const MODELS_FILE = 'core/registry/models.json';

/** What each ref is and which keys' values it needs, so the loader can detect a cycle without resolving. */
const REF_META: Readonly<Record<string, RefMeta>> = Object.freeze({
  'advice.providerIds': { kind: 'values', dependsOn: [] },
  'advice.providerDefaultEndpoint': { kind: 'default', dependsOn: ['advice.provider'] },
  'storage.lifecycleEventsDefaultHours': { kind: 'default', dependsOn: [] },
  'models.tierIds': { kind: 'values', dependsOn: [] },
  'protocols.reviewPresetIds': { kind: 'values', dependsOn: [] },
  'protocols.reviewPresetOrder': { kind: 'order', dependsOn: [] },
  'protocols.debatePresetIds': { kind: 'values', dependsOn: [] },
  'protocols.lensIds': { kind: 'values', dependsOn: [] },
  'harnesses.primaryIds': { kind: 'values', dependsOn: [] },
  'harnesses.ids': { kind: 'values', dependsOn: [] },
  'workers.ids': { kind: 'values', dependsOn: [] },
  'workers.defaultRungs': { kind: 'default', dependsOn: [] },
  'packages.ids': { kind: 'values', dependsOn: [] },
});

/** The depth label of the strictest preset the risk rule picks (resolve-protocol.ts step 1). */
const RISK_STRICTEST_DEPTH = 'deep';

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

/**
 * `pick(data)` from protocols.json, once the picked field has the ref's shape (an Error naming that
 * field) and the whole file passes `validateProtocols` (an Error naming the file, never its text).
 */
function fromProtocols<T>(source: Source, pick: (data: any) => T): T {
  const data = source(PROTOCOLS_FILE);
  const picked = pick(data);
  const checked = validateProtocols(data);
  if (!checked.ok) throw new Error(`${PROTOCOLS_FILE} fails validateProtocols (${checked.errors.length} error(s))`);
  return picked;
}

/** A non-empty list of non-empty strings, or an Error naming the file and `field`. */
function idList(list: unknown, field: string): string[] {
  if (!Array.isArray(list) || list.length === 0 || list.some((id: unknown) => typeof id !== 'string' || !id)) {
    throw new Error(`${PROTOCOLS_FILE} ${field} must be a non-empty list of non-empty strings`);
  }
  return list;
}

/** The ids active packages contribute to `kind`, none when the merged view is unusable. */
function contributed(merged: Merged, kind: string): string[] {
  const registry = merged();
  return registry ? contributedPresetIds(registry, kind) : [];
}

/** `review.preset` may be `auto`, any core review preset id (IC-006) or a contributed one (122 IC-014). */
function protocolsReviewPresetIds(source: Source, _deps: Deps, merged: Merged): string[] {
  return ['auto', ...fromProtocols(source, (data) => idList(data?.order?.review, 'order.review')), ...contributed(merged, 'review')];
}

/** The `review.preset` values narrowest (strictest) first; the header says where `auto` goes and why. Core ids only. */
function protocolsReviewPresetOrder(source: Source): string[] {
  const order = fromProtocols(source, (data) => idList(data?.order?.review, 'order.review'));
  const presets = source(PROTOCOLS_FILE).presets;
  const deep = order.findIndex((id) => presets[id]?.depth === RISK_STRICTEST_DEPTH);
  if (deep === -1) throw new Error(`${PROTOCOLS_FILE} order.review has no preset of depth '${RISK_STRICTEST_DEPTH}'`);
  const single = order.findIndex((id) => presets[id]?.depth === 'single');
  if (single !== -1) {
    return [...order.slice(0, single), 'auto', ...order.slice(single)];
  }
  return [...order.slice(0, deep + 1), 'auto', ...order.slice(deep + 1)];
}

function protocolsDebatePresetIds(source: Source, _deps: Deps, merged: Merged): string[] {
  return [...fromProtocols(source, (data) => idList(data?.order?.debate, 'order.debate')), ...contributed(merged, 'debate')];
}

function protocolsLensIds(source: Source): string[] {
  return fromProtocols(source, (data) => {
    const lenses = data?.lenses;
    return idList(Array.isArray(lenses) ? lenses.map((l: any) => l?.id) : null, 'lenses[].id');
  });
}

/** `primary.harness` may be `unknown` (undeclared) or any registry harness id. */
function harnessesIds(source: Source): string[] {
  const list = source(HARNESSES_FILE)?.harnesses;
  const ids = Array.isArray(list) ? list.map((h: any) => h?.id) : [];
  if (ids.length === 0 || ids.some((id: unknown) => typeof id !== 'string' || !id)) {
    throw new Error(`${HARNESSES_FILE} harnesses[].id must be non-empty strings`);
  }
  return ids;
}

function harnessesPrimaryIds(source: Source): string[] {
  return ['unknown', ...harnessesIds(source)];
}

/** 127 IC-005: the retired harness ids (`id`, `replacement`) harnesses.json records; none when it records none. */
function retiredHarnesses(source: Source): { id: string; replacement: string }[] {
  const list = source(HARNESSES_FILE)?.retired;
  return (Array.isArray(list) ? list : [])
    .filter((entry: any) => typeof entry?.id === 'string' && typeof entry?.replacement === 'string')
    .map((entry: any) => ({ id: entry.id, replacement: entry.replacement }));
}

/** IC-003: schema membership comes from the worker catalogue, loaded only on demand. */
function workersIds(source: Source): string[] {
  const { knownWorkerIds } = require('../../registry/worker-ids.ts');
  const { harnesses } = source(HARNESSES_FILE);
  return knownWorkerIds({ registry: { harnesses } }).ids;
}

/** IC-003: the unset list contains shipped workers and the primary rung. */
function workersDefaultRungs(source: Source): string[] {
  const { shippedWorkerIds } = require('../../registry/worker-ids.ts');
  const { harnesses } = source(HARNESSES_FILE);
  return [...shippedWorkerIds({ harnesses }), 'primary'];
}

/** IC-002: model tiers come from the registry as distinct non-empty strings. */
function modelsTierIds(source: Source): string[] {
  const tiers = source(MODELS_FILE)?.dispatchTiers?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0
      || tiers.some((tier: unknown) => typeof tier !== 'string' || !tier)
      || new Set(tiers).size !== tiers.length) {
    throw new Error(`${MODELS_FILE} dispatchTiers.tiers must be a non-empty list of distinct non-empty strings`);
  }
  return tiers;
}

/** The bundled package's id (core/registry/contribution-points.json `bundled`), always a valid member. */
const BUNDLED_PACKAGE_ID = 'doflow';

/** `doflow`, then the ids the global lock records. A lock that cannot be read adds none: settings must still load. */
function packagesIds(_source: Source, _deps: Deps, _merged: Merged, homeDir: string, fsImpl: any): string[] {
  let recorded: unknown[] = [];
  try { recorded = readLock({ scope: 'global', homeDir }, { fsImpl })?.packages ?? []; } catch { /* the lock is reported by the verbs that own it */ }
  const ids = (Array.isArray(recorded) ? recorded : []).map((row: any) => row?.id).filter((id: unknown) => typeof id === 'string' && id && id !== BUNDLED_PACKAGE_ID);
  return [BUNDLED_PACKAGE_ID, ...new Set<string>(ids as string[])];
}

const RESOLVERS: Readonly<Record<string, (source: Source, deps: Deps, merged: Merged, homeDir: string, fsImpl: any) => unknown>> = Object.freeze({
  'advice.providerIds': adviceProviderIds,
  'advice.providerDefaultEndpoint': adviceProviderDefaultEndpoint,
  'storage.lifecycleEventsDefaultHours': storageLifecycleEventsDefaultHours,
  'models.tierIds': modelsTierIds,
  'protocols.reviewPresetIds': protocolsReviewPresetIds,
  'protocols.reviewPresetOrder': protocolsReviewPresetOrder,
  'protocols.debatePresetIds': protocolsDebatePresetIds,
  'protocols.lensIds': protocolsLensIds,
  'harnesses.primaryIds': harnessesPrimaryIds,
  'harnesses.ids': harnessesIds,
  'workers.ids': workersIds,
  'workers.defaultRungs': workersDefaultRungs,
  'packages.ids': packagesIds,
});

interface Refs {
  /** 127 IC-005: the retired harness ids, with the id to use instead; throws when harnesses.json cannot be read. */
  retired(): { id: string; replacement: string }[];
  /** The value of a named ref; throws on an unknown name or a source that cannot be read. */
  resolve(name: string, deps?: Deps): unknown;
}

function createRefs({ repoRoot = REPO_ROOT, fsImpl = nodeFs, protocols, homeDir }: { repoRoot?: string; fsImpl?: any; protocols?: any; homeDir?: string } = {}): Refs {
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
  let mergedRegistry: any;
  const merged: Merged = () => {
    if (mergedRegistry === undefined) {
      if (protocols !== undefined) mergedRegistry = protocols;
      else {
        try {
          const loaded = require('../review/protocols.ts').loadProtocols({ repoRoot, fsImpl });
          mergedRegistry = loaded.ok ? loaded.registry : null;
        } catch { mergedRegistry = null; }
      }
    }
    return mergedRegistry;
  };
  return {
    retired: () => retiredHarnesses(source),
    resolve(name, deps = {}) {
      if (!Object.hasOwn(RESOLVERS, name)) throw new Error(`unknown settings ref '${name}'`);
      return RESOLVERS[name](source, deps, merged, homeDir ?? os.homedir(), fsImpl);
    },
  };
}

module.exports = { REF_META, createRefs };
