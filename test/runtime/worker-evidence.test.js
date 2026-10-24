'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { storeFileFor } = require('../../src/runtime/worker/run-store.ts');
const { executeWorkerCommand } = require('../../src/runtime/worker/command.ts');

const SLUG = 'feat-worker-evidence';
const RUN_ID = 'w-0123456789ab';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234';

function registry() {
  return {
    harnesses: [{
      id: 'codex',
      worker: {
        cli: { status: 'supported', binary: 'codex', versionArgv: ['--version'] },
      },
    }],
    coverage: {},
  };
}

function project(t) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-evidence-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(bin);
  const fake = path.join(bin, 'codex');
  fs.writeFileSync(fake, `#!/bin/sh
if [ -n "$FAKE_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_LOG"; fi
if [ "$1" = "--version" ]; then
  if [ "$FAKE_VERSION_FAIL" = "1" ]; then printf '%s\\n' 'not a codex version'
  elif [ "$FAKE_VERSION_SECRET" = "1" ]; then printf '%s\\n' 'codex-cli 0.163.0 api_token=${TOKEN}'
  else printf '%s\\n' 'codex-cli 0.163.0'; fi
  exit "\${FAKE_VERSION_EXIT:-0}"
fi
if [ "$1" = "check" ]; then
  printf '%s\\n' 'Usage: codex exec [OPTIONS] [PROMPT]'
  if [ "$FAKE_MISSING_EXPECT" != "1" ]; then printf '%s\\n' 'instructions are read from stdin'; fi
  exit 0
fi
if [ "$1" = "failexit" ]; then
  printf '%s\\n' 'Usage: codex exec [OPTIONS] [PROMPT]'
  exit 4
fi
if [ "$1" = "secret" ]; then
  printf '%s\\n' 'api_token=${TOKEN}'
  exit 0
fi
exit 3
`, { mode: 0o755 });
  // A second, valid-looking binary: only the checks-file binary binding keeps a record from using it.
  fs.writeFileSync(path.join(bin, 'other'), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.163.0'\n", { mode: 0o755 });
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({
    schema: 'doflow-worker-checks-v1',
    harness: 'codex',
    binary: 'codex',
    version: { argv: ['--version'], expect: '^codex-cli \\d+\\.\\d+\\.\\d+' },
    checks: [
      {
        id: 'two-expects', argv: ['check', '--help'],
        expect: ['^Usage: codex exec \\[OPTIONS\\] \\[PROMPT\\]$', '^instructions are read from stdin$'],
        establishes: ['oneShot'],
      },
      { id: 'masked-line', argv: ['secret', '--help'], expect: ['^api_token='], establishes: ['structuredOutput'] },
    ],
  }, null, 2));
  return {
    dir,
    checks,
    out: path.join(dir, 'evidence.json'),
    log: path.join(dir, 'fake.log'),
    env: { ...process.env, PATH: bin, FAKE_LOG: path.join(dir, 'fake.log'), FAKE_VERSION_FAIL: '0', FAKE_MISSING_EXPECT: '0', TEST_ENV_SECRET: 'must-not-be-recorded' },
  };
}

function writeRun(p, run) {
  const file = storeFileFor(p.dir, SLUG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ slug: SLUG, runs: { [run.runId]: { ...run, seq: 0 } } }));
  return file;
}

function endedRun(overrides = {}) {
  return {
    runId: RUN_ID,
    phase: 'ended',
    harness: 'codex',
    cliVersion: 'codex-cli 0.163.0',
    edit: null,
    recipe: {
      binary: 'codex',
      argvShape: ['exec', '-o', '<last-message-file>', '<prompt sha256:0123456789 bytes:12>'],
      parser: 'codex-exec-json-v1',
    },
    process: { kind: 'exited', code: 0, signal: null, leftover: { status: 'clean' } },
    end: { state: 'exited', at: '2026-10-18T11:59:00.000Z' },
    report: { parser: 'codex-exec-json-v1', status: 'success', reason: null, deniedCount: 0, usage: { tokens: 7 }, summary: 'PRIVATE MODEL SUMMARY' },
    readOnly: { status: 'clean', changes: [], head: { before: 'a'.repeat(40), after: 'a'.repeat(40) }, refsChanged: [] },
    isolation: null,
    output: { stdout: { bytes: 36 }, stderr: { bytes: 0 } },
    prompt: { path: '/private/prompt.md', text: 'PRIVATE PROMPT TEXT' },
    ...overrides,
  };
}

