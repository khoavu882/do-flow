'use strict';

// 150 A.3 (IC-002, IC-003, IC-004, IC-022; FR-002, FR-004, FR-009, FR-011, FR-013, FR-014, FR-018,
// NFR-007): the read-only worker verbs `worker-log`, `worker-result` and `worker-runs`, called
// in-process over temp stores. Records are built with insertRun and transition; output files are
// written where the sink writes them. Every case checks exact body key sets, exit codes, and that
// planted values never reach a body; the last case compares the whole tree before and after.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');
const { storeFileFor, insertRun, transition, readRuns } = require('../../src/runtime/worker/run-store.ts');
const { resultOfRun } = require('../../src/runtime/worker/supervisor.ts');
const {
  handleWorkerLogCommand, handleWorkerResultCommand, handleWorkerRunsCommand,
  workerLogBody, workerResultBody, workerRunsBody, WORKER_RUNS_LIMIT,
} = require('../../src/runtime/worker/reads.ts');

const SLUG = '150-reads-fixture';
const NOW = 1762581600000;
const LOG_KEYS = ['v', 'runId', 'stream', 'phase', 'log', 'ino', 'size', 'from', 'to', 'pieces', 'eof', 'reset', 'capped', 'cursor', 'before'];
const RESULT_KEYS = ['v', 'runId', 'task', 'token', 'harness', 'phase', 'endState', 'endedAt', 'reportStatus', 'readOnly', 'isolation', 'resultOffered', 'withheld', 'quota'];
const RUNS_KEYS = ['v', 'slug', 'store', 'runs', 'limits'];
const RUN_SUMMARY_KEYS = ['runId', 'task', 'token', 'harness', 'childOf', 'phase', 'endState', 'createdAt', 'startedAt', 'endedAt', 'edit'];
const ERROR_KEYS = ['v', 'ok', 'error'];

const idOf = (n: number) => `w-${n.toString(16).padStart(12, '0')}`;

/** A fresh project root (no git: the lifecycle root is the directory itself). */
function project(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-worker-reads-'));
  const state = path.join(root, '.doflow', 'state');
  return { root, state, store: storeFileFor(root, SLUG), output: path.join(state, 'worker-output') };
}

const INSERT_FIELDS = ['createdAt', 'harness', 'childOf', 'request', 'edit'];

/** Inserts a run as `starting`, then writes every other field (and the phase) by one transition. */
function addRun(p: any, fields: any, store = p.store) {
  const { runId, task = 'A.1', token = 1 } = fields;
  const inserted: any = { runId, task, token, phase: 'starting' };
  for (const key of INSERT_FIELDS) if (key in fields) inserted[key] = fields[key];
  assert.equal(insertRun(store, inserted).applied, true);
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => ![...INSERT_FIELDS, 'runId', 'task', 'token'].includes(key)));
  if (Object.keys(rest).length) assert.equal(transition(store, runId, ['starting'], (r: any) => { Object.assign(r, rest); }).applied, true);
  return readRuns(store)[runId];
}

function writeLog(p: any, runId: string, stream: string, content: string | Buffer) {
  fs.mkdirSync(p.output, { recursive: true });
  const file = path.join(p.output, `${runId}.${stream}.log`);
  fs.writeFileSync(file, content);
  return file;
}

const inoOf = (file: string) => String(fs.statSync(file, { bigint: true }).ino);

/** Runs a handler with captured writers; restores `process.exitCode`. */
function call(handler: any, options: any) {
  const out = { text: '', write(s: string) { this.text += s; } };
  const err = { text: '', write(s: string) { this.text += s; } };
  const saved = process.exitCode;
  let exit: number;
  try {
    exit = handler({ now: () => NOW, ...options, stdout: out, stderr: err });
  } finally {
    process.exitCode = saved;
  }
  return { exit, out: out.text, err: err.text };
}

/** A `--json` call: exactly one compact JSON line on stdout. */
function callJson(handler: any, options: any) {
  const r = call(handler, { json: true, ...options });
  assert.equal(r.out.endsWith('\n'), true, 'stdout ends with a line end');
  assert.equal(r.out.indexOf('\n'), r.out.length - 1, 'stdout is one line');
  assert.equal(r.out, `${JSON.stringify(JSON.parse(r.out))}\n`, 'the line is compact JSON');
  return { ...r, json: JSON.parse(r.out) };
}

