'use strict';

// Client DOM safety (feature 093, IC-007, IC-006; plan task D.2). `scanSource` is a pure function over one
// file's name and text; `scanDir` applies it to every .js, .html and .css file under a web root. Each rule
// has a mutated-fixture control: a planted line turns exactly that rule red, and a planted file in a copy
// of the shipped web root turns the whole scan red.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WEB_ROOT = path.join(__dirname, '..', 'web');

/** The SVG namespace identifier createElementNS needs. It names no network address and is the one URL allowed. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type Rule = { id: string, test: RegExp };

// IC-007's list, for .js files.
const JS_RULES: Rule[] = [
  { id: 'innerHTML', test: /innerHTML/ },
  { id: 'outerHTML', test: /outerHTML/ },
  { id: 'insertAdjacentHTML', test: /insertAdjacentHTML/ },
  { id: 'document.write', test: /document\s*\.\s*write/ },
  { id: 'setAttribute-style', test: /setAttribute\(\s*['"`]style['"`]/ },
  { id: 'style.cssText', test: /\.style\.cssText/ },
  { id: 'eval', test: /\beval\s*\(/ },
  { id: 'new Function', test: /new\s+Function\b/ },
  { id: 'javascript:', test: /javascript:/i },
  // Allowed dynamic styling is style.setProperty('--name', value) only.
  { id: 'style-other', test: /\.style\s*(?:\.(?!setProperty\b)|\[)/ },
  { id: 'setProperty-not-custom', test: /\.style\.setProperty\(\s*['"`](?!--)/ },
];

// IC-007 and IC-006's list, for .html files.
const HTML_RULES: Rule[] = [
  { id: 'on*=', test: /\bon[a-z]+\s*=/i },
  { id: '<style', test: /<style\b/i },
  { id: 'style=', test: /\bstyle\s*=/i },
  { id: 'javascript:', test: /javascript:/i },
  { id: 'inline-script', test: /<script\b(?![^>]*\bsrc\s*=)/i },
];

// IC-006: no external origin anywhere, in any file type the page loads.
const URL_RULE: Rule = { id: 'http-url', test: /\bhttps?:/i };
const CSS_RULES: Rule[] = [
  { id: '@import', test: /@import/i },
  // design note section 1: every colour in app.css is a token.
  { id: 'literal-colour', test: /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/ },
];

function rulesFor(file: string): Rule[] {
  const ext = path.extname(file);
  const base = ext === '.js' ? JS_RULES : ext === '.html' ? HTML_RULES : ext === '.css' && path.basename(file) !== 'tokens.css' ? CSS_RULES : [];
  return [...base, URL_RULE];
}

/** Violations in one file as `<file>:<line>: <rule id>`. */
function scanSource(file: string, text: string): string[] {
  const found: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const cleaned = line.split(SVG_NAMESPACE).join('');
    for (const rule of rulesFor(file)) {
      if (rule.test.test(cleaned)) found.push(`${path.basename(file)}:${index + 1}: ${rule.id}`);
    }
  });
  return found;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

function scanDir(root: string): string[] {
  return files(root)
    .filter((file) => ['.js', '.html', '.css'].includes(path.extname(file)))
    .flatMap((file) => scanSource(path.relative(root, file), fs.readFileSync(file, 'utf8')));
}

// ---- the shipped web root -----------------------------------------------------------------------

test('the shipped web root has the shell files and no unsafe line', () => {
  for (const name of ['index.html', 'tokens.css', 'app.css', 'app.js', 'dom.js', 'poll.js', 'states.js', 'views.js']) {
    assert.ok(fs.existsSync(path.join(WEB_ROOT, name)), `${name} exists`);
  }
  assert.deepEqual(scanDir(WEB_ROOT), []);
});

test('index.html loads tokens.css, then app.css, then app.js as a module, and nothing else', () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(stylesheets, ['tokens.css', 'app.css']);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /\btype="module"/);
  assert.match(scripts[0], /\bsrc="app\.js"/);
  assert.ok(html.indexOf('tokens.css') < html.indexOf('app.css'));
  const external = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]).filter((url) => /^(?:[a-z]+:)?\/\//i.test(url));
  assert.deepEqual(external, []);
});

