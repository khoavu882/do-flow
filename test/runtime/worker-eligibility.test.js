'use strict';
// 081 B.2 (IC-008, IC-009, IC-010): the needs vocabulary, eligibility, describe and select with
// the fallback answer. DEC-002, DEC-006, DEC-009, DEC-020, DEC-044.
//
// No case starts a real harness (NFR-002): descriptors are the fake ones from
// test/fixtures/worker/descriptors.json passed in process, each child's PATH is a scratch bin/
// holding only the fake CLI links plus the directory of process.execPath, and every child env is
// built from nothing, so the five DOFLOW_* identity variables are absent unless the probe itself
// sets them. The real-registry case runs with a PATH of one empty scratch directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { IDENTITY_VARS, linkBin, writeScenario } = require('../helper/fake-harness-cli.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const {
  BASELINE, NEED_IDS, FACTS, PROBE_MAX_AGE_MS, ReadinessError,
  probe, describe, select, requirementsFor, policyVocabulary, validateNeeds,
} = require('../../src/runtime/worker/readiness.ts');
const FIXTURE = require('../fixtures/worker/descriptors.json');

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIXED = { run: 'probe0000bbbb', lineage: 'p0000bbbb' };
const BINDING = `xdg/doflow/session-env/sessions/L.${FIXED.run}.${FIXED.lineage}.1/bound`;
const GATE = 'blocking-hook:pre-implementation-gate';
const REAL_COVERAGE = loadRegistry({ repoRoot: path.resolve(__dirname, '..', '..') }).coverage;

/** A coverage whose only claude row for the gate is an observation-class pre-tool hook. */
const OBSERVATION_COVERAGE = Object.freeze({
  profiles: { any: { description: 'test profile' } },
  rows: [
    { harness: 'claude', policy: 'pre-implementation-gate', event: 'PreToolUse', profile: 'any', timing: 'pre-tool', class: 'observation', wired: true, verification: 'verified' },
    { harness: 'claude', policy: '*', event: 'SessionStart', profile: 'any', timing: 'session', class: 'observation', wired: true, verification: 'verified' },
  ],
});

const clone = (id) => structuredClone(FIXTURE[id]);

function setup(t, scenario, names) {
  const dir = tempDir(t, 'doflow-eligibility-');
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const env = {
    PATH: linkBin(path.join(dir, 'bin'), names),
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    FAKE_HARNESS_SCENARIO: writeScenario(dir, scenario),
    FAKE_HARNESS_LOG: path.join(dir, 'log.jsonl'),
  };
  for (const key of IDENTITY_VARS) assert.equal(key in env, false);
  return { dir, root, env };
}

