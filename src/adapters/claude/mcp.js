'use strict';

// Claude's MCP component: DoFlow's servers as entries of `mcpServers` in `~/.claude.json` (user
// scope) or `<project>/.mcp.json` (project scope), the locations Claude Code actually reads. Both
// files are shared — `~/.claude.json` also holds Claude Code's own state, and a project `.mcp.json`
// can be read and written by other tools — so DoFlow owns its servers one entry at a time through
// ../mcp-entries.js and never rewrites another key or another entry's value.
const fs = require('node:fs');
const { nativeMcpCatalog } = require('../../registry');
const { readMcpFiles, planMcpEntries, verifyMcpEntries, ownedMcpIds, writeMcpEntries } = require('../mcp-entries');

const HARNESS = 'claude';
const MCP_CONTAINER = 'mcpServers';
const MCP_RENDERER = 'claude-mcp';
// Claude's MCP entries have no asset of their own; they ride the guidance asset every Claude
// install carries.
const MCP_ASSET_ID = 'guidance.core';

function ownershipIdentity(id) { return `doflow:${HARNESS}:mcp-server:${id}`; }

/** Claude Code's own per-server shape, the one the registry's native catalog renders. */
function rendered(servers) {
  const { serverDefs } = nativeMcpCatalog(servers);
  return servers.map((server) => ({ id: server.id, entry: serverDefs[server.id] }));
}

/** Everything the shared entry-ownership rules need from this adapter. */
function mcpEntriesInput({ paths, mcp = [], mcpAdoptable = [], ledger }) {
  const rows = (ledger?.resources || []).filter((row) => row.kind === 'mcp-server');
  return {
    file: paths.mcp, selected: rendered(mcp), adoptable: rendered(mcpAdoptable),
    ownRows: rows.filter((row) => row.harness === HARNESS).map((row) => ({
      identity: row.identity, target: row.target, fingerprint: row.fingerprint ?? null, ownershipIdentity: row.ownershipIdentity, legacy: false,
    })),
    foreignRows: rows.filter((row) => row.harness !== HARNESS).map((row) => ({ harness: row.harness, identity: row.identity, target: row.target })),
    identityFor: ownershipIdentity, assetId: MCP_ASSET_ID, renderer: MCP_RENDERER, label: 'Claude MCP',
  };
}

function readFiles(entries, fsImpl) {
  return readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
}

/** The MCP files as plan read them (`mcpSnapshot`, which verify compares against) and the servers
 * DoFlow owns in them now (`mcpOwned`). */
function discoverMcp({ paths, mcp, mcpAdoptable, ledger, fsImpl = fs }) {
  const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger });
  const mcpSnapshot = readFiles(entries, fsImpl);
  return { mcpSnapshot, mcpOwned: ownedMcpIds({ ...entries, files: mcpSnapshot }) };
}

function planMcp({ paths, mcp, mcpAdoptable, ledger, snapshot, removing, fsImpl = fs }) {
  const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger });
  return planMcpEntries({ ...entries, files: snapshot ?? readFiles(entries, fsImpl), removing });
}

/** An emptied `mcpServers` stays as `{}`, as Claude Code itself leaves it. */
function writeMcp(changes, { fsImpl = fs } = {}) {
  return writeMcpEntries(changes, { container: MCP_CONTAINER, keepEmptyContainer: true, fsImpl });
}

function verifyMcp({ paths, mcp, mcpAdoptable, ledger, snapshot, removing, sourceVersion, fsImpl = fs }) {
  const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger });
  const files = readFiles(entries, fsImpl);
  return verifyMcpEntries({ ...entries, files, snapshot: snapshot ?? files, removing, harness: HARNESS, sourceVersion });
}

module.exports = { discoverMcp, planMcp, writeMcp, verifyMcp };
