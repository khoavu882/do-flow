'use strict';

// `doflow advise --action report` (141 IC-008, common figures; 175 IC-010). Read-only: no model or network call, no
// write. The records hold no user text (only digests, picks and counts), so nothing user-written reaches the output.
// Every figure carries its n. Lines written before the dispatcher existed lack `mode` and `elevated`; they stay readable
// and count as `unrecorded`.
//
// Per kind it adds what the person did with the picks they were shown (the `followed` label of an outcome line) and
// "agreement with what you did": the replay figures (replay/score.ts) over picks whose label is known, never a standing.
// "Local results" lists this machine's stored replay results for the kinds shown, each re-judged against the current
// question, builder and bars (replay/trust.ts `rejudge`), and, for a result measured in this project, whether the case
// set has changed since. The model build is not checked here: that needs the provider's listing, a network call.

const fs = require('node:fs');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { readWindow, wasShown, FOLLOWED } = require('./record.ts');
const { isRetiredOutcome } = require('./retired.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { materializeKind } = require('./kinds.ts');
const { score } = require('./replay/score.ts');
const { effectiveBars } = require('./replay/bars.ts');
const { getSource, buildCases, optionNames } = require('./replay/sources/index.ts');
const { readResults } = require('./replay/results.ts');
const { rejudge, questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('./replay/trust.ts');

const SCHEMA = 1;
const MAX_AGE_DAYS = 90;
const SCOPE = 'this project only';
const FOOTER = 'Records are from this project only; every figure shows its n.';
// `-g` reads the user-level folder only, so its header, `scope` and footer say that instead of "this project".
const GLOBAL_SCOPE = 'user-level store';
const GLOBAL_FOOTER = 'Records are from the user-level store only; every figure shows its n.';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Nearest-rank percentile over a sorted ascending array; null when empty. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function summarize(values: number[]): { n: number; p50: number | null; p90: number | null; p95: number | null } {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return { n: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9), p95: nearestRank(sorted, 0.95) };
}

function kindFigures(picks: any[], misses: any[], outcomes: Map<string, any>, agreement: any): any {
  if (picks.length === 0 && misses.length === 0) {
    return { n: { picks: 0, misses: 0 }, missesByReason: {}, agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null, followed: null, agreement: null };
  }
  const missesByReason: Record<string, number> = {};
  for (const miss of misses) {
    const reason = typeof miss.reason === 'string' && miss.reason ? miss.reason : 'unknown';
    missesByReason[reason] = (missesByReason[reason] || 0) + 1;
  }
  const withStatic = picks.filter((p) => typeof p.static === 'string');
  const withOutcome = picks.filter((p) => typeof p.pickId === 'string' && typeof outcomes.get(p.pickId)?.actual === 'string');
  const modes = { shadow: 0, show: 0, act: 0, unrecorded: 0 };
  for (const pick of picks) {
    if (pick.mode === 'shadow' || pick.mode === 'show' || pick.mode === 'act') modes[pick.mode as 'shadow' | 'show' | 'act'] += 1;
    else modes.unrecorded += 1;
  }
  const followed = { n: 0, followed: 0, partly: 0, overruled: 0 };
  for (const pick of picks.filter(wasShown)) {
    followed.n += 1;
    const label = outcomes.get(pick.pickId)?.followed;
    if (label) followed[label as 'followed' | 'partly' | 'overruled'] += 1;
  }
  return {
    n: { picks: picks.length, misses: misses.length },
    missesByReason,
    agreeStatic: { n: withStatic.length, agree: withStatic.filter((p) => p.pick === p.static).length },
    agreeOutcome: { n: withOutcome.length, agree: withOutcome.filter((p) => outcomes.get(p.pickId).actual === p.pick).length },
    elevated: picks.filter((p) => p.elevated === true).length,
    modes,
    durationMs: summarize(picks.map((p) => p.durationMs)),
    missDurationMs: summarize(misses.map((m) => m.durationMs)),
    followed: followed.n === 0 ? null : followed,
    agreement,
  };
}

/**
 * What the person did, as an option of the pick, or why it is only counted (175 IC-010): `actual` when recorded; else,
 * for a shown pick, `followed` is the pick itself and `overruled` on a yes/no pick is the other answer. `partly`, and an
 * overruled choice pick with no `actual`, say what happened without naming the option, so they are counted, not scored.
 */
function knownLabel(pick: any, outcome: any): { label: string } | { counted: 'partly' | 'overruledWithoutActual' } | null {
  if (!outcome) return null;
  if (typeof outcome.actual === 'string') return { label: outcome.actual };
  if (!wasShown(pick) || !outcome.followed) return null;
  if (outcome.followed === 'followed' && typeof pick.pick === 'string') return { label: pick.pick };
  if (outcome.followed === 'partly') return { counted: 'partly' };
  const other = pick.qtype === 'yesno' ? ({ yes: 'no', no: 'yes' } as Record<string, string>)[pick.pick] : undefined;
  return other ? { label: other } : { counted: 'overruledWithoutActual' };
}

/**
 * "Agreement with what you did" for one kind: the replay figures of design section 5 over the picks whose label is known,
 * the static answer as the rule and the recorded pick as the model's answer, with the fixed bootstrap statistics of the
 * kind's effective bars (the package bars when the user's override cannot be read). Figures only: never judged against a
 * bar, so it never yields a standing. A labelled pick with no static answer has no rule to compare, so it is counted.
 */
function agreementFigures(picks: any[], outcomes: Map<string, any>, { registry, kind, roots, fsImpl }: any): any {
  const counted = { partly: 0, overruledWithoutActual: 0, noStaticAnswer: 0 };
  const cases: any[] = [];
  const options = new Set<string>();
  for (const pick of picks) {
    const known = knownLabel(pick, typeof pick.pickId === 'string' ? outcomes.get(pick.pickId) : null);
    if (!known) continue;
    if ('counted' in known) { counted[known.counted] += 1; continue; }
    if (typeof pick.static !== 'string') { counted.noStaticAnswer += 1; continue; }
    for (const option of Array.isArray(pick.options) ? pick.options : []) if (typeof option === 'string') options.add(option);
    cases.push({
      label: known.label, rule: pick.static, model: typeof pick.pick === 'string' ? pick.pick : null,
      strength: pick.strength, latencyMs: Number.isFinite(pick.durationMs) && pick.durationMs >= 0 ? pick.durationMs : 0,
    });
  }
  if (cases.length === 0 && Object.values(counted).every((count) => count === 0)) return null;
  const registryKind = (registry?.kinds || []).find((entry: any) => entry?.id === kind);
  const read = registry ? effectiveBars({ registry, kind, roots, fsImpl }) : null;
  const bars = read?.ok ? read.bars : registry?.bars;
  let figures: any = null;
  if (cases.length > 0 && bars?.statistics) {
    const budgetMs = Number.isFinite(registryKind?.budgetMs) ? registryKind.budgetMs : Infinity;
    const { worseIds, perClass, labelCounts, ...rest } = score(cases, { options: options.size ? [...options] : null, bars, budgetMs });
    figures = rest;
  }
  return { n: cases.length, counted, figures };
}

const NOT_CHECKED_NOTE = 'The model build is not checked here: that needs a network call, and the report makes none. Each decision checks it.';

const LOCAL_RESULTS_SCOPE = 'Local results hold entries from every project on this machine, not only this one; each line is labelled with its model, run date and case-set state.';

/** The moved digests of a stored entry, in the order question, builder, bars. */
function movedDigests(entry: any, { question, source, registryKind, bars }: any): string[] {
  const current: Array<[string, string]> = [
    ['question', questionDigest(question)],
    ['builder', builderDigest(source, registryKind)],
    ['bars', barsDigest(bars, registryKind?.budgetMs)],
  ];
  return current.filter(([name, digest]) => entry[`${name}Digest`] !== digest).map(([name]) => name);
}

/**
 * Whether the cases a result was measured on are still the cases of this project: `same` or `changed` when the entry's
 * project key is this project's, `other-project` when it is another's, `not-checked` with no project or no source.
 */
function caseSetState(entry: any, { projectRoot, roots, registryKind, fsImpl, keyOfHere, options }: any): string {
  if (!projectRoot) return 'not-checked';
  if (entry.caseSet.projectKey !== keyOfHere) return 'other-project';
  const source = getSource(entry.caseSet.source);
  if (!source) return 'not-checked';
  try {
    const built = buildCases(source, { projectRoot, roots, kind: registryKind, fsImpl }, options);
    return caseSetDigest(built.cases) === entry.caseSet.digest ? 'same' : 'changed';
  } catch { return 'not-checked'; }
}

/** This machine's stored results for the kinds shown, each re-judged now; no network call, nothing written. */
function localResults({ roots, registry, sources, shown, projectRoot, fsImpl }: any): any[] {
  const keyOfHere = projectRoot ? projectKey(projectRoot, fsImpl) : null;
  const entries = readResults({ roots, fsImpl })
    .filter((entry: any) => shown.has(entry.kind))
    .sort((a: any, b: any) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.modelDigest < b.modelDigest ? -1 : a.modelDigest > b.modelDigest ? 1 : 0));
  return entries.map((entry: any) => {
    const registryKind = (registry?.kinds || []).find((kind: any) => kind?.id === entry.kind) ?? null;
    const built = registry ? materializeKind(entry.kind, { adviceRegistry: registry, sources }) : { ok: false, detail: 'the advice registry cannot be read' };
    const row: any = {
      kind: entry.kind, provider: entry.provider, model: entry.model, modelDigest: entry.modelDigest, runAt: entry.runAt,
      replayed: entry.caseSet.replayed, eligible: entry.caseSet.eligible,
      standing: 'unknown', reason: '', failedChecks: [], stale: [],
      caseSet: caseSetState(entry, { projectRoot, roots, registryKind, fsImpl, keyOfHere, options: built.ok ? optionNames(built.question) : null }),
    };
    if (!built.ok) return { ...row, reason: `the question cannot be built: ${built.detail}` };
    const bars = effectiveBars({ registry, kind: entry.kind, roots, fsImpl });
    if (!bars.ok) return { ...row, reason: `bars-override-invalid: ${bars.errors[0]}` };
    const judged = rejudge({ entry, kind: entry.kind, registry, question: built.question, bars: bars.bars });
    const stale = movedDigests(entry, { question: built.question, source: getSource(registryKind?.replay?.source), registryKind, bars: bars.bars });
    const named = stale.length > 1 ? `${stale.slice(0, -1).join(', ')} and ${stale[stale.length - 1]}` : stale[0];
    const reason = stale.length ? `the ${named} changed since the replay; replay again` : judged.reason;
    return { ...row, standing: judged.standing, reason, failedChecks: judged.failedChecks, stale };
  });
}

