'use strict';
// upgrade-1.18.test.js — what a current `update`, `remove` and `reconcile` do to MCP state that
// DoFlow v1.18.0 left behind. Each scenario under test/fixtures/v1.18.0 holds only the files that
// carry MCP state; a current install lays down the rest of the tree, then the fixture files
// replace the lock, the manifest, every MCP file and every MCP ledger row. bin/doflow.js is spawned
// against that root with a scratch HOME and XDG folder.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'v1.18.0');
const LEDGER_ROWS = 'mcp-ledger-rows.json';

// A developer's own PI_CODING_AGENT_DIR would send Pi's mcp.json outside the scratch HOME.
delete process.env.PI_CODING_AGENT_DIR;

const scratch = createScratch('doflow-upgrade-118-');
after(() => scratch.remove());

let sequence = 0;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function doflow(args, { home, cwd = REPO }) {
  return spawnSync('node', [DOFLOW, ...args], {
    cwd,
    env: scratch.env({ HOME: home, USERPROFILE: home }),
    input: '\n',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Fixture files are stored without the leading dot of their first path component. */
function fixtureFiles(scenario) {
  const base = path.join(FIXTURES, scenario);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return walk(base).map((file) => path.relative(base, file)).filter((rel) => rel !== LEDGER_ROWS);
}

function diskPath(root, rel) {
  const [first, ...rest] = rel.split(path.sep);
  return path.join(root, `.${first}`, ...rest);
}

function isMcpRow(row) {
  return row.kind === 'mcp-server' || String(row.ownershipIdentity).startsWith('kiro:mcp:')
    || row.ownershipIdentity === 'copilot:mcp:registration';
}

/** Builds one scenario: a current install of its targets on a fresh root, then the 1.18.0 files over it. */
function materialise(scenario, { installArgs, project }) {
  const dir = path.join(scratch.dir, `${scenario}-${sequence += 1}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const root = project ? path.join(dir, 'project') : home;
  fs.mkdirSync(root, { recursive: true });
  const rootArgs = project ? [root] : ['-g'];

  const install = doflow(['install', ...rootArgs, ...installArgs, '--mcp', 'none', '--force', '--no-backup'], { home });
  assert.strictEqual(install.status, 0, install.stderr);

  const substitute = (text) => text.replaceAll('@ROOT@', root);
  for (const rel of fixtureFiles(scenario)) {
    const target = diskPath(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, substitute(fs.readFileSync(path.join(FIXTURES, scenario, rel), 'utf8')));
  }
  const ledgerFile = path.join(root, '.doflow', 'state', 'ledger.json');
  const ledger = readJson(ledgerFile);
  const captured = JSON.parse(substitute(fs.readFileSync(path.join(FIXTURES, scenario, LEDGER_ROWS), 'utf8')));
  ledger.resources = [...ledger.resources.filter((row) => !isMcpRow(row)), ...captured];
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);

  const cwd = project ? root : REPO;
  return {
    root,
    home,
    run: (command, ...extra) => doflow([command, ...(project ? [root] : ['-g']), ...extra], { home, cwd }),
    // `update` targets claude alone unless told otherwise, so the scenario's own targets are named.
    update: () => doflow(['update', ...(project ? [root] : ['-g']), ...installArgs, '--force', '--no-backup'], { home, cwd }),
    file: (rel) => diskPath(root, rel),
    lock: () => readJson(path.join(root, '.doflow', 'doflow.lock')),
    // Config files, ledger and lock: the bytes a second run must leave alone.
    snapshot: () => [
      path.join('.doflow', 'doflow.lock'),
      path.join('.doflow', 'state', 'ledger.json'),
      ...fixtureFiles(scenario).filter((rel) => !rel.startsWith('doflow')).map((rel) => path.relative(root, diskPath(root, rel))),
    ].map((rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null)),
  };
}

const USER_SERVER = { command: 'user-cmd', args: ['--user-owned'] };
const BOTH = ['context7', 'sequential-thinking'];

const TARGETS = {
  'global-multi': ['-t', 'claude,codex,gemini,opencode,pi'],
  'global-kiro': ['-t', 'kiro'],
  'project-claude-copilot': ['-t', 'claude,copilot'],
};

const globalMulti = () => materialise('global-multi', { installArgs: TARGETS['global-multi'] });
const globalKiro = () => materialise('global-kiro', { installArgs: TARGETS['global-kiro'] });
const projectClaudeCopilot = () => materialise('project-claude-copilot', { installArgs: TARGETS['project-claude-copilot'], project: true });

function serversOf(env, rel, key) {
  return readJson(env.file(rel))[key];
}

test('F1: update with no --mcp keeps every server and user entry on global-multi and records the selection of every harness', () => {
  const env = globalMulti();
  const r = env.update();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  for (const [rel, key] of [['claude.json', 'mcpServers'], ['config/opencode/opencode.json', 'mcp'], ['pi/agent/mcp.json', 'mcpServers']]) {
    const servers = serversOf(env, rel, key);
    assert.deepStrictEqual(Object.keys(servers).sort(), [...BOTH, 'user-server'].sort(), rel);
  }
  assert.deepStrictEqual(serversOf(env, 'claude.json', 'mcpServers')['user-server'], USER_SERVER);
  assert.deepStrictEqual(serversOf(env, 'pi/agent/mcp.json', 'mcpServers')['user-server'], USER_SERVER);
  const codexConfig = fs.readFileSync(env.file('codex/config.toml'), 'utf8');
  for (const id of [...BOTH, 'user-server']) assert.match(codexConfig, new RegExp(`\\[mcp_servers\\.${id}\\]`));
  assert.ok(codexConfig.includes('[mcp_servers.user-server]\ncommand = "user-cmd"\nargs = ["--user-owned"]'), 'the user block is byte for byte');

  const { mcpSelections } = env.lock();
  assert.deepStrictEqual(Object.keys(mcpSelections).sort(), ['claude', 'codex', 'opencode', 'pi']);
  for (const harness of Object.keys(mcpSelections)) assert.deepStrictEqual([...mcpSelections[harness]].sort(), BOTH, harness);
});

test('F2: global-kiro keeps both servers through update, and remove deletes them and keeps the user entry', () => {
  const env = globalKiro();
  let r = env.update();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(Object.keys(serversOf(env, 'kiro/settings/mcp.json', 'mcpServers')).sort(), [...BOTH, 'user-server'].sort());
  assert.deepStrictEqual([...env.lock().mcpSelections.kiro].sort(), BOTH, 'the lock records what Kiro holds');

  r = env.run('remove', '--force', '--no-backup', '-t', 'kiro');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(serversOf(env, 'kiro/settings/mcp.json', 'mcpServers'), { 'user-server': USER_SERVER });
});

test('F3: project-claude-copilot keeps context7 for both, and removing Copilot leaves it for Claude', () => {
  const env = projectClaudeCopilot();
  let r = env.update();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(Object.keys(serversOf(env, 'mcp.json', 'mcpServers')).sort(), ['context7', 'user-server']);
  assert.deepStrictEqual(env.lock().mcpSelections.claude, ['context7']);

  r = env.run('remove', '--force', '--no-backup', '-t', 'copilot');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(Object.keys(serversOf(env, 'mcp.json', 'mcpServers')).sort(), ['context7', 'user-server']);
  assert.deepStrictEqual(env.lock().mcpSelections.claude, ['context7']);
});

for (const [name, build] of [['global-multi', globalMulti], ['global-kiro', globalKiro], ['project-claude-copilot', projectClaudeCopilot]]) {
  test(`F4: a second update on ${name} changes no config file, ledger or lock byte`, () => {
    const env = build();
    let r = env.update();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const first = env.snapshot();
    r = env.update();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepStrictEqual(env.snapshot(), first);
  });
}

test('F5: reconcile --dry-run after the upgrade of global-multi reports no drift and exits 0', () => {
  const env = globalMulti();
  let r = env.update();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  r = env.run('reconcile', '--dry-run');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Observed state matches doflow\.lock/);
  assert.doesNotMatch(r.stdout, /\[WARN\]/);
});
