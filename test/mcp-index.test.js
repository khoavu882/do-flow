'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, selectMcpServers } = require('../src/registry');
const { renderMcpIndex } = require('../src/lifecycle/mcp-index');
const { mcpIndexPath } = require('../src/lifecycle');

const repoRoot = path.resolve(__dirname, '..');
const registry = loadRegistry({ repoRoot });
const guidanceSource = path.join(repoRoot, 'core', 'shared', 'guidance');

const HEADER = '# MCP short flags — this install';

function fixtureServers() {
  return [
    { id: 'context7', shortFlag: '--c7', doc: 'mcp/MCP_Context7.md' },
    { id: 'sequential-thinking', shortFlag: '--seq', doc: 'mcp/MCP_Sequential.md' },
    { id: 'playwright', shortFlag: '--play', doc: 'mcp/MCP_Playwright.md' },
  ];
}

test('full selection: one header line, two lines per server, in input order', () => {
  const servers = fixtureServers();
  const output = renderMcpIndex(servers);
  const lines = output.split('\n').filter((line) => line.length > 0);

  const headerLines = lines.filter((line) => line === HEADER);
  assert.equal(headerLines.length, 1);
  assert.equal(lines.length, 1 + servers.length * 2);

  for (const [index, server] of servers.entries()) {
    const flagLine = lines[1 + index * 2];
    const docLine = lines[1 + index * 2 + 1];
    assert.equal(flagLine, `# ${server.shortFlag} — prefer the \`${server.id}\` MCP server`);
    assert.equal(docLine, `#   on use, read ${server.doc} first`);
  }
});

test('partial selection: servers not in the input never appear in the output', () => {
  const servers = [{ id: 'context7', shortFlag: '--c7', doc: 'mcp/MCP_Context7.md' }];
  const output = renderMcpIndex(servers);

  assert.ok(output.includes('context7'));
  for (const excluded of ['sequential-thinking', 'chrome-devtools', 'playwright']) {
    assert.ok(!output.includes(excluded), `output must not mention unselected server '${excluded}'`);
  }
});

test('empty selection returns exactly null', () => {
  assert.equal(renderMcpIndex([]), null);
});

test('undefined/null input returns null', () => {
  assert.equal(renderMcpIndex(undefined), null);
  assert.equal(renderMcpIndex(null), null);
});

test('determinism: same (non-identical) input array produces byte-identical output', () => {
  const first = renderMcpIndex(fixtureServers());
  const second = renderMcpIndex(fixtureServers());
  assert.equal(first, second);
});

test('real registry shape: selectMcpServers output renders correctly', () => {
  const servers = selectMcpServers(registry, ['context7', 'playwright']);
  const output = renderMcpIndex(servers);
  const lines = output.split('\n').filter((line) => line.length > 0);

  assert.equal(lines[0], HEADER);
  assert.equal(lines.length, 1 + servers.length * 2);
  assert.equal(lines[1], '# --c7 — prefer the `context7` MCP server');
  assert.equal(lines[2], '#   on use, read mcp/MCP_Context7.md first');
  assert.equal(lines[3], '# --play — prefer the `playwright` MCP server');
  assert.equal(lines[4], '#   on use, read mcp/MCP_Playwright.md first');
});

// Anchor regression guard. Every `doc` path is relative, so it is only meaningful against an
// implied base directory, and nothing in the data itself records what that base is. These two
// tests pin the base down from both ends — the directory MCP_INDEX.md is written into, and the
// files the paths must land on — so relocating either side fails here instead of silently
// emitting dead read-instructions into every install's guidance layer.
test('anchor: MCP_INDEX.md is written to the guidance root, not a subdirectory of it', () => {
  const written = mcpIndexPath('/scope');
  assert.equal(written, path.join('/scope', '.doflow', 'guidance', 'MCP_INDEX.md'));
  assert.equal(
    path.dirname(written),
    path.join('/scope', '.doflow', 'guidance'),
    'doc paths in mcp.yaml are guidance-root-relative; writing MCP_INDEX.md deeper breaks them all',
  );
});

test('anchor: every rendered doc path resolves to a real file under the guidance tree', () => {
  const servers = selectMcpServers(registry, Array.from(registry.mcp, (s) => s.id));
  assert.ok(servers.length > 0, 'registry must define at least one MCP server to guard');

  // Reproduce what an agent actually does: read the doc path out of the rendered line, then
  // resolve it relative to the directory MCP_INDEX.md itself lives in.
  const indexDir = path.dirname(mcpIndexPath('/scope'));
  const guidanceRelativeDir = path.relative(path.join('/scope', '.doflow', 'guidance'), indexDir);

  for (const line of renderMcpIndex(servers).split('\n')) {
    const match = line.match(/^#\s+on use, read (\S+) first$/);
    if (!match) continue;
    const resolved = path.join(guidanceSource, guidanceRelativeDir, match[1]);
    assert.ok(
      fs.existsSync(resolved),
      `MCP_INDEX.md points at '${match[1]}', which resolves to a nonexistent file: ${resolved}`,
    );
  }
});
