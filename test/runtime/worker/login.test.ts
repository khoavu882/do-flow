'use strict';

// 172 T3: the login runner (design 4.1, 4.3), the answer precedence (4.2), the expiry matcher (4.4) and the store
// (4.5). Every spawning case runs the fake harness CLI from a scratch bin/ under a scratch HOME and config home; no
// real harness is run and nothing under the developer's home is read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
const { linkBin, writeScenario } = require('../../helper/fake-harness-cli.ts');
const login = require('../../../src/runtime/worker/login.ts');

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const NOW = Date.parse('2026-11-16T10:00:00.000Z');

/** A scratch HOME and config home, a bin/ holding `fake-login`, and a scenario file. */
function rig(scenario: any) {
  const scratch = createScratch('doflow-login-');
  const bin = path.join(scratch.dir, 'bin');
  const childPath = linkBin(bin, ['fake-login']);
  const env = childEnv(scratch, { PATH: childPath, FAKE_HARNESS_SCENARIO: writeScenario(scratch.dir, scenario) });
  return { scratch, env, cwd: scratch.dir };
}

function worker(probe: any) {
  return {
    cli: { status: 'supported', binary: 'fake-login', versionArgv: ['--version'] },
    loginProbe: { status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-11-16', ...probe },
  };
}

const MINIMAL = { argv: ['probe', 'login'], output: 'none', answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }], expiry: 'not-seen' };

test('a scratch recipe whose fake exits 0 reads logged-in with source recipe', POSIX_ONLY, async () => {
  const { env, cwd } = rig({ login: [{ exit: 0 }] });
  const w = worker(MINIMAL);
  const answer = await login.checkLogin({ harness: 'claude', worker: w, env, cwd, now: NOW });
  assert.equal(answer.state, 'logged-in');
  assert.equal(answer.reason, null);
  const record = { recipe: { ...answer, digest: login.recipeDigest(w) }, run: null };
  const read = login.loginAnswerOf({ harness: 'claude', worker: w, record, now: NOW });
  assert.equal(read.state, 'logged-in');
  assert.equal(read.source, 'recipe');
});

// ── Design 4.1: one process ──────────────────────────────────────────────────────────────────────────────────────

const { spawnBounded } = require('../../../src/runtime/worker/process-tree.ts');
const { readLog } = require('../../helper/fake-harness-cli.ts');
const store = require('../../../src/runtime/worker/login-store.ts');

const JSON_RECIPE = {
  argv: ['probe', 'login'], output: 'json',
  answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, when: [{ path: ['status'], equals: 'not_ready' }], state: 'logged-out' }],
  billing: { path: ['authMethod'], values: { 'claude.ai': { mode: 'subscription', billing: 'free' }, api_key: { mode: 'api-key', billing: 'metered' } } },
  expiry: 'not-seen',
};

/** Runs `probe` against a fake whose `login` kind runs `steps`; `seam` wraps spawnBounded when given. */
async function once(probe: any, steps: any[], { seam, extra = {} }: any = {}) {
  const r = rig({ login: steps });
  const log = path.join(r.scratch.dir, 'log.jsonl');
  const env = { ...r.env, FAKE_HARNESS_LOG: log, ...extra };
  const answer = await login.checkLogin({ harness: 'claude', worker: worker(probe), env, cwd: r.cwd, now: NOW, ...(seam ? { spawn: seam } : {}) });
  return { answer, calls: readLog(log) };
}

const short = (opts: any) => spawnBounded({ ...opts, timeoutMs: Math.min(opts.timeoutMs, 300) });

