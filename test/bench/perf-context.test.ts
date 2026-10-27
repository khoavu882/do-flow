'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const context = require('../../bench/perf/lib/context.ts');
const { alwaysLoaded } = require('../helper/always-loaded.ts');
const { tempDir } = require('../helper/tmp.ts');

test('computeStartupContext returns records for all 7 harnesses with IC-019 schema', () => {
  const result = context.computeStartupContext();
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 7);

  const always = alwaysLoaded();
  const expectedProjectedBytes = always.files.reduce((sum: any, f: any) => sum + f.bytes, 0);

  for (const row of result) {
    assert.equal(typeof row.harness, 'string');
    assert.ok(row.installedVersion === null || typeof row.installedVersion === 'string');
    assert.equal(row.doflowProjectedBytes, expectedProjectedBytes);
    assert.ok(
      typeof row.sessionStartStdoutBytes === 'number' ||
        (typeof row.sessionStartStdoutBytes === 'object' && typeof row.sessionStartStdoutBytes.unmeasured === 'string')
    );
    assert.ok(
      typeof row.sessionStartStderrBytes === 'number' ||
        (typeof row.sessionStartStderrBytes === 'object' && typeof row.sessionStartStderrBytes.unmeasured === 'string')
    );
    assert.equal(row.sessionStartBasis, 'measured:temp-home-install');
    assert.deepEqual(row.perPromptStdoutBytes, { unmeasured: 'owner 077' });
    const hookBytes = typeof row.sessionStartStdoutBytes === 'number' ? row.sessionStartStdoutBytes : 0;
    assert.equal(row.tokensEst, Math.ceil((expectedProjectedBytes + hookBytes) / 4));
    assert.equal(row.tokensBasis, 'estimated:bytes/4');
    assert.deepEqual(row.harnessNative, { unmeasured: 'needs a model call (paid)' });
  }
});

test('computeContextBudgets reports injected unverified IC-019 profile facts', () => {
  const harnesses = ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
  const contextProfiles = Object.fromEntries(harnesses.map((harness) => [harness, {
    capacityTokens: { unverified: 'fixture capacity', verifiedOn: '2026-10-13' },
    reserveTokens: { unverified: 'fixture reserve', verifiedOn: '2026-10-13' },
  }]));
  const budgets = context.computeContextBudgets({ contextProfiles });
  assert.equal(Array.isArray(budgets), true);
  assert.equal(budgets.length, 7);

  for (const b of budgets) {
    assert.equal(typeof b.harness, 'string');
    assert.equal(b.capacityTokens, null);
    assert.equal(b.capacityBasis, 'unverified:fixture capacity');
    assert.equal(typeof b.startupTokens, 'number');
    assert.ok(b.startupTokens > 0);
    assert.equal(b.startupBasis, 'estimated');
    assert.equal(b.reserveTokens, null);
    assert.equal(b.reserveBasis, 'unverified:fixture reserve');
    assert.equal(b.availableTokens, null);
    assert.equal(b.availableBasis, 'profile-required');
  }
});

test('computeStartupContext handles uninstalled harness and custom version injection (dropping isToolInstalled gate)', () => {
  const stubHarnesses = ['custom-installed', 'custom-absent'];
  const isToolInstalledFn = (tool: any) => tool === 'custom-installed';
  const getToolVersionFn = (tool: any) => (tool === 'custom-installed' ? 'v9.8.7' : null);

  const startup = context.computeStartupContext({
    harnesses: stubHarnesses,
    isToolInstalledFn,
    getToolVersionFn,
    alwaysLoadedFn: () => ({ files: [{ rel: 'a.md', bytes: 100 }] }),
  });

  assert.equal(startup.length, 2);

  const inst = startup.find((s: any) => s.harness === 'custom-installed');
  assert.equal(inst.installedVersion, 'v9.8.7');
  assert.equal(inst.doflowProjectedBytes, 100);
  assert.deepEqual(inst.sessionStartStdoutBytes, { unmeasured: 'no session-start hook' });
  assert.equal(inst.tokensEst, 25);

  const absent = startup.find((s: any) => s.harness === 'custom-absent');
  assert.equal(absent.installedVersion, null);
  assert.equal(absent.doflowProjectedBytes, 100);
  assert.deepEqual(absent.sessionStartStdoutBytes, { unmeasured: 'no session-start hook' });
  assert.equal(absent.tokensEst, 25);
});

test('computeStartupContext executes session-start hook with fixture when present', (t) => {
  const dir = tempDir(t, 'doflow-test-session-start-');
  const claudeHooksDir = path.join(dir, '.claude', 'hooks');
  fs.mkdirSync(claudeHooksDir, { recursive: true });

  // Hook writes 20 characters to stdout
  const hookScript = '#!/bin/bash\nprintf "01234567890123456789"\n';
  fs.writeFileSync(path.join(claudeHooksDir, 'session-start.sh'), hookScript, { mode: 0o755 });

  const startup = context.computeStartupContext({
    homeDir: dir,
    harnesses: ['claude'],
    isToolInstalledFn: () => true,
    getToolVersionFn: () => '2.0.0',
    alwaysLoadedFn: () => ({ files: [{ rel: 'a.md', bytes: 40 }] }),
  });

  assert.equal(startup.length, 1);
  const row = startup[0];
  assert.equal(row.doflowProjectedBytes, 40);
  assert.equal(row.sessionStartStdoutBytes, 20);
  assert.equal(row.sessionStartStderrBytes, 0);
  // Total bytes: 40 + 20 = 60 => tokens = ceil(60 / 4) = 15
  assert.equal(row.tokensEst, 15);
});

