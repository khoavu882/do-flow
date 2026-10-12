'use strict';

// G28 -- MCP claims. Shipped text may only name servers the registry declares, may not claim an
// `optional` server is used unconditionally, and must agree with the `steps` the registry lists for
// each server. Every name, selection, trigger and step comes from core/registry/mcp.json and
// capabilities.json, so a registry change alters what is checked with no second edit (FR-017).
// `checkMcpClaims` is pure over its inputs so the self-tests below run it over fixture trees.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { mcpIndexPath } = require('../../src/lifecycle/index.ts');

const SKILLS_PREFIX = 'core/shared/skills/';
const CODE_FILES = [
  'src/runtime/mcp-consultations.js',
  'src/runtime/mcp-reach.js',
  'src/runtime/brief-tools.js',
  'core/shared/scripts/doflow/bash/do-task-brief.sh',
];
const OFFLINE_FILES = CODE_FILES.slice(0, 3);
const OFFLINE_MODULES = ['http', 'https', 'net', 'dns'];
const SETUP_DOC = 'docs/setup.md';
const UNCONDITIONAL = /\balways\b|\bno flag\b|\bunconditional(?:ly)?\b/i;
// Quantifier wording ("every run", "at each step", "no exception") only claims universal use when the
// sentence carries no condition: "record each outcome" under a "when available" marker is not a claim.
const QUANTIFIED = /\bevery\b|\beach\b|\bno exception\b/i;
const CONDITION = /\bwhen\b|\bif\b|\bonly\b|\bunless\b|\bwould\b/i;
const universal = (text) => UNCONDITIONAL.test(text) || (QUANTIFIED.test(text) && !CONDITION.test(text));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Sentences of a text with the 1-based line each starts on. Paragraphs split on blank lines,
 * sentences on `.`, `!` or `?` followed by whitespace. */
function sentences(text) {
  const out = [];
  const para = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g;
  for (const p of text.matchAll(para)) {
    const split = /[.!?]+(?=\s)/g;
    let start = 0;
    const cut = (end) => {
      const raw = p[0].slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      if (raw.trim()) out.push({ text: raw.trim(), line: lineOf(text, p.index + start + lead) });
    };
    for (const m of p[0].matchAll(split)) { cut(m.index + m[0].length); start = m.index + m[0].length; }
    cut(p[0].length);
  }
  return out;
}

/**
 * @param {{registry: object, capabilities: object, files: Array<{rel: string, text: string}>,
 *   indexDocs?: string[]}} input  `files` holds the scan set (markdown), the four code files and
 *   docs/setup.md by repo-relative path; `indexDocs` are doc basenames that are generated indexes,
 *   not server docs (D8, read from mcpIndexPath).
 * @returns {string[]} one finding per violation, each naming file:line and the server or name
 */
