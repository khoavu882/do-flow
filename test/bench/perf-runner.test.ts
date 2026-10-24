'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../../bench/perf/runner.ts');
const { tempDir } = require('../helper/tmp.ts');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function capture() {
  const lines: any = { out: [], err: [] };
  return {
    lines,
    io: {
      out: (m: any) => lines.out.push(m),
      err: (m: any) => lines.err.push(m),
    },
  };
}

test('perf runner exports main and key helper functions', () => {
  assert.equal(typeof runner.main, 'function');
  assert.equal(typeof runner.computeCeilingMs, 'function');
  assert.equal(typeof runner.getMachineId, 'function');
  assert.equal(typeof runner.enumerateHookSurfaces, 'function');
  assert.equal(typeof runner.isAnotherNodeTestRunning, 'function');
});

test('perf hook enumerator exposes one named claude pre-bash first-write variant', () => {
  const { surfaces } = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT, isToolInstalledFn: () => true });
  const steady = surfaces.find((surface: any) => surface.id === 'hook.claude.pre-bash-guard');
  const firstWrite = surfaces.find((surface: any) => surface.id === 'hook.claude.pre-bash-guard.first-write');
  assert.ok(steady);
  assert.ok(firstWrite, 'the one-time mkdir cost has a separately selectable surface');
  assert.equal(steady.setup.fixture, 'bench/perf/fixtures/hook-bridge-project');
  assert.deepEqual(steady.setup.omit, undefined);
  assert.equal(firstWrite.variant, 'first-write');
  assert.equal(firstWrite.budgeted, false);
  assert.deepEqual(firstWrite.setup, {
    ...steady.setup,
    omit: ['.doflow/state/runs/telemetry'],
  });
  assert.equal(surfaces.filter((surface: any) => surface.id.endsWith('.first-write')).length, 1);
});

test('perf runner omits declared paths from copied fixture projects and the negative control detects them', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-omit-');
  const fixture = path.join(dir, 'fixture');
  const telemetry = path.join(fixture, '.doflow', 'state', 'runs', 'telemetry');
  fs.mkdirSync(telemetry, { recursive: true });
  fs.writeFileSync(path.join(telemetry, '.gitkeep'), '');
  const check = 'const fs=require("node:fs");process.exit(fs.existsSync(process.argv[1]) ? 3 : 0);';
  const setup: any = {
    kind: 'copy-fixture-project',
    fixture,
    git: false,
    cwdProject: true,
    omit: ['.doflow/state/runs/telemetry'],
  };
  const firstWrite: any = {
    id: 'stub.first-write',
    kind: 'cli',
    setup,
    argv: ['node', '-e', check, '{project}/.doflow/state/runs/telemetry'],
  };
  assert.equal(typeof runner.runSurfaceProcess(firstWrite, REPO_ROOT), 'number');
  assert.throws(
    () => runner.runSurfaceProcess({ ...firstWrite, id: 'stub.steady', setup: { ...setup, omit: undefined } }, REPO_ROOT),
    /process exited with status 3/
  );
});

test('perf runner exits 2 on missing or unknown verb, or unknown flag', () => {
  const { lines, io } = capture();
  assert.equal(runner.main([], io), 2);
  assert.match(lines.err.join('\n'), /usage: bench perf/);

  const { lines: lines2, io: io2 } = capture();
  assert.equal(runner.main(['unknown-verb'], io2), 2);
  assert.match(lines2.err.join('\n'), /unknown command "unknown-verb"/);

  const { lines: lines3, io: io3 } = capture();
  assert.equal(runner.main(['measure', '--bogus'], io3), 2);
  assert.match(lines3.err.join('\n'), /unknown flag --bogus/);

  const { lines: lines4, io: io4 } = capture();
  assert.equal(runner.main(['measure', 'stray'], io4), 2);
  assert.match(lines4.err.join('\n'), /unexpected argument "stray"/);
});

test('perf measure refuses with exit 2 when another node --test process is running', () => {
  const { lines, io } = capture();
  const exitCode = runner.main(['measure'], {
    ...io,
    isAnotherNodeTestRunningFn: () => true,
  });
  assert.equal(exitCode, 2);
  assert.match(lines.err.join('\n'), /exclusive execution required/);
});