let packageRegistry: any;
/** The installed package's advice registry, read once, when the caller passes none. */
function defaultRegistry(): any {
  if (packageRegistry === undefined) {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    packageRegistry = loaded.ok ? loaded.registry : null;
  }
  return packageRegistry;
}

const RELATIONS = ['supports', 'contradicts'];
const CLAIM_SUPPORT_NOTE = 'A recorded link is an assertion, not ground truth; agreement here is not accuracy.';

/** True when the model called `yes` at a probability of 0.5 or more; a line without a usable probability falls back to its pick. */
function calledYes(pick: any): boolean {
  const p = pick?.probabilities?.yes;
  return typeof p === 'number' && Number.isFinite(p) ? p >= 0.5 : pick?.pick === 'yes';
}

/**
 * The claim-support figures (141 IC-008, DEC-032). A pick is grouped by the relation recorded in its `claimSupport`
 * payload; a pick without a usable payload (an old line) is counted apart and joins no relation. Only the relation word
 * and numbers are read from a line, so no claim or passage text can reach the output.
 */
function claimSupportFigures(picks: any[], misses: any[]): any {
  const missesByReason: Record<string, number> = {};
  for (const miss of misses) {
    const reason = typeof miss.reason === 'string' && miss.reason ? miss.reason : 'unknown';
    missesByReason[reason] = (missesByReason[reason] || 0) + 1;
  }
  const byRelation: Record<string, { n: number; modelYes: number; agree: number }> = {};
  for (const relation of RELATIONS) byRelation[relation] = { n: 0, modelYes: 0, agree: 0 };
  let withoutPayload = 0;
  for (const pick of picks) {
    const relation = pick?.claimSupport?.relation;
    if (!RELATIONS.includes(relation)) { withoutPayload += 1; continue; }
    const figures = byRelation[relation];
    const yes = calledYes(pick);
    figures.n += 1;
    if (yes) figures.modelYes += 1;
    if (yes === (relation === 'supports')) figures.agree += 1;
  }
  const { n, p50, p95 } = summarize(picks.map((p) => p.durationMs));
  return { n: { picks: picks.length, misses: misses.length }, withoutPayload, missesByReason, byRelation, durationMs: { n, p50, p95 } };
}

