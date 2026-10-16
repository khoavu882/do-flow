'use strict';

// Feature 082 C.2 (IC-033 declaration, request and status; DEC-008, DEC-028, DEC-041, DEC-051,
// DEC-062): spawn grants and the `spawn` action. Run directly by Node native type-stripping.
//
//   - `validateGrant` checks `dispatch start --spawn-grant` against `--reserve-tokens`; `copyGrant`
//     gives the copy each subagent dispatch carries, with its own `used` counters.
//   - `requestSpawn` runs IC-033's refusals in order. Steps 1 to 3 and every read (the prompt, the
//     080 run's control, real paths) happen before the lock; steps 4 to 10 and the request's record
//     run inside one `mutateDispatch`, so a refusal writes nothing. The prompt copy
//     `dispatch-envelopes/<d-id>.c<n>.prompt.txt` is written after that lock, by temp file then
//     rename: this is one of the three dispatch modules allowed a direct fs write (IC-037).
//   - `spawnStatus` runs steps 1 to 4 over an unlocked read and reports a request of the caller's
//     own dispatch.
//
// Launching the child is the loop's (IC-033 launch, C.3): it moves a request from `requested` to
// `launched` or `refused`, records `childRunId` and the child's `identity`, and sets `endState`
// (and `report`) when the child run ends. A request counts toward `grant.children` until it is
// `refused` or has an `endState`. Spawns a harness makes through its own subagent tool are
// invisible here; only this action is bounded (DEC-008).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTaskState } = require('../task-state.ts');
const { storeFile: attemptStoreFile } = require('../task-attempts.ts');
const { resolveIdentity } = require('../context/identity.ts');
const { projectRoot } = require('../lifecycle/root.ts');
const { storeFileFor, readDispatch, mutateDispatch, DispatchStoreError } = require('./store.ts');
const { ENVELOPE_DIR } = require('./envelope.ts');

const MAX_DEPTH = 1;
const MAX_CHILDREN = 4;
const GRANT_KEYS = Object.freeze(['depth', 'children', 'tokens']);
const WORKTREE_DIR = 'dispatch-worktrees';
const REQUEST_ID = /^(d-[0-9a-f]{12})\.c([1-9][0-9]*)$/;
const WHOLE = /^[0-9]+$/;

type Env = Record<string, string | undefined>;
interface Grant { depth: number; children: number; tokens: number }

function usage(message: string) {
  return new DispatchStoreError('usage', message);
}

