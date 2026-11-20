'use strict';

// 143 D.2 (IC-002, IC-003; FR-002, FR-004, NFR-003): `review start` through its real entry point,
// `handleReviewCommand`, with the `team.verdict` observer wired in. Every scenario runs four ways against one
// scratch project: telemetry off (the baseline), an in-memory `teamWriter`, no `teamWriter` (the recorder
// builds a real writer at the project), and a `teamWriter` that throws. The answer lines, the exit code and the
// record handed to the existing `writer` must be the same in all four; only the team line may differ.
// Every directory is a temp directory, nothing touches the network or a model, the real HOME is never read.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSettingsEnv } = require('../../helper/settings-fixtures.ts');
const { handleReviewCommand } = require('../../../src/runtime/review/command.ts');
const { writeReadinessRecord } = require('../../../src/runtime/readiness-record.ts');
const { teamGate } = require('../../../src/runtime/team/evaluate.ts');

const START_SLUG = '143-wiring';
const LINE_KEYS = ['attempt', 'count', 'kind', 'lineage', 'mode', 'outcome', 'reason', 'rule', 'run', 'site', 'task', 'timestamp'];

const ON = { DOFLOW_TELEMETRY: undefined }; // `undefined` removes the key from the fixture env
const OFF = { DOFLOW_TELEMETRY: 'off' };

function scratch(t: any, prefix: string) {
  const f = createSettingsEnv(t, { prefix });
  fs.mkdirSync(path.join(f.project, '.doflow', 'state', 'runs'), { recursive: true }); // the writer never creates the ledger directory
  return f;
}

const telemetryDir = (f: any) => path.join(f.project, '.doflow', 'state', 'runs', 'telemetry');

/** Every parsed line under the project's telemetry directory. */
function diskLines(f: any): any[] {
  const dir = telemetryDir(f);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name: string) => name.endsWith('.jsonl')).sort()
    .flatMap((name: string) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)));
}

function resetTelemetry(f: any) {
  fs.rmSync(telemetryDir(f), { recursive: true, force: true });
}

/** An in-memory writer: every record handed to `write`, flat. */
function memoryWriter() {
  const records: any[] = [];
  return { records, writer: { write: (batch: any[]) => { records.push(...batch); } } };
}

const throwingWriter = () => ({ write() { throw new Error('teamWriter boom'); } });

/** Every file under `root` as relative path -> content, skipping the telemetry directory. */
function stateTree(root: string, base: string = root, out: Record<string, string> = {}) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'telemetry' || entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) stateTree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

/** The IC-003 shape of one recorded line, less the common fields. */
function assertTeamLine(line: any, project: string, expected: any) {
  assert.deepEqual(Object.keys(line).sort(), LINE_KEYS, 'IC-003 fields and the common fields only');
  assert.equal(line.kind, 'team.verdict');
  assert.deepEqual(
    { site: line.site, rule: line.rule, outcome: line.outcome, reason: line.reason, mode: line.mode, task: line.task, count: line.count },
    expected,
  );
  assert.equal(JSON.stringify(line).includes(project), false, 'a line holds no path');
}

// ---- review start -----------------------------------------------------------------------------

/**
 * A scratch git repository holding one change, with `.doflow/` excluded so run and record files keep the
 * tree clean, a task run for START_SLUG, and one verification record at HEAD (`pass` false: a FAIL record,
 * which makes the start refuse at its precondition).
 */