test('computeCeilingMs computes ceiling with minMs, percentage and intent budget cap', () => {
  const headroom: any = { minMs: 10, pct: 25 };
  // p95 = 20: 20 * 0.25 = 5 < 10 => headroom = 10 => 20 + 10 = 30
  assert.equal(runner.computeCeilingMs(20, headroom, 100), 30);
  // p95 = 80: 80 * 0.25 = 20 > 10 => headroom = 20 => 80 + 20 = 100
  assert.equal(runner.computeCeilingMs(80, headroom, 100), 100);
  // p95 = 120: headroom = 30 => 150, but capped at intent = 100
  assert.equal(runner.computeCeilingMs(120, headroom, 100), 100);
  // intent is null => uncapped
  assert.equal(runner.computeCeilingMs(120, headroom, null), 150);
});

test('perf measure runs warmups and rounds on stub surfaces and computes stats', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-measure-');
  const budgetsPath = path.join(dir, 'budgets.json');

  const stubSurfaces: any = [
    {
      id: 'stub.cmd1',
      kind: 'cli',
      argv: ['echo', 'cmd1'],
      intentClass: 'help',
      enforced: false,
    },
    {
      id: 'stub.cmd2',
      kind: 'cli',
      argv: ['echo', 'cmd2'],
      intentClass: 'verb',
      enforced: true,
    },
  ];

  let invocations = 0;
  const runSurfaceFn = (surface: any) => {
    invocations++;
    return surface.id === 'stub.cmd1' ? 10 : 25;
  };

  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '30', '--warmups', '3', '--seed', '12345', '--json', '--budgets', budgetsPath],
    {
      ...io,
      isAnotherNodeTestRunningFn: () => false,
      surfaces: stubSurfaces,
      runSurfaceFn,
    }
  );

  assert.equal(exitCode, 0);
  // Total invocations: (3 warmups + 30 rounds) * 2 surfaces = 66
  assert.equal(invocations, 66);

  const payload = JSON.parse(lines.out.join('\n'));
  assert.equal(payload.ok, true);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.runs, 30);
  assert.equal(payload.rows.length, 2);

  const r1 = payload.rows.find((r: any) => r.surfaceId === 'stub.cmd1');
  assert.ok(r1);
  assert.equal(r1.runs, 30);
  assert.equal(r1.warmups, 3);
  assert.equal(r1.p50Ms, 10);
  assert.equal(r1.p95Ms, 10);
  assert.equal(r1.ceilingMs, 20); // 10 + max(10, 2.5) = 20 <= 100
  assert.equal(r1.status, 'proposed');
});

test('perf measure --write upserts proposed rows and machine record into budgets.json', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-write-');
  const budgetsPath = path.join(dir, 'budgets.json');

  const stubSurfaces: any = [
    {
      id: 'stub.action',
      kind: 'cli',
      argv: ['echo', 'action'],
      intentClass: 'help',
      enforced: true,
    },
  ];

  const { io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '30', '--warmups', '1', '--write', '--budgets', budgetsPath],
    {
      ...io,
      isAnotherNodeTestRunningFn: () => false,
      surfaces: stubSurfaces,
      runSurfaceFn: () => 15,
    }
  );

  assert.equal(exitCode, 0);
  assert.ok(fs.existsSync(budgetsPath));
  const written = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));
  assert.equal(written.rows.length, 1);
  assert.equal(written.rows[0].surfaceId, 'stub.action');
  assert.equal(written.rows[0].status, 'proposed');
  assert.equal(written.machines.length, 1);
  assert.equal(written.machines[0].machineId, runner.getMachineId());
});

