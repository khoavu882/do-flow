'use strict';

// 119 IC-001: the review/debate protocol registry (core/registry/protocols.json) and its validator.
// Presets are data behind `validateProtocols`, a pure function over a parsed object, so a package
// could contribute presets later without a second validator. Read from the runtime install root
// (REPO_ROOT), never from a project tree. Content errors are returned, never thrown.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { dominates } = require('./dominance.ts');
const { isLocalId } = require('../../helper/package-ids.ts');

const PROTOCOLS_FILE = 'core/registry/protocols.json';
const MODELS_FILE = 'core/registry/models.json';
const KINDS = ['review', 'debate'];
const FAMILIES = ['any', 'different-from-author'];
const SYNTHESIZERS = ['separate', 'seat', 'none', 'verifier'];
const DECIDERS = ['gate', 'orchestrator'];
const PRESET_ID = /^[a-z][a-z0-9-]*$/;
const INVARIANT_ID = /^INV-\d+$/;

const TOP_KEYS = ['schema', 'description', 'hardRoundCap', 'lenses', 'synthesizerStrength', 'presets', 'order', 'invariants'];
const LENS_KEYS = ['id', 'description'];
const PRESET_KEYS = ['kind', 'depth', 'seats', 'rounds', 'crossAnswer', 'synthesizer', 'decider'];
const SEAT_KEYS = ['id', 'agent', 'lenses', 'model'];
const MODEL_KEYS = ['tier', 'family'];
const ROUNDS_KEYS = ['default', 'min'];
const INVARIANT_KEYS = ['id', 'statement', 'enforcedBy', 'kinds', 'authorKinds'];

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isPositiveInt = (value: any): boolean => Number.isInteger(value) && value > 0;
const isNonEmptyString = (value: any): boolean => typeof value === 'string' && value.length > 0;

