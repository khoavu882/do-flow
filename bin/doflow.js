#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Argument parsing, the installer command table and every
// command handler live in src/cli/ (see docs/architecture.md); this file is only the forwarder
// so the `doflow` binary path and the doflow-run dispatcher seam
// (core/shared/scripts/doflow/bin/doflow-run, which execs `node <repoRoot>/bin/doflow.js`)
// keep resolving to this exact location.
// Refuse clearly on a Node below the floor, or one that cannot strip types: src/ is TypeScript, and
// without stripping loading a .ts module dies with a SyntaxError on the first annotation. The floor
// is 24.22.1, the 2026-10-21 security release of the Node 24 line (engines.node in package.json is
// the same value); stripping is on by default from there and off only under
// --no-experimental-strip-types. This file stays plain JavaScript so it can say so. Exit 2 is the
// doflow-run usage/resolution-error code.
const NODE_FLOOR_VERSION = '24.22.1';
const NODE_FLOOR = `>=${NODE_FLOOR_VERSION}`;
// A prerelease of the floor version (24.22.1-rc.1) sorts below it, as in semver; any other
// prerelease suffix is ignored, so 24.22.2-rc.1 and 24.23.0-rc.1 both pass.
const running = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(process.versions.node)) || [];
const order = NODE_FLOOR_VERSION.split('.').reduce((result, part, i) => result || Math.sign(Number(running[i + 1] || 0) - Number(part)), 0);
const belowFloor = order < 0 || (order === 0 && Boolean(running[4]));
if (belowFloor) {
  process.stderr.write(`doflow: Node ${process.versions.node} is not supported; doflow needs Node ${NODE_FLOOR} (Node 22 and Node 24 before ${NODE_FLOOR_VERSION} are no longer supported).\n`);
  process.exit(2);
}
if (!process.features || !process.features.typescript) {
  process.stderr.write(`doflow: Node ${process.versions.node} cannot strip TypeScript types; doflow needs Node ${NODE_FLOOR} with type-stripping enabled (it is off under --no-experimental-strip-types, including via NODE_OPTIONS).\n`);
  process.exit(2);
}
// Enable Node's module compile cache before any ../src require. Type stripping makes the first load
// of each .ts module cost a transform; the cache turns that into a one-time cost per Node version
// and file content. Called without options so an explicit NODE_COMPILE_CACHE directory is honoured
// and NODE_DISABLE_COMPILE_CACHE still disables it. Best-effort: if it throws, the CLI runs at
// today's speed.
const nodeModule = require('node:module');
try { nodeModule.enableCompileCache(); } catch { /* best-effort */ }
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
