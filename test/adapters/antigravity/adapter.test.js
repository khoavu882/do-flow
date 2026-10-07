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

// ---- MCP entries, owned per server through ledger rows ----

const CONTEXT7 = { id: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const SEQUENTIAL = { id: 'sequential-thinking', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
const ENTRIES = { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } };
const USER_SERVER = { command: 'my-own-server', env: { TOKEN: 'secret-value' } };

// User scope keeps these cases to the MCP file: no instructions, skills or hooks are planned there.
function userMcpFile(home) { return path.join(home, '.gemini', 'config', 'mcp_config.json'); }

function writeUserMcp(home, doc) {
  fs.mkdirSync(path.dirname(userMcpFile(home)), { recursive: true });
  fs.writeFileSync(userMcpFile(home), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function readUserMcp(home) { return JSON.parse(fs.readFileSync(userMcpFile(home), 'utf8')); }

/** One run the way the lifecycle drives an adapter: discover, plan, apply or remove, verify. The
 * returned ledger drops the rows the plan removed or released and takes the MCP rows verify reports,
 * as updateLedger does. */
function runMcp({ home, mcp = [], mcpAdoptable = [], ledger = { resources: [] }, removing = false }) {
  const operation = removing ? 'remove' : 'apply';
  const input = { scope: 'global', scopeRoot: home, assets: [], mcp, mcpAdoptable, ledger, context: { repoRoot: REPO, operation } };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  if (!planned.conflicts.length) adapter[removing ? 'remove' : 'apply']({ ...input, changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation });
  const dropped = new Set(planned.changes.filter((change) => change.operation === 'remove').map((change) => change.ownershipIdentity));
  const added = verified.resources.filter((resource) => resource.kind === 'mcp-server').map((resource) => ({ ...resource, harness: 'antigravity' }));
  const kept = ledger.resources.filter((row) => !dropped.has(row.ownershipIdentity) && !added.some((item) => item.ownershipIdentity === row.ownershipIdentity));
  const mcpNotices = planned.notices.filter((notice) => notice.startsWith('MCP:'));
  return { discovery, planned, mcpNotices, verified, ledger: { resources: [...kept, ...added] } };
}

test('mcp: installs each selected server under a fingerprinted row and re-plans to nothing', () => {
  const home = scratch();
  writeUserMcp(home, { mcpServers: { 'user-server': USER_SERVER } });
  const first = runMcp({ home, mcp: [CONTEXT7] });
  assert.deepEqual(first.planned.conflicts, []);
  assert.deepEqual(readUserMcp(home).mcpServers, { 'user-server': USER_SERVER, context7: ENTRIES.context7 });
  assert.deepEqual(first.ledger.resources.map((row) => [row.ownershipIdentity, row.identity, row.target, typeof row.fingerprint]),
    [['doflow:antigravity:mcp-server:context7', 'context7', userMcpFile(home), 'string']]);
  assert.equal(first.verified.ok, true);

  const again = runMcp({ home, mcp: [CONTEXT7], ledger: first.ledger });
  assert.deepEqual(again.discovery.mcpOwned, ['context7']);
  assert.deepEqual(again.planned.changes, []);
});

test('A3 antigravity: a narrower selection removes the deselected owned entry, and none removes every owned entry', () => {
  const home = scratch();
  writeUserMcp(home, { otherKey: true });
  const both = runMcp({ home, mcp: [CONTEXT7, SEQUENTIAL] });
  assert.deepEqual(Object.keys(readUserMcp(home).mcpServers), ['context7', 'sequential-thinking']);

  const narrower = runMcp({ home, mcp: [SEQUENTIAL], ledger: both.ledger });
  assert.deepEqual(Object.keys(readUserMcp(home).mcpServers), ['sequential-thinking']);
  assert.deepEqual(narrower.ledger.resources.map((row) => row.identity), ['sequential-thinking']);

  const none = runMcp({ home, mcp: [], ledger: narrower.ledger });
  assert.deepEqual(readUserMcp(home), { otherKey: true, mcpServers: {} }, 'the emptied mcpServers object is kept; every other key stays');
  assert.deepEqual(none.ledger.resources, []);
});

test('A4 antigravity: remove with an empty selection removes the owned servers and keeps the user\'s', () => {
  const home = scratch();
  writeUserMcp(home, { mcpServers: { 'user-server': USER_SERVER } });
  const installed = runMcp({ home, mcp: [CONTEXT7, SEQUENTIAL] });

  const removed = runMcp({ home, mcp: [], ledger: installed.ledger, removing: true });
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release ?? false]),
    [['doflow:antigravity:mcp-server:context7', false], ['doflow:antigravity:mcp-server:sequential-thinking', false]]);
  assert.deepEqual(readUserMcp(home), { mcpServers: { 'user-server': USER_SERVER } });
  assert.equal(removed.verified.ok, true);
  assert.deepEqual(removed.ledger.resources, []);
});

