'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry, selectAssets } = require('../../../src/registry');
const { projectAdapterInput } = require('../../../src/adapters');
const adapter = require('../../../src/adapters/antigravity');
const { expectExecutable } = require('../../helper-platform');

const REPO = path.resolve(__dirname, '..', '..', '..');
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-agy-')); }

function harnessInput(registry, { scope = 'project', scopeRoot, mcp = [], ledger } = {}) {
  const harness = registry.harnesses.find((h) => h.id === 'antigravity');
  const assets = selectAssets(registry, { harness: 'antigravity' });
  const projected = projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp, policies: [], context: {} });
  return {
    ...projected,
    scope,
    scopeRoot,
    projectRoot: scopeRoot,
    homeDir: path.join(scopeRoot, 'home'),
    mcp,
    ledger: ledger ?? { resources: [] },
    context: { repoRoot: REPO, operation: 'apply' },
  };
}

function remoteServer() {
  // Not in the shipped catalog; the planner must still accept it and rewrite the URL.
  return { id: 'remote-x', transport: 'http', url: 'https://example.invalid/mcp' };
}

test('project plan: instructions, skills, agents, locator, and MCP land where Antigravity reads them', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root, mcp: [registry.mcp[0], remoteServer()] });

  const planned = adapter.plan(input);
  assert.equal(planned.conflicts.length, 0);
  assert.ok(planned.changes.some((c) => c.projection.renderer === 'antigravity-instructions' && c.target === path.join(root, 'AGENTS.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'agents', 'system-architect', 'agent.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'bin', 'doflow-run')), 'the locator rides the config dir');

  const mcpChanges = planned.changes.filter((c) => c.projection.renderer === 'antigravity-mcp');
  assert.ok(mcpChanges.length >= 2);
  adapter.apply({ ...input, changes: planned.changes });

  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /doflow:start/);
  const mcpDoc = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
  assert.equal(mcpDoc.mcpServers['remote-x'].serverUrl, 'https://example.invalid/mcp', 'remote url projects to serverUrl');
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));

  // Idempotent re-plan converges to zero copy-tree/instruction changes.
  const verified = adapter.verify({ ...input });
  const second = adapter.plan({
    ...input,
    ledger: { resources: verified.resources.map((r) => ({ ...r, harness: 'antigravity' })) },
  });
  assert.equal(second.changes.filter((c) => c.operation !== 'remove').length, 0, 'second plan is a no-op');
});

test('global scope: no instructions, no skills; agents and locator ride ~/.gemini/config', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const home = scratch();
  const input = harnessInput(registry, { scope: 'global', scopeRoot: home });
  const planned = adapter.plan(input);
  assert.ok(!planned.changes.some((c) => c.target.endsWith('AGENTS.md')), 'global instructions belong to Gemini CLI; never written');
  assert.ok(!planned.changes.some((c) => c.target.includes('.agents', 'skills')));
  assert.ok(planned.changes.some((c) => c.target === path.join(home, '.gemini', 'config', 'agents', 'system-architect', 'agent.md')));
  adapter.apply({ ...input, changes: planned.changes });
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'config', 'bin', 'doflow-run')));
});

test('removal strips the managed section but preserves foreign bytes on both sides', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root });
  const planned = adapter.plan(input);
  adapter.apply({ ...input, changes: planned.changes });
  const agentsPath = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agentsPath, `# mine\n${fs.readFileSync(agentsPath, 'utf8')}\n# mine after\n`);

  const removeContext = { ...input.context, operation: 'remove' };
  const removalPlan = adapter.plan({ ...input, context: removeContext });
  adapter.remove({ ...input, changes: removalPlan.changes, context: removeContext });
  const after = fs.readFileSync(agentsPath, 'utf8');
  assert.match(after, /# mine/);
  assert.match(after, /# mine after/);
  assert.ok(!after.includes('doflow:start'), 'managed section is gone');
});