/** Problems with the module imports of one file: not a relative .js path, leaving the web root, or naming no file. */
function importProblems(root: string, file: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
    const target = match[1];
    const resolved = path.resolve(path.dirname(file), target);
    if (!/^\.{1,2}\/(?:[a-z-]+\/)*[a-z-]+\.js$/.test(target)) problems.push(`${path.relative(root, file)} imports ${target}: not a relative .js path`);
    else if (path.relative(root, resolved).startsWith('..')) problems.push(`${path.relative(root, file)} imports ${target}: leaves the web root`);
    else if (!fs.existsSync(resolved)) problems.push(`${path.relative(root, file)} imports ${target}: no such file`);
  }
  return problems;
}

test('every module the page loads is a file of the web root (no import leaves it)', () => {
  const modules = files(WEB_ROOT).filter((entry) => entry.endsWith('.js'));
  for (const name of ['derive/rail.js', 'views/rail.js', 'views/home.js']) assert.ok(modules.includes(path.join(WEB_ROOT, name)), `${name} is a module of the web root`);
  assert.deepEqual(modules.flatMap((file) => importProblems(WEB_ROOT, file, fs.readFileSync(file, 'utf8'))), []);
});

test('control: an import that leaves the web root, names no file or is not relative .js is reported', () => {
  const file = path.join(WEB_ROOT, 'views', 'x.js');
  assert.deepEqual(importProblems(WEB_ROOT, file, "import { a } from '../dom.js';\nimport { b } from './rail.js';"), []);
  assert.equal(importProblems(WEB_ROOT, file, "import a from '../../src/x.js';").length, 1);
  assert.equal(importProblems(WEB_ROOT, file, "import a from '../missing.js';").length, 1);
  assert.equal(importProblems(WEB_ROOT, file, "import a from 'node:fs';").length, 1);
  assert.equal(importProblems(WEB_ROOT, file, "import a from 'https://x.invalid/a.js';").length, 1);
});

// ---- controls -----------------------------------------------------------------------------------

const tmp: string[] = [];
after(() => { for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true }); });

const PLANTED: Array<[string, string, string]> = [
  ['innerHTML', 'x.js', 'el.innerHTML = value;'],
  ['outerHTML', 'x.js', 'el.outerHTML = value;'],
  ['insertAdjacentHTML', 'x.js', "el.insertAdjacentHTML('beforeend', value);"],
  ['document.write', 'x.js', 'document.write(value);'],
  ['setAttribute-style', 'x.js', "el.setAttribute('style', 'color: red');"],
  ['setAttribute-style', 'x.js', 'el.setAttribute("style", value);'],
  ['style.cssText', 'x.js', 'el.style.cssText = value;'],
  ['eval', 'x.js', 'eval(value);'],
  ['new Function', 'x.js', "const f = new Function('return 1');"],
  ['javascript:', 'x.js', "link.href = 'javascript:alert(1)';"],
  ['http-url', 'x.js', "fetch('https://example.invalid/x');"],
  ['style-other', 'x.js', "el.style.display = 'none';"],
  ['setProperty-not-custom', 'x.js', "el.style.setProperty('color', 'red');"],
  ['on*=', 'x.html', '<button onclick="go()">go</button>'],
  ['<style', 'x.html', '<style>body { color: red }</style>'],
  ['style=', 'x.html', '<div style="color: red">x</div>'],
  ['javascript:', 'x.html', '<a href="javascript:alert(1)">x</a>'],
  ['inline-script', 'x.html', '<script>alert(1)</script>'],
  ['http-url', 'x.html', '<img src="http://example.invalid/a.png">'],
  ['http-url', 'x.css', '.a { background: url(https://example.invalid/a.png); }'],
  ['@import', 'x.css', '@import "other.css";'],
  ['literal-colour', 'x.css', '.a { color: #fff; }'],
  ['literal-colour', 'x.css', '.a { color: rgb(0 0 0); }'],
];

for (const [rule, file, line] of PLANTED) {
  test(`control: ${JSON.stringify(line)} turns the ${rule} rule red in ${file}`, () => {
    const found = scanSource(file, `// fixture\n${line}\n`);
    assert.ok(found.some((entry) => entry.endsWith(`: ${rule}`)), `${rule} not reported: ${JSON.stringify(found)}`);
  });
}

test('controls: what the contract allows stays green', () => {
  assert.deepEqual(scanSource('x.js', "el.style.setProperty('--x', value);\nconst ns = '" + SVG_NAMESPACE + "';"), []);
  assert.deepEqual(scanSource('x.js', "el.textContent = value; const a = ['mailto-free'];"), []);
  assert.deepEqual(scanSource('x.html', '<script type="module" src="app.js"></script>'), []);
  assert.deepEqual(scanSource('tokens.css', ':root { --a: #fff; }'), []);
  assert.deepEqual(scanSource('x.css', '.a { color: var(--text); background: transparent; border-color: currentColor; }'), []);
});