test('perf check passes on valid rows and reports findings on invalid rows', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-check-');
  const budgetsPath = path.join(dir, 'budgets.json');

  const validBudgets: any = {
    schemaVersion: 1,
    intentBudgetsMs: { help: 100, verb: 150 },
    headroom: { minMs: 10, pct: 25 },
    surfaces: [
      { id: 'cli.help', intentClass: 'help' },
    ],
    rows: [
      {
        surfaceId: 'cli.help',
        runs: 30,
        p95Ms: 40,
        ceilingMs: 50, // 40 + max(10, 10) = 50 <= 100
      },
    ],
  };

  fs.writeFileSync(budgetsPath, JSON.stringify(validBudgets, null, 2));

  const { lines: lines1, io: io1 } = capture();
  const code1 = runner.main(['check', '--json', '--budgets', budgetsPath], io1);
  assert.equal(code1, 0);
  const out1 = JSON.parse(lines1.out.join('\n'));
  assert.equal(out1.ok, true);
  assert.equal(out1.findings.length, 0);
  assert.equal(out1.rowsChecked, 1);

  // Failure cases:
  // 1. Differing ceiling
  // 2. Ceiling > intent
  // 3. Runs < 30
  const invalidBudgets: any = {
    ...validBudgets,
    rows: [
      {
        surfaceId: 'cli.help',
        runs: 25, // fewer than 30
        p95Ms: 40,
        ceilingMs: 99, // differs from expected 50
      },
      {
        surfaceId: 'cli.help',
        runs: 30,
        p95Ms: 120,
        ceilingMs: 150, // exceeds intent budget of 100
      },
    ],
  };

  fs.writeFileSync(budgetsPath, JSON.stringify(invalidBudgets, null, 2));

  const { lines: lines2, io: io2 } = capture();
  const code2 = runner.main(['check', '--json', '--budgets', budgetsPath], io2);
  assert.equal(code2, 1);
  const out2 = JSON.parse(lines2.out.join('\n'));
  assert.equal(out2.ok, false);
  assert.ok(out2.findings.length >= 3);
});

test('enumerateHookSurfaces identifies uninstalled, missing hooks and unmeasured fixtures', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-hooks-');
  const harnessesPath = path.join(dir, 'core', 'registry');
  fs.mkdirSync(harnessesPath, { recursive: true });

  fs.writeFileSync(
    path.join(harnessesPath, 'harnesses.json'),
    JSON.stringify({
      harnesses: [
        { id: 'claude' },
        { id: 'opencode' },
        { id: 'uninstalled_tool' },
      ],
    })
  );

  // Setup claude with hooks dir and one script
  const claudeHooks = path.join(dir, 'core', 'harnesses', 'claude', 'hooks');
  fs.mkdirSync(claudeHooks, { recursive: true });
  fs.writeFileSync(path.join(claudeHooks, 'test-hook.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(claudeHooks, 'lib.sh'), '#!/bin/bash\n'); // should be excluded
  fs.writeFileSync(path.join(claudeHooks, 'test-hook.impl.sh'), '#!/bin/bash\n'); // should be excluded

  const isToolInstalledFn = (tool: any) => tool !== 'uninstalled_tool';

  const res = runner.enumerateHookSurfaces({
    repoRoot: dir,
    isToolInstalledFn,
  });

  const ids = res.surfaces.map((s: any) => s.id);
  assert.ok(ids.includes('hook.claude.test-hook'));
  assert.ok(!ids.includes('hook.claude.lib'));
  assert.ok(!ids.includes('hook.claude.test-hook.impl'));
  assert.ok(ids.includes('hook.opencode'));
  assert.ok(ids.includes('hook.uninstalled_tool'));

  const unmeasured: any = new Map(res.unmeasuredRows.map((r: any) => [r.surfaceId, r.unmeasured]));
  assert.equal(unmeasured.get('hook.uninstalled_tool'), 'harness not installed');
  assert.equal(unmeasured.get('hook.opencode'), 'no hooks are projected');
  assert.equal(unmeasured.get('hook.claude.test-hook'), 'no fixture');
});

test('perf hook surfaces use corpus native payloads and include Kiro config sources and Pi policies', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-corpus-');
  fs.mkdirSync(path.join(dir, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', 'registry', 'harnesses.json'), JSON.stringify({ harnesses: [{ id: 'claude' }, { id: 'kiro' }, { id: 'pi' }] }));
  for (const harness of ['claude', 'kiro']) {
    fs.mkdirSync(path.join(dir, 'core', 'harnesses', harness, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core', 'harnesses', harness, 'hooks', 'pre-implement-gate.sh'), '#!/bin/bash\n');
    fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'hooks', harness, 'pre-implement-gate'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'hooks', harness, 'pre-implement-gate', 'perf.json'), JSON.stringify({ native: { hook_event_name: 'PreToolUse' } }));
  }
  fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'hooks', 'kiro', 'pre-implement-gate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'hooks', 'kiro', 'pre-implement-gate', 'agent-perf.json'), JSON.stringify({ native: { hook_event_name: 'preToolUse' } }));
  fs.mkdirSync(path.join(dir, 'core', 'harnesses', 'pi', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', 'harnesses', 'pi', 'extensions', 'doflow-guard.js'), '');
  fs.mkdirSync(path.join(dir, 'core', 'harnesses', 'shared', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js'), '');
  fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'hooks', 'pi', 'tool_call'), { recursive: true });

  const result = runner.enumerateHookSurfaces({ repoRoot: dir, isToolInstalledFn: () => true });
  const byId: any = new Map(result.surfaces.map((surface: any) => [surface.id, surface]));
  assert.ok(!result.unmeasuredRows.some((row: any) => row.surfaceId === 'hook.claude.pre-implement-gate' && row.unmeasured === 'no fixture'), 'a corpus perf case must prevent a no fixture report');
  assert.equal(byId.get('hook.claude.pre-implement-gate').stdinField, 'native');
  assert.match(byId.get('hook.claude.pre-implement-gate').argv[1], /\{mirror\}/);
  assert.equal(byId.get('hook.kiro.pre-implement-gate.agent-config').stdinFixture, path.join('test', 'fixtures', 'hooks', 'kiro', 'pre-implement-gate', 'agent-perf.json'));
  assert.equal(result.surfaces.filter((surface: any) => surface.id === 'hook.antigravity.pre-implementation-gate').length, 1);
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const surface: any = byId.get(`hook.pi.tool-call-${policy}`);
    assert.ok(surface, `missing Pi surface for ${policy}`);
    assert.deepEqual(surface.argv.slice(-3), ['pi', 'tool_call', policy]);
    assert.equal(surface.stdinField, 'native');
    assert.equal(surface.note, 'excludes the in-process extension spawn');
    const budgetSurface = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'bench/perf/budgets.json'), 'utf8')).surfaces
      .find((candidate: any) => candidate.id === surface.id);
    assert.equal(budgetSurface.note, 'excludes the in-process extension spawn');
  }
});

