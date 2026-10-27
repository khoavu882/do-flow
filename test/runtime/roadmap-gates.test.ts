'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { loadPolicy, evaluate, validateFindings, verifyRecordReasons } = require('../../src/runtime/roadmap/gates.ts');
const { sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const baseBytes = fs.readFileSync(path.join(__dirname, '../../core/registry/gates.json'));
const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const copy = (x: any) => JSON.parse(JSON.stringify(x));
const review = () => ({ schema: 1, row: '113', slug: '113-goal-order', reviewedHead: HEAD,
  seats: [{ id: 'one', findings: [] }, { id: 'two', findings: [] }], converged: [] });
function facts(overrides: any = {}) {
  const values: any = { row: { id: '113', slug: '113-goal-order', writeSet: ['src/', 'test/'], needs: [], requires: [] },
    heads: { developHead: PARENT, featureHead: HEAD }, 'markers:requirement': 0, 'markers:design': 0, 'markers:plan': 0,
    'protected-paths': { changes: [], writeSet: [], planFiles: [], packages: { base: {}, head: {} } },
    plan: { ok: true, files: ['src/x.ts'] }, needs: [], requires: [],
    verification: [{ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS' }],
    findings: review(), dispositions: { ancestors: {}, decisions: [] }, 'plan-verification-block': { present: false }, ...overrides };
  return Object.entries(values).map(([name, value]: any) => ({ name, value, locator: `fixture:${name}`, sha256: sha256Digest(JSON.stringify(value)) }));
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
    if (fixture.verdicts) values.verification = fixture.verdicts.map((verdict: any) => ({ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict }));
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
  assert.ok(result.inputs.every((x: any) => typeof x.locator === 'string' && /^sha256:[0-9a-f]{64}$/.test(x.sha256)));
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
  assert.equal((Object.prototype as any).minSeats, undefined);
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
  const check = (value: any) => evaluate(policy, 'feature', 'gate-a', facts({
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
  const check = (value: any) => evaluate(policy, 'feature', 'gate-a', facts({ 'protected-paths': { changes: [], packages: { base: {}, head: {} }, ...value } })).reasons;
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
    const lines: any = [{ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS', ...change }];
    assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: lines })).reasons, ['verify-missing']);
  }
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: [{ taskId: '113-goal-order', head: HEAD, clean: true }] })).reasons, ['verify-not-pass']);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: [{ schema: 2, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS' }] })).reasons, ['verify-not-pass']);
});

test('verify-flaky needs a FAIL followed by a PASS on the head; a single FAIL or INCONCLUSIVE is only verify-not-pass (D12)', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  const run = (verdict: any) => ({ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict });
  const reasons = (...verdicts: any[]) => evaluate(policy, 'feature', 'gate-b', facts({ verification: verdicts.map(run) })).reasons;
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
  const findings: any = { ...review(), converged: [
    { id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'fixed', fixedIn: PARENT },
    { id: 'C2', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'refuted', evidence: 'test/x.js:22' },
    { id: 'C3', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' },
    { id: 'C4', from: [], severity: 'should-fix', locator: 'src/x.ts:1', status: 'open' }] };
  const accepted = findings.converged.filter((f: any) => f.status !== 'user-accepted');
  assert.equal(evaluate(policy, 'feature', 'gate-b', facts({ findings: { ...findings, converged: accepted },
    dispositions: { ancestors: { [PARENT]: true }, decisions: [] } })).decision, 'pass');
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: { ...review(), row: '114', slug: '114-other' } })).reasons, ['findings-invalid']);
});

