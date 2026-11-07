'use strict';

// 143 B.2 (IC-001, IC-003, IC-004; FR-001, FR-003, FR-005, FR-006, NFR-003): the evaluation half of the team
// wiring. The six replay rows run through evaluateAdmission and teamGate; the setting resolution reads real
// layer files in a scratch HOME (createSettingsEnv), never the real one; the recorder writes into a scratch
// project's run ledger. Review observers take an in-memory writer unless the case is about the written line.
// No network, no model call, every directory is a temp directory.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');
const { writeReadinessRecord } = require('../../src/runtime/readiness-record.ts');
const {
  teamGate, evaluateAdmission, observeStart, observeCheck, record,
} = require('../../src/runtime/team/evaluate.ts');

const CAP1 = Object.freeze({ writerCap: 1, maxAttempts: 3 });
const CAP2 = Object.freeze({ writerCap: 2, maxAttempts: 3 });
const VERDICT_KEYS = ['count', 'mode', 'outcome', 'reason', 'rule', 'site', 'task'];
const LINE_KEYS = ['attempt', 'count', 'kind', 'lineage', 'mode', 'outcome', 'reason', 'rule', 'run', 'site', 'task', 'timestamp'];

const E = 'team.enforcement';
const W = 'team.writerCap';
const M = 'team.maxAttempts';

/** A settings fixture whose project also holds the run ledger directory the recorder appends under. */
function fixture(t: any) {
  const f = createSettingsEnv(t, { prefix: 'doflow-team-evaluate-' });
  const runs = path.join(f.project, '.doflow', 'state', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  return Object.assign(f, {
    runs,
    telemetryDir: path.join(runs, 'telemetry'),
    /** Every `team.verdict` line written under the project, parsed. */
    lines(): any[] {
      const dir = path.join(runs, 'telemetry');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((name: string) => name.endsWith('.jsonl')).sort()
        .flatMap((name: string) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)));
    },
    rawText(): string {
      const dir = path.join(runs, 'telemetry');
      if (!fs.existsSync(dir)) return '';
      return fs.readdirSync(dir).map((name: string) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
    },
  });
}

/** An in-memory writer: what `record` hands the telemetry writer, before sanitising. */
function capture() {
  const calls: any[][] = [];
  return { calls, writer: { write: (records: any[]) => { calls.push(records); } }, last: () => calls[calls.length - 1]?.[0] };
}

const candidate = (extra: any = {}) => ({ task: 'B.1', files: ['src/b.ts'], owner: 'core-implementer', harness: 'claude', ...extra });
const active = (task: string, ...files: string[]) => ({ task, files });

