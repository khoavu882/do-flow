'use strict';
// 118 IC-005: every agent renderer projects `access` through the harness's `agentLimits.readOnly`
// (IC-003). A `read-only` spec carries that harness's `apply` keys, a `write` spec carries none, and
// the `access` key itself reaches no harness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp');
const { TRANSFORMS, readOnlyApply } = require('../../src/adapters/copy-tree.ts');
const codexAgents = require('../../src/adapters/codex/agents.ts');
const { loadRegistry, selectAssets, harnessFor } = require('../../src/registry/index.ts');
const { projectAdapterInput } = require('../../src/adapters/index.ts');
const codexAdapter = require('../../src/adapters/codex/index.ts');

const REPO = path.resolve(__dirname, '../..');
const SPECS = path.join(REPO, 'core', 'shared', 'agent-specs');
const CODEX_TOMLS = path.join(REPO, 'core', 'harnesses', 'codex', 'agents');
const registry = loadRegistry({ repoRoot: REPO });
const sharedAgents = registry.assets.find((asset) => asset.id === 'agents.shared');

const specs = fs.readdirSync(SPECS).filter((file) => file.endsWith('.md')).sort().map((file) => {
  const text = fs.readFileSync(path.join(SPECS, file), 'utf8');
  return { name: path.basename(file, '.md'), file, text, access: text.match(/^access:\s*(\S+)\s*$/m)?.[1] };
});
const frontmatter = (text) => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
const keyLines = (text) => frontmatter(text).split('\n').filter((line) => /^[A-Za-z]/.test(line));

/** Render one spec the way harness `id`'s agent projection does, through the registry's transform. */
function render(id, spec) {
  const transform = sharedAgents.projection[id].transform;
  assert.ok(transform, `${id}: agents.shared declares a transform`);
  return TRANSFORMS[transform](spec.file, Buffer.from(spec.text)).toString('utf8');
}

test('the specs under test carry both access values', () => {
  assert.ok(specs.some((spec) => spec.access === 'read-only'));
  assert.ok(specs.some((spec) => spec.access === 'write'));
});

test('every harness agents.shared applies to projects through a registered transform (no byte-copy path)', () => {
  assert.ok(sharedAgents.appliesTo.length >= 7);
  for (const id of sharedAgents.appliesTo) {
    const transform = sharedAgents.projection[id].transform;
    assert.ok(transform && TRANSFORMS[transform], `${id}: agents.shared declares a registered transform`);
  }
});

test('readOnlyApply returns the registry apply block, or null when the limit is unenforced', () => {
  for (const harness of registry.harnesses) {
    const entry = harness.agentLimits.readOnly;
    assert.deepEqual(readOnlyApply(harness.id), entry.status === 'native' ? entry.apply : null, harness.id);
  }
  assert.throws(() => readOnlyApply('no-such-harness'), /unknown harness/);
});

for (const id of ['claude', 'gemini', 'copilot', 'antigravity']) {
  test(`${id}: markdown agents carry the apply keys on read-only specs only, and never access`, () => {
    const apply = readOnlyApply(id);
    assert.equal(apply !== null, registry.harnesses.find((item) => item.id === id).agentLimits.readOnly.status === 'native', `${id}: apply exists exactly when native`);
    for (const spec of specs) {
      const out = render(id, spec);
      assert.ok(!keyLines(out).some((line) => line.startsWith('access:')), `${id}/${spec.name}: no access key`);
      const keys = keyLines(out).map((line) => line.slice(0, line.indexOf(':')));
      for (const key of Object.keys(apply || {})) {
        if (spec.access === 'read-only') {
          const line = keyLines(out).find((item) => item.startsWith(`${key}:`));
          assert.ok(line, `${id}/${spec.name}: read-only spec carries '${key}'`);
          const value = line.slice(key.length + 1).trim();
          assert.equal(Array.isArray(apply[key]) ? JSON.stringify(JSON.parse(value)) : value, Array.isArray(apply[key]) ? JSON.stringify(apply[key]) : apply[key], `${id}/${spec.name}: '${key}' value`);
        } else {
          assert.ok(!keys.includes(key), `${id}/${spec.name}: write spec has no '${key}'`);
        }
      }
      // Body is untouched.
      assert.equal(out.slice(out.indexOf('\n---', 3)), spec.text.slice(spec.text.indexOf('\n---', 3)), `${id}/${spec.name}: body unchanged`);
    }
  });
}

test('antigravity: the limit is unenforced, so the output is the spec minus access and nothing added', () => {
  assert.equal(readOnlyApply('antigravity'), null);
  for (const spec of specs) {
    assert.equal(render('antigravity', spec), spec.text.replace(/^access:.*\n/m, ''), spec.name);
  }
});

test('opencode: permission block on read-only specs only, byte-identical to the pre-118 renderer', () => {
  for (const spec of specs) {
    const out = render('opencode', spec);
    assert.ok(!/^access:/m.test(out), `${spec.name}: no access key`);
    const fm = Object.fromEntries(frontmatter(spec.text).split('\n').map((line) => line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^"|"$/g, '')]));
    const body = spec.text.slice(spec.text.indexOf('\n---', 3) + 4).replace(/^\n+/, '');
    const base = ['---', `description: ${JSON.stringify(fm.description)}`, 'mode: subagent',
      ...(spec.access === 'read-only' ? ['permission:', '  edit: deny', '  bash: deny'] : []),
      '---', '', body.replace(/\n*$/, ''), ''].join('\n');
    assert.equal(out, base, `${spec.name}: bytes equal the base renderer's`);
  }
  assert.ok(specs.filter((spec) => spec.access === 'read-only').length >= 4);
});