test('control: an innerHTML line in a file added to a copy of the shipped web root turns the scan red', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  assert.deepEqual(scanDir(copy), [], 'the copy starts clean');
  fs.writeFileSync(path.join(copy, 'fixture.js'), 'export function bad(el, value) {\n  el.innerHTML = value;\n}\n');
  assert.deepEqual(scanDir(copy), ['fixture.js:2: innerHTML']);
});

// ---- app.css cascade (design note D.2, review findings F1, F3, F4, F5) -------------------------------

type CssRule = { selector: string, layer: number, media: { min: number, max: number } | null, order: number, decls: Map<string, string> };

/** Style rules of a stylesheet with their cascade layer (declaration order), width media condition and source order. */
function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const layers: string[] = [];
  const rules: CssRule[] = [];
  let order = 0;
  const walk = (source: string, layer: string | null, media: CssRule['media']) => {
    let index = 0;
    while (index < source.length) {
      const next = /[{;]/.exec(source.slice(index));
      if (!next) break;
      const at = index + next.index;
      const prelude = source.slice(index, at).trim();
      if (next[0] === ';') {
        const names = /^@layer\s+([^;]+)$/.exec(prelude);
        if (names) for (const name of names[1].split(',')) if (!layers.includes(name.trim())) layers.push(name.trim());
        index = at + 1;
        continue;
      }
      let depth = 1;
      let close = at + 1;
      while (close < source.length && depth > 0) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}') depth -= 1;
        close += 1;
      }
      const body = source.slice(at + 1, close - 1);
      if (prelude.startsWith('@layer')) {
        const name = prelude.slice(6).trim();
        if (!layers.includes(name)) layers.push(name);
        walk(body, name, media);
      } else if (prelude.startsWith('@media')) {
        const min = /min-width:\s*(\d+)px/.exec(prelude);
        const max = /max-width:\s*(\d+)px/.exec(prelude);
        const width = min || max ? { min: min ? Number(min[1]) : 0, max: max ? Number(max[1]) : Infinity } : { min: Infinity, max: -Infinity };
        walk(body, layer, width);
      } else if (!prelude.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
        }
        for (const selector of prelude.split(',')) {
          order += 1;
          rules.push({ selector: selector.trim().replace(/\s+/g, ' '), layer: layer === null ? Infinity : layers.indexOf(layer), media, order, decls });
        }
      }
      index = close;
    }
  };
  walk(text, null, null);
  return rules;
}

const SHORTHANDS: Record<string, string[]> = { 'margin-left': ['margin'], 'margin-top': ['margin'], padding: [], 'padding-top': ['padding'], 'padding-inline': ['padding'] };

/** The value `selector` gives `prop` at viewport `width`: later layer, then later source, wins (same selector text only). */
function effective(rules: CssRule[], selector: string, prop: string, width: number): string | undefined {
  const names = [prop, ...(SHORTHANDS[prop] ?? [])];
  const hits = rules
    .filter((rule) => rule.selector === selector && (rule.media === null || (width >= rule.media.min && width <= rule.media.max)))
    .flatMap((rule) => names.filter((name) => rule.decls.has(name)).map((name) => ({ rule, name })))
    .sort((a, b) => a.rule.layer - b.rule.layer || a.rule.order - b.rule.order);
  const last = hits.at(-1);
  if (!last) return undefined;
  const value = last.rule.decls.get(last.name)!;
  return last.name === prop || !/\s/.test(value) ? value : undefined;
}

/** Every `[selector, prop, media min]` that a min-width rule sets: the effective value there must be that rule's value. */
function overridesLost(rules: CssRule[]): string[] {
  const lost: string[] = [];
  for (const rule of rules) {
    if (!rule.media || rule.media.min === Infinity || rule.media.min === 0) continue;
    for (const [prop, value] of rule.decls) {
      const got = effective(rules, rule.selector, prop, rule.media.min);
      const winner = rules
        .filter((other) => other.selector === rule.selector && other.media && other.media.min !== Infinity && other.media.min <= rule.media!.min && other.decls.has(prop))
        .sort((a, b) => b.media!.min - a.media!.min)[0];
      if (winner && got !== winner.decls.get(prop)) lost.push(`${rule.selector} { ${prop} } from ${rule.media.min}px: ${value} loses to ${got}`);
    }
  }
  return lost;
}

const appCss = fs.readFileSync(path.join(WEB_ROOT, 'app.css'), 'utf8');