function rewriteChecks(p, edit) {
  const data = JSON.parse(fs.readFileSync(p.checks, 'utf8'));
  edit(data);
  fs.writeFileSync(p.checks, JSON.stringify(data, null, 2));
}

function fakeCalls(p) {
  return fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8').split('\n').filter(Boolean) : [];
}

async function evidence(p, flags = {}) {
  return executeWorkerCommand({
    action: 'evidence', harness: 'codex', slug: SLUG, out: p.out, checks: p.checks,
    env: p.env, cwd: p.dir, registry: registry(), now: () => NOW,
    ...flags,
  });
}

test('CLI-check evidence runs a fake version and checks every expect, masks matched lines, and sorts keys', async (t) => {
  const p = project(t);
  const result = await evidence(p);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.body.disposition, 'recorded');
  assert.deepEqual(result.body.establishes, ['oneShot', 'structuredOutput']);

  const record = JSON.parse(fs.readFileSync(p.out, 'utf8'));
  assert.equal(record.schema, 'doflow-worker-evidence-v1');
  assert.equal(record.kind, 'cli-check');
  assert.equal(record.cliVersion, 'codex-cli 0.163.0');
  assert.deepEqual(record.establishes, ['oneShot', 'structuredOutput']);
  assert.deepEqual(record.checks[0].expect.length, 2);
  assert.equal(record.checks[0].result, 'pass');
  assert.deepEqual(record.checks[0].matched, [
    'Usage: codex exec [OPTIONS] [PROMPT]',
    'instructions are read from stdin',
  ]);
  assert.equal(record.checks[1].result, 'pass');
  assert.equal(record.checks[1].matched.length, 1);
  assert.match(record.checks[1].matched[0], /^api_token=<masked>$/);
  assert.ok(!fs.readFileSync(p.out, 'utf8').includes(TOKEN));
  assert.ok(!fs.readFileSync(p.out, 'utf8').includes('TEST_ENV_SECRET'));
  assert.deepEqual(Object.keys(record), [...Object.keys(record)].sort());
  assert.equal(record.run, null);
});

test('a mismatched version refuses without writing, and one missing expect fails its check', async (t) => {
  const versionProject = project(t);
  versionProject.env.FAKE_VERSION_FAIL = '1';
  const versionResult = await evidence(versionProject);
  assert.equal(versionResult.exit, 1);
  assert.equal(versionResult.body.disposition, 'refused');
  assert.equal(versionResult.body.reason, 'version-unmatched');
  assert.equal(fs.existsSync(versionProject.out), false);

  const checkProject = project(t);
  checkProject.env.FAKE_MISSING_EXPECT = '1';
  const checkResult = await evidence(checkProject);
  assert.equal(checkResult.exit, 0);
  const record = JSON.parse(fs.readFileSync(checkProject.out, 'utf8'));
  assert.equal(record.checks[0].result, 'fail', 'the check fails when either of its two expects is absent');
  assert.deepEqual(record.establishes, ['structuredOutput'], 'a failed check establishes nothing');
  assert.ok(!record.establishes.includes('oneShot'));
});

test('--out existing is usage and preserves the existing file', async (t) => {
  const p = project(t);
  fs.writeFileSync(p.out, 'keep this file');
  const result = await evidence(p);
  assert.equal(result.exit, 2);
  assert.equal(result.body.error, 'usage');
  assert.equal(result.body.reason, 'out-exists');
  assert.equal(fs.readFileSync(p.out, 'utf8'), 'keep this file');
});

test('live-run evidence refuses absent output, absent terminal result, and a different harness', async (t) => {
  const cases = [
    ['no-output', endedRun({ output: { stdout: { bytes: 0 }, stderr: { bytes: 0 } } })],
    ['no-terminal-event', endedRun({ report: { status: 'unparsed', reason: 'no-turn-end', deniedCount: 0, usage: null } })],
    ['harness-mismatch', endedRun({ harness: 'other' })],
    ['run-not-ended', endedRun({ phase: 'running' })],
  ];
  for (const [reason, run] of cases) {
    const p = project(t);
    writeRun(p, run);
    const result = await evidence(p, { checks: undefined, workerRun: RUN_ID });
    assert.equal(result.exit, 1, reason);
    assert.equal(result.body.disposition, 'refused', reason);
    assert.equal(result.body.reason, reason, reason);
    assert.equal(fs.existsSync(p.out), false, `${reason} writes nothing`);
  }
});