/**
 * Builds the report object. `kind`, when given, narrows it to one kind. `kinds` lists the kinds to show (registry kinds).
 * `registry` and `sources` default to the installed package's; `projectRoot` (null for `-g`) is the project whose case
 * sets the local results are compared with. Never writes and makes no network call.
 */
function buildReport({
  roots, kinds, kind = null, now = () => new Date(), fsImpl = fs, registry = defaultRegistry(), sources = {},
  projectRoot = null, global = false,
}: any = {}): any {
  const at = new Date(typeof now === 'function' ? now() : now);
  const { records, unreadable } = readWindow({ roots, now: () => at, maxAgeDays: MAX_AGE_DAYS, fsImpl });
  const shown: string[] = kind ? [kind] : [...(kinds || [])];
  const picksBy = new Map<string, any[]>();
  const missesBy = new Map<string, any[]>();
  // Per pick, the latest `actual` and the latest `followed`, each on its own: a later label of one kind keeps the other.
  const outcomes = new Map<string, { actual?: string; actualAt?: string; followed?: string; followedAt?: string }>();
  for (const { record } of records) {
    if (typeof record.kind === 'string' && record.type === 'pick') {
      if (!picksBy.has(record.kind)) picksBy.set(record.kind, []);
      picksBy.get(record.kind)!.push(record);
    } else if (typeof record.kind === 'string' && record.type === 'miss') {
      if (!missesBy.has(record.kind)) missesBy.set(record.kind, []);
      missesBy.get(record.kind)!.push(record);
    } else if (record.type === 'outcome' && typeof record.pickId === 'string' && !isRetiredOutcome(record)) {
      const at = String(record.at);
      const known = outcomes.get(record.pickId) || {};
      if (typeof record.actual === 'string' && (!known.actualAt || at >= known.actualAt)) { known.actual = record.actual; known.actualAt = at; }
      if (FOLLOWED.includes(record.followed) && (!known.followedAt || at >= known.followedAt)) { known.followed = record.followed; known.followedAt = at; }
      outcomes.set(record.pickId, known);
    }
  }
  if (!kind) {
    for (const seen of [...picksBy.keys(), ...missesBy.keys()]) if (!shown.includes(seen)) shown.push(seen);
  }
  const kindsOut: Record<string, any> = {};
  for (const id of shown) {
    const picks = picksBy.get(id) || [];
    const agreement = agreementFigures(picks, outcomes, { registry, kind: id, roots, fsImpl });
    kindsOut[id] = kindFigures(picks, missesBy.get(id) || [], outcomes, agreement);
  }
  const claimSupport = shown.includes('claim-support')
    ? claimSupportFigures(picksBy.get('claim-support') || [], missesBy.get('claim-support') || []) : undefined;
  return {
    schema: SCHEMA,
    scope: global ? GLOBAL_SCOPE : SCOPE,
    window: { from: new Date(at.getTime() - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10), to: at.toISOString().slice(0, 10), maxAgeDays: MAX_AGE_DAYS },
    unreadable,
    kinds: kindsOut,
    ...(claimSupport ? { claimSupport } : {}),
    localResults: localResults({ roots, registry, sources, shown: new Set(shown), projectRoot, fsImpl }),
  };
}

