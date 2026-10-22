'use strict';

// Feature 117 A.1 (IC-001): an actor gate over real child processes. Each actor is a Node child that
// loads the real task-attempt ledger from the checkout under test and calls it with a gated fsImpl:
// before every fs call on the store file, `<store>.lock` or `<store>.<pid>.tmp` it writes
// `OP <seq> <method> <store|lock|tmp>` to stdout and blocks on a 1-byte read from fd 3 (the grant
// pipe; stdin stays free). It ends with `DONE <json>` or `THREW <code> <message>`. Any other fs
// method called on a store path reports `UNGATED <method>`, so a new fs call in the implementation
// ends the schedule INCOMPLETE instead of slipping past the gate.
//
// The parent grants one gated call at a time and grants the next only after the granted actor has
// parked again or ended (the completion rule): the order of fs calls is then the schedule's alone,
// and one schedule always gives one outcome. Real pid, clock and module state; no virtualization.
// The model's limit: fs calls are serialized per call, so in-call overlap is outside it.
//
// Run as `node sequence-gate.js --gate-actor <json>` it is an actor; required, it is the parent.

const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { suiteTempDir, removeTree } = require('./tmp.js');
const { SCENARIOS, INITS, DEFAULT_REPO, buildFixture, actorCall, ageLock } = require('./ledger-scenarios.js');

const ACTOR_FLAG = '--gate-actor';
const GRANT_FD = 3;
const GATED_METHODS = ['existsSync', 'mkdirSync', 'readFileSync', 'renameSync', 'rmdirSync', 'statSync', 'writeFileSync'];
const SHORT = new Map(GATED_METHODS.map((m) => [m.replace(/Sync$/, ''), m]));
const GRANT_MODES = ['park', 'release'];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ── replay strings ──────────────────────────────────────────────────────────────────────────────

