'use strict';

// G79 — attendance scope (autonomy plan section 2, "Keeping the person-only set closed").
//
// The `attendance` verb (src/runtime/roadmap/attendance.ts) answers "is a person watching?" from the
// session role and the run record. That answer may only change what a skill asks; it must never
// loosen anything only a person may do. So none of the person-only code may import attendance.ts or
// read DOFLOW_SESSION_ROLE:
//   - src/runtime/roadmap/seed.ts (promote, seed landing)
//   - src/runtime/settings/autopilot.ts and src/runtime/settings/config-write.ts
//   - src/runtime/roadmap/gates.ts and src/runtime/decision-register.ts
//   - the package trust code: every module under src/runtime/packages/
//   - src/runtime/roadmap/merge.ts
// The cleanup verb's own module (worktree-cleanup.ts) is a loop-side module and must not import
// attendance.ts either. Comments are stripped before the scan; a listed file that no longer exists
// fails the guard, so a rename cannot silently shrink the set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { tempDir } = require('../helper/tmp.ts');

const PERSON_ONLY = [
  'src/runtime/roadmap/seed.ts',
  'src/runtime/settings/autopilot.ts',
  'src/runtime/settings/config-write.ts',
  'src/runtime/roadmap/gates.ts',
  'src/runtime/decision-register.ts',
  'src/runtime/roadmap/merge.ts',
];
const PACKAGES_DIR = 'src/runtime/packages';
/** Must not import attendance.ts (it may read nothing of the role either, but it never does). */
const NO_IMPORT_ONLY = ['src/runtime/roadmap/worktree-cleanup.ts'];

const RE_ATTENDANCE_IMPORT = /(?:\brequire\s*\(|\bfrom\s+|\bimport\s*\()\s*(['"`])[^'"`\n]*attendance(?:\.ts|\.js)?\1/;
const RE_ROLE = /DOFLOW_SESSION_ROLE/;

/** `//` and block comments removed outside string and template literals; newlines kept. */
function stripComments(text: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; } else if (ch === quote) quote = '';
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++; }
      i++;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      out += ch;
    }
  }
  return out;
}

/** Findings for in-memory files: `{ rel: text }`. `noRole` lists the rels that may not read the role. */
function findViolations(files: Record<string, string>, noRole: Set<string>): string[] {
  const findings: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const code = stripComments(text);
    if (RE_ATTENDANCE_IMPORT.test(code)) findings.push(`${rel} imports attendance.ts`);
    if (noRole.has(rel) && RE_ROLE.test(code)) findings.push(`${rel} reads DOFLOW_SESSION_ROLE`);
  }
  return findings;
}

function loadRepoFiles(root: string): { files: Record<string, string>; noRole: Set<string>; missing: string[] } {
  const files: Record<string, string> = {};
  const noRole = new Set<string>();
  const missing: string[] = [];
  const add = (rel: string, role: boolean) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { missing.push(rel); return; }
    files[rel] = fs.readFileSync(file, 'utf8');
    if (role) noRole.add(rel);
  };
  for (const rel of PERSON_ONLY) add(rel, true);
  if (!fs.existsSync(path.join(root, PACKAGES_DIR))) missing.push(PACKAGES_DIR);
  else for (const name of fs.readdirSync(path.join(root, PACKAGES_DIR)).filter((n: string) => n.endsWith('.ts')).sort()) add(`${PACKAGES_DIR}/${name}`, true);
  for (const rel of NO_IMPORT_ONLY) add(rel, false);
  return { files, noRole, missing };
}

test('G79: no person-only module imports attendance.ts or reads DOFLOW_SESSION_ROLE', (t) => {
  const { files, noRole, missing } = loadRepoFiles(REPO);
  t.diagnostic(`G79: scanned ${Object.keys(files).length} module(s)`);
  assert.deepEqual(missing, [], 'every listed person-only file exists; update PERSON_ONLY if one was renamed');
  assert.ok(Object.keys(files).length >= PERSON_ONLY.length + NO_IMPORT_ONLY.length);
  assert.deepEqual(findViolations(files, noRole), []);
});

test('G79 control: each import form of attendance.ts and a role read turn the guard red', () => {
  const noRole = new Set(['seed.ts']);
  const forms = [
    "const { resolveAttendance } = require('./attendance.ts');",
    'const a = require("./roadmap/attendance");',
    "import { resolveAttendance } from './attendance.ts';",
    "const a = await import('../roadmap/attendance.ts');",
  ];
  for (const form of forms) assert.deepEqual(findViolations({ 'seed.ts': form }, noRole), ['seed.ts imports attendance.ts'], form);
  assert.deepEqual(findViolations({ 'seed.ts': "const role = process.env.DOFLOW_SESSION_ROLE;" }, noRole), ['seed.ts reads DOFLOW_SESSION_ROLE']);
  assert.deepEqual(findViolations({ 'seed.ts': "const key = 'DOFLOW_SESSION_ROLE';" }, noRole), ['seed.ts reads DOFLOW_SESSION_ROLE']);
  assert.deepEqual(findViolations({ 'worktree-cleanup.ts': "require('./attendance.ts')" }, new Set()), ['worktree-cleanup.ts imports attendance.ts']);
});

test('G79 control: comments and unrelated names do not trip the guard', () => {
  const noRole = new Set(['seed.ts']);
  const clean = [
    "// require('./attendance.ts') is forbidden here; DOFLOW_SESSION_ROLE too\nconst x = 1;",
    "/* DOFLOW_SESSION_ROLE\n   require('./attendance.ts') */ const y = 2;",
    "const { attendedBy } = require('./attended-by.ts'); // not the module",
  ];
  for (const text of clean) assert.deepEqual(findViolations({ 'seed.ts': text }, noRole), [], text);
});

test('G79 control: a listed file that is missing is reported, so a rename cannot shrink the set', (t) => {
  const root = tempDir(t, 'doflow-g79-');
  const { missing } = loadRepoFiles(root);
  assert.ok(missing.includes('src/runtime/roadmap/seed.ts'));
  assert.ok(missing.includes(PACKAGES_DIR));
});
