'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { gatherGateFacts, gatherGitFacts, countMarkers, sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const { loadPolicy, evaluate } = require('../../src/runtime/roadmap/gates.ts');
const baseBytes = fs.readFileSync(path.join(__dirname, '../../core/registry/gates.json'));
const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const row: any = { id: '113', slug: '113-goal-order', class: 'feature', writeSet: ['src/x.ts'], needs: [], requires: [] };
const plan = '## Tasks\n- [ ] A.1 Build — owner: core-implementer; files: src/x.ts\n';
const review: any = { schema: 1, row: '113', slug: '113-goal-order', reviewedHead: HEAD,
  seats: [{ id: 'one', findings: [] }, { id: 'two', findings: [] }], converged: [] };
function setup(t: any): any {
  const root = tempDir(t, 'doflow-roadmap-gate-facts-');
  const artifactRoot = path.join(root, 'agent-docs/doflow', row.slug);
  const write = (relative: any, text: any) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  write(`agent-docs/doflow/${row.slug}/intention/requirement.md`, 'Ready.\n');
  write(`agent-docs/doflow/${row.slug}/design/design.md`, 'Design.\n');
  write(`agent-docs/doflow/${row.slug}/plan.md`, plan);
  write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify(review));
  write(`.doflow/state/verification/runs/${row.slug}.jsonl`, `${JSON.stringify({ schema: 1, taskId: row.slug, head: HEAD, clean: true, verdict: 'PASS' })}\n`);
  const calls: any = [];
  const options: any = { root, artifactRoot, row, rows: [row], policy: loadPolicy(baseBytes).policy,
    developHead: PARENT, featureHead: HEAD,
    // The gate-b review-settings fact reads the user settings layer: pin it to a scratch HOME, never the developer's.
    env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg') },
    gitFacts: { developHead: PARENT, merges: [], branches: [], claims: [], unreadable: [] },
    execFileSync: (binary: any, vector: any) => {
      assert.equal(binary, 'git'); calls.push(vector);
      if (vector[0] === 'diff') return '';
      if (vector[0] === 'show') return '{}';
      if (vector[0] === 'merge-base') return '';
      throw new Error(`unexpected git read ${vector.join(' ')}`);
    } };
  return { root, artifactRoot, write, calls, options, gather: (gateId: any, changes: any = {}) => gatherGateFacts({ ...options, gateId, ...changes }) };
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
  assert.deepEqual(result.map((f: any) => f.name), ['row', 'markers:requirement']);
  assert.deepEqual(env.calls, []);
  const marker = result.find((f: any) => f.name === 'markers:requirement');
  assert.equal(marker.value, 0);
  assert.equal(marker.sha256, sha256Digest('Ready.\n'));
  assert.match(marker.locator, /intention\/requirement\.md$/);
  assert.ok(result.every((f: any) => f.locator && /^sha256:[a-f0-9]{64}$/.test(f.sha256)));
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
  assert.deepEqual(input.find((f: any) => f.name === 'requires').value.map((x: any) => [x.id, x.declared, x.reachable]),
    [['test.found', true, true], ['test.absent', true, false], ['test.unknown', false, false]]);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-a', input).reasons, ['capability-unreachable:test.absent', 'prerequisite-no-source:test.unknown']);
});

test('a hard prerequisite is reachable only on a HEALTHY primary provider; a grep fallback denies', (t) => {
  const env = setup(t);
  const rg = env.write('bin/rg', 'unused'); fs.chmodSync(rg, 0o755);
  env.write('core/registry/capabilities.json', JSON.stringify({ capabilities: {
    'code.semantic-search': { providers: [{ id: 'semble.search', kind: 'cli', binary: 'semble' }, { id: 'native.rg', kind: 'native', binary: 'rg' }] } } }));
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['requires-reachable'];
  const input = env.gather('gate-a', { policy, registryRoot: env.root, env: { PATH: path.dirname(rg) },
    row: { ...row, requires: ['code.semantic-search'] }, execFileSync: () => { assert.fail('capability resolution must not spawn'); } });
  assert.deepEqual(input.find((f: any) => f.name === 'requires').value, [{ id: 'code.semantic-search', declared: true, reachable: false, provider: 'native.rg' }]);
  assert.deepEqual(evaluate(policy, 'feature', 'gate-a', input).reasons, ['capability-unreachable:code.semantic-search']);
});

