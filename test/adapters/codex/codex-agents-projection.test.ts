'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');
const {
  agentDirectory, destinationFor, discoverCodexAgents, planCodexAgents, reconcileCodexAgents, fingerprint,
} = require('../../../src/adapters/codex/agents.ts');

function scratch() { return suiteTempDir('doflow-codex-agents-'); }
function agent(name = 'backend-architect', sandbox = 'sandbox_mode = "read-only"') {
  return `name = "${name}"\ndescription = "A specialist with a clear, bounded orchestration purpose."\n${sandbox}\ndeveloper_instructions = """\nUse evidence before recommendations and clearly identify trade-offs, risks, and validation needs.\nDo not make workspace changes; return concise findings for the parent orchestrator instead.\n"""\n`;
}
function sourceDirectory(root: any, name: any, content: any) {
  const directory = path.join(root, 'source'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.toml`), content); return directory;
}

test('discovers and validates a canonical custom-agent contract', () => {
  const root = scratch(); const sourceDir = sourceDirectory(root, 'backend-architect', agent());
  const [result] = discoverCodexAgents(sourceDir);
  assert.equal(result.name, 'backend-architect');
  assert.equal(result.sandbox_mode, 'read-only');
  assert.match(result.fingerprint, /^sha256:/);
});

test('rejects malformed TOML, missing required fields, and incorrect role sandbox defaults', () => {
  const root = scratch();
  assert.throws(() => discoverCodexAgents(sourceDirectory(root, 'backend-architect', 'name = "backend-architect"\n')), /missing required/);
  const malformed = sourceDirectory(scratch(), 'backend-architect', 'name = "backend-architect"\nnot valid\n');
  assert.throws(() => discoverCodexAgents(malformed), /Malformed agent TOML/);
  // Tied to the spec's access (118 IC-005): the role is whichever shipped spec is `access: read-only`.
  const specs = path.join(__dirname, '..', '..', '..', 'core', 'shared', 'agent-specs');
  const readOnlyRole = fs.readdirSync(specs).filter((file: any) => file.endsWith('.md'))
    .find((file: any) => /^access: read-only\s*$/m.test(fs.readFileSync(path.join(specs, file), 'utf8'))).slice(0, -3);
  const writableAnalysisRole = sourceDirectory(scratch(), readOnlyRole, agent(readOnlyRole, 'sandbox_mode = "workspace-write"'));
  assert.throws(() => discoverCodexAgents(writableAnalysisRole), /must use sandbox_mode/);
});

test('plans and applies project-scoped agents with manifest-owned resource records', () => {
  const root = scratch(); const sourceDir = sourceDirectory(root, 'backend-architect', agent());
  const plan = planCodexAgents({ scope: 'project', projectRoot: root, sourceDir, sourceVersion: '2.4.4' });
  assert.equal(plan.status, 'change');
  assert.equal(plan.changes[0].file, path.join(root, '.codex', 'agents', 'backend-architect.toml'));
  assert.deepEqual(plan.managedResources[0], {
    target: 'codex', scope: 'project', kind: 'custom-agent', identity: 'agent:backend-architect',
    sourceVersion: '2.4.4', fingerprint: plan.agents[0].fingerprint, selection: true,
  });
  const applied = reconcileCodexAgents({ scope: 'project', projectRoot: root, sourceDir, sourceVersion: '2.4.4' });
  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(plan.changes[0].file, 'utf8'), agent());
});

test('plans global-scoped agents under the supplied Codex directory', () => {
  const root = scratch(); const sourceDir = sourceDirectory(root, 'backend-architect', agent());
  const codexDir = path.join(root, 'home-codex');
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir });
  assert.equal(agentDirectory({ scope: 'global', codexDir }), path.join(codexDir, 'agents'));
  assert.equal(plan.changes[0].file, path.join(codexDir, 'agents', 'backend-architect.toml'));
});

test('an owned, current projection produces an idempotent plan', () => {
  const root = scratch(); const sourceDir = sourceDirectory(root, 'backend-architect', agent());
  const first = reconcileCodexAgents({ scope: 'project', projectRoot: root, sourceDir, sourceVersion: '2.4.4' });
  const second = planCodexAgents({ scope: 'project', projectRoot: root, sourceDir, sourceVersion: '2.4.4', managedResources: first.managedResources });
  assert.equal(second.status, 'unchanged');
  assert.deepEqual(second.changes, []);
});

test('does not permit traversal through agent contract names or destination filenames', () => {
  const root = scratch();
  const sourceDir = sourceDirectory(root, 'backend-architect', agent('../escape'));
  assert.throws(() => discoverCodexAgents(sourceDir), /lowercase kebab-case/);
  assert.throws(() => destinationFor(path.join(root, '.codex', 'agents'), '../escape'), /lowercase kebab-case/);
});

// FU-gb1xhy: an owned agent the source stopped shipping is pruned (unmodified) or released (user-modified).
function ownedRecord(name: any, content: any) {
  return { target: 'codex', scope: 'global', kind: 'custom-agent', identity: `agent:${name}`, fingerprint: fingerprint(content), selection: true };
}
function pruneFixture() {
  const root = scratch();
  const sourceDir = sourceDirectory(root, 'backend-architect', agent());
  const codexDir = path.join(root, 'home-codex');
  const dir = path.join(codexDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  return { sourceDir, codexDir, dir };
}

test('an owned agent that is no longer shipped is removed when the file is unmodified', () => {
  const { sourceDir, codexDir, dir } = pruneFixture();
  const old = agent('retired-role');
  fs.writeFileSync(path.join(dir, 'retired-role.toml'), old);
  const options = { scope: 'global', codexDir, sourceDir, managedResources: [ownedRecord('retired-role', old)] };
  const plan = planCodexAgents(options);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.managedResources.map((r: any) => r.identity), ['agent:backend-architect'], 'the retired row is dropped from the ledger');
  assert.deepEqual(plan.changes.filter((c: any) => c.type === 'remove').map((c: any) => [c.identity, c.file, c.release]),
    [['agent:retired-role', path.join(dir, 'retired-role.toml'), undefined]]);
  assert.ok(fs.existsSync(path.join(dir, 'retired-role.toml')), 'planning deletes nothing');
  reconcileCodexAgents(options);
  assert.equal(fs.existsSync(path.join(dir, 'retired-role.toml')), false, 'applying removes the owned file');
  assert.ok(fs.existsSync(path.join(dir, 'backend-architect.toml')), 'the shipped agent is written');
});

test('a user-modified owned agent that is no longer shipped is released and kept', () => {
  const { sourceDir, codexDir, dir } = pruneFixture();
  const old = agent('retired-role');
  fs.writeFileSync(path.join(dir, 'retired-role.toml'), `${old}# my edit\n`);
  const options = { scope: 'global', codexDir, sourceDir, managedResources: [ownedRecord('retired-role', old)] };
  const plan = planCodexAgents(options);
  assert.equal(plan.ok, true, 'a modified retired file is not a conflict');
  assert.deepEqual(plan.managedResources.map((r: any) => r.identity), ['agent:backend-architect']);
  assert.deepEqual(plan.changes.filter((c: any) => c.type === 'remove').map((c: any) => [c.identity, c.release]), [['agent:retired-role', true]]);
  reconcileCodexAgents(options);
  assert.equal(fs.readFileSync(path.join(dir, 'retired-role.toml'), 'utf8'), `${old}# my edit\n`, 'the user file is untouched');
});

test('a retired owned agent whose file is already gone plans no removal, and a still-shipped agent is never pruned', () => {
  const { sourceDir, codexDir } = pruneFixture();
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [ownedRecord('retired-role', agent('retired-role'))] });
  assert.deepEqual(plan.changes.map((c: any) => c.type), ['create'], 'only the shipped agent is planned');
  const same = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [ownedRecord('backend-architect', agent())] });
  assert.equal(same.changes.filter((c: any) => c.type === 'remove').length, 0);
});
