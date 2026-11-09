'use strict';

// G80 — verb stdout budget (feature 137, FR-001, FR-008)
//
// Every read-only verb is run through the dispatcher on one fixture (200 follow-ups, one checked goal;
// test/helper/verb-fixture.ts) and its normalised stdout is counted in bytes against a ceiling. The
// three verbs that answer in brief are also checked to be projections of their full answers, and the
// paged follow-up list is walked to its end. Every `cliVerbs()` verb is in exactly one of the measured
// table (CEILINGS) and the unmeasured table (UNMEASURED); a verb in neither, or in both, fails by name.
//
// RAISE PROTOCOL. A ceiling rises only in its own commit, whose message states the row, the new measured
// bytes and why the growth is needed. Never inside a change that also edits the verb, and never by
// widening the margin rule (ceilingFor in test/helper/verb-fixture.ts: roundUp64(measured + min(5%, 512 B)),
// 1,024 B for doctor). A row that measures far under its ceiling is lowered the same way.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cliVerbs } = require('./_shared.ts');
const { REPO, IC009_ROWS, FOLLOWUP_COUNT, buildFixture, measureVerb } = require('../helper/verb-fixture.ts');
const { keepPathsOf, resolvesPath, subsetViolations } = require('../helper/view-subset.ts');

/**
 * The measured table: [argv after `doflow-run`, expected exit, ceiling in bytes]. The comment on each row is the
 * measurement the ceiling was set from (built output at commit 68114aaf, compact for the verbs this feature changed).
 */
const CEILINGS: readonly (readonly [string, number, number])[] = [
  ['followup --action list --json', 0, 2752], // 2,600 B (brief, the new default)
  ['followup --action list --view full --json', 0, 91904], // 91,329 B
  ['classify --task-class feature --calling-skill do-design --json', 0, 5888], // 5,606 B
  ['classify --task-class feature --calling-skill do-design --view brief --json', 0, 2624], // 2,443 B
  ['classify --task-class nope --calling-skill do-design --json', 1, 832], // 788 B
  ['lifecycle --action overview --json', 0, 5696], // 5,393 B
  ['lifecycle --action overview --view brief --json', 0, 3136], // 2,973 B
  ['lifecycle --action overview --maintain --json', 0, 17984], // 17,413 B
  ['lifecycle --action overview --maintain --view brief --json', 0, 14528], // 13,965 B
  ['goal --action list --json', 0, 640], // 555 B
  ['workflow --task-class feature --json', 0, 6528], // 6,208 B
  ['rules --json', 0, 6592], // 6,236 B
  ['capabilities --json', 0, 3840], // 3,651 B
  ['discover --json', 0, 2240], // 2,109 B
  ['paths --json', 0, 896], // 841 B
  ['config --json', 0, 49536], // 48,988 B (141: five keys grew it: advice.kinds.rerank, advice.kinds.claim-support, advice.models.rerank, advice.models.claim-support, advice.criteria.rerank; 143: team.enforcement)
  ['doctor --json', 0, 25536], // 24,506 B (1,024 B margin, design R7)
  ['storage --json', 0, 14592], // 14,056 B
  ['indicators --json', 0, 704], // 619 B
  ['package --action list --json', 0, 1344], // 1,220 B
  ['failure --action list --json', 0, 256], // 231 B
  ['git-state --json', 0, 320], // 276 B
  ['inventory --json', 0, 1088], // 1,002 B
  ['attendance --task-id x --json', 0, 64], // 55 B
  ['help', 0, 6656], // 6,282 B (text; the verb has no JSON form; 151: the advice-picks and worker-matrix usage lines)
  ['prereqs --json', 0, 128], // 113 B
  ['models --action list --json', 0, 64], // 19 B
  ['protocol --action list --json', 0, 2688], // 2,522 B
  ['primary --action resolve --json', 0, 192], // 142 B
];

const WRITES_STATE = 'writes-state';
const NEEDS_LIVE_RUN = 'needs-live-run';
const LEDGER_DEPENDENT = 'ledger-dependent';
const INSTALLER = 'installer';
const SERVER = 'server';
const REASONS = [WRITES_STATE, NEEDS_LIVE_RUN, LEDGER_DEPENDENT, INSTALLER, SERVER];

