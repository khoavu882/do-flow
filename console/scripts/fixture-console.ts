'use strict';

// The fixture Console (feature 093, C.2; design C14, IC-015). Dev only: console/scripts/ is not in the
// package's `files`. It builds a scratch HOME, XDG config home and a git project with the REAL core's
// verbs (the builders of test/helpers/core-fixture.ts, then more runs on top), starts bin/doflow-ui.js
// on 127.0.0.1:0 against it, and prints the Console's one URL line on stdout. It is the only Console a
// designer or a browser check may open. Everything else it says goes to stderr.
//
//   node console/scripts/fixture-console.ts --core <abs path to bin/doflow.js> [--empty] [--core-missing] [--keep] [--tick <seconds>]
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
//
// Ctrl-C (SIGINT) or SIGTERM stops the Console and removes the scratch directories (exact paths, all
// under SCRATCH_ROOT) unless --keep.
//
// Two journal edits no verb can make, both through the record's own fields in the run's journal file:
// the stale run's startedAt, updatedAt and history times are moved back 48 h (the core stamps the
// clock and takes none), and the shape-mismatch run's `program` loses its `verification` node (a run
// started on an older workflow; the core only ever compiles the current one).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildFixture } = require('../test/helpers/core-fixture.ts');

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
const USAGE = 'usage: fixture-console.ts --core <absolute path to bin/doflow.js> [--empty] [--core-missing] [--keep] [--tick <seconds>]';

/** Slug and task id of every run this script adds to the helper's five (SLUGS in core-fixture.ts). */
const RUNS = Object.freeze({
  work: { slug: 'feat-work', taskId: 'run-work' }, // RUNNING in implementation; 12-task plan, attempts in every state
  tick: { slug: 'feat-tick', taskId: 'run-tick' }, // RUNNING in design; no plan; the live run of --tick
  approval: { slug: 'feat-approval', taskId: 'run-approval' }, // AWAITING_GATE at gate-a (approval); a plan with no attempts
  done: { slug: 'feat-done', taskId: 'run-done' }, // COMPLETED (documentation: one stage skipped); no plan
  rejected: { slug: 'feat-rejected', taskId: 'run-rejected' }, // REJECTED at gate-a
  stale: { slug: 'feat-stale', taskId: 'run-stale' }, // RUNNING, silent for 48 h
  shape: { slug: 'feat-shape', taskId: 'run-shape' }, // RUNNING, program one node short of the workflow
});

const OWNERS = Object.freeze(['core-implementer', 'quality-guardian', 'system-architect']);

/** 12 tasks over 3 owners, three phases; the declared owner is the lane of a task with no active attempt. */
const WORK_PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '',
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
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 [P] first step; owner: core-implementer; files: src/p1.js',
  '- [ ] A.2 [P] second step; owner: quality-guardian; files: src/p2.js',
  '- [ ] A.3 third step; owner: core-implementer; files: src/p3.js; depends-on: A.1, A.2',
  '',
].join('\n');

type Options = { core: string, empty?: boolean, coreMissing?: boolean, keep?: boolean, log?: (line: string) => void };
type Fixture = ReturnType<typeof buildFixture>;
type Handle = {
  url: string, port: number, code: string, dir: string, project: string, env: Record<string, string>,
  runs: Array<{ taskId: string, slug: string | null, state: string }>,
  /** The exact directories this fixture made (project and, with coreMissing, the core symlink's); all are removed by stop() unless keep. */
  scratch: string[],
  /** Takes the next step of the live run; the step's description, or null when none is left. */
  tick(): string | null,
  stop(): Promise<void>,
};

/** The fixture environment of the core's calls, with the upkeep switch on: building must not run upkeep. */
function coreCaller(core: string, cwd: string, env: Record<string, string>) {
  const buildEnv = { ...env, DOFLOW_UPKEEP: 'off' };
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
function addRuns(fixture: Fixture, core: string): Array<{ describe: string, args: string[] }> {
  const { main } = fixture;
  const call = coreCaller(core, main, fixture.env);
  const orchestrate = (...args: string[]) => call('orchestrate', ...args);
  for (const { slug } of Object.values(RUNS)) {
    fs.mkdirSync(path.join(main, 'agent-docs', 'doflow', slug), { recursive: true });
    fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', slug, 'requirement.md'), `# ${slug}\n`);
  }
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.work.slug, 'plan.md'), WORK_PLAN);
  fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', RUNS.approval.slug, 'plan.md'), APPROVAL_PLAN);

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

  const live = RUNS.tick;
  return [
    { describe: `${live.taskId}: design completed`, args: ['orchestrate', '--action', 'complete-stage', '--task-id', live.taskId, '--stage', 'design', '--result', 'passed', '--slug', live.slug] },
    { describe: `${live.taskId}: planning completed, awaiting gate-a`, args: ['orchestrate', '--action', 'complete-stage', '--task-id', live.taskId, '--stage', 'planning', '--result', 'passed', '--slug', live.slug] },
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
  let steps: Array<{ describe: string, args: string[] }> = [];
  try {
    if (options.empty) dropRuns(fixture);
    else {
      steps = addRuns(fixture, options.core);
      fixture.runs.push(...Object.values(RUNS).map((run) => ({ taskId: run.taskId, slug: run.slug, state: '' })));
    }

    // A symlink to the core, removed after boot: the handshake passes, the runner's file check then fails.
    let linkDir: string | null = null;
    let corePath = options.core;
    if (options.coreMissing) {
      linkDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'doflow-ui-core-'));
      scratch.push(linkDir);
      corePath = path.join(linkDir, 'doflow.js');
      fs.symlinkSync(options.core, corePath);
      cleanups.push(() => fs.rmSync(linkDir as string, { recursive: true, force: true }));
    }

    const child = spawn(process.execPath, [BIN, '--core', corePath, '--project', fixture.main, '--port', '0'], { cwd: fixture.main, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      tick() {
        if (next >= steps.length) return null;
        const step = steps[next];
        next += 1;
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

type Flags = { core: string, empty: boolean, coreMissing: boolean, keep: boolean, tick: number | null };

function parseFlags(argv: readonly string[]): Flags | { error: string } {
  const flags: Flags = { core: '', empty: false, coreMissing: false, keep: false, tick: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--empty') flags.empty = true;
    else if (name === '--core-missing') flags.coreMissing = true;
    else if (name === '--keep') flags.keep = true;
    else if (name === '--core' || name === '--tick') {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${name} needs a value` };
      index += 1;
      if (name === '--core') flags.core = value;
      else if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0) flags.tick = Number(value);
      else return { error: '--tick needs a positive number of seconds' };
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
  process.stdin.on('data', (chunk: string) => { for (const line of chunk.split('\n')) if (line.trim() === 'tick') tick(); });
  return new Promise<number>((resolve) => {
    const shutdown = () => {
      if (timer !== null) clearInterval(timer);
      process.stdin.pause();
      app.stop().then(() => resolve(0), () => resolve(1));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

module.exports = { RUNS, OWNERS, SCRATCH_ROOT, startFixtureConsole, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
