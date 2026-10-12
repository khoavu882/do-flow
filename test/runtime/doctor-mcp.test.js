'use strict';

// The MCP half of `doflow doctor` (062 CH6, IC-014 and IC-015): `[MCP Servers]` and
// `[MCP Consultations]` in text, `mcp.servers` and `mcp.consultations` in JSON, driven through the
// real CLI against ledgers and run journals written into a scratch home and project. The exit code
// and `findings` must equal a doctor run without the sections (FR-011, FR-012, NFR-003, NFR-005).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { REACH_DISPATCHER_REL, REACH_RUNTIME_REL } = require('../../src/runtime/reach');
const { buildHealthReport } = require('../../src/runtime/health');
const { OUTCOME_LABELS } = require('../../src/runtime/mcp-consultations.ts');
const { buildAdapterRegistry } = require('../../src/cli/shared.ts');

// A developer's PI_CODING_AGENT_DIR would send this file's global Pi MCP reads outside the scratch home.
delete process.env.PI_CODING_AGENT_DIR;

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const MCP = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'mcp.json'), 'utf8')).servers;
const STEPPED = MCP.filter((server) => server.steps.length);
const [FIRST, SECOND] = STEPPED.map((server) => server.id);

/** Runs `fn` with HOME (and so `os.homedir()`) at `home`, so an in-process call never reads the
 * developer's real ~/.claude.json, ~/.gemini/settings.json or global ledger. */
function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function fixture(testContext) {
  const dir = tempDir(testContext, 'doflow-doctor-mcp-');
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  return { dir, home, proj };
}

function write(file, text = '', mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function ledger(root, scope, { harnesses = [], selected = {} }) {
  const resources = [
    ...harnesses.map((harness) => ({ harness, assetId: 'skills.doflow', kind: 'copy-tree-file' })),
    ...Object.entries(selected).flatMap(([harness, ids]) => ids.map((identity) => ({ harness, kind: 'mcp-server', identity, target: 'x' }))),
  ];
  write(path.join(root, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope, scopeRoot: root, targets: {}, mcpSelections: {}, resources, legacyImports: [],
  }));
}