test('4.1: not installed, a timeout, a signal, a spawn failure and an exit no rule names each read unknown', POSIX_ONLY, async () => {
  const r = rig({});
  const missing = await login.checkLogin({ harness: 'claude', worker: worker(MINIMAL), env: { ...r.env, PATH: path.join(r.scratch.dir, 'empty') }, cwd: r.cwd, now: NOW });
  assert.deepEqual([missing.state, missing.reason], ['unknown', 'not-installed']);
  const gone = await login.checkLogin({ harness: 'claude', worker: worker(MINIMAL), env: r.env, cwd: r.cwd, now: NOW, binaryPath: path.join(r.scratch.dir, 'no-such-binary') });
  assert.deepEqual([gone.state, gone.reason], ['unknown', 'not-installed']);

  const slow = await once(MINIMAL, [{ sleep: 5000 }, { exit: 0 }], { seam: short });
  assert.deepEqual([slow.answer.state, slow.answer.reason], ['unknown', 'timeout']);
  const signal = await once(MINIMAL, [], { seam: async () => ({ status: 'exited', code: null, signal: 'SIGKILL', stdout: '', truncated: false }) });
  assert.deepEqual([signal.answer.state, signal.answer.reason], ['unknown', 'signal SIGKILL']);
  const failed = await once(MINIMAL, [], { seam: async () => ({ status: 'error', code: null, signal: null, error: 'EACCES', stdout: '', truncated: false }) });
  assert.deepEqual([failed.answer.state, failed.answer.reason], ['unknown', 'spawn-failed']);
  const unlisted = await once(MINIMAL, [{ exit: 7 }]);
  assert.deepEqual([unlisted.answer.state, unlisted.answer.reason], ['unknown', 'exit 7']);
  const out = await once(MINIMAL, [{ exit: 1 }]);
  assert.deepEqual([out.answer.state, out.answer.reason], ['logged-out', null]);
});

test('4.1: a rule needing JSON that stdout does not give reads unparseable-output; JSON without the tested value reads exit <n>', POSIX_ONLY, async () => {
  const text = await once(JSON_RECIPE, [{ print: 'not json' }, { exit: 1 }]);
  assert.deepEqual([text.answer.state, text.answer.reason], ['unknown', 'unparseable-output']);
  const other = await once(JSON_RECIPE, [{ print: '{"status":"ready"}' }, { exit: 1 }]);
  assert.deepEqual([other.answer.state, other.answer.reason], ['unknown', 'exit 1']);
  const out = await once(JSON_RECIPE, [{ print: '{"status":"not_ready"}' }, { exit: 1 }]);
  assert.equal(out.answer.state, 'logged-out');
  const cutOff = await once(JSON_RECIPE, [], { seam: async () => ({ status: 'exited', code: 1, signal: null, stdout: '{"status":"not_ready"}', truncated: true }) });
  assert.equal(cutOff.answer.reason, 'unparseable-output', 'stdout cut at its bound is not parsed');
});

test('4.1: billing maps a declared value; an unmapped or absent value reports none, and the raw value is not kept', POSIX_ONLY, async () => {
  const mapped = await once(JSON_RECIPE, [{ print: '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}' }, { exit: 0 }]);
  assert.deepEqual(mapped.answer.billing, { mode: 'subscription', billing: 'free' });
  assert.ok(!JSON.stringify(mapped.answer).includes('a@b.c'));
  const unmapped = await once(JSON_RECIPE, [{ print: '{"authMethod":"third_party"}' }, { exit: 0 }]);
  assert.deepEqual([unmapped.answer.state, unmapped.answer.billing], ['logged-in', null]);
  assert.ok(!JSON.stringify(unmapped.answer).includes('third_party'));
  const plainText = await once(JSON_RECIPE, [{ print: 'Logged in' }, { exit: 0 }]);
  assert.deepEqual([plainText.answer.state, plainText.answer.billing], ['logged-in', null]);
});