/** The unmeasured table: every other `cliVerbs()` verb with one reason from the closed set above. */
const UNMEASURED: Readonly<Record<string, string>> = {
  advise: NEEDS_LIVE_RUN,
  'brief-tools': NEEDS_LIVE_RUN,
  claim: WRITES_STATE,
  'context-emit': WRITES_STATE,
  'context-grant': WRITES_STATE,
  'context-pack': NEEDS_LIVE_RUN,
  decision: WRITES_STATE,
  dispatch: NEEDS_LIVE_RUN,
  enforcement: NEEDS_LIVE_RUN,
  events: SERVER,
  evidence: WRITES_STATE,
  fleet: NEEDS_LIVE_RUN,
  install: INSTALLER,
  intake: WRITES_STATE,
  'leak-scan': NEEDS_LIVE_RUN,
  'list-backups': INSTALLER,
  'model-role': NEEDS_LIVE_RUN,
  orchestrate: WRITES_STATE,
  outcome: WRITES_STATE,
  'parallel-check': NEEDS_LIVE_RUN,
  'plan-check': NEEDS_LIVE_RUN,
  readiness: NEEDS_LIVE_RUN,
  reconcile: INSTALLER,
  recover: NEEDS_LIVE_RUN,
  remove: INSTALLER,
  'render-audit': NEEDS_LIVE_RUN,
  'render-diagrams': NEEDS_LIVE_RUN,
  'render-puml': NEEDS_LIVE_RUN,
  'research-request': WRITES_STATE,
  'retrieval-plan': NEEDS_LIVE_RUN,
  retrieve: NEEDS_LIVE_RUN,
  review: NEEDS_LIVE_RUN,
  'review-package': NEEDS_LIVE_RUN,
  roadmap: WRITES_STATE,
  rollback: INSTALLER,
  route: NEEDS_LIVE_RUN,
  scaffold: WRITES_STATE,
  'self-update': INSTALLER,
  slot: WRITES_STATE,
  stats: LEDGER_DEPENDENT,
  status: INSTALLER,
  'sync-context': INSTALLER,
  'task-attempt': WRITES_STATE,
  'task-brief': WRITES_STATE,
  tools: INSTALLER,
  trace: LEDGER_DEPENDENT,
  transcript: NEEDS_LIVE_RUN,
  ui: SERVER,
  update: INSTALLER,
  validate: NEEDS_LIVE_RUN,
  verify: NEEDS_LIVE_RUN,
  worker: NEEDS_LIVE_RUN,
  // 150 IC-005: the verb fixture holds no worker run, so these read verbs have nothing to measure.
  'worker-log': NEEDS_LIVE_RUN,
  'worker-result': NEEDS_LIVE_RUN,
  'worker-runs': NEEDS_LIVE_RUN,
  worktree: WRITES_STATE,
};

const DISPATCHER_ARGV = (row: string) => row.split(' ');

/**
 * Checks measured rows against their ceilings.
 * @param {{argv: string, bytes: number, ceiling: number}[]} rows
 * @returns {string[]} one `<argv>: <bytes> B over its <ceiling> B ceiling (+<delta>)` line per row over, all rows
 */
function ceilingViolations(rows: readonly { argv: string; bytes: number; ceiling: number }[]) {
  return rows.filter((r) => r.bytes > r.ceiling).map((r) => `${r.argv}: ${r.bytes} B over its ${r.ceiling} B ceiling (+${r.bytes - r.ceiling})`);
}

/** Every verb in neither table, in both, or unmeasured with a reason outside the closed set; and stale unmeasured rows. */
function coverageViolations(verbs: ReadonlySet<string>, measured: ReadonlySet<string>, unmeasured: Readonly<Record<string, string>>) {
  const out: string[] = [];
  for (const verb of [...verbs].sort()) {
    const inMeasured = measured.has(verb);
    const inUnmeasured = Object.hasOwn(unmeasured, verb);
    if (!inMeasured && !inUnmeasured) out.push(`${verb}: in neither the measured nor the unmeasured table`);
    if (inMeasured && inUnmeasured) out.push(`${verb}: in both the measured and the unmeasured table`);
  }
  for (const [verb, reason] of Object.entries(unmeasured)) {
    if (!verbs.has(verb)) out.push(`${verb}: unmeasured row names a verb that no longer exists`);
    if (!REASONS.includes(reason)) out.push(`${verb}: reason '${reason}' is not one of ${REASONS.join(', ')}`);
  }
  for (const verb of measured) if (!verbs.has(verb)) out.push(`${verb}: measured row names a verb that no longer exists`);
  return out;
}

