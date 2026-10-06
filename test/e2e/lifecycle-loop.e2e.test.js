'use strict';

// lifecycle-loop.e2e.test.js: feature 046 acceptance scenarios (requirement section 6), driven the
// way a user meets them: through this checkout's dispatcher `core/shared/scripts/doflow/bin/doflow-run`
// against scratch git repositories with real branches, merges and tags. One test per scenario, named
// with the scenario title and its story and requirement ids. Each asserts on what the verb printed and
// on what is on disk: the event files under .doflow/state/lifecycle, nothing staged, no commit, no tag
// and no ignore rule written (DEC-012, NFR-005).
//
// Needs no model and no network. Every spawn runs under a scratch HOME and XDG_CONFIG_HOME and with
// no global git config (DEC-041), and every scratch directory is removed in an `after`.
//
// Time: a feature is tracked at the wall-clock instant `lifecycle --action init` runs, and merge
// evidence only counts when it is committed at or after that instant (IC-021). The git fixtures keep
// their own clock, so every test moves it to just after the newest tracking event it read back from
// disk. That keeps each test independent of the date it runs on, and nothing sleeps.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures');
const { IS_WIN } = require('../helper-platform');

const REPO = path.resolve(__dirname, '..', '..');
const RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SKIP = IS_WIN ? 'doflow-run is a bash script' : false;

const scratch = createScratch('doflow-loop-e2e-');
after(() => scratch.remove());

const CONFIG = path.join(scratch.dir, 'config');
const PRELOAD = path.join(scratch.dir, 'fault-preload.js');
let counter = 0;
const unique = (name) => `${name}-${(counter += 1)}`;

// The fault is injected into the real Node CLI by a preload in NODE_OPTIONS, which the dispatcher's
// own `node` child inherits: the same approach test/e2e/failure-capture-cli.test.js takes with
// `--require`. It replaces one function a verb calls, so the verb dies of an internal TypeError.
fs.writeFileSync(PRELOAD, `'use strict';
const path = require('node:path');
const spec = JSON.parse(process.env.DOFLOW_FAULT || 'null');
if (spec) {
  const mod = require(path.join(${JSON.stringify(REPO)}, spec.module));
  const fail = function injected() { throw new TypeError('injected "secret value" at attempt 42'); };
  if (spec.cls) mod[spec.cls].prototype[spec.method] = fail; else mod[spec.method] = fail;
}
`);
const FAULT_READINESS = { module: 'src/runtime/readiness.js', method: 'evaluateTaskReadiness' };
const FAULT_WORKFLOW = { module: 'src/runtime/workflow-engine.js', cls: 'WorkflowEngine', method: 'resolveWorkflow' };
const READINESS_ARGS = ['readiness', '--task-class', 'feature', '--task-id', 't1', '--json'];
const WORKFLOW_ARGS = ['workflow', '--task-class', 'feature', '--json'];

