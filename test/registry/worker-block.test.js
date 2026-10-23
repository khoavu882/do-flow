'use strict';
// 081 IC-001, IC-002, IC-003 (validation) and IC-032 (orchestration fixture): the `worker` block of
// core/registry/harnesses.json and validateWorker. Every rule has one failing case, built from an
// in-memory copy of the shipped registry so a regression in the validator cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateWorker, WORKER_KEYS, WORKER_CAPABILITIES, WORKER_OPTIONAL_CAPABILITIES,
} = require('../../src/registry/index.ts');
const ORCHESTRATION_AT_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');

const REPO = path.resolve(__dirname, '../..');
const HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
const CODEX_RECORD = 'core/worker-evidence/codex/2026-10-18-cli-check.json';
const LIVE_READ_ONLY = 'core/worker-evidence/codex/2026-10-18-live-run-read-only.json';
const LIVE_EDIT = 'core/worker-evidence/codex/2026-10-18-live-run-edit.json';
// D.1: the free check plus the live-run record(s) that establish each entry; runnableProbe keeps only the free check.
const CODEX_EVIDENCE = {
  oneShot: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  structuredOutput: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  spawnDenial: [CODEX_RECORD, LIVE_READ_ONLY, LIVE_EDIT],
  readOnly: [CODEX_RECORD, LIVE_READ_ONLY],
  isolatedEdit: [CODEX_RECORD, LIVE_EDIT],
  runnableProbe: [CODEX_RECORD],
};
const CODEX_SUPPORTED = ['oneShot', 'structuredOutput', 'readOnly', 'spawnDenial', 'runnableProbe'];
const PER_HARNESS_REASON = ['oneShot', 'structuredOutput', 'spawnDenial']; // isolatedEdit's reason is pinned in worker-isolated-edit.test.js
const BINARIES = { claude: 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode', pi: 'pi', copilot: 'copilot', kiro: 'kiro-cli', antigravity: 'agy' };

/** A supported entry carrying the given recipe fields. */
function supported(recipe) {
  return { status: 'supported', evidence: ['test/registry/worker-block.test.js'], verification: 'Run it.', verifiedOn: '2026-10-15', ...recipe };
}

/** Validates a fresh copy of the shipped registry after mutating claude's worker block. */
function mutated(mutate) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].worker, registry.harnesses[0]);
  return validateRegistry(registry, { repoRoot: REPO });
}

function assertReports(result, pattern) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  const workerErrors = result.errors.filter((line) => line.includes(" worker '"));
  assert.match(workerErrors.join('\n'), pattern);
  for (const line of workerErrors) {
    assert.match(line, /^harness 'claude' worker '[^']+': /, `message shape: ${line}`);
    assert.ok(!line.includes(' orchestration'), `no worker message may contain ' orchestration': ${line}`);
  }
}

test('worker: the shipped registry carries the block on all eight harnesses and validates', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const workerErrors = registry.validation.errors.filter((line) => line.includes(" worker '"));
  assert.deepEqual(workerErrors, []);
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.deepEqual(registry.harnesses.map((harness) => harness.id), HARNESSES);
  const modelChecksAt = WORKER_KEYS.indexOf('modelChecks');
  const expectedKeys = [...WORKER_KEYS.slice(0, modelChecksAt), ...Object.keys(WORKER_OPTIONAL_CAPABILITIES), ...WORKER_KEYS.slice(modelChecksAt)];
  for (const harness of registry.harnesses) assert.deepEqual(Object.keys(harness.worker), expectedKeys, `${harness.id} worker keys`);
});

