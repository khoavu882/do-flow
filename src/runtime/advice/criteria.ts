'use strict';

// Rerank criteria in force (141 IC-002), for the offline measurement of `bench advice-gate` (row 175). They come from the
// `rerank` kind of core/registry/advice.json only: no setting overrides them, and the runtime does not ask the kind.
// The digest is over the texts in force, so a registry edit changes it; it binds a bench verdict to them.

const crypto = require('node:crypto');

const LADDER_LEVELS = 5;

// IC-001's registry text, the same as the `rerank` kind of core/registry/advice.json (test/runtime/advice-criteria.test.ts
// keeps the two equal). A caller that has the kind passes it as `kind` (or the registry as `adviceRegistry`) and the
// kind's own text applies; these values are the fallback when it has not.
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

interface RerankCriteria {
  ladder: string[];
  choiceInstruction: string;
  digest: string;
  source: 'registry';
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

function inForce(ladder: string[], choiceInstruction: string): RerankCriteria {
  return { ladder: ladder.slice(), choiceInstruction, digest: criteriaDigest(ladder, choiceInstruction), source: 'registry', warning: null };
}

/**
 * The criteria in force: the registry's text. It comes from, in order: an explicit `registry`
 * (`{ ladder: string[5], choiceInstruction }`); the `rerank` kind entry given as `kind` or found in `adviceRegistry`;
 * IC-001's values.
 */
function resolveRerankCriteria({ registry: givenRegistry, kind: givenKind, adviceRegistry }: any = {}): RerankCriteria {
  const entry = givenKind ?? (Array.isArray(adviceRegistry?.kinds) ? adviceRegistry.kinds.find((candidate: any) => candidate?.id === 'rerank') : null);
  const fromKind = entry && typeof entry === 'object' ? { ladder: entry.scoreLadder?.criteria, choiceInstruction: entry.instructions } : null;
  const registry = givenRegistry ?? fromKind;
  const base = registryUsable(registry) ? registry : DEFAULT_REGISTRY;
  return inForce(base.ladder, base.choiceInstruction);
}

module.exports = { resolveRerankCriteria, DEFAULT_REGISTRY };