test('MCP removal deletes only DoFlow-owned servers; foreign ones survive byte-for-byte', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root, mcp: [registry.mcp[0]] });
  const planned = adapter.plan(input);
  adapter.apply({ ...input, changes: planned.changes });

  const mcpFile = path.join(root, '.agents', 'mcp_config.json');
  const doc = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  doc.mcpServers['foreign-thing'] = { command: '/bin/true' };
  fs.writeFileSync(mcpFile, `${JSON.stringify(doc, null, 2)}\n`);
  const ownedId = registry.mcp[0].id;

  // The lifecycle seeds removal planning with the ledger's ownership rows; mirror that here.
  const ownedRow = {
    harness: 'antigravity', scope: 'project', assetId: 'guidance.codex-pointer',
    target: mcpFile, ownershipIdentity: `doflow:antigravity:mcp-server:${ownedId}`,
    kind: 'mcp-server', identity: ownedId,
  };
  const removeContext = { ...input.context, operation: 'remove' };
  const seeded = { ...input, ledger: { resources: [ownedRow, ...input.ledger.resources.map((r) => ({ ...r, harness: 'antigravity' }))] } };
  const removalPlan = adapter.plan({ ...seeded, context: removeContext });
  adapter.remove({ ...seeded, changes: removalPlan.changes, context: removeContext });
  const after = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.ok(!Object.prototype.hasOwnProperty.call(after.mcpServers, ownedId));
  assert.deepEqual(after.mcpServers['foreign-thing'], { command: '/bin/true' }, 'a foreign server is never swept');
});

test('rules and workflows are workspace-scope only, landing under .agents/, and remove actually deletes', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scope: 'project', scopeRoot: root });
  const planned = adapter.plan(input);
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'rules', 'RULE_01_SAFETY.md')), 'workspace rules land under .agents/rules');
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'workflows', 'do-flow-chain.md')), 'the chain workflow lands under .agents/workflows');
  adapter.apply({ ...input, changes: planned.changes });
  assert.ok(fs.existsSync(path.join(root, '.agents', 'workflows', 'do-flow-chain.md')));

  // Regression guard: a removal plan routed through applyTree (which skips operation:'remove')
  // used to delete nothing while verification correctly refused to journal it.
  const ledgerAfterInstall = { resources: verifiedResources(adapter, input) };
  const removalPlan = adapter.plan({ ...input, context: { ...(input.context ?? {}), operation: 'remove' }, ledger: ledgerAfterInstall });
  adapter.apply({ ...input, changes: removalPlan.changes });
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'workflows', 'do-flow-chain.md')), 'remove must delete projected workflow files');

  const globalHome = scratch();
  const globalPlanned = adapter.plan(harnessInput(registry, { scope: 'global', scopeRoot: globalHome }));
  assert.ok(!globalPlanned.changes.some((c) => c.target.includes('.agents/rules') || c.target.includes('.agents/workflows')),
    'neither rules nor workflows have a documented user-scope home');
});

function verifiedResources(adapt, input) {
  const v = adapt.verify(input);
  return (v.resources || []).map((r) => ({ ...r, harness: 'antigravity', kind: r.kind || 'copy-tree-file' }));
}

