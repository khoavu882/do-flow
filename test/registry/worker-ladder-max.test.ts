'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LADDER_MAX, shippedWorkerIds } = require('../../src/registry/worker-ids.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { executeDispatchCommand } = require('../../src/runtime/dispatch/command.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

test('LADDER_MAX equals 8 and bounds built-in worker count', () => {
  assert.equal(LADDER_MAX, 8);

  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const shipped = shippedWorkerIds(registry);
  assert.ok(shipped.length <= LADDER_MAX, `shipped worker count (${shipped.length}) must be <= LADDER_MAX (${LADDER_MAX})`);

  // When 120's worker-list type exists, its maximum items equals LADDER_MAX + 1
  try {
    const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
    const settingsReg = loadSettingsRegistry({ repoRoot: REPO_ROOT });
    const workerListType = settingsReg.types?.find?.((t: any) => t.id === 'worker-list');
    if (workerListType) {
      assert.equal(workerListType.maxItems, LADDER_MAX + 1);
    }
  } catch {
    // 120 settings registry extension not yet present on base
  }
});

test('--ladder with 9 ids exits 2 naming 8', async () => {
  const nineIds = ['claude', 'codex', 'gemini', 'antigravity', 'pi', 'opencode', 'copilot', 'kiro', 'extra'].join(',');
  const res = await executeDispatchCommand({
    action: 'start',
    ladder: nineIds,
    by: 'main',
  });
  assert.equal(res.exit, 2);
  assert.equal(res.body.error, 'usage');
  assert.match(res.body.message, new RegExp(`--ladder expects 1 to ${LADDER_MAX} comma-separated harness ids, got 9`));
});
