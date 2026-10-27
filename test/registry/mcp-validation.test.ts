'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');

function errorsOf(mutate: (doc: any) => void): string {
  const doc = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(doc);
  const result = validateRegistry(doc, { repoRoot: REPO });
  return (result.errors || []).join('\n');
}

test('mcp step validation: accepts valid expectedWhen conditions', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const server = registry.mcp.find((s: any) => s.id === 'context7');
  assert.ok(server, 'context7 server must exist in registry');

  const conditions = server.steps.map((s: any) => s.expectedWhen).filter(Boolean);
  assert.ok(conditions.includes('research-request'), 'carries research-request');
  assert.ok(conditions.includes('dependency-change'), 'carries dependency-change');
  assert.ok(conditions.includes('manifest-review'), 'carries manifest-review');

  const validation = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(validation.ok, true, 'registry validation must pass');
});

test('mcp step validation: rejects unknown expectedWhen condition', () => {
  const err1 = errorsOf((r: any) => {
    r.mcp[0].steps[0].expectedWhen = 'unknown-condition';
  });
  assert.match(err1, /expectedWhen must be one of: research-request, dependency-change, manifest-review/);

  const err2 = errorsOf((r: any) => {
    r.mcp[0].steps[0].expectedWhen = 42;
  });
  assert.match(err2, /expectedWhen must be one of: research-request, dependency-change, manifest-review/);
});

test('mcp step validation: allows different expectedWhen conditions for same skill and file', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const context7 = registry.mcp.find((s: any) => s.id === 'context7');
  const docSteps = context7.steps.filter((s: any) => s.skill === 'do-document');
  assert.ok(docSteps.length >= 2, 'do-document has multiple steps with different conditions');

  const validation = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(validation.ok, true, 'validates cleanly with multiple conditional steps');
});

test('mcp step validation: rejects exact duplicates (same skill, file, and expectedWhen)', () => {
  const err = errorsOf((r: any) => {
    const c7 = r.mcp.find((s: any) => s.id === 'context7');
    c7.steps.push({ ...c7.steps[0] });
  });
  assert.match(err, /duplicates skill 'do-brainstorm' and file 'SKILL.md'/);
});
