'use strict';

// G79 — attendance scope (autonomy plan section 2, "Keeping the person-only set closed").
//
// The `attendance` verb (src/runtime/roadmap/attendance.ts) answers "is a person watching?" from the
// session role and the run record. It may only change what a skill asks. What this guard proves, by
// a static scan of comment-stripped source:
//   1. No listed file, and no module statically reachable from one (relative `require('...')`,
//      `import ... from '...'`, `export ... from '...'`, `import('...')`, followed recursively),
//      imports src/runtime/roadmap/attendance.ts.
//   2. Every module in that reachable set uses only string-literal require/import paths and every
//      relative path resolves to a file: a computed path, or one that does not resolve, fails closed.
//   3. No listed person-only file itself mentions DOFLOW_SESSION_ROLE.
// Listed files:
//   - src/runtime/roadmap/seed.ts (promote, seed landing)
//   - src/runtime/settings/autopilot.ts and src/runtime/settings/config-write.ts
//   - src/runtime/roadmap/gates.ts and src/runtime/decision-register.ts
//   - the package trust code: every module under src/runtime/packages/
//   - src/runtime/roadmap/merge.ts
//   - (imports only, not the role) src/runtime/roadmap/worktree-cleanup.ts
// A listed file that no longer exists fails the guard, so a rename cannot shrink the set.
// NOT proven: that modules reachable from the listed files never read DOFLOW_SESSION_ROLE (the
// identity and primary readers predate attendance and are out of scope), nor anything reached by a
// path built at run time (which rule 2 refuses in the first place), nor non-TypeScript consumers.

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

