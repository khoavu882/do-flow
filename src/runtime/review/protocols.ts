'use strict';

// 119 IC-001: the review/debate protocol registry (core/registry/protocols.json) and its validator.
// Presets are data behind `validateProtocols`, a pure function over a parsed object, so a package
// could contribute presets later without a second validator. Read from the runtime install root
// (REPO_ROOT), never from a project tree. Content errors are returned, never thrown.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { dominates } = require('./dominance.ts');

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
const INVARIANT_KEYS = ['id', 'statement', 'enforcedBy', 'kinds'];

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
 * lens catalogue), `hardRoundCap` and `tiers` (default: the core tiers of models.json). Package-mode
 * rules (`context.mode`) belong to their callers. Cross-preset rules (unique depth, `order`) stay in
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
  if (preset.kind === 'review') {
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
      if (!isNonEmptyString(seat.agent)) errors.push(`${sw}.agent must be a non-empty string`);
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

function validateProtocols(data: any): { ok: boolean; errors: string[] } {
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
      for (const id of list) if (!expected.includes(id)) errors.push(`order.${kind} lists '${id}', which is not a ${kind} preset`);
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

function loadProtocols({ repoRoot = REPO_ROOT, file, fsImpl = fs }: any = {}): { ok: boolean; registry?: any; errors: string[] } {
  const target = file || path.join(path.resolve(repoRoot), PROTOCOLS_FILE);
  let text: string;
  let registry: any;
  try {
    text = fsImpl.readFileSync(target, 'utf8');
    registry = JSON.parse(text);
  } catch (error: any) {
    return { ok: false, errors: [`${target}: ${error.message}`] };
  }
  const errors = [...duplicateKeys(text), ...validateProtocols(registry).errors];
  return errors.length === 0 ? { ok: true, registry, errors } : { ok: false, errors };
}

/** Preset ids of one kind, strictest first (the registry's own `order`). */
function presetIds(registry: any, kind: string): string[] {
  return [...(registry.order?.[kind] ?? [])];
}

function lensIds(registry: any): string[] {
  return (registry.lenses ?? []).map((lens: any) => lens.id);
}

module.exports = { loadProtocols, validateProtocols, validatePreset, presetIds, lensIds, PROTOCOLS_FILE };
