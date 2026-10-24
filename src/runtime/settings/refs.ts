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
 *   protocols.reviewPresetIds             core/registry/protocols.json 'auto', then order.review
 *   protocols.reviewPresetOrder           core/registry/protocols.json order.review with 'auto' right after the
 *                                         preset of depth 'deep'
 *   protocols.debatePresetIds             core/registry/protocols.json order.debate
 *   protocols.lensIds                     core/registry/protocols.json lenses[].id
 *   harnesses.primaryIds                  'unknown', then core/registry/harnesses.json harnesses[].id in order
 *
 * Where `auto` ranks: `auto` follows the risk rule, which picks the preset of depth `deep` or the one
 * of depth `single` (resolve-protocol.ts `idOfDepth`), so the deep preset is the strictest it can
 * pick. A preset at or above the deep one in order.review is at least as strict as anything `auto`
 * gives and ranks above it; every preset below the deep one ranks below it. A preset a package adds
 * above review-deep therefore needs no settings edit.
 *
 * protocols.json is held to `validateProtocols` before any of its refs resolves, so a ref never hands
 * out ids from a registry the review verbs would refuse. Sources are read on first use and cached for
 * the life of the returned resolver. A failure throws an Error that names the file and the field and
 * never carries file text.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { validateProtocols } = require('../review/protocols.ts');

type RefKind = 'values' | 'order' | 'default';
interface RefMeta { kind: RefKind; dependsOn: string[] }
/** Values of the keys a ref depends on (`dependsOn`), by key name. */
type Deps = Record<string, unknown>;
type Source = (name: string) => any;

const ADVICE_FILE = 'core/registry/advice.json';
const STORAGE_FILE = 'core/registry/storage.json';
const PROTOCOLS_FILE = 'core/registry/protocols.json';
const HARNESSES_FILE = 'core/registry/harnesses.json';

/** What each ref is and which keys' values it needs, so the loader can detect a cycle without resolving. */
const REF_META: Readonly<Record<string, RefMeta>> = Object.freeze({
  'advice.providerIds': { kind: 'values', dependsOn: [] },
  'advice.providerDefaultEndpoint': { kind: 'default', dependsOn: ['advice.provider'] },
  'storage.lifecycleEventsDefaultHours': { kind: 'default', dependsOn: [] },
  'protocols.reviewPresetIds': { kind: 'values', dependsOn: [] },
  'protocols.reviewPresetOrder': { kind: 'order', dependsOn: [] },
  'protocols.debatePresetIds': { kind: 'values', dependsOn: [] },
  'protocols.lensIds': { kind: 'values', dependsOn: [] },
  'harnesses.primaryIds': { kind: 'values', dependsOn: [] },
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

/** `review.preset` may be `auto` or any review preset id (IC-006). */
function protocolsReviewPresetIds(source: Source): string[] {
  return ['auto', ...fromProtocols(source, (data) => idList(data?.order?.review, 'order.review'))];
}

/** The `review.preset` values narrowest (strictest) first; the header says where `auto` goes and why. */
function protocolsReviewPresetOrder(source: Source): string[] {
  const order = protocolsReviewPresetIds(source).slice(1);
  const presets = source(PROTOCOLS_FILE).presets;
  const deep = order.findIndex((id) => presets[id].depth === RISK_STRICTEST_DEPTH);
  if (deep === -1) throw new Error(`${PROTOCOLS_FILE} order.review has no preset of depth '${RISK_STRICTEST_DEPTH}'`);
  return [...order.slice(0, deep + 1), 'auto', ...order.slice(deep + 1)];
}

function protocolsDebatePresetIds(source: Source): string[] {
  return fromProtocols(source, (data) => idList(data?.order?.debate, 'order.debate'));
}

function protocolsLensIds(source: Source): string[] {
  return fromProtocols(source, (data) => {
    const lenses = data?.lenses;
    return idList(Array.isArray(lenses) ? lenses.map((l: any) => l?.id) : null, 'lenses[].id');
  });
}

/** `primary.harness` may be `unknown` (undeclared) or any registry harness id. */
function harnessesPrimaryIds(source: Source): string[] {
  const list = source(HARNESSES_FILE)?.harnesses;
  const ids = Array.isArray(list) ? list.map((h: any) => h?.id) : [];
  if (ids.length === 0 || ids.some((id: unknown) => typeof id !== 'string' || !id)) {
    throw new Error(`${HARNESSES_FILE} harnesses[].id must be non-empty strings`);
  }
  return ['unknown', ...ids];
}

const RESOLVERS: Readonly<Record<string, (source: Source, deps: Deps) => unknown>> = Object.freeze({
  'advice.providerIds': adviceProviderIds,
  'advice.providerDefaultEndpoint': adviceProviderDefaultEndpoint,
  'storage.lifecycleEventsDefaultHours': storageLifecycleEventsDefaultHours,
  'protocols.reviewPresetIds': protocolsReviewPresetIds,
  'protocols.reviewPresetOrder': protocolsReviewPresetOrder,
  'protocols.debatePresetIds': protocolsDebatePresetIds,
  'protocols.lensIds': protocolsLensIds,
  'harnesses.primaryIds': harnessesPrimaryIds,
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