test('cascade: no min-width rule of app.css loses to a base rule of the same selector in a later layer or position', () => {
  assert.deepEqual(overridesLost(cssRules(appCss)), []);
});

test('control: the connection pill margin rule moved back into an earlier layer is reported lost (F1)', () => {
  const moved = appCss.replace('.conn { margin-left: auto; }', '').replace('@layer layout {', '@layer layout {\n  @media (min-width: 768px) { .conn { margin-left: auto; } }');
  assert.notEqual(moved, appCss);
  assert.ok(overridesLost(cssRules(moved)).some((entry) => entry.startsWith('.conn { margin-left }')));
});

test('layout F1: the pill takes the free space from 768, so the theme control sits at the end', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.conn', 'margin-left', 360), '0');
  assert.equal(effective(rules, '.conn', 'margin-left', 768), 'auto');
});

test('layout F3: summary gives needs-you priority, running support and finished quiet history', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 360), 'repeat(3, minmax(0, 1fr))');
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 767), 'repeat(3, minmax(0, 1fr))');
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 768), 'minmax(0, 1.8fr) repeat(2, minmax(0, 1fr))');
  assert.equal(effective(rules, '.tile[data-state="awaiting"]', 'min-height', 768), '172px');
  assert.equal(effective(rules, '.tile[data-state="running"]', 'min-height', 768), '138px');
  assert.equal(effective(rules, '.tile[data-state="running"]', 'background', 360), 'var(--surface-2)');
  assert.equal(effective(rules, '.tile[data-state="done"]', 'background', 360), 'transparent');
  assert.equal(effective(rules, '.tile[data-state="done"] .tile__count', 'color', 360), 'var(--text-muted)');
  const equalCards = cssRules(appCss.replace('minmax(0, 1.8fr) repeat(2, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))'));
  assert.notEqual(effective(equalCards, '.summary', 'grid-template-columns', 768), effective(rules, '.summary', 'grid-template-columns', 768));
  assert.equal(effective(rules, '.tile', 'min-height', 360), '102px');
  assert.equal(effective(rules, '.tile', 'min-height', 768), '150px');
  assert.equal(effective(rules, '.skel--tile', 'height', 360), effective(rules, '.tile', 'min-height', 360));
  assert.equal(effective(rules, '.skel--tile', 'height', 768), effective(rules, '.tile', 'min-height', 768));
  assert.equal(effective(rules, '.tile', 'box-sizing', 360), 'border-box');
  assert.equal(effective(rules, '.tile__label', 'white-space', 360), 'nowrap');
});

test('layout F4: the stale banner is a two-column grid below 768 with the button under the text', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.banner', 'display', 360), 'grid');
  assert.equal(effective(rules, '.banner', 'grid-template-columns', 360), '20px minmax(0, 1fr)');
  assert.equal(effective(rules, '.banner .btn', 'grid-column', 360), '2');
  assert.equal(effective(rules, '.banner .btn', 'justify-self', 360), 'start');
  assert.equal(effective(rules, '.banner .btn', 'margin-left', 360), '0');
  assert.equal(effective(rules, '.banner', 'display', 768), 'flex');
  assert.equal(effective(rules, '.banner .btn', 'margin-left', 768), 'auto');
});

test('layout F5: command blocks wrap below 768 and scroll inside themselves from 768', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.cmd__text', 'white-space', 360), 'pre-wrap');
  assert.equal(effective(rules, '.cmd__text', 'overflow-wrap', 360), 'anywhere');
  assert.equal(effective(rules, '.cmd__text', 'overflow-x', 360), 'visible');
  assert.equal(effective(rules, '.cmd', 'align-items', 360), 'center');
  assert.equal(effective(rules, '.cmd__text', 'white-space', 768), 'pre');
  assert.equal(effective(rules, '.cmd__text', 'overflow-x', 768), 'auto');
  assert.equal(effective(rules, '.cmd', 'align-items', 768), 'center');
});

// ---- E.1 review: the run row grid (F1, F2) and the gate glyph (F6) ------------------------------------

