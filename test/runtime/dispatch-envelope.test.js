'use strict';

// Feature 082 A.5: handoff and result envelopes (IC-010, IC-011, IC-012, DEC-005, DEC-027,
// DEC-033, DEC-059). Pure builders and one in-process writer; no child process starts here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.js');
const {
  canonical, buildHandoff, buildResult, writeEnvelope, FIXED_CONSTRAINTS, BOUNDS,
} = require('../../src/runtime/dispatch/envelope.ts');

const DISPATCH = 'd-0123456789ab';
const SLUG = '082-dispatch-integration-loop';
const SHA = 'a'.repeat(64);

function stateRootFor(t) {
  const root = tempDir(t, 'doflow-envelope-');
  return path.join(root, '.doflow', 'state');
}

function handoffInput(overrides = {}) {
  return {
    dispatchId: DISPATCH,
    dispatchRunId: 'p-0123456789ab',
    slug: SLUG,
    mode: 'subagent',
    task: { id: 'A.5', phase: 'A', owner: 'core-implementer', text: 'Handoff and result envelopes', files: ['src/a.ts', 'test/a.test.js'], dependsOn: [] },
    acceptance: ['FR-006', 'IC-010'],
    sources: [{ path: 'src/a.ts', sha256: SHA }],
    deltas: { runBase: 'b'.repeat(40), attemptBase: 'c'.repeat(40), changes: [] },
    budget: { reserveTokens: 1000, attemptSeconds: 600, attempts: { used: 1, limit: 20 } },
    grant: null,
    worktree: { path: '/scratch/dispatch-worktrees/d-0123456789ab', branch: `doflow-attempt/${SLUG}/${DISPATCH}`, base: 'c'.repeat(40) },
    report: { parser: 'doflow-jsonl-v1', spawn: null },
    ...overrides,
  };
}

function resultInput(overrides = {}) {
  return {
    dispatchId: DISPATCH,
    task: 'A.5',
    token: 1,
    epoch: 1,
    mode: 'subagent',
    outcome: 'offered',
    staleReason: null,
    failureClass: null,
    summary: 'done',
    status: 'success',
    base: 'c'.repeat(40),
    commit: 'd'.repeat(40),
    files: ['src/a.ts'],
    changes: [{ path: 'src/a.ts', change: 'M', from: null }],
    evidence: [],
    blockers: [],
    usage: { tokens: 10, basis: 'measured', source: 'worker' },
    workerRun: { id: 'w-0123456789ab', output: { stdout: 'worker-output/w-0123456789ab.out.log', stderr: 'worker-output/w-0123456789ab.err.log' } },
    isolation: { status: 'clean', reasons: [] },
    ...overrides,
  };
}

function readJson(stateRoot, pointer) {
  return JSON.parse(fs.readFileSync(path.join(stateRoot, pointer), 'utf8'));
}

test('handoff: fixed constraints in order, write-set line, acceptance sources, masked and cut text', () => {
  const secret = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2'}`;
  const h = buildHandoff(handoffInput({ task: { ...handoffInput().task, text: `token=${secret} ${'é'.repeat(1500)}` } }));
  assert.deepEqual(h.constraints, [...FIXED_CONSTRAINTS, 'files: src/a.ts, test/a.test.js']);
  assert.equal(FIXED_CONSTRAINTS[0], 'edit only inside worktree.path');
  assert.equal(FIXED_CONSTRAINTS[4], 'spawn children only through dispatch --action spawn within grant');
  assert.deepEqual(h.acceptance, [
    { id: 'FR-006', source: `agent-docs/doflow/${SLUG}/intention/requirement.md` },
    { id: 'IC-010', source: `agent-docs/doflow/${SLUG}/design/specs.md` },
  ]);
  assert.ok(!h.task.text.includes(secret));
  assert.ok(h.task.text.includes('<masked>'));
  assert.ok(Buffer.byteLength(h.task.text, 'utf8') <= 2000);
  assert.ok(!h.task.text.includes('\uFFFD'));
  const none = buildHandoff(handoffInput({ task: { ...handoffInput().task, files: [] } }));
  assert.equal(none.constraints.at(-1), 'files: none declared');
});

