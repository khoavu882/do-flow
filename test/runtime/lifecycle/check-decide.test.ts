'use strict';

// 181 G.3 (IC-015, FR-002, FR-003, NFR-005): `decideCheck` records accept, decline and built for a proposal. An accept
// returns the composed message and is refused from an unattended channel; a built check must hold that message and no
// built state exists without an accept; built settles the member follow-ups `fix`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createScratch } = require('../../helper/scratch-env.ts');
const followup = require('../../../src/runtime/lifecycle/followup.ts');
const store = require('../../../src/runtime/lifecycle/event-store.ts');
const { proposeChecks, decideCheck, composeMessage } = require('../../../src/runtime/lifecycle/check-proposal.ts');

const scratch = createScratch('doflow-check-decide-');
before(() => scratch.apply());
after(() => { scratch.restore(); scratch.remove(); });

const UPLOAD = ['The upload client retry loop ignores the server timeout header', 'Upload client retry loop ignores a timeout header from the server proxy'];
const detection = { commands: { lint: { role: 'lint', command: 'npm run lint' } } };
const ATTENDED = { attendance: 'attended', reason: 'no-run' };
const UNATTENDED = { attendance: 'unattended', source: 'worker-role' };

let counter = 0;
/** A project root holding a recorded proposal over two follow-ups; `offered` is static-check. */
function proposed() {
  counter += 1;
  const root = path.join(scratch.dir, `root-${counter}`);
  fs.mkdirSync(root);
  const ids = UPLOAD.map((statement) => followup.addFollowups({ root, cwd: root, items: [{ statement }], defaults: { source: 'manual', batch: false } }).created[0].id);
  const proposal = proposeChecks({ root, record: true, detection }).proposals[0];
  return { root, ids, proposal };
}
const eventFiles = (root: string) => fs.readdirSync(path.join(root, store.EVENTS_REL));
const accept = (root: string, proposal: string, extra: any = {}) => decideCheck({
  root, proposal, decision: 'accept', kind: 'static-check', alternative: 'the shared http client', attendance: ATTENDED, ...extra,
});
const stateOf = (root: string, proposal: string) => store.readFold(root).checks[proposal].state;

test('accept returns the composed message and records check.accepted', () => {
  const { root, proposal } = proposed();
  const out = accept(root, proposal.id);
  assert.deepEqual([out.ok, out.state, out.exitCode], [true, 'accepted', 0]);
  assert.equal(out.message, `${UPLOAD[1]}. Use the shared http client instead.`);
  assert.equal(composeMessage('Do not do X.', 'Y'), 'Do not do X. Use Y instead.');
  const event = JSON.parse(fs.readFileSync(path.join(root, out.events[0]), 'utf8'));
  assert.equal(event.type, 'check.accepted');
  assert.deepEqual(event.data, { proposal: proposal.id, kind: 'static-check', alternative: 'the shared http client', message: out.message });
  assert.equal(stateOf(root, proposal.id), 'accepted');
});

test('a kind below the offered rung needs a reason; the reason is kept', () => {
  const { root, proposal } = proposed();
  const before = eventFiles(root);
  const refused = accept(root, proposal.id, { kind: 'prose' });
  assert.deepEqual([refused.ok, refused.finding, refused.exitCode], [false, 'reason-missing', 1]);
  assert.deepEqual(eventFiles(root), before);
  const ok = accept(root, proposal.id, { kind: 'prose', reason: 'no lint rule can see this' });
  assert.equal(ok.ok, true);
  assert.equal(store.readFold(root).checks[proposal.id].reason, 'no lint rule can see this');
});

test('an accept from an unattended channel is refused and writes nothing', () => {
  const { root, proposal } = proposed();
  const before = eventFiles(root);
  const refused = accept(root, proposal.id, { attendance: UNATTENDED });
  assert.deepEqual([refused.ok, refused.finding, refused.exitCode], [false, 'unattended-accept', 1]);
  assert.deepEqual(eventFiles(root), before);
  // With nothing injected the runtime's own attendance source answers: a worker session is unattended, the autopilot channel too.
  const worker = decideCheck({ root, proposal: proposal.id, decision: 'accept', kind: 'static-check', alternative: 'x', env: { DOFLOW_SESSION_ROLE: 'worker' }, cwd: root });
  assert.equal(worker.finding, 'unattended-accept');
  const policy = decideCheck({ root, proposal: proposal.id, decision: 'accept', kind: 'static-check', alternative: 'x', channel: 'policy', attendance: ATTENDED });
  assert.equal(policy.finding, 'unattended-accept');
  const attended = decideCheck({ root, proposal: proposal.id, decision: 'accept', kind: 'static-check', alternative: 'x', env: {}, cwd: root });
  assert.equal(attended.ok, true);
  assert.deepEqual(eventFiles(root).length, before.length + 1);
});