test('layout E.1 F1/F2: the phone row gives the title a full line; from 768 rows are 76 px and the meta drops the workflow name until 1024', () => {
  const rules = cssRules(appCss);
  const areas = (width: number) => effective(rules, '.run-row', 'grid-template-areas', width);
  // Compact rows retain separate title, rail, metadata, state and time areas.
  assert.equal(areas(360), '"title title title" "rail rail rail" "meta state time"');
  assert.equal(effective(rules, '.run-row', 'min-height', 360), 'calc(var(--target) * 2 + var(--space-1))');
  assert.equal(effective(rules, '.run-row', 'padding', 360), 'var(--space-2) var(--space-4)');
  assert.equal(effective(rules, '.run-row__title', 'min-width', 360), '0');
  assert.equal(effective(rules, '.run-row__rail', 'min-width', 360), '0');
  const missingRail = cssRules(appCss.replace('"title title title" "rail rail rail" "meta state time"', '"title title title" "title title title" "meta state time"'));
  assert.notEqual(effective(missingRail, '.run-row', 'grid-template-areas', 360), areas(360));
  assert.equal(areas(768), '"title rail state" "meta rail time"');
  assert.equal(effective(rules, '.run-row', 'min-height', 768), '76px');
  assert.equal(effective(rules, '.run-row', 'grid-template-columns', 768), 'minmax(0, 1fr) var(--rail-col) 9rem');
  // CD-B2/CD-B3 replace the fixed rail column of 1024 and up with a stretching one and add the step column.
  assert.equal(effective(rules, '.run-row', 'grid-template-columns', 1024), 'minmax(0, 1fr) minmax(var(--rail-col), 1fr) 4rem 10rem');
  assert.equal(areas(1024), '"title rail step state" "meta rail step time"');
  assert.equal(effective(rules, '.run-row', 'grid-template-columns', 1500), 'minmax(0, 1fr) minmax(var(--rail-col), 1fr) 4rem 10rem');
  assert.equal(effective(rules, '.run-row__wf', 'display', 768), 'none');
  assert.equal(effective(rules, '.run-row__wf', 'display', 1024), 'inline');
  assert.equal(effective(rules, '.run-row__title', 'flex-wrap', 360), 'wrap');
  assert.equal(effective(rules, '.run-row__title', 'flex-wrap', 768), 'nowrap');
  assert.equal(effective(rules, '.skel--list', 'height', 360), '464px');
  assert.equal(effective(rules, '.skel--list', 'height', 768), '304px');
});

test('layout CD-B2/B3/B4: the compact rail stretches with caps, the step column and the tile sublines show per band', () => {
  const rules = cssRules(appCss);
  const glyph = '.rail--compact .rail__glyph + .rail__glyph';
  assert.equal(effective(rules, '.rail--compact', 'width', 360), '100%');
  assert.equal(effective(rules, glyph, 'flex', 360), '1 1 auto');
  assert.equal(effective(rules, `${glyph}::before`, 'flex', 360), '1 1 6px');
  assert.equal(effective(rules, `${glyph}::before`, 'min-width', 360), '6px');
  assert.equal(effective(rules, `${glyph}[data-type="stage"]`, 'max-width', 360), '68px');
  assert.equal(effective(rules, `${glyph}[data-type="gate"]`, 'max-width', 360), '60px');
  assert.equal(effective(rules, '.rail--lg .rail__glyph + .rail__glyph[data-type="stage"]', 'max-width', 360), '84px');
  assert.equal(effective(rules, '.rail--lg .rail__glyph + .rail__glyph[data-type="gate"]', 'max-width', 360), '72px');
  assert.equal(effective(rules, '.run-row__step', 'display', 768), 'none');
  assert.equal(effective(rules, '.run-row__step', 'display', 1024), 'block');
  assert.equal(effective(rules, '.run-row__sp', 'display', 360), 'inline');
  assert.equal(effective(rules, '.run-row__sp', 'display', 768), 'none');
  assert.equal(effective(rules, '.run-row__sp', 'display', 1024), 'inline');
  assert.equal(effective(rules, '.run-row__st', 'display', 360), 'none');
  assert.equal(effective(rules, '.run-row__st', 'display', 768), 'inline');
  assert.equal(effective(rules, '.run-row__st', 'display', 1024), 'none');
  assert.equal(effective(rules, '.run-row__frac', 'display', 360), 'inline');
  assert.equal(effective(rules, '.run-row__frac', 'display', 768), 'none');
  assert.equal(effective(rules, '.run-row__upd', 'display', 360), 'none');
  assert.equal(effective(rules, '.run-row__upd', 'display', 768), 'inline');
  assert.equal(effective(rules, '.tile__sub-long', 'display', 360), 'none');
  assert.equal(effective(rules, '.tile__sub-long', 'display', 768), 'inline');
  assert.equal(effective(rules, '.tile__sub-short', 'display', 360), 'inline');
  assert.equal(effective(rules, '.tile__sub-short', 'display', 768), 'none');
  assert.equal(effective(rules, '.tile', 'padding', 360), 'var(--space-3) var(--space-2)');
  assert.equal(effective(rules, '.tile', 'padding', 768), 'var(--space-5)');
});

