'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { loadPolicy, evaluate, validateFindings } = require('../../src/runtime/roadmap/gates.ts');
const { sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const baseBytes = fs.readFileSync(path.join(__dirname, '../../core/registry/gates.json'));
const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const copy = (x) => JSON.parse(JSON.stringify(x));
const review = () => ({ schema: 1, row: '113', slug: '113-goal-order', reviewedHead: HEAD,
  seats: [{ id: 'one', findings: [] }, { id: 'two', findings: [] }], converged: [] });
function facts(overrides = {}) {
  const values = { row: { id: '113', slug: '113-goal-order', writeSet: ['src/', 'test/'], needs: [], requires: [] },
    heads: { developHead: PARENT, featureHead: HEAD }, 'markers:requirement': 0, 'markers:design': 0, 'markers:plan': 0,
    'protected-paths': { changes: [], writeSet: [], planFiles: [], packages: { base: {}, head: {} } },
    plan: { ok: true, files: ['src/x.ts'] }, needs: [], requires: [],
    verification: [{ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS' }],
    findings: review(), dispositions: { ancestors: {}, decisions: [] }, ...overrides };
  return Object.entries(values).map(([name, value]) => ({ name, value, locator: `fixture:${name}`, sha256: sha256Digest(JSON.stringify(value)) }));
}

for (const fixture of require('../fixtures/roadmap/gates/policy-cases.json')) {
  test(`policy fixture: ${fixture.name}`, () => {
    if ('base' in fixture || fixture.override) {
      const loaded = loadPolicy('base' in fixture ? fixture.base : baseBytes, fixture.override && JSON.stringify(fixture.override));
      assert.equal(loaded.ok, false);
      assert.deepEqual(loaded.reasons, [fixture.reason]);
      assert.equal(loaded.policy, null, 'a rejected override never partially applies');
    } else {
      const policy = loadPolicy(baseBytes).policy;
      if (fixture.mode) policy.classes.feature['gate-0'].autopilot = fixture.mode;
      assert.deepEqual(evaluate(policy, fixture.class || 'feature', 'gate-0', facts('row' in fixture ? { row: fixture.row } : {})).reasons, [fixture.reason]);
    }
  });
}

for (const fixture of require('../fixtures/roadmap/gates/cases.json')) {
  test(`predicate fixture: ${fixture.name}`, () => {
    const policy = loadPolicy(baseBytes).policy;
    policy.classes.feature[fixture.gate].predicates = [fixture.predicate];
    const values = copy(fixture.facts || {});
    if (fixture.verdicts) values.verification = fixture.verdicts.map((verdict) => ({ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict }));
    if (fixture.reviewPatch) values.findings = { ...review(), ...fixture.reviewPatch };
    if (fixture.finding) values.findings = { ...review(), converged: [fixture.finding] };
    const input = facts(values);
    const before = JSON.stringify({ policy, input });
    const result = evaluate(policy, 'feature', fixture.gate, input);
    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.reasons, fixture.reasons);
    assert.equal(result.reason, fixture.reasons[0]);
    assert.equal(result.rule, `${fixture.gate}/${fixture.predicate}`);
    assert.equal(JSON.stringify(result), JSON.stringify(evaluate(policy, 'feature', fixture.gate, input)));
    assert.equal(JSON.stringify({ policy, input }), before);
  });
}

for (const gate of ['gate-0', 'gate-a', 'gate-b']) test(`${gate} passes with complete evidence`, () => {
  const result = evaluate(loadPolicy(baseBytes).policy, 'feature', gate, facts());
  assert.equal(result.decision, 'pass');
  assert.deepEqual(result.reasons, []);
  assert.match(result.inputsDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.inputs.length > 0);
  assert.ok(result.inputs.every((x) => typeof x.locator === 'string' && /^sha256:[0-9a-f]{64}$/.test(x.sha256)));
});

test('override narrows atomically, binds both byte digests, and never mutates base', () => {
  const override = JSON.stringify({ classes: { feature: { 'gate-0': { autopilot: 'never' }, 'gate-b': { minSeats: 3 } } },
    protected: { paths: [...JSON.parse(baseBytes).protected.paths, 'src/extra/'] }, loop: { wip: 1, maxSteps: 100 } });
  const loaded = loadPolicy(baseBytes, override);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.policy.loop.wip, 1);
  assert.equal(loaded.policy.classes.feature['gate-b'].minSeats, 3);
  assert.equal(loaded.policy.classes.feature['gate-0'].autopilot, 'never');
  assert.equal(loaded.digest, `${sha256Digest(baseBytes)}+${sha256Digest(override)}`);
  assert.equal(loadPolicy(baseBytes).policy.loop.wip, 2);
  assert.equal(loadPolicy(JSON.stringify(loaded.policy), JSON.stringify({ classes: { feature: { 'gate-0': { autopilot: 'approve' } } } })).ok, false);
  assert.equal(loadPolicy(baseBytes, '{').ok, false);
  assert.equal(loadPolicy(baseBytes, JSON.stringify({ loop: { wip: 0 } })).ok, false);
  assert.equal(loadPolicy(baseBytes, JSON.stringify({ loop: { wip: 1, maxSteps: 300 } })).policy, null);
  assert.equal(loadPolicy(baseBytes, '{"classes":{"feature":{"__proto__":{"minSeats":3}}}}').ok, false);
  assert.equal(Object.prototype.minSeats, undefined);
});

test('all predicates run and preserve declared reason order; inputs are order independent', () => {
  const input = facts({ 'markers:design': 2, 'markers:plan': 1, plan: { ok: false, files: ['elsewhere/x.ts'] },
    needs: [{ id: '096', status: 'not-started' }], requires: [{ id: 'x', declared: false }] });
  const policy = loadPolicy(baseBytes).policy;
  const result = evaluate(policy, 'feature', 'gate-a', input);
  assert.deepEqual(result.reasons, ['plan-unparsable', 'markers-open:design/design.md', 'markers-open:plan.md', 'need-unmerged:096', 'prerequisite-no-source:x', 'write-set-exceeded:elsewhere/x.ts']);
  assert.equal(JSON.stringify(result), JSON.stringify(evaluate(policy, 'feature', 'gate-a', [...input].reverse())));
});

test('C7 protects control-plane paths case-insensitively and catches covering gate-a write sets', () => {
  const policy = loadPolicy(baseBytes).policy;
  for (const protectedPath of [
    'src/runtime/workflow-orchestrator.ts',
    'src/runtime/decision-register.ts',
    'core/registry/settings.json',
    'core/harnesses/shared/hooks/policies/',
    '.github/workflows/',
  ]) assert.ok(policy.protected.paths.includes(protectedPath), `missing protected path ${protectedPath}`);

  policy.classes.feature['gate-a'].predicates = ['protected-paths'];
  const check = (value) => evaluate(policy, 'feature', 'gate-a', facts({
    'protected-paths': { changes: [], writeSet: [], planFiles: [], packages: { base: {}, head: {} }, ...value },
  })).reasons;
  assert.deepEqual(check({ changes: [{ status: 'M', path: 'core/registry/settings.json' }] }),
    ['protected-path:core/registry/settings.json']);
  assert.deepEqual(check({ changes: [{ status: 'M', path: 'CORE/registry/Gates.json' }] }),
    ['protected-path:CORE/registry/Gates.json']);
  assert.deepEqual(check({ writeSet: ['src/runtime/'] }), ['protected-path:src/runtime/']);
});

test('guard additions pass; modifications, deletions, renames and dependency edits deny', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-a'].predicates = ['protected-paths'];
  const check = (value) => evaluate(policy, 'feature', 'gate-a', facts({ 'protected-paths': { changes: [], packages: { base: {}, head: {} }, ...value } })).reasons;
  assert.deepEqual(check({ changes: [{ status: 'A', path: 'test/guards/new.test.js' }] }), []);
  for (const status of ['M', 'D', 'R100']) assert.deepEqual(check({ changes: [{ status, path: 'test/guards/a.test.js' }] }), ['protected-path:test/guards/a.test.js']);
  assert.deepEqual(check({ changes: [{ status: 'R100', oldPath: 'test/guards/a.test.js', path: 'test/other.js' }] }), ['protected-path:test/guards/a.test.js']);
  for (const key of policy.protected.packageJsonKeys) assert.deepEqual(check({ packages: { base: { [key]: { a: '1' } }, head: { [key]: { a: '2' } } } }), ['protected-path:package.json']);
  assert.deepEqual(check({ packages: { base: { dependencies: { a: '1', b: '2' }, version: '1' }, head: { dependencies: { b: '2', a: '1' }, version: '2' } } }), []);
  assert.deepEqual(check({ writeSet: ['core/'], planFiles: ['core/registry/gates.json'] }), ['protected-path:core/', 'protected-path:core/registry/gates.json']);
  assert.deepEqual(check({ writeSet: ['test/'] }), ['protected-path:test/']);
  assert.deepEqual(check({ packages: { base: { dependencies: null }, head: { dependencies: {} } } }), ['protected-path:package.json']);
});

