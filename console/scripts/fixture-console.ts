'use strict';

// The fixture Console (feature 093, C.2; design C14, IC-015). Dev only: console/scripts/ is not in the
// package's `files`. It builds a scratch HOME, XDG config home and a git project with the REAL core's
// verbs (the builders of test/helpers/core-fixture.ts, then more runs on top), starts bin/doflow-ui.js
// on 127.0.0.1:0 against it, and prints the Console's one URL line on stdout. It is the only Console a
// designer or a browser check may open. Everything else it says goes to stderr.
//
//   node console/scripts/fixture-console.ts --core <abs path to bin/doflow.js> [--empty] [--core-missing] [--keep] [--tick <seconds>] [--append <seconds>]
//
//   --empty          a project with no runs (the empty views)
//   --core-missing   the Console boots against a symlink to the core so its handshake passes, and the
//                    link is removed once the URL line is out: every later call is core-unreachable
//                    (503), the state the no-runtime view needs. The version and capabilities caches
//                    are empty at that moment, so nothing hides it; do not call the Console first.
//   --keep           leave the scratch directory in place on exit (its path goes to stderr)
//   --tick <seconds> every <seconds>, take the next step of the live run `run-tick`: complete design,
//                    complete planning (the run now awaits gate-a), approve gate-a (it is RUNNING in
//                    implementation). A line `tick` on stdin takes the same next step at once. The
//                    steps end there: completing implementation needs a readiness record, which a
//                    fixture does not make.
//   --append <seconds> every <seconds> (and on a stdin line `append`), the appending writer adds a reply, a tool call and its
//                    result to the Claude fixture transcript of the Fleet view; the Console shows them within a second.
//
// Ctrl-C (SIGINT) or SIGTERM stops the Console and removes the scratch directories (exact paths, all
// under SCRATCH_ROOT) unless --keep.
//
// The Sessions view (E.7) has its own run, feat-sessions: two overlapping tasks claimed by two runs and a 30 h claim
// (the ledger's startedAt moved back, like the stale run's times); hook records written by the REAL hook scripts
// (observe-model.sh through bridge.sh, session-context.sh) in the scratch HOME; a held slot with a dead holder, one
// whose liveness is unknown and one held from a second project; a commit in the linked worktree newer than every
// record there (outside DoFlow); and a second project whose sessions must never reach the Console.
//
// The Fleet view (V.10) has its own world, written into the same scratch HOME: a second DoFlow project (`beta`) next to the
// Console's own, the synthetic transcript homes of V.2 (test/fixtures/transcripts/v8, one per harness, aimed at the Console's
// project), hook sessions for four harnesses (claude with two subagents, codex, antigravity, opencode) and a one-file wrapper
// around --core that lists the fixture projects (they sit under a temporary directory, which the real `fleet` verb hides).
//
// Two journal edits no verb can make, both through the record's own fields in the run's journal file:
// the stale run's startedAt, updatedAt and history times are moved back 48 h (the core stamps the
// clock and takes none), and the shape-mismatch run's `program` loses its `verification` node (a run
// started on an older workflow; the core only ever compiles the current one).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildFixture, SLUGS, CONSTITUTION_CHECK, PASSING_PLAN } = require('../test/helpers/core-fixture.ts');

/**
 * Every directory this script makes is made directly under this root, and only those exact paths are
 * removed on exit. core-fixture.ts's buildFixture makes its directory in os.tmpdir() and cannot be
 * changed from here, so TMPDIR is pointed at the root for the length of that call (os.tmpdir() reads it
 * each time); the fixture environment it copies then carries the same TMPDIR to the Console child.
 */
const SCRATCH_ROOT = '/private/tmp/claude-504/093';

const BIN = path.join(__dirname, '..', 'bin', 'doflow-ui.js');
const URL_LINE = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})\n/;
const BOOT_MS = 30_000;
const STOP_MS = 5_000;
const HOUR = 60 * 60 * 1000;
const USAGE = 'usage: fixture-console.ts --core <absolute path to bin/doflow.js> [--empty] [--core-missing] [--keep] [--tick <seconds>] [--append <seconds>]';
const REPO = path.resolve(__dirname, '..', '..');
/** The session ids of the V.2 transcript fixtures (test/fixtures/transcripts/v8): `<RAW>c001` is the Claude main session. */
const RAW = 'fa000000-0000-4000-8000-00000000';

