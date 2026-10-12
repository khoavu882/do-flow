'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * MCP reach: for each harness the ledgers say is installed, which MCP servers does that harness
 * have — selected from DoFlow's catalog, configured by hand, absent, or out of the catalog's reach.
 * Read-only: it reads the same ledgers `evaluateReach` reads and asks each adapter's `discover()`
 * for the server names it can see (`mcpConfigured`) and whether that view is complete
 * (`mcpComplete`). A server is reported absent only from a complete view; otherwise its state is
 * unknown. It never starts a server and opens no connection, so the same inputs give the same answer.
 *
 * Server names come from the registries only (`mcp.json`, and the `mcp.server` of capability
 * providers); nothing here names one.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLedger } = require('../state/index.ts');
const { resolveAdapter } = require('../adapters/index.ts');
const { evaluateReach } = require('./reach.ts');

const SCOPE_ORDER: Record<string, number> = { project: 0, global: 1 };

/** Every server id the answer covers: the MCP catalog, then each provider's own MCP server. */
function serverIdsOf(registry: any) {
  const ids = (registry.mcp || []).map((server: any) => server.id);
  for (const capability of (Object.values(registry.capabilities || {}) as any[])) {
    for (const provider of capability.providers || []) if (provider.mcp?.server) ids.push(provider.mcp.server);
  }
  return [...new Set(ids)];
}

/** The MCP file an adapter's discovery could not read and the fixed reason it gives, or null.
 * Reasons come from the adapters (invalid JSON, wrong shape), never from file content. */
function unreadableDetail(discovery: any) {
  for (const [file, read] of (Object.entries(discovery.mcpSnapshot || {}) as [string, any][])) if (read?.ok === false) return { detail: read.reason, file };
  for (const [file, read] of (Object.entries(discovery.mcp || {}) as [string, any][])) if (read?.doc?.ok === false) return { detail: read.doc.reason, file };
  if (discovery.settings?.error) return { detail: 'invalid JSON', ...(discovery.paths?.settings ? { file: discovery.paths.settings } : {}) };
  return null;
}

/** A server is absent (`not-taken`, `not-selected`) only where the adapter read every source its
 * harness merges (`mcpComplete: true`); anywhere else absence is no proof and the state is unknown. */
function stateOf(row: any, id: any) {
  if (row.selected.has(id)) return 'selected';
  if (row.configured?.includes(id)) return 'configured';
  if (row.unreadable || row.configured === null || !row.complete) return 'unknown';
  return row.catalog === 'not-taken' ? 'not-taken' : 'not-selected';
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
function mcpReach({ registry, projectRoot, homeDir = os.homedir(), fsImpl = fs, adapters }: any) {
  const serverIds = serverIdsOf(registry);
  const catalogIds = (registry.mcp || []).map((server: any) => server.id);
  const harnessOrder = registry.harnesses.map((harness: any) => harness.id);
  const { rows: reached } = evaluateReach({ registry, projectRoot, homeDir, fsImpl });

  const ledgers = new Map();
  const ledgerOf = ({ scope, installRoot }: any) => {
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
  const rows: any[] = [];
  for (const { harness: id, scope, installRoot } of reached) {
    const key = `${id}\0${scope}\0${installRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const harness = registry.harnesses.find((item: any) => item.id === id);
    const ledger = ledgerOf({ scope, installRoot });
    const mcp = harness.capabilities?.mcp;
    const row = {
      id, scope, installRoot, displayName: harness.displayName || id,
      catalog: mcp?.status === 'supported' ? 'taken' : 'not-taken',
      note: mcp?.note ?? mcp?.verification,
      selected: new Set((ledger?.resources || [])
        .filter((resource: any) => resource.harness === id && resource.kind === 'mcp-server').map((resource: any) => resource.identity)),
      configured: null,
      complete: false,
      unreadable: false,
    };
    try {
      const discovery = resolveAdapter(adapters, harness).discover({
        scope, scopeRoot: installRoot, homeDir, mcp: [], mcpAdoptable: [], ledger, registry, context: { homeDir },
      });
      row.configured = Array.isArray(discovery.mcpConfigured) ? discovery.mcpConfigured : null;
      row.complete = discovery.mcpComplete === true;
      const found = unreadableDetail(discovery);
      if (found) { row.unreadable = true; unreadable.push({ harness: id, scope, ...found }); }
    } catch (error: any) {
      row.unreadable = true;
      unreadable.push({ harness: id, scope, detail: error.message });
    }
    rows.push(row);
  }
  rows.sort((a, b) => harnessOrder.indexOf(a.id) - harnessOrder.indexOf(b.id)
    || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.installRoot.localeCompare(b.installRoot));

  const result = {
    harnesses: rows.map((row) => {
      const entry: any = { id: row.id, scope: row.scope, catalog: row.catalog };
      if (row.catalog === 'not-taken' && row.note) entry.note = row.note;
      entry.servers = Object.fromEntries(serverIds.map((server) => [server, stateOf(row, server)]));
      return entry;
    }),
    unreadable,
  };

  /** `true` when a server is selected or configured on some installed harness, `false` only when
   * every installed harness read every source it merges and says it is absent, `null` (unknown)
   * otherwise, including when none is installed. */
  const anyHarnessHas = (server: any) => {
    const states = rows.map((row) => stateOf(row, server));
    if (states.some((state) => state === 'selected' || state === 'configured')) return true;
    return states.length > 0 && states.every((state) => state === 'not-selected' || state === 'not-taken') ? false : null;
  };

  /** The command that adds `serverId` for a harness at a scope, or where to configure it by hand. */
  const addCommand = (harnessId: any, scope: any, serverId: any) => {
    const harness = registry.harnesses.find((item: any) => item.id === harnessId);
    const name = harness?.displayName || harnessId;
    if (harness?.capabilities?.mcp?.status !== 'supported') {
      return `configure it in ${name}'s own MCP settings; DoFlow's catalog does not reach it`;
    }
    if (!catalogIds.includes(serverId)) {
      return `configure it in ${name}'s own MCP settings; DoFlow's catalog does not carry ${serverId}`;
    }
    const chosen = new Set([serverId]);
    for (const row of rows) if (row.id === harnessId && row.scope === scope) for (const id of row.selected) chosen.add(id);
    return `doflow install${scope === 'global' ? ' -g' : ''} --target ${harnessId} --mcp ${catalogIds.filter((id: any) => chosen.has(id)).join(',')}`;
  };

  Object.defineProperties(result, {
    anyHarnessHas: { value: anyHarnessHas },
    addCommand: { value: addCommand },
  });
  return result;
}

module.exports = { mcpReach };