function startRepo(t: any, { evidence = false, pass = true, run = true, taskClass = 'feature' }: any = {}) {
  const f = scratch(t, 'doflow-team-review-start-');
  const env = f.env(OFF);
  const git = (args: string[]) => {
    const res = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: f.project, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(f.project, rel)), { recursive: true });
    fs.writeFileSync(path.join(f.project, rel), text);
  };
  git(['init', '-q', '-b', 'main']);
  put('.git/info/exclude', '.doflow/\n');
  put('README.md', 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  put('src/a.ts', 'export {};\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'change']);
  const head = git(['rev-parse', 'HEAD']);
  if (run) {
    put(`.doflow/state/orchestration/${START_SLUG}.json`, JSON.stringify({ taskId: START_SLUG, taskClass, state: 'ACTIVE', program: [], history: [] }));
    const record = { schema: 1, taskId: START_SLUG, head, clean: true, verdict: pass ? 'PASS' : 'FAIL', at: '2026-10-23T00:00:00.000Z', reportSha256: 'x' };
    put(`.doflow/state/verification/runs/${START_SLUG}.jsonl`, `${JSON.stringify(record)}\n`);
  }
  if (evidence) {
    writeReadinessRecord({
      stateRoot: f.project, taskId: START_SLUG, mode: 'workflow', inputs: {},
      report: { taskClass: 'feature', templateName: 'feature', requirements: [], state: 'READY' },
    });
  }
  return f;
}

async function runStart(f: any, { env, teamWriter, slug = START_SLUG }: any) {
  const out: string[] = [];
  const options: any = {
    action: 'start', slug, json: true, cwd: f.project, env, resolve: () => ({ error: 'no-active-feature' }), out: (line: string) => out.push(line),
  };
  if (teamWriter !== undefined) options.teamWriter = teamWriter;
  const saved = process.exitCode;
  const exitCode = await handleReviewCommand(options);
  process.exitCode = saved;
  return { exitCode, out, state: stateTree(path.join(f.project, '.doflow')) };
}

async function startVariants(f: any, { slug }: any = {}) {
  const off = f.env(OFF);
  const on = f.env(ON);
  resetTelemetry(f);
  const baseline = await runStart(f, { env: off, slug });
  assert.deepEqual(diskLines(f), [], 'telemetry off writes no line');
  const team = memoryWriter();
  const captured = await runStart(f, { env: on, teamWriter: team.writer, slug });
  assert.deepEqual(diskLines(f), [], 'an injected teamWriter keeps the line off the disk');
  const throwing = await runStart(f, { env: on, teamWriter: throwingWriter(), slug });
  assert.deepEqual(diskLines(f), [], 'a throwing teamWriter writes nothing');
  const real = await runStart(f, { env: on, slug });
  return { baseline, captured, throwing, real, teamRecords: team.records, realLines: diskLines(f) };
}

function assertStartUnchanged(v: any) {
  for (const name of ['captured', 'throwing', 'real']) {
    const got = v[name];
    assert.equal(got.exitCode, v.baseline.exitCode, `${name}: exit code`);
    assert.deepEqual(got.out, v.baseline.out, `${name}: stdout`);
    assert.deepEqual(got.state, v.baseline.state, `${name}: no other state file added, changed or removed`);
  }
}

describe('review start: the pre-check verdict', () => {
  test('final emit, no readiness record: refused / ERR_MECHANICAL_CHECKS_FAILED counting that one failure', async (t: any) => {
    const f = startRepo(t);
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 0, v.baseline.out.join('\n'));
    assert.equal(JSON.parse(v.baseline.out.join('\n')).ok, true);
    assertStartUnchanged(v);
    const expected = { site: 'review-start', rule: 'pre-check', outcome: 'refused', reason: 'ERR_MECHANICAL_CHECKS_FAILED', mode: 'advisory', task: START_SLUG, count: 1 };
    assert.equal(v.teamRecords.length, 1);
    const { kind, ...verdict } = v.teamRecords[0];
    assert.deepEqual(verdict, expected);
    assert.equal(v.realLines.length, 1);
    assertTeamLine(v.realLines[0], f.project, expected);
  });

  test('final emit, pre-check evidence present: admitted, count null', async (t: any) => {
    const f = startRepo(t, { evidence: true });
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 0, v.baseline.out.join('\n'));
    assertStartUnchanged(v);
    const expected = { site: 'review-start', rule: 'pre-check', outcome: 'admitted', reason: null, mode: 'advisory', task: START_SLUG, count: null };
    assert.equal(v.teamRecords.length, 1);
    assertTeamLine(v.realLines[0], f.project, expected);
  });

  test('failed-precondition emit, no evidence: exit 1 as before, one refused verdict', async (t: any) => {
    const f = startRepo(t, { pass: false });
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 1);
    const answer = JSON.parse(v.baseline.out.join('\n'));
    assert.equal(answer.ok, false);
    assert.ok(answer.reasons.length > 0);
    assertStartUnchanged(v);
    assert.equal(v.teamRecords.length, 1);
    assertTeamLine(v.realLines[0], f.project, {
      site: 'review-start', rule: 'pre-check', outcome: 'refused', reason: 'ERR_MECHANICAL_CHECKS_FAILED', mode: 'advisory', task: START_SLUG, count: 2,
    });
  });

  test('failed-precondition emit, READY record: exit 1 as before, one refused verdict naming the one unmet verify reason', async (t: any) => {
    const f = startRepo(t, { pass: false, evidence: true });
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 1);
    assertStartUnchanged(v);
    assert.equal(v.teamRecords.length, 1);
    assertTeamLine(v.realLines[0], f.project, {
      site: 'review-start', rule: 'pre-check', outcome: 'refused', reason: 'ERR_MECHANICAL_CHECKS_FAILED', mode: 'advisory', task: START_SLUG, count: 1,
    });
  });

  test('no feature at all (not applicable): the answer is unchanged and no team.verdict line is written', async (t: any) => {
    const f = startRepo(t, { run: false });
    const v = await startVariants(f, { slug: null });
    assert.equal(v.baseline.exitCode, 0);
    assert.equal(JSON.parse(v.baseline.out.join('\n')).notApplicable, 'no-feature');
    assertStartUnchanged(v);
    assert.deepEqual(v.teamRecords, []);
    assert.deepEqual(v.realLines, []);
  });

  test('a feature with no task run (not applicable): the answer is unchanged and no team.verdict line is written', async (t: any) => {
    const f = startRepo(t, { run: false });
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 0);
    assert.equal(JSON.parse(v.baseline.out.join('\n')).notApplicable, 'no-run');
    assertStartUnchanged(v);
    assert.deepEqual(v.teamRecords, []);
    assert.deepEqual(v.realLines, []);
  });

  test('a class-exempt run (not applicable): the answer is unchanged and no team.verdict line is written', async (t: any) => {
    const f = startRepo(t, { taskClass: 'trivial-edit' });
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 0);
    assert.equal(JSON.parse(v.baseline.out.join('\n')).notApplicable, 'class-exempt');
    assertStartUnchanged(v);
    assert.deepEqual(v.teamRecords, []);
    assert.deepEqual(v.realLines, []);
  });

  test('a start refused before it is applicable (ambiguous or unreadable records) records no team line', async (t: any) => {
    const f = startRepo(t);
    fs.writeFileSync(path.join(f.project, '.doflow', 'state', 'verification', 'runs', `${START_SLUG}.jsonl`), '{ not json\n');
    const v = await startVariants(f);
    assert.equal(v.baseline.exitCode, 1);
    assert.equal(JSON.parse(v.baseline.out.join('\n')).error, 'records-unreadable');
    assertStartUnchanged(v);
    assert.deepEqual(v.teamRecords, []);
    assert.deepEqual(v.realLines, []);
  });

  test('team.enforcement=block does not touch the start: same stdout, exit code and state, advisory line', async (t: any) => {
    for (const pass of [true, false]) {
      const f = startRepo(t, { pass });
      const advisory = await startVariants(f);
      f.writeProjectSettings({ schema: 1, 'team.enforcement': 'block' });
      assert.equal(teamGate({ projectRoot: f.project, env: f.env(ON) }).mode, 'block', 'the fixture really sets block');
      const block = await startVariants(f);
      assertStartUnchanged(block);
      assert.equal(block.baseline.exitCode, advisory.baseline.exitCode);
      assert.deepEqual(block.baseline.out, advisory.baseline.out);
      assert.equal(block.baseline.exitCode, pass ? 0 : 1);
      assert.equal(block.realLines.length, 1);
      assert.equal(block.realLines[0].mode, 'advisory', 'a review site always records advisory');
      assert.equal(block.realLines[0].outcome, 'refused');
    }
  });
});