test('perf runner feeds a surface the exact stdin bytes from its fixture', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-stdin-bytes-');
  const fixturePath = path.join(dir, 'native.json');
  const markerPath = path.join(dir, 'stdin.txt');
  const expected = '{"hook_event_name":"PreToolUse","tool_name":"Edit"}';
  fs.writeFileSync(fixturePath, JSON.stringify({ native: JSON.parse(expected) }), 'utf8');

  const surface: any = {
    id: 'stub.stdin-bytes',
    argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], require("node:fs").readFileSync(0))', markerPath],
    stdinFixture: fixturePath,
    stdinField: 'native',
  };
  const duration = runner.runSurfaceProcess(surface, REPO_ROOT);
  assert.equal(typeof duration, 'number');
  assert.equal(fs.readFileSync(markerPath, 'utf8'), expected);
});

test('perf runner treats stdin EPIPE as a completed surface run but reports other spawn errors', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-epipe-');
  const fixturePath = path.join(dir, 'native.json');
  fs.writeFileSync(fixturePath, '{"hook_event_name":"PreToolUse"}', 'utf8');
  const surface: any = {
    id: 'stub.stdin-epipe',
    argv: ['bash', '-c', 'exit 0'],
    stdinFixture: fixturePath,
  };
  const epipeSpawn = (cmd: any, args: any, options: any) => {
    assert.equal(cmd, 'bash');
    assert.deepEqual(args, ['-c', 'exit 0']);
    assert.equal(options.input, '{"hook_event_name":"PreToolUse"}');
    return { status: 0, error: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) };
  };
  assert.equal(typeof runner.runSurfaceProcess(surface, dir, undefined, epipeSpawn), 'number');

  const missingSpawn = () => ({
    status: null,
    error: Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }),
  });
  assert.throws(
    () => runner.runSurfaceProcess(surface, dir, undefined, missingSpawn),
    /process error: spawn bash ENOENT/
  );
});

test('perf fixture-backed hook surfaces smoke through --surface without writing budget rows', () => {
  const addedIds: any = [
    'hook.claude.permission-audit', 'hook.claude.post-compact', 'hook.claude.post-edit-lint',
    'hook.claude.post-tool-failure', 'hook.claude.pre-compact', 'hook.claude.session-end',
    'hook.claude.skill-config-audit', 'hook.codex.post-edit-lint', 'hook.codex.pre-compact',
    'hook.codex.session-end', 'hook.gemini.post-edit-lint', 'hook.gemini.pre-compact',
    'hook.gemini.session-end', 'hook.shared.capture-failure', 'hook.shared.mcp-tool-guard',
    'hook.shared.pre-implementation-gate', 'hook.shared.session-context', 'hook.shared.stop-check',
    'hook.shared.subagent-audit',
  ];
  const { lines, io } = capture();
  const exitCode = runner.main(['measure', '--runs', '1', '--warmups', '0', '--surface', addedIds.join(',')], {
    ...io,
    isAnotherNodeTestRunningFn: () => false,
  });
  assert.equal(exitCode, 0, lines.err.join('\n'));
  for (const id of addedIds) assert.match(lines.out.join('\n'), new RegExp(id.replaceAll('.', '\\.')));
});

