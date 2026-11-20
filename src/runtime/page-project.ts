'use strict';

/**
 * page-project.ts: one self-contained HTML page from a feature's chain documents.
 *
 * `render-page.sh` resolves the feature and shells out to node here, the same way `render-puml.sh`
 * reaches `c4-project.ts`. The markdown files stay the only source of truth and are never modified;
 * the page is a projection a reader opens in a browser, with no server and no harness running.
 *
 * Everything a document says reaches the page as escaped text. The converter emits a fixed set of
 * elements and no raw HTML from a document, so a document cannot put markup or script on the page.
 *
 * Diagrams have three forms, chosen by `mode`:
 *   inline: each fenced mermaid block is rendered by `mmdc` with the shipped theme and embedded as
 *           an image, so the page needs nothing else to display.
 *   cdn:    the block's text stays on the page and Mermaid is loaded from jsDelivr when the page is
 *           opened, as one file checked against a pinned hash. The page then needs the network and
 *           runs Mermaid over document text, which is why it is never chosen for the caller.
 *   source: the block is shown as text.
 * `auto` is `inline` when `mmdc` is on PATH and `source` otherwise; `inline` without `mmdc` is `source`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shown } = require('./mask.ts');

/** The documents a page carries, in reading order: [key in `paths --json`, label on the page]. */
const DOCUMENTS: ReadonlyArray<readonly [string, string]> = [
  ['requirement', 'Requirement'],
  ['design', 'Design'],
  ['specs', 'Interface contracts'],
  ['data_model', 'Data model'],
  ['plan', 'Plan'],
  ['decisions', 'Decisions'],
  ['state', 'State'],
  ['audit', 'Process'],
];

const MODES = ['auto', 'inline', 'cdn', 'source'];
/**
 * The Mermaid build a `cdn` page loads: one file, pinned with its hash, so the page cannot change under
 * its reader. Releases from 11.1.0 up to 11.10.0 let diagram text run script (GHSA-8gwm-58g9-j8pw); when
 * this moves, move it forward and recompute the hash from the file jsDelivr serves.
 */
const MERMAID_SCRIPT = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';
const MERMAID_INTEGRITY = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';
const RENDER_TIMEOUT_MS = 60000;

// The info string's first word is the language; anything after it (a title, attributes) is ignored.
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** An id a document defines: `FR-001`, `IC-039.2`, or an unhyphenated short one such as `R1`. */
const ID_SHAPE = /^(?:[A-Z]{1,6}-\d{1,4}(?:\.\d+)?|[A-Z]{1,3}\d{1,4})$/;

function escapeHtml(text: any): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
}

/** Whether a fence line `m` closes the block `open` started: same character, at least as long, no info string. */
const closesFence = (m: RegExpExecArray | null, open: string) => !!m && m[1][0] === open[0] && m[1].length >= open.length && !m[2];

const keyId = (key: string) => key.replace(/_/g, '-');
const indentOf = (line: string) => line.length - line.trimStart().length;

