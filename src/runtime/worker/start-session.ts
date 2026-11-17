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
// (8) `dispatch-running`, (9) under the store lock `checkout-busy`, `actor-limit`, `machine-limit`,
// `start-rate-limited`. A harness whose control channel is supported always starts through it (170 A-2): the first
// prompt is then refused `command-not-allowed` at (5) when it starts with the channel's command prefix (R-4), and
// framed exactly as the supervisor will frame it, so a prompt the channel would refuse is refused before any write.
// A request id already in the store is a replay: it is answered right after (3), before the checks
// that read the machine as it is now, so a retry of a started request returns that run whatever has
// changed since, and starts nothing; the store lock repeats the check, so two racing requests yield
// one run. Then the prompt is written to `session-prompts` (0600, the record keeps its sha256 and
// bytes only), the supervisor is spawned, and the record is polled up to 10 s for `starting` to end.
//
// Limits (P-4): 1 open per checkout, exact under the lock; 2 per actor and 4 on the machine, counted
// in this store under the lock plus every other indexed project's store read just before it (design
// R3 accepts the cross-project race). 170 R-5: 6 starts per actor per hour, counted the same way over
// every started session created in the last hour, ended or not. A run is not open only on positive evidence that it is dead
// (R5, 165 review A-1: `liveness` below); one whose liveness cannot be read counts open, and in the
// checkout it is refused `checkout-busy-unknown`, which names the cancel that clears it. No probe is
// run: readiness reads the version (`discover`), the probe record and the models catalogue, and login is the
// `harness-login` store's answer (172 IC-004, D12): `logged-out` is not startable, `expired` and `unknown` warn.
//
// This module makes no fs write call: the run store is written through `insertRun` and `transition`,
// the prompt through `session-prompt.ts`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readiness = require('./readiness.ts');
const { readBindings, resolveBinding, bindingGap } = require('./models.ts');
const { PROVIDER_RE, EFFORT_RE } = require('../../registry/model-parts.ts');
const { cellFor } = require('../models/tier-view.ts');
const { workerCatalogue } = require('./catalogue.ts');
const { PARSERS, parserIdOf } = require('./parsers.ts');
const { workerIdFault } = require('../../registry/worker-ids.ts');
const { storeFileFor, newRunId, insertRun, transition, readRuns } = require('./run-store.ts');
const { mainLaunchRecord, STARTED_RUN_VAR } = require('./launch.ts');
const { compileChannel, frameMessage, commandRefusal, idOf } = require('./channel.ts');
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
const { loginAnswerOf } = require('./login.ts');
const { readLoginStore } = require('./login-store.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

/** The reserved store slug: `worker --action run` and `dispatch` refuse it (`slug-reserved`). */
const STARTED_SLUG = 'started-sessions';
const KIND = 'main-session';
const TIMEOUT_SECONDS = 3600;
const LIMITS = Object.freeze({ perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 });
const ENTRIES = Object.freeze(['do', 'none']);
const KEY16 = /^[0-9a-f]{16}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** The Console's request id (console/src/verb-runner.ts PATTERNS.requestId): 22 base64url characters, the first a letter or digit (the CLI cannot carry a flag value that begins with `-`). */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/;
const TIERS = Object.freeze(['orchestrator', 'frontier', 'standard', 'light']);
/**
 * 165 review B-3: the flags of `start-session` beside `--action`. Step 2 refuses a start without each required one; the Console's
 * terminal command (console/web/derive/start.js `terminalCommand`) and docs/reference.md's Command line are tested against this list.
 */
const START_FLAGS = Object.freeze({
  required: Object.freeze(['--project-key', '--worktree-key', '--harness', '--entry', '--request-id', '--stdin']),
  optional: Object.freeze(['--model', '--provider', '--effort', '--via', '--json']),
});
const CHECKOUTS_MAX = 64;
const MODELS_MAX = 50;
/** The label rule of src/runtime/fleet/projects.ts (IC-004 there): at most 64 of these characters, else withheld. */
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const START_WAIT_MS = 10000;
const START_POLL_MS = 100;
const HOUR_MS = 60 * 60 * 1000;
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

/**
 * 171 FR-006: the part of a worker's `structuredOutput` the detached supervisor needs to resolve the main-session parser: its own
 * field map, only when `mainSession.parser` is no `PARSERS` key and names that map's id. A built-in's record stays unchanged.
 */
function mapPart(worker: any): { structuredOutput?: { fieldMap: any } } {
  const map = worker.structuredOutput?.fieldMap;
  // 170: a channel's parser may name the same map (C5), so either id carries it.
  const named = [parserIdOf(worker.mainSession), parserIdOf(worker.controlChannel)]
    .some((id) => typeof id === 'string' && !Object.hasOwn(PARSERS, id) && map?.id === id);
  return named ? { structuredOutput: { fieldMap: map } } : {};
}

/** 172 FR-011: the expiry signs the supervisor matches on a started session's failure, only when the worker declares some. */
function signsPart(worker: any): { loginProbe?: { expirySigns: any } } {
  const signs = worker.loginProbe?.expirySigns;
  return signs && typeof signs === 'object' ? { loginProbe: { expirySigns: signs } } : {};
}

/** The worker blocks in catalogue order, package workers included: `[{ harness, worker }]`, an injected descriptor winning. */
function harnessBlocks(reg: any, descriptors: any, view: any) {
  return workerCatalogue({ registry: reg, view }).map((entry: any) => ({
    harness: entry.id,
    worker: descriptors && Object.hasOwn(descriptors, entry.id) ? descriptors[entry.id] : entry.worker,
  }));
}

/**
 * 165 review B-8: whether the main-session shape was seen on a live run: some record its `mainSession.evidence` cites is a `live-run`
 * record of this harness (as G41.5 reads `readOnly`). A help-only (`cli-check`) record, a missing or unreadable one, and a package
 * worker's (its paths are not under DoFlow's root) are false: not verified is the answer whenever it cannot be shown.
 * 170 D11: `entry` is any capability entry that carries evidence (`mainSession`, `controlChannel`).
 */
function liveVerified(harness: string, entry: any): boolean {
  if (!Array.isArray(entry?.evidence)) return false;
  return entry.evidence.some((item: unknown) => {
    if (typeof item !== 'string' || path.isAbsolute(item)) return false;
    const file = path.resolve(REPO_ROOT, item);
    if (!file.startsWith(REPO_ROOT + path.sep)) return false;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      return record?.kind === 'live-run' && record.harness === harness;
    } catch {
      return false;
    }
  });
}

