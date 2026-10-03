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

/** Splits History body lines into what stays and what moves. */
function classify(bodyLines) {
  const comments = [];
  const moved = [];
  let pointer = null;
  let inComment = false;
  let block = null;
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (inComment) {
      block.push(line);
      if (trimmed.includes('-->')) { inComment = false; comments.push(block); block = null; }
      continue;
    }
    if (trimmed === '') continue;
    if (trimmed.startsWith('<!--')) {
      if (trimmed.includes('-->', 4)) comments.push([line]);
      else { inComment = true; block = [line]; }
      continue;
    }
    if (POINTER.test(trimmed)) { if (pointer === null) pointer = line; continue; }
    if (trimmed === INITIAL_VERSION) continue;
    moved.push(line);
  }
  // An unterminated comment is kept where it is rather than guessed at.
  if (block) comments.push(block);
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
 * Compacts one artifact.
 * @returns {{artifact:string, path:string, archive:string, lines:number}|null} null when there was
 *   nothing to move
 */
function compactArtifact({ fsImpl, featureDir, file, date }) {
  const text = fsImpl.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => HISTORY_HEADING.test(l));
  if (start === -1) return null;
  const section = Number(HISTORY_HEADING.exec(lines[start])[1]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_H2.test(lines[i])) { end = i; break; }
  }
  const { comments, moved, pointer } = classify(lines.slice(start + 1, end));
  if (moved.length === 0) return null;

  const name = path.basename(file);
  const rel = toPosix(path.relative(featureDir, file));
  const archiveFile = path.join(featureDir, 'decisions', 'history', name);
  const archiveRel = toPosix(path.relative(featureDir, archiveFile));

  const block = moved.join('\n');
  const chunk = `## Compacted ${date} from ${rel} §${section}\n\n${block}\n`;
  const existing = fsImpl.existsSync(archiveFile) ? fsImpl.readFileSync(archiveFile, 'utf8') : null;
  if (existing === null || !existing.includes(chunk)) {
    const base = existing === null ? `# History archive: ${rel}\n` : (existing.endsWith('\n') ? existing : `${existing}\n`);
    writeAtomic(fsImpl, archiveFile, `${base}\n${chunk}`);
  }
  const verify = fsImpl.readFileSync(archiveFile, 'utf8');
  if (!verify.includes(chunk)) throw new Error(`the moved block is not present in ${archiveRel} after the write`);

  const link = toPosix(path.relative(path.dirname(file), archiveFile));
  const pointerLine = pointer !== null ? pointer : `Earlier entries: [decisions/history/${name}](${link}).`;
  const body = [''];
  for (const c of comments) body.push(...c, '');
  body.push(pointerLine, '');
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