test('kiro: tools list replaces ["*"] on read-only specs only, and access is never emitted', () => {
  const apply = readOnlyApply('kiro');
  for (const spec of specs) {
    const out = render('kiro', spec);
    assert.ok(!/access/.test(Object.keys(JSON.parse(out)).join(',')), `${spec.name}: no access key`);
    assert.deepEqual(JSON.parse(out).tools, spec.access === 'read-only' ? apply.tools : ['*'], spec.name);
  }
});

test('codex: every TOML carries sandbox_mode = "read-only" exactly when its spec is read-only', () => {
  const agents = codexAgents.discoverCodexAgents(CODEX_TOMLS);
  assert.deepEqual(agents.map((agent) => agent.name), specs.map((spec) => spec.name));
  for (const agent of agents) {
    const spec = specs.find((item) => item.name === agent.name);
    assert.equal(agent.sandbox_mode, spec.access === 'read-only' ? 'read-only' : undefined, agent.name);
    assert.ok(!/^access\b/m.test(agent.source), `${agent.name}: no access key`);
  }
});

test('codex: the Markdown agent copies in ~/.codex/agents carry no access key, through plan, apply and verify', () => {
  const projectRoot = suiteTempDir('doflow-agent-limits-codex-');
  const assets = selectAssets(registry, { harness: 'codex' });
  const projected = projectAdapterInput({ registry, harness: harnessFor(registry, 'codex'), scope: 'project', scopeRoot: projectRoot, assets, mcp: [], policies: [], context: { sourceVersion: 'test-v1' } });
  const input = { ...projected, projectRoot, context: { repoRoot: REPO, sourceVersion: 'test-v1' } };
  const planned = codexAdapter.plan(input);
  assert.equal(planned.components.copyTree.ok, true);
  codexAdapter.apply({ ...input, changes: planned.changes });
  const agentsDir = path.join(projectRoot, '.codex', 'agents');
  const written = fs.readdirSync(agentsDir);
  const mdFiles = written.filter((file) => file.endsWith('.md')).sort();
  assert.deepEqual(mdFiles, specs.map((spec) => spec.file), 'one Markdown copy per spec');
  for (const spec of specs) {
    const out = fs.readFileSync(path.join(agentsDir, spec.file), 'utf8');
    assert.ok(!/^access:/m.test(out), `codex/${spec.name}: no access key in the projected Markdown`);
    // Codex's limit is unenforced, so the output is the spec minus the access line and nothing added.
    assert.equal(out, spec.text.replace(/^access:.*\n/m, ''), `codex/${spec.name}: spec minus access`);
  }
  // The TOMLs are a separate asset and stay byte for byte what the repo ships.
  for (const file of written.filter((name) => name.endsWith('.toml'))) {
    assert.equal(fs.readFileSync(path.join(agentsDir, file), 'utf8'), fs.readFileSync(path.join(CODEX_TOMLS, file), 'utf8'), `${file}: untouched`);
  }
  assert.ok(written.some((file) => file.endsWith('.toml')));
  // verify re-derives the transformed bytes: clean after apply, and the ledger plan is a no-op.
  const verified = codexAdapter.verify({ ...input, registry });
  assert.equal(verified.ok, true, verified.conflicts.join('\n'));
  const ledger = { resources: verified.resources.map((resource) => ({ ...resource, harness: 'codex' })) };
  assert.equal(codexAdapter.plan({ ...input, ledger }).changes.filter((change) => change.projection?.renderer === 'copy-tree').length, 0, 'second plan is idempotent');
});

test('codex validator: a TOML disagreeing with its spec access is rejected, a user agent is not', () => {
  const toml = (name, sandbox) => `name = "${name}"\ndescription = "A specialist with a clear, bounded orchestration purpose."\n${sandbox}developer_instructions = """\nUse evidence before recommendations and clearly identify trade-offs, risks, and validation needs.\nDo not make workspace changes; return concise findings for the parent orchestrator instead.\n"""\n`;
  const read = specs.find((spec) => spec.access === 'read-only').name;
  const write = specs.find((spec) => spec.access === 'write').name;
  assert.throws(() => codexAgents.validateAgentContract(toml(read, ''), { fileName: `${read}.toml` }), /access: read-only/);
  assert.throws(() => codexAgents.validateAgentContract(toml(write, 'sandbox_mode = "read-only"\n'), { fileName: `${write}.toml` }), /access: write/);
  // Negative control: a user TOML named like a removed role (no spec) loads with or without sandbox_mode.
  const dir = suiteTempDir('doflow-agent-limits-');
  fs.writeFileSync(path.join(dir, 'pm-agent.toml'), toml('pm-agent', ''));
  fs.writeFileSync(path.join(dir, 'backend-architect.toml'), toml('backend-architect', 'sandbox_mode = "workspace-write"\n'));
  assert.deepEqual(codexAgents.discoverCodexAgents(dir).map((agent) => agent.name), ['backend-architect', 'pm-agent']);
});

test('the deleted per-harness role lists are gone', () => {
  assert.equal(codexAgents.READ_ONLY_ROLES, undefined);
  assert.equal(codexAgents.IMPLEMENTATION_ROLES, undefined);
  assert.ok(!/OPENCODE_READONLY_AGENTS/.test(fs.readFileSync(path.join(REPO, 'src', 'adapters', 'copy-tree.ts'), 'utf8')));
});
