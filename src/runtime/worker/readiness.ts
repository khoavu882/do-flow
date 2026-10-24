'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Worker readiness (feature 081 B.1 and B.2): discover (IC-004), probe facts and the probe
 * record (IC-005), model-backed checks (IC-006), freshness (IC-007), the identity-forwarding
 * observation (IC-023), and the needs vocabulary, eligibility, describe and select (IC-008,
 * IC-009, IC-010). DEC-002, DEC-003, DEC-004, DEC-006, DEC-009, DEC-018, DEC-019, DEC-020,
 * DEC-031, DEC-044. Describe and select write nothing.
 *
 * Nothing here reads a credential: login is learned from a probe's exit status only, probe stdout
 * is read up to 64 KiB and never stored, and the only paths read under the home directory are the
 * unit binding `stateDir()/sessions/<unit>/bound` and `sessions.log` (IC-030).
 *
 * Harness descriptors come from the registry's `worker` blocks, or from `descriptors`
 * (`{ <harnessId>: <worker block> }`) passed in process by tests (DEC-036). When `descriptors` is
 * given it is the whole set: only the harnesses it names are discovered, in registry order, so a
 * test never looks up a real harness binary that shares the node directory (NFR-002).
 *
 * The probe record is written through `updateTaskState`, which stamps the store's own `version`;
 * the IC-005 record, whose `version` is the harness's version banner, is therefore kept under
 * `record` in the file: `{ harness, record: { harness, at, binaryPath, version, descriptorDigest,
 * facts, modelChecks } }`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { workerCatalogue } = require('./catalogue.ts');
