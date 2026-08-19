'use strict';

// Codex MCP reconciliation.  Unlike Claude's JSON registry, Codex discovers MCP servers from
// config.toml.  This adapter manages only table names that it created and recorded in the
// manifest ledger; every other MCP table remains user-owned and byte-for-byte untouched.
const fs = require('node:fs');
const path = require('node:path');
const {
  configPath,
  fingerprint,
  parseToml,
  atomicWrite,
} = require('./config');
const { resolveMcpSelection } = require('../../install/mcp');
const { selectMcpServers, nativeMcpCatalog } = require('../../registry');

const MCP_KIND = 'mcp-server';
const MCP_PREFIX = 'mcp_servers.';

/** @param {object} registry a loaded registry (src/registry#loadRegistry) */
function readCodexMcpCatalog(registry) {
  return nativeMcpCatalog(selectMcpServers(registry));
}

function resolveCodexMcpSelection(options) {
  return resolveMcpSelection(options);
}

function isSafeServerName(name) {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`).join(', ')} }`;
  }
  throw new Error('Codex MCP definitions may only contain TOML-compatible values');
}

function renderServer(name, definition) {
  if (!isSafeServerName(name)) throw new Error(`Unsupported Codex MCP server name '${name}'`);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error(`Codex MCP server '${name}' requires an object definition`);
  }
  if (!definition.command && !definition.url) {
    throw new Error(`Codex MCP server '${name}' requires either command or url`);
  }
  const lines = [`[mcp_servers.${name}]`];
  for (const [key, value] of Object.entries(definition)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Unsupported Codex MCP key '${key}'`);
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function resourceFor({ name, scope, definition, sourceVersion, recoveryPoint }) {
  return {
    target: 'codex', scope, kind: MCP_KIND, identity: name,
    sourceVersion, selection: true, recoveryPoint,
    fingerprint: fingerprint(renderServer(name, definition)),
  };
}

function isOwnedRecord(resource, scope) {
  return resource && resource.target === 'codex' && resource.scope === scope &&
    resource.kind === MCP_KIND && typeof resource.identity === 'string';
}

function tableRanges(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/);
    if (!match) continue;
    const name = match[1];
    let end = lines.length;
    for (let following = index + 1; following < lines.length; following++) {
      const header = lines[following].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if (header && header[1] !== `mcp_servers.${name}` && !header[1].startsWith(`mcp_servers.${name}.`)) {
        end = following;
        break;
      }
    }
    tables.push({ name, start: index, end });
  }
  return { lines, tables };
}

function fullServerRange(tables, name) {
  return tables.find((table) => table.name === name) ?? null;
}

function planCodexMcp({ file, scope, managedResources = [], selected = [], allServers, serverDefs, sourceVersion, recoveryPoint }) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let parsed;
  try { parsed = parseToml(original); } catch (error) {
    return { ok: false, status: 'malformed', file, original, changes: [], conflicts: [error.message], managedResources };
  }
  if (!Array.isArray(allServers) || !serverDefs || typeof serverDefs !== 'object') {
    return { ok: false, status: 'invalid-request', file, original, changes: [], conflicts: ['Codex MCP catalog is required'], managedResources };
  }
  const unknown = selected.filter((name) => !allServers.includes(name));
  if (unknown.length) return { ok: false, status: 'invalid-request', file, original, changes: [], conflicts: [`Unknown MCP server(s): ${unknown.join(', ')}`], managedResources };
  const desired = [...new Set(selected)];
  try { for (const name of desired) renderServer(name, serverDefs[name]); } catch (error) {
    return { ok: false, status: 'invalid-request', file, original, changes: [], conflicts: [error.message], managedResources };
  }

  const { lines, tables } = tableRanges(original);
  const owned = new Map(managedResources.filter((resource) => isOwnedRecord(resource, scope)).map((resource) => [resource.identity, resource]));
  const changes = [];
  const conflicts = [];
  const names = new Set([...desired, ...owned.keys()]);
  for (const name of names) {
    const range = fullServerRange(tables, name);
    const existing = range ? `${lines.slice(range.start, range.end).join('\n').replace(/\n*$/, '\n')}` : null;
    const record = owned.get(name);
    const wanted = desired.includes(name);
    if (range && !record) {
      // A server the user had already registered is not appropriated by an install.  It remains
      // usable when selected, and is never removed merely because a later selection omits it.
      continue;
    }
    if (record && range && record.fingerprint !== fingerprint(existing)) {
      conflicts.push(`MCP server '${name}' was modified outside DoFlow`);
      continue;
    }
    if (wanted) {
      const content = renderServer(name, serverDefs[name]);
      if (!range) changes.push({ type: 'create', identity: name, content });
      else if (fingerprint(existing) !== fingerprint(content)) changes.push({ type: 'update', identity: name, content, range });
    } else if (range) {
      changes.push({ type: 'remove', identity: name, range });
    }
  }
  if (conflicts.length) return { ok: false, status: 'conflict', file, original, changes: [], conflicts, managedResources };

  const nextLines = [...lines];
  for (const change of changes.filter((item) => item.type !== 'create').sort((a, b) => b.range.start - a.range.start)) {
    const replacement = change.type === 'update' ? change.content.trimEnd().split('\n') : [];
    nextLines.splice(change.range.start, change.range.end - change.range.start, ...replacement);
  }
  for (const change of changes.filter((item) => item.type === 'create')) {
    while (nextLines.length && nextLines.at(-1) === '') nextLines.pop();
    if (nextLines.length) nextLines.push('');
    nextLines.push(...change.content.trimEnd().split('\n'));
  }
  let content = nextLines.join('\n');
  if (content && !content.endsWith('\n')) content += '\n';

  const nextManagedResources = managedResources.filter((resource) => !isOwnedRecord(resource, scope) || desired.includes(resource.identity));
  for (const name of desired) {
    const range = fullServerRange(tables, name);
    const existingIsForeign = range && !owned.has(name);
    if (existingIsForeign) continue;
    const next = resourceFor({ name, scope, definition: serverDefs[name], sourceVersion, recoveryPoint });
    const index = nextManagedResources.findIndex((resource) => isOwnedRecord(resource, scope) && resource.identity === name);
    if (index >= 0) nextManagedResources[index] = next;
    else nextManagedResources.push(next);
  }
  return { ok: true, status: changes.length ? 'change' : 'unchanged', file, original, content, changes, conflicts: [], managedResources: nextManagedResources };
}

function applyCodexMcp(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok || dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  atomicWrite(plan.file, plan.content, fsImpl);
  return { ...plan, applied: true };
}

function reconcileCodexMcp(options) {
  const file = options.file ?? configPath(options);
  return applyCodexMcp(planCodexMcp({ ...options, file }), options);
}

module.exports = {
  MCP_KIND,
  readCodexMcpCatalog,
  resolveCodexMcpSelection,
  renderServer,
  resourceFor,
  planCodexMcp,
  applyCodexMcp,
  reconcileCodexMcp,
};