const logCall = (p: any, options: any) => callJson(handleWorkerLogCommand, { cwd: p.root, ...options });
const resultCall = (p: any, options: any) => callJson(handleWorkerResultCommand, { cwd: p.root, ...options });
const runsCall = (p: any, options: any) => callJson(handleWorkerRunsCommand, { cwd: p.root, resolveSlug: () => null, ...options });

function assertError(r: any, exit: number, error: string) {
  assert.equal(r.exit, exit, `exit ${exit} for ${error}`);
  assert.deepEqual(Object.keys(r.json), ERROR_KEYS);
  assert.deepEqual(r.json, { v: 1, ok: false, error });
  assert.match(r.err, /^doflow worker-(log|result|runs): .+\n$/);
}

// ── Planted record ───────────────────────────────────────────────────────────────────────────────

/** A run that ended clean: every IC-003 "never" field holds a PLANTED marker or a marker number. */
function endedRecord(runId: string, token: number, extra: any = {}) {
  return {
    runId, task: 'A.1', token, harness: 'codex',
    createdAt: '2026-11-08T05:00:00.000Z', startedAt: '2026-11-08T05:00:01.000Z',
    prompt: { path: '/home/test/PLANTED-prompt.md', sha256: 'PLANTED-sha', bytes: 11 },
    identity: { run: 'PLANTED-identity-run', lineage: 'PLANTED-identity-lineage' },
    caller: { cwd: '/home/test/PLANTED-caller', runKey: 'PLANTED-runkey' },
    execWorktree: '/home/test/PLANTED-exec-worktree',
    descriptor: { id: 'PLANTED-descriptor' },
    recipe: { argv: ['PLANTED-argv'] },
    binding: { id: 'PLANTED-binding' },
    supervisor: { pid: 424242, start: 'PLANTED-supervisor-start' },
    worker: { pid: 434343, start: 'PLANTED-worker-start' },
    cleanup: { status: 'PLANTED-cleanup' },
    deadline: '2026-11-08T09:09:09.999Z',
    process: { kind: 'exited', pid: 454545, pgid: 454545, code: 0, signal: null, leftover: { status: 'none', survivors: [454546] } },
    readOnly: { status: 'clean', changes: ['PLANTED-change'], head: { before: 'PLANTED-head', after: 'PLANTED-head' }, refsChanged: ['PLANTED-ref'] },
    report: {
      status: 'success', summary: 'PLANTED-summary sk-ant-api03-PLANTEDPLANTEDPLANTEDPLANTED', reason: 'PLANTED-reason',
      denials: ['PLANTED-denial'], deniedCount: 7, usage: { input: 98765, output: 87654 }, ignoredLines: 31337,
    },
    output: {
      stdout: { path: 'worker-output/PLANTED.out.log', bytes: 1, written: 1, truncated: false },
      stderr: { path: 'worker-output/PLANTED.err.log', bytes: 1, written: 1, truncated: false },
      lastMessage: { path: `worker-output/${runId}.last.log`, bytes: 9 },
    },
    phase: 'ended',
    end: { state: 'exited', at: '2026-11-08T05:03:00.000Z' },
    ...extra,
  };
}

/** No planted marker, pid or marker number in the text. */
function assertNothingPlanted(text: string) {
  for (const marker of ['PLANTED', '424242', '434343', '454545', '454546', '98765', '87654', '31337', '09:09:09', '/home/test', 'sk-ant']) {
    assert.equal(text.includes(marker), false, `'${marker}' is not in ${text.slice(0, 200)}`);
  }
}

// ── worker-result ────────────────────────────────────────────────────────────────────────────────

const EDIT = { callerTop: '/home/test/PLANTED-top', base: 'PLANTED-base', branch: 'PLANTED-branch' };
const ISOLATION = (status: string, reason: string | null) => ({
  status, reason, changes: ['PLANTED-iso-change'], callerHead: { before: 'PLANTED-ch', after: 'PLANTED-ch' },
  attemptHead: { before: 'PLANTED-ah', after: 'PLANTED-ah' }, refsChanged: ['PLANTED-iso-ref'],
});