describe('IC-001: the six replay rows', () => {
  test('cap 1, a disjoint writer already active: WRITER_CAP_EXCEEDED', () => {
    const got = evaluateAdmission(candidate({ active: [active('A.1', 'src/a.ts')] }), CAP1);
    assert.deepEqual(got, {
      site: 'dispatch-admit', rule: 'admission', outcome: 'refused', reason: 'WRITER_CAP_EXCEEDED',
      mode: 'advisory', task: 'B.1', count: null,
    });
  });

  test('cap 2, a disjoint writer already active: admitted', () => {
    const got = evaluateAdmission(candidate({ active: [active('A.1', 'src/a.ts')] }), CAP2);
    assert.deepEqual(got, {
      site: 'dispatch-admit', rule: 'admission', outcome: 'admitted', reason: null,
      mode: 'advisory', task: 'B.1', count: null,
    });
  });

  test('cap 2, an overlapping writer active: WRITE_SET_CONFLICT with the number of overlapping files', () => {
    const got = evaluateAdmission(
      candidate({ files: ['src/a.ts', 'src/c.ts', 'src/z.ts'], active: [active('A.1', 'src/a.ts', 'src/c.ts')] }), CAP2,
    );
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'WRITE_SET_CONFLICT');
    assert.equal(got.count, 2);
    assert.equal(got.task, 'B.1');
  });

  test('attempts exhausted (priorAttempts at maxAttempts): MAX_ATTEMPTS_EXCEEDED; one below the bound is admitted', () => {
    const exhausted = evaluateAdmission(candidate({ priorAttempts: 3 }), CAP1);
    assert.equal(exhausted.outcome, 'refused');
    assert.equal(exhausted.reason, 'MAX_ATTEMPTS_EXCEEDED');
    assert.equal(exhausted.count, null);
    // priorAttempts beyond the bound is clamped to it, so the answer is the same
    assert.equal(evaluateAdmission(candidate({ priorAttempts: 99 }), CAP1).reason, 'MAX_ATTEMPTS_EXCEEDED');
    const below = evaluateAdmission(candidate({ priorAttempts: 2 }), CAP1);
    assert.equal(below.outcome, 'admitted');
    assert.equal(below.reason, null);
  });

  test('two actives at cap 1: WRITER_CAP_EXCEEDED; at cap 2 the same two actives still fill the cap', () => {
    const actives = [active('A.1', 'src/a.ts'), active('A.2', 'src/a2.ts')];
    assert.equal(evaluateAdmission(candidate({ active: actives }), CAP1).reason, 'WRITER_CAP_EXCEEDED');
    const atTwo = evaluateAdmission(candidate({ active: actives }), CAP2);
    assert.equal(atTwo.outcome, 'refused');
    assert.equal(atTwo.reason, 'WRITER_CAP_EXCEEDED');
  });

  test('a read-only candidate (no files) is admitted even when the cap is full', () => {
    const got = evaluateAdmission(candidate({ files: [], active: [active('A.1', 'src/a.ts')] }), CAP1);
    assert.equal(got.outcome, 'admitted');
    assert.equal(got.reason, null);
    assert.equal(got.count, null);
  });

  test('control: no active dispatch and no prior attempt is admitted at cap 1', () => {
    assert.equal(evaluateAdmission(candidate(), CAP1).outcome, 'admitted');
  });

  test('a candidate whose own task is already among the actives: TASK_ALREADY_ACTIVE', () => {
    const got = evaluateAdmission(candidate({ active: [active('B.1', 'src/other.ts')] }), CAP2);
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'TASK_ALREADY_ACTIVE');
  });
});

describe('IC-001/IC-003: the verdict shape', () => {
  test('a verdict holds exactly the seven IC-003 fields, whatever the outcome', () => {
    const outcomes = [
      evaluateAdmission(candidate(), CAP1),
      evaluateAdmission(candidate({ active: [active('A.1', 'src/a.ts')] }), CAP1),
      evaluateAdmission(candidate({ files: ['src/a.ts'], active: [active('A.1', 'src/a.ts')] }), CAP2),
      evaluateAdmission(null, CAP1),
    ];
    for (const got of outcomes) assert.deepEqual(Object.keys(got).sort(), VERDICT_KEYS);
  });

  test('mode follows the input: block stays block, anything else is advisory; the outcome does not depend on it', () => {
    const base = { active: [active('A.1', 'src/a.ts')] };
    const block = evaluateAdmission(candidate({ ...base, mode: 'block' }), CAP1);
    const advisory = evaluateAdmission(candidate({ ...base, mode: 'advisory' }), CAP1);
    const odd = evaluateAdmission(candidate({ ...base, mode: 'enforce' }), CAP1);
    assert.equal(block.mode, 'block');
    assert.equal(advisory.mode, 'advisory');
    assert.equal(odd.mode, 'advisory');
    assert.equal(block.reason, advisory.reason);
    assert.equal(block.outcome, 'refused');
  });

  test('owner, harness and runKey do not change the answer, and missing ones count as unknown', () => {
    const base = { active: [active('A.1', 'src/a.ts')] };
    const a = evaluateAdmission(candidate({ ...base, owner: null, harness: null, runKey: 'run-7' }), CAP1);
    const b = evaluateAdmission({ task: 'B.1', files: ['src/b.ts'], ...base }, CAP1);
    assert.deepEqual(a, b);
  });

  test('an input that makes the controller throw gives error / eval-fault, never a throw', () => {
    for (const bad of [null, undefined, {}, { task: '', files: [] }, { files: ['src/a.ts'] }]) {
      let got: any;
      assert.doesNotThrow(() => { got = evaluateAdmission(bad as any, CAP1); });
      assert.equal(got.outcome, 'error');
      assert.equal(got.reason, 'eval-fault');
      assert.equal(got.count, null);
      assert.equal(got.site, 'dispatch-admit');
      assert.equal(got.rule, 'admission');
    }
  });

  test('a task that is not a string is recorded with a null task', () => {
    assert.equal(evaluateAdmission({ task: 42, files: [] } as any, CAP1).task, null);
  });

  test('malformed files and active are read as empty', () => {
    const got = evaluateAdmission({ task: 'B.1', files: 'src/b.ts', active: 'x' } as any, CAP1);
    assert.equal(got.outcome, 'admitted');
  });
});