test('computeContextBudgets calculates availableTokens from declared contextProfile facts', () => {
  const startup = [
    {
      harness: 'claude',
      tokensEst: 2500,
    },
  ];

  const budgets = context.computeContextBudgets({
    startupContext: startup,
    contextProfiles: {
      claude: {
        capacityTokens: { value: 200000, source: 'fixture', verifiedOn: '2026-10-13' },
        reserveTokens: { value: 0, source: 'fixture', verifiedOn: '2026-10-13' },
      },
    },
  });

  assert.equal(budgets.length, 1);
  const b = budgets[0];
  assert.equal(b.harness, 'claude');
  assert.equal(b.capacityTokens, 200000);
  assert.equal(b.capacityBasis, 'fixture');
  assert.equal(b.startupTokens, 2500);
  assert.equal(b.reserveTokens, 0);
  // available = 200000 - 2500 - 0 = 197500
  assert.equal(b.availableTokens, 197500);
  assert.equal(b.availableBasis, 'estimated');
});

test('computeContextBudgets derives capacity and reserve from contextProfile with unverified reason', () => {
  const startup = [
    {
      harness: 'claude',
      tokensEst: 2500,
    },
  ];

  const budgets = context.computeContextBudgets({
    startupContext: startup,
    contextProfiles: {
      claude: {
        capacityTokens: { unverified: 'values belong to 085 (A-19)' },
        reserveTokens: { unverified: 'values belong to 085 (A-19)' },
      },
    },
  });

  assert.equal(budgets.length, 1);
  const b = budgets[0];
  assert.equal(b.harness, 'claude');
  assert.equal(b.capacityTokens, null);
  assert.equal(b.capacityBasis, 'unverified:values belong to 085 (A-19)');
  assert.equal(b.reserveTokens, null);
  assert.equal(b.reserveBasis, 'unverified:values belong to 085 (A-19)');
  assert.equal(b.availableTokens, null);
  assert.equal(b.availableBasis, 'profile-required');
});

test('computePointerCost reports whole-file and sliced read costs with unmeasured labels', (t) => {
  const fixtureRows = context.computePointerCost();
  assert.equal(Array.isArray(fixtureRows), true);
  assert.ok(fixtureRows.length >= 1, 'committed perf fixture must produce pointer-cost rows');

  const dir = tempDir(t, 'doflow-test-pointer-cost-');
  const filePath = path.join(dir, 'agent-docs/doflow/perf-feature/design/design.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# Design\nfirst line\nsecond line\n', 'utf8');

  const rows = context.computePointerCost({
    fixture: dir,
    repoRoot: dir,
    runPack: ({ formatRows }: any) => formatRows({ pointers: [{
        id: 'ptr:agent-docs/doflow/perf-feature/design/design.md:2-3',
        path: 'agent-docs/doflow/perf-feature/design/design.md',
        range: { startLine: 2, endLine: 3 },
        bytes: 23,
        inlineBytes: 70,
      }] }, dir),
  });

  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row: any) => row.target), ['whole-file', 'whole-file', 'slice', 'slice']);
  assert.deepEqual(rows.map((row: any) => row.form), ['markdown', 'json', 'markdown', 'json']);
  for (const row of rows) {
    assert.equal(row.reads, 1);
    assert.equal(row.path, 'agent-docs/doflow/perf-feature/design/design.md');
    assert.deepEqual(row.range, { startLine: 2, endLine: 3 });
    assert.equal(row.tokensEst.basis, 'estimated:bytes/4');
    assert.deepEqual(row.readProbability, { unmeasured: 'needs a model call (paid)' });
    assert.deepEqual(row.actual, { unmeasured: 'needs a model call (paid)' });
    assert.equal(row.inlineBytes, Buffer.byteLength('first line\nsecond line\n', 'utf8'));
    assert.equal(row.followedBytes, row.pointerBytes + row.targetBytes);
    assert.equal(row.netBytes, row.followedBytes - row.inlineBytes);
    assert.equal(row.tokensEst.inline, Math.ceil(row.inlineBytes / 4));
    assert.equal(row.tokensEst.followed, Math.ceil(row.followedBytes / 4));
  }
  assert.equal(rows[0].targetBytes, Buffer.byteLength('# Design\nfirst line\nsecond line\n', 'utf8'));
  assert.equal(rows[2].targetBytes, Buffer.byteLength('first line\nsecond line\n', 'utf8'));

  const estimatedActual = { ...rows[0], actual: { value: 3, basis: 'estimated:bytes/4' } };
  assert.throws(() => context.validatePointerCostRows([estimatedActual]), /actual measurement cannot use an estimated basis/);
});
