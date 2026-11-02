'use strict';

/**
 * `doflow-run attendance --task-id <slug> [--run <id>]` (autonomy plan section 2): a read-only answer
 * to "is a person watching this stage?", printed as `unattended <source>` or `attended <reason>`, exit
 * 0. A skill reads it once per stage and resolves its own questions to recorded defaults when the
 * answer is `unattended`; no hook reads it.
 *
 * `unattended` when either holds:
 *   (a) `DOFLOW_SESSION_ROLE` is `worker` (the launcher sets it), matched case-insensitively and
 *       literally: an unrecognised value is NOT a worker here, although the hook identity policy
 *       treats it as one, because uncertainty must read as `attended`; or
 *   (b) all of: the run record `.doflow/state/roadmap/runs/<run>.json` is open (no `closedAt`); its
 *       slot for the seed row with this slug holds a `perform` or the loop's `postMerge` marker (the stage is
 *       still pending; the loop clears the marker on its next merge step) and no `held` or
 *       `paused` mark; that row is not on `hold`; and the autopilot kill switch is enabled (the reader the policy decisions use).
 * Anything else, including a missing or unreadable record, is `attended`. The signal is derived from
 * state the runtime owns; a forged value only reaches the verbs the forging session itself calls.
 *
 * This module is imported only by the CLI. The person-only code (seed, autopilot settings, config
 * write, gates, decision register, package trust, merge) never imports it nor reads
 * `DOFLOW_SESSION_ROLE` (test/guards/attendance-scope.test.ts).
 */

const fs = require('node:fs');
const path = require('node:path');
const { listCheckouts } = require('../checkouts.ts');

const RUN_ID = /^rl-[0-9]{8}-[0-9a-hjkmnp-tv-z]{4}$/;
const ALLOWED_FLAGS = new Set(['--task-id', '--run', '--json']);

function mainRootOf(cwd: string): string {
  try {
    const info = listCheckouts({ cwd });
    if (info && info.ok && info.main) return info.main;
  } catch { /* fall back to the working directory */ }
  return path.resolve(cwd);
}

/**
 * The validation loop.ts readRunFile applies (steps, n and log included). loop.ts does not export it
 * and is edited in parallel by other packages, so the check is repeated here; a record that fails it
 * is unreadable to the loop and therefore reads as `attended`, never as a signal.
 */
function validRecord(value: any): boolean {
  return Boolean(value) && value.schema === 1 && typeof value.runId === 'string' && RUN_ID.test(value.runId)
    && Number.isSafeInteger(value.steps) && Number.isSafeInteger(value.n)
    && Boolean(value.rows) && typeof value.rows === 'object' && Array.isArray(value.log)
    && typeof value.createdAt === 'string';
}

function readRecord(file: string, fsImpl: any): any {
  const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  if (!validRecord(value)) throw new Error('not a schema 1 run record');
  return value;
}

/** The named run's record, else the newest open one; null when there is none. Throws when unreadable. */
function loadRun(runsDir: string, requested: string | undefined, fsImpl: any): any {
  if (requested) {
    try { return readRecord(path.join(runsDir, `${requested}.json`), fsImpl); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  let names: string[];
  try { names = fsImpl.readdirSync(runsDir); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  const open = names.filter((name) => /^rl-.*\.json$/.test(name)).sort()
    .map((name) => readRecord(path.join(runsDir, name), fsImpl))
    .filter((record) => !record.closedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.runId < b.runId ? -1 : 1));
  return open.at(-1) || null;
}

/**
 * @param {{taskId: string, run?: string, env?: object, cwd?: string, root?: string, fsImpl?: object, readKillSwitch?: Function}} options
 * @returns {{attendance: 'unattended'|'attended', source?: string, reason?: string, run?: string}}
 */
function resolveAttendance(options: any = {}): any {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const attended = (reason: string) => ({ attendance: 'attended', reason });
  if (String(env.DOFLOW_SESSION_ROLE || '').toLowerCase() === 'worker') return { attendance: 'unattended', source: 'worker-role' };

  const root = options.root || mainRootOf(options.cwd || process.cwd());
  let record: any;
  try { record = loadRun(path.join(root, '.doflow', 'state', 'roadmap', 'runs'), options.run, fsImpl); }
  catch { return attended('run-unreadable'); }
  if (!record) return attended('no-run');
  if (record.closedAt) return attended('run-closed');

  let rows: any[];
  try { rows = require('./rows.ts').parseSeed(fsImpl.readFileSync(path.join(root, 'agent-docs', 'roadmap', 'rows.json'), 'utf8')).rows; }
  catch { return attended('seed-unreadable'); }
  const row = rows.find((entry: any) => entry && entry.slug === options.taskId);
  if (!row) return attended('row-unknown');
  if (row.hold) return attended('row-held');
  const slot = record.rows?.[row.id];
  // A held or paused slot is machine state the loop stopped on for a person (hold, gate, dispatch, budget).
  if (slot?.held) return attended('slot-held');
  if (slot?.paused) return attended('slot-paused');
  // A pending stage is the slot's `perform`, or the marker the loop leaves when it issues the post-merge
  // verification perform (that perform is returned without being stored as slot.perform).
  const perform = slot?.perform;
  const postMerge = slot?.postMerge;
  const performPending = Boolean(perform) && typeof perform === 'object' && typeof perform.stage === 'string';
  const postMergePending = Boolean(postMerge) && typeof postMerge === 'object' && postMerge.purpose === 'post-merge' && typeof postMerge.stage === 'string';
  if (!performPending && !postMergePending) return attended('no-pending-perform');

  let enabled = false;
  try { enabled = (options.readKillSwitch || require('../settings/autopilot.ts').readKillSwitch)(env).enabled === true; } catch { enabled = false; }
  if (!enabled) return attended('switch-off');
  return { attendance: 'unattended', source: 'run-record', run: record.runId };
}

/** The CLI handler: exit 0 with the answer, 2 for a usage fault. */
function handleAttendanceCommand(options: any = {}): number {
  const json = Boolean(options.json);
  const usage = (detail: string): number => {
    if (json) console.log(JSON.stringify({ schema: 1, error: 'usage', detail }));
    else console.error(`doflow attendance: error: ${detail}`);
    process.exitCode = 2;
    return 2;
  };
  const extra = ((options.flags || []) as string[]).map((flag) => flag.split('=')[0]).find((flag) => !ALLOWED_FLAGS.has(flag));
  if (extra !== undefined) return usage(`unsupported flag ${extra}; only --task-id, --run and --json apply`);
  if (typeof options.taskId !== 'string' || !options.taskId) return usage('--task-id <row slug> is required');
  if (options.run !== undefined && !RUN_ID.test(String(options.run))) return usage('--run must be rl-<yyyymmdd>-<4 crockford characters>');
  const answer = resolveAttendance({ taskId: options.taskId, run: options.run, env: options.env, cwd: options.cwd });
  if (json) console.log(JSON.stringify({ schema: 1, ...answer }));
  else console.log(answer.attendance === 'unattended' ? `unattended ${answer.source}${answer.run ? ` ${answer.run}` : ''}` : `attended ${answer.reason}`);
  process.exitCode = 0;
  return 0;
}

module.exports = { resolveAttendance, handleAttendanceCommand };