const { workerGate } = require('./active.ts');
const { knownWorkerIds } = require('../../registry/worker-ids.ts');
const { runProbe, PROBE_TIMEOUT_MS } = require('../health.ts');
const { updateTaskState, readTaskState } = require('../task-state.ts');
const { stateDir } = require('../context/identity.ts');
const { configHome } = require('../config-home.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { spawnBounded } = require('./process-tree.ts');
const { parserFor, PARSERS } = require('./parsers.ts');
const { enforcementFor, UnknownEnforcementTarget } = require('../../lifecycle/coverage.ts');

/** A recorded fact is effective for 24 hours against a matching discover (DEC-019). */
const PROBE_MAX_AGE_MS = 86400000;
/** Probe stdout is read up to this many bytes and never stored. */
const PROBE_STDOUT_MAX = 65536;
const VERSION_MAX = 80;
/** IC-023: how much of `sessions.log` is read for a START line. */
const SESSIONS_LOG_LINES = 500;
const FACTS = Object.freeze(['installed', 'runnable', 'hooksLoaded', 'identityForwarded', 'guidanceLoaded', 'login', 'quota', 'model']);

/** A failure that is the caller's, not a refusal: exit 2 `usage`. */
class ReadinessError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReadinessError';
    this.code = code;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const clock = (now: any) => (typeof now === 'function' ? now : () => (typeof now === 'number' ? now : Date.now()));
const fact = (state: string, reason: string | null, at: string, basis = 'free') => ({ state, reason, at, basis });
const supported = (entry: any) => entry?.status === 'supported';

const { descriptorDigest } = require('./catalogue.ts');

/** `[{ harness, worker }]` in registry order: the registry's blocks, or exactly the injected ones. */
function workerDescriptors({ descriptors, registry }: any = {}): { harness: string; worker: any }[] {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  const ids: string[] = knownWorkerIds({ registry: reg }).ids;
  if (!descriptors) return workerCatalogue({ registry: reg }).map((entry: any) => ({ harness: entry.id, worker: entry.worker }));
  const unknown = Object.keys(descriptors).filter((id) => !ids.includes(id));
  if (unknown.length) throw new ReadinessError('usage', `descriptors name unregistered harness(es): ${unknown.join(', ')}; registered: ${ids.join(', ')}`);
  return ids.filter((id) => Object.hasOwn(descriptors, id)).map((id) => ({ harness: id, worker: descriptors[id] }));
}

/** The first executable `binary` on `env.PATH`, or null. Starts no process. */
function findOnPath(binary: string, env: any, platform = process.platform): string | null {
  const dirs = String(env?.PATH ?? '').split(path.delimiter).filter(Boolean);
  const suffixes = platform === 'win32'
    ? ['', ...String(env?.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, binary + suffix);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The first output line, control characters removed, trimmed, cut to 80 characters. */
function versionLine(output: any): string | null {
  const first = [...String(output ?? '').split('\n')[0]]
    .filter((character) => {
      const point = character.codePointAt(0) as number;
      return point >= 0x20 && point !== 0x7f;
    })
    .join('')
    .trim();
  return first ? first.slice(0, VERSION_MAX) : null;
}

/** IC-004 for one harness. */
function discoverOne({ harness, worker }: any, { env, cwd, now, platform }: any) {
  const cli = worker?.cli;
  if (!supported(cli)) {
    return { harness, binary: null, present: false, path: null, version: null, reason: 'cli-unknown', at: iso(now()) };
  }
  const found = findOnPath(cli.binary, env, platform);
  if (!found) return { harness, binary: cli.binary, present: false, path: null, version: null, reason: 'not-on-path', at: iso(now()) };
  const execFileImpl = (bin: string, args: string[], options: any) => execFileSync(bin, args, { ...options, env, cwd });
  const result = runProbe([found, ...cli.versionArgv], { execFileImpl, timeoutMs: PROBE_TIMEOUT_MS });
  const reason = result.ok ? null : (result.timedOut ? 'timeout' : 'version-failed');
  return { harness, binary: cli.binary, present: true, path: found, version: result.ok ? versionLine(result.output) : null, reason, at: iso(now()) };
}

/**
 * IC-004: looks every harness's binary up on `env.PATH` and runs its `versionArgv`. Writes nothing.
 * @returns {{ disposition: 'discovered', at: string, harnesses: Object[] }}
 */
function discover({ descriptors, registry, env = process.env, cwd = process.cwd(), now = Date.now, platform = process.platform }: any = {}) {
  const tick = clock(now);
  const at = iso(tick());
  const harnesses = workerDescriptors({ descriptors, registry }).map((entry) => discoverOne(entry, { env, cwd, now: tick, platform }));
  return { disposition: 'discovered', at, harnesses };
}

/** A fresh forwarding-probe identity (IC-023). */
function newProbeIdentity() {
  return { run: `probe${crypto.randomBytes(4).toString('hex')}`, lineage: `p${crypto.randomBytes(4).toString('hex')}` };
}

/** The caller's environment with IC-023's probe identity set over it. */
function probeEnv(env: any, identity: any, root: string) {
  return {
    ...env,
    DOFLOW_RUN_ID: identity.run,
    DOFLOW_LINEAGE_ID: identity.lineage,
    DOFLOW_ATTEMPT: '1',
    DOFLOW_SESSION_ROLE: 'worker',
    DOFLOW_WORKTREE: root,
  };
}

/** True when `S/sessions/<unit>/bound` is a regular, non-empty file. Never follows a link. */
function bindingObserved(env: any, unit: string): boolean {
  const root = stateDir(env);
  if (root === null) return false;
  try {
    const stat = fs.lstatSync(path.join(root, 'sessions', unit, 'bound'));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/** True when the last 500 lines of `sessions.log` hold a START line at or after `startedAtMs`,
 * truncated to the second, for `cwd`. */
function sessionStartLogged(env: any, cwd: string, startedAtMs: number): boolean {
  const { dir } = configHome(env ?? {});
  if (dir === null) return false;
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'sessions.log'), 'utf8');
  } catch {
    return false;
  }
  const since = Math.floor(startedAtMs / 1000) * 1000;
  for (const line of text.split('\n').filter(Boolean).slice(-SESSIONS_LOG_LINES)) {
    const match = /^(\S+) START (\S+) (.+)$/.exec(line);
    if (!match) continue;
    const ts = Date.parse(match[1]);
    if (Number.isFinite(ts) && ts >= since && samePath(match[3], cwd)) return true;
  }
  return false;
}

/**
 * IC-023: `hooksLoaded` and `identityForwarded` after a forwarding probe for `identity` ended.
 * `attempt` names the unit's last part: 1 for a probe, the claim token for a run's `launchObserved`.
 */
function observeForwarding({ env, identity, attempt = 1, cwd, startedAtMs, timedOut = false, at, basis = 'free' }: any) {
  if (timedOut) return { hooksLoaded: fact('unknown', 'timeout', at, basis), identityForwarded: fact('unknown', 'timeout', at, basis) };
  if (bindingObserved(env, `L.${identity.run}.${identity.lineage}.${attempt}`)) {
    return { hooksLoaded: fact('yes', 'unit-binding-observed', at, basis), identityForwarded: fact('yes', 'unit-binding-observed', at, basis) };
  }
  if (sessionStartLogged(env, cwd, startedAtMs)) {
    return { hooksLoaded: fact('yes', 'session-start-logged', at, basis), identityForwarded: fact('no', 'no-unit-binding', at, basis) };
  }
  return { hooksLoaded: fact('no', 'no-session-start-observed', at, basis), identityForwarded: fact('unknown', 'hooks-not-loaded', at, basis) };
}

/** A bounded probe run: the spawn result plus its start and end times. */
async function runBounded(binary: string, argv: string[], { env, cwd, timeoutMs, now }: any) {
  const startedAtMs = now();
  const result = await spawnBounded({ binary, argv, cwd, env, timeoutMs, maxStdout: PROBE_STDOUT_MAX });
  return { result, startedAtMs, at: iso(now()) };
}

/** `yes` on exit 0, `no` on another exit code, `unknown` for a timeout, a signal or a spawn error. */
function exitFact(result: any, at: string, basis = 'free') {
  if (result.status === 'timeout') return fact('unknown', 'timeout', at, basis);
  if (result.status === 'error') return fact('unknown', `spawn-failed ${result.error}`, at, basis);
  if (result.code === 0) return fact('yes', 'exit 0', at, basis);
  if (Number.isInteger(result.code)) return fact('no', `exit ${result.code}`, at, basis);
  return fact('unknown', `signal ${result.signal}`, at, basis);
}

/** The guidance rule: exit 0 with the marker in stdout is `yes`, exit 0 without it `no`. */
function guidanceFact(result: any, marker: string | undefined, at: string, basis = 'free') {
  const exit = exitFact(result, at, basis);
  if (exit.state !== 'yes') return exit.state === 'no' ? fact('unknown', exit.reason, at, basis) : exit;
  if (!marker) return fact('unknown', 'no-marker-declared', at, basis);
  return String(result.stdout).includes(marker) ? fact('yes', 'marker-found', at, basis) : fact('no', 'marker-absent', at, basis);
}

function installedFact(found: any) {
  if (found.reason === null) return fact('yes', 'version-answered', found.at);
  if (found.reason === 'not-on-path' || found.reason === 'version-failed') return fact('no', found.reason, found.at);
  return fact('unknown', found.reason, found.at);
}

/** IC-005: the eight free facts for one harness. */
async function freeFacts(worker: any, found: any, { env, root, now, probeIdentity }: any) {
  const facts: any = { installed: installedFact(found) };
  const bounded = (argv: string[], childEnv = env) => runBounded(found.path, argv, { env: childEnv, cwd: root, timeoutMs: PROBE_TIMEOUT_MS, now });
  const gate = (entry: any) => {
    if (!supported(entry)) return fact('unknown', 'no-free-probe-declared', iso(now()));
    if (!found.present) return fact('unknown', 'not-installed', iso(now()));
    return null;
  };

  facts.runnable = gate(worker.runnableProbe);
  if (!facts.runnable) {
    const { result, at } = await bounded(worker.runnableProbe.argv);
    facts.runnable = exitFact(result, at);
  }

  const hooksGate = gate(worker.hooksProbe);
  if (hooksGate) {
    facts.hooksLoaded = hooksGate;
    facts.identityForwarded = { ...hooksGate };
  } else {
    const identity = probeIdentity();
    const { result, startedAtMs, at } = await bounded(worker.hooksProbe.argv, probeEnv(env, identity, root));
    Object.assign(facts, observeForwarding({ env, identity, cwd: root, startedAtMs, timedOut: result.status === 'timeout', at }));
  }

  facts.guidanceLoaded = gate(worker.guidanceProbe);
  if (!facts.guidanceLoaded) {
    const { result, at } = await bounded(worker.guidanceProbe.argv);
    facts.guidanceLoaded = guidanceFact(result, worker.guidanceProbe.marker, at);
  }

  facts.login = gate(worker.loginProbe);
  if (!facts.login) {
    const { result, at } = await bounded(worker.loginProbe.argv);
    facts.login = exitFact(result, at);
  }

  const at = iso(now());
  facts.quota = fact('unknown', 'no-free-probe', at);
  facts.model = fact('unknown', 'no-free-probe', at);
  return facts;
}

/** IC-006: runs one declared model check and returns the facts it establishes and its usage. */
async function runModelCheck(worker: any, found: any, check: any, budgetTokens: number, { env, root, now, probeIdentity }: any) {
  const identity = probeIdentity();
  const { result, startedAtMs, at } = await runBounded(found.path, check.argv, {
    env: probeEnv(env, identity, root), cwd: root, timeoutMs: check.timeoutSeconds * 1000, now,
  });
  const basis = 'model-backed';
  const facts: any = {};
  const establishes = new Set(check.establishes);
  if (establishes.has('hooksLoaded') || establishes.has('identityForwarded')) {
    const observed: any = observeForwarding({ env, identity, cwd: root, startedAtMs, timedOut: result.status === 'timeout', at, basis });
    for (const key of ['hooksLoaded', 'identityForwarded']) if (establishes.has(key)) facts[key] = observed[key];
  }
  if (establishes.has('guidanceLoaded')) {
    facts.guidanceLoaded = guidanceFact(result, supported(worker.guidanceProbe) ? worker.guidanceProbe.marker : undefined, at, basis);
  }
  if (establishes.has('login')) facts.login = exitFact(result, at, basis);

  let measured: number | null = null;
  if (supported(worker.structuredOutput)) {
    const parser = parserFor(worker.structuredOutput.parser).create();
    for (const line of String(result.stdout).split('\n')) if (line) parser.line(line);
    measured = parser.end().usage?.tokens ?? null;
  }
  const tokens = measured ?? check.estimateTokens;
  const usage = { tokens, basis: measured === null ? 'estimated' : 'measured', budget: budgetTokens };
  return { facts, summary: { at, usage, overBudget: tokens > budgetTokens } };
}

function probeFile(root: string, harness: string): string {
  return path.join(root, '.doflow', 'state', 'worker-probes', `${harness}.json`);
}

/** The IC-005 record for `harness` under `root`, or null when it was never probed. */
function readProbeRecord(root: string, harness: string): any {
  const data = readTaskState(fs, probeFile(root, harness));
  return data && data.record && typeof data.record === 'object' ? data.record : null;
}

const sameBinding = (a: any, b: any) => Boolean(a) && Boolean(b)
  && a.binaryPath === b.binaryPath && a.version === b.version && a.descriptorDigest === b.descriptorDigest;

/** Fresh when `at` is at most 24 hours old and not in the future: a skewed clock never extends it. */
const freshAt = (at: any, nowMs: number) => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && nowMs - ms >= 0 && nowMs - ms <= PROBE_MAX_AGE_MS;
};

/**
 * The record to write over `prior`: a free `unknown` keeps a fresh model-backed `yes` or `no`
 * recorded for the same binary path, version and digest (IC-005). Pure: runs inside the lock.
 */
function mergeRecord(prior: any, next: any, nowMs: number) {
  const same = sameBinding(prior, next);
  const facts = { ...next.facts };
  if (same) {
    for (const name of FACTS) {
      const old = prior.facts?.[name];
      const fresh = facts[name];
      if (fresh?.basis === 'free' && fresh.state === 'unknown'
        && old?.basis === 'model-backed' && (old.state === 'yes' || old.state === 'no') && freshAt(old.at, nowMs)) {
        facts[name] = old;
      }
    }
  }
  return { ...next, facts, modelChecks: { ...(same ? prior.modelChecks : {}), ...next.modelChecks } };
}

function writeRecord(root: string, record: any, nowMs: number) {
  let written: any = null;
  updateTaskState({
    fsImpl: fs,
    file: probeFile(root, record.harness),
    build: (disk: any) => {
      written = mergeRecord(disk?.record ?? null, record, nowMs);
      return { harness: record.harness, record: written };
    },
  });
  return written;
}

/**
 * IC-007: the effective facts of `record` against `current`, a discover entry carrying
 * `descriptorDigest`. A fact older than 24 hours, or a record whose binary path, version or digest
 * differs, reads `unknown`, `probe-stale`; a harness with no record reads `not-probed`.
 */
function effectiveFacts(record: any, current: any, now: any = Date.now) {
  const nowMs = clock(now)();
  const out: any = {};
  if (!record) {
    for (const name of FACTS) out[name] = { state: 'unknown', reason: 'not-probed', at: null };
    return out;
  }
  const matches = Boolean(current) && record.binaryPath === current.path && record.version === current.version
    && record.descriptorDigest === current.descriptorDigest;
  for (const name of FACTS) {
    const recorded = record.facts?.[name];
    if (!recorded) out[name] = { state: 'unknown', reason: 'not-probed', at: null };
    else if (!matches || !freshAt(recorded.at, nowMs)) out[name] = { state: 'unknown', reason: 'probe-stale', at: recorded.at };
    else out[name] = recorded;
  }
  return out;
}

/** IC-006's usage checks, before any process starts. Returns a refusal or null. */
function checkModelRequest(entries: any[], harness: any, modelCheck: any, budgetTokens: any) {
  if (modelCheck === undefined || modelCheck === null) return null;
  if (!harness) throw new ReadinessError('usage', '--model-check needs --harness: a model check belongs to one harness');
  const worker = entries[0].worker;
  const declared = (worker.modelChecks || []).map((check: any) => check.id);
  const check = (worker.modelChecks || []).find((item: any) => item.id === modelCheck);
  if (!check) throw new ReadinessError('usage', `harness '${harness}' declares no model check '${modelCheck}'; declared: ${declared.length ? declared.join(', ') : '(none)'}`);
  if (budgetTokens === undefined || budgetTokens === null) {
    return { disposition: 'refused', reason: 'budget-required', harness, modelCheck, estimateTokens: check.estimateTokens };
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new ReadinessError('usage', `--budget-tokens '${budgetTokens}' is not a positive integer`);
  if (check.estimateTokens > budgetTokens) {
    return { disposition: 'refused', reason: 'budget-insufficient', harness, modelCheck, estimateTokens: check.estimateTokens, budgetTokens };
  }
  return null;
}

/**
 * IC-005 and IC-006: discover, then per harness the free probes, at most one model check after
 * them, and the probe record. Harnesses are probed one after another, so one harness's START line
 * in `sessions.log` is never read as another's.
 * @returns {Promise<{ disposition: 'probed', harnesses: Object[] } | { disposition: 'refused', reason: string }>}
 */
async function probe({
  descriptors, registry, coverage, harness, needs, modelCheck, budgetTokens,
  env = process.env, cwd = process.cwd(), root = cwd, now = Date.now, platform = process.platform,
  probeIdentity = newProbeIdentity,
}: any = {}) {
  const tick = clock(now);
  const all = workerDescriptors({ descriptors, registry });
  const entries = harness ? all.filter((entry) => entry.harness === harness) : all;
  if (harness && entries.length === 0) {
    throw new ReadinessError('usage', `unknown harness '${harness}'; known: ${all.map((entry) => entry.harness).join(', ')}`);
  }
  const cov = coverage === undefined ? registry?.coverage : coverage;
  const valid = validateNeeds(needs, cov);
  const refusal = checkModelRequest(entries, harness, modelCheck, budgetTokens);
  if (refusal) return refusal;

  // `root` is the lifecycle project root (IC-005): probe processes run there and the record lives
  // there; discover resolves PATH from the caller's `cwd`, as describe, select and run do.
  const results: any[] = [];
  for (const entry of entries) {
    const found = discoverOne(entry, { env, cwd, now: tick, platform });
    const facts = await freeFacts(entry.worker, found, { env, root, now: tick, probeIdentity });
    const modelChecks: any = {};
    let ran: any;
    if (modelCheck !== undefined && modelCheck !== null) {
      const check = entry.worker.modelChecks.find((item: any) => item.id === modelCheck);
      if (found.present) {
        const outcome = await runModelCheck(entry.worker, found, check, budgetTokens, { env, root, now: tick, probeIdentity });
        Object.assign(facts, outcome.facts);
        modelChecks[modelCheck] = outcome.summary;
        ran = { id: modelCheck, ran: true, ...outcome.summary };
      } else {
        ran = { id: modelCheck, ran: false, reason: 'not-installed' };
      }
    }
    const atMs = tick();
    const record = writeRecord(root, {
      harness: entry.harness,
      at: iso(atMs),
      binaryPath: found.path,
      version: found.version,
      descriptorDigest: descriptorDigest(entry.worker),
      facts,
      modelChecks,
    }, atMs);
    // FR-003: task-eligible, IC-008 over the effective facts of the record just written; never stored.
    const effective = effectiveFacts(record, { path: found.path, version: found.version, descriptorDigest: record.descriptorDigest }, atMs);
    const taskEligible = eligibility(requirementsFor(entry, effective, valid, cov));
    results.push({ harness: entry.harness, facts: record.facts, taskEligible, recordedAt: record.at, ...(ran ? { modelCheck: ran } : {}) });
  }
  return { disposition: 'probed', harnesses: results };
}

/** IC-008: requirements every task carries, in report order. */
const BASELINE = Object.freeze(['installed', 'runnable', 'one-shot', 'structured-output', 'read-only', 'spawn-denial']);
/** IC-013 (DEC-020): the baseline of an edit task, `read-only` replaced by `isolated-edit`. */
const EDIT_BASELINE = Object.freeze(['installed', 'runnable', 'one-shot', 'structured-output', 'isolated-edit', 'spawn-denial']);
/** IC-008: requirements a task adds with `--need`, besides `blocking-hook:<policy>`. */
const NEED_IDS = Object.freeze(['hooks-loaded', 'identity-forwarding', 'guidance-loaded', 'login']);
const BLOCKING_HOOK = 'blocking-hook:';
/** IC-001's capability keys, in declaration order (IC-009 `declared`). */
const CAPABILITIES = Object.freeze([
  'cli', 'oneShot', 'structuredOutput', 'readOnly', 'spawnDenial', 'runnableProbe', 'hooksProbe', 'guidanceProbe', 'loginProbe',
  'persistentSession', 'resume', 'steering',
]);
const FACT_REQUIREMENTS: Record<string, string> = Object.freeze({
  installed: 'installed', runnable: 'runnable', 'hooks-loaded': 'hooksLoaded',
  'identity-forwarding': 'identityForwarded', 'guidance-loaded': 'guidanceLoaded', login: 'login',
});
const CAPABILITY_REQUIREMENTS: Record<string, string> = Object.freeze({
  'one-shot': 'oneShot', 'structured-output': 'structuredOutput', 'read-only': 'readOnly', 'spawn-denial': 'spawnDenial',
  'isolated-edit': 'isolatedEdit',
});
const FACT_RESULT: Record<string, string> = Object.freeze({ yes: 'met', no: 'failed', unknown: 'unknown' });

/**
 * DEC-044: the `blocking-hook` policies, built from the coverage rows because coverage's
 * `POLICY_ORDER` is not exported and `src/lifecycle/coverage.ts` does not change (IC-032).
 */
function policyVocabulary(coverage: any): Set<string> {
  const policies = new Set<string>((coverage?.rows || []).map((row: any) => row.policy));
  policies.delete('*');
  return policies;
}

/** The need ids as given, deduplicated; an unknown id or policy is a `usage` error listing the valid ones. */
function validateNeeds(needs: any, coverage: any): string[] {
  const list = needs === undefined || needs === null ? [] : (Array.isArray(needs) ? needs : [needs]);
  const policies = policyVocabulary(coverage);
  for (const need of list) {
    if (typeof need === 'string' && need.startsWith(BLOCKING_HOOK)) {
      const policy = need.slice(BLOCKING_HOOK.length);
      if (!policies.has(policy)) {
        throw new ReadinessError('usage', `unknown policy '${policy}' in --need '${need}'; valid policies: ${[...policies].join(', ') || '(none)'}`);
      }
    } else if (!NEED_IDS.includes(need)) {
      throw new ReadinessError('usage', `unknown need '${need}'; valid needs: ${[...NEED_IDS, `${BLOCKING_HOOK}<policy>`].join(', ')}; policies: ${[...policies].join(', ') || '(none)'}`);
    }
  }
  return [...new Set<string>(list)];
}

function factRequirement(requirement: string, value: any) {
  const state = value?.state ?? 'unknown';
  return { requirement, result: FACT_RESULT[state] ?? 'unknown', reason: value?.reason ?? 'not-probed', at: value?.at ?? null };
}

function capabilityRequirement(requirement: string, entry: any) {
  if (!entry || typeof entry !== 'object') return { requirement, result: 'unknown', reason: 'not-declared' };
  if (entry.status === 'supported') {
    if (requirement === 'structured-output' && !Object.hasOwn(PARSERS, entry.parser)) {
      return { requirement, result: 'failed', reason: `parser-unknown ${entry.parser}` };
    }
    return { requirement, result: 'met', reason: 'supported' };
  }
  if (entry.status === 'unsupported') return { requirement, result: 'failed', reason: entry.reason || 'unsupported' };
  return { requirement, result: 'unknown', reason: entry.reason || 'unknown' };
}

/**
 * `blocking-hook:<policy>`: a known profile, an enforced coverage answer and loaded hooks. An
 * `UnknownEnforcementTarget` is a `failed` requirement carrying its `code`, never raised (DEC-044).
 */
function blockingHookRequirement(requirement: string, harness: string, worker: any, facts: any, coverage: any) {
  if (worker?.profile === null || worker?.profile === undefined) return { requirement, result: 'failed', reason: 'profile-unknown' };
  let answer: any;
  try {
    answer = enforcementFor(coverage, { harness, policy: requirement.slice(BLOCKING_HOOK.length), profile: worker.profile });
  } catch (error: any) {
    if (error instanceof UnknownEnforcementTarget) return { requirement, result: 'failed', reason: error.code };
    throw error;
  }
  if (!answer.enforced) return { requirement, result: 'failed', reason: answer.reason };
  const hooks = factRequirement(requirement, facts?.hooksLoaded);
  if (hooks.result !== 'met') return { ...hooks, reason: `hooksLoaded ${hooks.reason}` };
  return { requirement, result: 'met', reason: answer.reason, at: hooks.at };
}

/**
 * IC-008: the baseline and `needs` evaluated for one harness to `met`, `failed` or `unknown`, each
 * with a reason; fact-backed requirements also carry the fact's `at`. `descriptor` is a
 * `workerDescriptors` entry `{ harness, worker }`; `facts` are IC-007 effective facts. With `edit`
 * the baseline is `EDIT_BASELINE` (IC-013), without it `BASELINE`.
 */
function requirementsFor(descriptor: any, facts: any, needs: any, coverage: any, edit = false) {
  const { harness, worker } = descriptor;
  return [...(edit ? EDIT_BASELINE : BASELINE), ...validateNeeds(needs, coverage)].map((requirement) => {
    if (Object.hasOwn(FACT_REQUIREMENTS, requirement)) return factRequirement(requirement, facts?.[FACT_REQUIREMENTS[requirement]]);
    if (Object.hasOwn(CAPABILITY_REQUIREMENTS, requirement)) return capabilityRequirement(requirement, worker?.[CAPABILITY_REQUIREMENTS[requirement]]);
    return blockingHookRequirement(requirement, harness, worker, facts, coverage);
  });
}

/** Eligible when every applicable requirement is `met` (DEC-009, DEC-020); the others are gaps. */
function eligibility(requirements: any[]) {
  const gaps = requirements.filter((item) => item.result !== 'met').map(({ requirement, result, reason }) => ({ requirement, result, reason }));
  return { eligible: gaps.length === 0, gaps };
}

/** Registry, coverage and descriptors for one call; IC-009 filters only when active is supplied. */
function readinessContext({ descriptors, registry, coverage, active }: any) {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  const all = workerDescriptors({ descriptors, registry: reg });
  const entries = active ? all.filter((entry) => workerGate(active, entry.harness) === null) : all;
  return { entries, known: all.map((entry) => entry.harness), coverage: coverage === undefined ? reg.coverage : coverage };
}

/** Discover, then the IC-007 effective facts and IC-008 evaluation of one harness. Writes nothing. */
function evaluateHarness(entry: any, needs: string[], coverage: any, { env, cwd, root, now, platform, edit }: any) {
  const found = discoverOne(entry, { env, cwd, now, platform });
  const record = readProbeRecord(root, entry.harness);
  const facts = effectiveFacts(record, { ...found, descriptorDigest: descriptorDigest(entry.worker) }, now);
  const requirements = requirementsFor(entry, facts, needs, coverage, edit === true);
  return { harness: entry.harness, facts, recordedAt: record?.at ?? null, requirements, ...eligibility(requirements) };
}

/**
 * IC-009: what one harness declares, its effective probe facts with a `stale` flag, and IC-008's
 * requirements for the baseline and `needs`. Read-only.
 */
function describe({
  descriptors, registry, coverage, harness, needs, edit = false,
  env = process.env, cwd = process.cwd(), root = cwd, now = Date.now, platform = process.platform,
}: any = {}) {
  const context = readinessContext({ descriptors, registry, coverage });
  const entry = context.entries.find((item) => item.harness === harness);
  if (!entry) throw new ReadinessError('usage', `unknown harness '${harness}'; known: ${context.entries.map((item) => item.harness).join(', ')}`);
  const valid = validateNeeds(needs, context.coverage);
  const evaluated = evaluateHarness(entry, valid, context.coverage, { env, cwd, root, now: clock(now), platform, edit });
  const declared: any = { profile: entry.worker?.profile ?? null, modelChecks: (entry.worker?.modelChecks || []).map((check: any) => check.id) };
  for (const key of CAPABILITIES) {
    const value = entry.worker?.[key];
    declared[key] = value
      ? { status: value.status, verifiedOn: value.verifiedOn, ...(value.reason ? { reason: value.reason } : {}) }
      : { status: 'unknown', verifiedOn: null, reason: 'not-declared' };
  }
  const probeFacts: any = {};
  for (const name of FACTS) probeFacts[name] = { ...evaluated.facts[name], stale: evaluated.facts[name].reason === 'probe-stale' };
  return { disposition: 'described', harness, declared, probe: probeFacts, requirements: evaluated.requirements, eligible: evaluated.eligible };
}

/**
 * IC-010: the first eligible harness in registry order, or `none-eligible` with each gap and the
 * fallback modes. Claims nothing and writes nothing (DEC-002).
 */
function select({
  descriptors, registry, coverage, harness, needs, active, edit = false,
  env = process.env, cwd = process.cwd(), root = cwd, now = Date.now, platform = process.platform,
}: any = {}) {
  const context = readinessContext({ descriptors, registry, coverage, active });
  const entries = harness ? context.entries.filter((item) => item.harness === harness) : context.entries;
  if (harness && !context.known.includes(harness)) {
    throw new ReadinessError('usage', `unknown harness '${harness}'; known: ${context.known.join(', ')}`);
  }
  const valid = validateNeeds(needs, context.coverage);
  const tick = clock(now);
  const evaluated = entries.map((entry) => evaluateHarness(entry, valid, context.coverage, { env, cwd, root, now: tick, platform, edit }));
  const candidates = evaluated.map(({ harness: id, eligible, gaps }) => ({ harness: id, eligible, gaps }));
  const chosen = evaluated.find((item) => item.eligible);
  if (!chosen) {
    return {
      disposition: 'none-eligible',
      candidates,
      fallback: { modes: ['sequential', 'manual'], rule: 'claim with --mode sequential or manual; a subagent claim is run only by worker --action run' },
    };
  }
  const met = chosen.requirements.map((item: any) => item.requirement).join(', ');
  return {
    disposition: 'selected',
    harness: chosen.harness,
    reason: `first eligible harness in registry order; met: ${met}; probed at ${chosen.recordedAt}`,
    candidates,
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  PROBE_MAX_AGE_MS,
  PROBE_STDOUT_MAX,
  FACTS,
  ReadinessError,
  descriptorDigest,
  workerDescriptors,
  findOnPath,
  discover,
  probe,
  newProbeIdentity,
  observeForwarding,
  bindingObserved,
  effectiveFacts,
  readProbeRecord,
  probeFile,
  BASELINE,
  EDIT_BASELINE,
  NEED_IDS,
  policyVocabulary,
  validateNeeds,
  capabilityRequirement,
  requirementsFor,
  eligibility,
  describe,
  select,
};
