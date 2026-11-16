'use strict';

// Row 165 (design IC-001, IC-002, IC-003, D1, D6, D9, D10, §9.1-§9.3): start a harness headless as a
// started main session, and the read that feeds the start form.
//
// A started session is a worker run of kind `main-session` in the reserved run store
// `<main>/.doflow/state/worker-runs/started-sessions.json` (D1), so `worker --action status|cancel
// --slug started-sessions`, the output logs and the tree read it as they read any run. The detached
// supervisor launches it with `launch.ts`'s main-session recipe and environment (D9).
//
// `startSession` runs IC-001's checks in order, each refused before any write: (1) `nested-start`,
// (2) usage, (3) `project-mismatch` / `project-not-indexed`, (4) `unknown-worktree` / `worktree-gone`,
// (5) the prompt ids from `preparePrompt`, (6) `harness-not-startable`, (7) `model-not-offered`,
// (8) `dispatch-running`, (9) under the store lock `checkout-busy`, `actor-limit`, `machine-limit`.
// A request id already in the store is a replay: it is answered right after (3), before the checks
// that read the machine as it is now, so a retry of a started request returns that run whatever has
// changed since, and starts nothing; the store lock repeats the check, so two racing requests yield
// one run. Then the prompt is written to `session-prompts` (0600, the record keeps its sha256 and
// bytes only), the supervisor is spawned, and the record is polled up to 10 s for `starting` to end.
//
// Limits (P-4): 1 open per checkout, exact under the lock; 2 per actor and 4 on the machine, counted
// in this store under the lock plus every other indexed project's store read just before it (design
// R3 accepts the cross-project race). A run whose supervisor and worker are both seen gone is not
// open (R5); a liveness reading that is not `false` counts it open. No probe is run: readiness reads
// the version (`discover`), the probe record and the models catalogue only (D10).
//
// This module makes no fs write call: the run store is written through `insertRun` and `transition`,
// the prompt through `session-prompt.ts`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readiness = require('./readiness.ts');
const { readBindings } = require('./models.ts');
const { workerCatalogue } = require('./catalogue.ts');
const { storeFileFor, newRunId, insertRun, transition, readRuns } = require('./run-store.ts');
const { mainLaunchRecord, STARTED_RUN_VAR } = require('./launch.ts');
const { preparePrompt, writePrompt, ENTRY_LINE, PROMPT_MAX } = require('./session-prompt.ts');
const processTree = require('./process-tree.ts');
const { RELAY_LABEL } = require('../relay-label.ts');
const { cwdHash } = require('../context/identity.ts');
const { listCheckouts } = require('../checkouts.ts');
const { runKeyFor } = require('../task-run.ts');
const { sha16 } = require('../scaffold/fingerprint.ts');
const { fileKeyOf } = require('../events/artifacts.ts');
const { readDispatch } = require('../dispatch/store.ts');
const { readCatalogue } = require('../models/catalogue.ts');