const RESULT_CASES: Array<{ name: string; extra: any; withheld: string[] }> = [
  { name: 'offered read-only run', extra: {}, withheld: [] },
  { name: 'not-exited', extra: { end: { state: 'timed-out', at: '2026-11-08T05:03:00.000Z' } }, withheld: ['not-exited'] },
  { name: 'read-only-violation', extra: { readOnly: { status: 'violated', changes: ['PLANTED-c'] } }, withheld: ['read-only-violation'] },
  { name: 'read-only-unverifiable', extra: { readOnly: { status: 'unverifiable', changes: [] } }, withheld: ['read-only-unverifiable'] },
  { name: 'offered edit run', extra: { edit: EDIT, isolation: ISOLATION('clean', null), readOnly: { status: 'violated' } }, withheld: [] },
  { name: 'outside-write', extra: { edit: EDIT, isolation: ISOLATION('violated', 'outside-write') }, withheld: ['outside-write'] },
  { name: 'branch-moved', extra: { edit: EDIT, isolation: ISOLATION('violated', 'branch-moved') }, withheld: ['branch-moved'] },
  { name: 'isolation-unverifiable', extra: { edit: EDIT, isolation: ISOLATION('unverifiable', 'isolation-unverifiable') }, withheld: ['isolation-unverifiable'] },
  { name: 'report-denied', extra: { report: { status: 'denied', summary: 'PLANTED-s', denials: ['PLANTED-d'] } }, withheld: ['report-denied'] },
  { name: 'report-failure', extra: { report: { status: 'failure', summary: 'PLANTED-s' } }, withheld: ['report-failure'] },
  { name: 'report-quota', extra: { report: { status: 'failure', summary: 'PLANTED rate limit', quota: { signal: 'rate limit', basis: 'documented' } } }, withheld: ['report-quota'] },
  { name: 'report-unparsed', extra: { report: { status: 'unparsed', summary: 'PLANTED-s' } }, withheld: ['report-unparsed'] },
  { name: 'group-survived', extra: { process: { kind: 'exited', pid: 454545, leftover: { status: 'survivors', survivors: [454546] } } }, withheld: ['group-survived'] },
];

test('worker-result: exact keys, every withheld code, quota, edit and read-only runs, no planted field', (t: any) => {
  const p = project(t);
  RESULT_CASES.forEach((c, i) => addRun(p, endedRecord(idOf(i + 1), i + 1, { ...c.extra, childOf: idOf(0xfff) })));
  const records = readRuns(p.store);
  RESULT_CASES.forEach((c, i) => {
    const runId = idOf(i + 1);
    const r = resultCall(p, { workerRun: runId, slug: SLUG });
    assert.equal(r.exit, 0, c.name);
    assert.equal(r.err, '');
    assert.deepEqual(Object.keys(r.json), RESULT_KEYS, c.name);
    const isEdit = 'edit' in c.extra;
    const expected = resultOfRun(records[runId]);
    assert.deepEqual(r.json, {
      v: 1, runId, task: 'A.1', token: i + 1, harness: 'codex', phase: 'ended',
      endState: c.extra.end ? 'timed-out' : 'exited', endedAt: '2026-11-08T05:03:00.000Z',
      reportStatus: (c.extra.report ?? { status: 'success' }).status,
      readOnly: isEdit ? null : (c.extra.readOnly ?? { status: 'clean' }).status,
      isolation: isEdit ? { status: c.extra.isolation.status, reason: c.extra.isolation.reason } : null,
      resultOffered: c.withheld.length === 0, withheld: c.withheld,
      quota: c.extra.report?.quota ? { signal: 'rate limit', basis: 'documented' } : null,
    }, c.name);
    assert.deepEqual({ resultOffered: r.json.resultOffered, withheld: r.json.withheld }, expected, `${c.name}: resultOfRun verbatim`);
    assertNothingPlanted(r.out);
    assert.equal(r.out.includes(idOf(0xfff)), false, 'childOf is not in the result body');
  });
  // Without --slug the store that holds the run answers, and the text form prints the same line.
  const plain = call(handleWorkerResultCommand, { cwd: p.root, workerRun: idOf(1) });
  assert.equal(plain.exit, 0);
  assert.equal(plain.out, `${JSON.stringify(resultCall(p, { workerRun: idOf(1) }).json)}\n`);
});

