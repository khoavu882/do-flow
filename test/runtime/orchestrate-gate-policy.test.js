'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { initRegister, readRegister } = require('../../src/runtime/decision-register.ts');

const REPO = path.resolve(__dirname, '../..');
const SLUG = '001-policy';
const FIXED = new Date('2026-10-19T00:00:00.000Z');
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

// Loose objects make a real, read-only Git fixture without running a Git write command.
function object(root, type, body) {
  const bytes = Buffer.from(body);
  const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
  const sha = createHash('sha1').update(raw).digest('hex');
  write(path.join(root, '.git/objects', sha.slice(0, 2), sha.slice(2)), deflateSync(raw));
  return sha;
}
function commit(root, files, parent) {
  function tree(entries) {
    const dirs = new Map();
    const records = [];
    for (const [file, bytes] of entries) {
      const [name, ...rest] = file.split('/');
      if (rest.length) { if (!dirs.has(name)) dirs.set(name, []); dirs.get(name).push([rest.join('/'), bytes]); }
      else records.push({ name, mode: '100644', sha: object(root, 'blob', bytes) });
    }
    for (const [name, children] of dirs) records.push({ name, mode: '40000', sha: tree(children) });
    records.sort((a, b) => `${a.name}${a.mode === '40000' ? '/' : ''}`.localeCompare(`${b.name}${b.mode === '40000' ? '/' : ''}`));
    return object(root, 'tree', Buffer.concat(records.map(r => Buffer.concat([Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.sha, 'hex')]))));
  }
  return object(root, 'commit', `tree ${tree(Object.entries(files))}\n${parent ? `parent ${parent}\n` : ''}author Test <test@example.com> 1760832000 +0000\ncommitter Test <test@example.com> 1760832000 +0000\n\nfixture\n`);
}
function fixture(t, { mode = 'approve', missing = false, markers = false, gateId = 'gate-0', protect = false } = {}) {
  const root = tempDir(t, 'doflow-gate-policy-');
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  // Keep each gate independently passable while exercising the real fact gatherer.
  for (const gate of Object.values(policy.classes.feature)) { gate.autopilot = mode; gate.predicates = protect ? ['protected-paths'] : ['markers-zero:requirement']; }
  const baseBytes = JSON.stringify(policy);
  const pkg = protect ? { 'package.json': '{}' } : {};
  const developHead = commit(root, missing ? {} : { ...pkg, 'core/registry/gates.json': baseBytes });
  const weak = structuredClone(policy);
  for (const gate of Object.values(weak.classes.feature)) gate.autopilot = 'approve';
  const featureBytes = JSON.stringify(weak) + (protect ? '\n' : '');
  const featureHead = commit(root, { ...pkg, 'core/registry/gates.json': featureBytes }, developHead);
  write(path.join(root, '.git/HEAD'), `ref: refs/heads/feat/${SLUG}\n`);
  write(path.join(root, '.git/refs/heads/develop'), `${developHead}\n`);
  write(path.join(root, '.git/refs/heads/feat', SLUG), `${featureHead}\n`);
  write(path.join(root, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  write(path.join(root, 'core/registry/gates.json'), featureBytes);
  write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows: [{ id: '001', slug: SLUG, title: 'Policy', class: 'feature', needs: [] }] }));
  const featureDir = path.join(root, 'agent-docs/doflow', SLUG);
  initRegister({ featureDir, slug: SLUG });
  write(path.join(featureDir, 'intention/requirement.md'), markers ? '[NEEDS CLARIFICATION: choice]\n' : '# Settled\n');
  const orch = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: root, readinessEvaluate: () => 'READY' });
  orch.start({ taskId: SLUG, taskClass: 'feature', now: FIXED });
  // Stage work is outside this task: put the real compiled run at the requested gate.
  const run = orch.readRun(SLUG);
  run.cursor = run.program.findIndex(n => n.id === gateId);
  for (const node of run.program.slice(0, run.cursor)) node.status = node.type === 'gate' ? 'approved' : 'completed';
  run.state = 'AWAITING_GATE';
  orch.writeRun(run, FIXED);
  return { root, featureDir, orch, baseBytes, developHead, gateId };
}
const decide = f => f.orch.decideGate({ taskId: SLUG, gateId: f.gateId, policy: f.gateId, now: FIXED });
function cli(f, extra = []) {
  return spawnSync(process.execPath, [path.join(REPO, 'bin/doflow.js'), 'orchestrate', '--action', 'decide-gate', '--task-id', SLUG, '--gate', f.gateId, '--policy', f.gateId, ...extra, '--json'], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: path.join(f.root, '.config'), FORCE_COLOR: '' },
  });
}

