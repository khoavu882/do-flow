'use strict';

// 119 IC-003: the pure protocol resolver. Given the change facts (class, risk, changed paths), the run's
// preset and the loaded registries, it picks the review or debate protocol and says where each value came
// from. No filesystem, git or process: the caller loads the inputs (start.ts `loadProtocolInputs`), the
// settings among them as a plain `settingsView` ({ '<key>': { value, layer } }, an absent key = default).

const nodeCrypto = require('node:crypto');
const { presetIds, coreTiers } = require('./protocols.ts');
const { dominates } = require('./dominance.ts');

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

/**
 * 119 FR-008: one `{ agent, harness, status, reason }` row per read-only seat agent (seat order, each once) x harness
 * (registry order). `agentAccess` is `{ <agent>: 'read-only'|'write'|'unknown' }`, `readOnlyLimits` the ordered
 * `[{ harness, status, reason }]` the caller loaded; a caller that passes neither gets no rows. An agent whose access
 * is unknown (absent counts as unknown) gets rows too, `status: unknown` with the reason, so a seat whose access the
 * runtime cannot read is reported as such rather than dropped like a write agent.
 */
function enforcementRows(seats: any[], agentAccess: any, readOnlyLimits: any): any[] {
  if (!agentAccess || !Array.isArray(readOnlyLimits)) return [];
  const access = (agent: string) => (agentAccess[agent] === 'read-only' || agentAccess[agent] === 'write' ? agentAccess[agent] : 'unknown');
  const agents = [...new Set<string>(seats.map((seat: any) => seat.agent))].filter((agent) => access(agent) !== 'write');
  return agents.flatMap((agent) => readOnlyLimits.map((limit: any) => (access(agent) === 'read-only'
    ? { agent, harness: limit.harness, status: limit.status, reason: limit.reason ?? null }
    : { agent, harness: limit.harness, status: 'unknown', reason: `the access of agent '${agent}' is not declared in core/registry/workflows.json agents.access` })));
}

/** The review preset id carrying a depth label, or undefined. */
function idOfDepth(registry: any, depth: string): string | undefined {
  return presetIds(registry, 'review').find((id: string) => registry.presets[id].depth === depth);
}

/** The preset `id` of `kind` in the merged registry (core or an active package's), or null when it is not available. */
function presetOf(registry: any, kind: string, id: any): any {
  return typeof id === 'string' && Object.hasOwn(registry.presets ?? {}, id) && registry.presets[id]?.kind === kind ? registry.presets[id] : null;
}

/**
 * 122 IC-014: true when the available preset `a` is at least as strict as `b`, both of `kind`. Two ids of the effective
 * core order compare by their place in it; any other pair (a contributed id on either side) by `dominates`, so no
 * `indexOf` of -1 is ever read as a rank. An id that is not available is never at least as strict.
 */
function atLeastAsStrict(registry: any, kind: string, a: string, b: string): boolean {
  const order: string[] = presetIds(registry, kind);
  if (order.includes(a) && order.includes(b)) return order.indexOf(a) <= order.indexOf(b);
  const pa = presetOf(registry, kind, a);
  const pb = presetOf(registry, kind, b);
  return pa !== null && pb !== null && dominates(pa, pb, { tiers: coreTiers(), synthesizerStrength: registry.synthesizerStrength });
}

/** The setting `key` from a settings view when a non-default layer set it, else null. */
function setBy(settingsView: any, key: string): { value: any; layer: Origin } | null {
  const entry = settingsView?.[key];
  return entry && entry.layer !== undefined && entry.layer !== 'default' ? entry : null;
}

/**
 * IC-003 step 2, shared with the prepared-run check (119 C-3): the preset setting applied to a `pick`
 * (`{ id, origin }`). `auto` and the default leave the pick; a stricter id is taken with its layer
 * as origin; an equal one changes nothing, except that a debate (whose pick is the registry default) then names
 * the layer that decided it (C-11); a looser one is ignored and returned as `disagreement`. 122 IC-014: an id that is
 * not available (unknown, or its package disabled, suspended or incompatible) leaves the pick with the disagreement
 * `unavailable`; a contributed id is taken only when it dominates the pick, else `not-dominant`. Pure apart from the
 * core tiers a dominance comparison reads (models.json, once per process).
 */
