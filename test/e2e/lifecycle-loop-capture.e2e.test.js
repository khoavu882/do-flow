'use strict';
// lifecycle-loop-capture.e2e.test.js: feature 046 scenarios US4 to US7 (failure capture, reports, maintain, goals),
// driven through this checkout's dispatcher against scratch git repositories. Helpers: lifecycle-loop.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SKIP, scratch, PRELOAD, unique, FAULT_READINESS, FAULT_WORKFLOW, READINESS_ARGS, WORKFLOW_ARGS, rt, ok, eventsOf, newProject, folder, track, after10, mergeFeature, addFollowups, listFollowups, gitSnapshot, assertGitUntouched, tree,
} = require('./lifecycle-loop.shared');

after(() => scratch.remove());

// ---------------------------------------------------------------------------------------------
// US4: failure capture

/** A project directory for crash tests, with its own machine-wide failure home. */
function crashSandbox(name) {
  const dir = path.join(scratch.dir, unique(name));
  const project = path.join(dir, 'project');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const events = path.join(xdg, 'doflow', 'failures', 'events.jsonl');
  const lines = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, project, xdg, lines, failures: path.join(xdg, 'doflow', 'failures') };
}

function crash(box, args, fault, { env = {} } = {}) {
  return rt(box.project, args, { xdg: box.xdg, env: { NODE_OPTIONS: `--require ${PRELOAD}`, DOFLOW_FAULT: JSON.stringify(fault), ...env } });
}

/** Stdout, stderr and status are all that a caller of the command can see. */
const seen = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });

describe("Scenario: DoFlow's own crash is captured once (US4, FR-008, FR-010)", { skip: SKIP }, () => {
  test('the same internal error twice in another project is one entry counted twice, and the exit status is unchanged', () => {
    const box = crashSandbox('crash-on');
    const quiet = crashSandbox('crash-quiet');
    const first = crash(box, READINESS_ARGS, FAULT_READINESS);
    const second = crash(box, READINESS_ARGS, FAULT_READINESS);
    const reference = crash(quiet, READINESS_ARGS, FAULT_READINESS, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });

    assert.equal(first.status, 2, `the injected fault must reach the verb's error path: ${first.stderr}`);
    assert.deepEqual(seen(first), seen(reference), 'what the command printed and its exit status are what they are without capture');
    assert.deepEqual(seen(second), seen(reference));

    // The Node writer records the crash; the dispatcher does not count it again (exit 2 is not an odd status).
    const lines = box.lines();
    assert.equal(lines.length, 2, 'one line per failed run, none doubled by the dispatcher');
    for (const line of lines) {
      assert.deepEqual([line.source, line.command, line.kind, line.exit], ['cli', 'readiness', 'TypeError', 2]);
      assert.equal(line.message, 'injected "..." at attempt N', 'the message is masked and normalised');
      assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(line.version && line.version !== '', 'the version is recorded');
      assert.ok(line.project.includes('crash-on'), 'the project it ran in is recorded');
    }

    // From any working directory, the machine-wide list holds one entry with a count of two.
    const list = ok(quiet.project, ['failure', '--action', 'list'], { xdg: box.xdg });
    assert.equal(list.entries.length, 1);
    const [entry] = list.entries;
    assert.deepEqual([entry.count, entry.status, entry.command, entry.kind, entry.message], [2, 'new', 'readiness', 'TypeError', 'injected "..." at attempt N']);
    assert.ok(entry.lastSeen && entry.lastVersion, 'time and version are on the entry');
    assert.deepEqual(list.counts.new, 1);
    assert.equal(quiet.lines().length, 0, 'the reference run recorded nothing');
  });
});

