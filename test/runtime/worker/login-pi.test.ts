'use strict';

// 172 T6: the shipped login recipes (core/registry/harnesses.json `worker.loginProbe`) against fake binaries. The pi
// recipe gives each row of design 5.2 (the AC-2 table; each case of the deleted probe-pi.test.ts has its counterpart
// here), the claude recipe each documented exit and authMethod, and the five harnesses with no recipe read `unknown`
// with their reason and are not blocked by it (AC-6). Every process is the fake harness CLI linked into a scratch
// bin/ under a scratch HOME and config home, reached through `binaryPath` or a descriptor naming `fake-<id>`: no real
// harness is run and no credential file is read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
const { linkBin, writeScenario, readLog } = require('../../helper/fake-harness-cli.ts');

const REPO = path.resolve(__dirname, '..', '..', '..');
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const login = require(path.join(REPO, 'src', 'runtime', 'worker', 'login.ts'));

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const NOW = Date.parse('2026-11-16T10:00:00.000Z');
const NO_RECIPE = ['codex', 'opencode', 'copilot', 'kiro', 'antigravity'];

const shipped = (id: string) => structuredClone(loadRegistry({ repoRoot: REPO }).harnesses.find((h: any) => h.id === id).worker);

/** A scratch HOME and config home and a bin/ holding `fake-<name>` for each name; `scenario` answers by argv. */
function rig(names: string[], scenario: any = {}) {
  const scratch = createScratch('doflow-login-shipped-');
  const bin = path.join(scratch.dir, 'bin');
  const childPath = linkBin(bin, names.map((name) => `fake-${name}`));
  const log = path.join(scratch.dir, 'log.jsonl');
  const env = childEnv(scratch, { PATH: childPath, FAKE_HARNESS_SCENARIO: writeScenario(scratch.dir, scenario), FAKE_HARNESS_LOG: log });
  return { scratch, bin, env, cwd: scratch.dir, calls: () => readLog(log).map((entry: any) => entry.argv) };
}

// ── pi: design 5.2 ───────────────────────────────────────────────────────────────────────────────────────────────

const LISTING = ['--list-models', '--offline'];
const checkArgv = (provider: string) => ['auth', 'check', '--provider', provider, '--json', '--no-refresh'];
const table = (providers: string[]) => ['provider     model', ...providers.map((p) => `${p}     ${p}-model`)].join('\n');
const said = (provider: string, fields: any, exit: number) => ({ argv: checkArgv(provider), steps: [{ print: JSON.stringify({ provider, ...fields }) }, { exit }] });

/** The shipped pi recipe run once against a fake pi whose listing and checks follow `byArgv`. */
async function pi(byArgv: any[], extra: any = {}) {
  const r = rig(['pi'], { byArgv });
  const answer = await login.checkLogin({ harness: 'pi', worker: shipped('pi'), env: r.env, cwd: r.cwd, now: NOW, binaryPath: path.join(r.bin, 'fake-pi'), ...extra });
  return { answer, calls: r.calls() };
}
const listing = (providers: string[]) => ({ argv: LISTING, steps: [{ print: table(providers) }, { exit: 0 }] });
const READY_OAUTH = { status: 'ready', authType: 'oauth' };
const NOT_READY = { status: 'not_ready' };

