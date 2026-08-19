'use strict';
// runtime-evidence-write.test.js — the evidence write boundary and the readiness states it makes
// reachable (plan task C.12; FR-007, FR-008).
//
// Why this file spawns the real CLI rather than calling the libraries: the libraries were never
// the problem. `EvidenceLedger.addEvidence()` and `ClaimsManager.linkEvidence()` were built,
// tested and correct, and nothing in `bin/doflow.js` or `src/runtime/cli.js` called the first of
// them — so FR-007 recorded nothing durable and FR-008's gate had exactly one reachable answer
// (`NEEDS_EVIDENCE`) for every task in every class. A unit test against the ledger would have
// passed throughout. Only the seam shows the defect, so only the seam is asserted here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, "../..");
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

/** A git-backed scratch project. Git-backed because freshness records the observed commit, and a
 *  non-repo temp dir would exercise only the null branch of that measurement. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-evidence-'));
  const real = fs.realpathSync(dir);
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  fs.writeFileSync(path.join(real, 'b.js'), 'require("./a.js");\n');
  const git = (...args) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return real;
}

function run(cwd, args, { input } = {}) {
  const res = spawnSync('node', [DOFLOW, ...args], {
    cwd,
    env: { ...process.env, HOME: cwd },
    input: input ?? '',
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json(cwd, args, { input } = {}) {
  const res = run(cwd, [...args, '--json'], { input });
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch (error) {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

const SOURCE = ['--provider', 'grep', '--capability', 'code.exact-search'];

/** One valid extracted item, as flags. */
function addExtracted(cwd, taskId, locator, extra = []) {
  return json(cwd, ['evidence', '--task-id', taskId, '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', ...SOURCE,
    '--locator', locator, ...extra]);
}

// ─────────────────────────────────────────────────────────── the write exists and is durable

test('C.12: evidence --action add records a durable, provenanced item', () => {
  const cwd = project();
  const added = addExtracted(cwd, 'task-a', 'a.js:1', ['--content', 'module.exports = { x: 1 }']);
  assert.equal(added.status, 0);
  assert.equal(added.data.written, 1);

  const [record] = added.data.evidence;
  assert.equal(record.taskId, 'task-a');
  assert.equal(record.kind, 'exact-search');
  assert.equal(record.provenance, 'extracted');
  assert.deepEqual(record.source, { provider: 'grep', capability: 'code.exact-search' });
  assert.deepEqual(record.locator, { file: 'a.js', line: 1 });

  // Durable, not just echoed back: a separate process reads it from disk.
  const listed = json(cwd, ['evidence', '--task-id', 'task-a']);
  assert.equal(listed.data.evidenceCount, 1);
  assert.equal(listed.data.evidence[0].id, record.id);
  assert.ok(fs.existsSync(path.join(cwd, '.doflow', 'state', 'evidence', 'task-a.json')));
});

test('C.12: a second write appends rather than replacing the task ledger', () => {
  const cwd = project();
  addExtracted(cwd, 'task-a', 'a.js:1');
  addExtracted(cwd, 'task-a', 'b.js:1');
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-a']).data.evidenceCount, 2);
});

test('C.12: freshness is measured at the write boundary, not asserted by the caller', () => {
  const cwd = project();
  const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const [record] = addExtracted(cwd, 'task-a', 'a.js:1').data.evidence;
  assert.equal(record.freshness.gitCommit, head, 'the observed commit is what lets this record expire later');
  assert.match(record.freshness.fileHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.freshness.status, 'FRESH');
  assert.match(record.freshness.observedAt, /^\d{4}-\d{2}-\d{2}T/);

  // A locator naming a path that is not there records the hash as unmeasured, not as a value.
  const [missing] = addExtracted(cwd, 'task-a', 'deleted.js:9').data.evidence;
  assert.equal(missing.freshness.fileHash, null);
  assert.equal(missing.freshness.gitCommit, head);
});

// ─────────────────────────────────────────────────────────── the stage batch (design C5, plan D6)

