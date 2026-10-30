'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The settings resolver (086 IC-006, DD-2, DD-5, DD-6; data-model §3-4). `loadSettings()` returns a
 * view; `view.get(key, 'project' | 'global')` folds that key bottom-up from its registry default:
 *
 *   default → user legacy → user → (project view only: project legacy → project → local) → env
 *
 * `-g` (the global view) omits the project layers, which also gives the prune and retention root split.
 * Each step is one candidate, and every candidate is kept with a status, so `config list` can say why a
 * value applies and what it beat. The rules, in order:
 *   1. a project or local value of a `global-only` key, or a non-project value of a
 *      `project-only` key, is `ignored-scope`, never validated;
 *   2. an invalid value takes the key's fail-safe where its layer could have widened the key (user
 *      layers; project layers of a `project-overridable` key; env with `direction: any`), else it is
 *      skipped and the key falls through (FR-008, C7/C8/C13/C16);
 *   3. a narrowing comparison (project layers of a `narrow-only` key, any layer of a `combine:
 *      narrowest` key, env with `direction: narrow`) applies only a narrower value; an equal one is
 *      `redundant` and never takes the origin (C6), a wider one is `not-narrower`. A value the key's
 *      order does not rank is never ranked (no `indexOf` of -1): a contributed `review.preset` (122
 *      IC-014) is compared by dominance with the value below, anything else is `not-narrower`;
 *   3b. a `combine: union` key (a string-list) adds each valid candidate's items that are not yet present, in
 *      fold order; every contributor stays `decided`, a candidate adding nothing is `redundant`;
 *   3c. a `combine: subset` key at project/local layers intersects the value below with the candidate,
 *      preserving the order below; installed additions are `not-narrower`, dangling ids are notes
 *      (IC-004). A valid user candidate overrides under rule 4;
 *      a key declaring `unknownMembers: warn` (122 IC-011) keeps a member its list does not hold, as one note;
 *   4. anything else overrides, an equal value included (so the deciding file is the highest one that
 *      sets it, as `doflow storage` names it today, OI-3).
 * After the fold: a key named as `{gate}` by another key's fail-safe takes its own fail-safe when one
 * of those keys hit rule 2; `requires` rules (advice enabled with no model, C7); `needsConfigHome`.
 *
 * Reads are lazy and bounded: a key reads only its own sources, every path is `stat`ed and read at
 * most once per view, `legacy.ts` and `lexical.ts` are required only when a key needs them (legacy
 * after a `stat` hit). No file is written, no process spawned. A settings fault never throws; it is a
 * candidate status plus an `errors` entry. Only an unusable registry throws (IC-001), and so does a
 * caller's mistake (an unknown key, the project view of a `-g` load).
 *
 * Views are memoised per process for the real environment and file system only; a writer calls
 * `clearSettingsCache()` after it writes.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { isOffWord } = require('../off-words.ts');
const { classifyWorkerId, retiredAdvisory } = require('../../registry/worker-ids.ts');

function maskUrl(value: string): string {
  return require('./shared.ts').maskUrl(value);
}

type Layer = 'env' | 'local' | 'project' | 'user' | 'default';
type ViewName = 'project' | 'global';
type Checkout = 'own' | 'main' | null;
type Status = 'decided' | 'overridden' | 'shadowed' | 'redundant' | 'ignored-scope' | 'not-narrower' | 'no-effect' | 'invalid';
type Via = null | 'fail-safe' | 'cross-key' | 'no-config-home';

interface Origin { layer: Layer; source: string | null; legacy: boolean; checkout: Checkout; via: Via }
interface Candidate {
  layer: Layer; source: string; legacy: boolean; checkout: Checkout;
  display: string; value: unknown | null; status: Status; reason: string | null; code: string | null;
}
interface Resolution {
  key: string; view: ViewName; value: unknown; state: 'ok' | 'invalid'; explicit: boolean;
  origin: Origin; candidates: Candidate[]; meta: Record<string, unknown>;
}
interface FileRecord {
  layer: Layer; path: string; kind: 'settings' | 'legacy'; legacyKind: string | null;
  checkout: Checkout; status: 'absent' | 'ok' | 'invalid'; code: string | null; offset: number | null;
}
interface SettingsError { key: string | null; layer: Layer; source: string; legacy: boolean; code: string; reason: string; offset: number | null }
interface SettingsNote { code: string; key: string | null; source: string | null; text: string }
/** A candidate before the fold: its value, or why it has none. */
interface Raw {
  layer: Layer; source: string; legacy: boolean; checkout: Checkout; display: string; value: unknown;
  fault: { code: string; reason: string; offset: number | null } | null; noEffect?: boolean;
  /** 127 IC-005: the value names a retired harness id; the candidate is ignored with an advisory. */
  retired?: { id: string; replacement: string };
}