function checkMcpClaims({ registry, capabilities, files, indexDocs = [] }) {
  const findings = [];
  const servers = registry.servers || [];
  const byId = new Map(servers.map((s) => [s.id, s]));
  const declared = new Set(byId.keys());
  for (const cap of Object.values(capabilities.capabilities || {})) {
    for (const prov of cap.providers || []) if (prov.mcp?.server) declared.add(prov.mcp.server);
  }
  const docs = new Set([...servers.map((s) => path.posix.basename(s.doc || '')), ...indexDocs].filter(Boolean));
  const fileMap = new Map(files.map((f) => [f.rel, f.text]));
  const scan = files.filter((f) => f.rel.endsWith('.md')
    && /^core\/shared\/(skills|agent-specs|guidance)\//.test(f.rel) && path.posix.basename(f.rel) !== 'FLAGS.md');

  for (const { rel, text } of scan) {
    for (const m of text.matchAll(/MCP `([^`\n]+)`/g)) {
      const at = `${rel}:${lineOf(text, m.index)}`;
      if (!declared.has(m[1])) findings.push(`${at}: structural name: MCP \`${m[1]}\` is not declared in the MCP registry`);
      if (!rel.startsWith(SKILLS_PREFIX)) findings.push(`${at}: marker placement: MCP \`${m[1]}\` marker outside ${SKILLS_PREFIX}`);
      if (rel.startsWith(SKILLS_PREFIX) && byId.has(m[1])) {
        const [skill, ...rest] = rel.slice(SKILLS_PREFIX.length).split('/');
        const file = rest.join('/');
        if (!(byId.get(m[1]).steps || []).some((s) => s.skill === skill && s.file === file)) {
          findings.push(`${at}: steps, text to registry: server ${m[1]} has no steps entry for ${skill} ${file}`);
        }
      }
    }
    for (const m of text.matchAll(/mcp__([A-Za-z0-9-]+?)__/g)) {
      if (!declared.has(m[1])) findings.push(`${rel}:${lineOf(text, m.index)}: structural name: mcp__${m[1]}__ is not a declared server`);
    }
    for (const m of text.matchAll(/\bMCP_[A-Za-z0-9]+\.md/g)) {
      if (!docs.has(m[0])) findings.push(`${rel}:${lineOf(text, m.index)}: structural name: ${m[0]} is not a declared server doc`);
    }
    for (const s of sentences(text)) {
      if (universal(s.text)) {
        for (const server of servers) {
          // The id matches in any case; the doc alias (Context7, Sequential) only as the capitalised proper name.
          const alias = path.posix.basename(server.doc || '').replace(/^MCP_|\.md$/g, '');
          const named = (n, flags) => new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`, flags).test(s.text);
          if (server.selection === 'optional' && (named(server.id, 'i') || (alias && named(alias, '')))) {
            findings.push(`${rel}:${s.line}: unconditional claim about optional server ${server.id}`);
          }
        }
      }
      if (s.text.includes('ToolSearch(') && !s.text.includes('Claude Code')) {
        findings.push(`${rel}:${s.line}: harness-specific availability: ToolSearch( sentence lacks "Claude Code"`);
      }
    }
  }

  for (const server of servers) {
    for (const step of server.steps || []) {
      const rel = `${SKILLS_PREFIX}${step.skill}/${step.file}`;
      const text = fileMap.get(rel);
      if (text === undefined) findings.push(`steps, registry to text: server ${server.id}, skill ${step.skill}, file ${step.file} is missing`);
      else if (!text.includes(`MCP \`${server.id}\``)) findings.push(`steps, registry to text: server ${server.id}, skill ${step.skill}, file ${step.file} holds no marker`);
    }
  }

  for (const rel of CODE_FILES) {
    const text = fileMap.get(rel);
    if (text === undefined) continue;
    text.split('\n').forEach((line, i) => {
      for (const server of servers) {
        if (line.includes(server.id)) findings.push(`${rel}:${i + 1}: code names server ${server.id}`);
      }
      if (OFFLINE_FILES.includes(rel)) {
        for (const mod of OFFLINE_MODULES) {
          if (new RegExp(`require\\(\\s*['"](?:node:)?${mod}['"]\\s*\\)|from\\s+['"](?:node:)?${mod}['"]`).test(line)) {
            findings.push(`${rel}:${i + 1}: offline: requires node:${mod}`);
          }
        }
      }
    });
  }

  const setup = fileMap.get(SETUP_DOC) ?? '';
  for (const server of servers) {
    if ((server.steps || []).length && !setup.includes(server.trigger)) {
      findings.push(`${SETUP_DOC}: docs follow the registry: server ${server.id} trigger sentence missing verbatim`);
    }
  }
  return findings;
}

