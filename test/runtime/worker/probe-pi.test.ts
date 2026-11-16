'use strict';

// Row 168: probePi asks Pi's own `pi auth check ... --json --no-refresh` when `pi auth --help` shows it, and maps its
// exit codes. No test makes a model call: a fake `pi` shell script on PATH in a scratch dir answers every argv, and a
// second fake is injected through `execFileImpl`. DoFlow never opens `~/.pi/agent/auth.json`: the fs seam throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { probePi } = require('../../../src/runtime/worker/probes/index.ts');
const { suiteTempDir } = require('../../helper/tmp.ts');

// The `pi auth --help` text of pi 1.5.2 (the lines that matter; recorded with `pi auth --help` on 2026-11-16).
const AUTH_HELP = [
  'Usage:',
  '  pi auth login <provider> [--api-key] [--no-browser]',
  '  pi auth logout <provider>',
  '  pi auth print-api-key [--provider <provider>] [--model <model>]',
  '  pi auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]',
  '  pi auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]',
  '',
  'Commands:',
  '  check                   Print ready, not_ready, or invalid; exit with 0, 1, or 2',
].join('\n');
// What `pi --list-models --offline` prints: a header, then one row per model of a provider with usable credentials.
const LIST = [
  'provider        model              context  max-out  thinking  images',
  'anthropic       claude-sonnet-x    200K     64K      yes       yes',
  'anthropic       claude-haiku-x     200K     64K      yes       yes',
  'openai          gpt-x              400K     128K     yes       yes',
  'ollama-local    qwen-x             32K      8K       no        no',
].join('\n');
const CHECKS: Record<string, { exit: number; json: any }> = {
  anthropic: { exit: 0, json: { status: 'ready', provider: 'anthropic', authType: 'oauth' } },
  openai: { exit: 0, json: { status: 'ready', provider: 'openai', authType: 'api_key' } },
  'ollama-local': { exit: 0, json: { status: 'ready', provider: 'ollama-local', authType: 'api_key' } },
  gone: { exit: 1, json: { status: 'not_ready', provider: 'gone', reason: 'credentials_not_configured' } },
  broken: { exit: 2, json: { status: 'invalid', provider: 'broken', reason: 'invalid_state' } },
};

const noFs = {
  existsSync: () => { throw new Error('the probe must not touch the file system'); },
  readFileSync: () => { throw new Error('the probe must not read a file'); },
};

