'use strict';

// Feature 117 A.1 (IC-001): an actor gate over real child processes. Each actor is a Node child that
// loads the real task-attempt ledger from the checkout under test and calls it with a gated fsImpl:
// before every fs call on the store file, `<store>.lock` or any path under it, or `<store>.<pid>.tmp`
// it writes `OP <seq> <method> <store|lock|tmp>` to stdout and blocks on a 1-byte read from fd 3 (the
// grant pipe; stdin stays free). It ends with `DONE <json>` or `THREW <code> <message>`. Before the
// ledger loads, the actor also patches the real `node:fs` module object and `fs.promises`: any call
// that reaches a store path other than through a gated fsImpl method (an ungated fsImpl method,
// `fsImpl.promises`, `require('node:fs')` directly, an fd from `open`) reports `UNGATED <method>`,
// so a new fs call in the implementation ends the schedule INCOMPLETE instead of slipping past the
// gate. Paths are compared after `path.resolve`, the realpath of the nearest existing ancestor dir,
// and case folding on darwin and win32. Not seen: worker threads, child processes, native addons, a
// hard link or file symlink under another name, and removal of a parent directory.
//
// Each schedule also spawns a watchdog process that SIGKILLs the actors and removes the fixture dir
// when the parent dies (its stdin pipe closes) or deadline + WATCHDOG_MARGIN_MS passes, so a child
// hung outside `waitGrant()` cannot outlive a parent that is killed. `abortAll()` does the same
// synchronously for every schedule in flight, for a caller's signal handler.
//
// The parent grants one gated call at a time and grants the next only after the granted actor has
// parked again or ended (the completion rule): the order of fs calls is then the schedule's alone,
// and one schedule always gives one outcome. Real pid, clock and module state; no virtualization.
// The model's limit: fs calls are serialized per call, so in-call overlap is outside it.
//
// Run as `node sequence-gate.js --gate-actor <json>` it is an actor; required, it is the parent.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { suiteTempDir, removeTree } = require('./tmp.ts');
const { SCENARIOS, INITS, DEFAULT_REPO, buildFixture, actorCall, ageLock } = require('./ledger-scenarios.ts');