// ---- shipped tree ----

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function shippedFiles() {
  const rels = [
    ...walk(path.join(REPO, 'core', 'shared', 'skills')),
    ...walk(path.join(REPO, 'core', 'shared', 'agent-specs')),
    ...walk(path.join(REPO, 'core', 'shared', 'guidance')),
  ].map((f) => path.relative(REPO, f).split(path.sep).join('/'));
  return [...rels, ...CODE_FILES, SETUP_DOC].map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const indexDocs = () => [path.basename(mcpIndexPath('/x'))];

test('G28: shipped text, registry steps, code and docs agree on MCP servers', () => {
  const findings = checkMcpClaims({
    registry: readJson('core/registry/mcp.json'),
    capabilities: readJson('core/registry/capabilities.json'),
    files: shippedFiles(),
    indexDocs: indexDocs(),
  });
  assert.deepEqual(findings, [], `MCP claims violate the registry:\n${findings.join('\n')}`);
});

// ---- self-tests: each check fails on a bad fixture ----

const REGISTRY = {
  servers: [{
    id: 'context7', selection: 'optional', doc: 'mcp/MCP_Context7.md',
    trigger: 'The work states library behaviour as fact.',
    steps: [{ skill: 'do-design', file: 'SKILL.md' }],
  }],
};
const CAPS = { capabilities: { 'locate-concept': { providers: [{ id: 'semble.search', mcp: { server: 'semble', tool: 'search' } }] } } };
const f = (rel, text) => ({ rel, text });
const DESIGN = `${SKILLS_PREFIX}do-design/SKILL.md`;
const baseFiles = () => [
  f(DESIGN, '# Design\n- MCP `context7`: verify per `MCP_Context7.md`.\n'),
  f('core/shared/agent-specs/a.md', '## Boundaries\nWill use tools when due.\n'),
  ...CODE_FILES.map((rel) => f(rel, 'const x = 1;\n')),
  f(SETUP_DOC, 'Trigger: The work states library behaviour as fact.\n'),
];
const run = (files, registry = REGISTRY, extra = {}) => checkMcpClaims({ registry, capabilities: CAPS, files, ...extra });
const replace = (files, rel, text) => files.map((x) => (x.rel === rel ? f(rel, text) : x));

test('G28 control: clean fixture passes', () => {
  assert.deepEqual(run(baseFiles()), []);
});

test('G28 control: scenario 1 sequence (claim fails, undeclared fails, registry entry fixes it)', () => {
  const claim = replace(baseFiles(), 'core/shared/agent-specs/a.md', '## Boundaries\n\nWill always consult context7 first.\n');
  const r = run(claim);
  assert.equal(r.length, 1);
  assert.match(r[0], /core\/shared\/agent-specs\/a\.md:3: unconditional claim about optional server context7/);

  const acme = replace(baseFiles(), DESIGN, '# Design\n- MCP `context7`: x.\n- MCP `acme-docs`: y.\n');
  const r2 = run(acme);
  assert.ok(r2.some((x) => /SKILL\.md:3: structural name: MCP `acme-docs` is not declared/.test(x)), r2.join('\n'));

  const withAcme = {
    servers: [...REGISTRY.servers, {
      id: 'acme-docs', selection: 'optional', doc: 'mcp/MCP_Acme.md', trigger: 'Acme trigger sentence here.',
      steps: [{ skill: 'do-design', file: 'SKILL.md' }],
    }],
  };
  const files = replace(acme, SETUP_DOC, 'The work states library behaviour as fact. Acme trigger sentence here.\n');
  assert.deepEqual(run(files, withAcme), []);
});

test('G28 control: every/each/no exception phrasing, by id or by doc alias, is an unconditional claim', () => {
  const REG = {
    servers: [
      ...REGISTRY.servers,
      { id: 'sequential-thinking', selection: 'optional', doc: 'mcp/MCP_Sequential.md', trigger: 'T2.', steps: [] },
    ],
  };
  for (const text of [
    'Every design run consults sequential-thinking first.\n',
    'Consult Context7 and Sequential at each step, with no exception.\n',
  ]) {
    const r = run(replace(baseFiles(), 'core/shared/agent-specs/a.md', text), REG);
    assert.ok(r.some((x) => /a\.md:1: unconditional claim about optional server/.test(x)), `${text} -> ${r.join('\n')}`);
  }
  assert.deepEqual(run(replace(baseFiles(), 'core/shared/agent-specs/a.md', 'Consult Context7 when the trigger holds.\n'), REG), []);
});

test('G28 control: undeclared mcp__ tool prefix and server doc fail', () => {
  const r = run(replace(baseFiles(), 'core/shared/agent-specs/a.md', 'Call mcp__acme__go. See MCP_Acme.md.\n'));
  assert.ok(r.some((x) => /a\.md:1: structural name: mcp__acme__/.test(x)), r.join('\n'));
  assert.ok(r.some((x) => /a\.md:1: structural name: MCP_Acme\.md/.test(x)), r.join('\n'));
});

test('G28 control: index doc is accepted only through indexDocs', () => {
  const files = replace(baseFiles(), 'core/shared/agent-specs/a.md', 'See MCP_INDEX.md.\n');
  assert.equal(run(files).length, 1);
  assert.deepEqual(run(files, REGISTRY, { indexDocs: ['MCP_INDEX.md'] }), []);
});

test('G28 control: a marker outside core/shared/skills/ fails', () => {
  const r = run(replace(baseFiles(), 'core/shared/agent-specs/a.md', 'Use MCP `context7` here.\n'));
  assert.ok(r.some((x) => /a\.md:1: marker placement/.test(x)), r.join('\n'));
});

test('G28 control: a skill marker with no steps entry fails (text to registry)', () => {
  const other = `${SKILLS_PREFIX}do-plan/SKILL.md`;
  const r = run([...baseFiles(), f(other, 'x\nMCP `context7`: y\n')]);
  assert.ok(r.some((x) => /do-plan\/SKILL\.md:2: steps, text to registry: server context7/.test(x)), r.join('\n'));
});

test('G28 control: a steps entry whose file lacks its marker, or is missing, fails (registry to text)', () => {
  const r = run(replace(baseFiles(), DESIGN, '# Design\nno marker\n'));
  assert.ok(r.some((x) => /registry to text: server context7, skill do-design, file SKILL\.md holds no marker/.test(x)), r.join('\n'));
  const r2 = run(baseFiles().filter((x) => x.rel !== DESIGN));
  assert.ok(r2.some((x) => /registry to text: server context7, skill do-design, file SKILL\.md is missing/.test(x)), r2.join('\n'));
});

test('G28 control: a ToolSearch( sentence without Claude Code fails, with it passes', () => {
  const bad = run(replace(baseFiles(), 'core/shared/agent-specs/a.md', 'Check ToolSearch("select:x") for the tool.\n'));
  assert.ok(bad.some((x) => /a\.md:1: harness-specific availability/.test(x)), bad.join('\n'));
  const ok = run(replace(baseFiles(), 'core/shared/agent-specs/a.md', 'On Claude Code, ToolSearch("select:x") finds it.\n'));
  assert.deepEqual(ok, []);
});

test('G28 control: a server id literal in each code file fails naming the line', () => {
  for (const rel of CODE_FILES) {
    const r = run(replaceCode(rel, 'const a = 1;\nconst s = "context7";\n'));
    assert.ok(r.some((x) => x.startsWith(`${rel}:2: code names server context7`)), `${rel}: ${r.join('\n')}`);
  }
});
function replaceCode(rel, text) { return replace(baseFiles(), rel, text); }

test('G28 control: a network module in each of the three modules fails the offline check', () => {
  for (const rel of OFFLINE_FILES) {
    for (const mod of OFFLINE_MODULES) {
      const r = run(replaceCode(rel, `const h = require('node:${mod}');\n`));
      assert.ok(r.some((x) => x === `${rel}:1: offline: requires node:${mod}`), `${rel} ${mod}: ${r.join('\n')}`);
    }
  }
});

test('G28 control: docs/setup.md missing a trigger sentence fails', () => {
  const r = run(replace(baseFiles(), SETUP_DOC, 'nothing here\n'));
  assert.ok(r.some((x) => /docs\/setup\.md: docs follow the registry: server context7/.test(x)), r.join('\n'));
});

test('G28 control: FLAGS.md is excluded from the scan set', () => {
  const files = [...baseFiles(), f('core/shared/guidance/FLAGS.md', 'always context7 MCP `nope`\n')];
  assert.deepEqual(run(files), []);
});

module.exports = { checkMcpClaims };
