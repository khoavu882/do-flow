'use strict';

// The case-source seam (175 IC-002). A replay kind names its source in data (`kinds[].replay.source`); the facts of a
// source (how it builds cases, whether its label is the rule's answer) are code, so data cannot mark a source certifying.
// This is a closed map: a source id the map does not hold is a registry refusal, never a dynamic require.

interface ReplayCase {
  id: string;      // first 16 hex characters of sha256 over the source's natural key; cases are sorted by it
  state: string;   // the text the model is asked about
  label: string;   // the recorded decision, an option name of the kind's question
  rule: string;    // what the rule answers for this case, an option name too
}

interface CaseSource {
  id: string;                // equals the file name and the data id
  builderVersion: number;    // raised whenever how cases are built changes
  labelIsRule: boolean;      // true: the label is the rule's answer by construction, so the source is measure-only
  origin: 'project' | 'package';
  /** Pins the source's inputs carry (a shipped corpus and its rule); folded into the builder digest, so a moved pin makes stored results stale. */
  params?: Record<string, string>;
  /** Reads files only (no network, no process) and never writes. `skipped` counts the cases or files left out, by reason. */
  build(input: { projectRoot: string; roots: Record<string, string | null>; kind: any; fsImpl?: any }): { cases: ReplayCase[]; skipped: Record<string, number> };
}

const { source: claimLedger } = require('./claim-ledger.ts');
const { source: instructsReaderCorpus } = require('./instructs-reader-corpus.ts');
const { source: reviewFindings } = require('./review-findings.ts');

const SOURCES: Readonly<Record<string, CaseSource>> = Object.freeze({
  'claim-ledger': claimLedger,
  'instructs-reader-corpus': instructsReaderCorpus,
  'review-findings': reviewFindings,
});

const SOURCE_IDS: readonly string[] = Object.freeze(Object.keys(SOURCES));

/** The source for an id the map holds, else null (an inherited property name such as `toString` is not a source). */
function getSource(id: unknown): CaseSource | null {
  return typeof id === 'string' && Object.hasOwn(SOURCES, id) ? SOURCES[id] : null;
}

/** The option names of a materialised question: `yes` and `no` for a yes/no kind, else the keys of its options. */
function optionNames(question: any): string[] {
  return question?.type === 'yesno' ? ['yes', 'no'] : Object.keys(question?.options || {});
}

/**
 * The cases of `source` for the kind whose question has `options`, the way replay and the report both read them (design
 * section 4): a case whose label or rule is not one of `options` is left out and counted under `skipped['bad-label']`,
 * so a stray class never reaches the scorer or the case-set digest. `options` null (the question could not be built)
 * applies no filter.
 */
function buildCases(source: CaseSource, input: Parameters<CaseSource['build']>[0], options: readonly string[] | null) {
  const built = source.build(input);
  if (!options) return built;
  const cases = built.cases.filter((c) => options.includes(c.label) && options.includes(c.rule));
  const dropped = built.cases.length - cases.length;
  return { cases, skipped: dropped ? { ...built.skipped, 'bad-label': (built.skipped['bad-label'] || 0) + dropped } : built.skipped };
}

module.exports = { SOURCES, SOURCE_IDS, getSource, buildCases, optionNames };