const ACTOR_FLAG = '--gate-actor';
const GRANT_FD = 3;
const GATED_METHODS = ['existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'writeFileSync'];
const SHORT = new Map(GATED_METHODS.map((m) => [m.replace(/Sync$/, ''), m]));
const GRANT_MODES = ['park', 'release'];
const pause = (ms: any) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const WATCHDOG_MARGIN_MS = 1000;
// The originals, captured before an actor patches `node:fs`: the protocol itself is never reported.
const { writeSync, readSync, realpathSync } = fs;

// ── replay strings ──────────────────────────────────────────────────────────────────────────────

/** `'B.mkdir A.mkdir age-lock@2 B.stat'` -> `{ steps: [{ actor, method }], fault }`; throws on a bad token. */
function parseTrace(text: any) {
  const steps = [];
  let fault = null;
  for (const token of String(text).trim().split(/\s+/).filter(Boolean)) {
    const aged = /^age-lock@(\d+)$/.exec(token);
    if (aged) {
      if (fault) throw new Error(`trace: more than one fault ('${token}')`);
      if (Number(aged[1]) !== steps.length) throw new Error(`trace: '${token}' must stand before grant ${aged[1]}`);
      fault = { kind: 'age-lock', at: steps.length };
      continue;
    }
    const call = /^([AB])\.([A-Za-z]+)$/.exec(token);
    if (!call || !SHORT.has(call[2])) throw new Error(`trace: '${token}' is not <A|B>.<${[...SHORT.keys()].join('|')}> or age-lock@k`);
    steps.push({ actor: call[1], method: call[2] });
  }
  return { steps, fault };
}

/** The inverse of parseTrace. A fault past the last step is not written (it never applied). */
function formatTrace({ steps, fault = null }: any) {
  const out: any = [];
  steps.forEach((s: any, i: any) => {
    if (fault && fault.at === i) out.push(`age-lock@${i}`);
    out.push(`${s.actor}.${s.method}`);
  });
  return out.join(' ');
}

// ── actor (child) ───────────────────────────────────────────────────────────────────────────────

/** Writes one protocol line to stdout, whole, retrying a non-blocking pipe. */
function send(line: any) {
  const buf = Buffer.from(`${line}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += writeSync(1, buf, off); } catch (error: any) {
      if (error.code !== 'EAGAIN') process.exit(71);
      pause(1);
    }
  }
}

/** Blocks until the parent writes one grant byte. EOF or a pipe error means the parent is gone. */
function waitGrant() {
  const buf = Buffer.alloc(1);
  for (;;) {
    try {
      if (readSync(GRANT_FD, buf, 0, 1, null) === 1) return;
      process.exit(72);
    } catch (error: any) {
      if (error.code !== 'EAGAIN') process.exit(73);
      pause(1);
    }
  }
}

const asPath = (p: any) => {
  if (typeof p === 'string') return p;
  if (Buffer.isBuffer(p)) return p.toString();
  if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null;
  return null;
};

/**
 * `arg -> 'store' | 'lock' | 'tmp' | null` for `file`, after resolve, the realpath of the nearest
 * existing ancestor dir, and case folding. `lock` is `<store>.lock` and any path under it.
 */
function storeClassifier(file: any) {
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? (p: any) => p.toLowerCase() : (p: any) => p;
  const norm = (abs: any) => {
    let dir = path.dirname(abs);
    let rest = path.basename(abs);
    for (;;) {
      try { return fold(path.join(realpathSync(dir), rest)); } catch { /* not there (yet): one level up */ }
      const up = path.dirname(dir);
      if (up === dir) return fold(abs);
      rest = path.join(path.basename(dir), rest);
      dir = up;
    }
  };
  const store = norm(path.resolve(file));
  const base = fold(path.basename(file));
  const lock = `${store}.lock`;
  return (arg: any) => {
    const p = asPath(arg);
    if (p === null) return null;
    const abs = path.resolve(p);
    // The cheap filter before a realpath: the store's own name, or a name under a `<store>.lock` dir.
    if (!fold(path.basename(abs)).startsWith(base) && !fold(abs).includes(`${base}.lock${path.sep}`)) return null;
    const n = norm(abs);
    if (n === store) return 'store';
    if (n === lock || n.startsWith(`${lock}${path.sep}`)) return 'lock';
    return n.startsWith(`${store}.`) ? 'tmp' : null;
  };
}

/** Lower-case own function properties: the fs API, without the classes (Stats, ReadStream, ...). */
const apiNames = (obj: any) => Object.keys(obj).filter((name) => {
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d && 'value' in d && d.writable && typeof d.value === 'function' && !/^[A-Z]/.test(name);
});

/**
 * Patches `node:fs` and `fs.promises` in this (actor) process so a store path reached through any of
 * their functions reports `UNGATED <method>`, and returns the fs copy the ledger gets: the gated
 * methods park on a store path and run the original; every other function is the patched one.
 * Calls made inside an original (Node's own `fs.openSync` under `readFileSync`) are not reported.
 */
function gatedFs(file: any) {
  const classOf = storeClassifier(file);
  let depth = 0;
  const call = (fn: any, self: any, args: any) => {
    depth += 1;
    try { return fn.apply(self, args); } finally { depth -= 1; }
  };
  const report = (obj: any, prefix: any) => {
    for (const name of apiNames(obj)) {
      const original = obj[name];
      const patched: any = function (this: any, ...args: any[]) {
        if (depth === 0 && args.some(classOf)) send(`UNGATED ${prefix}${name}`);
        return call(original, this, args);
      };
      for (const key of Reflect.ownKeys(original)) { // realpathSync.native, promisify.custom, ...
        if (!['length', 'name', 'prototype'].includes(key as string)) patched[key] = (original as any)[key];
      }
      obj[name] = patched;
    }
  };
  const originals = Object.fromEntries(GATED_METHODS.map((name) => [name, fs[name]]));
  report(fs.promises, 'promises.');
  report(fs, '');
  require('node:module').syncBuiltinESMExports();

  let seq = 0;
  const gfs = { ...fs };
  for (const name of GATED_METHODS) {
    gfs[name] = (...args: any[]) => {
      if (depth === 0) {
        const cls = classOf(args[0]);
        if (cls) {
          send(`OP ${seq} ${name} ${cls}`);
          seq += 1;
          waitGrant();
        } else if (args.slice(1).some(classOf)) send(`UNGATED ${name}`);
      }
      return call(originals[name], fs, args);
    };
  }
  return gfs;
}

function runActor(config: any) {
  const { repo, fixture, op, args, actorModule } = JSON.parse(config);
  const fsImpl = gatedFs(fixture.file);
  let last;
  try {
    const response = actorModule
      ? (require(actorModule) as any)({ repo, fixture, op, args, fsImpl })
      : actorCall({ repo, fixture, op, args, fsImpl });
    last = `DONE ${JSON.stringify(response ?? null)}`;
  } catch (error: any) {
    const message = String(error?.message ?? error).replace(/\s*\n\s*/g, ' ');
    last = `THREW ${error?.code ?? 'null'} ${message}`;
  }
  send(`RSS ${process.resourceUsage().maxRSS}`);
  send(last);
  process.exit(0);
}

// ── parent ──────────────────────────────────────────────────────────────────────────────────────

/** Schedules in flight in this process: `{ dir, watchdog, children }`, for abortAll(). */
const IN_FLIGHT = new Set();

// The watchdog: argv `<dir> <ms>`, actor pids one per stdin line. It fires when stdin closes (the
// parent died, even by SIGKILL), on a signal, or after <ms>: SIGKILL the pids, remove <dir>, exit.
const WATCHDOG = `const fs = require('node:fs');
const [dir, ms] = [process.argv[1], Number(process.argv[2])];
const pids = [];
let held = '';
const fire = () => {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Windows: a killed process lets go of its cwd and open files a moment after kill() returns, and a
  // directory cannot be removed until then; so removal is retried briefly instead of attempted once.
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) break;
    nap(50);
  }
  process.exit(0);
};
process.stdin.on('data', (d) => { const lines = (held + d).split('\\n'); held = lines.pop(); for (const l of lines) pids.push(Number(l)); });
process.stdin.on('end', fire);
process.stdin.on('error', fire);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, fire);
setTimeout(fire, ms);`;

function startWatchdog(dir: any, ms: any) {
  const watchdog = spawn(process.execPath, ['-e', WATCHDOG, dir, String(ms)], {
    env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
  });
  watchdog.unref();
  watchdog.on('error', () => { /* no watchdog: the actors' own spawn reports the same failure */ });
  watchdog.stdin.on('error', () => { /* it was killed; nothing to tell it */ });
  return watchdog;
}

const alive = (child: any) => child.exitCode === null && child.signalCode === null;

/** Ends one schedule's processes and dir; the watchdog first, so it never kills a reused pid. */
function release(live: any) {
  let killed = 0;
  for (const child of [live.watchdog, ...live.children]) {
    if (alive(child)) killed += 1;
    child.kill('SIGKILL');
  }
  live.watchdog.stdin.destroy();
  const removed = fs.existsSync(live.dir) ? 1 : 0;
  removeTree(live.dir);
  IN_FLIGHT.delete(live);
  return { killed, removed };
}

/**
 * Synchronous, for a signal handler: SIGKILLs every live actor and watchdog of every schedule in
 * flight and removes their fixture dirs. Returns `{ killed, removed }`; a second call finds nothing.
 */
function abortAll() {
  let killed = 0;
  let removed = 0;
  for (const live of [...IN_FLIGHT]) {
    const r = release(live);
    killed += r.killed;
    removed += r.removed;
  }
  return { killed, removed };
}

/**
 * Runs one two-actor schedule in a fresh temp dir and resolves to the Observation (shared contract):
 * `{ scenario, init, fault, faultApplied, trace, gatedMethods, actors, final, incomplete, ms, maxRssKb }`.
 *
 * Exactly one of `chooser(parkedNames, step, view) -> name` (`view`: `{ methods: { A: 'mkdir', ... } }` for the
 * parked actors and `trace`, the tokens granted so far) or `replay` (a trace string; an age-lock token
 * in it is the fault unless `fault` is given). `deadlineMs` kills both children and ends the schedule
 * INCOMPLETE. Test-only: `grantOn: 'release'` grants the next step right after writing a grant
 * (the round-3 P2 defect, for the negative control); `actorModule` replaces the ledger call with
 * `require(actorModule)({ repo, fixture, op, args, fsImpl })`; `onFixture(fixture)` runs before spawn.
 *
 * Beyond the drive's own causes, INCOMPLETE `fault-not-applied` (a requested age-lock whose grant
 * never came or found no lock), `no-store-call` (an actor ended with no gated call) and
 * `store-unreadable` (the final store read failed other than ENOENT); the first cause found stands.
 */
async function runSchedule({
  repo = DEFAULT_REPO, scenario, init = 'none', fault, chooser, replay, deadlineMs = 5000,
  grantOn = 'park', actorModule = null, onFixture = null,
}: any) {
  if (!SCENARIOS[scenario]) throw new Error(`runSchedule: unknown scenario '${scenario}'`);
  if (!INITS.includes(init)) throw new Error(`runSchedule: unknown init '${init}'`);
  if ((typeof chooser === 'function') === (replay !== undefined)) throw new Error('runSchedule: give exactly one of chooser or replay');
  if (!GRANT_MODES.includes(grantOn)) throw new Error(`runSchedule: grantOn is one of ${GRANT_MODES.join(', ')}`);
  const plan = replay === undefined ? null : parseTrace(replay).steps;
  let applied = fault === undefined ? (replay === undefined ? null : parseTrace(replay).fault) : fault;
  if (applied !== null && !(applied?.kind === 'age-lock' && Number.isInteger(applied.at) && applied.at >= 0)) {
    throw new Error(`runSchedule: fault is null or { kind: 'age-lock', at: <k >= 0> }, got ${JSON.stringify(applied)}`);
  }
  applied = applied && { kind: 'age-lock', at: applied.at };

  const started = performance.now();
  const dir = suiteTempDir('doflow-seqgate-');
  const live = { dir, watchdog: startWatchdog(dir, deadlineMs + WATCHDOG_MARGIN_MS), children: [] };
  IN_FLIGHT.add(live);
  try {
    const fixture = buildFixture({ repo, dir, scenario, init });
    if (onFixture) onFixture(fixture);
    const run: any = await drive({ repo, scenario, fixture, fault: applied, chooser, plan, deadlineMs, grantOn, actorModule, live });
    let incomplete = run.incomplete;
    const note = (cause: any, detail: any) => { if (!incomplete) incomplete = { cause, detail }; };
    const faultApplied = applied ? run.faultApplied === true : null;
    if (applied && !faultApplied) {
      note('fault-not-applied', run.faultApplied === false
        ? `age-lock@${applied.at}: no lock to age at grant ${applied.at}`
        : `age-lock@${applied.at}: the schedule ended after ${run.grants} grants`);
    }
    for (const a of run.actors) {
      if (a.ended && a.ops === 0) note('no-store-call', `${a.name} ended ${a.outcome.kind} without a gated store call`);
    }
    let final = null;
    try { final = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).tasks?.['A.1'] ?? null; } catch (error: any) {
      if (error.code !== 'ENOENT') note('store-unreadable', `final store: ${error.message}`);
    }
    const rss = run.actors.map((a: any) => a.rss).filter(Number.isFinite);
    return {
      scenario, init, fault: applied, faultApplied, trace: run.trace, gatedMethods: [...GATED_METHODS].sort(),
      actors: run.actors.map(({ name, op, args, outcome }: any) => ({ name, op, args, outcome })),
      final, incomplete,
      ms: Math.round((performance.now() - started) * 10) / 10,
      maxRssKb: rss.length ? Math.max(...rss) : null,
    };
  } finally {
    release(live);
  }
}

/** Spawns the actors and grants calls until both have exited. Resolves `{ trace, grants, faultApplied, actors, incomplete }`. */
function drive({ repo, scenario, fixture, fault, chooser, plan, deadlineMs, grantOn, actorModule, live }: any) {
  return new Promise((resolve, reject) => {
    const actors = SCENARIOS[scenario].actors.map((a: any) => ({
      ...a, args: { ...a.args }, parked: null, reported: false, ended: false, closed: false, ops: 0, rss: null, stderr: '', outcome: { kind: 'NONE' },
    }));
    const trace: any = [];
    let grants = 0;
    let faultApplied: any = null; // null: the fault's grant never came
    let incomplete: any = null;
    let fatal: any = null;

    const stopAll = () => { for (const a of actors) a.child.kill('SIGKILL'); };
    const fail = (cause: any, detail: any) => {
      if (!incomplete) incomplete = { cause, detail };
      stopAll();
    };
    const timer = setTimeout(() => fail('schedule-deadline', `over ${deadlineMs} ms after: ${trace.join(' ')}`), deadlineMs);

    const ready = () => {
      if (!actors.every((a: any) => a.reported || a.closed)) return false;
      if (grantOn === 'release') return true;
      return actors.every((a: any) => a.parked || a.ended || a.closed);
    };

    /** The actor to grant next, or null to wait for a report. */
    const pick = () => {
      const parked = actors.filter((a: any) => a.parked);
      if (plan === null) {
        if (parked.length === 0) return null;
        const view = { methods: Object.fromEntries(parked.map((a: any) => [a.name, a.parked.method.replace(/Sync$/, '')])), trace: [...trace] };
        const name = chooser(parked.map((a: any) => a.name), grants, view);
        const chosen = parked.find((a: any) => a.name === name);
        if (!chosen) throw new Error(`chooser picked '${name}', parked: ${parked.map((a: any) => a.name).join(',')}`);
        return chosen;
      }
      if (grants >= plan.length) {
        if (parked.length) fail('replay-divergence', `trace ended with ${parked.map((a: any) => `${a.name}.${a.parked.method}`).join(', ')} parked`);
        return null;
      }
      const want = plan[grants];
      const actor = actors.find((a: any) => a.name === want.actor);
      if (actor.ended || actor.closed) {
        fail('replay-divergence', `step ${grants} wants ${want.actor}.${want.method}; ${want.actor} has ended`);
        return null;
      }
      if (!actor.parked) return null; // in flight (release mode only)
      const got = actor.parked.method.replace(/Sync$/, '');
      if (got !== want.method) {
        fail('replay-divergence', `step ${grants} wants ${want.actor}.${want.method}, ${want.actor} is parked on ${got}`);
        return null;
      }
      return actor;
    };

    const step = () => {
      try {
        while (!incomplete && ready()) {
          const actor = pick();
          if (!actor) return;
          if (fault && fault.at === grants) {
            faultApplied = ageLock(fixture.file);
            trace.push(`age-lock@${grants}`);
          }
          trace.push(`${actor.name}.${actor.parked.method.replace(/Sync$/, '')}`);
          actor.parked = null;
          grants += 1;
          actor.grant.write('g');
        }
      } catch (error: any) {
        fatal = fatal || error;
        fail('child-crash', `gate error: ${error.message}`);
      }
    };

    const onLine = (actor: any, line: any) => {
      const space = line.indexOf(' ');
      const tag = space < 0 ? line : line.slice(0, space);
      const rest = space < 0 ? '' : line.slice(space + 1);
      if (tag === 'OP') {
        const [seq, method, cls] = rest.split(' ');
        if (!GATED_METHODS.includes(method)) return;
        actor.parked = { seq: Number(seq), method, cls };
        actor.ops += 1;
      } else if (tag === 'UNGATED') {
        fail('ungated-store-call', `${actor.name} called ${rest} on a store path`);
      } else if (tag === 'RSS') {
        actor.rss = Number(rest);
        return;
      } else if (tag === 'DONE') {
        let response;
        try { response = JSON.parse(rest); } catch { return; }
        actor.outcome = { kind: 'DONE', response };
        actor.ended = true;
      } else if (tag === 'THREW') {
        const cut = rest.indexOf(' ');
        const code = cut < 0 ? rest : rest.slice(0, cut);
        actor.outcome = { kind: 'THREW', code: code === 'null' ? null : code, message: cut < 0 ? '' : rest.slice(cut + 1) };
        actor.ended = true;
      } else {
        return; // not protocol: ignored
      }
      actor.reported = true;
      step();
    };

    for (const actor of actors) {
      const config = JSON.stringify({ repo, fixture, op: actor.op, args: actor.args, actorModule });
      const child = spawn(process.execPath, [__filename, ACTOR_FLAG, config], {
        cwd: fixture.cwd,
        env: { PATH: process.env.PATH, ...fixture.env },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      live.children.push(child);
      live.watchdog.stdin.write(`${child.pid}\n`);
      actor.child = child;
      actor.grant = child.stdio[GRANT_FD];
      actor.grant.on('error', () => { /* the actor exited; its close event decides */ });
      child.stderr.on('data', (d: any) => { actor.stderr = (actor.stderr + d).slice(-2000); });
      child.on('error', (error: any) => fail('child-crash', `${actor.name} could not run: ${error.message}`));
      readline.createInterface({ input: child.stdout }).on('line', (line: any) => onLine(actor, line));
      child.on('close', (code: any, signal: any) => {
        actor.closed = true;
        actor.parked = null;
        if (!actor.ended) {
          fail('child-crash', `${actor.name} exited ${signal || code} without DONE/THREW${actor.stderr ? `: ${actor.stderr.trim().split('\n').at(-1)}` : ''}`);
        }
        if (actors.every((a: any) => a.closed)) {
          clearTimeout(timer);
          if (fatal) reject(fatal);
          else resolve({ trace: trace.join(' '), grants, faultApplied, actors, incomplete });
        } else step();
      });
    }
  });
}

if (require.main === module && process.argv[2] === ACTOR_FLAG) runActor(process.argv[3]);

module.exports = { runSchedule, abortAll, parseTrace, formatTrace, GATED_METHODS, ACTOR_FLAG, WATCHDOG_MARGIN_MS };
