#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Argument parsing, the installer command table and every
// command handler live in src/cli/ (see docs/architecture.md); this file is only the forwarder
// so the `doflow` binary path and the doflow-run dispatcher seam
// (core/shared/scripts/doflow/bin/doflow-run, which execs `node <repoRoot>/bin/doflow.js`)
// keep resolving to this exact location.
require('../src/cli').main(process.argv.slice(2));