/**
 * 170 IC-006: the channel fact of one harness, `{ state, reason, liveVerified, unverified }`. A descriptor without a
 * `controlChannel` entry (or one with another status) is `unknown`, never `unsupported`: nothing is said without evidence (R-11).
 */
function channelFact(harness: string, worker: any) {
  const entry = worker?.controlChannel;
  const state = entry?.status === 'supported' || entry?.status === 'unsupported' ? entry.status : 'unknown';
  const fallback = worker ? 'no-control-channel-entry' : 'not-listed';
  return {
    state,
    reason: state === 'supported' ? null : typeof entry?.reason === 'string' ? entry.reason : fallback,
    liveVerified: state === 'supported' && liveVerified(harness, entry),
    unverified: state === 'supported' && Array.isArray(entry.unverified) ? entry.unverified.filter((u: unknown) => typeof u === 'string') : [] as string[],
  };
}

/**
 * D10 / §9.2 for one harness: `{ harness, startable, reason, words, warnings, login, version, liveVerified }`, plus the
 * discover entry as `found` (not part of the reply). The shape is checked first, so a harness DoFlow cannot
 * start headless is never run, not even for its version. `login` is 172's `LoginAnswer` from `store` (null before
 * the harness is found installed).
 */
function harnessFacts({ harness, worker, reg, view, env, cwd, root, nowMs, platform, store }: any) {
  const channel = channelFact(harness, worker);
  const shut = (reason: string, words: string, extra: any = {}) => ({
    harness, startable: false, reason, words, warnings: [] as string[], login: null, version: null, liveVerified: false, channel, found: null, ...extra,
  });
  if (!worker) return shut('not-listed', workerIdFault(harness) ? 'the --harness value is not a DoFlow harness id' : `${harness} is not a DoFlow harness`);
  const ms = worker.mainSession;
  if (ms?.status !== 'supported' || !Array.isArray(ms.evidence) || ms.evidence.length === 0) {
    return shut('no-main-session-shape', `DoFlow has no recorded headless way to start ${harness}${typeof ms?.reason === 'string' ? `: ${ms.reason}` : ''}`);
  }
  const found = readiness.discover({ descriptors: { [harness]: worker }, registry: reg, view, env, cwd, now: nowMs, platform }).harnesses[0];
  if (!found?.present) return shut('not-installed', `${harness} is not installed on this machine`);
  const stored = store ?? readLoginStore(env);
  const login = loginAnswerOf({ harness, worker, record: Object.hasOwn(stored.harnesses, harness) ? stored.harnesses[harness] : null, now: nowMs });
  if (login.state === 'logged-out') {
    const how = login.hint ? `run ${login.hint} in a terminal` : 'log in to it again';
    return shut('logged-out', `${harness} is logged out: ${how}, then doflow models --action sync`, { login, version: found.version, found });
  }
  const warnings: string[] = [];
  let runnable: any = null;
  try {
    runnable = readiness.effectiveFacts(readiness.readProbeRecord(root, harness), { ...found, descriptorDigest: readiness.descriptorDigest(worker) }, nowMs).runnable;
  } catch {
    runnable = null;
  }
  if (runnable?.state !== 'yes') warnings.push('runnable-not-checked');
  if (login.state === 'expired') warnings.push('login-expired');
  else if (login.state === 'unknown') warnings.push('login-unknown');
  // 170 A-2: a harness with a supported channel takes its prompt as a framed message, never in argv.
  if (ms.promptVia === 'argv' && compileChannel(worker) === null) warnings.push('prompt-in-argv');
  if (channel.state === 'supported' && !channel.liveVerified) warnings.push('channel-not-verified-live');
  return { harness, startable: true, reason: null, words: `${harness} can start a session here`, warnings, login, version: found.version, liveVerified: liveVerified(harness, ms), channel, found };
}