/** A document's text with HTML comments removed, except inside a fenced block or a code span. */
function stripComments(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inComment) {
      const m = FENCE.exec(line);
      if (fence) { if (closesFence(m, fence)) fence = null; out.push(line); continue; }
      if (m) { fence = m[1]; out.push(line); continue; }
    }
    let rest = line;
    let kept = '';
    let touched = inComment;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) { rest = ''; break; }
        rest = rest.slice(end + 3); inComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) { kept += rest; break; }
        // An odd number of backticks before it on the line: the marker is text inside a code span.
        if (((kept + rest.slice(0, start)).match(/`/g) || []).length % 2 === 1) {
          kept += rest.slice(0, start + 4); rest = rest.slice(start + 4); continue;
        }
        kept += rest.slice(0, start); rest = rest.slice(start + 4); inComment = true; touched = true;
      }
    }
    // A line that held only a comment leaves no blank line behind, so it cannot split a list or a table.
    if (touched && kept.trim() === '') continue;
    out.push(kept);
  }
  return out.join('\n');
}

/**
 * The href a link may carry, or null when the page shows the link as plain text. A link to another
 * document on the page, or to a heading, points at that section; a web or mail address is kept; any
 * other scheme is refused; a relative path is rewritten from the document's folder to the page's.
 */
function resolveHref(url: string, ctx: any): string | null {
  // Browsers drop control characters before they read a scheme, so `\x01javascript:` is a script link.
  // None of these belongs in a link a document wrote, and a backslash path is a network share on Windows.
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return null;
  if (url.startsWith('#')) return `#${keyId(ctx.key)}-${url.slice(1)}`;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  if (!ctx.docs || !ctx.dir || !ctx.outDir) return url;
  const hash = url.indexOf('#');
  const file = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash + 1);
  const abs = path.resolve(ctx.dir, file);
  const target = ctx.docs.get(abs);
  if (target) return fragment ? `#${keyId(target)}-${fragment}` : `#doc-${keyId(target)}`;
  const rel = path.relative(ctx.outDir, abs).split(path.sep).join('/');
  return fragment ? `${rel}#${fragment}` : rel;
}

/** Image types the page embeds, by extension. A `.drawio.svg` is an SVG and needs no entry of its own. */
const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
/** Largest image file the page embeds; a larger one is named as left out. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Most image bytes one page carries, counted once per reference since each reference repeats the data. */
const MAX_PAGE_IMAGE_BYTES = 20 * 1024 * 1024;

/** What one page's images need to remember; the two limits can be set per page, for a test. */
function newImageState(limits: { maxImageBytes?: number; maxPageBytes?: number } = {}) {
  return {
    embedded: 0, skipped: [] as string[], bytes: 0, cache: new Map<string, { type: string; size: number; data: string }>(),
    maxImageBytes: limits.maxImageBytes ?? MAX_IMAGE_BYTES, maxPageBytes: limits.maxPageBytes ?? MAX_PAGE_IMAGE_BYTES,
  };
}

/**
 * An image a document shows, embedded so the page stays one file. Only a file of a known image type
 * inside the feature's checkout is read (links followed first, so a link out of the checkout is
 * refused, and the type is the real file's, not the link's); a web address becomes a link, since
 * loading it would make the page call out when opened. It is always an `<img>`: a browser runs no
 * script from an SVG shown that way.
 */
function imageHtml(alt: string, url: string, ctx: any): string {
  const label = escapeHtml(alt);
  const images = ctx.images || newImageState();
  const left = (why: string) => {
    // The address is document text and reaches a terminal in the note, so it is printed safe.
    images.skipped.push(`${shown(url)}: ${why}`);
    return `<span class="image-missing">${label || escapeHtml(url)} (image not shown: ${escapeHtml(why)})</span>`;
  };
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return left('unsafe path');
  if (/^https?:/i.test(url)) return `<a href="${escapeHtml(url)}">${label || escapeHtml(url)}</a>`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return left('not a local file');
  if (!ctx.dir || !ctx.root) return left('no folder to read from');
  const file = url.replace(/[?#].*$/, '');
  if (!IMAGE_TYPES[path.extname(file).toLowerCase()]) return left('not an image type the page embeds');
  try {
    const real = fs.realpathSync(path.resolve(ctx.dir, file));
    // A link named `a.svg` may point at any file: the type is the file read, not the name asked for.
    const type = IMAGE_TYPES[path.extname(real).toLowerCase()];
    if (!type) return left('not an image type the page embeds');
    const inside = path.relative(fs.realpathSync(ctx.root), real);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return left('outside the checkout');
    let entry = images.cache.get(real);
    if (!entry) {
      const stat = fs.statSync(real);
      if (!stat.isFile()) return left('not a file');
      if (stat.size > images.maxImageBytes) return left(`larger than ${+(images.maxImageBytes / 1024 / 1024).toFixed(2)} MB`);
      entry = { type, size: stat.size, data: fs.readFileSync(real).toString('base64') };
      images.cache.set(real, entry);
    }
    if (images.bytes + entry.size > images.maxPageBytes) return left('page image budget reached');
    images.bytes += entry.size;
    images.embedded++;
    return `<img class="image" alt="${label}" src="data:${entry.type};base64,${entry.data}">`;
  } catch {
    return left('file not found');
  }
}

/**
 * An id mention in escaped text: `FR-001`, `IC-039.2`, `R1`, or the word form `Story 1`. Each becomes a
 * `<@id@>` mark that `resolveRefs` turns into a link or back into the plain token once every document's
 * definitions are known. A document cannot write the mark: its `<` always reaches the page escaped.
 */
const MENTION = /(?<![\w.\-/])(?:[A-Z]{1,6}-\d{1,4}(?:\.\d+)?|[A-Z]{1,3}\d{1,4}|[A-Z][a-z]+ \d{1,4}(?:\.\d+)?)(?![\w-]|\.\d)/g;

/** Mention marks for the escaped text between held marks, skipping a link's label and the defining spot. */
function markMentions(html: string, held: string[], ctx: any): string {
  let inLink = false;
  return html.split(/(\u0000\d+\u0000)/).map((part, k) => {
    if (k % 2 === 1) {
      const tag = held[Number(part.slice(1, -1))];
      if (tag === '</a>') inLink = false;
      else if (tag.startsWith('<a ') && !tag.endsWith('</a>')) inLink = true;
      return part;
    }
    if (inLink) return part;
    return part.replace(MENTION, (id: string) => {
      if (ctx.skipRef === id) { ctx.skipRef = null; return id; }
      return `<@${id}@>`;
    });
  }).join('');
}

/** A text that is only ids separated by `;` or `,` (`FR-001; FR-002`), as its ids with empty items dropped; else null. */
function idRun(text: string): string[] | null {
  if (!/[;,]/.test(text)) return null;
  const ids = text.split(/[;,]/).map((item) => item.trim().replace(/[.\s]+$/, '')).filter((item) => item !== '');
  return ids.length > 0 && ids.every((id) => ID_SHAPE.test(id)) ? ids : null;
}

/** Inline markdown in one run of text: code spans, images, links, bold, italic, strike and `<br>`; with `refs`, id mentions. */
function inline(text: string, ctx: any, refs = true): string {
  refs = refs && !!ctx.registry;
  const run = refs ? idRun(text) : null;
  if (run) return `<span class="ids">${run.map((id) => `<@${id}@>`).join(' ')}</span>`;
  // A code span and a link's tags are set aside as numbered marks while the rest is formatted, so bold
  // may wrap a code span and no later pattern can rewrite what is inside a tag.
  const held: string[] = [];
  // What each mark reads as without markup: a code span's text, nothing for a tag. An image's alt wants it.
  const plain: string[] = [];
  const hold = (html: string, text = '') => { plain.push(text); return `\u0000${held.push(html) - 1}\u0000`; };
  const spans = text.replace(/\u0000/g, '')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_all: string, _ticks: string, body: string) => hold(`<code>${escapeHtml(body.trim())}</code>`, body.trim()));
  let html = escapeHtml(spans);
  html = html.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  // The URL was escaped with the rest of the text; undo that to judge it, and escape it again to write it.
  const unescaped = (url: string) => url.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all: string, alt: string, url: string) => {
    // An address written as a code span is text, not an image to read: kept as written, marks restored.
    if (url.includes('\u0000')) return hold(_all.replace(/\u0000(\d+)\u0000/g, (_m: string, n: string) => held[Number(n)]));
    return hold(imageHtml(unescaped(alt).replace(/\u0000(\d+)\u0000/g, (_m: string, n: string) => plain[Number(n)]), unescaped(url), ctx));
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all: string, label: string, url: string) => {
    const href = resolveHref(unescaped(url), ctx);
    return href === null ? label : `${hold(`<a href="${escapeHtml(href)}">`)}${label}${hold('</a>')}`;
  });
  if (refs) html = markMentions(html, held, ctx);
  html = html.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])??)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^\s*](?:[^*]*?[^\s*])??)\*(?![*\w])/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_all: string, n: string) => held[Number(n)]);
}