describe('Scenario: Capture turned off (US4, FR-009)', { skip: SKIP }, () => {
  test('with the environment switch off a failing command records nothing and behaves the same', () => {
    const on = crashSandbox('off-env-on');
    const off = crashSandbox('off-env-off');
    const recorded = crash(on, WORKFLOW_ARGS, FAULT_WORKFLOW);
    const silent = crash(off, WORKFLOW_ARGS, FAULT_WORKFLOW, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.equal(recorded.status, 2, recorded.stderr);
    assert.equal(on.lines().length, 1, 'the control run is captured, so the fault does reach the capture point');
    assert.deepEqual(seen(silent), seen(recorded));
    assert.equal(off.lines().length, 0);
    assert.equal(fs.existsSync(off.failures), false, 'capture off creates no folder');
  });

  test('a machine switched off with the sentinel records nothing, whatever the environment says', () => {
    const box = crashSandbox('off-sentinel');
    const control = crashSandbox('off-sentinel-control');
    const set = ok(box.project, ['failure', '--action', 'capture', '--set', 'off'], { xdg: box.xdg });
    assert.equal(set.effective, 'off');
    assert.ok(fs.existsSync(path.join(box.failures, 'off')), 'the sentinel exists');

    const silent = crash(box, WORKFLOW_ARGS, FAULT_WORKFLOW, { env: { DOFLOW_FAILURE_CAPTURE: 'on' } });
    const recorded = crash(control, WORKFLOW_ARGS, FAULT_WORKFLOW);
    assert.equal(silent.status, 2, silent.stderr);
    assert.deepEqual(seen(silent), seen(recorded));
    assert.equal(box.lines().length, 0, 'no line was written while the sentinel exists');
    assert.equal(control.lines().length, 1);
    assert.equal(ok(box.project, ['failure', '--action', 'list'], { xdg: box.xdg }).capture, 'off');

    // Switching it on again removes the sentinel and capture resumes.
    assert.equal(ok(box.project, ['failure', '--action', 'capture', '--set', 'on'], { xdg: box.xdg }).effective, 'on');
    crash(box, WORKFLOW_ARGS, FAULT_WORKFLOW);
    assert.equal(box.lines().length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// US5, US6: reports and maintain

describe('Scenario: A product problem is reported (US5, FR-011)', { skip: SKIP }, () => {
  test('a pasted crash trace becomes a follow-up sourced from the report, names the release, and keeps its secrets out of the repository', () => {
    const repo = newProject('report');
    const before = gitSnapshot(repo);
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';
    const trace = path.join(scratch.dir, `${unique('trace')}.txt`);
    fs.writeFileSync(trace, [
      "TypeError: Cannot read properties of null (reading 'price')",
      '    at cartTotal (cart.js:88)',
      `    Authorization: Bearer ${secret}`,
      `    token=${secret}`,
    ].join('\n'));
    const xdg = path.join(scratch.dir, unique('report-xdg'));
    fs.mkdirSync(xdg);

    const filed = ok(repo.dir, ['followup', '--action', 'report', '--statement', 'Checkout crashes when the cart holds a removed product',
      '--file', trace, '--release', 'v2.3.0'], { xdg });
    const [item] = filed.created;
    assert.deepEqual(item.source, { kind: 'report', release: 'v2.3.0' });
    assert.equal(item.state, 'open');
    assert.equal(item.body, 'on-this-machine');
    assert.ok(item.masked >= 1, 'a secret was masked');

    const listed = listFollowups(repo)[0];
    assert.deepEqual(listed.source, { kind: 'report', release: 'v2.3.0' });
    assert.match(listed.excerpt, /Cannot read properties of null/);
    assert.equal(ok(repo.dir, ['lifecycle']).followups.items[0].source.kind, 'report', 'discovery shows the report as the source');

    // The secret is in no committed-path file, no event and no output; the masked body lives on this machine only.
    const everything = [filed, ...eventsOf(repo)].map((x) => JSON.stringify(x)).join('\n');
    assert.ok(!everything.includes(secret), 'the event and the answer carry no secret');
    for (const rel of tree(repo.dir).filter((f) => fs.statSync(path.join(repo.dir, f)).isFile())) {
      assert.ok(!fs.readFileSync(path.join(repo.dir, rel), 'utf8').includes(secret), `${rel} carries no secret`);
    }
    const reports = path.join(xdg, 'doflow', 'reports');
    const bodies = fs.readdirSync(reports, { recursive: true }).filter((f) => f.endsWith('.txt'));
    assert.equal(bodies.length, 1, 'the body is kept once, under the machine-local reports folder');
    const body = fs.readFileSync(path.join(reports, bodies[0]), 'utf8');
    assert.match(body, /cartTotal \(cart\.js:88\)/);
    assert.ok(!body.includes(secret), 'the stored body is masked too');
    assertGitUntouched(repo, before);
  });
});

describe('Scenario: Maintain settles every item (US6, FR-012)', { skip: SKIP }, () => {
  test('in the DoFlow repository it lists failures and follow-ups, and every settlement is recorded until nothing is pending', () => {
    const repo = newProject('maintain');
    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: '@khoavu882/doflow', version: '0.0.0' }));
    const slug = '080-maint';
    track(repo, slug);
    const items = addFollowups(repo, slug, ['Keep: revisit the cache key', 'Dismiss: old naming nit', 'Promote: split the report module', 'Fix: wrong exit code on empty input']);
    const [toKeep, toDismiss, toPromote, toFix] = items;

    // Two distinct DoFlow crashes land in the machine-wide list this project reads.
    const xdg = path.join(scratch.dir, unique('maintain-xdg'));
    fs.mkdirSync(xdg);
    const box = { project: repo.dir, xdg };
    assert.equal(crash(box, READINESS_ARGS, FAULT_READINESS).status, 2);
    assert.equal(crash(box, WORKFLOW_ARGS, FAULT_WORKFLOW).status, 2);
    const T = new Date().toISOString();

    const queue = ok(repo.dir, ['lifecycle', '--maintain', '--since', T], { xdg });
    assert.equal(queue.mode, 'maintain');
    assert.equal(queue.pending, 4, 'every open item is pending');
    assert.deepEqual(queue.followups.items.map((i) => i.id).sort(), items.map((i) => i.id).sort());
    assert.equal(queue.failures.length, 2, 'both failures are listed in the DoFlow repository');
    assert.ok(queue.failures.every((e) => ['new', 'regressed'].includes(e.status)));

    // Each item is settled with the command the overview's next lines name: kept, dismissed with a reason, promoted, sent to a fix.
    const settle = (id, as, extra = []) => ok(repo.dir, ['followup', '--action', 'settle', '--ids', id, '--as', as, ...extra, '--channel', 'question'], { xdg });
    settle(toKeep.id, 'kept');
    settle(toDismiss.id, 'dismissed', ['--reason', 'superseded by the rename']);
    ok(repo.dir, ['followup', '--action', 'promote', '--ids', toPromote.id, '--title', 'Split the report module', '--channel', 'question'], { xdg });
    settle(toFix.id, 'fix', ['--reason', 'route as a bug run']);

    // Failures: one is noise, one is imported as a follow-up (allowed only in the DoFlow repository).
    const [noise, imported] = queue.failures;
    ok(repo.dir, ['failure', '--action', 'settle', '--fp', noise.fp, '--as', 'noise', '--reason', 'injected by the test'], { xdg });
    const importedResult = ok(repo.dir, ['failure', '--action', 'settle', '--fp', imported.fp, '--as', 'imported'], { xdg });
    assert.deepEqual(importedResult.followup.source, { kind: 'failure', ref: imported.fp });

    // Settled items are recorded: dismissed is gone from the open list, the rest carry their settlement.
    const open = Object.fromEntries(listFollowups(repo).map((i) => [i.id, i]));
    assert.equal(open[toDismiss.id], undefined, 'a dismissed item leaves the open list');
    assert.equal(listFollowups(repo, 'dismissed').length, 1);
    assert.equal(open[toPromote.id].intent, 'agent-docs/intent/split-the-report-module.md');
    assert.ok(open[toFix.id].fix, 'the fix route is recorded on the item');
    assert.ok(open[toKeep.id].history.some((h) => h.type === 'followup.settled'), 'a kept item has its settlement recorded');

    // The loop ends: nothing is pending, no new failure is listed. The imported failure is a new open item, still pending once.
    const rerun = ok(repo.dir, ['lifecycle', '--maintain', '--since', T], { xdg });
    assert.equal(rerun.pending, 1, 'only the follow-up that settling the failure created remains');
    assert.equal(rerun.followups.items.filter((i) => i.pending).length, 1);
    assert.deepEqual(rerun.failures, [], 'no new or regressed failure is left');
    const imp = rerun.followups.items.find((i) => i.pending);
    settle(imp.id, 'kept');
    const done = ok(repo.dir, ['lifecycle', '--maintain', '--since', T], { xdg });
    assert.equal(done.pending, 0, 'maintain has nothing left to settle');
    assert.deepEqual(done.failures, []);
    assert.equal(done.followups.open, 4, 'kept, promoted, fix and imported items stay open; only the dismissed one closed');
  });
});

// ---------------------------------------------------------------------------------------------
// US7: goals

describe('Scenario: Goal progress and done (US7, FR-013, FR-014)', { skip: SKIP }, () => {
  test('discovery shows progress, the agent proposes done when the last outcome is met, and it stays open until the user marks it', () => {
    const repo = newProject('goal');
    const goal = 'public-api-v2';
    const [a, b] = ['090-api-cache', '091-api-auth'];
    const at = [track(repo, a), track(repo, b)];
    const added = ok(repo.dir, ['goal', '--action', 'add', '--goal', goal, '--statement', 'Clients can migrate to the v2 API without downtime',
      '--item', 'v2 endpoints published', '--item', 'v1 clients keep working', '--item', 'Migration guide published']);
    assert.equal(added.ok, true);
    for (const slug of [a, b]) ok(repo.dir, ['goal', '--action', 'link', '--goal', goal, '--slug', slug]);
    after10(repo, ...at);
    mergeFeature(repo, a);

    ok(repo.dir, ['goal', '--action', 'check', '--goal', goal, '--item', 'C1', '--evidence', a]);
    ok(repo.dir, ['goal', '--action', 'check', '--goal', goal, '--item', 'C2', '--evidence', 'contract tests']);
    let shown = ok(repo.dir, ['lifecycle']).goals[0];
    assert.deepEqual([shown.goal, shown.items, shown.proposeDone], [goal, { met: 2, total: 3 }, false]);
    assert.deepEqual(shown.features.finished, [a]);
    assert.deepEqual(shown.features.inProgress, [b]);
    assert.ok(shown.nudges.some((n) => n.startsWith('C3 is unchecked')), 'the unchecked outcome is nudged because a linked feature is finished');

    // The last outcome is met: the agent proposes done, and the goal is still open.
    const last = ok(repo.dir, ['goal', '--action', 'check', '--goal', goal, '--item', 'C3', '--evidence', 'docs/migration.md']);
    assert.equal(last.proposeDone, true, 'the check that meets the last outcome proposes done');
    shown = ok(repo.dir, ['lifecycle']).goals[0];
    assert.deepEqual([shown.items, shown.proposeDone], [{ met: 3, total: 3 }, true]);
    assert.equal(ok(repo.dir, ['goal', '--action', 'list', '--goal', goal]).goals[0].status, 'open');

    // Only the user can close it: the default (agent) channel is refused and changes nothing.
    const eventsBefore = eventsOf(repo).length;
    const refused = rt(repo.dir, ['goal', '--action', 'done', '--goal', goal, '--channel', 'default', '--json']);
    assert.equal(refused.status, 1);
    assert.equal(refused.json.finding, 'not-user');
    assert.equal(eventsOf(repo).length, eventsBefore);
    assert.equal(ok(repo.dir, ['goal', '--action', 'list', '--goal', goal]).goals[0].status, 'open');

    ok(repo.dir, ['goal', '--action', 'done', '--goal', goal, '--channel', 'question']);
    assert.equal(ok(repo.dir, ['goal', '--action', 'list', '--goal', goal]).goals[0].status, 'done');
  });
});

describe('Scenario: Small change without a goal (US7, FR-013)', { skip: SKIP }, () => {
  test('a feature that does not name the goal runs exactly as it would with no goal at all', () => {
    const withGoal = newProject('small-goal');
    const without = newProject('small-none');
    ok(withGoal.dir, ['goal', '--action', 'add', '--goal', 'big-rewrite', '--statement', 'Rewrite the core', '--item', 'Core rewritten']);

    // The same sequence in both projects; the feature never names the goal.
    const run = (repo) => {
      const slug = '095-tiny-fix';
      const trackedAt = track(repo, slug);
      const [item] = addFollowups(repo, slug, ['Mention the flag in the README']);
      after10(repo, trackedAt);
      mergeFeature(repo, slug);
      return {
        status: ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', slug]).status,
        features: ok(repo.dir, ['lifecycle']).features,
        followups: listFollowups(repo).map((i) => [i.statement, i.state, i.source]),
        itemId: item.id,
      };
    };
    const a = run(withGoal);
    const b = run(without);
    assert.equal(a.status, 'finished');
    assert.deepEqual({ ...a, itemId: null }, { ...b, itemId: null }, 'the feature behaves the same with and without a goal in the project');

    const goal = ok(withGoal.dir, ['lifecycle']).goals[0];
    assert.deepEqual([goal.items, goal.proposeDone, goal.nudges], [{ met: 0, total: 1 }, false, []]);
    assert.deepEqual(goal.features, { finished: [], awaitingRelease: [], inProgress: [], unknown: [] }, 'the goal gained no feature');
    assert.equal(eventsOf(withGoal).filter((e) => e.type === 'goal.linked').length, 0, 'nothing linked the feature to the goal');
    assert.deepEqual(ok(without.dir, ['lifecycle']).goals, []);
  });
});