test('worker: the eight harnesses declare IC-002 values and nothing else as supported', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  for (const harness of registry.harnesses) {
    const worker = harness.worker;
    const binary = BINARIES[harness.id];
    assert.equal(worker.profile, null, `${harness.id} profile`);
    assert.deepEqual(worker.modelChecks, [], `${harness.id} modelChecks`);
    assert.equal(worker.cli.status, 'supported');
    assert.equal(worker.cli.binary, binary);
    assert.deepEqual(worker.cli.versionArgv, ['--version']);
    assert.equal(worker.cli.evidence.length, 1);
    assert.ok(worker.cli.evidence[0].startsWith(`bench/inventory/coverage.json → ${binary} --version → `), worker.cli.evidence[0]);
    for (const key of Object.keys(WORKER_CAPABILITIES).filter((name) => name !== 'cli')) {
      if (harness.id === 'codex' && CODEX_SUPPORTED.includes(key)) {
        // IC-008: the six entries the recorded codex cli-check establishes; the record is checked by G41.4.
        assert.equal(worker[key].status, 'supported', `codex ${key}`);
        assert.deepEqual(worker[key].evidence, CODEX_EVIDENCE[key], `codex ${key} evidence`);
        assert.equal(worker[key].verifiedOn, '2026-10-18', `codex ${key} verifiedOn`);
        continue;
      }
      assert.equal(worker[key].status, 'unknown', `${harness.id} ${key}`);
      assert.deepEqual(worker[key].evidence, [], `${harness.id} ${key} evidence`);
      assert.equal(worker[key].verification, `Read ${harness.id}'s headless CLI documentation and \`${binary} --help\`; record the flag and its source`, `${harness.id} ${key}`);
      assert.equal(worker[key].verifiedOn, '2026-10-15', `${harness.id} ${key}`);
      if (PER_HARNESS_REASON.includes(key)) {
        // the four static-gate entries carry a per-harness reason naming the missing evidence (FR-009)
        assert.match(worker[key].reason, new RegExp(`^no (recorded evidence for|captured) ${binary}[ :]`), `${harness.id} ${key} reason`);
      } else {
        assert.equal(worker[key].reason, `no in-repository evidence names this for ${harness.id}; nothing is inferred from another harness or a model name`, `${harness.id} ${key}`);
      }
    }
  }
});

// W2-1 (109 review A-1): the codex recipes are what the dispatcher launches, and the evidence record
// only shows the flags exist. Pin every supported entry, argv included, so widening a sandbox or
// swapping a disabled feature cannot pass with the record untouched.
const CODEX_RECIPES = {
  oneShot: { argv: ['--ephemeral', '-'], promptVia: 'stdin' },
  structuredOutput: {
    argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1',
    quotaSignals: { signals: ['rate limit', 'usage limit', 'quota exceeded', 'too many requests', 'resource_exhausted'], basis: 'unverified', evidence: [] },
  },
  readOnly: { argv: ['exec', '-s', 'read-only'] },
  isolatedEdit: { argv: ['exec', '-s', 'workspace-write'] },
  spawnDenial: { argv: ['--disable', 'multi_agent', '--disable', 'multi_agent_v2'] },
  runnableProbe: { argv: ['exec', '--help'] },
};

test('worker: the six supported codex entries equal their committed status, evidence, verifiedOn and recipe', () => {
  const codex = loadRegistry({ repoRoot: REPO }).harnesses.find((harness) => harness.id === 'codex').worker;
  assert.deepEqual(Object.keys(CODEX_RECIPES).sort(), [...CODEX_SUPPORTED, 'isolatedEdit'].sort());
  for (const [key, recipe] of Object.entries(CODEX_RECIPES)) {
    const { status, evidence, verifiedOn, argv, promptVia, parser, quotaSignals } = codex[key];
    assert.deepEqual(
      { status, evidence, verifiedOn, argv, promptVia, parser, ...(quotaSignals === undefined ? {} : { quotaSignals }) },
      { status: 'supported', evidence: CODEX_EVIDENCE[key], verifiedOn: '2026-10-18', promptVia: undefined, parser: undefined, ...recipe },
      `codex ${key}`,
    );
  }
});

test('worker: every harness orchestration block equals the copy taken at be752d8', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(Object.keys(ORCHESTRATION_AT_BE752D8), HARNESSES);
  for (const harness of registry.harnesses) {
    // 118 IC-004 adds `nest` after be752d8; the copy covers the five operations that existed then.
    const { nest: _nest, ...atBe752d8 } = harness.orchestration;
    assert.deepEqual(atBe752d8, ORCHESTRATION_AT_BE752D8[harness.id], `${harness.id} orchestration`);
  }
});

test('worker: validateWorker accepts a full supported recipe in isolation', () => {
  const errors = [];
  validateWorker({
    profile: 'user-headless',
    billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['-p', '{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json'], parser: 'doflow-jsonl-v1' }),
    readOnly: supported({ argv: ['--read-only'] }),
    spawnDenial: supported({ argv: ['--no-agents'] }),
    runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }),
    guidanceProbe: supported({ argv: ['--guidance'], marker: 'DOFLOW-MARKER' }),
    loginProbe: supported({ argv: ['--whoami'] }),
    persistentSession: supported({}),
    resume: { status: 'unsupported', evidence: ['docs'], verification: 'Read it.', verifiedOn: '2026-10-15' },
    steering: { status: 'unknown', evidence: [], verification: 'Read it.', verifiedOn: '2026-10-15', reason: 'unread' },
    modelChecks: [{ id: 'hooks-check', argv: ['-p', 'x'], establishes: ['hooksLoaded', 'login'], estimateTokens: 1, timeoutSeconds: 600 }],
  }, "harness 'claude'", errors);
  assert.deepEqual(errors, []);
});

