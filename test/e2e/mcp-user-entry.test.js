'use strict';
// A server entry the user wrote before DoFlow ever ran is the user's, even when it is byte for byte
// what DoFlow would have written: no later install, update, narrower or empty selection, or remove
// may take it over or delete it. Each case spawns bin/doflow.js in a scratch HOME and XDG folder.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const DOFLOW = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const scratches = [];
after(() => { for (const scratch of scratches) scratch.remove(); });

const CONTEXT7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const OPENCODE_CONTEXT7 = { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'], enabled: true };

/** Where each adapter keeps its MCP entries at each scope, and DoFlow's own rendering of context7. */
const ADAPTERS = {
  claude: { container: 'mcpServers', entry: CONTEXT7, global: (home) => path.join(home, '.claude.json'), project: (root) => path.join(root, '.mcp.json') },
  kiro: { container: 'mcpServers', entry: CONTEXT7, global: (home) => path.join(home, '.kiro', 'settings', 'mcp.json'), project: (root) => path.join(root, '.kiro', 'settings', 'mcp.json') },
  opencode: { container: 'mcp', entry: OPENCODE_CONTEXT7, global: (home) => path.join(home, '.config', 'opencode', 'opencode.json'), project: (root) => path.join(root, 'opencode.json') },
  copilot: { container: 'mcpServers', entry: CONTEXT7, global: (home) => path.join(home, '.copilot', 'mcp-config.json'), project: (root) => path.join(root, '.mcp.json') },
  antigravity: { container: 'mcpServers', entry: CONTEXT7, global: (home) => path.join(home, '.gemini', 'config', 'mcp_config.json'), project: (root) => path.join(root, '.agents', 'mcp_config.json') },
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function ledgerMcpRows(stateFile, harness) {
  if (!fs.existsSync(stateFile)) return [];
  return readJson(stateFile).resources.filter((row) => row.harness === harness && row.kind === 'mcp-server').map((row) => row.identity);
}

for (const [harness, spec] of Object.entries(ADAPTERS)) {
  for (const scope of ['global', 'project']) {
    test(`${harness} ${scope}: a user's own context7, equal to DoFlow's rendering, is never owned or deleted`, () => {
      const scratch = createScratch(`doflow-user-entry-${harness}-`);
      scratches.push(scratch);
      const project = path.join(scratch.dir, 'project');
      fs.mkdirSync(project);
      const where = scope === 'global' ? ['-g'] : [project];
      const file = scope === 'global' ? spec.global(scratch.home) : spec.project(project);
      const ledger = path.join(scope === 'global' ? scratch.home : project, '.doflow', 'state', 'ledger.json');
      const doflow = (...args) => {
        const r = spawnSync('node', [DOFLOW, ...args], { env: scratch.env(), input: '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
        return r;
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ [spec.container]: { context7: spec.entry } }, null, 2)}\n`);
      const kept = (step) => {
        assert.deepEqual(readJson(file)[spec.container]?.context7, spec.entry, `${step}: the user's context7 must stay`);
        assert.ok(!ledgerMcpRows(ledger, harness).includes('context7'), `${step}: DoFlow must not record the user's context7 as its own`);
      };

      const installed = doflow('install', ...where, '--force', '--no-backup', '-t', harness, '--mcp', 'context7');
      assert.match(installed.stdout, /kept your own entry 'context7'/);
      kept('install');
      doflow('update', ...where, '--force', '--no-backup', '-t', harness);
      kept('update with the recorded selection');
      doflow('update', ...where, '--force', '--no-backup', '-t', harness, '--mcp', 'sequential-thinking');
      kept('a narrower --mcp');
      doflow('update', ...where, '--force', '--no-backup', '-t', harness, '--mcp', 'none');
      kept('--mcp none');
      doflow('remove', ...where, '--force', '-t', harness);
      kept('remove');
    });
  }
}
