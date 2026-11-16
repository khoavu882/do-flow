'use strict';

// G84 -- the secret-printing flags and subcommands are data with evidence, and no argv of a worker block carries
// one (row 172, D9). It protects:
//   G84.1 a package worker whose loginProbe.argv, modelList.argv, a model check's argv, cli.versionArgv or any other
//         capability argv holds a flag or command that prints a credential is refused through the package
//         workerValidator, whatever its binary (a long flag and an owner entry apply to every binary; a short form
//         and a command of a set only to that binary's own descriptor)
//   G84.2 the matcher: a command is contiguous exact argv elements, so `auth --json export` is not `auth export`;
//         placeholders are never matched; a worker's own `secretFlags` add to the built-in set and are checked for shape
//   G84.3 every built-in descriptor passes its own check
//   G84.4 each set's evidence file exists, is a passing cli-check record of that binary, and its matched help lines
//         show every flag and command of the set (the lines came from `--help` forms, never from a login)
//
// The set is checked by src/registry/secret-flags.ts; src/registry/index.ts validateWorker() is its one caller.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { SECRET_BINARIES, secretProblem, secretFlagsProblem } = require('../../src/registry/secret-flags.ts');
const { cliVersionMatches, checksEstablish } = require('../helper/worker-evidence.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');

const registry = loadRegistry({ repoRoot: REPO });
const workerOf = (id: string) => structuredClone(registry.harnesses.find((h: any) => h.id === id).worker);
const supported = (argv: string[]) => ({ status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-11-16', argv });
// 172 design §3.1: a supported loginProbe is a login recipe; the least one is exit 0 logged in, exit 1 logged out.
const login = (argv: string[]) => ({ ...supported(argv), output: 'none', answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }], expiry: 'not-seen' });

/** A package worker for a made-up binary, passed through the package point validator. */
function packageErrors(change: (worker: any) => void): string {
  const w = workerOf('claude');
  w.cli = { ...w.cli, status: 'supported', evidence: ['test'], binary: 'mycli', versionArgv: ['--version'] };
  change(w);
  return POINT_VALIDATORS['worker-v1']('mycli', w, { packageId: 'acme' }).join('\n');
}

test('G84.1 a package worker whose loginProbe.argv holds --credentials is refused, naming worker.loginProbe.argv', () => {
  assert.equal(packageErrors((w) => { w.loginProbe = login(['auth', 'check']); }), '');
  assert.match(
    packageErrors((w) => { w.loginProbe = login(['auth', 'check', '--credentials']); }),
    /package 'acme' worker 'mycli' worker 'loginProbe': argv must not contain the secret-printing flag or command '--credentials'/,
  );
});

test('G84.1 a package worker whose loginProbe.providers.argv holds print-api-key is refused, naming loginProbe and providers.argv', () => {
  const withProviders = (providersArgv: string[]) => (w: any) => {
    w.loginProbe = { ...login(['auth', 'check', '--provider', '{provider}']), output: 'json',
      providers: { argv: providersArgv, parse: 'lines', emptyMeans: 'unknown' } };
  };
  assert.equal(packageErrors(withProviders(['auth', 'list-keys'])), '', 'control: the same recipe without the secret command is accepted');
  const errors = packageErrors(withProviders(['auth', 'print-api-key']));
  assert.match(errors, /worker 'loginProbe'/);
  assert.match(errors, /providers\.argv/);
  assert.match(errors, /secret-printing flag or command 'print-api-key'/);
});

test('G84.1 modelList.argv, a model check, cli.versionArgv and any capability argv are refused too', () => {
  assert.match(packageErrors((w) => { w.modelList = { status: 'supported', argv: ['auth', 'print-api-key'], parse: 'lines' }; }),
    /worker 'modelList': argv must not contain the secret-printing flag or command 'print-api-key'/);
  assert.match(packageErrors((w) => { w.modelChecks = [{ id: 'one', argv: ['--show-token'], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 5 }]; }),
    /worker 'modelChecks\[0\]': argv must not contain the secret-printing flag or command '--show-token'/);
  assert.match(packageErrors((w) => { w.cli.versionArgv = ['--print-token=x']; }),
    /worker 'cli': versionArgv must not contain the secret-printing flag or command '--print-token=x'/);
  assert.match(packageErrors((w) => { w.runnableProbe = supported(['auth', 'print-bearer-token']); }),
    /worker 'runnableProbe': argv must not contain the secret-printing flag or command 'print-bearer-token'/);
});