const cases = [
  ['a missing block', (_w, harness) => { delete harness.worker; }, /worker '\*': worker block is required/],
  ['a missing key', (w) => { delete w.loginProbe; }, /worker 'loginProbe': is missing/],
  ['an unknown key', (w) => { w.dispatch = {}; }, /worker 'dispatch': is not a worker key/],
  ['a bad status', (w) => { w.readOnly.status = 'maybe'; }, /worker 'readOnly': status must be supported, unsupported, or unknown/],
  ['empty evidence on supported', (w) => { w.cli.evidence = []; }, /worker 'cli': evidence must not be empty when status is supported/],
  ['a missing reason on unknown', (w) => { delete w.hooksProbe.reason; }, /worker 'hooksProbe': requires a reason when status is unknown/],
  ['a recipe field on unknown', (w) => { w.readOnly.argv = ['--read-only']; }, /worker 'readOnly': recipe field 'argv' is allowed only when status is supported/],
  ['a missing required recipe field', (w) => { delete w.cli.binary; }, /worker 'cli': requires recipe field 'binary' when status is supported/],
  ['an argv of 33 elements', (w) => { w.readOnly = supported({ argv: Array(33).fill('-x') }); }, /worker 'readOnly': argv must have at most 32 elements/],
  ['a NUL in an argv element', (w) => { w.readOnly = supported({ argv: ['-x\0y'] }); }, /worker 'readOnly': argv elements must not contain NUL/],
  ['{prompt} twice with promptVia argv', (w) => { w.oneShot = supported({ argv: ['{prompt}', '{prompt}'], promptVia: 'argv' }); }, /worker 'oneShot': argv must contain the element '\{prompt\}' exactly once/],
  ['{prompt} absent with promptVia argv', (w) => { w.oneShot = supported({ argv: ['-p'], promptVia: 'argv' }); }, /worker 'oneShot': argv must contain the element '\{prompt\}' exactly once/],
  ['{prompt} present with promptVia stdin', (w) => { w.oneShot = supported({ argv: ['{prompt}'], promptVia: 'stdin' }); }, /worker 'oneShot': argv must not contain '\{prompt\}' when promptVia is stdin/],
  ['{prompt} in readOnly argv', (w) => { w.readOnly = supported({ argv: ['--read-only', '{prompt}'] }); }, /worker 'readOnly': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in spawnDenial argv', (w) => { w.spawnDenial = supported({ argv: ['{prompt}'] }); }, /worker 'spawnDenial': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in structuredOutput argv', (w) => { w.structuredOutput = supported({ argv: ['{prompt}'], parser: 'doflow-jsonl-v1' }); }, /worker 'structuredOutput': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in cli versionArgv', (w) => { w.cli.versionArgv = ['{prompt}']; }, /worker 'cli': versionArgv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['{prompt} in a model check argv', (w) => { w.modelChecks = [{ id: 'x', argv: ['{prompt}'], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': argv must not contain '\{prompt\}' outside oneShot\.argv/],
  ['an unknown profile', (w) => { w.profile = 'headless-ish'; }, /worker 'profile': must be a lifecycle coverage profile or null/],
  ['a bad model-check id', (w) => { w.modelChecks = [{ id: 'Bad_Id', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': id must be a lowercase identifier/],
  ['a duplicate model-check id', (w) => {
    const check = { id: 'same', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 };
    w.modelChecks = [check, { ...check }];
  }, /worker 'modelChecks\[1\]': duplicate id 'same'/],
  ['establishes outside the four facts', (w) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['runnable'], estimateTokens: 1, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': establishes must be a non-empty subset/],
  ['estimateTokens 0', (w) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['login'], estimateTokens: 0, timeoutSeconds: 1 }]; }, /worker 'modelChecks\[0\]': estimateTokens must be an integer of at least 1/],
  ['timeoutSeconds 601', (w) => { w.modelChecks = [{ id: 'x', argv: [], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 601 }]; }, /worker 'modelChecks\[0\]': timeoutSeconds must be an integer from 1 to 600/],
];

for (const [name, mutate, pattern] of cases) {
  test(`worker: ${name} is reported`, () => { assertReports(mutated(mutate), pattern); });
}
