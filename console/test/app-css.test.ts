'use strict';

// Checks over web/app.css (180 review). In forced colours a 4 px start edge (`border-inline-start-width`) carries what the
// state colour did, so no later rule of the same layer may reset it with a border shorthand; rules are matched by the exact
// selector, so specificity is not computed (a later, more specific reset is not caught). And every component block of the file
// is used by a file of console/web/: a block counts as used when a script or page names the block or one of its classes as a
// whole word, or builds one from a template (`block--${`); a name in a comment counts too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classNames, componentBlocks } = require('../scripts/build-design-md.ts');

const WEB = path.join(__dirname, '..', 'web');
const APP_CSS: string = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');

/** The text of every script and page under console/web/. */
function webSources(): string {
  const texts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name)) texts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(WEB);
  return texts.join('\n');
}

type Rule = { order: number, selectors: string[], props: string[], layer: string | null, media: string[] };

/** Every style rule in source order, with its layer (null when unlayered), the @media preludes around it and the properties it sets. */
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (start: number, end: number, layer: string | null, media: string[]) => {
    let index = start;
    while (index < end) {
      const open = text.indexOf('{', index);
      if (open === -1 || open >= end) return;
      const prelude = text.slice(index, open).split(/[;}]/).pop()!.trim();
      let depth = 1;
      let close = open + 1;
      for (; depth > 0; close += 1) depth += text[close] === '{' ? 1 : text[close] === '}' ? -1 : 0;
      if (prelude.startsWith('@layer')) walk(open + 1, close - 1, prelude.slice('@layer'.length).trim(), media);
      else if (prelude.startsWith('@media')) walk(open + 1, close - 1, layer, [...media, prelude]);
      else if (!prelude.startsWith('@')) {
        const props = text.slice(open + 1, close - 1).split(';').map((d) => d.slice(0, d.indexOf(':')).trim().toLowerCase()).filter(Boolean);
        rules.push({ order: rules.length, selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), props, layer, media });
      }
      index = close;
    }
  };
  walk(0, text.length, null, []);
  return rules;
}

/** The shorthands that set `border-inline-start-width` again. */
const RESETS = new Set(['border', 'border-width', 'border-inline', 'border-inline-width', 'border-inline-start', 'border-inline-start-width']);
const forced = (rule: Rule) => rule.media.some((m) => m.includes('forced-colors: active'));

/** `selector: the later rule` for each forced-colours start edge a later rule of the same layer resets; empty when every edge holds. */
function resetEdges(css: string): string[] {
  const rules = rulesOf(css);
  const found: string[] = [];
  for (const edge of rules.filter((rule) => forced(rule) && rule.props.includes('border-inline-start-width'))) {
    for (const selector of edge.selectors) {
      const later = rules.find((rule) => rule.order > edge.order && rule.layer === edge.layer && rule.selectors.includes(selector)
        && rule.props.some((prop) => RESETS.has(prop)) && (rule.media.length === 0 || forced(rule)));
      if (later) found.push(`${selector}: ${later.selectors.join(', ')}`);
    }
  }
  return found;
}

test('in forced colours every 4 px start edge holds: no later rule of its layer resets it with a border shorthand', () => {
  const edges = rulesOf(APP_CSS).filter((rule) => forced(rule) && rule.props.includes('border-inline-start-width')).flatMap((rule) => rule.selectors);
  assert.ok(edges.includes('.activity'), 'the run view\'s activity slot has one');
  assert.deepEqual(resetEdges(APP_CSS), []);
});

test('control: a later forced-colours border on the same selector is reported', () => {
  const planted = `${APP_CSS}\n@media (forced-colors: active) { .gcard { border: 1px solid CanvasText; } }\n`;
  assert.ok(resetEdges(planted).includes('.gcard: .gcard'));
});

const word = (name: string) => new RegExp(`(?<![\\w-])${name.replace(/-/g, '\\-')}(?![\\w-])`);

/** The component blocks of `css` no script or page of `sources` uses. */
function unusedBlocks(css: string, sources: string): string[] {
  const names: string[] = classNames(css);
  return componentBlocks(css).filter((block: string) => {
    const own = names.filter((name) => name === block || name.startsWith(`${block}__`) || name.startsWith(`${block}--`));
    return !own.some((name) => word(name).test(sources)) && !new RegExp(`(?<![\\w-])${block.replace(/-/g, '\\-')}(?:__|--)\\$\\{`).test(sources);
  });
}

test('every component block of app.css is used by a script or page of console/web/', () => {
  assert.deepEqual(unusedBlocks(APP_CSS, webSources()), []);
});

test('control: a block no file uses is reported; one named only through its element, or built from a template, is not', () => {
  const planted = `${APP_CSS}\n@layer components { .zz-unused { color: var(--text); } .zz-elem__part { color: var(--text); } .zz-built--on { color: var(--text); } }\n`;
  assert.deepEqual(unusedBlocks(planted, `${webSources()}\nh('p', { class: 'zz-elem__part' }); const c = \`zz-built--\${state}\`;`), ['zz-unused']);
});
