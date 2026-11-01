'use strict';

// AU-P6 (D9): the shipped Claude settings route `git push` and `git tag` through the ask list, so a
// push or a tag never runs on the blanket `Bash(git *:*)` allow. The deny list is untouched. The merge
// keeps a user's own list whole, so the new key reaches an existing settings.json unless the user
// already wrote an `ask` array.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { suiteTempDir } = require('../../helper/tmp.ts');
const claude = require('../../../src/adapters/claude/index.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const SHIPPED = path.join(REPO_ROOT, 'core', 'harnesses', 'claude', 'settings', 'settings.json');
const ASK = ['Bash(git push:*)', 'Bash(git tag:*)', 'Bash(git * push:*)', 'Bash(git * tag:*)'];

function install(existing: any) {
  const repoRoot = suiteTempDir('doflow-permissions-ask-repo-');
  const projectRoot = suiteTempDir('doflow-permissions-ask-project-');
  const sourceDir = path.join(repoRoot, 'core', 'harnesses', 'claude', 'settings');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.copyFileSync(SHIPPED, path.join(sourceDir, 'settings.json'));
  fs.writeFileSync(path.join(sourceDir, 'keybindings.json'), '{}');
  const asset = { id: 'claude.settings', source: 'core/harnesses/claude/settings', renderer: 'claude-settings', capability: 'settings' };
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (existing) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing));
  }
  const context = { repoRoot, assets: [asset] };
  const planned = claude.plan({ assets: [asset], scope: 'project', scopeRoot: projectRoot, context, ledger: { resources: [] } });
  claude.apply({ changes: planned.changes, scope: 'project', scopeRoot: projectRoot, context });
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

test('shipped settings: ask lists push and tag in both spellings, and allow and deny keep their entries', () => {
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.deepEqual(shipped.permissions.ask, ASK);
  assert.ok(shipped.permissions.allow.includes('Bash(git *:*)'), 'the blanket git allow stays');
  assert.deepEqual(shipped.permissions.deny, ['Bash(git push --force*:*)', 'Bash(git reset --hard*:*)', 'Bash(git clean -fd*:*)']);
});

test('a fresh install projects allow, deny and ask', () => {
  const installed = install(null);
  assert.deepEqual(installed.permissions.ask, ASK);
  assert.ok(installed.permissions.allow.includes('Bash(git *:*)'));
  assert.equal(installed.permissions.deny.length, 3);
});

test("a user's own allow and deny arrays stay whole and do not block the new ask key", () => {
  const own = { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] };
  const installed = install({ permissions: own });
  assert.deepEqual(installed.permissions.allow, own.allow, 'the user allow array is not unioned');
  assert.deepEqual(installed.permissions.deny, own.deny, 'the user deny array is not unioned');
  assert.deepEqual(installed.permissions.ask, ASK, 'ask arrives because the user wrote none');
});

test("a user's own ask array wins whole: DoFlow's ask entries are not added to it", () => {
  const installed = install({ permissions: { ask: ['Bash(curl:*)'] } });
  assert.deepEqual(installed.permissions.ask, ['Bash(curl:*)']);
  assert.ok(installed.permissions.allow.includes('Bash(git *:*)'), 'the other lists still arrive');
});
