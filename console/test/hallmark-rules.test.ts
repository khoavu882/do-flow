'use strict';

// Kept-rules guard (feature 140-console-hallmark-polish, IC-003). Four predicates, each a pure function over
// CSS text that returns a list of `<rule>: <detail>` strings (an empty list passes):
//   clip          html or body declares `overflow-x: clip` (Hallmark floor 34; `hidden` does not satisfy it)
//   scale         literal px in padding / margin / gap sits on the 4px scale and is not a --space-N value (24a, 24b)
//   surface-text  a surface-background rule of a section/panel/card-like selector also sets `color` (floor 41)
//   eyebrow       an `eyebrow` class does not set uppercase or tracked caps (floor 67, narrowed by DEC-006)
// The guard reads web/app.css, web/tokens.css and web/index.html as text, uses no browser, network or
// dependency, and has no stamp predicate (DEC-003). Each rule has a control that runs its predicate on a
// planted mutation and expects the finding; the mutation helper asserts the text changed first, as
// tokens.test.ts does, so a stale search string cannot pass vacuously. The reader strips comments and walks
// nested at-rules into `{ at, selector, decls }` records, as tokens.test.ts does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const appCss = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(WEB, 'tokens.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

// ---- reading ------------------------------------------------------------------------------------

type Rule = { at: string | null, selector: string, decls: Array<[string, string]> };

/** Split on `separator` outside parentheses and quotes. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Every style rule of the text with the at-rule prelude that wraps it (null at top level), in source order. */
function parseRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (source: string, at: string | null) => {
    let index = 0;
    while (index < source.length) {
      const open = source.indexOf('{', index);
      if (open === -1) break;
      const prelude = source.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < source.length && depth > 0) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}') depth -= 1;
        close += 1;
      }
      const body = source.slice(open + 1, close - 1);
      if (prelude.startsWith('@')) walk(body, prelude);
      else {
        const decls: Array<[string, string]> = [];
        for (const part of splitTop(body, ';')) {
          const colon = part.indexOf(':');
          if (colon === -1) continue;
          decls.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
        }
        rules.push({ at, selector: prelude.replace(/\s+/g, ' '), decls });
      }
      index = close;
    }
  };
  walk(text, null);
  return rules;
}

const selectorParts = (selector: string) => splitTop(selector, ',').map((part) => part.trim());
const declared = (rule: Rule, prop: string) => rule.decls.filter(([name]) => name === prop).map(([, value]) => value.replace(/\s*!important$/i, '').trim());

/** The `<style>` blocks of an HTML text, so inline CSS is held to the same rules as the stylesheet. */
const inlineStyles = (html: string) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

// ---- the four predicates ------------------------------------------------------------------------

/** clip: html or body must declare `overflow-x: clip`. */
function checkClip(css: string): string[] {
  const rules = parseRules(css);
  const has = (element: string) => rules.some((rule) => selectorParts(rule.selector).includes(element) && declared(rule, 'overflow-x').includes('clip'));
  if (has('html') || has('body')) return [];
  const hidden = rules.some((rule) => selectorParts(rule.selector).some((part) => part === 'html' || part === 'body') && declared(rule, 'overflow-x').includes('hidden'));
  return [`clip: neither html nor body declares overflow-x: clip${hidden ? ' (overflow-x: hidden does not satisfy it)' : ''}`];
}

const SCALE_PROPS = new Set(['padding', 'margin', 'gap', 'row-gap', 'column-gap']);
for (const base of ['padding', 'margin']) for (const side of ['inline', 'block', 'top', 'right', 'bottom', 'left']) SCALE_PROPS.add(`${base}-${side}`);

/** The px values of --space-N read from tokens.css. */
function spaceValues(tokens: string): Set<number> {
  const values = new Set<number>();
  for (const match of tokens.matchAll(/--space-\d+:\s*(\d+(?:\.\d+)?)px\s*;/g)) values.add(Number(match[1]));
  return values;
}

/** scale: a literal px outside var() must be 0..2 or a multiple of 4, and must not repeat a --space-N value. */
function checkScale(css: string, tokens: string): string[] {
  const space = spaceValues(tokens);
  const errors: string[] = [];
  for (const rule of parseRules(css)) {
    for (const [prop, value] of rule.decls) {
      if (!SCALE_PROPS.has(prop)) continue;
      const literal = value.replace(/var\([^)]*\)/g, ' ');
      for (const match of literal.matchAll(/(-?\d*\.?\d+)px\b/g)) {
        const magnitude = Math.abs(Number(match[1]));
        if (magnitude <= 2) continue;
        if (magnitude % 4 !== 0) errors.push(`scale: ${rule.selector} { ${prop}: ${value} } has ${match[1]}px, not a multiple of 4`);
        else if (space.has(magnitude)) errors.push(`scale: ${rule.selector} { ${prop}: ${value} } has ${match[1]}px, which is a --space-N value; use the token`);
      }
    }
  }
  return errors;
}

