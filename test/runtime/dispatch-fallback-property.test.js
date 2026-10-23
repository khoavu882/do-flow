'use strict';

// Feature 106 review R-1..R-3 (IC-004, FR-004 to FR-006; D-ORCH re-review decisions): a bounded
// exhaustive enumeration of the pure `selectMode` over owners x task-line tiers x rung readiness x
// exhausted rungs x the task's last dispatch x fallback modes x acceptances, on a 3-rung ladder plus
// one eligible harness outside it. No sandbox, no I/O: the candidate cache is prefilled. The oracle
// below is written from the decisions, not from loop.ts, and every case is checked against six
// invariants:
//   1. a no-step task (resolved tier frontier, review owner, unknown owner) never runs on another
//      harness than its quota dispatch's after a quota, in any mode;
//   2. never an exhausted rung, never a rung outside the ladder;
//   3. never `sequential` when the task changes rung (after a quota, or past an exhausted rung);
//   4. a rung change happens only in `auto`, or in off/ask with an accepted rung equal to the chosen
//      one, and always carries `selection.fallback.kind === 'step'`; no step without a change;
//   5. with nothing exhausted and no quota, the pre-106 rule (launch shortcut, first eligible, else
//      sequential);
//   6. (118 IC-009) in auto, a task that may step does step to the first eligible rung on a rung
//      change, so a quality-guardian task at a light or standard tier is no longer held as review.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const loop = require(path.join(REPO, 'src', 'runtime', 'dispatch', 'loop.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));

const TIERS = loadRegistry({ repoRoot: REPO }).dispatchTiers;
const REGISTRY = { dispatchTiers: TIERS };
const LADDER = Object.freeze(['C', 'A', 'B']);
/** Registry order; `D` is always eligible and never on the ladder. */
const RUNGS = Object.freeze(['A', 'B', 'C']);
const OWNERS = Object.freeze(['system-architect', 'quality-guardian', 'reviewer', 'Reviewer', 'core-implementer', 'not-an-owner', 'System-Architect']);
const TASK_TIERS = Object.freeze([null, 'light', 'standard', 'frontier', 'ultra']);
const MODES = Object.freeze(['off', 'ask', 'auto']);
const LASTS = Object.freeze([null, ...RUNGS.flatMap((h) => ['quota', 'verification', 'launch'].map((failureClass) => ({ harness: h, failureClass, token: 1 })))]);
const subsets = (xs) => xs.reduce((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

/** The decisions' no-step rule: a valid task-line tier wins over the owner's; frontier, the review
 * archetype and an owner dispatchTiers does not list (any case) never step. */
function noStep(owner, tier) {
  const valid = typeof tier === 'string' && TIERS.tiers.includes(tier);
  if (valid && tier === 'frontier') return true;
  const key = typeof owner === 'string' ? owner.trim().toLowerCase() : '';
  const match = Object.keys(TIERS.byOwner).find((name) => name.toLowerCase() === key);
  if (!match) return true;
  if ((valid ? tier : TIERS.byOwner[match]) === 'frontier') return true;
  return match === 'reviewer';
}

test('106 property: selectMode keeps the six fallback invariants over the bounded state space', (t) => {
  const started = Date.now();
  const broken = new Map();
  const fail = (rule, example) => {
    const seen = broken.get(rule);
    if (seen) seen.n += 1; else broken.set(rule, { n: 1, example });
  };
  let cases = 0;
  for (const owner of OWNERS) for (const tier of TASK_TIERS) for (const ready of subsets(RUNGS)) for (const exhausted of subsets(RUNGS))
  for (const last of LASTS) for (const mode of MODES) for (const acceptance of ['none', 'chosen', 'other']) {
    const afterQuota = Boolean(last && last.failureClass === 'quota');
    if (afterQuota && !exhausted.includes(last.harness)) continue; // in a run, a quota-ed rung is exhausted
    const firstOk = LADDER.find((h) => !exhausted.includes(h) && ready.includes(h)) ?? null;
    const before = firstOk ? LADDER.slice(0, LADDER.indexOf(firstOk)) : LADDER;
    const passed = before.some((h) => exhausted.includes(h));
    const stays = !afterQuota && Boolean(last) && firstOk !== null && last.harness === firstOk;
    const change = afterQuota || (passed && !stays);
    const acceptedRung = acceptance === 'chosen' ? (firstOk ?? 'A') : acceptance === 'other' ? LADDER.find((h) => h !== firstOk) : undefined;
    const lastFailureClass = last && last.failureClass === 'launch' ? 'launch' : null;
    const candidates = [...RUNGS.map((h) => ({ harness: h, eligible: ready.includes(h), gaps: [] })), { harness: 'D', eligible: true, gaps: [] }];
    const fallback = {
      mode, ladder: [...LADDER], exhausted, holds: {}, events: [], eventsDropped: 0,
      ...(acceptedRung === undefined ? {} : { accepted: { 'A.1': acceptedRung } }),
    };
    const r = loop.selectMode({ policy: 'auto', registry: REGISTRY, cache: { candidates }, task: 'A.1', last, lastFailureClass, owner, tier, fallback });
    cases += 1;
    const example = { owner, tier, ready, exhausted, last, mode, acceptedRung, result: r.hold ? { hold: r.hold } : { mode: r.mode, harness: r.harness, fallback: r.selection.fallback } };
    const ran = r.mode === 'subagent' ? r.harness : null;
    const step = r.selection && r.selection.fallback;
    // 1
    if (noStep(owner, tier) && afterQuota && ran !== null && ran !== last.harness) fail('1 no-step task moved after a quota', example);
    // 2
    if (ran !== null && (exhausted.includes(ran) || !LADDER.includes(ran))) fail('2 exhausted or off-ladder rung', example);
    // 3
    if (change && r.mode === 'sequential') fail('3 sequential on a rung change', example);
    // 4
    if (change && ran !== null && !(!noStep(owner, tier) && (mode === 'auto' || acceptedRung === ran) && step && step.kind === 'step')) fail('4 rung change without auto, a matching acceptance or a step', example);
    if (step && !change) fail('4 step without a rung change', example);
    // 6
    if (!noStep(owner, tier) && change && mode === 'auto' && firstOk !== null && ran !== firstOk) fail('6 a may-step task did not step in auto', example);
    // 5
    if (!exhausted.length && !afterQuota) {
      const want = lastFailureClass === 'launch' || firstOk === null ? { mode: 'sequential', harness: null } : { mode: 'subagent', harness: firstOk };
      if (r.hold || r.mode !== want.mode || r.harness !== want.harness || step) fail('5 differs from the pre-106 rule', example);
    }
  }
  const ms = Date.now() - started;
  t.diagnostic(`${cases} cases in ${ms} ms`);
  assert.ok(cases > 100000, `${cases} cases`);
  assert.deepEqual([...broken].map(([rule, v]) => `${rule}: ${v.n} case(s), e.g. ${JSON.stringify(v.example)}`), []);
});
