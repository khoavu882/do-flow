'use strict';

// MCP outcomes at handoff, through the CLI in a scratch project (062 CH5, IC-006, IC-007, IC-011).
// A stage that names a server and records no outcome warns; every outcome recorded is quiet; a
// subagent's report line counts; nothing here ever changes an exit code (NFR-003).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const SLUG = '063-demo';
const FEATURE = path.join('agent-docs', 'doflow', SLUG);
const CONTEXT7_WARN = '[WARN] mcp: do-brainstorm recorded no outcome for context7; pass --mcp-outcome context7=used|nothing-usable|skipped:<reason>|unavailable';
const SEQ_WARN = '[WARN] mcp: do-brainstorm recorded no outcome for sequential-thinking; pass --mcp-outcome sequential-thinking=used|nothing-usable|skipped:<reason>|unavailable';
const QUIET: any = ['--mcp-outcome', 'context7=used', '--mcp-outcome', 'sequential-thinking=skipped:not-due'];

/** A git-backed scratch project holding one feature folder, with its own HOME and XDG folders. */
/** Runs `fn` with HOME (and so `os.homedir()`) at `home`, so an in-process call never reads the
 * developer's real ~/.claude.json, ~/.gemini/settings.json or global ledger. */
function withHome(home: any, fn: any) {
  const saved: any = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function project(t: any) {
  const scratch = createScratch('doflow-mcp-handoff-');
  t.after(() => scratch.remove());
  const dir = path.join(scratch.dir, 'proj');
  fs.mkdirSync(path.join(dir, FEATURE, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(dir, FEATURE, 'requirement.md'), '# Requirement\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, scratch };
}

function cli(p: any, args: any) {
  const res = spawnSync('node', [DOFLOW, ...args], { cwd: p.dir, env: p.scratch.env(), encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const orch = (p: any, args: any) => cli(p, ['orchestrate', ...args]);
const start = (p: any) => {
  const res = orch(p, ['--action', 'start', '--task-id', SLUG, '--task-class', 'feature']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
};
const handoffArgs = (skill: any, extra: any = []) => ['--action', 'handoff', '--task-id', SLUG, '--task-class', 'feature', '--calling-skill', skill, '--note', 'recorded', ...extra];
const handoff = (p: any, skill: any, extra: any = []) => orch(p, handoffArgs(skill, extra));
const handoffJson = (p: any, skill: any, extra: any = []) => {
  const res = orch(p, [...handoffArgs(skill, extra), '--json']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return { ...res, data: JSON.parse(res.stdout) };
};
const runOf = (p: any) => JSON.parse(fs.readFileSync(path.join(p.dir, '.doflow', 'state', 'orchestration', `${SLUG}.json`), 'utf8'));
const entries = (p: any, action: any) => runOf(p).history.filter((e: any) => e.action === action);

function writeBrief(p: any, { id = 'A.1', stage = 'discovery', expected = [], report = `${FEATURE}/exec/task-${id}-report.md` }: any = {}) {
  fs.writeFileSync(path.join(p.dir, FEATURE, 'exec', `task-${id}-brief.json`), JSON.stringify({
    schema: 1, feature: SLUG, runTaskId: SLUG, stage, stageSkill: 'do-brainstorm', owner: 'core-implementer',
    tier: 'standard', tierSource: 'owner', harness: null, tasks: [{ id, report }], expected, optional: [], tools: [], missing: [],
  }));
  return report;
}

const writeReport = (p: any, report: any, text: any) => fs.writeFileSync(path.join(p.dir, report), text);

test('a stage with no outcome warns on stderr, names each server, and exits 0', (t) => {
  const p = project(t);
  start(p);
  const res = handoff(p, 'do-brainstorm');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Handoff: completed/);
  assert.deepEqual(res.stderr.trim().split('\n'), [CONTEXT7_WARN, SEQ_WARN]);
  assert.doesNotMatch(res.stdout, /\[WARN\]/, 'warnings go to stderr only');
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.named, ['context7', 'sequential-thinking']);
  assert.deepEqual(entry.consultations.outcomes, [], 'a missing outcome is derived, never stored');
});

test('a stage with every outcome recorded is quiet and stores the outcomes', (t) => {
  const p = project(t);
  start(p);
  const res: any = handoff(p, 'do-brainstorm', QUIET);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr, '');
  assert.doesNotMatch(res.stdout, /\[(WARN|INFO)\]/);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.outcomes, [
    { server: 'context7', state: 'consulted-used', source: 'flag' },
    { server: 'sequential-thinking', state: 'skipped', reason: 'not-due', source: 'flag' },
  ]);
  assert.equal(entry.consultations.skill, 'do-brainstorm');
  assert.equal(entry.consultations.schema, 1);
});

test('json mode returns consultations and mcpWarnings and prints nothing on stderr', (t) => {
  const p = project(t);
  start(p);
  const { data, stderr }: any = handoffJson(p, 'do-brainstorm', ['--mcp-outcome', 'context7=used']);
  assert.equal(stderr, '');
  assert.equal(data.disposition, 'completed');
  assert.equal(data.consultations.outcomes[0].server, 'context7');
  assert.deepEqual(data.mcpWarnings.map((w: any) => [w.kind, w.server]), [['no-outcome', 'sequential-thinking']]);
  assert.equal(data.mcpWarnings[0].text, SEQ_WARN);
});

/** Claude installed at the project with a `.mcp.json` that names none of the stage's servers. */
function installClaude(p: any, mcpServers: any = {}) {
  fs.writeFileSync(path.join(p.dir, '.mcp.json'), JSON.stringify({ mcpServers }));
  fs.mkdirSync(path.join(p.dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope: 'project', scopeRoot: p.dir, targets: {}, mcpSelections: {},
    resources: [{ harness: 'claude', assetId: 'skills.doflow', kind: 'copy-tree-file' }], legacyImports: [],
  }));
}

test('X1: a server absent from the MCP files DoFlow reads is not stored unavailable; the no-outcome warning fires', (t) => {
  const p = project(t);
  // Claude is installed here and its project file names no server, but Claude also loads servers
  // from configs DoFlow cannot read, so absence is no proof.
  installClaude(p);
  start(p);
  const res = handoff(p, 'do-brainstorm');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(res.stderr.trim().split('\n'), [CONTEXT7_WARN, SEQ_WARN]);
  assert.doesNotMatch(res.stdout, /unavailable/);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.outcomes, []);
});

test('X1 repro: a Claude local-scope server in ~/.claude.json is seen; an asserted unavailable is warned as contradicted, with no add command', (t) => {
  const p = project(t);
  installClaude(p, { other: {} });
  fs.writeFileSync(path.join(p.scratch.home, '.claude.json'), JSON.stringify({ projects: { [p.dir]: { mcpServers: { context7: {} } } } }));
  start(p);
  const res: any = handoff(p, 'do-brainstorm', ['--mcp-outcome', 'context7=unavailable', '--mcp-outcome', 'sequential-thinking=used']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), '[WARN] mcp: context7 reported unavailable but Claude Code has it configured');
  assert.match(res.stdout, /\[INFO\] mcp: context7 unavailable to do-brainstorm\n/);
  assert.doesNotMatch(res.stdout, /add it:/);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.outcomes.map((o: any) => [o.server, o.state, o.source]),
    [['context7', 'unavailable', 'flag'], ['sequential-thinking', 'consulted-used', 'flag']]);
});