test('the shipped pi recipe against a fake pi gives each row of design §5.2', POSIX_ONLY, async () => {
  const fails = await pi([{ argv: LISTING, steps: [{ exit: 1 }] }]);
  assert.deepEqual([fails.answer.state, fails.answer.reason], ['unknown', 'providers-unlisted'], 'listing fails');

  const empty = await pi([listing([])]);
  assert.deepEqual([empty.answer.state, empty.answer.reason], ['logged-out', 'no-provider-listed'], 'empty listing');
  assert.deepEqual(empty.calls, [LISTING], 'no check runs when no provider is listed');

  const one = await pi([listing(['anthropic']), said('anthropic', READY_OAUTH, 0)]);
  assert.deepEqual([one.answer.state, one.answer.reason, one.answer.billing], ['logged-in', null, { mode: 'subscription', billing: 'unknown' }], 'anthropic oauth');
  assert.deepEqual(one.calls, [LISTING, checkArgv('anthropic')], 'the listing once, then each provider once');

  const two = await pi([listing(['anthropic', 'openai']), said('anthropic', READY_OAUTH, 0), said('openai', { status: 'ready', authType: 'api_key' }, 0)]);
  assert.deepEqual([two.answer.state, two.answer.billing], ['logged-in', 'mixed'], 'anthropic oauth and openai api_key');
  assert.deepEqual(two.answer.providers.map((p: any) => [p.id, p.state, p.mode]), [['anthropic', 'logged-in', 'subscription'], ['openai', 'logged-in', 'api-key']]);

  const gone = await pi([listing(['gone']), said('gone', NOT_READY, 1)]);
  assert.deepEqual([gone.answer.state, gone.answer.reason], ['logged-out', null], 'gone: not_ready');

  const broken = await pi([listing(['broken']), said('broken', { status: 'invalid' }, 2)]);
  assert.deepEqual([broken.answer.state, broken.answer.reason], ['unknown', 'invalid'], 'broken: exit 2');

  const ext = await pi([listing(['ext']), said('ext', { status: 'not_ready', reason: 'provider_not_found' }, 1)]);
  assert.deepEqual([ext.answer.state, ext.answer.reason], ['unknown', 'provider-not-found'], 'ext: provider_not_found');

  // The runner's own 3 s bound, not a lowered one: the fake sleeps past it.
  const slow = await pi([listing(['slow']), { argv: checkArgv('slow'), steps: [{ sleep: 4000 }, { print: JSON.stringify(READY_OAUTH) }, { exit: 0 }] }]);
  assert.deepEqual([slow.answer.state, slow.answer.reason], ['unknown', 'timeout'], 'slow: past 3 s');

  const nine = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
  const many = await pi([listing(nine), ...nine.map((p) => said(p, NOT_READY, 1))]);
  assert.deepEqual([many.answer.state, many.answer.reason, many.answer.checked, many.answer.listed, many.answer.billing], ['unknown', 'providers-partial', 8, 9, null], '9 providers');
  assert.equal(many.calls.filter((argv: string[]) => argv[0] === 'auth').length, 8, 'at most eight checks');

  const text = await pi([listing(['anthropic']), { argv: checkArgv('anthropic'), steps: [{ print: 'Usage: pi auth login <provider>' }, { exit: 1 }] }]);
  assert.deepEqual([text.answer.state, text.answer.reason], ['unknown', 'unparseable-output'], 'exit 1 with stdout that is not JSON (an older pi)');
});

test('pi: a listed name that is not a provider id never reaches a command line', POSIX_ONLY, async () => {
  const { answer, calls } = await pi([listing(['-rf', 'a;b', 'anthropic']), said('anthropic', READY_OAUTH, 0)]);
  assert.equal(answer.state, 'logged-in');
  assert.deepEqual(calls, [LISTING, checkArgv('anthropic')]);
});

test('pi: a check ended by a signal is unknown, and logged-out needs every checked provider to say not_ready', POSIX_ONLY, async () => {
  const signal = await pi([listing(['anthropic'])], {
    spawn: async (opts: any) => (opts.argv[0] === 'auth'
      ? { status: 'exited', code: null, signal: 'SIGKILL', stdout: '', truncated: false }
      : require(path.join(REPO, 'src', 'runtime', 'worker', 'process-tree.ts')).spawnBounded(opts)),
  });
  assert.deepEqual([signal.answer.state, signal.answer.reason], ['unknown', 'signal SIGKILL']);
  const partly = await pi([listing(['gone', 'broken']), said('gone', NOT_READY, 1), said('broken', { status: 'invalid' }, 2)]);
  assert.deepEqual([partly.answer.state, partly.answer.reason], ['unknown', 'invalid']);
});

test('pi: a missing binary is unknown not-installed, never logged-out, and starts no process', POSIX_ONLY, async () => {
  const r = rig([]);
  const answer = await login.checkLogin({ harness: 'pi', worker: shipped('pi'), env: { ...r.env, PATH: path.join(r.cwd, 'empty') }, cwd: r.cwd, now: NOW });
  assert.deepEqual([answer.state, answer.reason], ['unknown', 'not-installed']);
  assert.deepEqual(r.calls(), []);
});

test('pi: the shipped recipe cannot see expiry, and its signs (basis source, O-4) match the text Pi 1.5.2 throws', () => {
  const worker = shipped('pi');
  assert.equal(worker.loginProbe.expiry, 'not-seen');
  assert.equal(worker.loginProbe.expirySigns.basis, 'source');
  assert.match(worker.loginProbe.expirySigns.evidence.join(' '), /Pi 1\.5\.2 .*dist\/auth\/resolve\.js:81,114.*not seen on a live run/);
  const report = { status: 'failure', summary: 'Error: OAuth refresh failed for anthropic. Run pi auth login anthropic.' };
  assert.deepEqual(login.loginExpiredOf(report, worker), { sign: 'OAuth refresh failed for {provider}', provider: 'anthropic' });
  const soon = { status: 'failure', summary: 'OAuth refresh returned a token that expires too soon for openai' };
  assert.equal(login.loginExpiredOf(soon, worker).provider, 'openai');
  const answer = login.loginAnswerOf({ harness: 'pi', worker, record: null, now: NOW });
  assert.deepEqual([answer.expirySeen, answer.hint, answer.caveat], [false, 'pi auth login <provider>', null]);
});

