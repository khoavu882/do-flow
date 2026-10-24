'use strict';

/**
 * G40: operating-modes locators resolve (080 IC-027, DEC-012).
 *
 * docs/specs/operating-modes.md marks each task state and user control `implemented` or `target`
 * and cites the code behind an `implemented` claim as a `path#symbol` locator. G33.16 checks the
 * document's headings and state rows; this guard checks that the claims point at code that exists:
 *
 * - G40.1: every `implemented` row of Task states and User controls carries a `path#symbol`
 *   locator, and every `path#symbol` in the document names an existing file that declares the
 *   symbol (a `function`, `const`/`let`/`var` or `class` declaration, an `export { }` name, or a
 *   `module.exports` key).
 * - G40.2: the Manual / assisted cells of Pause, Cancel, Resume and Inspect are `implemented`.
 * - G40.3: no locator is a bare `path:line` form; a line number goes stale on the next edit.
 *
 * Each check is a pure function over injected text (the document, and a reader for source files),
 * so each control seeds one violation into a copy and expects exactly one named finding.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const DOC = 'docs/specs/operating-modes.md';
const MANUAL_CONTROLS: any = ['Pause', 'Cancel', 'Resume', 'Inspect'];

const SYMBOL_LOCATOR = /`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)#([A-Za-z_$][\w$]*)`/g;
const LINE_LOCATOR = /`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?`/g;

const escapeRe = (s: any) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads a repo-relative source file, or null when it is absent or escapes the repo. */
function readRepoFile(rel: any) {
  const abs = path.resolve(REPO, rel);
  if (!abs.startsWith(REPO + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/** The pipe-table under `## <heading>`, as header names and rows keyed by them. */
function sectionTable(doc: any, heading: any) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l: any) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((l: any, i: any) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).filter((l: any) => l.trim().startsWith('|'));
  if (body.length < 2) return null;
  const cells = (l: any) => l.trim().replace(/^\||\|$/g, '').split('|').map((c: any) => c.trim());
  const header = cells(body[0]);
  const rows = body.slice(2).map((l: any) => Object.fromEntries(cells(l).map((c: any, i: any) => [header[i], c])));
  return { header, rows };
}

/** The two tables G40 reads, each with the columns that mark a row `implemented`. */
const TABLES: any = [
  { heading: 'Task states', key: 'State', marks: ['Implemented'] },
  { heading: 'User controls', key: 'Control', marks: ['Manual / assisted', 'Autonomous'] },
];

function tableShapeProblems(doc: any) {
  const p: any = [];
  for (const { heading, key, marks } of TABLES) {
    const t = sectionTable(doc, heading);
    if (!t) { p.push(`${heading}: table not found`); continue; }
    for (const col of [key, ...marks, 'Locator']) {
      if (!t.header.includes(col)) p.push(`${heading}: column '${col}' not found`);
    }
  }
  return p;
}

/** G40.1a: an `implemented` row with no `path#symbol` in its Locator cell. */
function unlocatedRowProblems(doc: any) {
  const p: any = [];
  for (const { heading, key, marks } of TABLES) {
    const t = sectionTable(doc, heading);
    if (!t) continue;
    for (const row of t.rows) {
      if (!marks.some((m: any) => row[m] === 'implemented')) continue;
      if (![...(row.Locator || '').matchAll(SYMBOL_LOCATOR)].length) {
        p.push(`${heading}: implemented row ${row[key]} has no path#symbol locator`);
      }
    }
  }
  return p;
}

/** True when `source` declares `symbol` or exports it by name. */
function declares(source: any, symbol: any) {
  const s = escapeRe(symbol);
  const decl: any = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?` +
    `(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+)${s}\\b`, 'm');
  if (decl.test(source)) return true;
  if (new RegExp(`\\b(?:module\\.)?exports\\.${s}\\s*=`).test(source)) return true;
  const blocks: any = [
    ...[...source.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\};?/g)].map((m) => m[1]),
    ...[...source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)].map((m) => m[1]),
  ];
  const key: any = new RegExp(`(?:^|[\\s,{])${s}\\s*(?:,|:|$|\\bas\\b)`, 'm');
  return blocks.some((b: any) => key.test(b));
}

/** G40.1b: every `path#symbol` in the document names an existing file that declares the symbol. */
function unresolvedLocatorProblems(doc: any, read: any = readRepoFile) {
  const p: any = [];
  const seen: any = new Set();
  for (const [, file, symbol] of doc.matchAll(SYMBOL_LOCATOR)) {
    const id = `${file}#${symbol}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const source = read(file);
    if (source == null) p.push(`locator ${id}: path ${file} does not exist`);
    else if (!declares(source, symbol)) p.push(`locator ${id}: ${file} does not declare ${symbol}`);
  }
  return p;
}

/** G40.2: the four Manual / assisted control cells are `implemented`. */
function manualCellProblems(doc: any) {
  const t = sectionTable(doc, 'User controls');
  if (!t) return [];
  return MANUAL_CONTROLS.flatMap((name: any) => {
    const row = t.rows.find((r: any) => r.Control === name);
    if (!row) return [`User controls: no ${name} row`];
    const cell = row['Manual / assisted'];
    return cell === 'implemented' ? [] : [`User controls: Manual / assisted ${name} is '${cell}', not implemented`];
  });
}

/** G40.3: no `path:line` locator anywhere in the document. */
function lineLocatorProblems(doc: any) {
  return [...doc.matchAll(LINE_LOCATOR)].map((m) => `line-number locator ${m[1]}:${m[2]}; cite path#symbol`);
}

function g40Problems(doc: any, read: any = readRepoFile) {
  return [
    ...tableShapeProblems(doc),
    ...unlocatedRowProblems(doc),
    ...unresolvedLocatorProblems(doc, read),
    ...manualCellProblems(doc),
    ...lineLocatorProblems(doc),
  ];
}

const liveDoc = () => fs.readFileSync(path.join(REPO, DOC), 'utf8');

/** Replaces `from` with `to` on the one table row starting `| <rowName> |`, failing if nothing changed. */
function seedRow(doc: any, rowName: any, from: any, to: any) {
  const re: any = new RegExp(`^\\| ${escapeRe(rowName)} \\|.*$`, 'm');
  const row = doc.match(re);
  assert.ok(row && row[0].includes(from), `seed: row ${rowName} must contain ${from}`);
  return doc.replace(re, row[0].replace(from, to));
}

function assertOneFinding(doc: any, pattern: any) {
  const got = g40Problems(doc);
  assert.equal(got.length, 1, `expected exactly one finding, got:\n${got.join('\n')}`);
  assert.match(got[0], pattern);
}

test('G40 (G40.1, G40.2, G40.3): operating-modes locators resolve and the manual control cells are implemented', () => {
  const doc = liveDoc();
  assert.ok([...doc.matchAll(SYMBOL_LOCATOR)].length > 0, 'the document must cite path#symbol locators');
  assert.deepEqual(g40Problems(doc), []);
});

test('G40.1b control: a renamed symbol is reported as undeclared', () => {
  const doc = seedRow(liveDoc(), 'Resume', 'task-run.ts#resumeRun', 'task-run.ts#resumeRunX');
  assertOneFinding(doc, /^locator src\/runtime\/task-run\.ts#resumeRunX: .* does not declare resumeRunX$/);
});

test('G40.1b control: a missing path is reported', () => {
  const doc = seedRow(liveDoc(), 'Inspect', 'src/runtime/task-run.ts#inspectRun', 'src/runtime/task-runs.ts#inspectRun');
  assertOneFinding(doc, /^locator src\/runtime\/task-runs\.ts#inspectRun: path src\/runtime\/task-runs\.ts does not exist$/);
});

test('G40.1a control: an implemented row without a locator is reported', () => {
  const doc = seedRow(liveDoc(), 'Redirect', '| target | target | none |', '| implemented | target | none |');
  assertOneFinding(doc, /^User controls: implemented row Redirect has no path#symbol locator$/);
});

test('G40.3 control: a line-number locator is reported', () => {
  const doc = seedRow(liveDoc(), 'Pause', '`src/runtime/task-run.ts#pauseRun`',
    '`src/runtime/task-run.ts#pauseRun`, `src/runtime/task-run.ts:242`');
  assertOneFinding(doc, /^line-number locator src\/runtime\/task-run\.ts:242; cite path#symbol$/);
});

test('G40.2 control: a manual control cell reverted to target is reported', () => {
  const doc = seedRow(liveDoc(), 'Cancel', '| Cancel | implemented |', '| Cancel | target |');
  assertOneFinding(doc, /^User controls: Manual \/ assisted Cancel is 'target', not implemented$/);
});

test('G40.1b + G40.2 control: a renamed symbol and a manual cell set to target are both reported', () => {
  let doc = seedRow(liveDoc(), 'RUNNING', 'task-graph.ts#deriveTasks', 'task-graph.ts#deriveTask');
  doc = seedRow(doc, 'Pause', '| Pause | implemented |', '| Pause | target |');
  const got = g40Problems(doc);
  assert.equal(got.length, 2, got.join('\n'));
  assert.match(got.join('\n'), /locator src\/runtime\/task-graph\.ts#deriveTask: .* does not declare deriveTask/);
  assert.match(got.join('\n'), /Manual \/ assisted Pause is 'target', not implemented/);
});

test('G40.1b control: the declaration check reads functions, consts, classes and export keys only', () => {
  const src = [
    'function alpha() {}', 'export async function beta() {}', 'const GAMMA = 1;', 'class Delta {}',
    'module.exports = {', '  epsilon, zeta: alpha,', '};', 'export { eta as theta };',
    '// iota is only mentioned in a comment', 'call(kappa);',
  ].join('\n');
  for (const s of ['alpha', 'beta', 'GAMMA', 'Delta', 'epsilon', 'zeta', 'eta']) assert.ok(declares(src, s), s);
  for (const s of ['iota', 'kappa', 'alph']) assert.ok(!declares(src, s), s);
});
