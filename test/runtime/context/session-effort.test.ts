'use strict';

// 178 T3: the session reader (design 4, IC-002), `sessionVariables` (7.2) and `loginModeOf` (4.3, IC-007). Fake
// registries, fake env objects and a scratch login store only: no harness CLI and no model runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
const { readSessionEffort, sessionVariables, SESSION_REASONS } = require('../../../src/runtime/context/session-effort.ts');
const { loginModeOf, recipeDigest } = require('../../../src/runtime/worker/login.ts');
const { storeFile } = require('../../../src/runtime/worker/login-store.ts');

const effort = (levels: any) => ({ effort: { status: 'supported', levels } });
const supportedEntry = (marker: any, sources: any[]) => ({ status: 'supported', marker, sources, evidence: ['t'], verification: 't', verifiedOn: '2026-11-19' });
const BOTH = ['subscription', 'api-key'];

/** Three harnesses: alpha (one both-modes source), beta (a one-mode source, then a both-modes one), gamma (unknown). */
const REGISTRY = {
  harnesses: [
    { id: 'alpha', worker: effort(['low', 'mid', 'high']), sessionEffort: supportedEntry({ env: 'ALPHA_SESSION', equals: '1' }, [{ kind: 'env', name: 'ALPHA_EFFORT', modes: BOTH }]) },
    { id: 'beta', worker: effort(['min', 'max']), sessionEffort: supportedEntry({ env: 'BETA_SESSION', equals: 'yes' }, [
      { kind: 'env', name: 'BETA_SUB_EFFORT', modes: ['subscription'] }, { kind: 'env', name: 'BETA_ANY_EFFORT', modes: BOTH }]) },
    { id: 'gamma', worker: effort(['low']), sessionEffort: { status: 'unknown', reason: 'no marker recorded', verification: 't' } },
  ],
};
const noMode = () => null;
const read = (env: any, extra: any = {}) => readSessionEffort({ registry: REGISTRY, env, declaredHarness: null, loginModeOf: noMode, ...extra });
const unknownCase = (answer: any, reason: string, harness: string | null, origin: string | null = null, mode: string | null = null) => {
  assert.deepEqual(answer, { state: 'unknown', harness, reason, origin, mode });
};

test('(a) a marked session with a set, declared level is known, with the variable as origin', () => {
  assert.deepEqual(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }), { state: 'known', harness: 'alpha', level: 'high', origin: 'ALPHA_EFFORT', mode: null });
  assert.deepEqual(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'mid' }, { declaredHarness: 'alpha', loginModeOf: () => 'api-key' }),
    { state: 'known', harness: 'alpha', level: 'mid', origin: 'ALPHA_EFFORT', mode: 'api-key' });
});

test('(b) worker-role: DOFLOW_SESSION_ROLE other than main (any case) reads nothing; main and empty do not', () => {
  unknownCase(read({ DOFLOW_SESSION_ROLE: 'worker', ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }), 'worker-role', null);
  unknownCase(read({ DOFLOW_SESSION_ROLE: 'Reviewer', ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }), 'worker-role', null);
  assert.equal(read({ DOFLOW_SESSION_ROLE: 'MAIN', ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }).state, 'known');
  assert.equal(read({ DOFLOW_SESSION_ROLE: '', ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }).state, 'known');
});

test('(b) no marker: no-session-harness with the declared harness or null; nothing is read', () => {
  unknownCase(read({ ALPHA_EFFORT: 'high', ALPHA_SESSION: '0' }), 'no-session-harness', null);
  unknownCase(read({ ALPHA_EFFORT: 'high' }, { declaredHarness: 'alpha' }), 'no-session-harness', 'alpha');
  unknownCase(read({}, { declaredHarness: 'not-in-registry' }), 'no-session-harness', 'not-in-registry');
});

test('(b) no marker with a declared unknown harness: no-source, naming that harness', () => {
  unknownCase(read({ ALPHA_EFFORT: 'high' }, { declaredHarness: 'gamma' }), 'no-source', 'gamma');
});

