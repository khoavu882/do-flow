'use strict';

// Feature 082 SF-2 (IC-001 exit mapping, IC-004): `run`'s two stops that are not a pass outcome.
// `--max-seconds` over a sleeping fake worker returns `continue` with `timeUp: true`, and a SIGTERM
// emitted in process while the loop waits finishes the phase in progress and returns `signal` with
// exit 143. Either way the driver `run` registered is ended (`endedAt`) before it returns.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, an
// integration worktree and a seeded dispatch run. The child PATH is the sandbox's scratch bin/
// alone (fake CLI links, node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_*
// identity variables are set by the sandbox, DOFLOW_ATTEMPT deleted where a worker is launched.
// POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const controls = require(path.join(SRC, 'dispatch', 'controls.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));

const SLUG = '082-run-signals-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SLEEPER: any = { run: [{ sleep: 30000 }, { emit: { type: 'result', status: 'success', summary: 'edited' } }] };

async function project(t: any) {
  const sb = makeDispatchSandbox(t, { plan: 'budget', slug: SLUG, scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root, env } = sb;
  const ledgerFile = attempts.storeFile(root, SLUG);
  const started = attempts.start({ file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency: 1, mode: 'auto',
      reserveTokens: null, attemptSeconds: 60, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
    };
    return { write: true, result: null };
  });
  assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: root })).disposition, 'probed');
  const options = (extra: any = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  // The sleeping worker is ended once the case is done.
  t.after(() => controls.cancel({ slug: SLUG, env, cwd: root, by: 'main', reason: 'test done' }).catch(() => {}));
  return { file, options, read: () => store.readDispatch(file) };
}

const lastDriver = (s: any) => s.drivers[s.drivers.length - 1];

test('SF-2 / IC-004: run --max-seconds 1 over a sleeping worker returns continue with timeUp true and ends its driver', POSIX, async (t) => {
  const p = await project(t);
  const r = await loop.run(p.options({ maxSeconds: 1 }));
  const driver = lastDriver(p.read());
  assert.deepEqual([r.disposition, r.outcome, r.timeUp, r.signal ?? null, typeof (driver && driver.endedAt)], ['ran', 'continue', true, null, 'string'], JSON.stringify(r));
});

test('SF-2 / IC-001: a SIGTERM during run returns signal SIGTERM with exit 143 and ends its driver', POSIX, async (t) => {
  const p = await project(t);
  let emitted = false;
  // The loop's idle wait is its seam: the signal arrives while no phase runs, then the wait returns.
  const sleep = async (ms: any) => {
    if (!emitted) { emitted = true; process.emit('SIGTERM', 'SIGTERM'); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50)));
  };
  const r = await loop.run(p.options({ sleep, maxSeconds: 30 }));
  const driver = lastDriver(p.read());
  assert.deepEqual([emitted, r.signal, r.exit, r.timeUp, typeof (driver && driver.endedAt)], [true, 'SIGTERM', 143, false, 'string'], JSON.stringify(r));
});