test('hooks.antigravity projects both shims + their groups, verifies managed, and remove unmerges only its own', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scope: 'project', scopeRoot: root });
  const planned = adapter.plan(input);

  const scriptChanges = planned.changes.filter((c) => c.assetId === 'hooks.antigravity' && c.kind === 'copy-tree-file');
  const docChange = planned.changes.find((c) => c.assetId === 'hooks.antigravity' && c.kind === 'hooks-json');
  assert.deepEqual(scriptChanges.map((c) => c.identity).sort(), ['pre-implementation-gate.sh', 'stop-check.sh'],
    'both native-payload shims are projected');
  assert.ok(docChange, 'the hooks.json groups are registered');

  adapter.apply({ ...input, changes: planned.changes });
  const hooksJsonPath = path.join(root, '.agents', 'hooks.json');
  const doc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const entry = doc['doflow-pre-implementation-gate'].PreToolUse[0];
  assert.equal(entry.matcher, 'write_to_file|replace_file_content|multi_replace_file_content');
  assert.equal(entry.hooks[0].command, path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh'));
  expectExecutable(fs, entry.hooks[0].command, 'the shim must be executable');

  // PreToolUse registration keeps the documented matcher-wrapper shape.
  const gateEntry = doc['doflow-pre-implementation-gate'].PreToolUse[0];
  assert.equal(gateEntry.matcher, 'write_to_file|replace_file_content|multi_replace_file_content');
  assert.equal(gateEntry.hooks[0].command, path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh'));
  // Stop registration is matcher-free per Antigravity's docs: handlers sit directly under the key.
  const stopEntry = doc['doflow-stop-check'].Stop[0];
  assert.equal(stopEntry.command, path.join(root, '.agents', 'hooks', 'stop-check.sh'));
  if (process.platform !== 'win32') {   // GUARD: executable-bit semantics are POSIX-only
    for (const command of [gateEntry.hooks[0].command, stopEntry.command]) {
      assert.equal(fs.statSync(command).mode & 0o111, 0o111, `${path.basename(command)} must be executable`);
    }
  }

  // Verification journals the managed state with resource rows for both shims and the json.
  const verified = adapter.verify({ ...input });
  const hooksStatuses = verified.statuses.filter((s) => s.capability === 'hooks');
  assert.equal(hooksStatuses.length, 1);
  assert.equal(hooksStatuses[0].status, 'managed');
  const hookResources = verified.resources.filter((r) => r.assetId === 'hooks.antigravity');
  assert.deepEqual(hookResources.map((r) => r.identity).filter(Boolean).sort(), ['pre-implementation-gate.sh', 'stop-check.sh'],
    'verify journals one row per shim');
  assert.equal(hookResources.filter((r) => r.identity === undefined).length, 1,
    'verify journals the hooks.json registration row too');

  // Foreign groups survive; ours (both) do not — and both projected scripts go with theirs.
  fs.writeFileSync(hooksJsonPath, JSON.stringify({
    'user-own-group': { Stop: [{ type: 'command', command: './mine.sh' }] },
    'doflow-pre-implementation-gate': doc['doflow-pre-implementation-gate'],
    'doflow-stop-check': doc['doflow-stop-check'],
  }));
  const crypto = require('node:crypto');
  const ledgerRows = { resources: [
    { harness: 'antigravity', assetId: 'hooks.antigravity', kind: 'hooks-json',
      ownershipIdentity: 'antigravity:hooks:registration', target: hooksJsonPath },
    ...scriptChanges.map((c) => ({ harness: 'antigravity', assetId: 'hooks.antigravity', kind: 'copy-tree-file',
      identity: c.identity,
      fingerprint: crypto.createHash('sha256').update(fs.readFileSync(c.target)).digest('hex'),
      target: c.target })),
  ] };
  const removal = adapter.plan({ ...input, context: { ...(input.context ?? {}), operation: 'remove' }, ledger: ledgerRows });
  adapter.apply({ ...input, changes: removal.changes });
  const after = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  assert.ok(after['user-own-group'], 'foreign hook groups survive removal');
  assert.equal(after['doflow-pre-implementation-gate'], undefined, 'the owned gate group is removed');
  assert.equal(after['doflow-stop-check'], undefined, 'the owned stop group is removed');
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh')));
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'hooks', 'stop-check.sh')), 'the stop shim goes with its registration');
});

// ── pre-implementation-gate.sh shim stdin contract ─────────────────────────────
// Regression coverage for a real bug found during 022-normalize-hooks: the canonical policy's
// tool-name matcher initially omitted Antigravity's own native tool names (write_to_file,
// replace_file_content, multi_replace_file_content), which would have silently disabled this gate
// for Antigravity — always-allow regardless of feature state.

const { execFileSync } = require('node:child_process');

// Front doors resolve the Canonical Policy Library via a path relative to their installed
// location, not their source location — see build-install-mirror.sh for why this mirror exists.
const HOOKS_MIRROR = path.join(REPO, 'tmp', 'hooks-mirror');
execFileSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), HOOKS_MIRROR]);
const GATE_SHIM = path.join(HOOKS_MIRROR, '.antigravity', 'hooks', 'pre-implementation-gate.sh');

