'use strict';

// IC-001: `partitionExternalDependencies` skips task-id `depends-on:` values, and an
// `external-contract:` left with no external value is reported as `external-contract-orphaned`
// in MANIFEST.md's not-evaluated gaps instead of being dropped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateScaffold, SCAFFOLD_DIR_NAME, MANIFEST_NAME } = require('../../src/runtime/scaffold/generate.ts');
const { tempDir } = require('../helper/tmp.ts');

function feature(root, taskLines) {
  const featureDir = path.join(root, '001-deps');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(featureDir, 'requirement.md'), [
    '# Requirement: Deps', '',
    '## 3. Functional Requirements', '',
    '| ID | Requirement | Stories | Priority | Status |',
    '|---|---|---|---|---|',
    '| FR-001 | The widget works | US1 | P1 | Live |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(featureDir, 'design.md'), [
    '# Design: Deps', '',
    '## 3. Components & Boundaries', '',
    '| ID | Component | Kind | Serves | Status |',
    '|---|---|---|---|---|',
    '| C1 | Widget | service | FR-001 | Live |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(featureDir, 'plan.md'), [
    '# Implementation Plan: Deps', '',
    '## 8. Tasks', '',
    '### Phase A — build', '',
    ...taskLines, '',
  ].join('\n'));
  return { featureDir, repoRoot: root };
}

function run(t, prefix, taskLines) {
  const { featureDir, repoRoot } = feature(tempDir(t, prefix), taskLines);
  const result = generateScaffold({ featureDir, repoRoot });
  const manifest = fs.readFileSync(path.join(featureDir, SCAFFOLD_DIR_NAME, MANIFEST_NAME), 'utf8');
  return { result, manifest };
}

test('IC-001: a task-id depends-on value produces no dependency frame', (t) => {
  const { result, manifest } = run(t, 'doflow-scaffold-deps-taskid-', [
    '- [ ] A.1 [US1] Build — owner: core-implementer; files: `src/a.js`',
    '- [ ] A.2 [US1] Extend — owner: core-implementer; files: `src/b.js`; depends-on: A.1',
  ]);
  assert.deepEqual(result.externalDependencies, []);
  assert.match(manifest, /_No task declares a `depends-on:` value\._/);
  assert.ok(!result.notEvaluated.some((n) => /external-contract-orphaned/.test(n.why)));
});

test('IC-001: a service depends-on value still produces a dependency frame beside a task-id one', (t) => {
  const { result } = run(t, 'doflow-scaffold-deps-service-', [
    '- [ ] A.1 [US1] Build — owner: core-implementer; files: `src/a.js`',
    '- [ ] A.2 [US1] Wire — owner: core-implementer; files: `src/b.js`; depends-on: A.1, vendor/lookup-api; external-contract: lookup-api.md',
  ]);
  assert.deepEqual(result.externalDependencies.map((d) => [d.dependency, d.tasks]), [['vendor/lookup-api', ['A.2']]]);
  assert.match(result.externalDependencies[0].disposition, /frame from lookup-api\.md/);
  assert.ok(!result.notEvaluated.some((n) => /external-contract-orphaned/.test(n.why)));
});

test('IC-001: an external-contract left with only task-id dependencies is named in the manifest', (t) => {
  const { result, manifest } = run(t, 'doflow-scaffold-deps-orphan-', [
    '- [ ] A.1 [US1] Build — owner: core-implementer; files: `src/a.js`',
    '- [ ] A.2 [US1] Wire — owner: core-implementer; files: `src/b.js`; depends-on: A.1; external-contract: lookup-api.md',
  ]);
  assert.deepEqual(result.externalDependencies, []);
  const gap = result.notEvaluated.find((n) => /external-contract-orphaned/.test(n.why));
  assert.ok(gap, `no external-contract-orphaned gap in ${JSON.stringify(result.notEvaluated)}`);
  assert.match(gap.what, /A\.2 external-contract: lookup-api\.md/);
  const notEvaluatedSection = manifest.slice(manifest.indexOf('## Not evaluated'), manifest.indexOf('## External dependencies'));
  assert.match(notEvaluatedSection, /A\.2 external-contract: lookup-api\.md.*external-contract-orphaned/);
  assert.notEqual(result.status, 'COMPLETE');
});
