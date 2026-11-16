'use strict';

// 169 IC-001..IC-003: the binding of a tier slot to a model, and the pure functions over it. A slot holds a plain model
// id or `{model, provider?, effort?}`; `choiceOf` is the one reader, `composeModelPart` turns a choice into the argv a
// harness takes (data from the descriptor's `provider` and `effort` entries, never a harness id), and `matchListed`,
// `modelCheck` and `effortCheck` judge a choice against the models a harness listed. No I/O, no settings, no catalogue
// read: the caller passes the catalogue entry.
//
// Ceiling, accepted: with several matched entries under several providers (the choice names none), `effortCheck`
// answers `listed` or `not-offered` only when every match agrees, and `unchecked` otherwise.

const { PROVIDER_RE, EFFORT_RE } = require('../../registry/model-parts.ts');

/** The composed model id is at most this many characters (a 120-character id, a 64-character provider, a 32-character effort, two separators fit). */
const COMPOSED_ID_MAX = 220;
const MODEL_PLACEHOLDER = '{model}';
const PROVIDER_PLACEHOLDER = '{provider}';
const EFFORT_PLACEHOLDER = '{effort}';

type ModelChoice = { model: string; provider: string | null; effort: string | null };
type Check = 'listed' | 'several-providers' | 'not-listed' | 'unchecked';
type EffortCheck = null | 'listed' | 'not-offered' | 'unchecked';

/** `LaunchUsageError` lives in launch.ts, which requires this module's callers; load it only on the throwing path (no require cycle). */
function usageError(reason: 'model-part-unsupported' | 'model-part-invalid', message: string): Error {
  const { LaunchUsageError } = require('./launch.ts');
  return new LaunchUsageError(reason, message);
}

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** IC-001: a settings slot (a string, or a plain object with a string `model`) as a choice; absent parts are null; anything else is null. */
function choiceOf(value: unknown): ModelChoice | null {
  if (typeof value === 'string') return value === '' ? null : { model: value, provider: null, effort: null };
  if (!isPlain(value) || typeof value.model !== 'string' || value.model === '') return null;
  const part = (field: unknown): string | null | undefined => (field === undefined || field === null ? null : typeof field === 'string' ? field : undefined);
  const provider = part(value.provider);
  const effort = part(value.effort);
  if (provider === undefined || effort === undefined) return null;
  return { model: value.model, provider, effort };
}

/** Replaces every `from` in `text` with `to` (a plain split/join, so a `$` in a value is never a replacement pattern). */
const fill = (text: string, from: string, to: string): string => text.split(from).join(to);

/**
 * IC-002: the argv for the model part of a launch and the flags it owns. `worker` is a descriptor `worker` block, `choice` a
 * ModelChoice. `strip` lists the transport flags the model part added, so the assembler can drop a fixed copy from the
 * other pieces. Throws LaunchUsageError `model-part-unsupported` (a part is given and its entry is not `supported`, or
 * the model is not) or `model-part-invalid` (a value outside its pattern, an effort outside a closed levels list, or a
 * composed id over 220 characters). `shape: true` composes with the placeholders {model}, {provider}, {effort} instead of the
 * values (the stored `argvShape`) and checks only that each given part is supported.
 */
function composeModelPart(worker: any, choice: ModelChoice, { shape = false }: { shape?: boolean } = {}): { argv: string[]; strip: string[] } {
  if (worker?.model?.status !== 'supported' || !Array.isArray(worker.model.argv)) {
    throw usageError('model-part-unsupported', 'the harness does not take a model argument');
  }
  const unsupported = (part: string) => usageError('model-part-unsupported', `the harness does not take a ${part} (its ${part} capability is not supported)`);
  const invalid = (part: string, why: string) => usageError('model-part-invalid', `the ${part} ${why}`);
  const model = shape ? MODEL_PLACEHOLDER : choice.model;
  if (!shape && (typeof model !== 'string' || model === '')) throw invalid('model', 'must be a non-empty string');
  let id = model;
  const extra: string[] = [];
  const strip: string[] = [];

  if (choice.provider !== null) {
    const entry = worker.provider;
    if (entry?.status !== 'supported') throw unsupported('provider');
    const provider = shape ? PROVIDER_PLACEHOLDER : choice.provider;
    if (!shape && !PROVIDER_RE.test(provider)) throw invalid('provider', 'must start with a letter or digit and use only letters, digits, . _ - (at most 64 characters)');
    if (entry.via === 'id-prefix') id = provider + entry.separator + id;
    else { extra.push(entry.argv[0], fill(entry.argv[1], PROVIDER_PLACEHOLDER, provider)); strip.push(entry.argv[0]); }
  }
  if (choice.effort !== null) {
    const entry = worker.effort;
    if (entry?.status !== 'supported') throw unsupported('effort');
    const effort = shape ? EFFORT_PLACEHOLDER : choice.effort;
    if (!shape) {
      if (!EFFORT_RE.test(effort)) throw invalid('effort', 'must start with a letter or digit and use only letters, digits, . _ - (at most 32 characters)');
      if (Array.isArray(entry.levels) && !entry.levels.includes(effort)) throw invalid('effort', `must be one of: ${entry.levels.join(', ')}`);
    }
    if (entry.via === 'id-suffix') id = id + entry.separator + effort;
    else { extra.push(entry.argv[0], fill(entry.argv[1], EFFORT_PLACEHOLDER, effort)); strip.push(entry.argv[0]); }
  }
  if (!shape && id.length > COMPOSED_ID_MAX) throw invalid('model id', `is ${id.length} characters once composed; the limit is ${COMPOSED_ID_MAX}`);
  return { argv: [...worker.model.argv.map((item: string) => fill(item, MODEL_PLACEHOLDER, id)), ...extra], strip };
}

