'use strict';
// 081 B.1 (IC-004, IC-005, IC-006, IC-007, IC-023): discover, the free probe facts and the probe
// record, model-backed checks, freshness and the forwarding observation.
//
// No case starts a real harness (NFR-002): descriptors are the fake ones from
// test/fixtures/worker/descriptors.json (plus four clones under the remaining registered ids, so
// all seven are fakes), each child's PATH is a scratch bin/ holding only the fake CLI links plus
// the directory of process.execPath, and every child env is built from nothing, so the five
// DOFLOW_* identity variables are absent unless the probe itself sets them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { IDENTITY_VARS, kindOf, linkBin, writeScenario, readLog } = require('../helper/fake-harness-cli.ts');
const { validateWorker } = require('../../src/registry/index.ts');
const {
  PROBE_TIMEOUT_MS, PROBE_MAX_AGE_MS, FACTS, discover, probe, effectiveFacts, descriptorDigest, readProbeRecord, probeFile,
} = require('../../src/runtime/worker/readiness.ts');
const FIXTURE = require('../fixtures/worker/descriptors.json');

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MARKER = FIXTURE.claude.guidanceProbe.marker;
const FIXED: any = { run: 'probe0000aaaa', lineage: 'p0000aaaa' };
const BINDING = `xdg/doflow/session-env/sessions/L.${FIXED.run}.${FIXED.lineage}.1/bound`;

/** All seven registered harnesses as fakes: the fixture's four and claude clones for the rest. */
function sevenDescriptors() {
  const all = structuredClone(FIXTURE);
  for (const id of ['pi', 'copilot', 'kiro', 'antigravity']) {
    all[id] = structuredClone(FIXTURE.claude);
    all[id].cli.binary = `fake-${id}`;
  }
  return all;
}

/** A project root, a scratch bin/ with `names`, a scenario and a log, and a child env built from
 * nothing: PATH, HOME and XDG_CONFIG_HOME under the root, no DOFLOW_* variable. */
function setup(t: any, scenario: any, names: any) {
  const dir = tempDir(t, 'doflow-probe-');
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const log = path.join(dir, 'log.jsonl');
  const env: any = {
    PATH: linkBin(path.join(dir, 'bin'), names),
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    FAKE_HARNESS_SCENARIO: writeScenario(dir, scenario),
    FAKE_HARNESS_LOG: log,
  };
  for (const key of IDENTITY_VARS) assert.equal(key in env, false);
  return { dir, root, env, log, kinds: () => readLog(log).map((line: any) => kindOf(line.argv)) };
}

const one = (result: any, harness: any) => result.harnesses.find((entry: any) => entry.harness === harness);

test('discover: two fakes present with versions, five absent, no process beyond --version and nothing written', POSIX_ONLY, (t): any => {
  const descriptors = sevenDescriptors();
  const errors: any = [];
  for (const id of Object.keys(descriptors)) validateWorker(descriptors[id], `harness '${id}'`, errors);
  assert.deepEqual(errors, []);
  const long = `fake-codex ${'9'.repeat(100)}`;
  const s = setup(t, {
    byBinary: {
      'fake-claude': { version: [{ print: 'fake-claude 1.2.3\u0007\nsecond line' }] },
      'fake-codex': { version: [{ print: long }] },
    },
  }, ['fake-claude', 'fake-codex']);

  const result = discover({ descriptors, env: s.env, cwd: s.root });
  assert.equal(result.disposition, 'discovered');
  assert.match(result.at, ISO);
  assert.equal(result.harnesses.length, 7);
  const present = result.harnesses.filter((entry: any) => entry.present);
  assert.deepEqual(present.map((entry: any) => entry.harness), ['claude', 'codex']);
  assert.equal(one(result, 'claude').version, 'fake-claude 1.2.3');
  assert.equal(one(result, 'claude').reason, null);
  assert.equal(one(result, 'claude').path, path.join(s.dir, 'bin', 'fake-claude'));
  assert.equal(one(result, 'codex').version, long.slice(0, 80));
  for (const entry of result.harnesses.filter((item: any) => !item.present)) {
    assert.equal(entry.reason, 'not-on-path', entry.harness);
    assert.equal(entry.version, null);
    assert.match(entry.at, ISO);
  }
  assert.deepEqual(s.kinds(), ['version', 'version']);
  assert.equal(fs.existsSync(path.join(s.root, '.doflow')), false);
});