/** The reserved store slug: `worker --action run` and `dispatch` refuse it (`slug-reserved`). */
const STARTED_SLUG = 'started-sessions';
const KIND = 'main-session';
const TIMEOUT_SECONDS = 3600;
const LIMITS = Object.freeze({ perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 });
const ENTRIES = Object.freeze(['do', 'none']);
const KEY16 = /^[0-9a-f]{16}$/;
const HARNESS_ID = /^[a-z][a-z0-9-]{1,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** The Console's request id (console/src/verb-runner.ts PATTERNS.requestId): 22 base64url characters, the first a letter or digit (the CLI cannot carry a flag value that begins with `-`). */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/;
const TIERS = Object.freeze(['orchestrator', 'frontier', 'standard', 'light']);
const CHECKOUTS_MAX = 64;
const MODELS_MAX = 50;
/** The label rule of src/runtime/fleet/projects.ts (IC-004 there): at most 64 of these characters, else withheld. */
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const START_WAIT_MS = 10000;
const START_POLL_MS = 100;
/** A `starting` run with no supervisor recorded is open this long after its creation (the spawn is in flight). */
const UNSUPERVISED_GRACE_MS = 60000;

/** A malformed or missing flag: exit 2 `usage` through the worker verb's error path. */
class StartUsageError extends Error {
  declare code: string;
  constructor(message: string) {
    super(message);
    this.name = 'StartUsageError';
    this.code = 'usage';
  }
}

const given = (value: any) => value !== undefined && value !== null && value !== false;
const label = (name: any) => (typeof name === 'string' && LABEL.test(name) ? name : '(withheld)');

function refusal(code: string, message: string, current?: any) {
  return { ok: false, code, message, ...(current === undefined ? {} : { current }) };
}

function pattern(value: any, re: RegExp, flag: string, what: string): string {
  if (!given(value)) throw new StartUsageError(`${flag} is required`);
  if (typeof value !== 'string' || !re.test(value)) throw new StartUsageError(`${flag} expects ${what}, got '${value}'`);
  return value;
}

/** IC-001 step 3 (and IC-002's): the cwd's project is the one `--project-key` names, and it is indexed. */
function resolveProject({ cwd, env, projectKey, projects }: any) {
  const listed = listCheckouts({ cwd });
  const here = listed.ok && listed.main ? cwdHash(listed.main) : null;
  if (here !== projectKey) {
    return { refused: refusal('project-mismatch', 'this command runs in another project than --project-key names', { projectKey: here }) };
  }
  const found = projects({ env, cwd });
  const project = found?.ok ? found.body.projects.find((p: any) => p.projectKey === projectKey) ?? null : null;
  if (!project) return { refused: refusal('project-not-indexed', "this project is not in DoFlow's project index on this machine") };
  return { listed, project, others: found.body.projects.filter((p: any) => p.projectKey !== projectKey) };
}

/** A checkout git still lists whose directory is gone, matched by key. Read-only. */
function worktreeGone(main: string, worktreeKey: string): boolean {
  const r = spawnSync('git', ['-C', main, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return false;
  return String(r.stdout).split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .some((p) => !fs.existsSync(p) && cwdHash(p) === worktreeKey);
}

/** The worker blocks in registry order: `[{ harness, worker }]`, an injected descriptor winning. */
function harnessBlocks(reg: any, descriptors: any) {
  return workerCatalogue({ registry: reg }).map((entry: any) => ({
    harness: entry.id,
    worker: descriptors && Object.hasOwn(descriptors, entry.id) ? descriptors[entry.id] : entry.worker,
  }));
}

/**
 * D10 / §9.2 for one harness: `{ harness, startable, reason, words, warnings, login, version }`, plus the
 * discover entry as `found` (not part of the reply). The shape is checked first, so a harness DoFlow cannot
 * start headless is never run, not even for its version.
 */
function harnessFacts({ harness, worker, reg, env, cwd, root, nowMs, platform, catalogue }: any) {
  const shut = (reason: string, words: string, extra: any = {}) => ({
    harness, startable: false, reason, words, warnings: [] as string[], login: null, version: null, found: null, ...extra,
  });
  if (!worker) return shut('not-listed', `${harness} is not a DoFlow harness`);
  const ms = worker.mainSession;
  if (ms?.status !== 'supported' || !Array.isArray(ms.evidence) || ms.evidence.length === 0) {
    return shut('no-main-session-shape', `DoFlow has no recorded headless way to start ${harness}${typeof ms?.reason === 'string' ? `: ${ms.reason}` : ''}`);
  }
  const found = readiness.discover({ descriptors: { [harness]: worker }, registry: reg, env, cwd, now: nowMs, platform }).harnesses[0];
  if (!found?.present) return shut('not-installed', `${harness} is not installed on this machine`);
  const entry = catalogue?.harnesses && Object.hasOwn(catalogue.harnesses, harness) ? catalogue.harnesses[harness] : null;
  const login = entry ? { state: entry.loginState ?? null, checkedAt: entry.lastSyncedAt ?? null } : null;
  if (login?.state === 'logged-out') {
    return shut('logged-out', `${harness} is logged out: ${entry.reloginHint || 'log in to it again'}`, { login, version: found.version, found });
  }
  const warnings: string[] = [];
  let runnable: any = null;
  try {
    runnable = readiness.effectiveFacts(readiness.readProbeRecord(root, harness), { ...found, descriptorDigest: readiness.descriptorDigest(worker) }, nowMs).runnable;
  } catch {
    runnable = null;
  }
  if (runnable?.state !== 'yes') warnings.push('runnable-not-checked');
  if (login?.state !== 'logged-in') warnings.push('login-not-checked');
  if (ms.promptVia === 'argv') warnings.push('prompt-in-argv');
  return { harness, startable: true, reason: null, words: `${harness} can start a session here`, warnings, login, version: found.version, found };
}

/** IC-002: the models offered for `harness`, de-duplicated in source order, then the harness default; at most 50. */
function modelsFor({ harness, worker, bindings, catalogue }: any) {
  const out: any[] = [];
  const seen = new Set<string>();
  const add = (id: any, source: string) => {
    if (typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id) || out.length >= MODELS_MAX - 1) return;
    seen.add(id);
    out.push({ id, source });
  };
  // A model reaches argv only through the descriptor's `model` entry (IC-006), so without one only the default is offered.
  if (worker?.model?.status === 'supported' && Array.isArray(worker.model.argv)) {
    const map = bindings?.state === 'set' && bindings.map && Object.hasOwn(bindings.map, harness) ? bindings.map[harness] : null;
    for (const tier of TIERS) add(map && Object.hasOwn(map, tier) ? map[tier] : null, tier);
    const entry = catalogue?.harnesses && Object.hasOwn(catalogue.harnesses, harness) ? catalogue.harnesses[harness] : null;
    for (const model of Array.isArray(entry?.offeredModels) ? entry.offeredModels : []) add(model?.id, 'observed');
  }
  out.push({ id: null, source: 'default' });
  return out;
}

/**
 * §9.3: the project's dispatch is running when a dispatch store holds a driver with no `endedAt` and no
 * `lost` that `alive` reads as true, or a non-ended dispatch in a main-session mode. A liveness reading
 * of `unknown`, or a store that cannot be read, refuses too (fail closed). Read-only; signals nothing.
 */
function dispatchRunning(root: string, platform: string) {
  // Required here: admission.ts requires worker/command.ts, which requires this module.
  const { MAIN_SESSION_MODES } = require('../dispatch/admission.ts');
  const dir = path.join(root, '.doflow', 'state', 'dispatch');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name: string) => name.endsWith('.json')).sort(); } catch { return null; }
  for (const name of names) {
    const slug = name.slice(0, -'.json'.length);
    let store: any;
    try { store = readDispatch(path.join(dir, name)); } catch { return { slug, reason: 'store-unreadable' }; }
    for (const d of store.drivers) {
      if (!d || d.endedAt || d.lost) continue;
      const live = processTree.alive({ pid: d.pid, pgid: d.pid, start: d.start ?? null }, { platform });
      if (live === true) return { slug, driverPid: d.pid };
      if (live !== false) return { slug, driverPid: d.pid, reason: 'liveness-unknown' };
    }
    for (const d of Object.values(store.dispatches) as any[]) {
      if (d.phase !== 'ended' && MAIN_SESSION_MODES.includes(d.mode)) return { slug, dispatchId: d.dispatchId ?? null };
    }
  }
  return null;
}

