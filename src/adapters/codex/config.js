'use strict';

// Codex config.toml reconciliation.  This module deliberately manages individual,
// manifest-backed keys rather than serialising a whole TOML document.  The latter would either
// require a TOML dependency or, more importantly, risk reformatting/deleting a user's settings.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseToml, stripComment } = require('../../helper/toml');

const CONFIG_NAME = 'config.toml';
const CONFIG_KIND = 'configuration-entry';

function configPath({ scope, codexDir, projectRoot }) {
  if (scope === 'global') {
    if (!codexDir) throw new Error('codexDir is required for global Codex configuration');
    return path.join(codexDir, CONFIG_NAME);
  }
  if (scope === 'project') {
    if (!projectRoot) throw new Error('projectRoot is required for project Codex configuration');
    return path.join(projectRoot, '.codex', CONFIG_NAME);
  }
  throw new Error(`Unsupported Codex configuration scope: ${scope}`);
}

function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function commentSuffix(line) {
  const withoutComment = stripComment(line);
  return line.slice(withoutComment.length);
}

function renderValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error('Managed Codex config values must be boolean, number, or string');
}

function normaliseDesired(resources) {
  const result = new Map();
  for (const resource of resources || []) {
    if (!resource || (resource.kind && resource.kind !== CONFIG_KIND && resource.kind !== 'config-entry')) continue;
    const identity = resource.identity ?? resource.key;
    if (!identity || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(identity)) {
      throw new Error('A managed Codex configuration resource requires a dotted identity');
    }
    if (!Object.hasOwn(resource, 'value')) throw new Error(`Managed Codex configuration '${identity}' requires a value`);
    renderValue(resource.value);
    if (result.has(identity)) throw new Error(`Duplicate desired Codex configuration resource '${identity}'`);
    result.set(identity, { ...resource, identity, kind: resource.kind ?? CONFIG_KIND });
  }
  return result;
}

function isOwnedRecord(resource, scope) {
  return resource && resource.target === 'codex' && resource.scope === scope &&
    (resource.kind === CONFIG_KIND || resource.kind === 'config-entry') && typeof resource.identity === 'string';
}

function planCodexConfig({ file, scope, managedResources = [], desiredResources = [] }) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let parsed;
  try { parsed = parseToml(original); } catch (error) {
    return { ok: false, status: 'malformed', file, original, changes: [], conflicts: [error.message], managedResources };
  }
  let desired;
  try { desired = normaliseDesired(desiredResources); } catch (error) {
    return { ok: false, status: 'invalid-request', file, original, changes: [], conflicts: [error.message], managedResources };
  }
  const owned = new Map(managedResources.filter((resource) => isOwnedRecord(resource, scope)).map((resource) => [resource.identity, resource]));
  const changes = [];
  const conflicts = [];
  const all = new Set([...desired.keys(), ...owned.keys()]);
  for (const identity of all) {
    const entry = parsed.entries.get(identity);
    const record = owned.get(identity);
    const wanted = desired.get(identity);
    if (!record && entry) {
      conflicts.push(`'${identity}' exists but is not owned by DoFlow`);
      continue;
    }
    if (record && entry && record.fingerprint !== fingerprint(entry.value)) {
      conflicts.push(`'${identity}' was modified outside DoFlow`);
      continue;
    }
    if (wanted && (!entry || fingerprint(entry.value) !== fingerprint(wanted.value))) {
      changes.push({ type: entry ? 'update' : 'create', identity, value: wanted.value, line: entry?.line });
    } else if (!wanted && entry) {
      changes.push({ type: 'remove', identity, line: entry.line });
    }
  }
  if (conflicts.length) return { ok: false, status: 'conflict', file, original, changes: [], conflicts, managedResources };
  const nextLines = [...parsed.lines];
  for (const change of changes.filter((change) => change.type === 'update')) {
    const key = change.identity.split('.').at(-1);
    const originalLine = nextLines[change.line];
    const indentation = originalLine.match(/^\s*/)[0];
    // A user comment beside an owned value is still user content. Retain it even though the
    // owned scalar changes, so reconciliation does not silently erase unrelated explanation.
    const suffix = commentSuffix(originalLine);
    nextLines[change.line] = `${indentation}${key} = ${renderValue(change.value)}${suffix && !/^\s/.test(suffix) ? ' ' : ''}${suffix}`;
  }
  for (const change of changes.filter((change) => change.type === 'remove')) nextLines[change.line] = '';
  // A new key must land INSIDE its own table. Appending at end-of-file only happens to be
  // correct when that table is the file's last one — otherwise the key silently joins whichever
  // table trails the file, so `features.hooks` written after an `[mcp_servers.x]` block becomes
  // `mcp_servers.x.hooks`. Existing tables get an insertion after their final entry; genuinely
  // new tables are appended once each, with all of their keys grouped under a single header.
  const insertions = [];
  const newTables = new Map();
  for (const change of changes.filter((change) => change.type === 'create')) {
    const parts = change.identity.split('.');
    const table = parts.slice(0, -1).join('.');
    const line = `${parts.at(-1)} = ${renderValue(change.value)}`;
    const tableLines = [...parsed.entries.values()].filter((entry) => entry.table === table).map((entry) => entry.line);
    if (tableLines.length) insertions.push({ at: Math.max(...tableLines) + 1, line });
    else newTables.set(table, [...(newTables.get(table) || []), line]);
  }
  // Descending, so an earlier insertion never shifts the index of one still pending.
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) nextLines.splice(insertion.at, 0, insertion.line);
  for (const [table, lines] of newTables) {
    // `''.split(/\r?\n/)` is [`''`]; drop that synthetic line so a brand-new file does
    // not start with an unintended blank line.
    if (nextLines.length === 1 && nextLines[0] === '') nextLines.pop();
    if (nextLines.length && nextLines.at(-1) !== '') nextLines.push('');
    nextLines.push(`[${table}]`, ...lines);
  }
  let content = nextLines.join('\n');
  if (content && !content.endsWith('\n')) content += '\n';
  const nextManagedResources = managedResources.filter((resource) => !isOwnedRecord(resource, scope) || desired.has(resource.identity));
  for (const resource of desired.values()) {
    const index = nextManagedResources.findIndex((item) => isOwnedRecord(item, scope) && item.identity === resource.identity);
    const updated = { ...resource, target: 'codex', scope, kind: CONFIG_KIND, fingerprint: fingerprint(resource.value) };
    if (index >= 0) nextManagedResources[index] = updated;
    else nextManagedResources.push(updated);
  }
  return { ok: true, status: changes.length ? 'change' : 'unchanged', file, original, content, changes, conflicts: [], managedResources: nextManagedResources };
}

function atomicWrite(file, content, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, content, { flag: 'wx' });
    fsImpl.renameSync(temporary, file);
  } finally {
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
}

function applyCodexConfig(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  atomicWrite(plan.file, plan.content, fsImpl);
  return { ...plan, applied: true };
}

function reconcileCodexConfig(options) {
  const file = options.file ?? configPath(options);
  const plan = planCodexConfig({ ...options, file });
  return applyCodexConfig(plan, options);
}

module.exports = { CONFIG_NAME, CONFIG_KIND, configPath, fingerprint, parseToml, planCodexConfig, applyCodexConfig, reconcileCodexConfig, atomicWrite };