test('unreadable git facts never become an empty merged dependency answer', (t) => {
  const env = setup(t);
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['needs-merged'];
  const input = env.gather('gate-a', { policy, gitFacts: { merges: [], branches: [], claims: [], unreadable: ['merges'] } });
  const denied = evaluate(policy, 'feature', 'gate-a', input);
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.reasons.some((r: any) => r.startsWith('need-unmerged:') && r.includes('merges')));
});

test('needs use first-parent merge integrity rather than accepting duplicate evidence', (t) => {
  const env = setup(t);
  const need: any = { id: '096', slug: '096-trace-store', class: 'feature', needs: [] };
  const policy = structuredClone(env.options.policy); policy.classes.feature['gate-a'].predicates = ['needs-merged'];
  const merge: any = { sha: 'c'.repeat(40), parents: [HEAD, PARENT], rowTrailer: '096' };
  const options: any = { policy, row: { ...row, needs: ['096'] }, rows: [row, need],
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
  // The question-channel entry backs C2 (no accepted-without-user-decision), but policy never accepts it (C5).
  assert.deepEqual(evaluate(env.options.policy, 'feature', 'gate-b', input).reasons, ['user-accepted-needs-person:C2']);
  assert.ok(env.calls.some((v: any) => v[0] === 'merge-base' && v[1] === '--is-ancestor' && v[2] === PARENT && v[3] === HEAD));
  const stale = env.gather('gate-b', { featureHead: PARENT });
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', stale).reasons.includes('review-stale-head'));
});

test('D.3: gate-b gathers the project review.sameFamily as a review-settings fact; the dispositions schemaValid follows it', (t) => {
  const env = setup(t);
  const sandbox: any = { ...process.env, HOME: path.join(env.root, 'home'), XDG_CONFIG_HOME: path.join(env.root, 'xdg') };
  const settingsFact = (gathered: any) => gathered.find((f: any) => f.name === 'review-settings');
  const withFamilies: any = { ...review, author: { agent: 'core-implementer', session: 's1', family: 'claude' },
    seats: [{ id: 'one', findings: [], agent: 'reviewer', session: 's2', family: 'claude' }, { id: 'two', findings: [] }],
    converged: [{ id: 'C1', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'fixed', fixedIn: PARENT }] };
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify(withFamilies));
  const absent = env.gather('gate-b', { env: sandbox });
  assert.deepEqual(settingsFact(absent).value, { sameFamily: 'warn', preset: 'review-single' }, 'maint-thin: the shipped default');
  assert.equal(settingsFact(absent).unreadable, undefined);
  assert.equal(absent.find((f: any) => f.name === 'dispositions').value.schemaValid, true);
  env.write('.doflow/settings.json', JSON.stringify({ schema: 1, 'review.sameFamily': 'refuse' }));
  const refuse = env.gather('gate-b', { env: sandbox });
  assert.deepEqual(settingsFact(refuse).value, { sameFamily: 'refuse', preset: 'review-single' });
  assert.equal(refuse.find((f: any) => f.name === 'dispositions').value.schemaValid, false);
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', refuse).reasons.includes('findings-invalid'));
  assert.equal(env.gather('gate-0', { env: sandbox }).some((f: any) => f.name === 'review-settings'), false, 'read only when a findings predicate is in use');
});

