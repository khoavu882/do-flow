'use strict';

// TypeScript migration: run directly by Node native type-stripping.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTaxonomy, isPlainText, isUserContextPath } = require('../intake/taxonomy.ts');

/** The user's own files (feature 136's intake): a feature folder's `additional-context/`. Markdown there up to
 * `pointerMaxBytes` of core/registry/intake.json becomes pointers; nothing else does. */
const USER_CONTEXT_DIR = 'additional-context';

/** The registry's byte cap, or null when the taxonomy cannot be read (intake is then off: no user pointers). */
function userPointerMaxBytes(file?: string): number | null {
  const loaded = loadTaxonomy({ file, contributions: false });
  return loaded.ok ? loaded.taxonomy.pointerMaxBytes : null;
}

/** `'user-provided'` for a project-relative path inside `agent-docs/doflow/<slug>/additional-context/`, else null. */
function originOf(rel: string): 'user-provided' | null {
  return isUserContextPath(rel) ? 'user-provided' : null;
}

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function inside(root: string, file: string, fsImpl = fs): string | null {
  const absolute = path.resolve(file);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fsImpl.realpathSync(path.resolve(root));
    realFile = fsImpl.realpathSync(absolute);
  } catch { return null; }
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const normalized = relative.split(path.sep).join('/');
  if (normalized.split('/').includes('state')) return null;
  return normalized;
}

/** `file` as a '/'-separated path under `root` as written, links not resolved, or null when it is not under `root`.
 * A pointer keeps this logical path: a linked `agent-docs/` must not hide a user file from the ledger's path test. */
function logicalRel(root: string, file: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function lineSlice(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n') + '\n';
}

function rangesFor(file: string, text: string, requirement: boolean): Array<{ startLine: number; endLine: number; heading: string | null }> {
  const lines = text.split(/\r?\n/);
  const result: Array<{ startLine: number; endLine: number; heading: string | null }> = [];
  if (requirement) {
    let section = '';
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^##\s+(.*)$/);
      if (heading) section = heading[1];
      if (!/^##\s+[34](?:[.)]|\s|$)/.test(lines[i])) continue;
      let end = i + 1;
      while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
      for (let j = i + 1; j < end; j++) {
        if (!/^\s*\*\*Detail:?\*\*/i.test(lines[j])) continue;
        let blockEnd = j + 1;
        while (blockEnd < end && !/^\s*\*\*[A-Za-z][^*]*:?\*\*/.test(lines[blockEnd])) blockEnd++;
        result.push({ startLine: j + 1, endLine: blockEnd, heading: section || null });
        j = blockEnd - 1;
      }
      i = end - 1;
    }
    return result;
  }
  let start = -1;
  let title: string | null = null;
  const flush = (end: number) => {
    if (start >= 0 && end >= start) result.push({ startLine: start + 1, endLine: end, heading: title });
  };
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+)$/);
    if (heading) {
      flush(i);
      start = i;
      title = heading[1].trim();
    }
  }
  flush(lines.length);
  return result;
}

function createPointer({ path: rel, heading, range, slice, user = false }: any): any {
  const bytes = Buffer.byteLength(slice, 'utf8');
  return {
    id: `ptr:${rel}:${range.startLine}-${range.endLine}`,
    path: rel,
    heading,
    range,
    digest: sha256(slice),
    bytes,
    tokensEst: { value: Math.ceil(bytes / 4), basis: 'estimated:bytes/4' },
    inlineBytes: Buffer.byteLength(`- ptr:${rel}:${range.startLine}-${range.endLine} ${rel}:${range.startLine}-${range.endLine} ${bytes} B\n`, 'utf8'),
    load: `read ${rel} lines ${range.startLine}-${range.endLine}`,
    origin: user ? 'user-provided' : originOf(rel),
  };
}

/** Visible, regular `.md` files under a context folder, `.intake/` and every dotfile or symlink left out,
 * in byte order of path. A folder that is absent, or itself a symlink, gives none. */
