#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Argument parsing, the installer command table and every
// command handler live in src/cli/ (see docs/architecture.md); this file is only the forwarder
// so the `doflow` binary path and the doflow-run dispatcher seam
// (core/shared/scripts/doflow/bin/doflow-run, which execs `node <repoRoot>/bin/doflow.js`)
// keep resolving to this exact location.
// Refuse clearly on a Node that cannot strip types: src/ is TypeScript, and without stripping
// loading a .ts module dies with a SyntaxError on the first annotation. Stripping is on by
// default from Node 22.18.0 / 23.6.0 and off under --no-experimental-strip-types; the range stops at
// 24.3.0 because 23.6 to 24.2 print an ExperimentalWarning on every .ts load. This file stays
// plain JavaScript so it can say so. Exit 2 is the doflow-run usage/resolution-error code.
if (!process.features || !process.features.typescript) {
  process.stderr.write(`doflow: Node ${process.versions.node} cannot strip TypeScript types; doflow needs Node ^22.18.0 || >=24.3.0 with type-stripping enabled (it is off under --no-experimental-strip-types, including via NODE_OPTIONS).\n`);
  process.exit(2);
}
// Enable Node's module compile cache before any ../src require. Type stripping makes the first load
// of each .ts module cost a transform; the cache turns that into a one-time cost per Node version
// and file content. Called without options so an explicit NODE_COMPILE_CACHE directory is honoured
// and NODE_DISABLE_COMPILE_CACHE still disables it. Best-effort: where the API is missing (older
// Node) or throws, the CLI runs at today's speed.
const nodeModule = require('node:module');
if (typeof nodeModule.enableCompileCache === 'function') {
  try { nodeModule.enableCompileCache(); } catch { /* best-effort */ }
}
// Record an error that escapes everything, including one thrown while the CLI loads (a half-updated
// install), before it is loaded (IC-016). The monitor only observes: Node's own crash output and
// exit status are unchanged, and a monitor that threw would change that status to 7, hence the
// try/catch around both the registration and the body. If the writer cannot load, nothing is
// registered and the CLI runs as it always has. `cli` stays null until the CLI has loaded, so an
// error thrown while it loads is recorded under the command name `unknown`.
let cli = null;
try {
  const { captureError } = require('../src/runtime/failure/capture.ts');
  process.on('uncaughtExceptionMonitor', (error) => {
    try {
      const argv = process.argv.slice(2);
      const command = cli ? cli.commandName(argv.find((a) => !a.startsWith('-'))) : 'unknown';
      captureError(error, { command, exit: 1, uncaught: true });
    } catch { /* best-effort */ }
  });
} catch { /* best-effort */ }
cli = require('../src/cli/index.ts');
cli.main(process.argv.slice(2));