test('D.4: gate-b gathers the authoring-identities fact; dispositions schemaValid follows it', (t) => {
  const env = setup(t);
  const sandbox: any = { ...process.env, HOME: path.join(env.root, 'home'), XDG_CONFIG_HOME: path.join(env.root, 'xdg') };
  const authorsFact = (gathered: any) => gathered.find((f: any) => f.name === 'authoring-identities');

  // When no dispatch store exists, authoring-identities is empty array and readable
  const empty = env.gather('gate-b', { env: sandbox });
  assert.deepEqual(authorsFact(empty).value, []);
  assert.equal(authorsFact(empty).unreadable, undefined);

  // When dispatch store has dispatches, authoring-identities fact gathers them
  const { storeFileFor } = require('../../src/runtime/dispatch/store.ts');
  const storeFile = storeFileFor(env.root, row.slug);
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    revision: 1,
    slug: row.slug,
    run: { runId: 'p-123456789012', state: 'running' },
    lease: null,
    drivers: [],
    spawnRequests: {},
    steps: [],
    dispatches: {
      'd-1': {
        dispatchId: 'd-1',
        seq: 0,
        mode: 'subagent',
        harness: 'codex',
        phase: 'collected',
        collectedAt: '2026-10-24T12:00:00.000Z',
        outcome: 'offered',
        model: {
          requested: 'o3-mini',
          served: 'o3-mini-2025-01-31',
          source: 'binding',
          tier: 'standard',
        },
      },
    },
  }));

  const gathered = env.gather('gate-b', { env: sandbox });
  assert.deepEqual(authorsFact(gathered).value, [
    { kind: 'subagent', harness: 'codex', model: 'o3-mini-2025-01-31', channel: 'observed' },
    { kind: 'subagent', harness: 'codex', model: 'o3-mini', channel: 'observed' },
  ]);
  assert.equal(authorsFact(gathered).unreadable, undefined);

  // When dispatch store is corrupted, authoring-identities fact is unreadable
  fs.writeFileSync(storeFile, 'not valid json');
  const corrupted = env.gather('gate-b', { env: sandbox });
  assert.equal(authorsFact(corrupted).unreadable, 'dispatch-unreadable');

  // Fact is not gathered for gate-0
  assert.equal(env.gather('gate-0', { env: sandbox }).some((f: any) => f.name === 'authoring-identities'), false, 'read only when a findings predicate is in use');
});

test('C-2: the review-settings fact also carries the project review.preset, which gate-b reads as a floor for the recorded protocol', (t) => {
  const env = setup(t);
  const sandbox: any = { ...process.env, HOME: path.join(env.root, 'home'), XDG_CONFIG_HOME: path.join(env.root, 'xdg') };
  const record: any = { ...review, protocol: { id: 'review-single', digest: 'f'.repeat(64) }, rounds: 1 };
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify(record));
  env.write('.doflow/settings.json', JSON.stringify({ schema: 1, 'review.preset': 'review-deep' }));
  const gathered = env.gather('gate-b', { env: sandbox });
  assert.deepEqual(gathered.find((f: any) => f.name === 'review-settings').value, { sameFamily: 'warn', preset: 'review-deep' });
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', gathered).reasons.includes('findings-invalid'));
  // A project may only narrow review.preset (it cannot loosen toward review-single), so a deep record meets the deep floor.
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify({ ...record, protocol: { id: 'review-deep', digest: 'f'.repeat(64) }, rounds: 2 }));
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b', { env: sandbox })).reasons.includes('findings-invalid'), false);
});

test('C-6: an invalid project review.* value or a malformed project settings file makes the review-settings fact unreadable (gate-b denies)', (t) => {
  const env = setup(t);
  const sandbox: any = { ...process.env, HOME: path.join(env.root, 'home'), XDG_CONFIG_HOME: path.join(env.root, 'xdg') };
  for (const text of ['{ "schema": 1, "review.sameFamily": "refuse", }', '{ "schema": 1, "review.preset": "bogus" }']) {
    const file = env.write('.doflow/settings.json', text);
    const gathered = env.gather('gate-b', { env: sandbox });
    const fact = gathered.find((f: any) => f.name === 'review-settings');
    assert.equal(fact.unreadable, 'settings-unavailable', text);
    assert.equal(fact.locator, file);
    assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', gathered).reasons.some((r: any) => r.startsWith('findings-invalid:')), text);
  }
  env.write('.doflow/settings.json', JSON.stringify({ schema: 1, 'review.preset': 'review-deep' }));
  assert.equal(env.gather('gate-b', { env: sandbox }).find((f: any) => f.name === 'review-settings').unreadable, undefined);
});

test('an unknown review.preset in the user file makes the review-settings fact unreadable (gate-b denies), never a silent auto', (t) => {
  const env = setup(t);
  const home = path.join(env.root, 'home');
  const xdg = path.join(env.root, 'xdg');
  const sandbox: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  const user = path.join(xdg, 'doflow', 'settings.json');
  fs.writeFileSync(user, JSON.stringify({ schema: 1, 'review.preset': 'bogus-9' }));
  const gathered = env.gather('gate-b', { env: sandbox });
  const fact = gathered.find((f: any) => f.name === 'review-settings');
  assert.equal(fact.unreadable, 'settings-unavailable');
  assert.equal(fact.locator, user);
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', gathered).reasons.some((r: any) => r.startsWith('findings-invalid:')));
  fs.writeFileSync(user, JSON.stringify({ schema: 1, 'review.preset': 'review-deep' }));
  assert.equal(env.gather('gate-b', { env: sandbox }).find((f: any) => f.name === 'review-settings').unreadable, undefined);
});

