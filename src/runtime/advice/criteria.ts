'use strict';

// Rerank criteria in force (141 IC-002, DEC-037). The `advice.criteria.rerank` setting is one string of 5 or 6 lines:
// lines 1 to 5 are the ladder criteria for levels 0 to 4, and line 6, when present, replaces the choice-arm
// instruction. This module owns the bounds, because a settings string has no line or byte rule of its own.
//
// An invalid value never throws and never blocks a command: the registry text stays in force and the result carries a
// warning naming the first rule that failed. The digest is over the texts in force, so a registry edit changes it too.
// Only the digest is ever recorded; the texts are never stored (NFR-003).

const crypto = require('node:crypto');

const SETTING_KEY = 'advice.criteria.rerank';
const LADDER_LEVELS = 5;
const DEFAULT_CRITERIA_BYTES = 1536;

// IC-001's registry text, the same as the `rerank` kind of core/registry/advice.json (test/runtime/advice-criteria.test.ts
// keeps the two equal). A caller that has the kind passes it as `kind` (or the registry as `adviceRegistry`) and the
// kind's own text and `params.criteriaBytes` apply; these values are the fallback when it has not.
const DEFAULT_REGISTRY = Object.freeze({
  ladder: Object.freeze([
    'The candidate is unrelated to the query.',
    'The candidate shares the topic but does not help answer the query.',
    'The candidate answers part of the query or only one aspect of it.',
    'The candidate answers the query but leaves out detail or needs other passages.',
    'The candidate answers the query fully on its own.',
  ]),
  choiceInstruction: 'Select the candidate that best answers the query.',
});

// Every C0 control character except newline, the delete character and the C1 range (a CR is refused too), plus what
// can hide or reorder text in a prompt a person reads: the line and paragraph separators U+2028 and U+2029, the
// bidirectional controls U+202A-U+202E and U+2066-U+2069 (also U+200E, U+200F, U+061C), and the zero-width characters
// U+200B-U+200D, U+2060 and U+FEFF.
const CONTROL_CHARACTER = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

interface RerankCriteria {
  ladder: string[];
  choiceInstruction: string;
  digest: string;
  source: 'registry' | 'settings';
  warning: string | null;
}

function registryUsable(registry: any): boolean {
  return !!registry && Array.isArray(registry.ladder) && registry.ladder.length === LADDER_LEVELS
    && registry.ladder.every((line: any) => typeof line === 'string' && line.trim() !== '')
    && typeof registry.choiceInstruction === 'string' && registry.choiceInstruction.trim() !== '';
}

/** First 12 hex characters of sha256 over the canonical JSON of the texts in force (IC-002). */
function criteriaDigest(ladder: string[], choiceInstruction: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ladder, choice: choiceInstruction }), 'utf8').digest('hex').slice(0, 12);
}

function inForce(ladder: string[], choiceInstruction: string, source: 'registry' | 'settings', warning: string | null): RerankCriteria {
  return { ladder: ladder.slice(), choiceInstruction, digest: criteriaDigest(ladder, choiceInstruction), source, warning };
}

/** The lines of a valid value (trimmed), or the first rule it fails. */
function checkValue(value: any, maxBytes: number): { lines: string[] } | { failure: string } {
  if (typeof value !== 'string') return { failure: 'is not a string' };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) return { failure: `is ${bytes} bytes, over the ${maxBytes}-byte limit` };
  if (CONTROL_CHARACTER.test(value)) return { failure: 'has a control character other than newline, a line or paragraph separator, a bidirectional control or a zero-width character' };
  const lines = value.split('\n');
  if (lines.length !== LADDER_LEVELS && lines.length !== LADDER_LEVELS + 1) {
    return { failure: `has ${lines.length} lines; expected ${LADDER_LEVELS} or ${LADDER_LEVELS + 1}` };
  }
  const trimmed = lines.map((line) => line.trim());
  const empty = trimmed.findIndex((line) => line === '');
  if (empty !== -1) return { failure: `has an empty line ${empty + 1}` };
  if (new Set(trimmed.slice(0, LADDER_LEVELS)).size !== LADDER_LEVELS) return { failure: 'repeats a ladder line (lines 1 to 5 must differ)' };
  return { lines: trimmed };
}

