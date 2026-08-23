'use strict';

// G-Paths — Stage 3 guard family for the declared native path facts in core/registry/harnesses.json
// ("paths" per harness). Two questions no other test asks:
//   1. Does every harness DECLARE its paths, and does every declaration parse into the minimal
//      {base, segments} shape the loader accepts? (A declaration that silently stopped parsing
//      would otherwise only surface as an adapter falling back to hardcoded literals.)
//   2. Do DECLARED paths match what a REAL install lands on disk? One cheap probe install
//      (claude, project scope) cross-checks the resolver's output against the actual native tree —
//      the same class of drift G5 catches for capabilities, applied to paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadRegistry } = require('../../src/registry');
const { validatePathsSection, resolveHarnessPaths } = require('../../src/helper/harness-paths');
const { REPO } = require('./_shared');

const registry = loadRegistry({ repoRoot: REPO });

test('G-Paths: every harness declares a paths section and every rule parses cleanly', () => {
  const offenders = [];
  for (const harness of registry.harnesses) {
    if (!harness.paths || typeof harness.paths !== 'object' || Object.keys(harness.paths).length === 0) {
      offenders.push(`${harness.id}: no paths section declared`);
      continue;
    }
    offenders.push(...validatePathsSection(harness.paths, harness.id));
  }
  assert.deepEqual(offenders, [], `declared paths must parse into the minimal schema:\n  ${offenders.join('\n  ')}`);
});

test('G-Paths: declarations are consistent — every uniform-rule surface exists in both scopes', () => {
  // A scoped form with only one scope is meaningful (project-only surfaces like copilot's
  // instruction file); but a TYPO'd scope key would fail validation upstream, so here we pin the
  // softer invariant: scoped entries must name their scopes correctly, and every resolved user-
  // scope path must live under home while project-scope paths live under the project root.
  const offenders = [];
  // The resolver path.resolve()s its scope inputs, so the prefix to assert against must be
  // resolved the same way — on Windows '/proj' resolves to '<drive>:\proj', not '\proj'.
  const projectRootPrefix = path.resolve('/proj');
  const homePrefix = path.resolve('/home');
  for (const harness of registry.harnesses) {
    for (const [name, value] of Object.entries(harness.paths || {})) {
      const project = resolveHarnessPaths({ [name]: value }, { scope: 'project', scopeRoot: '/proj', homeDir: '/home' })[name];
      const user = resolveHarnessPaths({ [name]: value }, { scope: 'global', scopeRoot: '/home', homeDir: '/home' })[name];
      if (project !== null && !project.startsWith(projectRootPrefix)) offenders.push(`${harness.id}.${name}: project resolution escaped the project root (${project})`);
      if (user !== null && !user.startsWith(homePrefix)) offenders.push(`${harness.id}.${name}: user resolution escaped the home root (${user})`);
    }
  }
  assert.deepEqual(offenders, [], `declarations must resolve under their scope root:\n  ${offenders.join('\n  ')}`);
});

test('G-Paths: a real claude project install lands exactly on the declared paths', () => {
  // One CLI spawn is the whole runtime cost; claude is the cheapest full-featured target.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-gpaths-'));
  const project = path.join(sandbox, 'proj');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  try {
    const installed = spawnSync('node', [path.join(REPO, 'bin', 'doflow.js'), 'install', project, '-f', '--no-backup', '-t', 'claude'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(installed.status, 0, `probe install failed: ${installed.stderr}`);

    const harness = registry.harnesses.find((item) => item.id === 'claude');
    const resolved = resolveHarnessPaths(harness.paths, { scope: 'project', scopeRoot: project, homeDir: home });
    // Every declared FILE surface that this install projects must exist at exactly the declared
    // location — instructions/settings/keybindings/statusline come from assets, mcp from selection.
    for (const surface of ['instructions', 'settings', 'keybindings']) {
      assert.ok(fs.existsSync(resolved[surface]), `${surface} did not land at the declared path ${resolved[surface]}`);
    }
    // The config dir holds the projected trees at their declared root.
    for (const dir of ['skills', 'agents', 'hooks']) {
      assert.ok(fs.existsSync(path.join(resolved.configDir, dir)), `${dir}/ missing under the declared configDir`);
    }
    // And nothing landed OUTSIDE the declaration: the instruction file must not also exist at the
    // historical wrong guess (the project root), which is the drift class this guard exists for.
    assert.ok(!fs.existsSync(path.join(project, 'CLAUDE.md')), 'a CLAUDE.md at the project root contradicts the declared .claude/CLAUDE.md path');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