function install(root) {
  write(path.join(root, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  write(path.join(root, '.doflow', REACH_RUNTIME_REL), '');
}

/** Runs `doflow doctor` under an emptied environment so no real home, PATH tool or git config answers. */
function doctor(t, args) {
  return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd: t.dir,
    encoding: 'utf8',
    env: {
      HOME: t.home,
      USERPROFILE: t.home,
      XDG_CONFIG_HOME: path.join(t.dir, 'xdg'),
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

/** The lines of one section, sliced from its header to the next blank line. */
function section(stdout, header) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith(header));
  assert.notEqual(start, -1, `${header} is printed`);
  const end = lines.findIndex((line, index) => index > start && line === '');
  return lines.slice(start, end === -1 ? undefined : end);
}

function run(t, taskId, history) {
  write(path.join(t.proj, '.doflow', 'state', 'orchestration', `${taskId}.json`), JSON.stringify({
    version: 1, taskId, taskClass: 'feature', state: 'RUNNING', history,
  }));
}

function entry(at, node, consultations, action = 'complete-stage') {
  const item = { at, action, node, note: null };
  if (consultations !== undefined) item.consultations = consultations;
  return item;
}

function consultations(skill, named, outcomes) {
  return {
    schema: 1, skill, named,
    outcomes: outcomes.map(([server, state, reason]) => ({ server, state, ...(reason ? { reason } : {}), source: 'flag' })),
    toolsUsed: [],
  };
}

const stage = (report, skill) => report.mcp.consultations.stages.find((item) => item.skill === skill);
const serverRow = (item, id) => item.servers.find((row) => row.server === id);

test('a named server DoFlow does not see: unknown (absence is no proof) with the add command or where to configure it, exit unchanged', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  install(f.proj);
  write(path.join(f.proj, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  ledger(f.home, 'global', { harnesses: ['gemini'] });
  install(f.home);
  const result = doctor(f, [f.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const server = report.mcp.servers.find((item) => item.id === FIRST);
  assert.equal(server.selection, 'optional');
  assert.ok(server.namedBy.includes('do-design'));
  assert.deepEqual(server.harnesses.find((row) => row.id === 'claude'),
    { id: 'claude', scope: 'project', state: 'unknown', add: `doflow install --target claude --mcp ${FIRST}` });
  const gemini = server.harnesses.find((row) => row.id === 'gemini');
  assert.equal(gemini.state, 'unknown');
  assert.equal(gemini.add, "configure it in Gemini CLI's own MCP settings; DoFlow's catalog does not reach it");

  const text = doctor(f, [f.proj]);
  assert.equal(text.status, 0, text.stderr);
  const lines = section(text.stdout, '[MCP Servers]');
  assert.equal(lines[0], '[MCP Servers] — named by shipped stages; not blocking');
  assert.ok(lines.some((line) => line.startsWith(`  ${FIRST.padEnd(22)}named by `)));
  assert.ok(lines.includes(`    ${'claude'.padEnd(14)}${'project'.padEnd(9)}${'? unknown'.padEnd(19)}add: doflow install --target claude --mcp ${FIRST}`));
  assert.ok(lines.includes(`    ${'gemini'.padEnd(14)}${'global'.padEnd(9)}${'? unknown'.padEnd(19)}configure it in Gemini CLI's own MCP settings; DoFlow's catalog does not reach it`), lines.join('\n'));
});

test('X8: an unreadable MCP config says to fix the file first instead of an install command', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  install(f.proj);
  const file = path.join(f.proj, '.mcp.json');
  write(file, '{ not json');
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.deepEqual(report.mcp.servers.find((item) => item.id === FIRST).harnesses,
    [{ id: 'claude', scope: 'project', state: 'unknown', fix: file }]);
  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Servers]');
  assert.ok(lines.includes(`    ${'claude'.padEnd(14)}${'project'.padEnd(9)}${'? unknown'.padEnd(19)}fix ${file} first`), lines.join('\n'));
});

test('X7: the servers view degrades to a one-line note when it cannot be built; findings and exit are unchanged', (t) => {
  const f = fixture(t);
  const stub = () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; };
  const degraded = withHome(f.home, () => buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: f.proj, execFileImpl: stub }));
  assert.deepEqual(degraded.mcp.servers, []);
  assert.match(degraded.mcp.serversNote, /^MCP server view unavailable: /);
  const full = withHome(f.home, () => buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: f.proj, execFileImpl: stub, adapters: buildAdapterRegistry() }));
  assert.equal(full.mcp.serversNote, undefined);
  assert.deepEqual(degraded.findings, full.findings);
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'runtime', 'health.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/cli\//, 'the runtime takes the adapter registry injected, never from the CLI layer');
});

test('an absent MCP file reads as unknown, never as not selected, and still carries the add command', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  install(f.proj);
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.deepEqual(report.mcp.servers.find((item) => item.id === FIRST).harnesses,
    [{ id: 'claude', scope: 'project', state: 'unknown', add: `doflow install --target claude --mcp ${FIRST}` }]);
  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Servers]');
  assert.ok(lines.includes(`    ${'claude'.padEnd(14)}${'project'.padEnd(9)}${'? unknown'.padEnd(19)}add: doflow install --target claude --mcp ${FIRST}`));
});

test('a selected server shows as selected with no add command; the research-request step is worded as such', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'], selected: { claude: [FIRST] } });
  install(f.proj);
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  const row = report.mcp.servers.find((item) => item.id === FIRST).harnesses.find((item) => item.id === 'claude');
  assert.equal(row.state, 'selected');
  assert.equal(row.add, undefined);
  const research = STEPPED.find((server) => server.steps.some((step) => step.expectedWhen === 'research-request'));
  const named = report.mcp.servers.find((item) => item.id === research.id).namedBy;
  assert.ok(named.some((item) => item.endsWith(' (research request)')), named.join(', '));
  const text = doctor(f, [f.proj]).stdout;
  assert.ok(section(text, '[MCP Servers]').some((line) => line.includes('named by ') && line.includes('(research request)')));
});