test('C5: autopilot gate-b denies an open blocker marked user-accepted, whatever user channel backs it', () => {
  const policy = loadPolicy(baseBytes).policy;
  const findings: any = { ...review(), converged: [
    { id: 'C3', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' }] };
  for (const channel of ['question', 'gate', 'prompt']) {
    const result = evaluate(policy, 'feature', 'gate-b', facts({ findings, dispositions: { ancestors: {}, decisions: [{ id: 'DEC-001', channel }] } }));
    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.reasons, ['user-accepted-needs-person:C3']);
    assert.equal(result.rule, 'gate-b/dispositions-backed');
  }
  assert.ok(JSON.parse(baseBytes).denyReasons.includes('user-accepted-needs-person'));
});

test('C6: plan-verification-absent passes only a readable present:false fact at gate-a and gate-b', () => {
  const policy = loadPolicy(baseBytes).policy;
  for (const gate of ['gate-a', 'gate-b']) {
    policy.classes.feature[gate].predicates = ['plan-verification-absent'];
    const reasons = (input: any) => evaluate(policy, 'feature', gate, input).reasons;
    assert.deepEqual(reasons(facts()), []);
    assert.deepEqual(reasons(facts({ 'plan-verification-block': { present: true } })), ['protected-path:plan-verification']);
    // Until the fact is gathered, an absent fact denies; it is never read as present:false.
    assert.deepEqual(reasons(facts().filter((f) => f.name !== 'plan-verification-block')), ['protected-path:plan-verification-block']);
    const unreadable = facts().map((f) => f.name === 'plan-verification-block' ? { ...f, unreadable: 'EACCES' } : f);
    assert.deepEqual(reasons(unreadable), ['protected-path:fixture:plan-verification-block']);
    for (const value of [null, {}, { present: 'false' }]) {
      assert.deepEqual(reasons(facts({ 'plan-verification-block': value })), ['protected-path:fixture:plan-verification-block']);
    }
  }
});

test('C21: refutation evidence must be a path:line or a test or reproducer file path, never prose', () => {
  const refuted = (evidence: any) => ({ ...review(), converged: [{ id: 'C1', from: [], severity: 'note', locator: 'src/x.ts:1', status: 'refuted', evidence }] });
  for (const evidence of ['src/x.ts:12', 'src/x.ts:12-14', 'test/runtime/x.test.js', 'scratch/repro.sh', 'Makefile:3']) {
    assert.equal(validateFindings(refuted(evidence)).ok, true, evidence);
  }
  for (const evidence of ['because', 'see src/x.ts:12', 'src/x.ts:0', 'src/:3', '/abs/x.ts:1', '../x.ts:1', 'src/x.ts:', 'test/', 'fixed.', '']) {
    assert.deepEqual(validateFindings(refuted(evidence)).errors, ['evidence:C1'], JSON.stringify(evidence));
  }
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['dispositions-backed'];
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: refuted('because') })).reasons, ['refuted-without-evidence:C1']);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: refuted('src/x.ts:12') })).reasons, []);
});