test('4.1: a secret or widening flag in the final argv reads unknown and starts no process', POSIX_ONLY, async () => {
  const secret = await once({ ...MINIMAL, argv: ['auth', 'status', '--show-token'] }, [{ exit: 0 }]);
  assert.deepEqual([secret.answer.state, secret.answer.reason, secret.calls.length], ['unknown', 'secret-flag', 0]);
  const declared = await once({ ...MINIMAL, argv: ['auth', 'status', '--dump'] }, [{ exit: 0 }], {});
  assert.equal(declared.answer.state, 'logged-in');
  const r = rig({ login: [{ exit: 0 }] });
  const own = await login.checkLogin({ harness: 'claude', worker: { ...worker({ ...MINIMAL, argv: ['auth', 'status', '--dump'] }), secretFlags: [{ flag: '--dump' }] }, env: r.env, cwd: r.cwd, now: NOW });
  assert.deepEqual([own.state, own.reason], ['unknown', 'secret-flag'], 'the worker\'s own secretFlags apply');
  const widening = await once({ ...MINIMAL, argv: ['probe', 'login', '--dangerously-skip-permissions'] }, [{ exit: 0 }]);
  assert.deepEqual([widening.answer.state, widening.answer.reason, widening.calls.length], ['unknown', 'widening-flag', 0]);
});

test('4.1: an entry that is not supported reads no-recipe and starts no process', POSIX_ONLY, async () => {
  const r = rig({});
  const answer = await login.checkLogin({ harness: 'claude', worker: { cli: { status: 'supported', binary: 'fake-login' }, loginProbe: { status: 'unknown', reason: 'no status command' } }, env: r.env, cwd: r.cwd, now: NOW });
  assert.deepEqual([answer.state, answer.reason, answer.checked], ['unknown', 'no-recipe', 0]);
});

// ── Design 4.3: providers ────────────────────────────────────────────────────────────────────────────────────────

const PI = {
  argv: ['auth', 'check', '--provider', '{provider}', '--json', '--no-refresh'], output: 'json',
  providers: { argv: ['--list-models', '--offline'], parse: 'table-column:provider', emptyMeans: 'logged-out', max: 8 },
  answers: [
    { exit: 0, state: 'logged-in' },
    { exit: 1, when: [{ path: ['reason'], equals: 'provider_not_found' }], state: 'unknown', reason: 'provider-not-found' },
    { exit: 1, when: [{ path: ['status'], equals: 'not_ready' }], state: 'logged-out' },
    { exit: 1, when: [{ path: ['status'], equals: 'expired' }], state: 'expired' },
    { exit: 2, state: 'unknown', reason: 'invalid' }],
  billing: { path: ['authType'], values: { oauth: { mode: 'subscription', billing: 'unknown' }, api_key: { mode: 'api-key', billing: 'metered' } } },
  expiry: 'not-seen',
};
const check = (id: string) => ['auth', 'check', '--provider', id, '--json', '--no-refresh'];
const table = (ids: string[]) => [{ print: ['provider  model', ...ids.map((id) => `${id}  m-${id}`)].join('\n') }];
const READY = (type: string) => [{ print: JSON.stringify({ status: 'ready', authType: type }) }, { exit: 0 }];
const NOT_READY = [{ print: '{"status":"not_ready"}' }, { exit: 1 }];

/** The PI recipe against a fake whose listing prints `ids` and whose check of each id runs `checks[id]`. */
async function providers(ids: string[] | null, checks: Record<string, any[]>, { probe = PI, seam, now = NOW }: any = {}) {
  const byArgv = [
    { argv: ['--list-models', '--offline'], steps: ids === null ? [{ exit: 3 }] : table(ids) },
    ...Object.entries(checks).map(([id, steps]) => ({ argv: check(id), steps })),
  ];
  const r = rig({ byArgv, run: [{ exit: 9 }] });
  const log = path.join(r.scratch.dir, 'log.jsonl');
  const answer = await login.checkLogin({ harness: 'pi', worker: worker(probe), env: { ...r.env, FAKE_HARNESS_LOG: log }, cwd: r.cwd, now, ...(seam ? { spawn: seam } : {}) });
  return { answer, calls: readLog(log) };
}

