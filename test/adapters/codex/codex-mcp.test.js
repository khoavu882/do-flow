'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MCP_KIND, readCodexMcpCatalog, renderServer, resourceFor,
  reconcileCodexMcp, ownedCodexMcpIds,
} = require('../../../src/adapters/codex/mcp');
const codexAdapter = require('../../../src/adapters/codex');
const { loadRegistry } = require('../../../src/registry');

const REPO = path.resolve(__dirname, "../../..");
const REGISTRY = loadRegistry({ repoRoot: REPO });
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-mcp-')); }
function catalog() { return readCodexMcpCatalog(REGISTRY); }
function options(file, selected, extra = {}) { return { file, scope: 'project', selected, ...catalog(), ...extra }; }

test('uses the shared curated catalog', () => {
  assert.deepStrictEqual(catalog().allServers, ['context7', 'sequential-thinking']);
});

test('C1 codex: discover reports as owned only the owned tables still holding what DoFlow recorded', () => {
  const root = scratch();
  const file = path.join(root, '.codex', 'config.toml');
  const { serverDefs } = catalog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const edited = { ...serverDefs['sequential-thinking'], args: ['--edited'] };
  fs.writeFileSync(file, `${renderServer('context7', serverDefs.context7)}\n${renderServer('sequential-thinking', edited)}\n[mcp_servers.personal]\ncommand = "keep"\n`);
  const rows = ['context7', 'sequential-thinking'].map((name) => ({
    ...resourceFor({ name, scope: 'project', definition: serverDefs[name] }), harness: 'codex', target: file,
  }));
  assert.deepStrictEqual(ownedCodexMcpIds({ file, scope: 'project', managedResources: rows.map((row) => ({ ...row, target: 'codex' })) }), ['context7']);
  assert.deepStrictEqual(codexAdapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: rows } }).mcpOwned, ['context7']);
  assert.deepStrictEqual(codexAdapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: [] } }).mcpOwned, [], 'a table with no row is the user\'s');
  fs.writeFileSync(file, '[mcp_servers.context7\n');
  assert.deepStrictEqual(codexAdapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: rows } }).mcpOwned, [], 'an unparseable file owns nothing');
});

test('creates selected Codex MCP tables and records only owned resources', () => {
  const file = path.join(scratch(), 'config.toml');
  const result = reconcileCodexMcp(options(file, ['context7']));
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n');
  assert.deepStrictEqual(result.managedResources.map((item) => [item.kind, item.identity]), [[MCP_KIND, 'context7']]);
});

test('updates a proven-owned server to the current catalog definition', () => {
  const file = path.join(scratch(), 'config.toml');
  const { serverDefs } = catalog();
  const old = { command: 'old-context7' };
  fs.writeFileSync(file, renderServer('context7', old));
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: old })];
  const result = reconcileCodexMcp(options(file, ['context7'], { managedResources: managed }));
  assert.equal(result.applied, true);
  assert.match(fs.readFileSync(file, 'utf8'), /@upstash\/context7-mcp/);
  assert.equal(result.managedResources[0].fingerprint, resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 }).fingerprint);
});

test('deselect removes only an unmodified DoFlow-owned table', () => {
  const file = path.join(scratch(), 'config.toml');
  const { serverDefs } = catalog();
  fs.writeFileSync(file, `${renderServer('context7', serverDefs.context7)}\n[mcp_servers.personal]\ncommand = "keep"\n`);
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })];
  const result = reconcileCodexMcp(options(file, [], { managedResources: managed }));
  assert.equal(result.applied, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /mcp_servers\.context7/);
  assert.match(text, /mcp_servers\.personal/);
  assert.deepStrictEqual(result.managedResources, []);
});

test('deselect does not consume a non-MCP table after the owned MCP table', () => {
  const file = path.join(scratch(), 'config.toml');
  const { serverDefs } = catalog();
  fs.writeFileSync(file, `${renderServer('context7', serverDefs.context7)}\n[features]\nhooks = true\n`);
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })];
  reconcileCodexMcp(options(file, [], { managedResources: managed }));
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\nhooks = true\n');
});

test('preserves unrelated and pre-existing user-owned server registrations', () => {
  const file = path.join(scratch(), 'config.toml');
  const before = '[mcp_servers.personal]\ncommand = "keep"\n\n[mcp_servers.context7]\ncommand = "custom"\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexMcp(options(file, ['context7']));
  assert.equal(result.status, 'unchanged');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(result.managedResources, []);
});

