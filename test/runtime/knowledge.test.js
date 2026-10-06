'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chunkMarkdown, HARD_MAX_CHUNK_CHARS } = require('../../src/runtime/knowledge/chunker');
const { buildIndex, loadIndex, isFresh } = require('../../src/runtime/knowledge/index-store');
const { bm25Rank, searchGuidance } = require('../../src/runtime/knowledge/retrieval');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-know-')); }

const DOC = `---
title: Graphify Guide
---

# Graphify

Intro paragraph about blast radius analysis.

## Usage

Run \`graphify update .\` to rebuild the code graph index on demand.

\`\`\`bash
graphify update --verbose .
\`\`\`

## Notes

The graph powers ${'code.relationships'.replace('.', ' dot ')} queries.`;

test('chunker: frontmatter becomes the title, headings bound sections, fences stay whole', () => {
  const chunks = chunkMarkdown(DOC, { path: 'guides/graphify.md' });
  assert.ok(chunks.every((c) => !c.text.includes('title:')), 'frontmatter must never leak into chunk text');
  const usageChunk = chunks.find((c) => c.text.includes('graphify update'));
  assert.equal(usageChunk.title, 'Graphify Guide › Usage');
  const fenceChunk = chunks.find((c) => c.text.includes('```bash'));
  assert.ok(fenceChunk, 'the fenced block survives as searchable text');
  assert.ok(chunks.some((c) => c.path === 'guides/graphify.md'));
  // Ordinals are stable identities: same doc re-chunked yields the same ids.
  assert.deepEqual(chunkMarkdown(DOC, { path: 'guides/graphify.md' }).map((c) => c.id), chunks.map((c) => c.id));
});

test('chunker: an oversized fenced block stands alone instead of being cut', () => {
  const big = '```\n' + `${'x'.repeat(HARD_MAX_CHUNK_CHARS + 10)}\n` + '```\n';
  const chunks = chunkMarkdown(`## Big\n\npara\n\n${big}\n\nafter`, { path: 'b.md' });
  const lone = chunks.find((c) => c.text.startsWith('```'));
  assert.ok(lone && lone.text.length > HARD_MAX_CHUNK_CHARS);
});

function fixtureCorpus(dir) {
  fs.mkdirSync(path.join(dir, '.doflow', 'guidance'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'guidance', 'graphify.md'), DOC);
  fs.writeFileSync(path.join(dir, '.doflow', 'guidance', 'safety.md'), [
    '# Safety', '', 'RULE_01_SAFETY forbids destructive rm -rf commands without confirmation.', '',
    '## Escalation', '', 'Escalate to the user before deleting anything outside the worktree.',
  ].join('\n'));
}

test('index: builds fresh, detects staleness by digest, and rebuilds only what changed', () => {
  const dir = scratch();
  fixtureCorpus(dir);
  const corpusDir = path.join(dir, '.doflow', 'guidance');
  const indexDir = path.join(dir, '.doflow', 'index', 'guidance');

  const first = buildIndex({ corpusDir, indexDir });
  assert.equal(first.files, 2);
  assert.ok(first.chunks >= 4);
  assert.equal(isFresh({ corpusDir, indexDir }), true);
  assert.deepEqual(loadIndex({ indexDir }).manifest.version, 1);

  // No-op refresh: everything reused, nothing rebuilt.
  const second = buildIndex({ corpusDir, indexDir });
  assert.deepEqual(second.rebuilt, []);
  assert.equal(second.reusedCount, 2);

  // Edit one file: exactly that file is rebuilt; the other keeps its stored chunks.
  fs.appendFileSync(path.join(corpusDir, 'safety.md'), '\nExtra clause about secrets.\n');
  const third = buildIndex({ corpusDir, indexDir });
  assert.deepEqual(third.rebuilt, ['safety.md']);
  assert.equal(third.reusedCount, 1);

  // Delete a file: it leaves no orphaned manifest entry or chunks behind.
  fs.rmSync(path.join(corpusDir, 'graphify.md'));
  buildIndex({ corpusDir, indexDir });
  const loaded = loadIndex({ indexDir });
  assert.ok(loaded.chunks.every((c) => c.path !== 'graphify.md'));
});

test('bm25 ranks the exact-term document first and ignores stopword-only queries', () => {
  const dir = scratch();
  fixtureCorpus(dir);
  const corpusDir = path.join(dir, '.doflow', 'guidance');
  const indexDir = path.join(dir, '.doflow', 'index', 'guidance');
  buildIndex({ corpusDir, indexDir });
  const { chunks } = loadIndex({ indexDir });

  const hits = bm25Rank('rm -rf destructive confirmation', chunks, { k: 3 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].path, /safety\.md$/);
  assert.ok(hits[0].score > 0);

  const empty = bm25Rank('the and of', chunks, { k: 3 });
  assert.deepEqual(empty, []);
});

test('searchGuidance auto-rebuilds when stale and answers through the full stack', () => {
  const dir = scratch();
  fixtureCorpus(dir);
  const corpusDir = path.join(dir, '.doflow', 'guidance');
  const indexDir = path.join(dir, '.doflow', 'index', 'guidance');

  const before = searchGuidance({ corpusDir, indexDir, query: 'blast radius' });
  assert.equal(before.rebuilt.length, 2, 'first call builds from nothing');
  assert.match(before.results[0].path, /graphify\.md$/);

  fs.appendFileSync(path.join(corpusDir, 'graphify.md'), '\nPostscript mentioning escalation paths.\n');
  const after = searchGuidance({ corpusDir, indexDir, query: 'escalation' });
  assert.equal(after.rebuilt.length, 1);
  assert.ok(after.results.length >= 1);

  assert.throws(() => searchGuidance({
    corpusDir: path.join(dir, 'nope'),
    indexDir, query: 'x',
  }), /No guidance tree found/);
});

// `retrieve` finds its guidance tree the way the dispatcher finds its config dir: the nearest
// `.doflow` above the working directory, else the home install.
function retrieveFrom(cwd, home) {
  const { DOFLOW_CONFIG_DIR: _unset, ...env } = process.env;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/doflow.js'), 'retrieve', '--query', 'escalation', '--json'],
    { cwd, env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).results;
}

test('retrieve answers from a project subdirectory and from a home-only install', () => {
  const project = fs.realpathSync(scratch()); const home = fs.realpathSync(scratch());
  fixtureCorpus(project);
  const sub = path.join(project, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(retrieveFrom(sub, home).some((hit) => hit.path === 'safety.md'), 'project tree reached from a subdirectory');

  const elsewhere = fs.realpathSync(scratch());
  fixtureCorpus(home);
  assert.ok(retrieveFrom(elsewhere, home).some((hit) => hit.path === 'safety.md'), 'home tree reached with no project install');
});

test('retrieve prefers the nearest project tree over the home tree', () => {
  const project = fs.realpathSync(scratch()); const home = fs.realpathSync(scratch());
  fixtureCorpus(home);
  fs.mkdirSync(path.join(project, '.doflow', 'guidance'), { recursive: true });
  fs.writeFileSync(path.join(project, '.doflow', 'guidance', 'project.md'), '# Project\n\nEscalation goes to the project owner.\n');
  const paths = retrieveFrom(project, home).map((hit) => hit.path);
  assert.deepEqual(paths, ['project.md']);
});
