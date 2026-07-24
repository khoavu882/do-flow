'use strict';

// Codex custom-agent projection. Agent contracts are independent TOML documents, so unlike
// config.toml there is no safe key-level merge: a same-named destination is changed only when
// the manifest proves DoFlow owns the exact bytes currently on disk.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./codex-config');

const AGENT_DIRECTORY = 'agents';
const AGENT_KIND = 'custom-agent';
const REQUIRED_FIELDS = ['name', 'description', 'developer_instructions'];
const READ_ONLY_ROLES = new Set([
  'backend-architect', 'deep-research-agent', 'devops-architect', 'frontend-architect',
  'quality-engineer', 'requirements-analyst', 'root-cause-analyst', 'security-engineer',
  'system-architect', 'technical-writer',
]);
const IMPLEMENTATION_ROLES = new Set([
  'performance-engineer', 'pm-agent', 'python-expert', 'refactoring-expert',
]);
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'sandbox_mode']);

function fingerprint(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function assertAgentName(name, label = 'agent name') {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`${label} must be a lowercase kebab-case identifier`);
  }
  return name;
}

function filenameFor(name) {
  assertAgentName(name);
  return `${name}.toml`;
}

function expectedName(fileName) {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !fileName.endsWith('.toml')) {
    throw new Error('Agent filename must be a direct .toml filename');
  }
  return assertAgentName(fileName.slice(0, -'.toml'.length), 'Agent filename');
}

function parseQuoted(value, field, line) {
  if (!/^"(?:[^"\\\n]|\\.)*"$/.test(value)) throw new Error(`${field} must be a quoted TOML string on line ${line}`);
  try { return JSON.parse(value); } catch { throw new Error(`${field} has an invalid quoted value on line ${line}`); }
}

/** Parse the intentionally small TOML contract supported by Codex agent definitions. */
function parseAgentToml(source, { fileName } = {}) {
  if (typeof source !== 'string') throw new Error('Agent TOML source must be text');
  const values = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const triple = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"""\s*$/);
    if (triple) {
      const field = triple[1];
      if (!ALLOWED_FIELDS.has(field)) throw new Error(`Unsupported agent field '${field}'`);
      if (Object.hasOwn(values, field)) throw new Error(`Duplicate agent field '${field}'`);
      const body = [];
      let closed = false;
      while (++index < lines.length) {
        if (/^"""\s*$/.test(lines[index])) { closed = true; break; }
        body.push(lines[index]);
      }
      if (!closed) throw new Error(`${field} has an unterminated multiline string`);
      values[field] = body.join('\n').trim();
      continue;
    }
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!assignment) throw new Error(`Malformed agent TOML on line ${index + 1}`);
    const [, field, raw] = assignment;
    if (!ALLOWED_FIELDS.has(field)) throw new Error(`Unsupported agent field '${field}'`);
    if (Object.hasOwn(values, field)) throw new Error(`Duplicate agent field '${field}'`);
    values[field] = parseQuoted(raw, field, index + 1);
  }
  if (fileName) values._fileName = fileName;
  return values;
}

function validateAgentContract(source, { fileName } = {}) {
  const agent = parseAgentToml(source, { fileName });
  for (const field of REQUIRED_FIELDS) {
    if (typeof agent[field] !== 'string' || !agent[field].trim()) throw new Error(`Agent is missing required '${field}'`);
  }
  assertAgentName(agent.name);
  if (fileName && agent.name !== expectedName(fileName)) throw new Error(`Agent name '${agent.name}' must match filename '${fileName}'`);
  if (agent.description.trim().length < 20) throw new Error(`Agent '${agent.name}' needs a descriptive description`);
  if (agent.developer_instructions.trim().length < 100) throw new Error(`Agent '${agent.name}' needs substantive developer instructions`);
  if (agent.sandbox_mode !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(agent.sandbox_mode)) {
    throw new Error(`Agent '${agent.name}' has an unsupported sandbox_mode`);
  }
  if (READ_ONLY_ROLES.has(agent.name) && agent.sandbox_mode !== 'read-only') {
    throw new Error(`Analysis role '${agent.name}' must use sandbox_mode = "read-only"`);
  }
  if (IMPLEMENTATION_ROLES.has(agent.name) && agent.sandbox_mode !== undefined) {
    throw new Error(`Implementation role '${agent.name}' must inherit its parent sandbox`);
  }
  return Object.freeze({ ...agent, fileName: filenameFor(agent.name) });
}

