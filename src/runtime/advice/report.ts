'use strict';

// `doflow advise --action report` (141 IC-008, common figures). Read-only: no model call, no write. The records hold no
// user text (only digests, picks and counts), so nothing user-written reaches the output. Every figure carries its n.
// Lines written before the dispatcher existed lack `mode` and `elevated`; they stay readable and count as `unrecorded`.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { readWindow } = require('./record.ts');
const { evaluateBenchBar } = require('./bench-gate.ts');
const { resolveRerankCriteria } = require('./criteria.ts');

const SCHEMA = 1;
const MAX_AGE_DAYS = 90;
const SCOPE = 'this project only';
const FOOTER = 'Records are from this project only; every figure shows its n.';
const VERDICTS_FILE = 'core/registry/advice-verdicts.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Nearest-rank percentile over a sorted ascending array; null when empty. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function summarize(values: number[]): { n: number; p50: number | null; p90: number | null; p95: number | null } {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return { n: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9), p95: nearestRank(sorted, 0.95) };
}

function kindFigures(picks: any[], misses: any[], outcomes: Map<string, any>): any {
  if (picks.length === 0 && misses.length === 0) {
    return { n: { picks: 0, misses: 0 }, missesByReason: {}, agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null };
  }
  const missesByReason: Record<string, number> = {};
  for (const miss of misses) {
    const reason = typeof miss.reason === 'string' && miss.reason ? miss.reason : 'unknown';
    missesByReason[reason] = (missesByReason[reason] || 0) + 1;
  }
  const withStatic = picks.filter((p) => typeof p.static === 'string');
  const withOutcome = picks.filter((p) => typeof p.pickId === 'string' && outcomes.has(p.pickId));
  const modes = { shadow: 0, act: 0, unrecorded: 0 };
  for (const pick of picks) {
    if (pick.mode === 'shadow') modes.shadow += 1;
    else if (pick.mode === 'act') modes.act += 1;
    else modes.unrecorded += 1;
  }
  return {
    n: { picks: picks.length, misses: misses.length },
    missesByReason,
    agreeStatic: { n: withStatic.length, agree: withStatic.filter((p) => p.pick === p.static).length },
    agreeOutcome: { n: withOutcome.length, agree: withOutcome.filter((p) => outcomes.get(p.pickId) === p.pick).length },
    elevated: picks.filter((p) => p.elevated === true).length,
    modes,
    durationMs: summarize(picks.map((p) => p.durationMs)),
    missDurationMs: summarize(misses.map((m) => m.durationMs)),
  };
}

const LABELS = 'ABCDEFGHIJKLMNOP';
const ARMS = ['choice', 'ladder'];

/** A pick's rerank payload when it has the shape the figures need (a permutation of the first n labels), else null. */
function usablePayload(pick: any): any | null {
  const r = pick?.rerank;
  if (!isObject(r) || !Number.isInteger(r.n) || r.n < 1 || r.n > LABELS.length || !Array.isArray(r.order) || r.order.length !== r.n) return null;
  const labels = LABELS.slice(0, r.n).split('');
  return new Set(r.order).size === r.n && r.order.every((label: any) => labels.includes(label)) ? r : null;
}

/** Mean over candidates of |new rank - first-stage rank| for one payload. */
function displacementOf(r: any): number {
  let sum = 0;
  r.order.forEach((label: string, rank: number) => { sum += Math.abs(rank - LABELS.indexOf(label)); });
  return sum / r.n;
}

function armFigures(payloads: any[]): any {
  const changed = payloads.filter((r) => r.order[0] !== 'A').length;
  const displacements = payloads.map(displacementOf);
  const mean = displacements.length === 0 ? null : displacements.reduce((a, b) => a + b, 0) / displacements.length;
  return {
    picks: payloads.length,
    top1Changed: { n: payloads.length, changed },
    meanRankDisplacement: mean === null ? null : { n: displacements.length, mean: Math.round(mean * 100) / 100 },
  };
}