describe('IC-004: teamGate resolves mode and limits', () => {
  test('no settings files: advisory with the shipped limits', (t: any) => {
    const f = fixture(t);
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'advisory');
    assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
    assert.equal(typeof gate.evaluate, 'function');
    assert.equal(typeof gate.record, 'function');
  });

  test('a USER-layer file sets the limits and team.enforcement', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [E]: 'block', [W]: 2, [M]: 5 });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'block');
    assert.deepEqual(gate.limits, { writerCap: 2, maxAttempts: 5 });
  });

  test('the user-layer limits reach evaluate: cap 2 admits what the shipped cap 1 refuses', (t: any) => {
    const f = fixture(t);
    const input = candidate({ active: [active('A.1', 'src/a.ts')] });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).evaluate(input).reason, 'WRITER_CAP_EXCEEDED');
    f.writeUserSettings({ schema: 1, [W]: 2 });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).evaluate(input).outcome, 'admitted');
  });

  test('a user-layer maxAttempts is the bound evaluate replays against', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [M]: 5 });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.evaluate(candidate({ priorAttempts: 4 })).outcome, 'admitted');
    assert.equal(gate.evaluate(candidate({ priorAttempts: 5 })).reason, 'MAX_ATTEMPTS_EXCEEDED');
  });

  test('a PROJECT-layer file may choose block', (t: any) => {
    const f = fixture(t);
    f.writeProjectSettings({ schema: 1, [E]: 'block' });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).mode, 'block');
  });

  test('a project file choosing advisory does not loosen a user-layer block', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [E]: 'block' });
    f.writeProjectSettings({ schema: 1, [E]: 'advisory' });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).mode, 'block');
  });

  test('a project file choosing advisory alone stays advisory', (t: any) => {
    const f = fixture(t);
    f.writeProjectSettings({ schema: 1, [E]: 'advisory' });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).mode, 'advisory');
  });

  test('a value other than block (or an invalid one) gives advisory', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [E]: 'maybe' });
    assert.equal(teamGate({ projectRoot: f.project, env: f.env() }).mode, 'advisory');
  });

  test('an out-of-range or non-integer limit falls back to the shipped limit', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [W]: 99, [M]: 'many' });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
  });

  test('unreadable USER settings (malformed JSON): advisory and the shipped limits', (t: any) => {
    const f = fixture(t);
    fs.mkdirSync(f.configDir, { recursive: true });
    fs.writeFileSync(f.userFile('settings.json'), '{not json');
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'advisory');
    assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
  });

  test('unreadable PROJECT settings (malformed JSON): advisory and the shipped limits', (t: any) => {
    const f = fixture(t);
    fs.writeFileSync(f.projectFile('settings.json'), '{not json');
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'advisory');
    assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
  });

  test('a settings path that is a directory (read fails) gives advisory and the shipped limits', (t: any) => {
    const f = fixture(t);
    fs.mkdirSync(f.userFile('settings.json'), { recursive: true });
    fs.mkdirSync(f.projectFile('settings.json'), { recursive: true });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'advisory');
    assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
  });

  test('a project root that does not exist, is relative or is missing still builds a gate', (t: any) => {
    const f = fixture(t);
    for (const projectRoot of [path.join(f.dir, 'no-such-dir'), 'relative/dir', undefined, null]) {
      let gate: any;
      assert.doesNotThrow(() => { gate = teamGate({ projectRoot: projectRoot as any, env: f.env() }); });
      assert.equal(gate.mode, 'advisory');
      assert.deepEqual(gate.limits, { writerCap: 1, maxAttempts: 3 });
    }
    assert.doesNotThrow(() => teamGate({} as any));
  });

  test('the env override for the cap still applies (env beats files)', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [W]: 2 });
    const gate = teamGate({ projectRoot: f.project, env: f.env({ DOFLOW_TEAM_WRITER_CAP: '4' }) });
    assert.equal(gate.limits.writerCap, 4);
  });

  test('gate.evaluate carries the gate mode only when the caller passes it; the gate mode itself is a property', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [E]: 'block' });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.equal(gate.mode, 'block');
    assert.equal(gate.evaluate(candidate({ mode: gate.mode })).mode, 'block');
  });
});

