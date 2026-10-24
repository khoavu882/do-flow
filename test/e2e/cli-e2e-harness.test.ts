'use strict';
// cli-e2e-harness.test.js — bin/doflow.js against scratch $HOMEs: Pi MCP and the per-harness MCP cases E1 to E12. Runners live in cli-e2e.shared.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO, tempDir, scratchHome, run, cleanup,
} = require('./cli-e2e.shared.ts');

after(cleanup);

test('Pi MCP: a global install merges into a hand-written ~/.pi/agent/mcp.json and remove leaves the user bytes untouched', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const mcpFile = path.join(home, '.pi', 'agent', 'mcp.json');
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  const handWritten = '{\n  "mcpServers": { "mine": { "command": "my-server" } },\n  "other": 1\n}\n';
  fs.writeFileSync(mcpFile, handWritten);

  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const installed = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(installed.mcpServers).sort(), ['context7', 'mine', 'sequential-thinking']);
  assert.deepStrictEqual(installed.mcpServers.mine, { command: 'my-server' });
  assert.strictEqual(installed.other, 1);
  const installedText = fs.readFileSync(mcpFile, 'utf8');
  assert.ok(installedText.includes('"mine": { "command": "my-server" }') && installedText.includes('"other": 1'), 'install keeps the hand-written members byte for byte');

  r = run(['remove', '-g', '--force', '-t', 'pi'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(mcpFile, 'utf8'), handWritten, 'remove restores the user\'s bytes exactly');
});

test('Pi MCP: a project install writes <project>/.pi/mcp.json with both catalog servers and prints the trust notice', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
  const r = run(['install', project, '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(r.stdout.includes('MCP: Pi reads .pi/mcp.json only after this project is trusted (/trust or --approve); DoFlow does not grant trust.'), r.stdout);
});

test('Pi MCP: an update with a narrower --mcp selection drops the deselected server from Pi\'s mcp.json', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  let r = run(['install', '-g', '--force', '-t', 'claude,pi', '--mcp', 'context7,sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const piMcp = path.join(home, '.pi', 'agent', 'mcp.json');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(piMcp, 'utf8')).mcpServers).sort(), ['context7', 'sequential-thinking']);

  r = run(['update', '-g', '--force', '-t', 'claude,pi', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(piMcp, 'utf8')).mcpServers), ['context7']);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers), ['context7']);
});

test('Pi MCP: PI_CODING_AGENT_DIR redirects mcp.json while skills stay under ~/.pi/agent', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const agentDir = tempDir(t, 'doflow-cli-e2e-agentdir-');
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(home, '.pi', 'agent', 'mcp.json')), 'the default location must stay untouched');
  assert.ok(fs.existsSync(path.join(home, '.pi', 'agent', 'skills')), 'skills do not follow PI_CODING_AGENT_DIR');
  assert.ok(r.stdout.includes('PI_CODING_AGENT_DIR is set: Pi reads its whole agent dir from it, and DoFlow moves mcp.json and the guard extension there; skills and AGENTS.md stay in ~/.pi/agent.'), r.stdout);
  assert.ok(r.stdout.includes('[INFO] MCP selection: pi: context7, sequential-thinking (--mcp)'), r.stdout);
});

// --- Per-harness MCP selection: each harness's server file holds exactly its own selection ----

function readJson(file: any) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Where each MCP-capable harness keeps DoFlow's servers at global scope, and the member that holds them.
const GLOBAL_MCP_FILES = (home: any) => ({
  kiro: { file: path.join(home, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
  antigravity: { file: path.join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers' },
  opencode: { file: path.join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp' },
  copilot: { file: path.join(home, '.copilot', 'mcp-config.json'), key: 'mcpServers' },
  pi: { file: path.join(home, '.pi', 'agent', 'mcp.json'), key: 'mcpServers' },
});

test('E1: --mcp context7 leaves only context7 in Kiro, Antigravity, OpenCode, Copilot and Pi, and names it in the selection line', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,antigravity,opencode,copilot,pi', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro, antigravity, opencode, copilot, pi: context7 (--mcp)'), r.stdout);

  for (const [harness, { file, key }] of Object.entries(GLOBAL_MCP_FILES(home))) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]), ['context7'], `${harness} holds only the selected server`);
  }
});

test('E3: a non-interactive Pi install with no --mcp registers no server and says the selection is the default', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: pi: none (default)'), r.stdout);
  assert.match(r.stdout, /MCP: none selected by default/);
  const mcpFile = path.join(home, '.pi', 'agent', 'mcp.json');
  const servers = fs.existsSync(mcpFile) ? readJson(mcpFile).mcpServers ?? {} : {};
  assert.deepStrictEqual(Object.keys(servers), [], 'no DoFlow server is registered');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { pi: [] }, 'the lock records the empty selection');
});