const NEW_FILE = { user: 'settings.json', project: 'settings.json', local: 'settings.local.json' } as const;

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function absolute(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

/** How a value is shown: JSON text, a url without its user-info. */
function displayOf(spec: any, raw: unknown): string {
  if (raw === undefined) return '';
  return JSON.stringify(spec.type === 'url' && typeof raw === 'string' ? maskUrl(raw) : raw) ?? '';
}

/**
 * A view of `fsImpl` that remembers every `stat` and every file's bytes, errors included, so each path
 * is stat'ed and read at most once per view whichever readers need it (the JSON read and the lexical
 * read of the same `settings.json` share one read).
 */
function onceFs(fsImpl: any): any {
  const stats = new Map<string, { value?: any; error?: any }>();
  const bytes = new Map<string, { value?: Buffer; error?: any }>();
  const remembered = <T>(map: Map<string, { value?: T; error?: any }>, key: string, run: () => T): T => {
    if (!map.has(key)) {
      try { map.set(key, { value: run() }); } catch (error) { map.set(key, { error }); }
    }
    const entry = map.get(key)!;
    if ('error' in entry) throw entry.error;
    return entry.value as T;
  };
  return {
    statSync: (p: string) => remembered(stats, p, () => fsImpl.statSync(p)),
    accessSync: (p: string, mode?: number) => fsImpl.accessSync(p, mode),
    lstatSync: (p: string) => fsImpl.lstatSync(p),
    realpathSync: (p: string) => fsImpl.realpathSync(p),
    readFileSync(p: string, options?: any) {
      const buffer = remembered(bytes, p, () => {
        const read = fsImpl.readFileSync(p);
        return Buffer.isBuffer(read) ? read : Buffer.from(String(read));
      });
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? buffer.toString(encoding) : buffer;
    },
  };
}

function registryOrThrow(): any {
  const { loadSettingsRegistry } = require('./registry.ts');
  const loaded = loadSettingsRegistry();
  if (loaded.ok) return loaded.registry;
  const error: any = new Error(`settings registry unavailable: ${loaded.detail}`);
  error.reason = loaded.reason;
  error.detail = loaded.detail;
  throw error;
}

/** The place of `value` in the key's order (narrowest first), or null when the order does not hold it. */
function rank(spec: any, value: any): number | null {
  if (spec.order === 'ascending') return value;
  if (spec.order === 'descending') return -value;
  const at = spec.order.indexOf(value);
  return at === -1 ? null : at;
}

/**
 * 122 IC-014: how much narrower the `review.preset` value `candidate` is than `lower` when one of them is a contributed
 * preset (no rank): -1 narrower, 0 equal, null not narrower (no dominance relation is looser). `auto` stands for the
 * picks the risk rule can make: a value is narrower than `auto` when it dominates the strictest of them (depth `deep`),
 * and `auto` is narrower than a value only when the loosest of them (depth `single`) dominates it.
 */
function presetNarrowerBy(registry: any, candidate: string, lower: string): number | null {
  if (!registry) return null;
  const { atLeastAsStrict } = require('../review/resolve-protocol.ts');
  const order: string[] = registry.order?.review ?? [];
  const ofDepth = (depth: string): string | undefined => order.find((id) => registry.presets?.[id]?.depth === depth);
  const geq = (a: string | undefined, b: string): boolean => a !== undefined && atLeastAsStrict(registry, 'review', a, b);
  if (candidate === 'auto') return geq(ofDepth('single'), lower) ? -1 : null;
  if (lower === 'auto') {
    const deep = ofDepth('deep');
    return deep !== undefined && geq(candidate, deep) ? -1 : null;
  }
  if (!geq(candidate, lower)) return null;
  return geq(lower, candidate) ? 0 : -1;
}

const memo = new Map<string, any>();

/** Drops every memoised view; writers call it after a write so the next load sees the file. */
function clearSettingsCache(): void {
  memo.clear();
}

interface LoadOptions { projectRoot?: string | null; global?: boolean; env?: Record<string, string | undefined>; registry?: any; fsImpl?: any; protocols?: any; only?: string[] }

/**
 * The registry a view limited to `only` reads: a list-bound key outside `only` has no allowed values (its value in a
 * layer file is then invalid, and no such key can be read from the view), so reading a layer file never resolves another
 * key's value list.
 */
function narrowed(registry: any, only: string[]): any {
  return { ...registry, enumValues: (key: string) => (only.includes(key) ? registry.enumValues(key) : null) };
}

/**
 * @param projectRoot the project root DoFlow resolves for the verb (absolute; anything else means no
 *   project layers)
 * @param global `-g`: the global view, no project layers
 * @param registry a loaded settings registry; defaults to the shipped one (throws when unusable)
 * @param protocols a merged protocol registry the `review.preset` fold compares contributed presets in; defaults to
 *   the runtime's own merged view, loaded only when such a comparison happens
 * @param only the keys the view answers (`get` of any other key throws), for a reader the other keys' value lists
 *   depend on: the package view reads `packages.disabled` this way, because the `review.preset` and `debate.preset`
 *   lists hold the presets of active packages (122 IC-014), so validating them while reading the same layer file would
 *   load the package view again. A key in `only` must not depend on such a key itself (`packages.ids` reads the lock).
 */
function loadSettings({ projectRoot = null, global = false, env = process.env, registry, fsImpl = nodeFs, protocols, only }: LoadOptions = {}): any {
  const { configHome } = require('../config-home.ts');
  const loaded = registry ?? registryOrThrow();
  const reg = only ? narrowed(loaded, only) : loaded;
  const home = configHome(env);
  const root = global ? null : absolute(projectRoot);
  let cacheKey: string | null = null;
  if (env === process.env && fsImpl === nodeFs && !registry && protocols === undefined) {
    const bound = [...reg.keys.values()].filter((spec: any) => spec.env).map((spec: any) => env[spec.env.name] ?? null);
    cacheKey = JSON.stringify([global ? 'global' : 'project', root, home.dir, only ?? null, ...bound]);
    if (memo.has(cacheKey)) return memo.get(cacheKey);
  }
  const view = buildView(reg, home, root, global, env, fsImpl, protocols, only ?? null);
  if (cacheKey) memo.set(cacheKey, view);
  return view;
}

function buildView(registry: any, home: any, root: string | null, global: boolean, env: any, fsImpl: any, protocols: any, only: string[] | null): any {
  const { REGISTRY_FILE } = require('./registry.ts');
  const { REF_META } = require('./refs.ts');
  const { readLayerFile, validateValue } = require('./files.ts');
  const { projectLayerSource } = require('./project-layers.ts');
  const scope: ViewName = global ? 'global' : 'project';
  const io = onceFs(fsImpl);
  const layers = root ? projectLayerSource(root, io) : { layersFrom: null, checkout: null };
  const projectCheckout: Checkout = layers.layersFrom === null ? null : layers.checkout === 'main' ? 'main' : 'own';

  const files: FileRecord[] = [];
  const errors: SettingsError[] = [];
  const notes: SettingsNote[] = [];
  const seen = new Set<string>();
  const once = (tag: string): boolean => (seen.has(tag) ? false : (seen.add(tag), true));
  let presetRegistry: any;
  /** The rank delta of `candidate` over `lower` (negative: narrower), or null when neither rank nor dominance relates them. */
  const narrowerBy = (spec: any, candidate: any, lower: any): number | null => {
    const at = rank(spec, candidate);
    const below = rank(spec, lower);
    if (at !== null && below !== null) return at - below;
    if (spec.orderRef !== 'protocols.reviewPresetOrder') return null;
    if (presetRegistry === undefined) {
      if (protocols !== undefined) presetRegistry = protocols;
      else {
        try {
          const loaded = require('../review/protocols.ts').loadProtocols();
          presetRegistry = loaded.ok ? loaded.registry : null;
        } catch { presetRegistry = null; }
      }
    }
    return presetNarrowerBy(presetRegistry, candidate, lower);
  };
  const reads = new Map<string, any>();
  const resolved = new Map<string, { resolution: Resolution; tripped: Candidate | null }>();
  const resolving = new Set<string>();

  const keyOfField = (field: string): string | null => {
    for (const [name, spec] of registry.keys) {
      if (spec.legacy.some((entry: any) => entry.kind === 'decision-model' && entry.field === field)) return name;
    }
    return null;
  };

  /** What a user decision-model.json is checked against, from the registry (no default kept in code). */
  function providers(): any {
    const providerKey = keyOfField('provider');
    const endpointKey = keyOfField('endpoint');
    const providerSpec = providerKey ? registry.keys.get(providerKey) : null;
    const endpointSpec = endpointKey ? registry.keys.get(endpointKey) : null;
    return {
      defaultProvider: providerSpec?.default,
      ids: (providerKey && registry.enumValues(providerKey)) || [],
      defaultEndpoint(id: string) {
        if (!endpointSpec) return null;
        if (!endpointSpec.defaultRef) return endpointSpec.default;
        try { return registry.resolveRef(endpointSpec.defaultRef, { [providerKey as string]: id }); } catch { return null; }
      },
    };
  }

  function record(entry: FileRecord): void {
    files.push(entry);
  }

  function settingsFile(layer: 'user' | 'project' | 'local', file: string, checkout: Checkout): any {
    if (!reads.has(file)) {
      const read = readLayerFile(file, { registry, fsImpl: io });
      record({ layer, path: file, kind: 'settings', legacyKind: null, checkout, status: read.status, code: read.code, offset: read.offset });
      for (const note of read.notes) notes.push({ code: note.code, key: note.key, source: file, text: note.text });
      reads.set(file, read);
    }
    return reads.get(file);
  }

  /**
   * A `string-list` key declaring `unknownMembers: warn` (122 IC-011) keeps a member its list does not hold, because a
   * project file travels to a machine that has not recorded it: the value stands if it passes every other rule, and the
   * unrecorded members are one note. A list that breaks any other rule keeps its fault.
   */
  function keepUnknownMembers(key: string, spec: any, entry: any, file: string): any {
    if (validateValue({ ...spec, valuesRef: undefined }, entry.raw)) return entry;
    const known = registry.enumValues(key) ?? [];
    const unknown = (entry.raw as string[]).filter((item) => !known.includes(item));
    if (once(`unknown-member\0${key}\0${file}`)) {
      notes.push({ code: 'unknown-member', key, source: file, text: `${key} names ${unknown.join(', ')}, which this machine has not recorded (kept)` });
    }
    return { raw: entry.raw, value: entry.raw, error: null };
  }

  /** A legacy file read: a `stat` first, and `legacy.ts` only on a hit. */
  function legacyFile(layer: 'user' | 'project', entry: any, file: string, checkout: Checkout): any {
    if (!reads.has(file)) {
      let hit = false;
      try { io.statSync(file); hit = true; } catch (error: any) {
        // 2.0 read decision-model.json without a stat: any error but ENOENT made it invalid
        hit = entry.kind === 'decision-model' && error?.code !== 'ENOENT';
      }
      let read: any = { status: 'absent' };
      if (hit) {
        const legacy = require('./legacy.ts');
        if (entry.kind === 'decision-model') {
          read = legacy.readDecisionModel(file, layer, layer === 'user' ? providers() : null, io);
          for (const note of read.notes) {
            notes.push({ code: note.code, key: note.field ? keyOfField(note.field) : null, source: file, text: note.text });
          }
        } else if (entry.kind === 'line-onoff') {
          const value = legacy.readLineOnOff(file, io);
          read = value === null ? { status: 'absent' } : { status: 'ok', value };
        } else {
          read = legacy.readSentinel(file, io) ? { status: 'ok', value: entry.value } : { status: 'absent' };
        }
      }
      record({ layer, path: file, kind: 'legacy', legacyKind: entry.kind, checkout, status: read.status, code: read.code ?? null, offset: read.offset ?? null });
      reads.set(file, read);
    }
    return reads.get(file);
  }

  function newPath(layer: 'user' | 'project'): string {
    return layer === 'user' ? path.join(home.dir, NEW_FILE.user) : path.join(layers.layersFrom as string, NEW_FILE.project);
  }

  /** 127 IC-005: the retired record a `harnesses.primaryIds` enum value names, else null (any other id stays an enum fault). */
  function retiredHarnessOf(spec: any, value: unknown): { id: string; replacement: string } | null {
    if (spec.valuesRef !== 'harnesses.primaryIds' || typeof value !== 'string') return null;
    return (registry.retired?.() ?? []).find((entry: any) => entry.id === value) ?? null;
  }

  /** The candidates of one key in one view, lowest layer first (the env last). */
  function rawCandidates(key: string, spec: any, viewName: ViewName): Raw[] {
    const out: Raw[] = [];
    // The legacy file's deprecation note waits until the new file has been read: it tells the reader to set the
    // key there, which is noise when settings.json already holds it (FU-3xc3fj).
    const deprecated: Array<{ layer: 'user' | 'project'; file: string }> = [];
    const legacyAt = (layer: 'user' | 'project', base: string, checkout: Checkout): void => {
      for (const entry of spec.legacy) {
        if (entry.layer !== layer) continue;
        const file = path.join(base, entry.path);
        const read = legacyFile(layer, entry, file, checkout);
        const base0 = { layer, source: file, legacy: true, checkout };
        if (read.status === 'absent') continue;
        if (read.status === 'invalid') {
          out.push({ ...base0, display: '', value: null, fault: { code: read.code, reason: read.reason, offset: read.offset } });
        } else if (entry.kind === 'decision-model') {
          if (!read.fields.has(entry.field)) continue;
          const value = read.fields.get(entry.field);
          out.push({ ...base0, display: displayOf(spec, value), value, fault: null });
        } else {
          out.push({ ...base0, display: displayOf(spec, read.value), value: read.value, fault: null });
        }
        deprecated.push({ layer, file });
      }
    };
    const fileAt = (layer: 'user' | 'project' | 'local', file: string, checkout: Checkout): void => {
      const base0 = { layer, source: file, legacy: false, checkout };
      if (layer === 'user' && spec.shellRead === 'lexical-v1') {
        // Valid JSON still gets the schema check (so invalid enum values are visible in config list);
        // malformed JSON keeps the shell-compatible lexical fallback (IC-004).
        const read = settingsFile(layer, file, checkout);
        if (read.status === 'ok') {
          const entry = read.values.get(key);
          if (entry?.error) {
            out.push({ ...base0, display: displayOf(spec, entry.raw), value: null,
              fault: { ...entry.error, offset: null } });
            return;
          }
        }
        // Even parseable values use the literal line rule; duplicate keys keep every reader aligned.
        const value = require('./lexical.ts').readLexicalCapture(file, io);
        if (value !== null) out.push({ ...base0, display: displayOf(spec, value), value, fault: null });
        return;
      }
      const read = settingsFile(layer, file, checkout);
      if (read.status === 'absent') return;
      if (read.status === 'invalid') {
        out.push({ ...base0, display: '', value: null, fault: { code: read.code, reason: read.reason, offset: read.offset } });
        return;
      }
      let entry = read.values.get(key);
      if (!entry) return;
      const retired = entry.error?.code === 'enum' ? retiredHarnessOf(spec, entry.raw) : null;
      if (retired) {
        out.push({ ...base0, display: displayOf(spec, entry.raw), value: null, fault: null, retired });
        return;
      }
      if (spec.unknownMembers === 'warn' && entry.error?.code === 'enum') entry = keepUnknownMembers(key, spec, entry, file);
      out.push({ ...base0, display: displayOf(spec, entry.raw), value: entry.value, fault: entry.error ? { ...entry.error, offset: null } : null });
    };

    if (home.dir) {
      legacyAt('user', home.dir, null);
      fileAt('user', path.join(home.dir, NEW_FILE.user), null);
    }
    if (viewName === 'project' && layers.layersFrom) {
      legacyAt('project', layers.layersFrom, projectCheckout);
      fileAt('project', path.join(layers.layersFrom, NEW_FILE.project), projectCheckout);
      fileAt('local', path.join(layers.layersFrom, NEW_FILE.local), projectCheckout);
    }
    if (spec.env) {
      const raw = env[spec.env.name];
      if (typeof raw === 'string' && raw !== '') {
        const base0 = { layer: 'env' as Layer, source: spec.env.name, legacy: false, checkout: null, display: raw };
        if (spec.env.parse === 'positive-int') {
          // 2.0 parseWindow (lifecycle/retention.ts)
          const ok = /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw));
          out.push({ ...base0, value: ok ? Number(raw) : null, fault: ok ? null : { code: 'type', reason: /^0[0-9]+$/.test(raw) ? 'must be a positive whole number (no leading zeros)' : 'must be a positive whole number', offset: null } });
        } else if (spec.env.parse === 'verbatim') {
          // 120 IC-002: taken as written and judged like any file value
          const fault = validateValue(spec, raw, registry.enumValues(key));
          const retired = fault?.code === 'enum' ? retiredHarnessOf(spec, raw) : null;
          if (retired) out.push({ ...base0, value: null, fault: null, retired });
          else out.push({ ...base0, value: fault ? null : raw, fault: fault ? { ...fault, offset: null } : null });
        } else if (isOffWord(raw)) {
          // 2.0 envSetting + OFF_VALUES (failure/home.ts): only an off word has an effect
          out.push({ ...base0, value: 'off', fault: null });
        } else {
          out.push({ ...base0, value: null, fault: null, noEffect: true });
        }
      }
    }
    for (const { layer, file } of deprecated) {
      const held = reads.get(newPath(layer));
      if (held?.status === 'ok' && held.values.has(key)) continue;
      if (once(`deprecated\0${file}\0${key}`)) {
        notes.push({ code: 'deprecated', key, source: file, text: `${file} is deprecated; set "${key}" in ${newPath(layer)} (read through 2.x)` });
      }
    }
    return out;
  }

  function defaultOf(spec: any, viewName: ViewName): unknown {
    if (Object.hasOwn(spec, 'default')) return spec.default;
    const deps: Record<string, unknown> = {};
    for (const dep of REF_META[spec.defaultRef]?.dependsOn ?? []) deps[dep] = resolve(dep, viewName).resolution.value;
    return registry.resolveRef(spec.defaultRef, deps);
  }

  function fold(key: string, viewName: ViewName): { resolution: Resolution; tripped: Candidate | null } {
    const spec = registry.keys.get(key);
    const fallback = defaultOf(spec, viewName);
    let value = fallback;
    let state: 'ok' | 'invalid' = 'ok';
    let origin: Origin = { layer: 'default', source: REGISTRY_FILE, legacy: false, checkout: null, via: null };
    let holder: Candidate | null = null;
    let tripped: Candidate | null = null;
    const candidates: Candidate[] = [];
    const take = (c: Candidate, via: Via, keepHolder = false): void => {
      if (!keepHolder && holder && holder.status === 'decided') {
        holder.status = holder.layer === c.layer && holder.legacy && !c.legacy ? 'shadowed' : 'overridden';
      }
      origin = { layer: c.layer, source: c.source, legacy: c.legacy, checkout: c.checkout, via };
      holder = c;
    };

    for (const raw of rawCandidates(key, spec, viewName)) {
      const c: Candidate = {
        layer: raw.layer, source: raw.source, legacy: raw.legacy, checkout: raw.checkout, display: raw.display,
        value: raw.fault ? null : raw.value, status: 'decided', reason: null, code: null,
      };
      candidates.push(c);
      const projectLayer = c.layer === 'project' || c.layer === 'local';
      const bound = c.layer === 'env';
      if (!projectLayer && spec.scope === 'project-only') {
        Object.assign(c, { status: 'ignored-scope', value: null, reason: 'project-only: only a project can set it' });
        continue;
      }
      if (raw.noEffect) {
        Object.assign(c, { status: 'no-effect', value: null, reason: 'only off, 0, false or no has an effect' });
        continue;
      }
      if (projectLayer && spec.scope === 'global-only') {
        Object.assign(c, { status: 'ignored-scope', value: null, reason: 'global-only: a project cannot set it' });
        continue;
      }
      if (raw.retired) {
        const reason = retiredAdvisory(key, raw.retired);
        Object.assign(c, { status: 'no-effect', value: null, code: 'retired', reason });
        if (once(`retired\0${key}\0${c.source}\0${raw.retired.id}`)) notes.push({ code: 'retired', key, source: c.source, text: reason });
        continue;
      }
      if (raw.fault) {
        Object.assign(c, { status: 'invalid', reason: raw.fault.reason, code: raw.fault.code });
        if (once(`error\0${key}\0${c.layer}\0${c.source}`)) {
          errors.push({ key, layer: c.layer, source: c.source, legacy: c.legacy, code: raw.fault.code, reason: raw.fault.reason, offset: raw.fault.offset });
        }
        const canWiden = c.layer === 'user'
          || (projectLayer && spec.scope === 'project-overridable')
          || (bound && spec.env?.direction === 'any');
        if (!canWiden || !Object.hasOwn(spec, 'failSafe')) continue;
        const safe = spec.failSafe;
        if (isObject(safe) && typeof safe.gate === 'string') {
          tripped ??= c;                                   // keeps its lower value; the gate key reacts
        } else if (isObject(safe)) {
          take(c, 'fail-safe');                            // {state: 'invalid'}: the consumer's invalid path
          state = 'invalid';
        } else {
          take(c, 'fail-safe');
          value = safe;
          state = 'ok';
        }
        continue;
      }
      // IC-002, IC-004: report each dangling worker once per key, source and id, across both views.
      // 127 IC-005: a retired id is reported as retired and dropped from the value instead.
      if (spec.type === 'worker-list' || spec.type === 'worker-models' || spec.type === 'worker-billing') {
        const known = registry.enumValues(key) ?? [];
        const retired = registry.retired?.() ?? [];
        const isList = spec.type === 'worker-list';
        const ids = isList ? c.value as string[] : Object.keys(c.value as Record<string, unknown>);
        const gone = new Set<string>();
        for (const id of ids) {
          if (id === 'primary') continue;
          const kind = classifyWorkerId(id, known, retired);
          if (kind === 'retired') {
            gone.add(id);
            if (once(`retired\0${key}\0${c.source}\0${id}`)) {
              notes.push({ code: 'retired', key, source: c.source, text: retiredAdvisory(key, retired.find((entry: any) => entry.id === id)) });
            }
          } else if (kind === 'dangling' && spec.type !== 'worker-billing' && once(`dangling-worker\0${key}\0${c.source}\0${id}`)) {
            notes.push({ code: 'dangling-worker', key, source: c.source, text: `${key}: worker '${id}' is not installed (ignored)` });
          }
        }
        if (gone.size > 0) {
          const kept = isList
            ? (c.value as string[]).filter((id) => !gone.has(id))
            : Object.fromEntries(Object.entries(c.value as Record<string, unknown>).filter(([id]) => !gone.has(id)));
          if ((isList ? (kept as string[]).length : Object.keys(kept).length) === 0) {
            Object.assign(c, { status: 'no-effect', value: null, code: 'retired', reason: 'every worker it names is retired' });
            continue;
          }
          c.value = kept;
        }
      }
      if (spec.combine === 'union') {
        const added = (c.value as string[]).filter((item) => !(value as string[]).includes(item));
        if (added.length === 0) {
          Object.assign(c, { status: 'redundant', reason: 'every item is already present' });
          continue;
        }
        take(c, null, true);                               // both the earlier contributor and this one apply
        value = [...(value as string[]), ...added];
        state = 'ok';
        tripped = null;
        continue;
      }
      // IC-004 rule 3c: a project allowlist can remove entries, never add or reorder them.
      if (spec.combine === 'subset' && projectLayer) {
        if (state === 'invalid') {
          Object.assign(c, { status: 'no-effect', reason: 'the value below is invalid' });
          continue;
        }
        const below = value as string[];
        const candidate = c.value as string[];
        const isModelList = spec.type === 'model-list';
        const itemKind = isModelList ? 'models' : 'workers';
        const known = isModelList ? [] : (registry.enumValues(key) ?? []);
        const added = isModelList
          ? candidate.filter((id) => !below.includes(id))
          : candidate.filter((id) => !below.includes(id) && (id === 'primary' || known.includes(id)));
        if (added.length > 0) {
          Object.assign(c, { status: 'not-narrower', reason: `narrow-only: a project may only remove ${itemKind} ('${added[0]}' is not in the value below)` });
          continue;
        }
        const result = below.filter((id) => candidate.includes(id));
        if (result.length === below.length) {
          Object.assign(c, { status: 'redundant', reason: 'equal to the value below' });
          continue;
        }
        if (result.length === 0) {
          Object.assign(c, { status: 'no-effect', reason: `no ${itemKind} remain in the intersection` });
          continue;
        }
        take(c, null);
        value = result;
        state = 'ok';
        tripped = null;
        const ordered = candidate.filter((id) => result.includes(id));
        if (ordered.some((id, index) => id !== result[index])) {
          c.code = 'order-ignored';
          c.reason = `a project cannot reorder ${itemKind}; the order below applies`;
        }
        continue;
      }
      const narrowing = (projectLayer && spec.scope === 'narrow-only') || spec.combine === 'narrowest'
        || (bound && spec.env?.direction === 'narrow');
      if (narrowing) {
        // an unset value (null) is the widest, so any valid candidate narrows it
        const delta = value === null ? -1 : narrowerBy(spec, c.value, value);
        if (delta === 0) {
          Object.assign(c, { status: 'redundant', reason: 'equal to the value below' });
          continue;
        }
        if (delta === null || delta > 0) {
          Object.assign(c, { status: 'not-narrower', reason: projectLayer && spec.scope === 'narrow-only' ? 'narrow-only: a project may only narrow it' : 'only a narrower value applies' });
          continue;
        }
      }
      take(c, null);
      value = c.value;
      state = 'ok';
      tripped = null;
    }

    if (origin.via === null) {
      // a key that names this one as its gate hit its fail-safe: this key takes its own
      for (const [other, otherSpec] of registry.keys) {
        if (!(isObject(otherSpec.failSafe) && otherSpec.failSafe.gate === key)) continue;
        const forced = resolve(other, viewName).tripped;
        if (!forced) continue;
        if (holder && (holder as Candidate).status === 'decided') (holder as Candidate).status = 'overridden';
        origin = { layer: forced.layer, source: forced.source, legacy: forced.legacy, checkout: forced.checkout, via: 'fail-safe' };
        value = spec.failSafe;
        break;
      }
    }
    if (origin.via === null && Array.isArray(spec.requires)) {
      for (const rule of spec.requires) {
        if (value !== rule.when) continue;
        const needed = resolve(rule.key, scope === 'global' ? 'global' : rule.view).resolution;
        if (needed.value !== null) continue;
        const reason = `is ${JSON.stringify(rule.when)} but "${rule.key}" has no value`;
        if (once(`error\0${key}\0cross-key\0${origin.source}`)) {
          errors.push({ key, layer: origin.layer, source: origin.source ?? REGISTRY_FILE, legacy: origin.legacy, code: 'cross-key', reason, offset: null });
        }
        origin = { ...origin, via: 'cross-key' };
        value = spec.failSafe;
        break;
      }
    }
    if (spec.needsConfigHome && home.dir === null) {
      const previous = holder as Candidate | null;
      if (previous?.status === 'decided') previous.status = 'overridden';
      origin = { layer: 'default', source: null, legacy: false, checkout: null, via: 'no-config-home' };
      value = spec.failSafe;
      state = 'ok';
    }

    const resolution: Resolution = {
      key, view: viewName, value, state, explicit: origin.layer !== 'default', origin, candidates,
      meta: {
        type: spec.type,
        values: registry.enumValues(key),
        order: spec.order ?? null,
        default: fallback,
        scope: spec.scope, combine: spec.combine, securityRelevant: spec.securityRelevant,
        env: spec.env, flag: spec.flag, shellRead: spec.shellRead, views: spec.views ?? ['project'],
        needsConfigHome: spec.needsConfigHome, description: spec.description,
      },
    };
    return { resolution, tripped };
  }

  function resolve(key: string, viewName: ViewName): { resolution: Resolution; tripped: Candidate | null } {
    const id = `${viewName}\0${key}`;
    if (!resolved.has(id)) {
      if (resolving.has(id)) throw new Error(`settings key "${key}" depends on itself`);
      resolving.add(id);
      try { resolved.set(id, fold(key, viewName)); } finally { resolving.delete(id); }
    }
    return resolved.get(id)!;
  }

  /** One key's resolution in a view (the load's scope by default). Plain data, shared: do not mutate. */
  function get(key: string, viewName: ViewName = scope): Resolution {
    if (!registry.keys.has(key)) throw new Error(`unknown settings key "${key}"`);
    if (only && !only.includes(key)) throw new Error(`settings key "${key}" is not in this view (only ${only.join(', ')})`);
    if (viewName !== 'project' && viewName !== 'global') throw new Error(`unknown settings view "${viewName}"`);
    if (viewName === 'project' && scope === 'global') throw new Error('the project view is not available in a global (-g) load');
    return resolve(key, viewName).resolution;
  }

  /** Every key resolved: the `config list --json` payload (IC-012). */
  function report(): any {
    const keys: Record<string, unknown> = {};
    for (const [name, spec] of registry.keys) {
      keys[name] = scope === 'project' && Array.isArray(spec.views) && spec.views.includes('global')
        ? { project: get(name, 'project'), global: get(name, 'global') }
        : get(name);
    }
    return {
      schema: 1, scope, configHome: view.configHome, project: view.project,
      files: [...files], keys, errors: [...errors], notes: [...notes],
    };
  }

  const view = {
    schema: 1 as const,
    scope,
    configHome: { dir: home.dir, ignored: [...home.ignored] },
    project: { root, layersFrom: layers.layersFrom, checkout: layers.layersFrom === null ? null : layers.checkout },
    files, errors, notes, get, report,
  };
  return view;
}

module.exports = { loadSettings, clearSettingsCache };