test('4.3: a failed listing reads providers-unlisted; an empty one reads emptyMeans with no-provider-listed', POSIX_ONLY, async () => {
  const failed = await providers(null, {});
  assert.deepEqual([failed.answer.state, failed.answer.reason], ['unknown', 'providers-unlisted']);
  const empty = await providers([], {});
  assert.deepEqual([empty.answer.state, empty.answer.reason, empty.calls.length], ['logged-out', 'no-provider-listed', 1]);
  const emptyUnknown = await providers([], {}, { probe: { ...PI, providers: { ...PI.providers, emptyMeans: 'unknown' } } });
  assert.deepEqual([emptyUnknown.answer.state, emptyUnknown.answer.reason], ['unknown', 'no-provider-listed']);
});

test('4.3: any provider logged in reads logged-in; billing agrees, mixes, or is null when some were unchecked', POSIX_ONLY, async () => {
  const one = await providers(['anthropic'], { anthropic: READY('oauth') });
  assert.equal(one.answer.state, 'logged-in');
  assert.deepEqual(one.answer.billing, { mode: 'subscription', billing: 'unknown' });
  assert.deepEqual(one.answer.providers, [{ id: 'anthropic', state: 'logged-in', mode: 'subscription', reason: null }]);
  assert.deepEqual(one.calls.map((call: any) => call.argv), [['--list-models', '--offline'], check('anthropic')]);

  const mixed = await providers(['anthropic', 'openai'], { anthropic: READY('oauth'), openai: READY('api_key') });
  assert.deepEqual([mixed.answer.state, mixed.answer.billing], ['logged-in', 'mixed']);
  const partOut = await providers(['anthropic', 'gone'], { anthropic: READY('oauth'), gone: NOT_READY });
  assert.deepEqual([partOut.answer.state, partOut.answer.billing], ['logged-in', { mode: 'subscription', billing: 'unknown' }]);

  const nine = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'anthropic'];
  const unchecked = await providers(['anthropic', ...nine.slice(0, 8)], { anthropic: READY('oauth'), ...Object.fromEntries(nine.slice(0, 8).map((id) => [id, NOT_READY])) });
  assert.deepEqual([unchecked.answer.state, unchecked.answer.billing, unchecked.answer.checked, unchecked.answer.listed], ['logged-in', null, 8, 9]);
});

test('4.3: every listed provider logged out reads logged-out; 9 listed with 8 checked reads providers-partial', POSIX_ONLY, async () => {
  const out = await providers(['gone', 'away'], { gone: NOT_READY, away: NOT_READY });
  assert.deepEqual([out.answer.state, out.answer.reason], ['logged-out', null]);
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
  const partial = await providers(ids, Object.fromEntries(ids.map((id) => [id, NOT_READY])));
  assert.deepEqual([partial.answer.state, partial.answer.reason, partial.answer.checked, partial.answer.listed], ['unknown', 'providers-partial', 8, 9]);
  assert.ok(!partial.calls.some((call: any) => call.argv.includes('p9')));
});

test('4.3: none logged in with one expired reads provider-expired; otherwise the first provider\'s unknown reason', POSIX_ONLY, async () => {
  const expired = await providers(['gone', 'old'], { gone: NOT_READY, old: [{ print: '{"status":"expired"}' }, { exit: 1 }] });
  assert.deepEqual([expired.answer.state, expired.answer.reason], ['expired', 'provider-expired']);
  const invalid = await providers(['gone', 'broken', 'ext'], { gone: NOT_READY, broken: [{ exit: 2 }], ext: [{ print: '{"status":"not_ready","reason":"provider_not_found"}' }, { exit: 1 }] });
  assert.deepEqual([invalid.answer.state, invalid.answer.reason], ['unknown', 'invalid']);
  const notJson = await providers(['anthropic'], { anthropic: [{ print: 'oops' }, { exit: 1 }] });
  assert.deepEqual([notJson.answer.state, notJson.answer.reason], ['unknown', 'unparseable-output']);
});

