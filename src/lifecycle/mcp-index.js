'use strict';

// Per-install "this install has" index: the guidance layer's authoritative summary of exactly
// which MCP servers were selected for this install, so an agent never assumes availability of a
// server that isn't actually connected. Rendered fresh on every install/update from the resolved
// selection — never hand-edited, and never a partial/empty file (null means "omit entirely").
//
// Each server's doc is emitted as an `@`-import, not as a "read this on use" instruction. That
// instruction was prose describing a trigger, and nothing evaluates prose — the same shape this
// guidance layer removed from its behavioral modes. A mode had an alternative (bind it to the
// skill that reads it, at no context cost); a server doc has none, because there is no per-server
// skill to bind to. So the choice here is an import that actually loads or a sentence that hopes.
//
// Only SELECTED servers are imported, so the cost is proportional to what is installed: a
// one-server install pays for one doc, and an install with none produces no file at all.
function renderMcpIndex(selectedServers) {
  if (!selectedServers || selectedServers.length === 0) return null;
  const lines = ['# MCP short flags — this install'];
  for (const server of selectedServers) {
    lines.push(`# ${server.shortFlag} — prefer the \`${server.id}\` MCP server`);
    lines.push(`@${server.doc}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { renderMcpIndex };
