'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readAllServers, filterServerDefs, writeProjectMcpJson, mergeGlobalMcpServers, resolveMcpSelection,
  promptMcpCheckbox,
} = require('../src/mcp');

const REPO = path.resolve(__dirname, '..');
const MCP_JSON = path.join(REPO, 'core', '.mcp.json');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-mcp-'));
}

test('readAllServers returns core/.mcp.json server names in source order', () => {
  const servers = readAllServers(MCP_JSON);
  assert.deepStrictEqual(servers, ['context7', 'sequential-thinking', 'chrome-devtools', 'playwright']);
});

test('filterServerDefs keeps only the selected servers, each with its full definition', () => {
  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7', 'playwright']);
  assert.deepStrictEqual(Object.keys(defs), ['context7', 'playwright']);
  assert.strictEqual(defs.context7.command, 'npx');
});

test('writeProjectMcpJson writes {mcpServers} at the given root when no file exists yet', () => {
  const dir = scratchDir();
  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7']);
  const dest = writeProjectMcpJson(dir, all, defs);
  assert.strictEqual(dest, path.join(dir, '.mcp.json'));
  const written = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.deepStrictEqual(Object.keys(written.mcpServers), ['context7']);
});

test('writeProjectMcpJson merges — a hand-added project server doflow does not ship must survive', () => {
  const dir = scratchDir();
  const dest = path.join(dir, '.mcp.json');
  fs.writeFileSync(dest, JSON.stringify({ mcpServers: { 'my-project-server': { command: 'foo' }, context7: { command: 'old' } } }));

  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['sequential-thinking']);
  writeProjectMcpJson(dir, all, defs);

  const result = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.ok(result.mcpServers['my-project-server'], 'a server doflow does not know about must survive');
  assert.ok(!('context7' in result.mcpServers), 'a known server not in the new selection must be removed');
  assert.ok(result.mcpServers['sequential-thinking'], 'the newly selected known server must be present');
});

test('writeProjectMcpJson preserves a reselected known server\'s existing (hand-edited) definition instead of resetting it to the shipped default', () => {
  const dir = scratchDir();
  const dest = path.join(dir, '.mcp.json');
  fs.writeFileSync(dest, JSON.stringify({ mcpServers: { context7: { command: 'my-custom-wrapper', args: ['--extra-flag'] } } }));

  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7']); // context7 reselected, still known+present
  writeProjectMcpJson(dir, all, defs);

  const result = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.deepStrictEqual(result.mcpServers.context7, { command: 'my-custom-wrapper', args: ['--extra-flag'] }, 'a hand-edited definition for an already-present known server must survive reselection, not reset to the shipped default');
});

test('writeProjectMcpJson refuses to touch a malformed existing .mcp.json rather than silently discarding it', () => {
  const dir = scratchDir();
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not valid json');
  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7']);
  assert.throws(() => writeProjectMcpJson(dir, all, defs), /Refusing to touch malformed/);
});

test('mergeGlobalMcpServers refuses to touch a malformed ~/.claude.json rather than silently discarding it', () => {
  const dir = scratchDir();
  fs.writeFileSync(path.join(dir, '.claude.json'), '{ not valid json');
  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7']);
  assert.throws(() => mergeGlobalMcpServers(dir, all, defs), /Refusing to touch malformed/);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), '{ not valid json', 'the malformed file itself must be left exactly as-is');
});

test('mergeGlobalMcpServers only touches known server keys, leaving unrelated ~/.claude.json state untouched', () => {
  const dir = scratchDir();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({
    numStartups: 42,
    userID: 'abc123',
    mcpServers: { 'my-custom-server': { command: 'foo' }, context7: { command: 'old' } },
  }));

  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['sequential-thinking']);
  mergeGlobalMcpServers(dir, all, defs);

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(result.numStartups, 42, 'unrelated top-level state must survive');
  assert.strictEqual(result.userID, 'abc123', 'unrelated top-level state must survive');
  assert.ok(result.mcpServers['my-custom-server'], 'a server doflow does not know about must survive');
  assert.ok(!('context7' in result.mcpServers), 'a known server not in the new selection must be removed');
  assert.ok(result.mcpServers['sequential-thinking'], 'the newly selected known server must be present');
});

