'use strict';

// Row 179: interface contracts are owned by specs.md §1, so the scaffold reads them there as well as in
// an older design.md's API / Interface Contracts section. An `IC-###` detail heading that names its
// component (`(C1)`), or whose index row does, is attributed to that component; the "interface
// contracts" gap is reported only when neither document declares any.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDesign, parseSpecs } = require('../../../src/runtime/scaffold/artifacts.ts');
const { generateScaffold, SCAFFOLD_DIR_NAME } = require('../../../src/runtime/scaffold/generate.ts');
const { tempDir } = require('../../helper/tmp.ts');

const DESIGN = [
  '# Design: Fixture', '',
  '## 5. Components & Boundaries', '',
  '| ID | Component | Kind | Serves | Status |',
  '|---|---|---|---|---|',
  '| C1 | Name resolver | service | FR-001 | Live |',
  '| C2 | Name store | service | FR-001 | Live |', '',
].join('\n');

const SPECS = [
  '# Specs: Fixture', '',
  '## 1. Interface Contracts', '',
  '| ID | Contract | Family | Kind | Status |',
  '|---|---|---|---|---|',
  '| IC-001 | Resolver contract (C1) | resolve | schema | Live |',
  '| IC-002 | Store contract | store | schema | Live |',
  '| IC-003 | Unattributed contract | misc | schema | Live |', '',
  '**Detail**', '',
  '#### Family: resolve', '',
  '#### IC-001: Resolver contract (C1)', '',
  '```text', 'resolve(name) -> id | null', '```', '',
  '#### IC-002: Store contract', '',
  'put(id, name) stores the pair; C2 owns it.', '',
  '#### IC-003: Unattributed contract', '',
  'Names no component anywhere.', '',
  '#### IC-009: Heading with no index row (C1)', '',
  'ignored: the id is not in the index.', '',
  '## 2. History', '',
  'None — initial version.', '',
].join('\n');

test('specs.md §1: a heading that names its component attributes the contract to it', () => {
  const design = parseDesign(DESIGN);
  assert.equal(parseSpecs(SPECS, design.components), true);
  const declared = design.components.get('C1').declared;
  assert.deepEqual(declared.map((d: any) => [d.heading, d.source]), [['IC-001: Resolver contract (C1)', 'specs.md']]);
  assert.match(declared[0].block, /resolve\(name\) -> id \| null/);
});

test('specs.md §1: a component named only in the index row still gets the contract', () => {
  const design = parseDesign(DESIGN);
  const specs = SPECS.replace('| IC-002 | Store contract |', '| IC-002 | Store contract, owned by C2 |');
  parseSpecs(specs, design.components);
  assert.deepEqual(design.components.get('C2').declared.map((d: any) => d.heading), ['IC-002: Store contract']);
  assert.match(design.components.get('C2').declared[0].block, /put\(id, name\)/);
});

test('specs.md §1: unattributed contracts and headings without an index row declare nothing', () => {
  const design = parseDesign(DESIGN);
  parseSpecs(SPECS, design.components);
  const all = [...design.components.values()].flatMap((c: any) => c.declared.map((d: any) => d.heading));
  assert.ok(!all.some((h: string) => /IC-003|IC-009/.test(h)), JSON.stringify(all));
});

test('specs.md without a §1 Interface Contracts section declares nothing', () => {
  assert.equal(parseSpecs('# Specs\n\n## 2. History\n', parseDesign(DESIGN).components), false);
});

function feature(t: any, { design = DESIGN, specs = null }: { design?: string; specs?: string | null } = {}) {
  const repoRoot = tempDir(t, 'doflow-scaffold-specs-');
  const featureDir = path.join(repoRoot, '001-specs');
  fs.mkdirSync(path.join(featureDir, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(featureDir, 'design'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(featureDir, 'intention', 'requirement.md'), [
    '# Requirement: Fixture', '',
    '## 3. Functional Requirements', '',
    '| ID | Requirement | Stories | Priority | Status |',
    '|---|---|---|---|---|',
    '| FR-001 | The widget resolves a name to an id | US1 | P1 | Live |', '',
    '## 6. Acceptance Criteria', '',
    '- [ ] A known name resolves to its id (FR-001).', '',
  ].join('\n'));
  fs.writeFileSync(path.join(featureDir, 'design', 'design.md'), design);
  if (specs !== null) fs.writeFileSync(path.join(featureDir, 'design', 'specs.md'), specs);
  fs.writeFileSync(path.join(featureDir, 'plan.md'), [
    '# Implementation Plan: Fixture', '',
    '## 7. Tasks', '',
    '### Phase A — build', '',
    '- [ ] A.1 [US1] Build the resolver — owner: core-implementer; files: `src/resolver.js`', '',
  ].join('\n'));
  return { featureDir, repoRoot };
}

const gapNames = (result: any) => result.notEvaluated.filter((n: any) => /interface contracts/.test(n.what)).map((n: any) => n.what);

test('a design with no contracts section and a specs.md §1: the stub quotes the contract and no gap is reported', (t) => {
  const { featureDir, repoRoot } = feature(t, { specs: SPECS });
  const result = generateScaffold({ featureDir, repoRoot });
  assert.deepEqual(gapNames(result), []);
  assert.deepEqual(result.shapeUndeclared, []);
  const stub = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, 'src', 'src', 'resolver.js.stub'), 'utf8');
  assert.match(stub, /declared interface — specs\.md "IC-001: Resolver contract \(C1\)", verbatim:/);
  assert.match(stub, /resolve\(name\) -> id \| null/);
  assert.ok(result.sources.some((s: any) => s.name === 'specs.md' && s.present));
});