test('offered read-only and edit runs establish their capabilities without prompt or summary text', async (t) => {
  const readOnlyProject = project(t);
  writeRun(readOnlyProject, endedRun());
  const readOnlyResult = await evidence(readOnlyProject, { checks: undefined, workerRun: RUN_ID });
  assert.equal(readOnlyResult.exit, 0);
  assert.deepEqual(readOnlyResult.body.establishes, ['oneShot', 'structuredOutput', 'spawnDenial', 'readOnly']);
  const readOnlyRecord = JSON.parse(fs.readFileSync(readOnlyProject.out, 'utf8'));
  assert.equal(readOnlyRecord.kind, 'live-run');
  assert.equal(readOnlyRecord.cliVersion, 'codex-cli 0.163.0');
  assert.equal(readOnlyRecord.binary, 'codex');
  assert.equal(readOnlyRecord.run.resultOffered, true);
  assert.equal(readOnlyRecord.run.readOnly.status, 'clean');
  assert.equal(readOnlyRecord.run.isolation, null);

  const editProject = project(t);
  writeRun(editProject, endedRun({
    edit: { base: 'a'.repeat(40), branch: 'doflow-attempt/feat-worker-evidence/d-0123456789ab', callerTop: '/private/caller' },
    readOnly: null,
    isolation: { status: 'clean', changes: [], callerHead: { before: 'a'.repeat(40), after: 'a'.repeat(40) }, refsChanged: [] },
  }));
  const editResult = await evidence(editProject, { checks: undefined, workerRun: RUN_ID });
  assert.equal(editResult.exit, 0);
  assert.deepEqual(editResult.body.establishes, ['oneShot', 'structuredOutput', 'spawnDenial', 'isolatedEdit']);
  const editRecord = JSON.parse(fs.readFileSync(editProject.out, 'utf8'));
  assert.equal(editRecord.run.edit, true);
  assert.equal(editRecord.run.readOnly, null);
  assert.equal(editRecord.run.isolation.status, 'clean');
  for (const record of [readOnlyRecord, editRecord]) {
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes('PRIVATE PROMPT TEXT'));
    assert.ok(!serialized.includes('PRIVATE MODEL SUMMARY'));
    assert.ok(!serialized.includes('/private/caller'));
  }

  const withheldProject = project(t);
  writeRun(withheldProject, endedRun({ report: { status: 'failure', reason: null, deniedCount: 0, usage: null, summary: 'WITHHELD FAILURE SUMMARY' } }));
  const withheldResult = await evidence(withheldProject, { checks: undefined, workerRun: RUN_ID });
  assert.equal(withheldResult.exit, 0);
  assert.deepEqual(withheldResult.body.establishes, [], 'an exit code and terminal failure do not establish capabilities');
  const withheldRecord = JSON.parse(fs.readFileSync(withheldProject.out, 'utf8'));
  assert.equal(withheldRecord.run.resultOffered, false);
  assert.deepEqual(withheldRecord.establishes, []);
  assert.ok(!JSON.stringify(withheldRecord).includes('WITHHELD FAILURE SUMMARY'));
});

test('negative control: a check that exits non-zero fails even when its expected lines are all printed', async (t) => {
  const p = project(t);
  rewriteChecks(p, (data) => {
    data.checks = [{ id: 'exits-nonzero', argv: ['failexit', '--help'], expect: ['^Usage: codex exec'], establishes: ['oneShot'] }];
  });
  const result = await evidence(p);
  assert.equal(result.exit, 0);
  const record = JSON.parse(fs.readFileSync(p.out, 'utf8'));
  assert.equal(record.checks[0].exit, 4);
  assert.equal(record.checks[0].matched.length, 1, 'the expected line was printed');
  assert.equal(record.checks[0].result, 'fail');
  assert.deepEqual(record.establishes, []);
});