test('worker-result: a running run has null end fields; strings are masked', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), harness: 'ops@example.com', createdAt: '2026-11-08T05:00:00.000Z', phase: 'running', startedAt: '2026-11-08T05:00:01.000Z', process: { kind: 'running', pid: 454545 } });
  const r = resultCall(p, { workerRun: idOf(1) });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.json, {
    v: 1, runId: idOf(1), task: 'A.1', token: 1, harness: '<email>', phase: 'running',
    endState: null, endedAt: null, reportStatus: null, readOnly: null, isolation: null,
    resultOffered: false, withheld: ['not-exited', 'read-only-unverifiable', 'report-unparsed'], quota: null,
  });
  assert.equal(r.out.includes('454545'), false);
  // An edit run before its check: isolation and readOnly are both null.
  addRun(p, { runId: idOf(2), token: 2, edit: EDIT, phase: 'running' });
  const e = resultCall(p, { workerRun: idOf(2) });
  assert.equal(e.json.isolation, null);
  assert.equal(e.json.readOnly, null);
  assert.deepEqual(e.json.withheld, ['not-exited', 'isolation-unverifiable', 'report-unparsed']);
});

// ── worker-log ───────────────────────────────────────────────────────────────────────────────────

test('worker-log: tail of a running run, then a forward cursor round trip; partial lines wait', (t: any) => {
  const p = project(t);
  const runId = idOf(1);
  addRun(p, { runId, phase: 'running' });
  const file = writeLog(p, runId, 'out', 'alpha 10.1.2.3\nbeta\npart');
  const ino = inoOf(file);
  const r = logCall(p, { workerRun: runId, stream: 'out' });
  assert.equal(r.exit, 0);
  assert.deepEqual(Object.keys(r.json), LOG_KEYS);
  assert.deepEqual(r.json, {
    v: 1, runId, stream: 'out', phase: 'running', log: 'open', ino, size: 24, from: 0, to: 20,
    pieces: [{ at: 0, text: 'alpha <ip>' }, { at: 15, text: 'beta' }], eof: true, reset: false,
    capped: null, cursor: `${ino}:20:0:${NOW}`, before: null,
  });
  fs.appendFileSync(file, 'ial\ngamma\n');
  const next = logCall(p, { workerRun: runId, stream: 'out', cursor: r.json.cursor, slug: SLUG });
  assert.equal(next.exit, 0);
  assert.equal(next.json.from, 20);
  assert.equal(next.json.to, 34);
  assert.deepEqual(next.json.pieces, [{ at: 20, text: 'partial' }, { at: 28, text: 'gamma' }]);
  assert.equal(next.json.reset, false);
  assert.equal(next.json.cursor, `${ino}:34:0:${NOW}`);
  assert.equal(next.json.before, `${ino}:20:0:${NOW}`);
  // A cursor on another inode is a fresh tail with reset.
  const reset = logCall(p, { workerRun: runId, stream: 'out', cursor: `${ino === '1' ? '2' : '1'}:20:0:0` });
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.from, 0);
  assert.equal(reset.json.to, 34);
});

