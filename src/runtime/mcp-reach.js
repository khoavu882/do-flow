'use strict';

/**
 * MCP reach: for each harness the ledgers say is installed, which MCP servers does that harness
 * have — selected from DoFlow's catalog, configured by hand, absent, or out of the catalog's reach.
 * Read-only: it reads the same ledgers `evaluateReach` reads and asks each adapter's `discover()`
 * for the servers named in the MCP file it already reads. It never starts a server and opens no
 * connection, so the same inputs give the same answer.
 *
 * Server names come from the registries only (`mcp.json`, and the `mcp.server` of capability
 * providers); nothing here names one.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLedger } = require('../state');
const { resolveAdapter } = require('../adapters');
const { evaluateReach } = require('./reach');

const SCOPE_ORDER = { project: 0, global: 1 };

/** Every server id the answer covers: the MCP catalog, then each provider's own MCP server. */
function serverIdsOf(registry) {
  const ids = (registry.mcp || []).map((server) => server.id);
  for (const capability of Object.values(registry.capabilities || {})) {
    for (const provider of capability.providers || []) if (provider.mcp?.server) ids.push(provider.mcp.server);
  }
  return [...new Set(ids)];
}

/** A fixed reason an adapter's discovery gives for an MCP file it could not read, or null. Reasons
 * come from the adapters (invalid JSON, wrong shape), never from file content. */
function unreadableDetail(discovery) {
  for (const read of Object.values(discovery.mcpSnapshot || {})) if (read?.ok === false) return read.reason;
  for (const read of Object.values(discovery.mcp || {})) if (read?.doc?.ok === false) return read.doc.reason;
  if (discovery.settings?.error) return 'invalid JSON';
  return null;
}

function stateOf(row, id) {
  if (row.selected.has(id)) return 'selected';
  if (row.configured?.includes(id)) return 'configured';
  if (row.unreadable) return 'unknown';
  if (row.catalog === 'not-taken') return 'not-taken';
  return row.configured === null ? 'unknown' : 'not-selected';
}

/**
 * @param {Object} options
 * @param {Object} options.registry loaded registry
 * @param {string} options.projectRoot
 * @param {string} [options.homeDir]
 * @param {Object} [options.fsImpl]
 * @param {Object} options.adapters adapter registry (`buildAdapterRegistry()`)
 * @returns {{harnesses: Object[], unreadable: Object[]}} plain data; `anyHarnessHas` and `addCommand` ride along unenumerated
 */
function mcpReach({ registry, projectRoot, homeDir = os.homedir(), fsImpl = fs, adapters }) {
  const serverIds = serverIdsOf(registry);
  const catalogIds = (registry.mcp || []).map((server) => server.id);
  const harnessOrder = registry.harnesses.map((harness) => harness.id);
  const { rows: reached } = evaluateReach({ registry, projectRoot, homeDir, fsImpl });

  const ledgers = new Map();
  const ledgerOf = ({ scope, installRoot }) => {
    const key = `${scope}\0${installRoot}`;
    if (!ledgers.has(key)) {
      let ledger = null;
      try { ledger = readLedger(path.join(installRoot, '.doflow', 'state'), { fsImpl }); } catch { /* evaluateReach reports it */ }
      ledgers.set(key, ledger);
    }
    return ledgers.get(key);
  };

  const unreadable = [];
  const seen = new Set();
  const rows = [];
  for (const { harness: id, scope, installRoot } of reached) {
    const key = `${id}\0${scope}\0${installRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const harness = registry.harnesses.find((item) => item.id === id);
    const ledger = ledgerOf({ scope, installRoot });
    const mcp = harness.capabilities?.mcp;
    const row = {
      id, scope, installRoot, displayName: harness.displayName || id,
      catalog: mcp?.status === 'supported' ? 'taken' : 'not-taken',
      note: mcp?.note ?? mcp?.verification,
      selected: new Set((ledger?.resources || [])
        .filter((resource) => resource.harness === id && resource.kind === 'mcp-server').map((resource) => resource.identity)),
      configured: null,
      unreadable: false,
    };
    try {
      const discovery = resolveAdapter(adapters, harness).discover({
        scope, scopeRoot: installRoot, homeDir, mcp: [], mcpAdoptable: [], ledger, registry, context: { homeDir },
      });
      row.configured = Array.isArray(discovery.mcpConfigured) ? discovery.mcpConfigured : null;
      const detail = row.configured === null ? unreadableDetail(discovery) : null;
      if (detail) { row.unreadable = true; unreadable.push({ harness: id, scope, detail }); }
    } catch (error) {
      row.unreadable = true;
      unreadable.push({ harness: id, scope, detail: error.message });
    }
    rows.push(row);
  }
  rows.sort((a, b) => harnessOrder.indexOf(a.id) - harnessOrder.indexOf(b.id)
    || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.installRoot.localeCompare(b.installRoot));

  const result = {
    harnesses: rows.map((row) => {
      const entry = { id: row.id, scope: row.scope, catalog: row.catalog };
      if (row.catalog === 'not-taken' && row.note) entry.note = row.note;
      entry.servers = Object.fromEntries(serverIds.map((server) => [server, stateOf(row, server)]));
      return entry;
    }),
    unreadable,
  };

  /** `true` when a server is selected or configured on some installed harness, `false` when every
   * installed harness says it is absent, `unknown` otherwise (including when none is installed). */
  const anyHarnessHas = (server) => {
    const states = rows.map((row) => stateOf(row, server));
    if (states.some((state) => state === 'selected' || state === 'configured')) return true;
    return states.length > 0 && states.every((state) => state === 'not-selected' || state === 'not-taken') ? false : 'unknown';
  };

  /** The command that adds `serverId` for a harness at a scope, or where to configure it by hand. */
  const addCommand = (harnessId, scope, serverId) => {
    const harness = registry.harnesses.find((item) => item.id === harnessId);
    const name = harness?.displayName || harnessId;
    if (harness?.capabilities?.mcp?.status !== 'supported') {
      return `configure it in ${name}'s own MCP settings; DoFlow's catalog does not reach it`;
    }
    if (!catalogIds.includes(serverId)) {
      return `configure it in ${name}'s own MCP settings; DoFlow's catalog does not carry ${serverId}`;
    }
    const chosen = new Set([serverId]);
    for (const row of rows) if (row.id === harnessId && row.scope === scope) for (const id of row.selected) chosen.add(id);
    return `doflow install${scope === 'global' ? ' -g' : ''} --target ${harnessId} --mcp ${catalogIds.filter((id) => chosen.has(id)).join(',')}`;
  };

  Object.defineProperties(result, {
    anyHarnessHas: { value: anyHarnessHas },
    addCommand: { value: addCommand },
  });
  return result;
}

module.exports = { mcpReach };