test('handoff: 500 source pointers stay within 16384 bytes and the tail goes to a sidecar', (t) => {
  const stateRoot = stateRootFor(t);
  const sources = Array.from({ length: 500 }, (_, i) => ({ path: `src/module-${String(i).padStart(4, '0')}.ts`, sha256: SHA }));
  const value = buildHandoff(handoffInput({ sources }));
  const out = writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'handoff', value });
  const text = fs.readFileSync(out.path, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= BOUNDS.handoff);
  const written = JSON.parse(text);
  assert.equal(written.overflow.length, 1);
  const [entry] = written.overflow;
  assert.equal(entry.list, 'sources');
  assert.equal(entry.total, 500);
  assert.equal(entry.kept, written.sources.length);
  assert.ok(entry.kept > 0 && entry.kept < 500);
  assert.equal(entry.pointer, `dispatch-envelopes/${DISPATCH}.sources.json`);
  const sidecarText = fs.readFileSync(path.join(stateRoot, entry.pointer), 'utf8');
  const tail = JSON.parse(sidecarText);
  assert.equal(sidecarText, canonical(tail));
  assert.deepEqual([...written.sources, ...tail], JSON.parse(canonical(sources)));
  // One more source would not have fitted: the kept prefix is the longest one.
  const longer = JSON.parse(text);
  longer.sources = JSON.parse(canonical(sources.slice(0, entry.kept + 1)));
  longer.overflow[0].kept = entry.kept + 1;
  assert.ok(Buffer.byteLength(canonical(longer), 'utf8') > BOUNDS.handoff);
  assert.deepEqual(fs.readdirSync(path.dirname(out.path)).filter((f) => f.endsWith('.tmp')), []);
});

test('handoff: sources are cut before deltas-changes before acceptance', (t) => {
  const stateRoot = stateRootFor(t);
  const sources = Array.from({ length: 300 }, (_, i) => ({ path: `src/source-file-${i}.ts`, sha256: SHA }));
  const changes = Array.from({ length: 300 }, (_, i) => ({ path: `lib/changed-${i}.js`, change: 'M', dispatchId: 'd-aaaaaaaaaaaa' }));
  const acceptance = Array.from({ length: 100 }, (_, i) => `FR-${String(i).padStart(3, '0')}`);
  const value = buildHandoff(handoffInput({ sources, acceptance, deltas: { runBase: 'b'.repeat(40), attemptBase: 'c'.repeat(40), changes } }));
  const out = writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'handoff', value });
  const written = JSON.parse(fs.readFileSync(out.path, 'utf8'));
  assert.ok(out.bytes <= BOUNDS.handoff);
  assert.deepEqual(written.overflow.map((o) => o.list), ['sources', 'deltas.changes']);
  assert.equal(written.overflow[0].kept, 0);
  assert.ok(written.overflow[1].kept > 0 && written.overflow[1].kept < 300);
  assert.equal(written.acceptance.length, 100);
  assert.equal(written.overflow[1].pointer, `dispatch-envelopes/${DISPATCH}.deltas-changes.json`);
  assert.equal(readJson(stateRoot, written.overflow[1].pointer).length, 300 - written.overflow[1].kept);
  assert.equal(readJson(stateRoot, written.overflow[0].pointer).length, 300);
});

test('result: 5000 changes cut changes first', (t) => {
  const stateRoot = stateRootFor(t);
  const changes = Array.from({ length: 5000 }, (_, i) => ({ path: `src/f${i}.js`, change: 'M', from: null }));
  const declared = buildResult(resultInput({ changes, files: changes.map((c) => c.path) }));
  assert.deepEqual(declared.undeclared, []);
  const out = writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'result', value: declared });
  const written = JSON.parse(fs.readFileSync(out.path, 'utf8'));
  assert.ok(out.bytes <= BOUNDS.result);
  assert.deepEqual(written.overflow.map((o) => o.list), ['changes']);
  assert.ok(written.overflow[0].kept > 0);
  assert.equal(written.changes.length + readJson(stateRoot, written.overflow[0].pointer).length, 5000);

  const loose = buildResult(resultInput({ changes, files: [] }));
  const out2 = writeEnvelope({ stateRoot, dispatchId: 'd-0123456789ac', kind: 'result', value: loose });
  const written2 = JSON.parse(fs.readFileSync(out2.path, 'utf8'));
  assert.deepEqual(written2.overflow.map((o) => o.list), ['changes', 'undeclared']);
  assert.equal(written2.overflow[0].kept, 0);
  assert.ok(out2.bytes <= BOUNDS.result);
});

