'use strict';

// 119 IC-003: the pure protocol resolver. Given the change facts (class, risk, changed paths), the run's
// preset and the loaded registries, it picks the review or debate protocol and says where each value came
// from. No filesystem, git or process: the caller loads the inputs (start.ts `loadProtocolInputs`), the
// settings among them as a plain `settingsView` ({ '<key>': { value, layer } }, an absent key = default).

const nodeCrypto = require('node:crypto');
const { presetIds } = require('./protocols.ts');

type Origin = 'registry' | 'risk' | 'advice' | 'run' | 'floor' | 'user' | 'project' | 'local' | 'env';
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

/** The setting `key` from a settings view when a non-default layer set it, else null. */
function setBy(settingsView: any, key: string): { value: any; layer: Origin } | null {
  const entry = settingsView?.[key];
  return entry && entry.layer !== undefined && entry.layer !== 'default' ? entry : null;
}

/**
 * IC-003, in this order: (1) the risk rule, (2) the preset setting, (3) the run preset (Q-A1: compared with the
 * pick of steps 1-2; advice raises only when there is no run preset), (4) advice, (5) the seat floor, (6) the knobs
 * of a review. A setting is never a refusal: a looser preset setting is ignored and listed in `disagreements`.
 * Returns `{ ok: true, protocol }` or `{ ok: false, reason, field }`.
 */