test('worker-log: an ended run pages back with --before; the final read shows the last partial line', (t: any) => {
  const p = project(t);
  const runId = idOf(1);
  const line = (n: number) => `line ${String(n).padStart(5, '0')} ${'x'.repeat(88)}`; // 99 bytes + '\n'
  const lines = Array.from({ length: 2000 }, (_, n) => line(n));
  addRun(p, endedRecord(runId, 1, { output: { stdout: { path: 'worker-output/PLANTED.out.log', truncated: false } } }));
  const file = writeLog(p, runId, 'out', `${lines.join('\n')}\ntail-without-newline`);
  writeLog(p, 'PLANTED', 'out', 'PLANTED-path-content\n');
  const ino = inoOf(file);
  const size = fs.statSync(file).size;
  const tail = logCall(p, { workerRun: runId, stream: 'out' });
  assert.equal(tail.exit, 0);
  assert.equal(tail.json.to, size, 'final: the readable end is the size');
  assert.equal(tail.json.pieces.at(-1).text, 'tail-without-newline');
  assert.equal(tail.json.capped, false);
  assert.ok(tail.json.from > 0 && tail.json.from % 100 === 0);
  assert.equal(tail.json.before, `${ino}:${tail.json.from}:0:${NOW}`);
  const back = logCall(p, { workerRun: runId, stream: 'out', before: tail.json.before });
  assert.equal(back.exit, 0);
  assert.equal(back.json.to, tail.json.from);
  assert.equal(back.json.from, 0);
  assert.equal(back.json.before, null);
  const joined = [...back.json.pieces, ...tail.json.pieces].map((piece: any) => (piece.cut ? piece.text : `${piece.text}\n`)).join('');
  assert.equal(joined, `${fs.readFileSync(file, 'utf8')}\n`, 'the two pages join with no gap or overlap');
  assert.ok(tail.json.pieces.some((piece: any) => piece.cut), 'grid cuts inside lines are kept as cut pieces');
  assertNothingPlanted(tail.out + back.out);
});

test('worker-log: final needs the stream pointer; err reads output.stderr', (t: any) => {
  const p = project(t);
  addRun(p, endedRecord(idOf(1), 1, { output: { stdout: { path: 'x', truncated: true } } }));
  writeLog(p, idOf(1), 'out', 'a\nb');
  writeLog(p, idOf(1), 'err', 'e\npartial');
  const out = logCall(p, { workerRun: idOf(1), stream: 'out' });
  assert.deepEqual(out.json.pieces.map((x: any) => x.text), ['a', 'b']);
  assert.equal(out.json.capped, true, 'capped from output.stdout.truncated');
  const err = logCall(p, { workerRun: idOf(1), stream: 'err' });
  assert.deepEqual(err.json.pieces.map((x: any) => x.text), ['e'], 'no stderr pointer: the partial line waits');
  assert.equal(err.json.capped, null);
  assert.equal(err.json.log, 'open');
  addRun(p, { runId: idOf(2), token: 2, phase: 'running', output: { stdout: { path: 'x', truncated: true } } });
  writeLog(p, idOf(2), 'out', 'a\nb');
  const running = logCall(p, { workerRun: idOf(2), stream: 'out' });
  assert.deepEqual(running.json.pieces.map((x: any) => x.text), ['a']);
  assert.equal(running.json.capped, null, 'capped is null until the run ends');
});

test('worker-log: waiting, gone, none and capped', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  addRun(p, endedRecord(idOf(2), 2, { output: { stdout: { path: 'x', truncated: true }, stderr: { path: 'y', truncated: false } } }));
  addRun(p, { runId: idOf(3), token: 3, phase: 'ended', end: { state: 'cancelled', at: '2026-11-08T05:03:00.000Z' }, process: { kind: 'not-started' } });
  addRun(p, endedRecord(idOf(4), 4, { output: { stdout: { path: 'x', truncated: true }, stderr: { path: 'y', truncated: false } } }));
  writeLog(p, idOf(4), 'out', 'kept\n');
  writeLog(p, idOf(4), 'err', 'kept\n');
  const empty = { ino: null, size: 0, from: 0, to: 0, pieces: [], eof: true, reset: false, cursor: null, before: null };
  const cases: Array<[string, string, string, any]> = [
    [idOf(1), 'out', 'waiting', null],
    [idOf(2), 'out', 'gone', true],
    [idOf(2), 'err', 'gone', false],
    [idOf(3), 'out', 'none', null],
    [idOf(3), 'err', 'none', null],
  ];
  for (const [runId, stream, log, capped] of cases) {
    const r = logCall(p, { workerRun: runId, stream });
    assert.equal(r.exit, 0);
    assert.deepEqual(Object.keys(r.json), LOG_KEYS);
    assert.deepEqual({ log: r.json.log, capped: r.json.capped, ...Object.fromEntries(Object.keys(empty).map((k) => [k, r.json[k]])) }, { log, capped, ...empty }, `${runId} ${stream}`);
  }
  assert.equal(logCall(p, { workerRun: idOf(4), stream: 'out' }).json.capped, true);
  assert.equal(logCall(p, { workerRun: idOf(4), stream: 'err' }).json.capped, false);
});

