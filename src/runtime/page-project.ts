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

function escapeHtml(text: any): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
}

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
      if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2]) fence = null; out.push(line); continue; }
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

/** Inline markdown in one run of text: code spans, links, bold, italic, strike and `<br>`. */
function inline(text: string, ctx: any): string {
  // A code span and a link's tags are set aside as numbered marks while the rest is formatted, so bold
  // may wrap a code span and no later pattern can rewrite what is inside a tag.
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  const spans = text.replace(/\u0000/g, '')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_all: string, _ticks: string, body: string) => hold(`<code>${escapeHtml(body.trim())}</code>`));
  let html = escapeHtml(spans);
  html = html.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all: string, label: string, url: string) => {
    // The URL was escaped with the rest of the text; undo that to judge it, and escape it again to write it.
    const raw = url.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const href = resolveHref(raw, ctx);
    return href === null ? label : `${hold(`<a href="${escapeHtml(href)}">`)}${label}${hold('</a>')}`;
  });
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
        if (j < lines.length && indentOf(lines[j]) > base) { body.push(''); i++; continue; }
        break;
      }
      if (indentOf(line) > base) { body.push(line); i++; continue; }
      if (startsBlock(lines, i)) break;
      body.push(line); i++;
    }
    const rest = body.slice(1);
    const depths = rest.filter((l) => l.trim() !== '').map(indentOf);
    const cut = depths.length ? Math.min(...depths) : 0;
    let first = body[0];
    let box = '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
    if (task) {
      box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      first = task[2];
    }
    const blocks = blocksHtml([first, ...rest.map((l) => l.slice(Math.min(cut, indentOf(l))))], ctx, depth + 1);
    // A one-paragraph item reads as a line, not as a paragraph inside a bullet.
    if (blocks.length > 0 && blocks[0].startsWith('<p>')) blocks[0] = blocks[0].slice(3, -4);
    items.push(`<li${task ? ' class="task"' : ''}>${box}${blocks.join('\n')}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const first = ordered ? parseInt(lines[start].trim(), 10) : 1;
  return { html: `<${tag}${first > 1 ? ` start="${first}"` : ''}>\n${items.join('\n')}\n</${tag}>`, next: i };
}

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
        const close = FENCE.exec(lines[i]);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2]) break;
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
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(heading[2], ctx)}</h${level}>`);
      i++;
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
      const cells = (row: string[], tag: string) => head.map((_h, c) => `<${tag}>${inline(row[c] ?? '', ctx)}</${tag}>`).join('');
      out.push('<div class="table-wrap"><table>\n'
        + `<thead><tr>${cells(head, 'th')}</tr></thead>\n`
        + `<tbody>\n${rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('\n')}\n</tbody>\n</table></div>`);
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
  const state = { ...ctx, slugs: new Map(), sections: [], diagramIndex: 0 };
  const html = blocksHtml(stripComments(text).split('\n'), state).join('\n');
  return { html, sections: state.sections };
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
.diagram{margin:0 0 18px;padding:16px;background:var(--figure);border:1px solid var(--line);border-radius:8px;text-align:center;overflow-x:auto}
.diagram img{max-width:100%;height:auto}
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
  const docs = new Map(found.map((doc) => [path.resolve(root, doc.rel), doc.key]));
  const featureDir = typeof paths.feature_dir === 'string' ? paths.feature_dir : '';
  const target = path.resolve(out || path.join(root, featureDir, 'page.html'));

  let sectionsHtml = '';
  let contents = '';
  const documents: any[] = [];
  try {
    for (const doc of found) {
      const before = diagrams.blocks;
      const text = fs.readFileSync(path.join(root, doc.rel), 'utf8');
      const { html, sections } = documentHtml(text, {
        key: doc.key, label: doc.label, mode: resolved, diagrams, render: render || renderer?.render,
        docs, dir: path.dirname(path.resolve(root, doc.rel)), outDir: path.dirname(target),
      });
      const shown = featureDir && doc.rel.startsWith(`${featureDir}/`) ? doc.rel.slice(featureDir.length + 1) : doc.rel;
      sectionsHtml += `<section class="doc" id="doc-${keyId(doc.key)}">\n`
        + `<p class="doc-label">${escapeHtml(doc.label)}<span class="path">${escapeHtml(shown)}</span></p>\n${html}\n</section>\n`;
      contents += `<li><a href="#doc-${keyId(doc.key)}">${escapeHtml(doc.label)}</a>`
        + (sections.length ? `<ol>${sections.map((s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.text)}</a></li>`).join('')}</ol>` : '')
        + '</li>\n';
      documents.push({ key: doc.key, path: doc.rel, diagrams: diagrams.blocks - before });
    }
  } finally {
    renderer?.dispose();
  }

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
    + (resolved === 'cdn' && diagrams.blocks > 0 ? `${mermaidScript(themeFile)}\n` : '')
    + '</body>\n</html>\n';

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, page);
  try { fs.renameSync(tmp, target); }
  catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  return { ok: diagrams.failures === 0, written: true, file: target, documents, diagrams, ...(notes.length ? { note: notes.join('; ') } : {}) };
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
