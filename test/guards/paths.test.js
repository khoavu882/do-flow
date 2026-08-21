'use strict';

// G2 — path reachability. Generalizes the two guards added in v0.8.0, where an `MCP_INDEX.md`
// doc path resolved against the wrong directory and pointed at nothing. Relative paths in
// content are effectively untyped: nothing errors when one stops resolving.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { loadRegistry, selectMcpServers } = require('../../src/registry');
const { renderMcpIndex } = require('../../src/lifecycle/mcp-index');
const { mcpIndexPath } = require('../../src/lifecycle');
const { REPO, GUIDANCE } = require('./_shared');

const DOFLOW_CORE = path.join(GUIDANCE, 'DOFLOW_CORE.md');

test('G2: every @import in DOFLOW_CORE.md resolves against the guidance tree', () => {
  const imports = fs.readFileSync(DOFLOW_CORE, 'utf8').split('\n')
    .filter((line) => line.startsWith('@')).map((line) => line.slice(1).trim());
  assert.ok(imports.length, 'DOFLOW_CORE.md must declare at least one always-loaded import');
  const missing = imports
    // MCP_INDEX.md is generated per install by applyLifecycle, so it has no core/ counterpart to
    // stat here. The paths it *emits* are covered by the next test, which renders it for real.
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

// The generated index is the other half of path reachability, and the half that actually broke:
// mcp.yaml's `doc` values are relative, so they are only meaningful against the directory
// MCP_INDEX.md is written into. In v0.8.0 the index moved one level deeper and every pointer
// silently aimed at a path that never existed. This guard resolves them the way an agent does —
// render the index, read each emitted path, resolve it from the index's own location — so the
// anchor is pinned from both ends rather than assumed.
test('G2: every doc path the generated MCP index emits resolves from the index location', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const servers = selectMcpServers(registry, Array.from(registry.mcp, (server) => server.id));
  assert.ok(servers.length > 0, 'the registry must declare at least one MCP server to guard');

  const guidanceRoot = path.join('/scope', '.doflow', 'guidance');
  const indexDir = path.dirname(mcpIndexPath('/scope'));
  const relativeToRoot = path.relative(guidanceRoot, indexDir);

  const emitted = renderMcpIndex(servers).split('\n')
    .filter((line) => line.startsWith('@'))
    .map((line) => line.slice(1).trim());
  // A parser that matches nothing makes every assertion below vacuously true — the exact way the
  // v0.8.0 test failed. Pin the count to the input so a format change fails loudly instead.
  assert.equal(emitted.length, servers.length,
    'every selected server must emit exactly one @import; a silent parse mismatch would make this guard vacuous');

  const missing = emitted.filter((rel) => !fs.existsSync(path.join(GUIDANCE, relativeToRoot, rel)));
  assert.deepEqual(missing, [],
    `MCP_INDEX.md emits doc paths that do not resolve from its own directory: ${missing.join(', ')}`);
});

test('G2: no tracked file outside bench/runs embeds an absolute home directory path', () => {
  // An absolute /Users/<name> or /home/<name> path is meaningless in anyone else's checkout and
  // leaks the author's local layout into a public repository. 181 tracked files carried one; 179
  // are bench transcripts, whose write happens in the dispatch harness outside this repo — nothing
  // here writes a transcript, so there is no generation-time fix available to make. bench/runs is
  // therefore excluded and the remaining two files were redacted, which is what this keeps true.
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('bench/runs/'));

  const offenders = [];
  for (const rel of tracked) {
    const full = path.join(REPO, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // unreadable or binary — not this guard's business
    }
    // A path inside a code span or a comment is being *described*, not embedded: CHANGELOG.md
    // quotes `/home/user/claude-skills/…` as a generic placeholder, and doflow-run's header quotes
    // the error message "Cannot find module '/Users/bin/doflow.js'" from the defect it explains.
    // Neither is anyone's home directory — the second is not even a real one, and matched only
    // because the pattern read "bin" as a username.
    //
    // Stripping code spans and comment lines is the same distinction the analysers had to learn
    // between text about code and code. This is the fifth place in this repo that needed it, which
    // is itself the argument for doing it here rather than adding another allowlist entry.
    const prosed = text
      .replace(/`[^`\n]*`/g, '')
      .split('\n')
      .filter((l) => !/^\s*(?:#|\/\/|\*)/.test(l))
      .join('\n');
    // Shape alone does not separate a leaked home directory from a fabricated one. Every hit this
    // guard produced after the redaction was a placeholder: `/home/user/…` quoted in the changelog,
    // "/Users/bin/doflow.js" quoted from an error message, and /home/user/project-a passed to a
    // hash function as test input. What actually matters is whose home it is, so generic names are
    // not flagged and a real account name is.
    const PLACEHOLDER_NAMES = new Set(['user', 'users', 'you', 'me', 'someone', 'example', 'bin', 'test', 'name']);
    for (const m of prosed.matchAll(/\/(?:Users|home)\/([a-z][a-z0-9_-]*)\//g)) {
      if (!PLACEHOLDER_NAMES.has(m[1])) {
        offenders.push(`${rel} -> ${m[0]}`);
        break;
      }
    }
  }
  offenders.sort();

  assert.deepEqual(offenders, [],
    'these tracked files embed an absolute home directory path, which is meaningless in another '
    + `checkout and public once pushed:\n  ${offenders.join('\n  ')}`);
});