function wouldDropFigures(ladder: any[], thresholds: any): any {
  const both = ladder.filter((r) => Array.isArray(r.expected) && Array.isArray(r.confidence));
  const candidates = both.reduce((sum, r) => sum + r.n, 0);
  const rows: any[] = [];
  const add = (field: string, key: 'confidence' | 'expected', values: any) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      let dropped = 0;
      let top1 = 0;
      for (const r of both) {
        dropped += r[key].filter((x: number) => x < value).length;
        if (r[key][0] < value) top1 += 1;
      }
      rows.push({ field, value, wouldDrop: dropped, ofCandidates: candidates, top1WouldDrop: top1, ofPicks: both.length });
    }
  };
  add('confidenceBelow', 'confidence', thresholds?.confidenceBelow);
  add('expectedBelow', 'expected', thresholds?.expectedBelow);
  return { picks: both.length, candidates, illustrative: true, thresholds: rows };
}

/**
 * The rerank figures (141 IC-008, DEC-029). They describe agreement with the first-stage order and counts of what a
 * threshold would have removed; nothing here is a quality figure and nothing is dropped. Only numbers and the 12-hex
 * criteria digest are read from a line.
 */
function rerankFigures(picks: any[], misses: any[], { thresholds, criteria }: any): any {
  const missesByReason: Record<string, number> = {};
  for (const miss of misses) {
    const reason = typeof miss.reason === 'string' && miss.reason ? miss.reason : 'unknown';
    missesByReason[reason] = (missesByReason[reason] || 0) + 1;
  }
  const payloads = picks.map(usablePayload).filter((r) => r !== null);
  const armOf = (r: any) => (r.arm === 'ladder' ? 'ladder' : 'choice');
  const byArm = (arm: string) => payloads.filter((r) => armOf(r) === arm);
  const recorded: any = { n: payloads.length, bySource: { registry: 0, settings: 0, unrecorded: 0 }, digests: {} };
  for (const r of payloads) {
    if (r.criteriaSource === 'registry' || r.criteriaSource === 'settings') recorded.bySource[r.criteriaSource] += 1;
    else recorded.bySource.unrecorded += 1;
    if (typeof r.criteriaDigest === 'string' && /^[0-9a-f]{12}$/.test(r.criteriaDigest)) recorded.digests[r.criteriaDigest] = (recorded.digests[r.criteriaDigest] || 0) + 1;
  }
  const overall = armFigures(payloads);
  return {
    n: { picks: picks.length, misses: misses.length },
    withoutPayload: picks.length - payloads.length,
    missesByReason,
    top1Changed: overall.top1Changed,
    meanRankDisplacement: overall.meanRankDisplacement,
    firstStageMs: (({ n, p50, p95 }) => ({ n, p50, p95 }))(summarize(payloads.map((r) => r.firstStageMs))),
    arms: Object.fromEntries(ARMS.map((arm) => [arm, armFigures(byArm(arm))])),
    criteria: { source: criteria?.source ?? null, digest: criteria?.digest ?? null, warning: criteria?.warning ?? null, recorded },
    wouldDrop: wouldDropFigures(byArm('ladder'), thresholds),
  };
}

function readVerdicts(repoRoot: string, kinds: Set<string>, evaluate: any, criteriaDigest: string | null = null): any[] {
  let file: any;
  try { file = JSON.parse(fs.readFileSync(path.join(repoRoot, VERDICTS_FILE), 'utf8')); } catch { return []; }
  if (!isObject(file) || !Array.isArray(file.verdicts)) return [];
  const rows: any[] = [];
  for (const v of file.verdicts) {
    if (!isObject(v) || typeof v.kind !== 'string' || typeof v.model !== 'string' || !kinds.has(v.kind)) continue;
    const arm = typeof v.arm === 'string' ? v.arm : null;
    let judged: any = null;
    try { judged = evaluate(v.kind, v.model, v.kind === 'rerank' ? { arm, criteriaDigest } : { arm }); } catch { /* an evaluator failure reads as stale below */ }
    const reason = typeof judged?.reason === 'string' ? judged.reason : 'bench verdicts unreadable';
    const stale = !judged || /^(verdict stale|bench verdicts unreadable|verdict inconsistent)/.test(reason);
    rows.push({ kind: v.kind, model: v.model, arm, result: typeof v.result === 'string' ? v.result : null, stale, reason: stale ? reason : null });
  }
  return rows;
}

/**
 * Builds the report object. `kind`, when given, narrows it to one kind. `kinds` lists the kinds to show (registry kinds).
 * Never writes; `evaluate` and `repoRoot` are injectable for tests.
 */
