#!/usr/bin/env node
'use strict';

// A fake core for console/test/verb-runner.test.ts. It appends one JSON line {argv, env, cwd} to
// FAKE_CORE_LOG on every start (after any signal handler is installed, so a test that sees the line
// can signal it), then behaves as FAKE_CORE_MODE says. Neither variable starts with DOFLOW_, so the
// runner's environment stripping lets them through. Modes `worker-reads` and `old-core` (feature 150
// IC-010) answer the four worker chain shapes; see workerReads and oldCore below. Modes `manage`, `data-exit1`,
// `exit1-text`, `slow-doctor`, `usage-json` and `old-manage` (feature 151 IC-005) answer the ten management shapes;
// see manage below.

const fs = require('node:fs');

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

/**
 * The 151 IC-005 modes over the ten management argv shapes. Each answers `{v: 1, verb: <shape id>, argv}`;
 * `--version` prints `9.9.9-fake`; any other argv echoes, as mode `echo`.
 *   manage       exit 0.
 *   data-exit1   exit 1 with the JSON body and `[ERROR] secret-stderr-text` on stderr (a `config list` fail-safe
 *                key, a `doctor` with findings: data, DEC-024). Any other argv too, so a case can compare.
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
  const body = () => process.stdout.write(JSON.stringify({ v: 1, verb: shape, argv }));
  const fail = (exit) => {
    process.stderr.write('[ERROR] secret-stderr-text\n');
    process.exitCode = exit;
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
