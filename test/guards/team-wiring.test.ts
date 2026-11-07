'use strict';

// G82 — team admission wiring (feature 143, IC-005, FR-007). Two checks, each a pure function over
// injected text, run once on the shipped tree and once on in-memory text seeded with one violation.
//
//   G82.1 every WIRED_SITES entry of src/runtime/team/evaluate.ts names a file that exists and holds
//         the entry's token as code (a token that only a comment holds does not count)
//   G82.2 no file under src/runtime/dispatch or src/runtime/review calls evaluate.ts unless a
//         WIRED_SITES entry lists it. One exemption is declared here, not in WIRED_SITES: loop.ts
//         requires evaluate.ts to build the gate (`teamGate`) it hands to admit(), which is not an
//         evaluation site. The exemption names its token and fails when loop.ts stops holding it.
//
// "Calls evaluate.ts" is any of: a require/import of a path ending `team/evaluate`, a call to one of
// its evaluating exports (`teamGate`, `evaluateAdmission`, `observeStart`, `observeCheck`), or a call
// on a gate (`team.evaluate(`, `team.record(`). admission.ts is the last kind: it receives the gate
// as an argument and never requires the module.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { WIRED_SITES } = require('../../src/runtime/team/evaluate.ts');

const SCANNED_DIRS = Object.freeze(['src/runtime/dispatch', 'src/runtime/review']);
const GATE_BUILDERS: ReadonlyArray<{ file: string; token: string }> = Object.freeze([
  { file: 'src/runtime/dispatch/loop.ts', token: 'teamGate' },
]);

const REQUIRES_EVALUATE = /(?:require\s*\(|from\s+|import\s*\()\s*['"][^'"]*team\/evaluate(?:\.ts)?['"]/;
const CALLS_EVALUATE = /\b(?:teamGate|evaluateAdmission|observeStart|observeCheck)\s*\(|\bteam\.(?:evaluate|record)\s*\(/;

const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Source with block comments and whole-line `//` comments removed, so a token must be code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

function callsEvaluate(text: string): boolean {
  const code = stripComments(text);
  return REQUIRES_EVALUATE.test(code) || CALLS_EVALUATE.test(code);
}

function tsFilesUnder(rel: string): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts')) out.push(child);
    }
  })(rel);
  return out.sort();
}

type Site = { id: string; file: string; token: string };

/** G82.1: a finding per site whose file is missing or holds its token only outside code. */
function tokenFindings(sites: ReadonlyArray<Site>, readFile: (rel: string) => string | null): string[] {
  const findings: string[] = [];
  for (const site of sites) {
    const text = readFile(site.file);
    if (text === null) { findings.push(`G82.1: ${site.id} names ${site.file}, which does not exist`); continue; }
    if (!site.token || !stripComments(text).includes(site.token)) {
      findings.push(`G82.1: ${site.file} does not hold the token '${site.token}' of ${site.id}`);
    }
  }
  return findings;
}

/** G82.2: a finding per scanned file that calls evaluate.ts and is neither listed nor a declared gate builder. */
function unlistedCallerFindings(
  files: Record<string, string>, sites: ReadonlyArray<Site>, builders: ReadonlyArray<{ file: string; token: string }>,
): string[] {
  const allowed = new Set([...sites.map((s) => s.file), ...builders.map((b) => b.file)]);
  return Object.keys(files).sort()
    .filter((file) => callsEvaluate(files[file]) && !allowed.has(file))
    .map((file) => `G82.2: ${file} calls src/runtime/team/evaluate.ts and is not in WIRED_SITES`);
}

// ── G82.0 the list itself ───────────────────────────────────────────────────────────────────────

test('G82: WIRED_SITES lists the three registered sites, each once, with a file under a scanned directory', () => {
  const registered = JSON.parse(read('core/registry/telemetry.json')).vocabularies.team_site;
  assert.deepEqual(WIRED_SITES.map((s: Site) => s.id).sort(), [...registered].sort());
  assert.equal(new Set(WIRED_SITES.map((s: Site) => s.file)).size, WIRED_SITES.length, 'one entry per file');
  for (const site of WIRED_SITES) {
    assert.ok(site.token, `${site.id} has a token`);
    assert.ok(SCANNED_DIRS.some((dir) => site.file.startsWith(`${dir}/`)), `${site.file} is under a scanned directory`);
  }
});