/** R5: a non-ended main-session run whose supervisor and worker are both seen gone. Reads `ps`; never under a lock. */
function isDead(run: any, platform: string, nowMs: number): boolean {
  if (!run.supervisor) return !(Date.parse(run.createdAt) > nowMs - UNSUPERVISED_GRACE_MS);
  const gone = (proc: any) => !proc || processTree.alive(proc, { platform }) === false;
  return gone(run.supervisor) && gone(run.worker);
}

const isOpenShape = (run: any) => run && run.kind === KIND && run.phase !== 'ended';

/** The open main-session runs of one store, liveness read now. */
function openRuns(runs: Record<string, any>, platform: string, nowMs: number): any[] {
  return Object.values(runs).filter((run: any) => isOpenShape(run) && !isDead(run, platform, nowMs));
}

/** The open started sessions of every other indexed project: `{ total, byActor }`. An unreadable store counts nothing. */
function elsewhere(others: any[], platform: string, nowMs: number) {
  const out = { total: 0, byActor: new Map<string, number>() };
  for (const project of others) {
    let runs: any = {};
    try { runs = readRuns(storeFileFor(project.root, STARTED_SLUG)); } catch { continue; }
    for (const run of openRuns(runs, platform, nowMs)) {
      out.total += 1;
      out.byActor.set(run.startedBy, (out.byActor.get(run.startedBy) ?? 0) + 1);
    }
  }
  return out;
}

