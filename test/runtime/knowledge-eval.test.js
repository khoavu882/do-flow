'use strict';

// Retrieval eval gate: retrieval is measured like code. A fixed fixture corpus
// with golden query→document pairs runs on every `npm test`: any future change to the chunker or
// the ranker that drops a hit@k below 1.0 turns the suite red here first, with every miss named.
// Offline by construction — no model calls, no network; this asserts the floor lexical ranking
// assigns to lexical ranking, asserted rather than assumed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchGuidance } = require('../../src/runtime/knowledge/retrieval');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-knoweval-')); }

const CORPUS = {
  'DOFLOW_CORE.md': [
    '# DoFlow Core',
    '',
    '@rollback.md @hooks-trust.md @mcp-servers.md @skills-standard.md',
    '',
    'Core guidance pointer. Read the imported documents for deployment safety, hook trust',
    'gating, MCP server selection, and the skill authoring standard.',
  ].join('\n'),
  'rollback.md': [
    '## Rollback',
    '',
    'Every install creates a timestamped backup. Restore with the backup id:',
    '`doflow rollback -g install_YYYY-MM-DD_HH-MM-SS`. List ids with list-backups.',
  ].join('\n'),
  'hooks-trust.md': [
    '## Hook trust gating',
    '',
    'Codex and Gemini gate hooks behind their own review step; DoFlow writes the configuration',
    'but nothing executes until approved in that tool. Kiro hooks fire immediately with no gate.',
  ].join('\n'),
  'mcp-servers.md': [
    '## MCP server selection',
    '',
    'Selected servers are recorded per tool. The context7 catalog entry is optional; selection is',
    'remembered in the manifest and reused by update instead of re-prompting.',
  ].join('\n'),
  'skills-standard.md': [
    '## Skill authoring standard',
    '',
    'A skill is a folder with SKILL.md carrying YAML frontmatter: name and description are',
    'required per the agentskills.io open standard; scripts and references travel alongside.',
  ].join('\n'),
  'tombstones.md': [
    '## Tombstones and moved projections',
    '',
    'When an asset destination changes between versions the old location is journaled as a',
    "tombstone and the stale copy swept only if its bytes still match the verified fingerprint.",
  ].join('\n'),
};

// Golden pairs: each query must surface its document inside the top-k ORGANIC (lexical) hits.
// Queries are written the way an operator would ask, not with the document's own exact strings,
// so the eval measures ranking rather than substring luck.
const GOLDEN = [
  { query: 'restore previous installation state after a bad update', expect: 'rollback.md', k: 3 },
  { query: 'which tools run my hooks without asking me first', expect: 'hooks-trust.md', k: 3 },
  { query: 'approve automation before it executes in codex', expect: 'hooks-trust.md', k: 3 },
  { query: 'remember which servers were chosen last time', expect: 'mcp-servers.md', k: 3 },
  { query: 'required frontmatter fields for authoring a new skill folder', expect: 'skills-standard.md', k: 3 },
  { query: 'cleanup of stale copies after a destination changed between versions', expect: 'tombstones.md', k: 3 },
];

test('golden retrieval set: every query finds its document within top-k', () => {
  const dir = scratch();
  const corpusDir = path.join(dir, '.doflow', 'guidance');
  fs.mkdirSync(corpusDir, { recursive: true });
  for (const [name, body] of Object.entries(CORPUS)) fs.writeFileSync(path.join(corpusDir, name), body);
  const indexDir = path.join(dir, '.doflow', 'index', 'guidance');

  const misses = [];
  for (const { query, expect, k } of GOLDEN) {
    const { results } = searchGuidance({ corpusDir, indexDir, query, k });
    // Measure the RANKER: organic lexical hits only, never the graph extension.
    const organic = results.filter((result) => !result.viaGraph);
    if (!organic.some((result) => result.path === expect)) {
      misses.push(`  "${query}" → expected ${expect} in top-${k}, got [${organic.map((r) => r.path).join(', ') || 'nothing'}]`);
    }
  }
  assert.deepEqual(misses, [], `retrieval eval regressed below hit@k=1.0 (${GOLDEN.length - misses.length}/${GOLDEN.length} passed):\n${misses.join('\n')}`);
});

test('graph expansion: a strong anchor hit offers its imports as read-next, flagged and non-displacing', () => {
  const dir = scratch();
  const corpusDir = path.join(dir, '.doflow', 'guidance');
  fs.mkdirSync(corpusDir, { recursive: true });
  for (const [name, body] of Object.entries(CORPUS)) fs.writeFileSync(path.join(corpusDir, name), body);
  const indexDir = path.join(dir, '.doflow', 'index', 'guidance');

  // This query's vocabulary lives only in DOFLOW_CORE.md, making it the anchor hit.
  const { results } = searchGuidance({ corpusDir, indexDir, query: 'core guidance pointer imported documents', k: 2 });
  assert.equal(results[0].path, 'DOFLOW_CORE.md');
  const organicCount = results.filter((r) => !r.viaGraph).length;
  assert.ok(organicCount >= 1 && organicCount <= 2, 'organic hits keep their slots');
  const graphed = results.filter((r) => r.viaGraph);
  assert.ok(graphed.length >= 1, 'at least one import offered as read-next');
  for (const entry of graphed) {
    assert.match(entry.viaGraph, /DOFLOW_CORE\.md$/);
    assert.ok(Object.keys(CORPUS).includes(entry.path), 'graph targets exist in the corpus');
    assert.equal(entry.score, null, 'graph entries carry no fabricated lexical score');
  }
});
