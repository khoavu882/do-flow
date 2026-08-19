'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  agentDirectory, destinationFor, discoverCodexAgents, planCodexAgents, reconcileCodexAgents,
} = require('../src/adapters/codex/agents');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-agents-')); }
function agent(name = 'backend-architect', sandbox = 'sandbox_mode = "read-only"') {
  return `name = "${name}"\ndescription = "A specialist with a clear, bounded orchestration purpose."\n${sandbox}\ndeveloper_instructions = """\nUse evidence before recommendations and clearly identify trade-offs, risks, and validation needs.\nDo not make workspace changes; return concise findings for the parent orchestrator instead.\n"""\n`;
}
function sourceDirectory(root, name, content) {
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
  const writableAnalysisRole = sourceDirectory(scratch(), 'backend-architect', agent('backend-architect', 'sandbox_mode = "workspace-write"'));
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
