'use strict';

// Hand-written one-task model, independent of src/runtime helpers. Source behaviors: claim and
// claimChecks/claimWrite (src/runtime/task-attempts.ts:307-382, 392-436), finish (:459-497),
// cancel (:623-640), cancelAttempt (src/runtime/task-run.ts:335-356), refusedControl (:250-252).
const MODEL_VERSION = '117-B.2';

function clone(state: any) {
  return state ? { nextToken: state.nextToken, attempts: state.attempts.map((a: any) => ({ ...a })) } : { nextToken: 1, attempts: [] };
}
function initial(scenario: any) {
  return scenario === 'S1'
    ? { nextToken: 2, attempts: [{ token: 1, state: 'active', result: null }] }
    : { nextToken: 1, attempts: [] };
}
function apply(state: any, op: any, args: any = {}) {
  const next = clone(state);
  const entry = next.attempts;
  let response;
  if (op === 'claim') {
    const active = entry.find((a: any) => a.state === 'active');
    // claimChecks :335-339 refuses a task whose latest record is CANCELLED until a resume clears it.
    const last = entry.reduce((a: any, b: any) => (!a || b.token > a.token ? b : a), null);
    if (active) response = { disposition: 'refused', reason: 'active-attempt', activeToken: active.token };
    else if (last && last.state === 'cancelled') response = { disposition: 'refused', reason: 'cancelled' };
    else {
      const token = next.nextToken++;
      entry.push({ token, state: 'active', result: null });
      response = { disposition: 'claimed', token };
    }
  } else if (op === 'finish') {
    const cancelled = entry.find((a: any) => a.token === args.token && a.state === 'cancelled');
    const active = entry.find((a: any) => a.state === 'active');
    if (cancelled) response = { disposition: 'stale', token: args.token, reason: 'attempt-cancelled' };
    else if (!active) response = { disposition: 'stale', token: args.token, reason: 'no-active-attempt' };
    else if (active.token !== args.token) response = { disposition: 'stale', token: args.token, reason: 'token-mismatch' };
    else {
      active.state = 'finished'; active.result = args.result;
      response = { disposition: 'applied', token: args.token, result: args.result };
    }
  } else if (op === 'cancel') {
    const active = entry.find((a: any) => a.state === 'active');
    if (!active) response = { disposition: 'refused', token: args.token, reason: 'no-active-attempt' };
    else if (active.token !== args.token) response = { disposition: 'refused', token: args.token, reason: 'token-mismatch', activeToken: active.token };
    else {
      active.state = 'cancelled'; active.cancel = { by: args.by || 'lead', reason: args.reason || 'stop' };
      response = { disposition: 'cancelled', token: args.token };
    }
  } else throw new TypeError(`unknown operation: ${op}`);
  return { response, state: next };
}
const model = { initial, apply };

function sameResponse(actual: any, expected: any) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) || !expected || typeof expected !== 'object') return false;
  const required = ({
    claimed: ['disposition', 'token'],
    refused: ['disposition', 'reason'],
    applied: ['disposition', 'token', 'result'],
    stale: ['disposition', 'token', 'reason'],
    cancelled: ['disposition', 'token'],
  } as any)[expected.disposition];
  if (!required || required.some((key: any) => !(key in actual) || actual[key] !== expected[key])) return false;
  if (expected.disposition === 'refused' && expected.reason === 'active-attempt' &&
      (!('activeToken' in actual) || actual.activeToken !== expected.activeToken)) return false;
  const fields = ['disposition', 'reason', 'token', 'activeToken', 'result'];
  return fields.every((key) => {
    if (!(key in actual)) return true;
    return Object.prototype.hasOwnProperty.call(expected, key) && actual[key] === expected[key];
  });
}
function recordOf(value: any) { return value ? { nextToken: value.nextToken, attempts: value.attempts || [] } : { nextToken: 1, attempts: [] }; }
function sameRecord(actual: any, expected: any) {
  const a = recordOf(actual); const e = recordOf(expected);
  if (a.nextToken !== e.nextToken || a.attempts.length !== e.attempts.length) return false;
  return a.attempts.every((attempt: any, i: any) => {
    const other = e.attempts[i];
    return attempt.token === other.token && attempt.state === other.state && attempt.result === other.result && ('cancel' in attempt) === ('cancel' in other);
  });
}
function verdict(verdict: any, klass: any, detail: any, extra = {}) { return { verdict, class: klass, underlying: null, cause: null, order: null, detail, ...extra }; }
function classify(observation: any) {
  const actors = observation.actors;
  const claimed = actors.filter((a: any) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'claimed');
  // One task, two claimers: the model never acknowledges both, so two `claimed` answers are a double grant.
  if (claimed.length > 1 ||
      (observation.final && observation.final.attempts.filter((a: any) => a.state === 'active').length > 1)) return 'double-grant';
  const final = recordOf(observation.final);
  const acknowledgedCancel = actors.some((a: any) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'cancelled');
  const acknowledgedFinish = actors.some((a: any) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'applied');
  if (acknowledgedCancel && final.attempts.some((a: any) => a.state === 'finished')) return 'resurrected';
  if (acknowledgedFinish && !final.attempts.some((a: any) => a.state === 'finished')) return 'lost-ack';
  if (acknowledgedCancel && !final.attempts.some((a: any) => a.state === 'cancelled')) return 'lost-ack';
  return 'other-nonlinearizable';
}
function check(observation: any) {
  if (observation.incomplete) return verdict('INCOMPLETE', null, observation.incomplete.detail || observation.incomplete.cause, { cause: observation.incomplete.cause });
  if (observation.actors.length > 0 && observation.actors.every((a: any) => a.outcome.kind === 'THREW')) return verdict('INCOMPLETE', null, 'all actors threw', { cause: 'actor-threw' });
  if (observation.actors.some((a: any) => a.outcome.kind === 'THREW' && a.outcome.code === 'store-unreadable')) return verdict('INCOMPLETE', null, 'store unreadable', { cause: 'store-unreadable' });
  if (observation.actors.some((a: any) => a.outcome.kind === 'NONE')) return verdict('INCOMPLETE', null, 'actor did not report', { cause: 'child-crash' });
  const permutations = [[0, 1], [1, 0]];
  for (const order of permutations) {
    const choices = observation.actors.map((a: any) => a.outcome.kind === 'THREW' ? [false, true] : [true]);
    for (const include0 of choices[0]) for (const include1 of choices[1]) {
      let state = model.initial(observation.scenario); let valid = true;
      for (const i of order) {
        const actor = observation.actors[i];
        const include = i === 0 ? include0 : include1;
        if (!include) continue;
        const out = model.apply(state, actor.op, actor.args); state = out.state;
        if (actor.outcome.kind === 'DONE' && !sameResponse(actor.outcome.response, out.response)) valid = false;
      }
      if (valid && sameRecord(observation.final, state)) return verdict('PASS', null, 'history is sequentially reproducible', { order: order.map((i) => observation.actors[i].name) });
    }
  }
  const underlying = classify(observation);
  if (observation.init === 'none' && observation.fault === null) return verdict('VIOLATION', 'suspected-model-defect', `suspected model defect: ${underlying}`, { underlying });
  return verdict('VIOLATION', underlying, `history is not linearizable: ${underlying}`);
}

module.exports = { MODEL_VERSION, model, check };