test('neither document declares an interface: the gap is reported and the file gets the placeholder', (t) => {
  const { featureDir, repoRoot } = feature(t);
  const result = generateScaffold({ featureDir, repoRoot });
  assert.deepEqual(gapNames(result), ['design.md → interface contracts']);
  assert.equal(result.shapeUndeclared.length, 1);
  assert.ok(!result.sources.some((s: any) => s.name === 'specs.md'));
});

test('a specs.md whose §1 says N/A is a declaration, not a gap; the file still gets the placeholder', (t) => {
  const { featureDir, repoRoot } = feature(t, { specs: '# Specs\n\n## 1. Interface Contracts\n\nN/A: no interface.\n' });
  const result = generateScaffold({ featureDir, repoRoot });
  assert.deepEqual(gapNames(result), []);
  assert.equal(result.shapeUndeclared.length, 1);
});

test('an older design.md that carries its own contracts section still declares them, with no specs.md', (t) => {
  const design = `${DESIGN}\n## 6. API / Interface Contracts\n\n### 6.1 Resolver contract (C1)\n\n\`\`\`text\nresolve(name) -> id | null\n\`\`\`\n`;
  const { featureDir, repoRoot } = feature(t, { design });
  const result = generateScaffold({ featureDir, repoRoot });
  assert.deepEqual(gapNames(result), []);
  assert.deepEqual(result.shapeUndeclared, []);
  const stub = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, 'src', 'src', 'resolver.js.stub'), 'utf8');
  assert.match(stub, /declared interface — design\.md "6\.1 Resolver contract \(C1\)"/);
});

// The design template gives each component a `- **Contracts:**` line and its specs.md has no `(C#)`: that line is
// the attribution, with a run `IC-003 to IC-006` standing for every id between and a list naming each.
const TEMPLATE_DESIGN = [
  DESIGN.trimEnd(), '',
  '**Detail**', '',
  '- **C1:** Name resolver',
  '  - **Responsibility:** resolves names.',
  '  - **Contracts:** FR-001, IC-001.', '',
  '- **C2:** Name store',
  '  - **Contracts:** IC-002, IC-004 to IC-005 and',
  '    IC-007.', '',
  '## 6. Design Risks & Alternatives Considered', '',
].join('\n');

const TEMPLATE_SPECS = [
  '# Specs: Fixture', '',
  '## 1. Interface Contracts', '',
  '| ID | Contract | Family | Kind | Status |',
  '|---|---|---|---|---|',
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `| IC-00${n} | Contract ${n} | f | schema | Live |`), '',
  '**Detail**', '',
  ...[1, 2, 3, 4, 5, 6, 7].flatMap((n) => [`#### IC-00${n}: Contract ${n}`, '', `body ${n}`, '']),
  '## 2. History', '',
].join('\n');

test('specs.md §1 with no (C#): a component\'s design §5 Contracts line attributes ids, lists and runs', () => {
  const design = parseDesign(TEMPLATE_DESIGN);
  assert.equal(parseSpecs(TEMPLATE_SPECS, design.components), true);
  const headings = (id: string) => design.components.get(id).declared.map((d: any) => d.heading);
  assert.deepEqual(headings('C1'), ['IC-001: Contract 1']);
  assert.deepEqual(headings('C2'), ['IC-002: Contract 2', 'IC-004: Contract 4', 'IC-005: Contract 5', 'IC-007: Contract 7']);
});

test('a template-shaped specs.md and design §5 Contracts line: the stub quotes the contract, no gap', (t) => {
  const { featureDir, repoRoot } = feature(t, { design: TEMPLATE_DESIGN, specs: TEMPLATE_SPECS });
  const result = generateScaffold({ featureDir, repoRoot });
  assert.deepEqual(gapNames(result), []);
  assert.deepEqual(result.shapeUndeclared, []);
  const stub = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, 'src', 'src', 'resolver.js.stub'), 'utf8');
  assert.match(stub, /declared interface — specs\.md "IC-001: Contract 1", verbatim:/);
});

test('the placeholder reason says no contract is attributed to the file\'s component', (t) => {
  const { featureDir, repoRoot } = feature(t);
  const result = generateScaffold({ featureDir, repoRoot });
  assert.match(result.shapeUndeclared[0].why, /no contract is attributed to this file's component/);
});

test('the manifest\'s shape cell names the document a declared interface came from', (t) => {
  const fromSpecs = feature(t, { specs: SPECS });
  generateScaffold({ featureDir: fromSpecs.featureDir, repoRoot: fromSpecs.repoRoot });
  const specsManifest = fs.readFileSync(path.join(fromSpecs.featureDir, SCAFFOLD_DIR_NAME, 'MANIFEST.md'), 'utf8');
  assert.match(specsManifest, /`design\/specs\.md` \(when present\)/, 'the manifest header names all four documents it reads');
  assert.match(specsManifest, /\| declared interface \(specs\.md\) \+ placeholder signature \|/);

  const design = `${DESIGN}\n## 6. API / Interface Contracts\n\n### 6.1 Resolver contract (C1)\n\n\`\`\`text\nresolve(name) -> id | null\n\`\`\`\n`;
  const fromDesign = feature(t, { design });
  generateScaffold({ featureDir: fromDesign.featureDir, repoRoot: fromDesign.repoRoot });
  const designManifest = fs.readFileSync(path.join(fromDesign.featureDir, SCAFFOLD_DIR_NAME, 'MANIFEST.md'), 'utf8');
  assert.match(designManifest, /\| declared interface \(design\.md\) \+ placeholder signature \|/);
});