test('a register that does not exist yet is an empty decision list; a malformed one stays unreadable', (t) => {
  const env = setup(t);
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, JSON.stringify({ ...review, converged: [
    { id: 'C2', from: [], severity: 'blocker', locator: 'src/x.ts:1', status: 'user-accepted', decision: 'DEC-001' } ] }));
  const missing = env.gather('gate-b');
  assert.equal(missing.find((f: any) => f.name === 'dispositions').unreadable, undefined);
  assert.deepEqual(evaluate(env.options.policy, 'feature', 'gate-b', missing).reasons, ['accepted-without-user-decision:C2', 'user-accepted-needs-person:C2']);
  env.write(`agent-docs/doflow/${row.slug}/decisions/register.json`, '{broken');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b')).reasons.some((r: any) => r.startsWith('findings-invalid:')));
});

test('unreadable and malformed inputs deny with named locators; missing artifact never passes', (t) => {
  const env = setup(t);
  const requirement = path.join(env.artifactRoot, 'intention/requirement.md');
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (file: any, ...rest: any[]) => { if (file === requirement) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return fs.readFileSync(file, ...rest); };
  const input = env.gather('gate-0', { fsImpl });
  assert.deepEqual(evaluate(env.options.policy, 'feature', 'gate-0', input).reasons, [`unresolved-clarifications:${requirement}`]);
  fs.unlinkSync(requirement);
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0')).decision, 'deny');
  env.write(`.doflow/state/verification/runs/${row.slug}.jsonl`, '{broken\n');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b')).reasons.some((r: any) => r.startsWith('verify-missing:')));
  env.write(`agent-docs/doflow/${row.slug}/review/findings.json`, '{broken');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b')).reasons.includes('findings-invalid'));
});

test('git read errors fail closed for diff, packages, feature head and ancestry', (t) => {
  const env = setup(t);
  const broken = () => { throw new Error('git unavailable'); };
  const result = evaluate(env.options.policy, 'feature', 'gate-b', env.gather('gate-b', { execFileSync: broken }));
  assert.ok(result.reasons.some((r: any) => r.startsWith('protected-path:')));
  const noHead = env.gather('gate-b', { featureHead: undefined, execFileSync: broken });
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', noHead).decision, 'deny');
});

// The calling checkout may be develop itself: its HEAD is never the feature head.
function branchGit(env: any, { branchExists = true }: any = {}) {
  const branch = `refs/heads/feat/${row.slug}`;
  return (binary: any, vector: any) => {
    assert.equal(binary, 'git'); env.calls.push(vector);
    if (vector[0] === 'rev-parse') {
      const ref = vector[vector.length - 1];
      if (ref === 'HEAD') return `${PARENT}\n`;
      if (ref === branch && branchExists) return `${HEAD}\n`;
      throw new Error(`unknown ref ${ref}`);
    }
    if (vector[0] === 'diff') return vector[3] === `${PARENT}...${HEAD}` ? 'M\0core/registry/gates.json\0' : '';
    if (vector[0] === 'show') return '{}';
    if (vector[0] === 'merge-base') return '';
    throw new Error(`unexpected git read ${vector.join(' ')}`);
  };
}

test('the feature head comes from the feature branch, never from the calling checkout HEAD', (t) => {
  const env = setup(t);
  const input = env.gather('gate-a', { featureHead: undefined, execFileSync: branchGit(env) });
  assert.deepEqual(input.find((f: any) => f.name === 'heads').value, { developHead: PARENT, featureHead: HEAD });
  assert.ok(env.calls.some((v: any) => v[0] === 'rev-parse' && v.includes(`refs/heads/feat/${row.slug}`)));
  assert.ok(!env.calls.some((v: any) => v[0] === 'rev-parse' && v[v.length - 1] === 'HEAD'), 'HEAD is never consulted');
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', input).reasons.includes('protected-path:core/registry/gates.json'));
  const named = env.gather('gate-a', { featureHead: undefined, featureBranch: 'feat/other', execFileSync: (binary: any, vector: any) => {
    if (vector[0] === 'rev-parse') { assert.equal(vector[vector.length - 1], 'refs/heads/feat/other'); return `${HEAD}\n`; }
    return branchGit(env)(binary, vector);
  } });
  assert.equal(named.find((f: any) => f.name === 'heads').value.featureHead, HEAD);
});