test('(b) two markers: several-markers, harness null', () => {
  unknownCase(read({ ALPHA_SESSION: '1', BETA_SESSION: 'yes', ALPHA_EFFORT: 'high' }), 'several-markers', null);
});

test('(b) a marker for H with another registry harness declared: contradicted, naming H', () => {
  unknownCase(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }, { declaredHarness: 'beta' }), 'contradicted', 'alpha');
  assert.equal(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'high' }, { declaredHarness: 'not-in-registry' }).state, 'known');
});

test('(b) a one-mode source: skipped with mode null (mode-unknown) and with the other mode (mode-not-evidenced)', () => {
  const env = { BETA_SESSION: 'yes', BETA_SUB_EFFORT: 'max' };
  unknownCase(read(env), 'mode-unknown', 'beta', 'BETA_SUB_EFFORT', null);
  unknownCase(read(env, { loginModeOf: () => 'api-key' }), 'mode-not-evidenced', 'beta', 'BETA_SUB_EFFORT', 'api-key');
  assert.deepEqual(read(env, { loginModeOf: () => 'subscription' }), { state: 'known', harness: 'beta', level: 'max', origin: 'BETA_SUB_EFFORT', mode: 'subscription' });
});

test('(b) a skipped one-mode source is remembered; the next source decides when it is set', () => {
  const env = { BETA_SESSION: 'yes', BETA_SUB_EFFORT: 'max', BETA_ANY_EFFORT: 'min' };
  assert.deepEqual(read(env), { state: 'known', harness: 'beta', level: 'min', origin: 'BETA_ANY_EFFORT', mode: null });
  assert.deepEqual(read(env, { loginModeOf: () => 'api-key' }), { state: 'known', harness: 'beta', level: 'min', origin: 'BETA_ANY_EFFORT', mode: 'api-key' });
  assert.equal(read(env, { loginModeOf: () => 'subscription' }).level, 'max');
});

test('(b) an empty or absent source: not-set, origin the first source', () => {
  unknownCase(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: '' }), 'not-set', 'alpha', 'ALPHA_EFFORT');
  unknownCase(read({ ALPHA_SESSION: '1' }), 'not-set', 'alpha', 'ALPHA_EFFORT');
  unknownCase(read({ BETA_SESSION: 'yes' }, { loginModeOf: () => 'subscription' }), 'not-set', 'beta', 'BETA_SUB_EFFORT', 'subscription');
});

test('(b) a value not in the harness levels: level-not-declared, and the value is held nowhere in the answer', () => {
  const turbo = read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'turbo' });
  unknownCase(turbo, 'level-not-declared', 'alpha', 'ALPHA_EFFORT');
  assert.ok(!JSON.stringify(turbo).includes('turbo'));
  const odd = read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'high; rm -rf /' });
  unknownCase(odd, 'level-not-declared', 'alpha', 'ALPHA_EFFORT');
  assert.ok(!JSON.stringify(odd).includes('rm'));
});

test('per-model levels take any well-formed value, and still refuse a malformed one', () => {
  const registry = { harnesses: [{ ...REGISTRY.harnesses[0], worker: effort('per-model') }] };
  const at = (value: string) => readSessionEffort({ registry, env: { ALPHA_SESSION: '1', ALPHA_EFFORT: value }, declaredHarness: null, loginModeOf: noMode });
  assert.equal(at('anything-1').level, 'anything-1');
  assert.equal(at('bad value').reason, 'level-not-declared');
});

