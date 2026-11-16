'use strict';

// Row 171 T6 (design §6.1 step 5): the fake harness `worker --action conform` runs in place of a real one.
// It is not required by anything: conform.ts writes `<scratch>/bin/<cli.binary>`, a `#!/bin/sh` wrapper that
// execs `$DOFLOW_CONFORM_NODE $DOFLOW_CONFORM_FAKE "$@"`, so this file runs as a script.
//
// It writes `{argv, stdinBase64 (at most 1 MiB), env (the keys only)}` as one JSON line to $DOFLOW_CONFORM_LOG,
// writes the script's `lastMessage` to its `lastMessageFile` when the argv holds that path, prints the script's
// stdout lines and exits with $DOFLOW_CONFORM_EXIT. It reads no file but its script ($DOFLOW_CONFORM_SCRIPT) and
// stdin, and makes no network call.

const fs = require('node:fs');

const STDIN_MAX = 1048576;
const env = process.env;
const script = JSON.parse(fs.readFileSync(String(env.DOFLOW_CONFORM_SCRIPT), 'utf8'));
const argv = process.argv.slice(2);
let stdin = Buffer.alloc(0);
try {
  stdin = fs.readFileSync(0);
} catch {
  // no stdin (closed or not a pipe) logs as empty
}
fs.writeFileSync(String(env.DOFLOW_CONFORM_LOG), `${JSON.stringify({
  argv,
  stdinBase64: stdin.subarray(0, STDIN_MAX).toString('base64'),
  env: Object.keys(env).sort(),
})}\n`);
if (typeof script.lastMessageFile === 'string' && typeof script.lastMessage === 'string' && argv.includes(script.lastMessageFile)) {
  fs.writeFileSync(script.lastMessageFile, script.lastMessage);
}
const lines: string[] = Array.isArray(script.stdout) ? script.stdout : [];
process.stdout.write(lines.map((line) => `${line}\n`).join(''));
process.exitCode = Number(env.DOFLOW_CONFORM_EXIT);