test('a missing feature branch makes the heads fact unreadable and the gate denies', (t) => {
  const env = setup(t);
  const absent = env.gather('gate-b', { featureHead: undefined, execFileSync: branchGit(env, { branchExists: false }) });
  const heads = absent.find((f: any) => f.name === 'heads');
  assert.equal(heads.unreadable, 'no-feature-branch');
  assert.equal(heads.value.featureHead, null);
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', absent).decision, 'deny');
  const noRow = env.gather('gate-b', { featureHead: undefined, row: { ...row, slug: undefined }, execFileSync: branchGit(env) });
  assert.equal(noRow.find((f: any) => f.name === 'heads').unreadable, 'no-feature-branch');
  assert.equal(evaluate(env.options.policy, 'feature', 'gate-b', noRow).decision, 'deny');
});

test('unreadable empty artifacts have a different input digest from readable empty artifacts', (t) => {
  const env = setup(t);
  const file = env.write(`agent-docs/doflow/${row.slug}/intention/requirement.md`, '');
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (candidate: any, ...rest: any[]) => { if (candidate === file) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return fs.readFileSync(candidate, ...rest); };
  const denied = evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0', { fsImpl }));
  const passed = evaluate(env.options.policy, 'feature', 'gate-0', env.gather('gate-0'));
  assert.equal(denied.decision, 'deny');
  assert.equal(passed.decision, 'pass');
  assert.notEqual(denied.inputsDigest, passed.inputsDigest, 'a held row must retry when readability changes');
});

test('diff parser preserves added guard files and both rename paths, including whitespace', (t) => {
  const env = setup(t);
  const input = env.gather('gate-a', { execFileSync: (binary: any, vector: any) => vector[0] === 'diff'
    ? 'A\0test/guards/new test.js\0R100\0test/guards/old test.js\0test/other.js\0' : '{}' });
  assert.deepEqual(input.find((f: any) => f.name === 'protected-paths').value.changes, [
    { status: 'A', path: 'test/guards/new test.js' }, { status: 'R100', oldPath: 'test/guards/old test.js', path: 'test/other.js' } ]);
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', input).reasons.includes('protected-path:test/guards/old test.js'));
});

test('verify-pass-on-head reads the run record where verify appends it: the main checkout of a linked feature worktree (G.3 B1)', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-facts-linked-');
  const main = path.join(dir, 'main'), feature = path.join(dir, 'feature');
  const env: any = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'O', GIT_AUTHOR_EMAIL: 'o@example.test', GIT_COMMITTER_NAME: 'O', GIT_COMMITTER_EMAIL: 'o@example.test' };
  const git = (cwd: any, ...args: any[]) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'base'), 'base');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-q', '-b', `feat/${row.slug}`, feature);
  const record = `${JSON.stringify({ schema: 1, taskId: row.slug, head: HEAD, clean: true, verdict: 'PASS' })}\n`;
  fs.mkdirSync(path.join(main, '.doflow/state/verification/runs'), { recursive: true });
  fs.writeFileSync(path.join(main, '.doflow/state/verification/runs', `${row.slug}.jsonl`), record);
  const policy = loadPolicy(baseBytes).policy; policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  const input = gatherGateFacts({ root: feature, artifactRoot: path.join(feature, 'agent-docs/doflow', row.slug), row, rows: [row], policy,
    gateId: 'gate-b', developHead: PARENT, featureHead: HEAD,
    env: { ...process.env, HOME: path.join(main, 'home'), XDG_CONFIG_HOME: path.join(main, 'xdg') } });
  assert.equal(evaluate(policy, 'feature', 'gate-b', input).decision, 'pass');
  assert.equal(fs.realpathSync(input.find((f: any) => f.name === 'verification').locator), fs.realpathSync(path.join(main, '.doflow/state/verification/runs', `${row.slug}.jsonl`)));
});