test('negative control: a version command that exits non-zero refuses even when its output matches', async (t) => {
  const p = project(t);
  p.env.FAKE_VERSION_EXIT = '1';
  const result = await evidence(p);
  assert.equal(result.exit, 1);
  assert.equal(result.body.disposition, 'refused');
  assert.equal(result.body.reason, 'version-unmatched');
  assert.equal(fs.existsSync(p.out), false);
});

test('negative control: a checks file for another harness or binary is usage and starts no process', async (t) => {
  for (const [label, edit, pattern] of [
    ['harness', (data) => { data.harness = 'gemini'; }, /harness 'gemini' does not match 'codex'/],
    ['binary', (data) => { data.binary = 'other'; }, /binary 'other' does not match harness 'codex' binary 'codex'/],
  ]) {
    const p = project(t);
    rewriteChecks(p, edit);
    const result = await evidence(p);
    assert.equal(result.exit, 2, label);
    assert.equal(result.body.error, 'usage', label);
    assert.equal(result.body.reason, 'checks-invalid', label);
    assert.match(result.body.message, pattern, label);
    assert.equal(fs.existsSync(p.out), false, `${label}: nothing is recorded`);
    assert.deepEqual(fakeCalls(p), [], `${label}: no process was started`);
  }
});

test('negative control: a check may not establish cli', async (t) => {
  const p = project(t);
  rewriteChecks(p, (data) => { data.checks[0].establishes = ['oneShot', 'cli']; });
  const result = await evidence(p);
  assert.equal(result.exit, 2);
  assert.equal(result.body.reason, 'checks-invalid');
  assert.match(result.body.message, /other than 'cli'/);
  assert.equal(fs.existsSync(p.out), false);
  assert.deepEqual(fakeCalls(p), []);
});

test('negative control: a secret in the version line is masked in cliVersion', async (t) => {
  const p = project(t);
  p.env.FAKE_VERSION_SECRET = '1';
  const result = await evidence(p);
  assert.equal(result.exit, 0);
  const text = fs.readFileSync(p.out, 'utf8');
  assert.ok(!text.includes(TOKEN), 'the token is not written anywhere in the record');
  assert.equal(JSON.parse(text).cliVersion, 'codex-cli 0.163.0 api_token=<masked>');
});

test('negative control: a checks file argv that could start a model session is refused before any process starts', async (t) => {
  for (const argv of [['exec', '--json', 'write a poem'], ['exec'], ['--version', 'extra'], ['features', 'enable', 'x'],
    ['exec', '--', '--help'], ['features', 'list', '--', 'x'], ['exec', '--help', 'write a poem'], ['exec', '--help', 'prompt'],
    ['features', 'list', '--disable'], ['features', 'list', '--disable', 'a b']]) {
    const p = project(t);
    rewriteChecks(p, (data) => {
      data.checks.push({ id: 'paid-session', argv, expect: ['.'], establishes: ['oneShot'] });
    });
    const result = await evidence(p);
    assert.equal(result.exit, 2, argv.join(' '));
    assert.equal(result.body.error, 'usage', argv.join(' '));
    assert.equal(result.body.reason, 'checks-invalid', argv.join(' '));
    assert.match(result.body.message, /check 'paid-session'/, 'the message names the check id');
    assert.equal(fs.existsSync(p.out), false, `${argv.join(' ')} records nothing`);
    assert.deepEqual(fakeCalls(p), [], `${argv.join(' ')} starts no process, not even the version check`);
  }
  const p = project(t);
  rewriteChecks(p, (data) => { data.version.argv = ['exec', 'write a poem']; });
  const result = await evidence(p);
  assert.equal(result.exit, 2);
  assert.match(result.body.message, /version\.argv is not a free check/);
  assert.deepEqual(fakeCalls(p), []);
});

test('the shipped codex checks file still validates and runs only free commands', async (t) => {
  const p = project(t);
  p.checks = path.join(__dirname, '..', '..', 'core', 'worker-evidence', 'codex', 'checks.json');
  const result = await evidence(p);
  assert.equal(result.exit, 0, JSON.stringify(result.body));
  assert.equal(result.body.disposition, 'recorded');
  const calls = fakeCalls(p);
  assert.ok(calls.length >= 5, 'the version check and every declared check ran');
  for (const call of calls) {
    assert.match(call, /^(--version|exec --help|features list )/, `only free commands ran: ${call}`);
  }
});
