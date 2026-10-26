'use strict';

// Test-only preload for read-contract.test.ts's vacuity control, loaded as
// `node --require <this file> bin/doflow-ui.js ...`. It wraps child_process.spawn inside the Console
// process, so each core child gets exactly the environment the verb runner built minus DOFLOW_UPKEEP.
// Shipped code has no switch for this: only the process's own command line can load a preload, which
// no HTTP request reaches. Each spawn writes one line to the Console's stderr, so the test can tell
// the hook ran, and refuses (core-unreachable) if the runner did not force DOFLOW_UPKEEP=off.

const childProcess = require('node:child_process');
const spawn = childProcess.spawn;

childProcess.spawn = (command: string, args: string[], options: any) => {
  if (!options || !options.env || options.env.DOFLOW_UPKEEP !== 'off') throw new Error('the runner did not force DOFLOW_UPKEEP=off');
  const { DOFLOW_UPKEEP, ...env } = options.env;
  process.stderr.write('drop-upkeep-switch: removed\n');
  return spawn(command, args, { ...options, env });
};
