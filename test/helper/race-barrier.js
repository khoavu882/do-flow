'use strict';

// Feature 080 R.1 (IC-021, NFR-002; RK5): a race harness of long-lived child processes that call
// the task-attempt ledger module directly and are released together by a barrier file.
//
// Each worker is spawned once and serves many repetitions, so a 50-repetition race pays Node's
// start-up and the module load once rather than once per repetition. Per repetition the parent
// sends every worker one operation; each worker answers `ready` and then spins on `existsSync` of
// that repetition's barrier file. When every worker is ready the parent creates the file, every
// worker acts at once, and each answers with the operation's result. Nothing waits on a timer: the
// order of the racers is decided only by the lock, which is what the races test.
//
// Run as `node race-barrier.js --race-worker <module>` it is the worker; required, it is the parent.

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const WORKER_FLAG = '--race-worker';
const OPERATIONS = ['claim', 'finish', 'release', 'cancel'];

// ── worker ──────────────────────────────────────────────────────────────────────────────────────

function runWorker(modulePath) {
  const ledger = require(modulePath);
  const lines = readline.createInterface({ input: process.stdin });
  const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  lines.on('line', (line) => {
    const { rep, barrier, op, args, skewUs = 0 } = JSON.parse(line);
    reply({ rep, ready: true });
    while (!fs.existsSync(barrier)) { /* spin: released by the parent creating the barrier */ }
    // A swept start offset after the release, so a race whose racers differ in pre-lock work still
    // visits both orders. It spreads the interleavings; it never decides an outcome.
    const until = process.hrtime.bigint() + BigInt(Math.round(skewUs * 1000));
    while (process.hrtime.bigint() < until) { /* spin */ }
    try {
      const call = { ...args, fsImpl: fs, ...(args.now ? { now: new Date(args.now) } : {}) };
      reply({ rep, result: ledger[op](call) });
    } catch (error) {
      reply({ rep, error: { name: error.name, code: error.code || null, message: error.message } });
    }
  });
}

// ── parent ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Spawn `count` workers for `modulePath`. `envFor(i)` is each worker's whole environment (PATH is
 * added), so the developer's shell never decides a run key. Returns `{ race, stop }`.
 */
function startWorkers({ count, modulePath, envFor, barrierDir }) {
  let rep = 0;
  const workers = Array.from({ length: count }, (_, i) => {
    const child = spawn(process.execPath, [__filename, WORKER_FLAG, modulePath], {
      env: { ...envFor(i), PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const waiting = new Map();
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      const key = `${message.rep}:${message.ready ? 'ready' : 'done'}`;
      const resolve = waiting.get(key);
      if (resolve) { waiting.delete(key); resolve(message); }
    });
    const expect = (r, kind) => new Promise((resolve, reject) => {
      waiting.set(`${r}:${kind}`, resolve);
      exited.then((code) => reject(new Error(`race worker ${i} exited with ${code} during repetition ${r}`)));
    });
    return { child, expect, exited };
  });

  /**
   * One repetition: `ops[i]` is `{ op, args, skewUs? }` for worker i (`args.now` an ISO string;
   * `skewUs` microseconds the worker spins after the barrier opens). Resolves to each worker's
   * `{ result }` or `{ error }`, in worker order.
   */
  async function race(ops) {
    if (ops.length !== workers.length) throw new Error(`race: ${ops.length} operations for ${workers.length} workers`);
    for (const { op } of ops) if (!OPERATIONS.includes(op)) throw new Error(`race: unknown operation '${op}'`);
    rep += 1;
    const r = rep;
    const barrier = path.join(barrierDir, `barrier-${r}`);
    const ready = workers.map((w) => w.expect(r, 'ready'));
    const done = workers.map((w) => w.expect(r, 'done'));
    workers.forEach((w, i) => w.child.stdin.write(`${JSON.stringify({ rep: r, barrier, ...ops[i] })}\n`));
    await Promise.all(ready);
    fs.writeFileSync(barrier, '');
    const answers = await Promise.all(done);
    fs.rmSync(barrier, { force: true });
    return answers.map(({ result, error }) => (error ? { error } : { result }));
  }

  async function stop() {
    for (const w of workers) w.child.stdin.end();
    await Promise.all(workers.map((w) => w.exited));
  }

  return { race, stop };
}

if (require.main === module && process.argv[2] === WORKER_FLAG) runWorker(process.argv[3]);

module.exports = { startWorkers };
