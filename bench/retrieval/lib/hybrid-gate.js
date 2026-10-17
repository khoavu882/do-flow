'use strict';

const { applicability } = require('./metrics.js');
const { CORPORA } = require('./hybrid-protocol.js');

const PROTOCOL = 'hybrid-c-v1';
const P2_GATE = 'Conceptual retrieval improves within agreed quality/cost tolerances. Locators are valid; provider faults do not collapse the workflow or produce false absence claims.';
const REQUIRED_THRESHOLDS = ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008'];

/** Missing/underpowered evidence stays unresolved; paid T-005/T-006 are never inferred from offline data. */
function evaluate({ aggregates = {}, comparisons = {}, thresholds = {}, protocol = PROTOCOL } = {}) {
  if (protocol !== PROTOCOL) throw new Error(`gate requires ${PROTOCOL}`);
  const configured = new Map((thresholds.thresholds || []).map((threshold) => [threshold.id, threshold]));
  const rows = REQUIRED_THRESHOLDS.map((id) => {
    const threshold = configured.get(id);
    if (!threshold) return { id, verdict: 'UNRESOLVED', cause: 'threshold definition missing' };
    if (['T-005', 'T-006'].includes(threshold.id)) return { id: threshold.id, verdict: 'UNREACHED', cause: 'paid measurement requires separate authorization' };
    const corpusRows = threshold.corpus === '*' ? Object.keys(aggregates) : [threshold.corpus];
    const values = [];
    // Every C class row an absolute threshold covers but does not count, named by corpus and class only, with why.
    const excluded = [];
    for (const corpus of corpusRows) for (const [config, classes] of Object.entries(aggregates[corpus] || {})) {
      if (config !== 'C' && threshold.id !== 'T-003' && threshold.id !== 'T-008') continue;
      for (const [cls, row] of Object.entries(classes || {})) {
        if (threshold.class !== '*' && cls !== threshold.class) continue;
        const skip = !row ? 'missing' : row.applicable === false ? 'not-applicable' : row.state === 'unreached' ? 'unreached'
          : row.underpowered ? 'underpowered' : null;
        const value = skip ? undefined : threshold.metric === 'falseAbsence' ? row.metrics?.falseAbsence?.count
          : row.metrics?.[threshold.metric]?.value;
        if (value !== undefined && value !== null) values.push({ corpus, config, cls, value, n: row.metrics?.[threshold.metric]?.n });
        else if (config === 'C') excluded.push({ corpus, class: cls, reason: skip || 'metric-absent' });
      }
    }
    // A covered corpus with no C aggregate at all is excluded whole.
    if (threshold.corpus === '*') for (const corpus of CORPORA) if (!aggregates[corpus]?.C) excluded.push({ corpus, class: threshold.class, reason: 'missing' });
    if (threshold.relativeTo) {
      const rows = [];
      // RULE-003 holds for compared classes too: both sides must be measured, applicable and not underpowered.
      const established = (corpus, config, cls) => {
        const row = (aggregates[corpus] || {})[config]?.[cls];
        return Boolean(row) && row.applicable !== false && !row.underpowered && row.state !== 'unreached';
      };
      // `corpus: '*'` means every protocol corpus the class applies to, not whichever corpora happen to have rows.
      const expected = threshold.corpus === '*'
        ? CORPORA.filter((corpus) => threshold.class === '*' || applicability(threshold.class, corpus).applicable) : corpusRows;
      const missingCorpora = [];
      for (const corpus of expected) {
        const eligible = (comparisons[corpus] || []).filter((row) => row.metric === threshold.metric
          && (threshold.class === '*' || row.class === threshold.class)
          && ((row.a === 'C' && row.b === threshold.relativeTo) || (row.b === 'C' && row.a === threshold.relativeTo))
          && established(corpus, 'C', row.class) && established(corpus, threshold.relativeTo, row.class));
        if (!eligible.length) missingCorpora.push(corpus);
        for (const row of eligible) {
          const sign = row.a === 'C' ? 1 : -1;
          const delta = Number(row.diff) * sign;
          const ci = Array.isArray(row.ci95) ? row.ci95 : null;
          const lower = ci ? (sign === 1 ? ci[0] : -ci[1]) : null;
          const pass = threshold.comparator === '>=' ? delta >= threshold.value : threshold.comparator === '<=' ? delta <= threshold.value : delta === threshold.value;
          const ciPass = !threshold.requireCiLowerAboveZero || (lower !== null && lower > 0);
          rows.push({ pass: pass && ciPass, delta, lower });
        }
      }
      if (!rows.length) return { id: threshold.id, verdict: 'UNRESOLVED', cause: `no same-snapshot C versus ${threshold.relativeTo} comparison on an established class` };
      // A failure observed on one corpus stands; only a pass needs every covered corpus.
      if (missingCorpora.length && rows.every((row) => row.pass)) return { id: threshold.id, verdict: 'UNRESOLVED', missingCorpora,
        cause: `no same-snapshot C versus ${threshold.relativeTo} comparison on an established class for every corpus the threshold covers` };
      return { id: threshold.id, verdict: rows.every((row) => row.pass) ? 'PASS' : 'FAIL', observations: rows.length,
        ...(threshold.requireCiLowerAboveZero ? { ciLowerAboveZero: rows.every((row) => row.lower !== null && row.lower > 0) } : {}) };
    }
    if (!values.length) return { id: threshold.id, verdict: 'UNRESOLVED', cause: 'no eligible aggregate observation', excluded };
    const pass = values.every(({ value }) => threshold.comparator === '>=' ? value >= threshold.value
      : threshold.comparator === '<=' ? value <= threshold.value : threshold.comparator === '==' ? value === threshold.value : false);
    return { id: threshold.id, verdict: pass ? 'PASS' : 'FAIL', observations: values.length,
      value: values.length === 1 ? values[0].value : undefined, comparator: threshold.comparator, threshold: threshold.value, excluded };
  });
  const verdict = rows.some((r) => r.verdict === 'FAIL') ? 'FAIL' : rows.every((r) => r.verdict === 'PASS') ? 'PASS' : 'UNRESOLVED';
  return { schemaVersion: 1, protocol, gate: P2_GATE, rows, verdict,
    hybridMvp: verdict === 'PASS' ? 'incomplete: T-005/T-006 require separate paid evidence' : 'incomplete' };
}

module.exports = { PROTOCOL, P2_GATE, REQUIRED_THRESHOLDS, evaluate };