test('G84.2 a command is contiguous: `auth export` is refused for opencode, `auth --json export` and another binary\'s `auth export` are not', () => {
  const at = (binary: string, argv: string[]) => secretProblem(argv, { binary });
  assert.equal(at('opencode', ['auth', 'export']), 'auth export');
  assert.equal(at('opencode', ['x', 'auth', 'export', '--json']), 'auth export');
  assert.equal(at('opencode', ['auth', '--json', 'export']), null);
  assert.equal(at('opencode', ['export', 'auth']), null);
  assert.equal(at('mycli', ['auth', 'export']), null, 'a set\'s command is its own binary\'s');
  assert.equal(at('pi', ['auth', 'print-api-key']), 'auth print-api-key');
  assert.equal(at('claude', ['setup-token']), 'setup-token');
  assert.equal(at('pi', ['setup-token']), null);
  // A long flag of a set and the owner's entries apply to every binary.
  assert.equal(at('mycli', ['--credentials']), '--credentials');
  assert.equal(at('mycli', ['--credentials=1']), '--credentials=1');
  assert.equal(at('mycli', ['print-bearer-token']), 'print-bearer-token');
  assert.equal(at('mycli', ['--show-token']), '--show-token');
  assert.equal(at('mycli', ['--credentialsx']), null);
});

test('G84.2 placeholders are never matched, and `--` does not end the scan', () => {
  assert.equal(secretProblem(['auth', '{provider}'], { binary: 'pi' }), null);
  assert.equal(secretProblem(['--', 'print-api-key'], { binary: 'mycli' }), 'print-api-key');
  assert.equal(secretProblem([1, null, {}], { binary: 'pi' }), null);
});

test('G84.2 a worker\'s own secretFlags add to the built-in set, a short form only for its own binary, and are checked for shape', () => {
  const declared = [{ flag: '--reveal', short: '-R' }, { command: ['keys', 'dump'] }];
  const at = (argv: string[]) => secretProblem(argv, { binary: 'mycli', declared });
  assert.equal(at(['--reveal']), '--reveal');
  assert.equal(at(['-R']), '-R');
  assert.equal(at(['-Rx']), '-Rx');
  assert.equal(at(['keys', 'dump']), 'keys dump');
  assert.equal(at(['keys', 'list', 'dump']), null);
  assert.equal(secretProblem(['-R'], { binary: 'mycli' }), null, 'no declaration, no short form');
  assert.equal(packageErrors((w) => { w.secretFlags = declared; w.loginProbe = login(['keys', 'dump']); }).includes("command 'keys dump'"), true);
  assert.equal(packageErrors((w) => { w.secretFlags = declared; w.loginProbe = login(['keys', 'list']); }), '');
  for (const bad of ['--x', [], [{}], [{ flag: 'x' }], [{ flag: '--x', command: ['a'] }], [{ flag: '--x', extra: 1 }], [{ command: [] }],
    [{ command: ['a', 'b', 'c', 'd', 'e'] }], [{ command: ['{provider}'] }], [{ command: [' a'] }], [{ command: [''] }], [{ command: 'a b' }],
    [{ command: ['a'], short: '-a' }], [{ flag: '--x', short: 'x' }], Array.from({ length: 33 }, () => ({ flag: '--x' }))]) {
    assert.notEqual(secretFlagsProblem(bad), null, JSON.stringify(bad));
    const errors: string[] = [];
    validateWorker({ ...workerOf('claude'), secretFlags: bad }, "harness 'claude'", errors);
    assert.match(errors.join('\n'), /worker 'secretFlags': /, JSON.stringify(bad));
  }
  assert.equal(secretFlagsProblem(declared), null);
});