test('worker-log: the text form prints piece lines, a cut piece with no line end, and the summary on stderr', (t: any) => {
  const p = project(t);
  const runId = idOf(1);
  addRun(p, { runId, phase: 'running' });
  const content = `${'x'.repeat(40000)}\ny\n`;
  writeLog(p, runId, 'out', content);
  const json = logCall(p, { workerRun: runId, stream: 'out' }).json;
  assert.deepEqual(json.pieces.map((x: any) => [x.at, x.text.length, x.cut === true]), [[0, 32768, true], [32768, 7232, false], [40001, 1, false]]);
  const r = call(handleWorkerLogCommand, { cwd: p.root, workerRun: runId, stream: 'out' });
  assert.equal(r.exit, 0);
  assert.equal(r.out, content);
  assert.equal(r.err, `${runId} out open bytes 0 to 40003 of 40003\n`);
});

test('worker-log: .last.log and the record paths are never read', (t: any) => {
  const p = project(t);
  const runId = idOf(1);
  addRun(p, endedRecord(runId, 1));
  writeLog(p, runId, 'last', 'PLANTED-last-message\n');
  writeLog(p, 'PLANTED', 'out', 'PLANTED-path-content\n');
  writeLog(p, 'PLANTED', 'err', 'PLANTED-path-content\n');
  for (const stream of ['out', 'err']) {
    const r = logCall(p, { workerRun: runId, stream });
    assert.equal(r.json.log, 'gone', 'the pointer exists, the run file does not');
    assertNothingPlanted(r.out + r.err);
  }
  const last = logCall(p, { workerRun: runId, stream: 'last' });
  assertError(last, 2, 'usage');
  assertNothingPlanted(last.out + last.err);
});

test('worker-log: a read error is log-unreadable (exit 1)', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  writeLog(p, idOf(1), 'out', 'a\n');
  const fsImpl = Object.create(fs);
  fsImpl.openSync = () => { const e: any = new Error('denied'); e.code = 'EACCES'; throw e; };
  assertError(logCall(p, { workerRun: idOf(1), stream: 'out', fsImpl }), 1, 'log-unreadable');
  assert.deepEqual(workerLogBody({ cwd: p.root, workerRun: idOf(1), stream: 'out', fsImpl }), { exit: 1, json: { v: 1, ok: false, error: 'log-unreadable' } });
});

// ── worker-runs ──────────────────────────────────────────────────────────────────────────────────

test('worker-runs: 101 runs give the newest 100 ascending and notShown 1', (t: any) => {
  const p = project(t);
  const base = Date.parse('2026-11-08T05:00:00.000Z');
  // Run 0 has no createdAt and sorts as oldest; runs 1 and 2 tie and sort by run id.
  addRun(p, { runId: idOf(0), token: 1 });
  for (let n = 1; n <= 100; n++) {
    const at = new Date(base + (n === 2 ? 1 : n) * 1000).toISOString();
    addRun(p, { runId: idOf(n), token: n + 1, createdAt: at, harness: 'codex' });
  }
  const r = runsCall(p, { slug: SLUG });
  assert.equal(r.exit, 0);
  assert.deepEqual(Object.keys(r.json), RUNS_KEYS);
  assert.equal(WORKER_RUNS_LIMIT, 100);
  assert.deepEqual(r.json.limits, { shown: 100, notShown: 1 });
  assert.equal(r.json.runs.length, 100);
  assert.deepEqual(r.json.runs.map((x: any) => x.runId), Array.from({ length: 100 }, (_, i) => idOf(i + 1)));
  for (const run of r.json.runs) assert.deepEqual(Object.keys(run), RUN_SUMMARY_KEYS);
});

