'use strict';

// G49 — the published docs site stays true to the code it describes.
//
// The site is built from mkdocs.yml and docs/. Four structural truths keep it from going stale:
//   (a) every nav page exists and is listed in docs/llms.txt, and every llms.txt link is a nav page;
//   (b) docs/quickstart.md and docs/setup.md state the Node range package.json declares;
//   (c) no page claims a Node floor of 18 or 20 outside a sentence that says the floor was raised;
//   (d) when a page holds a ```mermaid fence, mkdocs.yml declares the mermaid custom fence and loads
//       a mermaid script, otherwise the fence ships as plain code (the fault this guard exists for).
// Each check is a function of a root directory, so a negative control re-seeds the fault in a copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function markdownPages(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'docs'));
  return out.sort();
}

/** The `Title: page.md` entries under `nav:`, as page paths relative to docs/. */
function navPages(mkdocs) {
  const lines = mkdocs.split('\n');
  const start = lines.findIndex((line) => /^nav:\s*$/.test(line));
  const pages = [];
  if (start < 0) return pages;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s*-\s+[^:]+:\s*(\S+\.md)\s*$/);
    if (match) pages.push(match[1]);
  }
  return pages;
}

function siteUrl(mkdocs) {
  const match = mkdocs.match(/^site_url:\s*(\S+)\s*$/m);
  return match ? match[1].replace(/\/+$/, '') : '';
}

/** Maps a published URL back to the docs page that produces it (directory URLs, like mkdocs). */
function urlToPage(url, base) {
  if (url !== base && !url.startsWith(`${base}/`)) return null;
  const rest = url.slice(base.length).replace(/^\/+|\/+$/g, '');
  return rest === '' ? 'index.md' : `${rest}.md`;
}