test('discover: a found binary whose version exits non-zero is present with version-failed', POSIX_ONLY, (t) => {
  const s = setup(t, { version: [{ exit: 4 }] }, ['fake-claude']);
  const entry = one(discover({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude');
  assert.equal(entry.present, true);
  assert.equal(entry.reason, 'version-failed');
  assert.equal(entry.version, null);
});

test('probe: installed and runnable yes with reasons and times; quota, model and login unknown; stdout never stored', POSIX_ONLY, async (t) => {
  const worker = structuredClone(FIXTURE.claude);
  worker.loginProbe = {
    status: 'unknown', evidence: [], verification: 'Not declared by this test descriptor.', verifiedOn: '2026-10-15', reason: 'no login probe in this test',
  };
  const s = setup(t, {
    version: [{ print: 'fake 1.0' }],
    runnable: [{ print: 'PROBE-STDOUT-SENTINEL' }, { exit: 0 }],
    guidance: [{ print: MARKER }],
  }, ['fake-claude']);

  const result = await probe({ descriptors: { claude: worker }, env: s.env, cwd: s.root });
  assert.equal(result.disposition, 'probed');
  const { facts, recordedAt } = one(result, 'claude');
  assert.match(recordedAt, ISO);
  assert.deepEqual(Object.keys(facts).sort(), [...FACTS].sort());
  assert.equal(facts.installed.state, 'yes');
  assert.equal(facts.installed.reason, 'version-answered');
  assert.equal(facts.runnable.state, 'yes');
  assert.equal(facts.runnable.reason, 'exit 0');
  for (const name of FACTS) {
    assert.match(facts[name].at, ISO, name);
    assert.equal(facts[name].basis, 'free', name);
  }
  assert.deepEqual([facts.quota.state, facts.quota.reason], ['unknown', 'no-free-probe']);
  assert.deepEqual([facts.model.state, facts.model.reason], ['unknown', 'no-free-probe']);
  assert.deepEqual([facts.login.state, facts.login.reason], ['unknown', 'no-free-probe-declared']);
  // No binding and no sessions.log line: IC-023's "neither" row.
  assert.deepEqual([facts.hooksLoaded.state, facts.hooksLoaded.reason], ['no', 'no-session-start-observed']);
  assert.deepEqual([facts.identityForwarded.state, facts.identityForwarded.reason], ['unknown', 'hooks-not-loaded']);
  assert.equal(facts.guidanceLoaded.state, 'yes');

  const file = probeFile(s.root, 'claude');
  assert.equal(file, path.join(s.root, '.doflow', 'state', 'worker-probes', 'claude.json'));
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('PROBE-STDOUT-SENTINEL'), false);
  assert.equal(text.includes(MARKER), false);
  const record = readProbeRecord(s.root, 'claude');
  assert.equal(record.binaryPath, path.join(s.dir, 'bin', 'fake-claude'));
  assert.equal(record.version, 'fake 1.0');
  assert.equal(record.descriptorDigest, descriptorDigest(worker));
  assert.deepEqual(record.facts, facts);

  // The forwarding probe ran with a fresh probe identity; every other probe with none.
  const lines = readLog(s.log);
  assert.deepEqual(lines.map((line: any) => kindOf(line.argv)), ['version', 'runnable', 'hooks', 'guidance']);
  const hooks = lines.find((line: any) => kindOf(line.argv) === 'hooks').doflowEnv;
  assert.match(hooks.DOFLOW_RUN_ID, /^probe[0-9a-f]{8}$/);
  assert.match(hooks.DOFLOW_LINEAGE_ID, /^p[0-9a-f]{8}$/);
  assert.deepEqual([hooks.DOFLOW_ATTEMPT, hooks.DOFLOW_SESSION_ROLE, hooks.DOFLOW_WORKTREE], ['1', 'worker', s.root]);
  for (const line of lines.filter((item: any) => kindOf(item.argv) !== 'hooks')) {
    for (const key of IDENTITY_VARS) assert.equal(line.doflowEnv[key], null, `${kindOf(line.argv)} ${key}`);
  }
});

test('probe: a hanging runnableProbe is unknown timeout within its bound', POSIX_ONLY, async (t) => {
  const s = setup(t, { runnable: [{ sleep: 20000 }] }, ['fake-claude']);
  const started = Date.now();
  const result = await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root });
  const elapsed = Date.now() - started;
  const { runnable } = one(result, 'claude').facts;
  assert.deepEqual([runnable.state, runnable.reason], ['unknown', 'timeout']);
  assert.ok(elapsed < PROBE_TIMEOUT_MS + 5000, `took ${elapsed} ms`);
});