test('worker-runs: ended, running, edit and child runs, field by field', (t: any) => {
  const p = project(t);
  addRun(p, endedRecord(idOf(1), 1, { harness: 'ops@example.com' }));
  addRun(p, { runId: idOf(2), token: 2, createdAt: '2026-11-08T05:01:00.000Z', harness: 'claude', edit: EDIT, phase: 'running', startedAt: '2026-11-08T05:01:01.000Z' });
  addRun(p, { runId: idOf(3), token: 2, createdAt: '2026-11-08T05:02:00.000Z', harness: 'claude', childOf: idOf(2), request: 'd-0123456789ab.c1', phase: 'starting', end: { state: 'exited', at: 'PLANTED' } });
  const r = runsCall(p, { resolveSlug: () => SLUG });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.json, {
    v: 1, slug: SLUG, store: 'present',
    runs: [
      { runId: idOf(1), task: 'A.1', token: 1, harness: '<email>', childOf: null, phase: 'ended', endState: 'exited', createdAt: '2026-11-08T05:00:00.000Z', startedAt: '2026-11-08T05:00:01.000Z', endedAt: '2026-11-08T05:03:00.000Z', edit: false },
      { runId: idOf(2), task: 'A.1', token: 2, harness: 'claude', childOf: null, phase: 'running', endState: null, createdAt: '2026-11-08T05:01:00.000Z', startedAt: '2026-11-08T05:01:01.000Z', endedAt: null, edit: true },
      { runId: idOf(3), task: 'A.1', token: 2, harness: 'claude', childOf: idOf(2), phase: 'starting', endState: null, createdAt: '2026-11-08T05:02:00.000Z', startedAt: null, endedAt: null, edit: false },
    ],
    limits: { shown: 3, notShown: 0 },
  });
  assertNothingPlanted(r.out);
  const absent = runsCall(p, { slug: 'feat-none' });
  assert.deepEqual(absent.json, { v: 1, slug: 'feat-none', store: 'absent', runs: [], limits: { shown: 0, notShown: 0 } });
  assert.deepEqual(JSON.parse(JSON.stringify(workerRunsBody({ cwd: p.root, slug: SLUG }).json)), r.json);
});

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

test('a version 2 or torn store is store-unreadable (exit 2); without --slug it holds no run', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  const doc = JSON.parse(fs.readFileSync(p.store, 'utf8'));
  fs.writeFileSync(p.store, JSON.stringify({ ...doc, version: 2 }));
  assertError(logCall(p, { workerRun: idOf(1), stream: 'out', slug: SLUG }), 2, 'store-unreadable');
  assertError(resultCall(p, { workerRun: idOf(1), slug: SLUG }), 2, 'store-unreadable');
  assertError(runsCall(p, { slug: SLUG }), 2, 'store-unreadable');
  assertError(logCall(p, { workerRun: idOf(1), stream: 'out' }), 1, 'unknown-run');
  fs.writeFileSync(p.store, '{"runs": ');
  assertError(runsCall(p, { slug: SLUG }), 2, 'store-unreadable');
  assert.deepEqual(workerResultBody({ cwd: p.root, workerRun: idOf(1), slug: SLUG }), { exit: 2, json: { v: 1, ok: false, error: 'store-unreadable' } });
});

test('a run no store holds is unknown-run (exit 1)', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  assertError(logCall(p, { workerRun: idOf(9), stream: 'out' }), 1, 'unknown-run');
  assertError(logCall(p, { workerRun: idOf(9), stream: 'out', slug: SLUG }), 1, 'unknown-run');
  assertError(resultCall(p, { workerRun: idOf(9) }), 1, 'unknown-run');
  assertError(resultCall(p, { workerRun: idOf(1), slug: 'other-feature' }), 1, 'unknown-run');
  const text = call(handleWorkerLogCommand, { cwd: p.root, workerRun: idOf(9), stream: 'out' });
  assert.equal(text.exit, 1);
  assert.equal(text.out, '');
  assert.match(text.err, /^doflow worker-log: /);
});

