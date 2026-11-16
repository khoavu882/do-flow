'use strict';

// 172 design §3 (L0-L6): `worker.loginProbe` is a declared login recipe. A supported entry carries the recipe of §3.1,
// an unknown or unsupported one only `expirySigns` and `hint` besides the capability-entry fields. Every refusal names
// the JSON location inside the entry it refers to, for a built-in descriptor and for a package worker alike.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');

const registry = loadRegistry({ repoRoot: REPO });
const workerOf = (id: string) => structuredClone(registry.harnesses.find((h: any) => h.id === id).worker);
const fields = { evidence: ['test'], verification: 'v', verifiedOn: '2026-11-16' };

/** Design §3.3, as shipped by T6. */
function piRecipe(): any {
  return {
    status: 'supported', ...fields,
    argv: ['auth', 'check', '--provider', '{provider}', '--json', '--no-refresh'], output: 'json',
    providers: { argv: ['--list-models', '--offline'], parse: 'table-column:provider', emptyMeans: 'logged-out', max: 8 },
    answers: [
      { exit: 0, state: 'logged-in' },
      { exit: 1, when: [{ path: ['reason'], equals: 'provider_not_found' }], state: 'unknown', reason: 'provider-not-found' },
      { exit: 1, when: [{ path: ['status'], equals: 'not_ready' }], state: 'logged-out' },
      { exit: 2, state: 'unknown', reason: 'invalid' },
    ],
    billing: { path: ['authType'], values: {
      oauth: { mode: 'subscription', billing: 'unknown' }, api_key: { mode: 'api-key', billing: 'metered' } } },
    expiry: 'not-seen',
    expirySigns: { signs: ['OAuth refresh failed for {provider}', 'OAuth refresh returned a token that expires too soon for {provider}'],
      basis: 'source', evidence: ['Pi 1.5.2 pi-ai dist/auth/resolve.js:81,114'] },
    hint: 'pi auth login <provider>',
  };
}

function claudeRecipe(): any {
  return {
    status: 'supported', ...fields,
    argv: ['auth', 'status', '--json'], output: 'json',
    answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }],
    billing: { path: ['authMethod'], values: {
      'claude.ai': { mode: 'subscription', billing: 'free' }, oauth_token: { mode: 'subscription', billing: 'free' },
      api_key: { mode: 'api-key', billing: 'metered' }, api_key_helper: { mode: 'api-key', billing: 'metered' } } },
    expiry: 'not-seen', hint: 'claude auth login',
    caveat: 'its help and docs do not show that this check runs offline',
  };
}

/** Every validateWorker error about `loginProbe` for harness `id` carrying `probe`. */
function loginErrors(id: string, probe: any): string[] {
  const worker = workerOf(id);
  worker.loginProbe = probe;
  const errors: string[] = [];
  validateWorker(worker, `harness '${id}'`, errors);
  return errors.filter((message) => message.includes("worker 'loginProbe'"));
}

/** Asserts an error that starts with the entry's location followed by `at`, and that contains `fragment`. */
function refused(errors: string[], at: string, fragment: string, id = 'pi'): void {
  const prefix = `harness '${id}' worker 'loginProbe': ${at}`;
  assert.ok(errors.some((e) => e.startsWith(prefix) && e.includes(fragment)), `expected '${prefix}' ... '${fragment}' in ${JSON.stringify(errors, null, 1)}`);
}

test('the pi recipe of design §3.3 is accepted', () => {
  assert.deepEqual(loginErrors('pi', piRecipe()), []);
});

test('the claude recipe of design §3.3 is accepted, with the LD-1 caveat', () => {
  assert.deepEqual(loginErrors('claude', claudeRecipe()), []);
  const bare = claudeRecipe();
  delete bare.caveat;
  assert.deepEqual(loginErrors('claude', bare), []);
});

test('an unknown entry may carry expirySigns and hint, and nothing else of the recipe', () => {
  const { expirySigns, hint } = piRecipe();
  assert.deepEqual(loginErrors('pi', { status: 'unknown', ...fields, reason: 'no status command', expirySigns, hint }), []);
  refused(loginErrors('pi', { status: 'unknown', ...fields, reason: 'r', answers: piRecipe().answers }), "recipe field 'answers'", 'allowed only when status is supported');
  refused(loginErrors('claude', { status: 'unknown', ...fields, reason: 'r', caveat: 'offline is not shown' }), "recipe field 'caveat'", 'allowed only when status is supported', 'claude');
});