test('with no harness ledger rows the servers section says so and the run exits 0', (t) => {
  const f = fixture(t);
  const result = doctor(f, [f.proj]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(section(result.stdout, '[MCP Servers]'), [
    '[MCP Servers] — named by shipped stages; not blocking',
    '  No harness has DoFlow ledger rows here, so no server selection to report.',
  ]);
});

test('sections print after [Project Commands] and before [Warnings] / [Findings]', (t) => {
  const f = fixture(t);
  const out = doctor(f, [f.proj]).stdout;
  const at = (header) => out.indexOf(header);
  assert.ok(at('[Project Commands]') < at('[MCP Servers]'));
  assert.ok(at('[MCP Servers]') < at('[MCP Consultations]'));
  assert.ok(at('[MCP Consultations]') < at('[Findings]'));
  const warnings = at('[Warnings]');
  if (warnings !== -1) assert.ok(at('[MCP Consultations]') < warnings);
});

test('no run with recorded outcomes: the consultations section says so', (t) => {
  const f = fixture(t);
  const result = doctor(f, [f.proj]);
  assert.deepEqual(section(result.stdout, '[MCP Consultations]'), [
    '[MCP Consultations] — last 20 recorded stage runs per stage in this project; not blocking',
    '  No stage run in this project has recorded MCP outcomes yet.',
  ]);
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.deepEqual(report.mcp.consultations.stages, []);
  assert.equal(report.mcp.consultations.window, 20);
});

test('no outcome warns in doctor: the run is listed, counted once, and the exit code is unchanged', (t) => {
  const f = fixture(t);
  const before = doctor(f, [f.proj, '--json']);
  run(f, '062-mcp-leverage', [
    entry('2026-10-10T08:12:03.000Z', 'design', consultations('do-design', [FIRST, SECOND], [[FIRST, 'consulted-used']])),
  ]);
  const after = doctor(f, [f.proj, '--json']);
  assert.equal(after.status, before.status);
  const report = JSON.parse(after.stdout);
  assert.deepEqual(report.findings, JSON.parse(before.stdout).findings);
  const design = stage(report, 'do-design');
  assert.equal(design.runs, 1);
  assert.deepEqual(serverRow(design, SECOND), { server: SECOND, used: 0, nothingUsable: 0, skipped: 0, unavailable: 0, noOutcome: 1 });
  assert.deepEqual(design.noOutcome, [{ taskId: '062-mcp-leverage', node: 'design', at: '2026-10-10T08:12:03.000Z', server: SECOND }]);

  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Consultations]');
  assert.ok(lines.includes(`    ${OUTCOME_LABELS['no-outcome']}: 062-mcp-leverage design 2026-10-10T08:12:03.000Z (${SECOND})`), lines.join('\n'));
});

test('every outcome recorded is quiet: one used, one skipped, no "no outcome" line', (t) => {
  const f = fixture(t);
  run(f, 'quiet', [
    entry('2026-10-10T09:00:00.000Z', 'discovery', consultations('do-brainstorm', [FIRST, SECOND],
      [[FIRST, 'consulted-used'], [SECOND, 'skipped', 'not-due']])),
  ]);
  const result = doctor(f, [f.proj, '--json']);
  const brainstorm = stage(JSON.parse(result.stdout), 'do-brainstorm');
  assert.equal(serverRow(brainstorm, FIRST).used, 1);
  assert.equal(serverRow(brainstorm, SECOND).skipped, 1);
  assert.deepEqual(brainstorm.noOutcome, []);
  assert.ok(brainstorm.servers.every((row) => row.noOutcome === 0));
  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Consultations]');
  assert.equal(lines.some((line) => line.includes('no outcome recorded:')), false);
});

test('consulted with nothing usable keeps its own label and count', (t) => {
  const f = fixture(t);
  run(f, 'nothing', [
    entry('2026-10-10T09:00:00.000Z', 'design', consultations('do-design', [FIRST], [[FIRST, 'consulted-nothing-usable']])),
  ]);
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.deepEqual(serverRow(stage(report, 'do-design'), FIRST),
    { server: FIRST, used: 0, nothingUsable: 1, skipped: 0, unavailable: 0, noOutcome: 0 });
  const line = section(doctor(f, [f.proj]).stdout, '[MCP Consultations]').find((item) => item.includes(`${FIRST} `));
  const { 'consulted-used': used, 'consulted-nothing-usable': nothing, skipped, unavailable } = OUTCOME_LABELS;
  assert.ok(line.endsWith(`${used} 0 · ${nothing} 1 · ${skipped} 0 · ${unavailable} 0 · ${OUTCOME_LABELS['no-outcome']} 0`), line);
  const labels = Object.values(OUTCOME_LABELS);
  assert.equal(new Set(labels).size, labels.length);
});