/** Slug and task id of every run this script adds to the helper's five (SLUGS in core-fixture.ts). */
const RUNS = Object.freeze({
  work: { slug: 'feat-work', taskId: 'run-work' }, // RUNNING in implementation; 12-task plan, attempts in every state
  tick: { slug: 'feat-tick', taskId: 'run-tick' }, // RUNNING in design; no plan; the live run of --tick
  approval: { slug: 'feat-approval', taskId: 'run-approval' }, // AWAITING_GATE at gate-a (approval); a plan with no attempts
  done: { slug: 'feat-done', taskId: 'run-done' }, // COMPLETED (documentation: one stage skipped); no plan
  rejected: { slug: 'feat-rejected', taskId: 'run-rejected' }, // REJECTED at gate-a
  stale: { slug: 'feat-stale', taskId: 'run-stale' }, // RUNNING, silent for 48 h
  shape: { slug: 'feat-shape', taskId: 'run-shape' }, // RUNNING, program one node short of the workflow
  sessions: { slug: 'feat-sessions', taskId: 'run-sessions' }, // RUNNING in implementation; S.1 and S.2 overlap and are claimed by two runs, S.3 is a 30 h claim
});

const OWNERS = Object.freeze(['core-implementer', 'quality-guardian', 'system-architect']);

/** 12 tasks over 3 owners, three phases; the declared owner is the lane of a task with no active attempt. */
const WORK_PLAN = [
  '# Plan', '', '**Task graph:** v1', '', ...CONSTITUTION_CHECK, '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 [P] first step; owner: core-implementer; files: src/a1.js',
  '- [ ] A.2 [P] second step; owner: quality-guardian; files: src/a2.js',
  '- [ ] A.3 [P] third step; owner: system-architect; files: src/a3.js',
  '- [ ] A.4 [P] fourth step; owner: core-implementer; files: src/a4.js',
  '', '### Phase B', '',
  '- [ ] B.1 depends on A.1; owner: core-implementer; files: src/b1.js; depends-on: A.1',
  '- [ ] B.2 depends on A.2; owner: quality-guardian; files: src/b2.js; depends-on: A.2',
  '- [ ] B.3 depends on A.3; owner: system-architect; files: src/b3.js; depends-on: A.3',
  '- [ ] B.4 depends on A.4; owner: core-implementer; files: src/b4.js; depends-on: A.4',
  '', '### Phase C', '',
  '- [ ] C.1 joins B.1 and B.2; owner: quality-guardian; files: src/c1.js; depends-on: B.1, B.2',
  '- [ ] C.2 follows B.2; owner: quality-guardian; files: src/c2.js; depends-on: B.2',
  '- [ ] C.3 follows B.3; owner: system-architect; files: src/c3.js; depends-on: B.3',
  '- [ ] C.4 closes the plan; owner: core-implementer; files: src/c4.js; depends-on: C.1, C.2, C.3',
  '',
].join('\n');

/** Three tasks in a graph plan; the run that uses it has no attempts ("a plan without attempts"). */
const APPROVAL_PLAN = [
  '# Plan', '', '**Task graph:** v1', '', ...CONSTITUTION_CHECK, '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 [P] first step; owner: core-implementer; files: src/p1.js',
  '- [ ] A.2 [P] second step; owner: quality-guardian; files: src/p2.js',
  '- [ ] A.3 third step; owner: core-implementer; files: src/p3.js; depends-on: A.1, A.2',
  '',
].join('\n');

/** Three tasks: S.1 and S.2 declare the same file (an overlap), S.3 is the long claim. */
const SESSIONS_PLAN = [
  '# Plan', '', '**Task graph:** v1', '', ...CONSTITUTION_CHECK, '## Tasks', '',
  '### Phase A', '',
  '- [ ] S.1 [P] first writer; owner: core-implementer; files: src/shared.js, src/s1.js',
  '- [ ] S.2 [P] second writer; owner: quality-guardian; files: src/shared.js, src/s2.js',
  '- [ ] S.3 [P] long claim; owner: system-architect; files: src/s3.js',
  '',
].join('\n');

/**
 * The helper's `feat-broken` run is live with a plan.md that has no tasks (plan-malformed). Sessions inspects every live
 * run's plan and, by IC-018 e, a failed inspect fails the whole `tasks` section, so with that plan in place no claim or
 * overlap would show. The full fixture mends it to a one-task graph plan; read-contract.test.ts keeps the helper's own.
 */
const MENDED_PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '', '- [ ] A.1 only step; owner: core-implementer; files: src/broken.js', ''].join('\n');

/** The second run of the overlap, and the launched unit that belongs to it (`L.<run>.<lineage>.<attempt>`). */
const SECOND_RUN = Object.freeze({ run: 'run-two', lineage: 'lin2', attempt: '1' });