/** IC-001's reply `run` from a record. */
function replyRun(run: any, root: string, projectKey: string) {
  const agentKey = sha16(`worker:${run.runId}`);
  const rel = (stream: string) => `.doflow/state/worker-output/${run.runId}.${stream}.log`;
  return {
    runId: run.runId, kind: KIND, phase: run.phase, harness: run.harness, model: run.binding?.model ?? null,
    modelSource: run.binding?.source ?? 'default', worktreeKey: run.project?.worktreeKey ?? null, startedBy: run.startedBy ?? null,
    createdAt: run.createdAt, agentKey, layers: `/layers/${projectKey}/agent/${agentKey}`,
    files: { out: fileKeyOf(root, rel('out')), err: fileKeyOf(root, rel('err')) },
    ...(run.phase === 'ended' && run.end ? { end: run.end } : {}),
  };
}

const replayOf = (runs: Record<string, any>, requestId: string) => (Object.values(runs) as any[])
  .find((run) => run.kind === KIND && run.task === KIND && run.token === 1 && (run.childOf ?? null) === null && run.request === requestId) ?? null;

/**
 * IC-001. `o`: the flags (`projectKey`, `worktreeKey`, `harness`, `model`, `entry`, `via`, `requestId`, `stdin`),
 * `readStdin()`, `env`, `cwd`, `root` (the lifecycle project root), `reg`, `descriptors`, `platform`, `clock`, `sleep`,
 * `projects(o)` (listProjects) and `spawnSupervisor({ file, runId })`. Resolves IC-001's reply.
 */