let fixture: any;
const results: { argv: string; status: number | null; bytes: number; stdout: string }[] = [];
const byArgv = new Map<string, any>();

before(() => {
  fixture = buildFixture();
  for (const [argv] of CEILINGS) {
    const out = measureVerb(fixture, DISPATCHER_ARGV(argv));
    const row = { argv, status: out.status, bytes: out.bytes, stdout: out.stdout };
    results.push(row);
    byArgv.set(argv, row);
  }
});

test('G80: the measured rows are the IC-009 rows, in order', () => {
  assert.deepEqual(CEILINGS.map(([argv]) => DISPATCHER_ARGV(argv)), IC009_ROWS.map((row: any) => [...row]));
});

test('G80: every measured verb answers with its expected exit', () => {
  const wrong = CEILINGS.filter(([argv, exit]) => byArgv.get(argv).status !== exit).map(([argv, exit]) => `${argv}: exit ${byArgv.get(argv).status}, expected ${exit}`);
  assert.deepEqual(wrong, []);
});

test('G80: every measured verb stays within its ceiling', () => {
  const rows = CEILINGS.map(([argv, , ceiling]) => ({ argv, bytes: byArgv.get(argv).bytes, ceiling }));
  assert.deepEqual(ceilingViolations(rows), []);
});

test('G80: every cliVerbs() verb is in exactly one table', () => {
  const measured = new Set(CEILINGS.map(([argv]) => argv.split(' ')[0]));
  assert.deepEqual(coverageViolations(cliVerbs(), measured, UNMEASURED), []);
});

test('G80: the coverage check names a verb in neither table, in both, and one with a stray reason', () => {
  const verbs = new Set(['alpha', 'beta', 'gamma']);
  const found = coverageViolations(verbs, new Set(['alpha', 'beta']), { beta: WRITES_STATE, gamma: 'because' });
  assert.deepEqual(found, ['beta: in both the measured and the unmeasured table', `gamma: reason 'because' is not one of ${REASONS.join(', ')}`]);
  assert.deepEqual(coverageViolations(verbs, new Set(['alpha']), { beta: WRITES_STATE }), ['gamma: in neither the measured nor the unmeasured table']);
});

test('G80 control: a row 2,048 B over its measured size is red, one line per row over', () => {
  const rows = CEILINGS.map(([argv, , ceiling]) => ({ argv, bytes: byArgv.get(argv).bytes, ceiling }));
  assert.deepEqual(ceilingViolations(rows), [], 'the real rows are green');
  const synthetic = rows.map((r, i) => (i < 2 ? { ...r, bytes: r.bytes + 2048 } : r));
  const found = ceilingViolations(synthetic);
  assert.equal(found.length, 2, 'every row over its ceiling is reported, not only the first');
  for (const [i, line] of found.entries()) {
    const over = synthetic[i];
    assert.equal(line, `${over.argv}: ${over.bytes} B over its ${over.ceiling} B ceiling (+${over.bytes - over.ceiling})`);
  }
});

// ------------------------------------------------------------------------------------------ projection

// `omitted` is brief-only: it counts what the brief cut from a list (FU-2jtkch).
const ENVELOPE = ['view', 'shown', 'nextCursor', 'next', 'omitted'];
const FOLLOWUP_CLI = path.join(REPO, 'src', 'runtime', 'lifecycle', 'cli.ts');
const CLASSIFIER = path.join(REPO, 'src', 'runtime', 'task-classifier.ts');

/**
 * Keep paths that hold a value only when the repository is in a state the fixture does not make: `reason` is set
 * when the lifecycle derivation refuses, `integrationBehind` and `note` when the integration branch is behind
 * (src/runtime/lifecycle/overview.ts:219-220), and a goal's `conflicts` when its events collided. They are still checked as leaves wherever a brief answer carries them.
 */