function resolveProtocol({ kind, taskClass, risk, paths, runPreset, advicePick, settingsView, gatePolicy, registry, riskPolicy }: any):
  { ok: true; protocol: any } | Refusal {
  const order: string[] = presetIds(registry, kind);
  const disagreements: any[] = [];
  let id: string | undefined;
  let idOrigin: Origin = 'registry';

  // Step 1: the risk rule picks the review preset (as the old decideDepth did); a debate starts at debate-2.
  if (kind === 'review') {
    const single = pathScope(riskPolicy, paths) === 'light' && typeof risk === 'string' && riskPolicy.singleRisks.includes(risk);
    id = idOfDepth(registry, single ? 'single' : 'deep');
    idOrigin = 'risk';
  } else id = DEBATE_DEFAULT;
  if (id === undefined || !order.includes(id)) return { ok: false, reason: 'registry-incomplete', field: 'registry' };

  // Step 2: the preset setting. `auto` and the default leave the pick; a stricter id is taken with its layer as
  // origin; an equal one changes nothing; a looser one is ignored and shown as a disagreement.
  const preset = setBy(settingsView, kind === 'review' ? 'review.preset' : 'debate.preset');
  if (preset && typeof preset.value === 'string' && preset.value !== 'auto' && order.includes(preset.value)) {
    const at = order.indexOf(preset.value);
    if (at < order.indexOf(id)) {
      id = preset.value;
      idOrigin = preset.layer;
    } else if (at > order.indexOf(id)) disagreements.push({ field: 'id', by: preset.layer, value: preset.value, reason: 'looser' });
  }

  // Advice only raises: a deep pick over a single pick gives deep.
  const adviceId: string | undefined = kind === 'review' && advicePick === 'deep' && registry.presets[id].depth === 'single'
    ? idOfDepth(registry, 'deep') : undefined;

  // Step 3: the run preset must exist for this kind and be at least as strict as the pick of steps 1-2. It wins
  // over advice (Q-A1): an advice raise above it is not applied and is shown as a disagreement.
  if (runPreset !== undefined && runPreset !== null) {
    if (typeof runPreset !== 'string' || !Object.hasOwn(registry.presets, runPreset) || registry.presets[runPreset].kind !== kind) {
      return { ok: false, reason: 'preset-unknown', field: 'preset' };
    }
    if (order.indexOf(runPreset) > order.indexOf(id)) return { ok: false, reason: 'preset-looser', field: 'preset' };
    id = runPreset;
    idOrigin = 'run';
    if (adviceId !== undefined && order.indexOf(adviceId) < order.indexOf(id)) {
      disagreements.push({ field: 'id', by: 'advice', value: adviceId, reason: 'run-preset' });
    }
  } else if (adviceId !== undefined) {
    id = adviceId;
    idOrigin = 'advice';
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

  const chosen = registry.presets[id];
  const protocol: any = { id, kind };
  if (kind === 'review') protocol.depth = chosen.depth;

  // Step 6: the knobs of a review, applied to the final preset. A debate keeps its preset's values.
  let rounds: number = chosen.rounds.default;
  let roundsOrigin: Origin = 'registry';
  let lensesOrigin: Origin = 'registry';
  let blockersOrigin: Origin = 'registry';
  let sameFamily = 'warn';
  let sameFamilyOrigin: Origin = 'registry';
  let crossFamilyRereview = 'on';
  let crossFamilyOrigin: Origin = 'registry';
  let blockerClauses: string[] = [];
  if (kind === 'review') {
    const wanted = setBy(settingsView, 'review.rounds');
    if (wanted && Number.isInteger(wanted.value)) {
      const reason = wanted.value < chosen.rounds.min ? 'below-min' : wanted.value > registry.hardRoundCap ? 'above-cap' : null;
      if (reason === null) {
        rounds = wanted.value;
        roundsOrigin = wanted.layer;
      } else disagreements.push({ field: 'rounds', by: wanted.layer, value: wanted.value, reason });
    }
    const lenses = setBy(settingsView, 'review.extraLenses');
    if (lenses && Array.isArray(lenses.value) && lenses.value.length > 0) {
      for (const seat of seats) seat.lenses = [...(seat.lenses ?? []), ...lenses.value.filter((lens: string) => !(seat.lenses ?? []).includes(lens))];
      lensesOrigin = lenses.layer;
    }
    const clauses = setBy(settingsView, 'review.blockerClauses');
    if (clauses && Array.isArray(clauses.value) && clauses.value.length > 0) {
      blockerClauses = [...clauses.value];
      blockersOrigin = clauses.layer;
    }
    const family = setBy(settingsView, 'review.sameFamily');
    if (family && (family.value === 'refuse' || family.value === 'warn')) {
      sameFamily = family.value;
      sameFamilyOrigin = family.layer;
    }
    const rereview = setBy(settingsView, 'review.crossFamilyRereview');
    if (rereview && (rereview.value === 'on' || rereview.value === 'off')) {
      crossFamilyRereview = rereview.value;
      crossFamilyOrigin = rereview.layer;
    }
  }
  Object.assign(protocol, {
    seats,
    rounds,
    crossAnswer: chosen.crossAnswer,
    synthesizer: chosen.synthesizer,
    decider: chosen.decider,
    lensesBySeat: Object.fromEntries(seats.map((seat: any) => [seat.id, [...(seat.lenses ?? [])]])),
    blockerClauses,
    sameFamily,
    crossFamilyRereview,
    rereview: 'automatic',
    invariants: registry.invariants.map((inv: any) => inv.id),
    origins: {
      id: idOrigin, seats: seatsOrigin, rounds: roundsOrigin, lenses: lensesOrigin, blockerClauses: blockersOrigin,
      sameFamily: sameFamilyOrigin, crossFamilyRereview: crossFamilyOrigin,
    },
    disagreements,
    enforcement: [],
  });
  return { ok: true, protocol };
}

/** `value` as JSON with object keys sorted at every depth (arrays keep their order). */
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 119 Q-A2 / IC-002: the sha256 hex of the resolved protocol's canonical JSON; a findings record's `protocol.digest`. */
function protocolDigest(protocol: any): string {
  return nodeCrypto.createHash('sha256').update(canonicalJson(protocol)).digest('hex');
}

/** A few compact lines for the text form of a resolved protocol (`review --action start`, `protocol`). */
function protocolLines(protocol: any): string[] {
  return [
    `protocol: id=${protocol.id} rounds=${protocol.rounds} crossAnswer=${protocol.crossAnswer} synthesizer=${protocol.synthesizer} decider=${protocol.decider} rereview=${protocol.rereview}`,
    `protocol.seats: ${protocol.seats.map((seat: any) => `${seat.id}[${(protocol.lensesBySeat[seat.id] ?? []).join(',')}]`).join(' ')}`,
    `protocol.origins: ${Object.entries(protocol.origins).map(([field, origin]) => `${field}=${origin}`).join(' ')}`,
    `protocol.invariants: ${protocol.invariants.join(',')}`,
    ...(protocol.disagreements?.length
      ? [`protocol.disagreements: ${protocol.disagreements.map((d: any) => `field=${d.field} by=${d.by} value=${d.value} reason=${d.reason}`).join('; ')}`]
      : []),
  ];
}

module.exports = { resolveProtocol, protocolLines, protocolDigest, pathScope, gateMinSeats };