async function startSession(o: any) {
  const { env, cwd, root, reg, descriptors, platform, clock, sleep, projects, spawnSupervisor } = o;
  const nowMs = () => clock().getTime();

  // Step 1: a start from inside a started session.
  if (typeof env[STARTED_RUN_VAR] === 'string') {
    return refusal('nested-start', 'a started session cannot start another session', { runId: env[STARTED_RUN_VAR] });
  }

  // Step 2: the flags, each by pattern.
  const projectKey = pattern(o.projectKey, KEY16, '--project-key', '16 lowercase hex characters');
  const worktreeKey = pattern(o.worktreeKey, KEY16, '--worktree-key', '16 lowercase hex characters');
  const harness = pattern(o.harness, HARNESS_ID, '--harness', 'a harness id');
  const entry = pattern(o.entry, /^(?:do|none)$/, '--entry', 'do or none');
  const requestId = pattern(o.requestId, REQUEST_ID, '--request-id', '22 base64url characters beginning with a letter or digit');
  const model = given(o.model) ? pattern(o.model, MODEL_ID, '--model', 'a model id') : null;
  const startedBy = given(o.via) ? pattern(o.via, RELAY_LABEL, '--via', 'console or device.d-<12 lowercase hex>') : 'manual';
  if (o.stdin !== true) throw new StartUsageError('--stdin is required: the prompt is read from stdin');

  // Step 3: the project.
  const resolved = resolveProject({ cwd, env, projectKey, projects });
  if (resolved.refused) return resolved.refused;
  const file = storeFileFor(root, STARTED_SLUG);
  const prior = replayOf(readRuns(file), requestId);
  if (prior) return { ok: true, replayed: true, run: replyRun(prior, root, projectKey) };

  // Step 4: the checkout.
  const checkout = resolved.listed.entries.find((e: any) => !e.sandbox && cwdHash(e.path) === worktreeKey) ?? null;
  if (!checkout) {
    return worktreeGone(resolved.listed.main, worktreeKey)
      ? refusal('worktree-gone', 'this checkout no longer exists')
      : refusal('unknown-worktree', '--worktree-key names no checkout of this project');
  }

  // Step 5: the prompt, as the harness takes it.
  const blocks = harnessBlocks(reg, descriptors);
  const worker = blocks.find((b: any) => b.harness === harness)?.worker ?? null;
  const promptVia = worker?.mainSession?.promptVia === 'argv' ? 'argv' : 'stdin';
  const prepared = preparePrompt(o.readStdin(), { entry, promptVia });
  if (!prepared.ok) return refusal(prepared.code, `the prompt is refused: ${prepared.code}`);

  // Step 6: the harness is startable here and now.
  const catalogue = readCatalogue(root, { env });
  const facts = harnessFacts({ harness, worker, reg, env, cwd, root, nowMs, platform, catalogue });
  if (!facts.startable) return refusal('harness-not-startable', facts.words, { harness, reason: facts.reason });

  // Step 7: the model is one the options offer.
  const offered = modelsFor({ harness, worker, bindings: readBindings({ env, projectRoot: root }), catalogue });
  const choice = offered.find((m: any) => m.id === model) ?? null;
  if (!choice) return refusal('model-not-offered', `${harness} is not offered the model '${model}' here`, { harness, models: offered });

  // Step 8: no dispatch of this project is running.
  const dispatch = dispatchRunning(root, platform);
  if (dispatch) return refusal('dispatch-running', `a dispatch is running in ${dispatch.slug}; start again when it ends`, dispatch);

  // Step 9: the record, inserted under the store lock with the limits.
  const runId = newRunId();
  const key = runKeyFor(env, cwd);
  const record = {
    runId, kind: KIND, task: KIND, token: 1, request: requestId, childOf: null,
    harness, phase: 'starting', createdAt: clock().toISOString(), timeoutSeconds: TIMEOUT_SECONDS, cliVersion: facts.version,
    caller: { lineageKind: key.identity.lineageKind, runKey: key.runKey },
    startedBy, project: { projectKey, worktreeKey }, execWorktree: checkout.path, entry,
    binding: { model, flag: model === null ? null : 'supported', source: choice.source },
    prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: prepared.sha256, bytes: prepared.bytes },
    ...mainLaunchRecord(worker, prepared.sent, model),
    // The detached supervisor launches from the record alone: the binary the version read found (an absolute
    // path, as `run` records), the recipe and the model part.
    descriptor: { cli: { binary: facts.found.path }, mainSession: worker.mainSession, model: worker.model ?? null },
  };
  // Liveness is read outside the lock (`ps` is a process); a run inserted after this reading is counted open.
  const dead = new Set((Object.values(readRuns(file)) as any[]).filter((run) => isOpenShape(run) && isDead(run, platform, nowMs())).map((run) => run.runId));
  const away = elsewhere(resolved.others, platform, nowMs());
  const inserted = insertRun(file, record, fs, {
    refuse: (store: any) => {
      const open = (Object.values(store.runs) as any[]).filter((run) => isOpenShape(run) && !dead.has(run.runId));
      const busy = open.find((run) => run.project?.worktreeKey === worktreeKey);
      if (busy) return { code: 'checkout-busy', current: { runId: busy.runId } };
      const mine = open.filter((run) => run.startedBy === startedBy).length + (away.byActor.get(startedBy) ?? 0);
      if (mine >= LIMITS.perActor) return { code: 'actor-limit', current: { open: mine, max: LIMITS.perActor } };
      const all = open.length + away.total;
      if (all >= LIMITS.machine) return { code: 'machine-limit', current: { open: all, max: LIMITS.machine } };
      return null;
    },
  });
  if (!inserted.applied) {
    if (inserted.reason === 'run-exists') {
      const existing = readRuns(file)[inserted.runId];
      return { ok: true, replayed: true, run: replyRun(existing, root, projectKey) };
    }
    return refusal(inserted.reason, LIMIT_WORDS[inserted.reason] ?? inserted.reason, inserted.current);
  }

  // The prompt (IC-005), then the supervisor. A prompt that cannot be written ends the run not-started.
  try {
    const runs = readRuns(file);
    writePrompt(root, runId, prepared.sent, { isEnded: (id: string) => !runs[id] || runs[id].phase === 'ended', now: nowMs() });
  } catch (error: any) {
    transition(file, runId, ['starting'], (run: any) => {
      const at = clock().toISOString();
      run.process = { kind: 'not-started', reason: 'prompt-unwritable', at, detail: typeof error?.code === 'string' ? error.code : null };
      run.end = { state: 'exited', at };
      run.phase = 'ended';
    });
    return { ok: true, replayed: false, run: replyRun(readRuns(file)[runId], root, projectKey) };
  }
  spawnSupervisor({ file, runId });

  // Poll up to 10 s for the record to leave `starting`.
  const until = nowMs() + START_WAIT_MS;
  let run = readRuns(file)[runId];
  while (run && run.phase === 'starting' && nowMs() < until) {
    await sleep(START_POLL_MS);
    run = readRuns(file)[runId];
  }
  return { ok: true, replayed: false, run: replyRun(run, root, projectKey) };
}

