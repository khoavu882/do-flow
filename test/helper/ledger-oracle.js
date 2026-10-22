'use strict';

// Hand-written one-task model, independent of src/runtime helpers. Source behaviors: claim and
// claimChecks/claimWrite (src/runtime/task-attempts.ts:307-382, 392-436), finish (:459-497),
// cancel (:623-640), cancelAttempt (src/runtime/task-run.ts:335-356), refusedControl (:250-252).
const MODEL_VERSION = '117-B.1';

function clone(state) {
  return state ? { nextToken: state.nextToken, attempts: state.attempts.map((a) => ({ ...a })) } : { nextToken: 1, attempts: [] };
}
function initial(scenario) {
  return scenario === 'S1'
    ? { nextToken: 2, attempts: [{ token: 1, state: 'active', result: null }] }
    : { nextToken: 1, attempts: [] };
}
function apply(state, op, args = {}) {
  const next = clone(state);
  const entry = next.attempts;
  let response;
  if (op === 'claim') {
    const active = entry.find((a) => a.state === 'active');
    // claimChecks :335-339 refuses a task whose latest record is CANCELLED until a resume clears it.
    const last = entry.reduce((a, b) => (!a || b.token > a.token ? b : a), null);
    if (active) response = { disposition: 'refused', reason: 'active-attempt', activeToken: active.token };
    else if (last && last.state === 'cancelled') response = { disposition: 'refused', reason: 'cancelled' };
    else {
      const token = next.nextToken++;
      entry.push({ token, state: 'active', result: null });
      response = { disposition: 'claimed', token };
    }
  } else if (op === 'finish') {
    const cancelled = entry.find((a) => a.token === args.token && a.state === 'cancelled');
    const active = entry.find((a) => a.state === 'active');
    if (cancelled) response = { disposition: 'stale', token: args.token, reason: 'attempt-cancelled' };
    else if (!active) response = { disposition: 'stale', token: args.token, reason: 'no-active-attempt' };
    else if (active.token !== args.token) response = { disposition: 'stale', token: args.token, reason: 'token-mismatch' };
    else {
      active.state = 'finished'; active.result = args.result;
      response = { disposition: 'applied', token: args.token, result: args.result };
    }
  } else if (op === 'cancel') {
    const active = entry.find((a) => a.state === 'active');
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

function sameResponse(actual, expected) {
  const fields = ['disposition', 'reason', 'token', 'activeToken', 'result'];
  return fields.every((key) => !(key in actual) || actual[key] === expected[key]);
}
function recordOf(value) { return value ? { nextToken: value.nextToken, attempts: value.attempts || [] } : { nextToken: 1, attempts: [] }; }
function sameRecord(actual, expected) {
  const a = recordOf(actual); const e = recordOf(expected);
  if (a.nextToken !== e.nextToken || a.attempts.length !== e.attempts.length) return false;
  return a.attempts.every((attempt, i) => {
    const other = e.attempts[i];
    return attempt.token === other.token && attempt.state === other.state && attempt.result === other.result && ('cancel' in attempt) === ('cancel' in other);
  });
}
function verdict(verdict, klass, detail, extra = {}) { return { verdict, class: klass, underlying: null, cause: null, order: null, detail, ...extra }; }
function classify(observation) {
  const actors = observation.actors;
  const claimed = actors.filter((a) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'claimed');
  // One task, two claimers: the model never acknowledges both, so two `claimed` answers are a double grant.
  if (claimed.length > 1 ||
      (observation.final && observation.final.attempts.filter((a) => a.state === 'active').length > 1)) return 'double-grant';
  const final = recordOf(observation.final);
  const acknowledgedCancel = actors.some((a) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'cancelled');
  const acknowledgedFinish = actors.some((a) => a.outcome.kind === 'DONE' && a.outcome.response.disposition === 'applied');
  if (acknowledgedCancel && final.attempts.some((a) => a.state === 'finished')) return 'resurrected';
  if (acknowledgedFinish && !final.attempts.some((a) => a.state === 'finished')) return 'lost-ack';
  if (acknowledgedCancel && !final.attempts.some((a) => a.state === 'cancelled')) return 'lost-ack';
  return 'other-nonlinearizable';
}
function check(observation) {
  if (observation.incomplete) return verdict('INCOMPLETE', null, observation.incomplete.detail || observation.incomplete.cause, { cause: observation.incomplete.cause });
  if (observation.actors.some((a) => a.outcome.kind === 'THREW' && a.outcome.code === 'store-unreadable')) return verdict('INCOMPLETE', null, 'store unreadable', { cause: 'store-unreadable' });
  if (observation.actors.some((a) => a.outcome.kind === 'NONE')) return verdict('INCOMPLETE', null, 'actor did not report', { cause: 'child-crash' });
  const permutations = [[0, 1], [1, 0]];
  for (const order of permutations) {
    const choices = observation.actors.map((a) => a.outcome.kind === 'THREW' ? [false, true] : [true]);
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
