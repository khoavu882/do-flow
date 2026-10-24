'use strict';

// The always-loaded measurement helper (074 C15, IC-019), extracted unchanged from
// test/guards/context-budget.test.js so the perf runner can report the same startup byte total
// the G13 guard enforces.
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE } = require('../guards/_shared.ts');
const { GENERATED_EXCLUSIONS, guidanceManifest } = require('../../src/adapters/guidance-manifest.ts');

/** Newline-separated lines, without the empty line a trailing newline would add. */
function lineCount(text: any) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** `@relative/path.md` at the start of a line — the import syntax DOFLOW_CORE.md actually uses. */
function importsIn(text: any) {
  return [...text.matchAll(/^@(\S+)$/gm)].map(([, target]) => target);
}

/**
 * The always-loaded set, walked transitively from DOFLOW_CORE.md rather than hardcoded.
 *
 * A hardcoded file list is the failure mode this ceiling exists to prevent: it silently stops
 * covering a file the moment someone adds one to the set, which is exactly when the budget most
 * needs to bind. Returns { files, dangling, excluded } — relative to the guidance root.
 */
function alwaysLoaded() {
  const manifest = guidanceManifest(GUIDANCE, fs);
  const files = manifest.files.map((rel: any) => {
    const full = path.join(GUIDANCE, rel);
    const text = fs.readFileSync(full, 'utf8');
    return { rel, lines: lineCount(text), bytes: Buffer.byteLength(text, 'utf8') };
  });
  return { files, dangling: manifest.dangling, excluded: manifest.generated };
}

/** Every `*.md` under `dir` (repo-relative), depth first. */
function markdownUnder(dir: any) {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry: any) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

/** Lines and bytes of every `*.md` under a directory, or of one file, after an optional transform. */
function measureSource(sourceRel: any, transform: any) {
  const full = path.join(REPO, sourceRel);
  const names = fs.statSync(full).isDirectory() ? markdownUnder(sourceRel) : [sourceRel];
  return names.reduce((total: any, rel: any) => {
    let bytes = fs.readFileSync(path.join(REPO, rel));
    if (transform) bytes = transform(rel, bytes);
    return { lines: total.lines + lineCount(bytes.toString('utf8')), bytes: total.bytes + bytes.length };
  }, { lines: 0, bytes: 0 });
}

module.exports = { GENERATED_EXCLUSIONS, alwaysLoaded, measureSource, lineCount, importsIn, markdownUnder };