test('perf runner executes front doors in an install mirror and fixture project on a feat branch', () => {
  const { surfaces } = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT, isToolInstalledFn: () => true });
  const surface = surfaces.find((candidate: any) => candidate.id === 'hook.claude.pre-implement-gate');
  assert.ok(surface);
  assert.equal(surface.setup.kind, 'hook-install-mirror');
  assert.equal(typeof runner.runSurfaceProcess(surface, REPO_ROOT), 'number');
});

test('perf runner executes Antigravity and Pi surfaces using their corpus payloads', () => {
  const { surfaces } = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT, isToolInstalledFn: () => true });
  const selected = surfaces.filter((surface: any) => surface.id.startsWith('hook.antigravity.') || surface.id.startsWith('hook.pi.tool-call-'));
  assert.equal(selected.length, 6);
  for (const surface of selected) {
    assert.equal(typeof runner.runSurfaceProcess(surface, REPO_ROOT), 'number', surface.id);
  }
});

test('bench runner forwards perf command to bench/perf/runner.ts', () => {
  const run = spawnSync(process.execPath, ['bench/runner.ts', 'perf'], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: bench perf/);
});

test('perf measure: a surface with non-zero exit fails (no row, reported, exit 1)', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-fail-nonzero-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const failScript = path.join(dir, 'fail.js');
  fs.writeFileSync(failScript, 'process.exit(3);\n', 'utf8');
  const stubSurfaces: any = [
    { id: 'stub.ok', kind: 'cli', argv: ['node', '-e', 'process.exit(0)'], intentClass: 'help', enforced: false },
    { id: 'stub.failing', kind: 'cli', argv: ['node', failScript], intentClass: 'help', enforced: false },
  ];
  assert.throws(
    () => runner.runSurfaceProcess(stubSurfaces[1], dir),
    /process exited with status 3/
  );
  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--budgets', budgetsPath],
    {
      ...io,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
    }
  );
  assert.equal(exitCode, 1);
  assert.match(lines.err.join('\n'), /perf measure: surface stub\.failing failed: process exited with status 3/);
  const outLines = lines.out.join('\n');
  assert.ok(!outLines.includes('stub.failing p50='));
});

test('perf measure: a surface with timeout fails (no row, reported, exit 1)', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-fail-timeout-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const sleepScript = path.join(dir, 'sleep.js');
  fs.writeFileSync(sleepScript, 'setTimeout(() => {}, 5000);\n', 'utf8');
  const stubSurfaces: any = [
    { id: 'stub.timeout', kind: 'cli', argv: ['node', sleepScript], timeoutMs: 100, intentClass: 'help', enforced: false },
  ];
  assert.throws(
    () => runner.runSurfaceProcess(stubSurfaces[0], dir),
    /timed out after 0\.1s/
  );
  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--budgets', budgetsPath],
    {
      ...io,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
    }
  );
  assert.equal(exitCode, 1);
  assert.match(lines.err.join('\n'), /perf measure: surface stub\.timeout failed: timed out after 0\.1s/);
});