/** Closed shape: every key of `value` must be in `allowed`. */
function checkKeys(errors: string[], where: string, value: any, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where} has unknown key '${key}'`);
  }
}

/** The ordered core model tiers (models.json `dispatchTiers.tiers`, loosest first) of the runtime install; null when unreadable. */
let coreTierCache: string[] | null | undefined;
function coreTiers(): string[] | null {
  if (coreTierCache === undefined) {
    try {
      const tiers = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MODELS_FILE), 'utf8'))?.dispatchTiers?.tiers;
      coreTierCache = Array.isArray(tiers) && tiers.length > 0 && tiers.every(isNonEmptyString) ? tiers : null;
    } catch {
      coreTierCache = null;
    }
  }
  return coreTierCache;
}

/**
 * The entry shape of one preset (122 IC-014): the one validator for core presets and, later, for a
 * package's contributed ones. `context` carries what the check reads beside the preset: `lensIds` (the
 * lens catalogue), `hardRoundCap` and `tiers` (default: the core tiers of models.json). With
 * `context.mode === 'package'` (a contributed preset, IC-014) `depth` is refused rather than required, each
 * seat id must be a local id, and each seat agent must be in `context.agents` (the core agent specs a package
 * seat may name). The kind match and comparability belong to the caller. Cross-preset rules (unique depth, `order`) stay in
 * `validateProtocols`. Returns the errors; never throws.
 */
function validatePreset(id: string, preset: any, context: any = {}): string[] {
  const errors: string[] = [];
  const lensIdSet = new Set<string>(context.lensIds ?? []);
  const cap = context.hardRoundCap;
  const tiers: string[] | null = Object.hasOwn(context, 'tiers') ? context.tiers : coreTiers();
  const where = `presets.${id}`;
  if (!PRESET_ID.test(id)) errors.push(`${where} id must match ${PRESET_ID}`);
  if (!isObject(preset)) { errors.push(`${where} must be an object`); return errors; }
  checkKeys(errors, where, preset, PRESET_KEYS);

  if (!KINDS.includes(preset.kind)) errors.push(`${where}.kind must be one of ${KINDS.join(', ')}`);
  const packageMode = context.mode === 'package';
  const agents: string[] = Array.isArray(context.agents) ? context.agents : [];
  if (packageMode) {
    if ('depth' in preset) errors.push(`${where}.depth is not allowed in a package preset (the depth vocabulary stays core)`);
  } else if (preset.kind === 'review') {
    if (!isNonEmptyString(preset.depth)) errors.push(`${where}.depth is required on a review preset`);
  } else if (preset.kind === 'debate' && 'depth' in preset) {
    errors.push(`${where}.depth is not allowed on a debate preset`);
  }

  const seatIds = new Set<string>();
  if (!Array.isArray(preset.seats) || preset.seats.length === 0) {
    errors.push(`${where}.seats must be a non-empty array`);
  } else {
    preset.seats.forEach((seat: any, i: number) => {
      const sw = `${where}.seats[${i}]`;
      if (!isObject(seat)) { errors.push(`${sw} must be an object`); return; }
      checkKeys(errors, sw, seat, SEAT_KEYS);
      if (!isNonEmptyString(seat.id)) errors.push(`${sw}.id must be a non-empty string`);
      else if (seatIds.has(seat.id)) errors.push(`${where} seat id '${seat.id}' is duplicated`);
      else seatIds.add(seat.id);
      if (packageMode && isNonEmptyString(seat.id) && !isLocalId(seat.id)) errors.push(`${sw}.id must be a local id (2 to 15 characters of a-z, 0-9 and single hyphens)`);
      if (!isNonEmptyString(seat.agent)) errors.push(`${sw}.agent must be a non-empty string`);
      else if (packageMode && !agents.includes(seat.agent)) errors.push(`${sw}.agent must be one of the core agents allowed for this kind: ${agents.join(', ') || '(none readable)'}`);
      if ('lenses' in seat) {
        if (!Array.isArray(seat.lenses)) errors.push(`${sw}.lenses must be an array`);
        else for (const lens of seat.lenses) {
          if (!lensIdSet.has(lens)) errors.push(`${sw}.lenses names unknown lens '${lens}'`);
        }
      }
      if (!isObject(seat.model)) errors.push(`${sw}.model must be an object`);
      else {
        checkKeys(errors, `${sw}.model`, seat.model, MODEL_KEYS);
        if (!isNonEmptyString(seat.model.tier)) errors.push(`${sw}.model.tier must be a non-empty string`);
        else if (!Array.isArray(tiers)) errors.push(`${sw}.model.tier cannot be checked: ${MODELS_FILE} dispatchTiers.tiers is unreadable`);
        else if (!tiers.includes(seat.model.tier)) errors.push(`${sw}.model.tier '${seat.model.tier}' must be one of ${tiers.join(', ')}`);
        if ('family' in seat.model && !FAMILIES.includes(seat.model.family)) {
          errors.push(`${sw}.model.family must be one of ${FAMILIES.join(', ')}`);
        }
      }
    });
  }

  const rounds = preset.rounds;
  if (!isObject(rounds)) errors.push(`${where}.rounds must be an object`);
  else {
    checkKeys(errors, `${where}.rounds`, rounds, ROUNDS_KEYS);
    for (const field of ROUNDS_KEYS) {
      if (!isPositiveInt(rounds[field])) errors.push(`${where}.rounds.${field} must be a positive integer`);
    }
    if (isPositiveInt(rounds.default) && isPositiveInt(rounds.min)) {
      if (rounds.min > rounds.default) errors.push(`${where}.rounds.min must not exceed rounds.default`);
      if (isPositiveInt(cap) && rounds.default > cap) errors.push(`${where}.rounds.default must not exceed hardRoundCap`);
    }
  }

  if (typeof preset.crossAnswer !== 'boolean') errors.push(`${where}.crossAnswer must be a boolean`);
  if (!SYNTHESIZERS.includes(preset.synthesizer)) errors.push(`${where}.synthesizer must be one of ${SYNTHESIZERS.join(', ')}`);
  else if (preset.synthesizer === 'seat' && !(Array.isArray(preset.seats) && preset.seats.length === 1)) {
    errors.push(`${where}.synthesizer 'seat' is only valid on a one-seat preset`);
  }
  if (!DECIDERS.includes(preset.decider)) errors.push(`${where}.decider must be one of ${DECIDERS.join(', ')}`);
  return errors;
}

/**
 * The preset ids a first-party (bundled) package contributes, by kind, for an `order` entry that names an id
 * `presets` does not hold (122 IC-014: `order` stays core-authored and may name first-party ids). `opaque` is
 * true when a bundled package's ids cannot be known (point registry or manifest unreadable): such an id is then
 * skipped by the loader, never a validation error (FR-009). Lazy, so the packages modules load only when needed.
 */
function bundledPresetIds({ repoRoot, fsImpl }: any = {}): { review: string[]; debate: string[]; opaque: boolean } {
  try {
    return require('../packages/contributions.ts').firstPartyPresets({ repoRoot, fsImpl });
  } catch {
    return { review: [], debate: [], opaque: false };
  }
}

/**
 * Validate a parsed registry. `options.firstParty` (default: read from `options.repoRoot`, REPO_ROOT, only when an
 * `order` id has no preset) names the first-party ids an `order` may carry without holding their preset.
 */
function validateProtocols(data: any, options: any = {}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(data)) return { ok: false, errors: ['registry must be an object'] };
  checkKeys(errors, 'registry', data, TOP_KEYS);

  if (data.schema !== 1) errors.push('schema must be 1');
  if (!isNonEmptyString(data.description)) errors.push('description must be a non-empty string');
  const cap = data.hardRoundCap;
  if (!isPositiveInt(cap)) errors.push('hardRoundCap must be a positive integer');

  const lensIdSet = new Set<string>();
  if (!Array.isArray(data.lenses) || data.lenses.length === 0) {
    errors.push('lenses must be a non-empty array');
  } else {
    data.lenses.forEach((lens: any, i: number) => {
      const where = `lenses[${i}]`;
      if (!isObject(lens)) { errors.push(`${where} must be an object`); return; }
      checkKeys(errors, where, lens, LENS_KEYS);
      if (!isNonEmptyString(lens.id)) errors.push(`${where}.id must be a non-empty string`);
      else if (lensIdSet.has(lens.id)) errors.push(`lens id '${lens.id}' is duplicated`);
      else lensIdSet.add(lens.id);
      if (!isNonEmptyString(lens.description)) errors.push(`${where}.description must be a non-empty string`);
    });
  }

  // The synthesizer lattice `dominates` reads: one non-negative integer per synthesizer, higher is stronger.
  const strength = data.synthesizerStrength;
  let strengthOk = isObject(strength);
  if (!strengthOk) errors.push('synthesizerStrength must be an object');
  else {
    const before = errors.length;
    checkKeys(errors, 'synthesizerStrength', strength, SYNTHESIZERS);
    for (const name of SYNTHESIZERS) {
      if (!Object.hasOwn(strength, name)) errors.push(`synthesizerStrength omits synthesizer '${name}'`);
      else if (!Number.isInteger(strength[name]) || strength[name] < 0) errors.push(`synthesizerStrength.${name} must be a non-negative integer`);
    }
    strengthOk = errors.length === before;
  }

  let firstParty: { review: string[]; debate: string[]; opaque: boolean } | undefined;
  const kindOf: Record<string, string> = {};
  const validIds = new Set<string>(); // presets with no entry error: the only ones the order's dominance check compares
  const depths = new Map<string, string>();
  if (!isObject(data.presets) || Object.keys(data.presets).length === 0) {
    errors.push('presets must be a non-empty object');
  } else {
    const context = { lensIds: lensIdSet, hardRoundCap: cap, tiers: coreTiers() };
    for (const [id, preset] of Object.entries<any>(data.presets)) {
      const presetErrors = validatePreset(id, preset, context);
      errors.push(...presetErrors);
      if (presetErrors.length === 0) validIds.add(id);
      if (!isObject(preset) || !KINDS.includes(preset.kind)) continue;
      kindOf[id] = preset.kind;
      if (preset.kind === 'review' && isNonEmptyString(preset.depth)) {
        if (depths.has(preset.depth)) errors.push(`presets.${id}.depth '${preset.depth}' duplicates presets.${depths.get(preset.depth)}.depth`);
        else depths.set(preset.depth, id);
      }
    }
  }

  if (!isObject(data.order)) errors.push('order must be an object');
  else {
    checkKeys(errors, 'order', data.order, KINDS);
    for (const kind of KINDS) {
      const list = data.order[kind];
      if (!Array.isArray(list)) { errors.push(`order.${kind} must be an array`); continue; }
      const expected = Object.keys(kindOf).filter((id) => kindOf[id] === kind);
      for (const id of list) {
        if (expected.includes(id)) continue;
        // An id with no preset here may be one a bundled package supplies (kept out of this file, merged by loadProtocols).
        if (!Object.hasOwn(data.presets ?? {}, id)) {
          firstParty ??= options.firstParty ?? bundledPresetIds(options);
          if ((firstParty as any)[kind].includes(id) || firstParty!.opaque) continue;
        }
        errors.push(`order.${kind} lists '${id}', which is not a ${kind} preset`);
      }
      for (const id of expected) {
        const count = list.filter((entry: any) => entry === id).length;
        if (count === 0) errors.push(`order.${kind} omits preset '${id}'`);
        else if (count > 1) errors.push(`order.${kind} lists preset '${id}' more than once`);
      }
      // 122 IC-014: the authored order is strictest first, so each preset dominates the next one. A pair
      // with an invalid preset or lattice is not compared: its own error is already reported.
      const tiers = coreTiers();
      if (!strengthOk || !tiers) continue;
      for (let i = 0; i + 1 < list.length; i++) {
        const [stricter, looser] = [list[i], list[i + 1]];
        if (kindOf[stricter] !== kind || kindOf[looser] !== kind || !validIds.has(stricter) || !validIds.has(looser)) continue;
        if (!dominates(data.presets[stricter], data.presets[looser], { tiers, synthesizerStrength: strength })) {
          errors.push(`order.${kind}: '${stricter}' does not dominate '${looser}'`);
        }
      }
    }
  }

  if (!Array.isArray(data.invariants) || data.invariants.length === 0) {
    errors.push('invariants must be a non-empty array');
  } else {
    const seen = new Set<string>();
    data.invariants.forEach((inv: any, i: number) => {
      const where = `invariants[${i}]`;
      if (!isObject(inv)) { errors.push(`${where} must be an object`); return; }
      checkKeys(errors, where, inv, INVARIANT_KEYS);
      if (typeof inv.id !== 'string' || !INVARIANT_ID.test(inv.id)) errors.push(`${where}.id must match ${INVARIANT_ID}`);
      else if (seen.has(inv.id)) errors.push(`invariant id '${inv.id}' is duplicated`);
      else seen.add(inv.id);
      if (!isNonEmptyString(inv.statement)) errors.push(`${where}.statement must be a non-empty string`);
      if (!isNonEmptyString(inv.enforcedBy)) errors.push(`${where}.enforcedBy must be a non-empty string`);
      if (Object.hasOwn(inv, 'kinds')) { // the protocol kinds the invariant applies to; absent = ['review']
        if (!Array.isArray(inv.kinds) || inv.kinds.length === 0) errors.push(`${where}.kinds must be a non-empty list of ${KINDS.join(', ')}`);
        else {
          for (const kind of inv.kinds) if (!KINDS.includes(kind)) errors.push(`${where}.kinds has unknown kind '${kind}'`);
          for (const kind of new Set(inv.kinds)) {
            if (inv.kinds.filter((k: any) => k === kind).length > 1) errors.push(`${where}.kinds lists '${kind}' more than once`);
          }
        }
      }
      if (Object.hasOwn(inv, 'authorKinds')) {
        const VALID_AUTHOR_KINDS = ['record', 'subagent', 'sequential', 'primary'];
        if (!Array.isArray(inv.authorKinds) || inv.authorKinds.length === 0) {
          errors.push(`${where}.authorKinds must be a non-empty list of ${VALID_AUTHOR_KINDS.join(', ')}`);
        } else {
          for (const kind of inv.authorKinds) {
            if (!VALID_AUTHOR_KINDS.includes(kind)) errors.push(`${where}.authorKinds has unknown kind '${kind}'`);
          }
          for (const kind of new Set(inv.authorKinds)) {
            if (inv.authorKinds.filter((k: any) => k === kind).length > 1) {
              errors.push(`${where}.authorKinds lists '${kind}' more than once`);
            }
          }
          if (!inv.authorKinds.includes('subagent')) {
            errors.push(`${where}.authorKinds must contain 'subagent'`);
          }
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Keys that appear twice in one object of `text` (JSON.parse keeps only the last, so a parsed
 * object cannot show it). A single pass over the text: a stack of per-object key sets.
 */
function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  const stack: Array<{ obj: boolean; keys: Set<string>; last: string | null }> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') stack.push({ obj: ch === '{', keys: new Set(), last: null });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (top && top.obj && text[next] === ':') {
        const key = JSON.parse(text.slice(i, end + 1));
        if (top.keys.has(key)) found.push(`duplicate key '${key}' in ${stack.map((e) => e.last ?? '[]').slice(0, -1).join('.') || 'registry'}`);
        top.keys.add(key);
        top.last = key;
      }
      i = end;
    }
  }
  return found;
}

/** The core registry file alone: `core/registry/protocols.json` (or `file`) read, held to no duplicate key and `validateProtocols`. */
function loadCoreProtocols({ repoRoot = REPO_ROOT, file, fsImpl = fs }: any = {}): { ok: boolean; registry?: any; errors: string[] } {
  const target = file || path.join(path.resolve(repoRoot), PROTOCOLS_FILE);
  let text: string;
  let registry: any;
  try {
    text = fsImpl.readFileSync(target, 'utf8');
    registry = JSON.parse(text);
  } catch (error: any) {
    return { ok: false, errors: [`${target}: ${error.message}`] };
  }
  const errors = [...duplicateKeys(text), ...validateProtocols(registry, { repoRoot, fsImpl }).errors];
  return errors.length === 0 ? { ok: true, registry, errors } : { ok: false, errors };
}

const CONTRIBUTION_POINT: Record<string, string> = { review: 'review-preset', debate: 'debate-preset' };

/**
 * The effective registry (122 IC-013, IC-014): the core file plus the presets of every active package, with
 * `provenance` (`{ [presetId]: { package, contentDigest } }`, contributed presets only) and `notices`. A
 * contributed id the core `order` names joins the validated registry, so dominance is checked on the merged order;
 * any other contributed id is added to `presets` after validation and never to `order`. An `order` id whose
 * package is not active is skipped from the effective order and noticed (FR-009), never a validation error.
 */
function loadProtocols(options: any = {}): { ok: boolean; registry?: any; errors: string[]; provenance?: Record<string, any>; notices?: string[] } {
  const { repoRoot = REPO_ROOT, fsImpl = fs } = options;
  const core = loadCoreProtocols(options);
  if (!core.ok) return core;
  const { contributionsFor } = require('../packages/contributions.ts');
  const registry: any = { ...core.registry, presets: { ...core.registry.presets }, order: { ...core.registry.order } };
  const provenance: Record<string, any> = {};
  const notices: string[] = [];
  const extra: Record<string, any> = {};
  for (const kind of KINDS) {
    const problems: string[] = [];
    const contributed = contributionsFor(CONTRIBUTION_POINT[kind], 1, { repoRoot, fsImpl, protocols: core.registry, problems });
    notices.push(...problems);
    for (const item of contributed) {
      if (Object.hasOwn(registry.presets, item.qualifiedId) || Object.hasOwn(extra, item.qualifiedId)) {
        notices.push(`${kind} preset '${item.qualifiedId}' from package ${item.packageId} is skipped: the id is already taken`);
        continue;
      }
      provenance[item.qualifiedId] = { package: item.packageId, contentDigest: item.provenance.contentDigest };
      if (registry.order[kind].includes(item.qualifiedId)) registry.presets[item.qualifiedId] = item.data;
      else extra[item.qualifiedId] = item.data;
    }
    const effective = registry.order[kind].filter((id: string) => Object.hasOwn(registry.presets, id));
    for (const id of registry.order[kind]) {
      if (!effective.includes(id)) notices.push(`order.${kind} names '${id}', which no active package provides; it is skipped from the effective order`);
    }
    registry.order[kind] = effective;
  }
  const errors = validateProtocols(registry, { repoRoot, fsImpl }).errors;
  if (errors.length > 0) return { ok: false, errors };
  Object.assign(registry.presets, extra);
  return { ok: true, registry, errors: [], provenance, notices };
}

/** Preset ids of one kind, strictest first (the registry's own `order`). */
function presetIds(registry: any, kind: string): string[] {
  return [...(registry.order?.[kind] ?? [])];
}

/** Presets of one kind that `order` does not name: the contributed ones that are selectable by name only. A first-party id the core `order` names counts as core, not contributed. */
function contributedPresetIds(registry: any, kind: string): string[] {
  const ordered = new Set<string>(registry.order?.[kind] ?? []);
  return Object.keys(registry.presets ?? {}).filter((id) => registry.presets[id]?.kind === kind && !ordered.has(id)).sort();
}

function lensIds(registry: any): string[] {
  return (registry.lenses ?? []).map((lens: any) => lens.id);
}

module.exports = { loadProtocols, loadCoreProtocols, validateProtocols, validatePreset, duplicateKeys, coreTiers, presetIds, contributedPresetIds, lensIds, PROTOCOLS_FILE };
