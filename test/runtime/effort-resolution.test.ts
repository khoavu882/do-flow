'use strict';

// 178 T4 (IC-003, IC-004): the effort resolver, the next-lower mapping and the assembler, over fake worker blocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveEffort, mapLevel, effortPlanFor, NONE_REASONS } = require('../../src/runtime/worker/effort-resolution.ts');

const SESSION_LEVELS = ['a', 'b', 'c', 'd'];

const worker = (levels: any, via = 'flag', status = 'supported') => ({ effort: status === 'supported' ? { status, via, levels } : { status } });
const known = (level: string, extra: any = {}) => ({ state: 'known', harness: 'sess', level, origin: 'SESSION_EFFORT', mode: null, ...extra });
const sessionWorker = worker(SESSION_LEVELS);

function plan(over: any = {}) {
  return resolveEffort({ choice: null, session: known('d'), sessionWorker, worker: worker(SESSION_LEVELS), ...over });
}

test('(a) a bound effort wins over a known session', () => {
  assert.deepEqual(plan({ choice: { model: 'm', provider: null, effort: 'a' } }), { pass: 'a', source: 'binding' });
});

test('(b) a known session level the worker has passes unchanged', () => {
  assert.deepEqual(plan({ session: known('c') }), {
    pass: 'c', source: 'session', harness: 'sess', level: 'c', origin: 'SESSION_EFFORT', mapped: null, check: 'listed',
  });
});

test('(c) an unknown session passes nothing and carries the session reason', () => {
  const session = { state: 'unknown', harness: 'sess', reason: 'not-set', origin: 'SESSION_EFFORT', mode: null };
  assert.deepEqual(plan({ session }), {
    pass: null, source: 'none', reason: 'session-unknown',
    session: { harness: 'sess', reason: 'not-set', level: null, origin: 'SESSION_EFFORT' },
  });
});

test('(d) a worker that takes no effort passes nothing', () => {
  const result = plan({ worker: worker(null, 'flag', 'unknown') });
  assert.equal(result.pass, null);
  assert.equal(result.reason, 'worker-takes-no-effort');
  assert.equal(result.session.level, 'd');
});

test('(e) an id-suffix transport needs a bound model', () => {
  const suffixed = worker(SESSION_LEVELS, 'id-suffix');
  const none = plan({ worker: suffixed, choice: null });
  assert.equal(none.pass, null);
  assert.equal(none.reason, 'needs-model');
  assert.equal(plan({ worker: suffixed, choice: { model: 'm', provider: null, effort: null } }).pass, 'd');
});

test('(f) mapping steps down the session list to the first name the worker has', () => {
  const result = plan({ worker: worker(['a', 'b']) });
  assert.equal(result.pass, 'b');
  assert.deepEqual(result.mapped, { from: 'd', to: 'b' });
  assert.deepEqual(mapLevel('d', SESSION_LEVELS, ['a', 'b']), { to: 'b' });
  assert.deepEqual(mapLevel('d', SESSION_LEVELS, ['x']), { none: 'no-lower-level' });
  assert.deepEqual(mapLevel('d', 'per-model', ['a']), { none: 'no-ordered-list' });
  const noLower = plan({ worker: worker(['x']) });
  assert.equal(noLower.pass, null);
  assert.equal(noLower.reason, 'no-lower-level');
  const perModel = plan({ sessionWorker: worker('per-model'), worker: worker(['a']) });
  assert.equal(perModel.reason, 'no-ordered-list');
});

test('(g) a per-model worker list takes the level unchanged, unchecked', () => {
  const result = plan({ worker: worker('per-model') });
  assert.equal(result.pass, 'd');
  assert.equal(result.mapped, null);
  assert.equal(result.check, 'unchecked');
});

test('(h) the none reasons are a frozen closed list of five', () => {
  assert.deepEqual([...NONE_REASONS].sort(), ['needs-model', 'no-lower-level', 'no-ordered-list', 'session-unknown', 'worker-takes-no-effort']);
  assert.ok(Object.isFrozen(NONE_REASONS));
});

test('(i) resolveEffort is pure and the module requires no fs, child_process or settings module', () => {
  const input = { choice: null, session: known('d'), sessionWorker, worker: worker(['a', 'b']) };
  const before = JSON.stringify(input);
  assert.deepEqual(resolveEffort(input), resolveEffort(input));
  assert.equal(JSON.stringify(input), before);
  const source = fs.readFileSync(path.join(__dirname, '../../src/runtime/worker/effort-resolution.ts'), 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  for (const name of required) assert.doesNotMatch(name, /^(node:)?(fs|child_process)$|settings/, name);
});

test('(j) effortPlanFor reads the session and resolves against the worker harness', () => {
  const registry = {
    harnesses: [
      { id: 'sess', sessionEffort: { status: 'supported', marker: { env: 'SESS_MARK', equals: '1' }, sources: [{ kind: 'env', name: 'SESS_EFFORT', modes: ['subscription', 'api-key'] }] }, worker: sessionWorker },
      { id: 'wrk', sessionEffort: { status: 'unknown', reason: 'none', verification: 'none' }, worker: worker(['a', 'b']) },
      { id: 'mute', sessionEffort: { status: 'unknown', reason: 'none', verification: 'none' }, worker: worker(null, 'flag', 'unknown') },
    ],
  };
  const loginModeOf = () => null;
  const call = (over: any = {}) => effortPlanFor({
    registry, env: { SESS_MARK: '1', SESS_EFFORT: 'd' }, declaredHarness: null, workerHarness: 'wrk', choice: null, loginModeOf, ...over,
  });
  assert.deepEqual(call(), {
    pass: 'b', source: 'session', harness: 'sess', level: 'd', origin: 'SESS_EFFORT', mapped: { from: 'd', to: 'b' }, check: 'listed',
  });
  assert.equal(call({ choice: { model: 'm', provider: null, effort: 'a' } }).source, 'binding');
  assert.equal(call({ workerHarness: 'mute' }).reason, 'worker-takes-no-effort');
  assert.equal(call({ workerHarness: 'absent' }).reason, 'worker-takes-no-effort');
  const unset = call({ env: { SESS_MARK: '1' } });
  assert.equal(unset.reason, 'session-unknown');
  assert.equal(unset.session.reason, 'not-set');
  assert.equal(call({ env: {} }).session.reason, 'no-session-harness');
});
