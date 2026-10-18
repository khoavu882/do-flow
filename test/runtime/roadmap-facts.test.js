'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { gatherGateFacts, countMarkers, sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const { loadPolicy, evaluate } = require('../../src/runtime/roadmap/gates.ts');
const baseBytes = fs.readFileSync(path.join(__dirname, '../../core/registry/gates.json'));
const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const row = { id: '113', slug: '113-goal-order', class: 'feature', writeSet: ['src/x.ts'], needs: [], requires: [] };
const plan = '## Tasks\n- [ ] A.1 Build — owner: core-implementer; files: src/x.ts\n';
const review = { schema: 1, row: '113', slug: '113-goal-order', reviewedHead: HEAD,
  seats: [{ id: 'one', findings: [] }, { id: 'two', findings: [] }], converged: [] };
function setup(t) {
  const root = tempDir(t, 'doflow-roadmap-gate-facts-');
  const artifactRoot = path.join(root, 'agent-docs/doflow', row.slug);
  const write = (relative, text) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  write(`agent-docs/doflow/${row.slug}/intention/requirement.md`, 'Ready.\n');
  write(`agent-docs/doflow/${row.slug}/design/design.md`, 'Design.\n');
  write(`agent-docs/doflow/${row.slug}/plan.md`, plan);
  write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify(review));
  write(`.doflow/state/verification/runs/${row.slug}.jsonl`, `${JSON.stringify({ schema: 1, taskId: row.slug, head: HEAD, clean: true, verdict: 'PASS' })}\n`);
  const calls = [];
  const options = { root, artifactRoot, row, rows: [row], policy: loadPolicy(baseBytes).policy,
    developHead: PARENT, featureHead: HEAD,
    gitFacts: { developHead: PARENT, merges: [], branches: [], claims: [], unreadable: [] },
    execFileSync: (binary, vector) => {
      assert.equal(binary, 'git'); calls.push(vector);
      if (vector[0] === 'diff') return '';
      if (vector[0] === 'show') return '{}';
      if (vector[0] === 'merge-base') return '';
      throw new Error(`unexpected git read ${vector.join(' ')}`);
    } };
  return { root, artifactRoot, write, calls, options, gather: (gateId, changes = {}) => gatherGateFacts({ ...options, gateId, ...changes }) };
}

test('markers outside fences count and the same markers in code do not', () => {
  const marker = '[NEEDS CLARIFICATION: x]';
  assert.equal(countMarkers(marker), 1);
  assert.equal(countMarkers(`\`\`\`md\n${marker}\n\`\`\`\n`), 0);
  assert.equal(countMarkers(`~~~md\n${marker}\n~~~\n`), 0);
  assert.equal(countMarkers(`\`${marker}\``), 0);
  assert.equal(countMarkers(`\`\`a\` ${marker}\`\``), 0);
  assert.equal(countMarkers(`\`a\n${marker}\n\``), 0);
  assert.equal(countMarkers(`\`unclosed ${marker}`), 1);
  assert.equal(countMarkers(`\`\`\`\`\n\`\`\`\n${marker}\n\`\`\`\`\n${marker}`), 1);
  assert.equal(countMarkers(`${marker}\n\`\`\`\n${marker}\n\`\`\`\n${marker}`), 2);
});

test('gate-0 reads only its named artifact; every fact has a locator and byte digest', (t) => {
  const env = setup(t);
  const result = env.gather('gate-0');
  assert.deepEqual(result.map((f) => f.name), ['row', 'markers:requirement']);
  assert.deepEqual(env.calls, []);
  const marker = result.find((f) => f.name === 'markers:requirement');
  assert.equal(marker.value, 0);
  assert.equal(marker.sha256, sha256Digest('Ready.\n'));
  assert.match(marker.locator, /intention\/requirement\.md$/);
  assert.ok(result.every((f) => f.locator && /^sha256:[a-f0-9]{64}$/.test(f.sha256)));
  assert.equal(JSON.stringify(result), JSON.stringify(env.gather('gate-0')));
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-0', result).decision, 'pass');
});

test('artifact lookup follows the established intention-first and flat fallback layouts', (t) => {
  const env = setup(t);
  env.write(`agent-docs/doflow/${row.slug}/requirement.md`, 'No marker here.');
  const nested = env.write(`agent-docs/doflow/${row.slug}/intention/requirement.md`, '[NEEDS CLARIFICATION: nested]');
  assert.deepEqual(evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0')).reasons, ['unresolved-clarifications']);
  fs.unlinkSync(nested);
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0')).decision, 'pass');
});

test('gate-a parses the real task graph and guards plan and seed paths', (t) => {
  const env = setup(t);
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-a', env.gather('gate-a')).decision, 'pass');
  env.write(`agent-docs/doflow/${row.slug}/plan.md`, '## Tasks\n- [ ] A.1 X — files: src/x.ts; depends-on: A.2\n- [ ] A.2 Y — files: src/y.ts; depends-on: A.1\n');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', env.gather('gate-a')).reasons.includes('plan-unparsable'));
  env.write(`agent-docs/doflow/${row.slug}/plan.md`, '## Tasks\n- [ ] A.1 X — files: core/registry/gates.json\n');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', env.gather('gate-a')).reasons.includes('protected-path:core/registry/gates.json'));
});

test('requires-reachable uses CapabilityRouter with filesystem binary lookup and never spawns', (t) => {
  const env = setup(t);
  const binary = env.write('bin/found-tool', 'unused'); fs.chmodSync(binary, 0o755);
  env.write('core/registry/capabilities.json', JSON.stringify({ capabilities: {
    'test.found': { providers: [{ id: 'found', kind: 'native', binary: 'found-tool' }] },
    'test.absent': { providers: [{ id: 'absent', kind: 'native', binary: 'absent-tool' }] } } }));
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['requires-reachable'];
  const input = env.gather('gate-a', { policy, registryRoot: env.root, env: { PATH: path.dirname(binary) },
    row: { ...row, requires: ['test.found', 'test.absent', 'test.unknown'] },
    execFileSync: () => { assert.fail('capability resolution must not spawn'); } });
  assert.deepEqual(input.find((f) => f.name === 'requires').value.map((x) => [x.id, x.declared, x.reachable]),
    [['test.found', true, true], ['test.absent', true, false], ['test.unknown', false, false]]);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-a', input).reasons, ['capability-unreachable:test.absent', 'prerequisite-no-source:test.unknown']);
});

test('unreadable git facts never become an empty merged dependency answer', (t) => {
  const env = setup(t);
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['needs-merged'];
  const input = env.gather('gate-a', { policy, gitFacts: { merges: [], branches: [], claims: [], unreadable: ['merges'] } });
  const denied = evaluate(policy, 'feature', 'gate-a', input);
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.reasons.some((r) => r.startsWith('need-unmerged:') && r.includes('merges')));
});