test('git facts read the develop branch, never a tag named develop, and carry no claims list (C13, C19)', (t) => {
  const root = tempDir(t, 'doflow-roadmap-facts-ref-');
  const env: any = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'O', GIT_AUTHOR_EMAIL: 'o@example.test', GIT_COMMITTER_NAME: 'O', GIT_COMMITTER_EMAIL: 'o@example.test' };
  const git = (...args: any[]) => cp.execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(root, 'base'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  git('tag', 'develop');
  git('switch', '-q', '-c', `feat/${row.slug}`);
  fs.writeFileSync(path.join(root, 'x'), 'x'); git('add', '.'); git('commit', '-qm', 'feature');
  const featureHead = git('rev-parse', 'HEAD');
  git('switch', '-q', 'develop');
  git('merge', '--no-ff', '-q', `feat/${row.slug}`, '-m', 'merge: 113 Goal order', '-m', 'DoFlow-Row: 113');
  const branchHead = git('rev-parse', 'refs/heads/develop');
  assert.notEqual(git('rev-parse', 'refs/tags/develop'), branchHead);
  // A claims directory nothing writes any more must not reach the facts.
  fs.mkdirSync(path.join(root, '.doflow/state/claims'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doflow/state/claims/113_claims.json'), '{}');
  const facts = gatherGitFacts({ root });
  assert.deepEqual(facts.unreadable, []);
  assert.equal(facts.developHead, branchHead);
  assert.deepEqual(facts.merges.map((m: any) => m.rowTrailer), ['113']);
  assert.equal('claims' in facts, false);
  const policy = loadPolicy(baseBytes).policy; policy.classes.feature['gate-b'].predicates = ['verify-pass-on-head'];
  const input = gatherGateFacts({ root, artifactRoot: path.join(root, 'agent-docs/doflow', row.slug), row, rows: [row], policy, gateId: 'gate-b', featureHead,
    env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg') } });
  assert.deepEqual(input.find((f: any) => f.name === 'heads').value, { developHead: branchHead, featureHead });
});

test('C6: gate-a and gate-b gather a plan-verification-block fact bound to the plan bytes, and the shipped policy denies a present block', (t) => {
  const env = setup(t);
  const planFile = path.join(env.artifactRoot, 'plan.md');
  const fact = (gateId: any) => env.gather(gateId).find((f: any) => f.name === 'plan-verification-block');
  for (const gateId of ['gate-a', 'gate-b']) {
    assert.deepEqual(fact(gateId), { name: 'plan-verification-block', value: { present: false }, locator: planFile, sha256: sha256Digest(plan) }, gateId);
  }
  const block = `${plan}\n\`\`\`doflow-verification\n{"test":"true"}\n\`\`\`\n`;
  env.write(`agent-docs/doflow/${row.slug}/plan.md`, block);
  for (const gateId of ['gate-a', 'gate-b']) {
    assert.deepEqual(fact(gateId), { name: 'plan-verification-block', value: { present: true }, locator: planFile, sha256: sha256Digest(block) }, gateId);
    assert.ok(evaluate(env.options.policy, 'feature', gateId, env.gather(gateId)).reasons.includes('protected-path:plan-verification'), gateId);
  }
  // A malformed block is still a block: it would replace the commands or fail the verify run.
  env.write(`agent-docs/doflow/${row.slug}/plan.md`, `${plan}\n\`\`\`doflow-verification\n{not json\n\`\`\`\n`);
  assert.equal(fact('gate-a').value.present, true);
  // planning/plan.md is read when plan.md is absent; neither file is present:false, never unreadable.
  fs.rmSync(planFile);
  const nested = env.write(`agent-docs/doflow/${row.slug}/planning/plan.md`, block);
  assert.deepEqual([fact('gate-b').locator, fact('gate-b').value.present], [nested, true]);
  fs.rmSync(nested);
  assert.deepEqual(fact('gate-b'), { name: 'plan-verification-block', value: { present: false }, locator: planFile, sha256: sha256Digest('') });
  // Any other read error is unreadable, and the gate denies on it.
  fs.mkdirSync(planFile);
  assert.ok(fact('gate-a').unreadable);
  assert.ok(evaluate(env.options.policy, 'feature', 'gate-a', env.gather('gate-a')).reasons.includes(`protected-path:${planFile}`));
  // gate-0 does not read the plan for this predicate.
  assert.equal(env.gather('gate-0').some((f: any) => f.name === 'plan-verification-block'), false);
});
