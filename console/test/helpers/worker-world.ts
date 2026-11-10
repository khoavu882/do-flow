'use strict';

// Feature 150 B.6 (IC-021, plan D7 and RK8): the worker world, one feature's worker run store with every
// case the Session screen and the read contract need, written into `<projectRoot>/.doflow/state`.
//
// No verb starts a worker run without a harness binary, so the store is written here, as the fixture
// Console already writes journal edits no verb can make. Every record goes through the core's own
// `insertRun` and `transition` (src/runtime/worker/run-store.ts), in the order the core writes them:
// the insert of `worker --action run` (src/runtime/worker/command.ts), its `supervisor` write, then the
// supervisor's `launchingAt`, `running`, exit, group, leftover and end transitions
// (src/runtime/worker/supervisor.ts superviseRun), and the timeout cancel's `cancelling` and end
// (src/runtime/worker/cancel.ts). Fields a reader reads have the shapes those writers give them:
// `process` `{kind: 'exited', code, signal, at}` plus `groupAlive` and `leftover`, `output.stdout`
// `{path, bytes, written, truncated}`, `readOnly` and `isolation` as worktree-check and isolationOf
// return them, `report` as a parser ends it, `quota` as quotaOf adds it.
//
// The world, by role (the caller passes the feature's attempts; at least one active and two ended):
//   running    top-level on the active attempt, `running`, its supervisor and worker this process's own
//              pid and start, so liveness reads alive; out and err files present unless asked otherwise
//   child      a child of `running`, `running`, alive, no output files yet
//   overdue    a child of `running`, `running`, alive, past its deadline
//   edit       top-level edit run on the first ended attempt: isolation `violated` `outside-write`
//   branchMoved top-level edit run on the second ended attempt: `branch-moved` and a denied report
//   unmatched  top-level edit run on a token no attempt holds: `isolation-unverifiable`, a failed report
//   offered    a child of `edit`, read-only, exited clean with a success report: result offered
//   violated   a child of `edit`: `read-only-violation` and `group-survived`
//   timedOut   a child of `edit`, ended `timed-out` by the timeout cancel: `not-exited`,
//              `read-only-unverifiable`, `report-unparsed`
//   quota      a child of `edit`: a failed report with a quota signal, `report-quota`
//   capped     a child of `edit`, offered, `output.stdout.truncated: true`
//   lastLog    a child of `edit`, offered, its `.last.log` holding LAST_LOG_MARKER
// `readOnly` names the same run as `offered`. Together the ended runs cover the offered result and each of
// the 11 withheld codes of `resultOfRun`; the build checks that and throws otherwise.
//
// Planted, for leak checks: PLANTED's secret, email, IP and home-style absolute path in the records' free
// text and in every out and err file; PROMPT_MARKER in each prompt path; distinct pids and a process start
// in every ended run, this process's own pid and start in the live ones.
//
// This module touches no test-runner global, so console/scripts can import it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const { storeFileFor, insertRun, transition, readRuns, RUN_ID } = require(path.join(REPO, 'src', 'runtime', 'worker', 'run-store.ts'));
const { resultOfRun } = require(path.join(REPO, 'src', 'runtime', 'worker', 'supervisor.ts'));
const processTree = require(path.join(REPO, 'src', 'runtime', 'worker', 'process-tree.ts'));
const { CLOSED_SETS } = require(path.join(REPO, 'console', 'src', 'project.ts'));

const PLANTED = Object.freeze({
  secret: 'fx-World-Secret-4c8a2f',
  email: 'world.person@example.invalid',
  ip: '10.44.55.66',
  path: '/home/test/worker-world-plan-7d3b.md',
});
const PROMPT_MARKER = 'WORLD-PROMPT-MARKER-5a1e';
const LAST_LOG_MARKER = 'WORLD-LAST-LOG-MARKER-9f04';
/** The pids of the ended runs' supervisors, workers and survivors: none may reach a body. */
const PLANTED_PIDS = Object.freeze([987651, 987652, 987653]);
/** The process start the ended runs' supervisors and workers carry (`ps -o lstart` form): no body may carry it. */
const DEAD_START = 'Sun Nov  1 05:00:00 2026';

const ROLES = Object.freeze(['running', 'child', 'overdue', 'edit', 'branchMoved', 'unmatched', 'offered', 'violated', 'timedOut', 'quota', 'capped', 'lastLog']);
const STREAM_FILES: Readonly<Record<string, string>> = Object.freeze({ out: 'out', err: 'err' });
/** The phases the supervisor's step 6 writes allow (supervisor.ts STEP6). */
const STEP6 = ['running', 'cancelling', 'ended'];
const MINUTE = 60_000;

