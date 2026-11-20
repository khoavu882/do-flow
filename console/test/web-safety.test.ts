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

// ---- 162: the page writes only from the confirmation dialog -------------------------------------

/** Where the page mentions `postAction`, code only (comments dropped): the files that import or call it, as paths below the web root. */
function postActionUsers(root: string): string[] {
  return files(root).filter((file) => path.extname(file) === '.js')
    .filter((file) => /\bpostAction\b/.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
    .map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}

test('162: `postAction` is defined in actions.js and imported by views/confirm.js and by nothing else; no other file names an action route', () => {
  assert.deepEqual(postActionUsers(WEB_ROOT), ['actions.js', 'views/confirm.js']);
  const confirm = fs.readFileSync(path.join(WEB_ROOT, 'views', 'confirm.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(confirm.match(/\bpostAction\s*\(/g)?.length, 1, 'it is called once, from the verb button\u2019s send()');
  const named = files(WEB_ROOT).filter((file) => path.extname(file) === '.js' && /\/api\/actions/.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
    .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'));
  assert.deepEqual(named, ['actions.js'], 'the action routes are named in one file');
});

test('control: a view that imports or calls `postAction`, or names an action route, turns the guard red', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-post-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  assert.deepEqual(postActionUsers(copy), ['actions.js', 'views/confirm.js']);
  fs.writeFileSync(path.join(copy, 'views', 'sneaky.js'), "import { postAction } from '../actions.js';\nexport const go = () => postAction('close-run', {});\n");
  assert.deepEqual(postActionUsers(copy), ['actions.js', 'views/confirm.js', 'views/sneaky.js']);
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

test('control: the 768 px rule of the theme control moved back into an earlier layer is reported lost', () => {
  const moved = appCss.replace('    .site-header .theme { display: inline-flex; }\n', '').replace('@layer layout {', '@layer layout {\n  @media (min-width: 768px) { .site-header .theme { display: inline-flex; } }');
  assert.notEqual(moved, appCss);
  assert.ok(overridesLost(cssRules(moved)).some((entry) => entry.startsWith('.site-header .theme { display }')));
});

test('layout shell: the app bar is one sticky row at every width; the theme control joins it from 768', () => {
  const rules = cssRules(appCss);
  for (const width of [360, 768, 1280]) {
    assert.equal(effective(rules, '.site-header', 'position', width), 'sticky');
    assert.equal(effective(rules, '.site-header__inner', 'display', width), 'flex');
    assert.equal(effective(rules, '.site-header__inner', 'height', width), 'var(--header-h)');
    assert.equal(effective(rules, '.brand', 'margin-right', width), 'auto', 'the brand takes the free space, so the controls sit at the end');
  }
  assert.equal(effective(rules, '.site-header .theme', 'display', 360), 'none', 'a phone sets the theme on the More page');
  assert.equal(effective(rules, '.site-header .theme', 'display', 768), 'inline-flex');
  assert.equal(effective(rules, '.conn__long', 'display', 360), 'none');
  assert.equal(effective(rules, '.conn__long', 'display', 768), 'inline');
  assert.equal(effective(rules, '.conn__short', 'display', 768), 'none');
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
  assert.equal(effective(rules, '.gate-card__head', 'min-height', 360), 'var(--target)', 'a compact head on a phone');
  assert.equal(effective(rules, '.gate-card__head', 'min-height', 768), '52px');
  assert.equal(effective(rules, '.gate-card__body', 'padding', 360), 'var(--space-3) var(--space-4)');
  assert.equal(effective(rules, '.gate-card__body', 'padding', 768), 'var(--space-4)');
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

// ---- 161: the Layers files (IC-007; design section 8) ---------------------------------------------------------

/** The Layers sources, plus the transcript panel the agent inspector uses and the derivation that feeds their words. */
const LAYERS_FILES = ['views/layers.js', 'views/transcript.js', 'derive/layers.js'];
const STATE_WORDS = /\b(active|online|idle)\b/i;
const STORAGE_API = /\b(?:localStorage|sessionStorage|indexedDB|caches|CacheStorage|openDatabase)\b/;

/** Findings of the Layers copy and storage rules for one file's text, as `<file>:<line>: <rule>`. */
function layersFindings(file: string, source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    if (STATE_WORDS.test(line)) found.push(`${file}:${index + 1}: state-word`);
    if (STORAGE_API.test(line)) found.push(`${file}:${index + 1}: storage-api`);
  });
  return found;
}

test('161: the Layers files exist, pass IC-007, never say active, online or idle, and touch no storage API', () => {
  for (const name of LAYERS_FILES) assert.ok(fs.existsSync(path.join(WEB_ROOT, name)), `${name} exists`);
  assert.deepEqual(scanDir(WEB_ROOT), [], 'IC-007 over the whole web root, the new files included');
  for (const name of LAYERS_FILES) assert.deepEqual(layersFindings(name, fs.readFileSync(path.join(WEB_ROOT, name), 'utf8')), []);
});

test('V.10: the stream panel says its text is masked, best effort', () => {
  const panel = fs.readFileSync(path.join(WEB_ROOT, 'views', 'transcript.js'), 'utf8');
  assert.ok(panel.includes('masked, best effort'));
});

test('control: a planted state word, storage call or missing masked line turns the Layers checks red', () => {
  assert.deepEqual(layersFindings('x.js', "mount(el, 'The agent is active');"), ['x.js:1: state-word']);
  assert.deepEqual(layersFindings('x.js', "h('p', {}, 'Online now');"), ['x.js:1: state-word']);
  assert.deepEqual(layersFindings('x.js', 'const idle = true;'), ['x.js:1: state-word']);
  assert.deepEqual(layersFindings('x.js', "globalThis.localStorage.setItem('t', text);"), ['x.js:1: storage-api']);
  assert.deepEqual(layersFindings('x.js', 'await caches.open("c");'), ['x.js:1: storage-api']);
  assert.deepEqual(layersFindings('x.js', "const text = 'a running process was seen at 10:41';"), []);
  const panel = fs.readFileSync(path.join(WEB_ROOT, 'views', 'transcript.js'), 'utf8');
  assert.ok(!panel.replaceAll('masked, best effort', 'masked').includes('masked, best effort'));
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'views', 'layers.js'), "\nexport const bad = 'The agent is online';\nglobalThis.sessionStorage.setItem('t', 'x');\n");
  assert.equal(layersFindings('views/layers.js', fs.readFileSync(path.join(copy, 'views', 'layers.js'), 'utf8')).length, 2);
});

test('layout shell: the pause control is an icon button below 1280 and keeps its words as its name', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.pause', 'width', 360), 'var(--target)');
  assert.equal(effective(rules, '.pause__label', 'clip-path', 360), 'inset(50%)', 'visually hidden, still the accessible name');
  assert.equal(effective(rules, '.pause__label', 'white-space', 360), 'nowrap');
  assert.equal(effective(rules, '.pause', 'width', 768), 'var(--target)');
  assert.equal(effective(rules, '.pause', 'width', 1280), 'auto');
  assert.equal(effective(rules, '.pause__label', 'clip-path', 1280), 'none');
  // The app bar's theme control is three icons at every width; its words show on the More page.
  for (const width of [768, 1280, 1920]) assert.equal(effective(rules, '.theme__label', 'clip-path', width), 'inset(50%)');
  assert.equal(effective(rules, '.theme--labelled .theme__label', 'clip-path', 360), 'none');
});

test('layout shell: the navigation is a tab bar fixed to the bottom below 768, a rail of columns from 768 and of rows from 1280', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.navrail', 'position', 360), 'fixed');
  assert.equal(effective(rules, '.navrail', 'inset', 360), 'auto 0 0');
  assert.equal(effective(rules, '.navrail', 'padding', 360), '0 var(--safe-right) var(--safe-bottom) var(--safe-left)', 'the bar clears the home indicator');
  assert.equal(effective(rules, '.navrail ul', 'height', 360), 'var(--tabbar-h)');
  assert.equal(effective(rules, '.navrail ul', 'grid-auto-columns', 360), 'minmax(0, 1fr)', 'equal tabs');
  assert.equal(effective(rules, '.navrail .navrail__group', 'display', 360), 'none', 'the Manage group is behind More on a phone');
  assert.equal(effective(rules, '.navrail .navrail__heading', 'display', 360), 'none');
  assert.equal(effective(rules, '.navrail__link', 'min-height', 360), 'var(--target)');
  assert.equal(effective(rules, '.navrail__link', 'flex-direction', 360), 'column', 'the label is always shown, under the icon');
  assert.equal(effective(rules, '.page', 'padding-block', 360), 'var(--space-4) calc(var(--space-7) + var(--chrome-bottom))', 'the canvas ends above the tab bar');
  assert.equal(effective(rules, '.navrail', 'position', 768), 'sticky');
  assert.equal(effective(rules, '.navrail', 'top', 768), 'var(--chrome-top)');
  assert.equal(effective(rules, '.navrail__more', 'display', 768), 'none', 'from 768 the rail holds every destination, so More leaves it');
  assert.equal(effective(rules, '.navrail .navrail__group', 'display', 768), 'flex');
  assert.equal(effective(rules, '.navrail__link', 'flex-direction', 768), 'column');
  assert.equal(effective(rules, '.navrail .navrail__heading', 'display', 768), 'none');
  assert.equal(effective(rules, '.navrail__link', 'flex-direction', 1280), 'row');
  assert.equal(effective(rules, '.navrail .navrail__heading', 'display', 1280), 'block');
  assert.equal(effective(rules, '.shell', 'grid-template-areas', 360), '"attention" "main"');
  assert.equal(effective(rules, '.shell', 'grid-template-areas', 768), '"nav attention" "nav main"');
  assert.equal(effective(rules, '.shell[data-inspectable="true"][data-panel="open"]', 'grid-template-areas', 1280), '"nav attention inspector" "nav main inspector"');
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  const labels = [...html.matchAll(/class="navrail__link" href="([^"]+)"><span class="navrail__label">([^<]+)</g)].map((m) => m[2]);
  assert.deepEqual(labels.slice(0, 4), ['Now', 'Sessions', 'Layers', 'More'], 'the four tabs of a phone');
  assert.deepEqual(labels.slice(4), ['Follow-ups', 'Workflows', 'Workers', 'Advice', 'Settings', 'Health'], 'the Manage group');
  assert.ok(!/<button[^>]*menu/i.test(html), 'no menu button: every destination is a link');
  const tokens = fs.readFileSync(path.join(WEB_ROOT, 'tokens.css'), 'utf8');
  assert.match(tokens, /@media \(min-width: 768px\) \{\s*:root \{[^}]*--tabbar-h: 0px;/, 'no tab bar from 768, so nothing is reserved for it');
});

test('layout shell: the sheet clears the app bar and the home indicator; the dock and the drawer start under the app bar', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.inspector[data-mode="sheet"]', 'max-height', 360), 'calc(100dvh - var(--chrome-top) - var(--space-4))');
  assert.equal(effective(rules, '.inspector[data-mode="sheet"]', 'padding-bottom', 360), 'var(--safe-bottom)');
  assert.equal(effective(rules, '.inspector[data-mode="drawer"]', 'top', 768), 'var(--chrome-top)');
  assert.equal(effective(rules, '.inspector[data-mode="dock"]', 'top', 1280), 'var(--chrome-top)');
});

test('layout 161: the project row of the machine page and the lane rows follow the bands of the design note', () => {
  const rules = cssRules(appCss);
  const project = '.lrow[data-kind="project"]';
  assert.equal(effective(rules, '.lrow', 'grid-template-columns', 360), 'minmax(0, 1fr)');
  assert.equal(effective(rules, project, 'grid-template-columns', 360), undefined, 'the project row is one column below 768');
  assert.equal(effective(rules, project, 'grid-template-columns', 768), 'minmax(0, 1.4fr) minmax(0, 2fr) 10rem');
  assert.equal(effective(rules, project, 'grid-template-columns', 1920), 'minmax(0, 1.4fr) minmax(0, 2fr) 10rem');
  assert.equal(effective(rules, '.layers--machine .gate-cards', 'grid-template-columns', 768), undefined);
  assert.equal(effective(rules, '.layers--machine .gate-cards', 'grid-template-columns', 1280), 'repeat(2, minmax(0, 1fr))');
  // The agent transcript is in the shell's inspector, so the page frame holds no panel of its own.
  for (const width of [360, 768, 1280, 1920]) {
    assert.equal(effective(rules, '.fpanel', 'grid-column', width), undefined, `${width}: the panel has no place in the page grid`);
    assert.equal(effective(rules, '.fpanel', 'position', width), undefined, `${width}: the panel is not a sheet of its own`);
  }
  assert.equal(effective(rules, '.layers-crumb__agent', 'display', 360), 'none');
  assert.equal(effective(rules, '.layers-crumb[data-agent="true"] .layers-crumb__agent', 'display', 360), 'inline');
  assert.equal(effective(rules, '.layers-crumb[data-agent="true"] .layers-crumb__agent', 'display', 768), undefined);
});

// The page names its own icon, so no browser asks for /favicon.ico (a 404 on every load before). The icon is a text SVG the static
// route serves as `image/svg+xml` under the unchanged policy (`img-src 'self'`): no binary file, no data: URI, no style or script in it.
test('the page icon is a small SVG file of the bundle, linked from index.html and served by the static route', async () => {
  const { readStatic } = require('../src/static.ts');
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="favicon\.svg">/);
  assert.doesNotMatch(html, /favicon\.ico|href="data:/);
  const served = await readStatic(fs.realpathSync(WEB_ROOT), '/favicon.svg');
  assert.ok(served, 'the static route finds it');
  assert.equal(served.type, 'image/svg+xml');
  const svg = String(served.body);
  assert.ok(svg.length < 1024, 'small');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16">/);
  assert.doesNotMatch(svg, /<script|<style|style=|href=|url\(|\bon[a-z]+=/i);
  assert.deepEqual(fs.readdirSync(WEB_ROOT).filter((name: string) => /\.(ico|png|jpe?g|gif)$/i.test(name)), [], 'no binary icon');
});

// ---- 180 C3: one file names the browser's notification API ------------------------------------------------------------

/** The files below `root` whose code (comments dropped) names `Notification`, as paths below the web root. */
function notificationUsers(root: string): string[] {
  return files(root).filter((file) => path.extname(file) === '.js')
    .filter((file) => /\bNotification\b/.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
    .map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}

test('180 C3: only notify.js names Notification, so the permission prompt has one audited place; the Layers files still touch no storage', () => {
  assert.deepEqual(notificationUsers(WEB_ROOT), ['notify.js']);
  for (const name of LAYERS_FILES) assert.deepEqual(layersFindings(name, fs.readFileSync(path.join(WEB_ROOT, name), 'utf8')).filter((f) => f.endsWith('storage-api')), [], name);
});

test('control: a view that names Notification turns the notify guard red', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-notify-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  assert.deepEqual(notificationUsers(copy), ['notify.js']);
  fs.appendFileSync(path.join(copy, 'views', 'home.js'), "\nexport const nag = () => globalThis.Notification.requestPermission();\n");
  assert.deepEqual(notificationUsers(copy), ['notify.js', 'views/home.js']);
  fs.writeFileSync(path.join(copy, 'views', 'quiet.js'), '// a comment may say Notification\nexport const x = 1;\n');
  assert.deepEqual(notificationUsers(copy), ['notify.js', 'views/home.js'], 'a comment is not code');
});

// ---- 180 C5: saved filters stay in this browser, inside try/catch; the explainer is pure ---------------------------------

/** Code only: `//` and block comments dropped. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The files that name the saved-filter key, and every storage call of filters.js not opened by the `try {` line just above it. */
function filterStoreFindings(root: string): { owners: string[], unguarded: string[], impure: string[] } {
  const js = files(root).filter((file) => path.extname(file) === '.js');
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const owners = js.filter((file) => codeOf(fs.readFileSync(file, 'utf8')).includes('doflow-console-filters')).map(rel).sort();
  const lines = codeOf(fs.readFileSync(path.join(root, 'filters.js'), 'utf8')).split('\n');
  const unguarded: string[] = [];
  lines.forEach((line, index) => {
    if (!/\blocalStorage\b/.test(line)) return;
    const above = lines.slice(0, index).reverse().find((prior) => prior.trim() !== '');
    if (!above || !/\btry\s*\{\s*$/.test(above)) unguarded.push(`filters.js:${index + 1}`);
  });
  const explain = codeOf(fs.readFileSync(path.join(root, 'derive', 'explain.js'), 'utf8'));
  const impure = ['document', 'localStorage', 'sessionStorage', 'Date.now', 'fetch'].filter((name) => new RegExp(`\\b${name.replace('.', '\\.')}\\b`).test(explain));
  return { owners, unguarded, impure };
}

test('180 C5: only filters.js names the saved-filter key, each of its storage calls opens a try block, and the explainer reads no DOM, storage, clock or network', () => {
  assert.deepEqual(filterStoreFindings(WEB_ROOT), { owners: ['filters.js'], unguarded: [], impure: [] });
  for (const name of LAYERS_FILES) assert.doesNotMatch(fs.readFileSync(path.join(WEB_ROOT, name), 'utf8'), /filters\.js/, `${name} does not use saved filters`);
});

test('control: a view naming the key, a storage call outside try, or a clock read in the explainer turns the saved-filter guard red', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-websafety-filters-'));
  tmp.push(copy);
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  assert.deepEqual(filterStoreFindings(copy), { owners: ['filters.js'], unguarded: [], impure: [] });
  fs.appendFileSync(path.join(copy, 'views', 'home.js'), "\nexport const peek = () => globalThis.localStorage.getItem('doflow-console-filters');\n");
  fs.appendFileSync(path.join(copy, 'filters.js'), '\nexport const raw = () => globalThis.localStorage.getItem(FILTERS_KEY);\n');
  fs.appendFileSync(path.join(copy, 'derive', 'explain.js'), '\nexport const at = () => Date.now();\n');
  const found = filterStoreFindings(copy);
  assert.deepEqual(found.owners, ['filters.js', 'views/home.js']);
  assert.equal(found.unguarded.length, 1);
  assert.deepEqual(found.impure, ['Date.now']);
});