type Options = { core: string, empty?: boolean, coreMissing?: boolean, keep?: boolean, log?: (line: string) => void };
type Fixture = ReturnType<typeof buildFixture>;
type Handle = {
  url: string, port: number, code: string, dir: string, project: string, env: Record<string, string>,
  runs: Array<{ taskId: string, slug: string | null, state: string }>,
  /** The exact directories this fixture made (project and, with coreMissing, the core symlink's); all are removed by stop() unless keep. */
  scratch: string[],
  /** Takes the next step of the live run; the step's description, or null when none is left. */
  tick(): string | null,
  /** The appending writer: adds a reply, a tool call and its result to the Claude fixture transcript; what it wrote, or null with no Fleet world. */
  append(): string | null,
  /** The Claude fixture transcript the writer appends to. */
  transcript: string,
  stop(): Promise<void>,
};

/** The fixture environment of the core's calls, with the upkeep switch on: building must not run upkeep. */
function coreCaller(core: string, cwd: string, env: Record<string, string>, extra: Record<string, string> = {}) {
  const buildEnv = { ...env, DOFLOW_UPKEEP: 'off', ...extra };
  return (...args: string[]): any => {
    const result = spawnSync(process.execPath, [core, ...args, '--json'], { cwd, env: buildEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`fixture-console: doflow ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  };
}

/** The journal file of a run in the project's store, parsed; `write` puts it back. */
function journalOf(main: string, slug: string, taskId: string) {
  const file = path.join(main, '.doflow', 'state', 'orchestration', slug, `${taskId}.json`);
  return { record: JSON.parse(fs.readFileSync(file, 'utf8')), write: (record: unknown) => fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`) };
}

/** The runs and attempts of the full fixture, on top of the helper's five runs. Returns the live run's steps. */
function addRuns(fixture: Fixture, core: string): Array<{ describe: string, args: string[], before?: () => void }> {
  const { main } = fixture;
  const call = coreCaller(core, main, fixture.env);
  const orchestrate = (...args: string[]) => call('orchestrate', ...args);
  for (const { slug } of Object.values(RUNS)) {
    fs.mkdirSync(path.join(main, 'agent-docs', 'doflow', slug), { recursive: true });
    fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', slug, 'requirement.md'), `# ${slug}\n`);
  }
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.work.slug, 'plan.md'), WORK_PLAN);
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.approval.slug, 'plan.md'), APPROVAL_PLAN);
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.sessions.slug, 'plan.md'), SESSIONS_PLAN);
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.rejected.slug, 'plan.md'), PASSING_PLAN); // the planning exit (row 134) needs a plan

  const start = (run: { slug: string, taskId: string }, taskClass: string) => orchestrate('--action', 'start', '--task-id', run.taskId, '--task-class', taskClass, '--slug', run.slug);
  const complete = (run: { slug: string, taskId: string }, stage: string) => orchestrate('--action', 'complete-stage', '--task-id', run.taskId, '--stage', stage, '--result', 'passed', '--slug', run.slug);
  const decide = (run: { slug: string, taskId: string }, gate: string, decision: string, ...more: string[]) => orchestrate('--action', 'decide-gate', '--task-id', run.taskId, '--gate', gate, '--decision', decision, ...more, '--slug', run.slug);
  const expectState = (answer: any, state: string, label: string) => {
    if (answer.state !== state) throw new Error(`fixture-console: ${label} is ${answer.state}, wanted ${state}`);
  };

  // To the point where design is next: discovery passed, gate-0 (clarification) approved.
  const toDesign = (run: { slug: string, taskId: string }, ...force: string[]) => {
    start(run, 'feature');
    expectState(complete(run, 'discovery'), 'AWAITING_GATE', `${run.taskId} at gate-0`);
    expectState(decide(run, 'gate-0', 'approve', ...force), 'RUNNING', `${run.taskId} after gate-0`);
  };
  // To gate-a (approval): design and planning passed.
  const toGateA = (run: { slug: string, taskId: string }) => {
    complete(run, 'design');
    expectState(complete(run, 'planning'), 'AWAITING_GATE', `${run.taskId} at gate-a`);
  };

  // COMPLETED: a documentation run with its optional verification stage skipped.
  start(RUNS.done, 'documentation');
  complete(RUNS.done, 'authoring');
  orchestrate('--action', 'skip-stage', '--task-id', RUNS.done.taskId, '--stage', 'verification', '--reason', 'fixture', '--slug', RUNS.done.slug);
  expectState(complete(RUNS.done, 'review'), 'COMPLETED', RUNS.done.taskId);

  // REJECTED at gate-a.
  toDesign(RUNS.rejected);
  toGateA(RUNS.rejected);
  expectState(decide(RUNS.rejected, 'gate-a', 'reject'), 'REJECTED', RUNS.rejected.taskId);

  // AWAITING_GATE at gate-a (approval; the helper's run-gate waits at gate-0, a clarification).
  toDesign(RUNS.approval);
  toGateA(RUNS.approval);

  // RUNNING in implementation, with the 12-task plan. gate-0 is approved forced, so the rail has a forced gate.
  toDesign(RUNS.work, '--forced', '--note', 'fixture: forced');
  toGateA(RUNS.work);
  expectState(decide(RUNS.work, 'gate-a', 'approve'), 'RUNNING', RUNS.work.taskId);
  addAttempts(call, RUNS.work.slug);

  // RUNNING in implementation with the Sessions plan; its claims, the hook records and the locks come after the runs.
  toDesign(RUNS.sessions);
  toGateA(RUNS.sessions);
  expectState(decide(RUNS.sessions, 'gate-a', 'approve'), 'RUNNING', RUNS.sessions.taskId);

  // RUNNING in design: the live run (see the header).
  toDesign(RUNS.tick);

  // RUNNING, silent for 48 h: the journal's times moved back (no verb takes a clock).
  start(RUNS.stale, 'feature');
  const stale = journalOf(main, RUNS.stale.slug, RUNS.stale.taskId);
  const back = (iso: string) => new Date(Date.parse(iso) - 48 * HOUR).toISOString();
  stale.record.startedAt = back(stale.record.startedAt);
  stale.record.updatedAt = back(stale.record.updatedAt);
  for (const entry of stale.record.history) entry.at = back(entry.at);
  stale.write(stale.record);

  // RUNNING on a program one node short of the workflow (progress.total 8, the workflow has 9).
  start(RUNS.shape, 'feature');
  const shape = journalOf(main, RUNS.shape.slug, RUNS.shape.taskId);
  shape.record.program = shape.record.program.filter((node: any) => node.id !== 'verification');
  shape.write(shape.record);

  addSessions(fixture, core, call);

  const live = RUNS.tick;
  return [
    { describe: `${live.taskId}: design completed`, args: ['orchestrate', '--action', 'complete-stage', '--task-id', live.taskId, '--stage', 'design', '--result', 'passed', '--slug', live.slug] },
    { describe: `${live.taskId}: planning completed, awaiting gate-a`, before: () => fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', live.slug, 'plan.md'), PASSING_PLAN), args: ['orchestrate', '--action', 'complete-stage', '--task-id', live.taskId, '--stage', 'planning', '--result', 'passed', '--slug', live.slug] },
    { describe: `${live.taskId}: gate-a approved, implementation running`, args: ['orchestrate', '--action', 'decide-gate', '--task-id', live.taskId, '--gate', 'gate-a', '--decision', 'approve', '--slug', live.slug] },
  ];
}