// ── G82.1 ───────────────────────────────────────────────────────────────────────────────────────

test('G82.1: every WIRED_SITES file holds its token', () => {
  assert.deepEqual(tokenFindings(WIRED_SITES, (rel) => (fs.existsSync(path.join(REPO, rel)) ? read(rel) : null)), []);
});

test('G82.1 control: a missing file, a missing token and a token held only by a comment are reported', () => {
  const site = { id: 'review-start', file: 'src/runtime/review/start.ts', token: 'observeStart' };
  const findings = (text: string | null) => tokenFindings([site], () => text);
  assert.deepEqual(findings('observeStart({ slug })'), []);
  assert.equal(findings(null).length, 1);
  assert.equal(findings('const nothing = 1;').length, 1);
  assert.equal(findings('// observeStart({ slug })\nconst nothing = 1;').length, 1);
  assert.equal(findings('/* observeStart({ slug }) */\nconst nothing = 1;').length, 1);
});

// ── G82.2 ───────────────────────────────────────────────────────────────────────────────────────

test('G82.2: no file under src/runtime/dispatch or src/runtime/review calls evaluate.ts unless listed', () => {
  const files = Object.fromEntries(SCANNED_DIRS.flatMap(tsFilesUnder).map((rel) => [rel, read(rel)]));
  assert.ok(Object.keys(files).length > 0, 'the scan found files');
  assert.deepEqual(unlistedCallerFindings(files, WIRED_SITES, GATE_BUILDERS), []);
});

test('G82.2: the declared gate builder still holds its token and is not also a wired site', () => {
  for (const builder of GATE_BUILDERS) {
    assert.ok(stripComments(read(builder.file)).includes(builder.token), `${builder.file} holds ${builder.token}`);
    assert.equal(WIRED_SITES.some((s: Site) => s.file === builder.file), false, `${builder.file} is exempt, not wired`);
  }
});

test('G82.2: every listed file is found by the same detector (the listing is not dead weight)', () => {
  for (const site of WIRED_SITES) {
    assert.equal(callsEvaluate(read(site.file)), true, `${site.file} is detected as a caller`);
  }
});

test('G82.2 control: an unlisted caller of each kind is reported; a listed file, a builder and a non-caller are not', () => {
  const sites = [{ id: 'review-start', file: 'src/runtime/review/start.ts', token: 'observeStart' }];
  const builders = [{ file: 'src/runtime/dispatch/loop.ts', token: 'teamGate' }];
  const findings = (files: Record<string, string>) => unlistedCallerFindings(files, sites, builders);

  assert.equal(findings({ 'src/runtime/review/other.ts': "require('../team/evaluate.ts').observeCheck(x);" }).length, 1, 'require with extension');
  assert.equal(findings({ 'src/runtime/review/other.ts': "const e = require('../team/evaluate');" }).length, 1, 'require without extension');
  assert.equal(findings({ 'src/runtime/dispatch/other.ts': "import { teamGate } from '../team/evaluate.ts';" }).length, 1, 'import');
  assert.equal(findings({ 'src/runtime/dispatch/other.ts': 'const gate = teamGate({ projectRoot });' }).length, 1, 'call by name');
  assert.equal(findings({ 'src/runtime/dispatch/other.ts': 'const v = team.evaluate(input);' }).length, 1, 'call on a gate');
  assert.equal(findings({ 'src/runtime/dispatch/other.ts': 'team.record(verdicts);' }).length, 1, 'record on a gate');

  assert.deepEqual(findings({ 'src/runtime/review/start.ts': "require('../team/evaluate.ts').observeStart(x);" }), [], 'listed');
  assert.deepEqual(findings({ 'src/runtime/dispatch/loop.ts': "const { teamGate } = require('../team/evaluate.ts');" }), [], 'gate builder');
  assert.deepEqual(findings({ 'src/runtime/dispatch/other.ts': "const x = require('./store.ts');" }), [], 'no call');
  assert.deepEqual(findings({ 'src/runtime/dispatch/other.ts': "// require('../team/evaluate.ts')\nconst x = 1;" }), [], 'a comment is not a call');
  assert.deepEqual(findings({ 'src/runtime/dispatch/other.ts': 'const own = evaluateRules(x);' }), [], 'a similar name is not a call');
});