/**
 * Reads the `advice.criteria.rerank` value through the settings view for the project (or the user layer with
 * `global`). An unreadable settings layer or an invalid value yields `value: null` and a warning, never a throw.
 */
function readCriteriaSetting({ projectRoot = null, global = false, env = process.env, fsImpl }: any = {}): { value: any; warning: string | null } {
  try {
    const { loadSettings, registryOn } = require('../settings/resolve.ts');
    const options: any = { projectRoot, global, env };
    if (fsImpl) Object.assign(options, { fsImpl }, registryOn(fsImpl));
    const entry = loadSettings(options).get(SETTING_KEY, global ? 'global' : 'project');
    const invalid = (entry.candidates || []).find((candidate: any) => candidate.status === 'invalid');
    if (entry.state !== 'ok' || invalid) {
      const reason = invalid ? `${invalid.source}: ${invalid.reason}` : 'the settings value is invalid';
      return { value: null, warning: `${SETTING_KEY} ignored (${reason}); the registry text is in force` };
    }
    return { value: entry.value ?? null, warning: null };
  } catch (error: any) {
    return { value: null, warning: `${SETTING_KEY} ignored (settings could not be read: ${error?.message || 'unknown error'}); the registry text is in force` };
  }
}

/** The registry's defaults from the `rerank` kind entry: its ladder, its choice instruction and its `params`. */
function kindDefaults(kind: any): { registry: any; params: any } | null {
  if (!kind || typeof kind !== 'object') return null;
  return { registry: { ladder: kind.scoreLadder?.criteria, choiceInstruction: kind.instructions }, params: kind.params };
}

/**
 * The criteria in force. `value` is the setting's string; when it is `undefined` the setting is read with
 * `projectRoot`, `global`, `env` and `fsImpl`. The registry text and the byte cap come from, in order: an explicit
 * `registry` (`{ ladder: string[5], choiceInstruction }`) and `params` (`criteriaBytes`); the `rerank` kind entry given
 * as `kind` or found in `adviceRegistry`; IC-001's values.
 */
function resolveRerankCriteria({ value, registry: givenRegistry, params: givenParams, kind: givenKind, adviceRegistry, projectRoot, global, env, fsImpl }: any = {}): RerankCriteria {
  const fromKind = kindDefaults(givenKind ?? (Array.isArray(adviceRegistry?.kinds) ? adviceRegistry.kinds.find((entry: any) => entry?.id === 'rerank') : null));
  const registry = givenRegistry ?? fromKind?.registry;
  const params = givenParams ?? fromKind?.params;
  const base = registryUsable(registry) ? registry : DEFAULT_REGISTRY;
  const maxBytes = Number.isInteger(params?.criteriaBytes) && params.criteriaBytes > 0 ? params.criteriaBytes : DEFAULT_CRITERIA_BYTES;
  const fallback = (warning: string | null) => inForce(base.ladder, base.choiceInstruction, 'registry', warning);

  let raw = value;
  if (raw === undefined) {
    const read = readCriteriaSetting({ projectRoot, global, env, fsImpl });
    if (read.warning) return fallback(read.warning);
    raw = read.value;
  }
  if (raw === null || raw === undefined) return fallback(null);

  const checked = checkValue(raw, maxBytes);
  if ('failure' in checked) return fallback(`${SETTING_KEY} ${checked.failure}; the registry text is in force`);
  const ladder = checked.lines.slice(0, LADDER_LEVELS);
  const choiceInstruction = checked.lines.length > LADDER_LEVELS ? checked.lines[LADDER_LEVELS] : base.choiceInstruction;
  return inForce(ladder, choiceInstruction, 'settings', null);
}

module.exports = { resolveRerankCriteria, readCriteriaSetting, DEFAULT_REGISTRY, DEFAULT_CRITERIA_BYTES, SETTING_KEY };