/**
 * Attempts on the 12-task plan: finished (A.1, A.2, B.2), failed then claimed again (A.3), released
 * and left (A.4), and active in each of three lanes (A.3 retry, B.1, C.2).
 */
function addAttempts(call: (...args: string[]) => any, slug: string) {
  const attempt = (...args: string[]) => call('task-attempt', '--slug', slug, ...args);
  const claim = (task: string, owner: string, mode: string) => attempt('--action', 'claim', '--task', task, '--owner', owner, '--mode', mode, '--epoch', '1');
  // COMPLETED needs a passing test-result item in the evidence ledger, observed after the claim.
  const passing = (task: string) => call('evidence', '--action', 'add', '--task-id', task, '--slug', slug, '--kind', 'test-result', '--provenance', 'extracted',
    '--provider', 'shell', '--capability', 'test', '--locator', 'README.md', '--content', 'fixture run', '--observed-command', 'node --test', '--observed-exit', '0').evidence[0].id;
  const finish = (task: string, token: any, result: string) => attempt('--action', 'finish', '--task', task, '--token', String(token), '--result', result, '--reason', 'fixture',
    ...(result === 'COMPLETED' ? ['--evidence-id', passing(task)] : []));
  attempt('--action', 'start', '--by', 'orchestrator');
  finish('A.1', claim('A.1', 'core-implementer', 'subagent').token, 'COMPLETED');
  finish('A.2', claim('A.2', 'quality-guardian', 'manual').token, 'COMPLETED');
  finish('A.3', claim('A.3', 'system-architect', 'subagent').token, 'FAILED');
  claim('A.3', 'system-architect', 'sequential'); // active: the retry
  attempt('--action', 'release', '--task', 'A.4', '--token', String(claim('A.4', 'core-implementer', 'manual').token), '--reason', 'fixture');
  claim('B.1', 'core-implementer', 'subagent'); // active
  finish('B.2', claim('B.2', 'quality-guardian', 'manual').token, 'COMPLETED');
  claim('C.2', 'quality-guardian', 'sequential'); // active
}

