'use strict';

// The failure explainer (180 C5, design §3 IC-180-B3, FR-B3): derive/explain.js reads why a run stopped from its own record
// (the rejecting gate decision, the close, the last update of a silent run) and names the next command from a fixed table.
// Pure: no DOM, no clock, no storage. The table's verb and actions are checked against the CLI's own help.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
// Read-only: the root guard helper that lists every verb the doflow CLI accepts.
const { cliVerbs, REPO } = require('../../test/guards/_shared.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let explain: any;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-explain-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  explain = await import(pathToFileURL(path.join(copy, 'derive', 'explain.js')).href);
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const run = (state: string, extra: any = {}) => ({
  taskId: 'T-1', featureSlug: 'feat-a', taskClass: 'feature', state, revision: 3, updatedAt: ago(1),
  current: { type: 'stage', id: 'design', kind: null }, progress: { done: 2, total: 6 }, ...extra,
});
const event = (action: string, extra: any = {}) => ({ at: ago(2), action, node: null, outcome: null, decision: null, by: null, forced: false, synthetic: false, ...extra });
const timeline = (...events: any[]) => ({ v: 1, taskId: 'T-1', featureSlug: 'feat-a', revision: 3, startedAt: ago(5), events, otherEvents: 0 });

test('REJECTED: the rejecting decide-gate entry, verbatim, and the timeline command', () => {
  const tl = timeline(
    event('start'),
    event('decide-gate', { node: 'gate-a', decision: 'approve', by: 'manual', at: ago(4) }),
    event('decide-gate', { node: 'gate-b', decision: 'reject', by: 'device.d-0123456789ab', at: ago(3) }),
  );
  assert.deepEqual(explain.explain(run('REJECTED'), tl, NOW), {
    state: 'REJECTED',
    reason: { kind: 'rejected', text: 'gate-b', by: 'device.d-0123456789ab', at: ago(3) },
    next: { command: 'doflow orchestrate --action timeline --task-id T-1 --slug feat-a', why: explain.NEXT.rejected.why },
  });
});

test('REJECTED with no readable timeline: the reason fields are null (nothing is made up), the command stays', () => {
  const out = explain.explain(run('REJECTED', { featureSlug: null }), null, NOW);
  assert.deepEqual(out.reason, { kind: 'rejected', text: null, by: null, at: null });
  assert.equal(out.next.command, 'doflow orchestrate --action timeline --task-id T-1');
});

test('CLOSED before its last step: the close entry (step, who, when) and the status command', () => {
  const tl = timeline(event('start'), event('close-run', { node: 'design', by: 'console', at: ago(2) }));
  assert.deepEqual(explain.explain(run('CLOSED'), tl, NOW), {
    state: 'CLOSED',
    reason: { kind: 'closed', text: 'design', by: 'console', at: ago(2) },
    next: { command: 'doflow orchestrate --action status --task-id T-1 --slug feat-a', why: explain.NEXT.closed.why },
  });
});

test('CLOSED after every step was done is no failure: null', () => {
  const tl = timeline(event('close-run', { node: null, by: 'manual' }));
  assert.equal(explain.explain(run('CLOSED', { progress: { done: 6, total: 6 }, current: null }), tl, NOW), null);
});

test('stale RUNNING (the home rule: no update for over a day): the last update and the current stage, and the status command', () => {
  assert.deepEqual(explain.explain(run('RUNNING', { updatedAt: ago(30) }), timeline(event('start')), NOW), {
    state: 'RUNNING',
    reason: { kind: 'stale', text: 'design', by: null, at: ago(30) },
    next: { command: 'doflow orchestrate --action status --task-id T-1 --slug feat-a', why: explain.NEXT.stale.why },
  });
});

test('a healthy run gives null: running and fresh, waiting at a gate, completed', () => {
  assert.equal(explain.explain(run('RUNNING', { updatedAt: ago(23) }), timeline(), NOW), null);
  assert.equal(explain.explain(run('AWAITING_GATE', { updatedAt: ago(48) }), timeline(), NOW), null);
  assert.equal(explain.explain(run('COMPLETED'), timeline(), NOW), null);
  assert.equal(explain.explain(null, null, NOW), null);
});

test('recorded text is never composed: a reason field holds only a recorded value, and a slug that is not id-shaped is left out', () => {
  const tl = timeline(event('decide-gate', { node: 'gate-b', decision: 'reject', by: null, at: null }));
  const out = explain.explain(run('REJECTED', { featureSlug: 'bad slug; rm -rf' }), tl, NOW);
  assert.deepEqual(out.reason, { kind: 'rejected', text: 'gate-b', by: null, at: null });
  assert.equal(out.next.command, 'doflow orchestrate --action timeline --task-id T-1');
});

/** The orchestrate actions `doflow --help` lists (its `orchestrate: a|b|c` line). */
function orchestrateActions(): string[] {
  const help = execFileSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), '--help'], { encoding: 'utf8' });
  const line = /^\s*orchestrate: ([a-z|-]+)$/m.exec(help);
  assert.ok(line, 'doflow --help lists the orchestrate actions');
  return line![1].split('|');
}

test('every command of the table names a shipped verb and an orchestrate action', () => {
  const verbs = cliVerbs();
  const actions = orchestrateActions();
  const commands = [
    explain.explain(run('REJECTED'), null, NOW).next.command,
    explain.explain(run('CLOSED'), null, NOW).next.command,
    explain.explain(run('RUNNING', { updatedAt: ago(30) }), null, NOW).next.command,
  ];
  assert.deepEqual(Object.keys(explain.NEXT).sort(), ['closed', 'rejected', 'stale']);
  for (const command of commands) {
    const parts = /^doflow ([a-z-]+) --action ([a-z-]+) /.exec(command);
    assert.ok(parts, command);
    assert.ok(verbs.has(parts![1]), `${parts![1]} is a doflow verb`);
    assert.ok(actions.includes(parts![2]), `${parts![2]} is an orchestrate action`);
  }
});

test('control: a verb or an action the CLI does not have is refused by the same check', () => {
  const verbs = cliVerbs();
  const actions = orchestrateActions();
  assert.equal(verbs.has('orchestrat'), false);
  assert.equal(actions.includes('explain'), false);
  assert.equal(actions.includes('timeline'), true);
});
