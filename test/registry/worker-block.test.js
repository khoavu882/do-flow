'use strict';
// 081 IC-001, IC-002, IC-003 (validation) and IC-032 (orchestration fixture): the `worker` block of
// core/registry/harnesses.json and validateWorker. Every rule has one failing case, built from an
// in-memory copy of the shipped registry so a regression in the validator cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateWorker, WORKER_KEYS, WORKER_CAPABILITIES,
} = require('../../src/registry/index.ts');
const ORCHESTRATION_AT_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');

const REPO = path.resolve(__dirname, '../..');
const HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
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
  for (const harness of registry.harnesses) assert.deepEqual(Object.keys(harness.worker), WORKER_KEYS, `${harness.id} worker keys`);
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
      assert.deepEqual(worker[key], {
        status: 'unknown',
        evidence: [],
        verification: `Read ${harness.id}'s headless CLI documentation and \`${binary} --help\`; record the flag and its source`,
        verifiedOn: '2026-10-15',
        reason: `no in-repository evidence names this for ${harness.id}; nothing is inferred from another harness or a model name`,
      }, `${harness.id} ${key}`);
    }
  }
});

test('worker: every harness orchestration block equals the copy taken at be752d8', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(Object.keys(ORCHESTRATION_AT_BE752D8), HARNESSES);
  for (const harness of registry.harnesses) {
    assert.deepEqual(harness.orchestration, ORCHESTRATION_AT_BE752D8[harness.id], `${harness.id} orchestration`);
  }
});

test('worker: validateWorker accepts a full supported recipe in isolation', () => {
  const errors = [];
  validateWorker({
    profile: 'user-headless',
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
