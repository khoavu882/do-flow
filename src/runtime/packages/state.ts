'use strict';

/**
 * The DoFlow-written package state file (122 IC-009, PN-1): `~/.doflow/packages/state.json`, atomic writes,
 * owner-only mode 0600. It holds narrowing facts only (`revoked`, `suspended`, `audit`, `removed`), never a
 * widening one. A missing file is empty state; a malformed one counts as every package revoked (`unreadable`).
 * The writers read, change and rewrite the file: a caller that writes takes the scope's `run.lock` first (IC-007).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicJsonWrite } = require('../../state/index.ts');

const STATE_VERSION = 1;
const AUDIT_MAX = 64;
const TOP_KEYS = ['state', 'revoked', 'suspended', 'audit', 'removed'];
const DIGEST = /^[0-9a-f]{64}$/;

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: any): boolean => typeof value === 'string' && value !== '';
const isTime = (value: any): boolean => isText(value) && !Number.isNaN(Date.parse(value));

const SHAPES: Record<string, (item: any) => boolean> = {
  revoked: (r) => isObject(r) && isText(r.package) && DIGEST.test(r.contentDigest) && isTime(r.at),
  suspended: (s) => isObject(s) && isText(s.package) && isText(s.reason) && isTime(s.since) && typeof s.projected === 'boolean',
  audit: (a) => isObject(a) && isTime(a.at) && isText(a.verb) && isText(a.package) && isText(a.result),
  removed: (r) => isObject(r) && isText(r.package) && Array.isArray(r.qualifiedIds) && r.qualifiedIds.every(isText) && isTime(r.at),
};

const emptyState = (): any => ({ state: STATE_VERSION, revoked: [], suspended: [], audit: [], removed: [] });

/** `~/.doflow/packages/state.json` (home from `homeDir`, else `os.homedir()`). */
const statePath = (homeDir?: string): string => path.join(homeDir ?? os.homedir(), '.doflow', 'packages', 'state.json');

function stateProblem(value: any): string | null {
  if (!isObject(value)) return 'not a JSON object';
  if (Object.keys(value).some((key) => !TOP_KEYS.includes(key))) return 'unknown key';
  if (value.state !== STATE_VERSION) return 'unsupported state version';
  for (const [key, valid] of Object.entries(SHAPES)) {
    if (value[key] !== undefined && !(Array.isArray(value[key]) && value[key].every(valid))) return `bad ${key}`;
  }
  return null;
}

/**
 * Read the state. Returns `{ path, exists, unreadable, state, findings }`. A missing file: empty `state`, no
 * finding. A malformed file: `unreadable` true, empty `state` and one `state-unreadable` finding; callers treat
 * `unreadable` as every package revoked (`grantRevoked`). Never throws.
 */
function readState({ homeDir, fsImpl = fs }: any = {}): any {
  const file = statePath(homeDir);
  const result: any = { path: file, exists: false, unreadable: false, state: emptyState(), findings: [] };
  let text: string;
  try {
    text = String(fsImpl.readFileSync(file, 'utf8'));
    result.exists = true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return result;
    text = '';
    result.exists = true;
  }
  let problem: string | null;
  let parsed: any;
  try { parsed = JSON.parse(text); problem = stateProblem(parsed); } catch { problem = 'not valid JSON'; }
  if (problem !== null) {
    result.unreadable = true;
    result.findings.push({ package: null, field: 'state.json', code: 'state-unreadable', severity: 'error',
      message: `the package state file is unreadable (${problem}); every package counts as revoked until verify --repair`, allowed: 'a state.json DoFlow wrote' });
    return result;
  }
  result.state = { ...emptyState(), ...parsed, audit: (parsed.audit ?? []).slice(-AUDIT_MAX) };
  return result;
}

/** Write the state atomically with mode 0600 (the temp file is created 0600 and renamed over the target). */
function writeState(state: any, { homeDir, fsImpl = fs }: any = {}): string {
  // The file is created 0600: `atomicJsonWrite` (the declared writer) gets an fs whose file writes carry that mode.
  const owned = new Proxy(fsImpl, {
    get: (target: any, name: string) => (name === 'writeFileSync'
      ? (file: string, data: string, options: any) => target[name](file, data, { ...options, mode: 0o600 })
      : (typeof target[name] === 'function' ? target[name].bind(target) : target[name])),
  });
  return atomicJsonWrite(statePath(homeDir), { ...state, audit: state.audit.slice(-AUDIT_MAX) }, { fsImpl: owned });
}