test('C.12: a stage batch writes every item in one pass, in either spelling', () => {
  const cwd = project();
  const envelope = path.join(cwd, 'stage.json');
  fs.writeFileSync(envelope, JSON.stringify({
    evidence: [
      { kind: 'structural', provenance: 'extracted', source: { provider: 'graphify', capability: 'code.relationships' }, locator: { file: 'a.js', symbol: 'x' } },
      { kind: 'generated-analysis', provenance: 'inferred', source: { provider: 'claude', capability: 'reasoning' }, content: 'x has one caller' },
    ],
  }));
  const written = json(cwd, ['evidence', '--task-id', 'task-b', '--action', 'add', '--batch', envelope]);
  assert.equal(written.status, 0);
  assert.equal(written.data.written, 2);

  const bare = path.join(cwd, 'stage2.json');
  fs.writeFileSync(bare, JSON.stringify([
    { kind: 'test-result', provenance: 'extracted', source: { provider: 'npm', capability: 'behavior.verify' }, locator: 'a.js' },
  ]));
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-b', '--action', 'add', '--batch', bare]).data.written, 1);
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-b']).data.evidenceCount, 3);
});

test('C.12: a batch is validated whole before any of it is written', () => {
  const cwd = project();
  const batch = path.join(cwd, 'stage.json');
  fs.writeFileSync(batch, JSON.stringify([
    { kind: 'structural', provenance: 'extracted', source: { provider: 'graphify', capability: 'code.relationships' }, locator: 'a.js' },
    { kind: 'hunch', provenance: 'extracted', source: { provider: 'graphify', capability: 'code.relationships' }, locator: 'a.js' },
  ]));
  const res = run(cwd, ['evidence', '--task-id', 'task-b', '--action', 'add', '--batch', batch]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /batch item 2 of 2/);
  // The valid first item must not have landed: a half-written stage batch looks complete to
  // every later reader, which is worse than a rejected one.
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-b']).data.evidenceCount, 0);
});

test('C.12: an empty batch is refused rather than reported as a successful write', () => {
  const cwd = project();
  const batch = path.join(cwd, 'stage.json');
  fs.writeFileSync(batch, '[]');
  const res = run(cwd, ['evidence', '--task-id', 'task-b', '--action', 'add', '--batch', batch]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no evidence items/);
});

// ─────────────────────────────────────────────────────────── FR-007: provenance is enforced here

test('C.12: an unknown kind is refused with the valid set', () => {
  const cwd = project();
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'vibes', '--provenance', 'extracted', ...SOURCE, '--locator', 'a.js']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown evidence kind 'vibes'/);
  for (const kind of ['exact-search', 'semantic-retrieval', 'structural', 'test-result', 'generated-analysis']) {
    assert.ok(res.stderr.includes(kind), `the refusal must name the valid set (missing ${kind})`);
  }
});

test('C.12: provenance has no default — an unstated one is refused, not filed as repository fact', () => {
  const cwd = project();
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'exact-search', ...SOURCE, '--locator', 'a.js']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /provenance is required/);
  assert.match(res.stderr, /asserted, extracted, inferred/);
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-a']).data.evidenceCount, 0);
});

test('C.12: model analysis cannot be filed as a repository read', () => {
  const cwd = project();
  for (const kind of ['generated-analysis', 'user-statement']) {
    const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
      '--kind', kind, '--provenance', 'extracted', '--provider', 'claude', '--capability', 'reasoning',
      '--locator', 'a.js', '--content', 'x is unused']);
    assert.equal(res.status, 2, `${kind} must not be recordable as extracted`);
    assert.match(res.stderr, /cannot carry provenance 'extracted'/);
  }
  // The same fact, honestly labelled, is accepted.
  const ok = json(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'generated-analysis', '--provenance', 'inferred', '--provider', 'claude',
    '--capability', 'reasoning', '--content', 'x is unused']);
  assert.equal(ok.status, 0);
  assert.equal(ok.data.evidence[0].provenance, 'inferred');
});

test('C.12: an extracted item must name where it was read; an inferred one must say something', () => {
  const cwd = project();
  const noLocator = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', ...SOURCE, '--content', 'saw it somewhere']);
  assert.equal(noLocator.status, 2);
  assert.match(noLocator.stderr, /requires a locator/);

  const noContent = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'generated-analysis', '--provenance', 'inferred', '--provider', 'claude',
    '--capability', 'reasoning', '--locator', 'a.js']);
  assert.equal(noContent.status, 2);
  assert.match(noContent.stderr, /requires content/);
});

test('C.12: source is required — no unknown/general stand-in reaches the ledger', () => {
  const cwd = project();
  const none = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', '--locator', 'a.js']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /source is required/);

  const half = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'grep', '--locator', 'a.js']);
  assert.equal(half.status, 2);
  assert.match(half.stderr, /source\.capability is required/);
});

