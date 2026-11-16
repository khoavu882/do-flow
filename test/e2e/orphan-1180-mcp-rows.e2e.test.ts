'use strict';
// MCP ownership rows that DoFlow 1.18.0 wrote (`kiro:mcp:<id>` per server, one `copilot:mcp:registration`
// row for the whole map) are no longer read. A ledger that still holds them must install and update
// with exit 0 and leave every entry of the harness's MCP file as it was, the user's own included.
// bin/doflow.js runs in a scratch HOME and XDG folder.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const DOFLOW = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const scratch = createScratch('doflow-orphan-1180-');
after(() => scratch.remove());

const USER_SERVER = { command: 'user-cmd', args: ['--user-owned'] };
const CONTEXT7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

let sequence = 0;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

function setup(args: string[], { project }: { project: boolean }) {
  const dir = path.join(scratch.dir, `case-${sequence += 1}`);
  const home = path.join(dir, 'home');
  const root = project ? path.join(dir, 'project') : home;
  fs.mkdirSync(root, { recursive: true });
  const rootArgs = project ? [root] : ['-g'];
  const run = (command: string, ...extra: string[]) => spawnSync('node', [DOFLOW, command, ...rootArgs, ...extra], {
    cwd: project ? root : path.resolve(__dirname, '..', '..'), env: scratch.env({ HOME: home, USERPROFILE: home }),
    input: '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const ok = (command: string, ...extra: string[]) => {
    const r = run(command, ...extra);
    assert.equal(r.status, 0, `${command} ${extra.join(' ')}\n${r.stdout}${r.stderr}`);
    return r;
  };
  ok('install', ...args, '--mcp', 'none', '--force', '--no-backup');
  const addRows = (rows: any[]) => {
    const file = path.join(root, '.doflow', 'state', 'ledger.json');
    const ledger = readJson(file);
    ledger.resources.push(...rows);
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  };
  return { root, ok, addRows, ledger: () => readJson(path.join(root, '.doflow', 'state', 'ledger.json')) };
}

test('a 1.18.0 kiro:mcp:<id> row and a copilot registration row change nothing in the MCP files', () => {
  const kiro = setup(['-t', 'kiro'], { project: false });
  const kiroFile = path.join(kiro.root, '.kiro', 'settings', 'mcp.json');
  fs.mkdirSync(path.dirname(kiroFile), { recursive: true });
  const kiroServers = { context7: CONTEXT7, 'user-server': USER_SERVER };
  fs.writeFileSync(kiroFile, `${JSON.stringify({ mcpServers: kiroServers }, null, 2)}\n`);
  kiro.addRows([{
    assetId: 'guidance.context-layer', target: kiroFile, ownershipIdentity: 'kiro:mcp:context7', identity: 'context7',
    fingerprint: 'ba674561deee52eca70f103ec561f576cd7582febec9bea15ebc81dcb2f4c258', sourceVersion: '1.18.0',
    projection: { renderer: 'kiro-mcp' }, harness: 'kiro', scope: 'global', recoveryRef: 'recovery_2026-10-06T15-27-04-554Z_1abdb561',
  }]);
  kiro.ok('update', '-t', 'kiro', '--force', '--no-backup');
  assert.deepEqual(readJson(kiroFile).mcpServers, kiroServers, 'Kiro entries as they were');
  kiro.ok('update', '-t', 'kiro', '--force', '--no-backup');
  kiro.ok('reconcile', '--dry-run');
  kiro.ok('remove', '--force', '--no-backup', '-t', 'kiro');
  assert.deepEqual(readJson(kiroFile).mcpServers, kiroServers, 'removing Kiro leaves entries it never owned');

  const copilot = setup(['-t', 'copilot'], { project: true });
  const copilotFile = path.join(copilot.root, '.mcp.json');
  const copilotServers = { context7: CONTEXT7, 'user-server': USER_SERVER };
  fs.writeFileSync(copilotFile, `${JSON.stringify({ mcpServers: copilotServers }, null, 2)}\n`);
  copilot.addRows([{
    assetId: 'guidance.codex-pointer', target: copilotFile, ownershipIdentity: 'copilot:mcp:registration',
    fingerprint: '9eec52e177e06ea640f729c24fdbd7d6d7ab99e0348c31fbcf0dc0bca6999061', sourceVersion: '1.18.0',
    projection: { renderer: 'copilot-mcp' }, harness: 'copilot', scope: 'project', recoveryRef: 'recovery_2026-10-06T15-27-04-752Z_4b9705be',
  }]);
  copilot.ok('update', '-t', 'copilot', '--force', '--no-backup');
  assert.deepEqual(readJson(copilotFile).mcpServers, copilotServers, 'Copilot entries as they were');
  copilot.ok('reconcile', '--dry-run');
  copilot.ok('remove', '--force', '--no-backup', '-t', 'copilot');
  assert.deepEqual(readJson(copilotFile).mcpServers, copilotServers, 'removing Copilot leaves entries it never owned');
});