/** Read, apply `change` to the state, write. A malformed file is replaced only through `repairState`, so this refuses it. */
function update(options: any, change: (state: any) => void): any {
  const read = readState(options);
  if (read.unreadable) throw new Error('the package state file is unreadable; run verify --repair first');
  change(read.state);
  writeState(read.state, options);
  return read.state;
}

/** Revoke trust for `packageId` at `contentDigest`: a trust grant counts only when its `at` is later than `at`. */
function recordRevocation(options: any, { packageId, contentDigest, at = new Date().toISOString() }: any): any {
  return update(options, (state) => {
    state.revoked = state.revoked.filter((r: any) => !(r.package === packageId && r.contentDigest === contentDigest));
    state.revoked.push({ package: packageId, contentDigest, at });
  });
}

/** The last detected suspension for `packageId` (one per package); `projected` says its files are still on disk. */
function recordSuspension(options: any, { packageId, reason, projected = false, since = new Date().toISOString() }: any): any {
  return update(options, (state) => {
    state.suspended = state.suspended.filter((s: any) => s.package !== packageId);
    state.suspended.push({ package: packageId, reason, since, projected });
  });
}

/** Drop the suspension record of `packageId` (it is intact again). */
function clearSuspension(options: any, { packageId }: any): any {
  return update(options, (state) => { state.suspended = state.suspended.filter((s: any) => s.package !== packageId); });
}

/** PN-1 tombstone: `remove` names the package's worker qualified ids; one entry per package, the latest. */
function recordTombstone(options: any, { packageId, qualifiedIds, at = new Date().toISOString() }: any): any {
  return update(options, (state) => {
    state.removed = state.removed.filter((r: any) => r.package !== packageId);
    state.removed.push({ package: packageId, qualifiedIds: [...qualifiedIds], at });
  });
}

/** Append one package verb result; only the latest 64 entries are kept, newest last. */
function appendAudit(options: any, { verb, packageId, result, at = new Date().toISOString() }: any): any {
  return update(options, (state) => { state.audit.push({ at, verb, package: packageId, result }); });
}

/**
 * `verify --repair` (IC-009): rewrite the state with one revocation per grant line present now (`grantEntries` is
 * `readGrants(...).entries`; a line with a package and a content digest names its revocation), `at` the repair
 * time. Suspensions, tombstones and audit are dropped with the unreadable file. Repair never widens: every
 * grant read before `at` stays void until the person adds a line printed after it. A `fetch` line names no
 * package, so it has no revocation record to hold; it widens network access only, and its result still needs trust.
 */
function repairState(options: any, { grantEntries = [], at = new Date().toISOString() }: any = {}): any {
  const state = emptyState();
  for (const entry of grantEntries) {
    if (!isText(entry?.package) || !DIGEST.test(entry?.contentDigest)) continue;
    if (!state.revoked.some((r: any) => r.package === entry.package && r.contentDigest === entry.contentDigest)) {
      state.revoked.push({ package: entry.package, contentDigest: entry.contentDigest, at });
    }
  }
  state.audit.push({ at, verb: 'verify --repair', package: '*', result: `ok: ${state.revoked.length} revoked` });
  writeState(state, options);
  return state;
}

/**
 * Whether a `trust` or `exempt` grant is revoked by `read` (a `readState` result): always when the state is
 * unreadable; else when a revocation names the same package and content digest and the grant's `at` is not
 * later than the revocation's.
 */
function grantRevoked(read: any, grant: any): boolean {
  if (read.unreadable) return true;
  return read.state.revoked.some((r: any) => r.package === grant.package && r.contentDigest === grant.contentDigest
    && !(Date.parse(grant.at) > Date.parse(r.at)));
}

module.exports = {
  statePath, readState, writeState, recordRevocation, recordSuspension, clearSuspension, recordTombstone,
  appendAudit, repairState, grantRevoked, AUDIT_MAX,
};