describe('IC-003: the recorded line', () => {
  test('one line per verdict, holding only the IC-003 fields plus the common ones', (t: any) => {
    const f = fixture(t);
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    gate.record([
      gate.evaluate(candidate({ active: [active('A.1', 'src/a.ts')] })),
      gate.evaluate(candidate({ task: 'B.2', files: [] })),
    ]);
    const lines = f.lines();
    assert.equal(lines.length, 2);
    for (const line of lines) assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
    assert.equal(lines[0].kind, 'team.verdict');
    assert.deepEqual(
      { site: lines[0].site, rule: lines[0].rule, outcome: lines[0].outcome, reason: lines[0].reason, mode: lines[0].mode, task: lines[0].task, count: lines[0].count },
      { site: 'dispatch-admit', rule: 'admission', outcome: 'refused', reason: 'WRITER_CAP_EXCEEDED', mode: 'advisory', task: 'B.1', count: null },
    );
    assert.equal(lines[1].outcome, 'admitted');
    assert.equal(lines[1].reason, null);
  });

  test('a line carries no path, file name or message (NFR-003)', (t: any) => {
    const f = fixture(t);
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    const secret = '/Users/someone/private/payroll-2026.ts';
    // cap 2 so the overlap, not the cap, is what refuses
    gate.record([
      evaluateAdmission(candidate({ files: [secret, 'src/a.ts'], active: [active('A.1', secret, 'src/a.ts')], owner: ['/home/', 'owner/x'].join('') }), CAP2),
    ]);
    const text = f.rawText();
    assert.ok(text.length > 0);
    for (const forbidden of ['payroll', 'someone', 'private', 'src/a.ts', 'a.ts', '/home/owner', f.project, 'message']) {
      assert.ok(!text.includes(forbidden), `the line must not contain ${forbidden}`);
    }
    const [line] = f.lines();
    assert.equal(line.reason, 'WRITE_SET_CONFLICT');
    assert.equal(line.count, 2);
    for (const value of Object.values(line)) assert.ok(value === null || typeof value !== 'object', 'only scalar fields');
  });

  test('a review verdict line carries no precondition message or project path', (t: any) => {
    const f = fixture(t);
    observeStart({ slug: 'Task.9', cwd: f.project, env: f.env() });
    const [line] = f.lines();
    assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
    assert.equal(line.reason, 'ERR_MECHANICAL_CHECKS_FAILED');
    const text = f.rawText();
    for (const forbidden of ['readiness', 'Pre-check', 'evidence', f.project, 'pre-checks']) {
      assert.ok(!text.includes(forbidden), `the line must not contain ${forbidden}`);
    }
  });

  test('a task value outside the token pattern is written null, not echoed', (t: any) => {
    const f = fixture(t);
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    gate.record([{ ...evaluateAdmission(candidate(), CAP1), task: '../../etc/passwd contents' }]);
    const [line] = f.lines();
    assert.equal(line.task, null);
    assert.ok(!f.rawText().includes('passwd'));
  });

  test('a block-mode refusal is recorded with mode block', (t: any) => {
    const f = fixture(t);
    f.writeUserSettings({ schema: 1, [E]: 'block' });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    gate.record([gate.evaluate(candidate({ mode: gate.mode, active: [active('A.1', 'src/a.ts')] }))]);
    const [line] = f.lines();
    assert.equal(line.mode, 'block');
    assert.equal(line.outcome, 'refused');
  });

  test('record() hands the writer records of kind team.verdict that spread the verdict', () => {
    const cap = capture();
    const v = evaluateAdmission(candidate(), CAP1);
    record([v], { writer: cap.writer });
    assert.equal(cap.calls.length, 1);
    assert.deepEqual(cap.calls[0], [{ kind: 'team.verdict', ...v }]);
  });

  test('record() with nothing to write does not touch the writer', () => {
    const cap = capture();
    record([], { writer: cap.writer });
    record(null as any, { writer: cap.writer });
    record(undefined as any, { writer: cap.writer });
    assert.equal(cap.calls.length, 0);
  });
});

