'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  computeCeilingMs,
  DEFAULT_HEADROOM,
  DEFAULT_INTENT_BUDGETS_MS,
} = require('../../bench/perf/runner.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUDGETS_PATH = path.join(REPO_ROOT, 'bench/perf/budgets.json');

function findApprovedRow(budgets: any, surfaceId: any) {
  return (budgets.rows || []).find(
    (row: any) => row.surfaceId === surfaceId && row.status === 'approved' && !row.unmeasured
  );
}

function runSurface(surface: any) {
  const fixturePath = surface.stdinFixture
    ? (path.isAbsolute(surface.stdinFixture)
        ? surface.stdinFixture
        : path.join(REPO_ROOT, surface.stdinFixture))
    : undefined;
  const input = fixturePath ? fs.readFileSync(fixturePath, 'utf8') : undefined;
  const [bin, ...args] = surface.argv;
  const result = spawnSync(bin === 'node' ? process.execPath : bin, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    timeout: 30000,
    env: { ...process.env, DOFLOW_QUIET: '1' },
  });

  return {
    status: result.status,
    error: result.error,
    stderr: result.stderr || '',
  };
}

const budgets = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8'));
const enforcedSurfaces = (budgets.surfaces || []).filter((surface: any) => surface.enforced);
const additionalSurfaces = (budgets.surfaces || []).filter((surface: any) =>
  ['cli.version', 'verb.capabilities'].includes(surface.id)
);

// suite.guard-file and suite.guards recurse into the test runner; diag.doctor depends on installed tools; install.dry-run is covered by test/install/.
const surfacesToRun: any = [...enforcedSurfaces, ...additionalSurfaces];

for (const surface of surfacesToRun) {
  test(`performance-budget: surface ${surface.id} runs successfully and has a valid budget row`, () => {
    const row = findApprovedRow(budgets, surface.id);
    assert.ok(row, `approved budgets.json row must exist for surface ${surface.id}`);

    assert.ok(Number.isInteger(row.runs) && row.runs >= 30, `surface ${surface.id} must have at least 30 runs`);
    assert.ok(Number.isFinite(row.p95Ms) && row.p95Ms >= 0, `surface ${surface.id} must have a valid p95Ms`);
    assert.ok(Number.isFinite(row.ceilingMs) && row.ceilingMs >= 0, `surface ${surface.id} must have a valid ceilingMs`);

    const intentBudgetsMs = budgets.intentBudgetsMs || DEFAULT_INTENT_BUDGETS_MS;
    const headroom = budgets.headroom || DEFAULT_HEADROOM;
    const intent = surface.intentClass && surface.intentClass !== 'none'
      ? intentBudgetsMs[surface.intentClass]
      : null;
    assert.equal(
      row.ceilingMs,
      computeCeilingMs(row.p95Ms, headroom, intent),
      `surface ${surface.id} ceilingMs must match the budget formula`
    );
    if (intent != null) {
      assert.ok(row.ceilingMs <= intent, `surface ${surface.id} ceilingMs must not exceed its intent budget`);
    }

    const expectedExitCode = surface.expectedExitCode ?? 0;
    const result = runSurface(surface);
    assert.equal(result.error, undefined, `surface ${surface.id} could not run: ${result.error?.message || ''}`);
    assert.equal(
      result.status,
      expectedExitCode,
      `surface ${surface.id} exited ${result.status}; expected ${expectedExitCode}\nstderr: ${result.stderr}`
    );
  });
}