test('an unavailable flag prints the notice and is stored with its source', (t) => {
  const p = project(t);
  start(p);
  const res: any = handoff(p, 'do-brainstorm', ['--mcp-outcome', 'context7=unavailable', '--mcp-outcome', 'sequential-thinking=nothing-usable']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /\[INFO\] mcp: context7 unavailable to do-brainstorm/);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.outcomes.map((o: any) => [o.server, o.state]), [['context7', 'unavailable'], ['sequential-thinking', 'consulted-nothing-usable']]);
});

test('a subagent report line counts: the outcome is attributed to tools-used and the line is recorded as evidence', (t) => {
  const p = project(t);
  start(p);
  const report = writeBrief(p);
  writeReport(p, report, '# Report\n\nDone.\n\nTools used: semble, rg, context7=used, sequential-thinking=skipped:not-due\n');
  const { data, stderr } = handoffJson(p, 'do-brainstorm');
  assert.equal(stderr, '');
  assert.deepEqual(data.mcpWarnings, []);
  const outcomes = data.consultations.outcomes;
  assert.deepEqual(outcomes.map((o: any) => [o.server, o.state, o.source, o.taskId]), [
    ['context7', 'consulted-used', 'tools-used', 'A.1'],
    // A provider's own MCP server is an MCP entry too (IC-009), though no stage names it.
    ['semble', 'consulted-used', 'tools-used', 'A.1'],
    ['sequential-thinking', 'skipped', 'tools-used', 'A.1'],
  ]);
  const [row] = data.consultations.toolsUsed;
  assert.equal(row.status, 'recorded');
  assert.match(row.evidenceId, /^ev_/);
  const ledger = JSON.parse(fs.readFileSync(path.join(p.dir, '.doflow', 'state', 'evidence', SLUG, 'A.1.json'), 'utf8'));
  assert.equal(ledger.evidence.length, 1);
  const [item] = ledger.evidence;
  assert.equal(item.id, row.evidenceId);
  assert.equal(item.provenance, 'asserted');
  assert.deepEqual(item.source, { provider: 'dispatched-agent', capability: 'tools-used' });
  assert.equal(item.content, 'Tools used: semble, rg, context7=used, sequential-thinking=skipped:not-due');
  assert.deepEqual(item.locator, { file: report, line: 5 });
  assert.deepEqual(item.establishes, []);
});

