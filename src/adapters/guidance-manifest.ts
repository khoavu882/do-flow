'use strict';

// The shared, harness-neutral core set: the breadth-first @-import walk rooted at DOFLOW_CORE.md.
const fs = require('node:fs');
const path = require('node:path');

// Generated per install, excluded by name rather than forgotten.
//
// MCP_INDEX.md and everything it imports under guidance/mcp/ are written at install time from the
// MCP servers the user actually selected. Their size is a property of the machine, not of
// DoFlow-authored content, and it differs between two correct installs — so the import walk stops
// at MCP_INDEX.md and does not descend into its @mcp/* imports.
const GENERATED_EXCLUSIONS = new Map<string, string>([
  ['MCP_INDEX.md', 'generated per install from the servers actually selected; size varies per machine'],
]);

function importsIn(text: string): string[] {
  return [...text.matchAll(/^@(\S+)$/gm)].map(([, target]) => target);
}

function guidanceManifest(root: string, fsImpl: any = fs): { files: string[], generated: string[], dangling: string[] } {
  const rootFile = 'DOFLOW_CORE.md';
  if (!fsImpl.existsSync(path.join(root, rootFile))) {
    throw new Error(`guidanceManifest root is missing ${rootFile}: ${root}`);
  }

  const files: string[] = [];
  const generated: string[] = [];
  const dangling: string[] = [];
  const seen = new Set<string>();
  const queue = [rootFile];

  while (queue.length) {
    const rel = path.posix.normalize(queue.shift()!.replace(/\\/g, '/'));
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (GENERATED_EXCLUSIONS.has(rel)) { generated.push(rel); continue; }

    const full = path.join(root, ...rel.split('/'));
    if (!fsImpl.existsSync(full)) { dangling.push(rel); continue; }
    const text = fsImpl.readFileSync(full, 'utf8');
    files.push(rel);
    for (const target of importsIn(text)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), target)));
    }
  }

  return { files, generated, dangling };
}

module.exports = { GENERATED_EXCLUSIONS, guidanceManifest };
