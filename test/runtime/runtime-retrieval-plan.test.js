'use strict';
// runtime-retrieval-plan.test.js — the declare-then-report contract for retrieval
// (feature 011, plan task B.1, design component C1; FR-010, FR-013, FR-014, FR-015, NFR-001).
//
// Two halves, for two different kinds of claim.
//
// The in-process half replaces `health.probeFreshness` with a spy BEFORE `retrieval-plan.ts` is
// loaded, because that module destructures the function at require time. This is the only way to
// assert the two properties the design spends its risk section on — that a provider is probed once
// per plan and never once per need (R8), and that a STALE index does not produce UNVERIFIED (R10).
// Neither is observable from outside the process: the first is a call count, and the second needs
// a freshness state the local machine may never produce.
//
// The subprocess half spawns the real CLI, because the contract this verb ships is exit codes and
// a record on disk, and a library call proves neither. It follows runtime-evidence-write.test.js
// for the same reason that file gives: the libraries were never the part that broke.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

// ── the probe spy, installed before the module under test is loaded ───────────────────────────

const health = require('../../src/runtime/health.ts');
const realProbeFreshness = health.probeFreshness;

/** Provider ids `probeFreshness` was called with, in order, since the last reset. */
let probeCalls = [];
/** When set, every probe answers with this instead of touching the filesystem. */
let cannedProbe = null;

health.probeFreshness = function spyProbeFreshness(providerId, options) {
  probeCalls.push(providerId);
  if (cannedProbe === null) return realProbeFreshness(providerId, options);
  return typeof cannedProbe === 'function' ? cannedProbe(providerId) : cannedProbe;
};

// Loaded AFTER the spy is in place: the module destructures `probeFreshness` on require.
const {
  handleRetrievalPlanCommand,
  resultForEmptyAnswer,
  planPath,
  RESULTS,
  EMPTY_ANSWER_BY_FRESHNESS,
  FRESHNESS_STATES,
  freshnessEntry,
  sourceModeLookup,
} = require('../../src/runtime/retrieval-plan.ts');
const { resolveNeed } = require('../../src/runtime/retrieval-record.ts');

/** A scratch project root. Nothing here needs git — the plan record stamps no commit. */
function project(label) {
  const real = suiteTempDir(`doflow-runtime-retrieval-plan-${label}-`);
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  return real;
}

/**
 * Calls the verb in-process with stdout captured.
 *
 * `finishRuntime` sets `process.exitCode`, so it is restored afterwards — a verb reporting a
 * finding must not make the whole test process exit non-zero.
 */
function callVerb(options) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let code;
  try {
    code = handleRetrievalPlanCommand(options);
  } finally {
    console.log = realLog;
    process.exitCode = 0;
  }
  return { code, out: lines.join('\n') };
}

function readRecord(root, taskId, slug = null) {
  return JSON.parse(fs.readFileSync(planPath(root, taskId, slug), 'utf8'));
}

// ── R8: one probe per distinct provider, never one per need ──────────────────────────────────

test('a provider is probed once per plan, however many needs resolve to it (design R8)', () => {
  const root = project('probe-count');
  probeCalls = [];
  cannedProbe = null;

  // `trace-dependency` and `estimate-blast-radius` resolve through the same capability chain, so
  // they land on the same provider on every machine — whether that is the code graph or the
  // ripgrep fallback. `locate-known-symbol` is always exact search. So this plan always contains a
  // duplicate provider, without the test needing to know which providers this machine has.
  const { code } = callVerb({
    taskId: 'probes',
    action: 'declare',
    need: ['trace-dependency', 'estimate-blast-radius', 'locate-known-symbol'],
    stateRoot: root,
    repoRoot: REPO,
    json: true,
  });
  assert.equal(code, 0);

  const record = readRecord(root, 'probes');
  assert.equal(record.needs.length, 3);
  const distinct = new Set(record.needs.map((n) => n.provider).filter(Boolean));

  assert.deepEqual([...new Set(probeCalls)].sort(), [...distinct].sort(),
    'the probe set must be exactly the set of distinct providers the plan resolved to');
  assert.equal(probeCalls.length, distinct.size,
    `probeFreshness ran ${probeCalls.length} times for ${distinct.size} distinct provider(s): `
    + `${probeCalls.join(', ')}. Each call walks the project tree to SCAN_FILE_LIMIT, so probing `
    + 'per need is the 4000-file-scan-per-need cost R8 exists to bound');
  assert.ok(probeCalls.length < record.needs.length,
    'this plan has a duplicate provider by construction, so a per-need probe would show up here');
});

