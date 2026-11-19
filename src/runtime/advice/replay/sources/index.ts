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
  /** Reads files only (no network, no process) and never writes. `skipped` counts the cases or files left out, by reason. */
  build(input: { projectRoot: string; roots: Record<string, string | null>; kind: any; fsImpl?: any }): { cases: ReplayCase[]; skipped: Record<string, number> };
}

const { source: claimLedger } = require('./claim-ledger.ts');

const SOURCES: Readonly<Record<string, CaseSource>> = Object.freeze({
  'claim-ledger': claimLedger,
});

const SOURCE_IDS: readonly string[] = Object.freeze(Object.keys(SOURCES));

/** The source for an id the map holds, else null (an inherited property name such as `toString` is not a source). */
function getSource(id: unknown): CaseSource | null {
  return typeof id === 'string' && Object.hasOwn(SOURCES, id) ? SOURCES[id] : null;
}

module.exports = { SOURCES, SOURCE_IDS, getSource };