test('mcp: a row recorded without a fingerprint owns its entry only while it equals DoFlow\'s rendering', () => {
  const home = scratch();
  const edited = { ...ENTRIES['sequential-thinking'], env: { DEBUG: '1' } };
  writeUserMcp(home, { mcpServers: { context7: ENTRIES.context7, 'sequential-thinking': edited } });
  const before = fs.readFileSync(userMcpFile(home));
  const unfingerprinted = { resources: ['context7', 'sequential-thinking'].map((id) => ({
    harness: 'antigravity', scope: 'global', assetId: 'guidance.codex-pointer', target: userMcpFile(home),
    ownershipIdentity: `doflow:antigravity:mcp-server:${id}`, kind: 'mcp-server', identity: id, fingerprint: null,
  })) };

  const installed = runMcp({ home, mcp: [CONTEXT7, SEQUENTIAL], ledger: unfingerprinted });
  assert.deepEqual(installed.discovery.mcpOwned, ['context7']);
  assert.deepEqual(installed.planned.changes.map((change) => [change.identity, change.operation, change.release ?? false]),
    [['sequential-thinking', 'remove', true]]);
  assert.deepEqual(installed.mcpNotices,
    ["MCP: entry 'sequential-thinking' in mcp_config.json was changed outside DoFlow; it is yours now and DoFlow no longer updates or removes it."]);
  assert.deepEqual(fs.readFileSync(userMcpFile(home)), before, 'nothing is written');
  assert.deepEqual(installed.ledger.resources.map((row) => [row.identity, typeof row.fingerprint]), [['context7', 'string']]);
});