const ATTENDANCE = 'src/runtime/roadmap/attendance.ts';
const RE_ATTENDANCE_SPEC = /attendance(?:\.ts|\.js)?$/;
const RE_ROLE = /DOFLOW_SESSION_ROLE/;
// A string-literal specifier, or any require/import call whose argument is not a string literal.
const RE_SPEC = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*)(['"`])([^'"`\n]*)\1|\bfrom\s+(['"])([^'"\n]*)\3/g;
// An argument that is not one plain string literal: an expression, a concatenation, or a template with ${}.
const RE_COMPUTED = /(?:\brequire|\bimport)\s*\(\s*(?:(?!['"`])[^)\s]|(['"`])[^'"`\n]*\1\s*[^)\s,]|`[^`\n]*\$\{)/g;

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

/** The file a relative specifier names, as a repo-relative path, or null when none of the candidates exists. */
function resolveSpec(from: string, spec: string, read: (rel: string) => string | null): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`]) {
    if (read(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * Walks the static import graph from `roots` over `read(rel)` (text or null). `noRole` lists the roots
 * that may not mention the role. Returns the findings and the number of modules walked.
 */
function scan(roots: string[], noRole: Set<string>, read: (rel: string) => string | null): { findings: string[]; walked: number } {
  const findings: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = read(rel);
    if (text === null) continue;
    const code = stripComments(text);
    if (noRole.has(rel) && RE_ROLE.test(code)) findings.push(`${rel} reads DOFLOW_SESSION_ROLE`);
    for (const computed of code.matchAll(RE_COMPUTED)) findings.push(`${rel} has a computed require/import path (${computed[0].trim()}), which cannot be followed`);
    for (const match of code.matchAll(RE_SPEC)) {
      const spec = match[2] ?? match[4];
      if (RE_ATTENDANCE_SPEC.test(spec)) { findings.push(`${rel} imports attendance.ts`); continue; }
      if (!spec.startsWith('.')) continue; // a node: builtin or a package: outside this tree
      const target = resolveSpec(rel, spec, read);
      if (target === null) findings.push(`${rel} imports ${spec}, which does not resolve`);
      else if (target === ATTENDANCE) findings.push(`${rel} imports attendance.ts`);
      else queue.push(target);
    }
  }
  return { findings: [...new Set(findings)].sort(), walked: seen.size };
}

function repoRoots(root: string): { roots: string[]; noRole: Set<string>; missing: string[] } {
  const roots: string[] = [];
  const noRole = new Set<string>();
  const missing: string[] = [];
  const add = (rel: string, role: boolean) => {
    if (!fs.existsSync(path.join(root, rel))) { missing.push(rel); return; }
    roots.push(rel);
    if (role) noRole.add(rel);
  };
  for (const rel of PERSON_ONLY) add(rel, true);
  if (!fs.existsSync(path.join(root, PACKAGES_DIR))) missing.push(PACKAGES_DIR);
  else for (const name of fs.readdirSync(path.join(root, PACKAGES_DIR)).filter((n: string) => n.endsWith('.ts')).sort()) add(`${PACKAGES_DIR}/${name}`, true);
  for (const rel of NO_IMPORT_ONLY) add(rel, false);
  return { roots, noRole, missing };
}

const diskReader = (root: string) => (rel: string): string | null => {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
};

test('G79: no person-only module, nor any module reachable from one, imports attendance.ts; none of them reads the role', (t) => {
  const { roots, noRole, missing } = repoRoots(REPO);
  assert.deepEqual(missing, [], 'every listed person-only file exists; update PERSON_ONLY if one was renamed');
  assert.ok(roots.length >= PERSON_ONLY.length + NO_IMPORT_ONLY.length);
  const { findings, walked } = scan(roots, noRole, diskReader(REPO));
  t.diagnostic(`G79: ${roots.length} listed module(s), ${walked} reachable module(s)`);
  assert.ok(walked > roots.length, 'the walk follows imports beyond the listed files');
  assert.deepEqual(findings, []);
});

test('G79 control: a direct import in every form turns the guard red', () => {
  const noRole = new Set(['seed.ts']);
  const forms = [
    "const { resolveAttendance } = require('./attendance.ts');",
    'const a = require("./roadmap/attendance");',
    "import { resolveAttendance } from './attendance.ts';",
    "export { resolveAttendance } from '../roadmap/attendance.ts';",
    "const a = await import('../roadmap/attendance.ts');",
  ];
  for (const form of forms) assert.deepEqual(scan(['seed.ts'], noRole, (rel) => (rel === 'seed.ts' ? form : null)).findings, ['seed.ts imports attendance.ts'], form);
});

test('G79 control: an import through a middle module is found transitively, in any require form', () => {
  const files: Record<string, string> = {
    'src/a/seed.ts': "const m = require('../b/mid');",
    'src/b/mid.ts': "export * from './deep.ts';",
    'src/b/deep.ts': "const x = () => require('../roadmap/attendance.ts');",
  };
  const found = scan(['src/a/seed.ts'], new Set(), (rel) => files[rel] ?? null);
  assert.deepEqual(found.findings, ['src/b/deep.ts imports attendance.ts']);
  assert.equal(found.walked, 3);
  const resolved: Record<string, string> = { 'src/a/seed.ts': "require('../b/mid.ts')", 'src/b/mid.ts': 'module.exports = 1;', 'src/roadmap/attendance.ts': '' };
  assert.deepEqual(scan(['src/a/seed.ts'], new Set(), (rel) => resolved[rel] ?? null).findings, [], 'control: a graph that never reaches the module is clean');
});

test('G79 control: a resolved path to attendance.ts is caught even when the specifier does not name it', () => {
  const files: Record<string, string> = {
    'src/runtime/roadmap/seed.ts': "const x = require('./index.ts');",
    'src/runtime/roadmap/index.ts': "module.exports = require('./' + 'attendance.ts');",
  };
  const found = scan(['src/runtime/roadmap/seed.ts'], new Set(), (rel) => files[rel] ?? null);
  assert.match(found.findings.join('\n'), /index\.ts has a computed require\/import path/);
});

test('G79 control: a computed path or an unresolvable relative path fails closed', () => {
  assert.match(scan(['a.ts'], new Set(), (rel) => (rel === 'a.ts' ? 'const m = require(`./${name}.ts`);' : null)).findings.join(), /computed require/);
  assert.match(scan(['a.ts'], new Set(), (rel) => (rel === 'a.ts' ? 'const m = require(path.join(dir, x));' : null)).findings.join(), /computed require/);
  assert.match(scan(['a.ts'], new Set(), (rel) => (rel === 'a.ts' ? "const m = require('./gone.ts');" : null)).findings.join(), /does not resolve/);
});

test('G79 control: the role is refused in a listed file only, in code or in a string', () => {
  const noRole = new Set(['seed.ts']);
  const read = (text: string) => (rel: string) => (rel === 'seed.ts' || rel === 'other.ts' ? text : null);
  assert.deepEqual(scan(['seed.ts'], noRole, read('const role = process.env.DOFLOW_SESSION_ROLE;')).findings, ['seed.ts reads DOFLOW_SESSION_ROLE']);
  assert.deepEqual(scan(['seed.ts'], noRole, read("const key = 'DOFLOW_SESSION_ROLE';")).findings, ['seed.ts reads DOFLOW_SESSION_ROLE']);
  assert.deepEqual(scan(['other.ts'], noRole, read('const role = process.env.DOFLOW_SESSION_ROLE;')).findings, [], 'a module outside the listed set may read it (identity and primary do)');
});

test('G79 control: comments and unrelated names do not trip the guard', () => {
  const noRole = new Set(['seed.ts']);
  const clean = [
    "// require('./attendance.ts') is forbidden here; DOFLOW_SESSION_ROLE too\nconst x = 1;",
    "/* DOFLOW_SESSION_ROLE\n   require('./attendance.ts') */ const y = 2;",
    "const { attendedBy } = require('./attended-by.ts'); // not the module",
  ];
  const read = (text: string) => (rel: string) => (rel === 'seed.ts' ? text : rel === 'attended-by.ts' ? '' : null);
  for (const text of clean) assert.deepEqual(scan(['seed.ts'], noRole, read(text)).findings, [], text);
});

test('G79 control: a listed file that is missing is reported, so a rename cannot shrink the set', (t) => {
  const root = tempDir(t, 'doflow-g79-');
  const { missing } = repoRoots(root);
  assert.ok(missing.includes('src/runtime/roadmap/seed.ts'));
  assert.ok(missing.includes(PACKAGES_DIR));
});
