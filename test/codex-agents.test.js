'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SOURCE_ROLES = path.join(REPO, 'core', 'shared', 'agent-specs');
const CODEX_AGENTS = path.join(REPO, 'core', 'harnesses', 'codex', 'agents');
const REQUIRED_FIELDS = ['name', 'description', 'developer_instructions'];
const READ_ONLY_ROLES = new Set([
  'backend-architect', 'deep-research-agent', 'devops-architect', 'frontend-architect',
  'quality-engineer', 'requirements-analyst', 'root-cause-analyst', 'security-engineer',
  'system-architect', 'technical-writer',
]);

function parseAgentToml(source, file) {
  assert.match(source, /^(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"\n]*"|"""[\s\S]*?"""))\s*$/m, `${file} must contain TOML assignments`);
  const values = {};
  for (const field of ['name', 'description', 'sandbox_mode']) {
    const match = source.match(new RegExp(`^${field}\\s*=\\s*"([^"\\n]+)"\\s*$`, 'm'));
    if (match) values[field] = match[1];
  }
  const instructions = source.match(/^developer_instructions\s*=\s*"""\n([\s\S]*?)\n"""\s*$/m);
  if (instructions) values.developer_instructions = instructions[1].trim();
  return values;
}

test('Codex custom-agent files cover every canonical specialist role', () => {
  const roles = fs.readdirSync(SOURCE_ROLES)
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.basename(file, '.md'))
    .sort();
  const agents = fs.readdirSync(CODEX_AGENTS)
    .filter((file) => file.endsWith('.toml'))
    .map((file) => path.basename(file, '.toml'))
    .sort();

  assert.deepStrictEqual(agents, roles);
});

test('every Codex custom-agent file has the required schema and valid narrow TOML content', () => {
  for (const file of fs.readdirSync(CODEX_AGENTS).filter((entry) => entry.endsWith('.toml'))) {
    const source = fs.readFileSync(path.join(CODEX_AGENTS, file), 'utf8');
    const agent = parseAgentToml(source, file);
    for (const field of REQUIRED_FIELDS) assert.ok(agent[field], `${file} is missing ${field}`);
    assert.strictEqual(agent.name, path.basename(file, '.toml'), `${file} name must match its filename`);
    assert.ok(agent.description.length >= 20, `${file} description must tell an orchestrator when to use it`);
    assert.ok(agent.developer_instructions.length >= 100, `${file} needs substantive developer instructions`);
    assert.ok(!/\bTODO\b|not implemented/i.test(agent.developer_instructions), `${file} must not contain implementation placeholders`);
  }
});

test('analysis-only roles use least-privilege read-only sandboxes and prohibit writes', () => {
  for (const role of READ_ONLY_ROLES) {
    const source = fs.readFileSync(path.join(CODEX_AGENTS, `${role}.toml`), 'utf8');
    const agent = parseAgentToml(source, `${role}.toml`);
    assert.strictEqual(agent.sandbox_mode, 'read-only', `${role} must be read-only`);
    assert.match(agent.developer_instructions, /do not (?:make workspace changes|modify|edit|implement|change)/i, `${role} must explicitly prohibit writes`);
  }
});

test('implementation-oriented roles do not receive an unnecessary read-only sandbox', () => {
  for (const role of ['performance-engineer', 'pm-agent', 'python-expert', 'refactoring-expert']) {
    const source = fs.readFileSync(path.join(CODEX_AGENTS, `${role}.toml`), 'utf8');
    const agent = parseAgentToml(source, `${role}.toml`);
    assert.strictEqual(agent.sandbox_mode, undefined, `${role} must inherit the parent sandbox for requested implementation work`);
  }
});