test('SESSION_REASONS is the closed, frozen §4.1 list, and every reason the reader returns is in it', () => {
  assert.ok(Object.isFrozen(SESSION_REASONS));
  assert.equal(new Set(SESSION_REASONS).size, SESSION_REASONS.length);
  const seen = new Set<string>();
  const note = (answer: any) => { if (answer.reason) seen.add(answer.reason); };
  note(read({ DOFLOW_SESSION_ROLE: 'worker' })); note(read({})); note(read({}, { declaredHarness: 'gamma' }));
  note(read({ ALPHA_SESSION: '1', BETA_SESSION: 'yes' })); note(read({ ALPHA_SESSION: '1' }, { declaredHarness: 'beta' }));
  note(read({ BETA_SESSION: 'yes', BETA_SUB_EFFORT: 'max' })); note(read({ BETA_SESSION: 'yes', BETA_SUB_EFFORT: 'max' }, { loginModeOf: () => 'api-key' }));
  note(read({ ALPHA_SESSION: '1' })); note(read({ ALPHA_SESSION: '1', ALPHA_EFFORT: 'x' }));
  assert.deepEqual([...seen].sort(), [...SESSION_REASONS].sort());
});

test('(c) the module requires no fs, child_process, settings or login module', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'context', 'session-effort.ts'), 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert.deepEqual(required, ['node:crypto', '../../registry/model-parts.ts']);
  assert.ok(!/\bprocess\.env\b/.test(source), 'reads only the env it is given');
});

test('(f) sessionVariables lists each marker and env source once, sorted; an unknown harness adds none', () => {
  assert.deepEqual(sessionVariables(REGISTRY), ['ALPHA_EFFORT', 'ALPHA_SESSION', 'BETA_ANY_EFFORT', 'BETA_SESSION', 'BETA_SUB_EFFORT']);
  const shared = { harnesses: [REGISTRY.harnesses[1], REGISTRY.harnesses[0], { ...REGISTRY.harnesses[0], id: 'alpha2' }] };
  assert.deepEqual(sessionVariables(shared), ['ALPHA_EFFORT', 'ALPHA_SESSION', 'BETA_ANY_EFFORT', 'BETA_SESSION', 'BETA_SUB_EFFORT']);
  assert.deepEqual(sessionVariables({ harnesses: [REGISTRY.harnesses[2]] }), []);
});

// 180 IC-180-E3 (K2 c): a hook-state source reads the level a hook stored for the session the id variable names, through the
// injected `readStored`; the key it is given is the first 16 hex of the sha256 of the id, never the id itself.
const sessionKeyOf = (id: string) => require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0, 16);
const DELTA = { harnesses: [{ id: 'delta', worker: effort(['low', 'high', 'xhigh']), sessionEffort: supportedEntry({ env: 'DELTA_SESSION', equals: '1' }, [
  { kind: 'hook-state', sessionIdEnv: 'DELTA_SESSION_ID', modes: BOTH }, { kind: 'env', name: 'DELTA_EFFORT', modes: BOTH }]) }] };
const stored = (byKey: Record<string, string>, calls: any[] = []) => (query: any) => {
  calls.push(query);
  return Object.hasOwn(byKey, query.sessionKey) ? { level: byKey[query.sessionKey], observedAt: '2026-11-20T10:00:00Z' } : null;
};
const readDelta = (env: any, readStored: any) => readSessionEffort({ registry: DELTA, env: { DELTA_SESSION: '1', ...env }, declaredHarness: null, loginModeOf: noMode, readStored });

test('(c) 180: a stored level beats the env variable, origin hook-state; the reader gets the hashed key only', () => {
  const calls: any[] = [];
  const answer = readDelta({ DELTA_SESSION_ID: 'sess-1', DELTA_EFFORT: 'high' }, stored({ [sessionKeyOf('sess-1')]: 'xhigh' }, calls));
  assert.deepEqual(answer, { state: 'known', harness: 'delta', level: 'xhigh', origin: 'hook-state', mode: null, observedAt: '2026-11-20T10:00:00Z' });
  assert.deepEqual(calls, [{ harness: 'delta', sessionKey: sessionKeyOf('sess-1') }]);
});

