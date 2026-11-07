'use strict';

// Feature 149 A.5 (IC-004, DEC-024): the section catalogue of `doflow events --follow`.
//
// Each channel of IC-003 maps to its sections, and each section is the `{exit, json}` of one
// allow-listed verb (`console/src/verb-runner.ts:72`) run with `--json`: the same function the
// verb's CLI handler calls, with the arguments the handler passes, so a live section equals the
// verb's output by construction. A documented verb failure (`status` exit 1, `inspect` exit 2
// `plan-unreadable`, `roadmap` exit 2) is a section result; only a fault the handler would not
// catch either is thrown, for the caller to report as `producer-failed`.
//
//   now                  list, observed*, slots*, roadmap
//   run:<slug>:<task>    status, timeline
//   tasks:<slug>         attempts, worker:<task>:<token>* (one per active attempt, at most 16)
//   worker:<runId>       status*
//   (* derived from the clock or a process: recomputed by the detector's 5 s pass)
//
// Each channel also declares its sources and primary record (IC-004, IC-006) in the shape
// `detector.follow(channel, sources)` takes. Results are raw: masking is the envelope writer's.
// Read-only: no file is created, written, renamed or deleted, no lock is taken, and the only
// processes started are the git reads the producers already run.

const fs = require('node:fs');
const path = require('node:path');
const { listRunsResult, statusResult, timelineResult } = require('../workflow-orchestrator.ts');
const { roadmapStatusResult, resolveMainRoot } = require('../roadmap/loop.ts');
const { observedSessions } = require('../context/primary.ts');
const { stateDir } = require('../context/identity.ts');
const { peekSlots } = require('../slots.ts');
const { inspect, storeFile: attemptsStoreFile, TaskAttemptError } = require('../task-attempts.ts');
const { executeWorkerCommand } = require('../worker/command.ts');
const { readRuns } = require('../worker/run-store.ts');
const { listCheckouts, mayBeLinked, clearCheckoutCache } = require('../checkouts.ts');
const { taskStateRoot } = require('../state-root.ts');
const { invalidSlugRefusal, isSafeSlug, clearTaskScopeCache } = require('../task-scope.ts');
const { findRunFile, runStoreDir, featureSlugFor } = require('../implementation-gate.ts');
const { projectRoot: lifecycleProjectRoot } = require('../lifecycle/root.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { parseChannel } = require('./channels.ts');

type Env = Record<string, string | undefined>;
type SectionResult = { exit: number; json: any };
type Sections = Record<string, SectionResult>;
type Channel =
  | { kind: 'now'; name: 'now' }
  | { kind: 'run'; name: string; slug: string; taskId: string }
  | { kind: 'tasks'; name: string; slug: string }
  | { kind: 'worker'; name: string; runId: string };

/** What a channel needs to run its verbs: the directory the verb would run in and its environment. */
interface SectionContext { cwd: string; env?: Env }

/** The roots the CLI resolves for one call from `cwd` and `env` (see `resolveContext`). */
interface ResolvedContext {
  cwd: string;
  env: Env;
  stateRoot: string;
  lifecycleRoot: string;
  mainRoot: string;
  sessionsDir: string | null;
  slotsDir: string | null;
}

/** `detector.follow`'s spec (src/runtime/events/detector.ts ChannelSources). */
interface FollowSources {
  directories: Array<{ path: string; match: RegExp }>;
  files: string[];
  derived: string[];
  primary: { path: string; pick?: (doc: any) => any } | null;
}

/** One computation: the sections asked for and, on `tasks:`, the worker sections that no longer exist. */
interface ComputeResult { sections: Sections; removed?: string[] }

/** A channel's catalogue entry; see `channelSpec`. */
interface ChannelSpec {
  readonly channel: Channel;
  readonly derived: readonly string[];
  sectionNames(): string[];
  isDerived(name: string): boolean;
  sources(): FollowSources;
  compute(only?: readonly string[]): Promise<ComputeResult>;
}

/** IC-004: the most `worker:<task>:<token>` sections one `tasks:` channel carries (`SESSION_LIMITS.workers`). */
const WORKER_SECTION_LIMIT = 16;

/** The name a `tasks:` channel declares as derived for all its worker sections, whose names change. */
const WORKER_SECTIONS = 'worker:*';

/** A worker section name: `worker:<task>:<token>`. */
const WORKER_SECTION = /^worker:[^:]+:[1-9][0-9]*$/;

/** IC-004's fixed sections and derived flags per channel kind (`tasks:` adds its worker sections). */
const CATALOGUE: Readonly<Record<Channel['kind'], { sections: readonly string[]; derived: readonly string[] }>> = Object.freeze({
  now: Object.freeze({ sections: Object.freeze(['list', 'observed', 'slots', 'roadmap']), derived: Object.freeze(['observed', 'slots']) }),
  run: Object.freeze({ sections: Object.freeze(['status', 'timeline']), derived: Object.freeze([]) }),
  tasks: Object.freeze({ sections: Object.freeze(['attempts']), derived: Object.freeze([WORKER_SECTIONS]) }),
  worker: Object.freeze({ sections: Object.freeze(['status']), derived: Object.freeze(['status']) }),
});

/** Record files of a store directory: no `<file>.lock` directory and no `<file>.<pid>.tmp`. */
const JSON_RECORD = /\.json$/;
/** Entries of an orchestration store: flat runs and namespace directories, never a lock or temp file. */
const STORE_ENTRY = /^(?!.*\.(?:lock|tmp)$)[^.]/;

function exactName(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}$`);
}

/** The value as `JSON.parse` of its printed form reads it, so a section equals the verb's parsed stdout. */
function parsed(value: any): any {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function result(exit: number, json: any): SectionResult {
  return { exit, json: parsed(json) };
}

/**
 * A fresh process's view: the checkout list and the branch feature are cached per process
 * (`checkouts.ts`, `task-scope.ts`), and every CLI call is a new process. Cleared before each
 * computation so a long-lived follower sees a new worktree or branch as the verb would.
 */
function freshProcessCaches(): void {
  clearCheckoutCache();
  clearTaskScopeCache();
}

/**
 * The roots one CLI call resolves from `cwd` and `env`:
 * - `stateRoot`: the orchestrate store, `taskStateRoot` over `listCheckouts` when the checkout may be
 *   linked (the main checkout of a linked worktree), as `src/cli/runtime-commands.ts:287-293` does;
 * - `lifecycleRoot`: the task-attempt and worker-run store, `lifecycle/root.ts projectRoot(cwd)`
 *   (`task-attempts.ts:892`, `worker/command.ts:548`);
 * - `mainRoot`: the roadmap's root, `resolveMainRoot(cwd)` (`roadmap/loop.ts:153`);
 * - `sessionsDir`: `<config home>/doflow/session-env/sessions` (`session-dirs`), null with no config home;
 * - `slotsDir`: `<user-state>/slots` (`slots-user`), null with no HOME.
 * @param {SectionContext} ctx
 * @returns {ResolvedContext}
 */
function resolveContext(ctx: SectionContext): ResolvedContext {
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd === '') throw new TypeError('a section context needs a cwd');
  const cwd = path.resolve(ctx.cwd);
  const env: Env = ctx.env ?? process.env;
  const checkouts = mayBeLinked(cwd) ? listCheckouts({ cwd }) : null;
  const stateRoot = taskStateRoot({ positional: [cwd] }, checkouts).root;
  const session = stateDir(env);
  const userState = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), env })['user-state'];
  return {
    cwd,
    env,
    stateRoot,
    lifecycleRoot: lifecycleProjectRoot(cwd),
    mainRoot: resolveMainRoot(cwd),
    sessionsDir: session === null ? null : path.join(session, 'sessions'),
    slotsDir: userState ? path.join(userState, 'slots') : null,
  };
}

// ── Producers: one per allow-listed verb shape ───────────────────────────────────────────────────

/** The dispatcher refuses an unsafe `--slug` for every verb before any handler runs (`runtime-commands.ts:276`). */
function slugRefusal(slug: string): SectionResult | null {
  const refusal = invalidSlugRefusal(slug);
  return refusal ? result(2, refusal) : null;
}

/** `orchestrate --action list --json`. */
function listSection(c: ResolvedContext): SectionResult {
  return result(...pair(listRunsResult({ stateRoot: c.stateRoot })));
}

/** `orchestrate --action status|timeline --task-id <task> --slug <slug> --json`; `sourceRoot` is the cwd (`evidenceRoot`). */
function runSection(c: ResolvedContext, action: 'status' | 'timeline', slug: string, taskId: string): SectionResult {
  const refused = slugRefusal(slug);
  if (refused) return refused;
  const fn = action === 'status' ? statusResult : timelineResult;
  return result(...pair(fn({ stateRoot: c.stateRoot, sourceRoot: c.cwd, taskId, slug })));
}

/** `primary --action observed --json` (`context/primary-command.ts:81-97`). */
function observedSection(c: ResolvedContext): SectionResult {
  try {
    const observed = observedSessions({ env: c.env, cwd: c.cwd });
    return observed.ok ? result(0, observed.body) : result(1, { v: 1, error: observed.error });
  } catch {
    return result(1, null); // the handler prints `[ERROR] primary: ...` to stderr only
  }
}

/** `slot --action peek --json` (`slot-command.ts:43-57`, `:63-71`). */
async function slotsSection(c: ResolvedContext): Promise<SectionResult> {
  try {
    return result(0, await peekSlots({ env: c.env, cwd: c.cwd }));
  } catch (error: any) {
    if (error?.code === 'usage') return result(2, { ok: false, error: 'usage', message: error.message });
    if (error?.code === 'no-home' || error?.code === 'slots-unsafe') return result(1, { ok: false, error: error.code, message: error.message });
    throw error;
  }
}

/** `roadmap --action status --json` (`roadmap/loop.ts:214`); a missing seed is exit 2. */
function roadmapSection(c: ResolvedContext): SectionResult {
  const answer = roadmapStatusResult({ json: true, cwd: c.cwd });
  return result(answer.exit, answer.json);
}

/** `task-attempt --action inspect --slug <slug> --json` (`task-attempts.ts:865-930`). */
function attemptsSection(c: ResolvedContext, slug: string): SectionResult {
  const refused = slugRefusal(slug);
  if (refused) return refused;
  try {
    const file = attemptsStoreFile(c.lifecycleRoot, slug);
    const roots = [...new Set([path.resolve(c.cwd), c.lifecycleRoot])]; // `rootsFor`, task-attempts.ts:273
    return result(0, inspect({ file, fsImpl: fs, roots, slug, env: c.env, cwd: c.cwd }));
  } catch (error: any) {
    if (error instanceof TaskAttemptError) {
      const e: any = error;
      return result(2, e.problems ? { ok: false, error: e.code, message: e.message, problems: e.problems } : { ok: false, error: e.code, message: e.message });
    }
    throw error;
  }
}

/** `worker --action status ... --json`: the handler prints `executeWorkerCommand`'s body (`worker/command.ts:670-677`). */
async function workerSection(c: ResolvedContext, selector: Record<string, any>): Promise<SectionResult> {
  const { exit, body } = await executeWorkerCommand({
    action: 'status', ...selector, env: c.env, cwd: c.cwd, resolveSlug: (cwd: string) => featureSlugFor({ projectRoot: cwd }),
  });
  return result(exit, body);
}

function pair(answer: { exit: number; json: any }): [number, any] {
  return [answer.exit, answer.json];
}

/** The active attempts of an `attempts` result, in task order then attempt order. */
function activeAttempts(attempts: SectionResult): Array<{ task: string; token: number }> {
  if (attempts.exit !== 0 || !attempts.json || !Array.isArray(attempts.json.tasks)) return [];
  return attempts.json.tasks.flatMap((task: any) => (Array.isArray(task?.attempts) ? task.attempts : [])
    .filter((a: any) => a && a.state === 'active' && Number.isInteger(a.token))
    .map((a: any) => ({ task: String(task.id), token: a.token })));
}

/** The worker-runs file that holds `runId`, read-only, or null. A file that cannot be read is skipped. */
function findWorkerRun(c: ResolvedContext, runId: string): { slug: string; file: string } | null {
  const dir = path.join(c.lifecycleRoot, '.doflow', 'state', 'worker-runs');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name: string) => JSON_RECORD.test(name)).sort(); } catch { return null; }
  for (const name of names) {
    const slug = name.slice(0, -'.json'.length);
    if (!isSafeSlug(slug)) continue;
    const file = path.join(dir, name);
    try {
      if (Object.prototype.hasOwnProperty.call(readRuns(file), runId)) return { slug, file };
    } catch { /* torn or newer store: not this channel's to report */ }
  }
  return null;
}

// ── Declared sources ─────────────────────────────────────────────────────────────────────────────

/** The orchestration store of `root` (flat runs and namespace directories) and each namespace directory in it. */
function orchestrationDirs(root: string): Array<{ path: string; match: RegExp }> {
  const store = runStoreDir(root);
  const dirs = [{ path: store, match: STORE_ENTRY }];
  let entries: any[] = [];
  try { entries = fs.readdirSync(store, { withFileTypes: true }); } catch { /* no store yet */ }
  for (const entry of entries.filter((e) => e.isDirectory() && isSafeSlug(e.name) && STORE_ENTRY.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    dirs.push({ path: path.join(store, entry.name), match: JSON_RECORD });
  }
  return dirs;
}

/** The checkouts other than a sandbox, and the directory git lists linked worktrees in (the checkout list). */
function checkoutRoots(c: ResolvedContext): { roots: string[]; listDir: { path: string; match: RegExp } | null } {
  const listed = listCheckouts({ cwd: c.cwd });
  const roots = new Set<string>([c.stateRoot]);
  if (listed.ok && !listed.sandbox) for (const entry of listed.entries) if (!entry.sandbox) roots.add(entry.path);
  const main = listed.ok ? listed.main : null;
  const listDir = main ? { path: path.join(main, '.git', 'worktrees'), match: /^[^.]/ } : null;
  return { roots: [...roots], listDir };
}

function nowSources(c: ResolvedContext): FollowSources {
  const { roots, listDir } = checkoutRoots(c);
  const directories = roots.flatMap((root) => orchestrationDirs(root));
  if (listDir) directories.push(listDir);
  if (c.sessionsDir) directories.push({ path: c.sessionsDir, match: /^[A-Za-z0-9]/ });
  if (c.slotsDir) directories.push({ path: c.slotsDir, match: JSON_RECORD });
  const roadmapState = path.join(c.mainRoot, '.doflow', 'state', 'roadmap');
  directories.push(
    { path: roadmapState, match: /^(?:lease\.json|runs)$/ },
    { path: path.join(roadmapState, 'runs'), match: JSON_RECORD },
    { path: path.join(c.mainRoot, 'agent-docs', 'roadmap'), match: /^rows\.json$/ },
  );
  return { directories, files: [], derived: [...CATALOGUE.now.derived], primary: null };
}

function runSources(c: ResolvedContext, slug: string, taskId: string): FollowSources {
  const file = exactName(`${taskId}.json`);
  const { roots } = checkoutRoots(c);
  const directories = roots.flatMap((root) => {
    const store = runStoreDir(root);
    return slug === taskId ? [{ path: store, match: file }] : [{ path: store, match: file }, { path: path.join(store, slug), match: file }];
  });
  let journal: string | null = null;
  if (isSafeSlug(slug)) {
    try {
      const found = findRunFile({ stateRoot: c.stateRoot, taskId, slug });
      if (found.status === 'found') journal = found.file;
    } catch { /* unlisted: the expected path below */ }
  }
  const expected = slug === taskId ? path.join(runStoreDir(c.stateRoot), `${taskId}.json`) : path.join(runStoreDir(c.stateRoot), slug, `${taskId}.json`);
  return { directories, files: [], derived: [], primary: { path: journal ?? expected } };
}

function tasksSources(c: ResolvedContext, slug: string): FollowSources {
  const state = path.join(c.lifecycleRoot, '.doflow', 'state');
  const record = exactName(`${slug}.json`);
  const planDirs = [...new Set([path.resolve(c.cwd), c.lifecycleRoot])]
    .map((root) => ({ path: path.join(root, 'agent-docs', 'doflow', slug), match: /^plan\.md$/ }));
  return {
    directories: [{ path: path.join(state, 'task-attempts'), match: record }, { path: path.join(state, 'worker-runs'), match: record }, ...planDirs],
    files: [],
    derived: [...CATALOGUE.tasks.derived],
    primary: { path: path.join(state, 'task-attempts', `${slug}.json`) },
  };
}

function workerSources(c: ResolvedContext, runId: string): FollowSources {
  const state = path.join(c.lifecycleRoot, '.doflow', 'state');
  const directories = [{ path: path.join(state, 'worker-runs'), match: JSON_RECORD }];
  const found = findWorkerRun(c, runId);
  if (found) directories.push({ path: path.join(state, 'task-attempts'), match: exactName(`${found.slug}.json`) });
  const pick = (doc: any) => (doc && doc.runs && typeof doc.runs === 'object' && Object.prototype.hasOwnProperty.call(doc.runs, runId) ? doc.runs[runId] : undefined);
  return { directories, files: [], derived: [...CATALOGUE.worker.derived], primary: found ? { path: found.file, pick } : null };
}

// ── The catalogue ────────────────────────────────────────────────────────────────────────────────

function toChannel(channel: Channel | string): Channel {
  if (typeof channel !== 'string') return channel;
  const answer = parseChannel(channel);
  if (!answer.ok) throw new TypeError(answer.reason);
  return answer.channel;
}

/** The names asked for, checked against the channel's sections; undefined asks for every section. */
function wanted(kind: Channel['kind'], only: readonly string[] | undefined): Set<string> {
  const fixed = CATALOGUE[kind].sections;
  if (only === undefined) return new Set(kind === 'tasks' ? [...fixed, WORKER_SECTIONS] : fixed);
  const names = new Set<string>();
  for (const name of only) {
    if (fixed.includes(name)) names.add(name);
    else if (kind === 'tasks' && (name === WORKER_SECTIONS || WORKER_SECTION.test(name))) names.add(WORKER_SECTIONS);
    else throw new TypeError(`'${name}' is not a section of a ${kind} channel`);
  }
  return names;
}

/**
 * The IC-004 catalogue entry of one channel.
 *
 * - `derived`: the names to declare to the detector as derived. `tasks:` declares `WORKER_SECTIONS`
 *   (`worker:*`), which stands for every worker section, because their names change.
 * - `sectionNames()`: the channel's current sections; on `tasks:`, `attempts` and the worker
 *   sections the last computation returned.
 * - `isDerived(name)`: whether a section is derived from the clock or a process (IC-004 table).
 * - `sources()`: the declared sources and primary record, read now, as `detector.follow` takes them:
 *   absolute directories with a `match` that skips `.lock` and `.tmp` entries, and `primary` (`run:`
 *   the run's journal, the expected local path while there is none; `tasks:` `task-attempts/<slug>.json`;
 *   `worker:` the worker-runs file holding the run with `pick` returning its entry, null while no file
 *   holds it; `now` none). Call it again to see a namespace directory, checkout or run file created since.
 * - `compute(only?)`: the sections named in `only` (the detector's `RecomputeRequest.sections`), or
 *   every section, each `{exit, json}` equal to the verb's exit code and parsed `--json` stdout.
 *   On `tasks:`, any worker name (or `worker:*`) recomputes the whole worker set from a fresh
 *   `attempts`, which is returned with it so the two never disagree; one section per active attempt,
 *   in task order then attempt order, at most `WORKER_SECTION_LIMIT`, and `removed` names the worker
 *   sections the previous such computation returned that are gone now. Rejects only on a fault the
 *   verb's handler would not catch either (the caller's `producer-failed`), or a name not of the channel.
 *
 * @param {Channel | string} channel a parsed channel or its IC-003 name
 * @param {SectionContext} ctx the directory the verbs run in (the events process's cwd) and the environment
 * @returns {ChannelSpec}
 */
function channelSpec(channel: Channel | string, ctx: SectionContext): ChannelSpec {
  const ch = toChannel(channel);
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd === '') throw new TypeError('a section context needs a cwd');
  const context: SectionContext = { cwd: ctx.cwd, env: ctx.env ?? process.env };
  let workers: string[] = [];
  const derived = CATALOGUE[ch.kind].derived;

  async function compute(only?: readonly string[]): Promise<ComputeResult> {
    const names = wanted(ch.kind, only);
    freshProcessCaches();
    const c = resolveContext(context);
    const sections: Sections = {};
    if (ch.kind === 'now') {
      if (names.has('list')) sections.list = listSection(c);
      if (names.has('observed')) sections.observed = observedSection(c);
      if (names.has('slots')) sections.slots = await slotsSection(c);
      if (names.has('roadmap')) sections.roadmap = roadmapSection(c);
      return { sections };
    }
    if (ch.kind === 'run') {
      if (names.has('status')) sections.status = runSection(c, 'status', ch.slug, ch.taskId);
      if (names.has('timeline')) sections.timeline = runSection(c, 'timeline', ch.slug, ch.taskId);
      return { sections };
    }
    if (ch.kind === 'worker') {
      const found = findWorkerRun(c, ch.runId);
      // No store holds the run: what `worker --action status --worker-run <id>` answers from the cwd's feature.
      sections.status = await workerSection(c, found ? { slug: found.slug, workerRun: ch.runId } : { workerRun: ch.runId });
      return { sections };
    }
    const attempts = attemptsSection(c, ch.slug);
    sections.attempts = attempts;
    if (!names.has(WORKER_SECTIONS)) return { sections };
    const current: string[] = [];
    for (const { task, token } of activeAttempts(attempts).slice(0, WORKER_SECTION_LIMIT)) {
      const name = `worker:${task}:${token}`;
      sections[name] = await workerSection(c, { slug: ch.slug, task, token: String(token) });
      current.push(name);
    }
    const removed = workers.filter((name) => !current.includes(name));
    workers = current;
    return removed.length > 0 ? { sections, removed } : { sections };
  }

  return {
    channel: ch,
    derived,
    sectionNames: () => (ch.kind === 'tasks' ? ['attempts', ...workers] : [...CATALOGUE[ch.kind].sections]),
    isDerived: (name: string) => derived.includes(name) || (ch.kind === 'tasks' && WORKER_SECTION.test(name)),
    sources(): FollowSources {
      freshProcessCaches();
      const c = resolveContext(context);
      if (ch.kind === 'now') return nowSources(c);
      if (ch.kind === 'run') return runSources(c, ch.slug, ch.taskId);
      if (ch.kind === 'tasks') return tasksSources(c, ch.slug);
      return workerSources(c, ch.runId);
    },
    compute,
  };
}

module.exports = { channelSpec, resolveContext, CATALOGUE, WORKER_SECTIONS, WORKER_SECTION_LIMIT };
