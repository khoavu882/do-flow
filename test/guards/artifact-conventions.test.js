'use strict';

// G18 -- artifact convention drift. guidance/references/ARTIFACT_FORMAT.md is the single
// declaration of how a chain artifact is shaped, and the four shipped templates hand-transcribe
// parts of that declaration: the two closed vocabularies in their header blockquote, the C4 level
// headings, and the reviewer-facing sections each artifact type owns. Nothing else in this repo
// compares the two sides, which is exactly how two shipped templates came to contradict the
// reference on line 3 for as long as they did -- a template is prose to every other guard, and the
// artifact checker is a consistency checker that never reads the reference at all. This guard also
// closes the same loop on the checker itself: the rule names validate-artifacts.sh implements
// versus the rule list ARTIFACT_FORMAT.md section 9 documents.
//
// Reads only core/ and test/. It MUST NOT read agent-docs/: a generated artifact belongs to a
// user's feature, not to this repository's suite, and reading one would make the suite's result
// depend on feature content that nobody here maintains.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const FORMAT = path.join(REPO, 'core', 'shared', 'guidance', 'references', 'ARTIFACT_FORMAT.md');
const TEMPLATES = path.join(REPO, 'core', 'shared', 'templates', 'doflow');

// The transcription set is an explicit, closed list -- widening it is a change to this guard's
// contract, never an incidental one. These four are the chain artifacts ARTIFACT_FORMAT.md
// governs. Deliberately absent, and each for a stated reason:
//   state-template.md         -- declared out of scope in ARTIFACT_FORMAT.md's intro (list-shaped);
//                                it carries "**Status:** In Progress", a value in neither closed
//                                vocabulary, so including it would produce a false failure.
//   question-log-template.md  -- out of scope; a dialogue transcript with no maturity field.
//   do-document/references/implementation-flow.md -- out of scope (narrative-only) and carries its
//                                own "**Status:** Draft" header for the same reason.
// Do not add a file here without first checking that ARTIFACT_FORMAT.md's intro governs it.
const TRANSCRIPTIONS = ['requirement-template.md', 'design-template.md', 'specs-template.md', 'plan-template.md'];

const read = (file) => fs.readFileSync(file, 'utf8');
const template = (name) => read(path.join(TEMPLATES, name));

/** ARTIFACT_FORMAT.md with its fenced examples blanked out. §3's example of an *artifact's*
 * History section is itself a literal `## 9. History` heading, so an unfenced read would slice the
 * wrong §9; §1's example tables would likewise feed a vocabulary extraction. Line count is
 * preserved so a failure message's context stays honest. */
