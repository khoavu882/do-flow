'use strict';

// What row 174 retired. An outcome whose `source` is listed here was recorded by a code path that no longer exists, and it
// is not an observation of the pick it names: doctor, the report and `advice-picks` count it in no figure. The records stay
// in the store until the retention window drops them.
const RETIRED_OUTCOME_SOURCES: readonly string[] = Object.freeze(['classify-verdict']);

function isRetiredOutcome(record: any): boolean {
  return RETIRED_OUTCOME_SOURCES.includes(record?.source);
}

module.exports = { RETIRED_OUTCOME_SOURCES, isRetiredOutcome };