// ── D7: freshness lives on the provider, never on the need ───────────────────────────────────

test('a need stores a provider id and nothing about that provider index (plan D7)', () => {
  const root = project('normalised');
  probeCalls = [];
  cannedProbe = null;

  callVerb({
    taskId: 'norm',
    action: 'declare',
    need: ['trace-dependency', 'estimate-blast-radius'],
    stateRoot: root,
    repoRoot: REPO,
    json: true,
  });

  const record = readRecord(root, 'norm');
  for (const need of record.needs) {
    assert.deepEqual(Object.keys(need).sort(), ['capability', 'evidenceIds', 'intent', 'provider', 'queryRef', 'result'],
      'a need carrying a freshness field of its own would let two needs resolving to the same '
      + 'provider disagree about that provider index — a contradiction the record must be unable to hold');
    if (need.provider) {
      assert.ok(record.providers[need.provider],
        'every need must be able to reach its freshness by dereferencing providers{}');
    }
  }
});

// ── the freshness-to-result mapping, exactly as design §4 states it ───────────────────────────

test('the freshness-to-result table maps only an empty answer, and STALE is not UNVERIFIED (R10)', () => {
  assert.deepEqual(EMPTY_ANSWER_BY_FRESHNESS, {
    UNKNOWN: 'UNVERIFIED',
    STALE: 'EMPTY',
    FRESH: 'EMPTY',
    NOT_APPLICABLE: 'EMPTY',
  });
  assert.equal(resultForEmptyAnswer('UNKNOWN'), 'UNVERIFIED');
  assert.equal(resultForEmptyAnswer('STALE'), 'EMPTY',
    'a stale index answered from real data; collapsing it into UNVERIFIED repeats the '
    + 'empty-versus-unreached conflation one level down (design R10)');
  assert.equal(resultForEmptyAnswer('FRESH'), 'EMPTY');
  assert.equal(resultForEmptyAnswer('NOT_APPLICABLE'), 'EMPTY');
  assert.equal(resultForEmptyAnswer('SOMETHING_ELSE'), 'UNVERIFIED',
    'an unrecognised freshness token must fail closed, not read as a negative finding');

  for (const state of FRESHNESS_STATES) {
    assert.ok(RESULTS.includes(resultForEmptyAnswer(state)),
      `${state} must map into the closed result vocabulary`);
  }
});

test('a STALE index yields EMPTY with its staleness and its refresh command (FR-014, R10)', () => {
  const root = project('stale');
  probeCalls = [];
  cannedProbe = {
    state: 'STALE',
    artifact: '/tmp/graph.json',
    refresh: 'graphify update .',
    label: 'code graph',
    reason: 'source has changed since the code graph was built',
  };

  callVerb({ taskId: 'st', action: 'declare', need: ['trace-dependency'], stateRoot: root, repoRoot: REPO, json: true });
  const declared = readRecord(root, 'st');
  const provider = declared.needs[0].provider;
  assert.ok(provider, 'this intent must resolve somewhere for the test to say anything');
  assert.equal(declared.providers[provider].state, 'STALE');
  assert.equal(declared.providers[provider].refresh, 'graphify update .',
    'the refresh command is carried so the report can state the remedy, not only the problem');

  const { code, out } = callVerb({
    taskId: 'st', action: 'report', need: 'trace-dependency', stateRoot: root, repoRoot: REPO,
  });
  const reported = readRecord(root, 'st');
  assert.equal(reported.needs[0].result, 'EMPTY');
  assert.equal(code, 0, 'EMPTY from a locatable index is a negative finding, not an incomplete plan');
  assert.match(out, /stale index/, 'the staleness must travel with the result');
  assert.match(out, /graphify update \./, 'the remedy must be one step away from the finding');
});

