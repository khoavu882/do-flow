'use strict';

// 119 IC-003: the pure protocol resolver. Given the change facts (class, risk, changed paths), the run's
// preset and the loaded registries, it picks the review or debate protocol and says where each value came
// from. No filesystem, git or process: the caller loads the inputs (start.ts `loadProtocolInputs`).

const { presetIds } = require('./protocols.ts');

type Origin = 'registry' | 'risk' | 'advice' | 'run' | 'floor';
type Refusal = { ok: false; reason: 'preset-unknown' | 'preset-looser' | 'registry-incomplete'; field: string };

const DEBATE_DEFAULT = 'debate-2';

/** Whether `riskPolicy.lightPaths` covers `file`: a `/`-ending entry covers its subtree, any other entry that exact path. */
function lightCovers(lightPaths: string[], file: string): boolean {
  const normal = String(file).replace(/^(\.\/)+/, '');
  return lightPaths.some((entry) => (entry.endsWith('/') ? normal.startsWith(entry) : normal === entry));
}

/**
 * The scope of a change: `light` when every path is covered by `lightPaths`, `code` otherwise, `unknown` when
 * the list is unreadable (null) or empty (the base resolved to HEAD; the verb does not know what the review covers).
 * A rename is two entries, so it counts both paths.
 */
function pathScope(riskPolicy: any, paths: string[] | null): 'light' | 'code' | 'unknown' {
  if (!Array.isArray(paths) || paths.length === 0) return 'unknown';
  return paths.every((file) => lightCovers(riskPolicy.lightPaths, file)) ? 'light' : 'code';
}

/** The gate-b `minSeats` of a class from a loaded gate policy; 0 when there is none. */
function gateMinSeats(gatePolicy: any, taskClass: string | null): number {
  if (!gatePolicy || !taskClass) return 0;
  const floor = gatePolicy.classes?.[taskClass]?.['gate-b']?.minSeats;
  return Number.isInteger(floor) && floor > 0 ? floor : 0;
}

/** The review preset id carrying a depth label, or undefined. */
function idOfDepth(registry: any, depth: string): string | undefined {
  return presetIds(registry, 'review').find((id: string) => registry.presets[id].depth === depth);
}

/**
 * IC-003 steps 1-5 (settings and knobs are phase B; step 2 reads no key from `settingsView` yet).
 * Returns `{ ok: true, protocol }` or `{ ok: false, reason, field }`.
 */
function resolveProtocol({ kind, taskClass, risk, paths, runPreset, advicePick, settingsView, gatePolicy, registry, riskPolicy }: any):
  { ok: true; protocol: any } | Refusal {
  void settingsView;
  const order: string[] = presetIds(registry, kind);
  let id: string | undefined;
  let idOrigin: Origin = 'registry';

  // Step 1: the risk rule picks the review preset (as the old decideDepth did); a debate starts at debate-2.
  if (kind === 'review') {
    const single = pathScope(riskPolicy, paths) === 'light' && typeof risk === 'string' && riskPolicy.singleRisks.includes(risk);
    id = idOfDepth(registry, single ? 'single' : 'deep');
    idOrigin = 'risk';
    // Advice only raises: a deep pick over a decided single gives deep; any other pick changes nothing.
    if (advicePick === 'deep' && single) {
      id = idOfDepth(registry, 'deep');
      idOrigin = 'advice';
    }
  } else id = DEBATE_DEFAULT;
  if (id === undefined || !order.includes(id)) return { ok: false, reason: 'registry-incomplete', field: 'registry' };

  // Step 3: the run preset must exist for this kind and be at least as strict as the pick.
  if (runPreset !== undefined && runPreset !== null) {
    if (typeof runPreset !== 'string' || !Object.hasOwn(registry.presets, runPreset) || registry.presets[runPreset].kind !== kind) {
      return { ok: false, reason: 'preset-unknown', field: 'preset' };
    }
    if (order.indexOf(runPreset) > order.indexOf(id)) return { ok: false, reason: 'preset-looser', field: 'preset' };
    id = runPreset;
    idOrigin = 'run';
  }

  // Step 5: the class seat floor. A pick with fewer seats takes the next stricter preset that has enough;
  // when none has, the strictest preset gains copies of its last seat (L-4).
  let seats: any[] = registry.presets[id].seats.map((seat: any) => structuredClone(seat));
  let seatsOrigin: Origin = 'registry';
  const needed = kind === 'review' ? gateMinSeats(gatePolicy, taskClass) : 0;
  if (seats.length < needed) {
    const stricter = order.slice(0, order.indexOf(id)).reverse().find((candidate) => registry.presets[candidate].seats.length >= needed);
    idOrigin = 'floor';
    if (stricter !== undefined) {
      id = stricter;
      seats = registry.presets[id].seats.map((seat: any) => structuredClone(seat));
    } else {
      id = order[0];
      seats = registry.presets[id].seats.map((seat: any) => structuredClone(seat));
      while (seats.length < needed) seats.push({ ...structuredClone(seats[seats.length - 1]), id: `floor-${seats.length + 1}` });
      seatsOrigin = 'floor';
    }
  }

  const preset = registry.presets[id];
  const protocol: any = { id, kind };
  if (kind === 'review') protocol.depth = preset.depth;
  Object.assign(protocol, {
    seats,
    // Step 4 knobs are phase B: the registry defaults, each labelled `registry`.
    rounds: preset.rounds.default,
    crossAnswer: preset.crossAnswer,
    synthesizer: preset.synthesizer,
    decider: preset.decider,
    lensesBySeat: Object.fromEntries(seats.map((seat: any) => [seat.id, [...(seat.lenses ?? [])]])),
    blockerClauses: [],
    sameFamily: 'warn',
    crossFamilyRereview: 'on',
    rereview: 'automatic',
    invariants: registry.invariants.map((inv: any) => inv.id),
    origins: {
      id: idOrigin, seats: seatsOrigin, rounds: 'registry', lenses: 'registry', blockerClauses: 'registry',
      sameFamily: 'registry', crossFamilyRereview: 'registry',
    },
    enforcement: [],
  });
  return { ok: true, protocol };
}

/** A few compact lines for the text form of a resolved protocol (`review --action start`, `protocol`). */
function protocolLines(protocol: any): string[] {
  return [
    `protocol: id=${protocol.id} rounds=${protocol.rounds} crossAnswer=${protocol.crossAnswer} synthesizer=${protocol.synthesizer} decider=${protocol.decider} rereview=${protocol.rereview}`,
    `protocol.seats: ${protocol.seats.map((seat: any) => `${seat.id}[${(protocol.lensesBySeat[seat.id] ?? []).join(',')}]`).join(' ')}`,
    `protocol.origins: ${Object.entries(protocol.origins).map(([field, origin]) => `${field}=${origin}`).join(' ')}`,
    `protocol.invariants: ${protocol.invariants.join(',')}`,
  ];
}

module.exports = { resolveProtocol, protocolLines, pathScope, gateMinSeats };
