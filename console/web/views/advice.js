// Advice and shadow: read-only projections of the three advice sections (IC-018).
import { h } from '../dom.js';
import { renderSection, ratioText, countText } from '../figures.js';
import { gateSentences, dayRows } from '../derive/advice.js';
import { showPanel, hidePanel } from '../shell.js';

/** @param {string} id @param {string} title @param {any} children */
function section(id, title, children) { return h('section', { 'aria-labelledby': id }, [h('h2', { id }, title), children]); }
/** @param {string} caption @param {string[]} columns @param {any[]} rows */
function table(caption, columns, rows) { return h('table', { class: 'mtable', tabindex: '0' }, [h('caption', {}, caption), h('thead', {}, h('tr', {}, columns.map((name) => h('th', { scope: 'col' }, name)))), h('tbody', {}, rows)]); }
/** @param {Array<[string, string]>} pairs */
function facts(pairs) { return h('dl', {}, pairs.map(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])); }
/** @param {any} n @param {any} total */
function of(n, total) { return n == null || total == null ? 'unknown' : `${n} of ${total}`; }
/** @param {any} p */
function duration(p) {
  if (p == null) return 'unknown';
  if (p.n === 0) return 'no data (n=0)';
  const parts = ['p50', 'p90', 'p95'].filter((k) => Object.hasOwn(p, k)).map((k) => `${k} ${p[k] === null ? 'unknown' : `${p[k]} ms`}`);
  return `${parts.join(', ')}, n=${countText(p.n)}`;
}
/** @param {any} value */
function agreement(value) { return ratioText(value); }
/** @param {any} row */
function kindFigures(row) {
  const misses = row.n.misses === null ? 'unknown' : `${row.n.misses}${row.missesByReason.length ? ` (${row.missesByReason.map((/** @type {any} */ r) => `${r.reason} ${r.n}`).join(', ')})` : ''}`;
  return section(`advice-kind-${row.kind}`, row.kind, facts([
    ['Picks', countText(row.n.picks)], ['Misses', misses], ['Agrees with the rule', agreement(row.agreeStatic)], ['Agrees with the outcome', agreement(row.agreeOutcome)],
    ['Elevated', of(row.elevated, row.n.picks)], ['Mode shadow', of(row.modes?.shadow, row.n.picks)], ['Mode act', of(row.modes?.act, row.n.picks)], ['Mode unrecorded', of(row.modes?.unrecorded, row.n.picks)],
    ['Pick duration', duration(row.durationMs)], ['Miss duration', duration(row.missDurationMs)],
  ]));
}
/** @param {any} block */
function rerankFigures(block) {
  const change = (/** @type {any} */ part) => agreement({ n: part.n, agree: part.changed });
  const displacement = (/** @type {any} */ part) => part == null ? 'unknown' : part.n === 0 ? 'no data (n=0)' : `${part.mean ?? 'unknown'}, n=${part.n}`;
  const thresholds = block.wouldDrop.thresholds.map((/** @type {any} */ t) => `${t.field} ${t.value}: ${t.wouldDrop} of ${t.ofCandidates} candidates, ${t.top1WouldDrop} of ${t.ofPicks} top picks`).join('; ') || 'no data (n=0)';
  return section('advice-rerank', 'Rerank', facts([
    ['Picks', countText(block.n.picks)], ['Misses', countText(block.n.misses)], ['Without payload', countText(block.withoutPayload)],
    ['Top-1 changed', change(block.top1Changed)], ['Mean rank displacement per candidate', block.n.picks === 0 ? 'no data (n=0)' : displacement(block.meanRankDisplacement)], ['First stage duration', duration(block.firstStageMs)],
    ['Choice arm', `${block.arms.choice.picks} picks; ${change(block.arms.choice.top1Changed)}; displacement ${displacement(block.arms.choice.meanRankDisplacement)}`],
    ['Ladder arm', `${block.arms.ladder.picks} picks; ${change(block.arms.ladder.top1Changed)}; displacement ${displacement(block.arms.ladder.meanRankDisplacement)}`],
    ['Criteria in force', `${block.criteria.source ?? 'unknown'}, digest ${block.criteria.digest ?? 'unknown'}`], ['Criteria warning', block.criteria.warning ?? 'no warning'],
    ['Criteria recorded', `${block.criteria.recorded.n}; registry ${block.criteria.recorded.bySource.registry}, settings ${block.criteria.recorded.bySource.settings}, unrecorded ${block.criteria.recorded.bySource.unrecorded}`],
    ['Would drop, ladder arm (measurement only)', block.wouldDrop.picks === 0 ? 'no data (n=0)' : thresholds],
  ]));
}
/** @param {any} block */
function claimFigures(block) {
  const relation = (/** @type {any} */ part) => part.n === 0 ? 'no data (n=0)' : `picks ${part.n}; model said yes ${part.modelYes} of ${part.n}; agrees with the recorded relation ${agreement(part)}`;
  return section('advice-claim-support', 'Claim support', facts([
    ['Picks', countText(block.n.picks)], ['Misses', countText(block.n.misses)], ['Without payload', countText(block.withoutPayload)],
    ['Supports', relation(block.byRelation.supports)], ['Contradicts', relation(block.byRelation.contradicts)], ['Pick duration', duration(block.durationMs)],
  ]));
}
/** @param {any} report */
function figures(report) {
  return [h('p', {}, `Last 90 days: ${report.window.from} to ${report.window.to} (UTC)`), report.kinds.map(kindFigures), report.rerank ? rerankFigures(report.rerank) : null, report.claimSupport ? claimFigures(report.claimSupport) : null];
}
/** @param {any} data */
function settings(data) {
  const chosen = data.keys.filter((/** @type {any} */ row) => row.key === 'advice.enabled' || row.key.startsWith('advice.kinds.'));
  const rows = chosen.map((/** @type {any} */ row) => h('tr', {}, [h('th', { scope: 'row' }, row.key), h('td', {}, row.views[0].value === null ? "not set (the kind's own path)" : String(row.views[0].value)), h('td', {}, row.views[0].origin.layer)]));
  const descriptions = chosen.filter((/** @type {any} */ row) => ['advice.kinds.rerank', 'advice.kinds.claim-support'].includes(row.key)).map((/** @type {any} */ row) => h('p', {}, `${row.key}: ${row.meta.description}`));
  return [table('Advice settings', ['Key', 'Value', 'Layer'], rows), descriptions];
}
/** @param {any} picks */
function days(picks) {
  const data = dayRows(picks.days, picks.kinds);
  const list = h('ul', {}, data.kinds.map((row) => h('li', {}, `${row.kind}: ${row.withPicks.length ? `${row.withPicks.map((p) => `${p.day}: ${p.n}`).join(', ')}; ` : ''}${row.zeroText}; ${row.unknownText}`)));
  const rows = data.table.map((row) => h('tr', {}, [row.day, row.coverage, ...picks.kinds.map((/** @type {string} */ kind) => countText(row.counts[kind]))].map((text) => h('td', {}, text))));
  return [list, h('details', {}, [h('summary', {}, 'All days'), table('Picks by day', ['Day', 'Coverage', ...picks.kinds], rows)])];
}
/** @param {any} pick @returns {Array<[string, string]>} */
function pickFacts(pick) {
  const outcome = pick.outcome === null ? 'no outcome recorded' : `${pick.outcome.actual}, ${pick.outcome.agree === null ? 'agreement unknown' : pick.outcome.agree ? 'agrees with the pick' : 'differs from the pick'}`;
  return [['Time', pick.at], ['Kind', pick.kind], ['Mode', pick.mode], ["Model's pick", pick.pick], ["Rule's answer", pick.static ?? 'not recorded'], ['Agreed', pick.agree === null ? 'unknown' : pick.agree ? 'yes' : 'no'], ['Outcome', outcome]];
}
/** @param {any} params @param {any} data @param {any} report */
function filter(params, data, report) {
  const kinds = [...new Set([...(report?.kinds ?? []).map((/** @type {any} */ row) => row.kind), ...(data?.kinds ?? [])])];
  const select = h('select', { id: 'advice-kind-filter', on: { change: (/** @type {any} */ e) => { const v = e.target.value; globalThis.location.hash = v ? `#/advice/kind/${v}` : '#/advice'; } } }, [
    h('option', { value: '', selected: !params.kind }, 'All'), kinds.map((kind) => h('option', { value: kind, selected: params.kind === kind }, kind)),
  ]);
  return [h('label', { for: 'advice-kind-filter' }, 'Kind'), select];
}
/** @param {any} data @param {any} params @param {any} local @param {Map<string, any>} owners */
function recent(data, params, local, owners) {
  const prefix = params.kind ? `#/advice/kind/${params.kind}` : '#/advice';
  const rows = data.picks.map((/** @type {any} */ pick) => {
    const values = pickFacts(pick).map((/** @type {any} */ pair) => pair[1]);
    const link = pick.pickId ? h('a', { href: `${prefix}/pick/${pick.pickId}`, 'aria-current': local.route?.pick === pick.pickId ? 'true' : null }, values[0]) : null;
    if (link) owners.set(pick.pickId, link);
    return h('tr', {}, [h('td', {}, link ?? values[0]), ...values.slice(1).map((/** @type {string} */ value) => h('td', {}, value))]);
  });
  const n = data.limits.notShown;
  return [rows.length ? table('Recent picks', ['Time', 'Kind', 'Mode', "Model's pick", "Rule's answer", 'Agreed', 'Outcome'], rows) : h('p', {}, 'No pick is recorded in the window.'), h('p', {}, `${n} older ${n === 1 ? 'pick' : 'picks'} in the window ${n === 1 ? 'is' : 'are'} not shown.`)];
}
/** @param {any} local */
function rerouteAdvice(local) { if (typeof local.reselectAdvice === 'function') local.reselectAdvice(); }
/** @param {any} body @param {any} params @param {any} local */
function renderAdvice(body, params, local) {
  const sections = body?.sections ?? {};
  const report = sections.report?.ok ? sections.report.data : null;
  const picks = sections.picks?.ok ? sections.picks.data : null;
  const owners = new Map();
  const retry = () => { if (typeof local.retry === 'function') local.retry(); else if (typeof local.refresh === 'function') local.refresh(); };
  const part = (/** @type {any} */ value, /** @type {string} */ noun, /** @type {(data: any) => any} */ render) => renderSection(value, { noun, render, onRetry: retry });
  const gate = section('advice-gate', 'Gate', [h('p', {}, ["A kind acts on the model's pick only when a shipped bench verdict passes for it; until then ", h('code', {}, 'act'), ' is gated.']), part(sections.report, 'the advice report', (data) => h('ul', {}, gateSentences(data.kinds, data.verdicts).map((entry) => h('li', {}, entry.text))))]);
  const root = h('div', {}, [gate, section('advice-settings', 'Settings', part(sections.settings, 'advice settings', settings)), section('advice-figures', 'Figures', part(sections.report, 'the advice report', figures)), section('advice-days', 'Picks per day', part(sections.picks, 'advice picks', days)), section('advice-recent', 'Recent picks', [filter(params, picks, report), part(sections.picks, 'advice picks', (data) => recent(data, params, local, owners))])]);
  local.reselectAdvice = () => {
    const id = local.route?.pick;
    if (!id) { hidePanel(local.inspector, local); return; }
    const pick = picks?.picks.find((/** @type {any} */ row) => row.pickId === id);
    const panel = h('div', {}, [h('h2', { id: 'advice-panel-title' }, 'Pick details'), pick ? facts([['Pick id', id], ...pickFacts(pick), ['Outcome recorded at', pick.outcome?.at ?? 'not recorded']]) : h('p', {}, `${id} is not among the picks this screen lists.`)]);
    showPanel(local.inspector, local, { title: 'Pick details', labelledBy: 'advice-panel-title', body: panel, owner: owners.get(id) ?? null, onClose: () => { if (typeof local.link === 'function') local.link(null); } });
  };
  if (local.route?.pick) local.reselectAdvice();
  return root;
}
/** @param {any} params @param {any} _body */
function adviceTitle(params, _body) { return typeof params?.kind === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(params.kind) ? `Advice and shadow · ${params.kind}` : 'Advice and shadow'; }
export { renderAdvice, rerouteAdvice, adviceTitle };
