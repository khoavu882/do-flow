'use strict';

// Design-system conformance (feature 093, IC-017; plan task D.2). `checkTokens` is a pure function over the
// text of web/tokens.css: it parses the custom properties of `:root`, `[data-theme="dark"]` and the
// `prefers-color-scheme: dark` block, requires the dark blocks to be identical, requires every token of the
// design system to exist in the blocks that must hold it, and recomputes the WCAG 2.2 contrast of every
// pair of design-system section 3 against its bar. Each rule has a control that runs the check on a
// planted mutation of the text and expects that rule to fail.
//
// The token list and the pair rules are held here (section 2 and 3 of design/design-system.md). That file
// is not in the package or in a clean checkout, so the last test cross-checks the list against it only when
// it can be found next to the checkout, and says so when it cannot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOKENS_FILE = path.join(__dirname, '..', 'web', 'tokens.css');

// ---- the design system (section 2) -------------------------------------------------------------

/** The six states that sit on --surface-3 (design-system 3, V8 additions). */
const V8_STATES = ['running', 'done', 'failed', 'stale', 'unknown', 'awaiting'];
const STATES = ['running', 'awaiting', 'done', 'rejected', 'failed', 'skipped', 'pending', 'stale', 'unknown'];
const NEUTRALS = ['bg', 'surface', 'surface-2', 'surface-3', 'border', 'border-strong', 'text', 'text-muted', 'accent', 'accent-tint', 'on-accent', 'focus', 'skeleton', 'skeleton-shine', 'scrim'];

/** Tokens that differ per theme: they exist in :root and in both dark blocks. */
const THEMED = [
  ...NEUTRALS.map((name) => `--${name}`),
  '--elev-1', '--elev-2',
  ...STATES.flatMap((state) => ['fg', 'tint', 'mark'].map((part) => `--state-${state}-${part}`)),
];

/** Theme-invariant tokens: :root only. */
const INVARIANT = [
  '--font-sans', '--font-mono',
  '--type-xs', '--type-sm', '--type-md', '--type-lg', '--type-xl', '--type-display',
  '--tracking-tight', '--tracking-display', '--tracking-caps',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `--space-${n}`),
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill',
  '--motion-fast', '--motion-base', '--motion-slow', '--motion-flash', '--motion-pulse', '--motion-march', '--motion-shimmer',
  '--ease-standard', '--ease-exit', '--ease-settle',
  '--content-max', '--prose-max', '--gutter', '--header-h', '--target', '--target-min', '--focus-width', '--focus-offset',
  '--z-banner', '--z-header', '--z-panel', '--z-skip',
];

// ---- parsing ------------------------------------------------------------------------------------

type Rule = { at: string | null, selector: string, decls: Map<string, string> };

/** Every style rule of the text with the at-rule prelude that wraps it (null at top level). */
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
        const decls = new Map<string, string>();
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon === -1) continue;
          const name = part.slice(0, colon).trim();
          if (name.startsWith('--')) decls.set(name, part.slice(colon + 1).trim());
        }
        rules.push({ at, selector: prelude, decls });
      }
      index = close;
    }
  };
  walk(text, null);
  return rules;
}

const pick = (rules: Rule[], at: string | null, selector: string) => rules.find((rule) => rule.at === at && rule.selector === selector);
const DARK_MEDIA = '@media (prefers-color-scheme: dark)';
const DARK_MEDIA_SELECTOR = ':root:not([data-theme="light"])';

// ---- WCAG 2.2 contrast --------------------------------------------------------------------------

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The pair list of design-system section 3: `[foreground, background, bar]`. */
function pairs(): Array<[string, string, number]> {
  const list: Array<[string, string, number]> = [];
  for (const surface of ['bg', 'surface', 'surface-2', 'surface-3']) {
    for (const fg of ['text', 'text-muted', 'accent']) list.push([`--${fg}`, `--${surface}`, 4.5]);
    for (const fg of ['focus', 'border-strong']) list.push([`--${fg}`, `--${surface}`, 3]);
  }
  list.push(['--accent', '--accent-tint', 4.5], ['--text', '--accent-tint', 4.5], ['--on-accent', '--accent', 4.5]);
  list.push(['--accent', '--state-awaiting-tint', 4.5]); // CD-B10: the links on the Sessions conflict bar
  for (const state of STATES) {
    const fg = `--state-${state}-fg`;
    const mark = `--state-${state}-mark`;
    const tint = `--state-${state}-tint`;
    for (const on of ['--surface', '--bg', '--surface-2', tint]) list.push([fg, on, 4.5]);
    for (const text of ['--text', '--text-muted']) list.push([text, tint, 4.5]);
    for (const on of ['--surface', '--bg', '--surface-2', tint]) list.push([mark, on, 3]);
    list.push(['--focus', tint, 3]);
  }
  // V8 Fleet (V.9, design-system 3): the 768 sheet and the E.3 side panel put state words and glyphs on --surface-3.
  for (const state of V8_STATES) {
    list.push([`--state-${state}-fg`, '--surface-3', 4.5]);
    list.push([`--state-${state}-mark`, '--surface-3', 3]);
  }
  return list;
}

