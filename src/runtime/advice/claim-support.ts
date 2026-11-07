'use strict';

// Claim-support state builder and payload (141 IC-009, IC-007). Pure: no file, network or clock access.
//
// The state is two named fields, one per line, values on one line: `claim: <statement>` and `passage: <evidence content>`,
// each with whitespace collapsed and cut to the kind's byte cap at a code-point boundary. The model is asked the
// registry's yes/no question about that state. Nothing `claimSupportPayload` returns is text a user wrote: ledger ids,
// the relation and status words, byte counts and a flag (NFR-003, DEC-028). The state itself is sent to the model and is
// never written; the pick line keeps only its digest and byte count.

const { collapseWhitespace, cutBytes } = require('./rerank.ts');

const RELATIONS = ['supports', 'contradicts'];

function usableCap(value: any): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * `{ claim, passage, params }` -> `{ ok: true, state, claimBytes, passageBytes, truncated }` or `{ ok: false, reason }`.
 * A blank claim is `empty-claim`, a blank or non-string passage `empty-passage`, unusable caps `bad-params`; no call is
 * made for any of them.
 */
function buildClaimSupportState({ claim, passage, params }: any = {}): any {
  if (!params || !usableCap(params.claimBytes) || !usableCap(params.passageBytes)) return { ok: false, reason: 'bad-params' };
  const claimText = collapseWhitespace(claim);
  if (!claimText) return { ok: false, reason: 'empty-claim' };
  const passageText = collapseWhitespace(passage);
  if (!passageText) return { ok: false, reason: 'empty-passage' };
  const claimCut = cutBytes(claimText, params.claimBytes);
  const passageCut = cutBytes(passageText, params.passageBytes);
  return {
    ok: true,
    state: `claim: ${claimCut.text}\npassage: ${passageCut.text}`,
    claimBytes: Buffer.byteLength(claimCut.text, 'utf8'),
    passageBytes: Buffer.byteLength(passageCut.text, 'utf8'),
    truncated: claimCut.cut || passageCut.cut,
  };
}

/** The `claimSupport` object of IC-007, or null when the relation is not `supports` or `contradicts` or an id is missing. */
function claimSupportPayload({ claimId, evidenceId, relation, claimStatus, claimBytes, passageBytes, truncated }: any = {}): any {
  if (!RELATIONS.includes(relation)) return null;
  if (typeof claimId !== 'string' || !claimId || typeof evidenceId !== 'string' || !evidenceId) return null;
  if (typeof claimStatus !== 'string' || !claimStatus) return null;
  const count = (value: any) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    claimId, evidenceId, relation, claimStatus,
    claimBytes: count(claimBytes), passageBytes: count(passageBytes), truncated: truncated === true,
  };
}

module.exports = { RELATIONS, buildClaimSupportState, claimSupportPayload };