test('probe: hooks and forwarding yes from the unit binding', POSIX_ONLY, async (t) => {
  const s = setup(t, { hooks: [{ write: { path: BINDING, content: 'fake-session\n' } }] }, ['fake-claude']);
  const result = await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root, probeIdentity: () => FIXED });
  const { hooksLoaded, identityForwarded } = one(result, 'claude').facts;
  assert.deepEqual([hooksLoaded.state, hooksLoaded.reason], ['yes', 'unit-binding-observed']);
  assert.deepEqual([identityForwarded.state, identityForwarded.reason], ['yes', 'unit-binding-observed']);
});

test('probe: an empty binding is not an observation', POSIX_ONLY, async (t) => {
  const s = setup(t, { hooks: [{ write: { path: BINDING, content: '' } }] }, ['fake-claude']);
  const result = await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root, probeIdentity: () => FIXED });
  assert.equal(one(result, 'claude').facts.hooksLoaded.state, 'no');
});

test('probe: a sessions.log START line only gives hooks yes and forwarding no; an old or foreign line gives neither', POSIX_ONLY, async (t) => {
  const future = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const s = setup(t, {}, ['fake-claude']);
  // The line names the root, which exists only after setup.
  writeScenario(s.dir, { hooks: [{ write: { path: 'xdg/doflow/sessions.log', content: `${future} START s-1 ${s.root}\n` } }] });
  let facts = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts;
  assert.deepEqual([facts.hooksLoaded.state, facts.hooksLoaded.reason], ['yes', 'session-start-logged']);
  assert.deepEqual([facts.identityForwarded.state, facts.identityForwarded.reason], ['no', 'no-unit-binding']);

  writeScenario(s.dir, {
    hooks: [{ write: { path: 'xdg/doflow/sessions.log', content: `2000-01-01T00:00:00Z START s-0 ${s.root}\n${future} START s-2 /elsewhere\n` } }],
  });
  facts = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts;
  assert.deepEqual([facts.hooksLoaded.state, facts.identityForwarded.state], ['no', 'unknown']);
});

test('probe: guidance is decided by the marker', POSIX_ONLY, async (t) => {
  const s = setup(t, { guidance: [{ print: `loaded ${MARKER} ok` }] }, ['fake-claude']);
  let facts = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts;
  assert.deepEqual([facts.guidanceLoaded.state, facts.guidanceLoaded.reason], ['yes', 'marker-found']);
  writeScenario(s.dir, { guidance: [{ print: 'no guidance here' }] });
  facts = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts;
  assert.deepEqual([facts.guidanceLoaded.state, facts.guidanceLoaded.reason], ['no', 'marker-absent']);
});

test('probe: login comes from the exit status only, never the output', POSIX_ONLY, async (t) => {
  const s = setup(t, { login: [{ print: 'not logged in' }, { exit: 0 }] }, ['fake-claude']);
  let { login } = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts;
  assert.deepEqual([login.state, login.reason], ['yes', 'exit 0']);
  writeScenario(s.dir, { login: [{ print: 'logged in as someone' }, { exit: 3 }] });
  ({ login } = one(await probe({ descriptors: { claude: FIXTURE.claude }, env: s.env, cwd: s.root }), 'claude').facts);
  assert.deepEqual([login.state, login.reason], ['no', 'exit 3']);
});