test('mergeGlobalMcpServers preserves a reselected known server\'s existing (hand-edited) definition instead of resetting it to the shipped default', () => {
  const dir = scratchDir();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: { context7: { command: 'my-custom-wrapper', args: ['--extra-flag'] } },
  }));

  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, ['context7']); // context7 reselected, still known+present
  mergeGlobalMcpServers(dir, all, defs);

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(result.mcpServers.context7, { command: 'my-custom-wrapper', args: ['--extra-flag'] }, 'a hand-edited definition for an already-present known server must survive reselection, not reset to the shipped default');
});

test('mergeGlobalMcpServers creates ~/.claude.json from scratch when absent', () => {
  const dir = scratchDir();
  const all = readAllServers(MCP_JSON);
  const defs = filterServerDefs(MCP_JSON, all, all);
  const file = mergeGlobalMcpServers(dir, all, defs);
  assert.strictEqual(file, path.join(dir, '.claude.json'));
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(result.mcpServers).sort(), [...all].sort());
});

test('resolveMcpSelection: --mcp <list> wins outright and dedupes', () => {
  const all = ['a', 'b', 'c'];
  const selected = resolveMcpSelection({
    cmd: 'install', requested: ['a', 'a', 'b'], allServers: all, manifestServers: ['c'],
    interactive: true, promptFn: () => { throw new Error('must not prompt when --mcp is given'); },
  });
  assert.deepStrictEqual(selected, ['a', 'b']);
});

test('resolveMcpSelection: --mcp rejects unknown server names', () => {
  assert.throws(
    () => resolveMcpSelection({ cmd: 'install', requested: ['bogus'], allServers: ['a', 'b'], manifestServers: null, interactive: false, promptFn: null }),
    /Unknown MCP server\(s\): bogus/,
  );
});

test('resolveMcpSelection: --mcp with an empty list is a hard error, not "keep all"', () => {
  assert.throws(
    () => resolveMcpSelection({ cmd: 'install', requested: [], allServers: ['a', 'b'], manifestServers: null, interactive: false, promptFn: null }),
    /requires at least one server/,
  );
});

test('resolveMcpSelection: install + interactive prompts, seeded with the manifest selection', () => {
  const all = ['a', 'b', 'c'];
  let seenSeed = null;
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: all, manifestServers: ['b'], interactive: true,
    promptFn: (servers, seed) => { seenSeed = seed; return ['a']; },
  });
  assert.deepStrictEqual(seenSeed, ['b']);
  assert.deepStrictEqual(selected, ['a']);
});

test('resolveMcpSelection: install + interactive, prompt returns [] (deliberate "no servers") is honored', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: null, interactive: true,
    promptFn: () => [],
  });
  assert.deepStrictEqual(selected, []);
});

test('resolveMcpSelection: install + interactive, prompt unavailable (null, e.g. no real TTY) falls back to manifest/all', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: null, interactive: true,
    promptFn: () => null,
  });
  assert.deepStrictEqual(selected, ['a', 'b']);
});

test('resolveMcpSelection: update never prompts, even when interactive is true', () => {
  const selected = resolveMcpSelection({
    cmd: 'update', requested: null, allServers: ['a', 'b'], manifestServers: ['a'], interactive: true,
    promptFn: () => { throw new Error('must not prompt on update'); },
  });
  assert.deepStrictEqual(selected, ['a']);
});

test('resolveMcpSelection: no flag, not interactive, no manifest yet -> defaults to all', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b', 'c'], manifestServers: null, interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, ['a', 'b', 'c']);
});

test('promptMcpCheckbox returns [] immediately for an empty server list, never entering the raw-mode read loop', () => {
  // Regression test: the cursor-movement math (`(cursor - 1 + servers.length) % servers.length`)
  // divides by servers.length — an empty list would produce NaN and hang the render loop waiting
  // on a keypress that a non-interactive caller (or a future core/.mcp.json with 0 servers) never
  // sends. Fake a TTY to get past the isTTY guard without actually blocking on stdin.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    assert.deepStrictEqual(promptMcpCheckbox([], []), []);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete process.stdin.isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete process.stdout.isTTY;
  }
});