function checkNavAndLlms(root) {
  const problems = [];
  const mkdocs = read(root, 'mkdocs.yml');
  const nav = navPages(mkdocs);
  const base = siteUrl(mkdocs);
  if (nav.length === 0) problems.push('mkdocs.yml has no nav pages');
  if (!base) problems.push('mkdocs.yml has no site_url');
  for (const page of nav) {
    if (!fs.existsSync(path.join(root, 'docs', page))) problems.push(`nav page missing on disk: docs/${page}`);
  }
  if (!fs.existsSync(path.join(root, 'docs', 'llms.txt'))) {
    problems.push('docs/llms.txt is missing');
    return problems;
  }
  const llms = read(root, 'docs/llms.txt');
  if (!/^# \S/.test(llms)) problems.push('docs/llms.txt does not open with an H1 title');
  if (!/^> \S/m.test(llms)) problems.push('docs/llms.txt has no blockquote summary');
  const listed = new Set();
  for (const match of llms.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
    const page = urlToPage(match[1], base);
    if (page === null) problems.push(`llms.txt link is outside site_url: ${match[1]}`);
    else if (!nav.includes(page)) problems.push(`llms.txt link is not a nav page: ${match[1]} (${page})`);
    else listed.add(page);
  }
  for (const page of nav) {
    if (!listed.has(page)) problems.push(`nav page not listed in llms.txt: ${page}`);
  }
  return problems;
}

/** `^22.18.0 || >=24.3.0` with whitespace and the table-cell backslash before `|` removed. */
function normalizeRange(text) {
  return text.replace(/\\/g, '').replace(/\s+/g, '');
}

const RANGE_PATTERN = /\^\d+\.\d+\.\d+\s*\\?\|\\?\|\s*>=\d+\.\d+\.\d+/;

function checkNodeFloor(root) {
  const problems = [];
  const declared = JSON.parse(read(root, 'package.json')).engines?.node;
  if (typeof declared !== 'string') return ['package.json declares no engines.node'];
  for (const page of ['docs/quickstart.md', 'docs/setup.md']) {
    const match = read(root, page).match(RANGE_PATTERN);
    if (!match) problems.push(`${page} does not state a Node range like "${declared}"`);
    else if (normalizeRange(match[0]) !== normalizeRange(declared)) {
      problems.push(`${page} states Node "${match[0]}" but package.json engines.node is "${declared}"`);
    }
  }
  return problems;
}

// A claim of an 18 or 20 floor: "Node 18", "Node.js 20+", "node >=18", "Node v20", "requires 18+".
const STALE_FLOOR = /\b(?:node(?:\.js)?\s*(?:>=|≥|v|version\s+)?\s*(?:18|20)\b(?!\.\d)|(?:>=|≥)\s*(?:18|20)\b(?!\.\d)|(?:18|20)\+)/i;
// A sentence that says the floor moved is history, not a claim.
const FLOOR_HISTORY = /no longer|not supported|unsupported|dropped|removed|previously|used to|formerly|was raised|raised from/i;

function checkStaleNodeFloor(root) {
  const problems = [];
  for (const page of markdownPages(root)) {
    read(root, page).split('\n').forEach((line, index) => {
      if (STALE_FLOOR.test(line) && !FLOOR_HISTORY.test(line)) {
        problems.push(`${page}:${index + 1} claims a Node 18 or 20 floor`);
      }
    });
  }
  return problems;
}

function checkMermaid(root) {
  const holders = markdownPages(root).filter((page) => /^```mermaid\b/m.test(read(root, page)));
  if (holders.length === 0) return [];
  const problems = [];
  const mkdocs = read(root, 'mkdocs.yml');
  if (!/custom_fences:[\s\S]*?-\s*name:\s*mermaid\b[\s\S]*?format:\s*!!python\/name:pymdownx\.superfences\.fence_(?:div|code)_format/.test(mkdocs)) {
    problems.push(`mkdocs.yml has no mermaid custom fence, but ${holders.join(', ')} hold mermaid fences`);
  }
  const scripts = mkdocs.match(/^extra_javascript:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
  const entries = scripts ? [...scripts[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]) : [];
  if (!entries.some((entry) => /mermaid/i.test(entry))) {
    problems.push('mkdocs.yml extra_javascript loads no mermaid script');
  }
  for (const entry of entries) {
    if (!/^https?:\/\//.test(entry) && !fs.existsSync(path.join(root, 'docs', entry))) {
      problems.push(`extra_javascript file missing on disk: docs/${entry}`);
    }
  }
  return problems;
}

/** The files the checks read, copied into a throwaway root so a fault can be seeded safely. */
function copySite(t) {
  const root = tempDir(t, 'doflow-g49-');
  for (const rel of ['mkdocs.yml', 'package.json']) fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  fs.cpSync(path.join(REPO, 'docs'), path.join(root, 'docs'), { recursive: true });
  return root;
}

function edit(root, rel, fn) {
  fs.writeFileSync(path.join(root, rel), fn(read(root, rel)));
}

test('G49.a: every nav page exists and is listed in docs/llms.txt, and every llms.txt link is a nav page', () => {
  assert.deepEqual(checkNavAndLlms(REPO), []);
});

test('G49.a negative control: an unlisted nav page, a stray link and a missing file are each reported', (t) => {
  const unlisted = copySite(t);
  edit(unlisted, 'docs/llms.txt', (s) => s.replace(/^- \[Quickstart\].*\n/m, ''));
  assert.ok(checkNavAndLlms(unlisted).some((p) => /not listed in llms\.txt: quickstart\.md/.test(p)));

  const stray = copySite(t);
  edit(stray, 'docs/llms.txt', (s) => `${s}\n- [Ghost](${siteUrl(read(stray, 'mkdocs.yml'))}/ghost/): not a page.\n`);
  assert.ok(checkNavAndLlms(stray).some((p) => /not a nav page/.test(p)));

  const missing = copySite(t);
  fs.rmSync(path.join(missing, 'docs', 'flags.md'));
  assert.ok(checkNavAndLlms(missing).some((p) => /nav page missing on disk: docs\/flags\.md/.test(p)));

  const noFile = copySite(t);
  fs.rmSync(path.join(noFile, 'docs', 'llms.txt'));
  assert.ok(checkNavAndLlms(noFile).some((p) => /llms\.txt is missing/.test(p)));
});

test('G49.b: quickstart.md and setup.md state the Node range package.json declares', () => {
  assert.deepEqual(checkNodeFloor(REPO), []);
});

test('G49.b negative control: a changed range, or a page with none, is reported', (t) => {
  const changed = copySite(t);
  edit(changed, 'docs/quickstart.md', (s) => s.replace('>=24.3.0', '>=24.0.0'));
  assert.ok(checkNodeFloor(changed).some((p) => /quickstart\.md states Node/.test(p)));

  const drifted = copySite(t);
  edit(drifted, 'package.json', (s) => s.replace('^22.18.0', '^22.19.0'));
  const problems = checkNodeFloor(drifted);
  assert.ok(problems.some((p) => /quickstart\.md/.test(p)) && problems.some((p) => /setup\.md/.test(p)));

  const none = copySite(t);
  edit(none, 'docs/setup.md', (s) => s.split('^22.18.0').join('22.18'));
  assert.ok(checkNodeFloor(none).some((p) => /setup\.md does not state a Node range/.test(p)));
});

test('G49.c: no page claims a Node 18 or 20 floor', () => {
  assert.deepEqual(checkStaleNodeFloor(REPO), []);
});

test('G49.c negative control: re-seeded 18 and 20 floor claims are reported, a history sentence is not', (t) => {
  const seeded = copySite(t);
  edit(seeded, 'docs/quickstart.md', (s) => `${s}\nDoFlow requires Node.js 18 or newer.\n`);
  edit(seeded, 'docs/overview.md', (s) => `${s}\nSupported: node >=20.\n`);
  const problems = checkStaleNodeFloor(seeded);
  assert.ok(problems.some((p) => /^docs\/quickstart\.md:\d+ /.test(p)));
  assert.ok(problems.some((p) => /^docs\/overview\.md:\d+ /.test(p)));

  const history = copySite(t);
  edit(history, 'docs/quickstart.md', (s) => `${s}\nNode 18 and 20 are no longer supported.\n`);
  assert.deepEqual(checkStaleNodeFloor(history), []);
});

test('G49.d: mkdocs.yml declares the mermaid custom fence and a mermaid script when docs hold mermaid fences', () => {
  assert.ok(markdownPages(REPO).some((page) => /^```mermaid\b/m.test(read(REPO, page))), 'expected mermaid fences in docs/');
  assert.deepEqual(checkMermaid(REPO), []);
});