// ---- the check ----------------------------------------------------------------------------------

/** Every failure as `<rule>: <detail>`; an empty list means the file conforms. */
function checkTokens(css: string): string[] {
  const errors: string[] = [];
  const rules = parseRules(css);
  const root = pick(rules, null, ':root');
  const dark = pick(rules, null, '[data-theme="dark"]');
  const media = pick(rules, DARK_MEDIA, DARK_MEDIA_SELECTOR);
  if (!root) errors.push('blocks: no :root block');
  if (!dark) errors.push('blocks: no [data-theme="dark"] block');
  if (!media) errors.push('blocks: no prefers-color-scheme dark block');
  if (!root || !dark || !media) return errors;

  for (const name of [...THEMED, ...INVARIANT]) {
    if (!root.decls.has(name)) errors.push(`missing-root: ${name} is not in :root`);
  }
  for (const name of THEMED) {
    if (!dark.decls.has(name)) errors.push(`missing-dark: ${name} is not in [data-theme="dark"]`);
    if (!media.decls.has(name)) errors.push(`missing-dark-media: ${name} is not in the prefers-color-scheme dark block`);
  }
  for (const name of new Set([...dark.decls.keys(), ...media.decls.keys()])) {
    if (dark.decls.get(name) !== media.decls.get(name)) errors.push(`dark-parity: ${name} differs between the attribute block and the media block`);
  }

  const light = new Map(root.decls);
  const night = new Map(root.decls);
  for (const [name, value] of dark.decls) night.set(name, value);
  const HEX = /^#[0-9A-Fa-f]{6}$/;
  for (const [theme, values] of [['light', light], ['dark', night]] as const) {
    for (const [fg, bg, bar] of pairs()) {
      const [a, b] = [values.get(fg), values.get(bg)];
      if (a === undefined || b === undefined || !HEX.test(a) || !HEX.test(b)) {
        errors.push(`contrast-input: ${theme} ${fg} on ${bg} is not a #RRGGBB pair`);
        continue;
      }
      const ratio = contrast(a, b);
      if (ratio < bar) errors.push(`contrast: ${theme} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, bar ${bar}:1`);
    }
  }
  return errors;
}

// ---- tests --------------------------------------------------------------------------------------

const shipped = fs.readFileSync(TOKENS_FILE, 'utf8');

test('the shipped tokens.css conforms: every token, dark parity, and all 270 contrast pairs', () => {
  assert.equal(pairs().length, 135, '135 pairs per theme (design-system 3, with the CD-B10 pair and the 12 V8 pairs on --surface-3)');
  assert.deepEqual(checkTokens(shipped), []);
});

test('the pair list is the one of design-system section 3 (spot checks on the lowest figures)', () => {
  const rules = parseRules(shipped);
  const root = pick(rules, null, ':root')!.decls;
  assert.ok(contrast(root.get('--text-muted')!, root.get('--surface-2')!) >= 6.7);
  assert.ok(contrast(root.get('--state-running-fg')!, root.get('--state-running-tint')!) >= 6.1);
});

test('control: one pair lowered under its bar turns the check red', () => {
  const lowered = shipped.replace('--text-muted: #4A5463;', '--text-muted: #9AA3B0;');
  assert.notEqual(lowered, shipped, 'the mutation applied');
  const errors = checkTokens(lowered);
  assert.ok(errors.some((e) => e.startsWith('contrast: light --text-muted on --surface')), errors.join('\n'));
});

test('control: the 24 V8 pairs are checked: --surface-3 moved to a mid grey turns each state word and mark on it red, in the dark theme', () => {
  const [head, tail] = shipped.split('[data-theme="dark"] {');
  const lowered = `${head}[data-theme="dark"] {${tail.replace('--surface-3: #212A36;', '--surface-3: #5A6475;')}`;
  assert.notEqual(lowered, shipped);
  const errors = checkTokens(lowered);
  for (const state of V8_STATES) {
    assert.ok(errors.some((e) => e.startsWith(`contrast: dark --state-${state}-fg on --surface-3`)), `${state} fg on --surface-3 is checked`);
    assert.ok(errors.some((e) => e.startsWith(`contrast: dark --state-${state}-mark on --surface-3`)), `${state} mark on --surface-3 is checked`);
  }
  const pairList = pairs().filter(([fg, bg]) => bg === '--surface-3' && fg.startsWith('--state-'));
  assert.equal(pairList.length * 2, 24, '12 pairs per theme, 24 in all');
});