test('a supported entry needs argv, output, answers and expiry', () => {
  const errors = loginErrors('pi', { status: 'supported', ...fields, argv: ['auth', 'status'] });
  for (const field of ['output', 'answers', 'expiry']) refused(errors, `requires recipe field '${field}'`, 'when status is supported');
});

test('L0: an unknown key is refused by name', () => {
  refused(loginErrors('pi', { ...piRecipe(), exitCodes: { 0: 'logged-in' } }), "has unknown field 'exitCodes'", '');
});

test('L0: an entry of 8 KiB + 1 byte is refused, one of 8 KiB is not', () => {
  const sized = (bytes: number) => {
    const entry = claudeRecipe();
    entry.verification = '';
    entry.verification = 'v'.repeat(bytes - Buffer.byteLength(JSON.stringify(entry)));
    assert.equal(Buffer.byteLength(JSON.stringify(entry)), bytes);
    return entry;
  };
  assert.deepEqual(loginErrors('claude', sized(8192)), []);
  refused(loginErrors('claude', sized(8193)), 'the entry is 8193 bytes', 'at most 8192', 'claude');
});

test('L1: {provider} without providers, and providers without {provider}, are refused at argv', () => {
  const noProviders = piRecipe();
  delete noProviders.providers;
  refused(loginErrors('pi', noProviders), 'argv', "must not contain '{provider}' without providers");
  const noSlot = piRecipe();
  noSlot.argv = ['auth', 'check', '--json'];
  refused(loginErrors('pi', noSlot), 'argv', "must contain '{provider}' exactly once when providers is set");
});

test('L1: {provider} twice, or inside a longer element, is refused at argv', () => {
  const twice = piRecipe();
  twice.argv = ['auth', 'check', '--provider', '{provider}', '{provider}'];
  refused(loginErrors('pi', twice), 'argv', "must contain '{provider}' exactly once when providers is set");
  const inside = piRecipe();
  inside.argv = ['auth', 'check', '--provider={provider}'];
  refused(loginErrors('pi', inside), 'argv', "holds '{provider}' inside a longer element");
  const other = piRecipe();
  other.argv.push('{account}');
  refused(loginErrors('pi', other), 'argv', "contains the unknown placeholder '{account}'");
});

test('L1: an empty argv and a placeholder in providers.argv are refused', () => {
  const empty = claudeRecipe();
  empty.argv = [];
  refused(loginErrors('claude', empty), 'argv', 'must not be empty', 'claude');
  const slot = piRecipe();
  slot.providers.argv = ['--list-models', '{provider}'];
  refused(loginErrors('pi', slot), 'providers.argv', 'must not contain a placeholder');
  const parse = piRecipe();
  parse.providers.parse = 'regex:.*';
  refused(loginErrors('pi', parse), 'providers.parse', 'lines, tsv-first-column or table-column:<name>');
});

test('L2: a rule with when under output none is refused at answers[1].when', () => {
  const entry = piRecipe();
  entry.output = 'none';
  delete entry.billing;
  refused(loginErrors('pi', entry), 'answers[1].when', 'needs output "json"');
  const billing = claudeRecipe();
  billing.output = 'none';
  refused(loginErrors('claude', billing), 'billing', 'needs output "json"', 'claude');
});

test('L3: a when test holding regex is refused at answers[1].when[0]', () => {
  const entry = piRecipe();
  entry.answers[1].when = [{ path: ['reason'], regex: '^provider' }];
  refused(loginErrors('pi', entry), 'answers[1].when[0]: ', "unknown key 'regex'");
});

test('L3: contradictory tests are refused at answers[1].when[1]', () => {
  const entry = piRecipe();
  entry.answers[1].when.push({ path: ['reason'], equals: 'other' });
  refused(loginErrors('pi', entry), 'answers[1].when[1]: ', 'contradicts when[0]');
});

test('L3: an answer list with no logged-in state is refused at answers', () => {
  const entry = claudeRecipe();
  entry.answers[0].state = 'unknown';
  refused(loginErrors('claude', entry), 'answers', 'no rule has state "logged-in"', 'claude');
});

test('L3: answers[2] shadowed by answers[1] (same exit, implied tests) is refused at answers[2]', () => {
  const entry = piRecipe();
  entry.answers[2].when = [{ path: ['reason'], equals: 'provider_not_found' }, { path: ['status'], equals: 'not_ready' }];
  refused(loginErrors('pi', entry), 'answers[2] is shadowed by answers[1]', '');
  // A rule with no tests hides every later rule on its exit.
  const bare = piRecipe();
  bare.answers.splice(1, 0, { exit: 1, state: 'logged-out' });
  refused(loginErrors('pi', bare), 'answers[2] is shadowed by answers[1]', '');
});

