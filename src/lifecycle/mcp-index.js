'use strict';

// Per-install "this install has" index: the guidance layer's authoritative summary of exactly
// which MCP servers were selected for this install, so an agent never assumes availability of a
// server that isn't actually connected. Rendered fresh on every install/update from the resolved
// selection — never hand-edited, and never a partial/empty file (null means "omit entirely").
function renderMcpIndex(selectedServers) {
  if (!selectedServers || selectedServers.length === 0) return null;
  const lines = ['# MCP short flags — this install'];
  for (const server of selectedServers) {
    lines.push(`# ${server.shortFlag} — prefer the \`${server.id}\` MCP server`);
    lines.push(`#   on use, read ${server.doc} first`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { renderMcpIndex };