test('E11: an update with a narrower --mcp drops the deselected server from every targeted harness', () => {
  const home = scratchHome();
  const targets = 'claude,codex,kiro,antigravity,opencode,copilot,pi';
  let r = run(['install', '-g', '--force', '--no-backup', '-t', targets, '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = GLOBAL_MCP_FILES(home);
  for (const [harness, { file, key }] of Object.entries(files)) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]).sort(), ['context7', 'sequential-thinking'], `${harness} starts with both`);
  }

  r = run(['update', '-g', '--force', '--no-backup', '-t', targets, '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const [harness, { file, key }] of Object.entries(files)) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]), ['context7'], `${harness} drops sequential-thinking`);
  }
  assert.deepStrictEqual(Object.keys(readJson(path.join(home, '.claude.json')).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.context7\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.sequential-thinking/);
});

test('E4: Claude and Codex keep their own selections across installs, and a Claude install with no flag keeps its servers', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'codex', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: claude: context7 (recorded)'), r.stdout);

  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections,
    { claude: ['context7'], codex: ['sequential-thinking'] });
  assert.deepStrictEqual(Object.keys(readJson(path.join(home, '.claude.json')).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.sequential-thinking\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.context7/);
});

// E5 and E6 share E4's first two installs, so each builds them itself.
function installClaudeAndCodexWithOwnSelections(home: any) {
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'codex', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
}

test('E5: reconcile --dry-run after a Claude and a Codex install with different selections finds no drift', () => {
  const home = scratchHome();
  installClaudeAndCodexWithOwnSelections(home);
  const r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Observed state matches doflow\.lock/);
  assert.doesNotMatch(r.stdout, /\[WARN\]/);
});

test('E6: reconcile re-creates a hand-deleted Claude server and gives Codex nothing from Claude\'s selection', () => {
  const home = scratchHome();
  installClaudeAndCodexWithOwnSelections(home);
  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  delete claudeJson.mcpServers.context7;
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);

  let r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.strictEqual(r.status, 1, 'the deleted server is drift');
  r = run(['reconcile', '-g', '--force'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.sequential-thinking\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.context7/, 'Claude\'s selection does not reach Codex');
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers).filter((id) => id === 'sequential-thinking'), [],
    'Codex\'s selection does not reach Claude');
});

/** Ledger rows of one kind for one harness, so a test can say which MCP rows a run left behind. */
function ledgerRows(home: any, harness: any, kind: any) {
  return readJson(path.join(home, '.doflow', 'state', 'ledger.json')).resources
    .filter((row: any) => row.harness === harness && row.kind === kind);
}

function addUserServer(file: any, key = 'mcpServers') {
  const doc = readJson(file);
  doc[key]['user-server'] = { command: 'user-cmd', args: ['--user-owned'] };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

test('E2: install --mcp none registers no DoFlow server and records an empty selection', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro', '--mcp', 'none'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro: none (--mcp)'), r.stdout);
  const mcpFile = GLOBAL_MCP_FILES(home).kiro.file;
  const servers = fs.existsSync(mcpFile) ? readJson(mcpFile).mcpServers ?? {} : {};
  assert.deepStrictEqual(Object.keys(servers), [], 'no DoFlow server is registered');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { kiro: [] });
});

test('E7: removing Kiro deletes its servers and rows, keeps a user entry, and leaves Codex and the lock row of Codex alone', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const kiroFile = GLOBAL_MCP_FILES(home).kiro.file;
  addUserServer(kiroFile);
  const codexFile = path.join(home, '.codex', 'config.toml');
  const codexBefore = fs.readFileSync(codexFile, 'utf8');
  const codexRowsBefore = ledgerRows(home, 'codex', 'mcp-server');
  assert.ok(ledgerRows(home, 'kiro', 'mcp-server').length > 0, 'Kiro owns a server row before the removal');

  r = run(['remove', '-g', '--force', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(kiroFile).mcpServers), ['user-server'], 'only the user entry stays');
  assert.deepStrictEqual(ledgerRows(home, 'kiro', 'mcp-server'), [], 'Kiro server rows are released');
  assert.strictEqual(fs.readFileSync(codexFile, 'utf8'), codexBefore, 'Codex config is untouched');
  assert.deepStrictEqual(ledgerRows(home, 'codex', 'mcp-server'), codexRowsBefore, 'Codex rows are unchanged');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { codex: ['context7'] });
});

test('E8: removing Claude deletes the unedited server, keeps a hand-edited one, and keeps Codex\'s lock row', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude,codex', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  claudeJson.mcpServers['sequential-thinking'].args.push('--edited');
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);

  r = run(['remove', '-g', '--force', '-t', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['sequential-thinking'], 'only the edited entry stays');
  assert.ok(readJson(claudeFile).mcpServers['sequential-thinking'].args.includes('--edited'));
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections,
    { codex: ['context7', 'sequential-thinking'] });
});

