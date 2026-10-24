'use strict';

// FX.10: --force re-merges an edited companion Codex hooks.json and keeps user entries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');

test('update -g -f -t codex re-merges edited hooks.json and keeps the user hook', () => {
  const scratch = createScratch('doflow-hook-step-codex-force-');
  const run = (args: any) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch.dir,
    env: scratch.env({ DOFLOW_FAILURE_CAPTURE: 'off' }),
    input: 'y\n', encoding: 'utf8',
  });
  const output = (result: any) => `${result.stdout}\n${result.stderr}`;

  const installed = run(['install', '-g', '-f', '--no-backup', '-t', 'codex,claude']);
  assert.equal(installed.status, 0, output(installed));
  const ledgerFile = path.join(scratch.home, '.doflow', 'state', 'ledger.json');
  const ledgerRows = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).resources;
  assert.ok(ledgerRows.some((row: any) => row.harness === 'codex' && row.kind === 'hooks-file'), 'Codex hooks.json is ledger-owned');

  const hooksFile = path.join(scratch.home, '.codex', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const userHook = { hooks: [{ type: 'command', command: 'echo user-custom-codex-hook' }] };
  hooks.hooks.SessionStart.push(userHook);
  fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);

  const updated = run(['update', '-g', '-f', '-t', 'codex']);
  assert.equal(updated.status, 0, output(updated));
  const merged = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.ok(merged.hooks.SessionStart.some((entry: any) => entry.hooks?.some((hook: any) => hook.command === 'echo user-custom-codex-hook')),
    'the user hook survives the forced re-merge');
});