test('layout CD-B1/B8: gate cards are 1, 2 and 3 columns; the run head is one column, then title and step side by side; the rail card pads 16 then 24', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.gate-cards', 'grid-template-columns', 360), 'minmax(0, 1fr)');
  assert.equal(effective(rules, '.gate-cards', 'grid-template-columns', 768), 'repeat(2, minmax(0, 1fr))');
  assert.equal(effective(rules, '.gate-cards', 'grid-template-columns', 1280), 'repeat(3, minmax(0, 1fr))');
  assert.equal(effective(rules, '.gate-card', 'border', 360), '1px solid var(--state-awaiting-mark)');
  assert.equal(effective(rules, '.gate-card__head', 'min-height', 360), '52px');
  assert.equal(effective(rules, '.run-head', 'grid-template-areas', 360), '"crumb" "title" "meta" "step"');
  assert.equal(effective(rules, '.run-head', 'grid-template-areas', 768), '"crumb crumb" "title step" "meta step"');
  assert.equal(effective(rules, '.run-head', 'grid-template-columns', 768), 'minmax(0, 1fr) auto');
  assert.equal(effective(rules, '.run-rail', 'padding', 360), 'var(--space-4)');
  assert.equal(effective(rules, '.run-rail', 'padding', 768), 'var(--space-5) var(--space-5) var(--space-4)');
  assert.equal(effective(rules, '.rail__dur', 'top', 768), '56px');
  assert.equal(effective(rules, '.rail--full', 'min-width', 768), '100%');
});

test('layout E.1 F6: only a stage glyph gets a dashed border; a gate keeps its dashed shape stroke', () => {
  const dashed = cssRules(appCss).filter((rule) => rule.selector.includes('.rail__glyph') && rule.decls.get('border-style') === 'dashed');
  assert.ok(dashed.length > 0);
  for (const rule of dashed) assert.ok(rule.selector.includes('[data-type="stage"]'), rule.selector);
});

test('control: an unscoped dashed glyph rule is reported by the F6 check', () => {
  const planted = `${appCss}\n@layer components { .rail__item[data-tone="skipped"] .rail__glyph { border-style: dashed; } }`;
  const bad = cssRules(planted).filter((rule) => rule.selector.includes('.rail__glyph') && rule.decls.get('border-style') === 'dashed' && !rule.selector.includes('[data-type="stage"]'));
  assert.equal(bad.length, 1);
});

test('layout E.1 r3: R3-9 no "·" ends a line at 360; R3-4 stage durations sit on the gate baseline; R3-1 the end labels are anchored to the node edge', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.run-head__sep', 'display', 360), 'none');
  assert.equal(effective(rules, '.run-head__sep', 'display', 768), 'inline');
  assert.equal(effective(rules, '.run-head__meta', 'row-gap', 360), 'var(--space-1)');
  assert.equal(effective(rules, '.run-head__meta', 'column-gap', 360), 'var(--space-3)');
  assert.equal(effective(rules, '.skel--meta', 'height', 360), '20px');
  assert.equal(effective(rules, '.rail__item[data-type="stage"] .rail__dur', 'top', 768), 'calc(56px - 1.5px)');
  const first = rules.find((rule) => rule.selector.includes(':first-child') && rule.selector.includes('.rail__dur'));
  const last = rules.find((rule) => rule.selector.includes(':last-child') && rule.selector.includes('.rail__dur'));
  assert.ok(first && last, 'the first and last item anchor their labels');
  assert.equal(first!.decls.get('left'), '0');
  assert.equal(last!.decls.get('right'), '0');
  assert.equal(last!.decls.get('left'), 'auto');
  assert.equal(last!.decls.get('transform'), 'none');
});

