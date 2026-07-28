'use strict';

// Shared helpers for the context-layer reachability guards. Each guard family lives in its own
// file so the four independent ones stay parallel-safe; this module holds only the parsing they
// all need, never assertions.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const GUIDANCE = path.join(REPO, 'core', 'shared', 'guidance');
const SKILLS = path.join(REPO, 'core', 'shared', 'skills');
const AGENT_SPECS = path.join(REPO, 'core', 'shared', 'agent-specs');

/** Frontmatter keys only — values are irrelevant to every guard here, and parsing them would mean
 * taking on a YAML dependency this repo deliberately does not have. */
function frontmatterKeys(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const keys = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    if (/^\s/.test(line) || !line.trim()) continue;          // nested value, not a top-level key
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function skillFiles() {
  return fs.readdirSync(SKILLS)
    .map((name) => ({ name, file: path.join(SKILLS, name, 'SKILL.md') }))
    .filter((entry) => fs.existsSync(entry.file));
}

function agentSpecFiles() {
  return fs.readdirSync(AGENT_SPECS)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, file: path.join(AGENT_SPECS, name) }));
}

/** Every file under core/ as text, for "is this declaration referenced anywhere?" scans. */
function coreTextFiles({ exclude = [] } = {}) {
  const out = [];
  const excluded = exclude.map((p) => path.resolve(REPO, p));
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (excluded.includes(full)) continue;
      if (!/\.(md|json|yaml|toml|sh|conf)$/.test(entry.name)) continue;
      out.push({ file: full, rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
    }
  }(path.join(REPO, 'core')));
  return out;
}

module.exports = { REPO, GUIDANCE, SKILLS, AGENT_SPECS, frontmatterKeys, skillFiles, agentSpecFiles, coreTextFiles };
