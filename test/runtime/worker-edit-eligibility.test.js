'use strict';
// 082 B.1 (IC-013 readiness half): the edit baseline and isolated-edit eligibility. DEC-020, DEC-052.
//
// No case starts a real harness (NFR-002): the edit-capable fake descriptors come from
// test/helper/dispatch-sandbox.js (editDescriptors) and are passed in process; the probe's child
// PATH is the sandbox's scratch bin/ (fake CLI links, node and git symlinks only, never
// dirname(process.execPath), DEC-056), and the sandbox sets the five DOFLOW_* identity variables in
// its env. The real-registry case runs with a PATH of one empty scratch directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
const { IDENTITY_VARS } = require('../helper/fake-harness-cli.js');
const { makeDispatchSandbox, editDescriptors } = require('../helper/dispatch-sandbox.js');
const { loadRegistry } = require('../../src/registry/index.ts');
const {
  BASELINE, EDIT_BASELINE, probe, describe, select, requirementsFor, eligibility, capabilityRequirement,
} = require('../../src/runtime/worker/readiness.ts');

const POSIX_ONLY = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL = loadRegistry({ repoRoot: REPO_ROOT });
const SCENARIO = { version: [{ print: 'fake 1.0' }] };
const NOT_DECLARED = { requirement: 'isolated-edit', result: 'unknown', reason: 'not-declared' };
const FRESH = Object.freeze({ installed: { state: 'yes', reason: 'found', at: null }, runnable: { state: 'yes', reason: 'exit 0', at: null } });

const gapOf = (answer, harness, requirement) => answer.candidates.find((c) => c.harness === harness).gaps.find((g) => g.requirement === requirement);

/** The sandbox with claude and gemini edit descriptors, both probed so their facts are fresh. */
async function probed(t) {
  const s = makeDispatchSandbox(t, { scenario: SCENARIO });
  for (const key of IDENTITY_VARS) assert.ok(key in s.env, `${key} is set in the child env`);
  const descriptors = { claude: s.descriptors.claude, gemini: s.descriptors.gemini };
  await probe({ descriptors, env: s.env, cwd: s.root });
  return { s, descriptors, base: { descriptors, coverage: REAL.coverage, env: s.env, cwd: s.root } };
}

test('EDIT_BASELINE is BASELINE with read-only replaced by isolated-edit', () => {
  assert.deepEqual(EDIT_BASELINE, BASELINE.map((id) => (id === 'read-only' ? 'isolated-edit' : id)));
  assert.ok(Object.isFrozen(EDIT_BASELINE));
});

test('capabilityRequirement: an absent isolatedEdit entry reads unknown, not-declared', () => {
  assert.deepEqual(capabilityRequirement('isolated-edit', undefined), NOT_DECLARED);
  assert.deepEqual(capabilityRequirement('isolated-edit', editDescriptors().claude.isolatedEdit), { requirement: 'isolated-edit', result: 'met', reason: 'supported' });
});

test('edit: true with fresh facts: the claude fake is eligible, gemini is ineligible naming isolated-edit not-declared', POSIX_ONLY, async (t) => {
  const { base } = await probed(t);

  const answer = select({ ...base, edit: true });
  assert.equal(answer.disposition, 'selected');
  assert.equal(answer.harness, 'claude');
  assert.match(answer.reason, /met: installed, runnable, one-shot, structured-output, isolated-edit, spawn-denial;/);
  assert.deepEqual(answer.candidates.find((c) => c.harness === 'claude'), { harness: 'claude', eligible: true, gaps: [] });
  assert.equal(answer.candidates.find((c) => c.harness === 'gemini').eligible, false);
  assert.deepEqual(gapOf(answer, 'gemini', 'isolated-edit'), NOT_DECLARED);
  assert.equal(gapOf(answer, 'gemini', 'read-only'), undefined, 'the edit baseline carries no read-only');

  const claude = describe({ ...base, harness: 'claude', edit: true });
  assert.equal(claude.eligible, true);
  assert.deepEqual(claude.requirements.map((item) => item.requirement), EDIT_BASELINE);
  const gemini = describe({ ...base, harness: 'gemini', edit: true });
  assert.equal(gemini.eligible, false);
  assert.deepEqual(gemini.requirements.find((item) => item.requirement === 'isolated-edit'), NOT_DECLARED);
});

test('without edit: describe and select deep-equal the same call with the argument omitted', POSIX_ONLY, async (t) => {
  const { base } = await probed(t);
  const now = Date.now();
  for (const harness of ['claude', 'gemini']) {
    const omitted = describe({ ...base, harness, now });
    assert.deepEqual(describe({ ...base, harness, now, edit: false }), omitted, harness);
    assert.deepEqual(omitted.requirements.map((item) => item.requirement), BASELINE, harness);
  }
  const omitted = select({ ...base, now });
  assert.deepEqual(select({ ...base, now, edit: false }), omitted);
  assert.deepEqual(select({ ...base, now, edit: undefined }), omitted);
  assert.equal(omitted.harness, 'claude', 'the read-only baseline still selects claude');
});

test('the real registry with edit: true leaves every harness ineligible naming isolated-edit', (t) => {
  const dir = tempDir(t, 'doflow-edit-eligibility-real-');
  const emptyBin = path.join(dir, 'bin');
  fs.mkdirSync(emptyBin);
  const env = { PATH: emptyBin, HOME: path.join(dir, 'home') };
  const answer = select({ env, cwd: dir, edit: true });
  assert.equal(answer.disposition, 'none-eligible');
  assert.equal(answer.candidates.length, REAL.harnesses.length);
  for (const harness of REAL.harnesses) {
    const candidate = answer.candidates.find((c) => c.harness === harness.id);
    assert.equal(candidate.eligible, false, harness.id);
    assert.equal(harness.worker.isolatedEdit.status, 'unknown', harness.id);
    assert.deepEqual(gapOf(answer, harness.id, 'isolated-edit'), { requirement: 'isolated-edit', result: 'unknown', reason: harness.worker.isolatedEdit.reason }, harness.id);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bin']);
});

test('negative control: readOnly unknown does not block an edit task whose isolatedEdit is supported', () => {
  const worker = editDescriptors().claude;
  worker.readOnly = { status: 'unknown', evidence: [], verification: 'not checked', verifiedOn: '2026-10-16', reason: 'unknown in this fake' };
  const editing = eligibility(requirementsFor({ harness: 'claude', worker }, FRESH, [], REAL.coverage, true));
  assert.deepEqual(editing, { eligible: true, gaps: [] });
  const reading = eligibility(requirementsFor({ harness: 'claude', worker }, FRESH, [], REAL.coverage));
  assert.deepEqual(reading.gaps, [{ requirement: 'read-only', result: 'unknown', reason: 'unknown in this fake' }]);
});