for (const [gateId, stage] of [['gate-0', 'discovery'], ['gate-a', 'planning'], ['gate-b', 'review']]) {
  test(`policy pass at ${gateId} records autopilot, digest, inputs and ${stage}`, t => {
    const f = fixture(t, { gateId });
    const result = decide(f);
    assert.equal(result.decision, 'pass');
    assert.notEqual(result.state, 'AWAITING_GATE');
    const run = f.orch.readRun(SLUG);
    assert.equal(run.program.find(n => n.id === gateId).status, 'approved');
    const entry = run.history.at(-1);
    assert.equal(entry.action, 'decide-gate');
    assert.equal(entry.detail, 'approve');
    assert.equal(entry.by, 'autopilot');
    assert.deepEqual(entry.policy, { id: gateId, digest: digest(f.baseBytes) });
    const input = entry.inputs.find(i => i.locator.endsWith('intention/requirement.md'));
    assert.equal(input.sha256, digest('# Settled\n'));
    assert.deepEqual(entry.inputs, result.inputs);
    assert.equal(entry.note, `approved by policy ${gateId}@${digest(f.baseBytes)} (${entry.inputs.length} inputs)`);
    assert.equal(entry.forced, false);
    const [decision] = readRegister(f.featureDir).decisions;
    assert.equal(decision.decidedBy, 'autopilot');
    assert.equal(decision.channel, 'policy');
    assert.equal(decision.stage, stage);
    assert.equal(decision.source, `git:${f.developHead}:core/registry/gates.json`);
  });
}

test('no caller names the decider, with or without --policy', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.orch.runFile(SLUG));
  assert.throws(() => f.orch.decideGate({ taskId: SLUG, gateId: 'gate-0', decision: 'approve', by: 'autopilot' }), /no decider/);
  assert.deepEqual(fs.readFileSync(f.orch.runFile(SLUG)), before);
});

for (const [name, options, reason] of [
  ['develop never beats a feature branch weakened to approve', { mode: 'never' }, 'policy-never'],
  ['absent develop policy beats the feature copy', { missing: true }, 'no-policy'],
  ['unresolved facts deny without rejecting', { markers: true }, 'unresolved-clarifications'],
]) {
  test(name, t => {
    const f = fixture(t, options);
    const before = fs.readFileSync(f.orch.runFile(SLUG));
    const register = fs.readFileSync(path.join(f.featureDir, 'decisions/register.json'));
    const result = decide(f);
    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.reasons, [reason]);
    assert.equal(result.state, 'AWAITING_GATE');
    assert.deepEqual(fs.readFileSync(f.orch.runFile(SLUG)), before);
    assert.deepEqual(fs.readFileSync(path.join(f.featureDir, 'decisions/register.json')), register);
    assert.equal(f.orch.readRun(SLUG).history.some(h => h.detail === 'reject'), false);
  });
}

test('override narrows the develop policy and binds its bytes', t => {
  const f = fixture(t);
  const bytes = JSON.stringify({ loop: { maxSteps: 1 } });
  write(path.join(f.root, '.doflow/gates.override.json'), bytes);
  const result = decide(f);
  assert.equal(result.decision, 'pass');
  assert.equal(result.policy.digest, `${digest(f.baseBytes)}+${digest(bytes)}`);
});

test('a widening override denies atomically', t => {
  const f = fixture(t);
  write(path.join(f.root, '.doflow/gates.override.json'), '{"loop":{"wip":999}}');
  const result = decide(f);
  assert.equal(result.decision, 'deny');
  assert.deepEqual(result.reasons, ['policy-override-widens:loop.wip']);
  assert.equal(readRegister(f.featureDir).decisions.length, 0);
});

test('unknown seed row cannot be approved by policy', t => {
  const f = fixture(t);
  write(path.join(f.root, 'agent-docs/roadmap/rows.json'), '{"schema":1,"rows":[]}');
  assert.deepEqual(decide(f).reasons, ['row-unknown']);
});

test('typed seed status cannot authorize a gate', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'agent-docs/roadmap/rows.json');
  const seed = JSON.parse(fs.readFileSync(file));
  seed.rows[0].status = 'merged';
  write(file, JSON.stringify(seed));
  assert.deepEqual(decide(f).reasons, ['seed-typed-status']);
  assert.equal(readRegister(f.featureDir).decisions.length, 0);
});

test('a deny is reevaluated from current artifact bytes on retry', t => {
  const f = fixture(t, { markers: true });
  assert.equal(decide(f).decision, 'deny');
  write(path.join(f.featureDir, 'intention/requirement.md'), '# Resolved on retry\n');
  const result = decide(f);
  assert.equal(result.decision, 'pass');
  assert.equal(result.inputs.find(i => i.locator.endsWith('requirement.md')).sha256, digest('# Resolved on retry\n'));
  assert.equal(readRegister(f.featureDir).decisions.length, 1);
});

test('a missing register prevents policy approval and leaves the journal untouched', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.featureDir, 'decisions/register.json'));
  const before = fs.readFileSync(f.orch.runFile(SLUG));
  assert.throws(() => decide(f), /no-register/);
  assert.deepEqual(fs.readFileSync(f.orch.runFile(SLUG)), before);
});

