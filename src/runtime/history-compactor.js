'use strict';

/**
 * History compactor (IC-005, IC-009). Moves the body of an artifact's `## <n>. History` section into
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

const HISTORY_HEADING = /^## ([0-9]+)\. History\s*$/;
const ANY_H2 = /^## /;
const POINTER = /^Earlier entries: \[decisions\/history\/[a-z-]+\.md\]/;
const INITIAL_VERSION = 'None — initial version.';
const TARGET_KEYS = ['requirement', 'design', 'specs', 'data_model', 'plan'];

/** Raised when one artifact could not be compacted. The artifact is left as it was. */
class CompactionError extends Error {
  constructor(message, artifact, moved) {
    super(message);
    this.name = 'CompactionError';
    this.artifact = artifact;
    /** Artifacts already compacted in this run before the failure. */
    this.moved = moved || [];
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Classifies every line as `text`, `fence` (a fence marker or a line inside a fenced block),
 * `comment` (the first line of an HTML comment) or `comment-cont`. A `## ` line inside a fence or a
 * comment is not a heading, and fence markers inside a comment (or the reverse) do not open
 * anything, so a History example quoted in a code block cannot be mistaken for the real section.
 * @returns {{kinds:string[], openFence:boolean, openComment:boolean}} the last two are true when a
 *   fence or an HTML comment is never closed, so everything after it was swallowed
 */
function scan(lines) {
  const kinds = new Array(lines.length);
  let fence = null;
  let comment = false;
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
    if (open) { kinds[i] = 'fence'; fence = { ch: open[1][0], len: open[1].length }; continue; }
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) {
      kinds[i] = 'comment';
      if (!trimmed.includes('-->', 4)) comment = true;
      continue;
    }
    kinds[i] = 'text';
  }
  return { kinds, openFence: fence !== null, openComment: comment };
}

/**
 * Splits History body lines into what stays and what moves. Fenced content moves intact. Only the
 * exact canonical pointer for this artifact is the pointer; any other line, including one that
 * merely looks like a pointer, moves, so no text is dropped.
 */
function classify(bodyLines, kinds, canonicalPointer) {
  const comments = [];
  const moved = [];
  let pointer = null;
  let block = null;
  bodyLines.forEach((line, i) => {
    const kind = kinds[i];
    if (kind === 'comment-cont') { block.push(line); return; }
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

function writeAtomic(fsImpl, file, content) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, content, 'utf8');
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw error;
  }
}

function toPosix(p) {
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
function lastChunkIs(archiveText, blockLF) {
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
 * Compacts one artifact.
 * @returns {{artifact:string, path:string, archive:string, lines:number}|null} null when there was
 *   nothing to move
 */
function compactArtifact({ fsImpl, featureDir, file, date }) {
  const text = fsImpl.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  const lines = text.split('\n');
  const { kinds, openFence, openComment } = scan(lines);
  // Refused before the heading is looked for: an unclosed fence or comment swallows everything
  // after it, so neither the heading nor the section's end can be told.
  if (openFence) throw new Error('a code fence is never closed, so the end of the History section cannot be told');
  if (openComment) throw new Error('an HTML comment is never closed, so the end of the History section cannot be told');
  const start = lines.findIndex((l, i) => kinds[i] === 'text' && HISTORY_HEADING.test(l));
  if (start === -1) return null;
  const section = Number(HISTORY_HEADING.exec(lines[start])[1]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (kinds[i] === 'text' && ANY_H2.test(lines[i])) { end = i; break; }
  }
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
  const eol = crlf ? '\r\n' : '\n';
  const toEol = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);
  const blockLF = moved.map((l) => l.replace(/\r$/, '')).join('\n');
  const chunk = `## Compacted ${date} from ${rel} §${section}\n\n${blockLF}\n`;
  const existing = fsImpl.existsSync(archiveFile) ? fsImpl.readFileSync(archiveFile, 'utf8') : null;
  if (existing === null || !lastChunkIs(existing, blockLF)) {
    const base = existing === null ? toEol(`# History archive: ${rel}\n`) : (existing.endsWith('\n') ? existing : `${existing}${eol}`);
    writeAtomic(fsImpl, archiveFile, `${base}${eol}${toEol(chunk)}`);
  }
  if (!lastChunkIs(fsImpl.readFileSync(archiveFile, 'utf8'), blockLF)) {
    throw new Error(`the moved block is not present in ${archiveRel} after the write`);
  }

  const blank = crlf ? '\r' : '';
  const pointerLine = pointer !== null ? pointer : `${canonicalPointer}${blank}`;
  const body = [blank];
  for (const c of comments) body.push(...c, blank);
  body.push(pointerLine, end === lines.length ? '' : blank);
  writeAtomic(fsImpl, file, [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n'));
  return { artifact: name, path: rel, archive: archiveRel, lines: moved.length };
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
 * @param {Object} [options.fsImpl] fs implementation (tests substitute one)
 *
 * Not locked: concurrent callers can interleave archive appends. Call it through
 * `compactDecisions` / `runDecision` in decision-register.js, which hold the register lock.
 *
 * @returns {{status:'compacted'|'unchanged', moved:Object[]}}
 * @throws {CompactionError} naming the artifact that failed; that artifact is left as it was
 */
function compactHistory({ repoRoot, featureDir, paths, date, fsImpl = nodeFs }) {
  const stamp = date || new Date().toISOString().slice(0, 10);
  const moved = [];
  for (const key of TARGET_KEYS) {
    if (!paths || !paths[key]) continue;
    const file = path.resolve(repoRoot, paths[key]);
    if (!fsImpl.existsSync(file)) continue;
    let result;
    try {
      result = compactArtifact({ fsImpl, featureDir, file, date: stamp });
    } catch (error) {
      const name = toPosix(path.relative(featureDir, file));
      throw new CompactionError(`could not compact ${name}: ${error.message}; the artifact was left unchanged`, name, moved);
    }
    if (result) moved.push(result);
  }
  return { status: moved.length ? 'compacted' : 'unchanged', moved };
}

module.exports = { compactHistory, CompactionError, HISTORY_HEADING, POINTER, INITIAL_VERSION };