// ─────────────────────────────────────────────────────────── FR-007: relevance is not confidence

test('C.12: a retrieval score offered as a flag is refused by name', () => {
  const cwd = project();
  for (const flag of ['--confidence', '--relevance', '--score', '--similarity', '--relevance-score']) {
    const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add',
      '--kind', 'semantic-retrieval', '--provenance', 'extracted', '--provider', 'semble',
      '--capability', 'code.semantic-search', '--locator', 'a.js', flag, '0.92']);
    assert.equal(res.status, 2, `${flag} must be refused`);
    assert.match(res.stderr, /retrieval score/, `${flag} must be refused for the FR-007 reason, not as an unknown flag`);
  }
});

test('C.12: a score smuggled into a batch item is refused, nested or not', () => {
  const cwd = project();
  const cases = [
    { kind: 'semantic-retrieval', provenance: 'extracted', source: { provider: 'semble', capability: 'c' }, locator: 'a.js', confidence: 0.9 },
    { kind: 'semantic-retrieval', provenance: 'extracted', source: { provider: 'semble', capability: 'c', score: 0.9 }, locator: 'a.js' },
    { kind: 'semantic-retrieval', provenance: 'extracted', source: { provider: 'semble', capability: 'c' }, locator: { file: 'a.js', rank: 1 } },
  ];
  for (const [index, item] of cases.entries()) {
    const batch = path.join(cwd, `score-${index}.json`);
    fs.writeFileSync(batch, JSON.stringify([item]));
    const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add', '--batch', batch]);
    assert.equal(res.status, 2, `case ${index} must be refused`);
    assert.match(res.stderr, /retrieval score/);
  }
  assert.equal(json(cwd, ['evidence', '--task-id', 'task-a']).data.evidenceCount, 0);
});

test('C.12: no evidence record carries a numeric confidence field (FR-008)', () => {
  const cwd = project();
  addExtracted(cwd, 'task-a', 'a.js:1', ['--content', 'x']);
  const text = fs.readFileSync(path.join(cwd, '.doflow', 'state', 'evidence', 'task-a.json'), 'utf8');
  for (const banned of ['confidence', 'score', 'relevance', 'similarity', 'probability']) {
    assert.ok(!new RegExp(`"${banned}"`).test(text), `the stored record must not carry a '${banned}' field`);
  }
});

// ─────────────────────────────────────────────────────────── nothing is dropped silently

test('C.12: an unrecognised field is refused, never dropped from a write reported as success', () => {
  const cwd = project();
  const batch = path.join(cwd, 'stage.json');
  fs.writeFileSync(batch, JSON.stringify([{
    kind: 'structural', provenance: 'extracted',
    source: { provider: 'graphify', capability: 'code.relationships' },
    locator: 'a.js', notes: 'a field the ledger has no column for',
  }]));
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add', '--batch', batch]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown evidence field 'notes'/);
  assert.match(res.stderr, /Accepted: kind, provenance, source, locator, content, taskId/);
});

test('C.12: fields the ledger would discard are refused by name, with the reason', () => {
  const cwd = project();
  const base = {
    kind: 'structural', provenance: 'extracted',
    source: { provider: 'graphify', capability: 'code.relationships' }, locator: 'a.js',
  };
  const expectations = [
    ['id', /minted by the ledger/],
    ['freshness', /measured here/],
    ['supports', /claim --action link/],
    ['contradicts', /claim --action link/],
    ['stage', /no stage field/],
  ];
  for (const [field, pattern] of expectations) {
    const batch = path.join(cwd, `refused-${field}.json`);
    fs.writeFileSync(batch, JSON.stringify([{ ...base, [field]: field === 'supports' || field === 'contradicts' ? ['claim_1'] : 'x' }]));
    const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add', '--batch', batch]);
    assert.equal(res.status, 2, `'${field}' must be refused`);
    assert.match(res.stderr, pattern);
  }
});

test('C.12: write arguments on a read action are refused, not ignored', () => {
  // The reported defect: `evidence` accepted append-shaped flags, ignored them, and printed the
  // unchanged ledger — a caller could believe a stage batch had been recorded when nothing was.
  const cwd = project();
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--kind', 'exact-search']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--action add/);
  const unknown = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'append']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown --action 'append'\. Valid: list, add/);
});