test('G49.d negative control: dropping the fence, the script or the local script file is reported', (t) => {
  const noFence = copySite(t);
  edit(noFence, 'mkdocs.yml', (s) => s.replace(/^markdown_extensions:[\s\S]*?(?=^extra_javascript:)/m, ''));
  assert.ok(checkMermaid(noFence).some((p) => /no mermaid custom fence/.test(p)));

  const noScript = copySite(t);
  edit(noScript, 'mkdocs.yml', (s) => s.replace(/^extra_javascript:[\s\S]*?(?=^nav:)/m, ''));
  assert.ok(checkMermaid(noScript).some((p) => /loads no mermaid script/.test(p)));

  const noFile = copySite(t);
  fs.rmSync(path.join(noFile, 'docs', 'javascripts', 'mermaid-init.js'));
  assert.ok(checkMermaid(noFile).some((p) => /extra_javascript file missing/.test(p)));

  const noFences = copySite(t);
  for (const page of markdownPages(noFences)) edit(noFences, page, (s) => s.replace(/^```mermaid/gm, '```text'));
  edit(noFences, 'mkdocs.yml', (s) => s.replace(/^markdown_extensions:[\s\S]*?(?=^nav:)/m, ''));
  assert.deepEqual(checkMermaid(noFences), [], 'with no mermaid fence in docs/, no declaration is required');
});