test('unavailable is counted apart from skipped', (t) => {
  const f = fixture(t);
  run(f, 'gone', [
    entry('2026-10-10T09:00:00.000Z', 'design', consultations('do-design', [FIRST, SECOND],
      [[FIRST, 'unavailable'], [SECOND, 'skipped', 'not-due']])),
  ]);
  const design = stage(JSON.parse(doctor(f, [f.proj, '--json']).stdout), 'do-design');
  assert.equal(serverRow(design, FIRST).unavailable, 1);
  assert.equal(serverRow(design, FIRST).skipped, 0);
  assert.equal(serverRow(design, SECOND).skipped, 1);
  assert.equal(serverRow(design, SECOND).unavailable, 0);
});

test('old runs produce no "no outcome" line: entries without consultations are never counted', (t) => {
  const f = fixture(t);
  run(f, 'old', [
    { at: '2026-09-01T00:00:00.000Z', action: 'start', detail: 'task-class=feature' },
    entry('2026-09-01T01:00:00.000Z', 'design'),
    entry('2026-09-01T02:00:00.000Z', 'discovery', undefined, 'annotate'),
  ]);
  const result = doctor(f, [f.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).mcp.consultations.stages, []);
  assert.match(section(doctor(f, [f.proj]).stdout, '[MCP Consultations]')[1], /No stage run in this project has recorded MCP outcomes yet\./);
});

test('an unreadable run file is skipped and counted in one line', (t) => {
  const f = fixture(t);
  run(f, 'good', [entry('2026-10-10T09:00:00.000Z', 'design', consultations('do-design', [FIRST], [[FIRST, 'consulted-used']]))]);
  write(path.join(f.proj, '.doflow', 'state', 'orchestration', 'broken.json'), '{ not json');
  write(path.join(f.proj, '.doflow', 'state', 'orchestration', 'array.json'), '[]');
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.equal(report.mcp.consultations.unreadableRuns, 2);
  assert.equal(stage(report, 'do-design').runs, 1);
  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Consultations]');
  assert.ok(lines.includes('  2 run file(s) could not be read'), lines.join('\n'));
});

test('the window keeps the 20 most recent entries per skill by "at"', (t) => {
  const f = fixture(t);
  // 25 entries across two run files, written out of order; the oldest five record nothing for SECOND.
  const stamp = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const makeEntries = (days) => days.map((n) => entry(stamp(n), 'design', consultations('do-design', [FIRST, SECOND],
    n <= 5 ? [[FIRST, 'consulted-used']] : [[FIRST, 'consulted-used'], [SECOND, 'skipped', 'not-due']])));
  run(f, 'late', makeEntries([25, 6, 20, 7, 24, 8, 22, 9, 23, 10, 21, 11]));
  run(f, 'early', makeEntries([1, 12, 5, 13, 2, 14, 4, 15, 3, 16, 19, 17, 18]));
  const design = stage(JSON.parse(doctor(f, [f.proj, '--json']).stdout), 'do-design');
  assert.equal(design.runs, 20);
  assert.equal(serverRow(design, FIRST).used, 20);
  // Days 6..25 are kept: every kept entry carries an outcome for SECOND, so none lacks one.
  assert.equal(serverRow(design, SECOND).skipped, 20);
  assert.deepEqual(design.noOutcome, []);
});

test('X6: no-outcome entries are bounded per server and skill: the count, and at most the latest 3', (t) => {
  const f = fixture(t);
  const days = [3, 1, 5, 2, 4];
  run(f, 'quiet-ones', days.map((n) => entry(`2026-10-0${n}T00:00:00.000Z`, 'design', consultations('do-design', [FIRST, SECOND], [[FIRST, 'consulted-used']]))));
  const design = stage(JSON.parse(doctor(f, [f.proj, '--json']).stdout), 'do-design');
  assert.equal(serverRow(design, SECOND).noOutcome, 5);
  assert.deepEqual(design.noOutcome.map((miss) => [miss.server, miss.at]), [5, 4, 3].map((n) => [SECOND, `2026-10-0${n}T00:00:00.000Z`]));
  const lines = section(doctor(f, [f.proj]).stdout, '[MCP Consultations]').filter((line) => line.includes(`${OUTCOME_LABELS['no-outcome']}:`));
  assert.equal(lines.length, 3, lines.join('\n'));
});