function declaration() {
  let fenced = false;
  return read(FORMAT).split('\n').map((line) => {
    if (/^```/.test(line)) { fenced = !fenced; return ''; }
    return fenced ? '' : line;
  }).join('\n');
}

/** Slice out one heading's section: from the heading line to the next heading of the same or a
 * higher level. Every extraction below is scoped to a section so an example fence elsewhere in the
 * document cannot feed a vocabulary. */
function section(text, headingPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingPattern.test(l));
  assert.notEqual(start, -1, `ARTIFACT_FORMAT.md has no heading matching ${headingPattern}`);
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** First-cell values of a markdown table's body rows, unwrapped from backticks. */
function firstColumnValues(text) {
  return [...text.matchAll(/^\|\s*`?([^`|]+?)`?\s*\|/gm)]
    .map(([, cell]) => cell.trim())
    .filter((cell) => cell && cell !== 'ID' && cell !== 'Value' && cell !== 'Level' && !/^-+$/.test(cell));
}

/** A template's header blockquote, flattened to one line so a wrapped sentence still matches. */
function headerBlockquote(text) {
  const quoted = text.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, ''));
  return quoted.join(' ').replace(/\s+/g, ' ');
}

const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map(([, v]) => v);

/** Both-directions set equality with a message naming both sides and every differing member. */
function assertSameSet(left, right, leftName, rightName) {
  const l = new Set(left);
  const r = new Set(right);
  const onlyLeft = [...l].filter((v) => !r.has(v)).sort();
  const onlyRight = [...r].filter((v) => !l.has(v)).sort();
  const detail = [
    `${leftName} declares: ${[...l].sort().map((v) => JSON.stringify(v)).join(', ') || '(nothing)'}`,
    `${rightName} carries:  ${[...r].sort().map((v) => JSON.stringify(v)).join(', ') || '(nothing)'}`,
    onlyLeft.length ? `only in ${leftName}: ${onlyLeft.map((v) => JSON.stringify(v)).join(', ')}` : null,
    onlyRight.length ? `only in ${rightName}: ${onlyRight.map((v) => JSON.stringify(v)).join(', ')}` : null,
  ].filter(Boolean).join('\n  ');
  assert.deepEqual([onlyLeft, onlyRight], [[], []],
    `${leftName} and ${rightName} disagree:\n  ${detail}`);
}

// --- comparison 1: the document `Maturity` vocabulary -------------------------------------------

/** Section 2's "Maturity -- the state of the document" table. */
function declaredMaturity() {
  const sub = section(section(declaration(), /^## 2\. /), /^### Maturity/);
  return firstColumnValues(sub);
}

/** A template restates the whole vocabulary in its header blockquote -- deliberately the whole
 * vocabulary, because a header carrying only its own current value would yield a one-member set
 * that could never equal a three-member one. */
function restatedMaturity(text) {
  const quote = headerBlockquote(text);
  const m = quote.match(/`Maturity` is (.+?)(?:, the item-level|\.)/);
  assert.ok(m, 'template header blockquote does not restate the `Maturity` vocabulary');
  return backticked(m[1]);
}

test('G18: every template restates ARTIFACT_FORMAT.md\'s document `Maturity` vocabulary', () => {
  const declared = declaredMaturity();
  assert.ok(declared.length === 3, `ARTIFACT_FORMAT.md §2 should declare 3 Maturity values, found ${declared.length}`);
  for (const name of TRANSCRIPTIONS) {
    assertSameSet(declared, restatedMaturity(template(name)),
      'ARTIFACT_FORMAT.md §2 Maturity', `templates/doflow/${name} header`);
  }
});

// --- comparison 2: the item `Status` vocabulary --------------------------------------------------

function declaredStatus() {
  const sub = section(section(declaration(), /^## 2\. /), /^### Status/);
  return firstColumnValues(sub);
}

function restatedStatus(text) {
  const quote = headerBlockquote(text);
  const m = quote.match(/`Status` is only (.+?)(?:, and superseded|\.)/);
  assert.ok(m, 'template header blockquote does not restate the item `Status` vocabulary');
  return backticked(m[1]);
}

test('G18: every template restates ARTIFACT_FORMAT.md\'s item `Status` vocabulary', () => {
  const declared = declaredStatus();
  assert.ok(declared.length === 2, `ARTIFACT_FORMAT.md §2 should declare 2 Status values, found ${declared.length}`);
  for (const name of TRANSCRIPTIONS) {
    assertSameSet(declared, restatedStatus(template(name)),
      'ARTIFACT_FORMAT.md §2 Status', `templates/doflow/${name} header`);
  }
});

test('G18: the two vocabularies stay disjoint', () => {
  const shared = declaredMaturity().filter((v) => new Set(declaredStatus()).has(v)).sort();
  assert.deepEqual(shared, [],
    `ARTIFACT_FORMAT.md §2 declares them disjoint, but these values are in both the document `
    + `Maturity vocabulary and the item Status vocabulary: ${shared.join(', ')}`);
});

// --- comparison 1b: the header field itself ------------------------------------------------------

/** A template's header BLOCK: the contiguous non-blank lines starting at "**Feature:** ...".
 * requirement.md's header runs to two lines, and a partial revert that put "**Status:**" back on a
 * sibling line would survive a single-line check -- the same drift this comparison exists to catch. */
function headerLine(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('**Feature:**'));
  if (start === -1) return '';
  const block = [];
  for (let i = start; i < lines.length && lines[i].trim() !== ''; i += 1) block.push(lines[i]);
  return block.join(' ');
}

test('G18: every template header carries **Maturity:** and no **Status:** field', () => {
  // Comparison 1 checks that the blockquote RESTATES the Maturity vocabulary. It does not check
  // that the header CARRIES the field, because headerBlockquote() keeps only lines starting ">"
  // and the field is outside the quote. Without this test the headline rename could be reverted in
  // any template with every other assertion still green -- verified by mutation.
  const offenders = [];
  for (const name of TRANSCRIPTIONS) {
    const line = headerLine(template(name));
    if (!line) { offenders.push(`${name}: no "**Feature:**" header line found`); continue; }
    if (!line.includes('**Maturity:**')) offenders.push(`${name}: header carries no **Maturity:** field`);
    if (line.includes('**Status:**')) offenders.push(`${name}: header still carries the removed **Status:** field`);
  }
  assert.deepEqual(offenders, [],
    'ARTIFACT_FORMAT.md §2 declares the document field is **Maturity:** and that the former '
    + `**Status:** header form is gone:\n  ${offenders.join('\n  ')}`);
});

// --- comparison 3: the C4 level names ------------------------------------------------------------

/** Section 4's level table row cells, UNFILTERED. The collision test below needs the raw cells:
 * filtering to /^C4 / first would discard exactly the ambiguous spellings it exists to catch. */
function declaredLevelCells() {
  const sec = section(declaration(), /^### C4 levels/);
  // The table's row labels AND the heading spellings §4's prose names, because an author copies the
  // prose. Rewriting only the prose to the ambiguous form would otherwise leave this guard green.
  const prose = backticked(sec)
    .filter((v) => v.startsWith('###'))
    .map((v) => v.replace(/^###\s*/, '').split(/[:—–]/)[0].trim());
  return [...firstColumnValues(sec), ...prose];
}

/** design-template.md §2's level headings, UNFILTERED, for the same reason. Matches any
 * "### <label>: ..." heading in §2 rather than only the "C4 Level N" shape. */
function templateLevelHeadings() {
  const sec = section(template('design-template.md'), /^## 2\. /);
  // No colon is required: "### C3" and "### C3 — Component" are exactly the ambiguous spellings
  // this feeds the collision test, and a colon-only match would be blind to both.
  return [...sec.matchAll(/^###\s+(.+?)\s*$/gm)].map(([, h]) => h.split(/[:—–]/)[0].trim());
}

/** Section 4's level table row labels, narrowed to the C4 spelling for the agreement test. */
function declaredLevels() {
  // De-duplicated: declaredLevelCells() now returns the table's row labels AND §4's prose
  // spellings, which agree in the healthy case and would otherwise double the count.
  return [...new Set(declaredLevelCells().filter((v) => /^C4 /.test(v)))];
}

/** design-template.md §2's "### C4 Level N: ..." headings, label only. */
function templateLevels() {
  return templateLevelHeadings().filter((v) => /^C4 Level \d+$/.test(v));
}

test('G18: design-template.md\'s C4 headings match ARTIFACT_FORMAT.md §4\'s level labels', () => {
  const declared = declaredLevels();
  assert.ok(declared.length === 3, `ARTIFACT_FORMAT.md §4 should declare 3 C4 levels, found ${declared.length}`);
  assertSameSet(declared, templateLevels(),
    'ARTIFACT_FORMAT.md §4 level table', 'templates/doflow/design-template.md §2 headings');
});

test('G18: no C4 level label collides with a design.md §3 component ID', () => {
  // `^C[0-9]+$` is what a component ID looks like (C1, C3). A level spelled that way is ambiguous
  // between the third zoom level and the third component -- the defect this feature removed.
  //
  // Read the RAW cells and headings, never declaredLevels()/templateLevels(): those narrow to the
  // `C4 ` spelling, and a value narrowed to `C4 ...` can never match `^C[0-9]+$`. Filtering first
  // made this assertion compare two empty arrays for every possible repository state -- it passed
  // even with both sides reverted to `C1`/`C2`/`C3`, which is the exact regression it guards.
  const offenders = [
    ...declaredLevelCells().map((v) => [`ARTIFACT_FORMAT.md §4`, v]),
    ...templateLevelHeadings().map((v) => [`design-template.md §2`, v]),
  ].filter(([, label]) => /^C[0-9]+$/.test(label));
  assert.deepEqual(offenders, [],
    `these C4 level labels match ^C[0-9]+$, the design.md §3 component-ID pattern, and are `
    + `therefore ambiguous:\n  ${offenders.map(([side, v]) => `${side}: ${v}`).join('\n  ')}`);
});

// --- comparison 4: reviewer-facing sections, in the template that owns each -----------------------

const REVIEWER_SECTIONS = section(declaration(), /^## 10\. /);

test('G18: design-template.md §1 carries the decision-and-blocker columns §10 declares', () => {
  const declared = REVIEWER_SECTIONS.replace(/\s+/g, ' ').match(/A table with the columns ((?:`[^`]+`[,\s]*(?:and )?)+)/);
  assert.ok(declared, 'ARTIFACT_FORMAT.md §10 no longer declares the decision-summary columns');
  const sec = section(template('design-template.md'), /^## 1\. /);
  const header = sec.split('\n').find((l) => /^\|.*\|/.test(l));
  assert.ok(header, 'design-template.md §1 carries no table at all');
  const cells = header.split('|').slice(1, -1).map((c) => c.trim()).filter(Boolean);
  assertSameSet(backticked(declared[1]), cells,
    'ARTIFACT_FORMAT.md §10 decision-summary columns', 'templates/doflow/design-template.md §1 table header');
});

test('G18: specs-template.md carries the §1 family grouping; data-model-template.md carries the §2-shaped data-model views §10 declares', () => {
  const specs = template('specs-template.md');
  const one = section(specs, /^## 1\. /);
  const dataModel = template('data-model-template.md');
  const dataModelOne = section(dataModel, /^## 1\. /);
  // Each marker is quoted verbatim out of §10, so the declaration -- not this file -- names them.
  const declaredMarkers = new Set(backticked(REVIEWER_SECTIONS));
  const expect = (marker, file, where, text) => {
    assert.ok(declaredMarkers.has(marker),
      `ARTIFACT_FORMAT.md §10 no longer declares the marker \`${marker}\`; this guard's `
      + `expectation and the declaration have drifted apart`);
    assert.ok(text.includes(marker.replace(/<[^>]+>/g, '').trim()),
      `ARTIFACT_FORMAT.md §10 declares \`${marker}\` but templates/doflow/${file} ${where} `
      + `does not carry it`);
  };
  // §1: a `Family` column in the index, and `#### Family: <name>` grouping beneath it.
  const indexHeader = one.split('\n').find((l) => /^\|\s*ID\s*\|/.test(l));
  assert.ok(indexHeader, 'specs-template.md §1 carries no index table');
  const cells = indexHeader.split('|').slice(1, -1).map((c) => c.trim());
  assert.ok(declaredMarkers.has('Family'), 'ARTIFACT_FORMAT.md §10 no longer declares the `Family` column');
  assert.ok(cells.includes('Family'),
    `ARTIFACT_FORMAT.md §10 declares a \`Family\` column for specs.md §1, but `
    + `templates/doflow/specs-template.md §1's index header is: ${cells.join(' | ')}`);
  expect('#### Family: <name>', 'specs-template.md', '§1', one);
  // data-model-template.md §1: a conceptual domain map, then one `#### ER view: <subdomain>` per
  // bounded subdomain -- the shape §10 declares for data-model.md §1.
  expect('#### ER view: <subdomain>', 'data-model-template.md', '§1', dataModelOne);
  assert.match(dataModelOne, /domain map/i,
    'ARTIFACT_FORMAT.md §10 declares data-model.md §1 opens with a conceptual domain map, but '
    + 'templates/doflow/data-model-template.md §1 never names one');
});

// --- comparison 6: the component detail labels ---------------------------------------------------

/** The four labels §10's "component detail shape" declares, in the order it declares them. */
function declaredComponentLabels() {
  const sec = section(declaration(), /^### The component detail shape/);
  return backticked(sec).filter((v) => /^\*\*.+:\*\*$/.test(v));
}

/** The labels design-template.md §3 actually transcribes, in document order, de-duplicated. */
function templateComponentLabels() {
  const sec = section(template('design-template.md'), /^## 3\. /);
  const seen = [];
  for (const [, label] of sec.matchAll(/(\*\*[A-Z][^*]*?:\*\*)/g)) {
    // Skip the entry's own ID label -- "- **C1:**" opens the entry, the four labels nest beneath it.
    if (/^\*\*[A-Za-z]+-?[0-9]+:\*\*$/.test(label)) continue;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen;
}

test('G18: design-template.md §3 transcribes §10\'s component labels, in order', () => {
  // Without this, the four labels were declared in §10, carved out in ARTIFACT_VOICE.md, and
  // transcribed into the template with nothing comparing them -- renaming or dropping one left
  // every other assertion green. That is the same defect as the header-field check above.
  const declared = declaredComponentLabels();
  assert.equal(declared.length, 4,
    `ARTIFACT_FORMAT.md §10 should declare 4 component labels, found ${declared.length}: ${declared.join(', ')}`);
  const transcribed = templateComponentLabels();
  assert.deepEqual(transcribed, declared,
    'ARTIFACT_FORMAT.md §10 declares the component detail labels and their order; '
    + `templates/doflow/design-template.md §3 must transcribe them exactly.\n`
    + `  §10 declares:  ${declared.join(' ')}\n`
    + `  §3 transcribes: ${transcribed.join(' ') || '(none)'}`);
});

// --- comparison 5: checker rule names vs the rule list §9 documents ------------------------------

const CHECKER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash', 'validate-artifacts.sh');

/** Rule names as *implemented* -- read from the finding() call sites, not from the script's own
 * header comment, so the comparison is against behaviour rather than a second transcription. */
function implementedRules() {
  const text = read(CHECKER);
  return new Set([...text.matchAll(/\bfinding\("([a-z]+)"/g)].map(([, rule]) => rule));
}

/** Section 9's "Checked:" line, split into the clauses it separates with `·`. */
function documentedClauses() {
  const nine = section(declaration(), /^## 9\. /).replace(/\s+/g, ' ');
  const m = nine.match(/Checked:\s*(.+?)\s*(?:Parity reads|Not checked)/);
  assert.ok(m, 'ARTIFACT_FORMAT.md §9 no longer carries a `Checked:` rule list');
  return m[1].split('·').map((c) => c.trim()).filter(Boolean);
}

test('G18: validate-artifacts.sh\'s rules and ARTIFACT_FORMAT.md §9\'s `Checked:` list agree', () => {
  const implemented = implementedRules();
  const clauses = documentedClauses();
  // §9 documents each rule as a prose clause rather than by bare name, so the match is "this
  // clause names this rule". A clause naming no implemented rule, and an implemented rule named by
  // no clause, are both failures -- set equality in both directions over the rule names.
  const documented = new Set();
  const unmatchedClauses = [];
  for (const clause of clauses) {
    const hit = [...implemented].filter((rule) => clause.toLowerCase().includes(rule));
    if (!hit.length) { unmatchedClauses.push(clause); continue; }
    for (const rule of hit) documented.add(rule);
  }
  assert.deepEqual(unmatchedClauses, [],
    `ARTIFACT_FORMAT.md §9 documents these as Checked, but no rule in `
    + `scripts/doflow/bash/validate-artifacts.sh implements them:\n  ${unmatchedClauses.join('\n  ')}\n`
    + `  implemented rules: ${[...implemented].sort().join(', ')}`);
  assertSameSet([...implemented], [...documented],
    'validate-artifacts.sh finding() rules', 'ARTIFACT_FORMAT.md §9 `Checked:` list');
});
