'use strict';

// G86 — the session-effort facts stay in step across the registry, the runtime, the Console copy and the wording fixture
// (row 178, design §11). Each check is a findings function over a root (the repo, or a scratch copy for its planted control).
//   G86.1  every harness in core/registry/harnesses.json declares `sessionEffort` (the reader treats a missing key as
//          unknown, so only an out-of-tree descriptor may omit it).
//   G86.2  the Console's `SESSION_VARIABLES` (a copy: the Console imports nothing from the core), as console/src/verb-runner.ts
//          under the root exports it, equals `sessionVariables(registry)` of the shipped registry, as a set and in order.
//   G86.3  no registry harness id is a quoted string literal (single, double or backtick) in the reader, the resolver or
//          the two wording modules (NFR-003). Comments are not stripped: a quoted id in a comment is a hit too, so prose
//          there names a harness without quoting it.
//   G86.4  the wording fixture holds a case per SESSION_REASONS value, per NONE_REASONS value and per plan kind (binding,
//          session unmapped listed, session unchecked, session mapped, none), read from the exported closed sets.
//   Controls: each check fails on a scratch copy with one planted fault.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry/index.ts');
const { sessionVariables, SESSION_REASONS } = require('../../src/runtime/context/session-effort.ts');
const { NONE_REASONS } = require('../../src/runtime/worker/effort-resolution.ts');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '..', '..');
const HARNESSES_FILE = 'core/registry/harnesses.json';
const FIXTURE_FILE = 'test/fixtures/models/effort-text.json';
const CONSOLE_FILE = 'console/src/verb-runner.ts';
const NEUTRAL_MODULES: readonly string[] = [
  'src/runtime/context/session-effort.ts',
  'src/runtime/worker/effort-resolution.ts',
  'src/runtime/models/effort-text.ts',
  'console/web/derive/effort-text.js',
];
const PLAN_KINDS: readonly string[] = ['binding', 'session-listed', 'session-unchecked', 'session-mapped', 'none'];

const scratch = createScratch('doflow-session-effort-guard-');
after(() => scratch.remove());

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const harnessesOf = (root: string): any[] => JSON.parse(read(root, HARNESSES_FILE)).harnesses;