test('4.3: a listed id with a bad character is never put in argv; a provider id that spells a secret command is refused', POSIX_ONLY, async () => {
  const bad = await providers(['-rf', 'gone'], { gone: NOT_READY });
  assert.ok(!bad.calls.some((call: any) => call.argv.includes('-rf')));
  assert.deepEqual([bad.answer.state, bad.answer.reason, bad.answer.checked, bad.answer.listed], ['unknown', 'providers-partial', 1, 2]);
  const secret = await providers(['print-api-key'], { 'print-api-key': READY('oauth') });
  assert.deepEqual([secret.answer.state, secret.answer.reason, secret.calls.length], ['unknown', 'secret-flag', 1]);
});

test('4.1: the whole recipe stops at 30 s; providers not yet checked count as unchecked', POSIX_ONLY, async () => {
  let t = NOW;
  const seam = async (opts: any) => { const result = await spawnBounded(opts); t += 10000; return result; };
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const run = await providers(ids, Object.fromEntries(ids.map((id) => [id, NOT_READY])), { seam, now: () => t });
  assert.deepEqual([run.answer.state, run.answer.reason, run.answer.checked, run.answer.listed], ['unknown', 'providers-partial', 2, 4]);
});

// ── Design 4.2: answer precedence ────────────────────────────────────────────────────────────────────────────────

const H = 3600000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const recipeOf = (w: any, state: string, offsetMs: number, extra: any = {}) => ({ state, reason: null, at: at(offsetMs), digest: login.recipeDigest(w), billing: null, providers: [], checked: 1, listed: 0, ...extra });
const answerFor = (w: any, record: any) => login.loginAnswerOf({ harness: 'pi', worker: w, record, now: NOW });

test('4.2 step 1 and 4: no recipe and no run reads never-checked no-recipe with the entry\'s reason; no record reads never-checked', () => {
  const none = answerFor({ loginProbe: { status: 'unknown', reason: 'x'.repeat(300), hint: 'codex login' } }, null);
  assert.equal(none.source, 'never-checked');
  assert.equal(none.reason, `no-recipe: ${'x'.repeat(120)}`);
  assert.equal(none.hint, 'codex login');
  const never = answerFor(worker(MINIMAL), null);
  assert.deepEqual([never.state, never.source, never.reason, never.at], ['unknown', 'never-checked', 'never-checked', null]);
});

test('4.2 step 2: a run\'s expiry stands over a later success of a not-seen recipe and is cleared by a later run or a seen recipe', () => {
  const notSeen = worker(PI);
  const run = { outcome: 'expired', at: at(-2 * H), runId: 'r1', provider: 'anthropic', sign: 'OAuth refresh failed for {provider}' };
  const expired = answerFor(notSeen, { recipe: recipeOf(notSeen, 'logged-in', -H), run });
  assert.deepEqual([expired.state, expired.source, expired.provider, expired.at, expired.expirySeen], ['expired', 'last-run', 'anthropic', run.at, false]);
  const old = answerFor(notSeen, { recipe: null, run: { ...run, at: at(-72 * H) } });
  assert.equal(old.state, 'expired', 'a run\'s expiry does not age');

  const seen = worker({ ...PI, expiry: 'seen' });
  const cleared = answerFor(seen, { recipe: recipeOf(seen, 'logged-in', -H), run });
  assert.deepEqual([cleared.state, cleared.source, cleared.expirySeen], ['logged-in', 'recipe', true]);
  const before = answerFor(seen, { recipe: recipeOf(seen, 'logged-in', -3 * H), run });
  assert.equal(before.state, 'expired', 'a recipe answer older than the run does not clear it');

  const succeeded = answerFor(notSeen, { recipe: recipeOf(notSeen, 'logged-in', -3 * H), run: { outcome: 'succeeded', at: at(-H), runId: 'r2', provider: null, sign: null } });
  assert.deepEqual([succeeded.state, succeeded.source], ['logged-in', 'last-run']);
});

