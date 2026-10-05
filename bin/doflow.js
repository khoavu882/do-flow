#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Argument parsing, the installer command table and every
// command handler live in src/cli/ (see docs/architecture.md); this file is only the forwarder
// so the `doflow` binary path and the doflow-run dispatcher seam
// (core/shared/scripts/doflow/bin/doflow-run, which execs `node <repoRoot>/bin/doflow.js`)
// keep resolving to this exact location.
// Record an error that escapes everything, including one thrown while the CLI loads (a half-updated
// install), before it is loaded (IC-016). The monitor only observes: Node's own crash output and
// exit status are unchanged, and a monitor that threw would change that status to 7, hence the
// try/catch around both the registration and the body. If the writer cannot load, nothing is
// registered and the CLI runs as it always has. `cli` stays null until the CLI has loaded, so an
// error thrown while it loads is recorded under the command name `unknown`.
let cli = null;
try {
  const { captureError } = require('../src/runtime/failure/capture');
  process.on('uncaughtExceptionMonitor', (error) => {
    try {
      const argv = process.argv.slice(2);
      const command = cli ? cli.commandName(argv.find((a) => !a.startsWith('-'))) : 'unknown';
      captureError(error, { command, exit: 1, uncaught: true });
    } catch { /* best-effort */ }
  });
} catch { /* best-effort */ }
cli = require('../src/cli');
cli.main(process.argv.slice(2));
