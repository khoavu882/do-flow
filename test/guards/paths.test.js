'use strict';

// G2 — path reachability. Generalizes the two guards added in v0.8.0, where an `MCP_INDEX.md`
// doc path resolved against the wrong directory and pointed at nothing. Relative paths in
// content are effectively untyped: nothing errors when one stops resolving.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE } = require('./_shared');

const DOFLOW_CORE = path.join(GUIDANCE, 'DOFLOW_CORE.md');

test('G2: every @import in DOFLOW_CORE.md resolves against the guidance tree', () => {
  const imports = fs.readFileSync(DOFLOW_CORE, 'utf8').split('\n')
    .filter((line) => line.startsWith('@')).map((line) => line.slice(1).trim());
  assert.ok(imports.length, 'DOFLOW_CORE.md must declare at least one always-loaded import');
  const missing = imports
    // MCP_INDEX.md is generated per install by applyLifecycle and has no core/ counterpart;
    // its own resolution is guarded in test/mcp-index.test.js.
    .filter((rel) => rel !== 'MCP_INDEX.md' && !fs.existsSync(path.join(GUIDANCE, rel)));
  assert.deepEqual(missing, [], `DOFLOW_CORE.md imports paths that do not exist: ${missing.join(', ')}`);
});

test('G2: every guidance directory advertised in DOFLOW_CORE.md exists', () => {
  const text = fs.readFileSync(DOFLOW_CORE, 'utf8');
  const missing = (text.match(/@[a-z]+\//g) ?? [])
    .map((token) => token.slice(1))
    .filter((dir) => !fs.existsSync(path.join(GUIDANCE, dir)));
  assert.deepEqual([...new Set(missing)], [], 'DOFLOW_CORE.md advertises directories that do not exist');
});

test('G2: every guidance-relative markdown link in the guidance tree resolves', () => {
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // Only backticked relative paths that look like guidance files — prose and URLs are noise.
      for (const [, rel] of text.matchAll(/`((?:rules|modes|mcp|references)\/[A-Za-z0-9_./-]+\.md)`/g)) {
        if (!fs.existsSync(path.join(GUIDANCE, rel))) offenders.push(`${path.relative(GUIDANCE, full)} -> ${rel}`);
      }
    }
  }(GUIDANCE));
  assert.deepEqual(offenders, [], `guidance files reference paths that do not resolve:\n  ${offenders.join('\n  ')}`);
});