const OVERVIEW_CONDITIONAL = ['$.reason', '$.note', '$.integrationBehind', '$.goals[].conflicts', '$.omitted'];

const SPECS: any[] = [
  { name: 'followup list', file: FOLLOWUP_CLI, constant: 'FOLLOWUP_LIST_BRIEF', brief: 'followup --action list --json', full: 'followup --action list --view full --json', offsets: { items: 0 } },
  { name: 'classify', file: CLASSIFIER, constant: 'CLASSIFY_BRIEF', brief: 'classify --task-class feature --calling-skill do-design --view brief --json', full: 'classify --task-class feature --calling-skill do-design --json' },
  { name: 'lifecycle overview', file: FOLLOWUP_CLI, constant: 'OVERVIEW_BRIEF', brief: 'lifecycle --action overview --view brief --json', full: 'lifecycle --action overview --json', resolveAlso: 'lifecycle --action overview --maintain --json', optional: OVERVIEW_CONDITIONAL, briefPage: true },
  { name: 'lifecycle overview --maintain', file: FOLLOWUP_CLI, constant: 'OVERVIEW_BRIEF', brief: 'lifecycle --action overview --maintain --view brief --json', full: 'lifecycle --action overview --maintain --json', optional: OVERVIEW_CONDITIONAL },
];

for (const spec of SPECS) {
  test(`G80 projection: ${spec.name} brief is a projection of its full answer`, () => {
    const brief = JSON.parse(byArgv.get(spec.brief).stdout);
    const full = JSON.parse(byArgv.get(spec.full).stdout);
    assert.equal(brief.view, 'brief', 'a brief answer carries view "brief"');
    const keep = keepPathsOf(spec.file, spec.constant);
    const also = spec.resolveAlso ? JSON.parse(byArgv.get(spec.resolveAlso).stdout) : null;
    const unresolved = keep.filter((p: string) => !resolvesPath(full, p) && !(also && resolvesPath(also, p)) && !(spec.optional || []).includes(p));
    assert.deepEqual(unresolved, [], 'every keep path resolves on the full answer');
    // A brief overview lists one page of the items the full answer lists, so its own `shown` is the page length
    // (checked here against the items it carries) and is compared to nothing in the full answer.
    const compared = spec.briefPage && brief.followups.shown !== full.followups.shown
      ? { ...brief, followups: { ...brief.followups, shown: full.followups.shown } } : brief;
    if (compared !== brief) assert.equal(brief.followups.shown, brief.followups.items.length, 'brief followups.shown is the number of items it lists');
    assert.deepEqual(subsetViolations(compared, full, { exclude: ENVELOPE, arrayOffsets: spec.offsets }), []);
  });
}

// ------------------------------------------------------------------------------------------ paging

test('G80 paging: following nextCursor from the first brief page visits all 200 ids once, in full order', () => {
  const fullItems = JSON.parse(byArgv.get('followup --action list --view full --json').stdout).items;
  assert.equal(fullItems.length, FOLLOWUP_COUNT);
  const seen: string[] = [];
  let page = JSON.parse(byArgv.get('followup --action list --json').stdout);
  for (let guard = 0; guard < FOLLOWUP_COUNT + 1; guard += 1) {
    assert.equal(page.view, 'brief');
    assert.equal(page.count, FOLLOWUP_COUNT);
    page.items.forEach((item: any, i: number) => {
      const index = seen.length + i;
      assert.deepEqual(item, { id: fullItems[index].id, state: fullItems[index].state, statement: fullItems[index].statement }, `item ${index} matches the full item at the same position`);
    });
    seen.push(...page.items.map((item: any) => item.id));
    if (page.nextCursor === null) break;
    const out = measureVerb(fixture, ['followup', '--action', 'list', '--cursor', page.nextCursor, '--json']);
    assert.equal(out.status, 0);
    page = JSON.parse(out.stdout);
  }
  assert.equal(page.nextCursor, null, 'the last page has nextCursor null');
  assert.deepEqual(seen, fullItems.map((item: any) => item.id), 'all ids once, in the full view order');
  assert.equal(new Set(seen).size, FOLLOWUP_COUNT);
});