/** A whole number given as an integer or a `^[0-9]+$` string, else null. */
function whole(value: any): number | null {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && WHOLE.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

/**
 * IC-033 declaration. `grant` is the `--spawn-grant` JSON text or its parsed object; returns
 * `{ depth, children, tokens }`, or throws `usage` (exit 2). `depth` 0 or 1, `children` 0 to 4,
 * `tokens` a whole number no larger than `reserveTokens`; a run started without `--reserve-tokens`
 * can grant no tokens, since the carve has nothing to be carved from.
 */
function validateGrant(grant: any, reserveTokens: any = null): Grant {
  let value = grant;
  if (typeof grant === 'string') {
    try { value = JSON.parse(grant); } catch { throw usage('--spawn-grant is not valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage('--spawn-grant must be a JSON object {depth, children, tokens}');
  const extra = Object.keys(value).filter((k) => !GRANT_KEYS.includes(k));
  if (extra.length) throw usage(`--spawn-grant has unknown field '${extra[0]}'`);
  const { depth, children, tokens } = value;
  if (depth !== 0 && depth !== 1) throw usage(`--spawn-grant depth must be 0 or ${MAX_DEPTH}`);
  if (!Number.isInteger(children) || children < 0 || children > MAX_CHILDREN) throw usage(`--spawn-grant children must be 0 to ${MAX_CHILDREN}`);
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw usage('--spawn-grant tokens must be a whole number');
  const reserve = reserveTokens == null ? null : whole(reserveTokens);
  if (reserveTokens != null && reserve === null) throw usage('--reserve-tokens must be a whole number');
  if (tokens > (reserve ?? 0)) throw usage(`--spawn-grant tokens ${tokens} exceeds --reserve-tokens ${reserve ?? 'absent'}`);
  return { depth, children, tokens };
}

/** DEC-051: the grant a dispatch carries, its own counters at zero; null for a main-session
 * dispatch or a run with no grant. */
function copyGrant(runGrant: Grant | null, mode: string) {
  if (!runGrant || mode !== 'subagent') return null;
  return { depth: runGrant.depth, children: runGrant.children, tokens: runGrant.tokens, used: { children: 0, tokens: 0 } };
}

function real(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function refused(reason: string, extra: Record<string, any> = {}) {
  return { disposition: 'refused', reason, ...extra };
}

/** Steps 1 and 2: the caller's identity, or a refusal. */
function callerOf(env: Env, cwd: string): any {
  const id = resolveIdentity(env, { cwd, sessionId: '' });
  if (id.role !== 'worker') return { refusal: refused('not-worker-session') };
  if (id.lineageKind !== 'launched' || !env.DOFLOW_WORKTREE) return { refusal: refused('identity-incomplete') };
  return { caller: { run: id.run, lineage: id.lineage, attempt: id.attempt, worktree: real(env.DOFLOW_WORKTREE) } };
}

function sameIdentity(a: any, b: any): boolean {
  return !!a && a.run === b.run && a.lineage === b.lineage && String(a.attempt) === String(b.attempt);
}

/** The child worktree a request names (IC-016), real path when it exists. */
function childWorktree(root: string, requestId: string): string {
  return real(path.join(root, '.doflow', 'state', WORKTREE_DIR, requestId));
}

/** Real paths of every dispatch's attempt worktree and every request's child worktree (keyed
 * `child:<id>`), read before the lock so `decide` does no I/O. */
function realPaths(store: any, root: string): Map<string, string> {
  const out = new Map();
  for (const d of Object.values(store.dispatches) as any[]) {
    const p = d.attempt && d.attempt.worktree;
    if (typeof p === 'string' && !out.has(p)) out.set(p, real(p));
  }
  for (const id of Object.keys(store.spawnRequests)) out.set(`child:${id}`, childWorktree(root, id));
  return out;
}

function liveChild(request: any): boolean {
  return request.state !== 'refused' && request.endState == null;
}

/**
 * Step 4. Every non-ended dispatch whose recorded worker identity equals the caller's and whose
 * attempt worktree is the caller's by real path, plus, with `children`, every live request of a
 * non-ended dispatch whose child worktree is the caller's (matched so step 5 can name it). The
 * worktree is part of the match: two workers of one launched main session share run, lineage and
 * attempt (DEC-041).
 */
function matchCaller(store: any, caller: any, paths: Map<string, string>, root: string, children: boolean) {
  const childPath = (id: string) => paths.get(`child:${id}`) ?? path.join(root, '.doflow', 'state', WORKTREE_DIR, id);
  const matches: Array<{ dispatchId: string; requestId: string | null }> = [];
  for (const d of Object.values(store.dispatches) as any[]) {
    if (d.phase === 'ended' || !sameIdentity(d.workerIdentity, caller)) continue;
    const p = d.attempt && d.attempt.worktree;
    if (typeof p !== 'string' || (paths.get(p) ?? path.resolve(p)) !== caller.worktree) continue;
    matches.push({ dispatchId: d.dispatchId, requestId: null });
  }
  if (!children) return matches;
  for (const r of Object.values(store.spawnRequests) as any[]) {
    const granter = store.dispatches[r.granterDispatchId];
    if (!granter || granter.phase === 'ended' || !liveChild(r)) continue;
    if (r.identity && !sameIdentity(r.identity, caller)) continue;
    if (childPath(r.requestId) !== caller.worktree) continue;
    matches.push({ dispatchId: r.granterDispatchId, requestId: r.requestId });
  }
  return matches;
}

/** The next `<d-id>.c<n>` for a granter: one past the highest `n` it has used. */
function nextRequestId(store: any, dispatchId: string): string {
  let n = 0;
  for (const id of Object.keys(store.spawnRequests)) {
    const m = REQUEST_ID.exec(id);
    if (m && m[1] === dispatchId) n = Math.max(n, Number(m[2]));
  }
  return `${dispatchId}.c${n + 1}`;
}

/** The 080 run's `control`, read without a lock before the dispatch lock (IC-006 allows no read
 * inside it); null when the ledger or the run is absent. */
function runControl(root: string, slug: string, runKey: any, fsImpl: any): string | null {
  if (typeof runKey !== 'string') return null;
  let ledger: any;
  try { ledger = readTaskState(fsImpl, attemptStoreFile(root, slug)); } catch { return null; }
  const run = ledger && ledger.runs && Object.prototype.hasOwnProperty.call(ledger.runs, runKey) ? ledger.runs[runKey] : null;
  return run && typeof run.control === 'string' ? run.control : null;
}

/**
 * IC-033 request: `dispatch --action spawn --slug --prompt-file --reserve-tokens`. Returns
 * `{ disposition: 'spawn-requested', requestId, state: 'requested' }`, or `{ disposition: 'refused',
 * reason, ... }` (exit 1) with nothing written; throws `usage` (exit 2) for a bad flag or an
 * unreadable prompt file.
 */
function requestSpawn({ slug, promptFile, reserveTokens, env = process.env, cwd = process.cwd(), root, fsImpl = fs, now = new Date() }: any) {
  storeFileFor(root ?? '.', slug); // step 0: validates the slug
  if (typeof promptFile !== 'string' || promptFile === '') throw usage('--prompt-file is required for --action spawn');
  const reserve = whole(reserveTokens);
  if (reserve === null) throw usage('--reserve-tokens must be a whole number for --action spawn');

  const who = callerOf(env, cwd);
  if (who.refusal) return who.refusal;
  const caller = who.caller;
  const base = real(root ?? projectRoot(cwd));
  const storeFile = storeFileFor(base, slug);

  const seen = readDispatch(storeFile, fsImpl);
  if (!seen.run) return refused('no-dispatch-run');

  let prompt: Buffer;
  try { prompt = fsImpl.readFileSync(path.resolve(cwd, promptFile)); } catch (err: any) {
    throw usage(`--prompt-file '${promptFile}' cannot be read: ${err && err.code ? err.code : err}`);
  }
  const promptSha256 = crypto.createHash('sha256').update(prompt).digest('hex');
  const control = runControl(base, slug, seen.run.runKey, fsImpl);
  const paths = realPaths(seen, base);

  // The copy, so the worker may delete its own file (which would otherwise count as a change of its
  // attempt). Written before the lock under a temporary name and renamed to its request's name in the
  // write that records the request, so no `requested` record is ever seen without its prompt (RT-16).
  const dir = path.join(base, '.doflow', 'state', ENVELOPE_DIR);
  const staged = path.join(dir, `.spawn.${process.pid}.${crypto.randomBytes(4).toString('hex')}.prompt.tmp`);
  fsImpl.mkdirSync(dir, { recursive: true });
  try {
    fsImpl.writeFileSync(staged, prompt, { mode: 0o600 });
  } catch (err) {
    try { fsImpl.rmSync(staged, { force: true }); } catch { /* the original error is the one reported */ }
    throw err;
  }
  let copyError: any = null;

  let result: any = null;
  try {
    result = mutateDispatch(storeFile, (store: any) => {
      const no = (reason: string, extra?: Record<string, any>) => ({ write: false, result: refused(reason, extra) });
      if (!store.run) return no('no-dispatch-run');
      const matches = matchCaller(store, caller, paths, base, true);
      if (matches.length === 0) return no('no-matching-dispatch');
      if (matches.length > 1) return no('identity-ambiguous', { dispatchIds: matches.map((m) => m.dispatchId).sort() });
      const [{ dispatchId, requestId: childOf }] = matches;
      if (childOf) return no('depth-exceeded', { limit: MAX_DEPTH, requestId: childOf });
      const d = store.dispatches[dispatchId];
      if (d.phase !== 'launched') return no('granter-not-running', { dispatchId, phase: d.phase });
      if (control === 'paused') return no('run-paused', { dispatchId });
      if (control !== 'running' || store.run.state === 'cancelling' || store.run.state === 'cancelled') return no('run-cancelled', { dispatchId });
      const grant = d.grant;
      if (!grant || grant.depth !== MAX_DEPTH) return no('spawning-denied', { dispatchId });
      const active = (Object.values(store.spawnRequests) as any[]).filter((r) => r.granterDispatchId === dispatchId && liveChild(r)).length;
      if (active >= grant.children) return no('concurrency-exceeded', { dispatchId, limit: grant.children });
      const used = grant.used || { children: 0, tokens: 0 };
      const remaining = grant.tokens - used.tokens;
      if (reserve > remaining) return no('budget-exceeded', { dispatchId, remaining });

      const requestId = nextRequestId(store, dispatchId);
      // One rename inside the lock, so the prompt exists before the record does; a failed rename
      // writes nothing and spends nothing.
      try { fsImpl.renameSync(staged, path.join(dir, `${requestId}.prompt.txt`)); } catch (err) {
        copyError = err;
        return { write: false, result: null };
      }
      store.spawnRequests[requestId] = {
        requestId,
        granterDispatchId: dispatchId,
        prompt: `${ENVELOPE_DIR}/${requestId}.prompt.txt`,
        promptSha256,
        reserveTokens: reserve,
        requestedAt: now.toISOString(),
        state: 'requested',
        reason: null,
        childRunId: null,
        identity: null,
        endState: null,
        report: null,
      };
      d.grant = { ...grant, used: { children: used.children + 1, tokens: used.tokens + reserve } };
      return { write: true, result: { disposition: 'spawn-requested', requestId, state: 'requested' } };
    }, fsImpl);
  } finally {
    if (!result || result.disposition !== 'spawn-requested') {
      try { fsImpl.rmSync(staged, { force: true }); } catch { /* a refusal is still the answer */ }
    }
  }
  if (copyError) throw copyError;
  return result;
}

/**
 * IC-033 status: `dispatch --action spawn --slug --request-id`. Steps 1 to 4 over an unlocked read;
 * `{ disposition: 'spawn-status', requestId, state, childRunId, endState, report }` for a request
 * of the caller's own dispatch, else a refusal (`unknown-request` for any other request id).
 */
function spawnStatus({ slug, requestId, env = process.env, cwd = process.cwd(), root, fsImpl = fs }: any) {
  storeFileFor(root ?? '.', slug);
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw usage(`--request-id '${requestId}' is not '<d-id>.c<n>'`);
  const who = callerOf(env, cwd);
  if (who.refusal) return who.refusal;
  const base = real(root ?? projectRoot(cwd));
  const store = readDispatch(storeFileFor(base, slug), fsImpl);
  if (!store.run) return refused('no-dispatch-run');
  const matches = matchCaller(store, who.caller, realPaths(store, base), base, false);
  if (matches.length === 0) return refused('no-matching-dispatch');
  if (matches.length > 1) return refused('identity-ambiguous', { dispatchIds: matches.map((m) => m.dispatchId).sort() });
  const request = Object.prototype.hasOwnProperty.call(store.spawnRequests, requestId) ? store.spawnRequests[requestId] : null;
  if (!request || request.granterDispatchId !== matches[0].dispatchId) return refused('unknown-request', { requestId });
  return {
    disposition: 'spawn-status',
    requestId,
    state: request.state,
    childRunId: request.childRunId ?? null,
    endState: request.endState ?? null,
    report: request.report ?? null,
  };
}

module.exports = {
  MAX_DEPTH,
  MAX_CHILDREN,
  REQUEST_ID,
  WORKTREE_DIR,
  validateGrant,
  copyGrant,
  requestSpawn,
  spawnStatus,
};