test('E9: removing the last harness removes the lock', () => {
  const home = scratchHome();
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['remove', '-g', '--force', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(lockFile), 'Codex is still pinned');
  r = run(['remove', '-g', '--force', '-t', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /doflow\.lock: cleared/);
  assert.ok(!fs.existsSync(lockFile), 'no harness is left to pin');
});

test('E10: reconcile names an installed harness the lock does not pin', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  const lock = readJson(lockFile);
  lock.targets = lock.targets.filter((entry: any) => entry.harness !== 'kiro');
  delete lock.mcpSelections.kiro;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);

  r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.match(r.stdout, /\[WARN\] kiro: installed \(ledger holds \d+ resource\(s\)\) but absent from doflow\.lock; reconcile does not converge it\./);
  assert.doesNotMatch(r.stdout, /\[WARN\] codex/);
  r = run(['reconcile', '-g', '--dry-run', '--json'], { home });
  const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('\n{\n') + 1, r.stdout.lastIndexOf('\n}') + 2));
  assert.deepStrictEqual(report.unpinned, ['kiro']);
});

test('E12: a second install, update, reconcile and remove leaves config files, ledger and lock byte for byte', () => {
  const home = scratchHome();
  const watched = [
    path.join(home, '.doflow', 'state', 'ledger.json'),
    path.join(home, '.doflow', 'doflow.lock'),
    path.join(home, '.claude.json'),
    path.join(home, '.codex', 'config.toml'),
    ...Object.values(GLOBAL_MCP_FILES(home)).map(({ file }) => file),
  ];
  const snapshot = () => watched.map((file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null));
  const twice = (args: any, label: any) => {
    let r = run(args, { home });
    assert.strictEqual(r.status, 0, `${label}: ${r.stderr}`);
    const first = snapshot();
    r = run(args, { home });
    assert.deepStrictEqual(snapshot(), first, `${label}: the second run changes no watched file`);
    return r;
  };
  const targets = 'claude,codex,kiro,antigravity,opencode,copilot,pi';
  const base = ['-g', '--force', '--no-backup', '-t', targets];
  twice(['install', ...base, '--mcp', 'all'], 'install');
  twice(['update', ...base, '--mcp', 'context7'], 'update');

  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  delete claudeJson.mcpServers.context7;
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);
  twice(['reconcile', '-g', '--force'], 'reconcile');
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['context7'], 'the first reconcile restored the server');

  let r = run(['remove', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const afterRemove = snapshot();
  r = run(['remove', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  // A remove with nothing left to remove refuses its empty plan and exits 1, as it did before this
  // feature; what this case pins is that it writes nothing.
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Refusing to apply a lifecycle plan with no required native resources/);
  assert.deepStrictEqual(snapshot(), afterRemove, 'a second remove changes no watched file');
});

test('the selection line under --dry-run names a remembered selection, and --mcp with no harness to take it has no effect', () => {
  const home = scratchHome();
  // A 1.18.0 manifest list is what a harness with nothing recorded is offered.
  fs.mkdirSync(path.join(home, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(home, '.doflow', '.install-manifest.json'), `${JSON.stringify({ tools: {}, mcp_servers: ['context7'] })}\n`);
  let r = run(['install', '-g', '--dry-run', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP selection: kiro: context7 (remembered)'), r.stdout);

  r = run(['install', '-g', '--dry-run', '-t', 'gemini', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP: no targeted harness takes MCP servers; --mcp has no effect.'), r.stdout);
  assert.doesNotMatch(r.stdout, /MCP selection:/);
});

test('update with no native change records a selection missing from the lock without touching a file, and says so', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro', '--mcp', 'none'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // An installed harness the lock records no selection for, as after an upgrade from 1.18.0.
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  const lock = readJson(lockFile);
  delete lock.mcpSelections.kiro;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const before = fs.readFileSync(lockFile, 'utf8');

  r = run(['update', '-g', '--force', '--no-backup', '--dry-run', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP selection: kiro: none (kept)'), r.stdout);
  assert.ok(r.stdout.includes('[DRY]  Would update doflow.lock: 1 change(s)'), r.stdout);
  assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), before, 'a dry run writes no lock');

  r = run(['update', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro: none (kept)'), r.stdout);
  assert.ok(r.stdout.includes('[INFO] doflow.lock: 1 change(s)'), r.stdout);
  assert.ok(r.stdout.includes('[OK] Already up to date: no native changes; selections recorded in doflow.lock'), r.stdout);
  assert.deepStrictEqual(readJson(lockFile).mcpSelections, { kiro: [] });
});

test('T2: no source, doc or README line still says the selection narrows only when claude or codex is targeted', () => {
  const stale = 'narrows this only when claude or codex';
  const walk = (entry: any) => {
    if (fs.statSync(entry).isFile()) return [entry];
    return fs.readdirSync(entry).flatMap((name: any) => walk(path.join(entry, name)));
  };
  const files = [path.join(REPO, 'README.md'), ...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'docs'))];
  const holders = files.filter((file) => fs.readFileSync(file, 'utf8').includes(stale));
  assert.deepStrictEqual(holders, []);
});