function runGateShim(payload) {
  try {
    const stdout = execFileSync('bash', [GATE_SHIM], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
}

const SHIM_TEST = process.platform !== 'win32' ? test : test.skip;   // GUARD: needs bash + jq

SHIM_TEST('pre-implementation-gate shim recognizes Antigravity\'s own native tool names', () => {
  const result = runGateShim({
    toolCall: { name: 'view_file', args: {} },
    workspacePaths: [REPO],
  });
  assert.equal(result.code, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'allow', 'a non-mutating tool must never trip the gate');
});

SHIM_TEST('pre-implementation-gate shim denies write_to_file when a started feature is missing specs', () => {
  const scratchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-agy-gate-'));
  execFileSync('git', ['init', '-q'], { cwd: scratchRepo });
  execFileSync('git', ['checkout', '-q', '-b', 'feat/999-scratch'], { cwd: scratchRepo });
  fs.mkdirSync(path.join(scratchRepo, 'agent-docs', 'doflow', '999-scratch'), { recursive: true });
  fs.writeFileSync(path.join(scratchRepo, 'agent-docs', 'doflow', '999-scratch', 'requirement.md'), '');

  for (const toolName of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    const result = runGateShim({
      toolCall: { name: toolName, args: { TargetFile: 'src/foo.js' } },
      workspacePaths: [scratchRepo],
    });
    assert.equal(result.code, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'deny', `${toolName} must be recognized and denied`);
  }
});

// ── stop-check.sh shim stdin contract ─────────────────────────────────────────
// The shim translates Antigravity's documented Stop payload into the same gate Claude's stop-check
// enforces. Its defining property is fail-open: every ambiguity exits 0 silently, because a stop
// hook that breaks session ending is worse than an under-gated one.

const STOP_SHIM = path.join(HOOKS_MIRROR, '.antigravity', 'hooks', 'stop-check.sh');

function runStopShim(payload) {
  const { execFileSync } = require('node:child_process');
  try {
    const stdout = execFileSync('bash', [STOP_SHIM], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
}

function transcriptWith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-agy-transcript-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

SHIM_TEST('stop-check shim blocks with the documented {decision:continue} when the last response carries stubs', () => {
  const transcript = transcriptWith([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Writing the module now.' },
    { role: 'assistant', content: "Done except one spot:\n\n// TODO: wire the retry path" },
  ]);
  const { code, stdout } = runStopShim({ executionNum: 1, terminationReason: 'model_stop', fullyIdle: true, transcriptPath: transcript });
  assert.equal(code, 0);
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'continue');
  assert.match(decision.reason, /[Tt][Oo][Dd][Oo]|stub/);
});

SHIM_TEST('stop-check shim lets a clean response end the session silently', () => {
  const transcript = transcriptWith([
    { role: 'assistant', content: 'All done; tests pass. I removed the TODO comment as requested.' },
  ]);
  const { code, stdout } = runStopShim({ executionNum: 2, terminationReason: 'model_stop', fullyIdle: true, transcriptPath: transcript });
  assert.equal(code, 0);
  assert.equal(stdout, '', 'an allow is silence, not JSON');
});

SHIM_TEST('stop-check shim fails open on every ambiguity', () => {
  const transcript = transcriptWith([{ role: 'assistant', content: '// TODO unfinished' }]);
  for (const [name, payload] of Object.entries({
    'empty stdin': '',
    'garbage stdin': '{definitely not json',
    'missing transcriptPath': { executionNum: 1, fullyIdle: true },
    'nonexistent transcript': { executionNum: 1, transcriptPath: '/nowhere/transcript.jsonl' },
    'foreign transcript schema': { executionNum: 1, transcriptPath: transcriptWith([{ message: 'no role field here' }]) },
  })) {
    const outcome = runStopShim(payload);
    assert.equal(outcome.code, 0, `${name}: must exit 0`);
    assert.equal(outcome.stdout, '', `${name}: must stay silent`);
  }
});
