'use strict';

/**
 * History compactor (IC-005, IC-009; settled-points mode IC-008, IC-009, IC-013). Moves the body of an artifact's `## <n>. History` section into
 * `decisions/history/<artifact>.md` and leaves a comment-and-pointer stub behind, so the live
 * artifact stops growing with the feature's age while every History line stays reachable
 * (NFR-004).
 *
 * Mechanical by design (NFR-001): no model is asked to decide what to move. A line moves unless it
 * is blank, part of an HTML comment, the pointer line, or the initial-version literal.
 *
 * Write order per artifact is the safety property (FR-014): append to the archive, read it back and
 * confirm the block is there, and only then rewrite the artifact. A failure at any step leaves the
 * artifact as it was. A crash between the two writes leaves the block in the archive and the
 * artifact unchanged; the next run recognises the identical chunk and does not append it twice.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./write-file-atomic.ts');

const HISTORY_HEADING = /^## ([0-9]+)\. History\s*$/;
const ANY_H2 = /^## /;
const POINTER = /^Earlier entries: \[decisions\/history\/[a-z-]+\.md\]/;
const INITIAL_VERSION = 'None — initial version.';
const TARGET_KEYS = ['requirement', 'design', 'specs', 'data_model', 'plan'];
/** IC-008: the design-stage documents that carry an Open Points for Review section. */
const CLOSED_TARGET_KEYS = ['design', 'specs', 'data_model'];
const OPEN_POINTS_HEADING = /^## (?:([0-9]+)\. )?Open Points for Review\s*$/;
/** A settled open point's opener: `- **Decided:**`, `- **Decided (DEC-###):**`, `- **Rejected (…):**`, `- **Round 2:**`. */
const CLOSED_POINT = /^- \*\*(Decided|Rejected|Round [0-9]+)(?: \([^)\n]*\))?:\*\*/;
const CLOSED_POINTER = /^Closed points: \[decisions\/history\/[a-z-]+-closed\.md\]/;

/** A line that starts a new block inside a list: a bullet or ordered list item, or an ATX heading (CommonMark). */
const LIST_OR_HEADING = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)]|#{1,6})(?:[ \t]|\r?$)/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Classifies every line as `text`, `fence` (a fence marker or a line inside a fenced block),
 * `comment` (the first line of an HTML comment) or `comment-cont`. A `## ` line inside a fence or a
 * comment is not a heading, and fence markers inside a comment (or the reverse) do not open
 * anything, so a History example quoted in a code block cannot be mistaken for the real section.
 * @returns {{kinds:string[], openFence:boolean, openComment:boolean, openAt:number}} the middle two
 *   are true when a fence or an HTML comment is never closed, so everything after it was swallowed;
 *   `openAt` is the line index where that construct opened (-1 when none is left open)
 */
function scan(lines: string[]): { kinds: string[]; starts: boolean[]; openFence: boolean; openComment: boolean; openAt: number } {
  const kinds: string[] = new Array(lines.length);
  // starts[i] is true on the line that opens a fence or an HTML comment (IC-008's item extent needs it).
  const starts: boolean[] = new Array(lines.length).fill(false);
  let fence: { ch: string; len: number } | null = null;
  let comment = false;
  let openedAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      kinds[i] = 'fence';
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (comment) {
      kinds[i] = 'comment-cont';
      if (line.includes('-->')) comment = false;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) { kinds[i] = 'fence'; starts[i] = true; fence = { ch: open[1][0], len: open[1].length }; openedAt = i; continue; }
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) {
      kinds[i] = 'comment';
      starts[i] = true;
      if (!trimmed.includes('-->', 4)) { comment = true; openedAt = i; }
      continue;
    }
    kinds[i] = 'text';
  }
  return { kinds, starts, openFence: fence !== null, openComment: comment, openAt: fence !== null || comment ? openedAt : -1 };
}

/**
 * Splits History body lines into what stays and what moves. Fenced content moves intact. Only the
 * exact canonical pointer for this artifact is the pointer; any other line, including one that
 * merely looks like a pointer, moves, so no text is dropped.
 */
function classify(bodyLines: string[], kinds: string[], canonicalPointer: string): { comments: string[][]; moved: string[]; pointer: string | null } {
  const comments: string[][] = [];
  const moved: string[] = [];
  let pointer: string | null = null;
  let block: string[] | null = null;
  bodyLines.forEach((line, i) => {
    const kind = kinds[i];
    if (kind === 'comment-cont') { (block as string[]).push(line); return; }
    block = null;
    if (kind === 'comment') { block = [line]; comments.push(block); return; }
    if (kind === 'fence') { moved.push(line); return; }
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (trimmed === canonicalPointer) { if (pointer === null) pointer = line; return; }
    if (trimmed === INITIAL_VERSION) return;
    moved.push(line);
  });
  return { comments, moved, pointer };
}