test('C23: override bytes that are unreadable or not a JSON object deny policy-override-invalid, not a widening', () => {
  for (const bytes of ['', '{', 'null', '[]', '"loop"', '7']) {
    const loaded = loadPolicy(baseBytes, bytes);
    assert.deepEqual(loaded.reasons, ['policy-override-invalid'], JSON.stringify(bytes));
    assert.equal(loaded.policy, null);
  }
  assert.ok(JSON.parse(baseBytes).denyReasons.includes('policy-override-invalid'));
  assert.deepEqual(loadPolicy(baseBytes, '{"merge":{}}').reasons, ['policy-override-widens:merge']);
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
  const findings: any = { ...review(), converged: [{ id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' }] };
  assert.ok(evaluate(policy, 'feature', 'gate-b', facts({ findings, dispositions: { ancestors: {}, decisions: [null] } })).reasons.includes('accepted-without-user-decision:C1'));
});

// Run the real assertions against scratch source copies. Each regression must yield an
// assertion failure, not a syntax/load failure. No tracked source or git state is changed.
const mutations: any = [
  { name: 'wip widening', from: 'value[limit] > base.loop[limit]', to: 'false', pattern: 'policy fixture: wip widening' },
  { name: 'stale parent review', from: 'findings.reviewedHead !== head', to: 'false', pattern: 'predicate fixture: review on parent' },
  { name: 'all predicates and declared order', from: 'for (const predicate of gate.predicates) {', to: 'for (const predicate of [...gate.predicates].reverse()) {', pattern: 'all predicates run and preserve declared reason order' },
  { name: 'FAIL then PASS', from: "run.verdict === 'FAIL' && runs.slice(i + 1).some((later: any) => later.verdict === 'PASS')", to: 'false', pattern: 'predicate fixture: FAIL then PASS remains flaky' },
  { name: 'INCONCLUSIVE', from: "runs[runs.length - 1].verdict !== 'PASS'", to: 'false', pattern: 'predicate fixture: inconclusive verification' },
  { name: 'seat minimum', from: 'seats.length < (gate.minSeats || 0)', to: 'false', pattern: 'predicate fixture: too few seats' },
  { name: 'person-only acceptance', from: "if (finding.status === 'user-accepted') reasons.push", to: 'if (false) reasons.push', pattern: 'C5: autopilot gate-b denies' },
  { name: 'evidence locator in validation', module: 'findings', from: "finding.status === 'refuted' && !evidenceLocator(finding.evidence)) errors", to: "finding.status === 'refuted' && !nonempty(finding.evidence)) errors", pattern: 'C21: refutation evidence' },
  { name: 'evidence locator at dispositions', from: "!evidenceLocator(finding.evidence)) reasons", to: '!nonempty(finding.evidence)) reasons', pattern: 'C21: refutation evidence' },
  { name: 'invalid override label', from: "denied('policy-override-invalid')", to: "denied('policy-override-widens:override')", pattern: 'C23: override bytes' },
  { name: 'unreadable plan-verification fact', from: "requireFact('plan-verification-block', 'protected-path')", to: 'true', pattern: 'C6: plan-verification-absent passes only' },
  { name: 'user-channel backing', from: "finding.status === 'user-accepted' && !decisions.some", to: 'false && !decisions.some', pattern: 'predicate fixture: agent acceptance' },
  { name: 'fixed ancestry', from: "finding.status === 'fixed' && backing?.ancestors?.[finding.fixedIn] !== true", to: 'false', pattern: 'predicate fixture: fix outside ancestry' },
  { name: 'marker outside code', module: 'facts', from: "visible.startsWith('[NEEDS CLARIFICATION', i)", to: 'false', pattern: 'markers outside fences count' },
  { name: 'raw source digest', module: 'facts', from: 'sha256Digest(bytes === undefined ? JSON.stringify(value) : bytes)', to: "sha256Digest('')", pattern: 'gate-0 reads only its named artifact' },
  { name: 'unreadable source', module: 'facts', from: "unreadable.length ? `unreadable:${unreadable.join(',')}` : undefined", to: 'undefined', pattern: 'unreadable git facts never become' },
  { name: 'dependency merge integrity', module: 'facts', from: "integrity.offendingRowIds.includes(id) ? 'not-started' : statuses.rowStatus[id]", to: 'statuses.rowStatus[id]', pattern: 'needs use first-parent merge integrity' },
  { name: 'readability changes digest', module: 'facts', from: 'unreadable ? sha256Digest(JSON.stringify({ unreadable, contentDigest })) : contentDigest', to: 'contentDigest', pattern: 'unreadable empty artifacts have a different input digest' },
  { name: 'verification schema', from: 'runs.some((run: any) => run.schema !== 1)', to: 'false', pattern: 'verification ignores dirty, stale-head' },
  { name: 'sameFamily option', from: "sameFamily: get('review-settings')?.sameFamily === 'refuse' ? 'refuse' : 'warn',", to: '', pattern: 'D.3: gate-b findings-valid applies' },
  { name: 'preset option', from: "preset: reviewPreset(get('review-settings')),", to: '', pattern: 'C-2: gate-b findings-valid checks the recorded protocol' },
  { name: 'authors option', from: "authors: get('authoring-identities'),", to: '', pattern: 'D.4: gate-b findings-valid applies the authoring-identities fact' },
  { name: 'preset floor', from: "|| protocolLooserThanPreset(findings.protocol, get('review-settings')?.preset)", to: '', pattern: 'C-2: gate-b findings-valid checks the recorded protocol' },
  { name: 'artifact layout precedence', module: 'facts', from: "['intention/requirement.md', 'requirement.md']", to: "['requirement.md', 'intention/requirement.md']", pattern: 'artifact lookup follows' },
];
for (const fixture of require('../fixtures/roadmap/gates/cases.json')) {
  if (mutations.some((m: any) => m.name === `predicate ${fixture.predicate}`)) continue;
  mutations.push({ name: `predicate ${fixture.predicate}`, from: 'for (const predicate of gate.predicates) {',
    to: `for (const predicate of gate.predicates.filter((entry: string) => entry !== ${JSON.stringify(fixture.predicate)})) {`,
    pattern: `predicate fixture: ${fixture.name}` });
}
for (const mutation of mutations) test(`scratch negative control: ${mutation.name}`, (t) => {
  const scratch = tempDir(t, 'doflow-roadmap-gate-control-');
  const targetName = mutation.module || 'gates';
  // Since 095 the findings validator lives in src/runtime/review/findings.ts; gates.ts imports it,
  // so its control mutates that module and runs the gates tests through a scratch gates.ts.
  const viaGates = targetName === 'findings';
  const gatesModule = path.join(__dirname, '../../src/runtime/roadmap/gates.ts');
  const originalModule = viaGates ? path.join(__dirname, '../../src/runtime/review/findings.ts')
    : path.join(__dirname, `../../src/runtime/roadmap/${targetName}.ts`);
  const originalTest = path.join(__dirname, `roadmap-${viaGates ? 'gates' : targetName}.test.ts`);
  const targetModule = path.join(scratch, `${targetName}.ts`);
  const targetTest = path.join(scratch, 'control.test.ts');
  const absolutize = (source: any, directory: any, substitute?: any, replacement: any = targetModule) => source.replace(/require\('([.][.]?\/[^']+)'\)/g, (_match: any, specifier: any) => {
    const absolute = path.resolve(directory, specifier);
    return `require(${JSON.stringify(absolute === substitute ? replacement : absolute)})`;
  });
  const source = fs.readFileSync(originalModule, 'utf8');
  assert.equal(source.split(mutation.from).length, 2, 'mutation must replace exactly one known behavior');
  fs.writeFileSync(targetModule, absolutize(source.replace(mutation.from, mutation.to), path.dirname(originalModule)));
  let tested: any = { module: originalModule, copy: targetModule };
  if (viaGates) {
    const scratchGates = path.join(scratch, 'gates.ts');
    fs.writeFileSync(scratchGates, absolutize(fs.readFileSync(gatesModule, 'utf8'), path.dirname(gatesModule), originalModule));
    tested = { module: gatesModule, copy: scratchGates };
  }
  fs.writeFileSync(targetTest, absolutize(fs.readFileSync(originalTest, 'utf8'), __dirname, tested.module, tested.copy)
    .replaceAll('__dirname', JSON.stringify(__dirname)));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.pattern}`, targetTest], {
    encoding: 'utf8', env, timeout: 15000 });
  assert.equal(run.status, 1, `${mutation.name} must turn its real test red: ${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout + run.stderr, /ERR_ASSERTION/, 'negative control must reach the assertion');
  t.diagnostic(`scratch ${mutation.name}: original assertion rejected regression`);
});