test('an UNKNOWN index turns an empty answer into UNVERIFIED, not a finding (FR-014, FR-015)', () => {
  const root = project('unknown');
  probeCalls = [];
  cannedProbe = {
    state: 'UNKNOWN', artifact: null, refresh: 'semble search "<any query>" .',
    label: 'semantic index', reason: 'no semantic index found at any location DoFlow knows to check',
  };

  callVerb({ taskId: 'uv', action: 'declare', need: ['locate-concept'], stateRoot: root, repoRoot: REPO, json: true });
  const { code, out } = callVerb({
    taskId: 'uv', action: 'report', need: 'locate-concept', stateRoot: root, repoRoot: REPO,
  });

  assert.equal(readRecord(root, 'uv').needs[0].result, 'UNVERIFIED');
  assert.equal(code, 1, 'an ungrounded answer is not a completed plan');
  assert.match(out, /UNVERIFIED/);
  assert.match(out, /not a negative finding/,
    'FR-015: the unverifiable-index case must be surfaced where it is used, not in a separate command');
});

// ── 068: a provider with no known artifact layout is judged by its declared sourceMode ─────────

const fixtureCapabilities = {
  'fixture.index-search': { providers: [
    { id: 'fx.indexed', sourceMode: 'index' },
    { id: 'fx.live', sourceMode: 'live' },
  ] },
  'fixture.other': { providers: [{ id: 'fx.live', sourceMode: 'live' }, { id: 'fx.both', sourceMode: 'live' }] },
  'fixture.third': { providers: [{ id: 'fx.both', sourceMode: 'index' }] },
};

test('an index provider absent from PROVIDER_ARTIFACTS records UNKNOWN with no refresh (068)', () => {
  const root = project('src-index');
  cannedProbe = null;
  const entry = freshnessEntry('fx.indexed', root, sourceModeLookup(fixtureCapabilities));
  assert.equal(entry.state, 'UNKNOWN');
  assert.equal(entry.refresh, null);
  assert.equal(entry.artifact, null);
  assert.equal(entry.reason, 'index-backed provider with no artifact layout DoFlow knows; freshness cannot be established');
  assert.equal(EMPTY_ANSWER_BY_FRESHNESS[entry.state], 'UNVERIFIED', 'UNKNOWN reports like the probe-produced UNKNOWN');
});

test('a live provider absent from PROVIDER_ARTIFACTS records NOT_APPLICABLE (068)', () => {
  const root = project('src-live');
  cannedProbe = null;
  const entry = freshnessEntry('fx.live', root, sourceModeLookup(fixtureCapabilities));
  assert.equal(entry.state, 'NOT_APPLICABLE');
  assert.match(entry.reason, /current by construction/);
});

test('a provider the registry does not declare, or declared index anywhere, is never trusted (068)', () => {
  const root = project('src-unknown');
  cannedProbe = null;
  const lookup = sourceModeLookup(fixtureCapabilities);
  assert.equal(freshnessEntry('fx.undeclared', root, lookup).state, 'UNKNOWN');
  assert.equal(freshnessEntry('fx.both', root, lookup).state, 'UNKNOWN', 'index wins when one id is declared both ways');
  assert.equal(freshnessEntry('fx.live', root).state, 'UNKNOWN', 'no lookup supplied fails closed');
});

test('semble and graphify keep their probed state; shipped live providers stay NOT_APPLICABLE (068)', () => {
  const root = project('src-shipped');
  cannedProbe = null;
  const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
  const lookup = sourceModeLookup(new CapabilityRouter({ repoRoot: REPO }).capabilities);
  for (const id of ['semble.search', 'graphify.query']) {
    const entry = freshnessEntry(id, root, lookup);
    assert.deepEqual(entry, (({ state, artifact, refresh, label, reason }) => ({
      state, artifact, refresh: refresh || null, label: label || null, reason: reason || null,
    }))(realProbeFreshness(id, { root })), `${id} entry must come from the probe, unchanged`);
    assert.ok(entry.refresh, `${id} still carries its rebuild command`);
  }
  for (const id of ['native.rg', 'git.native']) {
    assert.equal(freshnessEntry(id, root, lookup).state, 'NOT_APPLICABLE', id);
  }
});

// ── the CLI contract, through the real entrypoint ─────────────────────────────────────────────

