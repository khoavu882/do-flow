'use strict';

// Structure-aware markdown chunker. Chunks follow document
// structure — frontmatter becomes metadata, headings bound sections, fenced code blocks never
// split mid-block — because every downstream stage (indexing, ranking, prompting) inherits the
// coherence this stage preserves. Character budgets approximate common token targets (~150-token
// children ≈ 600 chars) without a tokenizer dependency: the corpus is
// prose-dominant English/markdown, where chars/4 tracks tokens closely enough to rank with.

const TARGET_CHUNK_CHARS = 600;
const HARD_MAX_CHUNK_CHARS = 1200;

/** Split raw markdown into chunks: {id, path, section, text}. Ids are stable path+ordinal pairs,
 * not content hashes — the index manifest owns content addressing, and a chunk whose text changed
 * should keep its identity so diffs are legible. */
function chunkMarkdown(rawText, { path: filePath } = {}) {
  const { body, title } = stripFrontmatter(String(rawText ?? ''));
  const sections = splitSections(body);
  const chunks = [];
  let ordinal = 0;
  for (const section of sections) {
    for (const piece of packSection(section.text)) {
      chunks.push({
        id: `${filePath ?? 'memory'}#${ordinal}`,
        path: filePath ?? null,
        title: section.heading ? `${title ? `${title} › ` : ''}${section.heading}` : (title ?? null),
        ordinal,
        text: piece,
      });
      ordinal += 1;
    }
  }
  return chunks;
}

function stripFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text, title: null };
  const meta = match[1];
  const titleMatch = /^title:\s*(.+)$/m.exec(meta) ?? /^#\s+(.+)$/m.exec(text.slice(match[0].length));
  return { body: text.slice(match[0].length), title: titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : null };
}

/** Heading-bounded sections; a leading H1 is metadata (the title), not a section boundary. */
function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { heading: null, lines: [] };
  const flush = () => {
    if (current.lines.some((l) => l.trim() !== '')) {
      sections.push({ heading: current.heading, text: current.lines.join('\n') });
    }
  };
  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections.length ? sections : [{ heading: null, text: body }];
}

/** Group a section's blocks (paragraphs, lists, fenced code) into chunks near the target size.
 * A block larger than the hard max (a long code fence) stands alone rather than being cut. */
function packSection(text) {
  const blocks = splitBlocks(text).filter((b) => b.trim() !== '');
  const packed = [];
  let buffer = '';
  for (const block of blocks) {
    if (block.length > HARD_MAX_CHUNK_CHARS) {
      if (buffer.trim()) packed.push(buffer.trim());
      packed.push(block.trim());
      buffer = '';
      continue;
    }
    if (buffer && buffer.length + block.length + 2 > TARGET_CHUNK_CHARS) {
      packed.push(buffer.trim());
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }
  if (buffer.trim()) packed.push(buffer.trim());
  return packed;
}

/** Split into blocks at blank lines, keeping fenced code blocks intact across their blank lines. */
function splitBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let fence = null;
  for (const line of lines) {
    const opening = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      buffer.push(line);
      if (opening && opening[1] === fence) fence = null;
      continue;
    }
    if (opening) {
      if (buffer.some((l) => l.trim() !== '')) blocks.push(buffer.join('\n'));
      buffer = [line];
      fence = opening[1];
      continue;
    }
    if (line.trim() === '' && !buffer.some((l) => l.trim() !== '')) continue;
    if (line.trim() === '') {
      blocks.push(buffer.join('\n'));
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  if (buffer.some((l) => l.trim() !== '')) blocks.push(buffer.join('\n'));
  return blocks;
}

module.exports = { chunkMarkdown, TARGET_CHUNK_CHARS, HARD_MAX_CHUNK_CHARS };