/** `git` in a fixture repository, with the fixture identity and an optional committer date. */
function gitIn(fixture: Fixture, cwd: string, args: string[], date?: string) {
  const env = { ...fixture.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) };
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=DoFlow UI Fixture', '-c', 'user.email=doflow-ui-fixture@example.test', ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`fixture-console: git ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The Sessions fixture (design 7a): claims, hook records from the real scripts, locks, an outside-DoFlow commit and a
 * second project. Everything is written into the scratch HOME, config home and user state of `fixture`.
 */
function addSessions(fixture: Fixture, core: string, call: (...args: string[]) => any) {
  const { main, linked } = fixture;
  const slug = RUNS.sessions.slug;
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', SLUGS.broken, 'plan.md'), MENDED_PLAN);

  // Claims: S.1 from the main session's run, S.2 from a second run (the overlap is held by two runs), S.3 left long.
  const second = coreCaller(core, main, fixture.env, { DOFLOW_RUN_ID: SECOND_RUN.run, DOFLOW_LINEAGE_ID: SECOND_RUN.lineage });
  const attempt = (caller: (...args: string[]) => any, ...args: string[]) => caller('task-attempt', '--slug', slug, ...args);
  attempt(call, '--action', 'start', '--by', 'orchestrator');
  attempt(call, '--action', 'claim', '--task', 'S.1', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '1');
  attempt(second, '--action', 'start', '--by', 'orchestrator'); // a run key of its own needs its own start
  attempt(second, '--action', 'claim', '--task', 'S.2', '--owner', 'quality-guardian', '--mode', 'subagent', '--epoch', '1');
  const long = attempt(call, '--action', 'claim', '--task', 'S.3', '--owner', 'system-architect', '--mode', 'manual', '--epoch', '1');
  // A 30 h claim: no verb takes a clock, so the ledger's startedAt of that attempt is moved back, as the stale run's times are.
  const ledger = path.join(main, '.doflow', 'state', 'task-attempts', `${slug}.json`);
  const record = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  let moved = 0;
  for (const attempts of Object.values(record.tasks ?? {}).map((entry: any) => entry.attempts ?? [])) {
    for (const entry of attempts as any[]) {
      if (entry.token === long.token && entry.owner === 'system-architect') { entry.startedAt = new Date(Date.now() - 30 * HOUR).toISOString(); moved += 1; }
    }
  }
  if (moved !== 1) throw new Error(`fixture-console: the S.3 claim was not found in ${ledger} (${moved})`);
  fs.writeFileSync(ledger, `${JSON.stringify(record, null, 2)}\n`);

  // A second project in the same config home: its sessions and its lock must never reach this Console's bodies.
  const other = path.join(fixture.dir, 'other');
  fs.mkdirSync(other, { recursive: true });
  gitIn(fixture, other, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(other, 'a.txt'), 'a\n');
  gitIn(fixture, other, ['add', '-A']);
  gitIn(fixture, other, ['commit', '-q', '-m', 'first']);

  // Hook records, written by the real scripts in the scratch HOME (observe-model.sh through bridge.sh; session-context.sh).
  const hooks = path.resolve(path.dirname(core), '..', 'core', 'harnesses', 'shared', 'hooks');
  const bridge = path.join(hooks, 'bridge', 'bridge.sh');
  const envelopeJq = path.join(hooks, 'bridge', 'envelope.jq');
  const sessionContext = path.join(hooks, 'policies', 'session-context.sh');
  if (![bridge, envelopeJq, sessionContext].every((file) => fs.existsSync(file))) throw new Error(`fixture-console: the hook scripts are not beside --core (${hooks})`);
  const hookEnv = { ...fixture.env, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_UPKEEP: 'off', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', DOFLOW_PROJECT_DIR: '', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '' };
  const run = (command: string, args: string[], cwd: string, input: string, env = hookEnv) => {
    const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`fixture-console: ${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const observe = (harness: string, event: string, sessionId: string, cwd: string, model: string) =>
    run('bash', [bridge, harness, event, 'mcp-tool-guard'], cwd, JSON.stringify({ hook_event_name: event, session_id: sessionId, model, cwd }));
  const sessionStart = (sessionId: string, cwd: string) => {
    const envelope = run('jq', ['-c', '--arg', 'harness', 'claude', '--arg', 'event', 'SessionStart', '--arg', 'policy', 'session-context', '-f', envelopeJq], cwd, JSON.stringify({ session_id: sessionId, cwd, source: 'startup' })).trimEnd();
    run('bash', [sessionContext], cwd, envelope, { ...hookEnv, DOFLOW_AGENT: 'claude' });
  };
  fs.mkdirSync(path.join(fixture.roots['config-home']), { recursive: true });
  observe('claude', 'SessionStart', 'fixture-session-linked-RAWID-1', linked, 'claude-sonnet-4'); // both records: one lane
  sessionStart('fixture-session-linked-RAWID-1', linked);
  observe('codex', 'PreToolUse', 'fixture-session-main-RAWID-2', main, 'gpt-6-luna'); // an observation only
  observe('claude', 'SessionStart', 'fixture-session-other-RAWID-3', other, 'claude-opus-4'); // the second project: never shown
  sessionStart('fixture-session-other-RAWID-3', other);
  const store = path.join(fixture.roots['config-home'], 'session-env');
  if (!fs.existsSync(path.join(store, 'primary'))) throw new Error(`fixture-console: the hook records did not land under ${store}`);
  // A launched unit of the second run, in the main checkout: it joins that run's lane.
  const unit = path.join(store, 'sessions', `L.${SECOND_RUN.run}.${SECOND_RUN.lineage}.${SECOND_RUN.attempt}`);
  fs.mkdirSync(unit, { recursive: true });
  fs.writeFileSync(path.join(unit, 'git-context.json'), JSON.stringify({ branch: '', sha: '', cwd: path.join(main, 'src'), captured_at: new Date().toISOString() }));

  // Locks (written as the core writes them; `slot --action peek` reads them without a lock): a dead holder in the linked
  // worktree, a holder whose liveness cannot be proven in the main checkout, and a holder from the second project.
  const slots = path.join(fixture.roots['user-state'], 'slots');
  fs.mkdirSync(slots, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const holder = (pid: number, start: string | null, label: string, since: number, cwd: string) => ({ pid, start, childPid: null, childStart: null, label, since: new Date(since).toISOString(), cwd });
  const plant = (name: string, held: unknown) => fs.writeFileSync(path.join(slots, `${name}.json`), JSON.stringify({ name, holder: held, waiters: [], lastRelease: null }));
  plant('build', holder(dead as number, 'x', 'build@linked', Date.now() - 2 * HOUR, linked));
  plant('suite', holder(process.pid, null, 'suite@main', Date.now() - HOUR, main));
  plant('other-suite', holder(process.pid, null, 'suite@other', Date.now() - HOUR, other));

  // A commit in the linked worktree newer than every record there: outside DoFlow (a minute ahead, so it is after the records).
  gitIn(fixture, linked, ['commit', '-q', '--allow-empty', '-m', 'outside doflow'], new Date(Date.now() + 60_000).toISOString());
}

const sha16 = (text: string): string => require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Text files under `dir` with `from` replaced by `to`; the OpenCode database files are left alone. */
function retarget(dir: string, from: string, to: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) retarget(full, from, to);
    else if (!entry.name.startsWith('opencode.db')) fs.writeFileSync(full, fs.readFileSync(full, 'utf8').split(from).join(to));
  }
}

/** A session as the hooks leave it: a model observation at the checkout and a session directory with its git context. */
function hookSession(store: string, harness: string, rawId: string, cwd: string) {
  const top = fs.realpathSync(cwd);
  const { cwdHash } = require(path.join(REPO, 'src', 'runtime', 'context', 'identity.ts'));
  const dir = path.join(store, 'primary', cwdHash(top), harness);
  fs.mkdirSync(dir, { recursive: true });
  const observedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, `${sha16(rawId)}.json`), JSON.stringify({ schema: 1, harness, model: `${harness}-fixture-1`, event: 'SessionStart', observedAt, session: sha16(rawId) }));
  const sessionDir = path.join(store, 'sessions', rawId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'git-context.json'), JSON.stringify({ cwd: top, captured_at: observedAt, branch: 'main' }));
}

/**
 * The Fleet world (V.10; IC-026): a second DoFlow project, one synthetic transcript home per harness aimed at the Console's
 * project, hook sessions for four harnesses, and a wrapper core that lists the fixture projects. Only fixture files are read.
 */
function addFleet(fixture: Fixture, core: string) {
  const { main } = fixture;
  const alpha = fs.realpathSync(main);
  const home = fixture.env.HOME;
  const store = path.join(fixture.roots['config-home'], 'session-env');
  const beta = path.join(fixture.dir, 'beta');
  fs.mkdirSync(path.join(beta, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(beta, 'README.md'), 'beta\n');
  gitIn(fixture, beta, ['init', '-q', '-b', 'main']);
  gitIn(fixture, beta, ['add', 'README.md']);
  gitIn(fixture, beta, ['commit', '-q', '-m', 'fixture']);
  // Both projects are listed by the hook-dir store.
  for (const [name, cwd] of [['alpha', alpha], ['beta', fs.realpathSync(beta)]]) {
    const dir = path.join(store, 'projects', sha16(name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ cwd, last_active: new Date().toISOString() }));
  }
  const { V8_ROOT, LOCATION_ROOTS } = require(path.join(REPO, 'test', 'fixtures', 'transcripts', 'v8', 'scan.ts'));
  for (const [harness, parts] of Object.entries(LOCATION_ROOTS) as Array<[string, string[]]>) {
    const target = path.join(home, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(V8_ROOT, harness), target, { recursive: true });
    retarget(target, '/work/fixture-project', alpha);
  }
  const piRoot = path.join(home, ...LOCATION_ROOTS.pi);
  fs.renameSync(path.join(piRoot, '--work-fixture-project--'), path.join(piRoot, `--${alpha.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`));
  for (const [harness, suffix] of [['claude', 'c001'], ['codex', 'd001'], ['antigravity', 'b001'], ['opencode', '0c00']]) hookSession(store, harness, `${RAW}${suffix}`, alpha);
  hookSession(store, 'claude', `${RAW}c0bb`, beta);

  const wrapper = path.join(fixture.dir, 'fleet-core.js');
  fs.writeFileSync(wrapper, [
    "'use strict';",
    'const argv = process.argv.slice(2);',
    "if (argv[0] === 'fleet' && argv[1] === '--action' && argv[2] === 'projects') {",
    `  const { handleFleetCommand } = require(${JSON.stringify(path.join(REPO, 'src', 'runtime', 'fleet', 'command.ts'))});`,
    "  handleFleetCommand({ action: 'projects', json: argv.includes('--json'), flags: [], tempRoots: [] });",
    '} else {',
    `  require(${JSON.stringify(core)});`,
    '}',
    '',
  ].join('\n'));

  const transcript = path.join(home, ...LOCATION_ROOTS.claude, '-work-fixture-project', `${RAW}c001.jsonl`);
  let appended = 0;
  const append = () => {
    appended += 1;
    const at = () => new Date().toISOString();
    const base = { sessionId: `${RAW}c001`, cwd: alpha };
    const lines = [
      { type: 'assistant', timestamp: at(), ...base, uuid: `fx-append-a${appended}`, message: { id: `msg_fx_append_${appended}`, role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'text', text: `FIXTURE-APPEND-${appended} a reply written while the Console is open` }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'assistant', timestamp: at(), ...base, uuid: `fx-append-b${appended}`, message: { id: `msg_fx_append_t${appended}`, role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'tool_use', id: `toolu_fx_append_${appended}`, name: 'Read', input: { file_path: `notes-${appended}.txt` } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'user', timestamp: at(), ...base, uuid: `fx-append-c${appended}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_fx_append_${appended}`, content: 'FIXTURE-APPEND-RESULT', is_error: false }] } },
    ];
    fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return `FIXTURE-APPEND-${appended}`;
  };
  return { wrapper, transcript, append, env: { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '' } };
}

/** Zero runs: both stores the helper wrote to (the main checkout and its linked worktree) are emptied. */
function dropRuns(fixture: Fixture) {
  for (const root of [fixture.main, fixture.linked]) fs.rmSync(path.join(root, '.doflow', 'state', 'orchestration'), { recursive: true, force: true });
  fixture.runs.length = 0;
}

/** Builds the fixture and starts the Console on it; resolves once the URL line is out. */
async function startFixtureConsole(options: Options): Promise<Handle> {
  const log = options.log ?? (() => {});
  if (!path.isAbsolute(options.core)) throw new Error('fixture-console: --core must be an absolute path');
  const cleanups: Array<() => void> = [];
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const tmpdir = process.env.TMPDIR;
  process.env.TMPDIR = SCRATCH_ROOT;
  let fixture: Fixture;
  try {
    fixture = buildFixture((fn: () => void) => cleanups.push(fn));
  } catch (error) {
    for (const fn of cleanups.splice(0)) fn(); // the directory buildFixture made before it failed
    throw error;
  } finally {
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
  }
  const scratch = [fixture.dir];
  let steps: Array<{ describe: string, args: string[], before?: () => void }> = [];
  try {
    if (options.empty) dropRuns(fixture);
    else {
      steps = addRuns(fixture, options.core);
      fixture.runs.push(...Object.values(RUNS).map((run) => ({ taskId: run.taskId, slug: run.slug, state: '' })));
    }
    const fleet = addFleet(fixture, options.core);

    // A symlink to the core, removed after boot: the handshake passes, the runner's file check then fails.
    let linkDir: string | null = null;
    let corePath = fleet.wrapper;
    if (options.coreMissing) {
      linkDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'doflow-ui-core-'));
      scratch.push(linkDir);
      corePath = path.join(linkDir, 'doflow.js');
      fs.symlinkSync(options.core, corePath);
      cleanups.push(() => fs.rmSync(linkDir as string, { recursive: true, force: true }));
    }

    const child = spawn(process.execPath, [BIN, '--core', corePath, '--project', fixture.main, '--port', '0'], { cwd: fixture.main, env: { ...fixture.env, ...fleet.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code: number | null) => resolve(code)));
    child.stderr.on('data', (chunk: any) => { err += chunk; log(String(chunk).trimEnd()); });
    const booted: { port: number, code: string } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture-console: no URL line within ${BOOT_MS} ms; stderr ${JSON.stringify(err)}`)); }, BOOT_MS);
      child.stdout.on('data', (chunk: any) => {
        out += chunk;
        const match = URL_LINE.exec(out);
        if (match) { clearTimeout(timer); resolve({ port: Number(match[1]), code: match[2] }); }
      });
      exited.then((code) => { clearTimeout(timer); reject(new Error(`fixture-console: doflow-ui exited ${code} before its URL line; stderr ${JSON.stringify(err)}`)); });
    });
    if (linkDir !== null) fs.rmSync(corePath, { force: true });

    let next = 0;
    const call = coreCaller(options.core, fixture.main, fixture.env);
    let stopped = false;
    return {
      url: `http://127.0.0.1:${booted.port}/#c=${booted.code}`,
      port: booted.port,
      code: booted.code,
      dir: fixture.dir,
      project: fixture.main,
      env: fixture.env,
      runs: fixture.runs,
      scratch,
      transcript: fleet.transcript,
      append: () => fleet.append(),
      tick() {
        if (next >= steps.length) return null;
        const step = steps[next];
        next += 1;
        step.before?.(); // the planning exit (row 134) refuses a run with no plan
        call(...step.args);
        return step.describe;
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
        await exited;
        clearTimeout(timer);
        if (!options.keep) for (const fn of cleanups.splice(0)) fn();
      },
    };
  } catch (error) {
    if (!options.keep) for (const fn of cleanups.splice(0)) fn();
    throw error;
  }
}