function buildReport({
  roots, kinds, kind = null, now = () => new Date(), fsImpl = fs, evaluate = evaluateBenchBar, repoRoot = REPO_ROOT,
  adviceRegistry = null, criteria, projectRoot = null, global = false, env = process.env,
}: any = {}): any {
  const at = new Date(typeof now === 'function' ? now() : now);
  const { records, unreadable } = readWindow({ roots, now: () => at, maxAgeDays: MAX_AGE_DAYS, fsImpl });
  const shown: string[] = kind ? [kind] : [...(kinds || [])];
  const picksBy = new Map<string, any[]>();
  const missesBy = new Map<string, any[]>();
  const outcomes = new Map<string, { at: string; actual: string }>();
  for (const { record } of records) {
    if (typeof record.kind === 'string' && record.type === 'pick') {
      if (!picksBy.has(record.kind)) picksBy.set(record.kind, []);
      picksBy.get(record.kind)!.push(record);
    } else if (typeof record.kind === 'string' && record.type === 'miss') {
      if (!missesBy.has(record.kind)) missesBy.set(record.kind, []);
      missesBy.get(record.kind)!.push(record);
    } else if (record.type === 'outcome' && typeof record.pickId === 'string' && typeof record.actual === 'string') {
      const prior = outcomes.get(record.pickId);
      if (!prior || String(record.at) >= prior.at) outcomes.set(record.pickId, { at: String(record.at), actual: record.actual });
    }
  }
  if (!kind) {
    for (const seen of [...picksBy.keys(), ...missesBy.keys()]) if (!shown.includes(seen)) shown.push(seen);
  }
  const actuals = new Map<string, string>([...outcomes].map(([id, o]) => [id, o.actual]));
  const kindsOut: Record<string, any> = {};
  for (const id of shown) kindsOut[id] = kindFigures(picksBy.get(id) || [], missesBy.get(id) || [], actuals);
  let rerank: any;
  if (shown.includes('rerank')) {
    let inForce: any = criteria;
    if (inForce === undefined) {
      try { inForce = resolveRerankCriteria({ adviceRegistry, projectRoot, global, env, fsImpl }); } catch { inForce = null; }
    }
    const entry = (adviceRegistry?.kinds || []).find((k: any) => k?.id === 'rerank');
    rerank = rerankFigures(picksBy.get('rerank') || [], missesBy.get('rerank') || [], { thresholds: entry?.thresholds, criteria: inForce });
  }
  return {
    schema: SCHEMA,
    scope: SCOPE,
    window: { from: new Date(at.getTime() - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10), to: at.toISOString().slice(0, 10), maxAgeDays: MAX_AGE_DAYS },
    unreadable,
    kinds: kindsOut,
    ...(rerank ? { rerank } : {}),
    verdicts: readVerdicts(repoRoot, new Set(shown), evaluate, rerank?.criteria?.digest ?? null),
  };
}

function ratio(part: { n: number; agree: number }): string {
  return part.n === 0 ? 'no data (n=0)' : `${part.agree} of ${part.n} (${Math.round((part.agree / part.n) * 100)}%), n=${part.n}`;
}

function duration(label: string, d: any): string {
  return d.n === 0 ? `  ${label}: no data (n=0)` : `  ${label} (n=${d.n}): p50 ${d.p50}, p90 ${d.p90}, p95 ${d.p95}`;
}

function changeRate(c: { n: number; changed: number }): string {
  return c.n === 0 ? 'no data (n=0)' : `${c.changed} of ${c.n} (${Math.round((c.changed / c.n) * 100)}%), n=${c.n}`;
}

function displacement(d: any): string {
  return d === null ? 'no data (n=0)' : `${d.mean}, n=${d.n}`;
}

