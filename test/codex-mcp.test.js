'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MCP_KIND, readCodexMcpCatalog, resolveCodexMcpSelection, renderServer, resourceFor,
  reconcileCodexMcp,
} = require('../src/adapters/codex/mcp');
const { loadRegistry } = require('../src/registry');

const REPO = path.resolve(__dirname, '..');
const REGISTRY = loadRegistry({ repoRoot: REPO });
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-mcp-')); }
function catalog() { return readCodexMcpCatalog(REGISTRY); }
function options(file, selected, extra = {}) { return { file, scope: 'project', selected, ...catalog(), ...extra }; }

test('uses the shared curated catalog and existing selection precedence', () => {
  const { allServers } = catalog();
  assert.deepStrictEqual(allServers, ['context7', 'sequential-thinking']);
  assert.deepStrictEqual(resolveCodexMcpSelection({ cmd: 'update', requested: null, allServers, manifestServers: ['sequential-thinking'], interactive: true, promptFn: () => { throw new Error('must not prompt'); } }), ['sequential-thinking']);
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