test('the same report line is not recorded twice on a rerun', (t) => {
  const p = project(t);
  start(p);
  const report = writeBrief(p);
  writeReport(p, report, 'Tools used: context7=used, sequential-thinking=used\n');
  const first = handoffJson(p, 'do-brainstorm').data;
  const again = handoffJson(p, 'do-brainstorm').data;
  assert.equal(again.disposition, 'annotated');
  assert.equal(first.consultations.toolsUsed[0].status, 'recorded');
  assert.equal(again.consultations.toolsUsed[0].status, 'already-recorded');
  assert.equal(again.consultations.toolsUsed[0].evidenceId, first.consultations.toolsUsed[0].evidenceId);
  const ledger = JSON.parse(fs.readFileSync(path.join(p.dir, '.doflow', 'state', 'evidence', SLUG, 'A.1.json'), 'utf8'));
  assert.equal(ledger.evidence.length, 1);
  const [annotation] = entries(p, 'annotate');
  assert.equal(annotation.consultations.skill, 'do-brainstorm', 'a rerun handoff stores its record on the annotate entry');
});

test('an agent type without MCP is stated: a brief that expected an unreachable server records it unavailable', (t) => {
  const p = project(t);
  start(p);
  const report: any = writeBrief(p, { expected: [{ server: 'context7', reach: 'unreachable', detail: 'not-taken' }] });
  writeReport(p, report, 'Tools used: rg\n');
  const res: any = handoff(p, 'do-brainstorm', ['--mcp-outcome', 'sequential-thinking=used']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /\[INFO\] mcp: context7 unavailable to do-brainstorm/);
  const [entry] = entries(p, 'complete-stage');
  const context7 = entry.consultations.outcomes.find((o: any) => o.server === 'context7');
  assert.deepEqual([context7.state, context7.source, context7.taskId], ['unavailable', 'brief', 'A.1']);
});

test('a report without a Tools used line warns, names the task and path, and still exits 0', (t) => {
  const p = project(t);
  start(p);
  const report = writeBrief(p);
  writeReport(p, report, '# Report\n\nNothing about tools here.\n');
  const res: any = handoff(p, 'do-brainstorm', QUIET);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), `[WARN] tools-used: task A.1 report ${report} has no "Tools used:" line`);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.toolsUsed, [{ taskId: 'A.1', status: 'no-line', report }]);
  assert.equal(fs.existsSync(path.join(p.dir, '.doflow', 'state', 'evidence', SLUG, 'A.1.json')), false);
});