test('write sets reject traversal and sibling prefixes; no declared write set means exclusive unrestricted work', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-a'].predicates = ['plan-within-write-set'];
  for (const file of ['src/../secrets', '/src/x.ts', 'src2/x.ts', 'src\\..\\secrets']) {
    assert.deepEqual(evaluate(policy, 'feature', 'gate-a', facts({ plan: { ok: true, files: [file] } })).reasons, [`write-set-exceeded:${file}`]);
  }
  assert.equal(evaluate(policy, 'feature', 'gate-a', facts({ row: { id: '113', slug: '113-goal-order' } })).decision, 'pass');
});

test('verification ignores dirty, stale-head, and other-task records and uses append order', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  for (const change of [{ clean: false }, { head: PARENT }, { taskId: 'other' }]) {
    const lines = [{ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS', ...change }];
    assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: lines })).reasons, ['verify-missing']);
  }
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: [{ taskId: '113-goal-order', head: HEAD, clean: true }] })).reasons, ['verify-not-pass']);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: [{ schema: 2, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS' }] })).reasons, ['verify-not-pass']);
});

test('verify-flaky needs a FAIL followed by a PASS on the head; a single FAIL or INCONCLUSIVE is only verify-not-pass (D12)', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  const run = (verdict) => ({ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict });
  const reasons = (...verdicts) => evaluate(policy, 'feature', 'gate-b', facts({ verification: verdicts.map(run) })).reasons;
  assert.deepEqual(reasons('FAIL'), ['verify-not-pass']);
  assert.deepEqual(reasons('INCONCLUSIVE'), ['verify-not-pass']);
  assert.deepEqual(reasons('PASS', 'FAIL'), ['verify-not-pass']);
  assert.deepEqual(reasons('FAIL', 'PASS'), ['verify-flaky']);
  assert.deepEqual(reasons('FAIL', 'PASS', 'FAIL'), ['verify-not-pass', 'verify-flaky']);
  assert.deepEqual(reasons('INCONCLUSIVE', 'PASS'), []);
});