test('R3-2 forced colours draw pending and not-reached shapes with borders, never box-shadow or gradients', () => {
  const forced = cssRules(appCss).filter((rule) => rule.media !== null && rule.media.min === Infinity && /Highlight|CanvasText|GrayText/.test([...rule.decls.values()].join(' ')));
  const bad = forced.filter((rule) => /pending|not-reached|unknown/.test(rule.selector) && [...rule.decls.entries()].some(([prop, value]) => (prop === 'box-shadow' && value !== 'none') || /gradient/.test(value)));
  assert.deepEqual(bad.map((rule) => rule.selector), []);
  const pill = forced.find((rule) => rule.selector.includes('[data-type="stage"][data-state="pending"]::after'));
  assert.ok(pill && /solid CanvasText/.test(pill.decls.get('border') ?? ''), 'a pending stage pill is a CanvasText border');
  const joined = forced.filter((rule) => rule.selector.includes('.rail--full') && rule.selector.includes('[data-state="pending"]::before'));
  assert.ok(joined.length > 0 && joined.every((rule) => /dashed GrayText/.test(`${rule.decls.get('border-top') ?? ''} ${rule.decls.get('border-inline-start') ?? ''}`)), 'pending full-rail connectors are dashed GrayText borders');
  assert.ok(forced.some((rule) => rule.selector === '.rail--compact .rail__glyph[data-state="pending"]::before' && rule.decls.get('background') === 'GrayText'), 'compact pending connectors are GrayText');
});

test('layout E.1 r4: R4-4 the meta is one 20 px line so a badge row is 76 px; R3-8 the wide-only words show from 768 and the completed step part is hidden below it', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.run-row__meta', 'height', 360), '20px');
  assert.equal(effective(rules, '.run-row__wide', 'display', 360), 'none');
  assert.equal(effective(rules, '.run-row__wide', 'display', 768), 'inline');
  assert.equal(effective(rules, '.run-row[data-state="COMPLETED"] .run-row__sp', 'display', 360), 'none');
  assert.equal(effective(rules, '.run-row[data-state="COMPLETED"] .run-row__sp', 'display', 768), 'inline');
});

// ---- V.10: the Fleet files (IC-007, IC-026; design ui/V8.md) ---------------------------------------------------------

/** The Fleet sources IC-026 names, plus the derivations that feed their words. */
const FLEET_FILES = ['views/fleet.js', 'views/transcript.js', 'stream.js', 'derive/fleet.js'];
const STATE_WORDS = /\b(active|online|idle)\b/i;
const STORAGE_API = /\b(?:localStorage|sessionStorage|indexedDB|caches|CacheStorage|openDatabase)\b/;

/** Findings of the Fleet copy and storage rules for one file's text, as `<file>:<line>: <rule>`. */
function fleetFindings(file: string, source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    if (STATE_WORDS.test(line)) found.push(`${file}:${index + 1}: state-word`);
    if (STORAGE_API.test(line)) found.push(`${file}:${index + 1}: storage-api`);
  });
  return found;
}

test('V.10: the Fleet files exist, pass IC-007, never say active, online or idle, and touch no storage API', () => {
  for (const name of FLEET_FILES) assert.ok(fs.existsSync(path.join(WEB_ROOT, name)), `${name} exists`);
  assert.deepEqual(scanDir(WEB_ROOT), [], 'IC-007 over the whole web root, the new files included');
  for (const name of FLEET_FILES) assert.deepEqual(fleetFindings(name, fs.readFileSync(path.join(WEB_ROOT, name), 'utf8')), []);
});

test('V.10: the stream panel says its text is masked, best effort', () => {
  const panel = fs.readFileSync(path.join(WEB_ROOT, 'views', 'transcript.js'), 'utf8');
  assert.ok(panel.includes('masked, best effort'));
});

test('control: a planted state word, storage call or missing masked line turns the Fleet checks red', () => {
  assert.deepEqual(fleetFindings('x.js', "mount(el, 'The agent is active');"), ['x.js:1: state-word']);
  assert.deepEqual(fleetFindings('x.js', "h('p', {}, 'Online now');"), ['x.js:1: state-word']);
  assert.deepEqual(fleetFindings('x.js', 'const idle = true;'), ['x.js:1: state-word']);
  assert.deepEqual(fleetFindings('x.js', "globalThis.localStorage.setItem('t', text);"), ['x.js:1: storage-api']);
  assert.deepEqual(fleetFindings('x.js', 'await caches.open("c");'), ['x.js:1: storage-api']);
  assert.deepEqual(fleetFindings('x.js', "const text = 'a running process was seen at 10:41';"), []);
  const panel = fs.readFileSync(path.join(WEB_ROOT, 'views', 'transcript.js'), 'utf8');
  assert.ok(!panel.replaceAll('masked, best effort', 'masked').includes('masked, best effort'));
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'views', 'fleet.js'), "\nexport const bad = 'The agent is online';\nglobalThis.sessionStorage.setItem('t', 'x');\n");
  assert.equal(fleetFindings('views/fleet.js', fs.readFileSync(path.join(copy, 'views', 'fleet.js'), 'utf8')).length, 2);
});

