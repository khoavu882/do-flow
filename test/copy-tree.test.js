'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverTree, planTree, applyTree, removeTree, verifyTree } = require('../src/adapters/copy-tree');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-copy-tree-')); }

function seedSource(root, files) {
  const sourceDir = path.join(root, 'source');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(sourceDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return sourceDir;
}

function sha256(text) { return require('node:crypto').createHash('sha256').update(text).digest('hex'); }

test('discoverTree lists nested files with source fingerprints and dest existence', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'A');

  const { files } = discoverTree({ sourceDir, destDir });
  const byRel = Object.fromEntries(files.map((f) => [f.relPath, f]));
  assert.equal(files.length, 2);
  assert.equal(byRel['a.md'].exists, true);
  assert.equal(byRel['nested/b.md'].exists, false);
  assert.equal(byRel['a.md'].fingerprint, sha256('A'));
});

test('planTree proposes create for every file on a fresh (empty) destination', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.deepEqual(conflicts, []);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.operation === 'create'));
});

test('applyTree writes files and preserves the source file mode (hook script +x survives)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'hook.sh': '#!/usr/bin/env bash\necho hi\n' });
  fs.chmodSync(path.join(sourceDir, 'hook.sh'), 0o755);
  const destDir = path.join(root, 'dest');

  const { changes } = planTree({ sourceDir, destDir });
  const { applied } = applyTree({ changes });
  assert.equal(applied, 1);
  assert.equal(fs.readFileSync(path.join(destDir, 'hook.sh'), 'utf8'), '#!/usr/bin/env bash\necho hi\n');
  assert.equal(fs.statSync(path.join(destDir, 'hook.sh')).mode & 0o777, 0o755);
});

test('re-planning after an unchanged apply reports zero changes (idempotent convergence)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  const second = planTree({ sourceDir, destDir, previousResources });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('planTree proposes update only for the file whose source content actually changed', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  fs.writeFileSync(path.join(sourceDir, 'a.md'), 'A2');
  const { changes } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].relPath, 'a.md');
  assert.equal(changes[0].operation, 'update');
});

test('planTree proposes remove for a previously-owned file no longer present in source', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  fs.rmSync(path.join(sourceDir, 'b.md'));
  const { changes } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { relPath: 'b.md', target: path.join(destDir, 'b.md'), operation: 'remove', fingerprint: sha256('B') });
});

test('removeTree deletes owned files and refuses a file modified since planning', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });
  const previousResources = [{ relPath: 'a.md', fingerprint: sha256('A') }, { relPath: 'b.md', fingerprint: sha256('B') }];

  const { changes } = planTree({ sourceDir, destDir, previousResources, operation: 'remove' });
  fs.writeFileSync(path.join(destDir, 'b.md'), 'TAMPERED');
  // a.md sorts before the tampered b.md in `changes` — removeTree processes it (and deletes it)
  // before reaching b.md and throwing; a throw on one file does not roll back another's already-
  // completed removal, matching Codex's own remove() semantics (no transactional rollback).
  assert.throws(() => removeTree({ changes }), /Refusing to remove modified copy-tree resource: b\.md/);
  assert.equal(fs.existsSync(path.join(destDir, 'a.md')), false);
  assert.equal(fs.existsSync(path.join(destDir, 'b.md')), true);
});

test('planTree reports a conflict (not a silent overwrite) for a destination file modified outside DoFlow', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = [{ relPath: 'a.md', fingerprint: sha256('A') }];

  fs.writeFileSync(path.join(destDir, 'a.md'), 'HAND-EDITED');
  fs.writeFileSync(path.join(sourceDir, 'a.md'), 'A2');
  const { changes, conflicts } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 0);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /a\.md was modified outside DoFlow/);
});

test('planTree treats an already-present, content-identical file with no ledger record as a safe adoption', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'A'); // e.g. left over from the legacy copy path

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.deepEqual(conflicts, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].operation, 'create');
});

test('planTree reports a conflict for a foreign file with no ledger record and different content than source', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'FOREIGN CONTENT');

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.equal(changes.length, 0);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /a\.md was modified outside DoFlow/);
});

