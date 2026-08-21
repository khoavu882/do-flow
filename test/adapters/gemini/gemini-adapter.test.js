'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGeminiAdapter, nativePaths, MARKER_START } = require('../../../src/adapters/gemini');
const { assertAdapter } = require('../../../src/adapters');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-gemini-')); }
const assets = [{ id: 'guidance.core', source: 'core/CLAUDE.md' }];

test('implements the adapter contract and resolves official project/user native paths', () => {
  assertAdapter(createGeminiAdapter(), 'Gemini');
  const root = scratch();
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).instruction, path.join(root, 'GEMINI.md'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).instruction, path.join(root, '.gemini', 'GEMINI.md'));
});

test('plans and applies a managed GEMINI.md section without overwriting foreign content', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.changes[0].operation, 'create');
  assert.equal(planned.surfaces.mcp.status, 'supported');
  adapter.apply({ changes: planned.changes });
  const instruction = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  assert.match(instruction, /# DoFlow/);
  assert.match(instruction, new RegExp(MARKER_START));
  const verify = adapter.verify({ scope: 'project', scopeRoot: root, assets });
  assert.equal(verify.ok, true);
  assert.equal(verify.resources.length, 1);
});

test('preserves foreign GEMINI.md and reports unsupported policy automation plus extension workflow', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Personal instructions\n');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow', policies: [{ id: 'stop-check' }] } });
  assert.match(planned.conflicts[0], /without a DoFlow managed section/);
  assert.deepEqual(planned.surfaces.policies, [{ id: 'stop-check', status: 'unavailable', fallback: 'guidance', reason: 'Gemini policy automation is not rendered by this adapter' }]);
  assert.equal(planned.surfaces.extensions.status, 'different');
});

// The helper-script and template trees were declared 'unavailable' for Gemini against a generic
// docs root, so no install received them — while every chain skill resolves its paths through
// do-paths.sh. This pins the projection so the gap cannot silently reopen.
test('projects the shared helper-script and template trees into the doflow directory', () => {
  const { loadRegistry, selectAssets, harnessFor } = require('../../../src/registry');
  const { projectAdapterInput } = require('../../../src/adapters');
  const repoRoot = path.resolve(__dirname, "../../..");
  const registry = loadRegistry({ repoRoot });
  const harness = harnessFor(registry, 'gemini');
  const adapter = createGeminiAdapter();

  // The `scripts` capability now carries two assets with deliberately different placement:
  // `scripts.doflow` is the harness-neutral shared tree that must land in `.doflow/scripts`, while
  // `locator.doflow` is the per-harness entrypoint shim that must land inside the harness's own
  // directory. Selecting by id keeps this test asserting the shared-tree property it was written
  // for; the locator's own placement is asserted separately below rather than left uncovered.
  for (const [capability, assetId] of [['scripts', 'scripts.doflow'], ['templates', 'templates.doflow']]) {
    // selectAssets filters out unavailable capabilities, so this returning an asset at all is the
    // behavioural difference: while the declaration said 'unavailable', no Gemini install could
    // receive the tree — and every chain skill resolves its paths through do-paths.sh.
    const selected = selectAssets(registry, { harness: 'gemini', capability }).filter((a) => a.id === assetId);
    assert.equal(selected.length, 1, `gemini must receive exactly one ${assetId} asset`);
    const root = scratch();
    const input = projectAdapterInput({
      registry, harness, scope: 'global', scopeRoot: root, assets: selected, context: { repoRoot, homeDir: root },
    });
    assert.equal(input.assets[0].renderer, 'copy-tree');
    const planned = adapter.plan({ ...input, ledger: { resources: [] } });
    assert.equal(planned.conflicts.length, 0);
    assert.ok(planned.changes.length > 0, `${capability} projection planned no files`);
    // nativeDir escapes .gemini/ on purpose: the tree is harness-neutral and shared, exactly as for
    // the other two harnesses, so all three read helpers and templates from one location.
    for (const change of planned.changes) {
      assert.ok(change.target.startsWith(path.join(root, '.doflow', capability)),
        `${capability} must land in .doflow/${capability}, got ${change.target}`);
    }
  }
});

// The locator is the counterpart to the tree above: the shared tree is harness-neutral and lands
// once in `.doflow/`, while this shim is projected per harness and must land INSIDE that harness's
// own directory — it is the only thing a skill can name by a literal relative path. It is also the
// first runtime-path asset to reach opencode, pi, copilot and kiro, which until now received chain
// skills referencing scripts they never got, so all seven are checked rather than gemini alone.
test('the runtime locator is projected into every harness, inside that harness own directory', () => {
  const { loadRegistry, selectAssets, harnessFor } = require('../../../src/registry');
  const { projectAdapterInput } = require('../../../src/adapters');
  const repoRoot = path.resolve(__dirname, "../../..");
  const registry = loadRegistry({ repoRoot });

  for (const id of ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro']) {
    const selected = selectAssets(registry, { harness: id, capability: 'scripts' })
      .filter((a) => a.id === 'locator.doflow');
    assert.equal(selected.length, 1, `${id} must receive the runtime locator`);
    const root = scratch();
    const input = projectAdapterInput({
      registry, harness: harnessFor(registry, id), scope: 'global', scopeRoot: root, assets: selected,
      context: { repoRoot, homeDir: root },
    });
    assert.equal(input.assets[0].renderer, 'copy-tree');
    for (const target of input.assets[0].targets ?? []) {
      // Never the shared .doflow tree: a locator there could not be reached by a literal relative
      // path from a skill, which is the single thing it exists to make possible.
      assert.ok(!target.includes(`${path.sep}.doflow${path.sep}`),
        `${id} locator must not land in the shared .doflow tree, got ${target}`);
    }
  }
});