test('needs use first-parent merge integrity rather than accepting duplicate evidence', (t) => {
  const env = setup(t);
  const need = { id: '096', slug: '096-trace-store', class: 'feature', needs: [] };
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['needs-merged'];
  const merge = { sha: 'c'.repeat(40), parents: [HEAD, PARENT], rowTrailer: '096' };
  const options = { policy, row: { ...row, needs: ['096'] }, rows: [row, need],
    gitFacts: { developHead: PARENT, merges: [merge], branches: [], claims: [], unreadable: [] } };
  assert.equal(evaluate(policy, 'feature', 'gate-a', env.gather('gate-a', options)).decision, 'pass');
  options.gitFacts.merges.push({ ...merge, sha: 'd'.repeat(40) });
  assert.deepEqual(evaluate(policy, 'feature', 'gate-a', env.gather('gate-a', options)).reasons, ['need-unmerged:096']);
});

test('gate-b reads head-bound verification and disposition ancestry and register channels', (t) => {
  const env = setup(t);
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify({ ...review, converged: [
    { id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'fixed', fixedIn: PARENT },
    { id: 'C2', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' } ] }));
  env.write(`agent-docs/doflow/${row.slug}/decisions/register.json`, JSON.stringify({ version: 1, nextId: 2, decisions: [{ id: 'DEC-001', channel: 'question' }] }));
  const input = env.gather('gate-b');
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', input).decision, 'pass');
  assert.ok(env.calls.some((v) => v[0] === 'merge-base' && v[1] === '--is-ancestor' && v[2] === PARENT && v[3] === HEAD));
  const stale = env.gather('gate-b', { featureHead: PARENT });
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', stale).reasons.includes('review-stale-head'));
});

test('unreadable and malformed inputs deny with named locators; missing artifact never passes', (t) => {
  const env = setup(t);
  const requirement = path.join(env.artifactRoot, 'intention/requirement.md');
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (file, ...rest) => { if (file === requirement) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return fs.readFileSync(file, ...rest); };
  const input = env.gather('gate-0', { fsImpl });
  assert.deepEqual(evaluate(env.options.policy, 'feature', 'gate-0', input).reasons, [`unresolved-clarifications:${requirement}`]);
  fs.unlinkSync(requirement);
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0')).decision, 'deny');
  env.write(`.doflow/state/verification/runs/${row.slug}.jsonl`, '{broken\n');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b')).reasons.some((r) => r.startsWith('verify-missing:')));
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, '{broken');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b')).reasons.includes('findings-invalid'));
});

test('git read errors fail closed for diff, packages, feature head and ancestry', (t) => {
  const env = setup(t);
  const broken = () => { throw new Error('git unavailable'); };
  const result = evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b', { execFileSync: broken }));
  assert.ok(result.reasons.some((r) => r.startsWith('protected-path:')));
  const noHead = env.gather('gate-b', { featureHead: undefined, execFileSync: broken });
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', noHead).decision, 'deny');
});

test('unreadable empty artifacts have a different input digest from readable empty artifacts', (t) => {
  const env = setup(t);
  const file = env.write(`agent-docs/doflow/${row.slug}/intention/requirement.md`, '');
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (candidate, ...rest) => { if (candidate === file) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return fs.readFileSync(candidate, ...rest); };
  const denied = evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0', { fsImpl }));
  const passed = evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0'));
  assert.equal(denied.decision, 'deny');
  assert.equal(passed.decision, 'pass');
  assert.notEqual(denied.inputsDigest, passed.inputsDigest, 'a held row must retry when readability changes');
});

test('diff parser preserves added guard files and both rename paths, including whitespace', (t) => {
  const env = setup(t);
  const input = env.gather('gate-a', { execFileSync: (binary, vector) => vector[0] === 'diff'
    ? 'A\0test/guards/new test.js\0R100\0test/guards/old test.js\0test/other.js\0' : '{}' });
  assert.deepEqual(input.find((f) => f.name === 'protected-paths').value.changes, [
    { status: 'A', path: 'test/guards/new test.js' }, { status: 'R100', oldPath: 'test/guards/old test.js', path: 'test/other.js' } ]);
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', input).reasons.includes('protected-path:test/guards/old test.js'));
});