type Attempt = { task: string; token: number; state: string; runKey?: string | null };
type WorldOptions = {
  projectRoot: string;
  slug: string;
  attempts: Attempt[];
  /** Appended to the planted text (a test's own marker). */
  marker?: string;
  /** `absent`: the running run's out and err files do not exist yet (IC-021's first tick creates them). */
  runningLogs?: 'present' | 'absent';
  now?: number;
};

const ROLE_IDS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(ROLES.map((role, index) => [role, `w-0b6e${(0x1000 + index).toString(16).padStart(8, '0')}`])));

const iso = (ms: number) => new Date(ms).toISOString();
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function applied(result: any, what: string): any {
  if (!result || result.applied !== true) throw new Error(`worker world: ${what} was not applied: ${JSON.stringify(result)}`);
  return result.run;
}

/**
 * Writes the world into `<projectRoot>/.doflow/state/worker-runs/<slug>.json` and its output files into
 * `<projectRoot>/.doflow/state/worker-output/`. Returns the run ids by role, the store and output paths,
 * the planted values, `appendLine` and `endRunning`.
 */
function buildWorkerWorld(options: WorldOptions) {
  const { projectRoot, slug, attempts, marker = '', runningLogs = 'present' } = options;
  const now = options.now ?? Date.now();
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new TypeError('worker world: projectRoot must be an absolute path');
  if (!Array.isArray(attempts)) throw new TypeError('worker world: attempts must be an array of {task, token, state}');
  const active = attempts.find((a) => a.state === 'active');
  const ended = attempts.filter((a) => a.state !== 'active');
  if (!active || ended.length < 2) throw new Error('worker world: needs one active and two ended attempts');
  const taken = attempts.filter((a) => a.task === active.task).map((a) => a.token);
  const unmatched = { task: active.task, token: Math.max(...taken) + 1, runKey: active.runKey ?? null };

  const store = storeFileFor(projectRoot, slug);
  const stateRoot = path.join(projectRoot, '.doflow', 'state');
  const outputDir = path.join(stateRoot, 'worker-output');
  if (fs.existsSync(store)) throw new Error(`worker world: ${store} exists already`);
  fs.mkdirSync(outputDir, { recursive: true });

  const text = `password=${PLANTED.secret} mail ${PLANTED.email} host ${PLANTED.ip} file ${PLANTED.path}${marker ? ` ${marker}` : ''}`;
  const selfStart = process.platform === 'win32' ? null : processTree.procStart(process.pid);
  const self = { pid: process.pid, pgid: process.pid, start: selfStart };
  const [supPid, workerPid, survivorPid] = PLANTED_PIDS;
  const deadProc = (pid: number) => ({ pid, pgid: pid, start: DEAD_START });

  const logFile = (runId: string, stream: string) => {
    if (!RUN_ID.test(runId) || !Object.hasOwn(STREAM_FILES, stream)) throw new TypeError(`worker world: no log file for ${runId} ${stream}`);
    return path.join(outputDir, `${runId}.${STREAM_FILES[stream]}.log`);
  };
  /** The sink's output pointer of a finished stream (createOutputSink's `end()`). */
  const writeOutput = (runId: string, truncated = false) => {
    const pointer = (stream: 'out' | 'err') => {
      const content = `world ${runId} ${stream} 1 ${text}\nworld ${runId} ${stream} 2 done\n`;
      fs.writeFileSync(logFile(runId, stream), content);
      const written = Buffer.byteLength(content);
      return { path: `worker-output/${runId}.${stream}.log`, bytes: truncated && stream === 'out' ? written + 4096 : written, written, truncated: truncated && stream === 'out' };
    };
    return { stdout: pointer('out'), stderr: pointer('err') };
  };
  /** A pointer whose file retention already removed: the reads say `gone`. */
  const prunedOutput = (runId: string) => ({
    stdout: { path: `worker-output/${runId}.out.log`, bytes: 120, written: 120, truncated: false },
    stderr: { path: `worker-output/${runId}.err.log`, bytes: 0, written: 0, truncated: false },
  });

  const report = (status: string, extra: any = {}) => ({
    parser: 'codex-jsonl', status, reason: status === 'success' ? null : `reason ${text}`, summary: `summary ${text}`,
    denials: status === 'denied' ? [{ action: 'write', detail: `denied ${text}` }] : [], deniedCount: status === 'denied' ? 1 : 0,
    usage: { tokens: 31337 }, ignoredLines: 0, ...extra,
  });
  const comparison = (status: string) => ({
    status, changes: status === 'violated' ? [`M ${PLANTED.path}`] : [], head: { before: 'a'.repeat(40), after: 'a'.repeat(40) }, refsChanged: status === 'clean' ? [] : null,
  });
  const isolation = (status: string, reason: string | null) => ({
    status, reason, changes: status === 'violated' ? [`M ${PLANTED.path}`] : [], callerHead: { before: 'b'.repeat(40), after: 'b'.repeat(40) },
    attemptHead: { before: { ref: 'refs/heads/doflow-world', object: 'c'.repeat(40) }, after: { ref: reason === 'branch-moved' ? 'refs/heads/elsewhere' : 'refs/heads/doflow-world', object: 'd'.repeat(40) } },
    refsChanged: null,
  });

  /** `worker --action run`'s insert and its supervisor write; then the supervisor up to `running`. */
  const start = (role: string, at: Omit<Attempt, 'state'>, extra: { edit?: boolean; childOf?: string; request?: string; supervisor: any; worker: any; startedAt: number; deadline: number }) => {
    const runId = ROLE_IDS[role];
    const createdAt = extra.startedAt - 2000;
    const identity = extra.childOf
      ? { run: runId.slice(2), lineage: `lineage ${text}`, attempt: String(at.token), runSource: 'run-scoped' }
      : { run: 'world-run', lineage: `lineage ${text}`, attempt: String(at.token), runSource: 'claim' };
    const promptPath = `/home/test/${PROMPT_MARKER}-${role}.md`;
    applied(insertRun(store, {
      runId, task: at.task, token: at.token, harness: 'codex', phase: 'starting', execWorktree: path.join(projectRoot, '.worktrees', role), createdAt: iso(createdAt), timeoutSeconds: 1800,
      cliVersion: '0.0.0-world',
      caller: { cwd: projectRoot, ...(at.runKey ? { runKey: at.runKey } : {}), run: 'world-run', lineage: 'main', attempt: null, role: 'primary', lineageKind: 'primary' },
      edit: extra.edit ? { callerTop: projectRoot, base: 'e'.repeat(40), branch: 'refs/heads/doflow-world' } : null,
      childOf: extra.childOf ?? null, request: extra.request ?? null,
      identity,
      recipe: { binary: 'codex', argvShape: ['exec', `<prompt sha256:${sha(PROMPT_MARKER)} bytes:${PROMPT_MARKER.length}>`], promptVia: 'stdin', parser: 'codex-jsonl', profile: null },
      envSet: ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'], envInherited: true,
      descriptor: { id: 'codex', cli: { binary: PLANTED.path }, structuredOutput: { parser: 'codex-jsonl' } },
      prompt: { path: promptPath, sha256: sha(PROMPT_MARKER), bytes: PROMPT_MARKER.length },
      needs: [{ requirement: 'oneShot', at: null }],
    }), `insert ${role}`);
    applied(transition(store, runId, ['starting', 'running', 'cancelling'], (run: any) => { run.supervisor = extra.supervisor; }), `${role} supervisor`);
    applied(transition(store, runId, ['starting'], (run: any) => { run.launchingAt = iso(extra.startedAt - 500); }), `${role} launchingAt`);
    applied(transition(store, runId, ['starting'], (run: any) => {
      run.phase = 'running';
      run.worker = extra.worker;
      run.startedAt = iso(extra.startedAt);
      run.deadline = iso(extra.deadline);
      run.launched = { reason: 'spawned', bytes: PROMPT_MARKER.length };
    }), `${role} running`);
    return runId;
  };

  type EndSpec = {
    code?: number | null; signal?: string | null; groupAlive?: boolean; leftover?: boolean; timedOut?: boolean;
    readOnly?: any; isolation?: any; report: any; output: any; endedAt: number;
  };
  /** The supervisor's step 6 (and, for a timeout, the cancel's end before it), as superviseRun writes them. */
  const finish = (role: string, runId: string, spec: EndSpec) => {
    const at = iso(spec.endedAt);
    if (spec.timedOut) {
      applied(transition(store, runId, ['starting', 'running', 'cancelling'], (run: any) => {
        run.phase = 'cancelling';
        run.cancel = { requestedAt: iso(spec.endedAt - 2000), by: 'doflow-worker', reason: 'timeout after 1800s', source: 'timeout' };
      }), `${role} cancelling`);
    }
    const put = (run: any, key: string, value: any) => { if (run.phase !== 'ended' || run[key] === undefined) run[key] = value; };
    applied(transition(store, runId, STEP6, (run: any) => put(run, 'process', { kind: 'exited', code: spec.code ?? null, signal: spec.signal ?? null, at })), `${role} process`);
    applied(transition(store, runId, STEP6, (run: any) => { if (run.process?.kind === 'exited' && run.process.groupAlive === undefined) run.process.groupAlive = spec.groupAlive === true; }), `${role} groupAlive`);
    if (spec.leftover) {
      applied(transition(store, runId, STEP6, (run: any) => {
        run.process.leftover = { status: 'survivors', reason: null, survivors: [survivorPid], zombies: [] };
      }), `${role} leftover`);
    }
    if (spec.timedOut) {
      applied(transition(store, runId, ['cancelling'], (run: any) => {
        run.attemptCancel = { disposition: 'skipped', reason: 'child-run' };
        run.cleanup = { status: 'verified', reason: null, survivors: [], zombies: [] };
        run.end = { state: 'timed-out', at };
        run.phase = 'ended';
      }), `${role} timed-out end`);
    }
    applied(transition(store, runId, STEP6, (run: any) => {
      put(run, 'readOnly', spec.readOnly ?? null);
      if (run.edit) put(run, 'isolation', spec.isolation);
      put(run, 'report', spec.report);
      put(run, 'launchObserved', 'yes');
      put(run, 'output', spec.output);
      if (run.phase === 'running') {
        run.end = { state: 'exited', at };
        run.phase = 'ended';
      }
    }), `${role} end`);
  };

  const alive = { supervisor: self, worker: self };
  const dead = { supervisor: deadProc(supPid), worker: deadProc(workerPid) };
  const ran = (minutesAgo: number) => ({ startedAt: now - minutesAgo * MINUTE, deadline: now - minutesAgo * MINUTE + 30 * MINUTE });
  const runs: Record<string, string> = {};

  // The live runs: the active attempt's run and two of its children.
  runs.running = start('running', active, { ...alive, startedAt: now - 2 * MINUTE, deadline: now + 60 * MINUTE });
  if (runningLogs === 'present') {
    fs.writeFileSync(logFile(runs.running, 'out'), `world running out 1 ${text}\nworld running out 2 compiling\n`);
    fs.writeFileSync(logFile(runs.running, 'err'), `world running err 1 ${text}\n`);
  }
  runs.child = start('child', active, { ...alive, childOf: runs.running, request: 'd-0b6e1ce0a1b2.c1', startedAt: now - MINUTE, deadline: now + 60 * MINUTE });
  runs.overdue = start('overdue', active, { ...alive, childOf: runs.running, request: 'd-0b6e1ce0a1b2.c2', startedAt: now - 40 * MINUTE, deadline: now - 10 * MINUTE });

  // Top-level edit runs: one per ended attempt, and one on a token no attempt holds. `edit` outlives its children.
  runs.edit = start('edit', ended[0], { ...dead, edit: true, ...ran(55) });
  runs.branchMoved = start('branchMoved', ended[1], { ...dead, edit: true, ...ran(54) });
  finish('branchMoved', runs.branchMoved, { code: 0, isolation: isolation('violated', 'branch-moved'), report: report('denied'), output: prunedOutput(runs.branchMoved), endedAt: now - 50 * MINUTE });
  runs.unmatched = start('unmatched', unmatched, { ...dead, edit: true, ...ran(53) });
  finish('unmatched', runs.unmatched, { code: 1, isolation: isolation('unverifiable', 'isolation-unverifiable'), report: report('failure'), output: prunedOutput(runs.unmatched), endedAt: now - 49 * MINUTE });

  // Read-only children of the edit run, one per remaining result case, each granted and ended while it ran.
  const child = (role: string, n: number) => start(role, ended[0], { ...dead, childOf: runs.edit, request: `d-0b6e1ce0a1b3.c${n}`, ...ran(50 - n) });
  const endOf = (n: number) => now - (45 - n) * MINUTE;
  runs.offered = child('offered', 1);
  finish('offered', runs.offered, { code: 0, readOnly: comparison('clean'), report: report('success'), output: writeOutput(runs.offered), endedAt: endOf(1) });
  runs.violated = child('violated', 2);
  finish('violated', runs.violated, { code: 0, groupAlive: true, leftover: true, readOnly: comparison('violated'), report: report('success'), output: prunedOutput(runs.violated), endedAt: endOf(2) });
  runs.timedOut = child('timedOut', 3);
  finish('timedOut', runs.timedOut, { code: null, signal: 'SIGTERM', timedOut: true, readOnly: comparison('unverifiable'), report: report('unparsed'), output: prunedOutput(runs.timedOut), endedAt: endOf(3) });
  runs.quota = child('quota', 4);
  finish('quota', runs.quota, { code: 1, readOnly: comparison('clean'), report: report('failure', { quota: { signal: 'rate limit', basis: 'documented' } }), output: prunedOutput(runs.quota), endedAt: endOf(4) });
  runs.capped = child('capped', 5);
  finish('capped', runs.capped, { code: 0, readOnly: comparison('clean'), report: report('success'), output: writeOutput(runs.capped, true), endedAt: endOf(5) });
  runs.lastLog = child('lastLog', 6);
  const lastFile = path.join(outputDir, `${runs.lastLog}.last.log`);
  fs.writeFileSync(lastFile, `${LAST_LOG_MARKER} ${text}\n`);
  finish('lastLog', runs.lastLog, {
    code: 0, readOnly: comparison('clean'), report: report('success'), endedAt: endOf(6),
    output: { ...writeOutput(runs.lastLog), lastMessage: { path: `worker-output/${runs.lastLog}.last.log`, bytes: fs.statSync(lastFile).size, altered: false } },
  });
  finish('edit', runs.edit, { code: 0, isolation: isolation('violated', 'outside-write'), report: report('success'), output: prunedOutput(runs.edit), endedAt: now - 30 * MINUTE });
  runs.readOnly = runs.offered;

  // The world must hold the offered result and every withheld code, read back from the store as written.
  const records = readRuns(store);
  const results = Object.fromEntries(Object.entries(records).map(([runId, record]) => [runId, resultOfRun(record)]));
  const seen = new Set(Object.values(results).flatMap((r: any) => r.withheld));
  const missing = CLOSED_SETS.withheldCodes.filter((code: string) => !seen.has(code));
  if (missing.length) throw new Error(`worker world: no run is withheld for ${missing.join(', ')}`);
  for (const role of ['offered', 'capped', 'lastLog']) if (!results[runs[role]].resultOffered) throw new Error(`worker world: ${role} is not offered`);

  /** Appends one line (`text` plus a newline) to a run's out or err file, as the sink would; returns the byte range written. */
  function appendLine(runId: string, stream: 'out' | 'err', line: string): { file: string; from: number; to: number } {
    if (typeof line !== 'string' || /[\r\n]/.test(line)) throw new TypeError('worker world: appendLine takes one line without a line end');
    const file = logFile(runId, stream);
    const from = fs.existsSync(file) ? fs.statSync(file).size : 0;
    fs.appendFileSync(file, `${line}\n`);
    return { file, from, to: fs.statSync(file).size };
  }

  /**
   * Ends the running run as the supervisor's step 6 ends a clean exit (`process.kind: 'exited'`, code 0), its output
   * pointers read from its out and err files as they stand. Returns the ended record.
   */
  function endRunning(at: number = Date.now()): any {
    const pointer = (stream: 'out' | 'err') => {
      const file = logFile(runs.running, stream);
      const written = fs.existsSync(file) ? fs.statSync(file).size : 0;
      return { path: `worker-output/${runs.running}.${stream}.log`, bytes: written, written, truncated: false };
    };
    finish('running', runs.running, { code: 0, report: report('success'), output: { stdout: pointer('out'), stderr: pointer('err') }, endedAt: at });
    return readRuns(store)[runs.running];
  }

  return {
    slug, store, stateRoot, outputDir, runs: Object.freeze(runs), all: Object.freeze(ROLES.map((role) => runs[role])),
    unmatched: { task: unmatched.task, token: unmatched.token }, results,
    planted: Object.freeze({ ...PLANTED, text, prompt: PROMPT_MARKER, lastLog: LAST_LOG_MARKER, pids: PLANTED_PIDS, starts: Object.freeze([selfStart, DEAD_START].filter((start): start is string => typeof start === 'string')) }),
    logFile, appendLine, endRunning,
  };
}

module.exports = { LAST_LOG_MARKER, PLANTED, PLANTED_PIDS, PROMPT_MARKER, ROLES, buildWorkerWorld };