test('C6: the shipped gate-a and gate-b carry plan-verification-absent right after protected-paths', () => {
  const policy = JSON.parse(baseBytes);
  for (const gate of ['gate-a', 'gate-b']) {
    const predicates = policy.classes.feature[gate].predicates;
    assert.equal(predicates.indexOf('plan-verification-absent'), predicates.indexOf('protected-paths') + 1, gate);
  }
  assert.equal(policy.classes.feature['gate-0'].predicates.includes('plan-verification-absent'), false);
});

test('D.3: gate-b findings-valid applies the review-settings fact (sameFamily refuse errors, warn and absent do not, unreadable fails closed)', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  const record: any = { ...review(), author: { agent: 'core-implementer', session: 's1', family: 'claude' },
    seats: [{ id: 'one', findings: [], agent: 'reviewer', session: 's2', family: 'claude' }, { id: 'two', findings: [], agent: 'reviewer', session: 's3', family: 'gpt' }] };
  const reasons = (extra: any) => evaluate(policy, 'feature', 'gate-b', facts({ findings: record, ...extra })).reasons;
  assert.deepEqual(reasons({ 'review-settings': { sameFamily: 'refuse' } }), ['findings-invalid']);
  assert.deepEqual(reasons({ 'review-settings': { sameFamily: 'warn' } }), []);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: record })).reasons, [], 'a fact set gathered without the setting keeps its verdict');
  const unreadable = facts({ findings: record, 'review-settings': { sameFamily: 'warn' } }).map((f) => f.name === 'review-settings' ? { ...f, unreadable: 'settings-unavailable' } : f);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', unreadable).reasons, ['findings-invalid:fixture:review-settings']);
  // INV-1 stays an error under either value.
  const own: any = { ...record, seats: [{ id: 'one', findings: [], agent: 'core-implementer', session: 's1', family: 'gpt' }, record.seats[1]] };
  for (const sameFamily of ['warn', 'refuse']) {
    assert.deepEqual(reasons({ findings: own, 'review-settings': { sameFamily } }), ['findings-invalid']);
  }
});