/** Every file under `root` with its bytes, so a read-only call can be shown to write nothing. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

const gap = (result, harness, requirement) => result.candidates.find((c) => c.harness === harness).gaps.find((g) => g.requirement === requirement);

test('describe: read-only met and an observation-only gate hook failed as observation, with probe times', POSIX_ONLY, async (t) => {
  const worker = clone('claude');
  worker.profile = 'any';
  const s = setup(t, { version: [{ print: 'fake 1.0' }], hooks: [{ write: { path: BINDING, content: 'fake-session\n' } }] }, ['fake-claude']);
  await probe({ descriptors: { claude: worker }, env: s.env, cwd: s.root, probeIdentity: () => FIXED });

  const before = snapshot(s.root);
  const answer = describe({ descriptors: { claude: worker }, coverage: OBSERVATION_COVERAGE, harness: 'claude', needs: [GATE], env: s.env, cwd: s.root });
  assert.deepEqual(snapshot(s.root), before, 'describe writes nothing');

  assert.equal(answer.disposition, 'described');
  assert.equal(answer.harness, 'claude');
  assert.equal(answer.declared.profile, 'any');
  assert.deepEqual(answer.declared.modelChecks, []);
  assert.deepEqual(answer.declared.readOnly, { status: 'supported', verifiedOn: '2026-10-15' });
  assert.equal(answer.declared.persistentSession.status, 'unknown');
  assert.ok(answer.declared.persistentSession.reason);
  assert.deepEqual(Object.keys(answer.probe).sort(), [...FACTS].sort());
  for (const name of FACTS) {
    assert.match(answer.probe[name].at, ISO, name);
    assert.equal(answer.probe[name].stale, false, name);
  }
  assert.equal(answer.probe.hooksLoaded.state, 'yes');

  const byId = Object.fromEntries(answer.requirements.map((r) => [r.requirement, r]));
  assert.deepEqual(answer.requirements.map((r) => r.requirement), [...BASELINE, GATE]);
  assert.equal(byId['read-only'].result, 'met');
  assert.equal(byId.installed.result, 'met');
  assert.match(byId.installed.at, ISO, 'a fact-backed requirement shows its probe time');
  assert.equal(byId[GATE].result, 'failed');
  assert.match(byId[GATE].reason, /^observation at \(pre-implementation-gate, claude, /);
  assert.equal(answer.eligible, false);
});

test('describe: a fact past 24 hours reads stale and the harness is not eligible', POSIX_ONLY, async (t) => {
  const s = setup(t, { version: [{ print: 'fake 1.0' }] }, ['fake-claude']);
  const descriptors = { claude: clone('claude') };
  await probe({ descriptors, env: s.env, cwd: s.root });
  assert.equal(select({ descriptors, coverage: REAL_COVERAGE, env: s.env, cwd: s.root }).disposition, 'selected');
  const later = Date.now() + PROBE_MAX_AGE_MS + 60000;
  const answer = describe({ descriptors, coverage: REAL_COVERAGE, harness: 'claude', env: s.env, cwd: s.root, now: later });
  assert.equal(answer.probe.installed.stale, true);
  assert.equal(answer.probe.installed.reason, 'probe-stale');
  assert.equal(answer.eligible, false);
});

test('select: identity-forwarding unknown makes the harness ineligible and the gap names it', POSIX_ONLY, async (t) => {
  const s = setup(t, { version: [{ print: 'fake 1.0' }] }, ['fake-claude']);
  const descriptors = { claude: clone('claude') };
  await probe({ descriptors, env: s.env, cwd: s.root });

  const without = select({ descriptors, coverage: REAL_COVERAGE, env: s.env, cwd: s.root });
  assert.equal(without.disposition, 'selected', 'the baseline alone is met');
  const answer = select({ descriptors, coverage: REAL_COVERAGE, needs: ['identity-forwarding'], env: s.env, cwd: s.root });
  assert.equal(answer.disposition, 'none-eligible');
  assert.deepEqual(answer.candidates[0].gaps, [{ requirement: 'identity-forwarding', result: 'unknown', reason: 'hooks-not-loaded' }]);
});

test('select: spawnDenial unknown is ineligible for any task, with or without needs', POSIX_ONLY, async (t) => {
  const worker = clone('claude');
  worker.spawnDenial = { status: 'unknown', evidence: [], verification: 'Not declared by this test.', verifiedOn: '2026-10-15', reason: 'no spawn-denial flag in this test' };
  const s = setup(t, { version: [{ print: 'fake 1.0' }] }, ['fake-claude']);
  await probe({ descriptors: { claude: worker }, env: s.env, cwd: s.root });
  for (const needs of [[], ['login'], ['guidance-loaded', 'login']]) {
    const answer = select({ descriptors: { claude: worker }, coverage: REAL_COVERAGE, needs, env: s.env, cwd: s.root });
    assert.equal(answer.disposition, 'none-eligible', JSON.stringify(needs));
    assert.deepEqual(gap(answer, 'claude', 'spawn-denial'), { requirement: 'spawn-denial', result: 'unknown', reason: 'no spawn-denial flag in this test' });
  }
});

test('requirementsFor: blocking-hook fails profile-unknown for a null profile and carries an UnknownEnforcementTarget code', () => {
  const facts = Object.fromEntries(FACTS.map((name) => [name, { state: 'yes', reason: 'test', at: '2026-10-15T00:00:00.000Z', basis: 'free' }]));
  const hook = (harness, worker, coverage) => requirementsFor({ harness, worker }, facts, [GATE], coverage).find((r) => r.requirement === GATE);

  assert.deepEqual(hook('claude', clone('claude'), REAL_COVERAGE), { requirement: GATE, result: 'failed', reason: 'profile-unknown' });
  const anyProfile = { ...clone('claude'), profile: 'any' };
  const met = hook('claude', anyProfile, REAL_COVERAGE);
  assert.equal(met.result, 'met', 'claude any has a verified blocking gate row and hooks loaded');
  assert.match(met.reason, /^blocking at /);
  assert.deepEqual(hook('pi', anyProfile, OBSERVATION_COVERAGE), { requirement: GATE, result: 'failed', reason: 'unknown-harness' });
  assert.deepEqual(hook('claude', { ...anyProfile, profile: 'ide' }, OBSERVATION_COVERAGE), { requirement: GATE, result: 'failed', reason: 'unknown-profile' });
  const notLoaded = requirementsFor({ harness: 'claude', worker: anyProfile }, { ...facts, hooksLoaded: { state: 'no', reason: 'no-session-start-observed', at: null } }, [GATE], REAL_COVERAGE);
  assert.deepEqual(notLoaded.find((r) => r.requirement === GATE).result, 'failed');
});

test('needs: the policy set comes from coverage rows without *, and unknown ids are usage errors listing the valid ones', () => {
  const policies = policyVocabulary(REAL_COVERAGE);
  assert.equal(policies.has('*'), false);
  assert.deepEqual([...policies].sort(), [...new Set(REAL_COVERAGE.rows.map((r) => r.policy))].filter((p) => p !== '*').sort());
  assert.deepEqual(validateNeeds(['login', 'login', GATE], REAL_COVERAGE), ['login', GATE]);

  const usage = (fn, ...expected) => assert.throws(fn, (error) => {
    assert.ok(error instanceof ReadinessError);
    assert.equal(error.code, 'usage');
    for (const text of expected) assert.ok(error.message.includes(text), `${error.message} lists ${text}`);
    return true;
  });
  usage(() => validateNeeds(['blocking-hook:no-such-policy'], REAL_COVERAGE), 'no-such-policy', ...policies);
  usage(() => validateNeeds(['blocking-hook:*'], REAL_COVERAGE), ...policies);
  usage(() => validateNeeds(['telepathy'], REAL_COVERAGE), 'telepathy', ...NEED_IDS, 'blocking-hook:<policy>');
  usage(() => select({ descriptors: { claude: clone('claude') }, coverage: REAL_COVERAGE, needs: ['telepathy'], env: { PATH: '' }, cwd: '/nonexistent' }), ...NEED_IDS);
  usage(() => describe({ descriptors: { claude: clone('claude') }, coverage: REAL_COVERAGE, harness: 'claude', needs: ['blocking-hook:x'], env: { PATH: '' }, cwd: '/nonexistent' }), ...policies);
  usage(() => describe({ descriptors: { claude: clone('claude') }, coverage: REAL_COVERAGE, harness: 'codex', env: { PATH: '' }, cwd: '/nonexistent' }), 'claude');
});

test('select: three fakes with one eligible select it with its reason and write nothing', POSIX_ONLY, async (t) => {
  const descriptors = { claude: clone('claude'), codex: clone('codex'), gemini: clone('gemini') };
  const s = setup(t, {
    version: [{ print: 'fake 1.0' }],
    byBinary: { 'fake-claude': { runnable: [{ exit: 3 }] } },
  }, ['fake-claude', 'fake-codex', 'fake-gemini']);
  await probe({ descriptors, env: s.env, cwd: s.root });

  const before = snapshot(s.root);
  const answer = select({ descriptors, coverage: REAL_COVERAGE, env: s.env, cwd: s.root });
  assert.deepEqual(snapshot(s.root), before, 'select writes nothing');
  assert.equal(answer.disposition, 'selected');
  assert.equal(answer.harness, 'codex');
  assert.match(answer.reason, /^first eligible harness in registry order; met: installed, runnable, one-shot, structured-output, read-only, spawn-denial; probed at \d{4}-/);
  assert.deepEqual(answer.candidates.map((c) => [c.harness, c.eligible]), [['claude', false], ['codex', true], ['gemini', false]]);
  assert.deepEqual(gap(answer, 'claude', 'runnable'), { requirement: 'runnable', result: 'failed', reason: 'exit 3' });
  assert.equal(gap(answer, 'gemini', 'read-only').result, 'unknown');

  const only = select({ descriptors, coverage: REAL_COVERAGE, harness: 'gemini', env: s.env, cwd: s.root });
  assert.equal(only.disposition, 'none-eligible');
  assert.deepEqual(only.candidates.map((c) => c.harness), ['gemini']);
});

test('select: none eligible returns each gap and the fallback modes', POSIX_ONLY, async (t) => {
  const descriptors = { claude: clone('claude'), codex: clone('codex'), gemini: clone('gemini') };
  const s = setup(t, { version: [{ print: 'fake 1.0' }], runnable: [{ exit: 1 }] }, ['fake-claude', 'fake-codex', 'fake-gemini']);
  await probe({ descriptors, env: s.env, cwd: s.root });
  const before = snapshot(s.root);
  const answer = select({ descriptors, coverage: REAL_COVERAGE, env: s.env, cwd: s.root });
  assert.deepEqual(snapshot(s.root), before);
  assert.equal(answer.disposition, 'none-eligible');
  assert.equal('harness' in answer, false);
  assert.deepEqual(answer.fallback, {
    modes: ['sequential', 'manual'],
    rule: 'claim with --mode sequential or manual; a subagent claim is run only by worker --action run',
  });
  for (const candidate of answer.candidates) {
    assert.equal(candidate.eligible, false);
    assert.ok(candidate.gaps.length > 0);
    for (const item of candidate.gaps) assert.deepEqual(Object.keys(item), ['requirement', 'result', 'reason']);
    assert.deepEqual(gap(answer, candidate.harness, 'runnable'), { requirement: 'runnable', result: 'failed', reason: 'exit 1' });
  }
});

test('select: the real registry selects nothing when no harness is installed (DEC-017)', (t) => {
  const dir = tempDir(t, 'doflow-eligibility-real-');
  const emptyBin = path.join(dir, 'bin');
  fs.mkdirSync(emptyBin);
  const env = { PATH: emptyBin, HOME: path.join(dir, 'home') };
  const answer = select({ env, cwd: dir });
  assert.equal(answer.disposition, 'none-eligible');
  assert.equal(answer.candidates.length, 8);
  for (const candidate of answer.candidates) {
    assert.equal(candidate.eligible, false, candidate.harness);
    if (candidate.harness === 'codex') {
      // 109 IC-008: codex's static entries are supported, so only the discover-time gaps remain.
      assert.deepEqual(candidate.gaps.map((g) => g.requirement), ['installed', 'runnable'], candidate.harness);
      assert.equal(gap(answer, 'codex', 'one-shot'), undefined);
      assert.equal(gap(answer, 'codex', 'spawn-denial'), undefined);
      continue;
    }
    assert.equal(gap(answer, candidate.harness, 'one-shot').result, 'unknown', candidate.harness);
    assert.equal(gap(answer, candidate.harness, 'spawn-denial').result, 'unknown', candidate.harness);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bin']);
});