/** `'B.mkdir A.mkdir age-lock@2 B.stat'` -> `{ steps: [{ actor, method }], fault }`; throws on a bad token. */
function parseTrace(text) {
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
function formatTrace({ steps, fault = null }) {
  const out = [];
  steps.forEach((s, i) => {
    if (fault && fault.at === i) out.push(`age-lock@${i}`);
    out.push(`${s.actor}.${s.method}`);
  });
  return out.join(' ');
}

// ── actor (child) ───────────────────────────────────────────────────────────────────────────────

/** Writes one protocol line to stdout, whole, retrying a non-blocking pipe. */
function send(line) {
  const buf = Buffer.from(`${line}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off); } catch (error) {
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
      if (fs.readSync(GRANT_FD, buf, 0, 1, null) === 1) return;
      process.exit(72);
    } catch (error) {
      if (error.code !== 'EAGAIN') process.exit(73);
      pause(1);
    }
  }
}

/** The fs copy the ledger gets: gated methods park on a store path; every other function reports one. */
function gatedFs(file) {
  const asPath = (p) => {
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString();
    if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null;
    return null;
  };
  const classOf = (arg) => {
    const p = asPath(arg);
    if (p === null) return null;
    if (p === file) return 'store';
    if (p === `${file}.lock`) return 'lock';
    return p.startsWith(`${file}.`) ? 'tmp' : null;
  };
  let seq = 0;
  const gfs = {};
  for (const [name, value] of Object.entries(fs)) {
    // Constructors (Stats, ReadStream, ...) and non-functions are copied as they are.
    if (typeof value !== 'function' || /^[A-Z]/.test(name)) { gfs[name] = value; continue; }
    if (GATED_METHODS.includes(name)) {
      gfs[name] = (...args) => {
        const cls = classOf(args[0]);
        if (cls) {
          send(`OP ${seq} ${name} ${cls}`);
          seq += 1;
          waitGrant();
        } else if (args.slice(1).some(classOf)) send(`UNGATED ${name}`);
        return value.apply(fs, args);
      };
    } else {
      gfs[name] = (...args) => {
        if (args.some(classOf)) send(`UNGATED ${name}`);
        return value.apply(fs, args);
      };
    }
  }
  return gfs;
}

function runActor(config) {
  const { repo, fixture, op, args, actorModule } = JSON.parse(config);
  const fsImpl = gatedFs(fixture.file);
  let last;
  try {
    const response = actorModule
      ? require(actorModule)({ repo, fixture, op, args, fsImpl })
      : actorCall({ repo, fixture, op, args, fsImpl });
    last = `DONE ${JSON.stringify(response ?? null)}`;
  } catch (error) {
    const message = String(error?.message ?? error).replace(/\s*\n\s*/g, ' ');
    last = `THREW ${error?.code ?? 'null'} ${message}`;
  }
  send(`RSS ${process.resourceUsage().maxRSS}`);
  send(last);
  process.exit(0);
}

// ── parent ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs one two-actor schedule in a fresh temp dir and resolves to the Observation (shared contract):
 * `{ scenario, init, fault, trace, gatedMethods, actors, final, incomplete, ms, maxRssKb }`.
 *
 * Exactly one of `chooser(parkedNames, step) -> name` or `replay` (a trace string; an age-lock token
 * in it is the fault unless `fault` is given). `deadlineMs` kills both children and ends the schedule
 * INCOMPLETE. Test-only: `grantOn: 'release'` grants the next step right after writing a grant
 * (the round-3 P2 defect, for the negative control); `actorModule` replaces the ledger call with
 * `require(actorModule)({ repo, fixture, op, args, fsImpl })`; `onFixture(fixture)` runs before spawn.
 */
async function runSchedule({
  repo = DEFAULT_REPO, scenario, init = 'none', fault, chooser, replay, deadlineMs = 5000,
  grantOn = 'park', actorModule = null, onFixture = null,
}) {
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
  const children = [];
  try {
    const fixture = buildFixture({ repo, dir, scenario, init });
    if (onFixture) onFixture(fixture);
    const run = await drive({ repo, scenario, fixture, fault: applied, chooser, plan, deadlineMs, grantOn, actorModule, children });
    let final = null;
    try { final = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).tasks?.['A.1'] ?? null; } catch { /* absent or unreadable: null */ }
    const rss = run.actors.map((a) => a.rss).filter(Number.isFinite);
    return {
      scenario, init, fault: applied, trace: run.trace, gatedMethods: [...GATED_METHODS].sort(),
      actors: run.actors.map(({ name, op, args, outcome }) => ({ name, op, args, outcome })),
      final, incomplete: run.incomplete,
      ms: Math.round((performance.now() - started) * 10) / 10,
      maxRssKb: rss.length ? Math.max(...rss) : null,
    };
  } finally {
    for (const child of children) child.kill('SIGKILL');
    removeTree(dir);
  }
}

/** Spawns the actors and grants calls until both have exited. Resolves `{ trace, actors, incomplete }`. */
function drive({ repo, scenario, fixture, fault, chooser, plan, deadlineMs, grantOn, actorModule, children }) {
  return new Promise((resolve, reject) => {
    const actors = SCENARIOS[scenario].actors.map((a) => ({
      ...a, args: { ...a.args }, parked: null, reported: false, ended: false, closed: false, rss: null, stderr: '', outcome: { kind: 'NONE' },
    }));
    const trace = [];
    let grants = 0;
    let incomplete = null;
    let fatal = null;

    const stopAll = () => { for (const a of actors) a.child.kill('SIGKILL'); };
    const fail = (cause, detail) => {
      if (!incomplete) incomplete = { cause, detail };
      stopAll();
    };
    const timer = setTimeout(() => fail('schedule-deadline', `over ${deadlineMs} ms after: ${trace.join(' ')}`), deadlineMs);

    const ready = () => {
      if (!actors.every((a) => a.reported || a.closed)) return false;
      if (grantOn === 'release') return true;
      return actors.every((a) => a.parked || a.ended || a.closed);
    };

    /** The actor to grant next, or null to wait for a report. */
    const pick = () => {
      const parked = actors.filter((a) => a.parked);
      if (plan === null) {
        if (parked.length === 0) return null;
        const name = chooser(parked.map((a) => a.name), grants);
        const chosen = parked.find((a) => a.name === name);
        if (!chosen) throw new Error(`chooser picked '${name}', parked: ${parked.map((a) => a.name).join(',')}`);
        return chosen;
      }
      if (grants >= plan.length) {
        if (parked.length) fail('replay-divergence', `trace ended with ${parked.map((a) => `${a.name}.${a.parked.method}`).join(', ')} parked`);
        return null;
      }
      const want = plan[grants];
      const actor = actors.find((a) => a.name === want.actor);
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
            ageLock(fixture.file);
            trace.push(`age-lock@${grants}`);
          }
          trace.push(`${actor.name}.${actor.parked.method.replace(/Sync$/, '')}`);
          actor.parked = null;
          grants += 1;
          actor.grant.write('g');
        }
      } catch (error) {
        fatal = fatal || error;
        fail('child-crash', `gate error: ${error.message}`);
      }
    };

    const onLine = (actor, line) => {
      const space = line.indexOf(' ');
      const tag = space < 0 ? line : line.slice(0, space);
      const rest = space < 0 ? '' : line.slice(space + 1);
      if (tag === 'OP') {
        const [seq, method, cls] = rest.split(' ');
        if (!GATED_METHODS.includes(method)) return;
        actor.parked = { seq: Number(seq), method, cls };
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
      children.push(child);
      actor.child = child;
      actor.grant = child.stdio[GRANT_FD];
      actor.grant.on('error', () => { /* the actor exited; its close event decides */ });
      child.stderr.on('data', (d) => { actor.stderr = (actor.stderr + d).slice(-2000); });
      child.on('error', (error) => fail('child-crash', `${actor.name} could not run: ${error.message}`));
      readline.createInterface({ input: child.stdout }).on('line', (line) => onLine(actor, line));
      child.on('close', (code, signal) => {
        actor.closed = true;
        actor.parked = null;
        if (!actor.ended) {
          fail('child-crash', `${actor.name} exited ${signal || code} without DONE/THREW${actor.stderr ? `: ${actor.stderr.trim().split('\n').at(-1)}` : ''}`);
        }
        if (actors.every((a) => a.closed)) {
          clearTimeout(timer);
          if (fatal) reject(fatal);
          else resolve({ trace: trace.join(' '), actors, incomplete });
        } else step();
      });
    }
  });
}

if (require.main === module && process.argv[2] === ACTOR_FLAG) runActor(process.argv[3]);

module.exports = { runSchedule, parseTrace, formatTrace, GATED_METHODS, ACTOR_FLAG };