test('D.4: gate-b findings-valid applies the authoring-identities fact (INV-8 equal pair denies findings-invalid, independent passes, absent passes, unreadable fails closed)', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  const record: any = {
    ...review(),
    author: { agent: 'core-implementer', session: 's1', family: 'claude' },
    seats: [
      { id: 'one', findings: [], agent: 'reviewer', session: 's2', family: 'claude', harness: 'codex', model: 'gpt-4o' },
      { id: 'two', findings: [], agent: 'reviewer', session: 's3', family: 'gpt', harness: 'claude', model: 'sonnet' },
    ],
  };
  const authors = [
    { kind: 'subagent', harness: 'codex', model: 'gpt-4o', channel: 'observed' },
  ];
  const reasons = (extra: any) => evaluate(policy, 'feature', 'gate-b', facts({ findings: record, ...extra })).reasons;

  // INV-8 equal pair denies with findings-invalid
  assert.deepEqual(reasons({ 'authoring-identities': authors }), ['findings-invalid']);

  // Independent author passes
  const independentAuthors = [
    { kind: 'subagent', harness: 'antigravity', model: 'flash', channel: 'observed' },
  ];
  assert.deepEqual(reasons({ 'authoring-identities': independentAuthors }), []);

  // Absent authoring-identities fact (pre-120 fact set) passes
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ findings: record })).reasons, [], 'a fact set gathered without authoring-identities keeps its verdict');

  // Unreadable authoring-identities fact denies findings-invalid
  const unreadable = facts({ findings: record, 'authoring-identities': authors }).map((f) => f.name === 'authoring-identities' ? { ...f, unreadable: 'dispatch-unreadable' } : f);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', unreadable).reasons, ['findings-invalid:fixture:authoring-identities']);
});