function writeAtomic(fsImpl: any, file: string, content: string, unchangedSince?: string): void {
  // The text `content` was built from is compared with the file just before the rename, so an edit
  // made since it was read is kept instead of replaced (FU-1jbmm3). This narrows the window to the
  // gap between this read and the rename; it cannot close it, which would take a lock on the
  // artifact itself that its editors would also have to take.
  const beforeRename = unchangedSince === undefined ? undefined : () => {
    if (fsImpl.readFileSync(file, 'utf8') !== unchangedSince) {
      throw new Error(`${path.basename(file)} changed while it was being compacted`);
    }
  };
  writeFileAtomic(file, content, { fsImpl, beforeRename });
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Whether the archive's most recent chunk is exactly this block. Only the last chunk counts: the
 * crash this guards against (archive written, artifact not) always leaves the interrupted chunk
 * last. The dated header is ignored, so a recovery on a later day does not append a second copy,
 * and a block that merely prefixes an earlier chunk does not match.
 *
 * A chunk header is a `## Compacted` line `scan()` classifies as text: a moved block may quote such
 * a line inside a code fence, and that must not be read as the start of a chunk. The dedupe and the
 * post-write confirmation both use this one predicate.
 */
function lastChunkIs(archiveText: string, blockLF: string): boolean {
  const lines = archiveText.replace(/\r\n/g, '\n').split('\n');
  const { kinds } = scan(lines);
  let header = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (kinds[i] === 'text' && lines[i].startsWith('## Compacted ')) { header = i; break; }
  }
  if (header === -1 || lines[header + 1] !== '') return false;
  return lines.slice(header + 2).join('\n').replace(/\n+$/, '') === blockLF;
}

/**
 * Appends `chunk` to the archive unless its last chunk already is this block, then reads the archive
 * back and requires the block to be its last chunk (IC-013): the artifact is rewritten only after
 * this returns. Chunks are built with LF and converted to the artifact's own line ending on write,
 * so a CRLF artifact gets a CRLF archive and no file ends up mixed.
 */
function appendChunk({ fsImpl, archiveFile, archiveRel, header, chunk, blockLF, crlf }: { fsImpl: any; archiveFile: string; archiveRel: string; header: string; chunk: string; blockLF: string; crlf: boolean }): void {
  const eol = crlf ? '\r\n' : '\n';
  const toEol = (t: string) => (crlf ? t.replace(/\n/g, '\r\n') : t);
  const existing = fsImpl.existsSync(archiveFile) ? fsImpl.readFileSync(archiveFile, 'utf8') : null;
  if (existing === null || !lastChunkIs(existing, blockLF)) {
    const base = existing === null ? toEol(`${header}\n`) : (existing.endsWith('\n') ? existing : `${existing}${eol}`);
    writeAtomic(fsImpl, archiveFile, `${base}${eol}${toEol(chunk)}`);
  }
  if (!lastChunkIs(fsImpl.readFileSync(archiveFile, 'utf8'), blockLF)) {
    throw new Error(`the moved block is not present in ${archiveRel} after the write`);
  }
}

/**
 * Compacts one artifact.
 * @returns {{artifact:string, path:string, archive:string, lines:number}|null} null when there was
 *   nothing to move
 */