const SURFACE_SELECTOR = /section|panel|hero|footer|band|block|col\b|__col|card|cta|dark|invert/i;
const SURFACE_STATE = /:hover|:focus|:active|::/;
const SURFACE_VALUE = /^var\(\s*--(?:bg|surface|surface-2|surface-3|accent-tint|skeleton|state-[a-z]+-tint)\s*\)$/;

/** surface-text: a surface-like rule that paints a surface background must also declare `color`. */
function checkSurfaceText(css: string): string[] {
  const errors: string[] = [];
  for (const rule of parseRules(css)) {
    if (!SURFACE_SELECTOR.test(rule.selector) || SURFACE_STATE.test(rule.selector)) continue;
    const backgrounds = [...declared(rule, 'background'), ...declared(rule, 'background-color')];
    const surface = backgrounds.find((value) => SURFACE_VALUE.test(value));
    if (surface !== undefined && declared(rule, 'color').length === 0) errors.push(`surface-text: ${rule.selector} sets background ${surface} without a text colour`);
  }
  return errors;
}

/** eyebrow: a rule for an `eyebrow` class must not set uppercase or tracked letter-spacing. */
function checkEyebrow(css: string): string[] {
  const errors: string[] = [];
  for (const rule of parseRules(css)) {
    const parts = selectorParts(rule.selector).filter((part) => /\.[\w-]*eyebrow[\w-]*/i.test(part));
    if (parts.length === 0) continue;
    if (declared(rule, 'text-transform').includes('uppercase')) errors.push(`eyebrow: ${parts[0]} sets text-transform: uppercase`);
    for (const value of declared(rule, 'letter-spacing')) {
      if (!/^(?:0(?:px|em|rem)?|normal|none)$/i.test(value)) errors.push(`eyebrow: ${parts[0]} sets letter-spacing: ${value}`);
    }
  }
  return errors;
}

/** All four predicates over a stylesheet text. */
function checkAll(css: string, tokens: string): string[] {
  return [...checkClip(css), ...checkScale(css, tokens), ...checkSurfaceText(css), ...checkEyebrow(css)];
}

/** Replace `from` with `to` and assert the text changed, so a stale search string cannot pass vacuously. */
function mutate(text: string, from: string | RegExp, to: string): string {
  const changed = text.replace(from, to);
  assert.notEqual(changed, text, `the mutation applied: ${String(from)}`);
  return changed;
}

const countOf = (errors: string[], rule: string) => errors.filter((e) => e.startsWith(`${rule}:`)).length;

// ---- tests --------------------------------------------------------------------------------------

test('the shipped files pass all four predicates', () => {
  const found = checkAll(`${appCss}\n${inlineStyles(indexHtml)}`, tokensCss);
  const counts = ['clip', 'scale', 'surface-text', 'eyebrow'].map((rule) => `${rule} ${countOf(found, rule)}`).join(', ');
  assert.ok(found.length === 0, `${found.length} findings (${counts}):\n${found.join('\n')}`);
});