test('perf measure --write: when any surface fails, write nothing and exit 1', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-write-fail-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const failScript = path.join(dir, 'fail.js');
  fs.writeFileSync(failScript, 'process.exit(3);\n', 'utf8');

  // Case 1: budgets.json does not exist initially; must NOT be created on failure
  const stubSurfaces: any = [
    { id: 'stub.ok', kind: 'cli', argv: ['node', '-e', 'process.exit(0)'], intentClass: 'help', enforced: false },
    { id: 'stub.failing', kind: 'cli', argv: ['node', failScript], intentClass: 'help', enforced: false },
  ];
  const { lines: lines1, io: io1 } = capture();
  const exitCode1 = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--write', '--budgets', budgetsPath],
    {
      ...io1,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
    }
  );
  assert.equal(exitCode1, 1);
  assert.equal(fs.existsSync(budgetsPath), false, 'budgets.json must not be created when a surface fails');

  // Case 2: budgets.json exists with prior content; must NOT be modified (no partial rewrite, no stale rows updated)
  const initialContent = JSON.stringify({
    schemaVersion: 1,
    intentBudgetsMs: {},
    headroom: {},
    machines: [],
    surfaces: stubSurfaces,
    rows: [{ surfaceId: 'stub.ok', p50Ms: 999, status: 'proposed' }],
  }, null, 2) + '\n';
  fs.writeFileSync(budgetsPath, initialContent, 'utf8');

  const { lines: lines2, io: io2 } = capture();
  const exitCode2 = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--write', '--budgets', budgetsPath],
    {
      ...io2,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
    }
  );
  assert.equal(exitCode2, 1);
  assert.equal(fs.readFileSync(budgetsPath, 'utf8'), initialContent, 'budgets.json must not be modified when a surface fails');
});

test('perf measure: a surface with missing stdin fixture fails (no row, reported, exit 1)', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-fail-stdin-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const stubSurfaces: any = [
    { id: 'stub.missing-stdin', kind: 'cli', argv: ['cat'], stdinFixture: 'nonexistent/fixture.json', intentClass: 'help', enforced: false },
  ];
  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--budgets', budgetsPath],
    {
      ...io,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
    }
  );
  assert.equal(exitCode, 1);
  assert.match(lines.err.join('\n'), /missing stdin fixture/);
});

test('perf measure: ceilingMs is computed from the stored (rounded) p95Ms', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-rounded-p95-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const stubSurfaces: any = [
    { id: 'stub.calc', kind: 'cli', argv: ['echo'], intentClass: 'none', enforced: false },
  ];
  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '10', '--warmups', '1', '--json', '--budgets', budgetsPath],
    {
      ...io,
      surfaces: stubSurfaces,
      isAnotherNodeTestRunningFn: () => false,
      runSurfaceFn: () => 10.004,
    }
  );
  assert.equal(exitCode, 0);
  const data = JSON.parse(lines.out.join(''));
  const row = data.rows.find((r: any) => r.surfaceId === 'stub.calc');
  assert.ok(row);
  assert.equal(row.p95Ms, 10);
  assert.equal(row.ceilingMs, 20);
});

test('perf runner: copy-fixture-project setup creates git repo, substitutes {project}, leaves no directory behind and writes nothing under repoRoot', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-copy-setup-');
  const fixtureDir = path.join(dir, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'sample.txt'), 'sample content\n', 'utf8');

  const markerFile = path.join(dir, 'observed-project.txt');

  const stubSurface: any = {
    id: 'stub.copy-fixture',
    kind: 'cli',
    setup: {
      kind: 'copy-fixture-project',
      fixture: fixtureDir,
      git: true,
    },
    argv: [
      'node',
      '-e',
      `
      const fs = require("node:fs");
      const path = require("node:path");
      const { execFileSync } = require("node:child_process");
      const p = process.argv[1];
      const marker = process.argv[2];
      if (!fs.existsSync(p)) process.exit(1);
      if (!fs.existsSync(path.join(p, "sample.txt"))) process.exit(1);
      const log = execFileSync("git", ["log", "-1", "--format=%an %ad"], { cwd: p, encoding: "utf8" }).trim();
      if (!log.includes("DoFlow Perf")) process.exit(2);
      fs.writeFileSync(marker, p, "utf8");
      fs.writeFileSync(path.join(p, "created-in-temp.txt"), "temp data", "utf8");
      `,
      '{project}',
      markerFile,
    ],
    intentClass: 'verb',
    enforced: false,
  };

  const dur = runner.runSurfaceProcess(stubSurface, REPO_ROOT);
  assert.equal(typeof dur, 'number');
  assert.ok(dur >= 0);

  assert.ok(fs.existsSync(markerFile), 'marker file should be written by child');
  const recordedTempDir = fs.readFileSync(markerFile, 'utf8').trim();
  assert.ok(recordedTempDir.length > 0);
  assert.notEqual(recordedTempDir, REPO_ROOT);
  assert.equal(fs.existsSync(recordedTempDir), false, 'the setup leaves no directory behind');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'created-in-temp.txt')), false, 'never writes under repoRoot');
});