describe('FR-005: telemetry faults never change an outcome', () => {
  test('DOFLOW_TELEMETRY=off writes nothing (and a control without it writes)', (t: any) => {
    const f = fixture(t);
    const off = f.env({ DOFLOW_TELEMETRY: 'off' });
    const gate = teamGate({ projectRoot: f.project, env: off });
    gate.record([gate.evaluate(candidate())]);
    observeCheck({ record: { slug: 'Task.9', author: { agent: 'a' }, seats: [{ agent: 'b' }] }, cwd: f.project, env: off });
    observeStart({ slug: null, cwd: f.project, env: off });
    assert.equal(fs.existsSync(f.telemetryDir), false);
    assert.deepEqual(f.lines(), []);

    const on = teamGate({ projectRoot: f.project, env: f.env() });
    on.record([on.evaluate(candidate())]);
    assert.equal(f.lines().length, 1);
  });

  test('DOFLOW_TELEMETRY=off does not change the verdict', (t: any) => {
    const f = fixture(t);
    const input = candidate({ active: [active('A.1', 'src/a.ts')] });
    const off = teamGate({ projectRoot: f.project, env: f.env({ DOFLOW_TELEMETRY: 'off' }) }).evaluate(input);
    const on = teamGate({ projectRoot: f.project, env: f.env() }).evaluate(input);
    assert.deepEqual(off, on);
  });

  test('no run ledger directory: nothing is written, nothing is created, nothing throws', (t: any) => {
    const f = fixture(t);
    fs.rmSync(f.runs, { recursive: true, force: true });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.doesNotThrow(() => gate.record([gate.evaluate(candidate())]));
    assert.doesNotThrow(() => observeStart({ slug: null, cwd: f.project, env: f.env() }));
    assert.doesNotThrow(() => observeCheck({ record: null, cwd: f.project, env: f.env() }));
    assert.equal(fs.existsSync(f.runs), false);
  });

  test('the ledger path is a regular file: nothing throws and the file is untouched', (t: any) => {
    const f = fixture(t);
    fs.rmSync(f.runs, { recursive: true, force: true });
    fs.writeFileSync(f.runs, 'not a directory\n');
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.doesNotThrow(() => gate.record([gate.evaluate(candidate())]));
    assert.doesNotThrow(() => observeCheck({ record: null, cwd: f.project, env: f.env() }));
    assert.equal(fs.readFileSync(f.runs, 'utf8'), 'not a directory\n');
  });

  test('a telemetry path that is a directory where the day file belongs: nothing throws', (t: any) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.telemetryDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), { recursive: true });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.doesNotThrow(() => gate.record([gate.evaluate(candidate())]));
  });

  test('a read-only ledger directory: nothing throws and nothing is written', { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) }, (t: any) => {
    const f = fixture(t);
    fs.chmodSync(f.runs, 0o500); // the tempDir cleanup restores owner write permission before it removes the tree
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    assert.doesNotThrow(() => gate.record([gate.evaluate(candidate())]));
    assert.doesNotThrow(() => observeCheck({ record: { slug: 'Task.9', author: { agent: 'a' }, seats: [{ agent: 'b' }] }, cwd: f.project, env: f.env() }));
    assert.equal(fs.existsSync(f.telemetryDir), false);
  });

  test('a writer that throws never makes record, observeStart or observeCheck throw', () => {
    const boom = { write() { throw new Error('disk on fire'); } };
    const seen: string[] = [];
    const throwing = { write(records: any[]) { seen.push(records[0].kind); throw new Error('disk on fire'); } };
    assert.doesNotThrow(() => record([evaluateAdmission(candidate(), CAP1)], { writer: boom }));
    assert.doesNotThrow(() => observeStart({ slug: null, cwd: process.cwd(), writer: throwing }));
    assert.doesNotThrow(() => observeCheck({ record: null, cwd: process.cwd(), writer: throwing }));
    assert.doesNotThrow(() => observeCheck({ record: { slug: 'Task.9', author: { agent: 'a' }, seats: [{ agent: 'b' }] }, cwd: process.cwd(), writer: throwing }));
    assert.deepEqual(seen, ['team.verdict', 'team.verdict', 'team.verdict']);
  });

  test('a writer whose write is not a function does not make record throw', () => {
    assert.doesNotThrow(() => record([evaluateAdmission(candidate(), CAP1)], { writer: {} as any }));
  });

  test('a throwing gate.record leaves gate.evaluate usable (the verdict is computed before any write)', (t: any) => {
    const f = fixture(t);
    fs.rmSync(f.runs, { recursive: true, force: true });
    const gate = teamGate({ projectRoot: f.project, env: f.env() });
    const v = gate.evaluate(candidate());
    assert.doesNotThrow(() => gate.record([v]));
    assert.equal(gate.evaluate(candidate()).outcome, 'admitted');
  });
});