function settingsPick({ kind, pick, settingsView, registry }: { kind: string; pick: { id: string; origin: Origin }; settingsView: any; registry: any }):
  { id: string; origin: Origin; disagreement?: any } {
  const order: string[] = presetIds(registry, kind);
  const preset = setBy(settingsView, kind === 'review' ? 'review.preset' : 'debate.preset');
  if (!preset || typeof preset.value !== 'string' || preset.value === 'auto') return { ...pick };
  if (presetOf(registry, kind, preset.value) === null) {
    return { ...pick, disagreement: { field: 'id', by: preset.layer, value: preset.value, reason: 'unavailable' } };
  }
  if (!order.includes(preset.value) || !order.includes(pick.id)) {
    return atLeastAsStrict(registry, kind, preset.value, pick.id) ? { id: preset.value, origin: preset.layer }
      : { ...pick, disagreement: { field: 'id', by: preset.layer, value: preset.value, reason: 'not-dominant' } };
  }
  const at = order.indexOf(preset.value);
  const from = order.indexOf(pick.id);
  if (at < from || (at === from && kind === 'debate')) return { id: preset.value, origin: preset.layer };
  if (at > from) return { ...pick, disagreement: { field: 'id', by: preset.layer, value: preset.value, reason: 'looser' } };
  return { ...pick };
}

/**
 * IC-003, in this order: (1) the start pick (the risk rule under `auto`, else the thin default), (2) the preset setting, (3) the run preset (Q-A1: compared with the
 * pick of steps 1-2; advice raises only when there is no run preset), (4) advice, (5) the seat floor, (6) the knobs
 * of a review. A setting is never a refusal: a looser preset setting is ignored and listed in `disagreements`.
 * Returns `{ ok: true, protocol }` or `{ ok: false, reason, field }`.
 */
