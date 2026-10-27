'use strict';

// Copilot CLI hooks end to end: a real `doflow install/update/remove -t copilot` into a scratch HOME,
// then the installed doflow.json commands run against Copilot payloads. Gated by `hooks.harnesses`
// like every other adapter (copilot is outside the shipped default).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, run, cleanup } = require('../../e2e/cli-e2e.shared.ts');
const { loadRegistry, capabilityMapData, selectAssets } = require('../../../src/registry/index.ts');
const { tieredRegistry } = require('../../../src/lifecycle/hook-tier.ts');

const REPO = path.resolve(__dirname, '../../..');
const DOORS = ['pre-implement-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-start', 'stop-check', 'subagent-start', 'subagent-stop'].map((name) => `doflow-${name}.sh`);
const EVENTS = ['agentStop', 'preToolUse', 'sessionStart', 'subagentStart', 'subagentStop'];

after(cleanup);

function settings(xdg: any, hookHarnesses: any) {
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'hooks.harnesses': hookHarnesses }));
}

function gitProject(t: any) {
  const project = tempDir(t, 'doflow-copilot-hooks-project-');
  spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  return project;
}

/** Run the installed command of one doflow.json entry the way Copilot does: through a shell, in `cwd`. */
function runEntry(entry: any, payload: any, { cwd, home, xdg }: any) {
  return spawnSync('bash', ['-c', entry.bash], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

test('the shipped default hooks.harnesses leaves Copilot content-only: no hook file is written', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const installed = run(['install', project, '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(path.join(project, '.github', 'hooks')), false);
  assert.equal(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge')), false);
  const status = JSON.parse(run(['status', project, '--target', 'copilot', '--json'], { home, env: { XDG_CONFIG_HOME: xdg } }).stdout);
  assert.equal(status.context.copilot.hooks.status, 'absent');
});

test('naming copilot in hooks.harnesses projects doflow.json, the front doors and the shared bridge; leaving it removes them', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const env = { XDG_CONFIG_HOME: xdg };
  settings(xdg, ['copilot']);
  let r = run(['install', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);

  const hooksDir = path.join(project, '.github', 'hooks');
  for (const name of ['doflow.json', 'doflow-lib.sh', ...DOORS]) assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} is installed`);
  for (const name of DOORS) assert.ok(fs.statSync(path.join(hooksDir, name)).mode & 0o111, `${name} is executable`);
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'doflow.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks).sort(), EVENTS);
  assert.deepEqual(config.hooks.preToolUse.map((entry: any) => entry.bash.match(/doflow-[\w-]+\.sh/)[0]), ['doflow-pre-implement-gate.sh', 'doflow-pre-bash-guard.sh', 'doflow-mcp-tool-guard.sh']);

  const status = JSON.parse(run(['status', project, '--target', 'copilot', '--json'], { home, env }).stdout);
  assert.deepEqual(status.context.copilot.hooks, { status: 'active', prerequisites: [] });

  // An unchanged second run plans nothing new and keeps the files.
  r = run(['update', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(hooksDir, 'doflow.json')));

  settings(xdg, ['claude']);
  r = run(['update', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['doflow.json', 'doflow-lib.sh', ...DOORS]) assert.equal(fs.existsSync(path.join(hooksDir, name)), false, `${name} is removed`);
  assert.equal(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')), false);
  assert.ok(fs.existsSync(path.join(project, '.github', 'copilot-instructions.md')), 'Copilot content stays');
});

test('a hook file the user keeps beside doflow.json is left alone, and `remove` takes only DoFlow\'s own', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const env = { XDG_CONFIG_HOME: xdg };
  settings(xdg, ['copilot']);
  const own = path.join(project, '.github', 'hooks', 'mine.json');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '{"version":1,"hooks":{}}\n');
  let r = run(['install', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  r = run(['remove', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(own, 'utf8'), '{"version":1,"hooks":{}}\n');
  assert.equal(fs.existsSync(path.join(project, '.github', 'hooks', 'doflow.json')), false);
});

test('the installed project commands deny a force-push and a source edit on a feature branch, and allow a plain command', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  settings(xdg, ['copilot']);
  const r = run(['install', project, '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(project, '.github', 'hooks', 'doflow.json'), 'utf8'));
  const ctx = { cwd: project, home, xdg };
  const [gate, bash, mcp] = config.hooks.preToolUse;

  const denied = runEntry(bash, { sessionId: 's1', cwd: project, toolName: 'bash', toolArgs: { command: 'git push --force origin main' } }, ctx);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
  assert.match(JSON.parse(denied.stdout).permissionDecisionReason, /Force push blocked/);

  const allowed = runEntry(bash, { sessionId: 's1', cwd: project, toolName: 'bash', toolArgs: { command: 'ls' } }, ctx);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');

  spawnSync('git', ['-C', project, 'checkout', '-q', '-b', 'feat/021-demo'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(project, 'agent-docs', 'doflow', '021-demo'), { recursive: true });
  const patch = '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch\n';
  const gated = runEntry(gate, { sessionId: 's1', cwd: project, toolName: 'apply_patch', toolArgs: patch }, ctx);
  assert.equal(gated.status, 0, gated.stderr);
  assert.equal(JSON.parse(gated.stdout).permissionDecision, 'deny');
  assert.match(JSON.parse(gated.stdout).permissionDecisionReason, /missing requirement\.md, design\.md, or plan\.md/);

  const passed = runEntry(mcp, { sessionId: 's1', cwd: project, toolName: 'bash', toolArgs: { command: 'ls' } }, ctx);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, '');
});

test('a global install writes ~/.copilot/hooks and ~/.doflow/shared/hooks, and its commands resolve from outside any repository', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  settings(xdg, ['copilot']);
  const r = run(['install', '-g', '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(r.status, 0, r.stderr);
  const hooksDir = path.join(home, '.copilot', 'hooks');
  for (const name of ['doflow.json', ...DOORS]) assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} is installed`);
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'doflow.json'), 'utf8'));
  const elsewhere = tempDir(t, 'doflow-copilot-hooks-elsewhere-');
  const denied = runEntry(config.hooks.preToolUse[1], { sessionId: 's1', cwd: elsewhere, toolName: 'bash', toolArgs: { command: 'git push --force origin main' } }, { cwd: elsewhere, home, xdg });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
});

test('the capability map and the hook tier agree: supported hooks, five wired events, tiered off outside hooks.harnesses', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const row = capabilityMapData(registry).find((item: any) => item.harness === 'copilot' && item.capability === 'hooks');
  assert.equal(row.status, 'supported');
  assert.equal(row.nativeTarget, '.github/hooks');
  assert.ok(row.evidence.includes('https://docs.github.com/en/copilot/reference/hooks-reference'));
  const copilot = registry.harnesses.find((item: any) => item.id === 'copilot');
  const wired = Object.entries(copilot.capabilities.hooks.events).filter(([, detail]: any) => detail.status === 'supported').map(([event]) => event).sort();
  const contract = registry.contracts.find((item: any) => item.harness === 'copilot');
  assert.deepEqual(wired, [...contract.hookEvents].sort());
  assert.deepEqual(wired, ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(selectAssets(registry, { harness: 'copilot', capability: 'hooks' }).map((asset: any) => asset.id).sort(), ['copilot.hooks-scripts', 'hooks.shared']);
  const tiered = tieredRegistry(registry, ['claude']);
  assert.deepEqual(selectAssets(tiered, { harness: 'copilot', capability: 'hooks' }), []);
  assert.equal(tiered.harnesses.find((item: any) => item.id === 'copilot').capabilities.hooks.status, 'unavailable');
});