test('4.2 step 3: the newer of recipe and success wins; past 24 h or on another digest it reads stale with last', () => {
  const w = worker({ ...PI, caveat: 'its help does not show this check runs offline' });
  const recipe = answerFor(w, { recipe: recipeOf(w, 'logged-out', -H), run: { outcome: 'succeeded', at: at(-2 * H) } });
  assert.deepEqual([recipe.state, recipe.source, recipe.reason, recipe.caveat], ['logged-out', 'recipe', 'logged-out', w.loginProbe.caveat]);
  const run = answerFor(w, { recipe: recipeOf(w, 'logged-out', -3 * H), run: { outcome: 'succeeded', at: at(-2 * H) } });
  assert.deepEqual([run.state, run.source, run.caveat], ['logged-in', 'last-run', null]);

  const aged = answerFor(w, { recipe: recipeOf(w, 'logged-in', -25 * H), run: null });
  assert.deepEqual([aged.state, aged.reason, aged.source, aged.at, aged.last], ['unknown', 'stale', 'recipe', at(-25 * H), { state: 'logged-in', source: 'recipe', at: at(-25 * H) }]);
  assert.equal(aged.caveat, w.loginProbe.caveat, 'a stale recipe answer still carries the caveat');
  const digest = answerFor(w, { recipe: { ...recipeOf(w, 'logged-in', -H), digest: 'sha256:other' }, run: null });
  assert.deepEqual([digest.state, digest.reason, digest.last?.source], ['unknown', 'stale', 'recipe']);
  const oldRun = answerFor(w, { recipe: null, run: { outcome: 'succeeded', at: at(-25 * H) } });
  assert.deepEqual([oldRun.state, oldRun.reason, oldRun.last], ['unknown', 'stale', { state: 'logged-in', source: 'last-run', at: at(-25 * H) }]);
});

test('IC-001: a full LoginAnswer at its limits is at most 1 KiB', () => {
  const long = (n: number) => 'a'.repeat(n);
  const w = { loginProbe: { ...PI, status: 'supported', hint: long(120), caveat: long(160) } };
  const providers = Array.from({ length: 8 }, (_, i) => ({ id: `${i}${long(63)}`, state: 'unknown', mode: null, reason: long(40) }));
  const record = { recipe: { ...recipeOf(w, 'unknown', -H), reason: long(200), billing: { mode: 'subscription', billing: 'unknown' }, providers }, run: null };
  const answer = login.loginAnswerOf({ harness: `pkg/${long(60)}`, worker: w, record, now: NOW });
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 1024, `${Buffer.byteLength(JSON.stringify(answer))} bytes`);
  assert.equal(answer.reason?.length, 160);
  assert.equal(answer.hint?.length, 120);
  assert.equal(answer.caveat?.length, 160);
  assert.ok(answer.providers.length >= 1);
  assert.deepEqual(Object.keys(answer).sort(), ['at', 'billing', 'caveat', 'expirySeen', 'harness', 'hint', 'last', 'provider', 'providers', 'reason', 'source', 'state']);
});

test('4.6: loginFact maps each state', () => {
  const base = { harness: 'pi', at: at(0), provider: null } as any;
  assert.deepEqual(login.loginFact({ ...base, state: 'logged-in', reason: null }), { state: 'yes', reason: 'logged-in', at: at(0), basis: 'free' });
  assert.equal(login.loginFact({ ...base, state: 'logged-out', reason: 'logged-out' }).state, 'no');
  assert.equal(login.loginFact({ ...base, state: 'expired', reason: 'expired', provider: 'anthropic' }).reason, 'login-expired anthropic');
  assert.equal(login.loginFact({ ...base, state: 'expired', reason: 'expired' }).reason, 'login-expired pi');
  assert.deepEqual([login.loginFact({ ...base, state: 'unknown', reason: 'stale' }).state, login.loginFact({ ...base, state: 'unknown', reason: 'stale' }).reason], ['unknown', 'stale']);
});

// ── Design 4.4: expiry matcher ───────────────────────────────────────────────────────────────────────────────────

const SIGNS = worker({ ...PI, expirySigns: { signs: ['OAuth refresh failed for {provider}', 'token that expires too soon for {provider}.', 'Session expired'], basis: 'source', evidence: ['x'] } });
const failure = (summary: string) => ({ status: 'failure', summary });