function compactArtifact({ fsImpl, featureDir, file, date }: { fsImpl: any; featureDir: string; file: string; date: string }): { artifact: string; path: string; archive: string; lines: number } | null {
  const text = fsImpl.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  const lines = text.split('\n');
  const { kinds, openFence, openComment, openAt } = scan(lines);
  const unclosed: string | null = openFence ? 'a code fence' : openComment ? 'an HTML comment' : null;
  const refuse = (): never => {
    throw new Error(`${unclosed} is never closed, so the end of the History section cannot be told`);
  };
  const start = lines.findIndex((l: string, i: number) => kinds[i] === 'text' && HISTORY_HEADING.test(l));
  // An unclosed construct swallows everything after it. It matters only when it opens before the
  // History section ends (FR-001): then the section's end cannot be told. A History heading it
  // swallowed is such a case; one that simply is not there, or that closed before the construct
  // opened, is not, and the construct is treated as absent.
  if (start === -1) {
    if (unclosed && lines.some((l: string, i: number) => i > openAt && HISTORY_HEADING.test(l))) refuse();
    return null;
  }
  const section = Number((HISTORY_HEADING.exec(lines[start]) as RegExpExecArray)[1]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (kinds[i] === 'text' && ANY_H2.test(lines[i])) { end = i; break; }
  }
  if (unclosed && openAt < end) refuse();
  const name = path.basename(file);
  const archiveFile = path.join(featureDir, 'decisions', 'history', name);
  const link = toPosix(path.relative(path.dirname(file), archiveFile));
  const canonicalPointer = `Earlier entries: [decisions/history/${name}](${link}).`;
  const { comments, moved, pointer } = classify(lines.slice(start + 1, end), kinds.slice(start + 1, end), canonicalPointer);
  if (moved.length === 0) return null;

  const rel = toPosix(path.relative(featureDir, file));
  const archiveRel = toPosix(path.relative(featureDir, archiveFile));

  // Chunks are built with LF and converted to the artifact's own line ending on write, so a CRLF
  // artifact gets a CRLF archive and no file ends up mixed.
  const blockLF = moved.map((l) => l.replace(/\r$/, '')).join('\n');
  appendChunk({ fsImpl, archiveFile, archiveRel, header: `# History archive: ${rel}`, chunk: `## Compacted ${date} from ${rel} §${section}\n\n${blockLF}\n`, blockLF, crlf });

  const blank = crlf ? '\r' : '';
  const pointerLine = pointer !== null ? pointer : `${canonicalPointer}${blank}`;
  const body = [blank];
  for (const c of comments) body.push(...c, blank);
  body.push(pointerLine, end === lines.length ? '' : blank);
  writeAtomic(fsImpl, file, [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n'), text);
  return { artifact: name, path: rel, archive: archiveRel, lines: moved.length };
}

/**
 * IC-008, IC-009: moves the labelled settled points of the Open Points for Review section to
 * `decisions/history/<stem>-closed.md` and leaves one pointer line. Same write order and refusal
 * rules as `compactArtifact`.
 * @returns {{artifact:string, path:string, archive:string, lines:number, items:number}|null} null
 *   when there was no section or nothing labelled in it
 */
function compactClosedPoints({ fsImpl, featureDir, file, date }: { fsImpl: any; featureDir: string; file: string; date: string }): { artifact: string; path: string; archive: string; lines: number; items: number } | null {
  const text = fsImpl.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  const lines = text.split('\n');
  const { kinds, starts, openFence, openComment, openAt } = scan(lines);
  const unclosed: string | null = openFence ? 'a code fence' : openComment ? 'an HTML comment' : null;
  const refuse = (): never => {
    throw new Error(`${unclosed} is never closed, so the end of the Open Points for Review section cannot be told`);
  };
  const start = lines.findIndex((l: string, i: number) => kinds[i] === 'text' && OPEN_POINTS_HEADING.test(l));
  if (start === -1) {
    if (unclosed && lines.some((l: string, i: number) => i > openAt && OPEN_POINTS_HEADING.test(l))) refuse();
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (kinds[i] === 'text' && ANY_H2.test(lines[i])) { end = i; break; }
  }
  if (unclosed && openAt < end) refuse();

  const name = path.basename(file);
  const stem = name.replace(/\.md$/, '');
  const archiveFile = path.join(featureDir, 'decisions', 'history', `${stem}-closed.md`);
  const link = toPosix(path.relative(path.dirname(file), archiveFile));
  const canonicalPointer = `Closed points: [decisions/history/${stem}-closed.md](${link}).`;

  // Items: an opener plus the lines that belong to it (blank, indented, or inside a fence or comment
  // that opened on one of its own lines); trailing blank lines are not part of the item.
  const isBlank = (i: number): boolean => kinds[i] === 'text' && lines[i].trim() === '';
  // CommonMark lazy continuation: a non-blank line directly after a text line that opens no list item
  // or heading (a fence or comment opener is not 'text', so it never reaches here) belongs to the item.
  const isLazy = (j: number): boolean => kinds[j - 1] === 'text' && lines[j - 1].trim() !== '' && !LIST_OR_HEADING.test(lines[j]) && lines[j].replace(/\r$/, '') !== canonicalPointer;
  const items: Array<[number, number]> = [];
  for (let i = start + 1; i < end; i += 1) {
    if (kinds[i] !== 'text' || !CLOSED_POINT.test(lines[i])) continue;
    let last = i;
    for (let j = i + 1; j < end; j += 1) {
      const kind = kinds[j];
      const owned = kind === 'text'
        ? lines[j].trim() === '' || lines[j][0] === ' ' || lines[j][0] === '\t' || isLazy(j)
        : !starts[j] || lines[j][0] === ' ' || lines[j][0] === '\t';
      if (!owned) break;
      last = j;
    }
    while (last > i && isBlank(last)) last -= 1;
    items.push([i, last]);
    i = last;
  }
  if (items.length === 0) return null;

  const rel = toPosix(path.relative(featureDir, file));
  const archiveRel = toPosix(path.relative(featureDir, archiveFile));
  const number = (OPEN_POINTS_HEADING.exec(lines[start]) as RegExpExecArray)[1];

  const strip = (l: string) => l.replace(/\r$/, '');
  const blockLF = items.map(([a, b]) => lines.slice(a, b + 1).map(strip).join('\n')).join('\n\n');
  const movedLines = items.reduce((n, [a, b]) => n + (b - a + 1), 0);
  appendChunk({
    fsImpl, archiveFile, archiveRel, crlf, blockLF,
    header: `# Closed points archive: ${rel}`,
    chunk: `## Compacted ${date} from ${rel} §${number || 'Open Points for Review'}\n\n${blockLF}\n`,
  });

  // Kept body: everything else in the section but the pointer, blank runs collapsed, edges trimmed.
  const moving = new Set<number>();
  for (const [a, b] of items) for (let i = a; i <= b; i += 1) moving.add(i);
  const kept: string[] = [];
  let pendingBlank: string | null = null;
  for (let i = start + 1; i < end; i += 1) {
    if (moving.has(i)) continue;
    if (kinds[i] === 'text' && strip(lines[i]).trim() === canonicalPointer) continue;
    if (isBlank(i)) { if (kept.length && pendingBlank === null) pendingBlank = lines[i]; continue; }
    if (pendingBlank !== null) { kept.push(pendingBlank); pendingBlank = null; }
    kept.push(lines[i]);
  }
  const blank = crlf ? '\r' : '';
  const body = [blank, ...(kept.length ? [...kept, blank] : []), `${canonicalPointer}${blank}`, end === lines.length ? '' : blank];
  writeAtomic(fsImpl, file, [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n'), text);
  return { artifact: name, path: rel, archive: archiveRel, lines: movedLines, items: items.length };
}

/**
 * Compacts every existing artifact among requirement, design, specs, data model and plan.
 *
 * @param {Object} options
 * @param {string} options.repoRoot repository root the resolver's paths are relative to
 * @param {string} options.featureDir absolute feature folder
 * @param {Object} options.paths the resolver's JSON (`requirement`, `design`, `specs`,
 *   `data_model`, `plan`, repo-root-relative or null)
 * @param {string} [options.date] YYYY-MM-DD stamped on the archive chunk; defaults to today (UTC)
 * @param {'history'|'closed-points'} [options.mode] history (default) compacts the History sections;
 *   closed-points moves labelled settled open points out of design, specs and data model (IC-004)
 * @param {Object} [options.fsImpl] fs implementation (tests substitute one)
 *
 * Not locked: concurrent callers can interleave archive appends, and an artifact edited between its
 * read and its rewrite is detected just before the rename and left as the editor wrote it (the
 * artifact is reported in `failed`; the moved block is already in the archive and a later run does
 * not copy it twice), but an edit landing in the last instant before the rename is not. Call it through
 * `compactDecisions` / `runDecision` in decision-register.js, which hold the register lock.
 *
 * Every artifact is attempted. One that cannot be compacted is left as it was and reported in
 * `failed`; it does not stop the others (IC-005).
 *
 * @returns {{status:'compacted'|'unchanged'|'partial', moved:Object[], failed:Array<{artifact:string, path:string, message:string}>}}
 *   `partial` means at least one artifact failed
 */
function compactHistory({ repoRoot, featureDir, paths, date, mode = 'history', fsImpl = nodeFs }: { repoRoot: string; featureDir: string; paths: any; date?: string; mode?: 'history' | 'closed-points'; fsImpl?: any }): { status: 'compacted' | 'unchanged' | 'partial'; moved: any[]; failed: Array<{ artifact: string; path: string; message: string }> } {
  const stamp = date || new Date().toISOString().slice(0, 10);
  const moved: any[] = [];
  const failed: any[] = [];
  const compactOne = mode === 'closed-points' ? compactClosedPoints : compactArtifact;
  for (const key of mode === 'closed-points' ? CLOSED_TARGET_KEYS : TARGET_KEYS) {
    if (!paths || !paths[key]) continue;
    const file = path.resolve(repoRoot, paths[key]);
    if (!fsImpl.existsSync(file)) continue;
    let result: any;
    try {
      result = compactOne({ fsImpl, featureDir, file, date: stamp });
    } catch (error: any) {
      const name = toPosix(path.relative(featureDir, file));
      failed.push({ artifact: path.basename(file), path: name, message: `could not compact ${name}: ${error.message}; the artifact was left unchanged` });
      continue;
    }
    if (result) moved.push(result);
  }
  return { status: failed.length ? 'partial' : moved.length ? 'compacted' : 'unchanged', moved, failed };
}

module.exports = { compactHistory, HISTORY_HEADING, POINTER, INITIAL_VERSION, CLOSED_POINT, CLOSED_POINTER };
