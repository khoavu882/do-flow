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

test('every module the page loads is a file of the web root (no import leaves it)', () => {
  const names = new Set(fs.readdirSync(WEB_ROOT));
  for (const file of files(WEB_ROOT).filter((entry) => entry.endsWith('.js'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
      assert.match(match[1], /^\.\/[a-z-]+\.js$/, `${path.basename(file)} imports ${match[1]}`);
      assert.ok(names.has(match[1].slice(2)), `${match[1]} exists`);
    }
  }
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

test('layout F3: the summary stacks in one column below 768, and skeleton tiles are exactly the tile heights', () => {
  const rules = cssRules(appCss);
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 360), '1fr');
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 767), '1fr');
  assert.equal(effective(rules, '.summary', 'grid-template-columns', 768), 'repeat(3, minmax(0, 1fr))');
  assert.equal(effective(rules, '.tile', 'min-height', 360), '62px');
  assert.equal(effective(rules, '.tile', 'min-height', 768), '122px');
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