describe('IC-002: observeStart verdicts', () => {
  const TASK = 'Task.7';

  test('no feature (null, empty or non-string slug): not-evaluable / no-feature, task null', () => {
    for (const slug of [null, '', undefined, 42]) {
      const cap = capture();
      observeStart({ slug: slug as any, cwd: process.cwd(), writer: cap.writer });
      assert.deepEqual(
        { ...cap.last(), kind: undefined },
        { kind: undefined, site: 'review-start', rule: 'pre-check', outcome: 'not-evaluable', reason: 'no-feature', mode: 'advisory', task: null, count: null },
      );
      assert.equal(cap.last().kind, 'team.verdict');
    }
  });

  test('a feature with no readiness or pre-check evidence: refused / ERR_MECHANICAL_CHECKS_FAILED with the failure count', (t: any) => {
    const f = fixture(t);
    const cap = capture();
    observeStart({ slug: TASK, cwd: f.project, env: f.env(), writer: cap.writer });
    const got = cap.last();
    assert.equal(got.site, 'review-start');
    assert.equal(got.rule, 'pre-check');
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'ERR_MECHANICAL_CHECKS_FAILED');
    assert.equal(got.mode, 'advisory');
    assert.equal(got.task, TASK);
    assert.equal(got.count, 2, 'readiness evidence and pre-check evidence are both missing');
  });

  test('a READY record and passing pre-check evidence: admitted', (t: any) => {
    const f = fixture(t);
    writeReadinessRecord({
      stateRoot: f.project, taskId: TASK, mode: 'workflow', inputs: {},
      report: { taskClass: 'feature', templateName: 'feature', requirements: [], state: 'READY' },
    });
    const dir = path.join(f.project, '.doflow', 'state', 'team', 'pre-checks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TASK}.json`), JSON.stringify({ passed: true, failures: [] }));
    const cap = capture();
    observeStart({ slug: TASK, cwd: f.project, env: f.env(), writer: cap.writer });
    const got = cap.last();
    assert.equal(got.outcome, 'admitted');
    assert.equal(got.reason, null);
    assert.equal(got.task, TASK);
    assert.equal(got.count, null);
  });

  test('a fault that is not a pre-check refusal is error / eval-fault', () => {
    const cap = capture();
    observeStart({ slug: TASK, cwd: 42 as any, writer: cap.writer });
    const got = cap.last();
    assert.equal(got.outcome, 'error');
    assert.equal(got.reason, 'eval-fault');
    assert.equal(got.task, TASK);
  });

  test('observeStart records exactly one verdict per call and returns nothing', (t: any) => {
    const f = fixture(t);
    const cap = capture();
    const returned = observeStart({ slug: TASK, cwd: f.project, env: f.env(), writer: cap.writer });
    assert.equal(returned, undefined);
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].length, 1);
  });
});