test('layout CD-B9: phone header keeps pause and theme reachable alongside navigation', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.site-header__inner', 'grid-template-areas', 360), '"brand conn" "nav nav" "pause theme"');
  assert.equal(effective(rules, '.pause', 'grid-area', 360), 'pause');
  assert.equal(effective(rules, '.theme', 'grid-area', 360), 'theme');
  assert.equal(effective(rules, '.pause__label', 'white-space', 360), 'nowrap');
  const orphanPause = cssRules(appCss.replace('"brand conn" "nav nav" "pause theme"', '"brand conn" "nav nav" "theme theme"'));
  assert.notEqual(effective(orphanPause, '.site-header__inner', 'grid-template-areas', 360), effective(rules, '.site-header__inner', 'grid-template-areas', 360));
  assert.equal(effective(rules, '.site-header__inner', 'grid-template-rows', 360), 'var(--header-h) auto 48px');
  assert.equal(effective(rules, '.nav', 'justify-self', 360), 'stretch');
  assert.equal(effective(rules, '.conn', 'justify-self', 360), 'end');
  assert.equal(effective(rules, '.nav ul', 'flex-wrap', 359), 'wrap', 'the list may wrap as a fallback below 360');
  assert.equal(effective(rules, '.nav ul', 'flex-wrap', 768), 'nowrap');
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/class="nav__link" href="([^"]+)">([^<]+)</g)].map((m) => m[2]), ['Runs', 'Workflows', 'Sessions', 'Fleet']);
  assert.ok(!/<button[^>]*menu/i.test(html), 'no menu button');
});

test('layout CD-B9: tablet header separates navigation until the desktop row fits', () => {
  const rules = cssRules(appCss);
  for (const width of [768, 1024, 1099]) {
    assert.equal(effective(rules, '.site-header__inner', 'display', width), 'grid');
    assert.equal(effective(rules, '.site-header__inner', 'grid-template-areas', width), '"brand conn pause theme" "nav nav nav nav"');
    assert.equal(effective(rules, '.site-header__inner', 'grid-template-columns', width), 'minmax(0, 1fr) auto auto auto');
    assert.equal(effective(rules, '.site-header__inner', 'grid-template-rows', width), 'var(--header-h) auto');
  }
  assert.equal(effective(rules, '.site-header__inner', 'display', 1100), 'flex');
  assert.equal(effective(rules, '.site-header__inner', 'height', 1100), 'var(--header-h)');
  const earlyDesktop = cssRules(appCss.replace('@media (min-width: 1100px)', '@media (min-width: 768px)'));
  assert.equal(effective(earlyDesktop, '.site-header__inner', 'display', 768), 'flex');
  assert.notEqual(effective(earlyDesktop, '.site-header__inner', 'display', 768), effective(rules, '.site-header__inner', 'display', 768));
  const orphanPause = cssRules(appCss.replace('"brand conn pause theme" "nav nav nav nav"', '"brand conn conn theme" "nav nav nav nav"'));
  assert.notEqual(effective(orphanPause, '.site-header__inner', 'grid-template-areas', 768), effective(rules, '.site-header__inner', 'grid-template-areas', 768));
});

test('layout V.10: the project row, the Fleet grid and the sheet follow the bands of the design note', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.project-row', 'grid-template-areas', 360), '"name name" "agents agents" "models models" "traffic last"');
  assert.equal(effective(rules, '.project-row', 'min-height', 360), '132px');
  assert.equal(effective(rules, '.project-row', 'grid-template-areas', 768), '"name agents last" "models traffic last"');
  assert.equal(effective(rules, '.project-row', 'min-height', 768), '76px');
  assert.equal(effective(rules, '.project-row', 'grid-template-areas', 1280), '"name agents models traffic last"');
  assert.equal(effective(rules, '.project-row', 'min-height', 1280), '64px');
  assert.equal(effective(rules, '.fleet-grid', 'grid-template-columns', 360), 'minmax(0, 1fr)');
  assert.equal(effective(rules, '.fleet-grid', 'grid-template-columns', 1280), 'repeat(12, minmax(0, 1fr))');
  assert.equal(effective(rules, '.fleet-tree', 'grid-column', 1280), '1 / span 5');
  assert.equal(effective(rules, '.fpanel', 'grid-column', 1280), '6 / span 7');
  assert.equal(effective(rules, '.fleet-tree', 'grid-column', 1920), '1 / span 3');
  assert.equal(effective(rules, '.fpanel', 'grid-column', 1920), '4 / span 6');
  assert.equal(effective(rules, '.traffic__switch', 'display', 1920), 'none');
});