const LIMIT_WORDS: Record<string, string> = Object.freeze({
  'checkout-busy': 'a started session is already open in this checkout',
  'actor-limit': `this actor already has ${LIMITS.perActor} started sessions open`,
  'machine-limit': `${LIMITS.machine} started sessions are already open on this machine`,
});

/** IC-002's `observedSession` per checkout: the newest hook-observed session there, `{ harness, lastSeenAt }`. */
function observedByCheckout(env: any, cwd: string): Map<string, any> {
  const out = new Map<string, any>();
  let body: any = null;
  try {
    // Required here: the observed-session reader lists checkouts and reads hook records, which only this read needs.
    const answer = require('../context/primary.ts').observedSessions({ env, cwd });
    body = answer?.ok ? answer.body : null;
  } catch {
    body = null;
  }
  for (const s of Array.isArray(body?.sessions) ? body.sessions : []) {
    const at = s.lastHookRecordAt ?? s.startedAt ?? s.modelFirstSeenAt ?? null;
    if (typeof s.worktreeKey !== 'string' || typeof at !== 'string') continue;
    const seen = out.get(s.worktreeKey);
    if (!seen || Date.parse(at) > Date.parse(seen.lastSeenAt)) out.set(s.worktreeKey, { harness: s.harness ?? null, lastSeenAt: at });
  }
  return out;
}

/**
 * IC-002. `o`: `projectKey`, `env`, `cwd`, `root`, `reg`, `descriptors`, `platform`, `clock`, `projects(o)`.
 * Resolves the options, or a `project-mismatch` / `project-not-indexed` refusal. Writes nothing.
 */
function startOptions(o: any) {
  const { env, cwd, root, reg, descriptors, platform, clock, projects } = o;
  const nowMs = () => clock().getTime();
  const projectKey = pattern(o.projectKey, KEY16, '--project-key', '16 lowercase hex characters');
  const resolved = resolveProject({ cwd, env, projectKey, projects });
  if (resolved.refused) return resolved.refused;

  const open = openRuns(readRuns(storeFileFor(root, STARTED_SLUG)), platform, nowMs());
  const observed = observedByCheckout(env, root);
  const checkouts = resolved.listed.entries.filter((e: any) => !e.sandbox).slice(0, CHECKOUTS_MAX).map((e: any) => {
    const worktreeKey = cwdHash(e.path);
    const busy = open.find((run: any) => run.project?.worktreeKey === worktreeKey);
    return {
      worktreeKey, label: label(path.basename(e.path)), branch: e.branch === null ? null : label(e.branch), main: e.path === resolved.listed.main,
      busy: busy ? { runId: busy.runId } : null, observedSession: observed.get(worktreeKey) ?? null,
    };
  });
  const catalogue = readCatalogue(root, { env });
  const bindings = readBindings({ env, projectRoot: root });
  const harnesses = harnessBlocks(reg, descriptors).map(({ harness, worker }: any) => {
    const { found, ...facts } = harnessFacts({ harness, worker, reg, env, cwd, root, nowMs, platform, catalogue });
    return { ...facts, models: modelsFor({ harness, worker, bindings, catalogue }) };
  });
  const dispatch = dispatchRunning(root, platform);
  return {
    project: { projectKey, label: resolved.project.label, root: null },
    checkouts,
    harnesses,
    limits: LIMITS,
    open: { machine: open.length + elsewhere(resolved.others, platform, nowMs()).total },
    dispatch: dispatch ? { running: true, slug: dispatch.slug } : { running: false },
    promptMax: PROMPT_MAX,
    entries: ENTRIES,
    entryLine: ENTRY_LINE,
  };
}

module.exports = { startSession, startOptions, STARTED_SLUG, KIND, LIMITS, StartUsageError };