test('C-2: gate-b findings-valid checks the recorded protocol against its preset and against the review.preset setting', () => {
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  const DIGEST = 'f'.repeat(64);
  const deep: any = { ...review(), protocol: { id: 'review-deep', digest: DIGEST }, rounds: 2 };
  const single: any = { ...review(), protocol: { id: 'review-single', digest: DIGEST }, rounds: 1 };
  const reasons = (record: any, settings?: any) => evaluate(policy, 'feature', 'gate-b', facts({ findings: record, ...(settings ? { 'review-settings': settings } : {}) })).reasons;
  assert.deepEqual(reasons(deep), []);
  assert.deepEqual(reasons({ ...deep, rounds: 1 }), ['findings-invalid'], 'deep recorded with one round');
  assert.deepEqual(reasons({ ...deep, seats: deep.seats.slice(0, 1) }), ['findings-invalid'], 'deep recorded with one seat');
  // The project's non-auto review.preset is a floor: a looser recorded protocol is invalid, an equal or stricter one passes.
  assert.deepEqual(reasons(single, { sameFamily: 'warn', preset: 'review-deep' }), ['findings-invalid']);
  assert.deepEqual(reasons(deep, { sameFamily: 'warn', preset: 'review-deep' }), []);
  assert.deepEqual(reasons(deep, { sameFamily: 'warn', preset: 'review-single' }), []);
  assert.deepEqual(reasons(single, { sameFamily: 'warn', preset: 'review-single' }), []);
  assert.deepEqual(reasons(single, { sameFamily: 'warn', preset: 'auto' }), [], 'auto resolves from the diff, which gate-b does not read');
  assert.deepEqual(reasons(single, { sameFamily: 'warn' }), [], 'a fact without a preset (older gather) keeps its verdict');
  // Closure fix (agent-docs/doflow/119-review-protocol/closure-fix-brief.md, item 1): omitting `protocol` must not skip the
  // check. A non-auto review.preset makes a record without one invalid (it was pinned valid before: the stale side).
  assert.deepEqual(reasons({ ...review(), rounds: 1 }, { sameFamily: 'warn', preset: 'review-deep' }), ['findings-invalid'], 'project review-deep, no protocol, rounds 1');
  // maint-thin: review-single is now the shipped default and the loosest core preset, so it holds a record to nothing a
  // missing protocol could hide (as auto did before); any stricter preset still needs one (review-deep above).
  assert.deepEqual(reasons(review(), { sameFamily: 'warn', preset: 'review-single' }), [], 'the loosest preset needs no protocol');
  assert.deepEqual(reasons({ ...review(), rounds: 1 }, { sameFamily: 'warn', preset: 'auto' }), [], 'auto: a record without protocol stays valid');
  assert.deepEqual(reasons(review(), { sameFamily: 'warn' }), [], 'a fact without a preset: a record without protocol stays valid');
});

test('C20: one verify-record rule serves gate-b and the post-merge check (task, head, clean, schema, flaky)', () => {
  const run = (extra?: any) => ({ schema: 1, taskId: '113-goal-order', head: HEAD, clean: true, verdict: 'PASS', ...extra });
  assert.deepEqual(verifyRecordReasons([run()], HEAD, '113-goal-order'), []);
  assert.deepEqual(verifyRecordReasons([run({ taskId: '999-other' })], HEAD, '113-goal-order'), ['verify-missing'], 'another task\'s PASS is not this row\'s');
  assert.deepEqual(verifyRecordReasons([run({ clean: false }), run({ head: PARENT })], HEAD, '113-goal-order'), ['verify-missing']);
  assert.deepEqual(verifyRecordReasons([run({ verdict: 'FAIL' }), run()], HEAD, '113-goal-order'), ['verify-flaky']);
  assert.deepEqual(verifyRecordReasons([run(), run({ verdict: 'FAIL' })], HEAD, '113-goal-order'), ['verify-not-pass']);
  assert.deepEqual(verifyRecordReasons([run({ schema: 2 })], HEAD, '113-goal-order'), ['verify-not-pass']);
  assert.deepEqual(verifyRecordReasons([null, 'x', run()], HEAD, '113-goal-order'), []);
  assert.deepEqual(verifyRecordReasons([run()], 'not-a-head', '113-goal-order'), ['verify-missing']);
  // gate-b's predicate gives the same answer as the shared rule.
  const policy = loadPolicy(baseBytes).policy;
  policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  for (const records of [[run()], [run({ taskId: '999-other' })], [run({ verdict: 'FAIL' }), run()]]) {
    assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts({ verification: records })).reasons, verifyRecordReasons(records, HEAD, '113-goal-order'));
  }
});
