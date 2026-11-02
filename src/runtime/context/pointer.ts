'use strict';

// TypeScript migration: run directly by Node native type-stripping.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** The user's own files (feature 136's intake): a feature folder's `additional-context/`. Markdown there up to
 * this many bytes (the 256 KiB `pointerMaxBytes` of core/registry/intake.json) becomes pointers; nothing else does. */
const USER_CONTEXT_DIR = 'additional-context';
const USER_POINTER_MAX_BYTES = 262144;

/** `'user-provided'` for a project-relative path with an `additional-context` segment, else null. */
function originOf(rel: string): 'user-provided' | null {
  return rel.split('/').includes(USER_CONTEXT_DIR) ? 'user-provided' : null;
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

function createPointer({ path: rel, heading, range, slice }: any): any {
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
    origin: originOf(rel),
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

function sourceFiles({ projectRoot, feature, fsImpl = fs }: any): Array<{ absolute: string; requirement: boolean }> {
  const root = path.resolve(projectRoot);
  const featureDir = feature?.featureDir ? path.resolve(feature.featureDir) : null;
  const candidates: Array<{ absolute: string; requirement: boolean }> = [];
  const add = (file: string | null | undefined, requirement = false, maxBytes = Infinity) => {
    if (!file) return;
    const absolute = path.isAbsolute(file) ? file : path.resolve(feature?.repoRoot || root, file);
    let stat: any;
    try { stat = fsImpl.statSync(absolute); } catch { return; }
    if (!inside(root, absolute, fsImpl) || !stat.isFile() || stat.size > maxBytes) return;
    if (!candidates.some((item) => item.absolute === absolute)) candidates.push({ absolute, requirement });
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
    for (const file of userContextFiles(path.join(featureDir, USER_CONTEXT_DIR), fsImpl)) add(file, false, USER_POINTER_MAX_BYTES);
  }
  return candidates;
}

function collectPointers({ projectRoot, feature, fsImpl = fs }: any): any[] {
  const root = path.resolve(projectRoot);
  const pointers: any[] = [];
  for (const source of sourceFiles({ projectRoot: root, feature, fsImpl })) {
  const rel = inside(root, source.absolute, fsImpl);
    if (!rel) continue;
    let text: string;
    try { text = fsImpl.readFileSync(source.absolute, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const ranges = rangesFor(rel, text, source.requirement);
    // A user's markdown often opens with a title or runs without `##` headings; the sections alone would drop that text.
    if (originOf(rel) && (!ranges.length || ranges[0].startLine > 1)) {
      ranges.unshift({ startLine: 1, endLine: ranges.length ? ranges[0].startLine - 1 : lines.length, heading: null });
    }
    for (const range of ranges) {
      const slice = lineSlice(lines, range.startLine, range.endLine);
      if (!slice.trim()) continue;
      pointers.push(createPointer({ path: rel, heading: range.heading, range: { startLine: range.startLine, endLine: range.endLine }, slice }));
    }
  }
  return pointers;
}

function readPointerSlice({ projectRoot, pointer, fsImpl = fs }: any): { slice: string; digest: string } | null {
  const rel = inside(projectRoot, path.resolve(projectRoot, pointer.path), fsImpl);
  if (!rel || rel !== pointer.path) return null;
  const file = path.resolve(projectRoot, rel);
  try {
    const lines = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/);
    const slice = lineSlice(lines, pointer.range.startLine, pointer.range.endLine);
    return { slice, digest: sha256(slice) };
  } catch { return null; }
}

module.exports = { collectPointers, createPointer, originOf, readPointerSlice, sha256 };