test('4.4: a sign with a slot captures the provider in its own case; a sign without one matches case-insensitively', () => {
  assert.deepEqual(login.loginExpiredOf(failure('Error: oauth REFRESH failed for AnthropicX.'), SIGNS), { sign: 'OAuth refresh failed for {provider}', provider: 'AnthropicX' });
  assert.deepEqual(login.loginExpiredOf(failure('a token that expires too soon for open.ai-1.'), SIGNS), { sign: 'token that expires too soon for {provider}.', provider: 'open.ai-1' });
  assert.deepEqual(login.loginExpiredOf(failure('SESSION EXPIRED, log in again'), SIGNS), { sign: 'Session expired', provider: null });
});

test('4.4: a provider with a bad character, a sign past 2,000 bytes and a success report give no expiry', () => {
  assert.equal(login.loginExpiredOf(failure('OAuth refresh failed for $evil'), SIGNS), null);
  assert.equal(login.loginExpiredOf(failure(`${'x'.repeat(1990)} OAuth refresh failed for anthropic`), SIGNS), null);
  assert.equal(login.loginExpiredOf({ status: 'success', summary: 'OAuth refresh failed for anthropic' }, SIGNS), null);
  assert.equal(login.loginExpiredOf({ status: 'unparsed', summary: 'Session expired' }, SIGNS), null);
  assert.equal(login.loginExpiredOf(failure('Session expired'), worker(MINIMAL)), null, 'no signs declared');
  assert.deepEqual(login.loginExpiredOf(failure('OAuth refresh failed for  OAuth refresh failed for pi'), SIGNS)?.provider, 'pi', 'a later occurrence is tried');
});

// ── Design 4.5: the store ────────────────────────────────────────────────────────────────────────────────────────

const RECIPE_ANSWER = { state: 'logged-in', reason: null, at: at(0), billing: null, providers: [], checked: 1, listed: 0 };

test('4.5: no config home writes nothing and reads empty; a write lands in <config home>/state/harness-login.json', () => {
  const none = { PATH: '/nonexistent' };
  assert.equal(store.recordRecipeAnswer(none, 'pi', RECIPE_ANSWER, 'd', { known: ['pi'] }), null);
  assert.deepEqual(store.readLoginStore(none), { version: 1, harnesses: {} });
  const scratch = createScratch('doflow-login-store-');
  const env = childEnv(scratch);
  const file = store.recordRecipeAnswer(env, 'pi', RECIPE_ANSWER, 'sha256:d', { known: ['pi'] });
  assert.equal(file, path.join(scratch.xdg, 'doflow', 'state', 'harness-login.json'));
  assert.deepEqual(store.readLoginStore(env).harnesses.pi.recipe.digest, 'sha256:d');
  const answers = login.loginAnswers({ env, now: NOW, workers: [{ id: 'pi', worker: worker(MINIMAL) }, { id: 'claude', worker: worker(MINIMAL) }] });
  assert.deepEqual(answers.map((a: any) => [a.harness, a.state, a.reason, a.source]), [['pi', 'unknown', 'stale', 'recipe'], ['claude', 'unknown', 'never-checked', 'never-checked']]);
});

test('4.5: two concurrent writers keep both harnesses', POSIX_ONLY, async () => {
  const scratch = createScratch('doflow-login-race-');
  const env = childEnv(scratch);
  const modulePath = path.resolve(__dirname, '../../../src/runtime/worker/login-store.ts');
  const script = (id: string) => `const s = require(${JSON.stringify(modulePath)});
for (let i = 0; i < 15; i += 1) s.recordRecipeAnswer(process.env, ${JSON.stringify(id)}, { state: 'logged-in', reason: null, at: new Date().toISOString(), billing: null, providers: [], checked: 1, listed: 0 }, 'sha256:' + i, { known: ['a', 'b'] });`;
  const { spawn } = require('node:child_process');
  const runOne = (id: string) => new Promise((resolve) => spawn(process.execPath, ['-e', script(id)], { env, stdio: 'inherit' }).on('exit', resolve));
  const codes = await Promise.all([runOne('a'), runOne('b')]);
  assert.deepEqual(codes, [0, 0]);
  const disk = JSON.parse(fs.readFileSync(path.join(scratch.xdg, 'doflow', 'state', 'harness-login.json'), 'utf8'));
  assert.deepEqual(Object.keys(disk.harnesses).sort(), ['a', 'b']);
  assert.equal(disk.revision, 30);
  assert.equal(disk.harnesses.a.recipe.digest, 'sha256:14');
  assert.equal(disk.harnesses.b.recipe.digest, 'sha256:14');
});

