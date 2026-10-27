'use strict';

// Feature 117 A.1 (IC-002): the two ledger scenarios the actor gate runs, and the fixture both the
// in-suite regressions and the sampler build them from, so the two always exercise one setup.
//
//   S1  A.1 claimed (token 1)   A: finish(A.1, token 1, BLOCKED)   B: cancel(A.1, token 1)
//   S2  nothing claimed         A: claim(A.1)                      B: claim(A.1)
//
// Initial lock `none` leaves no `<store>.lock`; `stale` seeds one 60 s old with no live holder.
// The ledger is loaded from the checkout under test (`repo`), never from this file's own tree.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = path.resolve(__dirname, '../..');
const SLUG = 'feat-race';
const NOW = new Date('2000-01-02T00:00:00.000Z');
const STALE_AGE_MS = 60_000;
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 t; owner: core-implementer; files: a.js', ''].join('\n');
const CLAIM = { task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 };

const SCENARIOS: any = {
  S1: { actors: [
    { name: 'A', op: 'finish', args: { task: 'A.1', token: 1, result: 'BLOCKED' } },
    { name: 'B', op: 'cancel', args: { task: 'A.1', token: 1, by: 'lead', reason: 'stop' } },
  ] },
  S2: { actors: [
    { name: 'A', op: 'claim', args: { ...CLAIM } },
    { name: 'B', op: 'claim', args: { ...CLAIM } },
  ] },
};
const INITS = ['none', 'stale'];

// Two S1 traces from lock `none` on the 117 Phase C lock, shared by the instrument's own tests.
// INTERLEAVED: the actors alternate from the first call; A takes the lock and finishes, B waits on it,
// then cancels nothing (refused). Replayed it gives one outcome; granted on release it does not.
const INTERLEAVED = 'A.mkdir B.mkdir A.mkdir B.stat A.readdir B.mkdir A.exists B.stat A.readFile B.mkdir A.writeFile B.stat '
  + 'A.exists B.mkdir A.rename B.stat A.stat B.mkdir A.exists B.stat A.rmdir B.mkdir A.stat B.stat A.rmdir B.mkdir B.mkdir '
  + 'B.readdir B.exists B.readFile B.stat B.exists B.rmdir B.stat B.rmdir';
// LOST_ACK: the lock's documented bound. A passes its ownership check (A.exists after its tmp write),
// the lock then ages past LOCK_STALE_MS (age-lock@7), B reclaims it in place and reads before A's rename
// lands, and B's write replaces A's: finish `applied`, cancel `cancelled`, final `cancelled`.
const LOST_ACK = 'A.mkdir A.mkdir A.readdir A.exists A.readFile A.writeFile A.exists age-lock@7 B.mkdir B.stat B.readdir '
  + 'B.stat B.mkdir B.stat B.rmdir B.readdir B.exists B.readFile A.rename B.writeFile B.exists B.rename B.stat B.exists B.rmdir '
  + 'B.stat B.rmdir A.stat A.rmdir';

const ledger = (repo: any) => require(path.join(repo, 'src/runtime/task-attempts.ts'));

/** The whole environment an actor sees: a fixed identity rooted in the fixture dir. */
const envFor = (dir: any) => ({
  DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
  DOFLOW_WORKTREE: dir, HOME: dir,
});

/** Sets `<file>.lock`'s mtime 60 s back. Returns false when there is no lock to age. */
function ageLock(file: any) {
  const past = new Date(Date.now() - STALE_AGE_MS);
  try { fs.utimesSync(`${file}.lock`, past, past); return true; } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Writes the scenario's starting state into `dir` (an empty temp dir the caller owns): a `.git`
 * dir, the plan, the store with one run at epoch 1, A.1 claimed for S1 (plain fs, before any gating)
 * and the stale lock for init `stale`. Returns the JSON-serialisable call context the actors share.
 */
function buildFixture({ repo = DEFAULT_REPO, dir, scenario, init = 'none' }: any) {
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario '${scenario}'`);
  if (!INITS.includes(init)) throw new Error(`unknown init '${init}'`);
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env = envFor(dir);
  const { runKeyFor, createRun } = require(path.join(repo, 'src/runtime/task-run.ts'));
  const key = runKeyFor(env, dir);
  fs.writeFileSync(file, JSON.stringify({
    version: 1, revision: 1, planPath: null, tasks: {}, runs: { [key.runKey]: createRun(key, null, NOW, { epoch: 1 }) },
  }));
  const fixture = { file, roots: [dir], slug: SLUG, env, cwd: dir };
  if (scenario === 'S1') actorCall({ repo, fixture, op: 'claim', args: CLAIM, fsImpl: fs });
  if (init === 'stale') {
    fs.mkdirSync(`${file}.lock`);
    ageLock(file);
  }
  return fixture;
}

/** One ledger operation against the fixture, at the fixed clock. Returns the ledger's response. */
function actorCall({ repo = DEFAULT_REPO, fixture, op, args, fsImpl }: any) {
  const { file, roots, slug, env, cwd } = fixture;
  return ledger(repo)[op]({ file, fsImpl, roots, slug, env, cwd, now: NOW, ...args });
}

module.exports = { SCENARIOS, INITS, NOW, DEFAULT_REPO, INTERLEAVED, LOST_ACK, buildFixture, actorCall, ageLock };