/**
 * The models a harness listed, from one catalogue entry `{offeredModels, modelList}` (null or undefined for none): the
 * offered list when it is non-empty (a kept stale list counts), else null (`none-recorded`, no entry, a failed listing
 * with nothing kept, an empty listing).
 */
function listedOf(entry: any): any[] | null {
  return Array.isArray(entry?.offeredModels) && entry.offeredModels.length > 0 ? entry.offeredModels : null;
}

/**
 * IC-003: the offered entries (OfferedModel[]) a choice matches. With a provider: same id and provider. Without: the same
 * id, or `provider + separator + id` equal to the model when the descriptor's provider is `id-prefix`.
 */
function matchListed(entries: any[], choice: ModelChoice, worker: any): any[] {
  const prefix = worker?.provider?.status === 'supported' && worker.provider.via === 'id-prefix' ? worker.provider.separator : null;
  return entries.filter((m: any) => {
    if (choice.provider !== null) return m.id === choice.model && m.provider === choice.provider;
    if (m.id === choice.model) return true;
    return prefix !== null && typeof m.provider === 'string' && m.provider + prefix + m.id === choice.model;
  });
}

/**
 * IC-003 model check of a choice against one catalogue entry (`{offeredModels, modelList}`, or null): `unchecked` with no
 * list, `not-listed` when none matches, `several-providers` when matches under two or more providers and the choice names
 * none, else `listed`.
 */
function modelCheck(entry: any, choice: ModelChoice, worker: any): Check {
  const list = listedOf(entry);
  if (list === null) return 'unchecked';
  const matches = matchListed(list, choice, worker);
  if (matches.length === 0) return 'not-listed';
  if (choice.provider === null && new Set(matches.map((m: any) => m.provider ?? null)).size > 1) return 'several-providers';
  return 'listed';
}

/** One matched model's verdict on an effort; `offLevel` is the descriptor's level that switches reasoning off. */
function effortOf(model: any, effort: string, offLevel: unknown): 'listed' | 'not-offered' | 'unchecked' {
  const levels = Array.isArray(model.effortLevels) ? model.effortLevels : null;
  if (levels !== null && !levels.includes(effort)) return 'not-offered';
  if (model.reasoning === false && effort !== offLevel) return 'not-offered';
  return levels !== null ? 'listed' : 'unchecked';
}

/**
 * IC-003 effort check of a choice against one catalogue entry: null with no effort bound; `not-offered` when the matched
 * model's `effortLevels` lack it, or it has `reasoning: false` and the effort is not the descriptor's `offLevel`; `listed`
 * when its `effortLevels` hold it; `unchecked` otherwise, including no list and no match (D5).
 */
function effortCheck(entry: any, choice: ModelChoice, worker: any): EffortCheck {
  if (choice.effort === null) return null;
  const list = listedOf(entry);
  if (list === null) return 'unchecked';
  const matches = matchListed(list, choice, worker);
  const verdicts = new Set(matches.map((m: any) => effortOf(m, choice.effort as string, worker?.effort?.offLevel)));
  return verdicts.size === 1 ? [...verdicts][0] : 'unchecked';
}

module.exports = { COMPOSED_ID_MAX, choiceOf, composeModelPart, listedOf, matchListed, modelCheck, effortCheck };
