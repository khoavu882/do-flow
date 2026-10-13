'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/** The names a retrieval score arrives under, in camelCase (`--relevance-score` normalises here).
 *  Exported because `bin/doflow.js` refuses the same names on the command line, and because
 *  `retrieval-plan.ts` and `outcome.ts` refuse them on the option object a declared plan and a
 *  terminal record are built from: one definition, three input surfaces (argv, a `--batch` JSON
 *  file, and a verb's own options), each with exactly one enforcement point. A second copy of
 *  this list is how one of them drifts. */
const EVIDENCE_SCORE_FIELDS: ReadonlySet<string> = new Set([
  'confidence', 'score', 'relevance', 'relevanceScore', 'similarity',
  'certainty', 'probability', 'rank', 'distance', 'weight',
]);

/** The one refusal message for a score offered as a property of a fact. */
function scoreFieldRefusal(name: string): string {
  return `'${name}' is a retrieval score and this boundary records none (FR-007). Relevance is a `
    + 'property of a search, not of a fact: stored beside the fact it is read as confidence by the '
    + 'next worker, which is the specific interpretation the requirement forbids. Record the '
    + 'locator and the content instead — a reader who can see where a fact came from does not need '
    + 'to be told how sure to be.';
}

/** Refuses a score-shaped key anywhere in an item, including nested under source or locator. */
function assertNoScoreFields(value: unknown, prefix: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (EVIDENCE_SCORE_FIELDS.has(key)) throw new Error(scoreFieldRefusal(dotted));
    assertNoScoreFields(inner, dotted);
  }
}

module.exports = {
  EVIDENCE_SCORE_FIELDS,
  scoreFieldRefusal,
  assertNoScoreFields,
};