test('fails closed for malformed configuration', () => {
  const file = path.join(scratch(), 'config.toml'); const before = '[mcp_servers.context7\ncommand = "npx"\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexMcp(options(file, ['context7']));
  assert.equal(result.status, 'malformed');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('dry-run supplies plan and ownership records without writing', () => {
  const file = path.join(scratch(), 'config.toml');
  const result = reconcileCodexMcp(options(file, ['sequential-thinking'], { dryRun: true }));
  assert.equal(result.status, 'change');
  assert.equal(result.applied, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(result.changes[0].type, 'create');
  assert.equal(result.managedResources[0].identity, 'sequential-thinking');
});

// --- a user's own server, release and the conflict that names it ---------------
const { planCodexMcp } = require('../../../src/adapters/codex/mcp');
const { NOTICES } = require('../../../src/adapters/mcp-entries');

function plannedOver(text, selected, extra = {}) {
  const file = path.join(scratch(), 'config.toml');
  if (text !== null) fs.writeFileSync(file, text);
  return { file, plan: planCodexMcp(options(file, selected, { scopeArg: '-g', ...extra })) };
}

test('a selected server the user already defines, in any form, is kept with no change, no record and one notice', () => {
  const { serverDefs } = catalog();
  for (const text of [
    '[mcp_servers.context7]\ncommand = "x"\n',
    '[mcp_servers."context7"]\ncommand = "x"\n',
    'mcp_servers.context7.command = "x"\n',
    renderServer('context7', serverDefs.context7),
  ]) {
    const { file, plan } = plannedOver(text, ['context7']);
    assert.equal(plan.ok, true, text);
    assert.deepStrictEqual(plan.changes, [], text);
    assert.deepStrictEqual(plan.managedResources, [], text);
    assert.deepStrictEqual(plan.notices, [NOTICES.collision('context7', file)], text);
    assert.deepStrictEqual(plan.userDefined, ['context7'], text);
    assert.equal(plan.content, text, text);
  }
});

test('an unselected server the user defines gives no notice', () => {
  const { plan } = plannedOver('[mcp_servers.context7]\ncommand = "x"\n', []);
  assert.deepStrictEqual(plan.changes, []);
  assert.deepStrictEqual(plan.notices, []);
});

test('an owned row whose table the user changed is released when a run does not select it', () => {
  const { serverDefs } = catalog();
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })];
  for (const text of ['[mcp_servers.context7]\ncommand = "mine"\n', '[mcp_servers."context7"]\ncommand = "npx"\n']) {
    const { file, plan } = plannedOver(text, [], { managedResources: managed });
    assert.equal(plan.ok, true, text);
    assert.deepStrictEqual(plan.changes, [{ type: 'remove', identity: 'context7', release: true }], text);
    assert.deepStrictEqual(plan.notices, [NOTICES.released('context7', file)], text);
    assert.equal(plan.content, text, 'a release edits no line');
    assert.deepStrictEqual(plan.managedResources, []);
  }
});

test('an owned row whose table the user changed is a conflict naming the update that releases it', () => {
  const { serverDefs } = catalog();
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })];
  const text = '[mcp_servers.context7]\ncommand = "mine"\n';
  for (const [selected, removing, rest] of [
    [['context7'], false, 'none'],
    [[], true, 'none'],
    [['context7', 'sequential-thinking'], false, 'sequential-thinking'],
  ]) {
    const { file, plan } = plannedOver(text, selected, { managedResources: managed, removing });
    assert.equal(plan.status, 'conflict');
    assert.deepStrictEqual(plan.conflicts, [`MCP server 'context7' was modified outside DoFlow. If this table is yours, run: doflow update -g -t codex --mcp ${rest}; DoFlow then stops managing it and keeps the table.`]);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('a DoFlow-owned unchanged table is still updated and removed, with no notice', () => {
  const { serverDefs } = catalog();
  const old = { command: 'old-context7' };
  const updated = plannedOver(renderServer('context7', old), ['context7'], { managedResources: [resourceFor({ name: 'context7', scope: 'project', definition: old })] }).plan;
  assert.deepStrictEqual(updated.changes.map((change) => change.type), ['update']);
  assert.deepStrictEqual(updated.notices, []);
  const removed = plannedOver(renderServer('context7', serverDefs.context7), [], { managedResources: [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })] }).plan;
  assert.deepStrictEqual(removed.changes.map((change) => [change.type, change.release]), [['remove', undefined]]);
  assert.equal(removed.content, '');
  assert.deepStrictEqual(removed.notices, []);
});

test('a server the user defines inside an [mcp_servers] table is the user\'s, so nothing is appended', () => {
  const before = '[mcp_servers]\ncontext7 = { command = "x" }\n';
  const { file, plan } = plannedOver(before, ['context7']);
  assert.equal(plan.ok, true);
  assert.deepStrictEqual(plan.changes, []);
  assert.deepStrictEqual(plan.notices, [NOTICES.collision('context7', file)]);
  assert.equal(plan.content, before);
});

test('an MCP table that would make the file invalid TOML is refused with nothing written', () => {
  const before = 'mcp_servers = { other = { command = "y" } }\n';
  const { file, plan } = plannedOver(before, ['context7']);
  assert.equal(plan.status, 'conflict');
  assert.match(plan.conflicts[0], /DoFlow cannot write 'context7' without making the file invalid TOML \(table-and-value 'mcp_servers' on line 3\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a user comment written after DoFlow\'s last table is not part of that table, and remove keeps it', () => {
  const appended = '\n# my profiles\n[profiles.fast]\nmodel = "a"\n';
  for (const [before, after] of [['[features]\nx = 1\n', appended], ['', '# mine\n']]) {
    const file = path.join(scratch(), 'config.toml');
    if (before) fs.writeFileSync(file, before);
    const installed = reconcileCodexMcp(options(file, ['context7']));
    fs.appendFileSync(file, after);
    const edited = fs.readFileSync(file, 'utf8');
    const reinstall = planCodexMcp(options(file, ['context7'], { managedResources: installed.managedResources }));
    assert.equal(reinstall.status, 'unchanged', JSON.stringify(reinstall.conflicts));
    const removed = reconcileCodexMcp(options(file, [], { managedResources: installed.managedResources }));
    assert.deepStrictEqual(removed.changes.map((change) => [change.type, change.release]), [['remove', undefined]]);
    assert.equal(fs.readFileSync(file, 'utf8'), `${before}${after}`, `from ${JSON.stringify(edited)}`);
  }
});

test('the conflict quotes a project root that a shell would split', () => {
  const { serverDefs } = catalog();
  const managed = [resourceFor({ name: 'context7', scope: 'project', definition: serverDefs.context7 })];
  const { plan } = plannedOver('[mcp_servers.context7]\ncommand = "mine"\n', ['context7'], { managedResources: managed, scopeArg: "/tmp/my proj's" });
  assert.match(plan.conflicts[0], /run: doflow update '\/tmp\/my proj'\\''s' -t codex --mcp none;/);
});