test('findings validator rejects invalid and ambiguous records and missing disposition fields', () => {
  assert.equal(validateFindings(JSON.stringify(review())).ok, true);
  for (const value of [null, '{', {}, { ...review(), row: '114' , slug: '113-goal-order' }, { ...review(), reviewedHead: 'HEAD' },
    { ...review(), seats: [{ id: 'one', findings: [] }, { id: 'one', findings: [] }] },
    { ...review(), converged: [{ id: 'C1', from: ['unknown'], severity: 'blocker', locator: 'x:1', status: 'open' }] },
    { ...review(), blockers: 0 }]) assert.equal(validateFindings(value).ok, false, JSON.stringify(value));
  for (const status of ['fixed', 'refuted', 'user-accepted']) {
    assert.equal(validateFindings({ ...review(), converged: [{ id: 'C1', from: [], severity: 'blocker', locator: 'x:1', status }] }).ok, false);
  }
});

test('findings row/slug binding, complete dispositions and blockers derived from converged records', () => {
  const policy = loadPolicy(baseBytes).policy;
  const findings = { ...review(), converged: [
    { id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'fixed', fixedIn: PARENT },
    { id: 'C2', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'refuted', evidence: 'test/x.js:22' },
    { id: 'C3', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' },
    { id: 'C4', from: [], severity: 'should-fix', locator: 'src/x.ts:1', status: 'open' }] };
  for (const channel of ['question', 'gate', 'prompt']) assert.equal(evaluate(policy, 'feature', 'gate-b', facts({ findings,
    dispositions: { ancestors: { [PARENT]: true }, decisions: [{ id: 'DEC-001', channel }] } })).decision, 'pass');
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: { ...review(), row: '114', slug: '114-other' } })).reasons, ['findings-invalid']);
});