function resolveProtocol({ kind, taskClass, risk, paths, runPreset, advicePick, settingsView, gatePolicy, unattended, registry, riskPolicy, agentAccess, readOnlyLimits }: any):
  { ok: true; protocol: any } | Refusal {
  const order: string[] = presetIds(registry, kind);
  const disagreements: any[] = [];
  let id: string | undefined;
  let idOrigin: Origin = 'registry';

  // Step 1 (maint-thin): a review starts thin. Only an effective `review.preset` of `auto` runs the risk rule (as the
  // old decideDepth did); otherwise the pick starts at the default-layer preset (the registry default, review-single)
  // or, with no entry at all, the loosest core preset, and step 2 raises it to a stricter preset a layer set. A preset
  // id this install does not have never reaches here from a run: loadProtocolInputs refuses it (settings-unavailable),
  // so the review is blocked, which fails closed. A debate starts at debate-2.
  if (kind === 'review') {
    const entry = settingsView?.['review.preset'];
    if (entry?.value === 'auto') {
      const single = pathScope(riskPolicy, paths) === 'light' && typeof risk === 'string' && riskPolicy.singleRisks.includes(risk);
      id = idOfDepth(registry, single ? 'single' : 'deep');
      idOrigin = 'risk';
    } else {
      const shipped = entry && !setBy(settingsView, 'review.preset') && typeof entry.value === 'string' && order.includes(entry.value) ? entry.value : undefined;
      id = shipped ?? order[order.length - 1];
    }
  } else id = DEBATE_DEFAULT;
  if (id === undefined || !order.includes(id)) return { ok: false, reason: 'registry-incomplete', field: 'registry' };

  // Step 2: the preset setting (settingsPick).
  const picked = settingsPick({ kind, pick: { id, origin: idOrigin }, settingsView, registry });
  // The core pick of steps 1-2: what the seat floor falls back to when a contributed pick has too few seats (IC-014).
  const corePick: string = order.includes(picked.id) ? picked.id : id;
  id = picked.id;
  idOrigin = picked.origin;
  if (picked.disagreement) disagreements.push(picked.disagreement);

  // Advice only raises: a deep pick over a single pick gives deep.
  const adviceId: string | undefined = kind === 'review' && advicePick === 'deep' && registry.presets[id].depth === 'single'
    ? idOfDepth(registry, 'deep') : undefined;

  // Step 3: the run preset must exist for this kind and be at least as strict as the pick of steps 1-2 (a contributed
  // one: dominate it). It wins over advice (Q-A1): an advice raise above it is not applied and is shown as a disagreement.
  if (runPreset !== undefined && runPreset !== null) {
    if (typeof runPreset !== 'string' || presetOf(registry, kind, runPreset) === null) return { ok: false, reason: 'preset-unknown', field: 'preset' };
    if (!atLeastAsStrict(registry, kind, runPreset, id)) return { ok: false, reason: 'preset-looser', field: 'preset' };
    id = runPreset;
    idOrigin = 'run';
    if (adviceId !== undefined && !atLeastAsStrict(registry, kind, runPreset, adviceId)) {
      disagreements.push({ field: 'id', by: 'advice', value: adviceId, reason: 'run-preset' });
    }
  } else if (adviceId !== undefined) {
    id = adviceId;
    idOrigin = 'advice';
  }
  // Step 5: the class seat floor. A pick with fewer seats takes the next stricter preset that has enough;
  // when none has, the strictest preset gains copies of its last seat (L-4). The walk reads the core order only: a
  // contributed pick with too few seats first falls back to the core pick of steps 1-2 (IC-014), with a disagreement.
  let seats: any[] = registry.presets[id].seats.map((seat: any) => structuredClone(seat));
  let seatsOrigin: Origin = 'registry';
  // maint-thin: the class floor binds only a review nobody attends (`unattended`: the autopilot switch is on, so its
  // policy gate-b may decide the merge); a person-attended review follows the preset. Omitted reads as unattended.
  const needed = kind === 'review' && unattended !== false ? gateMinSeats(gatePolicy, taskClass) : 0;
  if (seats.length < needed && !order.includes(id)) {
    disagreements.push({ field: 'id', by: 'floor', value: id, reason: 'seat-floor' });
    id = corePick;
    idOrigin = 'floor';
    seats = registry.presets[id].seats.map((seat: any) => structuredClone(seat));
  }
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
  if (kind === 'review' && chosen.depth !== undefined) protocol.depth = chosen.depth; // a contributed preset has no depth label

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
    invariants: registry.invariants.filter((inv: any) => (inv.kinds ?? ['review']).includes(kind)).map((inv: any) => inv.id),
    origins: {
      id: idOrigin, seats: seatsOrigin, rounds: roundsOrigin, lenses: lensesOrigin, blockerClauses: blockersOrigin,
      sameFamily: sameFamilyOrigin, crossFamilyRereview: crossFamilyOrigin,
    },
    disagreements,
    enforcement: enforcementRows(seats, agentAccess, readOnlyLimits),
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
    ...[...new Set<string>((protocol.enforcement ?? []).map((row: any) => row.agent))].map((agent) => {
      const rows = protocol.enforcement.filter((row: any) => row.agent === agent);
      const ids = (status: string) => rows.filter((row: any) => row.status === status).map((row: any) => row.harness).join(',');
      return `protocol.enforcement: ${agent} native=${ids('native')} unenforced=${ids('unenforced')}${ids('unknown') ? ` unknown=${ids('unknown')}` : ''}`;
    }),
    // A review's rule values and the project's blocker clauses, in full (C-5); a debate has none. A control
    // character in a clause is escaped (\u00XX) so a clause cannot start a forged protocol line.
    ...(protocol.kind === 'review'
      ? [`protocol.rules: sameFamily=${protocol.sameFamily} crossFamilyRereview=${protocol.crossFamilyRereview}`,
        ...protocol.blockerClauses.map((clause: string) => `protocol.blocker: ${clause.replace(/\p{Cc}/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`)]
      : []),
    ...(protocol.disagreements?.length
      ? [`protocol.disagreements: ${protocol.disagreements.map((d: any) => `field=${d.field} by=${d.by} value=${d.value} reason=${d.reason}`).join('; ')}`]
      : []),
  ];
}

module.exports = { resolveProtocol, settingsPick, atLeastAsStrict, protocolLines, protocolDigest, pathScope, gateMinSeats };
