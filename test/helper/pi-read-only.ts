'use strict';

// Row 178 G-1: the shipped registry holds Pi's `readOnly` and `spawnDenial` as `unknown` until two live runs with the
// current argv are recorded (core/registry/harnesses.json, pinned in test/registry/pi-worker-truth.test.ts). A test whose
// subject is the Pi recipe's shape (argv assembly, model parts, conformance) needs those two entries; this puts the
// recipe the live runs would restore onto a copy of Pi's worker block. It is a fixture, never the shipped data.

const PI_READ_ONLY_ARGV = ['--tools', 'read,grep,find,ls'];
const PI_SPAWN_DENIAL_ARGV = ['--no-extensions', '--no-mcp'];
const FIXTURE = { evidence: ['core/worker-evidence/pi/2026-11-07-cli-check-model.json'], verification: 'test fixture: the recipe a later live run restores', verifiedOn: '2026-11-19' };

/** `worker` (a Pi worker block, changed in place) with `readOnly` and `spawnDenial` supported; returns `worker`. */
function withPiReadOnly(worker: any): any {
  worker.readOnly = { status: 'supported', ...FIXTURE, argv: [...PI_READ_ONLY_ARGV] };
  worker.spawnDenial = { status: 'supported', ...FIXTURE, argv: [...PI_SPAWN_DENIAL_ARGV] };
  return worker;
}

module.exports = { withPiReadOnly };
