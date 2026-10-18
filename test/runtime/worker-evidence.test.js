'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
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
if [ "$1" = "--version" ]; then
  if [ "$FAKE_VERSION_FAIL" = "1" ]; then printf '%s\\n' 'not a codex version'; else printf '%s\\n' 'codex-cli 0.163.0'; fi
  exit 0
fi
if [ "$1" = "check" ]; then
  printf '%s\\n' 'Usage: codex exec [OPTIONS] [PROMPT]'
  if [ "$FAKE_MISSING_EXPECT" != "1" ]; then printf '%s\\n' 'instructions are read from stdin'; fi
  exit 0
fi
if [ "$1" = "secret" ]; then
  printf '%s\\n' 'api_token=${TOKEN}'
  exit 0
fi
exit 3
`.replace('${TOKEN}', TOKEN), { mode: 0o755 });
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({
    schema: 'doflow-worker-checks-v1',
    harness: 'codex',
    binary: 'codex',
    version: { argv: ['--version'], expect: '^codex-cli \\d+\\.\\d+\\.\\d+' },
    checks: [
      {
        id: 'two-expects', argv: ['check'],
        expect: ['^Usage: codex exec \\[OPTIONS\\] \\[PROMPT\\]$', '^instructions are read from stdin$'],
        establishes: ['oneShot'],
      },
      { id: 'masked-line', argv: ['secret'], expect: ['^api_token='], establishes: ['structuredOutput'] },
    ],
  }, null, 2));
  return {
    dir,
    checks,
    out: path.join(dir, 'evidence.json'),
    env: { ...process.env, PATH: bin, FAKE_VERSION_FAIL: '0', FAKE_MISSING_EXPECT: '0', TEST_ENV_SECRET: 'must-not-be-recorded' },
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
