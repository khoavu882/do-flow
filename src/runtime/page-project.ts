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
      const skip = ctx.skipRef ? ctx.skipRef.indexOf(id) : -1;
      if (skip >= 0) { ctx.skipRef.splice(skip, 1); return id; }
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

/**
 * Column floors in characters (design §7: cells at least 8ch). An overflowing table gives every column
 * only its narrowest width, so a long-text column would shrink to one word a line; each column's header
 * cell instead carries a floor fitting its longest cell, up to COLUMN_FLOOR_CH. A table whose floors
 * add up past WIDE_TABLE_CH scrolls in its frame anyway, so its floors go up to WIDE_COLUMN_FLOOR_CH and
 * a long column reads in lines rather than a word a line. A browser ignores a maximum width on a table
 * cell, so no ceiling is set.
 */
const COLUMN_MIN_CH = 8;
const COLUMN_FLOOR_CH = 20;
const WIDE_COLUMN_FLOOR_CH = 40;
const WIDE_TABLE_CH = 112;
const COLUMN_STEP_CH = 4;

/** Each column's header-cell width class, '' where the default floor is enough. */
function columnFloors(head: string[], rows: string[][]): string[] {
  const longest = head.map((h, c) => Math.max(plainText(h).length, ...rows.map((row) => plainText(row[c] ?? '').length)) + 1);
  const fit = (cap: number) => longest.map((n) => Math.min(cap, Math.max(COLUMN_MIN_CH, Math.ceil(n / COLUMN_STEP_CH) * COLUMN_STEP_CH)));
  const narrow = fit(COLUMN_FLOOR_CH);
  const floors = narrow.reduce((sum, ch) => sum + ch, 0) > WIDE_TABLE_CH ? fit(WIDE_COLUMN_FLOOR_CH) : narrow;
  return floors.map((ch) => (ch > COLUMN_MIN_CH ? ` class="min${ch}"` : ''));
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

function listHtml(lines: string[], start: number, ctx: any, depth: number): { html: string; next: number; items: number } {
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
    const run = lead ? leadRun(first, lead[1]) : null;
    const defs = run ? run.ids.map((id) => defineId(ctx, id, run.summary)) : [];
    const def = defs[0] || null;
    // The later ids of the run are anchored at the start of the item; the item itself carries the first.
    const later = defs.slice(1).map((d) => (d ? `<span id="${escapeHtml(d.anchor)}"></span>` : '')).join('');
    if (run) ctx.skipRef = run.ids;
    const blocks = blocksHtml([first, ...rest.map((l) => l.slice(Math.min(cut, indentOf(l))))], ctx, depth + 1);
    ctx.skipRef = null;
    // A one-paragraph item reads as a line, not as a paragraph inside a bullet.
    if (blocks.length > 0 && blocks[0].startsWith('<p>')) blocks[0] = blocks[0].slice(3, -4);
    items.push(`<li${def ? ` id="${escapeHtml(def.anchor)}"` : ''}${task ? ' class="task"' : ''}>${later}${box}${blocks.join('\n')}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const first = ordered ? parseInt(lines[start].trim(), 10) : 1;
  return { html: `<${tag}${first > 1 ? ` start="${first}"` : ''}>\n${items.join('\n')}\n</${tag}>`, next: i, items: items.length };
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

/** One more id of a leading run: `, IC-061`, `, and IC-062`, ` / IC-063`, ` to IC-064`. */
const RUN_NEXT = /^\s*(?:,\s*(?:and\s+)?|\/\s*|(?:and|to)\s+)([A-Z]{1,6}-\d{1,4}(?:\.\d+)?|[A-Z]{1,3}\d{1,4})(?![\w-]|\.\d)/;

/**
 * The ids a heading or bold bullet opens with, and what follows them as their summary:
 * `**FR-001:** The page …` → [FR-001], `The page …`; `**IC-060, IC-061:** Before …` → [IC-060, IC-061], `Before …`.
 * A run counts only when a colon or dash closes it; otherwise the first id alone leads.
 */
function leadRun(text: string, id: string): { ids: string[]; summary: string } {
  const plain = plainText(text);
  const after = plain.slice(plain.indexOf(id) + id.length);
  const ids = [id];
  let rest = after;
  for (let m = RUN_NEXT.exec(rest); m; m = RUN_NEXT.exec(rest)) { ids.push(m[1]); rest = rest.slice(m[0].length); }
  const strip = (t: string) => t.replace(/^[\s:.)\-–—]+/, '');
  return ids.length > 1 && /^\s*[:\-–—]/.test(rest) ? { ids, summary: strip(rest) } : { ids: [id], summary: strip(after) };
}

/** A level-2 heading that names open questions, open points or open items; its rows and bullets are counted. */
const OPEN_SECTION = /\bopen\s+(questions?|points?|items?|issues?)\b/i;

/** A heading's leading section number (`3.`, `4.2`) wrapped so the page can mute it; `html` is already escaped. */
const mutedNumber = (html: string) => html.replace(/^(\d+(?:\.\d+)*\.|\d+(?:\.\d+)+)(?=\s)/, '<span class="num">$1</span>');

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
      const text = heading[2].replace(/`/g, '');
      if (level === 2) {
        ctx.sections.push({ id, text });
        if (ctx.counts) ctx.counts.inOpen = OPEN_SECTION.test(text);
      }
      if (level === 3 && ctx.subsections && ctx.sections.length) ctx.subsections.push({ id, text, parent: ctx.sections[ctx.sections.length - 1].id });
      const defined = headingId(heading[2]);
      const run = defined ? leadRun(heading[2], defined) : null;
      const anchors = run ? run.ids.map((one) => defineId(ctx, one, run.summary)).map((d) => (d ? `<span id="${escapeHtml(d.anchor)}"></span>` : '')).join('') : '';
      const tag = `<h${level} id="${escapeHtml(id)}">${anchors}${mutedNumber(inline(heading[2], ctx, false))}</h${level}>`;
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
      if (ctx.counts) { ctx.counts.tables++; if (ctx.counts.inOpen && depth === 0) ctx.counts.open += rows.length; }
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
      const floors = columnFloors(head, rows);
      out.push(`<div class="table-wrap" data-cols="${head.length}"><table${defines ? ' class="id-first"' : ''}>\n`
        + `<thead><tr>${head.map((h, c) => `<th${floors[c]}>${inline(h, ctx, false)}</th>`).join('')}</tr></thead>\n`
        + `<tbody>\n${rows.map((row) => `<tr>${head.map((_h, c) => td(row, c)).join('')}</tr>`).join('\n')}\n</tbody>\n</table></div>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = listHtml(lines, i, ctx, depth);
      if (ctx.counts?.inOpen && depth === 0) ctx.counts.open += list.items;
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
  const state = {
    ...ctx, slugs: ctx.slugs || new Map(), sections: [], subsections: [], diagramIndex: 0, registry: ctx.registry || new Map(),
    counts: { tables: 0, open: 0, inOpen: false }, skipRef: null,
  };
  const blocks = blocksHtml(lines, state);
  return {
    html: blocks.join('\n'), blocks, sections: state.sections as Array<{ id: string; text: string }>,
    subsections: state.subsections as Array<{ id: string; text: string; parent: string }>,
    registry: state.registry as Map<string, any[]>, tables: state.counts.tables, open: state.counts.open, words: countWords(lines),
  };
}

/** Light and dark colours, as custom properties (design §7). */
const LIGHT = '--bg:#f6f6f4;--surface:#ffffff;--ink:#1c2028;--muted:#5b6475;--line:#e4e4e7;--accent:#b4491c;--ref:#9a3d14;'
  + '--code:#efefec;--tint:rgba(28,32,40,.045);--zebra:rgba(28,32,40,.02);--shadow:rgba(28,32,40,.18);--figure:#fbfbfa;color-scheme:light';
const DARK = '--bg:#101217;--surface:#171a21;--ink:#e8eaef;--muted:#9aa3b5;--line:#2a2f3a;--accent:#f0915f;--ref:#f4a77e;'
  + '--code:#1f232c;--tint:rgba(232,234,239,.055);--zebra:rgba(232,234,239,.02);--shadow:rgba(0,0,0,.6);--figure:#f3f3f1;color-scheme:dark';
/** Label colours per tone: light background and text, then dark background and text. */
const TONE_COLORS: Record<string, [string, string, string, string]> = {
  good: ['#e3f3e6', '#1e6b34', 'rgba(74,190,110,.16)', '#86d9a0'],
  warn: ['#fbefd9', '#86560b', 'rgba(240,170,60,.16)', '#f2c378'],
  info: ['#e2ecfb', '#1f4f99', 'rgba(90,150,240,.18)', '#9cc0f5'],
  quiet: ['#efeff0', '#62666f', 'rgba(232,234,239,.07)', '#9aa3b5'],
  bad: ['#fbe3e1', '#a1281c', 'rgba(240,90,80,.18)', '#f3a097'],
  n0: ['#f3e8e1', '#7a4422', 'rgba(220,150,110,.16)', '#e7b796'],
  n1: ['#ece6f7', '#5a3d8f', 'rgba(160,130,230,.18)', '#c4b0f0'],
  n2: ['#e1f2f2', '#1d6363', 'rgba(80,190,190,.16)', '#8fd6d6'],
  n3: ['#f6e6ef', '#8a2f5f', 'rgba(230,110,170,.16)', '#eda6c9'],
  n4: ['#eef0dd', '#5b6115', 'rgba(180,190,80,.16)', '#cdd48a'],
  n5: ['#e6ebf0', '#3c4b5c', 'rgba(140,160,190,.16)', '#b5c3d6'],
};
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
/** The dark theme under one selector: the colours, and labels switched to their dark pair. */
const darkTheme = (sel: string) => `${sel}{${DARK}}${sel} .tag{background:var(--tbd);color:var(--tfd)}`;

const STYLE = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){${darkTheme('html:not([data-theme=light])')}}
${darkTheme('html[data-theme=dark]')}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:76px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:2px}
code,pre{font-family:${MONO}}
.appbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:16px;height:56px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto;color:var(--ink);text-decoration:none}
.mark{position:relative;flex:none;width:18px;height:18px;border:2px solid var(--accent);border-radius:5px}
.mark::after{content:"";position:absolute;inset:3px;border-radius:1px;background:var(--accent)}
.brand .name{min-width:0;overflow:hidden;font-size:15px;font-weight:650;white-space:nowrap;text-overflow:ellipsis}
.brand .slug{flex:none;font-size:12px;color:var(--muted);background:none;padding:0}
.bar-tools{display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0}
.bar-tools [hidden]{display:none}
.filter{width:300px;min-width:0;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
.filter:focus{outline:2px solid var(--accent);outline-offset:-1px}
.theme{flex:none;width:34px;height:34px;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:16px;cursor:pointer}
.nav-toggle{display:none}
.layout{display:grid;grid-template-columns:288px minmax(0,1fr);align-items:start}
.sidebar{position:sticky;top:56px;height:calc(100vh - 56px);overflow:auto;padding:20px 14px 48px 16px;border-right:1px solid var(--line);font-size:14px;line-height:1.45}
.sidebar ol{list-style:none;margin:0;padding:0}
.nav-doc{margin:0 0 4px}
.nav-doc>a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-radius:8px;color:var(--ink);font-weight:600;text-decoration:none}
.nav-doc>a:hover,.nav-doc[data-current]>a{background:var(--tint)}
.nav-secs{margin:2px 0 12px 10px}
.nav-sec>a{display:block;padding:4px 10px 4px 12px;border-left:2px solid var(--line);color:var(--muted);text-decoration:none}
.nav-sec>a:hover{color:var(--ink)}
.nav-sec[data-current]>a{border-left-color:var(--accent);color:var(--ink)}
.nav-sub{display:none}
.nav-sec[data-current]>.nav-sub{display:block}
.nav-sub .nav-sec>a{padding-left:24px;font-size:13px}
html[data-script] .nav-doc:not([data-current])>.nav-secs{display:none}
.num{color:var(--muted);font-weight:500}
main{min-width:0;max-width:1276px;padding:32px 48px 40px;overflow-wrap:break-word}
.view{margin:0 0 64px}
:is(.doc,.state-rest,details.history)>:is(p,ul,ol,blockquote,h1,h2,h3,h4,h5,h6,pre,hr){max-width:820px}
h1,h2,h3,h4,h5,h6{font-weight:650;line-height:1.3}
h1{font-size:30px;margin:0 0 16px;letter-spacing:-.01em}
h2{font-size:22px;margin:48px 0 14px}
h3{font-size:18px;margin:32px 0 10px}
h4{font-size:16px;margin:24px 0 8px}
h5,h6{font-size:15px;margin:20px 0 6px}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:24px}
li{margin:4px 0}
li.task{list-style:none;margin-left:-22px}
blockquote{margin:0 0 16px;padding:10px 16px;border-left:3px solid var(--line);color:var(--muted)}
blockquote p:last-child{margin-bottom:0}
code{font-size:13px;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{margin:0 0 16px;padding:14px 16px;font-size:13px;line-height:1.55;background:var(--code);border-radius:8px;overflow:auto}
pre code{padding:0;background:none;overflow-wrap:normal}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
.kicker{margin:0 0 6px;font-size:12px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.facts{display:flex;flex-wrap:wrap;gap:12px 32px;margin:0}
.fact{min-width:0;max-width:100%}
.fact dt{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.fact dd{margin:2px 0 0;font-size:14.5px;line-height:1.5;overflow-wrap:anywhere}
.doc-head{margin:0 0 32px;padding:24px 28px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.doc-head h1{margin:0 0 16px}
.doc-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:18px 0 0;font-size:13px;color:var(--muted)}
.doc-meta .path{font-size:12.5px;color:var(--muted);background:none;padding:0}
.ov-head{margin:0 0 28px}
.ov-head h1{margin:0}
.ov-slug{margin:6px 0 22px}
.ov-slug code{font-size:13px;color:var(--muted);background:none;padding:0}
.chain{display:flex;flex-wrap:wrap;align-items:center;gap:8px 0;list-style:none;margin:0 0 32px;padding:0;counter-reset:step}
.chain li{display:flex;align-items:center;margin:0}
.chain li+li::before{content:"";width:14px;height:1px;background:var(--line)}
.chain a{display:flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;background:var(--surface);border:1px solid var(--line);border-radius:999px;color:var(--ink);font-size:13.5px;font-weight:600;text-decoration:none}
.chain a::before{counter-increment:step;content:counter(step);display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--tint);color:var(--muted);font-size:12px}
.chain a:hover,.doc-card:hover{border-color:var(--accent)}
.ov-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr));gap:16px;align-items:start;margin:0 0 16px}
.card{min-width:0;padding:20px;font-size:14.5px;line-height:1.6;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.card h2{margin:0 0 12px;font-size:16px}
.card>.clamp>:last-child,.card li:last-child{margin-bottom:0}
.card .table-wrap{margin-bottom:0}
.card--long>.clamp{max-height:360px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 72%,transparent);mask-image:linear-gradient(#000 72%,transparent)}
.card:has(>details.more[open])>.clamp{max-height:none;-webkit-mask-image:none;mask-image:none}
@supports not selector(:has(*)){.card--long>.clamp{max-height:none;-webkit-mask-image:none;mask-image:none}.more{display:none}}
.more{margin-top:10px}
.more>summary{display:inline-block;list-style:none;cursor:pointer;font-size:13.5px;font-weight:650;color:var(--accent)}
.more>summary::-webkit-details-marker{display:none}
.more[open] .more-show,.more:not([open]) .more-hide{display:none}
.ov-title{margin:40px 0 14px}
.doc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:16px;margin:0 0 48px}
.doc-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:20px;background:var(--surface);border:1px solid var(--line);border-radius:12px;color:var(--ink);text-decoration:none}
.doc-card .top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.doc-card .kicker{margin:0}
.doc-card .title{font-size:16px;font-weight:650;line-height:1.35}
.stats{display:flex;flex-wrap:wrap;gap:2px 14px;margin:0;padding:0;list-style:none;font-size:13px;color:var(--muted)}
.stats li{margin:0}
.id-counts{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0;padding:0;list-style:none}
.id-counts li{margin:0;padding:2px 7px;border-radius:6px;background:var(--tint);font:12px/1.5 ${MONO}}
.id-counts b{font-weight:650}
.table-wrap{max-width:100%;overflow-x:auto;margin:0 0 22px;border:1px solid var(--line);border-radius:10px;background-color:var(--surface);
background-image:linear-gradient(90deg,var(--surface) 40%,transparent),linear-gradient(270deg,var(--surface) 40%,transparent),radial-gradient(farthest-side at 0 50%,var(--shadow),transparent),radial-gradient(farthest-side at 100% 50%,var(--shadow),transparent);
background-position:left center,right center,left center,right center;background-size:40px 100%,40px 100%,14px 100%,14px 100%;background-repeat:no-repeat;background-attachment:local,local,scroll,scroll}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;line-height:1.5}
th,td{min-width:calc(${COLUMN_MIN_CH}ch + 24px);padding:8px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th+th,td+td{border-left:1px solid var(--line)}
th{background:var(--tint);font-weight:650}
${Array.from({ length: (WIDE_COLUMN_FLOOR_CH - COLUMN_MIN_CH) / COLUMN_STEP_CH }, (_v, k) => COLUMN_MIN_CH + (k + 1) * COLUMN_STEP_CH).map((ch) => `th.min${ch}{min-width:calc(${ch}ch + 24px)}`).join('')}
.card th[class],.card th,.card td{min-width:calc(${COLUMN_MIN_CH}ch + 24px)}
tbody tr:nth-child(even)>td{background:var(--zebra)}
tbody tr:last-child>td{border-bottom:0}
table.id-first td:first-child{white-space:nowrap;font-family:${MONO};font-size:12.5px}
a.ref{color:var(--ref);text-decoration:none;white-space:nowrap;font-family:${MONO};font-size:.9em;border-bottom:1px dotted currentColor}
a.ref:hover{border-bottom-style:solid}
.ids{display:inline-flex;flex-wrap:wrap;gap:2px 8px}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;--tb:#ececef;--tf:#3f4552;--tbd:rgba(232,234,239,.08);--tfd:#c9ced8;background:var(--tb);color:var(--tf)}
${Object.entries(TONE_COLORS).map(([tone, [tb, tf, tbd, tfd]]) => `.tag--${tone}{--tb:${tb};--tf:${tf};--tbd:${tbd};--tfd:${tfd}}`).join('\n')}
details.history{max-width:820px;margin:40px 0 0;padding:0 18px;background:var(--surface);border:1px solid var(--line);border-radius:10px}
details.history[open]{padding-bottom:6px}
details.history>summary{padding:12px 0;cursor:pointer;color:var(--muted)}
details.history>summary>*{display:inline;margin:0;font-size:16px}
.diagram{margin:0 0 22px;padding:16px;background:var(--figure);border:1px solid var(--line);border-radius:10px;text-align:center;overflow-x:auto}
.diagram img{max-width:100%;height:auto}
img.image{display:block;max-width:100%;height:auto;margin:0 auto 18px}
.image-missing{color:var(--muted);font-style:italic}
.diagram pre{text-align:left;margin:0}
.diagram pre.mermaid{background:none;color:#1c2028}
.diagram details{margin-top:10px;text-align:left;font-size:13px;color:#5b6475}
.diagram--source{background:var(--surface);text-align:left}
.diagram figcaption{margin-bottom:8px;font-size:13px;color:var(--muted)}
.foot{margin:0;padding:20px 0 0;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.foot code{font-size:12px;background:none;padding:0}
.view[hidden]{margin:0}
[data-hit],tbody tr:has(>[data-hit])>td{background:color-mix(in srgb,var(--accent) 11%,transparent)}
.anchor{margin-left:.4em;color:var(--muted);font-weight:500;text-decoration:none;opacity:0}
.anchor::before{content:"#"}
:is(h2,h3):hover>.anchor,.anchor:focus-visible{opacity:1}
.bar-tools{position:relative}
.filter-results{position:absolute;top:42px;right:0;z-index:50;width:min(460px,calc(100vw - 24px));max-height:min(64vh,520px);overflow:auto;margin:0;padding:6px;list-style:none;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px var(--shadow)}
.filter-results li{margin:0}
.filter-results a{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 10px;padding:7px 10px;border-radius:8px;color:var(--ink);font-size:13.5px;line-height:1.45;text-decoration:none}
.filter-results a:hover,.filter-results a.on{background:var(--tint)}
.filter-results .rid{font:650 12.5px/1.45 ${MONO};color:var(--ref)}
.filter-results .rdoc{font-size:12px;color:var(--muted);text-align:right}
.filter-results .rsum{grid-column:1/-1;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.filter-results .rnote{padding:7px 10px;font-size:13px;color:var(--muted)}
.sidebar [data-miss]{display:none}
html[data-script] .sidebar[data-filtering] .nav-doc>.nav-secs,.sidebar[data-filtering] .nav-sub{display:block}
.ref-card{position:fixed;z-index:60;max-width:min(380px,calc(100vw - 16px));margin:0;padding:10px 12px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 28px var(--shadow);font-size:13.5px;line-height:1.5;pointer-events:none}
.ref-card[hidden]{display:none}
.ref-card p{margin:0}
.ref-card .rc-top{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-bottom:4px}
.ref-card .rc-id{font:650 13px/1.4 ${MONO};color:var(--ref)}
.ref-card .rc-doc{font-size:12px;color:var(--muted)}
.frame-bar{display:flex;justify-content:flex-end;margin:0 0 6px}
.frame-bar[hidden]{display:none}
.tool-btn{flex:none;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer}
.tool-btn:hover{border-color:var(--accent)}
dialog.viewer{width:calc(100vw - 32px);height:calc(100vh - 32px);max-width:none;max-height:none;margin:auto;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);overflow:hidden}
dialog.viewer[open]{display:flex;flex-direction:column}
dialog.viewer::backdrop{background:rgba(10,12,16,.55)}
.viewer-bar{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 18px;border-bottom:1px solid var(--line)}
.viewer-title{flex:1 1 auto;min-width:0;margin:0;overflow:hidden;font-size:15px;white-space:nowrap;text-overflow:ellipsis}
.viewer-tools{display:flex;align-items:center;gap:6px;flex:none}
.viewer-level{min-width:48px;font:12.5px/1 ${MONO};color:var(--muted);text-align:center}
.viewer-stage{flex:1 1 auto;min-height:0;overflow:auto;background:var(--bg);outline:none}
.viewer-sizer{margin:0 auto;overflow:hidden}
.viewer-content{padding:24px;transform-origin:0 0}
.viewer-content table{background:var(--surface)}
@media (max-width:900px){
.appbar{gap:10px;padding:0 12px}
.nav-toggle{display:inline-flex;align-items:center;flex:none;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:8px;color:var(--ink);font-size:14px;font-weight:600;text-decoration:none}
.brand{flex:0 1 auto}
.brand .slug{display:none}
.bar-tools{flex:1 1 auto;justify-content:flex-end}
.filter{flex:1 1 auto;width:auto;max-width:300px}
.chain{gap:8px}
.chain li+li::before{display:none}
.layout{display:block}
.sidebar{position:fixed;z-index:40;top:56px;bottom:0;left:0;width:min(320px,86vw);height:auto;background:var(--surface);box-shadow:0 12px 32px var(--shadow);transform:translateX(-100%);visibility:hidden;transition:transform .2s,visibility .2s}
.sidebar:target,.sidebar[data-open]{transform:none;visibility:visible}
main{padding:20px 16px 32px}
.doc-head{padding:18px}
h1{font-size:24px}
}
@media (max-width:600px){.brand .name{display:none}}
@media print{
html[data-theme],html:not([data-theme]){${LIGHT}}
html[data-theme] .tag,html:not([data-theme]) .tag{background:var(--tb);color:var(--tf)}
.appbar,.sidebar,.foot,.more,.frame-bar,.anchor,.ref-card,dialog{display:none!important}
body{background:#fff}
.layout{display:block}
main{max-width:none;padding:0}
.view{display:block!important;content-visibility:visible!important}
.view+.view{break-before:page}
.card--long>.clamp{max-height:none;-webkit-mask-image:none;mask-image:none}
details.history::details-content{content-visibility:visible}
.table-wrap{overflow:visible;background-image:none}
.diagram,.card,.doc-card,tr{break-inside:avoid}
}
`.trim();

/**
 * The page's own script, inline in `<head>` so the stored theme applies before the body paints; the rest
 * waits for the document. It only listens through `addEventListener` and puts document text on the page
 * through `textContent` (the ids block) or by moving markup the converter already escaped. Without it every
 * view stays visible, stacked, and the drawer opens through `:target`.
 *
 * `openViewer(title, node, fit)` shows `node` in the one full-size viewer; tables reach it through their
 * "Open full size" button, and a diagram can reach it the same way.
 */
const PAGE_SCRIPT = String.raw`(function () {
'use strict';
var root = document.documentElement;
var THEME_KEY = 'doflow-page-theme';
var THEMES = ['auto', 'light', 'dark'];
var TONES = ${JSON.stringify(TONES)};
var NEUTRAL_TONES = ${NEUTRAL_TONES};
// A page opened from a file may be refused storage; the theme then lasts as long as the page is open.
function storedTheme() { try { var t = localStorage.getItem(THEME_KEY); return THEMES.indexOf(t) > 0 ? t : 'auto'; } catch (e) { return 'auto'; } }
function applyTheme(t) { if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t); }
applyTheme(storedTheme());
root.setAttribute('data-script', '');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

function start() {
  var $$ = function (sel, from) { return Array.prototype.slice.call((from || document).querySelectorAll(sel)); };
  var make = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  var views = $$('section.view[data-view]');
  var sidebar = document.querySelector('.sidebar');
  if (!views.length || !sidebar) return;
  var viewOf = function (node) { return node && node.closest ? node.closest('section.view[data-view]') : null; };
  var current = null;
  var routed = null;

  // A # link on every H2 and H3; its mark comes from CSS, so a heading's text stays its own.
  $$('section.view :is(h2,h3)[id]').forEach(function (h) {
    var a = make('a', 'anchor');
    a.setAttribute('href', '#' + h.id);
    a.setAttribute('aria-label', 'Link to ' + h.textContent.trim());
    h.appendChild(a);
  });

  // Ids: id -> entries in reading order; a link names the entry by its anchor (or the secondary one).
  var ids = {};
  try { var block = document.getElementById('page-ids'); if (block) ids = JSON.parse(block.textContent); } catch (e) { ids = {}; }
  var byAnchor = {};
  var idIndex = [];
  Object.keys(ids).forEach(function (id) {
    ids[id].forEach(function (entry) {
      var hit = { id: id, entry: entry, key: id.toLowerCase(), text: (id + ' ' + entry.doc + ' ' + entry.summary).toLowerCase() };
      byAnchor[entry.anchor] = hit;
      if (!byAnchor[entry.anchor + '-2']) byAnchor[entry.anchor + '-2'] = hit;
      idIndex.push(hit);
    });
  });
  function toneOf(value) {
    var key = value.toLowerCase();
    if (TONES[key]) return TONES[key];
    if (key.indexOf('superseded') === 0) return 'quiet';
    var hash = 0;
    for (var ch of key) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return 'n' + (hash % NEUTRAL_TONES);
  }

  // The sidebar: one entry per view, and per view its sections in reading order, each with its H2 parent.
  var navDocs = {};
  $$('li.nav-doc', sidebar).forEach(function (li) { navDocs[li.getAttribute('data-view')] = li; });
  var spies = {};
  var sections = [];
  views.forEach(function (view) {
    var key = view.getAttribute('data-view');
    var doc = navDocs[key];
    var list = [];
    if (doc) {
      var label = doc.firstElementChild.firstElementChild ? doc.firstElementChild.firstElementChild.textContent : '';
      $$('li.nav-sec', doc).forEach(function (li) {
        var el = document.getElementById(li.getAttribute('data-section'));
        if (!el) return;
        var parent = li.parentElement.closest('li.nav-sec');
        list.push({ el: el, li: li, parent: parent });
        var text = li.firstElementChild.textContent.trim();
        sections.push({ href: '#' + el.id, text: text, doc: label, key: text.toLowerCase() });
      });
    }
    spies[key] = list;
  });

  // Keep el in view inside box without scrolling anything else.
  function keepIn(box, el) {
    var b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < b.top + 8) box.scrollTop += r.top - b.top - 8;
    else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8;
  }

  // One view at a time: the others are hidden until found, so the browser's find still reaches them.
  var marked = [];
  function show(view) {
    if (view === current) return false;
    views.forEach(function (v) { if (v === view) v.removeAttribute('hidden'); else v.setAttribute('hidden', 'until-found'); });
    current = view;
    var key = view.getAttribute('data-view');
    Object.keys(navDocs).forEach(function (k) { navDocs[k].toggleAttribute('data-current', k === key); });
    mark([]);
    checkFrames();
    return true;
  }
  function targetOf(hash) {
    var id = hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* kept as written */ }
    return id ? document.getElementById(id) : null;
  }
  function openDetails(el) {
    for (var d = el.parentElement; d; d = d.parentElement) {
      if (d.tagName !== 'DETAILS' || d.open) continue;
      var summary = d.querySelector(':scope>summary');
      if (!summary || !summary.contains(el)) d.open = true;
    }
  }
  // Show the view the hash points into and scroll to the hash's target; a new view opens without animation.
  var reached = null;
  function route(hash) {
    routed = hash;
    var el = targetOf(hash);
    var view = viewOf(el);
    if (el && !view) { if (!current) show(views[0]); return; }
    var changed = show(view || views[0]);
    var behavior = changed ? 'instant' : 'auto';
    if (!el || el === view) window.scrollTo({ top: 0, behavior: behavior });
    else { openDetails(el); el.scrollIntoView({ block: 'start', behavior: behavior }); }
    // The hash moves without :target (history.pushState), so the reached id is marked here.
    if (reached) reached.removeAttribute('data-hit');
    reached = el && el !== view && !/^H[1-6]$/.test(el.tagName) ? el : null;
    if (reached) reached.setAttribute('data-hit', '');
    spy();
  }
  function go(hash) {
    if (hash !== location.hash) {
      try { history.pushState(null, '', hash); } catch (e) { location.hash = hash; return; }
    }
    route(hash);
  }
  try { history.scrollRestoration = 'manual'; } catch (e) { /* not offered */ }
  window.addEventListener('popstate', function () { if (location.hash !== routed) route(location.hash); });
  window.addEventListener('hashchange', function () { if (location.hash !== routed) route(location.hash); });
  // Find in page reached text in a hidden view: that view becomes the current one.
  document.addEventListener('beforematch', function (e) {
    var view = viewOf(e.target);
    if (!view || !show(view)) return;
    if (viewOf(targetOf(location.hash)) === view) return;
    routed = '#' + view.id;
    try { history.replaceState(null, '', routed); } catch (err) { /* the hash stays */ }
  }, true);

  // The current section: the last heading of the current view scrolled past the app bar.
  var ticking = false;
  function mark(next) {
    if (next.length === marked.length && next.every(function (li, k) { return li === marked[k]; })) return false;
    marked.forEach(function (li) { li.removeAttribute('data-current'); });
    next.forEach(function (li) { li.setAttribute('data-current', ''); });
    marked = next;
    return true;
  }
  function spy() {
    ticking = false;
    if (!current) return;
    var list = spies[current.getAttribute('data-view')] || [];
    var height = window.innerHeight;
    var atEnd = window.scrollY > 0 && height + window.scrollY >= document.documentElement.scrollHeight - 4;
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var rects = list[i].el.getClientRects();
      if (!rects.length) continue;
      var top = rects[0].top;
      if (top <= 100 || (atEnd && top < height)) hit = list[i];
      else if (!atEnd) break;
    }
    var next = hit ? (hit.parent ? [hit.parent, hit.li] : [hit.li]) : [];
    if (mark(next) && hit) keepIn(sidebar, hit.li.firstElementChild);
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });

  // The full-size viewer: one dialog for tables and diagrams.
  var viewer = make('dialog', 'viewer');
  viewer.setAttribute('aria-labelledby', 'viewer-title');
  var vbar = make('div', 'viewer-bar');
  var vtitle = make('h2', 'viewer-title');
  vtitle.id = 'viewer-title';
  var tools = make('div', 'viewer-tools');
  var level = make('output', 'viewer-level', '100%');
  var stage = make('div', 'viewer-stage');
  // The stage takes focus when the viewer opens, so arrow keys pan it.
  stage.tabIndex = 0;
  stage.setAttribute('autofocus', '');
  var sizer = make('div', 'viewer-sizer');
  var content = make('div', 'viewer-content');
  var zoom = 1, natW = 1, natH = 1;
  function tool(label, text, fn) {
    var b = make('button', 'tool-btn', text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  }
  tools.append(tool('Zoom out', '−', function () { zoomTo(zoom / 1.25); }), level,
    tool('Zoom in', '+', function () { zoomTo(zoom * 1.25); }), tool('Fit to window', 'Fit', fit), tool('Close', '×', function () { viewer.close(); }));
  vbar.append(vtitle, tools);
  sizer.appendChild(content);
  stage.appendChild(sizer);
  viewer.append(vbar, stage);
  document.body.appendChild(viewer);
  function applyZoom() {
    content.style.transform = 'scale(' + zoom + ')';
    sizer.style.width = natW * zoom + 'px';
    sizer.style.height = natH * zoom + 'px';
    level.textContent = Math.round(zoom * 100) + '%';
  }
  // Zoom about a point of the stage (its centre by default), so what is under it stays there.
  function zoomTo(z, cx, cy) {
    z = Math.min(8, Math.max(0.1, z));
    if (cx == null) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
    var x = (stage.scrollLeft + cx - sizer.offsetLeft) / zoom, y = (stage.scrollTop + cy - sizer.offsetTop) / zoom;
    zoom = z;
    applyZoom();
    stage.scrollLeft = x * z + sizer.offsetLeft - cx;
    stage.scrollTop = y * z + sizer.offsetTop - cy;
  }
  function fit() {
    zoomTo(Math.min(stage.clientWidth / natW, stage.clientHeight / natH));
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
  stage.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomTo(zoom * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  viewer.addEventListener('click', function (e) { if (e.target === viewer) viewer.close(); });
  // The close event comes a task later: a viewer opened again in between keeps its new content.
  viewer.addEventListener('close', function () { if (!viewer.open) content.textContent = ''; hideCard(); });
  // Show node full size under title: at 100 % unless fitFirst, scrolled to its top left.
  function openViewer(title, node, fitFirst) {
    hideCard();
    vtitle.textContent = title;
    content.textContent = '';
    content.style.transform = '';
    sizer.style.width = '';
    sizer.style.height = '';
    content.appendChild(node);
    if (!viewer.open) viewer.showModal();
    var width = stage.clientWidth;
    content.style.width = width + 'px';
    natW = Math.max(width, Math.ceil(node.getBoundingClientRect().width) + 48);
    content.style.width = natW + 'px';
    natH = Math.max(1, content.offsetHeight);
    zoom = 1;
    applyZoom();
    if (fitFirst) fit();
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
  // The nearest heading before a node in its view, after the view's label: the viewer's title.
  function captionOf(node) {
    var view = viewOf(node);
    var kicker = view && view.querySelector('.kicker');
    var label = kicker ? kicker.textContent.trim() : document.title;
    var name = '';
    if (view) {
      var heads = $$('h1,h2,h3,h4,h5,h6', view);
      for (var i = 0; i < heads.length; i++) {
        if (heads[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) name = heads[i].textContent.trim();
        else break;
      }
    }
    return name && name !== label ? label + ' · ' + name : label;
  }
  // A table frame wider than its column gets a button that opens a copy of the table in the viewer.
  var frameBars = new Map();
  function checkFrames() {
    if (!current) return;
    $$('.table-wrap', current).forEach(function (frame) {
      var wide = frame.scrollWidth > frame.clientWidth + 1;
      var bar = frameBars.get(frame);
      if (wide && !bar) {
        bar = make('div', 'frame-bar');
        bar.appendChild(tool('Open this table full size', 'Open full size', function () {
          var table = frame.querySelector('table').cloneNode(true);
          table.removeAttribute('id');
          $$('[id]', table).forEach(function (n) { n.removeAttribute('id'); });
          openViewer(captionOf(frame), table, false);
        }));
        frame.parentNode.insertBefore(bar, frame);
        frameBars.set(frame, bar);
      }
      if (bar) bar.hidden = !wide;
    });
  }
  document.addEventListener('toggle', function (e) { if (e.target.tagName === 'DETAILS') checkFrames(); }, true);
  // Print shows every History section; the ones the reader had closed close again after.
  var printOpened = [];
  window.addEventListener('beforeprint', function () {
    printOpened = $$('details.history:not([open])');
    printOpened.forEach(function (d) { d.open = true; });
  });
  window.addEventListener('afterprint', function () {
    printOpened.forEach(function (d) { d.open = false; });
    printOpened = [];
  });
  var resizing = false;
  window.addEventListener('resize', function () {
    if (resizing) return;
    resizing = true;
    requestAnimationFrame(function () { resizing = false; checkFrames(); spy(); });
  });
  window.addEventListener('load', checkFrames);

  // The hover card: an id link's id, document, status and summary, kept inside the viewport.
  var card = make('div', 'ref-card');
  card.id = 'ref-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  document.body.appendChild(card);
  var cardFor = null, cardTimer = 0;
  var refOf = function (node) { return node && node.closest ? node.closest('a.ref') : null; };
  function hideCard() {
    clearTimeout(cardTimer);
    card.hidden = true;
    if (cardFor) cardFor.removeAttribute('aria-describedby');
    cardFor = null;
  }
  function showCard(a) {
    var hit = byAnchor[(a.getAttribute('href') || '').slice(1)];
    if (!hit) return;
    card.textContent = '';
    var top = make('p', 'rc-top');
    top.append(make('span', 'rc-id', hit.id), make('span', 'rc-doc', hit.entry.doc));
    if (hit.entry.status) top.appendChild(make('span', 'tag tag--' + toneOf(hit.entry.status), hit.entry.status));
    card.appendChild(top);
    if (hit.entry.summary) card.appendChild(make('p', 'rc-sum', hit.entry.summary));
    // Inside the open viewer the card has to be in the dialog to show above it.
    var host = viewer.open ? viewer : document.body;
    if (card.parentNode !== host) host.appendChild(card);
    card.hidden = false;
    var r = a.getBoundingClientRect();
    var w = card.offsetWidth, h = card.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var left = Math.min(Math.max(8, r.left), vw - w - 8);
    var y = r.bottom + 6 + h > vh - 8 ? r.top - h - 6 : r.bottom + 6;
    card.style.left = Math.max(8, left) + 'px';
    card.style.top = Math.max(8, y) + 'px';
    if (cardFor && cardFor !== a) cardFor.removeAttribute('aria-describedby');
    a.setAttribute('aria-describedby', 'ref-card');
    cardFor = a;
  }
  document.addEventListener('mouseover', function (e) {
    var a = refOf(e.target);
    if (!a || a === cardFor) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(function () { showCard(a); }, 120);
  });
  document.addEventListener('mouseout', function (e) { var a = refOf(e.target); if (a && !a.contains(e.relatedTarget)) hideCard(); });
  document.addEventListener('focusin', function (e) { var a = refOf(e.target); if (a) showCard(a); });
  document.addEventListener('focusout', function (e) { if (refOf(e.target)) hideCard(); });
  document.addEventListener('scroll', function () { if (cardFor) hideCard(); }, { capture: true, passive: true });

  // The drawer below 900 px: the button opens and closes it, and a choice closes it.
  var navToggle = document.querySelector('[data-nav-toggle]');
  function setNav(open) {
    sidebar.toggleAttribute('data-open', open);
    if (navToggle) navToggle.setAttribute('aria-expanded', String(open));
  }
  if (navToggle) navToggle.setAttribute('aria-expanded', 'false');

  // The filter: narrows the sidebar to matching sections and lists matching ids, then sections.
  var filter = document.querySelector('[data-filter]');
  var results = make('ol', 'filter-results');
  results.id = 'filter-results';
  results.hidden = true;
  results.setAttribute('aria-label', 'Matches');
  var picks = [], active = -1;
  var MAX_RESULTS = 40;
  if (filter) {
    filter.parentNode.insertBefore(results, filter.nextSibling);
    filter.setAttribute('aria-controls', 'filter-results');
    filter.removeAttribute('hidden');
  }
  var has = function (text, words) { return words.every(function (w) { return text.indexOf(w) !== -1; }); };
  function narrow(words) {
    sidebar.toggleAttribute('data-filtering', words.length > 0);
    var left = 0;
    Object.keys(navDocs).forEach(function (k) {
      var doc = navDocs[k];
      var any = false;
      // Sections after their H3s, so a section stays when one of its H3s matches.
      $$('li.nav-sec', doc).reverse().forEach(function (li) {
        var hit = !words.length || has(li.firstElementChild.textContent.toLowerCase(), words) || !!li.querySelector('li.nav-sec:not([data-miss])');
        li.toggleAttribute('data-miss', !hit);
        if (hit) any = true;
      });
      if (!doc.toggleAttribute('data-miss', words.length > 0 && !any && !has(doc.firstElementChild.textContent.toLowerCase(), words))) left++;
    });
    // A query that only ids match would empty the sidebar: it stays whole, and the ids are in the list.
    if (words.length && !left) narrow([]);
  }
  function setActive(k) {
    var links = $$('a', results);
    links.forEach(function (a, i) { a.classList.toggle('on', i === k); });
    active = k;
    if (links[k]) keepIn(results, links[k]);
  }
  function update() {
    var query = filter.value.trim().toLowerCase();
    var words = query.split(/\s+/).filter(Boolean);
    narrow(words);
    results.textContent = '';
    picks = [];
    active = -1;
    if (!words.length) { results.hidden = true; return; }
    // Ids first: the id itself, then one starting with the query, then one holding it, then one whose text holds every word.
    var scored = [];
    idIndex.forEach(function (hit) {
      var rank = hit.key === query ? 0 : hit.key.indexOf(query) === 0 ? 1 : hit.key.indexOf(query) !== -1 ? 2 : has(hit.text, words) ? 3 : -1;
      if (rank >= 0) scored.push([rank, scored.length, hit]);
    });
    scored.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var found = scored.map(function (s) { return { href: '#' + s[2].entry.anchor, id: s[2].id, doc: s[2].entry.doc, text: s[2].entry.summary }; });
    sections.forEach(function (s) { if (has(s.key, words)) found.push({ href: s.href, id: '', doc: s.doc, text: s.text }); });
    picks = found.slice(0, MAX_RESULTS);
    picks.forEach(function (p) {
      var li = make('li');
      var a = make('a');
      a.setAttribute('href', p.href);
      if (p.id) a.append(make('span', 'rid', p.id), make('span', 'rdoc', p.doc), make('span', 'rsum', p.text));
      else a.append(make('span', 'rid', '§'), make('span', 'rdoc', p.doc), make('span', 'rsum', p.text));
      li.appendChild(a);
      results.appendChild(li);
    });
    if (found.length > picks.length) results.appendChild(make('li', 'rnote', (found.length - picks.length) + ' more; type more to narrow'));
    if (!found.length) results.appendChild(make('li', 'rnote', 'Nothing matches'));
    results.hidden = false;
  }
  function clearFilter() { if (!filter) return; filter.value = ''; update(); }
  if (filter) {
    filter.addEventListener('input', update);
    filter.addEventListener('focus', function () { if (filter.value.trim()) results.hidden = false; });
    filter.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!picks.length) return;
        e.preventDefault();
        setActive(((active < 0 && e.key === 'ArrowUp' ? 0 : active) + (e.key === 'ArrowDown' ? 1 : -1) + picks.length) % picks.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var p = picks[active < 0 ? 0 : active];
        if (!p) return;
        clearFilter();
        filter.blur();
        setNav(false);
        go(p.href);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (filter.value) clearFilter(); else filter.blur();
      }
    });
  }

  // The theme switch: auto, light, dark, remembered when the page may store it.
  var toggle = document.querySelector('[data-theme-toggle]');
  var GLYPHS = { auto: '◐', light: '☀', dark: '☾' };
  var theme = storedTheme();
  function paintToggle() {
    toggle.textContent = GLYPHS[theme];
    var label = 'Theme: ' + theme + '. Switch theme';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
  if (toggle) {
    paintToggle();
    toggle.removeAttribute('hidden');
    toggle.addEventListener('click', function () {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      applyTheme(theme);
      try { if (theme === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme); } catch (e) { /* this page only */ }
      paintToggle();
    });
  }

  // Links inside the page: shown here rather than by the browser, so a link into another view opens it first.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (filter && !results.hidden && !(t.closest && t.closest('.bar-tools'))) results.hidden = true;
    if (sidebar.hasAttribute('data-open') && !sidebar.contains(t) && !(navToggle && navToggle.contains(t))) setNav(false);
    if (!a) return;
    if (a === navToggle) { e.preventDefault(); setNav(!sidebar.hasAttribute('data-open')); return; }
    var href = a.getAttribute('href');
    if (href.charAt(0) !== '#' || href.length < 2) return;
    e.preventDefault();
    if (viewer.open && viewer.contains(a)) viewer.close();
    if (results.contains(a)) { clearFilter(); filter.blur(); }
    if (sidebar.contains(a)) setNav(false);
    go(href);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && filter && !e.ctrlKey && !e.metaKey && !e.altKey && !viewer.open) {
      var t = e.target;
      if (t && t.closest && t.closest('input,textarea,select,[contenteditable]')) return;
      e.preventDefault();
      filter.focus();
      filter.select();
    } else if (e.key === 'Escape' && sidebar.hasAttribute('data-open')) {
      setNav(false);
    }
  });

  route(location.hash);
}
})();`;

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

/** One `**Label:** value` fact; a header line may carry several, separated by ` · `. */
const FACT = /^\*\*([^*]+?):\*\*\s*(.*)$/;

/** The facts a paragraph states, when every part of it is a `**Label:** value` pair; else null. */
function factsOf(lines: string[]): Array<[string, string]> | null {
  const facts: Array<[string, string]> = [];
  for (const line of lines) {
    for (const piece of line.trim().split(/\s+·\s+/)) {
      const m = FACT.exec(piece.trim());
      if (!m) return null;
      facts.push([m[1].trim(), m[2].trim()]);
    }
  }
  return facts.length ? facts : null;
}

/**
 * A document's opening, read apart from its body: the H1 on its first line, and the paragraph of
 * `**Label:** value` facts right under it. The page shows both in the document's header band, so the
 * body starts after them; a document that opens otherwise keeps all of its text as the body.
 */
function documentHead(text: string): { title: string | null; facts: Array<[string, string]>; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const h1 = i < lines.length ? HEADING.exec(lines[i]) : null;
  if (!h1 || h1[1].length !== 1) return { title: null, facts: [], body: text };
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  let k = j;
  while (k < lines.length && lines[k].trim() !== '' && (k === j || !startsBlock(lines, k))) k++;
  const facts = k > j ? factsOf(lines.slice(j, k)) : null;
  return { title: h1[2], facts: facts || [], body: lines.slice(facts ? k : i + 1).join('\n') };
}

/** What a title says after its kind: `Feature Requirement: Direct discount` → `Direct discount`; null without a `: `. */
function titleRest(title: string | null): string | null {
  if (!title) return null;
  const at = title.indexOf(': ');
  return at === -1 ? null : plainText(title.slice(at + 2)) || null;
}

/** A value as a label, in the tone its word takes or a neutral one by hash. */
function labelHtml(value: string): string {
  const text = plainText(value);
  return `<span class="tag tag--${toneOf(text, true) || 'n0'}">${escapeHtml(text)}</span>`;
}

/** A strip of facts; each value is inline markdown, so its ids link like any other mention. */
function factsHtml(facts: Array<[string, string]>, ctx: any): string {
  if (!facts.length) return '';
  return `<dl class="facts">${facts.map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${inline(value, ctx) || '—'}</dd></div>`).join('')}</dl>\n`;
}

/** A state section that names next steps or the next action, and one that names open or blocked items. */
const NEXT_SECTION = /\bnext\s+(steps?|actions?)\b|^(\d+(\.\d+)*\.?\s+)?next$/i;
const OPEN_STATE_SECTION = /\b(open|blocked)\b/i;
/** A card longer than this, in characters of text or table rows, clamps with a "Show all" control. */
const CLAMP_CHARS = 900;
const CLAMP_ROWS = 6;
/** Reading speed for a document card's reading time, in words a minute. */
const WORDS_PER_MINUTE = 230;

/** One document's blocks grouped by level-2 heading; the first group holds what comes before any. */
function sectionGroups(blocks: string[], sections: Array<{ id: string; text: string }>) {
  const groups: Array<{ id: string | null; text: string; html: string[] }> = [{ id: null, text: '', html: [] }];
  for (const block of blocks) {
    const m = /^<h2 id="([^"]+)">/.exec(block);
    if (m) groups.push({ id: m[1], text: sections.find((s) => escapeHtml(s.id) === m[1])?.text || '', html: [block] });
    else groups[groups.length - 1].html.push(block);
  }
  return groups;
}

/** A state section rendered in place as an overview card; a long one clamps, and `<details>` lifts the clamp without script. */
function stateCard(group: { html: string[] }, kind: string): string {
  const body = group.html.join('\n');
  const rows = (body.match(/<tr>/g) || []).length - 1;
  const long = body.replace(/<[^>]+>/g, '').length > CLAMP_CHARS || rows > CLAMP_ROWS;
  return `<div class="card card--${kind}${long ? ' card--long' : ''}" data-card="${kind}">\n<div class="clamp">\n${body}\n</div>\n`
    + (long ? '<details class="more"><summary><span class="more-show">Show all</span><span class="more-hide">Show less</span></summary></details>\n' : '')
    + '</div>';
}

const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/** A document's card on the overview: label, title, sizes and the ids it defines, per prefix. */
function docCardHtml(view: any, count: any, name: string, slug: string): string {
  const rest = titleRest(view.title) ?? (view.title ? plainText(view.title) : null);
  const title = rest && ![name, slug, view.label].some((same) => same.toLowerCase() === rest.toLowerCase()) ? rest : null;
  const stats = [
    plural(count.h2, 'section'),
    `${plural(count.words, 'word')} · ${Math.max(1, Math.round(count.words / WORDS_PER_MINUTE))} min read`,
    count.tables ? plural(count.tables, 'table') : '',
    count.diagrams ? plural(count.diagrams, 'diagram') : '',
    count.open ? `${count.open.toLocaleString('en-US')} open` : '',
  ].filter(Boolean);
  const ids = Object.entries(count.ids as Record<string, number>).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `<a class="doc-card" href="#doc-${keyId(view.key)}" data-view-link="${keyId(view.key)}">\n`
    + `<span class="top"><span class="kicker">${escapeHtml(view.label)}</span>${view.maturity ? labelHtml(view.maturity) : ''}</span>\n`
    + (title ? `<span class="title">${escapeHtml(title)}</span>\n` : '')
    + `<ul class="stats">${stats.map((stat) => `<li>${escapeHtml(stat)}</li>`).join('')}</ul>\n`
    + (ids.length ? `<ul class="id-counts" aria-label="Ids defined">${ids.map(([prefix, n]) => `<li>${escapeHtml(prefix)} <b>${n}</b></li>`).join('')}</ul>\n` : '')
    + '</a>';
}

/** A sidebar section link, with its H3 links nested; the next task shows the nested list for the current section. */
function navSection(view: string, section: { id: string; text: string }, subs: Array<{ id: string; text: string }>): string {
  const id = escapeHtml(section.id);
  return `<li class="nav-sec" data-section="${id}"><a href="#${id}" data-section-link="${id}" data-view="${view}">${mutedNumber(escapeHtml(section.text))}</a>`
    + (subs.length ? `<ol class="nav-sub">${subs.map((sub) => navSection(view, sub, [])).join('')}</ol>` : '')
    + '</li>';
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

  const documents: any[] = [];
  const counts: any[] = [];
  const views: any[] = [];
  // Every id a document defines is known before any mention is linked: collect over all documents first.
  const registry = new Map<string, any[]>();
  try {
    for (const doc of found) {
      const before = diagrams.blocks;
      const text = stripComments(fs.readFileSync(path.join(root, doc.rel), 'utf8'));
      const head = documentHead(text);
      const docCtx = {
        key: doc.key, label: doc.label, mode: resolved, diagrams, render: render || renderer?.render,
        docs, dir: path.dirname(path.resolve(root, doc.rel)), outDir: path.dirname(target), root, images, registry,
      };
      const titleSlug = head.title ? slugify(head.title) || 'section' : '';
      const collected = documentParts(head.body, { ...docCtx, slugs: new Map(titleSlug ? [[titleSlug, 1]] : []) });
      const maturity = head.facts.find(([label]) => /^maturity$/i.test(label));
      const shown = featureDir && doc.rel.startsWith(`${featureDir}/`) ? doc.rel.slice(featureDir.length + 1) : doc.rel;
      const band = `<header class="doc-head">\n<p class="kicker">${escapeHtml(doc.label)}</p>\n`
        + (head.title ? `<h1 id="${escapeHtml(`${keyId(doc.key)}-${titleSlug}`)}">${inline(head.title, docCtx, false)}</h1>\n` : '')
        + factsHtml(head.facts.filter((fact) => fact !== maturity), docCtx)
        + `<p class="doc-meta">${maturity ? labelHtml(maturity[1]) : ''}<code class="path">${escapeHtml(shown)}</code></p>\n</header>\n`;
      views.push({
        key: doc.key, label: doc.label, title: head.title, maturity: maturity ? maturity[1] : null, collected,
        facts: factsHtml(head.facts, docCtx),
        html: `<section class="view doc" id="doc-${keyId(doc.key)}" data-view="${keyId(doc.key)}">\n${band}${collected.html}\n</section>\n`,
      });
      documents.push({ key: doc.key, path: doc.rel, diagrams: diagrams.blocks - before });
      counts.push({
        key: doc.key, label: doc.label, h2: collected.sections.length, words: countWords(text.split('\n')), tables: collected.tables,
        diagrams: diagrams.blocks - before, ids: {}, open: collected.open,
      });
    }
  } finally {
    renderer?.dispose();
  }
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
  const byKey = new Map(views.map((view) => [view.key, view]));
  // The feature's name: what the first of these titles says after its kind, else the slug.
  const name = ['requirement', 'design', 'plan', 'state'].map((key) => titleRest(byKey.get(key)?.title ?? null)).find(Boolean) || slug;
  const state = byKey.get('state');
  const chain = views.filter((view) => view !== state);

  // The overview: name and stage facts, the chain, the state's Next and Open sections as cards, one card
  // per document, then the rest of the state document in its own order. The state is not a view of its own.
  const groups = state ? sectionGroups(state.collected.blocks, state.collected.sections) : [];
  const next = groups.find((g) => g.id && NEXT_SECTION.test(g.text));
  const open = groups.find((g) => g.id && g !== next && OPEN_STATE_SECTION.test(g.text));
  const rest = groups.filter((g) => g !== next && g !== open);
  const stageFacts = state ? state.facts : byKey.get('requirement')?.facts || '';
  const overview = '<section class="view overview" id="overview" data-view="overview">\n<header class="ov-head">\n<p class="kicker">Feature overview</p>\n'
    + `<h1 id="overview-name">${escapeHtml(name)}</h1>\n<p class="ov-slug"><code>${escapeHtml(slug)}</code></p>\n${stageFacts}</header>\n`
    + `<ol class="chain" aria-label="Documents in chain order">${chain.map((view) => `<li><a href="#doc-${keyId(view.key)}" data-view-link="${keyId(view.key)}">`
      + `${escapeHtml(view.label)}${view.maturity ? labelHtml(view.maturity) : ''}</a></li>`).join('')}</ol>\n`
    + (next || open ? `<div class="ov-cards">\n${[next && stateCard(next, 'next'), open && stateCard(open, 'open')].filter(Boolean).join('\n')}\n</div>\n` : '')
    + `<h2 class="ov-title" id="overview-documents">Documents</h2>\n<div class="doc-cards">\n`
    + `${chain.map((view) => docCardHtml(view, counts.find((c) => c.key === view.key), name, slug)).join('\n')}\n</div>\n`
    + (rest.some((g) => g.html.length) ? `<div class="state-rest">\n${rest.map((g) => g.html.join('\n')).join('\n')}\n</div>\n` : '')
    + '</section>\n';
  const viewsHtml = resolveRefs(overview, 'state', registry)
    + chain.map((view) => resolveRefs(view.html, view.key, registry)).join('');

  // The sidebar: the overview and its sections, then each document with its level-2 sections and their level-3 ones.
  const overviewSections = [next, open, { id: 'overview-documents', text: 'Documents' }, ...rest.filter((g) => g.id)].filter(Boolean) as any[];
  const navDoc = (view: string, href: string, label: string, maturity: string | null, sections: any[], subs: any[]) =>
    `<li class="nav-doc" data-view="${view}"><a href="${href}" data-view-link="${view}"><span>${escapeHtml(label)}</span>${maturity ? labelHtml(maturity) : ''}</a>`
    + (sections.length ? `<ol class="nav-secs">${sections.map((s) => navSection(view, s, subs.filter((sub) => sub.parent === s.id))).join('')}</ol>` : '')
    + '</li>\n';
  const contents = navDoc('overview', '#overview', 'Overview', null, overviewSections, [])
    + chain.map((view) => navDoc(keyId(view.key), `#doc-${keyId(view.key)}`, view.label, view.maturity, view.collected.sections, view.collected.subsections)).join('');

  const generated = escapeHtml(now.toISOString().slice(0, 16).replace('T', ' '));
  const page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="doflow render-page">\n'
    + `<title>${escapeHtml(name)}</title>\n<style>\n${STYLE}\n</style>\n<script>\n${PAGE_SCRIPT}\n</script>\n</head>\n<body>\n`
    + '<header class="appbar">\n<a class="nav-toggle" href="#sidebar" aria-controls="sidebar" data-nav-toggle>Contents</a>\n'
    + `<a class="brand" href="#overview" data-view-link="overview" aria-label="${escapeHtml(name)}"><span class="mark" aria-hidden="true"></span><span class="name">${escapeHtml(name)}</span>`
    + `${name === slug ? '' : `<code class="slug">${escapeHtml(slug)}</code>`}</a>\n`
    + '<div class="bar-tools">\n<input class="filter" type="search" placeholder="Filter sections and ids" aria-label="Filter sections and ids" autocomplete="off" data-filter hidden>\n'
    + '<button class="theme" type="button" aria-label="Switch theme" title="Switch theme" data-theme-toggle hidden>◐</button>\n</div>\n</header>\n'
    + `<div class="layout">\n<nav class="sidebar" id="sidebar" aria-label="Contents">\n<ol>\n${contents}</ol>\n</nav>\n`
    + `<main id="main">\n${viewsHtml}<footer class="foot">Generated ${generated} UTC${featureDir ? ` from <code>${escapeHtml(featureDir)}</code>` : ''}</footer>\n</main>\n</div>\n`
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
