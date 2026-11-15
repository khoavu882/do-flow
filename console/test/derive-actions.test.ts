'use strict';

// 162 IC-010 (T7): the words of the Console actions and the confirmation spec builder (console/web/derive/actions.js). Pure
// functions: no DOM and no fetch. The web root is copied beside a {"type":"module"} marker so the ES module imports here.
// The words table is keyed by action id: its ids equal the runner's WRITE_SHAPE_IDS (T6's ACTION_IDS does not exist yet; a
// later task adds the four-way check).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WRITE_SHAPE_IDS } = require('../src/verb-runner.ts');
const { TEXT_VECTORS } = require('./helpers/text-vectors.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let scratch: string;
let words: any;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-actions-'));
  fs.cpSync(WEB_ROOT, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  words = await import(pathToFileURL(path.join(scratch, 'derive', 'actions.js')).href);
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PK = '0123456789abcdef';
const gateCtx = (over: any = {}) => ({
  projectKey: PK, project: 'do-flow', slug: '162-console-actions', taskId: '162-console-actions', gate: { id: 'gate-a', name: 'Design approval' }, revision: 7, ...over,
});

test('the reject words name the project, run and gate and say "cannot be undone"; device.d-0a1b2c3d4e5f reads "from paired device d-0a1b2c3d4e5f"; the words table ids equal WRITE_SHAPE_IDS', () => {
  const spec = words.buildConfirmation('decide-gate', gateCtx({ decision: 'reject' }));
  assert.equal(spec.effect, 'Reject Design approval (gate-a) of run 162-console-actions/162-console-actions in do-flow. The run ends as rejected. This cannot be undone.');
  assert.match(spec.effect, /do-flow/);
  assert.match(spec.effect, /162-console-actions\/162-console-actions/);
  assert.match(spec.effect, /gate-a/);
  assert.match(spec.effect, /cannot be undone/);
  assert.equal(words.byWords('device.d-0a1b2c3d4e5f'), 'from paired device d-0a1b2c3d4e5f');
  assert.deepEqual(Object.keys(words.ACTION_WORDS).sort(), [...WRITE_SHAPE_IDS].sort());
});

test('the by words: autopilot, manual, console, a paired device, and "decider not recorded" for null or any other value', () => {
  assert.equal(words.byWords('autopilot'), 'by autopilot');
  assert.equal(words.byWords('manual'), 'manually');
  assert.equal(words.byWords('console'), 'from the Console on this machine');
  assert.equal(words.byWords('device.d-0a1b2c3d4e5f'), 'from paired device d-0a1b2c3d4e5f');
  for (const other of [null, undefined, '', 'person', 'device.d-XYZ', 'device:d-0a1b2c3d4e5f', 7]) assert.equal(words.byWords(other), 'decider not recorded', String(other));
});

test('the four effect sentences, as IC-010 gives them', () => {
  const approve = words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve' }));
  assert.equal(approve.effect, 'Approve Design approval (gate-a) of run 162-console-actions/162-console-actions in do-flow. The run continues past this gate.');
  const close = words.buildConfirmation('close-run', { projectKey: PK, project: 'do-flow', slug: null, taskId: 'fix-x', current: { type: 'stage', id: 'implement' }, revision: 3 });
  assert.equal(close.effect, 'Close run fix-x in do-flow, now at implement. It ends as closed where it stands. This cannot be undone.');
  const stop = words.buildConfirmation('cancel-worker', { projectKey: PK, project: 'do-flow', slug: 'feat-a', worker: { runId: 'w-1a2b3c4d5e6f', harness: 'codex', task: 'A.1' } });
  assert.equal(stop.effect, 'Stop worker w-1a2b3c4d5e6f (codex, task A.1) of feat-a in do-flow. Its processes get SIGTERM, then SIGKILL after 3 s. Edits it has not handed back stay in its own worktree and are not merged. This cannot be undone.');
});

test('the spec: verb labels, the text field rule and the request body without requestId; a gate without a name reads by its id', () => {
  const approve = words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve' }));
  assert.equal(approve.verb, 'Approve gate-a');
  assert.equal(words.buildConfirmation('decide-gate', gateCtx({ decision: 'reject' })).verb, 'Reject gate-a');
  assert.deepEqual(approve.text, { field: 'note', required: false, max: 500, label: 'Note (optional)' });
  assert.deepEqual(approve.expect, { revision: 7 });
  assert.deepEqual(approve.body, { v: 1, projectKey: PK, slug: '162-console-actions', taskId: '162-console-actions', gateId: 'gate-a', decision: 'approve', note: null, expect: { revision: 7 } });
  assert.equal('requestId' in approve.body, false);
  const close = words.buildConfirmation('close-run', { projectKey: PK, project: 'do-flow', slug: null, taskId: 'fix-x', current: null, revision: 3 });
  assert.equal(close.verb, 'Close run');
  assert.deepEqual(close.text, { field: 'note', required: true, max: 500, label: 'Why is this run closed? (required)' });
  assert.deepEqual(close.body, { v: 1, projectKey: PK, slug: null, taskId: 'fix-x', note: null, expect: { revision: 3 } });
  assert.equal(close.effect, 'Close run fix-x in do-flow. It ends as closed where it stands. This cannot be undone.');
  const stop = words.buildConfirmation('cancel-worker', { projectKey: PK, project: 'do-flow', slug: 'feat-a', worker: { runId: 'w-1a2b3c4d5e6f', harness: null, task: 'A.1' } });
  assert.equal(stop.verb, 'Stop worker');
  assert.deepEqual(stop.text, { field: 'reason', required: true, max: 500, label: 'Why is this worker stopped? (required)' });
  assert.equal(stop.expect, null);
  assert.deepEqual(stop.body, { v: 1, projectKey: PK, slug: 'feat-a', runId: 'w-1a2b3c4d5e6f', reason: null });
  assert.match(stop.effect, /\(task A\.1\)/);
  const bare = words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve', gate: { id: 'gate-a', name: null } }));
  assert.match(bare.effect, /^Approve gate-a of run /);
});

test('a spec needs every field the body carries: a missing revision, project key or decision builds nothing', () => {
  assert.equal(words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve', revision: null })), null);
  assert.equal(words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve', projectKey: 'not-a-key' })), null);
  assert.equal(words.buildConfirmation('decide-gate', gateCtx({ decision: 'maybe' })), null);
  assert.equal(words.buildConfirmation('decide-gate', gateCtx({ decision: 'approve', gate: null })), null);
  assert.equal(words.buildConfirmation('close-run', { projectKey: PK, project: 'p', slug: null, taskId: 't', current: null, revision: 1.5 }), null);
  assert.equal(words.buildConfirmation('cancel-worker', { projectKey: PK, project: 'p', slug: null, worker: { runId: 'w-1a2b3c4d5e6f' } }), null, 'a worker cancel names its feature');
  assert.equal(words.buildConfirmation('cancel-worker', { projectKey: PK, project: 'p', slug: 's', worker: { runId: 'nope', task: 'A.1' } }), null);
  assert.equal(words.buildConfirmation('unknown-action', gateCtx()), null);
});

test('every IC-002 error code has words, and an unknown code still gets a sentence', () => {
  const codes = ['usage', 'unauthenticated', 'device-unpaired', 'device-revoked', 'device-expired', 'phone-scope', 'action-transport', 'forbidden-origin', 'unsupported-media',
    'project-not-found', 'run-not-found', 'stale', 'cancel-in-progress', 'ambiguous-run', 'request-reused', 'action-rate-limited', 'action-busy', 'core-lacks-action',
    'core-error', 'core-contract-mismatch', 'core-unreachable', 'action-log-unwritable', 'action-timeout'];
  for (const code of codes) {
    const sentence = words.refusalWords(code);
    assert.equal(typeof sentence, 'string', code);
    assert.ok(sentence.length > 10 && sentence.endsWith('.'), code);
  }
  assert.deepEqual(Object.keys(words.REFUSAL_WORDS).sort(), [...codes].sort());
  assert.match(words.refusalWords('brand-new-code'), /brand-new-code/);
  assert.match(words.refusalWords(undefined), /did not accept/);
});

test('the stale words: the current state in words, then "Nothing was applied."', () => {
  const run = (current: any) => words.staleWords('decide-gate', current);
  assert.deepEqual(run({ state: 'RUNNING', revision: 8, awaitingGate: null }), ['This run changed since you opened it.', 'It is now running.', 'Nothing was applied.']);
  assert.deepEqual(run({ state: 'AWAITING_GATE', revision: 8, awaitingGate: { gateId: 'gate-b', name: 'Plan approval' } }), ['This run changed since you opened it.', 'It is now waiting at Plan approval (gate-b).', 'Nothing was applied.']);
  assert.equal(run({ state: 'CLOSED', revision: 9, awaitingGate: null })[1], 'It is now closed.');
  assert.equal(run({ state: 'REJECTED', revision: 9, awaitingGate: null })[1], 'It is now rejected.');
  assert.equal(run({ state: 'COMPLETED', revision: 9, awaitingGate: null })[1], 'It is now completed.');
  assert.deepEqual(words.staleWords('cancel-worker', { state: 'ended', endState: 'exited' }), ['This worker run changed since you opened it.', 'It has already ended (exited).', 'Nothing was applied.']);
  assert.deepEqual(words.staleWords('cancel-worker', { state: 'cancelling', requestedAt: '2026-11-15T10:00:00.000Z' }), ['This worker run changed since you opened it.', 'A stop is already in progress.', 'Nothing was applied.']);
  assert.deepEqual(run(null), ['This run changed since you opened it.', 'Nothing was applied.'], 'a reply with no current state still says it');
  assert.deepEqual(run({ state: 'SOMETHING', revision: 1, awaitingGate: null }), ['This run changed since you opened it.', 'Nothing was applied.']);
});

test('the text rules of IC-009 as the page counts them: one line, no control characters, trimmed, code points, 500 at most', () => {
  assert.equal(words.normalizeText('  a\r\nb\tc  ​\u0007d  '), 'a b c d');
  assert.equal(words.normalizeText('‮evil⁩'), 'evil');
  assert.equal(words.normalizeText('é'), 'é', 'NFC');
  // 162 review 6: the server's vectors, the same list actions-routes.test.ts runs; a text the server refuses is never ok here.
  for (const [raw, normalized] of TEXT_VECTORS) {
    assert.equal(words.normalizeText(raw), normalized, JSON.stringify(raw));
    if (normalized === null) assert.equal(words.textState({ required: false, max: 500 }, raw).ok, false, JSON.stringify(raw));
  }
  assert.equal(words.textState({ required: true, max: 500 }, '\u007F').ok, false, 'a note of only DEL is empty, as the server makes it');
  const text = words.textState({ required: true, max: 500 }, '   ');
  assert.deepEqual(text, { text: '', count: 0, ok: false, over: false });
  assert.equal(words.textState({ required: false, max: 500 }, '').ok, true);
  assert.equal(words.textState({ required: true, max: 500 }, 'why').ok, true);
  assert.equal(words.textState({ required: true, max: 500 }, '\u{1F600}'.repeat(500)).ok, true, '500 code points, 1000 UTF-16 units');
  const over = words.textState({ required: false, max: 500 }, 'x'.repeat(501));
  assert.deepEqual([over.ok, over.over, over.count], [false, true, 501]);
});

test('the applied notices', () => {
  assert.equal(words.appliedWords('decide-gate', 'approve'), 'Approved. The page shows the run’s new state.');
  assert.equal(words.appliedWords('decide-gate', 'reject'), 'Rejected. The page shows the run’s new state.');
  assert.equal(words.appliedWords('close-run', null), 'Closed. The page shows the run’s new state.');
  assert.equal(words.appliedWords('cancel-worker', null), 'Stopped. The page shows the worker run’s new state.');
  assert.equal(words.UNKNOWN_WORDS, 'The outcome is unknown. The page shows the run as it is now.');
});

test('the cancel words: who asked for a worker stop, from the worker status `cancelBy`', () => {
  assert.equal(words.cancelWords(null), null);
  assert.equal(words.cancelWords(undefined), null);
  assert.equal(words.cancelWords({ by: 'console', source: 'operator', requestedAt: null }), 'from the Console on this machine');
  assert.equal(words.cancelWords({ by: 'device.d-0a1b2c3d4e5f', source: 'operator', requestedAt: null }), 'from paired device d-0a1b2c3d4e5f');
  assert.equal(words.cancelWords({ by: 'worker-b', source: 'user', requestedAt: null }), 'by worker-b');
  // 162 review 8: the projector carries any name the core takes as display text.
  assert.equal(words.cancelWords({ by: 'Jane Doe', source: 'user', requestedAt: null }), 'by Jane Doe');
  assert.equal(words.cancelWords({ by: null, source: 'timeout', requestedAt: null }), 'by the deadline');
  for (const odd of [{ by: 'person', source: 'operator' }, { by: null, source: 'user' }, { by: 'x', source: 'other' }, 'console', 7]) assert.equal(words.cancelWords(odd), 'requester not recorded', JSON.stringify(odd));
});