function ratio(part: { n: number; agree: number }): string {
  return part.n === 0 ? 'no data (n=0)' : `${part.agree} of ${part.n} (${Math.round((part.agree / part.n) * 100)}%), n=${part.n}`;
}

function duration(label: string, d: any): string {
  return d.n === 0 ? `  ${label}: no data (n=0)` : `  ${label} (n=${d.n}): p50 ${d.p50}, p90 ${d.p90}, p95 ${d.p95}`;
}

function renderClaimSupport(kindFigs: any, c: any): string[] {
  if (kindFigs.agreeStatic === null) return ['  no data'];
  const reasons = Object.entries(c.missesByReason).map(([reason, count]) => `${reason} ${count}`).join(', ');
  const lines = [`  picks: ${c.n.picks}; misses: ${c.n.misses}${reasons ? ` (${reasons})` : ''}`];
  if (c.withoutPayload > 0) lines.push(`  picks without a claim-support payload: ${c.withoutPayload} of ${c.n.picks}`);
  lines.push('  by recorded relation:');
  for (const relation of RELATIONS) {
    const r = c.byRelation[relation];
    if (r.n === 0) { lines.push(`    ${relation}: no data (n=0)`); continue; }
    const expected = relation === 'supports' ? 'yes' : 'no';
    lines.push(`    ${relation}: picks ${r.n}; model said yes at p>=0.5: ${r.modelYes} of ${r.n}; agrees with the recorded relation (${relation} means ${expected}): ${ratio({ n: r.n, agree: r.agree })}`);
  }
  lines.push(c.durationMs.n === 0 ? '  pick duration ms: no data (n=0)' : `  pick duration ms (n=${c.durationMs.n}): p50 ${c.durationMs.p50}, p95 ${c.durationMs.p95}`);
  lines.push(`  ${CLAIM_SUPPORT_NOTE}`);
  return lines;
}