type Flags = { core: string, empty: boolean, coreMissing: boolean, keep: boolean, tick: number | null, append: number | null };

function parseFlags(argv: readonly string[]): Flags | { error: string } {
  const flags: Flags = { core: '', empty: false, coreMissing: false, keep: false, tick: null, append: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--empty') flags.empty = true;
    else if (name === '--core-missing') flags.coreMissing = true;
    else if (name === '--keep') flags.keep = true;
    else if (name === '--core' || name === '--tick' || name === '--append') {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${name} needs a value` };
      index += 1;
      if (name === '--core') flags.core = value;
      else if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0) flags[name === '--tick' ? 'tick' : 'append'] = Number(value);
      else return { error: `${name} needs a positive number of seconds` };
    } else return { error: `unknown argument ${JSON.stringify(name)}` };
  }
  if (flags.core === '') return { error: '--core is required' };
  if (!path.isAbsolute(flags.core)) return { error: '--core must be an absolute path' };
  if (!fs.existsSync(flags.core)) return { error: `--core does not exist: ${flags.core}` };
  return flags;
}

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if ('error' in flags) {
    process.stderr.write(`fixture-console: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const log = (line: string) => process.stderr.write(`fixture-console: ${line}\n`);
  let app: Handle;
  try {
    app = await startFixtureConsole({ ...flags, log });
  } catch (error: any) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    return 1;
  }
  process.stdout.write(`doflow ui: ${app.url}\n`);
  log(`scratch directory ${app.dir}${flags.keep ? ' (kept)' : ''}; project ${app.project}`);
  const tick = () => {
    try {
      const done = app.tick();
      log(done === null ? 'no step left' : done);
      return done !== null;
    } catch (error: any) {
      log(`tick failed: ${error && error.message ? error.message : error}`);
      return false;
    }
  };
  const timer = flags.tick === null ? null : setInterval(() => { if (!tick()) clearInterval(timer as any); }, flags.tick * 1000);
  process.stdin.setEncoding('utf8');
  const appendOnce = () => {
    try {
      log(`appended ${app.append()}`);
    } catch (error: any) {
      log(`append failed: ${error && error.message ? error.message : error}`);
    }
  };
  const writer = flags.append === null ? null : setInterval(appendOnce, flags.append * 1000);
  process.stdin.on('data', (chunk: string) => { for (const line of chunk.split('\n')) { if (line.trim() === 'tick') tick(); else if (line.trim() === 'append') appendOnce(); } });
  return new Promise<number>((resolve) => {
    const shutdown = () => {
      if (timer !== null) clearInterval(timer);
      if (writer !== null) clearInterval(writer);
      process.stdin.pause();
      app.stop().then(() => resolve(0), () => resolve(1));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

module.exports = { RUNS, OWNERS, SCRATCH_ROOT, startFixtureConsole, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