function userContextFiles(dir: string, fsImpl = fs): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: any[];
    try { entries = fsImpl.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  };
  try { if (fsImpl.lstatSync(dir).isSymbolicLink()) return []; } catch { return []; }
  walk(dir);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sourceFiles({ projectRoot, feature, fsImpl = fs, intakeFile }: any): Array<{ absolute: string; requirement: boolean; user: boolean }> {
  const root = path.resolve(projectRoot);
  const featureDir = feature?.featureDir ? path.resolve(feature.featureDir) : null;
  const candidates: Array<{ absolute: string; requirement: boolean; user: boolean }> = [];
  const add = (file: string | null | undefined, requirement = false, maxBytes = Infinity, user = false) => {
    if (!file) return;
    const absolute = path.isAbsolute(file) ? file : path.resolve(feature?.repoRoot || root, file);
    let stat: any;
    try { stat = fsImpl.statSync(absolute); } catch { return; }
    if (!inside(root, absolute, fsImpl) || !stat.isFile() || stat.size > maxBytes) return;
    const known = candidates.find((item) => item.absolute === absolute);
    if (known) known.user ||= user;
    else candidates.push({ absolute, requirement, user });
  };
  if (featureDir) {
    add(feature.paths?.requirement || path.join(featureDir, 'intention', 'requirement.md'), true);
    for (const file of [
      feature.paths?.design,
      feature.paths?.plan,
      path.join(featureDir, 'design', 'design.md'),
      path.join(featureDir, 'design', 'specs.md'),
      path.join(featureDir, 'design', 'data-model.md'),
      path.join(featureDir, 'plan', 'plan.md'),
      path.join(featureDir, 'design.md'),
      path.join(featureDir, 'plan.md'),
    ]) add(file);
    const maxBytes = userPointerMaxBytes(intakeFile);
    if (maxBytes !== null) {
      for (const file of userContextFiles(path.join(featureDir, USER_CONTEXT_DIR), fsImpl)) add(file, false, maxBytes, true);
    }
  }
  return candidates;
}

/** `intakeFile` overrides the intake registry path (tests); the default is core/registry/intake.json. */
function collectPointers({ projectRoot, feature, fsImpl = fs, intakeFile }: any): any[] {
  const root = path.resolve(projectRoot);
  const pointers: any[] = [];
  for (const source of sourceFiles({ projectRoot: root, feature, fsImpl, intakeFile })) {
  // The realpath decides whether the file is inside the project; the pointer names it as it is written.
    const real = inside(root, source.absolute, fsImpl);
    if (!real) continue;
    const rel = logicalRel(root, source.absolute) ?? real;
    const user = source.user || Boolean(originOf(rel));
    let text: string;
    try {
      const data = fsImpl.readFileSync(source.absolute);
      // A user's file may be anything saved as .md; only plain UTF-8 text becomes a pointer. `source.user` is where
      // the file was found, so a realpath outside the `agent-docs/doflow/<slug>/` shape (a linked agent-docs) is held to it too.
      if (user && !isPlainText(data)) continue;
      text = data.toString('utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    const ranges = rangesFor(rel, text, source.requirement);
    // A user's markdown often opens with a title or runs without `##` headings; the sections alone would drop that text.
    if (user && (!ranges.length || ranges[0].startLine > 1)) {
      ranges.unshift({ startLine: 1, endLine: ranges.length ? ranges[0].startLine - 1 : lines.length, heading: null });
    }
    for (const range of ranges) {
      const slice = lineSlice(lines, range.startLine, range.endLine);
      if (!slice.trim()) continue;
      pointers.push(createPointer({ path: rel, heading: range.heading, range: { startLine: range.startLine, endLine: range.endLine }, slice, user }));
    }
  }
  return pointers;
}

function readPointerSlice({ projectRoot, pointer, fsImpl = fs }: any): { slice: string; digest: string } | null {
  // A pointer path is a plain relative path under the project (a logical one through a link, or an older
  // pointer's realpath) whose realpath is inside it too.
  const absolute = path.resolve(projectRoot, pointer.path);
  if (!inside(projectRoot, absolute, fsImpl) || logicalRel(projectRoot, absolute) !== pointer.path) return null;
  const file = absolute;
  try {
    const lines = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/);
    const slice = lineSlice(lines, pointer.range.startLine, pointer.range.endLine);
    return { slice, digest: sha256(slice) };
  } catch { return null; }
}

module.exports = { collectPointers, createPointer, originOf, readPointerSlice, sha256 };