test('linked checkout uses the main seed and override, even when the run lives on main', t => {
  const f = fixture(t);
  const linked = tempDir(t, 'doflow-policy-linked-');
  const admin = path.join(f.root, '.git/worktrees/policy');
  write(path.join(f.root, '.git/HEAD'), 'ref: refs/heads/develop\n');
  write(path.join(admin, 'HEAD'), `ref: refs/heads/feat/${SLUG}\n`);
  write(path.join(admin, 'gitdir'), `${linked}/.git\n`);
  write(path.join(admin, 'commondir'), '../..\n');
  write(path.join(linked, '.git'), `gitdir: ${admin}\n`);
  write(path.join(linked, 'agent-docs/roadmap/rows.json'), '{"schema":1,"rows":[]}');
  write(path.join(f.root, '.doflow/gates.override.json'), '{"classes":{"feature":{"gate-0":{"autopilot":"never"}}}}');
  write(path.join(linked, '.doflow/gates.override.json'), '{"loop":{"wip":999}}');
  f.orch = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: f.root, sourceRoot: linked });
  const result = decide(f);
  assert.deepEqual(result.reasons, ['policy-never']);
  assert.equal(result.state, 'AWAITING_GATE');
  assert.equal(readRegister(f.featureDir).decisions.length, 0);
  const narrowed = '{"loop":{"maxSteps":1}}';
  write(path.join(f.root, '.doflow/gates.override.json'), narrowed);
  const pass = decide(f);
  assert.equal(pass.decision, 'pass', `the main seed row and main artifacts are visible from the linked checkout: ${JSON.stringify(pass)}`);
  assert.equal(pass.policy.digest, `${digest(f.baseBytes)}+${digest(narrowed)}`);
});

test('the feature head is the feature branch, so a run from the main checkout on develop still sees the protected change', t => {
  const f = fixture(t, { protect: true });
  const linked = tempDir(t, 'doflow-policy-linked-');
  const admin = path.join(f.root, '.git/worktrees/policy');
  write(path.join(f.root, '.git/HEAD'), 'ref: refs/heads/develop\n');
  write(path.join(admin, 'HEAD'), `ref: refs/heads/feat/${SLUG}\n`);
  write(path.join(admin, 'gitdir'), `${linked}/.git\n`);
  write(path.join(admin, 'commondir'), '../..\n');
  write(path.join(linked, '.git'), `gitdir: ${admin}\n`);
  const result = decide(f);
  assert.equal(result.decision, 'deny', `a develop-vs-develop diff must not approve: ${JSON.stringify(result.reasons)}`);
  assert.ok(result.reasons.includes('protected-path:core/registry/gates.json'), JSON.stringify(result.reasons));
  assert.equal(result.state, 'AWAITING_GATE');
  assert.equal(readRegister(f.featureDir).decisions.length, 0);
  const heads = result.inputs.find(i => i.locator.endsWith(`#diff:${f.developHead}...${fs.readFileSync(path.join(f.root, '.git/refs/heads/feat', SLUG), 'utf8').trim()}`));
  assert.ok(heads, 'the diff input is bound to develop...feature-branch');
});

test('a feature branch that does not exist denies instead of falling back to HEAD', t => {
  const f = fixture(t, { protect: true });
  write(path.join(f.root, '.git/HEAD'), 'ref: refs/heads/develop\n');
  fs.rmSync(path.join(f.root, '.git/refs/heads/feat'), { recursive: true });
  const result = decide(f);
  assert.equal(result.decision, 'deny');
  assert.equal(result.state, 'AWAITING_GATE');
  assert.equal(readRegister(f.featureDir).decisions.length, 0);
});

for (const extra of [{ decision: 'approve' }, { decision: 'reject' }, { forced: true, note: 'override' }, { by: 'autopilot' }, { policy: 'gate-b' }]) {
  test(`policy refuses competing arguments ${JSON.stringify(extra)}`, t => {
    const f = fixture(t);
    const before = fs.readFileSync(f.orch.runFile(SLUG));
    assert.throws(() => f.orch.decideGate({ taskId: SLUG, gateId: 'gate-0', policy: 'gate-0', ...extra }), /policy/);
    assert.deepEqual(fs.readFileSync(f.orch.runFile(SLUG)), before);
  });
}

test('CLI forwards policy and reports an attributable approval', t => {
  const f = fixture(t);
  const result = cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'pass');
  assert.equal(f.orch.readRun(SLUG).history.at(-1).by, 'autopilot');
});

for (const args of [['--decision', 'approve'], ['--forced', '--note', 'override'], ['--by', 'autopilot']]) {
  test(`CLI refuses policy with ${args[0]}`, t => {
    const f = fixture(t);
    const before = fs.readFileSync(f.orch.runFile(SLUG));
    const result = cli(f, args);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(fs.readFileSync(f.orch.runFile(SLUG)), before);
  });
}