function run(cwd, args) {
  const res = spawnSync('node', [DOFLOW, ...args], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json(cwd, args) {
  const res = run(cwd, [...args, '--json']);
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

test('a need no provider can answer is recorded as declared-unresolvable, never dropped (FR-010)', () => {
  const cwd = project('unresolvable');
  // `compress-command` resolves to rtk and declares no fallback, so on a machine without rtk it
  // resolves to nothing. Whichever way this machine answers, the need must appear in the record.
  const declared = json(cwd, ['retrieval-plan', '--task-id', 'u1', '--action', 'declare',
    '--need', 'compress-command,locate-known-symbol']);
  assert.equal(declared.status, 0,
    'an unresolvable need is not a declare-time failure: it stops the stage before it retrieves the '
    + 'needs that ARE resolvable, and it surfaces as UNREACHED at report');
  assert.deepEqual(declared.data.needs.map((n) => n.intent), ['compress-command', 'locate-known-symbol']);

  const unresolvable = declared.data.needs.filter((n) => n.provider === null);
  for (const need of unresolvable) {
    assert.ok(declared.data.unresolvable.includes(need.intent),
      'a need with no provider must be named in the declare output, not left to be inferred');
  }
});

test('every declared item is reported, and an unreached one exits 1 rather than being omitted (FR-010, NFR-004)', () => {
  const cwd = project('report');
  json(cwd, ['retrieval-plan', '--task-id', 'r1', '--action', 'declare',
    '--need', 'locate-known-symbol', '--need', 'inspect-history', '--stage', 'do-design']);

  const report = json(cwd, ['retrieval-plan', '--task-id', 'r1']);
  assert.equal(report.status, 1, 'a plan with an unreached item is not a completed plan');
  assert.equal(report.data.needs.length, 2, 'every declared item is reported, including the unreached');
  assert.deepEqual(report.data.unreached.sort(), ['inspect-history', 'locate-known-symbol']);
  assert.equal(report.data.stage, 'do-design');

  const text = run(cwd, ['retrieval-plan', '--task-id', 'r1']);
  assert.match(text.stdout, /UNREACHED — declared and never asked/,
    'NFR-004: a skip is stated as prominently as a failure');
});

test('recorded evidence lifts a declared need to RETRIEVED and links what it yielded', () => {
  const cwd = project('retrieved');
  json(cwd, ['retrieval-plan', '--task-id', 'g1', '--action', 'declare', '--need', 'inspect-history']);
  const written = json(cwd, ['evidence', '--task-id', 'g1', '--action', 'add',
    '--kind', 'historical', '--provenance', 'extracted',
    '--provider', 'git.native', '--capability', 'history.search', '--locator', 'a.js:1']);
  assert.equal(written.status, 0, written.stderr);

  const report = json(cwd, ['retrieval-plan', '--task-id', 'g1', '--need', 'inspect-history']);
  assert.equal(report.status, 0);
  assert.equal(report.data.needs[0].result, 'RETRIEVED');
  assert.deepEqual(report.data.needs[0].evidenceIds, [written.data.evidence[0].id],
    'the plan must link a need to the ledger ids it produced');
});

test('a need nobody says was asked stays UNREACHED rather than becoming a negative finding', () => {
  const cwd = project('no-claim');
  json(cwd, ['retrieval-plan', '--task-id', 'n1', '--action', 'declare', '--need', 'inspect-history']);
  // No --need on report: the caller states nothing about what ran, and nothing is recorded.
  const report = json(cwd, ['retrieval-plan', '--task-id', 'n1']);
  assert.equal(report.data.needs[0].result, 'UNREACHED');
  assert.equal(report.status, 1);
});

test('reporting an intent the plan never declared is refused, naming what was declared', () => {
  const cwd = project('undeclared');
  json(cwd, ['retrieval-plan', '--task-id', 'd1', '--action', 'declare', '--need', 'inspect-history']);
  const res = run(cwd, ['retrieval-plan', '--task-id', 'd1', '--need', 'locate-concept']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /never declared: locate-concept/);
  assert.match(res.stderr, /Declared: inspect-history/);
});

test('a declare with no need, an unknown action and an unknown intent are each refused by name', () => {
  const cwd = project('refusals');
  const noNeed = run(cwd, ['retrieval-plan', '--task-id', 'x1', '--action', 'declare']);
  assert.equal(noNeed.status, 2);
  assert.match(noNeed.stderr, /needs at least one --need/);

  const badAction = run(cwd, ['retrieval-plan', '--task-id', 'x1', '--action', 'nonsense']);
  assert.equal(badAction.status, 2);
  assert.match(badAction.stderr, /Valid: declare, report/);

  const badIntent = run(cwd, ['retrieval-plan', '--task-id', 'x1', '--action', 'declare', '--need', 'not-a-route']);
  assert.equal(badIntent.status, 2);
  assert.match(badIntent.stderr, /Declared intents: /,
    'a misspelled intent must be refused with the valid set, not recorded as an unresolvable need');
});

test('a task id can never name a path (the evidence ledger rule, unchanged)', () => {
  const cwd = project('safe-id');
  const res = run(cwd, ['retrieval-plan', '--task-id', '../../etc/passwd', '--action', 'declare', '--need', 'inspect-history']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Invalid task id/);
  assert.ok(!fs.existsSync(path.join(cwd, '.doflow', 'state', 'retrieval')),
    'a refused id must not have created the state directory on its way to the refusal');
});

test('no state this verb records is a number, and a score-shaped flag is refused by name (NFR-001)', () => {
  const cwd = project('no-scores');
  const refused = run(cwd, ['retrieval-plan', '--task-id', 's1', '--confidence', '0.9']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /'--confidence' is a retrieval score/);

  json(cwd, ['retrieval-plan', '--task-id', 's1', '--action', 'declare', '--need', 'inspect-history']);
  const record = JSON.parse(fs.readFileSync(path.join(cwd, '.doflow', 'state', 'retrieval', 's1.json'), 'utf8'));
  for (const need of record.needs) {
    assert.ok(RESULTS.includes(need.result), `${need.result} is outside the closed result vocabulary`);
  }
  for (const entry of Object.values(record.providers)) {
    assert.ok(FRESHNESS_STATES.includes(entry.state), `${entry.state} is outside the freshness vocabulary`);
    for (const value of Object.values(entry)) {
      assert.notEqual(typeof value, 'number',
        'a freshness expressed as a number invites arithmetic across indexes measured on different scales');
    }
  }
});

test('reporting a plan that was never declared is a resolution error, not an empty report', () => {
  const cwd = project('no-plan');
  const res = run(cwd, ['retrieval-plan', '--task-id', 'missing']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no retrieval plan is declared/,
    'a report over no plan would state that nothing was missed, which an absent plan cannot establish');
});

test('the verb dispatches through the shell seam, not only through the entrypoint', () => {
  const cwd = project('dispatch');
  const declare = spawnSync('bash', [DISPATCHER, 'retrieval-plan', '--task-id', 'p1',
    '--action', 'declare', '--need', 'inspect-history', '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  assert.equal(declare.status, 0, declare.stderr);
  assert.equal(JSON.parse(declare.stdout).action, 'declare');

  const report = spawnSync('bash', [DISPATCHER, 'retrieval-plan', '--task-id', 'p1', '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  assert.equal(report.status, 1, 'the verb exit code is the dispatcher exit code');
  assert.deepEqual(JSON.parse(report.stdout).unreached, ['inspect-history']);
});

test('the dispatcher help lists the verb it now dispatches', () => {
  const help = spawnSync('bash', [DISPATCHER, '--help'], { env: createScratch('doflow-runtime-retrieval-plan-home-').env(), encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^ {2}retrieval-plan {2,}\S/m,
    'G12 reads this list as the only verb inventory a user ever sees');
});

// ── 076 B.1: planId, queryRefs and active attemptRef at declare (IC-010, IC-011, IC-005) ────

test('declare writes the fields, and version stays 1 (IC-010, B.1)', () => {
  const root = project('declare-fields');
  const { code } = callVerb({
    taskId: 'b1-fields',
    action: 'declare',
    need: ['trace-dependency', 'estimate-blast-radius'],
    stateRoot: root,
    repoRoot: REPO,
    json: true,
  });
  assert.equal(code, 0);

  const record = readRecord(root, 'b1-fields');
  assert.ok(record.planId, 'planId must be present');
  assert.match(record.planId, /^rp_[0-9a-z]+_[0-9a-f]{4}$/, 'planId must match rp_<base36 ms>_<4 hex>');
  assert.equal(record.binding, 'query', 'binding must be query');
  assert.equal(record.version, 1, 'version must stay 1');
  assert.equal(record.attemptRef, null, 'attemptRef is null when no attempt is active');

  assert.equal(record.needs.length, 2);
  for (const need of record.needs) {
    assert.equal(need.queryRef, `${record.planId}#${need.intent}`, 'need.queryRef must be <planId>#<intent>');
  }
});

test('re-declare mints a new planId (IC-011, B.1)', () => {
  const root = project('re-declare');
  callVerb({
    taskId: 'redec',
    action: 'declare',
    need: ['trace-dependency'],
    stateRoot: root,
    repoRoot: REPO,
    json: true,
  });
  const firstRecord = readRecord(root, 'redec');
  assert.ok(firstRecord.planId);

  callVerb({
    taskId: 'redec',
    action: 'declare',
    need: ['trace-dependency'],
    stateRoot: root,
    repoRoot: REPO,
    json: true,
  });
  const secondRecord = readRecord(root, 'redec');
  assert.ok(secondRecord.planId);

  assert.notEqual(secondRecord.planId, firstRecord.planId, 're-declaring must mint a new planId');
});

test("with a claimed 070 attempt the plan's attemptRef is A.1#1 (IC-005, B.1)", (t) => {
  const scratch = createScratch('doflow-declare-attempt-');
  t.after(() => scratch.remove());
  const dir = path.join(scratch.dir, 'project');
  const slug = 'feat-b1';
  fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', slug), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-docs', 'doflow', slug, 'plan.md'), [
    '# Plan', '', '## Tasks', '',
    '### Phase A', '',
    '- [ ] A.1 test task; owner: core-implementer; files: a.js',
  ].join('\n'));
  spawnSync('git', ['init', '-q'], { cwd: dir, env: scratch.env() });

  const claimRes = spawnSync(process.execPath, [
    DOFLOW, 'task-attempt', '--action', 'claim', '--slug', slug, '--task', 'A.1',
    '--owner', 'core-implementer', '--mode', 'subagent', '--json',
  ], { cwd: dir, env: scratch.env(), encoding: 'utf8' });
  assert.equal(claimRes.status, 0, claimRes.stderr);

  const declareRes = json(dir, [
    'retrieval-plan', '--task-id', 'A.1', '--action', 'declare',
    '--need', 'locate-known-symbol', '--slug', slug,
  ]);
  assert.equal(declareRes.status, 0, declareRes.stderr);
  assert.equal(declareRes.data.attemptRef, 'A.1#1');

  const record = readRecord(dir, 'A.1', slug);
  assert.equal(record.attemptRef, 'A.1#1', 'declared plan must stamp attemptRef A.1#1');
});

test('resolveNeed maps declared intents and yields IC-002 refusals (IC-020, IC-002)', () => {
  // 1. Missing plan
  const noPlan = resolveNeed(null, 'need-x', 'task-1');
  assert.equal(noPlan.ok, false);
  assert.equal(
    noPlan.message,
    "no retrieval plan is declared for task 'task-1', so --need 'need-x' names nothing. Declare one first: doflow retrieval-plan --task-id task-1 --action declare --need need-x, then re-run.",
  );

  // 2. Legacy plan without planId
  const legacyPlan = { taskId: 'task-legacy', needs: [{ intent: 'intent-a' }, { intent: 'intent-b' }] };
  const noPlanId = resolveNeed(legacyPlan, 'intent-a');
  assert.equal(noPlanId.ok, false);
  assert.equal(
    noPlanId.message,
    "the retrieval plan for task 'task-legacy' was declared before query binding and has no plan id. Re-declare it: doflow retrieval-plan --task-id task-legacy --action declare --need intent-a, intent-b, then re-run.",
  );

  // 3. Plan with planId but undeclared intent
  const plan = {
    taskId: 'task-bound',
    planId: 'rp_m1_ab12',
    needs: [{ intent: 'intent-a', queryRef: 'rp_m1_ab12#intent-a' }, { intent: 'intent-b', queryRef: 'rp_m1_ab12#intent-b' }],
  };
  const undeclared = resolveNeed(plan, 'intent-c');
  assert.equal(undeclared.ok, false);
  assert.equal(
    undeclared.message,
    "'intent-c' is not a declared need of task 'task-bound' (plan rp_m1_ab12). Declared: intent-a, intent-b. Re-run with one of them, or re-declare the plan with this need.",
  );

  // 4. Declared need resolved
  const resolved = resolveNeed(plan, 'intent-a');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.queryRef, 'rp_m1_ab12#intent-a');
  assert.equal(resolved.need.intent, 'intent-a');
});