/** Runs the dispatcher in `cwd`. `xdg` gives a run its own machine-wide failure home. */
function rt(cwd, args, { env = {}, xdg = scratch.xdg, input = '' } = {}) {
  const result = spawnSync('bash', [RUN, ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: scratch.env({
      XDG_CONFIG_HOME: xdg, DOFLOW_CONFIG_DIR: CONFIG,
      DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '', DOFLOW_FAULT: '', NODE_OPTIONS: '',
      ...env,
    }),
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* human output */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/** `rt` that requires exit 0 and a JSON answer. */
function ok(cwd, args, options) {
  const r = rt(cwd, [...args, '--json'], options);
  assert.equal(r.status, 0, `${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.json, `${args.join(' ')} printed no JSON: ${r.stdout}`);
  return r.json;
}

function eventsOf(repo) {
  const dir = path.join(repo.dir, '.doflow', 'state', 'lifecycle', 'events');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).sort().map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
    : [];
}

function newProject(name) {
  const repo = makeRepo(scratch, unique(name));
  repo.dir = fs.realpathSync(repo.dir);
  return repo;
}

function folder(repo, slug) { fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true }); }

/** Creates the feature folder and tracks it through the verb; returns the tracking event's instant. */
function track(repo, slug, extra = []) {
  folder(repo, slug);
  const out = ok(repo.dir, ['lifecycle', '--action', 'init', '--slug', slug, ...extra]);
  assert.equal(out.tracked, 'new');
  return eventsOf(repo).find((e) => e.type === 'feature.tracked' && e.data.slug === slug).at;
}

/** Moves the fixture clock ten minutes past the newest instant given, so later commits count as after tracking. */
function after10(repo, ...instants) {
  repo.at(new Date(Math.max(...instants.map((i) => Date.parse(i))) + 10 * 60000).toISOString());
}

/** A feature branch with one commit, merged into develop with a merge commit; develop is left checked out. */
function mergeFeature(repo, slug) {
  const branch = featureBranch(repo, slug, 1);
  repo.mergeNoFf(branch);
  return branch;
}

function addFollowups(repo, slug, statements, stage = 'review') {
  const file = path.join(scratch.dir, `${unique('batch')}.json`);
  fs.writeFileSync(file, JSON.stringify(statements.map((statement) => ({ statement, stage, source: 'stage' }))));
  return ok(repo.dir, ['followup', '--action', 'add', '--slug', slug, '--stage', stage, '--batch', file]).created;
}

const listFollowups = (repo, state = 'open') => ok(repo.dir, ['followup', '--action', 'list', '--state', state]).items;

/** What git and the working tree held before a verb, so a later check can prove nothing was committed, staged or ignored. */
function gitSnapshot(repo) {
  const exclude = path.join(repo.dir, '.git', 'info', 'exclude');
  return {
    head: repo.git('rev-parse', 'HEAD'),
    refs: repo.git('for-each-ref'),
    exclude: fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null,
    ignoreFiles: ['.gitignore', '.gitattributes'].filter((f) => fs.existsSync(path.join(repo.dir, f))),
  };
}

function assertGitUntouched(repo, before) {
  const now = gitSnapshot(repo);
  assert.equal(now.head, before.head, 'no commit was made');
  assert.equal(now.refs, before.refs, 'no branch or tag was created or moved');
  assert.equal(repo.git('diff', '--cached', '--name-only'), '', 'nothing is staged');
  assert.equal(now.exclude, before.exclude, '.git/info/exclude is untouched');
  assert.deepEqual(now.ignoreFiles, before.ignoreFiles, 'no .gitignore or .gitattributes was written');
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !f.startsWith('.git')).sort();

// ---------------------------------------------------------------------------------------------
// US1, US2: the follow-up list

describe('Scenario: Next feature starts from a follow-up (US1, FR-001, FR-002, FR-003)', { skip: SKIP }, () => {
  test('discovery shows both items with their source, the picked one is taken, and it is done when the feature finishes', () => {
    const repo = newProject('next-feature');
    const first = '050-first';
    const trackedFirst = track(repo, first);
    const [keep, pick] = addFollowups(repo, first, ['Validator misses a stale decision cited in a table cell', 'Retry the flaky export step']);
    const before = gitSnapshot(repo);
    folder(repo, '051-next');
    const filesBefore = tree(repo.dir);

    // Discovery: the first thing the new feature sees, before it asks anything.
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.mode, 'discovery');
    assert.equal(overview.followups.open, 2);
    assert.deepEqual(overview.followups.items.map((i) => i.id).sort(), [keep.id, pick.id].sort());
    for (const item of overview.followups.items) {
      assert.deepEqual(item.source, { kind: 'stage', feature: first, stage: 'review' }, 'each item shows where it came from');
      assert.equal(item.state, 'open');
    }
    assert.ok(overview.next.some((line) => line.includes('lifecycle --action init --slug <slug> --take')), 'the overview says how to take one');
    assert.deepEqual(tree(repo.dir), filesBefore, 'discovery is read-only');

    // The user picks one; the new feature takes it when its folder exists.
    const init = ok(repo.dir, ['lifecycle', '--action', 'init', '--slug', '051-next', '--take', pick.id]);
    assert.deepEqual([init.tracked, init.taken], ['new', [pick.id]]);
    const taken = listFollowups(repo, 'taken');
    assert.deepEqual(taken.map((i) => [i.id, i.takenBy]), [[pick.id, '051-next']]);
    assert.deepEqual(listFollowups(repo).map((i) => i.id), [keep.id], 'the other item stays open');

    // The feature merges; with no release in the project that finishes it, and its item with it.
    const trackedNext = eventsOf(repo).find((e) => e.type === 'feature.tracked' && e.data.slug === '051-next').at;
    after10(repo, trackedFirst, trackedNext);
    mergeFeature(repo, '051-next');
    const finished = ok(repo.dir, ['lifecycle']);
    assert.deepEqual(finished.features.finished, ['051-next']);
    assert.deepEqual(finished.features.inProgress, [first]);
    const done = listFollowups(repo, 'done');
    assert.deepEqual(done.map((i) => [i.id, i.state, i.takenBy]), [[pick.id, 'done', '051-next']]);
    assert.equal(ok(repo.dir, ['followup', '--action', 'list', '--state', 'taken']).count, 0);
    assertGitUntouched(repo, { ...before, head: repo.git('rev-parse', 'HEAD'), refs: repo.git('for-each-ref') });
  });
});

describe('Scenario: A deferral is recorded when it is decided (US2, FR-004)', { skip: SKIP }, () => {
  test('a review that leaves one finding unfixed and one item out of scope hands both to the list with the review stage as source', () => {
    const repo = newProject('deferral');
    const slug = '052-review-handoff';
    track(repo, slug);
    featureBranch(repo, slug, 1);
    const before = gitSnapshot(repo);
    const batch = path.join(scratch.dir, `${unique('review')}.json`);
    fs.writeFileSync(batch, JSON.stringify([
      { statement: 'Finding left unfixed on purpose: the export retries twice', stage: 'review', source: 'stage' },
      { statement: 'Out of scope: a rewrite of the report renderer', stage: 'review', source: 'stage' },
    ]));

    // No --slug: the feature comes from the branch the review ran on, as it does in a real handoff.
    const added = ok(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--batch', batch]);
    assert.equal(added.created.length, 2);
    assert.equal(added.events.length, 2);

    const items = listFollowups(repo);
    assert.equal(items.length, 2);
    for (const item of items) assert.deepEqual(item.source, { kind: 'stage', feature: slug, stage: 'review' });
    assert.deepEqual(items.map((i) => i.statement).sort(), [
      'Finding left unfixed on purpose: the export retries twice', 'Out of scope: a rewrite of the report renderer',
    ]);
    assert.equal(eventsOf(repo).filter((e) => e.type === 'followup.added').length, 2, 'both are events on disk, not prose');
    assertGitUntouched(repo, before);

    // The step is what the handoff guidance tells a stage to run (FR-004).
    const guidance = fs.readFileSync(path.join(REPO, 'core', 'shared', 'guidance', 'references', 'WORKFLOW_HANDOFF.md'), 'utf8');
    assert.match(guidance, /followup --action add --stage/);
  });
});

describe('Scenario: Promote to an intent (US1, FR-005)', { skip: SKIP }, () => {
  test('three related items promoted together give one intent that names all three, and each item shows it', () => {
    const repo = newProject('promote');
    const slug = '053-cart';
    track(repo, slug);
    const items = addFollowups(repo, slug, ['Cart total ignores a removed discount', 'Cart badge counts removed lines', 'Cart restore loses quantities']);
    const before = gitSnapshot(repo);
    const ids = items.map((i) => i.id);

    const promoted = ok(repo.dir, ['followup', '--action', 'promote', '--ids', ids.join(','), '--title', 'Cart robustness', '--channel', 'question']);
    assert.equal(promoted.intent, 'agent-docs/intent/cart-robustness.md');
    assert.deepEqual(promoted.ids.slice().sort(), ids.slice().sort());

    const intent = fs.readFileSync(path.join(repo.dir, promoted.intent), 'utf8');
    assert.match(intent, /^# Intent: Cart robustness/);
    assert.match(intent, /\*\*Raised by:\*\* user/);
    for (const item of items) assert.ok(intent.includes(`- ${item.id}: ${item.statement}`), `the intent names ${item.id} with its statement`);

    for (const item of listFollowups(repo)) {
      assert.equal(item.intent, promoted.intent, `${item.id} shows its intent`);
      assert.equal(item.state, 'open', 'a promoted item stays open');
    }
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.intents.length, 1);
    assert.equal(overview.intents[0].path, promoted.intent);
    assert.deepEqual(overview.intents[0].items.slice().sort(), ids.slice().sort());
    assert.ok(overview.followups.items.every((i) => i.promoted === true));

    // An intent is never overwritten: promoting under the same title is refused and writes nothing.
    const eventsBefore = eventsOf(repo).length;
    const again = rt(repo.dir, ['followup', '--action', 'promote', '--ids', ids[0], '--title', 'Cart robustness', '--json']);
    assert.equal(again.status, 1);
    assert.equal(again.json.finding, 'intent-exists');
    assert.equal(fs.readFileSync(path.join(repo.dir, promoted.intent), 'utf8'), intent);
    assert.equal(eventsOf(repo).length, eventsBefore);
    assertGitUntouched(repo, before);
  });
});

// ---------------------------------------------------------------------------------------------
// US3: finishing

describe('Scenario: Release finishes what it shipped (US3, FR-006, FR-007)', { skip: SKIP }, () => {
  test('the first feature is finished by the record, the second awaits release, and the item the first took is done', () => {
    const repo = newProject('release');
    const [shipped, later] = ['060-shipped', '061-later'];
    const at = [track(repo, shipped), track(repo, later)];
    const [item] = addFollowups(repo, shipped, ['Document the new export flag']);
    ok(repo.dir, ['followup', '--action', 'take', '--ids', item.id, '--slug', shipped]);
    after10(repo, ...at);
    mergeFeature(repo, shipped);
    repo.tag('v1.0.0');
    mergeFeature(repo, later); // merged after the release was cut
    const before = gitSnapshot(repo);

    // The preview names what the release shipped and writes nothing.
    const eventsBefore = eventsOf(repo).length;
    const preview = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0']);
    assert.equal(preview.recorded, false);
    assert.deepEqual(preview.candidates.map((c) => [c.slug, c.evidence]), [[shipped, 'branch']]);
    assert.deepEqual(preview.notDetected, [later]);
    assert.deepEqual(preview.followupsDone, [item.id]);
    assert.equal(eventsOf(repo).length, eventsBefore, 'the preview writes nothing');

    const recorded = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--confirm']);
    assert.equal(recorded.recorded, true);
    const record = eventsOf(repo).filter((e) => e.type === 'release.recorded');
    assert.equal(record.length, 1);
    assert.equal(record[0].data.tag, 'v1.0.0');
    assert.deepEqual(record[0].data.features.map((f) => f.slug), [shipped]);

    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.releaseMode, 'tagged');
    assert.deepEqual(overview.features.finished, [shipped]);
    assert.deepEqual(overview.features.awaitingRelease, [later]);
    assert.deepEqual(overview.features.inProgress, []);
    assert.deepEqual(listFollowups(repo, 'done').map((i) => [i.id, i.state]), [[item.id, 'done']]);
    assert.equal(ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', later]).status, 'awaiting-release');

    // The next release finishes the one that missed this one; the first stays finished.
    repo.tag('v1.1.0');
    const second = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.1.0', '--confirm']);
    assert.deepEqual(second.candidates.map((c) => c.slug), [later]);
    const after = ok(repo.dir, ['lifecycle']);
    assert.deepEqual(after.features.finished.slice().sort(), [shipped, later].sort());
    assert.deepEqual(after.features.awaitingRelease, []);

    // DEC-021: recording a release writes no commit; only the tags this test cut exist.
    assert.equal(repo.git('rev-parse', 'HEAD'), before.head, 'no commit was made');
    assert.deepEqual(repo.git('tag').split('\n').sort(), ['v1.0.0', 'v1.1.0']);
    assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  });
});

describe('Scenario: A project without releases (US3, FR-006)', { skip: SKIP }, () => {
  test('a merged feature is finished at the merge, and never awaits a release', () => {
    const repo = newProject('no-releases');
    const slug = '070-solo';
    const trackedAt = track(repo, slug);
    after10(repo, trackedAt);
    const branch = featureBranch(repo, slug, 1);
    repo.checkout('develop');
    assert.equal(ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', slug]).status, 'in-progress', 'unmerged work is in progress');

    repo.mergeNoFf(branch);
    repo.git('branch', '-q', '-D', branch);
    const status = ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', slug]);
    assert.equal(status.status, 'finished');
    assert.equal(status.evidence.kind, 'merge-subject', 'a deleted branch still finishes by its merge subject');
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.releaseMode, 'untagged');
    assert.deepEqual([overview.features.finished, overview.features.awaitingRelease], [[slug], []]);

    // A tag without the v prefix is not a release either.
    repo.tag('1.2.3');
    assert.equal(ok(repo.dir, ['lifecycle']).releaseMode, 'untagged');
  });
});

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

// ---------------------------------------------------------------------------------------------
// NFR-001: what v1.13.0 did, this checkout still does

/**
 * The v1.13.0 runtime, extracted with `git archive` into the scratch directory. Returns null when
 * this clone has no such tag (a shallow CI checkout), and the caller skips with the reason.
 */
const TAG = 'v1.13.0';
const SKIP_NO_TAG = `the ${TAG} tag is absent from this clone, so the comparison against it did not run (git fetch --tags)`;
let legacyRoot;
function legacyRuntime() {
  if (legacyRoot !== undefined) return legacyRoot;
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${TAG}`], { cwd: REPO }).status === 0;
  if (!exists) { legacyRoot = null; return null; }
  const dir = path.join(scratch.dir, 'legacy-runtime');
  const tarball = path.join(scratch.dir, 'legacy-runtime.tar');
  fs.mkdirSync(dir);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', tarball, TAG], { cwd: REPO, encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-x', '-f', tarball, '-C', dir], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  legacyRoot = dir;
  return dir;
}

/** The dispatcher of a runtime root (this checkout, or the extracted tag). */
const dispatcherOf = (root) => path.join(root, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

function rtWith(root, cwd, args, { input = '' } = {}) {
  const result = spawnSync('bash', [dispatcherOf(root), ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: scratch.env({
      DOFLOW_CONFIG_DIR: path.join(scratch.dir, `config-${path.basename(cwd)}`),
      DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '', DOFLOW_FAULT: '', NODE_OPTIONS: '',
    }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const MIN_HISTORY = '\n## 9. History\n\nNone — initial version.\n';

/** A 045-shaped feature on branch feat/<slug>: requirement and design with a decision register, built by `root`'s runtime. */
function legacyProject(root, name, slug) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch.dir, `${name}-`)));
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env({ GIT_AUTHOR_DATE: '2026-09-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'README.md'), 'legacy project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-b', `feat/${slug}`);
  // The register is created first, as do-brainstorm does for a folder it is creating; the artifacts follow.
  const init = rtWith(root, dir, ['decision', '--action', 'init', '--slug', slug, '--json']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const feature = path.join(dir, 'agent-docs', 'doflow', slug);
  fs.mkdirSync(path.join(feature, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'design'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'intention', 'requirement.md'), `# Requirement\n\n## 1. Overview\n\nA legacy feature.\n${MIN_HISTORY}`);
  fs.writeFileSync(path.join(feature, 'design', 'design.md'), `# Design\n\n## 1. Choices\n\nStore: sqlite (DEC-001).\n${MIN_HISTORY}`);
  const batch = path.join(scratch.dir, `${unique('legacy-decisions')}.json`);
  fs.writeFileSync(batch, JSON.stringify([{ topic: 'store', statement: 'sqlite', channel: 'question', stage: 'design', rationale: 'because store', supersedes: [], refs: [], source: 'intention/q.md#store' }]));
  const added = rtWith(root, dir, ['decision', '--action', 'add', '--batch', batch, '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  return dir;
}

describe('NFR-001: the chain verbs answer as they did under v1.13.0', { skip: SKIP }, () => {
  const slug = '045-legacy-shape';

  // The same verbs, in order, on two identical copies of one project, one per runtime: a verb that
  // writes state (orchestrate, evidence, claim) would otherwise leave its result for the other runtime to find.
  const sequence = [
    ['paths', '--json'],
    ['classify', '--task-class', 'feature', '--json'],
    ['validate', '--json'],
    ['render-audit', '--json'],
    ['readiness', '--task-class', 'feature', '--task-id', slug, '--json'],
    ['orchestrate', '--action', 'start', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['orchestrate', '--action', 'handoff', '--task-id', slug, '--task-class', 'feature', '--calling-skill', 'do-brainstorm', '--note', 'discovery recorded', '--json'],
    ['orchestrate', '--action', 'status', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['decision', '--action', 'list', '--json'],
    ['evidence', '--task-id', slug, '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'local-read', '--capability', 'code.exact-search', '--locator', 'README.md:1', '--establishes', 'target_identified', '--json'],
    ['evidence', '--task-id', slug, '--action', 'list', '--json'],
    ['claim', '--task-id', slug, '--action', 'add', '--statement', 'the legacy project has a readme', '--json'],
    ['claim', '--task-id', slug, '--action', 'list', '--json'],
    ['context-pack', '--task-id', slug, '--task-class', 'feature', '--json'],
    ['git-state', '--json'],
    ['render-audit', '--json'],
  ];

  /** The two runs of one verb, with only named values normalised: the project path, the runtime root, scratch paths, timestamps and generated ids. */
  function normaliser(runtimes, ...dirs) {
    return (text) => {
      let out = text;
      for (const dir of dirs) out = out.split(dir).join('<PROJECT>');
      for (const root of runtimes) out = out.split(root).join('<RUNTIME>');
      return out
        .split(scratch.dir).join('<SCRATCH>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<TIME>')
        .replace(/\b[a-z]+_[0-9a-z]{6,}_[0-9a-f]{8}_\d+\b/g, '<ID>');
    };
  }

  /** Every leaf of `old` is present, unchanged, in `neu`; returns the paths only `neu` has. */
  function additions(old, neu, at = '$') {
    if (Array.isArray(old) || old === null || typeof old !== 'object') {
      assert.deepEqual(neu, old, `${at} changed`);
      return [];
    }
    assert.ok(neu && typeof neu === 'object' && !Array.isArray(neu), `${at} is no longer an object`);
    const added = [];
    for (const key of Object.keys(neu)) if (!(key in old)) added.push(`${at}.${key}`);
    for (const key of Object.keys(old)) {
      assert.ok(key in neu, `${at}.${key} was removed`);
      added.push(...additions(old[key], neu[key], `${at}.${key}`));
    }
    return added;
  }

  test('every chain verb prints the same bytes as the v1.13.0 runtime, apart from time and generated ids', (t) => {
    const legacy = legacyRuntime();
    if (!legacy) { t.skip(SKIP_NO_TAG); return; }
    assert.doesNotMatch(rtWith(legacy, REPO, ['--help']).stdout, /followup|lifecycle/, 'the extracted runtime really is the old one');
    assert.match(rtWith(REPO, REPO, ['--help']).stdout, /followup/);

    const seed = legacyProject(legacy, 'equiv-seed', slug);
    const oldDir = `${seed}-old`;
    const newDir = `${seed}-new`;
    fs.cpSync(seed, oldDir, { recursive: true });
    fs.cpSync(seed, newDir, { recursive: true });
    const norm = normaliser([legacy, REPO], oldDir, newDir);

    const added = new Set();
    for (const args of sequence) {
      const label = args.slice(0, 3).join(' ');
      const was = rtWith(legacy, oldDir, args);
      const now = rtWith(REPO, newDir, args);
      assert.equal(was.status, 0, `${label}: the v1.13.0 side must answer, or the comparison is of two usage errors: ${was.stdout}${was.stderr}`);
      assert.ok(was.stdout.trim().length > 0, `${label}: nothing to compare`);
      assert.equal(now.status, was.status, `${label}: exit status`);
      assert.equal(norm(now.stderr), norm(was.stderr), `${label}: stderr`);
      if (norm(now.stdout) === norm(was.stdout)) continue;
      // Not identical: the new runtime may only have added fields; nothing the old one printed may change.
      let oldJson;
      let newJson;
      try { oldJson = JSON.parse(norm(was.stdout)); newJson = JSON.parse(norm(now.stdout)); } catch { assert.fail(`${label}: stdout differs and is not JSON\n--- v1.13.0\n${norm(was.stdout)}\n--- now\n${norm(now.stdout)}`); }
      for (const field of additions(oldJson, newJson)) added.add(`${label}: ${field}`);
    }
    assert.deepEqual([...added], [], 'the new runtime adds nothing to a chain verb\'s output');

    // The state the two runtimes left behind is the same set of files.
    const filesOf = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !f.startsWith('.git') && fs.statSync(path.join(dir, f)).isFile()).sort();
    assert.deepEqual(filesOf(newDir), filesOf(oldDir), 'the same files exist after the same verbs');
  });
});

describe('Scenario: Older features are untouched (NFR-001)', { skip: SKIP }, () => {
  test('discovery, release and maintain leave a v1.13.0 feature folder and run exactly as they were, and list none of its prose follow-ups', (t) => {
    const legacy = legacyRuntime();
    if (!legacy) { t.skip(SKIP_NO_TAG); return; }
    const slug = '045-older-feature';
    const dir = legacyProject(legacy, 'older', slug);
    const feature = path.join(dir, 'agent-docs', 'doflow', slug);
    // The run, as v1.13.0 recorded it, and a state.md holding prose follow-ups the way older features did.
    const started = rtWith(legacy, dir, ['orchestrate', '--action', 'start', '--task-id', slug, '--task-class', 'feature', '--json']);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    fs.writeFileSync(path.join(feature, 'state.md'), '# State\n\n## Follow-ups\n\n- Tidy the exporter after the release\n- Out of scope: rewrite the renderer\n');

    const hashes = () => {
      const out = {};
      for (const root of [feature, path.join(dir, '.doflow', 'state')]) {
        for (const rel of fs.readdirSync(root, { recursive: true })) {
          const file = path.join(root, rel);
          if (fs.statSync(file).isFile()) out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
        }
      }
      return out;
    };
    const before = hashes();
    assert.ok(Object.keys(before).some((f) => f.includes('orchestration')), 'the old run state exists');
    const git = gitSnapshot({ dir, git: (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env() }).stdout.trim() });
    const T = new Date().toISOString();

    const discovery = ok(dir, ['lifecycle']);
    assert.deepEqual(discovery.followups, { open: 0, shown: 0, items: [] }, 'none of the old prose follow-ups appear');
    assert.deepEqual(discovery.features, { finished: [], awaitingRelease: [], inProgress: [], unknown: [] }, 'an older feature is untracked, so no status is derived');
    const release = ok(dir, ['lifecycle', '--action', 'release', '--tag', 'v1.13.0']);
    assert.deepEqual([release.recorded, release.candidates, release.notDetected], [false, [], []]);
    const maintain = ok(dir, ['lifecycle', '--maintain', '--since', T]);
    assert.equal(maintain.pending, 0);
    assert.equal(maintain.followups.open, 0);
    assert.equal(ok(dir, ['followup', '--action', 'list', '--state', 'all']).count, 0);
    const untracked = rt(dir, ['lifecycle', '--action', 'status', '--slug', slug, '--json']);
    assert.equal(untracked.status, 1);
    assert.equal(untracked.json.finding, 'untracked-feature');

    // The run still resumes under the new runtime, and everything old is byte-for-byte where it was.
    const status = rt(dir, ['orchestrate', '--action', 'status', '--task-id', slug, '--task-class', 'feature', '--json']);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).taskId, slug);
    assert.deepEqual(hashes(), before, 'the feature folder and the run state are unchanged');
    for (const rel of [['.doflow', 'state', 'lifecycle'], ['agent-docs', 'lifecycle']]) {
      assert.equal(fs.existsSync(path.join(dir, ...rel)), false, `reading wrote no ${rel.join('/')}`);
    }
    assertGitUntouched({ dir, git: (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: scratch.env() }).stdout.trim() }, git);
  });
});