test('missing or unreadable predicate facts fail closed with the source named', () => {
  const policy = loadPolicy(baseBytes).policy;
  for (const [gate, name, reason] of [['gate-0', 'markers:requirement', 'unresolved-clarifications'], ['gate-a', 'needs', 'need-unmerged'], ['gate-a', 'requires', 'capability-unreachable'], ['gate-b', 'verification', 'verify-missing']]) {
    const input = facts().map((f) => f.name === name ? { ...f, value: null, unreadable: 'EACCES' } : f);
    assert.ok(evaluate(policy, 'feature', gate, input).reasons.includes(`${reason}:fixture:${name}`));
  }
  assert.equal(evaluate(policy, 'feature', 'gate-0', facts().filter((f) => f.name !== 'markers:requirement')).decision, 'deny');
});

test('malformed findings remain data and cannot crash evaluation of later predicates', () => {
  const policy = loadPolicy(baseBytes).policy;
  for (const findings of [{ ...review(), seats: [null], converged: [null] }, { ...review(), seats: [{ id: 'one', findings: [null] }] }]) {
    const result = evaluate(policy, 'feature', 'gate-b', facts({ findings }));
    assert.equal(result.decision, 'deny');
    assert.ok(result.reasons.includes('findings-invalid'));
  }
  const findings = { ...review(), converged: [{ id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' }] };
  assert.ok(evaluate(policy, 'feature', 'gate-b', facts({ findings, dispositions: { ancestors: {}, decisions: [null] } })).reasons.includes('accepted-without-user-decision:C1'));
});

// Run the real assertions against scratch source copies. Each regression must yield an
// assertion failure, not a syntax/load failure. No tracked source or git state is changed.
const mutations = [
  { name: 'wip widening', from: 'value[limit] > base.loop[limit]', to: 'false', pattern: 'policy fixture: wip widening' },
  { name: 'stale parent review', from: 'findings.reviewedHead !== head', to: 'false', pattern: 'predicate fixture: review on parent' },
  { name: 'all predicates and declared order', from: 'for (const predicate of gate.predicates) {', to: 'for (const predicate of [...gate.predicates].reverse()) {', pattern: 'all predicates run and preserve declared reason order' },
  { name: 'FAIL then PASS', from: "run.verdict === 'FAIL' && runs.slice(i + 1).some((later: any) => later.verdict === 'PASS')", to: 'false', pattern: 'predicate fixture: FAIL then PASS remains flaky' },
  { name: 'INCONCLUSIVE', from: "runs[runs.length - 1].verdict !== 'PASS'", to: 'false', pattern: 'predicate fixture: inconclusive verification' },
  { name: 'seat minimum', from: 'seats.length < (gate.minSeats || 0)', to: 'false', pattern: 'predicate fixture: too few seats' },
  { name: 'user-channel backing', from: "finding.status === 'user-accepted' && !decisions.some", to: 'false && !decisions.some', pattern: 'predicate fixture: agent acceptance' },
  { name: 'fixed ancestry', from: "finding.status === 'fixed' && backing?.ancestors?.[finding.fixedIn] !== true", to: 'false', pattern: 'predicate fixture: fix outside ancestry' },
  { name: 'marker outside code', module: 'facts', from: "visible.startsWith('[NEEDS CLARIFICATION', i)", to: 'false', pattern: 'markers outside fences count' },
  { name: 'raw source digest', module: 'facts', from: 'sha256Digest(bytes === undefined ? JSON.stringify(value) : bytes)', to: "sha256Digest('')", pattern: 'gate-0 reads only its named artifact' },
  { name: 'unreadable source', module: 'facts', from: "unreadable.length ? `unreadable:${unreadable.join(',')}` : undefined", to: 'undefined', pattern: 'unreadable git facts never become' },
  { name: 'dependency merge integrity', module: 'facts', from: "integrity.offendingRowIds.includes(id) ? 'not-started' : statuses.rowStatus[id]", to: 'statuses.rowStatus[id]', pattern: 'needs use first-parent merge integrity' },
  { name: 'readability changes digest', module: 'facts', from: 'unreadable ? sha256Digest(JSON.stringify({ unreadable, contentDigest })) : contentDigest', to: 'contentDigest', pattern: 'unreadable empty artifacts have a different input digest' },
  { name: 'verification schema', from: 'runs.some((run: any) => run.schema !== 1)', to: 'false', pattern: 'verification ignores dirty, stale-head' },
  { name: 'artifact layout precedence', module: 'facts', from: "['intention/requirement.md', 'requirement.md']", to: "['requirement.md', 'intention/requirement.md']", pattern: 'artifact lookup follows' },
];
for (const fixture of require('../fixtures/roadmap/gates/cases.json')) {
  if (mutations.some((m) => m.name === `predicate ${fixture.predicate}`)) continue;
  mutations.push({ name: `predicate ${fixture.predicate}`, from: 'for (const predicate of gate.predicates) {',
    to: `for (const predicate of gate.predicates.filter((entry: string) => entry !== ${JSON.stringify(fixture.predicate)})) {`,
    pattern: `predicate fixture: ${fixture.name}` });
}
for (const mutation of mutations) test(`scratch negative control: ${mutation.name}`, (t) => {
  const scratch = tempDir(t, 'doflow-roadmap-gate-control-');
  const targetName = mutation.module || 'gates';
  const originalModule = path.join(__dirname, `../../src/runtime/roadmap/${targetName}.ts`);
  const originalTest = path.join(__dirname, `roadmap-${targetName}.test.js`);
  const targetModule = path.join(scratch, `${targetName}.ts`);
  const targetTest = path.join(scratch, 'control.test.js');
  const absolutize = (source, directory, substitute) => source.replace(/require\('([.][.]?\/[^']+)'\)/g, (_match, specifier) => {
    const absolute = path.resolve(directory, specifier);
    return `require(${JSON.stringify(absolute === substitute ? targetModule : absolute)})`;
  });
  const source = fs.readFileSync(originalModule, 'utf8');
  assert.equal(source.split(mutation.from).length, 2, 'mutation must replace exactly one known behavior');
  fs.writeFileSync(targetModule, absolutize(source.replace(mutation.from, mutation.to), path.dirname(originalModule)));
  fs.writeFileSync(targetTest, absolutize(fs.readFileSync(originalTest, 'utf8'), __dirname, originalModule)
    .replaceAll('__dirname', JSON.stringify(__dirname)));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.pattern}`, targetTest], {
    encoding: 'utf8', env, timeout: 15000 });
  assert.equal(run.status, 1, `${mutation.name} must turn its real test red: ${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout + run.stderr, /ERR_ASSERTION/, 'negative control must reach the assertion');
  t.diagnostic(`scratch ${mutation.name}: original assertion rejected regression`);
});
