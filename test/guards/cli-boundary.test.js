'use strict';

// CLI boundary guard — Stage 2 of the structure refactor (docs/refactor-plan.md).
//
// bin/doflow.js used to be a 1215-line monolith holding parseArgs and nine cmd* handlers. The
// extraction moved all of that into src/cli/, applying the repo's own verb-table doctrine to the
// installer commands: one table, one file per command, a thin forwarder at bin/. Nothing fails
// loudly when handlers grow back in the entry point — a second handler there is just dead weight
// until someone edits it instead of the real one — so this guard ratchets both directions:
//
// (a) bin/doflow.js defines no command handlers and no argument parser;
// (b) the installer command surface is written down exactly once (src/cli/index.js's COMMANDS
//     table, one handler file per command under src/cli/commands/) and equals the nine commands
//     listed below. A deliberate change to that surface must edit this file in the same commit,
//     same ratchet philosophy as test/guards/boundaries.test.js.
//
// The runtime verbs are deliberately NOT enumerated here: their namespace is owned by the
// doflow-run dispatcher's verb table and is already cross-checked against src/cli/runtime-commands.js
// in both directions by test/guards/runtime-unification.test.js — enumerating it here too would
// be a second list claiming to own the same fact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const BIN = fs.readFileSync(path.join(REPO, 'bin', 'doflow.js'), 'utf8');
const CLI_DIR = path.join(REPO, 'src', 'cli');

/** The nine installer commands and the kebab-case handler filename each one owns. */
const COMMAND_FILES = new Map([
  ['install', 'install.js'],
  ['update', 'update.js'],
  ['reconcile', 'reconcile.js'],
  ['remove', 'remove.js'],
  ['status', 'status.js'],
  ['tools', 'tools.js'],
  ['list-backups', 'list-backups.js'],
  ['rollback', 'rollback.js'],
  ['self-update', 'self-update.js'],
]);

test('cli-boundary: bin/doflow.js is a thin forwarder with no handlers and no parser', () => {
  assert.doesNotMatch(BIN, /\bfunction\s+cmd[A-Za-z]*/,
    'a command handler defined in bin/doflow.js is a second implementation growing back inside '
    + 'the entry point; handlers live in src/cli/commands/<name>.js');
  assert.doesNotMatch(BIN, /\bfunction\s+parseArgs\b/,
    'argument parsing lives in src/cli/index.js; a parser copy here would drift from it silently');
  assert.match(BIN, /require\([^)]*src\/cli["']\)|require\([^)]*src[\\/]cli["']\)/,
    'bin/doflow.js must reach the CLI through src/cli, not re-implement any part of it');
});

test('cli-boundary: COMMANDS exports exactly the nine installer commands, wired to their files', () => {
  const { COMMANDS } = require(path.join(CLI_DIR, 'index.js'));

  const names = Object.keys(COMMANDS).sort();
  assert.deepEqual(names, [...COMMAND_FILES.keys()].sort(),
    'the installer command surface changed. If deliberate, update COMMAND_FILES above in the '
    + 'same commit so the surface stays written down exactly once.');

  for (const [name, handler] of Object.entries(COMMANDS)) {
    assert.equal(typeof handler, 'function', `COMMANDS['${name}'] must be a handler function`);
  }
});

test('cli-boundary: src/cli/commands holds exactly one kebab-case file per command', () => {
  const files = fs.readdirSync(path.join(CLI_DIR, 'commands'))
    .filter((f) => f.endsWith('.js'))
    .sort();
  assert.deepEqual(files, [...COMMAND_FILES.values()].sort(),
    'src/cli/commands/ and COMMAND_FILES must describe the same nine handlers. A command without '
    + 'a file, or a file no command dispatches to, means the surface has drifted.');
});
