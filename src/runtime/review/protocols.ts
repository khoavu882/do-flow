'use strict';

// 119 IC-001: the review/debate protocol registry (core/registry/protocols.json) and its validator.
// Presets are data behind `validateProtocols`, a pure function over a parsed object, so a package
// could contribute presets later without a second validator. Read from the runtime install root
// (REPO_ROOT), never from a project tree. Content errors are returned, never thrown.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const PROTOCOLS_FILE = 'core/registry/protocols.json';
const KINDS = ['review', 'debate'];
const FAMILIES = ['any', 'different-from-author'];
const SYNTHESIZERS = ['separate', 'seat', 'none', 'verifier'];
const DECIDERS = ['gate', 'orchestrator'];
const PRESET_ID = /^[a-z][a-z0-9-]*$/;
const INVARIANT_ID = /^INV-\d+$/;

const TOP_KEYS = ['schema', 'description', 'hardRoundCap', 'lenses', 'presets', 'order', 'invariants'];
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

  const kindOf: Record<string, string> = {};
  const depths = new Map<string, string>();
  if (!isObject(data.presets) || Object.keys(data.presets).length === 0) {
    errors.push('presets must be a non-empty object');
  } else {
    for (const [id, preset] of Object.entries<any>(data.presets)) {
      const where = `presets.${id}`;
      if (!PRESET_ID.test(id)) errors.push(`${where} id must match ${PRESET_ID}`);
      if (!isObject(preset)) { errors.push(`${where} must be an object`); continue; }
      checkKeys(errors, where, preset, PRESET_KEYS);

      if (!KINDS.includes(preset.kind)) errors.push(`${where}.kind must be one of ${KINDS.join(', ')}`);
      else kindOf[id] = preset.kind;

      if (preset.kind === 'review') {
        if (!isNonEmptyString(preset.depth)) errors.push(`${where}.depth is required on a review preset`);
        else if (depths.has(preset.depth)) errors.push(`${where}.depth '${preset.depth}' duplicates presets.${depths.get(preset.depth)}.depth`);
        else depths.set(preset.depth, id);
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

module.exports = { loadProtocols, validateProtocols, presetIds, lensIds, PROTOCOLS_FILE };