test('the window is per skill: another skill keeps its own 20', (t) => {
  const f = fixture(t);
  const days = Array.from({ length: 22 }, (_, index) => index + 1);
  run(f, 'many', days.flatMap((n) => {
    const at = `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
    return [
      entry(at, 'design', consultations('do-design', [FIRST], [[FIRST, 'consulted-used']])),
      entry(at, 'discovery', consultations('do-brainstorm', [FIRST], [[FIRST, 'consulted-used']])),
    ];
  }));
  const report = JSON.parse(doctor(f, [f.proj, '--json']).stdout);
  assert.equal(stage(report, 'do-design').runs, 20);
  assert.equal(stage(report, 'do-brainstorm').runs, 20);
});

test('only servers with a steps entry are listed, and a registry entry with steps appears with no code change', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  install(f.proj);
  const repo = path.join(f.dir, 'repo');
  fs.mkdirSync(path.join(repo, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(repo, 'core', 'registry'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'core', 'shared'), path.join(repo, 'core', 'shared'));
  fs.symlinkSync(path.join(REPO_ROOT, 'core', 'harnesses'), path.join(repo, 'core', 'harnesses'));
  for (const name of ['bin', 'src']) fs.symlinkSync(path.join(REPO_ROOT, name), path.join(repo, name));
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(repo, 'package.json'));
  const file = path.join(repo, 'core', 'registry', 'mcp.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = { transport: 'stdio', command: 'npx', args: ['-y', 'acme'], selection: 'optional', doc: registry.servers[0].doc };
  const trigger = 'The work is about to state an acme fact as fact in an artifact.';
  registry.servers.push(
    { ...base, id: 'acme-docs', shortFlag: '--acme', trigger, steps: [{ skill: 'do-plan', file: 'SKILL.md' }] },
    { ...base, id: 'acme-quiet', shortFlag: '--quiet', trigger, steps: [] },
  );
  fs.writeFileSync(file, JSON.stringify(registry));
  const stub = () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; };
  const report = withHome(f.home, () => buildHealthReport({ repoRoot: repo, projectRoot: f.proj, execFileImpl: stub, adapters: buildAdapterRegistry() }));
  const ids = report.mcp.servers.map((server) => server.id);
  assert.ok(ids.includes('acme-docs'));
  assert.equal(ids.includes('acme-quiet'), false, 'a server with empty steps is not listed');
  assert.deepEqual(report.mcp.servers.find((server) => server.id === 'acme-docs').namedBy, ['do-plan']);
  assert.deepEqual(ids, STEPPED.map((server) => server.id).concat('acme-docs'));
});

test('findings and the exit code equal a run with the sections removed', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['pi'] });
  write(path.join(f.proj, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  run(f, 'noisy', [entry('2026-10-10T09:00:00.000Z', 'design', consultations('do-design', [FIRST, SECOND], []))]);
  const result = doctor(f, [f.proj, '--json']);
  assert.equal(result.status, 1, 'a real reach finding still exits 1');
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.every((item) => !/mcp/i.test(item.kind)));
  assert.ok(report.warnings.every((item) => !/mcp/i.test(item.kind)));
  assert.equal(stage(report, 'do-design').servers.reduce((sum, row) => sum + row.noOutcome, 0), 2);
  // The same project with the journals removed answers with the same findings and exit code.
  fs.rmSync(path.join(f.proj, '.doflow', 'state', 'orchestration'), { recursive: true });
  const bare = doctor(f, [f.proj, '--json']);
  assert.equal(bare.status, result.status);
  assert.deepEqual(JSON.parse(bare.stdout).findings, report.findings);
  assert.deepEqual(JSON.parse(bare.stdout).warnings, report.warnings);
});

test('the sections are deterministic: two runs over the same inputs print the same bytes', (t) => {
  const f = fixture(t);
  ledger(f.proj, 'project', { harnesses: ['claude'] });
  install(f.proj);
  run(f, 'twice', [entry('2026-10-10T09:00:00.000Z', 'design', consultations('do-design', [SECOND, FIRST], [[FIRST, 'consulted-used']]))]);
  const mcpText = () => ['[MCP Servers]', '[MCP Consultations]'].map((header) => section(doctor(f, [f.proj]).stdout, header).join('\n')).join('\n');
  assert.equal(mcpText(), mcpText());
  // Probe durations differ run to run, so the JSON comparison covers the `mcp` block only.
  assert.deepEqual(JSON.parse(doctor(f, [f.proj, '--json']).stdout).mcp, JSON.parse(doctor(f, [f.proj, '--json']).stdout).mcp);
});