test('model check: refused without a budget or below the estimate, run once and recorded estimated with both', POSIX_ONLY, async (t) => {
  const s = setup(t, { 'model-check:hooks-roundtrip': [{ write: { path: BINDING, content: 'fake-session\n' } }] }, ['fake-opencode']);
  const base: any = { descriptors: { opencode: FIXTURE.opencode }, env: s.env, cwd: s.root, probeIdentity: () => FIXED };

  await assert.rejects(probe({ ...base, harness: 'opencode', modelCheck: 'nope', budgetTokens: 1000 }), (error: any) => {
    assert.equal(error.code, 'usage');
    assert.match(error.message, /hooks-roundtrip/);
    return true;
  });
  await assert.rejects(probe({ ...base, modelCheck: 'hooks-roundtrip', budgetTokens: 1000 }), { code: 'usage' });

  const noBudget = await probe({ ...base, harness: 'opencode', modelCheck: 'hooks-roundtrip' });
  assert.equal(noBudget.disposition, 'refused');
  assert.equal(noBudget.reason, 'budget-required');
  const low = await probe({ ...base, harness: 'opencode', modelCheck: 'hooks-roundtrip', budgetTokens: 100 });
  assert.deepEqual([low.disposition, low.reason, low.estimateTokens, low.budgetTokens], ['refused', 'budget-insufficient', 500, 100]);
  assert.deepEqual(s.kinds(), [], 'a refused request starts no process');
  assert.equal(fs.existsSync(probeFile(s.root, 'opencode')), false);

  const ran = await probe({ ...base, harness: 'opencode', modelCheck: 'hooks-roundtrip', budgetTokens: 1000 });
  assert.equal(ran.disposition, 'probed');
  const entry = one(ran, 'opencode');
  assert.equal(s.kinds().filter((kind: any) => kind === 'model-check:hooks-roundtrip').length, 1);
  assert.equal(s.kinds().at(-1), 'model-check:hooks-roundtrip', 'the model check runs after the free probes');
  assert.deepEqual([entry.facts.hooksLoaded.state, entry.facts.hooksLoaded.basis], ['yes', 'model-backed']);
  assert.deepEqual([entry.facts.identityForwarded.state, entry.facts.identityForwarded.basis], ['yes', 'model-backed']);
  const check = readProbeRecord(s.root, 'opencode').modelChecks['hooks-roundtrip'];
  assert.deepEqual(check.usage, { tokens: 500, basis: 'estimated', budget: 1000 });
  assert.equal(check.overBudget, false);
  assert.match(check.at, ISO);
});

test('model check: usage the parser reports is recorded measured', POSIX_ONLY, async (t) => {
  const s = setup(t, { 'model-check:hooks-roundtrip': [{ emit: { type: 'usage', tokens: 1200 } }] }, ['fake-opencode']);
  await probe({ descriptors: { opencode: FIXTURE.opencode }, env: s.env, cwd: s.root, harness: 'opencode', modelCheck: 'hooks-roundtrip', budgetTokens: 1000 });
  const check = readProbeRecord(s.root, 'opencode').modelChecks['hooks-roundtrip'];
  assert.deepEqual(check.usage, { tokens: 1200, basis: 'measured', budget: 1000 });
  assert.equal(check.overBudget, true);
});

test('precedence: a free unknown never replaces a fresh model-backed answer', POSIX_ONLY, async (t) => {
  const s = setup(t, { 'model-check:hooks-roundtrip': [{ write: { path: BINDING, content: 'fake-session\n' } }] }, ['fake-opencode']);
  const base: any = { descriptors: { opencode: FIXTURE.opencode }, env: s.env, cwd: s.root, probeIdentity: () => FIXED };
  await probe({ ...base, harness: 'opencode', modelCheck: 'hooks-roundtrip', budgetTokens: 1000 });
  // opencode declares no free hooks probe, so a plain probe answers hooks `unknown` (free).
  const again = one(await probe(base), 'opencode').facts;
  assert.deepEqual([again.hooksLoaded.state, again.hooksLoaded.basis], ['yes', 'model-backed']);
  assert.deepEqual([again.identityForwarded.state, again.identityForwarded.basis], ['yes', 'model-backed']);
  assert.ok(readProbeRecord(s.root, 'opencode').modelChecks['hooks-roundtrip'], 'the model-check usage is kept');
});