test('L3: nine answers are refused at answers; a bad exit, state and reason name their answer', () => {
  const nine = claudeRecipe();
  nine.answers = Array.from({ length: 9 }, (_, i) => ({ exit: i, state: 'logged-in' }));
  refused(loginErrors('claude', nine), 'answers', 'holds 1 to 8 rules', 'claude');
  const bad = claudeRecipe();
  bad.answers[1] = { exit: 256, state: 'gone', reason: 'Not-A-Reason' };
  const errors = loginErrors('claude', bad);
  refused(errors, 'answers[1].exit', 'integer from 0 to 255', 'claude');
  refused(errors, 'answers[1].state', 'logged-in, logged-out, expired or unknown', 'claude');
  refused(errors, 'answers[1].reason', 'matches', 'claude');
});

test('L4: a billing path and value set are checked', () => {
  const entry = claudeRecipe();
  entry.billing.path = ['__proto__'];
  refused(loginErrors('claude', entry), 'billing.path[0]: ', "must not be '__proto__'", 'claude');
  const many = claudeRecipe();
  many.billing.values = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`v${i}`, { mode: 'api-key', billing: 'metered' }]));
  refused(loginErrors('claude', many), 'billing.values', 'holds 1 to 16 values', 'claude');
  const mode = claudeRecipe();
  mode.billing.values.api_key.mode = 'card';
  refused(loginErrors('claude', mode), 'billing.values["api_key"].mode', "'subscription' or 'api-key'", 'claude');
});

test('L5: a sign with two {provider} slots is refused at expirySigns.signs[0]', () => {
  const entry = piRecipe();
  entry.expirySigns.signs[0] = 'OAuth refresh failed for {provider} and {provider}';
  refused(loginErrors('pi', entry), 'expirySigns.signs[0]', 'at most one');
  const short = piRecipe();
  short.expirySigns.signs[1] = 'at {provider} failed';
  refused(loginErrors('pi', short), 'expirySigns.signs[1]', 'at least 4 literal characters before');
  const basis = piRecipe();
  basis.expirySigns.basis = 'guess';
  basis.expirySigns.evidence = [];
  const errors = loginErrors('pi', basis);
  refused(errors, 'expirySigns.basis', "'source', 'transcript' or 'unverified'");
  refused(errors, 'expirySigns.evidence', 'non-empty');
});

test('LD-1: a caveat over 160 characters, or holding a control or invisible character, is refused at caveat', () => {
  const long = claudeRecipe();
  long.caveat = 'x'.repeat(161);
  refused(loginErrors('claude', long), 'caveat', '1 to 160 characters', 'claude');
  const hidden = claudeRecipe();
  hidden.caveat = 'runs​offline';
  refused(loginErrors('claude', hidden), 'caveat', 'control or invisible', 'claude');
  const hint = claudeRecipe();
  hint.hint = 'claude\nauth login';
  refused(loginErrors('claude', hint), 'hint', 'control or invisible', 'claude');
});

test('L6: --credentials in argv and a widening flag in providers.argv are refused, each once', () => {
  const secret = piRecipe();
  secret.argv.push('--credentials');
  const errors = loginErrors('pi', secret);
  refused(errors, 'argv', "must not contain the secret-printing flag or command '--credentials'");
  assert.equal(errors.filter((e) => e.includes('--credentials')).length, 1, JSON.stringify(errors));
  const widening = piRecipe();
  widening.providers.argv = ['--list-models', '--approve'];
  refused(loginErrors('pi', widening), 'providers.argv', "must not contain the widening flag '--approve'");
  const listing = piRecipe();
  listing.providers.argv = ['auth', 'print-api-key'];
  refused(loginErrors('pi', listing), 'providers.argv', "must not contain the secret-printing flag or command 'auth print-api-key'");
});

test('a package worker with a shadowed answer is refused through the package workerValidator', () => {
  const worker = workerOf('claude');
  worker.cli = { ...worker.cli, binary: 'mycli' };
  worker.loginProbe = claudeRecipe();
  assert.deepEqual(POINT_VALIDATORS['worker-v1']('mycli', worker, { packageId: 'acme' }).filter((e: string) => e.includes('loginProbe')), []);
  worker.loginProbe.answers.push({ exit: 0, state: 'logged-out' });
  const errors = POINT_VALIDATORS['worker-v1']('mycli', worker, { packageId: 'acme' });
  assert.ok(errors.includes("package 'acme' worker 'mycli' worker 'loginProbe': answers[2] is shadowed by answers[0]: same exit, and answers[0] matches whenever this rule does, so it can never match"), JSON.stringify(errors));
});
