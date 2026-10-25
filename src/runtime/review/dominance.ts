'use strict';

// 122 IC-014: `dominates(P, B, context)`, the strictness comparison between two protocol presets. Pure:
// no filesystem, no throw. P dominates B when every field that makes a review or debate stricter is at
// least as strict in P. `context` carries the ordered core tiers (models.json `dispatchTiers.tiers`,
// loosest first) and the synthesizer lattice (protocols.json `synthesizerStrength`). An unknown tier or
// synthesizer has no rank and never dominates: no `indexOf` of -1 is read as a rank.

const FAMILY_STRICTNESS: Record<string, number> = { any: 0, 'different-from-author': 1 };

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A rank from `ranks`, or null when `key` has none. */
function rankOf(ranks: Record<string, number>, key: any): number | null {
  return typeof key === 'string' && Object.hasOwn(ranks, key) && Number.isInteger(ranks[key]) ? ranks[key] : null;
}

/** True when seat `p` covers seat `b`: a lens superset, a family at least as strict, a tier at least as high. */
function seatCovers(p: any, b: any, tierRank: Record<string, number>): boolean {
  if (!isObject(p) || !isObject(b) || !isObject(p.model) || !isObject(b.model)) return false;
  const pLenses = new Set(Array.isArray(p.lenses) ? p.lenses : []);
  if (!(Array.isArray(b.lenses) ? b.lenses : []).every((lens: any) => pLenses.has(lens))) return false;
  const pFamily = rankOf(FAMILY_STRICTNESS, p.model.family ?? 'any');
  const bFamily = rankOf(FAMILY_STRICTNESS, b.model.family ?? 'any');
  if (pFamily === null || bFamily === null || pFamily < bFamily) return false;
  const pTier = rankOf(tierRank, p.model.tier);
  const bTier = rankOf(tierRank, b.model.tier);
  return pTier !== null && bTier !== null && pTier >= bTier;
}

/**
 * True when every B seat maps to a distinct P seat that covers it: a maximum bipartite matching by
 * augmenting paths (Kuhn), so a first-fit choice never hides a matching that exists. Seats are few.
 */
function seatsMatch(pSeats: any[], bSeats: any[], tierRank: Record<string, number>): boolean {
  if (bSeats.length > pSeats.length) return false;
  const covers = bSeats.map((b) => pSeats.map((p) => seatCovers(p, b, tierRank)));
  const owner: number[] = new Array(pSeats.length).fill(-1); // P seat index -> B seat index
  const augment = (bi: number, seen: boolean[]): boolean => {
    for (let pi = 0; pi < pSeats.length; pi++) {
      if (!covers[bi][pi] || seen[pi]) continue;
      seen[pi] = true;
      if (owner[pi] === -1 || augment(owner[pi], seen)) { owner[pi] = bi; return true; }
    }
    return false;
  };
  return bSeats.every((_, bi) => augment(bi, new Array(pSeats.length).fill(false)));
}

function dominates(P: any, B: any, context: any = {}): boolean {
  if (!isObject(P) || !isObject(B) || !isObject(context)) return false;
  const { tiers, synthesizerStrength } = context;
  if (!Array.isArray(tiers) || !isObject(synthesizerStrength)) return false;
  const tierRank: Record<string, number> = Object.fromEntries(tiers.map((tier: string, i: number) => [tier, i]));

  if (P.kind !== B.kind || P.decider !== B.decider) return false;
  if (!Array.isArray(P.seats) || !Array.isArray(B.seats) || !seatsMatch(P.seats, B.seats, tierRank)) return false;
  if (!isObject(P.rounds) || !isObject(B.rounds)) return false;
  for (const field of ['default', 'min']) {
    if (!Number.isInteger(P.rounds[field]) || !Number.isInteger(B.rounds[field]) || P.rounds[field] < B.rounds[field]) return false;
  }
  if (B.crossAnswer === true && P.crossAnswer !== true) return false;
  const pSynth = rankOf(synthesizerStrength, P.synthesizer);
  const bSynth = rankOf(synthesizerStrength, B.synthesizer);
  return pSynth !== null && bSynth !== null && pSynth >= bSynth;
}

module.exports = { dominates };