test('clip control: removing overflow-x: clip from html, or from body, or using hidden, fails with a clip: finding', () => {
  // Start from a copy of app.css that holds the clip on both elements, whatever state the shipped file is in.
  const bare = appCss.replace(/overflow-x:\s*clip\s*;?/g, '');
  const both = mutate(mutate(bare, /(^|\n)(\s*)html \{/, '$1$2html { overflow-x: clip;'), /(^|\n)(\s*)body \{/, '$1$2body { overflow-x: clip;');
  assert.deepEqual(checkClip(both), [], 'html and body both clipping passes');

  const htmlOnly = mutate(both, /(\n\s*)body \{ overflow-x: clip;/, '$1body {');
  assert.deepEqual(checkClip(htmlOnly), [], 'html alone satisfies the rule');
  const bodyOnly = mutate(both, /(\n\s*)html \{ overflow-x: clip;/, '$1html {');
  assert.deepEqual(checkClip(bodyOnly), [], 'body alone satisfies the rule');

  const neither = mutate(htmlOnly, /(\n\s*)html \{ overflow-x: clip;/, '$1html {');
  assert.ok(checkClip(neither).some((e) => e.startsWith('clip:')), 'removed from both html and body');

  const hidden = mutate(mutate(neither, /(^|\n)(\s*)html \{/, '$1$2html { overflow-x: hidden;'), /(\n\s*)body \{/, '$1body { overflow-x: hidden;');
  assert.ok(checkClip(hidden).some((e) => e.startsWith('clip:')), 'hidden does not satisfy clip');
});

const FIXTURE = [
  'html { overflow-x: clip; }',
  '.x-pad { margin: SEED; }',
  '.x-card { background: var(--surface-2); color: var(--text); }',
  '.x__eyebrow { font: var(--type-xs); color: var(--text-muted); }',
].join('\n');

test('scale control: 5px and a --space-2 duplicate fail; 2px and a var() pass', () => {
  assert.deepEqual(checkScale(mutate(FIXTURE, 'SEED', '2px'), tokensCss), [], '2px is a hairline and passes');
  assert.deepEqual(checkScale(mutate(FIXTURE, 'SEED', 'var(--space-2)'), tokensCss), []);
  assert.deepEqual(checkScale(mutate(FIXTURE, 'SEED', '0 0 0 var(--space-1)'), tokensCss), []);
  const odd = checkScale(mutate(FIXTURE, '.x-pad { margin: SEED; }', '.x-pad { margin: 5px 0 0; }'), tokensCss);
  assert.equal(odd.length, 1, odd.join('\n'));
  assert.ok(odd[0].startsWith('scale:'));
  const longhand = checkScale(mutate(FIXTURE, '.x-pad { margin: SEED; }', '.x-pad { margin-inline: 8px; }'), tokensCss);
  assert.equal(longhand.length, 1, longhand.join('\n'));
  assert.ok(longhand[0].startsWith('scale:'));
  const gap = checkScale(mutate(FIXTURE, '.x-pad { margin: SEED; }', '.x-pad { padding: 0 7px; gap: 16px; }'), tokensCss);
  assert.equal(gap.length, 2, gap.join('\n'));
  assert.deepEqual(checkScale(mutate(FIXTURE, '.x-pad { margin: SEED; }', '.x-pad { margin-inline-start: 11px; }'), tokensCss), [], 'a two-segment longhand is out of scope');
});

test('surface-text control: a surface background without colour fails; with colour, or on :hover, it passes', () => {
  assert.deepEqual(checkSurfaceText(mutate(FIXTURE, 'SEED', '0')), [], 'the fixture is clean');
  const bare = mutate(FIXTURE, ' color: var(--text); }\n.x__', ' }\n.x__');
  const found = checkSurfaceText(bare);
  assert.equal(found.length, 1, found.join('\n'));
  assert.ok(found[0].startsWith('surface-text: .x-card'));
  assert.deepEqual(checkSurfaceText(mutate(bare, 'var(--surface-2); }', 'var(--surface-2); color: var(--text); }')), []);
  assert.deepEqual(checkSurfaceText(mutate(bare, '.x-card {', '.x-card:hover {')), [], 'a :hover rule is exempt');
  assert.deepEqual(checkSurfaceText(mutate(bare, '.x-card {', '.x-card::before {')), [], 'a pseudo-element rule is exempt');
  const tinted = checkSurfaceText(mutate(bare, 'var(--surface-2)', 'var(--state-failed-tint)'));
  assert.equal(tinted.length, 1, 'a state tint counts as a surface');
  assert.deepEqual(checkSurfaceText(mutate(bare, 'var(--surface-2)', 'transparent')), [], 'a non-surface background is out of scope');
});

test('eyebrow control: uppercase or tracked caps on an eyebrow class fails; plain eyebrows pass', () => {
  assert.deepEqual(checkEyebrow(mutate(FIXTURE, 'SEED', '0')), [], 'the fixture is clean');
  const seeded = mutate(FIXTURE, 'font: var(--type-xs);', 'text-transform: uppercase; letter-spacing: var(--tracking-caps); font: var(--type-xs);');
  const found = checkEyebrow(seeded);
  assert.equal(found.length, 2, found.join('\n'));
  assert.ok(found.every((e) => e.startsWith('eyebrow: .x__eyebrow')));
  assert.equal(checkEyebrow(mutate(FIXTURE, 'font: var(--type-xs);', 'letter-spacing: 0.1em;')).length, 1);
  assert.deepEqual(checkEyebrow(mutate(FIXTURE, 'font: var(--type-xs);', 'letter-spacing: normal;')), []);
  assert.deepEqual(checkEyebrow(mutate(FIXTURE, '.x__eyebrow {', '.x__label {').replace('font: var(--type-xs);', 'text-transform: uppercase;')), [], 'a non-eyebrow label is out of scope');
});

test('non-application control (DEC-003): capital-letter heads and status labels are not reported, and no stamp is required', () => {
  const labels = [
    'html { overflow-x: clip; }',
    '.ttable thead th { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.srow__colhead { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.tile__label { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.gate-card__kind { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.srows__heads { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.graph__layerhead { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
    '.wf__tag { text-transform: uppercase; letter-spacing: var(--tracking-caps); }',
  ].join('\n');
  assert.ok(!/stamp/i.test(labels), 'the fixture carries no stamp comment');
  assert.deepEqual(checkAll(labels, tokensCss), []);
  assert.equal(Object.keys({ checkClip, checkScale, checkSurfaceText, checkEyebrow }).some((name) => /stamp/i.test(name)), false, 'the guard has no stamp predicate');
});

test('the mutation helper asserts the text changed before any failure is asserted', () => {
  assert.throws(() => mutate('a { margin: 8px; }', 'no such text', 'x'), /the mutation applied/);
  assert.equal(mutate('a { margin: 8px; }', '8px', '5px'), 'a { margin: 5px; }');
});