/** A table row's cells. A pipe inside a code span, or escaped as `\|`, does not split. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let ticks = 0;
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '`') ticks++;
    if (ch === '|' && ticks % 2 === 0) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** A cell or heading as a reader sees it: markup marks dropped, whitespace collapsed. */
function plainText(md: string): string {
  return md.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/<br\s*\/?>/gi, ' ').replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ').trim();
}

/** Label tones for status words; any other value of an enumerated column takes a neutral tone by hash. */
const TONES: Record<string, string> = {
  live: 'good', approved: 'good', accepted: 'good', mitigated: 'good', done: 'good', pass: 'good',
  draft: 'warn', proposed: 'warn', open: 'warn', pending: 'warn', should: 'warn',
  'in review': 'info', must: 'info',
  superseded: 'quiet', rejected: 'quiet', 'n/a': 'quiet',
  blocked: 'bad', fail: 'bad',
};
const NEUTRAL_TONES = 6;

/** Whether a column's values read as a short set of labels: ≥ 2 values, each ≤ 3 words and ≤ 24 characters, not an id or number, ≤ 6 distinct. */
function isEnumerated(values: string[]): boolean {
  const seen = new Set<string>();
  let count = 0;
  for (const raw of values) {
    const value = plainText(raw);
    if (value === '' || /^[-–—]+$/.test(value)) continue;
    if (/[`[]|<br/i.test(raw) || !/\p{L}/u.test(value) || ID_SHAPE.test(value)) return false;
    if (value.length > 24 || value.split(' ').length > 3) return false;
    seen.add(value.toLowerCase());
    count++;
  }
  return count >= 2 && seen.size <= 6;
}

/** The label tone of a cell, or null when the cell is not a label. */
function toneOf(value: string, enumerated: boolean): string | null {
  const key = value.toLowerCase();
  if (TONES[key]) return TONES[key];
  if (/^superseded\b/.test(key)) return 'quiet';
  if (!enumerated || value === '' || /^[-–—]+$/.test(value)) return null;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return `n${hash % NEUTRAL_TONES}`;
}

const isTableStart = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_DIVIDER.test(lines[i + 1])
  && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || isTableStart(lines, i);
}

function diagramHtml(source: string, ctx: any): string {
  ctx.diagrams.blocks++;
  const label = `${ctx.label} diagram ${++ctx.diagramIndex}`;
  const text = `<pre><code>${escapeHtml(source)}</code></pre>`;
  if (ctx.mode === 'cdn') {
    return `<figure class="diagram"><pre class="mermaid">${escapeHtml(source)}</pre></figure>`;
  }
  if (ctx.mode === 'inline') {
    const svg = ctx.render(source);
    if (svg) {
      ctx.diagrams.rendered++;
      const data = Buffer.from(svg, 'utf8').toString('base64');
      return `<figure class="diagram"><img alt="${escapeHtml(label)}" src="data:image/svg+xml;base64,${data}">`
        + `<details><summary>Diagram source</summary>${text}</details></figure>`;
    }
    ctx.diagrams.failures++;
  }
  return `<figure class="diagram diagram--source"><figcaption>Diagram source, not rendered</figcaption>${text}</figure>`;
}

function listHtml(lines: string[], start: number, ctx: any, depth: number): { html: string; next: number } {
  const base = indentOf(lines[start]);
  const ordered = /^\s*\d/.test(lines[start]);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length !== base) break;
    const body: string[] = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        // The whole run of blank lines is taken in one step: looking ahead again from each of them is quadratic.
        if (j < lines.length && indentOf(lines[j]) > base) { for (; i < j; i++) body.push(''); continue; }
        break;
      }
      if (indentOf(line) > base) { body.push(line); i++; continue; }
      if (startsBlock(lines, i)) break;
      body.push(line); i++;
    }
    const rest = body.slice(1);
    const cut = rest.reduce((least, l) => (l.trim() === '' ? least : Math.min(least, indentOf(l))), Infinity);
    let first = body[0];
    let box = '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
    if (task) {
      box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      first = task[2];
    }
    // A bullet led by a bold id defines it; that leading id is the defining spot, not a mention.
    const lead = /^\*\*\s*([A-Z]{1,6}-\d{1,4}(?:\.\d+)?|[A-Z]{1,3}\d{1,4})(?![\w-]|\.\d)/.exec(first);
    const def = lead ? defineId(ctx, lead[1], afterId(first, lead[1])) : null;
    if (lead) ctx.skipRef = lead[1];
    const blocks = blocksHtml([first, ...rest.map((l) => l.slice(Math.min(cut, indentOf(l))))], ctx, depth + 1);
    ctx.skipRef = null;
    // A one-paragraph item reads as a line, not as a paragraph inside a bullet.
    if (blocks.length > 0 && blocks[0].startsWith('<p>')) blocks[0] = blocks[0].slice(3, -4);
    items.push(`<li${def ? ` id="${escapeHtml(def.anchor)}"` : ''}${task ? ' class="task"' : ''}>${box}${blocks.join('\n')}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const first = ordered ? parseInt(lines[start].trim(), 10) : 1;
  return { html: `<${tag}${first > 1 ? ` start="${first}"` : ''}>\n${items.join('\n')}\n</${tag}>`, next: i };
}

/** Short anchor prefixes, one per document: the page carries thousands of id links. */
const ANCHOR_PREFIX: Record<string, string> = {
  requirement: 'r', design: 'd', specs: 's', data_model: 'm', plan: 'p', decisions: 'x', state: 't', audit: 'a',
};
const SUMMARY_CHARS = 140;
const clip = (text: string) => (text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : text);

/**
 * Record that the current document defines `id` here. The document's first definition is its primary
 * anchor, a second is a secondary anchor the primary row links down to, and any later one gets none.
 * The registry maps an id to one entry per defining document, in reading order.
 */
function defineId(ctx: any, id: string, summary: string, status = ''): { anchor: string; primary: boolean } | null {
  if (!ctx.registry) return null;
  let entries = ctx.registry.get(id);
  if (!entries) ctx.registry.set(id, (entries = []));
  const anchor = `${ANCHOR_PREFIX[ctx.key] || keyId(ctx.key)}-${id.replace(/ /g, '_')}`;
  const own = entries.find((e: any) => e.doc === ctx.key);
  if (!own) {
    entries.push({ doc: ctx.key, label: ctx.label, anchor, summary: clip(summary), status });
    return { anchor, primary: true };
  }
  if (own.secondary) return null;
  own.secondary = `${anchor}-2`;
  return { anchor: own.secondary, primary: false };
}

/**
 * Turn the id marks in one document's HTML into links, now that every definition on the page is known:
 * the same document's definition first, else the page's first. An unhyphenated short id defined by more
 * than one document, and an id nothing defines, stay plain text.
 */
function resolveRefs(html: string, key: string, registry: Map<string, any[]>): string {
  return html.replace(/<@([\^$]?)([^@<>]+)@>/g, (_all: string, mark: string, id: string) => {
    const entries = registry.get(id) || [];
    const own = entries.find((e) => e.doc === key);
    if (mark) return own?.secondary ? (mark === '^' ? `<a class="ref" href="#${escapeHtml(own.secondary)}">` : '</a>') : '';
    if (entries.length === 0 || (entries.length > 1 && /^[A-Z]+\d+$/.test(id))) return escapeHtml(id);
    return `<a class="ref" href="#${escapeHtml((own || entries[0]).anchor)}">${escapeHtml(id)}</a>`;
  });
}

/** The id a heading starts with: `IC-039: …`, `R1 …`, or the word form `Story 1: …` / `Story 1 — …`. */
function headingId(text: string): string | null {
  const t = text.replace(/^[*`_]+/, '');
  const id = /^([A-Z]{1,6}-\d{1,4}(?:\.\d+)?|[A-Z]{1,3}\d{1,4})(?![\w-]|\.\d)/.exec(t);
  if (id) return id[1];
  const word = /^([A-Z][a-z]+ \d{1,4}(?:\.\d+)?)\s*(?::|[-–—])/.exec(t);
  return word ? word[1] : null;
}

/** What follows a leading id, as a summary: `**FR-001:** The page …` → `The page …`. */
const afterId = (text: string, id: string) => plainText(text).slice(plainText(text).indexOf(id) + id.length).replace(/^[\s:.)\-–—]+/, '');

/** Quote and list levels converted as nested blocks; real documents stay in single digits. */
const MAX_BLOCK_DEPTH = 64;

/**
 * The HTML blocks of a run of markdown lines. Each quote or list level recurses with `depth + 1`; past
 * MAX_BLOCK_DEPTH the remaining lines are one escaped preformatted block, so a hostile document cannot
 * overflow the stack (FU-wdq963).
 */
function blocksHtml(lines: string[], ctx: any, depth = 0): string[] {
  if (depth > MAX_BLOCK_DEPTH) return [`<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        if (closesFence(FENCE.exec(lines[i]), fence[1])) break;
        body.push(lines[i]); i++;
      }
      i++;
      const source = body.join('\n');
      out.push(fence[2] === 'mermaid' ? diagramHtml(source, ctx) : `<pre><code>${escapeHtml(source)}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const slug = slugify(heading[2]) || 'section';
      const seen = ctx.slugs.get(slug) || 0;
      ctx.slugs.set(slug, seen + 1);
      const id = `${keyId(ctx.key)}-${seen ? `${slug}-${seen}` : slug}`;
      if (level === 2) ctx.sections.push({ id, text: heading[2].replace(/`/g, '') });
      const defined = headingId(heading[2]);
      const def = defined ? defineId(ctx, defined, afterId(heading[2], defined)) : null;
      const tag = `<h${level} id="${escapeHtml(id)}">${def ? `<span id="${escapeHtml(def.anchor)}"></span>` : ''}${inline(heading[2], ctx, false)}</h${level}>`;
      i++;
      // A History section, up to the next heading of its level or higher, starts closed.
      if ((level === 2 || level === 3) && /^history$/i.test(heading[2].replace(/`/g, '').replace(/^\d+(\.\d+)*\.?\s+/, '').trim())) {
        const body: string[] = [];
        let open: string | null = null;
        for (; i < lines.length; i++) {
          const m = FENCE.exec(lines[i]);
          if (open) { if (closesFence(m, open)) open = null; }
          else if (m) open = m[1];
          else { const next = HEADING.exec(lines[i]); if (next && next[1].length <= level) break; }
          body.push(lines[i]);
        }
        out.push(`<details class="history"><summary>${tag}</summary>\n${blocksHtml(body, ctx, depth + 1).join('\n')}\n</details>`);
        continue;
      }
      out.push(tag);
      continue;
    }

    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].replace(QUOTE, '')); i++; }
      out.push(`<blockquote>\n${blocksHtml(body, ctx, depth + 1).join('\n')}\n</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
      if (ctx.counts) ctx.counts.tables++;
      // The first column is the row's key, never a set of labels.
      const enumerated = head.map((_h, c) => c > 0 && isEnumerated(rows.map((row) => row[c] ?? '')));
      // A row defines the id in its first cell when the header's first cell is `ID` or every first cell is an id.
      const defines = /^id$/i.test(plainText(head[0])) || (rows.length > 0 && rows.every((row) => ID_SHAPE.test(plainText(row[0] ?? ''))));
      const status = head.findIndex((h) => /^status$/i.test(plainText(h)));
      const td = (row: string[], c: number) => {
        const raw = row[c] ?? '';
        const defined = c === 0 && defines ? plainText(raw) : '';
        if (ID_SHAPE.test(defined)) {
          const summary = row.slice(1).map(plainText).find((cell, k) => cell !== '' && k + 1 !== status) || '';
          const def = defineId(ctx, defined, summary, status > 0 ? plainText(row[status] ?? '') : '');
          const body = inline(raw, ctx, false);
          if (!def) return `<td>${body}</td>`;
          // The primary row's id links down to the same document's later definition, when it has one.
          return `<td id="${escapeHtml(def.anchor)}">${def.primary ? `<@^${defined}@>${body}<@$${defined}@>` : body}</td>`;
        }
        const body = inline(raw, ctx);
        const tone = toneOf(plainText(raw), enumerated[c]);
        return `<td>${tone ? `<span class="tag tag--${tone}">${body}</span>` : body}</td>`;
      };
      out.push(`<div class="table-wrap" data-cols="${head.length}"><table>\n`
        + `<thead><tr>${head.map((h) => `<th>${inline(h, ctx, false)}</th>`).join('')}</tr></thead>\n`
        + `<tbody>\n${rows.map((row) => `<tr>${head.map((_h, c) => td(row, c)).join('')}</tr>`).join('\n')}\n</tbody>\n</table></div>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = listHtml(lines, i, ctx, depth);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Two trailing spaces end a line inside a paragraph; the artifact header lines rely on it.
    const hard = (raw: string) => (/ {2,}$/.test(raw) ? `${raw.trim()}<br>` : raw.trim());
    const body: string[] = [hard(line)];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) { body.push(hard(lines[i])); i++; }
    out.push(`<p>${inline(body.join('\n'), ctx)}</p>`);
  }
  return out;
}

/** One document's body HTML and the level-2 headings the page's contents list links to. */
function documentHtml(text: string, ctx: any): { html: string; sections: Array<{ id: string; text: string }> } {
  const parts = documentParts(text, ctx);
  return { html: resolveRefs(parts.html, ctx.key, parts.registry), sections: parts.sections };
}

/** Words in a document, outside fenced blocks: tokens holding a letter or a digit. */
function countWords(lines: string[]): number {
  let open: string | null = null;
  let words = 0;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (open) { if (closesFence(m, open)) open = null; continue; }
    if (m) { open = m[1]; continue; }
    for (const token of line.split(/[\s|]+/)) if (/[\p{L}\p{N}]/u.test(token)) words++;
  }
  return words;
}

/**
 * The collect pass over one document: its HTML with id marks still unresolved, its level-2 headings and
 * counts, with its definitions added to `ctx.registry` (a new one when the caller passed none).
 */
function documentParts(text: string, ctx: any) {
  const lines = stripComments(text).split('\n');
  const state = { ...ctx, slugs: new Map(), sections: [], diagramIndex: 0, registry: ctx.registry || new Map(), counts: { tables: 0 }, skipRef: null };
  const html = blocksHtml(lines, state).join('\n');
  return { html, sections: state.sections as Array<{ id: string; text: string }>, registry: state.registry as Map<string, any[]>, tables: state.counts.tables, words: countWords(lines) };
}

const STYLE = `
:root{--bg:#fbfbfa;--panel:#ffffff;--ink:#22252e;--muted:#5d6577;--line:#dcdde0;--accent:#b4491c;--code:#f1f1ef;--figure:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--panel:#1d2027;--ink:#e6e7ea;--muted:#a0a7b6;--line:#343842;--accent:#f0915f;--code:#262a33}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.top{padding:28px 32px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.kicker{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.slug{margin:4px 0 6px;font-size:26px;line-height:1.25;overflow-wrap:anywhere}
.meta{margin:0;font-size:14px;color:var(--muted)}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);align-items:start}
.contents{position:sticky;top:0;max-height:100vh;overflow:auto;padding:24px 16px 24px 32px;font-size:14px}
.contents ol{list-style:none;margin:0;padding:0}
.contents>ol>li{margin-bottom:14px}
.contents>ol>li>a{font-weight:600;color:var(--ink);text-decoration:none}
.contents ol ol{margin-top:4px;padding-left:12px;border-left:1px solid var(--line)}
.contents ol ol a{display:block;padding:2px 0;color:var(--muted);text-decoration:none}
.contents a:hover{color:var(--accent)}
main{min-width:0;padding:24px 32px 64px;max-width:980px}
.doc{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 32px 28px;margin-bottom:28px}
.doc-label{margin:16px 0 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.doc-label .path{margin-left:8px;letter-spacing:0;text-transform:none;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:28px;line-height:1.25;margin:8px 0 16px}
h2{font-size:21px;margin:36px 0 12px;padding-top:20px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:28px 0 8px}
h4,h5,h6{font-size:15px;margin:22px 0 6px}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:24px}
li{margin:4px 0}
li.task{list-style:none;margin-left:-22px}
blockquote{margin:0 0 14px;padding:10px 16px;border-left:3px solid var(--line);color:var(--muted)}
blockquote p:last-child{margin-bottom:0}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{margin:0 0 14px;padding:14px 16px;background:var(--code);border-radius:8px;overflow:auto}
pre code{padding:0;background:none;overflow-wrap:normal}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.table-wrap{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600}
a.ref{text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.ids{display:inline-flex;flex-wrap:wrap;gap:2px 8px}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;background:#ececef;color:#3f4552}
.tag--good{background:#e3f3e6;color:#1e6b34}.tag--warn{background:#fbefd9;color:#86560b}.tag--info{background:#e2ecfb;color:#1f4f99}
.tag--quiet{background:#efefef;color:#6b6f78}.tag--bad{background:#fbe3e1;color:#a1281c}
.tag--n1{background:#ece6f7;color:#5a3d8f}.tag--n2{background:#e1f2f2;color:#1d6363}.tag--n3{background:#f6e6ef;color:#8a2f5f}
.tag--n4{background:#eef0dd;color:#5b6115}.tag--n5{background:#e6ebf0;color:#3c4b5c}
details.history>summary{cursor:pointer}details.history>summary>*{display:inline}
.diagram{margin:0 0 18px;padding:16px;background:var(--figure);border:1px solid var(--line);border-radius:8px;text-align:center;overflow-x:auto}
.diagram img{max-width:100%;height:auto}
img.image{display:block;max-width:100%;height:auto;margin:0 auto 18px}
.image-missing{color:var(--muted);font-style:italic}
.diagram pre{text-align:left;margin:0}
.diagram pre.mermaid{background:none;color:#22252e}
.diagram details{margin-top:10px;text-align:left;font-size:13px;color:#5d6577}
.diagram--source{background:var(--panel);text-align:left}
.diagram figcaption{margin-bottom:8px;font-size:13px;color:var(--muted)}
@media (max-width:860px){.layout{grid-template-columns:1fr}.contents{position:static;max-height:none;padding:16px 16px 0}main{padding:16px}.doc{padding:4px 16px 20px}.top{padding:20px 16px}}
@media print{.contents{display:none}.layout{display:block}body{background:#fff}.doc{border:0;padding:0;break-before:page}.diagram{break-inside:avoid}}
`.trim();

/** A renderer for `inline` mode: Mermaid text in, SVG text out, or null when `mmdc` failed on it. */
function mmdcRenderer(theme: string | null): { render: (source: string) => string | null; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-page-'));
  let n = 0;
  return {
    render(source: string) {
      const input = path.join(dir, `${++n}.mmd`);
      const output = path.join(dir, `${n}.svg`);
      fs.writeFileSync(input, `${source}\n`);
      const args = ['-i', input, '-o', output, '-b', 'transparent', ...(theme ? ['-c', theme] : [])];
      const run = mmdc(args, RENDER_TIMEOUT_MS);
      if (run.status !== 0 || !fs.existsSync(output)) return null;
      return fs.readFileSync(output, 'utf8');
    },
    dispose() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Run `mmdc`. On Windows it is a `.cmd` shim, which needs the shell, and the shell needs paths with a space quoted. */
function mmdc(args: string[], timeout: number): any {
  if (process.platform !== 'win32') return spawnSync('mmdc', args, { encoding: 'utf8', timeout });
  const line = ['mmdc', ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ');
  return spawnSync(line, { encoding: 'utf8', timeout, shell: true });
}

const hasMmdc = () => mmdc(['--version'], 20000).status === 0;

/** The script a `cdn` page carries: Mermaid from the pinned build, styled by the shipped theme. */
function mermaidScript(theme: string | null): string {
  let config: any = {};
  if (theme) {
    try { config = JSON.parse(fs.readFileSync(theme, 'utf8')); } catch { config = {}; }
  }
  const settings = JSON.stringify({ ...config, startOnLoad: true, securityLevel: 'strict' }).replace(/</g, '\\u003c');
  return `<script src="${MERMAID_SCRIPT}" integrity="${MERMAID_INTEGRITY}" crossorigin="anonymous"></script>\n`
    + `<script>mermaid.initialize(${settings});</script>`;
}

/**
 * Build the page for one feature.
 *
 * `paths` is the object `doflow-run paths --json` printed. Document locations in it are relative to
 * `root`. Returns what was written and what was not; it throws only on a bad argument.
 */
function buildPage({ paths, root, out, mode = 'auto', theme = null, now = new Date(), render = null, probe = hasMmdc }: any = {}): any {
  if (!paths || typeof paths !== 'object') throw new TypeError('buildPage: paths must be the object `paths --json` printed');
  if (!root || typeof root !== 'string') throw new TypeError('buildPage: root must be a directory path');
  if (!MODES.includes(mode)) throw new TypeError(`buildPage: mode must be one of ${MODES.join(', ')}`);

  const found = DOCUMENTS
    .map(([key, label]) => ({ key, label, rel: paths[key] }))
    .filter((doc) => typeof doc.rel === 'string' && doc.rel && fs.existsSync(path.join(root, doc.rel)));
  if (found.length === 0) return { ok: true, written: false, note: 'no chain document found for this feature', documents: [] };

  const themeFile = theme && fs.existsSync(theme) ? theme : null;
  let resolved = mode;
  const notes: string[] = [];
  // An absent renderer is an absent optional capability, not a failed render: the page falls back to
  // source and says so, whether the caller asked for `auto` or for `inline`.
  if (mode === 'auto' || mode === 'inline') {
    resolved = render || probe() ? 'inline' : 'source';
    if (resolved === 'source') {
      notes.push('diagrams are shown as source: the mermaid renderer was not found. Install it with '
        + '`npm install -g @mermaid-js/mermaid-cli`, or pass --diagrams=cdn for a page that loads Mermaid from jsDelivr when opened');
    }
  }
  if (theme && !themeFile && resolved !== 'source') {
    notes.push(`the DoFlow diagram theme was not found at ${theme}, so diagrams use Mermaid's default colours. Reinstall the scripts tree: npx @khoavu882/doflow install`);
  }
  const renderer = resolved === 'inline' && !render ? mmdcRenderer(themeFile) : null;
  const diagrams = { mode: resolved, blocks: 0, rendered: 0, failures: 0 };
  const images = newImageState();
  const docs = new Map(found.map((doc) => [path.resolve(root, doc.rel), doc.key]));
  const featureDir = typeof paths.feature_dir === 'string' ? paths.feature_dir : '';
  const target = path.resolve(out || path.join(root, featureDir, 'page.html'));

  let sectionsHtml = '';
  let contents = '';
  const documents: any[] = [];
  const counts: any[] = [];
  const parts: Array<{ key: string; html: string }> = [];
  // Every id a document defines is known before any mention is linked: collect over all documents first.
  const registry = new Map<string, any[]>();
  try {
    for (const doc of found) {
      const before = diagrams.blocks;
      const text = fs.readFileSync(path.join(root, doc.rel), 'utf8');
      const collected = documentParts(text, {
        key: doc.key, label: doc.label, mode: resolved, diagrams, render: render || renderer?.render,
        docs, dir: path.dirname(path.resolve(root, doc.rel)), outDir: path.dirname(target), root, images, registry,
      });
      const shown = featureDir && doc.rel.startsWith(`${featureDir}/`) ? doc.rel.slice(featureDir.length + 1) : doc.rel;
      parts.push({ key: doc.key, html: `<section class="doc" id="doc-${keyId(doc.key)}">\n`
        + `<p class="doc-label">${escapeHtml(doc.label)}<span class="path">${escapeHtml(shown)}</span></p>\n${collected.html}\n</section>\n` });
      contents += `<li><a href="#doc-${keyId(doc.key)}">${escapeHtml(doc.label)}</a>`
        + (collected.sections.length ? `<ol>${collected.sections.map((s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.text)}</a></li>`).join('')}</ol>` : '')
        + '</li>\n';
      documents.push({ key: doc.key, path: doc.rel, diagrams: diagrams.blocks - before });
      counts.push({ key: doc.key, label: doc.label, h2: collected.sections.length, words: collected.words, tables: collected.tables, diagrams: diagrams.blocks - before, ids: {} });
    }
  } finally {
    renderer?.dispose();
  }
  for (const part of parts) sectionsHtml += resolveRefs(part.html, part.key, registry);
  const idData: Record<string, any[]> = {};
  for (const [id, entries] of registry) {
    idData[id] = entries.map((e) => ({ doc: e.label, anchor: e.anchor, summary: e.summary, ...(e.status ? { status: e.status } : {}) }));
    // `FR-001` → FR, `R1` → R, `Story 1` → Story.
    const prefix = id.split(/[- ]|(?=\d)/)[0];
    for (const e of entries) {
      const tally = counts.find((c) => c.key === e.doc).ids;
      tally[prefix] = (tally[prefix] || 0) + 1;
    }
  }
  const idScript = registry.size ? `<script type="application/json" id="page-ids">${JSON.stringify(idData).replace(/</g, '\\u003c')}</script>\n` : '';

  const slug = typeof paths.feature_slug === 'string' && paths.feature_slug ? paths.feature_slug : path.basename(featureDir || root);
  const how = diagrams.blocks === 0 ? 'no diagrams'
    : resolved === 'inline' ? `${diagrams.rendered} of ${diagrams.blocks} diagrams rendered`
      : resolved === 'cdn' ? `${diagrams.blocks} diagrams, drawn by Mermaid loaded from jsDelivr`
        : `${diagrams.blocks} diagrams shown as source`;
  const page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="doflow render-page">\n'
    + `<title>${escapeHtml(slug)}</title>\n<style>\n${STYLE}\n</style>\n</head>\n<body>\n`
    + `<header class="top">\n<p class="kicker">DoFlow feature</p>\n<p class="slug">${escapeHtml(slug)}</p>\n`
    + `<p class="meta">${found.length} document${found.length === 1 ? '' : 's'} · ${how} · generated ${escapeHtml(now.toISOString().slice(0, 16).replace('T', ' '))} UTC`
    + `${featureDir ? ` from <code>${escapeHtml(featureDir)}</code>` : ''}</p>\n</header>\n`
    + `<div class="layout">\n<nav class="contents" aria-label="Documents">\n<ol>\n${contents}</ol>\n</nav>\n<main>\n${sectionsHtml}</main>\n</div>\n`
    + idScript
    + (resolved === 'cdn' && diagrams.blocks > 0 ? `${mermaidScript(themeFile)}\n` : '')
    + '</body>\n</html>\n';

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, page);
  try { fs.renameSync(tmp, target); }
  catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  if (images.skipped.length) notes.push(`${images.skipped.length} image(s) not shown: ${images.skipped.join(', ')}`);
  const result = { ok: diagrams.failures === 0, written: true, file: target, documents, diagrams, images: { embedded: images.embedded, skipped: images.skipped.length }, ...(notes.length ? { note: notes.join('; ') } : {}) };
  // Per-document counts for the page's own overview; not enumerable, so the `--json` result stays as it is.
  Object.defineProperty(result, 'counts', { value: counts, enumerable: false });
  return result;
}

module.exports = { buildPage, documentHtml, inline, stripComments, splitRow, slugify, DOCUMENTS, MODES, MERMAID_SCRIPT, MERMAID_INTEGRITY };

if (require.main === module) {
  const args: any = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
  let paths: any;
  try { paths = JSON.parse(args['--paths'] || ''); }
  catch { process.stderr.write('usage: page-project.ts --paths <paths --json output> --root <dir> [--out <file>] [--diagrams <mode>] [--theme <file>]\n'); process.exit(2); }
  let result: any;
  try {
    result = buildPage({ paths, root: args['--root'], out: args['--out'], mode: args['--diagrams'] || 'auto', theme: args['--theme'] || null });
  } catch (err: any) {
    process.stderr.write(`page-project: ${err.message}\n`);
    process.exit(err instanceof TypeError ? 2 : 1);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
