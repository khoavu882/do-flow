'use strict';

const { projectEvidenceCandidates } = require('./code-validation.ts');

/** Project a validated full-span candidate into one score-free evidence candidate per origin. */
function projectCodeEvidence(candidate: any, { need } = {} as any): any[] {
  return projectEvidenceCandidates(candidate, { need });
}

module.exports = { projectCodeEvidence };
