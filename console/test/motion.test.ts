'use strict';

// Motion conformance (feature 149, IC-022, DEC-038; plan task D.5). `checkMotion` is a pure function over the text
// of web/app.css: every @keyframes block declares only transform, opacity and SVG stroke properties; every animated
// host is stopped by the reduced-motion rule and by the stale rule of the `states` layer; an infinite animation runs
// only under [data-loop="on"]. Each rule has a control that plants a mutation into the text and expects that rule to
// fail. The Run and Now fixtures (at most one marked element per view) are in client-core.test.ts, beside the fake DOM.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const APP_CSS = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');
const TOKENS_CSS = fs.readFileSync(path.join(WEB, 'tokens.css'), 'utf8');

const ALLOWED = new Set(['transform', 'opacity', 'stroke-dashoffset', 'stroke-dasharray', 'stroke-opacity']);
const LAYERS = '@layer base, layout, components, states, motion;';
const REDUCE = '(prefers-reduced-motion: reduce)';
const ROOTS = ['#main[data-stale="true"]', '#inspector[data-stale="true"]'];
/** Hosts that live outside #main and #inspector, with why they may move while the data is stale. */
const OUTSIDE = new Map([
  ['.banner', 'the stale banner itself: one opacity fade as it arrives'],
  ['.banner--leaving', 'the stale banner itself: one opacity fade as it leaves'],
]);
/** Blocks of the page frame outside #main and #inspector (their BEM elements and modifiers too): a host that names one must be in OUTSIDE. */
const FRAME = ['.site-header', '.banner', '.banner-slot', '.navrail', '.palette', '.skip', '.shell'];

// ---- parsing ------------------------------------------------------------------------------------

type Rule = { selector: string, decls: Map<string, string>, context: string[] };
type Keyframes = { name: string, props: string[] };

function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces');
}

const declsOf = (body: string) => new Map(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const at = d.indexOf(':');
  return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()] as [string, string];
}));

/** Every style rule with the at-rule preludes around it, and every @keyframes block with the properties it declares. */
function parse(css: string): { rules: Rule[], keyframes: Keyframes[], firstLayer: string | null } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const keyframes: Keyframes[] = [];
  const walk = (source: string, context: string[]) => {
    let index = 0;
    while (index < source.length) {
      const open = source.indexOf('{', index);
      if (open === -1) break;
      const prelude = source.slice(index, open).split(/[;}]/).pop()!.trim();
      const close = closeOf(source, open);
      const body = source.slice(open + 1, close);
      if (prelude.startsWith('@keyframes')) {
        const props: string[] = [];
        const frames = /([^{}]+)\{([^{}]*)\}/g;
        for (let m = frames.exec(body); m; m = frames.exec(body)) props.push(...declsOf(m[2]).keys());
        keyframes.push({ name: prelude.slice('@keyframes'.length).trim(), props });
      } else if (prelude.startsWith('@')) walk(body, [...context, prelude]);
      else rules.push({ selector: prelude, decls: declsOf(body), context });
      index = close + 1;
    }
  };
  walk(text, []);
  const first = /@layer[^;{]*;/.exec(text);
  return { rules, keyframes, firstLayer: first ? first[0].replace(/\s+/g, ' ') : null };
}

const selectorsOf = (rule: Rule) => rule.selector.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
const layerOf = (rule: Rule) => rule.context.find((c) => c.startsWith('@layer')) ?? null;
const animationOf = (rule: Rule) => rule.decls.get('animation') ?? rule.decls.get('animation-name') ?? null;
const isStop = (rule: Rule) => /^none\s*!important$/.test(rule.decls.get('animation') ?? '');

// ---- the check ------------------------------------------------------------------------------------

/** Every way the text breaks IC-022, as one sentence each; empty when it conforms. */
function checkMotion(css: string): string[] {
  const { rules, keyframes, firstLayer } = parse(css);
  const problems: string[] = [];
  if (firstLayer !== LAYERS) problems.push(`the layer order is ${firstLayer}, not ${LAYERS}`);

  for (const frame of keyframes) {
    for (const prop of new Set(frame.props)) if (!ALLOWED.has(prop)) problems.push(`@keyframes ${frame.name} animates ${prop}`);
  }

  const stops = rules.filter((rule) => isStop(rule) && layerOf(rule) === '@layer states');
  const reduced = new Set(stops.filter((rule) => rule.context.includes(`@media ${REDUCE}`)).flatMap(selectorsOf));
  const stale = new Set(stops.filter((rule) => !rule.context.some((c) => c.startsWith('@media'))).flatMap(selectorsOf));
  for (const sel of ['*', '*::before', '*::after']) {
    if (!reduced.has(sel)) problems.push(`no reduced-motion stop in the states layer for ${sel}`);
  }
  for (const root of ROOTS) {
    for (const sel of [root, `${root} *`, `${root} *::before`, `${root} *::after`]) {
      if (!stale.has(sel)) problems.push(`no stale stop in the states layer for ${sel}`);
    }
  }

  const hosts = rules.filter((rule) => !isStop(rule) && animationOf(rule) !== null && !/^none\b/.test(animationOf(rule)!));
  if (hosts.length === 0) problems.push('no animated host found');
  for (const host of hosts) {
    if (layerOf(host) !== '@layer motion') problems.push(`${host.selector} animates outside the motion layer`);
    for (const sel of selectorsOf(host)) {
      const frame = FRAME.find((cls) => new RegExp(`${cls.replace(/[.[\]-]/g, '\\$&')}(?![a-z0-9]|-[a-z0-9])`).test(sel));
      if (frame && !OUTSIDE.has(sel)) problems.push(`${sel} lives outside #main and #inspector, so no stale stop reaches it`);
      const loops = /\binfinite\b/.test(animationOf(host)!) || host.decls.get('animation-iteration-count') === 'infinite';
      if (loops && !sel.includes('[data-loop="on"]')) problems.push(`${sel} loops without [data-loop="on"]`);
    }
  }
  return problems;
}

// ---- the shipped files ------------------------------------------------------------------------------

test('app.css conforms to IC-022: allowed keyframe properties, stop rules for every host, loops only under data-loop', () => {
  assert.deepEqual(checkMotion(APP_CSS), []);
});

test('the primitives of IC-022 exist and the old background-position and box-shadow keyframes are gone', () => {
  const names = parse(APP_CSS).keyframes.map((k) => k.name);
  for (const name of ['shimmer', 'flow', 'tint-decay', 'fade', 'gate-open', 'panel-in', 'panel-out', 'pulse', 'settle', 'view-in', 'banner-in', 'banner-out', 'draw']) {
    assert.ok(names.includes(name), `@keyframes ${name}`);
  }
  for (const gone of ['flash', 'march-x', 'march-y']) assert.ok(!names.includes(gone), `@keyframes ${gone} is replaced`);
});

test('every animated host is reached by the stop rules: the hosts outside the canvas are only the stale banner', () => {
  const { rules } = parse(APP_CSS);
  const hosts = rules.filter((rule) => !isStop(rule) && animationOf(rule) !== null && !/^none\b/.test(animationOf(rule)!)).flatMap(selectorsOf);
  assert.ok(hosts.includes('.flow-edge[data-loop="on"]::before'), 'the running connector flows');
  assert.ok(hosts.includes('.skeleton[data-loop="on"] .skel'), 'the skeleton breathes');
  assert.deepEqual(hosts.filter((sel) => OUTSIDE.has(sel)).sort(), ['.banner', '.banner--leaving']);
});

test('the motion tokens of IC-022 are in :root and 0ms under reduced motion', () => {
  const block = (re: RegExp) => (re.exec(TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')) ?? [])[1] ?? '';
  const root = block(/^:root\s*\{([^}]*)\}/m);
  const reduced = block(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/);
  for (const [name, value] of [['--motion-swap', '160ms'], ['--motion-row', '180ms'], ['--motion-gate', '240ms']]) {
    assert.match(root, new RegExp(`${name}:\\s*${value};`), `${name} in :root`);
    assert.match(reduced, new RegExp(`${name}:\\s*0ms;`), `${name} under reduced motion`);
  }
});

test('no file of console/web schedules a frame callback', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('requestAnimationFrame')) offenders.push(path.relative(WEB, full));
    }
  };
  walk(WEB);
  assert.deepEqual(offenders, []);
});

// ---- controls: each rule fails on a planted mutation --------------------------------------------------

test('control: a box-shadow keyframe fails', () => {
  const planted = `${APP_CSS}\n@layer motion { @keyframes planted { from { box-shadow: 0 0 0 0 var(--tint); } to { box-shadow: 0 0 0 6px var(--tint); } } }\n`;
  assert.deepEqual(checkMotion(planted), ['@keyframes planted animates box-shadow']);
});

test('control: an infinite animation without data-loop fails', () => {
  const planted = `${APP_CSS}\n@layer motion { .planted { animation: pulse 1s linear infinite; } }\n`;
  assert.deepEqual(checkMotion(planted), ['.planted loops without [data-loop="on"]']);
});

test('control: a missing stale stop for the inspector fails', () => {
  const planted = APP_CSS.replace('#inspector[data-stale="true"] *::after { animation: none !important; }', '#inspector[data-stale="true"] *::after { animation: none; }');
  assert.notEqual(planted, APP_CSS, 'the mutation applied');
  assert.ok(checkMotion(planted).includes('no stale stop in the states layer for #inspector[data-stale="true"]'));
});

test('control: a missing reduced-motion stop fails', () => {
  const planted = APP_CSS.replace('*, *::before, *::after { animation: none !important; }', '*::before { animation: none !important; }');
  assert.notEqual(planted, APP_CSS, 'the mutation applied');
  assert.deepEqual(checkMotion(planted), ['no reduced-motion stop in the states layer for *', 'no reduced-motion stop in the states layer for *::after']);
});

test('control: an animated host in the page frame fails', () => {
  const planted = `${APP_CSS}\n@layer motion { .navrail__link { animation: fade 1s both; } }\n`;
  assert.deepEqual(checkMotion(planted), ['.navrail__link lives outside #main and #inspector, so no stale stop reaches it']);
});

test('control: an animation outside the motion layer fails', () => {
  const planted = `${APP_CSS}\n@layer components { .tile { animation: fade 1s both; } }\n`;
  assert.deepEqual(checkMotion(planted), ['.tile animates outside the motion layer']);
});
