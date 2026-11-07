#!/usr/bin/env node
'use strict';

// A fake core for console/test/verb-runner.test.ts. It appends one JSON line {argv, env, cwd} to
// FAKE_CORE_LOG on every start (after any signal handler is installed, so a test that sees the line
// can signal it), then behaves as FAKE_CORE_MODE says. Neither variable starts with DOFLOW_, so the
// runner's environment stripping lets them through.

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