test('perf runner: copy-fixture-project generates deterministic files before git init', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-generate-');
  const fixtureDir = path.join(dir, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const markerFile = path.join(dir, 'observed-generated.txt');
  const surface: any = {
    id: 'stub.generate',
    kind: 'cli',
    setup: {
      kind: 'copy-fixture-project',
      fixture: fixtureDir,
      git: true,
      generate: { dir: 'src/gen', count: 3 },
    },
    argv: [
      'node', '-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const root = process.argv[1];
        const marker = process.argv[2];
        const generated = path.join(root, 'src/gen');
        const names = fs.readdirSync(generated).sort();
        if (JSON.stringify(names) !== JSON.stringify(['f0.js', 'f1.js', 'f2.js'])) process.exit(1);
        for (let i = 0; i < 3; i++) {
          if (fs.readFileSync(path.join(generated, 'f' + i + '.js'), 'utf8') !== 'export const v' + i + ' = ' + i + ';\\n') process.exit(2);
        }
        const tracked = execFileSync('git', ['ls-files', 'src/gen'], { cwd: root, encoding: 'utf8' }).trim().split('\\n');
        if (tracked.length !== 3) process.exit(3);
        fs.writeFileSync(marker, root, 'utf8');
      `,
      '{project}',
      markerFile,
    ],
  };
  assert.equal(typeof runner.runSurfaceProcess(surface, REPO_ROOT), 'number');
  const generatedProject = fs.readFileSync(markerFile, 'utf8');
  assert.equal(fs.existsSync(generatedProject), false, 'the generated temp project is cleaned up');
});

test('perf runner: copy-fixture-project refuses an invalid generated file count', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-generate-invalid-');
  const fixtureDir = path.join(dir, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const surface: any = {
    id: 'stub.generate-invalid',
    kind: 'cli',
    setup: {
      kind: 'copy-fixture-project',
      fixture: fixtureDir,
      generate: { dir: 'src/gen', count: 0 },
    },
    argv: ['node', '-e', 'process.exit(0)'],
  };
  assert.throws(() => runner.runSurfaceProcess(surface, REPO_ROOT), /positive integer count no greater than 10000/);
});

test('perf measure: copy-fixture-project fixture that exits 3 fails with no row (negative control)', (t) => {
  const dir = tempDir(t, 'doflow-test-perf-copy-fail-');
  const budgetsPath = path.join(dir, 'budgets.json');
  const fixtureDir = path.join(dir, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'exit3.js'), 'process.exit(3);\n', 'utf8');

  const stubSurface: any = {
    id: 'stub.fixture-exit3',
    kind: 'cli',
    setup: {
      kind: 'copy-fixture-project',
      fixture: fixtureDir,
      git: true,
    },
    argv: ['node', '{project}/exit3.js'],
    intentClass: 'verb',
    enforced: false,
  };

  assert.throws(
    () => runner.runSurfaceProcess(stubSurface, dir),
    /process exited with status 3/
  );

  const { lines, io } = capture();
  const exitCode = runner.main(
    ['measure', '--runs', '5', '--warmups', '1', '--budgets', budgetsPath],
    {
      ...io,
      surfaces: [stubSurface],
      isAnotherNodeTestRunningFn: () => false,
    }
  );

  assert.equal(exitCode, 1);
  assert.match(
    lines.err.join('\n'),
    /perf measure: surface stub\.fixture-exit3 failed: process exited with status 3/
  );
  const outLines = lines.out.join('\n');
  assert.ok(!outLines.includes('stub.fixture-exit3 p50='));
});

test('perf runner: verb.context-pack surface runs against context-pack-project fixture and exits 0', () => {
  const contextPackSurface: any = {
    id: 'verb.context-pack',
    kind: 'cli',
    intentClass: 'verb',
    enforced: false,
    status: 'proposed',
    setup: {
      kind: 'copy-fixture-project',
      fixture: 'bench/perf/fixtures/context-pack-project',
      git: true,
    },
    argv: [
      'node',
      'bin/doflow.js',
      'context-pack',
      '{project}',
      '--task-id',
      'perf-cp',
      '--slug',
      'perf-feature',
      '--json',
    ],
  };

  const dur = runner.runSurfaceProcess(contextPackSurface, REPO_ROOT);
  assert.equal(typeof dur, 'number');
  assert.ok(dur > 0);
});