test('verifyTree reports owned resources when on-disk content matches source, and a conflict when it does not', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });

  const ok = verifyTree({ sourceDir, destDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.resources.length, 1);

  fs.writeFileSync(path.join(destDir, 'a.md'), 'DRIFTED');
  const bad = verifyTree({ sourceDir, destDir });
  assert.equal(bad.ok, false);
  assert.equal(bad.conflicts.length, 1);
});

test('discoverTree throws when the source directory itself is missing', () => {
  const root = scratch();
  assert.throws(() => discoverTree({ sourceDir: path.join(root, 'nope'), destDir: path.join(root, 'dest') }),
    /copy-tree source is missing/);
});

// Regression: a destination-only file with no source counterpart (e.g. the generated
// .doflow/guidance/docs/MCP_INDEX.md, written directly by applyLifecycle rather than through
// applyTree) must never surface as a copy-tree resource, conflict, or removal candidate — every
// enumeration in this module walks the SOURCE tree, never the destination tree independently.
test('discoverTree ignores a destination-only file with no source counterpart (orphan generated file)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(path.join(destDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'docs', 'MCP_INDEX.md'), 'generated, not source-tracked');

  const { files } = discoverTree({ sourceDir, destDir });
  assert.equal(files.length, 2);
  assert.ok(!files.some((f) => f.relPath === 'docs/MCP_INDEX.md'));
});

test('verifyTree reports zero conflicts for a destination-only file with no source counterpart', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });
  fs.mkdirSync(path.join(destDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'docs', 'MCP_INDEX.md'), 'generated, not source-tracked');

  const result = verifyTree({ sourceDir, destDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.resources.length, 1);
  assert.ok(!result.resources.some((r) => r.relPath === 'docs/MCP_INDEX.md'));
});

test('planTree never proposes removal of a destination-only file absent from previousResources', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));
  // Simulate MCP_INDEX.md: present on disk, but never registered as a copy-tree ledger resource
  // because it was written directly via fs, not through applyTree.
  fs.mkdirSync(path.join(destDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'docs', 'MCP_INDEX.md'), 'generated, not source-tracked');

  const { changes, conflicts } = planTree({ sourceDir, destDir, previousResources });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(changes, []); // a.md unchanged, no-op; MCP_INDEX.md never considered at all
});

// Regression: DOFLOW_CORE.md's pre-existing generic on-demand block must survive the addition of
// the new `@docs/MCP_INDEX.md` line untouched.
test('DOFLOW_CORE.md still ships the generic on-demand resources block unchanged', () => {
  const doflowCorePath = path.join(__dirname, '..', 'core/shared/guidance/DOFLOW_CORE.md');
  const content = fs.readFileSync(doflowCorePath, 'utf8');
  assert.equal(content.includes('@docs/MCP_INDEX.md'), true);
  assert.ok(content.includes(
    '# On-demand resources (NOT auto-loaded — load manually when needed)\n' +
    '# Behavioral Modes → @modes/\n' +
    '#   MODE_Brainstorming.md     — discovery/requirements sessions\n' +
    '#   MODE_DeepResearch.md      — research sessions\n' +
    '#   MODE_Introspection.md     — debugging/meta-cognition\n' +
    '#   MODE_Orchestration.md     — multi-tool coordination\n' +
    '#   MODE_Task_Management.md   — complex multi-step tasks\n' +
    '#   MODE_Token_Efficiency.md  — high context-usage sessions\n' +
    '#\n' +
    '# MCP Documentation → @mcp/\n' +
    '#   MCP_Context7.md           — when using Context7\n' +
    '#   MCP_Sequential.md         — when using Sequential\n' +
    '#   MCP_ChromeDevTools.md     — when using Chrome DevTools\n' +
    '#   MCP_Playwright.md         — when using Playwright\n' +
    '#\n' +
    '# Reference → @references/\n' +
    '#   DOFLOW_CHAIN.md           - core change multi-workflow with DoFlow\n' +
    '#   CONSTITUTION_BASE.md      - constitution base details\n' +
    '#   RESEARCH_CONFIG.md        — deep research sessions'
  ));
});