/**
 * IC-002, 169 IC-007: the models offered for `harness`, in source order (each tier binding, then each model the harness listed),
 * then the harness default; at most 50. An entry is the IC-005 cell of its choice, `{ model, provider, effort, check, effortMayLower? }`,
 * with its `source`; a bound entry the harness cannot take a part of carries `refused: <reason>` (`bindingGap`'s reason) and cannot
 * start. An entry is one triple: the same model under another provider or effort is another entry. The default is `model: null`.
 */
function modelsFor({ harness, worker, bindings, catalogue }: any) {
  const out: any[] = [];
  const seen = new Set<string>();
  const listed = catalogue?.harnesses && Object.hasOwn(catalogue.harnesses, harness) ? catalogue.harnesses[harness] : null;
  const add = (choice: any, source: string, refused: string | null = null) => {
    if (!choice || !MODEL_ID.test(choice.model) || out.length >= MODELS_MAX - 1) return;
    if ((choice.provider !== null && !PROVIDER_RE.test(choice.provider)) || (choice.effort !== null && !EFFORT_RE.test(choice.effort))) return;
    const key = JSON.stringify([choice.model, choice.provider, choice.effort]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...cellFor(choice, worker, listed, refused), source });
  };
  // A model reaches argv only through the descriptor's `model` entry (IC-006), so without one only the default is offered.
  if (worker?.model?.status === 'supported' && Array.isArray(worker.model.argv)) {
    for (const tier of TIERS) {
      const bound = resolveBinding({ worker: harness, tier, bindings, descriptor: worker });
      if (bound.source === 'binding') add(bound.choice, tier, bindingGap(bound)?.reason ?? null);
    }
    const byProvider = worker.provider?.status === 'supported';
    for (const model of Array.isArray(listed?.offeredModels) ? listed.offeredModels : []) {
      add({ model: model?.id, provider: byProvider && typeof model?.provider === 'string' ? model.provider : null, effort: null }, 'observed');
    }
  }
  out.push({ model: null, provider: null, effort: null, source: 'default', check: null });
  return out;
}

