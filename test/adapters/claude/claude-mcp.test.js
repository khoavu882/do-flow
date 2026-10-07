'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createClaudeAdapter } = require('../../../src/adapters/claude');

const CONTEXT7 = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const SEQUENTIAL = { id: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
const ENTRIES = { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } };
const USER_SERVER = { command: 'my-own-server', env: { TOKEN: 'secret-value' } };
// Claude Code's own state in ~/.claude.json, which DoFlow must never rewrite.
const CLAUDE_STATE = { numStartups: 42, userID: 'abc123', projects: { '/work': { allowedTools: ['Bash'] } } };

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-mcp-')); }

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** One run the way the lifecycle drives an adapter: discover, plan, apply or remove, verify. The
 * returned ledger drops the rows the plan removed or released and takes the MCP rows verify reports,
 * as updateLedger does. `scope: 'global'` takes the home directory as its scope root, as the CLI does. */
function runMcp({ scope = 'global', root, mcp = [], mcpAdoptable = [], ledger = { resources: [] }, removing = false }) {
  const adapter = createClaudeAdapter();
  const operation = removing ? 'remove' : 'apply';
  const input = { scope, scopeRoot: root, assets: [], mcp, mcpAdoptable, ledger, context: { operation } };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  if (!planned.conflicts.length) adapter[removing ? 'remove' : 'apply']({ ...input, changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation });
  const dropped = new Set(planned.changes.filter((change) => change.operation === 'remove').map((change) => change.ownershipIdentity));
  const added = verified.resources.filter((resource) => resource.kind === 'mcp-server').map((resource) => ({ ...resource, harness: 'claude' }));
  const kept = ledger.resources.filter((row) => !dropped.has(row.ownershipIdentity) && !added.some((item) => item.ownershipIdentity === row.ownershipIdentity));
  return { discovery, planned, verified, ledger: { resources: [...kept, ...added] } };
}

const mcpRows = (ledger) => ledger.resources.filter((row) => row.kind === 'mcp-server');

test('A1 claude: user scope writes ~/.claude.json, keeps every other key, and keeps a user server through install, update and remove', () => {
  const home = scratch();
  const file = path.join(home, '.claude.json');
  writeJson(file, { ...CLAUDE_STATE, mcpServers: { 'user-server': USER_SERVER } });

  const installed = runMcp({ root: home, mcp: [CONTEXT7, SEQUENTIAL] });
  assert.deepEqual(installed.planned.conflicts, []);
  assert.deepEqual(readJson(file), { ...CLAUDE_STATE, mcpServers: { 'user-server': USER_SERVER, ...ENTRIES } });
  assert.deepEqual(mcpRows(installed.ledger).map((row) => [row.ownershipIdentity, row.assetId, row.target]), [
    ['doflow:claude:mcp-server:context7', 'guidance.core', file],
    ['doflow:claude:mcp-server:sequential-thinking', 'guidance.core', file],
  ]);
  assert.equal(installed.verified.ok, true);
  assert.equal(fs.existsSync(path.join(home, '.claude', '.mcp.json')), false, 'Claude Code never reads .claude/.mcp.json');

  const again = runMcp({ root: home, mcp: [CONTEXT7, SEQUENTIAL], ledger: installed.ledger });
  assert.deepEqual(again.discovery.mcpOwned, ['context7', 'sequential-thinking']);
  assert.deepEqual(again.planned.changes, [], 'a re-plan after apply changes nothing');

  const updated = runMcp({ root: home, mcp: [SEQUENTIAL], ledger: again.ledger });
  assert.deepEqual(readJson(file), { ...CLAUDE_STATE, mcpServers: { 'user-server': USER_SERVER, 'sequential-thinking': ENTRIES['sequential-thinking'] } });

  const removed = runMcp({ root: home, ledger: updated.ledger, removing: true });
  assert.deepEqual(readJson(file), { ...CLAUDE_STATE, mcpServers: { 'user-server': USER_SERVER } });
  assert.deepEqual(mcpRows(removed.ledger), []);
  assert.equal(removed.verified.ok, true);
});

test('A1 claude: project scope writes <root>/.mcp.json and keeps an emptied mcpServers as {}', () => {
  const root = scratch();
  const file = path.join(root, '.mcp.json');
  const installed = runMcp({ scope: 'project', root, mcp: [SEQUENTIAL] });
  assert.deepEqual(readJson(file), { mcpServers: { 'sequential-thinking': ENTRIES['sequential-thinking'] } });
  assert.equal(fs.existsSync(path.join(root, '.claude', '.mcp.json')), false);

  runMcp({ scope: 'project', root, mcp: [], ledger: installed.ledger });
  assert.deepEqual(readJson(file), { mcpServers: {} });
});

test('A1 claude: nothing selected and nothing owned writes no file', () => {
  const home = scratch();
  const run = runMcp({ root: home });
  assert.deepEqual(run.planned.changes, []);
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
});

test('A2 claude: entries written before Claude kept MCP rows are adopted when unedited, and remove deletes only those', () => {
  const home = scratch();
  const file = path.join(home, '.claude.json');
  const edited = { ...ENTRIES['sequential-thinking'], env: { DEBUG: '1' } };
  writeJson(file, { ...CLAUDE_STATE, mcpServers: { context7: ENTRIES.context7, 'sequential-thinking': edited, 'user-server': USER_SERVER } });
  const before = fs.readFileSync(file);
  // A 1.18.0 install: Claude holds ledger rows (none for MCP) and a lock row for both servers, so
  // both are adoptable.
  const adoptable = [CONTEXT7, SEQUENTIAL];

  const installed = runMcp({ root: home, mcp: [CONTEXT7, SEQUENTIAL], mcpAdoptable: adoptable });
  assert.deepEqual(installed.discovery.mcpOwned, ['context7']);
  assert.deepEqual(installed.planned.changes, [], 'adopting writes nothing');
  assert.deepEqual(installed.planned.notices,
    ["MCP: kept your own entry 'sequential-thinking' in .claude.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(mcpRows(installed.ledger).map((row) => row.identity), ['context7']);

  const removed = runMcp({ root: home, mcpAdoptable: adoptable, removing: true });
  assert.deepEqual(removed.planned.changes.map((change) => [change.identity, change.operation, change.release ?? false]), [['context7', 'remove', false]]);
  assert.deepEqual(readJson(file), { ...CLAUDE_STATE, mcpServers: { 'sequential-thinking': edited, 'user-server': USER_SERVER } });
});

test('A6 claude: a malformed ~/.claude.json is an install conflict and a remove release, and is never written', () => {
  const home = scratch();
  const file = path.join(home, '.claude.json');
  const owned = runMcp({ root: home, mcp: [CONTEXT7] });
  writeJson(file, '{ "mcpServers": { "secret-value": ');

  const installed = runMcp({ root: home, mcp: [CONTEXT7], ledger: owned.ledger });
  assert.deepEqual(installed.planned.conflicts, [`Claude MCP: ${file}: invalid JSON; DoFlow did not change the file`]);
  assert.deepEqual(installed.planned.changes, []);
  assert.doesNotMatch(JSON.stringify(installed.planned), /secret-value/);

  const removed = runMcp({ root: home, ledger: owned.ledger, removing: true });
  assert.deepEqual(removed.planned.conflicts, []);
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release]), [['doflow:claude:mcp-server:context7', true]]);
  assert.match(removed.planned.notices[0], /^MCP: left .*\.claude\.json untouched because it cannot be edited safely/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "mcpServers": { "secret-value": ');
  assert.deepEqual(mcpRows(removed.ledger), []);
});
