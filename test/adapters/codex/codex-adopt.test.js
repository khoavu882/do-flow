'use strict';

/**
 * Adoption of Codex resources that exist with no ledger record.
 *
 * Codex's three native components each refused a resource present on disk with no record —
 * `'<identity>' exists but is not owned by DoFlow`, `Agent '<name>' exists but is not owned by
 * DoFlow`, and `Codex hooks.json exists but is not owned by the neutral ledger`. None of the three
 * consulted `force`, so a tree written before the neutral ledger existed could never be re-adopted:
 * the condition blocking the install was the same condition an install had to run to clear.
 *
 * `adopt` is deliberately NOT `force`, and the tests below pin that difference rather than assuming
 * it. Adoption covers the no-record case only. A resource whose record *disagrees* with the bytes on
 * disk stays a conflict under `adopt`, because that is drift — someone changed a managed file — and
 * healing drift is what `force` is for. Conflating the two would let one flag both claim unknown
 * files and overwrite known-changed ones, which are different decisions with different risks.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fingerprint, planCodexConfig } = require('../../../src/adapters/codex/config');
const { planCodexAgents, fingerprint: agentFingerprint } = require('../../../src/adapters/codex/agents');

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `doflow-codex-adopt-${prefix}-`)); }

function configResource(value = true) {
  return { target: 'codex', scope: 'project', kind: 'configuration-entry', identity: 'features.hooks', value, sourceVersion: 'test' };
}

// ── config entries ─────────────────────────────────────────────────────────────────────────────

test('config: an unrecorded entry is refused by default', () => {
  const root = scratch('cfg'); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nhooks = true\n');
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [], desiredResources: [configResource()] });
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'conflict');
  assert.deepEqual(plan.conflicts, ["'features.hooks' exists but is not owned by DoFlow"]);
});

test('config: adopt claims the unrecorded entry instead of refusing, and records ownership', () => {
  const root = scratch('cfg-adopt'); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nhooks = true\n');
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [], desiredResources: [configResource()], adopt: true });
  assert.equal(plan.ok, true, 'adoption is not a conflict');
  assert.deepEqual(plan.conflicts, []);
  const record = plan.managedResources.find((r) => r.identity === 'features.hooks');
  assert.ok(record, 'the adopted entry is now owned');
  assert.equal(record.fingerprint, fingerprint(true));
});

test('config: adopt does not rewrite an entry that already matches the desired value', () => {
  const root = scratch('cfg-noop'); const file = path.join(root, 'config.toml');
  const before = '# mine\nmodel = "gpt-5"\n\n[features]\nhooks = true\n';
  fs.writeFileSync(file, before);
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [], desiredResources: [configResource(true)], adopt: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes, [], 'nothing to change: the file already holds the declared value');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'planning wrote nothing');
});

test('config: adopt still refuses an entry whose record disagrees with the file', () => {
  // This is the line between adopt and force. The entry IS recorded, and the record says `true`
  // while the file says `false` — someone changed a managed value. That is drift, not an unknown
  // resource, so adopt must not touch it.
  const root = scratch('cfg-drift'); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nhooks = false\n');
  const owned = { ...configResource(true), fingerprint: fingerprint(true) };
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [owned], desiredResources: [configResource(true)], adopt: true });
  assert.equal(plan.ok, false, 'adopt is not a drift override');
  assert.deepEqual(plan.conflicts, ["'features.hooks' was modified outside DoFlow"]);
});

// ── agent files ────────────────────────────────────────────────────────────────────────────────

/** The real shipped shape, satisfying the whole agent contract in one go: `name`, `description`
 * (>= 20 chars) and `developer_instructions` (>= 100 chars) are required, `sandbox_mode` is the only
 * other accepted field, and `spec-analyst` is a read-only role so it must declare read-only.
 * Inventing the shape, then discovering one rule per run, cost four iterations — the contract is
 * stated in validateAgentContract and reading it whole was the cheaper move. */
function agentSource(name, marker = 'declared') {
  const instructions = `Exercise adoption of an agent file that exists with no ledger record. This body is `
    + `deliberately long enough to clear the hundred-character substantive-instructions floor that the `
    + `agent contract enforces. Marker: ${marker}.`;
  return `name = "${name}"\ndescription = "Specialist test agent used to exercise adoption of unrecorded files."\n`
    + `sandbox_mode = "read-only"\ndeveloper_instructions = """\n${instructions}\n"""\n`;
}

/** A source dir holding one agent, plus a codex dir whose agents/ already holds that agent's file. */
function agentFixture(name, { installedBody } = {}) {
  const sourceDir = scratch('agent-src');
  fs.writeFileSync(path.join(sourceDir, `${name}.toml`), agentSource(name));
  const codexDir = scratch('agent-dest');
  const agentsDir = path.join(codexDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  if (installedBody !== undefined) {
    for (const ext of ['toml', 'md']) {
      const candidate = path.join(agentsDir, `${name}.${ext}`);
      if (ext === 'toml') fs.writeFileSync(candidate, installedBody);
    }
  }
  return { sourceDir, codexDir };
}

test('agents: an unrecorded agent file is refused by default', () => {
  const { sourceDir, codexDir } = agentFixture('spec-analyst', { installedBody: agentSource('spec-analyst') });
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [] });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.conflicts, ["Agent 'spec-analyst' exists but is not owned by DoFlow"]);
});

test('agents: adopt claims the unrecorded agent file and records ownership', () => {
  const { sourceDir, codexDir } = agentFixture('spec-analyst', { installedBody: agentSource('spec-analyst') });
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [], adopt: true });
  assert.equal(plan.ok, true, 'adoption is not a conflict');
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.managedResources.some((r) => r.identity === 'agent:spec-analyst'), 'now owned');
});

test('agents: adopt still refuses an agent whose record disagrees with the file', () => {
  const body = agentSource('spec-analyst');
  const { sourceDir, codexDir } = agentFixture('spec-analyst', { installedBody: body });
  // Recorded, but the record describes different bytes than the file holds.
  const owned = {
    target: 'codex', scope: 'global', kind: 'custom-agent', identity: 'agent:spec-analyst',
    fingerprint: agentFingerprint('something else entirely'),
  };
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [owned], adopt: true });
  assert.equal(plan.ok, false, 'adopt is not a drift override');
  assert.deepEqual(plan.conflicts, ["Agent 'spec-analyst' was modified outside DoFlow"]);
});

test('agents: adopting an unrecorded file whose content differs plans an update to the declared source', () => {
  // Adoption records ownership; ordinary planning then brings the file to the declared state, exactly
  // as it would for any managed resource. Adoption is not "keep whatever is there".
  const { sourceDir, codexDir } = agentFixture('spec-analyst', { installedBody: agentSource('spec-analyst', 'stale-predates-the-ledger') });
  const plan = planCodexAgents({ scope: 'global', codexDir, sourceDir, managedResources: [], adopt: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes.map((c) => c.type), ['update']);
  assert.match(plan.changes[0].content, /Marker: declared\./, 'the declared source wins');
});