/**
 * §9.3: the project's dispatch is running when a dispatch store holds a driver with no `endedAt` and no
 * `lost` that `alive` reads as true, or a non-ended dispatch in a main-session mode. A liveness reading
 * of `unknown`, or a store that cannot be read, refuses too (fail closed). Only a missing dispatch directory means there is
 * no dispatch record; any other failure to list it refuses with `{ slug: null, reason: 'dispatch-unreadable', detail }`
 * (165 review A-3). Read-only; signals nothing.
 */
function dispatchRunning(root: string, platform: string) {
  // Required here: admission.ts requires worker/command.ts, which requires this module.
  const { MAIN_SESSION_MODES } = require('../dispatch/admission.ts');
  const dir = path.join(root, '.doflow', 'state', 'dispatch');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name: string) => name.endsWith('.json')).sort();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    return { slug: null, reason: 'dispatch-unreadable', detail: typeof error?.code === 'string' ? error.code : null };
  }
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

/**
 * 165 review A-1: whether any process of this user names a run id in its command line or environment (the supervisor's argv
 * carries the run id, the harness's environment `DOFLOW_STARTED_RUN`): `found`, `none` or `unknown` when the listing cannot be
 * read. The listing is read once, on the first question, and only when one is asked.
 */
function namingScan(platform: string) {
  let texts: string[] | null | undefined;
  return (runId: string): 'found' | 'none' | 'unknown' => {
    if (texts === undefined) texts = processTree.processTexts({ platform });
    if (texts === null || texts === undefined) return 'unknown';
    return texts.some((text) => text.includes(runId)) ? 'found' : 'none';
  };
}

/**
 * R5, 165 review A-1: `live`, `dead` or `unknown` for a non-ended main-session run. It is dead only on positive evidence: every
 * process it records (supervisor, worker; pid and start, as `processTree.alive` reads them) is seen gone, and when it records
 * fewer than both, no process of this user names it (`named`). With neither recorded it is `live` for UNSUPERVISED_GRACE_MS
 * after its creation, while the spawn is in flight. A reading that is neither true nor false is `unknown`. Reads `ps`; never
 * under a lock.
 */
function liveness(run: any, platform: string, nowMs: number, named: (runId: string) => string): 'live' | 'dead' | 'unknown' {
  const recorded = [run.supervisor, run.worker].filter(Boolean);
  const reads = recorded.map((proc: any) => processTree.alive(proc, { platform }));
  if (reads.includes(true)) return 'live';
  if (reads.some((read: any) => read !== false)) return 'unknown';
  if (recorded.length === 2) return 'dead';
  if (recorded.length === 0 && Date.parse(run.createdAt) > nowMs - UNSUPERVISED_GRACE_MS) return 'live';
  const seen = named(run.runId);
  return seen === 'none' ? 'dead' : seen === 'found' ? 'live' : 'unknown';
}

const isOpenShape = (run: any) => run && run.kind === KIND && run.phase !== 'ended';

/** The open main-session runs of one store, each with its liveness read now: `[{ run, state }]`, the dead left out. */
function openRuns(runs: Record<string, any>, platform: string, nowMs: number, named: (runId: string) => string): Array<{ run: any; state: string }> {
  return (Object.values(runs) as any[]).filter(isOpenShape)
    .map((run) => ({ run, state: liveness(run, platform, nowMs, named) }))
    .filter((entry) => entry.state !== 'dead');
}

/** 170 R-5: the creation times (ms) of the started sessions in `runs` created in the hour before `nowMs`, by actor. */
function startsByActor(runs: Record<string, any>, nowMs: number, into: Map<string, number[]> = new Map()): Map<string, number[]> {
  for (const run of Object.values(runs) as any[]) {
    const at = Date.parse(run?.createdAt);
    if (run?.kind !== KIND || !Number.isFinite(at) || at <= nowMs - HOUR_MS || at > nowMs) continue;
    into.set(run.startedBy, [...(into.get(run.startedBy) ?? []), at]);
  }
  return into;
}

