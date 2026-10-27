'use strict';
// 082 IC-013 (registry half, DEC-020): the optional `isolatedEdit` capability entry of the worker
// block. Each refusal is built from an in-memory copy of the shipped registry, so a validator
// regression cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateWorker, WORKER_KEYS, WORKER_OPTIONAL_CAPABILITIES,
} = require('../../src/registry/index.ts');
const ORCHESTRATION_AT_BE752D8 = require('../fixtures/worker/orchestration-be752d8.json');

const REPO = path.resolve(__dirname, '../..');
const HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
const BINARIES: any = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', copilot: 'copilot', kiro: 'kiro-cli', antigravity: 'agy' };
const CODEX_RECORD = 'core/worker-evidence/codex/2026-10-18-cli-check.json';
const AT = /^harness 'claude' worker 'isolatedEdit': /;

function supported(recipe: any) {
  return { status: 'supported', evidence: ['test/registry/worker-isolated-edit.test.ts'], verification: 'Run it.', verifiedOn: '2026-10-16', ...recipe };
}

/** Validates a fresh copy of the shipped registry after mutating claude's worker block. */
function mutated(mutate: any) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].worker);
  return validateRegistry(registry, { repoRoot: REPO });
}

function workerErrors(result: any) {
  return result.errors.filter((line: any) => line.includes(" worker '"));
}

function assertRefused(result: any, pattern: any) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  const errors = workerErrors(result);
  const hits = errors.filter((line: any) => AT.test(line));
  assert.ok(hits.length > 0, `an isolatedEdit error is reported: ${errors.join('; ')}`);
  assert.match(hits.join('\n'), pattern);
  for (const line of errors) assert.ok(!line.includes(' orchestration'), `no worker message may contain ' orchestration': ${line}`);
}

test('isolatedEdit: exported as an optional capability, WORKER_KEYS unchanged', () => {
  assert.deepEqual(WORKER_OPTIONAL_CAPABILITIES, {
    isolatedEdit: { allowed: ['argv'], required: ['argv'] },
    model: { allowed: ['argv'], required: ['argv'] },
  });
  assert.ok(!WORKER_KEYS.includes('isolatedEdit'));
});

test('isolatedEdit: the real registry loads; codex is supported on its recorded evidence, the other harnesses stay unknown with a reason', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.validation.errors.filter((line: any) => line.includes(" worker 'isolatedEdit'")), []);
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.deepEqual(registry.harnesses.map((h: any) => h.id), HARNESSES);
  for (const harness of registry.harnesses) {
    const binary = BINARIES[harness.id];
    if (harness.id === 'codex') {
      assert.deepEqual(harness.worker.isolatedEdit, {
        status: 'supported',
        evidence: [CODEX_RECORD, 'core/worker-evidence/codex/2026-10-18-live-run-edit.json'],
        verification: `Run \`node bin/doflow.js worker --action evidence --harness codex --checks core/worker-evidence/codex/checks.json --out ${CODEX_RECORD}\` against the installed codex and read the matched help lines. Live run 2026-10-18 (codex-cli 0.163.0): run w-821933d703be under \`exec -s workspace-write\` in an isolated attempt ended with report status success, result offered, isolation status clean and unchanged caller and attempt refs.`,
        verifiedOn: '2026-10-18',
        argv: ['exec', '-s', 'workspace-write'],
      }, 'codex isolatedEdit');
      continue;
    }
    assert.deepEqual(harness.worker.isolatedEdit, {
      status: 'unknown',
      evidence: [],
      verification: `Read ${harness.id}'s headless CLI documentation and \`${binary} --help\`; record the flag that confines edits to the working directory and its source`,
      verifiedOn: '2026-10-16',
      reason: `no recorded evidence for ${binary}: no free check shows a flag that confines edits to the working directory`,
    }, `${harness.id} isolatedEdit`);
  }
});

test('isolatedEdit: an absent entry loads', () => {
  const result = mutated((worker: any) => { delete worker.isolatedEdit; });
  assert.deepEqual(workerErrors(result), []);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('isolatedEdit: supported with argv loads', () => {
  const result = mutated((worker: any) => { worker.isolatedEdit = supported({ argv: ['--edit-in-cwd'] }); });
  assert.deepEqual(workerErrors(result), []);
  const errors: any = [];
  validateWorker({ ...structuredClone(loadRegistry({ repoRoot: REPO }).harnesses[0].worker), isolatedEdit: supported({ argv: [] }) }, "harness 'claude'", errors);
  assert.deepEqual(errors, []);
});

test('isolatedEdit: supported without argv is refused', () => {
  assertRefused(mutated((worker: any) => { worker.isolatedEdit = supported({}); }), /requires recipe field 'argv' when status is supported/);
});

test('isolatedEdit: argv on an unknown entry is refused', () => {
  assertRefused(mutated((worker: any) => { worker.isolatedEdit.argv = ['--edit-in-cwd']; }), /recipe field 'argv' is allowed only when status is supported/);
});

test('isolatedEdit: a {prompt} element is refused', () => {
  assertRefused(mutated((worker: any) => { worker.isolatedEdit = supported({ argv: ['--edit', '{prompt}'] }); }), /argv must not contain '\{prompt\}' outside oneShot\.argv/);
});

test('isolatedEdit: a bad status is refused', () => {
  assertRefused(mutated((worker: any) => { worker.isolatedEdit.status = 'maybe'; }), /status must be supported, unsupported, or unknown/);
});

test('isolatedEdit: empty evidence on supported is refused', () => {
  assertRefused(mutated((worker: any) => { worker.isolatedEdit = supported({ argv: ['--x'], evidence: [] }); }), /evidence must not be empty when status is supported/);
});

test('isolatedEdit: every harness orchestration block still equals the copy taken at be752d8', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  for (const harness of registry.harnesses) {
    // 118 IC-004 adds `nest` after be752d8; the copy covers the five operations that existed then.
    const { nest: _nest, ...atBe752d8 } = harness.orchestration;
    assert.deepEqual(atBe752d8, ORCHESTRATION_AT_BE752D8[harness.id], `${harness.id} orchestration`);
  }
});