/** A fake `pi`: a script that logs its argv and answers like pi 1.5.2. `models` is what `--list-models` prints. */
function fakePi(dir: string, { help = AUTH_HELP, models = LIST }: { help?: string; models?: string } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    'case "$1 $2" in',
    '  "--version ") echo 1.5.2; exit 0;;',
    `  "auth --help") cat <<'EOF'`,
    help,
    'EOF',
    '  exit 0;;',
    `  "--list-models --offline") cat <<'EOF'`,
    models,
    'EOF',
    '  exit 0;;',
    '  "auth check")',
    '    case "$4" in',
    ...Object.entries(CHECKS).map(([name, { exit, json }]) => `      ${name}) echo '${JSON.stringify(json)}'; exit ${exit};;`),
    '      *) echo "unknown provider" >&2; exit 2;;',
    '    esac;;',
    'esac',
    'exit 3',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'pi'), script, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('pi probe: with the check command in `pi auth --help`, a ready provider is logged in and each provider is asked once', async () => {
  const dir = suiteTempDir('doflow-probe-pi-ready-');
  const { env, calls } = fakePi(dir);
  const res: any = await probePi({ env, homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.equal(res.installed, true);
  assert.equal(res.version, '1.5.2');
  assert.equal(res.loginState, 'logged-in');
  assert.equal(res.reloginHint, null);
  assert.equal(res.loginCheck.method, 'pi-auth-check');
  assert.deepEqual(res.loginCheck.providers, [
    { provider: 'anthropic', status: 'ready', authType: 'oauth' },
    { provider: 'openai', status: 'ready', authType: 'api_key' },
    { provider: 'ollama-local', status: 'ready', authType: 'api_key' },
  ]);
  // The command line is exactly Pi's documented one: never the credential-printing options.
  const checks = calls().filter((c: string) => c.startsWith('auth check'));
  assert.deepEqual(checks, [
    'auth check --provider anthropic --json --no-refresh',
    'auth check --provider openai --json --no-refresh',
    'auth check --provider ollama-local --json --no-refresh',
  ]);
  assert.ok(!calls().some((c: string) => /--credentials|print-api-key|print-bearer-token|login|logout/.test(c)), calls().join('\n'));
});

test('pi probe: the exit codes map 0 ready, 1 not ready, 2 invalid; the stated limit on an expired OAuth login rides in the result', async () => {
  const dir = suiteTempDir('doflow-probe-pi-exits-');
  const only = (name: string) => `provider model\n${name} m-x 1K 1K no no`;

  const gone: any = await probePi({ ...fakePi(path.join(dir, 'a'), { models: only('gone') }), homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.equal(gone.loginState, 'logged-out');
  assert.equal(gone.reloginHint, 'pi');
  assert.deepEqual(gone.loginCheck.providers, [{ provider: 'gone', status: 'not_ready' }]);

  const broken: any = await probePi({ ...fakePi(path.join(dir, 'b'), { models: only('broken') }), homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.equal(broken.loginState, 'error');
  assert.deepEqual(broken.loginCheck.providers, [{ provider: 'broken', status: 'invalid' }]);

  // One ready provider among others that are not is still logged in.
  const mixed: any = await probePi({ ...fakePi(path.join(dir, 'c'), { models: `provider model\ngone m 1 1 n n\nbroken m 1 1 n n\nopenai m 1 1 n n` }), homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.equal(mixed.loginState, 'logged-in');
  assert.deepEqual(mixed.loginCheck.providers.map((p: any) => p.status), ['not_ready', 'invalid', 'ready']);

  assert.match(gone.loginCheck.limit, /expired/i);
  assert.match(gone.loginCheck.limit, /--no-refresh/);
});

test('pi probe: no provider with usable credentials means logged out and no check is run', async () => {
  const dir = suiteTempDir('doflow-probe-pi-none-');
  const { env, calls } = fakePi(dir, { models: 'No models available. Use /login to log into a provider via OAuth or API key.' });
  const res: any = await probePi({ env, homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.equal(res.loginState, 'logged-out');
  assert.equal(res.reloginHint, 'pi');
  assert.deepEqual(res.loginCheck.providers, []);
  assert.deepEqual(calls().filter((c: string) => c.startsWith('auth check')), []);
});

test('pi probe: the billing mode comes from the authType of the ready providers', async () => {
  const dir = suiteTempDir('doflow-probe-pi-mode-');
  const one = async (sub: string, name: string) => probePi({ ...fakePi(path.join(dir, sub), { models: `provider model\n${name} m 1 1 n n` }), homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  const oauth: any = await one('o', 'anthropic');
  assert.deepEqual([oauth.detectedMode, oauth.derivedBilling], ['subscription', 'unknown']);
  const key: any = await one('k', 'openai');
  assert.deepEqual([key.detectedMode, key.derivedBilling], ['api-key', 'metered']);
  const both: any = await probePi({ ...fakePi(path.join(dir, 'b')), homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  assert.deepEqual([both.detectedMode, both.derivedBilling], ['unverified', 'unknown']);
});

test('pi probe: without the check command in `pi auth --help` it falls back to the models.json and key guess and says so', async () => {
  const dir = suiteTempDir('doflow-probe-pi-fallback-');
  const { env, calls } = fakePi(dir, { help: 'Usage:\n  pi auth login <provider>\n  pi auth logout <provider>' });
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), '{}');
  const res: any = await probePi({ env, homeDir: home, timeoutMs: 10000 });
  assert.equal(res.loginState, 'logged-in');
  assert.equal(res.detectedMode, 'api-key');
  assert.equal(res.loginCheck.method, 'fallback');
  assert.match(res.loginCheck.reason, /does not show the check command/);
  assert.match(res.loginCheck.limit, /models\.json/);
  assert.deepEqual(calls().filter((c: string) => c.startsWith('auth check') || c.startsWith('--list-models')), []);

  // The same fallback when the help command fails; and logged out when the guess finds nothing.
  const bare = suiteTempDir('doflow-probe-pi-bare-');
  const noHelp = (bin: string, args: string[], opts: any, cb: any) => {
    if (args[0] === '--version') cb(null, 'pi 1.4.0\n', '');
    else { const err: any = new Error('exit 1'); err.code = 1; cb(err, '', 'nope'); }
  };
  const res2: any = await probePi({ execFileImpl: noHelp, homeDir: bare, env: {} });
  assert.equal(res2.loginState, 'logged-out');
  assert.equal(res2.loginCheck.method, 'fallback');
});

test('pi probe: a missing binary is not installed, and the check path never reads auth.json', async () => {
  const gone = (bin: string, args: string[], opts: any, cb: any) => { const err: any = new Error('spawn ENOENT'); err.code = 'ENOENT'; cb(err, '', ''); };
  const res: any = await probePi({ execFileImpl: gone, homeDir: suiteTempDir('doflow-probe-pi-gone-'), env: {}, fsImpl: noFs });
  assert.equal(res.installed, false);
  assert.equal(res.loginState, 'logged-out');
});

test('pi probe: the provider names read from the list are checked for shape and capped before they reach a command line', async () => {
  const dir = suiteTempDir('doflow-probe-pi-shape-');
  const rows = ['provider model', '--credentials m 1 1 n n', 'ok-one m 1 1 n n', 'bad/name m 1 1 n n', ...Array.from({ length: 12 }, (_, i) => `p${i} m 1 1 n n`)].join('\n');
  const { env, calls } = fakePi(dir, { models: rows });
  await probePi({ env, homeDir: dir, fsImpl: noFs, timeoutMs: 10000 });
  const asked = calls().filter((c: string) => c.startsWith('auth check'));
  assert.equal(asked.length, 8);
  assert.ok(!asked.some((c: string) => c.includes('--credentials') || c.includes('bad/name')), asked.join('\n'));
});
