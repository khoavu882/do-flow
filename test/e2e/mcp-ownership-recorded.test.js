'use strict';
// An entry DoFlow comes to own without writing it (co-owned beside another harness's row, or adopted
// from 1.18.0) must reach the ledger on a run that changes no file, or a later removal of the other
// harness deletes it. bin/doflow.js runs in a scratch HOME and XDG folder.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const DOFLOW = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const scratch = createScratch('doflow-mcp-co-owned-');
after(() => scratch.remove());

test('a server Copilot co-owns through a no-change update survives removing Claude', () => {
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const doflow = (...args) => spawnSync('node', [DOFLOW, ...args], { env: scratch.env(), input: '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const ok = (...args) => { const r = doflow(...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`); return r; };

  ok('install', project, '--force', '--no-backup', '-t', 'claude', '--mcp', 'context7');
  ok('install', project, '--force', '--no-backup', '-t', 'copilot', '--mcp', 'none');
  const update = ok('update', project, '--force', '--no-backup', '-t', 'copilot', '--mcp', 'context7');
  assert.match(update.stdout, /copilot: recorded DoFlow's ownership of 1 MCP entry \(context7\)/);
  const rows = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8')).resources
    .filter((row) => row.kind === 'mcp-server').map((row) => `${row.harness}:${row.identity}`).sort();
  assert.deepEqual(rows, ['claude:context7', 'copilot:context7']);

  ok('remove', project, '--force', '-t', 'claude');
  const servers = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['context7'], 'Copilot still owns context7');
  const reconcile = ok('reconcile', project, '--dry-run');
  assert.match(reconcile.stdout, /Observed state matches doflow\.lock/);
});