/** The design §8.1 row a plan renders through (the same split as test/runtime/models/effort-text.test.ts). */
function kindOf(plan: any): string {
  if (plan.source === 'binding') return 'binding';
  if (plan.source === 'session') return plan.mapped ? 'session-mapped' : `session-${plan.check}`;
  return 'none';
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────────

function declaresSessionEffort(root: string): string[] {
  return harnessesOf(root).filter((h) => h.sessionEffort === undefined).map((h) => `G86.1 harness ${h.id} declares no sessionEffort`);
}

/** The `SESSION_VARIABLES` list the Console file under `root` exports (the file requires node built-ins only, so a copy loads). */
const consoleListOf = (root: string): readonly string[] => require(path.join(root, CONSOLE_FILE)).SESSION_VARIABLES;

function consoleListFindings(root: string, registry: any): string[] {
  const consoleList = consoleListOf(root);
  const expected: string[] = sessionVariables(registry);
  return JSON.stringify(consoleList) === JSON.stringify(expected)
    ? []
    : [`G86.2 Console SESSION_VARIABLES [${consoleList.join(', ')}] differs from sessionVariables(registry) [${expected.join(', ')}]`];
}

function idLiteralFindings(root: string, files: readonly string[]): string[] {
  const findings: string[] = [];
  const ids: string[] = harnessesOf(root).map((h) => h.id);
  for (const file of files) {
    const lines = read(root, file).split('\n');
    lines.forEach((line, i) => {
      for (const id of ids) if (new RegExp(`['"\`]${id}['"\`]`).test(line)) findings.push(`G86.3 ${file}:${i + 1} holds the harness id ${id} as a literal`);
    });
  }
  return findings;
}

function fixtureFindings(root: string): string[] {
  const findings: string[] = [];
  const cases: any[] = JSON.parse(read(root, FIXTURE_FILE)).cases;
  const kinds = new Set(cases.map((c) => kindOf(c.plan)));
  for (const kind of PLAN_KINDS) if (!kinds.has(kind)) findings.push(`G86.4 no fixture case of plan kind ${kind}`);
  const none = cases.filter((c) => c.plan.source === 'none');
  for (const reason of NONE_REASONS) if (!none.some((c) => c.plan.reason === reason)) findings.push(`G86.4 no fixture case of NoneReason ${reason}`);
  const sessionUnknown = none.filter((c) => c.plan.reason === 'session-unknown');
  for (const reason of SESSION_REASONS) if (!sessionUnknown.some((c) => c.plan.session?.reason === reason)) findings.push(`G86.4 no fixture case of SessionReason ${reason}`);
  return findings;
}

/** A scratch root holding copies of the files the checks read (and `mutate` to plant one fault). */
function scratchRoot(name: string, mutate: (root: string) => void): string {
  const root = path.join(scratch.dir, name);
  for (const rel of [HARNESSES_FILE, FIXTURE_FILE, ...NEUTRAL_MODULES]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  mutate(root);
  return root;
}

const registry = loadRegistry({ repoRoot: REPO });

// ── green on the repo ───────────────────────────────────────────────────────────────────────────────

test('G86.1 every shipped harness declares sessionEffort', () => {
  assert.deepEqual(declaresSessionEffort(REPO), []);
});

test('G86.2 the Console SESSION_VARIABLES equal sessionVariables(registry), as a set and in order', () => {
  assert.deepEqual(consoleListFindings(REPO, registry), []);
});

test('G86.3 no harness id is a string literal in the reader, resolver or wording modules', () => {
  assert.deepEqual(idLiteralFindings(REPO, NEUTRAL_MODULES), []);
});

test('G86.4 the wording fixture holds a case per SessionReason, NoneReason and plan kind', () => {
  assert.deepEqual(fixtureFindings(REPO), []);
});

// ── planted controls ────────────────────────────────────────────────────────────────────────────────

test('G86.1 control: a harness with the key deleted is found', () => {
  const root = scratchRoot('c1', (r) => {
    const doc = JSON.parse(read(r, HARNESSES_FILE));
    delete doc.harnesses[0].sessionEffort;
    fs.writeFileSync(path.join(r, HARNESSES_FILE), JSON.stringify(doc));
  });
  const findings = declaresSessionEffort(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^G86\.1 harness \S+ declares no sessionEffort$/);
});

test('G86.2 control: a Console file whose list misses one name, or lists them out of order, is found', (t) => {
  // Design §11: the fault is planted in a temp copy of the Console file the check reads, and the check runs on that copy.
  const shipped = consoleListOf(REPO);
  assert.ok(shipped.length > 1);
  const source = read(REPO, CONSOLE_FILE);
  const declared = /(const SESSION_VARIABLES\b[^=]*=\s*)Object\.freeze\(\[[^\]]*\]\)/;
  assert.equal(source.match(new RegExp(declared, 'g'))?.length, 1, `${CONSOLE_FILE} declares SESSION_VARIABLES once as a frozen array literal`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-g86-2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const planted = (name: string, list: readonly string[]): string => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, path.dirname(CONSOLE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, CONSOLE_FILE), source.replace(declared, (_m, head) => `${head}Object.freeze(${JSON.stringify(list)})`));
    return root;
  };
  const missing = consoleListFindings(planted('missing', shipped.slice(1)), registry);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^G86\.2 /);
  assert.equal(consoleListFindings(planted('reversed', [...shipped].reverse()), registry).length, 1, 'order counts');
});

test('G86.3 control: an id literal planted in a copy of effort-resolution.ts is found', () => {
  const id = harnessesOf(REPO)[0].id;
  const root = scratchRoot('c3', (r) => {
    const file = path.join(r, 'src/runtime/worker/effort-resolution.ts');
    fs.appendFileSync(file, `\nconst planted = '${id}';\n`);
  });
  const findings = idLiteralFindings(root, NEUTRAL_MODULES);
  assert.equal(findings.length, 1);
  assert.match(findings[0], new RegExp(`^G86\\.3 src/runtime/worker/effort-resolution\\.ts:\\d+ holds the harness id ${id} as a literal$`));
});

test('G86.4 control: a fixture with one case removed is found', () => {
  // The last NoneReason's case goes: the first (session-unknown) carries every SessionReason case.
  const root = scratchRoot('c4', (r) => {
    const doc = JSON.parse(read(r, FIXTURE_FILE));
    const at = doc.cases.findIndex((c: any) => c.plan.source === 'none' && c.plan.reason === NONE_REASONS[NONE_REASONS.length - 1]);
    assert.ok(at >= 0);
    doc.cases.splice(at, 1);
    fs.writeFileSync(path.join(r, FIXTURE_FILE), JSON.stringify(doc));
  });
  const findings = fixtureFindings(root);
  assert.ok(findings.length >= 1);
  assert.ok(findings.some((f) => f === `G86.4 no fixture case of NoneReason ${NONE_REASONS[NONE_REASONS.length - 1]}`), findings.join('\n'));
});