test('a brief record whose report file is missing warns and exits 0', (t) => {
  const p = project(t);
  start(p);
  const report = writeBrief(p);
  const res: any = handoff(p, 'do-brainstorm', QUIET);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), `[WARN] tools-used: task A.1 has no report at ${report}`);
});

test('a bad --mcp-outcome value is ignored with one warning; the handoff still records and exits 0', (t) => {
  const p = project(t);
  start(p);
  const res: any = handoff(p, 'do-brainstorm', ['--mcp-outcome', 'context7=skipped', '--mcp-outcome', 'sequential-thinking=used']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = res.stderr.trim().split('\n');
  assert.match(lines[0], /^\[WARN\] mcp: ignored --mcp-outcome 'context7=skipped': skipped needs a reason/);
  assert.equal(lines[1], CONTEXT7_WARN);
  assert.equal(lines.length, 2);
  assert.match(res.stdout, /Handoff: completed/);
});

test('a server outside the registry is recorded as given with one notice', (t) => {
  const p = project(t);
  start(p);
  const res: any = handoff(p, 'do-brainstorm', [...QUIET, '--mcp-outcome', 'acme-docs=used']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /\[INFO\] mcp: acme-docs is not in DoFlow's MCP registry; recorded as given/);
  const [entry] = entries(p, 'complete-stage');
  assert.ok(entry.consultations.outcomes.some((o: any) => o.server === 'acme-docs' && o.state === 'consulted-used'));
  assert.deepEqual(entry.consultations.named, ['context7', 'sequential-thinking'], 'named stays what the registry says');
});

test('--mcp-outcome on any action but handoff is a usage error, as --result is', (t) => {
  const p = project(t);
  start(p);
  const res = orch(p, ['--action', 'status', '--task-id', SLUG, '--mcp-outcome', 'context7=used']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /'--mcp-outcome' has no effect on action 'status' — only handoff records MCP outcomes/);
  const complete = orch(p, ['--action', 'complete-stage', '--task-id', SLUG, '--stage', 'discovery', '--mcp-outcome', 'context7=used']);
  assert.equal(complete.status, 2);
  assert.equal(entries(p, 'complete-stage').length, 0, 'a usage error changes nothing');
});

test('a deferred handoff prints nothing about MCP and stores consultations: null', (t) => {
  const p = project(t);
  start(p);
  // gate-0 is unapproved, so a design handoff stops before it.
  const text = handoff(p, 'do-design');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /Handoff: deferred/);
  assert.equal(text.stderr, '');
  assert.doesNotMatch(text.stdout, /mcp:/);
  const { data } = handoffJson(p, 'do-design');
  assert.equal(data.disposition, 'deferred');
  assert.equal(data.consultations, null);
  assert.deepEqual(data.mcpWarnings, []);
  assert.deepEqual(runOf(p).history.filter((e: any) => 'consultations' in e), []);
});

test('a standalone handoff prints the warnings and stores nothing', (t) => {
  const p = project(t);
  const res = orch(p, ['--action', 'handoff', '--task-id', SLUG, '--calling-skill', 'do-brainstorm', '--note', 'recorded']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Handoff: standalone/);
  assert.deepEqual(res.stderr.trim().split('\n'), [CONTEXT7_WARN, SEQ_WARN]);
  assert.equal(fs.existsSync(path.join(p.dir, '.doflow', 'state', 'orchestration', `${SLUG}.json`)), false);
  assert.equal(fs.existsSync(path.join(p.dir, '.doflow', 'state', 'evidence')), false);
});

test('catch-up backfills, skip-stage, gate decisions and a direct complete-stage carry no consultations', (t) => {
  const p = project(t);
  // A design handoff on a fresh run: gate-0 stops it, so discovery is backfilled by catch-up only.
  assert.equal(orch(p, ['--action', 'start', '--task-id', SLUG, '--task-class', 'feature']).status, 0);
  assert.equal(orch(p, ['--action', 'complete-stage', '--task-id', SLUG, '--stage', 'discovery']).status, 0);
  assert.equal(orch(p, ['--action', 'decide-gate', '--task-id', SLUG, '--gate', 'gate-0', '--decision', 'approve']).status, 0);
  const catchUp = orch(p, ['--action', 'catch-up', '--task-id', SLUG, '--task-class', 'feature', '--stage', 'planning']);
  assert.equal(catchUp.status, 0, catchUp.stdout + catchUp.stderr);
  const history = runOf(p).history;
  assert.ok(history.some((e: any) => e.action === 'complete-stage' && e.backfilled === true), 'a backfilled entry exists');
  assert.deepEqual(history.filter((e: any) => 'consultations' in e), []);
  assert.equal(catchUp.stderr, '');

  const q = project(t);
  start(q);
  const skip = orch(q, ['--action', 'skip-stage', '--task-id', SLUG, '--stage', 'discovery']);
  assert.equal(skip.status, 1, 'a required stage cannot be skipped, as before');
  assert.deepEqual(runOf(q).history.filter((e: any) => 'consultations' in e), []);
});

test('exit codes equal the same call without outcomes, success and failure alike', (t) => {
  const withFlags = project(t);
  const without = project(t);
  start(withFlags);
  start(without);
  assert.equal(handoff(withFlags, 'do-brainstorm', QUIET).status, handoff(without, 'do-brainstorm').status);
  // A failing handoff keeps failing the same way: an unknown skill owns no stage.
  const bad: any = handoff(withFlags, 'do-nothing', QUIET);
  const badWithout = handoff(without, 'do-nothing');
  assert.equal(bad.status, 1);
  assert.equal(bad.status, badWithout.status);
  assert.equal(bad.stderr, badWithout.stderr);
});

/** An evidence item for the run, attributed to a server, as a folded-in fact would be. */
function writeServerEvidence(p: any, provider: any) {
  const file = path.join(p.dir, '.doflow', 'state', 'evidence', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const item: any = {
    id: 'ev_fixture_1', taskId: SLUG, kind: 'generated-analysis', source: { provider, capability: 'docs' }, locator: {},
    provenance: 'extracted', content: 'a fact', freshness: { gitCommit: null, fileHash: null, observedAt: new Date().toISOString(), status: 'FRESH' },
    establishes: [], observation: null, supports: [], contradicts: [], status: 'active', supersededBy: null,
  };
  fs.writeFileSync(file, JSON.stringify({ taskId: SLUG, updatedAt: item.freshness.observedAt, evidenceCount: 1, evidence: [item] }));
}

test('X3: evidence recorded during brainstorm does not satisfy design', (t) => {
  const p = project(t);
  start(p);
  writeServerEvidence(p, 'context7');
  const brainstorm: any = handoffJson(p, 'do-brainstorm', ['--mcp-outcome', 'sequential-thinking=used']).data;
  assert.deepEqual(brainstorm.consultations.outcomes.find((o: any) => o.server === 'context7'), { server: 'context7', state: 'consulted-used', source: 'evidence' });
  assert.equal(orch(p, ['--action', 'decide-gate', '--task-id', SLUG, '--gate', 'gate-0', '--decision', 'approve']).status, 0);
  const design: any = handoffJson(p, 'do-design', ['--mcp-outcome', 'sequential-thinking=used']).data;
  assert.equal(design.disposition, 'completed');
  assert.deepEqual(design.consultations.outcomes.map((o: any) => o.server), ['sequential-thinking']);
  assert.deepEqual(design.mcpWarnings.map((w: any) => [w.kind, w.server]), [['no-outcome', 'context7']]);
});

test('X11 fail-open: a corrupt brief record, an unreadable evidence ledger and a report reader that fails never stop the handoff', (t) => {
  const p = project(t);
  start(p);
  fs.writeFileSync(path.join(p.dir, FEATURE, 'exec', 'task-B.1-brief.json'), '{ not json');
  const report = writeBrief(p);
  writeReport(p, report, 'Tools used: context7=used, sequential-thinking=used\n');
  // The run's own ledger is flat (its id is the slug); the subagent task's is under the slug (115 C-1).
  fs.mkdirSync(path.join(p.dir, '.doflow', 'state', 'evidence', SLUG), { recursive: true });
  for (const rel of [`${SLUG}.json`, path.join(SLUG, 'A.1.json')]) fs.writeFileSync(path.join(p.dir, '.doflow', 'state', 'evidence', rel), '{ not json');
  const res = handoff(p, 'do-brainstorm');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Handoff: completed/);
  const [entry] = entries(p, 'complete-stage');
  assert.deepEqual(entry.consultations.outcomes.map((o: any) => [o.server, o.source]), [['context7', 'tools-used'], ['sequential-thinking', 'tools-used']]);
  assert.equal(entry.consultations.toolsUsed[0].evidenceId, undefined, 'a ledger that cannot be written leaves the row without an id');

  // A report path that is a directory makes the reader fail: the row is no-report, the handoff completes.
  const q = project(t);
  start(q);
  const dirReport = writeBrief(q);
  fs.mkdirSync(path.join(q.dir, dirReport));
  const dirRes: any = handoff(q, 'do-brainstorm', QUIET);
  assert.equal(dirRes.status, 0, dirRes.stdout + dirRes.stderr);
  assert.deepEqual(entries(q, 'complete-stage')[0].consultations.toolsUsed, [{ taskId: 'A.1', status: 'no-report', report: dirReport }]);
});

test('X11 fail-open: a registry that will not load stores no record and the handoff completes', (t) => {
  const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
  const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
  const { buildAdapterRegistry } = require('../../src/cli/shared.ts');
  const p = project(t);
  const broken = path.join(p.scratch.dir, 'broken-repo');
  fs.mkdirSync(path.join(broken, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'core', 'registry', 'mcp.json'), '{ not json');
  const orchestrator: any = new WorkflowOrchestrator({
    repoRoot: broken, projectRoot: p.dir, engine: new WorkflowEngine({ repoRoot: REPO }), buildAdapters: buildAdapterRegistry,
  });
  const result = withHome(p.scratch.home, () => orchestrator.handoff({ taskId: SLUG, taskClass: 'feature', callingSkill: 'do-brainstorm', note: 'recorded' }));
  assert.equal(result.disposition, 'completed');
  assert.equal(result.consultations, null);
  assert.deepEqual(result.mcpWarnings, []);
  assert.deepEqual(runOf(p).history.filter((e: any) => 'consultations' in e), []);
});

test('X11 retry: evidence saved before a refused completion is found again, not added twice', (t) => {
  const { ResearchRequestStore } = require('../../src/runtime/research-request.ts');
  const p = project(t);
  start(p);
  const report = writeBrief(p);
  writeReport(p, report, 'Tools used: context7=used, sequential-thinking=used\n');
  const store: any = new ResearchRequestStore({ projectRoot: p.dir });
  store.open({ taskId: SLUG, stageId: 'discovery', question: 'what blocks?', reason: 'detected-gap', blocking: true });
  const refused = handoff(p, 'do-brainstorm');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(entries(p, 'complete-stage').length, 0, 'the completion was refused');
  const ledgerFile = path.join(p.dir, '.doflow', 'state', 'evidence', SLUG, 'A.1.json');
  const saved = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).evidence;
  assert.equal(saved.length, 1, 'the evidence went in before the refusal');

  fs.rmSync(store.file(SLUG));
  const retry = handoffJson(p, 'do-brainstorm').data;
  assert.equal(retry.disposition, 'completed');
  assert.deepEqual(retry.consultations.toolsUsed, [{ taskId: 'A.1', status: 'already-recorded', evidenceId: saved[0].id }]);
  assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).evidence.length, 1);
  assert.equal(entries(p, 'complete-stage').length, 1);
});
