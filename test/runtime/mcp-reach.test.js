'use strict';

// mcpReach over scratch ledgers and MCP files, with the real adapters: per-server states, the
// catalog flag, anyHarnessHas, addCommand, unreadable configs and determinism (IC-012, IC-013).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry');
const { buildAdapterRegistry } = require('../../src/cli/shared');
const { mcpReach } = require('../../src/runtime/mcp-reach');

// A developer's PI_CODING_AGENT_DIR would send Pi's user-scope MCP file outside the scratch home.
delete process.env.PI_CODING_AGENT_DIR;

const registry = loadRegistry({ repoRoot: REPO_ROOT });
const adapters = buildAdapterRegistry();
const SERVER_IDS = registry.mcp.map((server) => server.id);
const [FIRST, SECOND] = SERVER_IDS;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture(t) {
  const dir = tempDir(t, 'doflow-mcp-reach-');
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  return { home, proj };
}

/** A ledger with a skills row per harness and an `mcp-server` row per selected server. */
function ledger(root, scope, { harnesses = [], selected = {} }) {
  const resources = [
    ...harnesses.map((harness) => ({ harness, assetId: 'skills.doflow', kind: 'copy-tree-file' })),
    ...Object.entries(selected).flatMap(([harness, ids]) => ids.map((identity) => ({ harness, kind: 'mcp-server', identity, target: 'x' }))),
  ];
  write(path.join(root, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope, scopeRoot: root, targets: {}, mcpSelections: {}, resources, legacyImports: [],
  }));
}

/** The real adapters, with the named ones claiming a complete view (`mcpComplete: true`) the way an
 * adapter that reads every source its harness merges would. No shipped adapter claims it today. */
function completeAdapters(...ids) {
  return { get: (name) => {
    const adapter = adapters.get(name);
    if (!ids.includes(name)) return adapter;
    return { ...adapter, discover: (input) => ({ ...adapter.discover(input), mcpComplete: true }) };
  } };
}

function reach(f, extra = {}) {
  return mcpReach({ registry, projectRoot: f.proj, homeDir: f.home, adapters, ...extra });
}

const rowOf = (result, harness, scope) => result.harnesses.find((row) => row.id === harness && row.scope === scope);

test('per-server states: selected, configured, unknown where absence is no proof, and the catalog flag', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [FIRST] } });
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: { [FIRST]: {}, semble: {} } }));
  const row = rowOf(reach(f), 'claude', 'project');
  assert.equal(row.catalog, 'taken');
  assert.equal(row.servers[FIRST], 'selected');
  assert.equal(row.servers.semble, 'configured', 'a provider mcp.server is reported too');
  assert.equal(row.servers[SECOND], 'unknown', 'Claude loads servers DoFlow cannot read, so absence is not proof');
  assert.equal(row.note, undefined);
  assert.equal(rowOf(reach(f, { adapters: completeAdapters('claude') }), 'claude', 'project').servers[SECOND], 'not-selected',
    'not-selected needs an adapter that read every source');
});

test('a harness whose capabilities.mcp.status is not supported is not-taken and carries the note', (t) => {
  const f = fixture(t);
  ledger(f.home, 'global', { harnesses: ['gemini'] });
  const result = reach(f);
  const row = rowOf(result, 'gemini', 'global');
  assert.equal(row.catalog, 'not-taken');
  assert.match(row.note, /adapter-supported MCP registration/);
  assert.equal(row.servers[FIRST], 'unknown', 'no settings read: Gemini cannot say');
  write(path.join(f.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: {} }));
  assert.equal(rowOf(reach(f), 'gemini', 'global').servers[FIRST], 'unknown', 'Gemini merges system settings and extensions DoFlow does not read');
  assert.equal(rowOf(reach(f, { adapters: completeAdapters('gemini') }), 'gemini', 'global').servers[FIRST], 'not-taken');
  write(path.join(f.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { [FIRST]: {} } }));
  assert.equal(rowOf(reach(f), 'gemini', 'global').servers[FIRST], 'configured', 'a hand-configured server shows');
});

test('unknown: nothing selected and the MCP file is absent', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [FIRST] } });
  const row = rowOf(reach(f), 'claude', 'project');
  assert.equal(row.servers[FIRST], 'selected');
  assert.equal(row.servers[SECOND], 'unknown');
});

test('anyHarnessHas returns true, false and null (unknown)', (t) => {
  const f = fixture(t);
  assert.equal(reach(f).anyHarnessHas(FIRST), null, 'no harness installed');
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [FIRST] } });
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: { [FIRST]: {}, other: {} } }));
  const result = reach(f);
  assert.equal(result.anyHarnessHas(FIRST), true);
  assert.equal(result.anyHarnessHas('other'), true, 'configured by hand');
  assert.equal(result.anyHarnessHas(SECOND), null, 'Claude absence is never proof');
  assert.equal(reach(f, { adapters: completeAdapters('claude') }).anyHarnessHas(SECOND), false, 'every row read every source and says not-selected');
  fs.rmSync(path.join(f.proj, '.mcp.json'));
  assert.equal(reach(f, { adapters: completeAdapters('claude') }).anyHarnessHas(SECOND), null, 'an absent MCP file cannot say');
});