// ── claude: exit 0 per authMethod, exit 1, exit 3 ───────────────────────────────────────────────────────────────

const CLAUDE_ARGV = ['auth', 'status', '--json'];

async function claude(steps: any[]) {
  const r = rig(['claude'], { byArgv: [{ argv: CLAUDE_ARGV, steps }] });
  const worker = shipped('claude');
  const answer = await login.checkLogin({ harness: 'claude', worker, env: r.env, cwd: r.cwd, now: NOW, binaryPath: path.join(r.bin, 'fake-claude') });
  return { answer, worker, calls: r.calls() };
}
const status = (authMethod: string, loggedIn = true) => [{ print: JSON.stringify({ loggedIn, authMethod, apiProvider: 'firstParty' }) }, { exit: loggedIn ? 0 : 1 }];

test('the shipped claude recipe: exit 0 with claude.ai, api_key and third_party, exit 1 and exit 3', POSIX_ONLY, async () => {
  const sub = await claude(status('claude.ai'));
  assert.deepEqual([sub.answer.state, sub.answer.billing], ['logged-in', { mode: 'subscription', billing: 'free' }]);
  assert.deepEqual(sub.calls, [CLAUDE_ARGV]);
  const key = await claude(status('api_key'));
  assert.deepEqual([key.answer.state, key.answer.billing], ['logged-in', { mode: 'api-key', billing: 'metered' }]);
  const cloud = await claude(status('third_party'));
  assert.deepEqual([cloud.answer.state, cloud.answer.billing], ['logged-in', null], 'third_party is left unmapped: no billing is reported');
  const out = await claude(status('none', false));
  assert.deepEqual([out.answer.state, out.answer.reason, out.answer.billing], ['logged-out', null, null]);
  const odd = await claude([{ exit: 3 }]);
  assert.deepEqual([odd.answer.state, odd.answer.reason], ['unknown', 'exit 3']);

  // O-2 / LD-1: the answer's "how it was learned" carries the recipe's caveat, in the doctor cell too.
  const record = { recipe: { ...sub.answer, digest: login.recipeDigest(sub.worker) }, run: null };
  const answer = login.loginAnswerOf({ harness: 'claude', worker: sub.worker, record, now: NOW });
  assert.equal(answer.caveat, 'its help and docs do not show that this check runs offline');
  assert.equal(login.loginCell(answer), 'logged-in (login check, 2026-11-16T10:00:00.000Z; its help and docs do not show that this check runs offline)');
});

test('the claude recipe cites its cli-check record, which says in plain words that running offline is not shown', () => {
  const probe = shipped('claude').loginProbe;
  assert.ok(probe.evidence.includes('core/worker-evidence/claude/2026-11-16-cli-check-login-recipe.json'));
  assert.ok(probe.evidence.some((item: string) => item.startsWith('https://code.claude.com/docs/en/cli-reference')));
  const record = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'worker-evidence', 'claude', '2026-11-16-cli-check-login-recipe.json'), 'utf8'));
  assert.equal(record.checks.find((check: any) => check.id === 'login-recipe').result, 'pass');
  assert.match(record.caveats.join(' '), /Running offline is not shown/);
});

// ── AC-6: the five harnesses with no recipe ─────────────────────────────────────────────────────────────────────

test('AC-6: codex, opencode, copilot, kiro and antigravity read unknown with their loginProbe.reason and start no process', POSIX_ONLY, async () => {
  const r = rig(NO_RECIPE);
  const store = require(path.join(REPO, 'src', 'runtime', 'worker', 'login-store.ts'));
  for (const id of NO_RECIPE) {
    const worker = shipped(id);
    assert.equal(worker.loginProbe.status, 'unknown', id);
    assert.ok(worker.loginProbe.reason.length <= 200, `${id} reason is at most 200 characters`);
    worker.cli = { ...worker.cli, binary: `fake-${id}` };
    const ran = await login.checkLogin({ harness: id, worker, env: r.env, cwd: r.cwd, now: NOW, spawn: () => assert.fail(`${id}: no process starts`) });
    assert.deepEqual([ran.state, ran.reason], ['unknown', 'no-recipe'], id);
    const answer = login.loginAnswerOf({ harness: id, worker, record: store.readLoginStore(r.env).harnesses[id] ?? null, now: NOW });
    assert.equal(answer.state, 'unknown', id);
    assert.equal(answer.source, 'never-checked', id);
    assert.equal(answer.reason, `no-recipe: ${Array.from(worker.loginProbe.reason as string).slice(0, 120).join('')}`, id);
    assert.match(login.loginCell(answer), /^unknown \(no login check: /, id);
  }
  assert.deepEqual(r.calls(), []);
});