test('C.12: a batch item naming a different task is refused', () => {
  const cwd = project();
  const batch = path.join(cwd, 'stage.json');
  fs.writeFileSync(batch, JSON.stringify([{
    kind: 'structural', provenance: 'extracted', taskId: 'some-other-task',
    source: { provider: 'graphify', capability: 'code.relationships' }, locator: 'a.js',
  }]));
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add', '--batch', batch]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /one write, one task/);
});

test('C.12: usage errors honour --json and exit 2', () => {
  const cwd = project();
  const res = run(cwd, ['evidence', '--task-id', 'task-a', '--action', 'add', '--kind', 'vibes',
    '--provenance', 'extracted', ...SOURCE, '--locator', 'a.js', '--json']);
  assert.equal(res.status, 2);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'USAGE');
  assert.equal(payload.exitCode, 2);
  assert.match(payload.summary, /unknown evidence kind/);
});

// ─────────────────────────────────────────── FR-008: all four readiness states, each demonstrated

test('C.12/FR-008: NEEDS_EVIDENCE — the class contract is understood and unmet', () => {
  const cwd = project();
  const res = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a']);
  assert.equal(res.data.state, 'NEEDS_EVIDENCE');
  assert.deepEqual(res.data.callerAsserted, []);
  assert.deepEqual(
    res.data.requirements.filter((r) => !r.satisfied).map((r) => r.id).sort(),
    ['scope_verified', 'target_identified'],
  );
});

test('C.12/FR-008: READY — reachable only because evidence can now be written', () => {
  const cwd = project();
  // Same command, before and after the write: the state must move.
  const before = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a', '--scope', 'a.js only, no dependents']);
  assert.equal(before.data.state, 'NEEDS_EVIDENCE');

  addExtracted(cwd, 'task-a', 'a.js:1', ['--content', 'const x']);
  const after = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a', '--scope', 'a.js only, no dependents']);
  assert.equal(after.data.state, 'READY');
  assert.equal(after.data.evidenceCount, 1);
  const target = after.data.requirements.find((r) => r.id === 'target_identified');
  assert.ok(target.satisfied);
  assert.equal(target.evidenceIds.length, 1, 'the satisfied requirement must name the evidence that satisfied it');
});

test('C.12/FR-008: READY on the heaviest template needs a claim promoted by linked evidence', () => {
  const cwd = project();
  const id = 'task-bug';
  const claim = json(cwd, ['claim', '--task-id', id, '--action', 'add', '--statement', 'x is undefined because a.js exports it late']);
  assert.equal(claim.data.claim.status, 'hypothesis', 'a conclusion starts as a hypothesis (FR-007)');

  const repro = json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'test-result',
    '--provenance', 'extracted', '--provider', 'npm', '--capability', 'behavior.verify',
    '--locator', 'b.js:1', '--content', 'require throws']);
  addExtracted(cwd, id, 'a.js:1', ['--content', 'module.exports']);
  json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'structural',
    '--provenance', 'extracted', '--provider', 'graphify', '--capability', 'code.relationships',
    '--locator', 'b.js:1', '--content', 'one caller']);

  const linked = json(cwd, ['claim', '--task-id', id, '--action', 'link',
    '--claim-id', claim.data.claim.id, '--evidence-id', repro.data.evidence[0].id, '--relation', 'supports']);
  assert.equal(linked.data.status, 'supported', 'only a linked evidence item may promote a hypothesis');

  const ready = json(cwd, ['readiness', '--task-class', 'bug', '--task-id', id, '--verification-plan', 'node --test test/a.test.js']);
  assert.equal(ready.data.state, 'READY');
  assert.deepEqual(ready.data.callerAsserted, ['verificationPlan']);
});

test('C.12/FR-008: BLOCKED — a claim with fresh support and fresh contradiction', () => {
  const cwd = project();
  const id = 'task-conflict';
  const claim = json(cwd, ['claim', '--task-id', id, '--action', 'add', '--statement', 'a.js exports x']);
  const support = addExtracted(cwd, id, 'a.js:1', ['--content', 'module.exports = { x: 1 }']);
  const against = json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'test-result',
    '--provenance', 'extracted', '--provider', 'npm', '--capability', 'behavior.verify',
    '--locator', 'b.js:1', '--content', 'importing x yields undefined']);

  json(cwd, ['claim', '--task-id', id, '--action', 'link', '--claim-id', claim.data.claim.id,
    '--evidence-id', support.data.evidence[0].id, '--relation', 'supports']);
  const conflicted = json(cwd, ['claim', '--task-id', id, '--action', 'link', '--claim-id', claim.data.claim.id,
    '--evidence-id', against.data.evidence[0].id, '--relation', 'contradicts']);
  assert.equal(conflicted.data.status, 'conflicted');

  const res = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', id, '--scope', 'a.js only']);
  assert.equal(res.data.state, 'BLOCKED');
  assert.equal(res.data.claimsSummary.conflicts, 1);
});