const two = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : 'n/a');

/** The followed counts and "agreement with what you did" of one kind; nothing when neither has data. */
function renderFollowed(f: any): string[] {
  const lines: string[] = [];
  if (f.followed) {
    lines.push(`  followed (n=${f.followed.n} shown picks): followed ${f.followed.followed}, partly ${f.followed.partly}, overruled ${f.followed.overruled}`);
  }
  const a = f.agreement;
  if (!a) return lines;
  if (!a.figures) lines.push(`  agreement with what you did: no data (n=${a.n})`);
  else {
    const m = a.figures;
    lines.push(`  agreement with what you did (n=${a.n}): model ${two(m.accuracy.model)}, rule ${two(m.accuracy.rule)} accuracy; kappa model ${two(m.kappa.model)} (low ${two(m.kappa.lower)}), rule ${two(m.kappa.rule)}; worse ${m.worse}, better ${m.better}`);
  }
  const c = a.counted;
  if (c.partly + c.overruledWithoutActual + c.noStaticAnswer > 0) {
    lines.push(`    counted, not scored: partly ${c.partly}, overruled without --actual ${c.overruledWithoutActual}, no static answer ${c.noStaticAnswer}`);
  }
  return lines;
}

const CASE_SET_TEXT: Record<string, string> = {
  same: 'case set same',
  changed: 'case set changed: replay again',
  'other-project': 'measured in another project',
  'not-checked': 'case set not checked here',
};

function renderLocalResult(r: any): string {
  const head = `${r.kind} ${r.model} (provider ${r.provider}, digest ${r.modelDigest.slice(0, 15)}…), run ${r.runAt.slice(0, 10)}`;
  return `${head}: ${r.standing}: ${r.reason}; ${CASE_SET_TEXT[r.caseSet] || r.caseSet}`;
}

function renderText(report: any): string {
  const lines = [
    `Advice report (${report.scope})`,
    `Window: ${report.window.from} to ${report.window.to} (${report.window.maxAgeDays} days)`,
  ];
  if (report.unreadable > 0) lines.push(`Unreadable lines skipped: ${report.unreadable}`);
  for (const [id, f] of Object.entries<any>(report.kinds)) {
    lines.push('', id);
    if (id === 'claim-support' && report.claimSupport) lines.push(...renderClaimSupport(f, report.claimSupport));
    else if (f.agreeStatic === null) { lines.push('  no data'); continue; }
    else {
      const reasons = Object.entries(f.missesByReason).map(([reason, count]) => `${reason} ${count}`).join(', ');
      lines.push(`  picks: ${f.n.picks}; misses: ${f.n.misses}${reasons ? ` (${reasons})` : ''}`);
      lines.push(`  agrees with the static answer: ${ratio(f.agreeStatic)}`);
      lines.push(`  agrees with the recorded outcome: ${ratio(f.agreeOutcome)}`);
      lines.push(`  elevated: ${f.elevated} of ${f.n.picks} picks`);
      lines.push(`  modes (n=${f.n.picks}): shadow ${f.modes.shadow}, show ${f.modes.show}, act ${f.modes.act}, unrecorded ${f.modes.unrecorded}`);
      lines.push(duration('pick duration ms', f.durationMs));
      lines.push(duration('miss duration ms', f.missDurationMs));
    }
    lines.push(...renderFollowed(f));
  }
  lines.push('', 'Local results', `  ${NOT_CHECKED_NOTE}`);
  if (report.localResults.length === 0) lines.push('  none stored for the kinds shown');
  for (const r of report.localResults) lines.push(`  ${renderLocalResult(r)}`);
  lines.push(`  ${LOCAL_RESULTS_SCOPE}`);
  lines.push('', report.scope === GLOBAL_SCOPE ? GLOBAL_FOOTER : FOOTER);
  return lines.join('\n');
}

module.exports = { buildReport, renderText, FOOTER, GLOBAL_FOOTER };