function renderRerank(kindFigs: any, r: any): string[] {
  if (kindFigs.agreeStatic === null) return ['  no data'];
  const reasons = Object.entries(r.missesByReason).map(([reason, count]) => `${reason} ${count}`).join(', ');
  const lines = [`  picks: ${r.n.picks}; misses: ${r.n.misses}${reasons ? ` (${reasons})` : ''}`];
  if (r.withoutPayload > 0) lines.push(`  picks without a rerank payload: ${r.withoutPayload} of ${r.n.picks}`);
  lines.push(`  top-1 changed: ${changeRate(r.top1Changed)}`);
  lines.push(`  mean absolute rank displacement per candidate: ${displacement(r.meanRankDisplacement)}`);
  lines.push(r.firstStageMs.n === 0 ? '  first-stage time ms: no data (n=0)' : `  first-stage time ms (n=${r.firstStageMs.n}): p50 ${r.firstStageMs.p50}, p95 ${r.firstStageMs.p95}`);
  lines.push(duration('pick duration ms', kindFigs.durationMs));
  lines.push(duration('miss duration ms', kindFigs.missDurationMs));
  lines.push('  by arm:');
  for (const arm of ARMS) {
    const a = r.arms[arm];
    lines.push(a.picks === 0 ? `    ${arm}: no data (n=0)`
      : `    ${arm}: picks ${a.picks}; top-1 changed ${changeRate(a.top1Changed)}; mean displacement ${displacement(a.meanRankDisplacement)}`);
  }
  const c = r.criteria;
  lines.push(`  criteria in force: ${c.source ?? 'unknown'}, digest ${c.digest ?? 'unknown'}; warning: ${c.warning ?? 'none'}`);
  const digests = Object.entries(c.recorded.digests).map(([digest, count]) => `${digest} ${count}`).join(', ');
  lines.push(c.recorded.n === 0 ? '  criteria recorded: no data (n=0)'
    : `  criteria recorded (n=${c.recorded.n}): registry ${c.recorded.bySource.registry}, settings ${c.recorded.bySource.settings}, unrecorded ${c.recorded.bySource.unrecorded}; digests ${digests || 'none'}`);
  const w = r.wouldDrop;
  lines.push('  would-drop (measurement only), ladder arm:');
  if (w.picks === 0) lines.push('    no data (n=0)');
  else {
    for (const t of w.thresholds) {
      lines.push(`    ${t.field === 'confidenceBelow' ? 'confidence' : 'expected score'} below ${t.value}: ${t.wouldDrop} of ${t.ofCandidates} candidates; first-stage top candidate ${t.top1WouldDrop} of ${t.ofPicks} picks`);
    }
  }
  lines.push('  Illustrative thresholds; nothing was dropped.');
  return lines;
}

function renderText(report: any): string {
  const lines = [
    `Advice report (${report.scope})`,
    `Window: ${report.window.from} to ${report.window.to} (${report.window.maxAgeDays} days)`,
  ];
  if (report.unreadable > 0) lines.push(`Unreadable lines skipped: ${report.unreadable}`);
  for (const [id, f] of Object.entries<any>(report.kinds)) {
    lines.push('', id);
    if (id === 'rerank' && report.rerank) { lines.push(...renderRerank(f, report.rerank)); continue; }
    if (f.agreeStatic === null) { lines.push('  no data'); continue; }
    const reasons = Object.entries(f.missesByReason).map(([reason, count]) => `${reason} ${count}`).join(', ');
    lines.push(`  picks: ${f.n.picks}; misses: ${f.n.misses}${reasons ? ` (${reasons})` : ''}`);
    lines.push(`  agrees with the static answer: ${ratio(f.agreeStatic)}`);
    lines.push(`  agrees with the recorded outcome: ${ratio(f.agreeOutcome)}`);
    lines.push(`  elevated: ${f.elevated} of ${f.n.picks} picks`);
    lines.push(`  modes (n=${f.n.picks}): shadow ${f.modes.shadow}, act ${f.modes.act}, unrecorded ${f.modes.unrecorded}`);
    lines.push(duration('pick duration ms', f.durationMs));
    lines.push(duration('miss duration ms', f.missDurationMs));
  }
  if (report.verdicts.length > 0) {
    lines.push('', 'Bench verdicts');
    for (const v of report.verdicts) {
      lines.push(`  ${v.kind} ${v.model}${v.arm ? ` (arm ${v.arm})` : ''}: ${v.result ?? 'unknown'}${v.stale ? `, stale: ${v.reason}` : ''}`);
    }
  }
  lines.push('', FOOTER);
  return lines.join('\n');
}

module.exports = { buildReport, renderText, FOOTER };