test('result: still over after every list is empty, summary is cut on a UTF-8 boundary ending [cut]', (t) => {
  const stateRoot = stateRootFor(t);
  const summary = `x${'€'.repeat(666)}`; // 1999 bytes, every boundary after the first byte is 3-aligned
  const value = buildResult(resultInput({
    summary,
    changes: [{ path: 'a.js', change: 'A', from: null }],
    files: [],
    evidence: [{ id: 'ev-1', exitCode: 0 }],
    blockers: ['blocked'],
    isolation: { status: 'violated', reasons: Array.from({ length: 31 }, (_, i) => `${i}${'r'.repeat(999)}`) },
  }));
  const out = writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'result', value });
  const text = fs.readFileSync(out.path, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= BOUNDS.result);
  const written = JSON.parse(text);
  assert.deepEqual(written.overflow.map((o) => [o.list, o.kept]), [['changes', 0], ['undeclared', 0], ['evidence', 0], ['blockers', 0]]);
  assert.ok(written.summary.endsWith('[cut]'));
  const kept = written.summary.slice(0, -'[cut]'.length);
  assert.ok(kept.length < summary.length);
  assert.ok(summary.startsWith(kept));
  assert.ok(!written.summary.includes('\uFFFD'));
});

test('result: undeclared lists every change and rename source for a task with no files, and ./a.js matches a.js', () => {
  const changes = [
    { path: 'a.js', change: 'M', from: null },
    { path: 'lib/new.js', change: 'R', from: 'lib/old.js' },
  ];
  assert.deepEqual(buildResult(resultInput({ changes, files: [] })).undeclared, ['a.js', 'lib/old.js', 'lib/new.js']);
  assert.deepEqual(buildResult(resultInput({ changes, files: undefined })).undeclared, ['a.js', 'lib/old.js', 'lib/new.js']);
  assert.deepEqual(buildResult(resultInput({ changes, files: [' ./a.js ', 'lib/new.js'] })).undeclared, ['lib/old.js']);
});

test('written envelope size equals its canonical length', (t) => {
  const stateRoot = stateRootFor(t);
  for (const [kind, value] of [['handoff', buildHandoff(handoffInput())], ['result', buildResult(resultInput())]]) {
    const out = writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind, value });
    const text = fs.readFileSync(out.path, 'utf8');
    assert.equal(text, canonical(JSON.parse(text)));
    assert.equal(fs.statSync(out.path).size, Buffer.byteLength(canonical(JSON.parse(text)), 'utf8'));
    assert.equal(out.bytes, fs.statSync(out.path).size);
    assert.equal(out.pointer, `dispatch-envelopes/${DISPATCH}.${kind}.json`);
  }
  assert.throws(() => writeEnvelope({ stateRoot, dispatchId: '../x', kind: 'result', value: {} }), /invalid dispatch id/);
  assert.throws(() => writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'other', value: {} }), /unknown envelope kind/);
});

test('a planted environment value given in no input appears in no written file', (t) => {
  const stateRoot = stateRootFor(t);
  const name = 'DOFLOW_ENVELOPE_PLANTED_VALUE';
  const planted = `planted-${crypto.randomBytes(8).toString('hex')}`;
  process.env[name] = planted;
  t.after(() => { delete process.env[name]; });
  const sources = Array.from({ length: 500 }, (_, i) => ({ path: `src/m${i}.ts`, sha256: SHA }));
  writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'handoff', value: buildHandoff(handoffInput({ sources })) });
  const changes = Array.from({ length: 5000 }, (_, i) => ({ path: `src/f${i}.js`, change: 'A', from: null }));
  writeEnvelope({ stateRoot, dispatchId: DISPATCH, kind: 'result', value: buildResult(resultInput({ changes, files: [] })) });
  const dir = path.join(stateRoot, 'dispatch-envelopes');
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 4);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!text.includes(planted), `${file} holds the planted value`);
    assert.ok(!text.includes(name), `${file} holds the planted name`);
  }
});