test('anyHarnessHas is false when every row is not-selected or not-taken', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  ledger(f.home, 'global', { harnesses: ['gemini'] });
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  write(path.join(f.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: {} }));
  assert.equal(reach(f, { adapters: completeAdapters('claude', 'gemini') }).anyHarnessHas(FIRST), false);
  assert.equal(reach(f, { adapters: completeAdapters('claude') }).anyHarnessHas(FIRST), null, 'one row without a complete view keeps it unknown');
  assert.equal(reach(f).anyHarnessHas(FIRST), null);
});

test('repro (062 X1): a Claude local-scope server in ~/.claude.json counts, and an absent one is unknown, not absent', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));
  write(path.join(f.home, '.claude.json'), JSON.stringify({ projects: { [f.proj]: { mcpServers: { [FIRST]: {} } } } }));
  const result = reach(f);
  const row = rowOf(result, 'claude', 'project');
  assert.equal(row.servers[FIRST], 'configured');
  assert.equal(row.servers[SECOND], 'unknown');
  assert.equal(result.anyHarnessHas(FIRST), true);
  assert.equal(result.anyHarnessHas(SECOND), null);
});

test('repro (062 X1): Gemini servers in ~/.gemini/settings.json with no project settings count, and an absent one is unknown', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['gemini'] });
  write(path.join(f.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { [FIRST]: {} } }));
  const result = reach(f);
  const row = rowOf(result, 'gemini', 'project');
  assert.equal(row.servers[FIRST], 'configured');
  assert.equal(row.servers[SECOND], 'unknown');
  assert.equal(result.anyHarnessHas(SECOND), null);
});

test('addCommand: project and global scope, servers already selected in registry order, and a not-taken harness', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [SECOND] } });
  ledger(f.home, 'global', { harnesses: ['claude', 'gemini'], selected: { claude: [] } });
  const result = reach(f);
  assert.equal(result.addCommand('claude', 'project', FIRST), `doflow install --target claude --mcp ${FIRST},${SECOND}`);
  assert.equal(result.addCommand('claude', 'project', SECOND), `doflow install --target claude --mcp ${SECOND}`);
  assert.equal(result.addCommand('claude', 'global', FIRST), `doflow install -g --target claude --mcp ${FIRST}`);
  assert.equal(result.addCommand('gemini', 'global', FIRST),
    "configure it in Gemini CLI's own MCP settings; DoFlow's catalog does not reach it");
  assert.match(result.addCommand('claude', 'project', 'semble'), /^configure it in Claude Code's own MCP settings/,
    'a server outside the catalog cannot be installed by DoFlow');
});

test('an unreadable MCP config lands in unreadable and its servers are unknown', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  write(path.join(f.proj, '.mcp.json'), '{ not json');
  const result = reach(f);
  assert.deepEqual(result.unreadable, [{ harness: 'claude', scope: 'project', detail: 'invalid JSON', file: path.join(f.proj, '.mcp.json') }]);
  assert.equal(rowOf(result, 'claude', 'project').servers[FIRST], 'unknown');
  assert.equal(reach(f, { adapters: completeAdapters('claude') }).anyHarnessHas(FIRST), null);
});

test('a fixture registry with an extra server reaches the result with no code change', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'acme-docs': {} } }));
  const extended = { ...registry, mcp: [...registry.mcp, { ...registry.mcp[0], id: 'acme-docs' }] };
  const row = rowOf(reach(f, { registry: extended }), 'claude', 'project');
  assert.equal(row.servers['acme-docs'], 'configured');
  assert.equal(row.servers[FIRST], 'unknown');
  const plain = rowOf(reach(f), 'claude', 'project');
  assert.equal(Object.hasOwn(plain.servers, 'acme-docs'), false);
});

test('the same inputs twice give byte-identical JSON and the result is plain data', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [FIRST] } });
  ledger(f.home, 'global', { harnesses: ['gemini', 'codex'] });
  const a = JSON.stringify(reach(f));
  assert.equal(a, JSON.stringify(reach(f)));
  assert.deepEqual(Object.keys(JSON.parse(a)).sort(), ['harnesses', 'unreadable']);
});

test('every registered harness answers at both scopes without an unreadable entry', (t) => {
  const f = fixture(t);
  const all = registry.harnesses.map((harness) => harness.id);
  ledger(f.proj, 'project', { harnesses: all });
  ledger(f.home, 'global', { harnesses: all });
  const result = reach(f);
  assert.deepEqual(result.unreadable, []);
  assert.equal(result.harnesses.length, all.length * 2);
  for (const row of result.harnesses) assert.ok(Object.hasOwn(row.servers, FIRST), `${row.id} ${row.scope}`);
});