test('decline needs a reason and is final', () => {
  const { root, proposal } = proposed();
  const before = eventFiles(root);
  assert.equal(decideCheck({ root, proposal: proposal.id, decision: 'decline' }).finding, 'reason-missing');
  assert.deepEqual(eventFiles(root), before);
  const out = decideCheck({ root, proposal: proposal.id, decision: 'decline', reason: 'review catches it' });
  assert.deepEqual([out.ok, out.state], [true, 'declined']);
  assert.equal(accept(root, proposal.id).finding, 'illegal-transition');
  assert.equal(stateOf(root, proposal.id), 'declined');
  assert.equal(proposeChecks({ root, detection }).proposals[0].declinedBefore.reason, 'review catches it');
});

test('no built state without an accept', () => {
  const { root, proposal } = proposed();
  fs.writeFileSync(path.join(root, 'check.js'), composeMessage(UPLOAD[1], 'the shared http client'));
  const before = eventFiles(root);
  const out = decideCheck({ root, proposal: proposal.id, decision: 'built', check: 'check.js' });
  assert.deepEqual([out.ok, out.finding, out.exitCode], [false, 'illegal-transition', 1]);
  assert.deepEqual(eventFiles(root), before);
});

test('built is refused message-missing unless the file holds the composed message; then the members settle fix', () => {
  const { root, ids, proposal } = proposed();
  const { message } = accept(root, proposal.id);
  const before = eventFiles(root);
  const call = (check: string) => decideCheck({ root, proposal: proposal.id, decision: 'built', check });

  fs.writeFileSync(path.join(root, 'rule.js'), "throw new Error('do not call fetch');\n");
  for (const bad of ['rule.js', 'absent.js', '../escape.js', path.join(root, 'rule.js')]) {
    const out = call(bad);
    assert.deepEqual([out.ok, out.finding, out.exitCode], [false, 'message-missing', 1], bad);
  }
  assert.deepEqual(eventFiles(root), before);
  assert.equal(stateOf(root, proposal.id), 'accepted');

  // A scaffolded check that fails on a violating input shows the correction and the alternative (FR-003).
  fs.writeFileSync(path.join(root, 'rule.js'), `if (process.argv[2] === 'fetch(') { console.error(${JSON.stringify(message)}); process.exit(1); }\n`);
  let failure = '';
  try { execFileSync(process.execPath, [path.join(root, 'rule.js'), 'fetch('], { stdio: 'pipe' }); } catch (error: any) { failure = String(error.stderr); }
  assert.ok(failure.includes(UPLOAD[1]) && failure.includes('Use the shared http client instead.'));

  const out = call('rule.js');
  assert.deepEqual([out.ok, out.state, out.path, out.exitCode], [true, 'built', 'rule.js', 0]);
  assert.deepEqual(out.settled, [...ids].sort());
  const folded = store.readFold(root);
  assert.equal(folded.checks[proposal.id].checkPath, 'rule.js');
  for (const id of ids) assert.match(folded.followups.find((item: any) => item.id === id).fix, /check built at rule\.js/);
  assert.equal(call('rule.js').finding, 'illegal-transition', 'built is terminal');
  assert.equal(decideCheck({ root, proposal: proposal.id, decision: 'decline', reason: 'x' }).finding, 'illegal-transition');
});

test('built settles only the members still open and names the others', () => {
  const { root, ids, proposal } = proposed();
  const { message } = accept(root, proposal.id);
  fs.writeFileSync(path.join(root, 'rule.js'), message);
  followup.settleFollowups({ root, ids: [ids[0]], as: 'dismissed', reason: 'dup' });
  const out = decideCheck({ root, proposal: proposal.id, decision: 'built', check: 'rule.js' });
  assert.equal(out.ok, true);
  assert.deepEqual([out.settled, out.skipped], [[ids[1]], [ids[0]]]);
});

test('an unknown proposal is refused; a malformed call is a usage error', () => {
  const { root, proposal } = proposed();
  assert.equal(accept(root, 'CP-000000').finding, 'unknown-id');
  const usage = (input: any) => assert.throws(() => decideCheck({ root, attendance: ATTENDED, ...input }), followup.FollowupUsageError);
  usage({ proposal: 'nope', decision: 'accept', kind: 'test', alternative: 'x' });
  usage({ proposal: proposal.id, decision: 'maybe' });
  usage({ proposal: proposal.id, decision: 'accept', kind: 'nonsense', alternative: 'x' });
  usage({ proposal: proposal.id, decision: 'accept', kind: 'test' });
  usage({ proposal: proposal.id, decision: 'accept', kind: 'test', alternative: 'x', reason: 'r'.repeat(201) });
  usage({ proposal: proposal.id, decision: 'built' });
  usage({ proposal: proposal.id, decision: 'decline', reason: 'r', kind: 'test' });
});