test('C.12/FR-008: NEEDS_USER_DECISION — the caller declares a decision is owed', () => {
  const cwd = project();
  addExtracted(cwd, 'task-a', 'a.js:1', ['--content', 'const x']);
  const res = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a',
    '--scope', 'a.js only', '--user-decision-pending']);
  assert.equal(res.data.state, 'NEEDS_USER_DECISION');
  assert.ok(res.data.callerAsserted.includes('userDecisionPending'));
});

test('C.12/FR-008: all four states are reachable, and only those four', () => {
  // The summary assertion of this task. C.5 measured one reachable state; this pins four, so a
  // later change that quietly re-strands one fails here rather than being rediscovered by reading.
  const { READINESS_STATES } = require('../../src/runtime/readiness');
  const cwd = project();
  const reached = new Set();

  reached.add(json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'r1']).data.state);
  addExtracted(cwd, 'r2', 'a.js:1', ['--content', 'const x']);
  reached.add(json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'r2', '--scope', 'a.js']).data.state);
  reached.add(json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'r2', '--scope', 'a.js', '--user-decision-pending']).data.state);

  const claim = json(cwd, ['claim', '--task-id', 'r3', '--action', 'add', '--statement', 'x exists']);
  const yes = addExtracted(cwd, 'r3', 'a.js:1', ['--content', 'x']);
  const no = json(cwd, ['evidence', '--task-id', 'r3', '--action', 'add', '--kind', 'test-result',
    '--provenance', 'extracted', '--provider', 'npm', '--capability', 'behavior.verify',
    '--locator', 'b.js:1', '--content', 'x is undefined']);
  json(cwd, ['claim', '--task-id', 'r3', '--action', 'link', '--claim-id', claim.data.claim.id, '--evidence-id', yes.data.evidence[0].id, '--relation', 'supports']);
  json(cwd, ['claim', '--task-id', 'r3', '--action', 'link', '--claim-id', claim.data.claim.id, '--evidence-id', no.data.evidence[0].id, '--relation', 'contradicts']);
  reached.add(json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'r3', '--scope', 'a.js']).data.state);

  assert.deepEqual([...reached].sort(), [...READINESS_STATES].sort());
});

test('C.12: a stated input is reported as stated, never as evidence', () => {
  // A verdict that mixes measured and asserted inputs must say which is which, or the next reader
  // treats "the caller typed a verification plan" as "a verification plan was established".
  const cwd = project();
  addExtracted(cwd, 'task-a', 'a.js:1', ['--content', 'const x']);
  const res = run(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a', '--scope', 'a.js only']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Caller-stated: scopeClear/);
  assert.match(res.stdout, /not established by evidence/);

  const scopeReq = json(cwd, ['readiness', '--task-class', 'trivial-edit', '--task-id', 'task-a', '--scope', 'a.js only'])
    .data.requirements.find((r) => r.id === 'scope_verified');
  assert.ok(scopeReq.satisfied);
  assert.deepEqual(scopeReq.evidenceIds, [], 'a caller-stated requirement links no evidence, because none backs it');
});

test('C.12: linking a claim to an unrecorded evidence id is refused, not graded', () => {
  // This is what made BLOCKED look unreachable: `evaluateClaim` reads a missing evidence item as
  // *stale support* and answers `invalidated` — a verdict about evidence that never existed.
  const cwd = project();
  const claim = json(cwd, ['claim', '--task-id', 'task-a', '--action', 'add', '--statement', 'x exists']);
  const res = run(cwd, ['claim', '--task-id', 'task-a', '--action', 'link',
    '--claim-id', claim.data.claim.id, '--evidence-id', 'ev_not_real']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no evidence 'ev_not_real' is recorded/);
  assert.equal(json(cwd, ['claim', '--task-id', 'task-a', '--action', 'list']).data.claims[0].status, 'hypothesis');
});

test('C.12: an unsafe task id is a usage error, not an arbitrary file write', () => {
  const cwd = project();
  const res = run(cwd, ['evidence', '--task-id', '../../escape', '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', ...SOURCE, '--locator', 'a.js']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Invalid task id/);
});