test('4.5: 65 entries keep 64 (the oldest goes) and ids no worker catalogue knows are dropped', () => {
  const scratch = createScratch('doflow-login-bound-');
  const env = childEnv(scratch);
  const ids = Array.from({ length: 65 }, (_, i) => `h${String(i).padStart(2, '0')}`);
  ids.forEach((id, i) => store.recordRecipeAnswer(env, id, { ...RECIPE_ANSWER, at: at(i * 1000) }, 'd', { known: ids }));
  const kept = Object.keys(store.readLoginStore(env).harnesses);
  assert.equal(kept.length, 64);
  assert.ok(!kept.includes('h00') && kept.includes('h64'));
  store.recordRecipeAnswer(env, 'h64', RECIPE_ANSWER, 'd', { known: ['h63', 'h64'] });
  assert.deepEqual(Object.keys(store.readLoginStore(env).harnesses).sort(), ['h63', 'h64']);
  assert.equal(store.MAX_BYTES, 128 * 1024);
});

test('4.5: a succeeded run is not written again while the harness reads logged-in from a run under 1 h old', () => {
  const scratch = createScratch('doflow-login-quiet-');
  const env = childEnv(scratch);
  const file = path.join(scratch.xdg, 'doflow', 'state', 'harness-login.json');
  const revision = () => JSON.parse(fs.readFileSync(file, 'utf8')).revision;
  const opts = (offsetMs: number) => ({ now: NOW + offsetMs, known: ['pi'] });
  assert.ok(store.recordRunOutcome(env, 'pi', { outcome: 'expired', runId: 'r1', provider: 'anthropic', sign: 's' }, opts(0)));
  assert.ok(store.recordRunOutcome(env, 'pi', { outcome: 'succeeded', runId: 'r2' }, opts(60000)), 'a success after an expiry is written');
  assert.equal(store.recordRunOutcome(env, 'pi', { outcome: 'succeeded', runId: 'r3' }, opts(120000)), null, 'skipped within the hour');
  assert.equal(revision(), 2);
  assert.ok(store.recordRunOutcome(env, 'pi', { outcome: 'succeeded', runId: 'r4' }, opts(60000 + H)), 'written again after an hour');
  store.recordRecipeAnswer(env, 'pi', { ...RECIPE_ANSWER, state: 'logged-out', at: new Date(NOW + 2 * H).toISOString() }, 'd', { known: ['pi'] });
  assert.ok(store.recordRunOutcome(env, 'pi', { outcome: 'succeeded', runId: 'r5' }, opts(2 * H + 1000)), 'written when a newer recipe answer is what the harness reads');
  assert.equal(store.readLoginStore(env).harnesses.pi.run.runId, 'r5');
});

test('4.5: an unreadable store file is set aside on the next write and read as empty before it', () => {
  const scratch = createScratch('doflow-login-torn-');
  const env = childEnv(scratch);
  const file = path.join(scratch.xdg, 'doflow', 'state', 'harness-login.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{torn');
  assert.deepEqual(store.readLoginStore(env).harnesses, {});
  assert.ok(store.recordRecipeAnswer(env, 'pi', RECIPE_ANSWER, 'd', { known: ['pi'] }));
  assert.deepEqual(Object.keys(store.readLoginStore(env).harnesses), ['pi']);
});