test('G84.3 every built-in descriptor passes', () => {
  for (const harness of registry.harnesses) {
    const errors: string[] = [];
    validateWorker(harness.worker, `harness '${harness.id}'`, errors);
    assert.deepEqual(errors.filter((e) => /secret-printing/.test(e)), [], harness.id);
    assert.deepEqual(errors, [], harness.id);
  }
});

/** The first thing wrong with a set's evidence record, or null: a passing cli-check of that binary whose secret-commands check shows each
 * flag and command in a help form. */
function recordProblem(record: any, binary: string, set: any): string | null {
  if (record.binary !== binary) return 'binary';
  if (record.kind !== 'cli-check') return 'kind';
  // The same two checks G41.4 applies (test/helper/worker-evidence.ts): every check equals checks.json, and the version line is the harness's.
  if (typeof record.cliVersion !== 'string' || !cliVersionMatches(record.cliVersion, binary, REPO)) return 'cliVersion is not the harness\'s version line';
  if (!checksEstablish(record, binary, 'mainSession', REPO)) return 'a check differs from checks.json';
  const check = record.checks.find((c: any) => c.id === 'secret-commands');
  if (!check) return 'no secret-commands check';
  if (check.result !== 'pass') return 'secret-commands did not pass';
  if (check.argv.at(-1) !== '--help') return 'not a help form';
  const matched = check.matched.join('\n');
  for (const entry of set.entries) {
    for (const word of [entry.flag, entry.short, ...(entry.command ?? [])].filter(Boolean)) if (!matched.includes(word)) return `'${word}' is not in the matched lines`;
  }
  return null;
}

const recordOf = (binary: string) => JSON.parse(fs.readFileSync(path.join(REPO, SECRET_BINARIES[binary].evidence), 'utf8'));

test('G84.4 a record that differs from checks.json, or whose cliVersion is not the harness\'s, is refused', () => {
  const edits: Array<[string, (record: any) => void]> = [
    ['a check argv is not the one in checks.json', (r) => { r.checks.find((c: any) => c.id === 'secret-commands').argv = ['--help', '--extra']; }],
    ['a check expect is not the one in checks.json', (r) => { r.checks.find((c: any) => c.id === 'secret-commands').expect = ['.']; }],
    ['a check establishes is not the one in checks.json', (r) => { r.checks.find((c: any) => c.id === 'secret-commands').establishes = ['readOnly']; }],
    ['a check is not in checks.json at all', (r) => { r.checks.push({ ...r.checks[0], id: 'invented' }); }],
    ['cliVersion is another harness\'s', (r) => { r.cliVersion = 'x'; }],
  ];
  for (const binary of Object.keys(SECRET_BINARIES)) {
    for (const [what, edit] of edits) {
      const record = recordOf(binary);
      edit(record);
      assert.notEqual(recordProblem(record, binary, SECRET_BINARIES[binary]), null, `${binary}: ${what}`);
    }
  }
});

test('G84.4 every set has an evidence record whose matched help lines show each flag and command', () => {
  assert.deepEqual(Object.keys(SECRET_BINARIES).sort(), ['claude', 'opencode', 'pi']);
  for (const [binary, set] of Object.entries(SECRET_BINARIES) as Array<[string, any]>) {
    const file = path.join(REPO, set.evidence);
    assert.ok(fs.existsSync(file), `${binary}: ${set.evidence} exists`);
    assert.equal(recordProblem(recordOf(binary), binary, set), null, `${binary}: ${set.evidence}`);
    const checks = JSON.parse(fs.readFileSync(path.join(REPO, 'core/worker-evidence', binary, 'checks.json'), 'utf8'));
    assert.ok(checks.checks.some((c: any) => c.id === 'secret-commands'), `${binary}: checks.json declares secret-commands`);
  }
});
