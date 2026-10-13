'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const context = require('../../bench/perf/lib/context.js');
const { alwaysLoaded } = require('../helper/always-loaded.js');
const { tempDir } = require('../helper/tmp.js');

test('computeStartupContext returns records for all 8 harnesses with IC-019 schema', () => {
  const result = context.computeStartupContext();
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 8);

  const always = alwaysLoaded();
  const expectedProjectedBytes = always.files.reduce((sum, f) => sum + f.bytes, 0);

  for (const row of result) {
    assert.equal(typeof row.harness, 'string');
    assert.ok(row.installedVersion === null || typeof row.installedVersion === 'string');
    assert.equal(row.doflowProjectedBytes, expectedProjectedBytes);
    assert.ok(
      typeof row.sessionStartStdoutBytes === 'number' ||
        (typeof row.sessionStartStdoutBytes === 'object' && typeof row.sessionStartStdoutBytes.unmeasured === 'string')
    );
    const hookBytes = typeof row.sessionStartStdoutBytes === 'number' ? row.sessionStartStdoutBytes : 0;
    assert.equal(row.tokensEst, Math.ceil((expectedProjectedBytes + hookBytes) / 4));
    assert.equal(row.tokensBasis, 'estimated:bytes/4');
    assert.deepEqual(row.harnessNative, { unmeasured: 'needs a model call (paid)' });
  }
});

test('computeContextBudgets returns IC-019 budget rows with profile-required defaults', () => {
  const budgets = context.computeContextBudgets();
  assert.equal(Array.isArray(budgets), true);
  assert.equal(budgets.length, 8);

  for (const b of budgets) {
    assert.equal(typeof b.harness, 'string');
    assert.equal(b.capacityTokens, null);
    assert.equal(b.capacityBasis, 'profile-required');
    assert.equal(typeof b.startupTokens, 'number');
    assert.ok(b.startupTokens > 0);
    assert.equal(b.startupBasis, 'estimated');
    assert.equal(b.reserveTokens, 0);
    assert.equal(b.reserveBasis, 'estimated');
    assert.equal(b.availableTokens, null);
    assert.equal(b.availableBasis, 'profile-required');
  }
});

test('computeStartupContext handles uninstalled harness and custom version injection', () => {
  const stubHarnesses = ['custom-installed', 'custom-absent'];
  const isToolInstalledFn = (tool) => tool === 'custom-installed';
  const getToolVersionFn = (tool) => (tool === 'custom-installed' ? 'v9.8.7' : null);

  const startup = context.computeStartupContext({
    harnesses: stubHarnesses,
    isToolInstalledFn,
    getToolVersionFn,
    alwaysLoadedFn: () => ({ files: [{ rel: 'a.md', bytes: 100 }] }),
  });

  assert.equal(startup.length, 2);

  const inst = startup.find((s) => s.harness === 'custom-installed');
  assert.equal(inst.installedVersion, 'v9.8.7');
  assert.equal(inst.doflowProjectedBytes, 100);
  assert.deepEqual(inst.sessionStartStdoutBytes, { unmeasured: 'no session-start hook' });
  assert.equal(inst.tokensEst, 25);

  const absent = startup.find((s) => s.harness === 'custom-absent');
  assert.equal(absent.installedVersion, null);
  assert.equal(absent.doflowProjectedBytes, 100);
  assert.deepEqual(absent.sessionStartStdoutBytes, { unmeasured: 'harness not installed' });
  assert.equal(absent.tokensEst, 25);
});

test('computeStartupContext executes session-start hook with fixture when present', (t) => {
  const dir = tempDir(t, 'doflow-test-session-start-');
  const claudeHooksDir = path.join(dir, 'core', 'harnesses', 'claude', 'hooks');
  fs.mkdirSync(claudeHooksDir, { recursive: true });

  // Hook writes 20 characters to stdout
  const hookScript = '#!/bin/bash\nprintf "01234567890123456789"\n';
  fs.writeFileSync(path.join(claudeHooksDir, 'session-start.sh'), hookScript);

  // Fixture
  const fixturesDir = path.join(dir, 'bench', 'perf', 'fixtures', 'claude');
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(path.join(fixturesDir, 'session-start.json'), '{"session_id":"test"}');

  const startup = context.computeStartupContext({
    repoRoot: dir,
    harnesses: ['claude'],
    isToolInstalledFn: () => true,
    getToolVersionFn: () => '2.0.0',
    alwaysLoadedFn: () => ({ files: [{ rel: 'a.md', bytes: 40 }] }),
  });

  assert.equal(startup.length, 1);
  const row = startup[0];
  assert.equal(row.doflowProjectedBytes, 40);
  assert.equal(row.sessionStartStdoutBytes, 20);
  // Total bytes: 40 + 20 = 60 => tokens = ceil(60 / 4) = 15
  assert.equal(row.tokensEst, 15);
});

test('computeContextBudgets calculates availableTokens when capacity is declared', () => {
  const startup = [
    {
      harness: 'claude',
      tokensEst: 2500,
    },
  ];

  const budgets = context.computeContextBudgets({
    startupContext: startup,
    declaredCapacities: {
      claude: 200000,
    },
  });

  assert.equal(budgets.length, 1);
  const b = budgets[0];
  assert.equal(b.harness, 'claude');
  assert.equal(b.capacityTokens, 200000);
  assert.equal(b.capacityBasis, 'declared');
  assert.equal(b.startupTokens, 2500);
  assert.equal(b.reserveTokens, 0);
  // available = 200000 - 2500 - 0 = 197500
  assert.equal(b.availableTokens, 197500);
  assert.equal(b.availableBasis, 'estimated');
});