// ------------------------------------------------------------------------------------------ AC-4

test('AC-4: the brief overview on the G80 fixture is at most 3,500 B, one page of items, and carries the goal fields callers read', () => {
  const row = byArgv.get('lifecycle --action overview --view brief --json');
  assert.ok(row.bytes <= 3500, `brief overview is ${row.bytes} B, over 3,500 B`);
  const brief = JSON.parse(row.stdout);
  assert.equal(brief.followups.open, FOLLOWUP_COUNT, 'followups.open stays the true count');
  assert.equal(brief.followups.shown, 10, 'one brief page of items');
  assert.equal(brief.followups.items.length, brief.followups.shown, 'followups.shown matches what is listed');
  assert.deepEqual(Object.keys(brief.goals[0]), ['goal', 'outcome', 'items', 'proposeDone', 'nudges'], 'a goal keeps its fields but not its feature lists');
  assert.equal(brief.next.some((line: string) => line.startsWith('Full view')), false, 'no line sends the caller to the unbounded view');
});

// ------------------------------------------------------------------------------------------ FU-2jtkch

test('G80 caps: a brief overview lists at most 10 intents, 10 ids per intent, 10 nudges per goal and 10 finished slugs per nudge, counts the rest, and the full answer keeps all of it', () => {
  const { goalView, capOverviewBrief, FEATURES_SHOWN } = require('../../src/runtime/lifecycle/overview.ts');
  const { projectBrief } = require('../../src/runtime/verb-view.ts');
  const slugs = Array.from({ length: 13 }, (_, i) => `feature-${String(i).padStart(2, '0')}`);
  const goal = { goal: 'G-1', outcome: 'ship', status: 'open', items: Array.from({ length: 14 }, (_, i) => ({ id: `I-${i}`, met: false })) };
  const statuses = { statuses: Object.fromEntries(slugs.map((slug) => [slug, { status: 'finished' }])) };
  const view = goalView(goal, slugs.map((slug) => ({ slug, goal: 'G-1' })), statuses);
  const full: any = {
    ok: true, mode: 'discovery', releaseMode: 'tag', integrationRef: 'develop', gitError: null,
    followups: { open: 0, shown: 0, items: [] },
    intents: Array.from({ length: 12 }, (_, i) => ({ path: `agent-docs/intents/i-${i}.md`, items: Array.from({ length: i === 0 ? 11 : 1 }, (_, j) => `FU-${i}${j}`) })),
    goals: [view], conflicts: [], unreadable: [], unreadableReasons: {}, failures: null, next: [],
  };
  assert.equal(full.goals[0].nudges.length, 14, 'the full answer keeps every nudge');
  assert.equal(full.goals[0].features.finished.length, 13, 'the full answer keeps every finished feature');
  assert.ok(full.goals[0].nudges[0].includes(`(+${13 - FEATURES_SHOWN} more)`) && !full.goals[0].nudges[0].includes('feature-00'), 'a nudge names the most recent finished features only');

  const brief: any = capOverviewBrief(full);
  assert.equal(brief.intents.length, 10);
  assert.equal(brief.intents[0].items.length, 10);
  assert.equal(brief.goals[0].nudges.length, 10);
  assert.deepEqual(brief.omitted, {
    intentItems: [{ path: 'agent-docs/intents/i-0.md', total: 11, more: 1 }],
    intents: { total: 12, more: 2 },
    finished: [{ goal: 'G-1', total: 13, more: 3 }],
    nudges: [{ goal: 'G-1', total: 14, more: 4 }],
  });
  assert.equal(full.intents.length, 12, 'capping does not touch the full answer');
  const keep = keepPathsOf(FOLLOWUP_CLI, 'OVERVIEW_BRIEF');
  assert.deepEqual(subsetViolations(projectBrief(brief, keep), full, { exclude: ENVELOPE }), [], 'the capped brief is a projection of the full answer');
  assert.equal('omitted' in capOverviewBrief({ ...full, intents: [], goals: [] }), false, 'nothing cut, no omitted key');
});