test('A5 antigravity: a same-named user entry is kept through install and remove', () => {
  const home = scratch();
  writeUserMcp(home, { mcpServers: { context7: USER_SERVER } });
  const before = fs.readFileSync(userMcpFile(home));

  const installed = runMcp({ home, mcp: [CONTEXT7] });
  assert.deepEqual(installed.planned.changes, []);
  assert.deepEqual(installed.mcpNotices,
    ["MCP: kept your own entry 'context7' in mcp_config.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.equal(installed.verified.statuses.find((status) => status.capability === 'mcp').status, 'not-managed');
  assert.deepEqual(installed.ledger.resources, []);

  runMcp({ home, ledger: installed.ledger, removing: true });
  assert.deepEqual(fs.readFileSync(userMcpFile(home)), before);
});

test('A6 antigravity: a malformed mcp_config.json is an install conflict and a remove release, and is never written', () => {
  const home = scratch();
  const owned = runMcp({ home, mcp: [CONTEXT7] });
  writeUserMcp(home, '{ "mcpServers": { "secret-value": ');

  const installed = runMcp({ home, mcp: [CONTEXT7], ledger: owned.ledger });
  assert.deepEqual(installed.planned.conflicts, [`Antigravity MCP: ${userMcpFile(home)}: invalid JSON; DoFlow did not change the file`]);
  assert.deepEqual(installed.planned.changes, []);
  assert.doesNotMatch(JSON.stringify(installed.planned), /secret-value/);

  const removed = runMcp({ home, ledger: owned.ledger, removing: true });
  assert.deepEqual(removed.planned.conflicts, []);
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release]), [['doflow:antigravity:mcp-server:context7', true]]);
  assert.match(removed.mcpNotices[0], /^MCP: left .*mcp_config\.json untouched because it cannot be edited safely/);
  assert.equal(fs.readFileSync(userMcpFile(home), 'utf8'), '{ "mcpServers": { "secret-value": ');
  assert.deepEqual(removed.ledger.resources, []);
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

const RUNTIME_ASSETS = [
  { id: 'scripts.doflow', source: 'core/shared/scripts', nativeDir: '../.doflow/scripts' },
  { id: 'runtime.cli', source: 'bin', nativeDir: '../.doflow/runtime/bin' },
  { id: 'runtime.lib', source: 'src', nativeDir: '../.doflow/runtime/src' },
  { id: 'runtime.registry', source: 'core/registry', nativeDir: '../.doflow/runtime/core/registry' },
].map((asset) => ({ ...asset, renderer: 'copy-tree', capability: 'scripts' }));

test('project plan reads its hook source from context.repoRoot, not the working directory', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root });
  const cwd = process.cwd();
  process.chdir(root);
  let planned;
  try { planned = adapter.plan(input); } finally { process.chdir(cwd); }
  assert.equal(planned.conflicts.length, 0);
  assert.ok(planned.changes.some((c) => c.assetId === 'hooks.antigravity' && c.kind === 'hooks-json'));
  assert.ok(planned.changes.some((c) => c.assetId === 'hooks.antigravity' && c.identity === 'stop-check.sh'));
});

test('the four runtime assets plan under <project>/.doflow at project scope and nothing at global scope', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const runtimeIds = new Set(RUNTIME_ASSETS.map((asset) => asset.id));
  const runtimeTargets = (planned) => planned.changes.filter((c) => runtimeIds.has(c.assetId)).map((c) => c.target);

  const project = scratch();
  const projectInput = harnessInput(registry, { scopeRoot: project });
  const projectTargets = runtimeTargets(adapter.plan({ ...projectInput, assets: [...projectInput.assets, ...RUNTIME_ASSETS] }));
  assert.ok(projectTargets.length > 0, 'project scope plans the runtime');
  assert.ok(projectTargets.every((target) => target.startsWith(path.join(project, '.doflow') + path.sep)), 'every runtime target sits under <project>/.doflow');
  assert.ok(projectTargets.includes(path.join(project, '.doflow', 'runtime', 'bin', 'doflow.js')));
  assert.ok(projectTargets.includes(path.join(project, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')));

  const home = scratch();
  const globalInput = harnessInput(registry, { scope: 'global', scopeRoot: home });
  const globalPlan = adapter.plan({ ...globalInput, assets: [...globalInput.assets, ...RUNTIME_ASSETS] });
  assert.deepEqual(runtimeTargets(globalPlan), [], 'global scope plans no runtime target');
  assert.ok(!fs.existsSync(path.join(home, '.doflow')));
});

test('global scope carries the no-skills notice, project scope and removal carry none', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const global = harnessInput(registry, { scope: 'global', scopeRoot: scratch() });
  const [notice, ...rest] = adapter.plan(global).notices;
  assert.deepEqual(rest, []);
  assert.match(notice, /^no skills at global scope \(the user-scope skills location is unresolved\)/);
  assert.match(notice, /install per project with: npx @khoavu882\/doflow install -t antigravity$/);
  assert.ok(notice.length <= 200 && !/[\u0000-\u001f]/.test(notice), 'a notice is one line of at most 200 characters');

  const removing = { ...global, context: { ...global.context, operation: 'remove' } };
  assert.deepEqual(adapter.plan(removing).notices, [], 'removal prints no notice');
  assert.deepEqual(adapter.plan(harnessInput(registry, { scopeRoot: scratch() })).notices, [], 'project scope has skills, so no notice');
});