test('control: a V8 pair lowered under its bar in the light theme turns the check red', () => {
  const lowered = shipped.replace('--state-unknown-mark: #7D8797;', '--state-unknown-mark: #B5BCC8;');
  assert.notEqual(lowered, shipped);
  assert.ok(checkTokens(lowered).some((e) => e.startsWith('contrast: light --state-unknown-mark on --surface-3')));
});

test('control: a dark-theme pair lowered under its bar turns the check red', () => {
  const [head, tail] = shipped.split('[data-theme="dark"] {');
  const lowered = `${head}[data-theme="dark"] {${tail.replace('--state-failed-fg: #FF8A8A;', '--state-failed-fg: #5A2A2A;')}`;
  assert.notEqual(lowered, shipped);
  assert.ok(checkTokens(lowered).some((e) => e.startsWith('contrast: dark --state-failed-fg')));
});

test('control: one token removed from the dark attribute block turns the check red', () => {
  const [head, tail] = shipped.split('[data-theme="dark"] {');
  const removed = `${head}[data-theme="dark"] {${tail.replace('  --accent-tint: #2A2148;\n', '')}`;
  assert.notEqual(removed, shipped);
  const errors = checkTokens(removed);
  assert.ok(errors.some((e) => e.startsWith('missing-dark: --accent-tint')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('dark-parity: --accent-tint')));
});

test('control: a value changed in the media block only breaks dark parity', () => {
  const index = shipped.indexOf(DARK_MEDIA);
  const changed = shipped.slice(0, index) + shipped.slice(index).replace('--accent: #B69CFF;', '--accent: #B69CFE;');
  assert.notEqual(changed, shipped);
  assert.ok(checkTokens(changed).some((e) => e.startsWith('dark-parity: --accent')));
});

test('control: a token removed from :root turns the check red', () => {
  const removed = shipped.replace('  --space-3: 12px;\n', '');
  assert.notEqual(removed, shipped);
  assert.ok(checkTokens(removed).some((e) => e.startsWith('missing-root: --space-3')));
});

test('tokens.css styles no element', () => {
  for (const rule of parseRules(shipped)) {
    assert.ok(/^(?::root(?::not\(\[data-theme="light"\]\))?|\[data-theme="dark"\])$/.test(rule.selector), `unexpected selector ${rule.selector}`);
  }
});

test('the pair list equals the count design-system section 3 states (when that file can be found)', (t) => {
  const relative = path.join('agent-docs', 'doflow', '093-console-web-ui', 'design', 'design-system.md');
  const repo = path.join(__dirname, '..', '..');
  const found = [path.join(repo, relative), path.join(repo, '..', 'do-flow', relative)].find((file) => fs.existsSync(file));
  if (!found) {
    t.skip('design/design-system.md is not reachable from this checkout (it lives in the ignored agent-docs/ tree)');
    return;
  }
  const doc = fs.readFileSync(found, 'utf8');
  const stated = /That is (\d+) pairs per theme, (\d+) in all/.exec(doc);
  assert.ok(stated, 'section 3 states its pair count');
  assert.equal(pairs().length, Number(stated![1]));
  assert.equal(pairs().length * 2, Number(stated![2]));
});

test('the token list matches section 2 of design/design-system.md (when that file can be found)', (t) => {
  const relative = path.join('agent-docs', 'doflow', '093-console-web-ui', 'design', 'design-system.md');
  const repo = path.join(__dirname, '..', '..');
  const found = [path.join(repo, relative), path.join(repo, '..', 'do-flow', relative)].find((file) => fs.existsSync(file));
  if (!found) {
    t.skip('design/design-system.md is not reachable from this checkout (it lives in the ignored agent-docs/ tree)');
    return;
  }
  const doc = fs.readFileSync(found, 'utf8');
  const section = doc.slice(doc.indexOf('## 2. Tokens'), doc.indexOf('## 3. Contrast proof'));
  const named = new Set<string>();
  for (const match of section.matchAll(/`(--[a-z0-9-]+)`/g)) named.add(match[1]);
  for (const state of STATES) for (const part of ['fg', 'tint', 'mark']) named.add(`--state-${state}-${part}`);
  const known = new Set([...THEMED, ...INVARIANT]);
  const unknown = [...named].filter((name) => !known.has(name) && !name.endsWith('-'));
  assert.deepEqual(unknown, [], 'every token named in section 2 is checked by this file');
  assert.deepEqual([...known].filter((name) => !shipped.includes(`${name}:`)), []);
});