// The shim is exec'd directly by skill prose, so a non-executable mode makes every chain skill fail
// at its first runtime call. `applyTree` copies the source mode verbatim, so the bit has to be
// right in the repo — and Write creates 0644, which is exactly how this was missed once already.
test('the locator source is executable', () => {
  const src = path.resolve(__dirname, '../../..', 'core', 'harnesses', 'shared', 'locator', 'doflow-run');
  assert.ok(fs.existsSync(src), 'locator source is missing');
  assert.ok(fs.statSync(src).mode & 0o111, 'locator must be executable — applyTree copies the source mode verbatim');
});

// The pointer source carries one hardcoded `../`, correct only when the instruction file sits a
// level below the install root. Gemini reads a project-level GEMINI.md from the workspace ROOT, so
// that prefix pointed above the install and the entire guidance chain silently failed to load —
// the install still reported success, because the file was written correctly and only its content
// aimed at nothing. Depth varies by SCOPE, not by harness, so no static pointer can satisfy both.
test('the guidance import resolves from wherever GEMINI.md lands, in either scope', () => {
  const { loadRegistry, selectAssets, harnessFor } = require('../../../src/registry');
  const { projectAdapterInput } = require('../../../src/adapters');
  const repoRoot = path.resolve(__dirname, "../../..");
  const registry = loadRegistry({ repoRoot });
  const harness = harnessFor(registry, 'gemini');
  const adapter = createGeminiAdapter();
  const selected = selectAssets(registry, { harness: 'gemini' })
    .filter((a) => ['guidance.core', 'guidance.context-layer'].includes(a.id));

  for (const scope of ['project', 'global']) {
    const root = scratch();
    const input = projectAdapterInput({
      registry, harness, scope, scopeRoot: root, assets: selected, context: { repoRoot, homeDir: root },
    });
    const planned = adapter.plan({ ...input, ledger: { resources: [] } });
    const instruction = planned.changes.find((c) => c.assetId === 'guidance.core');
    assert.ok(instruction, `${scope}: no instruction change planned`);

    const imported = instruction.content.split('\n').find((l) => l.startsWith('@'));
    assert.ok(imported, `${scope}: rendered instruction has no @import`);
    // Resolve the emitted path the way the agent will: relative to the file's own directory.
    const resolved = path.resolve(path.dirname(instruction.target), imported.slice(1).trim());
    const expected = path.resolve(root, '.doflow', 'guidance', 'DOFLOW_CORE.md');
    assert.equal(resolved, expected,
      `${scope}: '${imported}' from ${instruction.target} resolves to ${resolved}, not the installed guidance tree`);
  }
});

test('remove strips only the managed section, preserving foreign content on both sides', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  adapter.apply({ changes: install.changes });
  const managed = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'GEMINI.md'), `# Before notes\n${managed}# After notes\n`);
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].operation, 'remove');
  adapter.remove({ changes: removal.changes });
  const remaining = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  assert.match(remaining, /# Before notes/);
  assert.match(remaining, /# After notes/);
  assert.doesNotMatch(remaining, new RegExp(MARKER_START));
});

test('remove deletes the file only once nothing but the managed section remains', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  adapter.apply({ changes: install.changes });
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, 'GEMINI.md')), false);
});

test('remove is a no-op on a foreign GEMINI.md that DoFlow never owned', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Personal instructions\n');
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  assert.equal(removal.changes.length, 0);
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8'), '# Personal instructions\n');
});

test('invalid native settings block settings/MCP planning but never mutate the file', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const settings = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7' }] });
  assert.equal(planned.surfaces.settings.status, 'invalid');
  assert.equal(planned.surfaces.mcp.status, 'blocked');
  assert.match(planned.conflicts[0], /Invalid JSON/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
});

test('project-scope config directory is .agents/, not .gemini/ (Antigravity convention)', () => {
  const root = scratch();
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).configDir, path.join(root, '.agents'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).configDir, path.join(root, '.gemini', 'config'));
});

function copyTreeAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('Gemini adapter plans, applies, and verifies a copy-tree asset under .agents/ for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.changes.length, 1);
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  assert.equal(verified.resources.length, 1);

  const ledger = { resources: verified.resources.map((r) => ({ harness: 'gemini', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Gemini adapter installs the same copy-tree asset under .gemini/config/ for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(path.join(root, '.gemini', 'config', 'skills', 'do-analyze', 'SKILL.md'), 'utf8'), '# do-analyze\n');
});

test('Gemini adapter removes only fingerprint-matching copy-tree files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const ledger = { resources: [{ harness: 'gemini', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: first.changes[0].fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md')), false);
});