test('(c) 180: no stored level falls through to the env variable; no session id reads nothing stored', () => {
  assert.deepEqual(readDelta({ DELTA_SESSION_ID: 'sess-1', DELTA_EFFORT: 'high' }, stored({})),
    { state: 'known', harness: 'delta', level: 'high', origin: 'DELTA_EFFORT', mode: null });
  for (const env of [{ DELTA_EFFORT: 'high' }, { DELTA_SESSION_ID: '', DELTA_EFFORT: 'high' }]) {
    const calls: any[] = [];
    assert.equal(readDelta(env, stored({ [sessionKeyOf('')]: 'xhigh' }, calls)).level, 'high');
    assert.deepEqual(calls, [], 'an absent or empty session id is not set: the store is not asked');
  }
  assert.equal(readDelta({ DELTA_SESSION_ID: 'sess-1', DELTA_EFFORT: 'high' }, undefined).level, 'high', 'no reader injected reads nothing stored');
});

test('(c) 180: a stored level not in levels is level-not-declared with origin hook-state; nothing set is not-set naming the variable', () => {
  const turbo = readDelta({ DELTA_SESSION_ID: 'sess-1', DELTA_EFFORT: 'high' }, stored({ [sessionKeyOf('sess-1')]: 'turbo' }));
  unknownCase(turbo, 'level-not-declared', 'delta', 'hook-state');
  assert.ok(!JSON.stringify(turbo).includes('turbo'));
  unknownCase(readDelta({ DELTA_SESSION_ID: 'sess-1' }, stored({})), 'not-set', 'delta', 'DELTA_EFFORT');
});

test('(f) 180: sessionVariables lists a hook-state source\'s session id variable', () => {
  assert.deepEqual(sessionVariables(DELTA), ['DELTA_EFFORT', 'DELTA_SESSION', 'DELTA_SESSION_ID']);
});

test('(g) loginModeOf gives the mode for a logged-in answer with a billing object, null otherwise, and starts no process', () => {
  const NOW = Date.parse('2026-11-19T10:00:00.000Z');
  const FRESH = '2026-11-19T09:00:00.000Z';
  const STALE = '2026-11-16T09:00:00.000Z';
  const probe = { status: 'supported', argv: ['x'], output: 'none', answers: [], expiry: 'not-seen' };
  const withProbe = (id: string): any => ({ id, worker: { ...effort(['low']), loginProbe: probe } });
  const registry = { harnesses: ['sub', 'key', 'mixed', 'stale', 'never', 'out'].map(withProbe).concat([{ id: 'norecipe', worker: effort(['low']) }]) };
  const digest = recipeDigest(registry.harnesses[0].worker);
  const slot = (state: string, billing: any, at = FRESH) => ({ recipe: { state, reason: null, at, billing, providers: [], checked: 1, listed: 0, digest }, run: null });
  const scratch = createScratch('doflow-session-effort-');
  const env = childEnv(scratch);
  const file = storeFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, harnesses: {
    sub: slot('logged-in', { mode: 'subscription', billing: 'free' }),
    key: slot('logged-in', { mode: 'api-key', billing: 'metered' }),
    mixed: slot('logged-in', 'mixed'),
    stale: slot('logged-in', { mode: 'subscription', billing: 'free' }, STALE),
    out: slot('logged-out', { mode: 'subscription', billing: 'free' }),
    norecipe: slot('logged-in', { mode: 'subscription', billing: 'free' }),
  } }));

  const spawned: string[] = [];
  const saved: any = {};
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    saved[name] = childProcess[name];
    childProcess[name] = () => { spawned.push(name); throw new Error(`spawn seam used: ${name}`); };
  }
  try {
    const modeOf = loginModeOf({ registry, env, now: NOW });
    assert.equal(modeOf('sub'), 'subscription');
    assert.equal(modeOf('key'), 'api-key');
    for (const id of ['mixed', 'stale', 'never', 'out', 'norecipe', 'not-in-registry']) assert.equal(modeOf(id), null, id);
  } finally {
    for (const name of Object.keys(saved)) childProcess[name] = saved[name];
  }
  assert.deepEqual(spawned, []);
});