describe('IC-002: observeCheck verdicts', () => {
  const author = (extra: any = {}) => ({ agent: 'core-implementer', session: 'sess-author', ...extra });
  const seat = (agent: string, session?: string) => ({ agent, ...(session === undefined ? {} : { session }) });
  const reviewRecord = (extra: any = {}) => ({ slug: 'feat-x', valid: true, author: author(), seats: [seat('quality-guardian', 'sess-q')], ...extra });

  function check(rec: any) {
    const cap = capture();
    observeCheck({ record: rec, cwd: process.cwd(), writer: cap.writer });
    assert.equal(cap.calls.length, 1, 'one verdict per call');
    assert.equal(cap.calls[0].length, 1);
    assert.equal(cap.last().kind, 'team.verdict');
    const { kind, ...verdict } = cap.last();
    assert.deepEqual(Object.keys(verdict).sort(), VERDICT_KEYS);
    assert.equal(verdict.site, 'review-check');
    assert.equal(verdict.rule, 'separation');
    assert.equal(verdict.mode, 'advisory');
    return verdict;
  }

  test('no record (null, undefined, array, non-object): not-evaluable / no-record, task null', () => {
    for (const rec of [null, undefined, [], 'text', 7]) {
      const got = check(rec);
      assert.equal(got.outcome, 'not-evaluable');
      assert.equal(got.reason, 'no-record');
      assert.equal(got.task, null);
      assert.equal(got.count, null);
    }
  });

  test('no author object with a string agent: not-evaluable / no-author, task is the slug', () => {
    for (const rec of [
      reviewRecord({ author: undefined }), reviewRecord({ author: null }),
      reviewRecord({ author: {} }), reviewRecord({ author: { agent: 5 } }), reviewRecord({ author: 'core-implementer' }),
    ]) {
      const got = check(rec);
      assert.equal(got.outcome, 'not-evaluable');
      assert.equal(got.reason, 'no-author');
      assert.equal(got.task, 'feat-x');
      assert.equal(got.count, null);
    }
  });

  test('no seat with a string agent: not-evaluable / no-seat-agent', () => {
    for (const rec of [
      reviewRecord({ seats: undefined }), reviewRecord({ seats: [] }), reviewRecord({ seats: 'x' }),
      reviewRecord({ seats: [{}, { agent: 3 }, null] }),
    ]) {
      const got = check(rec);
      assert.equal(got.outcome, 'not-evaluable');
      assert.equal(got.reason, 'no-seat-agent');
      assert.equal(got.task, 'feat-x');
    }
  });

  test('a seat with the author\'s own role: refused / ERR_REVIEWER_SELF_REVIEW, count is the seats evaluated', () => {
    const got = check(reviewRecord({ seats: [seat('core-implementer', 'sess-other'), seat('quality-guardian', 'sess-q')] }));
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'ERR_REVIEWER_SELF_REVIEW');
    assert.equal(got.task, 'feat-x');
    assert.equal(got.count, 2);
  });

  test('a seat sharing the author\'s session under a different role: refused', () => {
    const got = check(reviewRecord({ seats: [seat('quality-guardian', 'sess-author')] }));
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'ERR_REVIEWER_SELF_REVIEW');
    assert.equal(got.count, 1);
  });

  test('a record the existing check marked invalid is still evaluated', () => {
    const got = check(reviewRecord({ valid: false, seats: [seat('core-implementer')] }));
    assert.equal(got.outcome, 'refused');
    assert.equal(got.reason, 'ERR_REVIEWER_SELF_REVIEW');
  });

  test('valid:false passed to observeCheck gives a null task but is still evaluated; valid:true or omitted keeps the slug', () => {
    const run = (valid?: boolean) => {
      const cap = capture();
      observeCheck({ record: reviewRecord({ seats: [seat('core-implementer')] }), valid, cwd: process.cwd(), writer: cap.writer });
      return cap.last();
    };
    const invalid = run(false);
    assert.equal(invalid.task, null);
    assert.equal(invalid.outcome, 'refused');
    assert.equal(invalid.reason, 'ERR_REVIEWER_SELF_REVIEW');
    assert.equal(invalid.count, 1);
    assert.equal(run(true).task, 'feat-x');
    assert.equal(run(undefined).task, 'feat-x');
  });

  test('distinct roles and sessions: admitted, count is the seats evaluated, reason null', () => {
    const got = check(reviewRecord({ seats: [seat('quality-guardian', 'sess-q'), seat('system-architect', 'sess-s')] }));
    assert.equal(got.outcome, 'admitted');
    assert.equal(got.reason, null);
    assert.equal(got.task, 'feat-x');
    assert.equal(got.count, 2);
  });

  test('distinct roles with no session recorded: admitted', () => {
    const got = check({ slug: 'feat-x', author: { agent: 'core-implementer' }, seats: [{ agent: 'quality-guardian' }] });
    assert.equal(got.outcome, 'admitted');
  });

  test('seats without a string agent are not counted among the seats evaluated', () => {
    const got = check(reviewRecord({ seats: [seat('quality-guardian', 'sess-q'), { session: 'x' }, null] }));
    assert.equal(got.outcome, 'admitted');
    assert.equal(got.count, 1);
  });

  test('a record without a string slug is evaluated with a null task', () => {
    const got = check({ author: author(), seats: [seat('quality-guardian', 'sess-q')] });
    assert.equal(got.outcome, 'admitted');
    assert.equal(got.task, null);
  });

  test('a hostile record (getter that throws) is error / eval-fault, never a throw', () => {
    const hostile = { slug: 'feat-x', get author(): any { throw new Error('boom'); }, seats: [] };
    const got = check(hostile);
    assert.equal(got.outcome, 'error');
    assert.equal(got.reason, 'eval-fault');
    assert.equal(got.task, null);
  });

  test('observeCheck writes a real line through the default writer, with only the IC-003 fields', (t: any) => {
    const f = fixture(t);
    observeCheck({ record: reviewRecord({ seats: [seat('core-implementer')] }), cwd: f.project, env: f.env() });
    const lines = f.lines();
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), LINE_KEYS);
    assert.equal(lines[0].reason, 'ERR_REVIEWER_SELF_REVIEW');
    assert.equal(lines[0].count, 1);
    assert.ok(!f.rawText().includes('core-implementer'), 'a role name is not part of the line');
    assert.ok(!f.rawText().includes('sess-author'), 'a session id is not part of the line');
  });
});
