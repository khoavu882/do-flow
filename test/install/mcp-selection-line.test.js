'use strict';
// The one line install and update name each harness's MCP selection in (src/cli/shared.js
// printMcpSelection): every source word, grouping and the --mcp-without-a-taker line, from a plan's
// targets alone. The interactive prompt cannot be driven from a spawned CLI, so its word is pinned here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { printMcpSelection } = require('../../src/cli/shared');

function linesOf(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try { fn(); } finally { console.log = original; }
  return lines;
}

const view = (targets) => ({ plan: { targets } });

test('each source prints its word, and harnesses share a group only with the same servers and source', () => {
  const targets = view([
    { harness: 'kiro', mcpSelected: ['context7'] },
    { harness: 'pi', mcpSelected: ['context7'] },
    { harness: 'claude', mcpSelected: ['context7'] },
    { harness: 'codex', mcpSelected: [] },
    { harness: 'opencode', mcpSelected: ['sequential-thinking'] },
    { harness: 'copilot', mcpSelected: [] },
    { harness: 'gemini', mcpSelected: null },
    { harness: 'antigravity', skipped: true, mcpSelected: null },
  ]);
  const sources = { kiro: 'prompt', pi: 'prompt', claude: 'kept', codex: 'recorded', opencode: 'manifest', copilot: 'default' };
  assert.deepEqual(linesOf(() => printMcpSelection(targets, sources)), [
    '[INFO] MCP selection: kiro, pi: context7 (prompt); claude: context7 (kept); codex: none (recorded); '
      + 'opencode: sequential-thinking (remembered); copilot: none (default)',
  ]);
  assert.deepEqual(linesOf(() => printMcpSelection(view([{ harness: 'kiro', mcpSelected: ['context7'] }]), { kiro: 'flag' }, { prefix: '[DRY]' })),
    ['[DRY] MCP selection: kiro: context7 (--mcp)']);
});

test('with no target that takes servers, only an explicit --mcp is mentioned', () => {
  const geminiOnly = view([{ harness: 'gemini', mcpSelected: null }]);
  assert.deepEqual(linesOf(() => printMcpSelection(geminiOnly, {})), []);
  assert.deepEqual(linesOf(() => printMcpSelection(geminiOnly, {}, { requested: ['context7'] })),
    ['[INFO] MCP: no targeted harness takes MCP servers; --mcp has no effect.']);
});