test('freshness: 24 hours effective, 24 hours plus 1 ms or a changed version or digest is probe-stale', () => {
  const at = '2026-10-15T00:00:00.000Z';
  const atMs = Date.parse(at);
  const digest = descriptorDigest(FIXTURE.claude);
  const facts = Object.fromEntries(FACTS.map((name: any) => [name, { state: 'yes', reason: 'exit 0', at, basis: 'free' }]));
  const record: any = { harness: 'claude', at, binaryPath: '/bin/fake-claude', version: 'fake 1.0', descriptorDigest: digest, facts };
  const current: any = { path: '/bin/fake-claude', version: 'fake 1.0', descriptorDigest: digest };

  assert.equal(effectiveFacts(record, current, atMs + PROBE_MAX_AGE_MS).runnable.state, 'yes');
  const stale = (value: any) => {
    for (const name of FACTS) assert.deepEqual(value[name], { state: 'unknown', reason: 'probe-stale', at }, name);
  };
  stale(effectiveFacts(record, current, atMs + PROBE_MAX_AGE_MS + 1));
  stale(effectiveFacts(record, { ...current, version: 'fake 1.1' }, atMs));
  stale(effectiveFacts(record, { ...current, path: '/other/fake-claude' }, atMs));
  const edited = structuredClone(FIXTURE.claude);
  edited.runnableProbe.argv = ['probe', 'runnable', '--again'];
  assert.notEqual(descriptorDigest(edited), digest);
  stale(effectiveFacts(record, { ...current, descriptorDigest: descriptorDigest(edited) }, atMs));
  // Key order does not change the digest.
  const reordered = Object.fromEntries(Object.entries(FIXTURE.claude).reverse());
  assert.equal(descriptorDigest(reordered), digest);
  for (const value of Object.values(effectiveFacts(null, current, atMs))) assert.deepEqual(value, { state: 'unknown', reason: 'not-probed', at: null });
});

test('freshness: a fact dated in the future (clock skew) is probe-stale, not fresh', () => {
  const at = '2026-10-15T01:00:00.000Z';
  const digest = descriptorDigest(FIXTURE.claude);
  const facts = Object.fromEntries(FACTS.map((name: any) => [name, { state: 'yes', reason: 'exit 0', at, basis: 'free' }]));
  const record: any = { harness: 'claude', at, binaryPath: '/bin/fake-claude', version: 'fake 1.0', descriptorDigest: digest, facts };
  const current: any = { path: '/bin/fake-claude', version: 'fake 1.0', descriptorDigest: digest };
  const hourEarlier = Date.parse(at) - 3600000;
  for (const [name, value] of Object.entries(effectiveFacts(record, current, hourEarlier))) {
    assert.deepEqual(value, { state: 'unknown', reason: 'probe-stale', at }, name);
  }
  assert.equal(effectiveFacts(record, current, Date.parse(at)).runnable.state, 'yes', 'age 0 is fresh');
});

test('NFR-005: seven fake harnesses probe within seven times PROBE_TIMEOUT_MS with no run or model check', POSIX_ONLY, async (t) => {
  const descriptors = sevenDescriptors();
  const names = Object.values(descriptors).map((worker) => worker.cli.binary);
  const s = setup(t, {}, names);
  const started = Date.now();
  const result = await probe({ descriptors, env: s.env, cwd: s.root });
  const elapsed = Date.now() - started;
  t.diagnostic(`seven harnesses probed in ${elapsed} ms`);
  assert.ok(elapsed < 7 * PROBE_TIMEOUT_MS, `took ${elapsed} ms`);
  assert.equal(result.harnesses.length, 7);
  for (const entry of result.harnesses) {
    assert.equal(entry.facts.installed.state, 'yes', entry.harness);
    assert.ok(fs.existsSync(probeFile(s.root, entry.harness)), entry.harness);
  }
  const kinds = s.kinds();
  assert.equal(kinds.some((kind: any) => kind === 'run' || kind.startsWith('model-check:')), false, kinds.join(' '));
});