function agentDirectory({ scope, codexDir, projectRoot }) {
  if (scope === 'global') {
    if (!codexDir) throw new Error('codexDir is required for global Codex agents');
    return path.join(codexDir, AGENT_DIRECTORY);
  }
  if (scope === 'project') {
    if (!projectRoot) throw new Error('projectRoot is required for project Codex agents');
    return path.join(projectRoot, '.codex', AGENT_DIRECTORY);
  }
  throw new Error(`Unsupported Codex agent scope: ${scope}`);
}

function destinationFor(directory, name) {
  const file = path.resolve(directory, filenameFor(name));
  const root = `${path.resolve(directory)}${path.sep}`;
  if (!file.startsWith(root)) throw new Error(`Refusing to write agent '${name}' outside the Codex agents directory`);
  return file;
}

function discoverCodexAgents(sourceDir, fsImpl = fs) {
  if (!sourceDir) throw new Error('sourceDir is required for Codex agents');
  const directory = path.resolve(sourceDir);
  if (!fsImpl.existsSync(directory)) throw new Error(`Codex agent source directory does not exist: ${sourceDir}`);
  const agents = [];
  for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.toml')) continue;
    if (!entry.isFile()) throw new Error(`Codex agent source '${entry.name}' must be a regular file`);
    const name = expectedName(entry.name);
    const source = fsImpl.readFileSync(path.join(directory, entry.name), 'utf8');
    agents.push({ ...validateAgentContract(source, { fileName: entry.name }), name, source, fingerprint: fingerprint(source) });
  }
  if (!agents.length) throw new Error(`No Codex agent TOML contracts found in ${sourceDir}`);
  return agents;
}

function isOwnedResource(resource, scope) {
  return resource && resource.target === 'codex' && resource.scope === scope && resource.kind === AGENT_KIND && typeof resource.identity === 'string';
}

function resourceFor(agent, scope, sourceVersion) {
  return {
    target: 'codex', scope, kind: AGENT_KIND, identity: `agent:${agent.name}`,
    sourceVersion, fingerprint: agent.fingerprint, selection: true,
  };
}

/** Plan all writes before performing any, preserving unknown or user-modified same-name agents. */
function planCodexAgents({ scope, codexDir, projectRoot, sourceDir, sourceVersion = 'unknown', managedResources = [], fsImpl = fs }) {
  const directory = agentDirectory({ scope, codexDir, projectRoot });
  const agents = discoverCodexAgents(sourceDir, fsImpl);
  const owned = new Map(managedResources.filter((resource) => isOwnedResource(resource, scope)).map((resource) => [resource.identity, resource]));
  const changes = [];
  const conflicts = [];
  const nextManagedResources = managedResources.filter((resource) => !isOwnedResource(resource, scope));
  for (const agent of agents) {
    const file = destinationFor(directory, agent.name);
    const identity = `agent:${agent.name}`;
    const record = owned.get(identity);
    const current = fsImpl.existsSync(file) ? fsImpl.readFileSync(file, 'utf8') : null;
    if (current !== null && !record) conflicts.push(`Agent '${agent.name}' exists but is not owned by DoFlow`);
    else if (current !== null && record.fingerprint !== fingerprint(current)) conflicts.push(`Agent '${agent.name}' was modified outside DoFlow`);
    else if (current === null || current !== agent.source) changes.push({ type: current === null ? 'create' : 'update', identity, file, content: agent.source });
    nextManagedResources.push(resourceFor(agent, scope, sourceVersion));
  }
  if (conflicts.length) return { ok: false, status: 'conflict', directory, agents, changes: [], conflicts, managedResources };
  return {
    ok: true, status: changes.length ? 'change' : 'unchanged', directory, agents, changes, conflicts: [],
    managedResources: nextManagedResources,
  };
}

function applyCodexAgents(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok || dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  for (const change of plan.changes) atomicWrite(change.file, change.content, fsImpl);
  return { ...plan, applied: true };
}

function reconcileCodexAgents(options) {
  return applyCodexAgents(planCodexAgents(options), options);
}

module.exports = {
  AGENT_DIRECTORY, AGENT_KIND, READ_ONLY_ROLES, IMPLEMENTATION_ROLES, fingerprint,
  parseAgentToml, validateAgentContract, agentDirectory, destinationFor, discoverCodexAgents,
  planCodexAgents, applyCodexAgents, reconcileCodexAgents,
};
