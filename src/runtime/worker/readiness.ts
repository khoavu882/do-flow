'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Worker readiness, first half (feature 081 B.1): discover (IC-004), probe facts and the probe
 * record (IC-005), model-backed checks (IC-006), freshness (IC-007) and the identity-forwarding
 * observation (IC-023). DEC-003, DEC-004, DEC-018, DEC-019, DEC-031.
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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runProbe, PROBE_TIMEOUT_MS } = require('../health.ts');
const { updateTaskState, readTaskState } = require('../task-state.ts');
const { stateDir } = require('../context/identity.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { spawnBounded } = require('./process-tree.ts');
const { parserFor } = require('./parsers.ts');

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

/** Stable JSON: object keys sorted at every depth. */
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:` over the stable JSON of a harness's `worker` block (IC-007). */
function descriptorDigest(worker: any): string {
  return `sha256:${crypto.createHash('sha256').update(stable(worker)).digest('hex')}`;
}

/** `[{ harness, worker }]` in registry order: the registry's blocks, or exactly the injected ones. */
function workerDescriptors({ descriptors, registry }: any = {}): { harness: string; worker: any }[] {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  const ids: string[] = reg.harnesses.map((h: any) => h.id);
  if (!descriptors) return reg.harnesses.map((h: any) => ({ harness: h.id, worker: h.worker }));
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
  try {
    const stat = fs.lstatSync(path.join(stateDir(env), 'sessions', unit, 'bound'));
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
  const config = env?.XDG_CONFIG_HOME || path.join(env?.HOME || os.homedir(), '.config');
  let text: string;
  try {
    text = fs.readFileSync(path.join(config, 'doflow', 'sessions.log'), 'utf8');
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

const freshAt = (at: any, nowMs: number) => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && nowMs - ms <= PROBE_MAX_AGE_MS;
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
  descriptors, registry, harness, modelCheck, budgetTokens,
  env = process.env, cwd = process.cwd(), now = Date.now, platform = process.platform,
  probeIdentity = newProbeIdentity,
}: any = {}) {
  const tick = clock(now);
  const all = workerDescriptors({ descriptors, registry });
  const entries = harness ? all.filter((entry) => entry.harness === harness) : all;
  if (harness && entries.length === 0) {
    throw new ReadinessError('usage', `unknown harness '${harness}'; known: ${all.map((entry) => entry.harness).join(', ')}`);
  }
  const refusal = checkModelRequest(entries, harness, modelCheck, budgetTokens);
  if (refusal) return refusal;

  const root = cwd;
  const results: any[] = [];
  for (const entry of entries) {
    const found = discoverOne(entry, { env, cwd: root, now: tick, platform });
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
    results.push({ harness: entry.harness, facts: record.facts, recordedAt: record.at, ...(ran ? { modelCheck: ran } : {}) });
  }
  return { disposition: 'probed', harnesses: results };
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
};
