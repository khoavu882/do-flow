'use strict';

// The trust evaluator (175 IC-006, FR-012) and the digests a stored replay result is keyed and checked by. Every show or
// act decision asks `evaluateTrust`; the report re-judges stored entries with `rejudge`, which makes no network call.
//
// The evaluator reads two places only: the result store under `roots['user-state']` and the user's bars override under
// `roots['config-home']` (through `effectiveBars`). The deciding project's root is only hashed into the project key, never
// read below, so a file planted in a project cannot certify anything. Order (design section 8): no model digest ->
// unknown; a kind with no replay source -> none, before any network call; no model digest from the listing -> unknown; an
// invalid bars override -> unknown; no store or no entry for (project key, kind, model digest) -> none; a question,
// builder or bars digest that moved -> stale, naming the first; then `judge` on the stored numbers against the current
// effective bars. A stored standing does not exist, so nothing stored is ever taken as the answer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { canonicalJson } = require('../../canonical-json.ts');
const { judge } = require('./score.ts');
const { effectiveBars } = require('./bars.ts');
const { getSource } = require('./sources/index.ts');
const { readResults } = require('./results.ts');

type Standing = 'act' | 'show' | 'below-show' | 'below-minimum' | 'measure-only' | 'unknown' | 'stale' | 'none';
type StaleDigest = 'question' | 'builder' | 'bars';

interface Trust {
  standing: Standing;
  reason: string;               // one line, data ids only: what a LOCAL_RESULT_UNMET warning or a report prints
  failedChecks: string[];       // the checks `judge` failed; [] for unknown, none and stale
  staleDigest: StaleDigest | null;
  modelDigest: string | null;   // the build the answer is about, null when it could not be read
}

/** `sha256:<hex>` of the canonical JSON of `value`. */
function digestOf(value: any): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** The materialised question (`kinds.ts materializeKind(...).question`: name, type, instructions, options or yes/no texts). */
function questionDigest(question: any): string {
  return digestOf(question ?? null);
}

/** How the cases were built: the source's id, builder version and own `params` (when it has any) and the kind's params. */
function builderDigest(source: any, kind: any): string {
  const built = { source: source?.id ?? null, builderVersion: source?.builderVersion ?? null, params: kind?.params ?? null };
  return digestOf(source?.params ? { ...built, sourceParams: source.params } : built);
}

/** The effective bars of the kind (`effectiveBars(...).bars`) and the kind's `budgetMs`. */
function barsDigest(bars: any, budgetMs: any): string {
  return digestOf({ bars: bars ?? null, budgetMs: budgetMs ?? null });
}

/** Every eligible case, sorted by id, as `[id, sha256 of its state, label, rule]`: the case set, never the text. */
function caseSetDigest(cases: any[]): string {
  const rows = cases
    .map((c: any) => [c.id, `sha256:${crypto.createHash('sha256').update(String(c.state), 'utf8').digest('hex')}`, c.label, c.rule])
    .sort((a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return digestOf(rows);
}

/** `sha256:` of the real path of a project root (a worktree is its own project); the root path as given when it has none. */
function projectKey(projectRoot: string, fsImpl: any = fs): string {
  let real = projectRoot;
  try { real = fsImpl.realpathSync(projectRoot); } catch { /* the path as given */ }
  return `sha256:${crypto.createHash('sha256').update(String(real), 'utf8').digest('hex')}`;
}

const answer = (standing: Standing, reason: string, modelDigest: string | null, extra: Partial<Trust> = {}): Trust =>
  ({ standing, reason, failedChecks: [], staleDigest: null, modelDigest, ...extra });

const JUDGED_REASON: Record<string, string> = {
  'measure-only': 'the source\'s label is the rule\'s answer, so it measures and never certifies',
  'below-minimum': 'too few cases',
  'below-show': 'the show bar is not met',
  show: 'the show bar holds; the act bar does not',
  act: 'the show and act bars hold',
};

/**
 * One stored entry against the current registry, question and effective bars, with no network call: stale with the first
 * digest that moved, else the standing `judge` gives the stored numbers. `bars` is `effectiveBars(...).bars` for the kind.
 */
function rejudge({ entry, kind, registry, question, bars, sourceOf = getSource }:
  { entry: any; kind: string; registry: any; question: any; bars: any; sourceOf?: (id: unknown) => any }): Omit<Trust, 'modelDigest'> {
  const registryKind = (registry?.kinds || []).find((item: any) => item?.id === kind) ?? null;
  const source = sourceOf(registryKind?.replay?.source);
  const budgetMs = registryKind?.budgetMs;
  const checks: [StaleDigest, string][] = [
    ['question', questionDigest(question)],
    ['builder', builderDigest(source, registryKind)],
    ['bars', barsDigest(bars, budgetMs)],
  ];
  for (const [name, current] of checks) {
    if (entry[`${name}Digest`] !== current) {
      return { standing: 'stale', reason: `the ${name} changed since the replay; replay again`, failedChecks: [], staleDigest: name };
    }
  }
  const judged = judge(entry.metrics, bars, budgetMs, source);
  const standing = judged.standing as Standing;
  const failed = judged.failedChecks.length ? ` (${judged.failedChecks.join(', ')})` : '';
  return { standing, reason: `${JUDGED_REASON[standing] || standing}${failed}`, failedChecks: judged.failedChecks, staleDigest: null };
}

/**
 * The standing of `kind` answered by `model` in the project at `projectRoot`. `client.modelDigest` is the one network call
 * (the listing, capped by `timeoutMs` and ended by `signal`), made only for a kind that has a replay source; everything
 * else is two local reads. Never throws.
 */
async function evaluateTrust({
  kind, model, provider, endpoint, question, registry, roots, client, projectRoot, timeoutMs, signal, fsImpl = fs, sourceOf = getSource,
}: {
  kind: string; model: string | null; provider?: string; endpoint?: string; question: any; registry: any; roots: any;
  client: any; projectRoot: string; timeoutMs?: number; signal?: any; fsImpl?: any; sourceOf?: (id: unknown) => any;
}): Promise<Trust> {
  if (typeof model !== 'string' || !model) return answer('unknown', 'model digest unknown: no model is named', null);
  const registryKind = (registry?.kinds || []).find((item: any) => item?.id === kind) ?? null;
  if (!sourceOf(registryKind?.replay?.source)) return answer('none', `kind '${kind}' has no replay source`, null);
  let read: any;
  try { read = await client.modelDigest({ endpoint, model, provider, timeoutMs, signal }); } catch { read = null; }
  const modelDigest = typeof read?.digest === 'string' ? read.digest : null;
  if (modelDigest === null) return answer('unknown', `model digest unknown: ${read?.reason || 'unreachable'}`, null);

  try {
    const bars = effectiveBars({ registry, kind, roots, fsImpl });
    if (!bars.ok) return answer('unknown', `bars-override-invalid: ${bars.errors[0]}`, modelDigest);

    const key = projectKey(projectRoot, fsImpl);
    const entry = readResults({ roots, fsImpl })
      .find((item: any) => item.kind === kind && item.modelDigest === modelDigest && item.caseSet.projectKey === key);
    if (!entry) return answer('none', 'no local result for this project, kind and model build; run a replay with --write', modelDigest);

    return { ...rejudge({ entry, kind, registry, question, bars: bars.bars, sourceOf }), modelDigest };
  } catch (error: any) {
    return answer('unknown', `local result could not be judged: ${error?.message || 'unknown error'}`, modelDigest);
  }
}

module.exports = { evaluateTrust, rejudge, digestOf, questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey };
