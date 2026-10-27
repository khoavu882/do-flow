'use strict';

// DESIGN.md drift guard (feature 133). console/DESIGN.md carries two blocks generated from web/tokens.css
// and web/app.css by scripts/build-design-md.ts. This test proves they equal the current CSS, that a planted
// change (a value, a removed token, a new class block) is reported as drift, that every token and class the
// hand-written prose names exists in the CSS, and, when the source design-system document can be found, that
// every token it lists exists in tokens.css. That document lives in the ignored agent-docs/ tree, so the
// last check says so and skips when it is absent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DESIGN_FILE, TOKENS_FILE, APP_FILE, SCRIPT_FILE, classNames, parseRules, componentBlocks, proseOf, render, check } = require('../scripts/build-design-md.ts');

const design: string = fs.readFileSync(DESIGN_FILE, 'utf8');
const tokensCss: string = fs.readFileSync(TOKENS_FILE, 'utf8');
const appCss: string = fs.readFileSync(APP_FILE, 'utf8');

/** Names of the custom properties tokens.css declares anywhere. */
const declared = new Set<string>(parseRules(tokensCss).flatMap((rule: { decls: Array<[string, string]> }) => rule.decls.map(([name]) => name)));

/** `--name` references in a text, as a token reference (not the `--` of a BEM modifier), without partial names like `--state-`. */
function tokenNames(text: string): string[] {
  return [...new Set<string>([...text.matchAll(/(?<![\w-])(--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w-])/g)].map((match) => match[1]))];
}

test('DESIGN.md equals the output generated from the current tokens.css and app.css', () => {
  const { ok, expected } = check(design, tokensCss, appCss);
  assert.ok(ok, 'console/DESIGN.md drifted from the CSS. Run: node console/scripts/build-design-md.ts --write');
  assert.equal(render(expected, tokensCss, appCss), expected, 'render is idempotent');
});

test('the check mode of the CLI exits 0 on the shipped files', () => {
  const run = spawnSync(process.execPath, [SCRIPT_FILE], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

test('control: a token value changed in DESIGN.md is reported as drift', () => {
  const planted = design.replace('--accent: #5B2FD0 | #B69CFF', '--accent: #5B2FD1 | #B69CFF');
  assert.notEqual(planted, design, 'the mutation applied');
  assert.equal(check(planted, tokensCss, appCss).ok, false);
});

test('control: a token removed from the CSS is reported as drift', () => {
  const removed = tokensCss.replace('  --space-3: 12px;\n', '');
  assert.notEqual(removed, tokensCss, 'the mutation applied');
  assert.equal(check(design, removed, appCss).ok, false);
});

test('control: a token added to the CSS, and a new class block, are reported as drift', () => {
  assert.equal(check(design, tokensCss.replace('  --space-3: 12px;\n', '  --space-3: 12px;\n  --space-9: 72px;\n'), appCss).ok, false);
  assert.equal(check(design, tokensCss, `${appCss}\n.zz-new-block { color: var(--text); }\n`).ok, false);
});

test('control: a component list edited by hand is reported as drift', () => {
  const planted = design.replace('`.badge`, ', '');
  assert.notEqual(planted, design, 'the mutation applied');
  assert.equal(check(planted, tokensCss, appCss).ok, false);
});

test('the component list is the sorted, de-duplicated set of top-level blocks', () => {
  const blocks: string[] = componentBlocks(appCss);
  assert.deepEqual(blocks, [...new Set(blocks)].sort());
  for (const block of ['badge', 'rail', 'banner', 'btn', 'cmd', 'conn', 'segmented', 'skel', 'empty', 'state-panel']) assert.ok(blocks.includes(block), `.${block} is a block`);
  assert.ok(!blocks.some((block) => block.includes('__') || block.includes('--')), 'no element or modifier is listed as a block');
});

test('every --token named in the prose exists in tokens.css', () => {
  const prose = proseOf(design).replace(/`node [^`]*`/g, ''); // a shell command's flags (--write) are not tokens
  const named = tokenNames(prose);
  assert.ok(named.length > 20, 'the prose names tokens');
  assert.deepEqual(named.filter((name) => !declared.has(name)), [], 'tokens named in DESIGN.md prose but absent from tokens.css');
});

test('control: a token that tokens.css does not declare is caught in prose', () => {
  const planted = `${proseOf(design)}\nUse \`--no-such-token\` here.\n`;
  assert.ok(tokenNames(planted).some((name) => !declared.has(name)));
});

test('every `.class` named in the prose exists in app.css', () => {
  const known = new Set<string>(classNames(appCss));
  const named: string[] = [...proseOf(design).matchAll(/`\.([a-z][a-z0-9_-]*)`/g)].map((match) => match[1]);
  assert.ok(named.length > 20, 'the prose names classes');
  assert.deepEqual(named.filter((name) => !known.has(name)), [], 'classes named in DESIGN.md prose but absent from app.css');
});

test('DESIGN.md stays under 400 lines', () => {
  const lines = design.split('\n').length;
  assert.ok(lines < 400, `DESIGN.md has ${lines} lines`);
});

test('every token the design-system document lists exists in tokens.css (when that document can be found)', (t) => {
  const relative = path.join('agent-docs', 'doflow', '093-console-web-ui', 'design', 'design-system.md');
  const repo = path.join(__dirname, '..', '..');
  const found = [path.join(repo, relative), path.join(repo, '..', 'do-flow', relative)].find((file) => fs.existsSync(file));
  if (!found) {
    t.skip('design/design-system.md is not reachable from this checkout (it lives in the ignored agent-docs/ tree)');
    return;
  }
  const doc = fs.readFileSync(found, 'utf8');
  const listed = new Set<string>();
  for (const match of doc.matchAll(/`(--[a-z][a-z0-9-]*[a-z0-9])`/g)) listed.add(match[1]);
  assert.ok(listed.size > 50, 'the document lists tokens');
  assert.deepEqual([...listed].filter((name) => !declared.has(name)), [], 'tokens listed in design-system.md but absent from tokens.css');
});
