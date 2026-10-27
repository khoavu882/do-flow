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
/** Top-level frontmatter keys of a text, bare or quoted (`"key":`, `'key':`), quotes removed. */
function frontmatterKeysOf(text: any) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const keys: any = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    if (/^\s/.test(line) || !line.trim()) continue;          // nested value, not a top-level key
    const match = line.match(/^(?:"((?:[^"\\]|\\.)+)"|'((?:[^']|'')+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:/);
    if (match) keys.push(match[1]?.replace(/\\(.)/g, '$1') ?? match[2]?.replace(/''/g, "'") ?? match[3]);
  }
  return keys;
}

function frontmatterKeys(file: any) {
  return frontmatterKeysOf(fs.readFileSync(file, 'utf8'));
}

function skillFiles() {
  return fs.readdirSync(SKILLS)
    .map((name: any) => ({ name, file: path.join(SKILLS, name, 'SKILL.md') }))
    .filter((entry: any) => fs.existsSync(entry.file));
}

function agentSpecFiles() {
  return fs.readdirSync(AGENT_SPECS)
    .filter((name: any) => name.endsWith('.md'))
    .map((name: any) => ({ name, file: path.join(AGENT_SPECS, name) }));
}

/** Every file under core/ as text, for "is this declaration referenced anywhere?" scans. `rel` is
 * normalized to forward slashes so guards can match it against literal `core/...` prefixes on any
 * platform's separator. */
function coreTextFiles({ exclude = [] }: any = {}) {
  const out: any = [];
  const excluded = exclude.map((p: any) => path.resolve(REPO, p));
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (excluded.includes(full)) continue;
      if (!/\.(md|json|yaml|toml|sh|conf)$/.test(entry.name)) continue;
      out.push({
        file: full,
        rel: path.relative(REPO, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  }(path.join(REPO, 'core')));
  return out;
}

/** Every verb `doflow-run` dispatches: the shell-backed `shell_helper_for()` labels, the Node-backed
 * `is_node_verb()` alternation, and `help`. `\r?\n` keeps the parse working on CRLF checkouts. */
function dispatcherVerbs() {
  const text = fs.readFileSync(path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run'), 'utf8');
  const shellBlock = text.match(/shell_helper_for\(\)\s*\{([\s\S]*?)\r?\n\}/);
  const nodeBlock = text.match(/is_node_verb\(\)\s*\{([\s\S]*?)\r?\n\}/);
  const shell = shellBlock ? [...shellBlock[1].matchAll(/^\s*([a-z][a-z-]*)\)\s*printf/gm)].map(([, verb]) => verb) : [];
  const alternation = nodeBlock?.[1].replace(/\\\r?\n/g, '').match(/^\s*([a-z|-]+)\)\s*return 0/m)?.[1];
  const node = alternation ? alternation.split('|').map((verb: any) => verb.trim()).filter(Boolean) : [];
  if (!shell.length) throw new Error('dispatcher verb table unparseable: shell_helper_for()');
  if (!node.length) throw new Error('dispatcher verb table unparseable: is_node_verb()');
  return new Set([...shell, ...node, 'help']);
}

module.exports = {
  REPO, GUIDANCE, SKILLS, AGENT_SPECS, frontmatterKeys, frontmatterKeysOf, skillFiles, agentSpecFiles, coreTextFiles, dispatcherVerbs,
};
