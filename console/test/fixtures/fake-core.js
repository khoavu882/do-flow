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
  default:
    process.stderr.write(`fake-core: unknown mode ${mode}\n`);
    process.exitCode = 9;
}
