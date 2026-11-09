#!/usr/bin/env node
'use strict';

// A fake core for console/test/verb-runner.test.ts. It appends one JSON line {argv, env, cwd} to
// FAKE_CORE_LOG on every start (after any signal handler is installed, so a test that sees the line
// can signal it), then behaves as FAKE_CORE_MODE says. Neither variable starts with DOFLOW_, so the
// runner's environment stripping lets them through. Modes `worker-reads` and `old-core` (feature 150
// IC-010) answer the four worker chain shapes; see workerReads and oldCore below. Modes `manage`, `data-exit1`,
// `exit1-text`, `slow-doctor`, `usage-json` and `old-manage` (feature 151 IC-005) answer the ten management shapes,
// with bodies that pass their projectors (151 B.5); see manage and manageBody below.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.env.FAKE_CORE_MODE || 'echo';
const CAP = 4 * 1024 * 1024;

if (mode === 'ignore-term') process.on('SIGTERM', () => {});
// The events follow script exits 0 on SIGTERM, as the real verb does (149 IC-001).
if (mode === 'events' && (process.env.FAKE_EVENTS_SCRIPT || 'follow') === 'follow') process.on('SIGTERM', () => process.exit(0));
if (process.env.FAKE_CORE_LOG) {
  fs.appendFileSync(process.env.FAKE_CORE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() })}\n`);
}

const echo = () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));

switch (mode) {
  case 'echo':
    if (process.argv[2] === '--version') process.stdout.write('9.9.9-fake\n');
    else echo();
    break;
  case 'delay': // echo after FAKE_CORE_DELAY_MS of real time
    setTimeout(echo, Number(process.env.FAKE_CORE_DELAY_MS || 200));
    break;
  case 'sleep':
  case 'ignore-term':
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(9), 60_000); // safety net if a test never kills it
    break;
  case 'big': // one byte over the cap
    process.stdout.write(`"${'a'.repeat(CAP - 1)}"`);
    break;
  case 'at-cap': // a JSON string of exactly the cap
    process.stdout.write(`"${'a'.repeat(CAP - 2)}"`);
    break;
  case 'error':
    process.stderr.write('[ERROR] secret-stderr-text\n');
    process.exitCode = 1;
    break;
  case 'exit1':
    process.stderr.write('plain failure secret-stderr-text\n');
    process.exitCode = 1;
    break;
  case 'exit2':
    process.exitCode = 2;
    break;
  case 'text':
    process.stdout.write('not json\n');
    break;
  case 'empty':
    break;
  case 'events':
    events(process.env.FAKE_EVENTS_SCRIPT || 'follow');
    break;
  case 'worker-reads':
    workerReads(process.argv.slice(2));
    break;
  case 'old-core':
    oldCore(process.argv.slice(2));
    break;
  case 'manage':
  case 'data-exit1':
  case 'exit1-text':
  case 'slow-doctor':
  case 'usage-json':
  case 'old-manage':
    manage(mode, process.argv.slice(2));
    break;
  default:
    process.stderr.write(`fake-core: unknown mode ${mode}\n`);
    process.exitCode = 9;
}

/**
 * Mode `events`: a stand-in for `doflow events --follow --control stdin --json` (149 IC-001, IC-005).
 * FAKE_EVENTS_SCRIPT picks the behaviour:
 *   follow (default)  IC-005 lines on stdin: `sub` emits a snapshot of that channel, `unsub` stops it, an
 *                     invalid line writes one stderr line and exits 2, stdin EOF or SIGTERM exits 0. With
 *                     FAKE_EVENTS_TICK_MS set, every followed channel gets a patch at that interval.
 *   frames            FAKE_EVENTS_COUNT (default 2) frames on `now`, a snapshot then patches, then exit
 *                     FAKE_EVENTS_EXIT (default 0).
 *   fault             FAKE_EVENTS_COUNT (default 0) frames, then one `[ERROR]` stderr line and exit 1.
 *   usage             a usage error of the verb on stderr, exit 2, no stdout.
 *   over-cap          262145 bytes of stdout with no newline, then stays alive until killed.
 *   old-flag          an old core: `doflow: unknown flag '--follow'` on stderr, exit 1.
 *   old-command       an old core: `doflow: unknown command 'events'` on stderr, exit 1.
 *   old-verb          the projected dispatcher: `unknown verb 'events'` on stderr, exit 2.
 * FAKE_EVENTS_SECTIONS (a JSON object) is the `sections` of every frame; default `{}`.
 */
function events(script) {
  const EPOCH = '0fa4ec0d';
  const sections = process.env.FAKE_EVENTS_SECTIONS ? JSON.parse(process.env.FAKE_EVENTS_SECTIONS) : {};
  const counters = new Map();
  const frame = (ch, type) => {
    const n = (counters.get(ch) || 0) + 1;
    counters.set(ch, n);
    process.stdout.write(`${JSON.stringify({ v: 1, ch, id: `${EPOCH}-${n}`, type, at: new Date().toISOString(), data: { sections } })}\n`);
  };
  const frames = (count) => {
    for (let i = 0; i < count; i++) frame('now', i === 0 ? 'snapshot' : 'patch');
  };
  const count = (fallback) => (process.env.FAKE_EVENTS_COUNT === undefined ? fallback : Number(process.env.FAKE_EVENTS_COUNT));
  const stayAlive = () => {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(9), 60_000).unref(); // safety net if a test never kills it
  };
  switch (script) {
    case 'follow': {
      setTimeout(() => process.exit(9), 60_000).unref();
      const followed = new Set();
      const tick = Number(process.env.FAKE_EVENTS_TICK_MS || 0);
      if (tick > 0) setInterval(() => followed.forEach((ch) => frame(ch, 'patch')), tick).unref();
      let buffered = '';
      let refused = false;
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (text) => {
        if (refused) return;
        const parts = (buffered + text).split('\n');
        buffered = parts.pop();
        for (const line of parts) {
          let message = null;
          try {
            message = JSON.parse(line);
          } catch {}
          const valid = message && typeof message === 'object' && Object.keys(message).sort().join(',') === 'ch,op' && typeof message.ch === 'string' && (message.op === 'sub' || message.op === 'unsub');
          if (!valid) {
            // Exit by draining, not process.exit, so frames already written still reach a pipe.
            refused = true;
            followed.clear();
            process.stderr.write('doflow events: invalid control line\n');
            process.exitCode = 2;
            process.stdin.destroy();
            return;
          }
          if (message.op === 'sub') {
            followed.add(message.ch);
            frame(message.ch, 'snapshot');
          } else {
            followed.delete(message.ch);
          }
        }
      });
      process.stdin.on('end', () => {
        followed.clear();
        process.exitCode = 0;
      });
      break;
    }
    case 'frames':
      frames(count(2));
      process.exitCode = Number(process.env.FAKE_EVENTS_EXIT || 0);
      break;
    case 'fault':
      frames(count(0));
      process.stderr.write('[ERROR] events: producer failed secret-stderr-text\n');
      process.exitCode = 1;
      break;
    case 'usage':
      process.stderr.write("doflow events: --control accepts only 'stdin'\n");
      process.exitCode = 2;
      break;
    case 'over-cap':
      process.stdout.write('a'.repeat(262_145));
      stayAlive();
      break;
    case 'old-flag':
      process.stderr.write("doflow: unknown flag '--follow'\n");
      process.exitCode = 1;
      break;
    case 'old-command':
      process.stderr.write("doflow: unknown command 'events'\n");
      process.exitCode = 1;
      break;
    case 'old-verb':
      process.stderr.write("unknown verb 'events'\n");
      process.exitCode = 2;
      break;
    default:
      process.stderr.write(`fake-core: unknown events script ${script}\n`);
      process.exitCode = 9;
  }
}

/** The value of `--<name>` in argv, or null. */
function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
}

/**
 * Mode `worker-reads`: the four 150 IC-010 shapes over one ended feature with two runs, the top-level
 * WORKER_RUN and its child CHILD_RUN. Bodies are compact JSON, as the core prints them:
 *   worker-runs --slug <s>                 IC-004: both runs, `slug` echoed.
 *   worker-result --worker-run <id>        IC-003: exactly the result keys.
 *   worker --action status --worker-run    the core's status view, with `process` and `deadline`; its
 *                                          `process` and the top level carry the planted PLANTED_PID
 *                                          and PLANTED_PGID, which no Console body may show (FR-016).
 *   worker-log --worker-run <id> --stream  IC-002: the out log is `compiling`, then one 32768-grid cut
 *                                          line (a `cut: true` piece ending at 32768), then its end; the
 *                                          err log is one line. No cursor is tail, `--cursor` forward,
 *                                          `--before` backward; a cursor on another inode is a reset.
 * A run id other than the two is `{"v":1,"ok":false,"error":"unknown-run"}` with exit 1 (status: `run: null`,
 * exit 0, as the core answers). Any other argv echoes, as mode `echo`.
 */
function workerReads(argv) {
  const WORKER_RUN = 'w-1a2b3c4d5e6f';
  const CHILD_RUN = 'w-0f0e0d0c0b0a';
  const PLANTED_PID = 424242;
  const PLANTED_PGID = 424243;
  const INO = '8812345';
  const MS = 1762581600000;
  const runs = {
    [WORKER_RUN]: { runId: WORKER_RUN, task: 'A.1', token: 1, harness: 'codex', childOf: null, createdAt: '2026-11-08T05:00:00.000Z', startedAt: '2026-11-08T05:00:01.000Z', endedAt: '2026-11-08T05:03:00.000Z' },
    [CHILD_RUN]: { runId: CHILD_RUN, task: 'A.1', token: 1, harness: 'claude', childOf: WORKER_RUN, createdAt: '2026-11-08T05:01:00.000Z', startedAt: '2026-11-08T05:01:01.000Z', endedAt: '2026-11-08T05:02:00.000Z' },
  };
  const print = (body, exit = 0) => {
    process.stdout.write(JSON.stringify(body));
    process.exitCode = exit;
  };
  const runId = flagValue(argv, '--worker-run');
  const run = runId !== null && Object.hasOwn(runs, runId) ? runs[runId] : null;
  const unknownRun = () => print({ v: 1, ok: false, error: 'unknown-run' }, 1);

  if (argv[0] === 'worker-runs') {
    return print({
      v: 1,
      slug: flagValue(argv, '--slug'),
      store: 'present',
      runs: Object.values(runs).map((r) => ({ runId: r.runId, task: r.task, token: r.token, harness: r.harness, childOf: r.childOf, phase: 'ended', endState: 'exited', createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt, edit: false })),
      limits: { shown: 2, notShown: 0 },
    });
  }
  if (argv[0] === 'worker-result') {
    if (!run) return unknownRun();
    return print({
      v: 1, runId: run.runId, task: run.task, token: run.token, harness: run.harness, phase: 'ended', endState: 'exited', endedAt: run.endedAt,
      reportStatus: 'success', readOnly: 'clean', isolation: null, resultOffered: true, withheld: [], quota: null,
    });
  }
  if (argv[0] === 'worker' && argv[2] === 'status' && runId !== null) {
    if (!run) return print({ disposition: 'status', run: null, task: null, token: null });
    return print({
      disposition: 'status', runId: run.runId, task: run.task, token: run.token, harness: run.harness, identity: null,
      state: 'exited', reason: null, startedAt: run.startedAt, endedAt: run.endedAt, deadline: '2026-11-08T05:30:01.000Z',
      process: { kind: 'exited', code: 0, signal: null, at: run.endedAt, pid: PLANTED_PID, pgid: PLANTED_PGID },
      pid: PLANTED_PID, pgid: PLANTED_PGID,
      report: { status: 'success' }, readOnly: { status: 'clean' }, edit: null, isolation: null, childOf: run.childOf, request: null,
      verified: null, attemptActive: true, resultOffered: true, withheld: [],
      cleanup: null, supervisorCleanup: null, attemptCancel: null, output: null, launchObserved: null,
    });
  }
  if (argv[0] === 'worker-log') {
    if (!run) return unknownRun();
    const stream = flagValue(argv, '--stream');
    const lines = stream === 'out'
      ? [{ at: 0, text: 'compiling' }, { at: 10, text: 'a'.repeat(32_758), cut: true }, { at: 32_768, text: 'end of the long line' }]
      : [{ at: 0, text: 'warning: retrying' }];
    const end = (piece) => piece.at + Buffer.byteLength(piece.text) + (piece.cut ? 0 : 1);
    const size = end(lines[lines.length - 1]);
    const position = flagValue(argv, '--cursor') ?? flagValue(argv, '--before');
    const [ino, offset] = position === null ? [INO, null] : position.split(':');
    const reset = position !== null && ino !== INO;
    const backward = !reset && flagValue(argv, '--before') !== null;
    let pieces;
    let from;
    let to;
    if (position === null || reset) {
      [pieces, from, to] = [lines, 0, size];
    } else if (backward) {
      pieces = lines.filter((piece) => end(piece) <= Number(offset));
      [from, to] = [0, pieces.length ? end(pieces[pieces.length - 1]) : 0];
    } else {
      pieces = lines.filter((piece) => piece.at >= Number(offset));
      [from, to] = [Number(offset), pieces.length ? end(pieces[pieces.length - 1]) : Number(offset)];
    }
    return print({
      v: 1, runId: run.runId, stream, phase: 'ended', log: 'open', ino: INO, size, from, to, pieces, eof: to === size, reset, capped: false,
      cursor: `${INO}:${to}:0:${MS}`, before: from === 0 ? null : `${INO}:${from}:0:${MS}`,
    });
  }
  return echo();
}

/**
 * Mode `old-core`: a core older than 150. Each new verb (`worker-runs`, `worker-result`, `worker-log`) is
 * `doflow: unknown command '<verb>'` on stderr with exit 1, as today's core answers an unknown verb;
 * `worker --action status --worker-run` is `doflow: unknown flag '--worker-run'` with exit 2 (RK2). No
 * stdout. Any other argv echoes, as mode `echo`.
 */
function oldCore(argv) {
  if (['worker-runs', 'worker-result', 'worker-log'].includes(argv[0])) {
    process.stderr.write(`doflow: unknown command '${argv[0]}'\n`);
    process.exitCode = 1;
  } else if (argv[0] === 'worker' && argv.includes('--worker-run')) {
    process.stderr.write("doflow: unknown flag '--worker-run'\n");
    process.exitCode = 2;
  } else {
    echo();
  }
}

/** The IC-005 shape id an argv is, or null: the ten 151 argv shapes by the prefix the Console runs, `followup-record` before `followups`. */
function manageShapeOf(argv) {
  const shapes = [
    ['config-list', ['config', 'list']],
    ['config-schema', ['config', 'schema']],
    ['advise-report', ['advise', '--action', 'report']],
    ['advice-picks', ['advice-picks']],
    ['followup-record', ['followup', '--action', 'list', '--view', 'full']],
    ['followups', ['followup', '--action', 'list', '--state']],
    ['lifecycle-overview', ['lifecycle', '--action', 'overview']],
    ['doctor', ['doctor']],
    ['storage-report', ['storage', '--action', 'report']],
    ['worker-matrix', ['worker-matrix']],
  ];
  const found = shapes.find(([, prefix]) => prefix.every((part, i) => argv[i] === part));
  return found ? found[0] : null;
}

/** Every UTC date from `from` to `to`, oldest first. */
function datesOf(from, to) {
  const out = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/** The kind ids `advice-picks --kind` accepts: the shipped advice registry's, then `adhoc` (src/runtime/advice/picks.ts:153). */
function adviceKinds() {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'core', 'registry', 'advice.json'), 'utf8'));
  return [...registry.kinds.map((entry) => entry.id), 'adhoc'];
}

/**
 * The core's own body for each management shape, in the fields its projector (console/src/project.ts, 151
 * IC-007 to IC-011) reads, plus fields it must drop. Paths and free text name the project root (the cwd), the
 * home folder (FAKE_HOME, else os.homedir()) and the config home under it, so a route test can check that no
 * anchor value reaches a body. `exit1` gives doctor a finding, as a doctor exiting 1 has.
 */
function manageBody(shape, argv, exit1) {
  // The follow-up records: `followup-record` answers FU_KNOWN; any other id has no record.
  const FU_KNOWN = 'FU-0a1b2c';
  const FU_OTHER = 'FU-0a1b2d';
  const FU_NEXT = '1762581600000:20261108T050000000Z-0a1b2c';
  const root = process.cwd();
  const home = process.env.FAKE_HOME || os.homedir();
  const cfg = `${home}/.config/doflow`;
  const layers = `${root}/.doflow`;
  const meta = (over = {}) => ({ type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on', scope: 'project-overridable', combine: 'override',
    securityRelevant: false, env: { name: 'DOFLOW_FAKE', parse: 'off-words', direction: 'narrow' }, flag: '--fake', shellRead: 'fake', views: ['project'],
    needsConfigHome: false, description: `Read from ${cfg}/settings.json`, ...over });
  const candidate = (over = {}) => ({ layer: 'user', source: `${cfg}/settings.json`, legacy: false, checkout: null, display: '"on"', value: 'on',
    status: 'decided', reason: null, code: null, ...over });
  const resolution = (key, over = {}) => ({ key, view: 'project', value: 'on', state: 'ok', explicit: true,
    origin: { layer: 'user', source: `${cfg}/settings.json`, legacy: false, checkout: null, via: null }, candidates: [candidate()], meta: meta(), ...over });
  const builtIn = (key, value, metaOver = {}) => resolution(key, { value, explicit: false, origin: { layer: 'default', source: null, legacy: false, checkout: null, via: null },
    candidates: [], meta: meta({ ...metaOver, default: value }) });
  switch (shape) {
    case 'config-list':
      return {
        schema: 1, scope: 'project',
        configHome: { dir: cfg, ignored: [] },
        project: { root, layersFrom: layers, checkout: 'main' },
        files: [
          { layer: 'user', path: `${cfg}/settings.json`, kind: 'settings', legacyKind: null, checkout: null, status: 'ok', code: null, offset: null },
          { layer: 'project', path: `${layers}/settings.json`, kind: 'settings', legacyKind: null, checkout: 'main', status: 'ok', code: null, offset: null },
          { layer: 'local', path: `${root}/.doflow/settings.local.json`, kind: 'settings', legacyKind: null, checkout: 'main', status: 'invalid', code: 'unparseable', offset: 3 },
        ],
        keys: {
          'advice.enabled': resolution('advice.enabled', { value: false, origin: { layer: 'default', source: null, legacy: false, checkout: null, via: 'cross-key' },
            candidates: [candidate({ display: 'true', value: true, status: 'invalid', reason: `advice.model is not set in ${cfg}/settings.json`, code: 'cross-key' })],
            meta: meta({ type: 'boolean', values: null, order: [false, true], default: false, scope: 'narrow-only', securityRelevant: true, env: null }) }),
          'advice.model': builtIn('advice.model', null, { type: 'string', values: null, securityRelevant: true, env: null }),
          'advice.kinds.task-class': resolution('advice.kinds.task-class', { value: 'shadow', origin: { layer: 'project', source: `${layers}/settings.json`, legacy: false, checkout: 'main', via: null },
            candidates: [candidate({ layer: 'project', source: `${layers}/settings.json`, checkout: 'main', display: '"shadow"' })],
            meta: meta({ values: ['off', 'shadow', 'act'], securityRelevant: true }) }),
          'dispatch.fallback': builtIn('dispatch.fallback', 'sequential', { values: ['manual', 'sequential'] }),
          'workers.enabled': resolution('workers.enabled', { value: ['codex', 'primary'], meta: meta({ type: 'worker-list', values: null, default: [], securityRelevant: true }) }),
          'team.writerCap': builtIn('team.writerCap', 2, { type: 'integer', values: null }),
          'review.rounds': builtIn('review.rounds', 2, { type: 'integer', values: null }),
          'storage.prune': {
            project: resolution('storage.prune', { view: 'project' }),
            global: resolution('storage.prune', { view: 'global', origin: { layer: 'default', source: null, legacy: false, checkout: null, via: null }, candidates: [] }),
          },
        },
        errors: [
          { key: 'advice.enabled', layer: 'user', source: `${cfg}/settings.json`, legacy: false, code: 'cross-key', reason: `advice.enabled needs advice.model (${cfg}/settings.json)`, offset: null },
          { key: null, layer: 'local', source: `${root}/.doflow/settings.local.json`, legacy: false, code: 'unparseable', reason: `cannot parse ${root}/.doflow/settings.local.json`, offset: 3 },
          { key: 'review.rounds', layer: 'project', source: `${layers}/settings.json`, legacy: false, code: 'schema', reason: 'review.rounds must be 1 to 3', offset: null },
        ],
        notes: [
          { code: 'unknown-key', key: 'not.a-setting', source: `${cfg}/settings.json`, text: '"not.a-setting" is not a DoFlow setting (ignored)' },
          { code: 'scope', key: 'advice.kinds.task-class', source: `${layers}/settings.json`, text: `narrowed in ${layers}/settings.json` },
          { code: 'scope', key: 'workers.enabled', source: `${cfg}/settings.json`, text: 'workers.enabled is global-only' },
          { code: 'legacy', field: 'enabled', source: null, text: `legacy file under ${home}` },
        ],
      };
    case 'config-schema':
      return {
        schema: 1,
        keys: [
          { key: 'review.rounds', type: 'integer', values: null, order: null, tiers: null, min: 1, max: 3, maxItems: null, maxLength: null, default: 2, writable: true, locked: false },
          { key: 'workers.models', type: 'worker-list', values: null, order: null, tiers: ['light', 'standard', 'frontier'], min: null, max: null, maxItems: 4, maxLength: null, default: [], writable: false, locked: false },
        ],
        invariants: [{ id: 'INV-1', key: 'invariant.INV-1', locked: true, writable: false, statement: 'advice.enabled requires advice.model', enforcedBy: 'config set' }],
        presets: [{ id: 'deep', kind: 'review', summary: `3 seats ${cfg}` }],
      };
    case 'advise-report':
      return {
        schema: 1, scope: 'this project only',
        window: { from: '2026-08-11', to: '2026-11-09', maxAgeDays: 90 },
        unreadable: 0,
        kinds: {
          tier: { n: { picks: 2, misses: 1 }, missesByReason: { timeout: 1 }, agreeStatic: { n: 2, agree: 1 }, agreeOutcome: null, elevated: 0,
            modes: { shadow: 2, act: 0, unrecorded: 0 }, durationMs: { n: 2, p50: 10, p90: 12, p95: 12 }, missDurationMs: null },
        },
        verdicts: [{ kind: 'tier', model: 'qwen3:8b', arm: null, result: 'pass', stale: false, reason: `checked against ${root}/bench` }],
      };
    case 'advice-picks': {
      const kind = flagValue(argv, '--kind');
      const from = '2026-08-11';
      const to = '2026-11-09';
      const days = datesOf(from, to).map((day) => ({ day, coverage: 'read', unreadableLines: 0, picks: {} }));
      const picks = kind === null || kind === 'task-class'
        ? [{ pickId: 'adv-1762581600000-0a1b2c', kind: 'task-class', at: '2026-11-08T05:00:00.000Z', mode: 'shadow', pick: 'feature', static: 'bug', agree: false,
          outcome: { actual: 'feature', at: '2026-11-08T06:00:00.000Z', agree: true } }]
        : [];
      if (picks.length) days[89].picks = { 'task-class': 1 };
      return { v: 1, window: { from, to, maxAgeDays: 90 }, kind, kinds: kind === null ? adviceKinds() : [kind], stores: { 'project-state': 'read', 'user-state': 'absent' },
        days, picks, limits: { shown: picks.length, notShown: 0, skipped: 0 } };
    }
    case 'followups':
      return {
        view: 'brief', ok: true, action: 'list', state: flagValue(argv, '--state'), count: 2, shown: 2, nextCursor: FU_NEXT,
        items: [
          { id: FU_KNOWN, statement: `Fix the loader in ${root}/src/a.ts`, state: 'open' },
          { id: FU_OTHER, statement: `Notes in ${home}/notes.md`, state: 'open' },
        ],
        conflicts: [], unreadable: [], unreadableReasons: {},
        next: [`Next page: doflow-run followup --action list --cursor ${FU_NEXT}`],
      };
    case 'followup-record': {
      const known = flagValue(argv, '--ids') === FU_KNOWN;
      return {
        ok: true, action: 'list', state: 'all', count: known ? 1 : 0, conflicts: [], unreadable: [], unreadableReasons: {}, next: [],
        items: known ? [{
          id: FU_KNOWN, statement: `Fix the loader in ${root}/src/a.ts`, source: { kind: 'report', feature: '151-console-v2-manage' }, state: 'open', takenBy: null,
          intent: `${root}/agent-docs/intent/loader.md`, fix: null, added: '2026-11-08', excerpt: `seen in ${home}/notes.md`, body: 'on-this-machine',
          bodyRef: `local:${home}`, history: [{ event: '20261108T050000000Z-0a1b2c', type: 'followup.added', at: '2026-11-08T05:00:00.000Z', by: 'agent' }],
        }] : [],
      };
    }
    case 'lifecycle-overview':
      return {
        ok: true, mode: 'maintain', releaseMode: 'tagged', integrationRef: 'develop', gitError: null,
        followups: { open: 2, shown: 0, items: [] },
        intents: [{ path: `${root}/agent-docs/intent/loader.md`, items: [FU_KNOWN] }],
        goals: [{ goal: 'G-1', outcome: `Loader fixed in ${root}`, items: { met: 1, total: 1 }, proposeDone: true,
          features: { finished: ['150-console-v2-chain'], awaitingRelease: [], inProgress: [], unknown: [] }, nudges: [] }],
        features: { finished: ['150-console-v2-chain'], awaitingRelease: ['151-console-v2-manage'], inProgress: [], unknown: [] },
        featuresShown: { finished: { count: 1, shown: ['150-console-v2-chain'] }, awaitingRelease: { count: 1, shown: ['151-console-v2-manage'] } },
        conflicts: [], unreadable: [], next: ['doflow-run lifecycle --action init --take FU-0a1b2c'],
      };
    case 'doctor':
      return {
        identity: { source: { root: `${home}/doflow` }, project: { root } },
        summary: { probed: 1, healthy: 1, unhealthy: 0, absent: 0, unverified: 0 },
        findings: exit1 ? [{ kind: 'runtime-no-reach', subject: `claude:project ${root}/.doflow`, detail: `no runtime at ${home}/.doflow` }] : [],
        warnings: [{ kind: 'claude-permissions-user-array', subject: `${home}/.claude/settings.json: permissions.allow`, detail: 'the user array is ignored' }],
        harnesses: [{ id: 'claude', displayName: 'Claude Code', status: 'PASS', reach: [{ scope: 'global', installRoot: home }] }],
        externalTools: [{ id: 'rtk', displayName: 'RTK', status: 'HEALTHY', detail: `rtk 1.1.0 ${home}/bin/rtk` }],
        capabilities: [{ capability: 'code.exact-search', status: 'HEALTHY', activeProvider: 'native.rg', providers: [] }],
        providers: [{ id: 'native.rg', status: 'HEALTHY', present: true, answered: true, durationMs: 3, version: 'ripgrep 15.2.0', binary: `${home}/bin/rg`, probeCommand: 'rg --version' }],
        freshness: [],
        workers: { state: 'set', rows: [{ harness: 'codex', enabled: { state: 'enabled', position: 1, origin: { layer: 'user', source: `${cfg}/settings.json` } }, eligible: true, firstGap: null }] },
        workerPool: { state: 'unsynced', syncedAt: null, harnesses: [{ harness: 'codex', binary: `${home}/bin/codex`, installed: true, loginState: 'logged-in', detectedMode: 'subscription',
          effectiveBilling: { value: 'free', source: 'user-record', asserted: '2026-10-23' } }] },
      };
    case 'storage-report':
      return {
        setting: { project: 'on', user: 'off', decidedBy: { project: null, user: `${cfg}/settings.json` } }, mode: 'report', partial: false, durationMs: 12.5,
        stores: [
          { id: 'verification-runs', root: `${root}/.doflow/state`, location: `${root}/.doflow/state/verification/runs`, bound: 'prune finished work after 30 days', setting: 'on',
            entries: 3, bytes: 2048, selected: [{ name: 'a', reason: 'settled', bytes: 10 }], removed: 0, protected: 1, failed: [] },
          { id: 'user-traces', root: `${home}/.doflow`, location: `${home}/.doflow/traces`, bound: `kept under ${home}/.doflow`, setting: 'off',
            entries: 0, bytes: 0, selected: [], removed: 0, protected: 0, failed: [] },
        ],
      };
    case 'worker-matrix': {
      const cell = (over = {}) => ({ status: 'supported', declared: true, evidence: [`bench/inventory/coverage.json → claude --version, run from ${home}`],
        verification: 'Run `claude --version`.', verifiedOn: '2026-10-12', reason: null, fallback: null, cut: false, ...over });
      return {
        v: 1, registryVersion: 1,
        groups: { worker: ['cli', 'oneShot'], orchestration: ['spawn'] },
        harnesses: [{ id: 'claude', billing: 'unknown', profile: null, binary: 'claude',
          cells: { worker: { cli: cell(), oneShot: cell({ status: 'unknown', evidence: [] }) }, orchestration: { spawn: cell({ fallback: 'manual' }) } } }],
        counts: { worker: { supported: 1, unknown: 1, unsupported: 0 }, orchestration: { supported: 1, unknown: 0, unsupported: 0 } },
        limits: { shown: 1, notShown: 0, cellsNotShown: 0, cut: 0 },
      };
    }
    default:
      return {};
  }
}

/** A comma list of shape ids from an environment variable. */
function shapesIn(name) {
  return (process.env[name] || '').split(',').filter(Boolean);
}

/**
 * The 151 IC-005 modes over the ten management argv shapes. `--version` prints `9.9.9-fake`; any other argv
 * echoes, as mode `echo`. A shape answers `{v: 1, verb: <shape id>, argv}` plus the core's own body for that
 * shape (manageBody), which passes its projector.
 *   manage       exit 0. `advice-picks --kind <k>` with a kind the advice registry lacks (and not `adhoc`) is the
 *                core's JSON usage body with exit 2, as the verb answers (IC-001). Two comma lists of shape ids:
 *                FAKE_MANAGE_EXIT1 answers those with the body on exit 1 and `[ERROR] secret-stderr-text` on
 *                stderr (data, DEC-024); FAKE_MANAGE_FAIL answers those with `[ERROR] secret-stderr-text` and
 *                exit 3, no stdout (a failed read).
 *   data-exit1   exit 1 with exactly `{v: 1, verb, argv}` and `[ERROR] secret-stderr-text` on stderr (a `config
 *                list` fail-safe key, a `doctor` with findings: data, DEC-024). Any other argv too, so a case can compare.
 *   exit1-text   exit 1 with `not json` on stdout and `[ERROR] secret-stderr-text` on stderr, for every argv.
 *   slow-doctor  `doctor` answers after FAKE_CORE_DELAY_MS (default 300) of real time; the others as manage.
 *   usage-json   `{"v":1,"ok":false,"error":"usage"}` with exit 2 for every argv (DEC-041).
 *   old-manage   the two older-core answers of D6: `advise --action report` is the JSON usage body with exit 2
 *                (cores v2.0.0-beta.7 to v2.3.0), `advice-picks` and `worker-matrix` are
 *                `doflow: unknown command '<verb>'` on stderr with exit 1 and no stdout; the others as manage.
 */
function manage(mode, argv) {
  if (argv[0] === '--version') return process.stdout.write('9.9.9-fake\n');
  const shape = manageShapeOf(argv);
  const fail = (exit) => {
    process.stderr.write('[ERROR] secret-stderr-text\n');
    process.exitCode = exit;
  };
  const body = () => {
    if (shapesIn('FAKE_MANAGE_FAIL').includes(shape)) return fail(3);
    const kind = shape === 'advice-picks' ? flagValue(argv, '--kind') : null;
    if (kind !== null && !adviceKinds().includes(kind)) {
      process.stdout.write('{"v":1,"ok":false,"error":"usage"}');
      process.stderr.write(`doflow advice-picks: unknown --kind '${kind}'\n`);
      process.exitCode = 2;
      return;
    }
    const exit1 = shapesIn('FAKE_MANAGE_EXIT1').includes(shape);
    process.stdout.write(JSON.stringify({ v: 1, verb: shape, argv, ...manageBody(shape, argv, exit1) }));
    if (exit1) fail(1);
  };
  switch (mode) {
    case 'data-exit1':
      process.stdout.write(JSON.stringify(shape === null ? { argv } : { v: 1, verb: shape, argv }));
      return fail(1);
    case 'exit1-text':
      process.stdout.write('not json\n');
      return fail(1);
    case 'usage-json':
      process.stdout.write('{"v":1,"ok":false,"error":"usage"}');
      process.exitCode = 2;
      return;
    case 'old-manage':
      if (shape === 'advise-report') {
        process.stdout.write('{"v":1,"ok":false,"error":"usage"}');
        process.exitCode = 2;
        return;
      }
      if (shape === 'advice-picks' || shape === 'worker-matrix') {
        process.stderr.write(`doflow: unknown command '${argv[0]}'\n`);
        process.exitCode = 1;
        return;
      }
      break;
    case 'slow-doctor':
      if (shape === 'doctor') return setTimeout(body, Number(process.env.FAKE_CORE_DELAY_MS || 300));
      break;
  }
  return shape === null ? echo() : body();
}