/**
 * The open started sessions of every other indexed project: `{ total, byActor }`, and `startedByActor`, the creation
 * times of the sessions each actor started there in the last hour (R-5). An unreadable store counts nothing.
 */
function elsewhere(others: any[], platform: string, nowMs: number, named: (runId: string) => string) {
  const out = { total: 0, byActor: new Map<string, number>(), startedByActor: new Map<string, number[]>() };
  for (const project of others) {
    let runs: any = {};
    try { runs = readRuns(storeFileFor(project.root, STARTED_SLUG)); } catch { continue; }
    for (const { run } of openRuns(runs, platform, nowMs, named)) {
      out.total += 1;
      out.byActor.set(run.startedBy, (out.byActor.get(run.startedBy) ?? 0) + 1);
    }
    startsByActor(runs, nowMs, out.startedByActor);
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
 * IC-001. `o`: the flags (`projectKey`, `worktreeKey`, `harness`, `model`, `provider`, `effort`, `entry`, `via`, `requestId`, `stdin`),
 * `readStdin()`, `env`, `cwd`, `root` (the lifecycle project root), `reg`, `descriptors`, `platform`, `clock`, `sleep`,
 * `projects(o)` (listProjects) and `spawnSupervisor({ file, runId })`. Resolves IC-001's reply.
 */
async function startSession(o: any) {
  const { env, cwd, root, reg, descriptors, view, platform, clock, sleep, projects, spawnSupervisor } = o;
  const nowMs = () => clock().getTime();

  // Step 1: a start from inside a started session.
  if (typeof env[STARTED_RUN_VAR] === 'string') {
    return refusal('nested-start', 'a started session cannot start another session', { runId: env[STARTED_RUN_VAR] });
  }

  // Step 2: the flags, each by pattern.
  const projectKey = pattern(o.projectKey, KEY16, '--project-key', '16 lowercase hex characters');
  const worktreeKey = pattern(o.worktreeKey, KEY16, '--worktree-key', '16 lowercase hex characters');
  // 165 review A-2: any id the registry's worker-id grammar refuses is simply not listed (step 6), not a usage error.
  if (typeof o.harness !== 'string' || o.harness === '') throw new StartUsageError('--harness is required');
  const harness = o.harness;
  const entry = pattern(o.entry, /^(?:do|none)$/, '--entry', 'do or none');
  const requestId = pattern(o.requestId, REQUEST_ID, '--request-id', '22 base64url characters beginning with a letter or digit');
  const model = given(o.model) ? pattern(o.model, MODEL_ID, '--model', 'a model id') : null;
  const provider = given(o.provider) ? pattern(o.provider, PROVIDER_RE, '--provider', 'a provider id') : null;
  const effort = given(o.effort) ? pattern(o.effort, EFFORT_RE, '--effort', 'an effort level') : null;
  if (model === null && (provider !== null || effort !== null)) throw new StartUsageError('--provider and --effort need --model');
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
  const blocks = harnessBlocks(reg, descriptors, view);
  const worker = blocks.find((b: any) => b.harness === harness)?.worker ?? null;
  const channel = worker ? compileChannel(worker) : null;
  const promptVia = channel === null && worker?.mainSession?.promptVia === 'argv' ? 'argv' : 'stdin';
  const prepared = preparePrompt(o.readStdin(), { entry, promptVia });
  if (!prepared.ok) return refusal(prepared.code, `the prompt is refused: ${prepared.code}`);
  if (channel !== null) {
    // R-4 on the person's text, then the supervisor's own framing of what is sent (caps, prefix, record size).
    const framed = commandRefusal(channel, prepared.text) ? { ok: false, code: 'command-not-allowed' } : frameMessage(channel, 'first', { text: prepared.sent, id: idOf(1) });
    if (!framed.ok) {
      return refusal(framed.code, framed.code === 'command-not-allowed'
        ? `${harness} reads a message starting with '${channel.commandPrefix}' as its own command; DoFlow does not send one`
        : `the prompt is refused: ${framed.code}`);
    }
  }

  // Step 6: the harness is startable here and now.
  const catalogue = readCatalogue(root, { env });
  const facts = harnessFacts({ harness, worker, reg, view, env, cwd, root, nowMs, platform });
  if (!facts.startable) return refusal('harness-not-startable', facts.words, { harness, reason: facts.reason });

  // Step 7: the model, provider and effort are one triple the options offer, and not a refused one.
  const offered = modelsFor({ harness, worker, bindings: readBindings({ env, projectRoot: root }), catalogue });
  const choice = offered.find((m: any) => m.model === model && m.provider === provider && m.effort === effort) ?? null;
  if (!choice || choice.refused) {
    const what = [model, provider === null ? null : `provider ${provider}`, effort === null ? null : `effort ${effort}`].filter((part) => part !== null).join(', ');
    return refusal('model-not-offered', `${harness} is not offered '${what}' here${choice ? ` (${choice.refused})` : ''}`, { harness, models: offered });
  }

  // Step 8: no dispatch of this project is running.
  const dispatch = dispatchRunning(root, platform);
  if (dispatch) {
    const words = dispatch.slug === null
      ? `the project's dispatch records cannot be read (${dispatch.detail ?? 'unknown error'}), so a running dispatch cannot be ruled out; start again when they can be read`
      : `a dispatch is running in ${dispatch.slug}; start again when it ends`;
    return refusal('dispatch-running', words, dispatch);
  }

  // Step 9: the record, inserted under the store lock with the limits.
  const runId = newRunId();
  const key = runKeyFor(env, cwd);
  const record = {
    runId, kind: KIND, task: KIND, token: 1, request: requestId, childOf: null,
    harness, phase: 'starting', createdAt: clock().toISOString(), timeoutSeconds: TIMEOUT_SECONDS, cliVersion: facts.version,
    caller: { lineageKind: key.identity.lineageKind, runKey: key.runKey },
    startedBy, project: { projectKey, worktreeKey }, execWorktree: checkout.path, entry,
    binding: { model, provider, effort, flag: model === null ? null : 'supported', source: choice.source },
    prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: prepared.sha256, bytes: prepared.bytes },
    ...mainLaunchRecord(worker, prepared.sent, model === null ? null : { model, provider, effort }, channel !== null),
    // The detached supervisor launches from the record alone: the binary the version read found (an absolute
    // path, as `run` records), the recipe and the model part.
    // The provider and effort entries ride along only when the choice uses them: the supervisor composes the model part from the record.
    descriptor: {
      cli: { binary: facts.found.path }, mainSession: worker.mainSession, ...mapPart(worker), model: worker.model ?? null, ...signsPart(worker),
      // 170 IC-002: the channel the supervisor launches through, and for a session without one its reason.
      ...(worker.controlChannel ? { controlChannel: worker.controlChannel } : {}),
      ...(provider === null ? {} : { provider: worker.provider }), ...(effort === null ? {} : { effort: worker.effort }),
    },
  };
  // Liveness is read outside the lock (`ps` is a process); a run inserted after this reading is counted open and live.
  const named = namingScan(platform);
  const states = new Map((Object.values(readRuns(file)) as any[]).filter(isOpenShape).map((run) => [run.runId, liveness(run, platform, nowMs(), named)]));
  const away = elsewhere(resolved.others, platform, nowMs(), named);
  const startedAt = nowMs();
  const inserted = insertRun(file, record, fs, {
    refuse: (store: any) => {
      const open = (Object.values(store.runs) as any[]).filter((run) => isOpenShape(run) && states.get(run.runId) !== 'dead');
      const here = open.filter((run) => run.project?.worktreeKey === worktreeKey);
      const busy = here.find((run) => states.get(run.runId) !== 'unknown');
      if (busy) return { code: 'checkout-busy', current: { runId: busy.runId } };
      if (here.length > 0) return { code: 'checkout-busy-unknown', current: { runId: here[0].runId } };
      const mine = open.filter((run) => run.startedBy === startedBy).length + (away.byActor.get(startedBy) ?? 0);
      if (mine >= LIMITS.perActor) return { code: 'actor-limit', current: { open: mine, max: LIMITS.perActor } };
      const all = open.length + away.total;
      if (all >= LIMITS.machine) return { code: 'machine-limit', current: { open: all, max: LIMITS.machine } };
      // R-5: the actor's starts in the last hour, here under the lock and in the other projects' stores.
      const starts = [...(startsByActor(store.runs, startedAt).get(startedBy) ?? []), ...(away.startedByActor.get(startedBy) ?? [])].sort((a, b) => a - b);
      if (starts.length >= LIMITS.perActorPerHour) {
        const retryAfterSeconds = Math.max(1, Math.ceil((starts[starts.length - LIMITS.perActorPerHour] + HOUR_MS - startedAt) / 1000));
        return { code: 'start-rate-limited', current: { started: starts.length, max: LIMITS.perActorPerHour, retryAfterSeconds } };
      }
      return null;
    },
  });
  if (!inserted.applied) {
    if (inserted.reason === 'run-exists') {
      const existing = readRuns(file)[inserted.runId];
      return { ok: true, replayed: true, run: replyRun(existing, root, projectKey) };
    }
    const words = inserted.reason === 'checkout-busy-unknown' ? unknownWords(inserted.current.runId) : LIMIT_WORDS[inserted.reason] ?? inserted.reason;
    return refusal(inserted.reason, words, inserted.current);
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

/** 165 review A-1: the words of `checkout-busy-unknown`, with the cancel that clears it. */
const unknownWords = (runId: string) => `a started session in this checkout (${runId}) may still be running and its processes cannot be checked; `
  + `if it has ended, clear it with: doflow worker --action cancel --slug ${STARTED_SLUG} --worker-run ${runId} --operator --via console --reason ended`;

const LIMIT_WORDS: Record<string, string> = Object.freeze({
  'checkout-busy': 'a started session is already open in this checkout',
  'actor-limit': `this actor already has ${LIMITS.perActor} started sessions open`,
  'machine-limit': `${LIMITS.machine} started sessions are already open on this machine`,
  'start-rate-limited': `this actor has started ${LIMITS.perActorPerHour} sessions in the last hour; start again later`,
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
  const { env, cwd, root, reg, descriptors, view, platform, clock, projects } = o;
  const nowMs = () => clock().getTime();
  const projectKey = pattern(o.projectKey, KEY16, '--project-key', '16 lowercase hex characters');
  const resolved = resolveProject({ cwd, env, projectKey, projects });
  if (resolved.refused) return resolved.refused;

  const named = namingScan(platform);
  const open = openRuns(readRuns(storeFileFor(root, STARTED_SLUG)), platform, nowMs(), named).map((entry) => entry.run);
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
  const store = readLoginStore(env);
  const bindings = readBindings({ env, projectRoot: root });
  const harnesses = harnessBlocks(reg, descriptors, view).map(({ harness, worker }: any) => {
    const { found, ...facts } = harnessFacts({ harness, worker, reg, view, env, cwd, root, nowMs, platform, store });
    return { ...facts, models: modelsFor({ harness, worker, bindings, catalogue }) };
  });
  const dispatch = dispatchRunning(root, platform);
  return {
    project: { projectKey, label: resolved.project.label, root: null },
    checkouts,
    harnesses,
    limits: LIMITS,
    open: { machine: open.length + elsewhere(resolved.others, platform, nowMs(), named).total },
    dispatch: dispatch ? { running: true, slug: dispatch.slug, ...(dispatch.slug === null ? { reason: dispatch.reason } : {}) } : { running: false },
    promptMax: PROMPT_MAX,
    entries: ENTRIES,
    entryLine: ENTRY_LINE,
  };
}

module.exports = { startSession, startOptions, liveness, namingScan, STARTED_SLUG, KIND, LIMITS, START_FLAGS, StartUsageError };