test('every usage refusal is exit 2 with the usage body', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  const run = idOf(1);
  const logRefusals: any[] = [
    { stream: 'out' },
    { workerRun: 'w-XYZ', stream: 'out' },
    { workerRun: 'w-0123456789abc', stream: 'out' },
    { workerRun: run },
    { workerRun: run, stream: 'last' },
    { workerRun: run, stream: 'stdout' },
    { workerRun: run, stream: 'toString' },
    { workerRun: run, stream: 'out', cursor: '1:2:0:0', before: '1:2:0:0' },
    { workerRun: run, stream: 'out', cursor: 'abc' },
    { workerRun: run, stream: 'out', cursor: '1:2:3' },
    { workerRun: run, stream: 'out', before: '1:-2:0:0' },
    { workerRun: run, stream: 'out', cursor: '1:99999999999999999:0:0' },
    { workerRun: run, stream: 'out', slug: '../evil' },
    { workerRun: run, stream: 'out', flags: ['--worker-run', '--stream', '--bogus'] },
    { workerRun: run, stream: 'out', flags: ['--worker-run', '--stream', '--stream'] },
    { workerRun: run, stream: 'out', flags: ['--worker-run', '--stream', '--json=1'] },
    { workerRun: run, stream: 'out', positional: ['extra'] },
  ];
  for (const options of logRefusals) assertError(logCall(p, options), 2, 'usage');
  const resultRefusals: any[] = [
    {},
    { workerRun: 'w-1' },
    { workerRun: run, slug: 'Bad Slug' },
    { workerRun: run, flags: ['--worker-run', '--stream'] },
    { workerRun: run, flags: ['--worker-run', '--worker-run'] },
    { workerRun: run, positional: ['extra'] },
  ];
  for (const options of resultRefusals) assertError(resultCall(p, options), 2, 'usage');
  const runsRefusals: any[] = [
    {},
    { resolveSlug: () => '../x' },
    { slug: '../x' },
    { slug: SLUG, flags: ['--slug', '--worker-run'] },
    { slug: SLUG, flags: ['--slug', '--slug'] },
    { slug: SLUG, positional: ['extra'] },
  ];
  for (const options of runsRefusals) assertError(runsCall(p, options), 2, 'usage');
  // The flags as typed are accepted when each is known and given once.
  assert.equal(logCall(p, { workerRun: run, stream: 'out', flags: ['--worker-run', '--stream', '--slug=x', '--json'], slug: SLUG }).exit, 0);
});

// ── Read-only ────────────────────────────────────────────────────────────────────────────────────

/** Every entry under `root`: path, type, size, mtime, inode and a content digest. */
function treeOf(root: string) {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full, { bigint: true });
      const digest = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : '-';
      out.push(`${path.relative(root, full)} ${st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeNs} ${st.ino} ${digest}`);
      if (st.isDirectory()) walk(full);
    }
  }(root));
  return out;
}

test('every read leaves the tree byte for byte unchanged', (t: any) => {
  const p = project(t);
  addRun(p, { runId: idOf(1), phase: 'running' });
  addRun(p, endedRecord(idOf(2), 2));
  writeLog(p, idOf(1), 'out', 'a\nb\n');
  writeLog(p, idOf(2), 'last', 'PLANTED\n');
  const other = storeFileFor(p.root, 'other-feature');
  addRun(p, { runId: idOf(3), phase: 'running' }, other);
  fs.writeFileSync(other, JSON.stringify({ ...JSON.parse(fs.readFileSync(other, 'utf8')), version: 2 }));
  const before = treeOf(p.root);
  assert.ok(before.length > 5);
  for (const stream of ['out', 'err', 'last']) {
    for (const runId of [idOf(1), idOf(2), idOf(3), idOf(9)]) {
      logCall(p, { workerRun: runId, stream });
      logCall(p, { workerRun: runId, stream, slug: SLUG });
      logCall(p, { workerRun: runId, stream, slug: 'other-feature', cursor: '1:0:0:0' });
      call(handleWorkerLogCommand, { cwd: p.root, workerRun: runId, stream });
    }
  }
  for (const runId of [idOf(1), idOf(2), idOf(3), idOf(9)]) {
    resultCall(p, { workerRun: runId });
    resultCall(p, { workerRun: runId, slug: 'other-feature' });
  }
  for (const slug of [SLUG, 'other-feature', 'feat-none']) runsCall(p, { slug });
  assert.deepEqual(treeOf(p.root), before);
});
